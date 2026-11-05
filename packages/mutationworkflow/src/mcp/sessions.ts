/**
 * Live exploration sessions a connected coding agent drives through MCP tools. Sessions on one
 * target share its running environment (the engine stops it when the last one closes), so a
 * client may open one per sub-agent. The registry closes sessions that sit idle and every
 * session when the client disconnects.
 */
import {
  type ExplorationHandle,
  errorMessage,
  type Logger,
  MutationWorkflowError,
  type ToolOutput,
} from '@mutationworkflow/core';

/** Sessions untouched for this long are closed and their environments stopped. */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

type CloseResult = Awaited<ReturnType<ExplorationHandle['close']>>;

interface Entry {
  handle: ExplorationHandle;
  timer: NodeJS.Timeout;
  /** Tool calls on one session run one after another; adapter sessions are not reentrant. */
  queue: Promise<unknown>;
}

export interface ExplorationRegistryOptions {
  logger: Logger;
  idleMs?: number;
}

export class ExplorationRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly idleMs: number;
  private closingAll: Promise<void> | undefined;

  constructor(private readonly options: ExplorationRegistryOptions) {
    this.idleMs = options.idleMs ?? SESSION_IDLE_MS;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Every open session, oldest first. */
  list(): ExplorationHandle[] {
    return [...this.entries.values()].map((entry) => entry.handle);
  }

  /** The open sessions on `targetId`. */
  forTarget(targetId: string): ExplorationHandle[] {
    return this.list().filter((handle) => handle.targetId === targetId);
  }

  add(handle: ExplorationHandle): void {
    if (this.closingAll) {
      void handle.close();
      throw new MutationWorkflowError('INVALID_INPUT', 'The server is shutting down.');
    }
    const entry: Entry = {
      handle,
      timer: this.idleTimer(handle.id),
      queue: Promise.resolve(),
    };
    this.entries.set(handle.id, entry);
  }

  /** Run one of the session's tools, serialized with its other calls; refreshes the idle timer. */
  call(sessionId: string, tool: string, input: unknown): Promise<ToolOutput> {
    const entry = this.touch(sessionId);
    const next = entry.queue.then(() => entry.handle.session.callTool(tool, input));
    entry.queue = next.catch(() => undefined);
    return next;
  }

  /** The live handle, for reading budget and saved workflows. */
  get(sessionId: string): ExplorationHandle {
    return this.touch(sessionId).handle;
  }

  /** Close one session (its environment stops with the last session on the target) and forget it. */
  async close(sessionId: string): Promise<CloseResult> {
    const entry = this.require(sessionId);
    this.entries.delete(sessionId);
    clearTimeout(entry.timer);
    await entry.queue;
    return entry.handle.close();
  }

  /** Close every session; used when the client disconnects. Safe to call more than once. */
  closeAll(): Promise<void> {
    this.closingAll ??= (async () => {
      const ids = [...this.entries.keys()];
      await Promise.all(
        ids.map((id) =>
          this.close(id).catch((error: unknown) =>
            this.options.logger.warn(
              `Closing exploration session ${id} failed: ${errorMessage(error)}`,
            ),
          ),
        ),
      );
      if (ids.length > 0) this.options.logger.info(`Closed ${ids.length} exploration session(s)`);
    })();
    return this.closingAll;
  }

  private touch(sessionId: string): Entry {
    const entry = this.require(sessionId);
    clearTimeout(entry.timer);
    entry.timer = this.idleTimer(sessionId);
    return entry;
  }

  private require(sessionId: string): Entry {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      const open = [...this.entries.keys()];
      throw new MutationWorkflowError(
        'NOT_FOUND',
        `No open exploration session ${sessionId}. ${
          open.length > 0
            ? `Open sessions: ${open.join(', ')}.`
            : `Sessions close after ${minutes(this.idleMs)} minute(s) without a call; open a new one with mw_explore_open.`
        }`,
      );
    }
    return entry;
  }

  private idleTimer(sessionId: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.options.logger.info(
        `Exploration session ${sessionId} was idle for ${minutes(this.idleMs)} minute(s); closing it`,
      );
      this.close(sessionId).catch((error: unknown) =>
        this.options.logger.warn(
          `Closing idle session ${sessionId} failed: ${errorMessage(error)}`,
        ),
      );
    }, this.idleMs);
    timer.unref();
    return timer;
  }
}

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}
