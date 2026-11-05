import type { MutationOperator, Variant } from '../types.js';

/**
 * Perform the same workflow as a different identity, or as nobody. Another role may be refused,
 * so the final expectations are dropped; what remains are crashes, invariants and the question
 * of whether a step that should have been blocked was allowed.
 */
export const roleSwapOperator: MutationOperator = {
  id: 'role-swap',
  description: 'Performs the workflow as another identity or anonymously',
  mutate(workflow, { target }) {
    const variants: Variant[] = [];
    for (const identity of target.identities) {
      if (identity.id === workflow.identity) continue;
      variants.push({
        titleSuffix: `as ${identity.id}`,
        description: `Performs the workflow as "${identity.id}" instead of ${workflow.identity ? `"${workflow.identity}"` : 'an anonymous user'}; it should be allowed or refused cleanly`,
        steps: workflow.steps,
        expect: [],
        identity: identity.id,
        params: { identity: identity.id },
      });
    }
    if (workflow.identity !== undefined) {
      variants.push({
        titleSuffix: 'anonymous',
        description: `Performs the workflow without signing in as "${workflow.identity}"; protected steps should be refused cleanly`,
        steps: workflow.steps,
        expect: [],
        identity: undefined,
        params: { identity: null },
      });
    }
    return variants;
  },
};
