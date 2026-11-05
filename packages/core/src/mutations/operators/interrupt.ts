import type { MutationOperator, Variant } from '../types.js';
import { bareStep, isAnchor } from './shared.js';

/**
 * Insert an interruption such as a reload or back-and-forward between two steps. State the app
 * keeps only in memory gets lost, and the rest of the workflow shows whether it recovers, so the
 * expectations are kept.
 */
export const interruptOperator: MutationOperator = {
  id: 'interrupt',
  description: 'Inserts an interruption (reload, navigation, signal) between steps',
  mutate(workflow, { hints }) {
    const { steps } = workflow;
    const sequences = hints.interruptSequences.filter((sequence) => sequence.length > 0);
    const variants: Variant[] = [];
    steps.forEach((step, index) => {
      if (index === steps.length - 1 || isAnchor(step, hints)) return;
      for (const sequence of sequences) {
        const label = sequence.map((action) => action.type).join(' then ');
        variants.push({
          titleSuffix: `${label} after step ${index + 1}`,
          description: `Performs ${label} after step ${index + 1} (${step.action.type}); the rest of the workflow should still work`,
          steps: [
            ...steps.slice(0, index + 1),
            ...sequence.map(bareStep),
            ...steps.slice(index + 1),
          ],
          params: { index, sequence: sequence.map((action) => action.type) },
        });
      }
    });
    return variants;
  },
};
