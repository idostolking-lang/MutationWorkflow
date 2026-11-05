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

interface Running {
  controller: AbortController;
  promise: Promise<unknown>;
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
  ): Promise<Job> {
    const job = JobSchema.parse({
      id: newId('job'),
      kind,
      status: 'running',
      params,
      createdAt: nowIso(),
      startedAt: nowIso(),
    });
    await this.store.jobs.insert(job);
    const controller = new AbortController();
    const promise = this.execute(job, controller, work);
    this.running.set(job.id, { controller, promise });
    return job;
  }

  /** Start a job and wait for it; throws when the job fails. */
  async run<T>(
    kind: JobKind,
    params: Record<string, unknown>,
    work: (context: JobContext) => Promise<T>,
  ): Promise<{ job: Job; result: T }> {
    const job = await this.start(kind, params, work);
    const running = this.running.get(job.id);
    const result = (await running?.promise) as T;
    const final = (await this.store.jobs.get(job.id)) ?? job;
    if (final.status === 'failed') {
      throw new Error(final.error ?? `Job ${job.id} failed`);
    }
    return { job: final, result };
  }

  cancel(id: string): boolean {
    const running = this.running.get(id);
    if (!running) return false;
    running.controller.abort();
    return true;
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
  ): Promise<T | undefined> {
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
      const result = await work(context);
      await persist({
        status: controller.signal.aborted ? 'cancelled' : 'succeeded',
        result,
        finishedAt: nowIso(),
        progress: { message: controller.signal.aborted ? 'Cancelled' : 'Done' },
      });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      logger.error(`Job failed: ${message}`);
      await persist({
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        error: message,
        finishedAt: nowIso(),
      });
      return undefined;
    } finally {
      this.running.delete(job.id);
    }
  }
}
