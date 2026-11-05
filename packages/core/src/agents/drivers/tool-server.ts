import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Logger } from '../../util/logger.js';
import {
  type AgentTool,
  defineTool,
  normalizeToolOutput,
  runTool,
  type ToolContext,
} from '../tools.js';

export interface ToolServer {
  /** Streamable HTTP MCP endpoint, bound to the loopback interface with a random path. */
  url: string;
  /** Names of the tools served, as the external runtime sees them. */
  toolNames: string[];
  close(): Promise<void>;
}

export interface ToolServerOptions {
  /** Server name advertised over MCP; tools appear to Claude Code as `mcp__<name>__<tool>`. */
  name: string;
  logger: Logger;
}

type ToolContent = Array<
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
>;

/**
 * Serve an agent's tools to an external agent runtime over MCP for the duration of one task.
 * Each MCP session gets its own server instance, so a client that reconnects keeps working. The
 * endpoint lives on 127.0.0.1 under an unguessable path and disappears when the task ends.
 */
export async function serveTools(
  tools: ReadonlyArray<AgentTool>,
  context: ToolContext,
  options: ToolServerOptions,
): Promise<ToolServer> {
  const path = `/mcp/${randomUUID()}`;
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  // A remark tool is always present, so the tool list is never empty (an empty list would leave
  // the MCP tools/list handler unregistered) and agents have somewhere to leave a note.
  const remark = defineTool({
    name: 'remark',
    description:
      'Leave a short note for the operator log, for example an observation worth keeping.',
    schema: z.object({ text: z.string().min(1).max(2000) }),
    execute: async ({ text }) => {
      options.logger.info(`Agent remark: ${text}`);
      return { content: 'Noted.' };
    },
  });
  const served: AgentTool[] = [...tools, remark];

  const createSession = async (): Promise<StreamableHTTPServerTransport> => {
    const mcp = new McpServer({ name: options.name, version: '0.1.0' });
    for (const tool of served) {
      mcp.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.schema as z.ZodObject },
        async (args: unknown) => {
          const output = normalizeToolOutput(await runTool(served, tool.name, args, context));
          const content: ToolContent = output.content.map((part) =>
            part.type === 'image'
              ? { type: 'image', data: part.data, mimeType: part.mediaType }
              : { type: 'text', text: part.text },
          );
          return { content, ...(output.isError ? { isError: true } : {}) };
        },
      );
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    await mcp.connect(transport);
    return transport;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!req.url || req.url.split('?')[0] !== path) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    const transport = existing ?? (await createSession());
    await transport.handleRequest(req, res);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      options.logger.warn(`Tool server request failed: ${String(error)}`);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}${path}`,
    toolNames: served.map((tool) => tool.name),
    close: async () => {
      await Promise.all([...sessions.values()].map((t) => t.close().catch(() => undefined)));
      sessions.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
