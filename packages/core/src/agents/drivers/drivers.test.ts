import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentsConfigSchema } from '../../config/schema.js';
import { silentLogger } from '../../util/logger.js';
import { AgentRuntime } from '../runtime.js';
import { defineTool } from '../tools.js';
import { ClaudeCodeDriver } from './claude-code.js';
import { CodexDriver } from './codex.js';

const fixture = fileURLToPath(new URL('./__fixtures__/fake-agent-cli.mjs', import.meta.url));

const echoed: string[] = [];
const echoTool = defineTool({
  name: 'echo',
  description: 'Echo text',
  schema: z.object({ text: z.string() }),
  execute: async ({ text }) => {
    echoed.push(text);
    return { content: `echo:${text}` };
  },
});

const script = (steps: Array<{ tool: string; input: unknown }>) =>
  `Do the task. SCRIPT:${JSON.stringify(steps)}`;

function runtimeWith(driver: ClaudeCodeDriver | CodexDriver, config: Record<string, unknown> = {}) {
  return new AgentRuntime({
    providers: new Map([[driver.id, driver]]),
    config: AgentsConfigSchema.parse(config),
    logger: silentLogger,
  });
}

describe('coding-agent drivers', () => {
  it('hands the task to Claude Code, serves the tools over MCP and reads the JSON result', async () => {
    const driver = new ClaudeCodeDriver({
      id: 'claude-code',
      command: process.execPath,
      args: [fixture],
    });
    const result = await runtimeWith(driver, { roles: { explorer: { model: 'opus' } } }).run({
      role: 'explorer',
      system: 'You explore.',
      task: script([
        { tool: 'echo', input: { text: 'hi' } },
        { tool: 'finish', input: { result: { answer: 42 } } },
      ]),
      tools: [echoTool],
      output: z.object({ answer: z.number() }),
    });
    expect(result.stoppedBecause).toBe('finished');
    expect(result.output).toEqual({ answer: 42 });
    expect(echoed).toContain('hi');
    expect(result.turns).toBe(3);
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 7,
    });
    expect(result.costUsd).toBeCloseTo(0.0123);
    const summary = JSON.parse(result.text) as {
      tools: string[];
      outputs: string[];
      model: string | null;
      argv: string[];
    };
    expect(summary.tools).toEqual(['echo', 'finish', 'remark']);
    expect(summary.outputs[0]).toBe('echo:hi');
    expect(summary.model).toBe('opus');
    expect(summary.argv).toContain('--strict-mcp-config');
    expect(summary.argv).toContain('--system-prompt');
    expect(summary.argv.indexOf('--tools')).toBeGreaterThan(-1);
    expect(summary.argv[summary.argv.indexOf('--tools') + 1]).toBe('');
    expect(summary.argv).not.toContain('--restricted');
  });

  it('switches built-in tools off for the inspector too and passes no model when none is set', async () => {
    const driver = new ClaudeCodeDriver({
      id: 'claude-code',
      command: process.execPath,
      args: [fixture],
    });
    const result = await runtimeWith(driver).run({
      role: 'inspector',
      system: 's',
      task: script([]),
      tools: [],
    });
    const summary = JSON.parse(result.text) as { argv: string[]; model: string | null };
    expect(summary.argv).not.toContain('--restricted');
    expect(summary.argv).toContain('--tools');
    expect(summary.model).toBeNull();
  });

  it('reports a missing executable and a crashing process as errors', async () => {
    const missing = new ClaudeCodeDriver({ id: 'claude-code', command: '/nonexistent/claude' });
    const absent = await runtimeWith(missing).run({
      role: 'explorer',
      system: 's',
      task: 't',
      tools: [],
    });
    expect(absent.stoppedBecause).toBe('error');
    expect(absent.error).toContain('not installed');

    const crashing = new ClaudeCodeDriver({
      id: 'claude-code',
      command: process.execPath,
      args: [fixture, '--crash'],
    });
    const crashed = await runtimeWith(crashing).run({
      role: 'explorer',
      system: 's',
      task: 't',
      tools: [],
    });
    expect(crashed.stoppedBecause).toBe('error');
    expect(crashed.error).toContain('simulated failure');
  });

  it('drives Codex through exec and reads the last message file', async () => {
    const driver = new CodexDriver({ id: 'codex', command: process.execPath, args: [fixture] });
    const result = await runtimeWith(driver, { defaults: { model: 'gpt-x' } }).run({
      role: 'mutator',
      system: 'You mutate.',
      task: script([{ tool: 'echo', input: { text: 'codex' } }]),
      tools: [echoTool],
    });
    expect(result.stoppedBecause).toBe('finished');
    const summary = JSON.parse(result.text) as { outputs: string[]; argv: string[] };
    expect(summary.outputs).toEqual(['echo:codex']);
    expect(summary.argv.slice(0, 2)).toEqual(['exec', '--skip-git-repo-check']);
    expect(summary.argv).toContain('--model');
    expect(summary.argv.at(-1)).toContain('You mutate.');
  });

  it('holds one runtime permit per drive', async () => {
    const driver = new ClaudeCodeDriver({
      id: 'claude-code',
      command: process.execPath,
      args: [fixture],
    });
    const rt = runtimeWith(driver, { maxParallel: 1 });
    const started = Date.now();
    await Promise.all([
      rt.run({ role: 'explorer', system: 's', task: script([]), tools: [] }),
      rt.run({ role: 'explorer', system: 's', task: script([]), tools: [] }),
    ]);
    expect(rt.slots.free).toBe(1);
    expect(Date.now() - started).toBeGreaterThan(0);
  });
});
