import { z } from 'zod';
import { IsoDateTimeSchema, SeveritySchema } from './common.js';
import { MutationInfoSchema, StepSchema } from './workflow.js';

export const FindingStatusSchema = z.enum(['open', 'confirmed', 'fixed', 'dismissed']);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

export const TriageVerdictSchema = z.enum(['bug', 'not-a-bug', 'needs-human']);
export type TriageVerdict = z.infer<typeof TriageVerdictSchema>;

/**
 * Triage is the review of an automatically detected problem. `pending` findings await a
 * triager agent (or a human); `done` findings carry its verdict; `skipped` findings could not
 * be reviewed because no model provider was configured (`triage --include-skipped` revisits them).
 */
export const TriageSchema = z.object({
  state: z.enum(['pending', 'done', 'skipped']),
  verdict: TriageVerdictSchema.optional(),
  rationale: z.string().optional(),
  model: z.string().optional(),
  at: IsoDateTimeSchema.optional(),
});
export type Triage = z.infer<typeof TriageSchema>;

export const ReproductionSchema = z.object({
  workflowId: z.string().min(1),
  steps: z.array(StepSchema).min(1),
  mutation: MutationInfoSchema.optional(),
});
export type Reproduction = z.infer<typeof ReproductionSchema>;

/** A deduplicated problem in the application under test. */
export const FindingSchema = z.object({
  id: z.string().min(1),
  targetId: z.string().min(1),
  fingerprint: z.string().min(1).describe('Groups runs that fail the same way'),
  title: z.string().min(1),
  summary: z.string(),
  severity: SeveritySchema,
  detectedBy: z.string().min(1).describe('Oracle id, or "triager" for agent-detected problems'),
  status: FindingStatusSchema,
  triage: TriageSchema,
  workflowIds: z.array(z.string()).default([]),
  runIds: z.array(z.string()).default([]),
  evidenceIds: z.array(z.string()).default([]),
  reproduction: ReproductionSchema.optional(),
  occurrences: z.number().int().nonnegative(),
  firstSeenAt: IsoDateTimeSchema,
  lastSeenAt: IsoDateTimeSchema,
  notes: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const QuestionKindSchema = z.enum(['expected-behavior', 'is-this-a-bug', 'setup']);
export type QuestionKind = z.infer<typeof QuestionKindSchema>;

export const QuestionDecisionSchema = z.enum(['confirm', 'bug', 'dismiss']);
export type QuestionDecision = z.infer<typeof QuestionDecisionSchema>;

/**
 * A question for the humans who own the application, raised when agents observe behaviour
 * they cannot judge: "is this what the app should do?" Answers feed back into workflow status
 * and findings.
 */
export const QuestionSchema = z.object({
  id: z.string().min(1),
  targetId: z.string().optional(),
  kind: QuestionKindSchema,
  question: z.string().min(1),
  context: z
    .object({
      workflowId: z.string().optional(),
      runId: z.string().optional(),
      findingId: z.string().optional(),
      evidenceIds: z.array(z.string()).default([]),
    })
    .prefault({}),
  status: z.enum(['open', 'answered']),
  decision: QuestionDecisionSchema.optional(),
  answer: z.string().optional(),
  createdAt: IsoDateTimeSchema,
  answeredAt: IsoDateTimeSchema.optional(),
});
export type Question = z.infer<typeof QuestionSchema>;
