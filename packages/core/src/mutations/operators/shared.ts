import type { MutationHints } from '../../adapter/types.js';
import type { Action, Step, StepInput } from '../../schema/index.js';

/** Anchor steps set the stage (navigate, start) and are never removed, moved or repeated. */
export function isAnchor(step: Step, hints: MutationHints): boolean {
  return hints.anchorActionTypes.includes(step.action.type);
}

/** A new step performing `action`, with no expectations of its own. */
export function bareStep(action: Action): StepInput {
  return { action, expect: [] };
}
