import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type Engine, errorMessage } from '@mutationworkflow/core';
import { VERSION } from '../version.js';
import { registerMemoryTools } from './memory.js';
import { registerOperationTools } from './operations.js';

const INSTRUCTIONS = `MutationWorkflow finds sequence bugs: agents discover user workflows in the app, the engine mutates them (skip, reorder, repeat, interrupt, fuzz) and replays them against a local environment it starts itself.
Typical flow: mw_status → mw_setup (no config yet) → mw_explore → mw_mutate → mw_run → mw_findings → mw_finding / mw_evidence.
setup, explore, run, triage and agent mutate start background jobs: they return a job id; poll mw_job until it is succeeded, failed or cancelled.
Questions from mw_questions are for the human: ask the user before answering with mw_answer.`;

export interface McpServerOptions {
  /**
   * Cancel running jobs and close the engine when the connection closes (default true). The
   * engine must not be used afterwards.
   */
  closeEngineOnClose?: boolean;
}

/** Create an MCP server exposing the engine's operations and memory as `mw_*` tools. */
export function createMcpServer(engine: Engine, options: McpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'mutationworkflow', version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerMemoryTools(server, engine);
  registerOperationTools(server, engine);
  if (options.closeEngineOnClose !== false) {
    server.server.onclose = () => {
      shutdownEngine(engine).catch((error: unknown) =>
        engine.logger.error(`Shutdown failed: ${errorMessage(error)}`),
      );
    };
  }
  return server;
}

/** Cancel the jobs this process is running, wait for them to stop their environments, close. */
export async function shutdownEngine(engine: Engine): Promise<void> {
  for (const job of await engine.jobs.list({ status: 'running' })) engine.jobs.cancel(job.id);
  await engine.jobs.drain();
  await engine.close();
}

export interface ServeOptions {
  /** Aborting closes the server (SIGINT/SIGTERM in the CLI). */
  signal?: AbortSignal;
}

/**
 * Serve the engine over stdio until the client disconnects (stdin ends) or `signal` aborts,
 * then cancel running jobs and close the engine. stdout belongs to the protocol from here on;
 * logs go to stderr.
 */
export async function serveStdio(engine: Engine, options: ServeOptions = {}): Promise<void> {
  const server = createMcpServer(engine, { closeEngineOnClose: false });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = resolve;
  });
  const close = () => {
    server.close().catch(() => undefined);
  };
  process.stdin.once('end', close);
  options.signal?.addEventListener('abort', close, { once: true });
  try {
    await server.connect(transport);
    engine.logger.info(
      `MCP server ready for ${engine.config.project.name} (${engine.rootDir}${engine.configPath ? '' : ', no config yet'})`,
    );
    if (options.signal?.aborted) close();
    await closed;
  } finally {
    process.stdin.off('end', close);
    options.signal?.removeEventListener('abort', close);
    await shutdownEngine(engine);
  }
}
