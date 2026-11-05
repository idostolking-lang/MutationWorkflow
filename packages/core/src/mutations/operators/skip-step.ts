import type { MutationOperator, Variant } from '../types.js';
import { isAnchor } from './shared.js';

/** Leave out one step: users forget things, and apps should stop or recover, not break. */
export const skipStepOperator: MutationOperator = {
  id: 'skip-step',
  description: 'Removes one non-anchor step at a time',
  mutate(workflow, { hints }) {
    const { steps } = workflow;
    if (steps.length < 2) return [];
    const variants: Variant[] = [];
    steps.forEach((step, index) => {
      if (isAnchor(step, hints)) return;
      const remaining = steps.filter((_, i) => i !== index);
      if (!remaining.some((s) => !isAnchor(s, hints))) return;
      variants.push({
        titleSuffix: `skip step ${index + 1}`,
        description: `Skips step ${index + 1} (${step.action.type}); the app should block or recover from the missing step instead of breaking`,
        steps: remaining,
        params: { index },
      });
    });
    return variants;
  },
};
