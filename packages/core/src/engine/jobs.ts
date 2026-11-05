import { hostname } from 'node:os';
import { type Job, type JobKind, JobSchema, newId, nowIso } from '../schema/index.js';
import type { JobFilter, Store } from '../store/types.js';
import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';

export interface JobContext {
  readonly job: Job;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  progress(message: string, current?: number, total?: number): Promise<void>;
}

export interface JobStartOptions {
  /** Aborting this signal cancels the job. */
  signal?: AbortSignal;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

interface Running {
  controller: AbortController;
  promise: Promise<Outcome<unknown>>;
}

/**
 * Tracks long-running work so MCP clients can start it, return immediately and poll, while
 * the CLI awaits it. Every job is persisted, so history survives restarts.
 */
export class JobManager {
  private readonly running = new Map<string, Running>();

  constructor(
    private readonly store: Store,
    private readonly logger: Logger,
  ) {}

  /** Start a job in the background and return its record right away. */
  async start<T>(
    kind: JobKind,
    params: Record<string, unknown>,
    work: (context: JobContext) => Promise<T>,
    options: JobStartOptions = {},
  ): Promise<Job> {
    const job = JobSchema.parse({
      id: newId('job'),
      kind,
      status: 'running',
      params,
      owner: { pid: process.pid, host: hostname() },
      createdAt: nowIso(),
      startedAt: nowIso(),
    });
    await this.store.jobs.insert(job);
    const controller = new AbortController();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    const promise = this.execute(job, controller, work);
    this.running.set(job.id, { controller, promise });
    return job;
  }

  /** Start a job and wait for it; rethrows the job's own error when it fails. */
  async run<T>(
    kind: JobKind,
    params: Record<string, unknown>,
    work: (context: JobContext) => Promise<T>,
    options: JobStartOptions = {},
  ): Promise<{ job: Job; result: T }> {
    const job = await this.start(kind, params, work, options);
    const running = this.running.get(job.id);
    const outcome = (await running?.promise) as Outcome<T> | undefined;
    const final = (await this.store.jobs.get(job.id)) ?? job;
    if (!outcome) throw new Error(`Job ${job.id} vanished before it finished`);
    if (!outcome.ok) throw outcome.error;
    return { job: final, result: outcome.value };
  }

  /**
   * Mark jobs left `running` by a process that no longer exists on this machine as failed. Jobs
   * owned by live processes or by other hosts are left alone. Called once at startup.
   */
  async recover(): Promise<number> {
    const stale = (await this.store.jobs.list({ status: ['queued', 'running'] })).filter(
      (job) => !this.running.has(job.id) && ownerIsGone(job),
    );
    for (const job of stale) {
      await this.store.jobs.update(
        JobSchema.parse({
          ...job,
          status: 'failed',
          error: 'Interrupted: the process ended before the job finished',
          finishedAt: nowIso(),
        }),
      );
    }
    return stale.length;
  }

  cancel(id: string): boolean {
    const running = this.running.get(id);
    if (!running) return false;
    running.controller.abort();
    return true;
  }

  /** Ids of the jobs running in this process. */
  get active(): string[] {
    return [...this.running.keys()];
  }

  get(id: string): Promise<Job | undefined> {
    return this.store.jobs.get(id);
  }

  list(filter?: JobFilter): Promise<Job[]> {
    return this.store.jobs.list(filter);
  }

  /** Wait for every running job (used on shutdown). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.running.values()].map((r) => r.promise));
  }

  private async execute<T>(
    job: Job,
    controller: AbortController,
    work: (context: JobContext) => Promise<T>,
  ): Promise<Outcome<T>> {
    const logger = this.logger.child(`job:${job.kind}`);
    let current = job;
    const persist = async (patch: Partial<Job>) => {
      current = JobSchema.parse({ ...current, ...patch });
      await this.store.jobs.update(current);
    };
    const context: JobContext = {
      job,
      signal: controller.signal,
      logger,
      progress: async (message, cur, total) => {
        logger.info(message, cur !== undefined ? { current: cur, total } : undefined);
        await persist({ progress: { message, current: cur, total } });
      },
    };
    try {
      const value = await work(context);
      const cancelled = controller.signal.aborted;
      await persist({
        status: cancelled ? 'cancelled' : 'succeeded',
        result: value,
        finishedAt: nowIso(),
        progress: { message: cancelled ? 'Cancelled' : 'Done' },
      });
      return { ok: true, value };
    } catch (error) {
      const message = errorMessage(error);
      logger.error(`Job failed: ${message}`);
      await persist({
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        error: message,
        finishedAt: nowIso(),
      });
      return { ok: false, error };
    } finally {
      this.running.delete(job.id);
    }
  }
}

/** True when the job's owner process is known to be gone from this machine. */
function ownerIsGone(job: Job): boolean {
  if (!job.owner) return true;
  if (job.owner.host !== hostname() || job.owner.pid === process.pid) return false;
  try {
    process.kill(job.owner.pid, 0);
    return false;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code !== 'EPERM';
  }
}
