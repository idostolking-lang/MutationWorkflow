import { z } from 'zod';
import { isValidPattern } from './matching.js';

const description = z.string().optional().describe('What this assertion verifies, in user terms');

const stream = z
  .enum(['stdout', 'stderr', 'both'])
  .default('both')
  .describe('Which output stream to search');

const since = z
  .enum(['step', 'session'])
  .default('session')
  .describe(
    'step: output since this step began (for a wait step, since the input before it); session: all output',
  );

const pattern = z
  .string()
  .min(1)
  .refine(isValidPattern, 'Must be a valid regular expression')
  .describe('Regular expression; ^ and $ match at line boundaries');

export const OutputMatchesAssertionSchema = z
  .object({ type: z.literal('output-matches'), description, pattern, stream, since })
  .describe('The output contains a match for the pattern');

export const OutputNotMatchesAssertionSchema = z
  .object({ type: z.literal('output-not-matches'), description, pattern, stream, since })
  .describe('The output contains no match for the pattern');

export const ExitCodeAssertionSchema = z
  .object({
    type: z.literal('exit-code'),
    description,
    code: z.number().int().describe('Expected exit code'),
  })
  .describe('The process has exited with this code (fails while it is still running)');

export const RunningAssertionSchema = z
  .object({
    type: z.literal('running'),
    description,
    expected: z.boolean().describe('true: the process is still running; false: it has exited'),
  })
  .describe('Whether the process is still running');

export const StderrEmptyAssertionSchema = z
  .object({ type: z.literal('stderr-empty'), description, since })
  .describe('Nothing was printed on stderr');

/** The CLI adapter's assertion vocabulary, by type. */
export const CliAssertionSchemas = {
  'output-matches': OutputMatchesAssertionSchema,
  'output-not-matches': OutputNotMatchesAssertionSchema,
  'exit-code': ExitCodeAssertionSchema,
  running: RunningAssertionSchema,
  'stderr-empty': StderrEmptyAssertionSchema,
} as const;

export type CliAssertionType = keyof typeof CliAssertionSchemas;
export type CliAssertion = z.output<(typeof CliAssertionSchemas)[CliAssertionType]>;

/** One example per assertion type, shown to agents. */
export const ASSERTION_EXAMPLES: Record<
  CliAssertionType,
  z.input<(typeof CliAssertionSchemas)[CliAssertionType]>
> = {
  'output-matches': { type: 'output-matches', pattern: '\\b5$', since: 'step' },
  'output-not-matches': { type: 'output-not-matches', pattern: 'NaN' },
  'exit-code': { type: 'exit-code', code: 0 },
  running: { type: 'running', expected: true },
  'stderr-empty': { type: 'stderr-empty' },
};
