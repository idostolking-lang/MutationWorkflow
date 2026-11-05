import type { MutationOperator, Variant } from '../types.js';
import { isAnchor } from './shared.js';

/**
 * Abandon the workflow part-way. The final expectations no longer apply, so only crashes and
 * invariants (for example "no orphaned records") can fail these variants.
 */
export const truncateOperator: MutationOperator = {
  id: 'truncate',
  description: 'Stops the workflow early, as a user abandoning it would',
  mutate(workflow, { hints }) {
    const { steps } = workflow;
    if (steps.length < 3) return [];
    let leadingAnchors = 0;
    while (leadingAnchors < steps.length) {
      const step = steps[leadingAnchors];
      if (!step || !isAnchor(step, hints)) break;
      leadingAnchors++;
    }
    const variants: Variant[] = [];
    for (let keep = leadingAnchors + 1; keep < steps.length; keep++) {
      variants.push({
        titleSuffix: `stop after step ${keep}`,
        description: `Abandons the workflow after step ${keep} of ${steps.length}; whatever was left half-done must not break the app`,
        steps: steps.slice(0, keep),
        expect: [],
        params: { keep },
      });
    }
    return variants;
  },
};
