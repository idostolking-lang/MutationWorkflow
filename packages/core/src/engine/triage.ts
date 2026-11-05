import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  type TriageDecision,
  TriageDecisionSchema,
  triagerPrompt,
} from '../agents/prompts/triager.js';
import type { ImagePart } from '../agents/provider.js';
import type { AgentEvent, AgentRuntime } from '../agents/runtime.js';
import { defineTool, fail, ok } from '../agents/tools.js';
import {
  type Evidence,
  type Finding,
  FindingSchema,
  fingerprint,
  newId,
  nowIso,
  type Question,
  QuestionSchema,
  type Run,
  type TargetConfig,
  type Workflow,
} from '../schema/index.js';
import type { Store } from '../store/types.js';
import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { truncate } from '../util/text.js';
import { describeAction } from './report.js';

/** Oracles whose signature already identifies a problem independently of the workflow. */
const WORKFLOW_INDEPENDENT_ORACLES = new Set(['app-error', 'invariants']);

export interface RecordFindingsInput {
  run: Run;
  workflow: Workflow;
  target: TargetConfig;
  evidence: Evidence[];
}

/**
 * Turn a run's failing oracle results into findings, merging with findings that already exist
 * for the same problem. Problems the application reports itself (error signals, invariants) are
 * grouped across workflows, because a 500 from one endpoint is one bug however it was reached.
 * Failed steps and expectations are grouped per exact workflow: a mutated sequence that breaks
 * an expectation is a problem of that sequence, and its steps are the reproduction.
 */
export async function recordFindings(
  store: Store,
  input: RecordFindingsInput,
  logger: Logger,
): Promise<Finding[]> {
  const { run, workflow, target } = input;
  const touched: Finding[] = [];
  const failures = run.oracles.filter((result) => result.verdict === 'fail');
  for (const result of failures) {
    const scopeKey = WORKFLOW_INDEPENDENT_ORACLES.has(result.oracle) ? null : workflow.id;
    const key = fingerprint({
      targetId: target.id,
      oracle: result.oracle,
      signature: result.signature ?? result.summary ?? '',
      scopeKey,
    });
    const evidenceIds = relevantEvidence(run, input.evidence, result.details);
    const existing = await store.findings.getByFingerprint(target.id, key);
    const now = nowIso();
    if (existing) {
      const reopened = existing.status === 'fixed';
      const updated = FindingSchema.parse({
        ...existing,
        status: reopened ? 'open' : existing.status,
        occurrences: existing.occurrences + 1,
        lastSeenAt: now,
        workflowIds: unique([...existing.workflowIds, workflow.id]),
        runIds: unique([...existing.runIds, run.id]),
        evidenceIds: unique([...existing.evidenceIds, ...evidenceIds]).slice(-30),
        notes: reopened
          ? `${existing.notes ? `${existing.notes}\n` : ''}Reappeared on ${now} after being marked fixed.`
          : existing.notes,
      });
      await store.findings.update(updated);
      touched.push(updated);
      if (reopened) logger.warn(`Finding reopened: ${updated.title}`);
      continue;
    }
    const created = FindingSchema.parse({
      id: newId('fnd'),
      targetId: target.id,
      fingerprint: key,
      title: truncate(result.summary ?? `${result.oracle} failed`, 140),
      summary: describeContext(workflow, run, result.summary),
      severity: result.severity ?? 'medium',
      detectedBy: result.oracle,
      status: 'open',
      triage: { state: 'pending' },
      workflowIds: [workflow.id],
      runIds: [run.id],
      evidenceIds,
      reproduction: { workflowId: workflow.id, steps: workflow.steps, mutation: workflow.mutation },
      occurrences: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    });
    await store.findings.insert(created);
    touched.push(created);
    logger.info(`New finding: ${created.title}`, { severity: created.severity });
  }
  return touched;
}

function describeContext(workflow: Workflow, run: Run, summary: string | undefined): string {
  const lines = [summary ?? ''];
  lines.push('', `Workflow "${workflow.title}": ${workflow.intent}.`);
  if (workflow.mutation) lines.push(`Mutation: ${workflow.mutation.description}.`);
  const failedStep = run.steps.find((s) => s.status !== 'passed' && s.status !== 'skipped');
  if (failedStep) {
    const step = workflow.steps[failedStep.index];
    lines.push(
      `Step ${failedStep.index + 1} (${step ? describeAction(step.action) : failedStep.stepId}) ${failedStep.status}${failedStep.message ? `: ${failedStep.message}` : ''}.`,
    );
  }
  return lines.join('\n').trim();
}

