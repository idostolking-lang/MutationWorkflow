import { BUILTIN_OPERATOR_IDS } from '../config/schema.js';
import {
  createWorkflow,
  type StepInput,
  type Workflow,
  workflowFingerprint,
} from '../schema/index.js';
import { MutationWorkflowError } from '../util/errors.js';
import { dataFuzzOperator } from './operators/data-fuzz.js';
import { interleaveOperator } from './operators/interleave.js';
import { interruptOperator } from './operators/interrupt.js';
import { reorderStepsOperator } from './operators/reorder-steps.js';
import { repeatStepOperator } from './operators/repeat-step.js';
import { roleSwapOperator } from './operators/role-swap.js';
import { skipStepOperator } from './operators/skip-step.js';
import { timingOperator } from './operators/timing.js';
import { truncateOperator } from './operators/truncate.js';
import type { MutationContext, MutationOperator } from './types.js';

/** The operators shipped with core, in the order of {@link BUILTIN_OPERATOR_IDS}. */
export function builtinOperators(): MutationOperator[] {
  return [
    skipStepOperator,
    reorderStepsOperator,
    repeatStepOperator,
    truncateOperator,
    dataFuzzOperator,
    interruptOperator,
    timingOperator,
    roleSwapOperator,
    interleaveOperator,
  ];
}

/**
 * Resolve operator ids from the config, in the order given. `extra` registers custom operators
 * and may replace a built-in one with the same id.
 */
export function resolveOperators(
  ids: ReadonlyArray<string>,
  extra: ReadonlyArray<MutationOperator> = [],
): MutationOperator[] {
  const available = new Map<string, MutationOperator>();
  for (const operator of [...builtinOperators(), ...extra]) available.set(operator.id, operator);
  return ids.map((id) => {
    const operator = available.get(id);
    if (!operator) {
      throw new MutationWorkflowError(
        'INVALID_INPUT',
        `Unknown mutation operator "${id}". Built-in operators: ${BUILTIN_OPERATOR_IDS.join(', ')}`,
      );
    }
    return operator;
  });
}

export interface GenerateVariantsOptions {
  /** Stop after this many variants. */
  maxVariants: number;
  /** Fingerprints of workflows that already exist, typically from the store. */
  existingFingerprints?: ReadonlySet<string>;
}

/** Variant steps get fresh positional ids: operators copy and duplicate steps freely. */
function withoutIds(steps: ReadonlyArray<StepInput>): StepInput[] {
  return steps.map(({ id: _id, ...step }) => step);
}

/**
 * Apply `operators` in order to `workflow` and build the resulting mutation workflows. Variants
 * that perform the same actions as the parent, as an earlier variant or as an existing workflow
 * are dropped; generation stops after `maxVariants`. Deterministic apart from ids and timestamps.
 */
export function generateVariants(
  workflow: Workflow,
  operators: ReadonlyArray<MutationOperator>,
  context: MutationContext,
  options: GenerateVariantsOptions,
): Workflow[] {
  const seen = new Set<string>([workflow.fingerprint, ...(options.existingFingerprints ?? [])]);
  const variants: Workflow[] = [];
  // Round-robin across operators, so a prolific operator such as data-fuzz cannot use up the
  // whole budget before interrupt, timing or interleave produce anything.
  const queues = operators.map((operator) => ({
    operator,
    pending: [...operator.mutate(workflow, context)],
  }));
  while (variants.length < options.maxVariants && queues.some((q) => q.pending.length > 0)) {
    for (const queue of queues) {
      if (variants.length >= options.maxVariants) break;
      const variant = queue.pending.shift();
      if (!variant) continue;
      const steps = withoutIds(variant.steps);
      const identity = 'identity' in variant ? variant.identity : workflow.identity;
      const fingerprint = workflowFingerprint(workflow.targetId, identity, steps);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      variants.push(
        createWorkflow(
          workflow.targetId,
          {
            title: `${workflow.title} (${variant.titleSuffix})`,
            intent: workflow.intent,
            steps,
            expect: variant.expect ?? workflow.expect,
            identity,
            tags: [...new Set([...workflow.tags, 'mutation', queue.operator.id])],
          },
          {
            origin: 'mutation',
            status: workflow.status,
            parentId: workflow.id,
            mutation: {
              operator: queue.operator.id,
              description: variant.description,
              params: variant.params,
            },
          },
        ),
      );
    }
  }
  return variants;
}
