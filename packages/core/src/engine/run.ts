import type { AgentEvent, AgentRuntime } from '../agents/runtime.js';
import type { Config } from '../config/schema.js';
import { type EnvironmentManager, withEnvironment } from '../environment/manager.js';
import type { Oracle } from '../oracles/types.js';
import {
  type Evidence,
  type Finding,
  FindingSchema,
  type Footprint,
  nowIso,
  type Run,
  type RunTrigger,
  type TargetConfig,
  type Workflow,
  WorkflowSchema,
} from '../schema/index.js';
import type { RunStats, Store } from '../store/types.js';
import { errorMessage, MutationWorkflowError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { mapWithConcurrency, Semaphore } from '../util/semaphore.js';
import type { AdapterRegistry } from './adapters.js';
import {
  type CodeMapper,
  createCodeMapper,
  indexRepository,
  type RepositoryIndex,
} from './codemap.js';
import { executeWorkflow } from './executor.js';
import { getGitContext } from './git.js';
import { impactOnTarget, selectForChange } from './impact.js';
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
  /**
   * Files changed since the last run, relative to the project root. Only workflows whose learned
   * footprint overlaps them replay, plus workflows that have never run; a change to a shared
   * file (manifest, lockfile, global config) replays everything.
   */
  changedFiles?: string[];
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  onRun?: (run: Run, workflow: Workflow, done: number, total: number) => void;
}

/** How a change narrowed the workflows of one target. */
export interface SelectionSummary {
  targetId: string;
  changedFiles: number;
  /** Base workflows replayed because their footprint overlaps the change. */
  impacted: number;
  /** Base workflows replayed because nothing is known about them yet. */
  unknown: number;
  /** Base workflows skipped because they do not touch the changed files. */
  skipped: number;
  /** Everything was replayed: a shared file changed, or no workflow has a footprint yet. */
  everything: boolean;
}

export interface RunSummary {
  runs: Run[];
  /** Findings created or updated by these runs, after triage. */
  findings: Finding[];
  stats: RunStats;
  reportPath?: string;
  durationMs: number;
  /** Infrastructure problems that prevented some work (environment, storage, triage). */
  errors: string[];
  /** Per target, how the change narrowed the run; only when `changedFiles` was given. */
  selection?: SelectionSummary[];
}

/** Store key of the commit the last completed run saw; `--changed` diffs from it by default. */
export const LAST_RUN_COMMIT_KEY = 'last-run-commit';

/**
 * Replay workflows against each target in a freshly started environment, record runs and
 * evidence, fold failures into findings, triage them, and write a report. One failing workflow,
 * environment or triage call never aborts the rest: problems are collected in `errors`.
 */
export async function runWorkflows(deps: RunDeps, options: RunOptions): Promise<RunSummary> {
  const { store, config, logger } = deps;
  const started = Date.now();
  const git = await getGitContext(deps.rootDir);
  const runs: Run[] = [];
  const errors: string[] = [];
  const workflowsById = new Map<string, Workflow>();
  const evidenceById = new Map<string, Evidence>();
  const touched = new Map<string, Finding>();
  const selection: SelectionSummary[] = [];
  // Runs execute in parallel, but persistence is serial: two runs hitting the same problem must
  // merge into one finding instead of racing on its fingerprint.
  const persist = new Semaphore(1);
  // The repository is read once for every target's code map, and only if a run touched anything.
  let repository: RepositoryIndex | undefined;
  const indexed = () => {
    repository ??= indexRepository(deps.rootDir);
    return repository;
  };

  for (const target of options.targets) {
    if (options.signal?.aborted) break;
    const selected = await selectWorkflows(store, target.id, options);
    if (selected.selection) selection.push(selected.selection);
    const { workflows } = selected;
    if (workflows.length === 0) {
      logger.info(
        options.changedFiles
          ? `No workflow of target "${target.id}" is affected by the change`
          : `No workflows to run for target "${target.id}"`,
      );
      continue;
    }
    for (const workflow of workflows) workflowsById.set(workflow.id, workflow);
    const mapper = createCodeMapper({
      rootDir: deps.rootDir,
      rules: target.codemap,
      repository: indexed,
    });
    const parallel = config.execution.resetBetweenRuns
      ? 1
      : (options.parallel ?? config.execution.parallel);
    logger.info(
      `Running ${workflows.length} workflow(s) for "${target.id}" with parallelism ${parallel}`,
    );

    try {
      const adapter = await deps.registry.forTarget(target);
      await withEnvironment(deps.environments, target, async (env) => {
        let done = 0;
        await mapWithConcurrency(workflows, parallel, async (workflow) => {
          if (options.signal?.aborted) return;
          try {
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
            // A run interrupted by a shutdown is not evidence of anything.
            if (options.signal?.aborted) return;
            await persist.use(async () => {
              await store.evidence.insertMany(evidence);
              await store.runs.insert(run);
              for (const item of evidence) evidenceById.set(item.id, item);
              await learnTouches(store, mapper, workflow, run);
              const findings = await recordFindings(
                store,
                { run, workflow, target, evidence },
                logger,
              );
              for (const finding of findings) touched.set(finding.id, finding);
            });
            runs.push(run);
            done += 1;
            options.onRun?.(run, workflow, done, workflows.length);
          } catch (error) {
            const message = `Workflow "${workflow.title}" (${workflow.id}) could not be run or recorded: ${errorMessage(error)}`;
            logger.error(message);
            errors.push(message);
          }
        });
      });
    } catch (error) {
      const message = `Target "${target.id}": ${errorMessage(error)}`;
      logger.error(message);
      errors.push(message);
      continue;
    }

    try {
      await triageTarget(deps, options, target, touched);
    } catch (error) {
      const message = `Triage for "${target.id}" failed; findings stay pending: ${errorMessage(error)}`;
      logger.error(message);
      errors.push(message);
    }
  }

  if (git.commit && runs.length > 0 && !options.signal?.aborted) {
    await store.meta
      .set(LAST_RUN_COMMIT_KEY, git.commit)
      .catch((error: unknown) => errors.push(`Last run commit not saved: ${errorMessage(error)}`));
  }

  const stats = computeStats(runs);
  let reportPath: string | undefined;
  if (options.report !== false && runs.length > 0) {
    try {
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
        evidence: evidenceById,
        reportsDir: deps.reportsDir,
        selection: options.changedFiles
          ? {
              changedFiles: options.changedFiles,
              everything: selection.every((entry) => entry.everything),
            }
          : undefined,
      });
      reportPath = writeReport(deps.reportsDir, 'run', markdown);
      logger.info(`Report written to ${reportPath}`);
    } catch (error) {
      errors.push(`Report could not be written: ${errorMessage(error)}`);
    }
  }
  return {
    runs,
    findings: [...touched.values()],
    stats,
    reportPath,
    durationMs: Date.now() - started,
    errors,
    ...(options.changedFiles ? { selection } : {}),
  };
}

