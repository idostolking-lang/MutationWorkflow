import { z } from 'zod';
import { SignalKindSchema } from '../schema/run.js';
import { TargetConfigSchema } from '../schema/target.js';

/** Ids of the mutation operators shipped with core, in the order they run. */
export const BUILTIN_OPERATOR_IDS = [
  'skip-step',
  'reorder-steps',
  'repeat-step',
  'truncate',
  'data-fuzz',
  'interrupt',
  'timing',
  'role-swap',
  'interleave',
] as const;
export type BuiltinOperatorId = (typeof BUILTIN_OPERATOR_IDS)[number];

/** Ids of the oracles shipped with core. */
export const BUILTIN_ORACLE_IDS = [
  'step-failure',
  'app-error',
  'assertions',
  'invariants',
] as const;
export type BuiltinOracleId = (typeof BUILTIN_ORACLE_IDS)[number];

export const AgentRoleSchema = z.enum(['inspector', 'explorer', 'mutator', 'triager']);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof EffortSchema>;

export const ModelSettingsSchema = z.object({
  provider: z.string().optional().describe('Provider id from the providers map'),
  model: z.string().optional().describe('Model id understood by the provider'),
  effort: EffortSchema.optional().describe('Reasoning effort, when the provider supports it'),
  maxTurns: z.number().int().positive().optional().describe('Maximum model calls per agent run'),
  maxTokens: z.number().int().positive().optional().describe('Maximum output tokens per call'),
  vision: z.boolean().optional().describe('Send screenshots to the model'),
});
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;

export const AgentsConfigSchema = z.object({
  maxParallel: z
    .number()
    .int()
    .positive()
    .default(3)
    .describe('Maximum concurrent model calls across all agents and sub-agents'),
  defaults: ModelSettingsSchema.prefault({}),
  roles: z.partialRecord(AgentRoleSchema, ModelSettingsSchema).prefault({}),
  budget: z
    .object({
      maxTokensPerJob: z.number().int().positive().optional(),
      maxUsdPerJob: z.number().positive().optional(),
    })
    .prefault({}),
});
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;

export const ModelPriceSchema = z
  .object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z
      .number()
      .nonnegative()
      .optional()
      .describe('Defaults to a tenth of the input price'),
    cacheWrite: z.number().nonnegative().optional().describe('Defaults to 1.25x the input price'),
  })
  .describe('USD per million tokens, used for cost estimates and budgets');
export type ModelPriceConfig = z.infer<typeof ModelPriceSchema>;

export const ProviderConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('anthropic'),
    apiKeyEnv: z.string().default('ANTHROPIC_API_KEY'),
    baseUrl: z.string().optional(),
    pricing: ModelPriceSchema.optional().describe('Overrides the built-in price table'),
  }),
  z.object({
    type: z.literal('openai'),
    apiKeyEnv: z.string().default('OPENAI_API_KEY'),
    baseUrl: z.string().optional().describe('Any OpenAI-compatible endpoint'),
    pricing: ModelPriceSchema.optional().describe('Needed for cost estimates and USD budgets'),
  }),
]);
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const MutationsConfigSchema = z.object({
  operators: z.array(z.string()).default([...BUILTIN_OPERATOR_IDS]),
  maxVariantsPerWorkflow: z.number().int().positive().default(25),
  fuzzValues: z
    .array(z.string())
    .optional()
    .describe('Replacement values for data-fuzz; defaults to a built-in boundary set'),
});
export type MutationsConfig = z.infer<typeof MutationsConfigSchema>;

export const ExecutionConfigSchema = z.object({
  parallel: z.number().int().positive().default(2).describe('Concurrent workflow executions'),
  stepTimeoutMs: z.number().int().positive().default(15_000),
  assertionTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(5_000)
    .describe('How long an assertion may keep retrying before it counts as failed'),
  workflowTimeoutMs: z.number().int().positive().default(180_000),
  screenshots: z.enum(['always', 'on-failure', 'never']).default('on-failure'),
  resetBetweenRuns: z
    .boolean()
    .default(false)
    .describe('Run the environment reset command before every workflow (forces serial runs)'),
});
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;

export const OraclesConfigSchema = z.object({
  enabled: z.array(z.string()).default([...BUILTIN_ORACLE_IDS]),
  ignoreSignalKinds: z.array(SignalKindSchema).default([]),
  ignoreSignals: z
    .array(z.string())
    .default([])
    .describe('Regular expressions; matching signal messages are ignored'),
  httpErrorStatus: z
    .number()
    .int()
    .default(500)
    .describe('Responses with this status or higher are error signals'),
});
export type OraclesConfig = z.infer<typeof OraclesConfigSchema>;

export const ExplorationConfigSchema = z.object({
  maxWorkflows: z.number().int().positive().default(10).describe('New workflows per session'),
  maxStepsPerWorkflow: z.number().int().positive().default(25),
  parallelExplorers: z.number().int().positive().default(2),
  focus: z.array(z.string()).default([]).describe('Areas or features to prioritise'),
});
export type ExplorationConfig = z.infer<typeof ExplorationConfigSchema>;

export const ScheduleActionSchema = z.enum(['run', 'explore', 'mutate', 'cycle']);
export type ScheduleAction = z.infer<typeof ScheduleActionSchema>;

export const ScheduleConfigSchema = z.object({
  continuous: z
    .object({
      idleMs: z
        .number()
        .int()
        .nonnegative()
        .default(10 * 60_000),
      exploreEveryCycles: z
        .number()
        .int()
        .positive()
        .default(3)
        .describe(
          'Explore on the first cycle and then every N cycles; other cycles replay and mutate',
        ),
      maxCycles: z.number().int().positive().optional(),
    })
    .prefault({}),
  cron: z
    .array(
      z.object({
        expression: z.string().min(1),
        action: ScheduleActionSchema.default('cycle'),
        target: z.string().optional(),
      }),
    )
    .default([]),
});
export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>;

export const ConfigSchema = z.object({
  version: z.literal(1),
  project: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
  }),
  targets: z.array(TargetConfigSchema).default([]),
  providers: z
    .record(z.string(), ProviderConfigSchema)
    .prefault({})
    .describe('Model providers; inferred from API key environment variables when empty'),
  agents: AgentsConfigSchema.prefault({}),
  mutations: MutationsConfigSchema.prefault({}),
  execution: ExecutionConfigSchema.prefault({}),
  oracles: OraclesConfigSchema.prefault({}),
  exploration: ExplorationConfigSchema.prefault({}),
  schedule: ScheduleConfigSchema.prefault({}),
  store: z.object({ path: z.string().default('.mutationworkflow/mw.db') }).prefault({}),
  evidenceDir: z.string().default('.mutationworkflow/evidence'),
  reportsDir: z.string().default('.mutationworkflow/reports'),
});
export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
