import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentsConfigSchema } from '../config/schema.js';
import { silentLogger } from '../util/logger.js';
import type { CompletionRequest } from './provider.js';
import { FakeProvider, fakeText, fakeToolCall } from './providers/fake.js';
import { AgentRuntime } from './runtime.js';
import { defineTool } from './tools.js';

const echoTool = defineTool({
  name: 'echo',
  description: 'Echo text',
  schema: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ content: `echo:${text}` }),
});

function runtime(provider: FakeProvider, config: Record<string, unknown> = {}) {
  return new AgentRuntime({
    providers: new Map([[provider.id, provider]]),
    config: AgentsConfigSchema.parse(config),
    logger: silentLogger,
  });
}

const lastToolResultText = (request: CompletionRequest): string => {
  const last = request.messages.at(-1);
  const part = last?.content.find((p) => p.type === 'tool_result');
  return part?.type === 'tool_result'
    ? part.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('')
    : '';
};

describe('AgentRuntime', () => {
  it('runs the tool loop until the model stops calling tools', async () => {
    const provider = new FakeProvider((_request, call) =>
      call === 0 ? fakeToolCall({ name: 'echo', input: { text: 'hi' } }) : fakeText('done'),
    );
    const result = await runtime(provider).run({
      role: 'explorer',
      system: 'sys',
      task: 'go',
      tools: [echoTool],
    });
    expect(result.stoppedBecause).toBe('finished');
    expect(result.text).toBe('done');
    expect(result.turns).toBe(2);
    expect(lastToolResultText(provider.requests[1] as CompletionRequest)).toBe('echo:hi');
    expect(result.usage.inputTokens).toBe(20);
  });

  it('returns structured output through the finish tool', async () => {
    const provider = new FakeProvider(() =>
      fakeToolCall({ name: 'finish', input: { result: { answer: 42 } } }),
    );
    const result = await runtime(provider).run({
      role: 'triager',
      system: 'sys',
      task: 'go',
      tools: [],
      output: z.object({ answer: z.number() }),
    });
    expect(result.output).toEqual({ answer: 42 });
    expect(result.stoppedBecause).toBe('finished');
    const request = provider.requests[0] as CompletionRequest;
    expect(request.tools.map((t) => t.name)).toContain('finish');
  });

  it('nudges once when the model forgets to call finish', async () => {
    const provider = new FakeProvider((_request, call) =>
      call === 0
        ? fakeText('I think the answer is 7')
        : fakeToolCall({ name: 'finish', input: { result: { answer: 7 } } }),
    );
    const result = await runtime(provider).run({
      role: 'triager',
      system: 'sys',
      task: 'go',
      tools: [],
      output: z.object({ answer: z.number() }),
    });
    expect(result.output).toEqual({ answer: 7 });
    expect(result.turns).toBe(2);
  });

  it('reports invalid tool input and unknown tools as error results', async () => {
    const provider = new FakeProvider((_request, call) =>
      call === 0
        ? fakeToolCall({ name: 'echo', input: { nope: 1 } }, { name: 'missing', input: {} })
        : fakeText('ok'),
    );
    await runtime(provider).run({ role: 'explorer', system: 'sys', task: 'go', tools: [echoTool] });
    const request = provider.requests[1] as CompletionRequest;
    const results = request.messages.at(-1)?.content.filter((p) => p.type === 'tool_result') ?? [];
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.type === 'tool_result' && r.isError)).toBe(true);
    const texts = results.map((r) =>
      r.type === 'tool_result'
        ? r.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
        : '',
    );
    expect(texts[0]).toContain('Invalid input for echo');
    expect(texts[1]).toContain('Unknown tool "missing"');
  });

  it('stops when the job budget is exhausted', async () => {
    const provider = new FakeProvider(() =>
      fakeToolCall({ name: 'echo', input: { text: 'again' } }),
    );
    const result = await runtime(provider, { budget: { maxTokensPerJob: 20 } }).run({
      role: 'explorer',
      system: 'sys',
      task: 'go',
      tools: [echoTool],
      jobId: 'job_1',
    });
    expect(result.stoppedBecause).toBe('budget');
    expect(provider.requests).toHaveLength(2);
  });

  it('stops at the configured number of turns', async () => {
    const provider = new FakeProvider(() =>
      fakeToolCall({ name: 'echo', input: { text: 'again' } }),
    );
    const result = await runtime(provider, { roles: { explorer: { maxTurns: 3 } } }).run({
      role: 'explorer',
      system: 'sys',
      task: 'go',
      tools: [echoTool],
    });
    expect(result.stoppedBecause).toBe('max-turns');
    expect(result.turns).toBe(3);
  });

  it('surfaces refusals', async () => {
    const provider = new FakeProvider((request) => ({
      message: fakeText('No.'),
      stopReason: 'refusal',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: request.model,
    }));
    const result = await runtime(provider).run({
      role: 'explorer',
      system: 'sys',
      task: 'go',
      tools: [],
    });
    expect(result.stoppedBecause).toBe('refusal');
  });

  it('fans out through delegate and merges the sub-agent reports', async () => {
    const provider = new FakeProvider((request, call) => {
      const isSub = request.messages[0]?.content.some(
        (p) => p.type === 'text' && p.text.startsWith('sub:'),
      );
      if (isSub)
        return fakeText(
          `finished ${request.messages[0]?.content[0]?.type === 'text' ? request.messages[0].content[0].text : ''}`,
        );
      return call === 0
        ? fakeToolCall({
            name: 'delegate',
            input: {
              tasks: [
                { title: 'A', task: 'sub:a' },
                { title: 'B', task: 'sub:b' },
              ],
            },
          })
        : fakeText('parent done');
    });
    const result = await runtime(provider, { maxParallel: 1 }).run({
      role: 'inspector',
      system: 'sys',
      task: 'go',
      tools: [echoTool],
    });
    expect(result.text).toBe('parent done');
    const merged = lastToolResultText(
      provider.requests.find((r) => lastToolResultText(r).includes('## A')) as CompletionRequest,
    );
    expect(merged).toContain('## A\nfinished sub:a');
    expect(merged).toContain('## B\nfinished sub:b');
    const subRequest = provider.requests.find(
      (r) =>
        r.messages[0]?.content[0]?.type === 'text' &&
        r.messages[0].content[0].text.startsWith('sub:a'),
    );
    expect(subRequest?.tools.map((t) => t.name)).toEqual(['echo', 'delegate']);
  });

  it('never exceeds maxParallel concurrent model calls', async () => {
    let inFlight = 0;
    let peak = 0;
    const provider = new FakeProvider(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return fakeText('ok');
    });
    const rt = runtime(provider, { maxParallel: 2 });
    await Promise.all(
      Array.from({ length: 6 }, () =>
        rt.run({ role: 'explorer', system: 'sys', task: 'go', tools: [] }),
      ),
    );
    expect(peak).toBe(2);
    expect(provider.requests).toHaveLength(6);
  });

  it('resolves models per role with defaults and fails clearly without a model', async () => {
    const provider = new FakeProvider(() => fakeText('ok'));
    const rt = runtime(provider, {
      defaults: { model: 'm-default', maxTurns: 7 },
      roles: { triager: { model: 'm-triage', effort: 'high' } },
    });
    expect(rt.resolveModel('explorer')).toMatchObject({
      model: 'm-default',
      maxTurns: 7,
      vision: true,
    });
    expect(rt.resolveModel('triager')).toMatchObject({ model: 'm-triage', effort: 'high' });
    const noModel = new FakeProvider(() => fakeText('ok'));
    Object.defineProperty(noModel, 'defaultModel', { value: undefined });
    expect(() => runtime(noModel).resolveModel('explorer')).toThrow(/No model configured/);
  });
});
