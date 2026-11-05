import { z } from 'zod';
import { ActionSchema, AssertionSchema } from './action.js';
import { fingerprint, IsoDateTimeSchema, newId, nowIso } from './common.js';
import { FootprintSchema } from './run.js';

/** A single user action inside a workflow, with the expectations checked right after it. */
export const StepSchema = z.object({
  id: z.string().min(1),
  action: ActionSchema,
  note: z.string().optional().describe('Why a user performs this step, in their own terms'),
  expect: z
    .array(AssertionSchema)
    .default([])
    .describe('Assertions checked immediately after the action'),
});
export type Step = z.infer<typeof StepSchema>;

/** Step as written by agents, config files and operators: the id is optional and assigned later. */
export const StepInputSchema = StepSchema.extend({ id: z.string().min(1).optional() });
export type StepInput = z.input<typeof StepInputSchema>;

export const WorkflowOriginSchema = z.enum([
  'seed',
  'imported-test',
  'discovered',
  'mutation',
  'manual',
]);
export type WorkflowOrigin = z.infer<typeof WorkflowOriginSchema>;

/**
 * `active` workflows encode confirmed expectations. `pending-review` workflows were
 * discovered by agents and describe observed behaviour that a human has not confirmed yet;
 * they still run, because crashes are bugs regardless of what the intended behaviour is.
 */
export const WorkflowStatusSchema = z.enum(['active', 'pending-review', 'archived']);
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

export const MutationInfoSchema = z.object({
  operator: z.string().min(1).describe('Operator id, or "agent" for model-proposed mutations'),
  description: z.string().min(1).describe('Human-readable description of the change'),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type MutationInfo = z.infer<typeof MutationInfoSchema>;

export const WorkflowSourceSchema = z.object({
  file: z.string().optional().describe('Repository path this workflow was derived from'),
  name: z.string().optional().describe('Test or scenario name inside that file'),
  framework: z.string().optional().describe('Test framework, e.g. playwright, cypress, vitest'),
});
export type WorkflowSource = z.infer<typeof WorkflowSourceSchema>;

/** Accumulated knowledge of what a workflow exercises, learned from its runs and the code map. */
export const WorkflowTouchesSchema = FootprintSchema.extend({
  files: z
    .array(z.string())
    .default([])
    .describe('Source files or globs the workflow exercises, derived from endpoints and pages'),
  updatedAt: IsoDateTimeSchema,
});
export type WorkflowTouches = z.infer<typeof WorkflowTouchesSchema>;

/**
 * A workflow is an ordered sequence of user actions with an intent. It is fully serialisable
 * and replays deterministically through an adapter, without a model in the loop.
 */
export const WorkflowSchema = z.object({
  id: z.string().min(1),
  targetId: z.string().min(1),
  title: z.string().min(1),
  intent: z.string().min(1).describe('What the user is trying to achieve'),
  origin: WorkflowOriginSchema,
  status: WorkflowStatusSchema,
  parentId: z.string().optional().describe('Base workflow this mutation was derived from'),
  mutation: MutationInfoSchema.optional(),
  identity: z.string().optional().describe('Identity (from target config) to set up first'),
  steps: z.array(StepSchema).min(1),
  expect: z
    .array(AssertionSchema)
    .default([])
    .describe('Assertions about the final state, checked after the last step'),
  tags: z.array(z.string()).default([]),
  source: WorkflowSourceSchema.optional(),
  touches: WorkflowTouchesSchema.optional(),
  fingerprint: z.string().min(1),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Workflow = z.infer<typeof WorkflowSchema>;

/** The part of a workflow that agents, importers and operators produce. */
export const WorkflowDraftSchema = z.object({
  title: z.string().min(1).describe('Short, specific title such as "Add item then undo"'),
  intent: z.string().min(1).describe('What the user is trying to achieve'),
  steps: z.array(StepInputSchema).min(1),
  expect: z.array(AssertionSchema).default([]),
  identity: z.string().optional(),
  tags: z.array(z.string()).default([]),
  source: WorkflowSourceSchema.optional(),
});
export type WorkflowDraft = z.input<typeof WorkflowDraftSchema>;

/**
 * Two workflows are the same when they perform the same actions on the same target as the
 * same identity. Titles, notes and expectations do not change identity.
 */
export function workflowFingerprint(
  targetId: string,
  identity: string | undefined,
  steps: ReadonlyArray<{ action: unknown }>,
): string {
  return fingerprint({ targetId, identity: identity ?? null, actions: steps.map((s) => s.action) });
}

/**
 * Assign ids to steps that lack one. Existing ids are kept when they are unique; when a model
 * copied a step and its id, every step gets a positional id instead, so ids stay unambiguous.
 */
export function normalizeSteps(steps: ReadonlyArray<StepInput>): Step[] {
  const ids = steps.flatMap((step) => (step.id ? [step.id] : []));
  const unique = new Set(ids).size === ids.length;
  return steps.map((step, index) =>
    StepSchema.parse({ ...step, id: unique && step.id ? step.id : `s${index + 1}` }),
  );
}

export interface CreateWorkflowOptions {
  origin: WorkflowOrigin;
  status?: WorkflowStatus;
  parentId?: string;
  mutation?: MutationInfo;
}

/** Build a complete workflow record from a draft. */
export function createWorkflow(
  targetId: string,
  draft: WorkflowDraft,
  options: CreateWorkflowOptions,
): Workflow {
  const parsed = WorkflowDraftSchema.parse(draft);
  const steps = normalizeSteps(parsed.steps);
  const now = nowIso();
  return WorkflowSchema.parse({
    id: newId('wf'),
    targetId,
    title: parsed.title,
    intent: parsed.intent,
    origin: options.origin,
    status: options.status ?? 'active',
    parentId: options.parentId,
    mutation: options.mutation,
    identity: parsed.identity,
    steps,
    expect: parsed.expect,
    tags: parsed.tags,
    source: parsed.source,
    fingerprint: workflowFingerprint(targetId, parsed.identity, steps),
    createdAt: now,
    updatedAt: now,
  });
}
