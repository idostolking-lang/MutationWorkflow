import { z } from 'zod';
import type { Adapter } from '../adapter/types.js';
import {
  type AgentVariants,
  AgentVariantsSchema,
  mutatorPrompt,
} from '../agents/prompts/mutator.js';
import type { AgentEvent, AgentRuntime } from '../agents/runtime.js';
import type { Config } from '../config/schema.js';
import { generateVariants, resolveOperators } from '../mutations/registry.js';
import type { MutationContext } from '../mutations/types.js';
import {
  createWorkflow,
  normalizeSteps,
  type TargetConfig,
  type Workflow,
  workflowFingerprint,
} from '../schema/index.js';
import type { Store } from '../store/types.js';
import { MutationWorkflowError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { workflowProblem } from './identity.js';

/** What mutation needs regardless of who proposes the agent variants. */
export interface MutationContextDeps {
  store: Store;
  target: TargetConfig;
  adapter: Adapter;
  logger: Logger;
}

export interface MutateDeps extends MutationContextDeps {
  config: Config;
  runtime?: AgentRuntime;
  jobId?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export interface MutateOptions {
  /** Restrict to these base workflows; defaults to every base workflow of the target. */
  workflowIds?: string[];
  /** Also ask the mutator agent for variants the operators cannot think of. */
  agent?: boolean;
  maxVariantsPerWorkflow?: number;
  operators?: string[];
}

export interface MutateResult {
  created: Workflow[];
  bases: number;
  fromOperators: number;
  fromAgent: number;
}

/** Everything a mutator needs for one base workflow, in-process or in a connected coding agent. */
export interface MutationBrief {
  system: string;
  task: string;
  /** JSON Schema of the variants to submit. */
  variantsSchema: Record<string, unknown>;
}

const MAX_AGENT_BASES = 10;
export const MAX_AGENT_VARIANTS = 6;

/**
 * Derive new workflow variants for a target. Deterministic operators run first and are cheap;
 * the mutator agent is optional and adds semantically interesting variants. Variants whose
 * actions already exist (same fingerprint) are never stored twice, and the cap is a total per
 * base workflow, so repeated calls converge.
 */
export async function mutate(deps: MutateDeps, options: MutateOptions = {}): Promise<MutateResult> {
  const { store, config, target, adapter, logger } = deps;
  const allBases = await store.workflows.list({
    targetId: target.id,
    parentId: null,
    status: ['active', 'pending-review'],
  });
  const bases = options.workflowIds
    ? allBases.filter((w) => options.workflowIds?.includes(w.id))
    : allBases;
  const existing = new Set(
    (await store.workflows.list({ targetId: target.id })).map((w) => w.fingerprint),
  );
  const operators = resolveOperators(options.operators ?? config.mutations.operators);
  const context: MutationContext = {
    target,
    hints: adapter.describe().hints,
    siblings: allBases,
    config: config.mutations,
  };
  const maxVariants = options.maxVariantsPerWorkflow ?? config.mutations.maxVariantsPerWorkflow;
  const created: Workflow[] = [];
  let fromOperators = 0;

  for (const base of bases) {
    const remaining = maxVariants - (await store.workflows.count({ parentId: base.id }));
    if (remaining <= 0) continue;
    const variants = generateVariants(base, operators, context, {
      maxVariants: remaining,
      existingFingerprints: existing,
    });
    for (const variant of variants) {
      const problem = workflowProblem(adapter, variant);
      if (problem) {
        logger.warn(`Skipping variant "${variant.title}": ${problem}`);
        continue;
      }
      await store.workflows.insert(variant);
      existing.add(variant.fingerprint);
      created.push(variant);
      fromOperators += 1;
    }
  }
  logger.info(
    `Operators produced ${fromOperators} new variant(s) from ${bases.length} base workflow(s)`,
  );

  let fromAgent = 0;
  if (options.agent && deps.runtime?.enabled) {
    for (const base of bases.slice(0, MAX_AGENT_BASES)) {
      if (deps.signal?.aborted) break;
      const brief = await mutationBrief(deps, base);
      const result = await deps.runtime.run({
        role: 'mutator',
        delegate: false,
        system: brief.system,
        task: `${brief.task} Submit them with the finish tool.`,
        tools: [],
        output: AgentVariantsSchema,
        jobId: deps.jobId,
        signal: deps.signal,
        onEvent: deps.onEvent,
      });
      if (!result.output) {
        logger.warn(`Mutator produced nothing for "${base.title}" (${result.stoppedBecause})`);
        continue;
      }
      const added = await applyAgentVariants(deps, base, result.output, existing);
      created.push(...added);
      fromAgent += added.length;
    }
    logger.info(`Mutator agent produced ${fromAgent} new variant(s)`);
  } else if (options.agent) {
    logger.warn('Agent mutations requested but no model provider is configured');
  }

  return { created, bases: bases.length, fromOperators, fromAgent };
}

export async function mutationBrief(
  deps: MutationContextDeps,
  base: Workflow,
): Promise<MutationBrief> {
  const siblings = await deps.store.workflows.list({ parentId: base.id });
  const { $schema: _ignored, ...variantsSchema } = z.toJSONSchema(AgentVariantsSchema, {
    io: 'input',
    target: 'draft-2020-12',
  }) as Record<string, unknown>;
  return {
    system: mutatorPrompt({
      target: deps.target,
      adapter: deps.adapter.describe(),
      workflow: base,
      existingVariantDescriptions: siblings.map((s) => s.mutation?.description ?? s.title),
      maxVariants: MAX_AGENT_VARIANTS,
    }),
    task: `Propose variants of the workflow "${base.title}".`,
    variantsSchema,
  };
}

/**
 * Store agent-proposed variants of a base workflow: positional step ids, the base's status and
 * identity, expectations only when the proposal keeps them, and no duplicates by fingerprint.
 */
export async function applyAgentVariants(
  deps: MutationContextDeps,
  base: Workflow,
  rawVariants: unknown,
  existing?: Set<string>,
): Promise<Workflow[]> {
  const { store, target, adapter, logger } = deps;
  const parsed = AgentVariantsSchema.safeParse(rawVariants);
  if (!parsed.success) {
    throw new MutationWorkflowError(
      'INVALID_INPUT',
      `The proposed variants are invalid:\n${z.prettifyError(parsed.error)}`,
    );
  }
  const known =
    existing ??
    new Set((await store.workflows.list({ targetId: target.id })).map((w) => w.fingerprint));
  const added: Workflow[] = [];
  for (const proposal of (parsed.data as AgentVariants).variants) {
    // Ids the model copied from the base would collide; positions decide them.
    const steps = normalizeSteps(proposal.steps.map(({ id: _id, ...step }) => step));
    const fingerprint = workflowFingerprint(target.id, base.identity, steps);
    if (known.has(fingerprint)) continue;
    const workflow = createWorkflow(
      target.id,
      {
        title: `${base.title} (${proposal.titleSuffix})`,
        intent: base.intent,
        steps,
        expect: proposal.expect ?? [],
        identity: base.identity,
        tags: [...new Set([...base.tags, 'mutation', 'agent'])],
      },
      {
        origin: 'mutation',
        status: base.status,
        parentId: base.id,
        mutation: { operator: 'agent', description: proposal.description },
      },
    );
    const problem = workflowProblem(adapter, workflow);
    if (problem) {
      logger.warn(`Skipping agent variant "${workflow.title}": ${problem}`);
      continue;
    }
    await store.workflows.insert(workflow);
    known.add(fingerprint);
    added.push(workflow);
  }
  return added;
}
