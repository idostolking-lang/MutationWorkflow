import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { normalizeToolOutput, type ToolOutput } from '@mutationworkflow/core';
import { describeError } from '../errors.js';

/** A short human-readable summary, followed by compact JSON when `data` is given. */
export function textResult(summary: string, data?: unknown): CallToolResult {
  const text = data === undefined ? summary : `${summary}\n\n${JSON.stringify(data)}`;
  return { content: [{ type: 'text', text }] };
}

/** A tool failure the client's model can read and act on. */
export function errorResult(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: describeError(error, 'mcp') }] };
}

/** Wrap a tool handler so thrown errors become `isError` results instead of protocol errors. */
export function safe<A>(
  handler: (args: A) => Promise<CallToolResult>,
): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      return errorResult(error);
    }
  };
}

type Content = CallToolResult['content'][number];

/**
 * An agent tool's output as MCP content: text parts become text, image parts become images the
 * client's model can see. `isError` passes through. `prefix` adds a leading text block.
 */
export function toolOutputResult(output: ToolOutput, prefix?: string): CallToolResult {
  const { content, isError } = normalizeToolOutput(output);
  const parts: Content[] = content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image', data: part.data, mimeType: part.mediaType },
  );
  if (prefix) parts.unshift({ type: 'text', text: prefix });
  return isError ? { isError: true, content: parts } : { content: parts };
}

/** Several text blocks, e.g. a summary followed by long instructions and a schema. */
export function textBlocks(...blocks: ReadonlyArray<string | undefined>): CallToolResult {
  return {
    content: blocks.flatMap((text) => (text ? [{ type: 'text' as const, text }] : [])),
  };
}
