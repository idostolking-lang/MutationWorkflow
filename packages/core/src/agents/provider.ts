import type { Effort } from '../config/schema.js';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image';
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** Base64 without a data: prefix. */
  data: string;
}

export interface ToolUsePart {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultPart {
  type: 'tool_result';
  toolUseId: string;
  content: Array<TextPart | ImagePart>;
  isError?: boolean;
}

export type ContentPart = TextPart | ImagePart | ToolUsePart | ToolResultPart;

/** Provider-neutral conversation message. Providers translate to and from their own shapes. */
export interface AgentMessage {
  role: 'user' | 'assistant';
  content: ContentPart[];
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12 or compatible) of the tool input object. */
  inputSchema: Record<string, unknown>;
}

export interface CompletionRequest {
  model: string;
  system: string;
  messages: AgentMessage[];
  tools: ToolSpec[];
  maxTokens: number;
  effort?: Effort;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface CompletionResponse {
  message: AgentMessage;
  stopReason: StopReason;
  usage: TokenUsage;
  model: string;
}

/** A model API. Implementations exist for Anthropic, OpenAI-compatible endpoints and tests. */
export interface ModelProvider {
  readonly id: string;
  readonly type: string;
  readonly supportsVision: boolean;
  /** Model used when a role does not name one; undefined means the user must choose. */
  readonly defaultModel: string | undefined;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  /** Approximate cost in USD, when the provider knows the model's prices. */
  estimateCostUsd(model: string, usage: TokenUsage): number | undefined;
}

export function textOf(message: AgentMessage): string {
  return message.content
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

export function toolUsesOf(message: AgentMessage): ToolUsePart[] {
  return message.content.filter((part): part is ToolUsePart => part.type === 'tool_use');
}

export const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}
