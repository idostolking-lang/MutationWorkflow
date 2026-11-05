import { existsSync, readFileSync } from 'node:fs';
import {
  type Engine,
  type Evidence,
  type Finding,
  MutationWorkflowError,
  type Run,
  resolveInside,
  type Workflow,
  type WorkflowFilter,
  type WorkflowOrigin,
  type WorkflowStatus,
} from '@mutationworkflow/core';

/** Evidence with its file resolved to an absolute path under the evidence root. */
export interface EvidenceItem {
  id: string;
  kind: Evidence['kind'];
  label?: string;
  mimeType?: string;
  runId?: string;
  stepId?: string;
  /** Absolute path of the evidence file, when it has one. */
  path?: string;
  /** Inline text, for small textual evidence. */
  text?: string;
}

/** Resolve an evidence record's file against the engine's evidence root. */
export function evidenceItem(engine: Engine, evidence: Evidence): EvidenceItem {
  return {
    id: evidence.id,
    kind: evidence.kind,
    ...(evidence.label ? { label: evidence.label } : {}),
    ...(evidence.mimeType ? { mimeType: evidence.mimeType } : {}),
    ...(evidence.runId ? { runId: evidence.runId } : {}),
    ...(evidence.stepId ? { stepId: evidence.stepId } : {}),
    ...(evidence.path ? { path: resolveInside(engine.evidenceRoot, evidence.path) } : {}),
    ...(evidence.text !== undefined ? { text: evidence.text } : {}),
  };
}

export interface FindingDetail {
  finding: Finding;
  /** The workflow the reproduction replays, when it still exists. */
  workflow?: Workflow;
  evidence: EvidenceItem[];
}

/** A finding with its reproduction workflow and evidence; throws NOT_FOUND for unknown ids. */
export async function getFindingDetail(engine: Engine, id: string): Promise<FindingDetail> {
  const finding = await engine.store.findings.get(id);
  if (!finding) throw new MutationWorkflowError('NOT_FOUND', `No finding with id ${id}`);
  const workflowId = finding.reproduction?.workflowId ?? finding.workflowIds[0];
  const workflow = workflowId ? await engine.store.workflows.get(workflowId) : undefined;
  const evidence = await engine.store.evidence.getMany(finding.evidenceIds);
  return {
    finding,
    ...(workflow ? { workflow } : {}),
    evidence: evidence.map((item) => evidenceItem(engine, item)),
  };
}

export interface WorkflowDetail {
  workflow: Workflow;
  /** The base workflow, for mutations. */
  parent?: Workflow;
  /** Number of mutation variants derived from this workflow. */
  variants: number;
  lastRun?: Run;
}

/** A workflow with its parent, variant count and latest run; throws for unknown ids. */
export async function getWorkflowDetail(engine: Engine, id: string): Promise<WorkflowDetail> {
  const workflow = await engine.store.workflows.get(id);
  if (!workflow) {
    throw new MutationWorkflowError('WORKFLOW_NOT_FOUND', `No workflow with id ${id}`);
  }
  const parent = workflow.parentId
    ? await engine.store.workflows.get(workflow.parentId)
    : undefined;
  const lastRun = await engine.store.runs.latestForWorkflow(id);
  return {
    workflow,
    ...(parent ? { parent } : {}),
    variants: await engine.store.workflows.count({ parentId: id }),
    ...(lastRun ? { lastRun } : {}),
  };
}

export interface WorkflowQuery {
  targetId?: string;
  origin?: WorkflowOrigin;
  status?: WorkflowStatus;
  /** true: base workflows only; false: mutations only; undefined: both. */
  base?: boolean;
  limit?: number;
}

/**
 * List workflows. The store can select base workflows directly; mutations-only is filtered
 * here, so the limit is applied afterwards.
 */
export async function listWorkflows(engine: Engine, query: WorkflowQuery): Promise<Workflow[]> {
  const filter: WorkflowFilter = {
    ...(query.targetId ? { targetId: query.targetId } : {}),
    ...(query.origin ? { origin: query.origin } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.base === true ? { parentId: null } : {}),
  };
  if (query.base === false) {
    const mutations = (await engine.store.workflows.list(filter)).filter((w) => w.parentId);
    return query.limit ? mutations.slice(0, query.limit) : mutations;
  }
  return engine.store.workflows.list({ ...filter, ...(query.limit ? { limit: query.limit } : {}) });
}

/** Evidence content: inline text, a text file's content, or an image file's bytes. */
export type EvidenceContent =
  | { type: 'text'; item: EvidenceItem; text: string }
  | { type: 'image'; item: EvidenceItem; data: Buffer; mimeType: string };

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** Load one evidence item's content; throws NOT_FOUND for unknown ids. */
export async function readEvidence(engine: Engine, id: string): Promise<EvidenceContent> {
  const evidence = await engine.store.evidence.get(id);
  if (!evidence) throw new MutationWorkflowError('NOT_FOUND', `No evidence with id ${id}`);
  const item = evidenceItem(engine, evidence);
  if (!item.path) return { type: 'text', item, text: evidence.text ?? '' };
  if (!existsSync(item.path)) {
    throw new MutationWorkflowError('NOT_FOUND', `Evidence file ${item.path} no longer exists`);
  }
  const extension = item.path.slice(item.path.lastIndexOf('.')).toLowerCase();
  const mimeType = item.mimeType?.startsWith('image/') ? item.mimeType : IMAGE_TYPES[extension];
  if (mimeType || evidence.kind === 'screenshot') {
    return {
      type: 'image',
      item,
      data: readFileSync(item.path),
      mimeType: mimeType ?? 'image/png',
    };
  }
  return { type: 'text', item, text: readFileSync(item.path, 'utf8') };
}