function relevantEvidence(run: Run, evidence: Evidence[], details: unknown): string[] {
  const stepId =
    details && typeof details === 'object' && 'stepId' in details
      ? (details as { stepId?: string }).stepId
      : undefined;
  const forStep = stepId ? evidence.filter((e) => e.stepId === stepId) : [];
  const screenshots = evidence.filter((e) => e.kind === 'screenshot');
  const chosen = unique(
    [...forStep, ...screenshots.slice(-2), ...evidence.slice(-2)].map((e) => e.id),
  );
  return chosen.length > 0 ? chosen : run.evidenceIds.slice(-3);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export interface TriageDeps {
  store: Store;
  runtime: AgentRuntime;
  target: TargetConfig;
  evidenceRoot: string;
  logger: Logger;
  jobId?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

const BATCH_SIZE = 8;

/**
 * Ask the triager agent to judge pending findings for one target: bug or not, title, summary,
 * severity, duplicates. Findings judged "not a bug" are dismissed; "needs human" becomes a
 * question for the team.
 */
export async function triageFindings(deps: TriageDeps, findings: Finding[]): Promise<Finding[]> {
  const pending = findings.filter(
    (f) => f.triage.state === 'pending' && f.targetId === deps.target.id,
  );
  const updated: Finding[] = [];
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    updated.push(...(await triageBatch(deps, pending.slice(i, i + BATCH_SIZE))));
  }
  return updated;
}

async function triageBatch(deps: TriageDeps, batch: Finding[]): Promise<Finding[]> {
  const { store, runtime, target, logger } = deps;
  const resolved = runtime.resolveModel('triager');
  const dossiers: string[] = [];
  for (const finding of batch) {
    dossiers.push(await dossier(store, finding));
  }
  const tools = [
    defineTool({
      name: 'get_evidence',
      description:
        'Fetch one evidence item by id: screenshots are returned as images, logs as text.',
      schema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const item = await store.evidence.get(id);
        if (!item) return fail(`No evidence with id ${id}`);
        return ok(loadEvidence(deps.evidenceRoot, item, resolved.vision));
      },
    }),
    defineTool({
      name: 'get_run',
      description: 'Fetch the full record of a run by id (steps, assertions, signals, oracles).',
      schema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const run = await store.runs.get(id);
        return run ? ok(JSON.stringify(run, null, 2)) : fail(`No run with id ${id}`);
      },
    }),
    defineTool({
      name: 'get_workflow',
      description: 'Fetch a workflow by id, including its steps and expectations.',
      schema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const workflow = await store.workflows.get(id);
        return workflow ? ok(JSON.stringify(workflow, null, 2)) : fail(`No workflow with id ${id}`);
      },
    }),
  ];

  const result = await runtime.run({
    role: 'triager',
    system: triagerPrompt({ target }),
    task: `Triage the following ${batch.length} finding(s).\n\n${dossiers.join('\n\n---\n\n')}`,
    tools,
    output: TriageDecisionSchema,
    jobId: deps.jobId,
    signal: deps.signal,
    onEvent: deps.onEvent,
  });
  if (!result.output) {
    logger.warn(
      `Triage produced no decisions (${result.stoppedBecause}${result.error ? `: ${result.error}` : ''})`,
    );
    return [];
  }
  return applyDecisions(store, batch, result.output, resolved.model, logger);
}

