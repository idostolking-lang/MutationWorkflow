import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
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
