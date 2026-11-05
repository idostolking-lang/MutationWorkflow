import {
  computeStats,
  type Engine,
  nowIso,
  renderReport,
  type Workflow,
  writeReport,
} from '@mutationworkflow/core';

export interface LatestReport {
  /** Undefined when there are no runs to report on. */
  path?: string;
  markdown: string;
  runs: number;
}

/**
 * Render a report of the latest `limit` runs across all targets, with the findings those runs
 * contributed to, and write it into the reports directory.
 */
export async function writeLatestReport(engine: Engine, limit = 50): Promise<LatestReport> {
  const runs = await engine.store.runs.list({ limit });
  if (runs.length === 0) {
    return { markdown: 'No runs recorded yet. Run `mw run` first.', runs: 0 };
  }
  const workflowIds = [...new Set(runs.map((run) => run.workflowId))];
  const workflows = new Map<string, Workflow>(
    (await engine.store.workflows.list({ ids: workflowIds })).map((w) => [w.id, w]),
  );
  const runIds = new Set(runs.map((run) => run.id));
  const findings = (await engine.store.findings.list({ status: ['open', 'confirmed'] })).filter(
    (finding) => finding.runIds.some((id) => runIds.has(id)),
  );
  const markdown = renderReport({
    title: `MutationWorkflow report (latest ${runs.length} runs)`,
    generatedAt: nowIso(),
    targetIds: [...new Set(runs.map((run) => run.targetId))],
    runs,
    workflows,
    findings,
    stats: computeStats(runs),
    evidenceRoot: engine.evidenceRoot,
  });
  return { path: writeReport(engine.reportsDir, 'report', markdown), markdown, runs: runs.length };
}
