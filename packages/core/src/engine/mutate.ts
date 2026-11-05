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
import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';

export interface MutateDeps {
  store: Store;
  config: Config;
  target: TargetConfig;
  adapter: Adapter;
  runtime?: AgentRuntime;
  logger: Logger;
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

const MAX_AGENT_BASES = 10;
const MAX_AGENT_VARIANTS = 6;

/**
 * Derive new workflow variants for a target. Deterministic operators run first and are cheap;
 * the mutator agent is optional and adds semantically interesting variants. Variants whose
 * actions already exist (same fingerprint) are never stored twice.
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
  const description = adapter.describe();
  const context: MutationContext = {
    target,
    hints: description.hints,
    siblings: allBases,
    config: config.mutations,
  };
  const maxVariants = options.maxVariantsPerWorkflow ?? config.mutations.maxVariantsPerWorkflow;
  const created: Workflow[] = [];
  let fromOperators = 0;

  for (const base of bases) {
    // The cap is per base workflow in total, not per call, so repeated runs converge.
    const remaining = maxVariants - (await store.workflows.count({ parentId: base.id }));
    if (remaining <= 0) continue;
    const variants = generateVariants(base, operators, context, {
      maxVariants: remaining,
      existingFingerprints: existing,
    });
    for (const variant of variants) {
      if (!validSteps(adapter, variant, logger)) continue;
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
      fromAgent += await agentVariants(deps, base, existing, created, description);
    }
    logger.info(`Mutator agent produced ${fromAgent} new variant(s)`);
  } else if (options.agent) {
    logger.warn('Agent mutations requested but no model provider is configured');
  }

  return { created, bases: bases.length, fromOperators, fromAgent };
}

async function agentVariants(
  deps: MutateDeps,
  base: Workflow,
  existing: Set<string>,
  created: Workflow[],
  description: ReturnType<Adapter['describe']>,
): Promise<number> {
  const { store, target, adapter, logger, runtime } = deps;
  if (!runtime) return 0;
  const siblings = await store.workflows.list({ parentId: base.id });
  const result = await runtime.run({
    role: 'mutator',
    delegate: false,
    system: mutatorPrompt({
      target,
      adapter: description,
      workflow: base,
      existingVariantDescriptions: siblings.map((s) => s.mutation?.description ?? s.title),
      maxVariants: MAX_AGENT_VARIANTS,
    }),
    task: `Propose variants of the workflow "${base.title}" and submit them with finish.`,
    tools: [],
    output: AgentVariantsSchema,
    jobId: deps.jobId,
    signal: deps.signal,
    onEvent: deps.onEvent,
  });
  if (!result.output) {
    logger.warn(`Mutator produced nothing for "${base.title}" (${result.stoppedBecause})`);
    return 0;
  }
  let count = 0;
  for (const proposal of (result.output as AgentVariants).variants) {
    const steps = normalizeSteps(proposal.steps);
    const fingerprint = workflowFingerprint(target.id, base.identity, steps);
    if (existing.has(fingerprint)) continue;
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
    if (!validSteps(adapter, workflow, logger)) continue;
    await store.workflows.insert(workflow);
    existing.add(fingerprint);
    created.push(workflow);
    count += 1;
  }
  return count;
}

function validSteps(adapter: Adapter, workflow: Workflow, logger: Logger): boolean {
  for (const step of workflow.steps) {
    try {
      adapter.validateAction(step.action);
      for (const assertion of step.expect) adapter.validateAssertion(assertion);
    } catch (error) {
      logger.warn(`Skipping variant "${workflow.title}": ${errorMessage(error)}`);
      return false;
    }
  }
  for (const assertion of workflow.expect) {
    try {
      adapter.validateAssertion(assertion);
    } catch (error) {
      logger.warn(`Skipping variant "${workflow.title}": ${errorMessage(error)}`);
      return false;
    }
  }
  return true;
}
