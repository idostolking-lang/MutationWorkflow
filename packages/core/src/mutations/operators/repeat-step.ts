import type { MutationOperator, Variant } from '../types.js';
import { isAnchor } from './shared.js';

/** Do one step twice: double clicks, double submits and retried requests. */
export const repeatStepOperator: MutationOperator = {
  id: 'repeat-step',
  description: 'Performs one non-anchor step twice in a row',
  mutate(workflow, { hints }) {
    const { steps } = workflow;
    const variants: Variant[] = [];
    steps.forEach((step, index) => {
      if (isAnchor(step, hints) || step.action.type === hints.waitAction?.type) return;
      // The repeat drops the step's own expectations: they describe the state after one
      // performance, which a second one may legitimately change.
      const repeated = { action: step.action, note: step.note, expect: [] };
      variants.push({
        titleSuffix: `repeat step ${index + 1}`,
        description: `Performs step ${index + 1} (${step.action.type}) twice, like a double click or a retried submit`,
        steps: [...steps.slice(0, index + 1), repeated, ...steps.slice(index + 1)],
        params: { index },
      });
    });
    return variants;
  },
};
