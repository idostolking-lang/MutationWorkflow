/**
 * Plain-text rendering for the CLI and the MCP server. Every function is pure: data in, string
 * out, colour only when a `Colors` instance is passed.
 */
import {
  type AgentEvent,
  describeAction,
  type Finding,
  type Job,
  type Question,
  type Run,
  type RunSummary,
  type SetupResult,
  type StatusSummary,
  type UsageTotals,
  type Workflow,
} from '@mutationworkflow/core';
import pc from 'picocolors';
import type { Colors } from 'picocolors/types.js';
import type { FindingDetail, WorkflowDetail } from './details.js';
import { progressText, type TargetExploreResult, type TargetMutateResult } from './views.js';

/** Colour functions that return their input unchanged. */
export const plain: Colors = pc.createColors(false);

/** Left-aligned columns separated by two spaces; the last column is not padded. */
export function table(headers: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>) {
  const all = [headers, ...rows];
  const widths = headers.map((_, column) =>
    Math.max(...all.map((row) => (row[column] ?? '').length)),
  );
  return all
    .map((row) =>
      row
        .map((cell, column) =>
          column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0),
        )
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/** Shorten text to one line of at most `max` characters. */
export function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** 950 → "950", 12_345 → "12.3k", 4_200_000 → "4.2M". */
export function compactNumber(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** 850 → "850ms", 12_300 → "12.3s", 125_000 → "2m 5s". */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms - minutes * 60_000) / 1_000)}s`;
}

export function formatUsage(usage: UsageTotals): string {
  if (usage.calls === 0) return 'no model calls yet';
  const cost = usage.costUsd > 0 ? `, about $${usage.costUsd.toFixed(2)}` : '';
  return `${usage.calls} calls, ${compactNumber(usage.inputTokens)} input / ${compactNumber(usage.outputTokens)} output tokens${cost}`;
}

export function formatStatus(status: StatusSummary): string {
  const lines: string[] = [];
  const { project } = status;
  lines.push(
    `${project.name}  ${project.rootDir}`,
    `config: ${project.configPath ?? 'none (run "mw setup" or "mw init")'}`,
    '',
  );
  if (status.targets.length === 0) {
    lines.push('No targets configured.');
  } else {
    lines.push(
      table(
        [
          'TARGET',
          'KIND',
          'BASE',
          'MUTATIONS',
          'REVIEW',
          'RUNS P/F/B/E',
          'OPEN C/H/M/L',
          'QUESTIONS',
        ],
        status.targets.map((t) => {
          const s = t.findings.bySeverity;
          return [
            t.id,
            t.kind,
            String(t.workflows.base),
            String(t.workflows.mutations),
            String(t.workflows.pendingReview),
            `${t.runs.total} (${t.runs.passed}/${t.runs.failed}/${t.runs.blocked}/${t.runs.error})`,
            `${s.critical}/${s.high}/${s.medium}/${s.low}`,
            String(t.openQuestions),
          ];
        }),
      ),
    );
  }
  lines.push('');
  const { agents } = status;
  if (agents.enabled) {
    lines.push(
      `agents: enabled, providers ${agents.providers.join(', ') || 'none'}, max parallel ${agents.maxParallel}`,
    );
    const models = Object.entries(agents.models).map(([role, model]) => `${role}=${model}`);
    if (models.length > 0) lines.push(`models: ${models.join(', ')}`);
  } else {
    lines.push('agents: disabled (set ANTHROPIC_API_KEY or OPENAI_API_KEY)');
  }
  lines.push(`usage: ${formatUsage(status.usage)}`);
  if (status.openQuestions > 0) {
    lines.push(`${status.openQuestions} open question(s): see "mw questions"`);
  }
  return lines.join('\n');
}

export function formatFindings(findings: ReadonlyArray<Finding>): string {
  if (findings.length === 0) return 'No findings.';
  return table(
    ['ID', 'SEVERITY', 'STATUS', 'TRIAGE', 'SEEN', 'TARGET', 'TITLE'],
    findings.map((f) => [
      f.id,
      f.severity,
      f.status,
      f.triage.verdict ?? f.triage.state,
      `${f.occurrences}x`,
      f.targetId,
      oneLine(f.title),
    ]),
  );
}

export function formatFindingDetail(detail: FindingDetail): string {
  const { finding: f } = detail;
  const lines = [
    f.title,
    `${f.id} · ${f.severity} · ${f.status} · target ${f.targetId} · detected by ${f.detectedBy}`,
    `seen ${f.occurrences}x, first ${f.firstSeenAt}, last ${f.lastSeenAt}`,
    '',
  ];
  if (f.summary) lines.push(f.summary, '');
  const triage = f.triage.verdict
    ? `${f.triage.verdict}${f.triage.rationale ? `: ${f.triage.rationale}` : ''}`
    : f.triage.state;
  lines.push(`Triage: ${triage}`, '');
  if (f.reproduction) {
    const title = detail.workflow ? ` "${detail.workflow.title}"` : '';
    lines.push(`Reproduction (workflow ${f.reproduction.workflowId}${title}):`);
    if (f.reproduction.mutation) lines.push(`Mutation: ${f.reproduction.mutation.description}`);
    lines.push(...formatSteps(f.reproduction.steps), '');
  }
  if (detail.evidence.length > 0) {
    lines.push('Evidence:');
    for (const item of detail.evidence) {
      const label = item.label ? ` "${item.label}"` : '';
      const where = item.path ?? (item.text !== undefined ? oneLine(item.text, 100) : '');
      lines.push(`  ${item.id}  ${item.kind}${label}  ${where}`);
    }
    lines.push('');
  }
  if (f.notes) lines.push(`Notes: ${f.notes}`, '');
  return lines.join('\n').trimEnd();
}

/** Numbered steps, e.g. `  1. click target={"role":"button"} (add the item)`. */
export function formatSteps(steps: Workflow['steps']): string[] {
  return steps.map(
    (step, index) =>
      `  ${index + 1}. ${describeAction(step.action)}${step.note ? ` (${step.note})` : ''}`,
  );
}

export function formatWorkflows(workflows: ReadonlyArray<Workflow>): string {
  if (workflows.length === 0) return 'No workflows.';
  return table(
    ['ID', 'TARGET', 'STATUS', 'ORIGIN', 'STEPS', 'TITLE'],
    workflows.map((w) => [
      w.id,
      w.targetId,
      w.status,
      w.origin,
      String(w.steps.length),
      oneLine(w.mutation ? `${w.title} [${w.mutation.description}]` : w.title, 90),
    ]),
  );
}

export function formatWorkflowDetail(detail: WorkflowDetail): string {
  const { workflow: w } = detail;
  const lines = [
    w.title,
    `${w.id} · ${w.status} · ${w.origin} · target ${w.targetId}${w.identity ? ` · as ${w.identity}` : ''}`,
    `Intent: ${w.intent}`,
  ];
  if (detail.parent) lines.push(`Mutation of ${detail.parent.id} "${detail.parent.title}"`);
  if (w.mutation) lines.push(`Mutation: ${w.mutation.description} (${w.mutation.operator})`);
  if (detail.variants > 0) lines.push(`Variants: ${detail.variants}`);
  if (w.source?.file)
    lines.push(`Source: ${w.source.file}${w.source.name ? ` › ${w.source.name}` : ''}`);
  if (w.tags.length > 0) lines.push(`Tags: ${w.tags.join(', ')}`);
  lines.push('', 'Steps:', ...formatSteps(w.steps));
  if (w.expect.length > 0) {
    lines.push('', 'Final expectations:', ...w.expect.map((a) => `  - ${describeAction(a)}`));
  }
  if (detail.lastRun) {
    const run = detail.lastRun;
    lines.push(
      '',
      `Last run: ${run.status} ${run.finishedAt} (${formatDuration(run.durationMs)}) ${run.id}`,
    );
  }
  return lines.join('\n');
}

export function formatQuestions(questions: ReadonlyArray<Question>): string {
  if (questions.length === 0) return 'No questions.';
  return questions
    .map((q) => {
      const head = `${q.id}  ${q.kind}${q.targetId ? `  ${q.targetId}` : ''}  ${q.status}${q.decision ? ` (${q.decision})` : ''}`;
      const refs = [
        q.context.workflowId && `workflow ${q.context.workflowId}`,
        q.context.findingId && `finding ${q.context.findingId}`,
      ].filter(Boolean);
      return [
        head,
        `  ${q.question}`,
        ...(refs.length > 0 ? [`  re: ${refs.join(', ')}`] : []),
      ].join('\n');
    })
    .join('\n\n');
}

export function formatJobs(jobs: ReadonlyArray<Job>): string {
  if (jobs.length === 0) return 'No jobs.';
  return table(
    ['ID', 'KIND', 'STATUS', 'CREATED', 'PROGRESS'],
    jobs.map((j) => [
      j.id,
      j.kind,
      j.status,
      j.createdAt,
      oneLine(j.error ?? (j.progress ? progressText(j.progress) : ''), 70),
    ]),
  );
}

export function formatJobDetail(job: Omit<Job, 'result'> & { result?: unknown }): string {
  const lines = [`${job.id} · ${job.kind} · ${job.status}`, `created ${job.createdAt}`];
  if (job.finishedAt) lines.push(`finished ${job.finishedAt}`);
  if (job.progress) lines.push(`progress: ${progressText(job.progress)}`);
  if (job.error) lines.push(`error: ${job.error}`);
  if (Object.keys(job.params).length > 0) lines.push(`params: ${JSON.stringify(job.params)}`);
  if (job.result !== undefined) lines.push(`result: ${JSON.stringify(job.result, null, 2)}`);
  return lines.join('\n');
}

const RUN_STATUS_COLOR: Record<Run['status'], keyof Colors> = {
  passed: 'green',
  failed: 'red',
  blocked: 'yellow',
  error: 'magenta',
};

/** `[3/12] failed   Add item then undo · repeat step 2 (1.2s)` */
export function formatRunLine(
  run: Run,
  workflow: Workflow,
  done: number,
  total: number,
  colors: Colors = plain,
): string {
  const paint = colors[RUN_STATUS_COLOR[run.status]];
  const status = typeof paint === 'function' ? paint(run.status.padEnd(7)) : run.status;
  const mutation = workflow.mutation ? ` · ${workflow.mutation.description}` : '';
  const error = run.error ? ` · ${oneLine(run.error, 80)}` : '';
  return `[${done}/${total}] ${status} ${workflow.title}${mutation} (${formatDuration(run.durationMs)})${error}`;
}

export function formatRunSummary(summary: RunSummary): string {
  const s = summary.stats;
  const lines = [
    table(
      ['PASSED', 'FAILED', 'BLOCKED', 'ERROR', 'TOTAL', 'DURATION'],
      [
        [
          String(s.passed),
          String(s.failed),
          String(s.blocked),
          String(s.error),
          String(s.total),
          formatDuration(summary.durationMs),
        ],
      ],
    ),
    '',
  ];
  if (summary.findings.length > 0) {
    lines.push(
      `Findings created or updated (${summary.findings.length}):`,
      formatFindings(summary.findings),
    );
  } else {
    lines.push('No new or updated findings.');
  }
  if (summary.reportPath) lines.push('', `Report: ${summary.reportPath}`);
  return lines.join('\n');
}

/** One progress line for an agent event, or undefined for events not worth a line. */
export function formatAgentEvent(event: AgentEvent): string | undefined {
  const who = `${event.role}${event.depth > 0 ? `#${event.depth}` : ''}`;
  switch (event.type) {
    case 'turn':
      return undefined;
    case 'tool':
      return `[${who}] ${event.ok ? '✓' : '✗'} ${event.name}${event.summary ? `: ${oneLine(event.summary, 100)}` : ''}`;
    case 'text': {
      const text = oneLine(event.text, 120);
      return text ? `[${who}] ${text}` : undefined;
    }
  }
}

export function formatSetupResult(result: SetupResult): string {
  const lines = [result.report.summary, ''];
  lines.push(
    result.configAction === 'created'
      ? `Config written to ${result.configPath}`
      : `A config already exists; the proposal was written to ${result.configPath}`,
  );
  if (result.report.targets.length > 0) {
    lines.push(`Targets: ${result.report.targets.map((t) => `${t.id} (${t.kind})`).join(', ')}`);
  }
  lines.push('', `Seeded ${result.workflows.length} workflow(s):`);
  lines.push(result.workflows.length > 0 ? formatWorkflows(result.workflows) : '  none');
  if (result.validation.length > 0) {
    lines.push('', 'Environment validation:');
    for (const v of result.validation) {
      lines.push(
        `  ${v.ok ? '✓' : '✗'} ${v.targetId}${v.message ? `: ${oneLine(v.message, 200)}` : ''}`,
      );
    }
  }
  if (result.questions.length > 0) {
    lines.push('', `Questions for the team (${result.questions.length}), answer with "mw answer":`);
    lines.push(formatQuestions(result.questions));
  }
  return lines.join('\n');
}

export function formatExploreResults(results: ReadonlyArray<TargetExploreResult>): string {
  return results
    .map(({ targetId, result }) => {
      const lines = [
        `${targetId}: ${result.workflows.length} new workflow(s), ${result.questions.length} question(s)`,
      ];
      if (result.workflows.length > 0) lines.push(formatWorkflows(result.workflows));
      const stops = result.stoppedBecause.filter((cause) => cause !== 'finished');
      if (stops.length > 0) lines.push(`explorers stopped early: ${stops.join(', ')}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

export function formatMutateResults(results: ReadonlyArray<TargetMutateResult>): string {
  return results
    .map(
      ({ targetId, result }) =>
        `${targetId}: ${result.created.length} new variant(s) from ${result.bases} base workflow(s) (${result.fromOperators} from operators, ${result.fromAgent} from the agent)`,
    )
    .join('\n');
}

export function formatSearch(result: { workflows: Workflow[]; findings: Finding[] }): string {
  return [
    `Workflows (${result.workflows.length}):`,
    formatWorkflows(result.workflows),
    '',
    `Findings (${result.findings.length}):`,
    formatFindings(result.findings),
  ].join('\n');
}
