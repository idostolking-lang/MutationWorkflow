import { type StepInput, stableStringify, type Workflow } from '../../schema/index.js';
import type { MutationOperator, Variant } from '../types.js';

/** At most this many siblings are interleaved with each workflow. */
const MAX_SIBLINGS = 3;

function byTitle(a: Workflow, b: Workflow): number {
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Alternate the steps of two workflows, dropping a step that would repeat the previous action. */
function alternate(a: ReadonlyArray<StepInput>, b: ReadonlyArray<StepInput>): StepInput[] {
  const merged: StepInput[] = [];
  let previous: string | undefined;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    for (const step of [a[i], b[i]]) {
      if (!step) continue;
      const action = stableStringify(step.action);
      if (action === previous) continue;
      merged.push(step);
      previous = action;
    }
  }
  return merged;
}

/**
 * Weave two workflows together, as a user with two tabs or two tasks in flight would. Neither
 * workflow's final expectations hold for the mixture, so they are dropped.
 */
export const interleaveOperator: MutationOperator = {
  id: 'interleave',
  description: 'Alternates the steps of this workflow with another workflow of the same identity',
  mutate(workflow, { siblings }) {
    if (workflow.steps.length < 2) return [];
    return siblings
      .filter(
        (sibling) =>
          sibling.id !== workflow.id &&
          sibling.origin !== 'mutation' &&
          sibling.identity === workflow.identity &&
          sibling.steps.length >= 2,
      )
      .sort(byTitle)
      .slice(0, MAX_SIBLINGS)
      .map(
        (sibling): Variant => ({
          titleSuffix: `interleaved with "${sibling.title}"`,
          description: `Alternates each step with a step of "${sibling.title}", as a user doing both at once would`,
          steps: alternate(workflow.steps, sibling.steps),
          expect: [],
          params: { siblingId: sibling.id },
        }),
      );
  },
};
