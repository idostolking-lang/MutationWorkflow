import { resolve } from 'node:path';
import { MutationWorkflowError } from '@mutationworkflow/core';
import { z } from 'zod';
import { isValidPattern } from './matching.js';

/** `target.options` for a `cli` target. */
export const CliTargetOptionsSchema = z.object({
  command: z.string().min(1).describe('Executable to run, e.g. "node" or "./bin/app"'),
  args: z.array(z.string()).default([]).describe('Arguments passed before any per-action args'),
  cwd: z.string().optional().describe('Working directory relative to the project root'),
  env: z
    .record(z.string(), z.string())
    .default({})
    .describe('Environment variables merged over the current environment'),
  shell: z.boolean().default(false).describe('Run the command through the system shell'),
  promptPattern: z
    .string()
    .refine(isValidPattern, 'Must be a valid regular expression')
    .optional()
    .describe(
      'Regular expression (multiline) for the prompt shown when input is expected, e.g. "^> "',
    ),
  exitTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(5_000)
    .describe('How long `close` waits for the process to exit before terminating it'),
});
export type CliTargetOptions = z.infer<typeof CliTargetOptionsSchema>;

/** Parsed options with `cwd` resolved to an absolute path. */
export interface ResolvedCliOptions extends Omit<CliTargetOptions, 'cwd'> {
  cwd: string;
}

/** Validate a target's options; throws CONFIG_INVALID with a readable message. */
export function parseCliOptions(
  targetId: string,
  options: Record<string, unknown>,
  rootDir: string,
): ResolvedCliOptions {
  const parsed = CliTargetOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new MutationWorkflowError(
      'CONFIG_INVALID',
      `Invalid options for cli target "${targetId}":\n${z.prettifyError(parsed.error)}`,
    );
  }
  return { ...parsed.data, cwd: resolve(rootDir, parsed.data.cwd ?? '.') };
}
