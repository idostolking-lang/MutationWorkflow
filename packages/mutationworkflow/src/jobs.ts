import {
  type AgentRole,
  type Engine,
  type Job,
  type JobContext,
  type JobKind,
  MutationWorkflowError,
  type TargetConfig,
} from '@mutationworkflow/core';

/** A unit of long-running work tracked by the engine's job manager. */
export interface JobSpec<T> {
  kind: JobKind;
  /** Recorded on the job for later inspection. */
  params: Record<string, unknown>;
  work(context: JobContext): Promise<T>;
  /** Compact form stored as the job result (full results can be large). */
  summarize(result: T): unknown;
}

/** Start a job in the background and return its record immediately (MCP polling model). */
export function startJob<T>(engine: Engine, spec: JobSpec<T>): Promise<Job> {
  return engine.jobs.start(spec.kind, spec.params, async (context) =>
    spec.summarize(await spec.work(context)),
  );
}

export interface JobOutcome<T> {
  job: Job;
  /** Undefined when the job was cancelled before it produced a result. */
  result: T | undefined;
}

/**
 * Run a job to completion. Unlike `engine.jobs.run`, the original error (with its
 * MutationWorkflowError code) is rethrown, the full result is returned while only the summary
 * is persisted, and aborting `signal` cancels the job.
 */
export async function runJob<T>(
  engine: Engine,
  spec: JobSpec<T>,
  signal?: AbortSignal,
): Promise<JobOutcome<T>> {
  let full: T | undefined;
  let failure: unknown;
  try {
    const { job } = await engine.jobs.run(spec.kind, spec.params, async (context) => {
      // An outside abort (Ctrl+C) cancels the job, so its record says "cancelled".
      const cancel = () => engine.jobs.cancel(context.job.id);
      if (signal?.aborted) cancel();
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        full = await spec.work(context);
        return spec.summarize(full);
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
    });
    return { job, result: full };
  } catch (error) {
    throw failure ?? error;
  }
}

export interface RequireAgentsOptions {
  /** The role the operation runs; checked too, so a role without a model fails before the job. */
  role?: AgentRole;
  /** The MCP tool a connected coding agent can call to do the work itself, without a provider. */
  clientTool?: string;
}

/**
 * Fail fast, before a job is recorded, when an operation needs a model provider. The error
 * carries `clientTool` in its details so the MCP surface can point at the client-driven tool.
 */
export function requireAgents(
  engine: Engine,
  action: string,
  options: RequireAgentsOptions = {},
): void {
  const details = options.clientTool ? { clientTool: options.clientTool } : undefined;
  if (!engine.agents.enabled) {
    throw new MutationWorkflowError(
      'PROVIDER_NOT_CONFIGURED',
      `"${action}" needs a model provider. Install Claude Code or Codex, set ANTHROPIC_API_KEY or OPENAI_API_KEY, or add a providers section to the config.`,
      { details },
    );
  }
  if (!options.role) return;
  try {
    engine.agents.resolveModel(options.role);
  } catch (error) {
    if (error instanceof MutationWorkflowError) {
      throw new MutationWorkflowError(error.code, error.message, { cause: error, details });
    }
    throw error;
  }
}

/** Resolve target ids (all when empty) and fail when nothing is configured. */
export function requireTargets(engine: Engine, ids?: ReadonlyArray<string>): TargetConfig[] {
  const targets = engine.targets(ids ? [...ids] : undefined);
  if (targets.length === 0) {
    throw new MutationWorkflowError(
      'TARGET_NOT_FOUND',
      'No targets are configured. Run "mw setup" (or the mw_setup tool) or "mw init" first.',
    );
  }
  return targets;
}
