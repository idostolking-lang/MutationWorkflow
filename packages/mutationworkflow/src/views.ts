/**
 * Compact, JSON-friendly views of domain records. They keep MCP responses and persisted job
 * results small; full records are available through the detail tools and commands.
 */
import type {
  ExploreResult,
  Finding,
  ImpactReport,
  Job,
  MutateResult,
  Run,
  RunSummary,
  SetupResult,
  Severity,
  Workflow,
  WorkflowTouches,
} from '@mutationworkflow/core';

export interface FindingView {
  id: string;
  targetId: string;
  title: string;
  severity: Severity;
  status: Finding['status'];
  triage: string;
  occurrences: number;
  lastSeenAt: string;
}

/** Compact finding: identity, severity, status and triage outcome. */
export function findingView(finding: Finding): FindingView {
  return {
    id: finding.id,
    targetId: finding.targetId,
    title: finding.title,
    severity: finding.severity,
    status: finding.status,
    triage: finding.triage.verdict ?? finding.triage.state,
    occurrences: finding.occurrences,
    lastSeenAt: finding.lastSeenAt,
  };
}

export interface WorkflowView {
  id: string;
  targetId: string;
  title: string;
  status: Workflow['status'];
  origin: Workflow['origin'];
  steps: number;
  parentId?: string;
  mutation?: string;
  /** Pages, endpoints and files the workflow was seen to exercise, once it has run. */
  touches?: WorkflowTouches;
}

/** Compact workflow: identity, status, origin, step count, mutation and learned footprint. */
export function workflowView(workflow: Workflow): WorkflowView {
  return {
    id: workflow.id,
    targetId: workflow.targetId,
    title: workflow.title,
    status: workflow.status,
    origin: workflow.origin,
    steps: workflow.steps.length,
    ...(workflow.parentId ? { parentId: workflow.parentId } : {}),
    ...(workflow.mutation ? { mutation: workflow.mutation.description } : {}),
    ...(workflow.touches ? { touches: workflow.touches } : {}),
  };
}

/** An impact report with every workflow reduced to its compact view. */
export function impactView(report: ImpactReport) {
  return {
    changedFiles: report.changedFiles,
    ...(report.range ? { range: report.range } : {}),
    targets: report.targets.map((target) => ({
      targetId: target.targetId,
      sharedChange: target.sharedChange,
      impacted: target.impacted.map(workflowView),
      unknown: target.unknown.map(workflowView),
      unaffected: target.unaffected.map(workflowView),
    })),
  };
}

export interface JobView {
  id: string;
  kind: Job['kind'];
  status: Job['status'];
  progress?: string;
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

/** Compact job without params or result. */
export function jobView(job: Job): JobView {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    ...(job.progress ? { progress: progressText(job.progress) } : {}),
    ...(job.error ? { error: job.error } : {}),
    createdAt: job.createdAt,
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
  };
}

/** "Running 3/10: Add item" style progress text. */
export function progressText(progress: NonNullable<Job['progress']>): string {
  const counter =
    progress.current !== undefined
      ? ` (${progress.current}${progress.total !== undefined ? `/${progress.total}` : ''})`
      : '';
  return `${progress.message}${counter}`;
}

export interface RunView {
  id: string;
  workflowId: string;
  status: Run['status'];
  durationMs: number;
  title?: string;
  mutation?: string;
  error?: string;
}

/** Compact run, with the workflow title when known. */
export function runView(run: Run, workflow?: Workflow): RunView {
  return {
    id: run.id,
    workflowId: run.workflowId,
    status: run.status,
    durationMs: run.durationMs,
    ...(workflow ? { title: workflow.title } : {}),
    ...(workflow?.mutation ? { mutation: workflow.mutation.description } : {}),
    ...(run.error ? { error: run.error } : {}),
  };
}

/** Job result of `setup`. */
export function summarizeSetup(result: SetupResult) {
  return {
    summary: result.report.summary,
    configPath: result.configPath,
    configAction: result.configAction,
    targets: result.report.targets.map((t) => ({ id: t.id, kind: t.kind })),
    workflows: result.workflows.map(workflowView),
    questions: result.questions.map((q) => ({ id: q.id, question: q.question })),
    validation: result.validation,
    risks: result.report.risks,
  };
}

/** Result of exploring one target. */
export interface TargetExploreResult {
  targetId: string;
  result: ExploreResult;
}

/** Job result of `explore`. */
export function summarizeExplore(results: ReadonlyArray<TargetExploreResult>) {
  return results.map(({ targetId, result }) => ({
    targetId,
    workflows: result.workflows.map(workflowView),
    questions: result.questions.map((q) => ({ id: q.id, question: q.question })),
    stoppedBecause: result.stoppedBecause,
  }));
}

/** Result of mutating one target. */
export interface TargetMutateResult {
  targetId: string;
  result: MutateResult;
}

/** Job result of `mutate`. */
export function summarizeMutate(results: ReadonlyArray<TargetMutateResult>) {
  return results.map(({ targetId, result }) => ({
    targetId,
    bases: result.bases,
    created: result.created.length,
    fromOperators: result.fromOperators,
    fromAgent: result.fromAgent,
  }));
}

/** Job result of `run`: stats, report path, touched findings and runs that did not pass. */
export function summarizeRun(summary: RunSummary) {
  return {
    stats: summary.stats,
    durationMs: summary.durationMs,
    reportPath: summary.reportPath,
    findings: summary.findings.map(findingView),
    notPassing: summary.runs.filter((r) => r.status !== 'passed').map((r) => runView(r)),
    ...(summary.selection ? { selection: summary.selection } : {}),
    ...(summary.errors.length > 0 ? { errors: summary.errors } : {}),
  };
}

/** Job result of `triage`. */
export function summarizeTriage(findings: ReadonlyArray<Finding>) {
  return { reviewed: findings.length, findings: findings.map(findingView) };
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/** Findings at or above `threshold` that still matter (not dismissed or fixed). */
export function findingsAtOrAbove(
  findings: ReadonlyArray<Finding>,
  threshold: Severity,
): Finding[] {
  return findings.filter(
    (f) =>
      SEVERITY_RANK[f.severity] >= SEVERITY_RANK[threshold] &&
      f.status !== 'dismissed' &&
      f.status !== 'fixed',
  );
}
