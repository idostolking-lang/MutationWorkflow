import { join } from 'node:path';
import type { Finding, Run, Workflow } from '../schema/index.js';
import type { RunStats, UsageTotals } from '../store/types.js';
import { ensureDir, slugify, writeFileAtomic } from '../util/fs.js';
import { pluralize } from '../util/text.js';

export interface ReportInput {
  title: string;
  generatedAt: string;
  targetIds: string[];
  runs: Run[];
  workflows: ReadonlyMap<string, Workflow>;
  /** Findings created or updated by these runs. */
  findings: Finding[];
  stats: RunStats;
  usage?: UsageTotals;
  /** Evidence root, shown so paths in the report can be opened. */
  evidenceRoot: string;
}

/** Render a run report as Markdown: summary, findings with reproduction steps, run table. */
export function renderReport(input: ReportInput): string {
  const lines: string[] = [];
  lines.push(`# ${input.title}`, '');
  lines.push(
    `Generated ${input.generatedAt} for ${input.targetIds.map((t) => `\`${t}\``).join(', ')}.`,
    '',
  );

  lines.push('## Summary', '');
  lines.push('| Passed | Failed | Blocked | Error | Total |', '| --- | --- | --- | --- | --- |');
  const s = input.stats;
  lines.push(`| ${s.passed} | ${s.failed} | ${s.blocked} | ${s.error} | ${s.total} |`, '');
  if (input.usage && input.usage.calls > 0) {
    const u = input.usage;
    const cost = u.costUsd > 0 ? `, about $${u.costUsd.toFixed(2)}` : '';
    lines.push(
      `Model usage: ${u.calls} calls, ${u.inputTokens.toLocaleString()} input and ${u.outputTokens.toLocaleString()} output tokens${cost}.`,
      '',
    );
  }

  lines.push(`## Findings (${input.findings.length})`, '');
  if (input.findings.length === 0) {
    lines.push('No findings from these runs.', '');
  }
  for (const finding of input.findings) {
    lines.push(`### ${finding.title}`, '');
    lines.push(
      `- Severity: **${finding.severity}** · Status: ${finding.status} · Detected by: ${finding.detectedBy} · Seen ${pluralize(finding.occurrences, 'time')}`,
    );
    if (finding.triage.verdict) {
      const rationale = finding.triage.rationale ? ` (${finding.triage.rationale})` : '';
      lines.push(`- Triage: ${finding.triage.verdict}${rationale}`);
    }
    lines.push(`- Id: \`${finding.id}\``, '');
    if (finding.summary) lines.push(finding.summary, '');
    if (finding.reproduction) {
      const workflow = input.workflows.get(finding.reproduction.workflowId);
      lines.push(`Reproduction${workflow ? ` (workflow "${workflow.title}")` : ''}:`, '');
      if (finding.reproduction.mutation) {
        lines.push(`Mutation: ${finding.reproduction.mutation.description}`, '');
      }
      for (const [index, step] of finding.reproduction.steps.entries()) {
        const note = step.note ? ` (${step.note})` : '';
        lines.push(`${index + 1}. ${describeAction(step.action)}${note}`);
      }
      lines.push('');
    }
    if (finding.evidenceIds.length > 0) {
      lines.push(
        `Evidence: ${pluralize(finding.evidenceIds.length, 'item')} under \`${input.evidenceRoot}\`.`,
        '',
      );
    }
  }

  const failed = input.runs.filter((run) => run.status !== 'passed');
  lines.push(`## Runs (${input.runs.length}, ${failed.length} not passing)`, '');
  lines.push(
    '| Status | Workflow | Mutation | Duration | Run |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const run of input.runs) {
    const workflow = input.workflows.get(run.workflowId);
    const seconds = (run.durationMs / 1000).toFixed(1);
    lines.push(
      `| ${run.status} | ${workflow?.title ?? run.workflowId} | ${workflow?.mutation?.description ?? ''} | ${seconds}s | \`${run.id}\` |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** One-line human rendering of an action, e.g. `click target={"role":"button","name":"Add"}`. */
export function describeAction(action: Record<string, unknown>): string {
  const { type, ...params } = action;
  const rendered = Object.entries(params)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ');
  return rendered ? `${String(type)} ${rendered}` : String(type);
}

/** Write a report into the reports directory and return its path. */
export function writeReport(reportsDir: string, name: string, markdown: string): string {
  ensureDir(reportsDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(reportsDir, `${stamp}-${slugify(name)}.md`);
  writeFileAtomic(path, markdown);
  return path;
}
