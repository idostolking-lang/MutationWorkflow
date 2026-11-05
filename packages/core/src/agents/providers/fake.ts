import type {
  AgentMessage,
  CompletionRequest,
  CompletionResponse,
  ModelProvider,
  TokenUsage,
  ToolUsePart,
} from '../provider.js';

export type FakeScript = (
  request: CompletionRequest,
  call: number,
) => CompletionResponse | AgentMessage | Promise<CompletionResponse | AgentMessage>;

/**
 * Scripted provider for tests and dry runs. The script receives every request and returns
 * either a full response or just an assistant message (stop reason inferred from its content).
 */
export class FakeProvider implements ModelProvider {
  readonly kind = 'model';
  readonly type = 'fake';
  readonly supportsVision = true;
  readonly requests: CompletionRequest[] = [];
  private calls = 0;

  constructor(
    private readonly script: FakeScript,
    readonly id = 'fake',
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    // Snapshot: the runtime keeps appending to the same messages array.
    this.requests.push({ ...request, messages: [...request.messages] });
    const result = await this.script(request, this.calls++);
    if ('message' in result) return result;
    const hasToolUse = result.content.some((part) => part.type === 'tool_use');
    return {
      message: result,
      stopReason: hasToolUse ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: request.model,
    };
  }

  estimateCostUsd(_model: string, usage: TokenUsage): number {
    return (usage.inputTokens + usage.outputTokens) / 1_000_000;
  }
}

let fakeToolUseCounter = 0;

/** Helper for scripts: an assistant message that calls one or more tools. */
export function fakeToolCall(...calls: Array<{ name: string; input: unknown }>): AgentMessage {
  return {
    role: 'assistant',
    content: calls.map(
      (call): ToolUsePart => ({
        type: 'tool_use',
        id: `toolu_${++fakeToolUseCounter}`,
        name: call.name,
        input: call.input,
      }),
    ),
  };
}

/** Helper for scripts: a plain assistant text message. */
export function fakeText(text: string): AgentMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}
