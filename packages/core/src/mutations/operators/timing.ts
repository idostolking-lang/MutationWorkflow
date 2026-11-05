import type { MutationOperator, Variant } from '../types.js';
import { bareStep } from './shared.js';

/** Pause used by the `pause before last step` variant, long enough to outlive most debounces. */
const PAUSE_MS = 2000;

/**
 * Change the pace of a workflow: without its waits the app sees actions as fast as possible,
 * which exposes races; with a pause before the end, timers and sessions get a chance to fire.
 */
export const timingOperator: MutationOperator = {
  id: 'timing',
  description: 'Removes waits, or pauses before the last step',
  mutate(workflow, { hints }) {
    const wait = hints.waitAction;
    if (!wait) return [];
    const { steps } = workflow;
    const variants: Variant[] = [];
    const withoutWaits = steps.filter((step) => step.action.type !== wait.type);
    if (withoutWaits.length > 0 && withoutWaits.length < steps.length) {
      variants.push({
        titleSuffix: 'no waits',
        description: 'Removes every wait so the app receives actions as fast as possible',
        steps: withoutWaits,
        params: { removed: steps.length - withoutWaits.length },
      });
    }
    const pause = bareStep({ type: wait.type, [wait.field]: PAUSE_MS });
    variants.push({
      titleSuffix: 'pause before last step',
      description: `Waits ${PAUSE_MS} ms before the last step, giving timers, debounces and expiring state time to fire`,
      steps: [...steps.slice(0, -1), pause, ...steps.slice(-1)],
      params: { ms: PAUSE_MS },
    });
    return variants;
  },
};
