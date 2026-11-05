import type { AgentRole, Effort } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import type { AgentTool, ToolContext } from './tools.js';

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

/**
 * A model API called one turn at a time; MutationWorkflow runs the tool loop. The model id is
 * always chosen by the user in the configuration: there is no default.
 */
export interface ModelProvider {
  readonly kind: 'model';
  readonly id: string;
  readonly type: string;
  readonly supportsVision: boolean;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  /** Approximate cost in USD, when the provider knows the model's prices. */
  estimateCostUsd(model: string, usage: TokenUsage): number | undefined;
}

export interface AgentDriveRequest {
  role: AgentRole;
  system: string;
  task: string;
  /** Tools the agent may call, served to the external runtime over MCP. */
  tools: AgentTool[];
  toolContext: ToolContext;
  /** Model name as the external runtime understands it; its own setting applies when absent. */
  model?: string;
  maxTurns: number;
  signal?: AbortSignal;
  logger: Logger;
}

export interface AgentDriveResult {
  /** The agent's final answer. */
  text: string;
  usage: TokenUsage;
  costUsd?: number;
  turns: number;
  stoppedBecause: 'finished' | 'max-turns' | 'error' | 'aborted';
  error?: string;
  /** Model the external runtime reports having used, when it says. */
  model?: string;
}

/**
 * An external agent runtime that runs a whole task itself: a coding agent's command line such
 * as Claude Code or Codex, using the user's own installation and subscription. MutationWorkflow
 * hands it the system prompt, the task and its tools (over MCP) and reads the final answer.
 */
export interface AgentDriver {
  readonly kind: 'driver';
  readonly id: string;
  readonly type: string;
  drive(request: AgentDriveRequest): Promise<AgentDriveResult>;
}

export type Provider = ModelProvider | AgentDriver;

export function isDriver(provider: Provider): provider is AgentDriver {
  return provider.kind === 'driver';
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
