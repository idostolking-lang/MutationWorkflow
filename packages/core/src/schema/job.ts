import { z } from 'zod';
import { IsoDateTimeSchema } from './common.js';

export const JobKindSchema = z.enum([
  'setup',
  'explore',
  'mutate',
  'run',
  'triage',
  'cycle',
  'watch',
]);
export type JobKind = z.infer<typeof JobKindSchema>;

export const JobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** Long-running work started from the CLI or an MCP client, polled while it runs. */
export const JobSchema = z.object({
  id: z.string().min(1),
  kind: JobKindSchema,
  status: JobStatusSchema,
  params: z.record(z.string(), z.unknown()).default({}),
  progress: z
    .object({
      message: z.string(),
      current: z.number().optional(),
      total: z.number().optional(),
    })
    .optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  createdAt: IsoDateTimeSchema,
  startedAt: IsoDateTimeSchema.optional(),
  finishedAt: IsoDateTimeSchema.optional(),
});
export type Job = z.infer<typeof JobSchema>;
