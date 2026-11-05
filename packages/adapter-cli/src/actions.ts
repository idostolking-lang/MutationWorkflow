import { z } from 'zod';
import { isValidPattern } from './matching.js';

const pattern = (what: string) =>
  z.string().min(1).refine(isValidPattern, 'Must be a valid regular expression').describe(what);

const extraArgs = z
  .array(z.string())
  .optional()
  .describe('Arguments appended to the configured args for this run');

export const StartActionSchema = z
  .object({
    type: z.literal('start'),
    args: extraArgs,
  })
  .describe('Start the application as a long-running interactive process');

export const ExecActionSchema = z
  .object({
    type: z.literal('exec'),
    args: extraArgs,
  })
  .describe(
    'Run the application to completion (for one-shot commands) and record its exit code; stdin is closed immediately',
  );

export const WriteActionSchema = z
  .object({
    type: z.literal('write'),
    text: z.string().describe('Text typed into the process'),
    newline: z.boolean().default(true).describe('Press Enter after the text'),
  })
  .describe('Type text into the running process, like a user at the keyboard');

export const WaitActionSchema = z
  .object({
    type: z.literal('wait'),
    ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Milliseconds to wait; with output or prompt, the timeout instead'),
    output: pattern(
      'Wait until output printed since the last input (start, write or signal) matches this regular expression',
    ).optional(),
    prompt: z
      .boolean()
      .optional()
      .describe("Wait until the application shows its prompt (the target's promptPattern)"),
  })
  .refine((action) => action.ms !== undefined || action.output !== undefined || action.prompt, {
    message: 'wait needs ms, output or prompt',
  })
  .describe('Pause for a fixed time, or until the application prints something or prompts');

export const SignalActionSchema = z
  .object({
    type: z.literal('signal'),
    signal: z
      .enum(['SIGINT', 'SIGTERM', 'SIGKILL'])
      .describe('SIGINT is Ctrl+C; SIGTERM asks to quit; SIGKILL kills immediately'),
  })
  .describe('Send a signal to the running process and its children');

export const CloseActionSchema = z
  .object({
    type: z.literal('close'),
  })
  .describe(
    'Close stdin (end of input, like Ctrl+D) and wait for the process to exit; terminate it if it does not',
  );

/** The CLI adapter's action vocabulary, by type. */
export const CliActionSchemas = {
  start: StartActionSchema,
  exec: ExecActionSchema,
  write: WriteActionSchema,
  wait: WaitActionSchema,
  signal: SignalActionSchema,
  close: CloseActionSchema,
} as const;

export type CliActionType = keyof typeof CliActionSchemas;
export type CliAction = z.output<(typeof CliActionSchemas)[CliActionType]>;

/** One example per action type, shown to agents. */
export const ACTION_EXAMPLES: Record<
  CliActionType,
  z.input<(typeof CliActionSchemas)[CliActionType]>
> = {
  start: { type: 'start' },
  exec: { type: 'exec', args: ['--version'] },
  write: { type: 'write', text: 'add 5' },
  wait: { type: 'wait', prompt: true },
  signal: { type: 'signal', signal: 'SIGINT' },
  close: { type: 'close' },
};
