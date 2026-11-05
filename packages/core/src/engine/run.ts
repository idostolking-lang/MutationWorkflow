import type { AgentEvent, AgentRuntime } from '../agents/runtime.js';
import type { Config } from '../config/schema.js';
import { type EnvironmentManager, withEnvironment } from '../environment/manager.js';
import type { Oracle } from '../oracles/types.js';
import {
  type Finding,
  FindingSchema,
  nowIso,
  type Run,
  type RunTrigger,
  type TargetConfig,
  type Workflow,
} from '../schema/index.js';
import type { RunStats, Store } from '../store/types.js';
import type { Logger } from '../util/logger.js';
import { mapWithConcurrency } from '../util/semaphore.js';
import type { AdapterRegistry } from './adapters.js';
import { executeWorkflow } from './executor.js';
import { getGitContext } from './git.js';
import { renderReport, writeReport } from './report.js';
import { recordFindings, triageFindings } from './triage.js';

export interface RunDeps {
  store: Store;
  config: Config;
  rootDir: string;
  evidenceRoot: string;
  reportsDir: string;
  registry: AdapterRegistry;
  environments: EnvironmentManager;
  oracles: ReadonlyArray<Oracle>;
  runtime?: AgentRuntime;
  logger: Logger;
}

export interface RunOptions {
  targets: TargetConfig[];
  /** Restrict to these workflow ids. */
  workflowIds?: string[];
  /** Which workflows to include; defaults to all active and pending-review workflows. */
  include?: 'all' | 'base' | 'mutations';
  trigger: RunTrigger;
  jobId?: string;
  parallel?: number;
  /** Ask the triager agent to review new findings (default true when agents are configured). */
  triage?: boolean;
  /** Write a Markdown report (default true). */
  report?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  onRun?: (run: Run, workflow: Workflow, done: number, total: number) => void;
}

export interface RunSummary {
  runs: Run[];
  /** Findings created or updated by these runs, after triage. */
  findings: Finding[];
  stats: RunStats;
  reportPath?: string;
  durationMs: number;
}

/**
 * Replay workflows against each target in a freshly started environment, record runs and
 * evidence, fold failures into findings, triage them, and write a report.
 */
export async function runWorkflows(deps: RunDeps, options: RunOptions): Promise<RunSummary> {
  const { store, config, logger } = deps;
  const started = Date.now();
  const git = await getGitContext(deps.rootDir);
  const runs: Run[] = [];
  const workflowsById = new Map<string, Workflow>();
  const touched = new Map<string, Finding>();

  for (const target of options.targets) {
    if (options.signal?.aborted) break;
    const workflows = await selectWorkflows(store, target.id, options);
    if (workflows.length === 0) {
      logger.info(`No workflows to run for target "${target.id}"`);
      continue;
    }
    for (const workflow of workflows) workflowsById.set(workflow.id, workflow);
    const adapter = await deps.registry.forTarget(target);
    const parallel = config.execution.resetBetweenRuns
      ? 1
      : (options.parallel ?? config.execution.parallel);
    logger.info(
      `Running ${workflows.length} workflow(s) for "${target.id}" with parallelism ${parallel}`,
    );

    await withEnvironment(deps.environments, target, async (env) => {
      let done = 0;
      await mapWithConcurrency(workflows, parallel, async (workflow) => {
        if (options.signal?.aborted) return;
        if (config.execution.resetBetweenRuns) await env.reset();
        const { run, evidence } = await executeWorkflow({
          workflow,
          target,
          adapter,
          config,
          oracles: deps.oracles,
          evidenceRoot: deps.evidenceRoot,
          trigger: options.trigger,
          context: { jobId: options.jobId, ...git, baseUrl: env.baseUrl },
          logger: logger.child(`run:${workflow.id}`),
        });
        await store.evidence.insertMany(evidence);
        await store.runs.insert(run);
        for (const finding of await recordFindings(
          store,
          { run, workflow, target, evidence },
          logger,
        )) {
          touched.set(finding.id, finding);
        }
        runs.push(run);
        done += 1;
        options.onRun?.(run, workflow, done, workflows.length);
      });
    });

    await triageTarget(deps, options, target, touched);
  }

  const stats = computeStats(runs);
  let reportPath: string | undefined;
  if (options.report !== false && runs.length > 0) {
    const usage = options.jobId ? await store.usage.totals({ jobId: options.jobId }) : undefined;
    const markdown = renderReport({
      title: `MutationWorkflow run (${options.trigger})`,
      generatedAt: nowIso(),
      targetIds: options.targets.map((t) => t.id),
      runs,
      workflows: workflowsById,
      findings: [...touched.values()],
      stats,
      usage,
      evidenceRoot: deps.evidenceRoot,
    });
    reportPath = writeReport(deps.reportsDir, 'run', markdown);
    logger.info(`Report written to ${reportPath}`);
  }
  return {
    runs,
    findings: [...touched.values()],
    stats,
    reportPath,
    durationMs: Date.now() - started,
  };
}

async function selectWorkflows(
  store: Store,
  targetId: string,
  options: RunOptions,
): Promise<Workflow[]> {
  const all = await store.workflows.list({
    targetId,
    status: ['active', 'pending-review'],
    ...(options.workflowIds ? { ids: options.workflowIds } : {}),
  });
  switch (options.include ?? 'all') {
    case 'base':
      return all.filter((w) => !w.parentId);
    case 'mutations':
      return all.filter((w) => Boolean(w.parentId));
    default:
      return all;
  }
}

async function triageTarget(
  deps: RunDeps,
  options: RunOptions,
  target: TargetConfig,
  touched: Map<string, Finding>,
): Promise<void> {
  if (options.triage === false) return;
  const pending = [...touched.values()].filter(
    (f) => f.targetId === target.id && f.triage.state === 'pending',
  );
  if (pending.length === 0) return;
  if (deps.runtime?.enabled) {
    const updated = await triageFindings(
      {
        store: deps.store,
        runtime: deps.runtime,
        target,
        evidenceRoot: deps.evidenceRoot,
        logger: deps.logger,
        jobId: options.jobId,
        signal: options.signal,
        onEvent: options.onEvent,
      },
      pending,
    );
    for (const finding of updated) touched.set(finding.id, finding);
    return;
  }
  // Without a model provider nobody can judge them now; mark them so they do not look stuck.
  for (const finding of pending) {
    const skipped = FindingSchema.parse({ ...finding, triage: { state: 'skipped' } });
    await deps.store.findings.update(skipped);
    touched.set(skipped.id, skipped);
  }
}

export function computeStats(runs: ReadonlyArray<Run>): RunStats {
  const stats: RunStats = { total: runs.length, passed: 0, failed: 0, blocked: 0, error: 0 };
  for (const run of runs) {
    stats[run.status] += 1;
    if (!stats.lastRunAt || run.finishedAt > stats.lastRunAt) stats.lastRunAt = run.finishedAt;
  }
  return stats;
}
