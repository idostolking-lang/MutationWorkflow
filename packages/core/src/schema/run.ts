import { z } from 'zod';
import { AssertionSchema } from './action.js';
import { IsoDateTimeSchema, SeveritySchema } from './common.js';

export const StepStatusSchema = z.enum(['passed', 'failed', 'blocked', 'skipped', 'error']);
export type StepStatus = z.infer<typeof StepStatusSchema>;

/**
 * `passed`: every step ran and every assertion held.
 * `failed`: an assertion failed or the application showed an error signal.
 * `blocked`: an action could not be performed (for example a control did not exist). On a
 *   mutated workflow this usually means the application refused an out-of-order action, which
 *   is correct behaviour, so it is not a failure by itself.
 * `error`: infrastructure problem (adapter crash, environment down); says nothing about the app.
 */
export const RunStatusSchema = z.enum(['passed', 'failed', 'blocked', 'error']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunTriggerSchema = z.enum([
  'manual',
  'mcp',
  'schedule',
  'push',
  'continuous',
  'explore',
]);
export type RunTrigger = z.infer<typeof RunTriggerSchema>;

export const EvidenceKindSchema = z.enum([
  'screenshot',
  'console',
  'network',
  'stdout',
  'stderr',
  'log',
  'dom',
  'text',
  'trace',
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

/** A file or text captured during execution. Files live under the evidence directory. */
export const EvidenceSchema = z.object({
  id: z.string().min(1),
  runId: z.string().optional(),
  sessionId: z.string().optional().describe('Exploration session that produced the evidence'),
  stepId: z.string().optional(),
  kind: EvidenceKindSchema,
  label: z.string().optional(),
  path: z.string().optional().describe('Path relative to the evidence directory'),
  mimeType: z.string().optional(),
  text: z.string().optional().describe('Inline content for small textual evidence'),
  createdAt: IsoDateTimeSchema,
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/** Something the application did that indicates an error, independent of expectations. */
export const SignalKindSchema = z.enum([
  'console-error',
  'uncaught-exception',
  'network-error',
  'http-error',
  'error-page',
  'stderr',
  'process-exit',
  'crash',
]);
export type SignalKind = z.infer<typeof SignalKindSchema>;

export const SignalSchema = z.object({
  kind: SignalKindSchema,
  message: z.string(),
  signature: z
    .string()
    .describe('Stable form of the message with volatile parts (ids, timestamps) removed'),
  stepId: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  at: IsoDateTimeSchema,
});
export type Signal = z.infer<typeof SignalSchema>;

/**
 * What a session touched: the pages or screens visited and the backend endpoints or commands
 * used. Adapters report it; the engine turns it into the files a workflow exercises, so a code
 * change can be matched to the workflows worth replaying.
 */
export const FootprintSchema = z.object({
  urls: z.array(z.string()).default([]).describe('Paths of pages or screens visited, without host'),
  endpoints: z
    .array(z.string())
    .default([])
    .describe('Backend endpoints or commands used, e.g. "POST /api/todos" or "add"'),
});
export type Footprint = z.infer<typeof FootprintSchema>;

export const AssertionScopeSchema = z.enum(['step', 'final', 'invariant']);
export type AssertionScope = z.infer<typeof AssertionScopeSchema>;

export const AssertionResultSchema = z.object({
  assertion: AssertionSchema,
  scope: AssertionScopeSchema,
  passed: z.boolean(),
  message: z.string().optional(),
  stepId: z.string().optional(),
});
export type AssertionResult = z.infer<typeof AssertionResultSchema>;

export const StepResultSchema = z.object({
  stepId: z.string().min(1),
  index: z.number().int().nonnegative(),
  status: StepStatusSchema,
  durationMs: z.number().nonnegative(),
  message: z.string().optional(),
  evidenceIds: z.array(z.string()).default([]),
});
export type StepResult = z.infer<typeof StepResultSchema>;

export const OracleVerdictSchema = z.enum(['pass', 'fail', 'skip']);
export type OracleVerdict = z.infer<typeof OracleVerdictSchema>;

export const OracleResultSchema = z.object({
  oracle: z.string().min(1),
  verdict: OracleVerdictSchema,
  summary: z.string().optional(),
  signature: z
    .string()
    .optional()
    .describe('Groups runs that failed for the same reason into one finding'),
  severity: SeveritySchema.optional(),
  details: z.unknown().optional(),
});
export type OracleResult = z.infer<typeof OracleResultSchema>;

export const RunContextSchema = z.object({
  jobId: z.string().optional(),
  commit: z.string().optional(),
  branch: z.string().optional(),
  baseUrl: z.string().optional(),
  mutated: z.boolean().default(false),
});
export type RunContext = z.infer<typeof RunContextSchema>;

/** One execution of a workflow, with everything needed to understand what happened. */
export const RunSchema = z.object({
  id: z.string().min(1),
  workflowId: z.string().min(1),
  targetId: z.string().min(1),
  trigger: RunTriggerSchema,
  status: RunStatusSchema,
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema,
  durationMs: z.number().nonnegative(),
  steps: z.array(StepResultSchema),
  assertions: z.array(AssertionResultSchema).default([]),
  signals: z.array(SignalSchema).default([]),
  oracles: z.array(OracleResultSchema).default([]),
  evidenceIds: z.array(z.string()).default([]),
  context: RunContextSchema,
  touched: FootprintSchema.prefault({}),
  error: z.string().optional().describe('Infrastructure error message when status is "error"'),
});
export type Run = z.infer<typeof RunSchema>;
