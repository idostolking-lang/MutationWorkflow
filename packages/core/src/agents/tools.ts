import { z } from 'zod';
import type { AgentRole } from '../config/schema.js';
import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { truncate } from '../util/text.js';
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

const MAX_TOOL_OUTPUT_CHARS = 40_000;

/**
 * Run a tool by name with validation and error capture. Shared by the in-process runtime, the
 * MCP tool servers that expose tools to external agent runtimes, and the MCP server that lets a
 * connected coding agent drive sessions itself. Never throws: problems become error outputs the
 * model can read.
 */
export async function runTool(
  tools: ReadonlyArray<AgentTool>,
  name: string,
  input: unknown,
  context: ToolContext,
): Promise<ToolOutput> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    return fail(`Unknown tool "${name}". Available: ${tools.map((t) => t.name).join(', ')}`);
  }
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) {
    return fail(`Invalid input for ${tool.name}:\n${z.prettifyError(parsed.error)}`);
  }
  try {
    return normalizeToolOutput(await tool.execute(parsed.data, context));
  } catch (error) {
    return fail(`${tool.name} failed: ${errorMessage(error)}`);
  }
}

/** Always an array of parts, with oversized text cut so one tool cannot flood the context. */
export function normalizeToolOutput(
  output: ToolOutput,
): ToolOutput & { content: Array<TextPart | ImagePart> } {
  const parts: Array<TextPart | ImagePart> =
    typeof output.content === 'string' ? [{ type: 'text', text: output.content }] : output.content;
  const normalized = parts.map((part) =>
    part.type === 'text' ? { ...part, text: truncate(part.text, MAX_TOOL_OUTPUT_CHARS) } : part,
  );
  return {
    content: normalized.length > 0 ? normalized : [{ type: 'text', text: '(no output)' }],
    isError: output.isError,
  };
}

/** Text of a tool output, for logs and for runtimes that cannot carry images. */
export function toolOutputText(output: ToolOutput): string {
  if (typeof output.content === 'string') return output.content;
  return output.content.map((part) => (part.type === 'text' ? part.text : '[image]')).join('\n');
}