async function selectWorkflows(
  store: Store,
  targetId: string,
  options: RunOptions,
): Promise<{ workflows: Workflow[]; selection?: SelectionSummary }> {
  const include = options.include ?? 'all';
  let ids = options.workflowIds;
  let selection: SelectionSummary | undefined;
  if (options.changedFiles) {
    const impact = await impactOnTarget(store, targetId, options.changedFiles);
    const chosen = await selectForChange(store, impact);
    selection = {
      targetId,
      changedFiles: options.changedFiles.length,
      impacted: impact.impacted.length,
      unknown: impact.unknown.length,
      skipped: chosen ? impact.unaffected.length : 0,
      everything: chosen === undefined,
    };
    if (chosen) {
      ids = ids ? ids.filter((id) => chosen.includes(id)) : chosen;
      if (ids.length === 0) return { workflows: [], selection };
    }
  }
  const workflows = await store.workflows.list({
    targetId,
    status: ['active', 'pending-review'],
    ...(ids ? { ids } : {}),
    ...(include === 'base'
      ? { hasParent: false }
      : include === 'mutations'
        ? { hasParent: true }
        : {}),
  });
  return { workflows, selection };
}

/**
 * Fold what a run touched into its workflow and, for a variant, into the base workflow, and
 * refresh the files the code map derives from the accumulated footprint.
 */
async function learnTouches(
  store: Store,
  mapper: CodeMapper,
  workflow: Workflow,
  run: Run,
): Promise<void> {
  if (run.touched.urls.length === 0 && run.touched.endpoints.length === 0) return;
  const ids = workflow.parentId ? [workflow.id, workflow.parentId] : [workflow.id];
  for (const id of ids) {
    // Re-read: another run of the same workflow may have updated it meanwhile.
    const current = await store.workflows.get(id);
    if (!current) continue;
    const updated = mergeTouches(current, run.touched, mapper);
    if (updated) await store.workflows.update(updated);
  }
}

/** The workflow with the footprint merged in, or undefined when nothing changed. */
export function mergeTouches(
  workflow: Workflow,
  footprint: Footprint,
  mapper: CodeMapper,
): Workflow | undefined {
  const urls = union(workflow.touches?.urls ?? [], footprint.urls);
  const endpoints = union(workflow.touches?.endpoints ?? [], footprint.endpoints);
  const files = mapper.filesFor({ urls, endpoints });
  const previous = workflow.touches;
  if (
    previous &&
    sameList(previous.urls, urls) &&
    sameList(previous.endpoints, endpoints) &&
    sameList(previous.files, files)
  ) {
    return undefined;
  }
  const updatedAt = nowIso();
  return WorkflowSchema.parse({
    ...workflow,
    touches: { urls, endpoints, files, updatedAt },
    updatedAt,
  });
}

function union(first: ReadonlyArray<string>, second: ReadonlyArray<string>): string[] {
  return [...new Set([...first, ...second])];
}

function sameList(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
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
    try {
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
    } catch (error) {
      // A missing model for the triager role is a configuration problem: treat it like having
      // no provider. Anything else (rate limits, network) leaves the findings pending for later.
      if (!(error instanceof MutationWorkflowError && error.code === 'PROVIDER_NOT_CONFIGURED')) {
        throw error;
      }
      deps.logger.warn(`Triage skipped: ${error.message}`);
    }
  }
  // Nobody can judge them now; mark them so they do not look stuck.
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
