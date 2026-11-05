import type { MutationOperator, Variant } from '../types.js';
import { isAnchor } from './shared.js';

/** Swap two neighbouring steps: real users do things in a different order than tests do. */
export const reorderStepsOperator: MutationOperator = {
  id: 'reorder-steps',
  description: 'Swaps each adjacent pair of non-anchor steps',
  mutate(workflow, { hints }) {
    const { steps } = workflow;
    const variants: Variant[] = [];
    for (let index = 0; index + 1 < steps.length; index++) {
      const first = steps[index];
      const second = steps[index + 1];
      if (!first || !second || isAnchor(first, hints) || isAnchor(second, hints)) continue;
      const swapped = [...steps];
      swapped[index] = second;
      swapped[index + 1] = first;
      variants.push({
        titleSuffix: `swap steps ${index + 1} and ${index + 2}`,
        description: `Performs step ${index + 2} (${second.action.type}) before step ${index + 1} (${first.action.type}); the app should handle the other order or refuse it cleanly`,
        steps: swapped,
        params: { index },
      });
    }
    return variants;
  },
};
