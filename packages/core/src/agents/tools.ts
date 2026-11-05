import { z } from 'zod';
import type { AgentRole } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import type { ImagePart, TextPart, ToolSpec } from './provider.js';

export interface ToolContext {
  role: AgentRole;
  /** 0 for the top-level agent, 1 for its delegates, and so on. */
  depth: number;
  jobId?: string;
  logger: Logger;
  signal?: AbortSignal;
}

export interface ToolOutput {
  content: string | Array<TextPart | ImagePart>;
  isError?: boolean;
}

/** A capability offered to an agent. Input is validated with the schema before `execute` runs. */
export interface AgentTool<TInput = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<TInput>;
  execute(input: TInput, context: ToolContext): Promise<ToolOutput>;
}

/** Type-safe tool constructor: `execute` receives the parsed schema output. */
export function defineTool<S extends z.ZodType>(definition: {
  name: string;
  description: string;
  schema: S;
  execute(input: z.output<S>, context: ToolContext): Promise<ToolOutput>;
}): AgentTool<z.output<S>> {
  return definition as AgentTool<z.output<S>>;
}

/** JSON Schema for a tool input, without the `$schema` marker providers do not expect. */
export function toToolSpec(tool: AgentTool): ToolSpec {
  const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(tool.schema, {
    io: 'input',
    target: 'draft-2020-12',
  }) as Record<string, unknown>;
  return { name: tool.name, description: tool.description, inputSchema };
}

export const ok = (content: ToolOutput['content']): ToolOutput => ({ content });
export const fail = (text: string): ToolOutput => ({ content: text, isError: true });
