import { z } from 'zod';
import { AssertionSchema } from './action.js';
import { StepInputSchema } from './workflow.js';

/** How the engine knows the application is ready to accept interactions. */
export const ReadyCheckSchema = z
  .object({
    url: z.string().optional().describe('URL that must respond before the app counts as ready'),
    status: z
      .number()
      .int()
      .optional()
      .describe('Expected HTTP status for the url check; any status below 500 when omitted'),
    port: z.number().int().positive().optional().describe('TCP port that must accept connections'),
    output: z.string().optional().describe('Regular expression matched against process output'),
    timeoutMs: z.number().int().positive().default(60_000),
  })
  .refine((check) => check.url || check.port || check.output, {
    message: 'A ready check needs at least one of url, port or output',
  });
export type ReadyCheck = z.infer<typeof ReadyCheckSchema>;

export const CommandSchema = z.object({
  command: z.string().min(1).describe('Shell command, run from cwd'),
  cwd: z.string().optional().describe('Directory relative to the project root'),
  env: z.record(z.string(), z.string()).prefault({}),
  timeoutMs: z.number().int().positive().optional(),
});
export type Command = z.infer<typeof CommandSchema>;

export const StartCommandSchema = CommandSchema.omit({ timeoutMs: true }).extend({
  ready: ReadyCheckSchema,
  stopSignal: z.enum(['SIGTERM', 'SIGINT', 'SIGKILL']).default('SIGTERM'),
  stopTimeoutMs: z.number().int().positive().default(10_000),
});
export type StartCommand = z.infer<typeof StartCommandSchema>;

/**
 * The local environment the engine controls. MutationWorkflow only ever tests an application it
 * started itself (or one the operator points it at on localhost); production is never a target.
 */
export const EnvironmentConfigSchema = z.object({
  start: StartCommandSchema.optional().describe(
    'Starts the app; omitted when it is already running',
  ),
  reset: CommandSchema.optional().describe('Restores a known state, e.g. reseeding a database'),
});
export type EnvironmentConfig = z.infer<typeof EnvironmentConfigSchema>;

/** A user the workflows can act as. The steps log in or otherwise prepare the session. */
export const IdentitySchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(StepInputSchema).default([]),
});
export type Identity = z.infer<typeof IdentitySchema>;

/** A property that must hold regardless of which workflow ran. */
export const InvariantSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  check: AssertionSchema,
  when: z.enum(['after-workflow', 'after-step']).default('after-workflow'),
});
export type Invariant = z.infer<typeof InvariantSchema>;

/** Boundaries for agents and executors; everything outside them is never touched. */
export const ScopeSchema = z.object({
  allowUrls: z
    .array(z.string())
    .default([])
    .describe('URL globs agents may visit; defaults to the base URL origin'),
  denyUrls: z.array(z.string()).default([]).describe('URL globs that are never visited'),
  denyText: z
    .array(z.string())
    .default([])
    .describe('Regular expressions; controls whose text matches are never activated'),
});
export type Scope = z.infer<typeof ScopeSchema>;

/**
 * Ties what a workflow touches to the code that implements it. Patterns are globs matched against
 * normalised endpoints ("POST /api/todos/*") and page paths ("/settings"); files are paths or
 * globs relative to the project root. The inspector proposes these; the engine also derives
 * files by searching the repository for the literal paths.
 */
export const CodeMapRuleSchema = z.object({
  match: z.string().min(1).describe('Glob over endpoint ("POST /api/todos/**") or page path'),
  files: z.array(z.string()).min(1).describe('Source files or globs relative to the project root'),
  description: z.string().optional(),
});
export type CodeMapRule = z.infer<typeof CodeMapRuleSchema>;

export const TargetConfigSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Target ids are lowercase letters, digits, "-" and "_"'),
  name: z.string().optional(),
  description: z.string().optional().describe('What the application does, for the agents'),
  kind: z.string().min(1).describe('Adapter kind, e.g. "web" or "cli"'),
  adapter: z
    .string()
    .optional()
    .describe('Adapter package to load; defaults to the built-in adapter for the kind'),
  options: z
    .record(z.string(), z.unknown())
    .prefault({})
    .describe('Adapter options, e.g. baseUrl for web or command for cli'),
  environment: EnvironmentConfigSchema.prefault({}),
  identities: z.array(IdentitySchema).default([]),
  invariants: z.array(InvariantSchema).default([]),
  scope: ScopeSchema.prefault({}),
  codemap: z
    .array(CodeMapRuleSchema)
    .default([])
    .describe('Explicit mapping from endpoints and pages to source files'),
});
export type TargetConfig = z.infer<typeof TargetConfigSchema>;
export type TargetConfigInput = z.input<typeof TargetConfigSchema>;

/**
 * The target without anything that may hold credentials: identity steps (logins) and the raw
 * option maps that carry environment variables or browser launch options. Used for records
 * that leave the process, such as the database and prompts.
 */
export function redactTarget(target: TargetConfig): TargetConfig {
  const {
    env: _env,
    launchOptions: _launch,
    storageStatePath: _state,
    ...options
  } = target.options;
  return {
    ...target,
    options,
    identities: target.identities.map((identity) => ({ ...identity, steps: [] })),
  };
}
