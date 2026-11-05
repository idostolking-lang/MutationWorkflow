import { join, relative, sep } from 'node:path';
import type { Evidence, Finding, Footprint, Run, Workflow } from '../schema/index.js';
import type { RunStats, UsageTotals } from '../store/types.js';
import { ensureDir, slugify, writeFileAtomic } from '../util/fs.js';
import { pluralize } from '../util/text.js';
import { methodOf, normalizePath } from './codemap.js';

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
  /** Evidence from these runs by id; screenshots among it are embedded under the findings. */
  evidence?: ReadonlyMap<string, Evidence>;
  /** Directory the report is written to; image paths are made relative to it. */
  reportsDir?: string;
  /** Why these workflows were chosen, when the run was limited to a code change. */
  selection?: { changedFiles: string[]; everything: boolean };
}

const MAX_SCREENSHOTS_PER_FINDING = 3;
const MAX_COVERAGE_ENTRIES = 40;

/**
 * Render a run report as Markdown: summary, what the runs exercised, findings with reproduction
 * steps and screenshots, and the run table.
 */
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
  if (input.selection) {
    const n = input.selection.changedFiles.length;
    lines.push(
      input.selection.everything
        ? `${pluralize(n, 'changed file')}; every workflow was replayed.`
        : `${pluralize(n, 'changed file')}; only the workflows that exercise them, and workflows never run before, were replayed.`,
      '',
    );
  }
  if (input.usage && input.usage.calls > 0) {
    const u = input.usage;
    const cost = u.costUsd > 0 ? `, about $${u.costUsd.toFixed(2)}` : '';
    lines.push(
      `Model usage: ${u.calls} calls, ${u.inputTokens.toLocaleString()} input and ${u.outputTokens.toLocaleString()} output tokens${cost}.`,
      '',
    );
  }

  const coverage = summarizeFootprints(input.runs.map((run) => run.touched));
  if (coverage.pages.length > 0 || coverage.endpoints.length > 0) {
    lines.push('## What these runs exercised', '');
    if (coverage.pages.length > 0) {
      lines.push(`Pages: ${coverage.pages.map((p) => `\`${p}\``).join(', ')}`, '');
    }
    if (coverage.endpoints.length > 0) {
      lines.push(`Endpoints: ${coverage.endpoints.map((e) => `\`${e}\``).join(', ')}`, '');
    }
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
    const run = latestRun(input.runs, finding.runIds);
    if (run && (run.touched.urls.length > 0 || run.touched.endpoints.length > 0)) {
      lines.push(`- Touched: ${describeFootprint(run.touched)}`);
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
    const screenshots = screenshotsFor(finding, input);
    for (const shot of screenshots) {
      lines.push(`![${shot.label}](${shot.path})`, '');
    }
    if (finding.evidenceIds.length > screenshots.length) {
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

/** `2 pages (/, /settings) and 3 endpoints (GET /api/todos, POST /api/todos, …)`. */
export function describeFootprint(footprint: Footprint): string {
  const parts: string[] = [];
  if (footprint.urls.length > 0) {
    parts.push(`${pluralize(footprint.urls.length, 'page')} (${footprint.urls.join(', ')})`);
  }
  if (footprint.endpoints.length > 0) {
    parts.push(
      `${pluralize(footprint.endpoints.length, 'endpoint')} (${footprint.endpoints.join(', ')})`,
    );
  }
  return parts.join(' and ');
}

/**
 * Union of footprints with ids normalised away and methods grouped per path, e.g.
 * `/api/todos/* (DELETE, PUT)`.
 */
export function summarizeFootprints(footprints: ReadonlyArray<Footprint>): {
  pages: string[];
  endpoints: string[];
} {
  const pages = new Set<string>();
  const methods = new Map<string, Set<string>>();
  for (const footprint of footprints) {
    for (const url of footprint.urls) pages.add(normalizePath(url));
    for (const endpoint of footprint.endpoints) {
      const path = normalizePath(endpoint);
      const method = methodOf(endpoint);
      const set = methods.get(path) ?? new Set<string>();
      if (method) set.add(method);
      methods.set(path, set);
    }
  }
  const endpoints = [...methods.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, set]) => (set.size > 0 ? `${path} (${[...set].sort().join(', ')})` : path));
  return {
    pages: [...pages].sort().slice(0, MAX_COVERAGE_ENTRIES),
    endpoints: endpoints.slice(0, MAX_COVERAGE_ENTRIES),
  };
}

function latestRun(runs: ReadonlyArray<Run>, ids: ReadonlyArray<string>): Run | undefined {
  let latest: Run | undefined;
  for (const run of runs) {
    if (ids.includes(run.id) && (!latest || run.startedAt > latest.startedAt)) latest = run;
  }
  return latest;
}

function screenshotsFor(finding: Finding, input: ReportInput): { label: string; path: string }[] {
  if (!input.evidence) return [];
  const shots: { label: string; path: string }[] = [];
  for (const id of finding.evidenceIds) {
    const item = input.evidence.get(id);
    if (!item || item.kind !== 'screenshot' || !item.path) continue;
    const absolute = join(input.evidenceRoot, item.path);
    const path = input.reportsDir ? relative(input.reportsDir, absolute) : absolute;
    shots.push({ label: item.label ?? 'screenshot', path: path.split(sep).join('/') });
  }
  return shots.slice(-MAX_SCREENSHOTS_PER_FINDING);
}

/** Write a report into the reports directory and return its path. */
export function writeReport(reportsDir: string, name: string, markdown: string): string {
  ensureDir(reportsDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(reportsDir, `${stamp}-${slugify(name)}.md`);
  writeFileAtomic(path, markdown);
  return path;
}