async function dossier(store: Store, finding: Finding): Promise<string> {
  const workflow = finding.reproduction
    ? await store.workflows.get(finding.reproduction.workflowId)
    : undefined;
  const lastRunId = finding.runIds.at(-1);
  const run = lastRunId ? await store.runs.get(lastRunId) : undefined;
  const evidence = await store.evidence.getMany(finding.evidenceIds);
  const lines = [
    `# Finding ${finding.id}`,
    `Detected by: ${finding.detectedBy} · severity guess: ${finding.severity} · seen ${finding.occurrences}x`,
    `Current title: ${finding.title}`,
    finding.summary,
  ];
  if (workflow) {
    lines.push('', `Workflow "${workflow.title}" (${workflow.origin}): ${workflow.intent}`);
    if (workflow.mutation) lines.push(`Mutation: ${workflow.mutation.description}`);
    for (const [index, step] of workflow.steps.entries()) {
      const outcome = run?.steps.find((s) => s.stepId === step.id);
      const status = outcome
        ? ` → ${outcome.status}${outcome.message ? ` (${outcome.message})` : ''}`
        : '';
      lines.push(
        `${index + 1}. ${describeAction(step.action)}${step.note ? ` — ${step.note}` : ''}${status}`,
      );
    }
  }
  if (run) {
    const failed = run.assertions.filter((a) => !a.passed);
    if (failed.length > 0) {
      lines.push('', 'Failed expectations:');
      for (const a of failed) {
        lines.push(
          `- [${a.scope}${a.stepId ? ` ${a.stepId}` : ''}] ${JSON.stringify(a.assertion)}${a.message ? ` → ${a.message}` : ''}`,
        );
      }
    }
    if (run.signals.length > 0) {
      lines.push('', 'Application error signals:');
      for (const s of run.signals.slice(0, 20)) {
        lines.push(`- ${s.kind}${s.stepId ? ` at ${s.stepId}` : ''}: ${truncate(s.message, 300)}`);
      }
    }
    lines.push('', `Run ${run.id}: ${run.status}${run.error ? ` (${run.error})` : ''}`);
  }
  if (evidence.length > 0) {
    lines.push('', 'Evidence (use get_evidence):');
    for (const e of evidence) {
      lines.push(
        `- ${e.id}: ${e.kind}${e.label ? ` "${e.label}"` : ''}${e.stepId ? ` at ${e.stepId}` : ''}`,
      );
    }
  }
  return lines.join('\n');
}

function loadEvidence(
  root: string,
  item: Evidence,
  vision: boolean,
): string | Array<{ type: 'text'; text: string } | ImagePart> {
  if (item.text !== undefined) return truncate(item.text, 20_000);
  if (!item.path) return '(evidence has no content)';
  const absolute = join(root, item.path);
  try {
    if (item.kind === 'screenshot') {
      if (!vision) return `Screenshot stored at ${absolute} (this model cannot view images).`;
      const data = readFileSync(absolute).toString('base64');
      return [
        { type: 'text', text: `Screenshot ${item.label ?? ''}`.trim() },
        { type: 'image', mediaType: 'image/png', data },
      ];
    }
    return truncate(readFileSync(absolute, 'utf8'), 20_000);
  } catch (error) {
    return `Could not read evidence file ${absolute}: ${errorMessage(error)}`;
  }
}

async function applyDecisions(
  store: Store,
  batch: Finding[],
  decision: TriageDecision,
  model: string,
  logger: Logger,
): Promise<Finding[]> {
  const byId = new Map(batch.map((f) => [f.id, f]));
  const updated: Finding[] = [];
  const now = nowIso();
  for (const entry of decision.decisions) {
    const finding = byId.get(entry.findingId);
    if (!finding) {
      logger.warn(`Triager referenced unknown finding ${entry.findingId}`);
      continue;
    }
    const duplicateOf =
      entry.duplicateOf && entry.duplicateOf !== finding.id ? entry.duplicateOf : undefined;
    const status: Finding['status'] =
      duplicateOf || entry.verdict === 'not-a-bug' ? 'dismissed' : finding.status;
    const next = FindingSchema.parse({
      ...finding,
      title: entry.title,
      summary: entry.summary,
      severity: entry.severity,
      status,
      triage: { state: 'done', verdict: entry.verdict, rationale: entry.rationale, model, at: now },
      notes: duplicateOf
        ? `${finding.notes ? `${finding.notes}\n` : ''}Duplicate of ${duplicateOf}.`
        : finding.notes,
    });
    await store.findings.update(next);
    updated.push(next);
    if (duplicateOf) {
      const primary = await store.findings.get(duplicateOf);
      if (primary) {
        await store.findings.update(
          FindingSchema.parse({
            ...primary,
            runIds: unique([...primary.runIds, ...finding.runIds]),
            workflowIds: unique([...primary.workflowIds, ...finding.workflowIds]),
            occurrences: primary.occurrences + finding.occurrences,
          }),
        );
      }
    }
    if (entry.verdict === 'needs-human') {
      const question: Question = QuestionSchema.parse({
        id: newId('q'),
        targetId: finding.targetId,
        kind: 'is-this-a-bug',
        question: `${entry.title}\n\n${entry.summary}\n\nTriager: ${entry.rationale}`,
        context: {
          findingId: finding.id,
          workflowId: finding.reproduction?.workflowId,
          evidenceIds: finding.evidenceIds.slice(0, 5),
        },
        status: 'open',
        createdAt: now,
      });
      await store.questions.insert(question);
    }
  }
  const missing = batch.filter((f) => !decision.decisions.some((d) => d.findingId === f.id));
  if (missing.length > 0) {
    logger.warn(`Triager skipped ${missing.length} finding(s); they stay pending`);
  }
  return updated;
}
