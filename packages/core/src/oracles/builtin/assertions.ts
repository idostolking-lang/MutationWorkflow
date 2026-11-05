import type { OracleResult } from '../../schema/index.js';
import type { Oracle, OracleContext } from '../types.js';

/**
 * Expectations written by tests, agents or humans did not hold. On a base workflow this is a
 * regression. On a mutated workflow it may be the mutation's legitimate consequence (skipping
 * "add item" means the item is not there) or a real bug (submitting twice created two items),
 * which is why these findings start with triage pending.
 */
export const assertionsOracle: Oracle = {
  id: 'assertions',
  description: 'Fails when a step or final-state assertion does not hold',
  evaluate(context: OracleContext): OracleResult[] {
    const failed = context.assertions.filter((a) => !a.passed && a.scope !== 'invariant');
    if (failed.length === 0) return [];
    const first = failed[0];
    if (!first) return [];
    return [
      {
        oracle: 'assertions',
        verdict: 'fail',
        severity: context.mutated ? 'medium' : 'high',
        signature: `assertions:${first.scope}:${first.stepId ?? 'final'}:${first.assertion.type}`,
        summary:
          failed.length === 1
            ? describe(first)
            : `${describe(first)} (and ${failed.length - 1} more)`,
        details: {
          failed: failed.map((a) => ({
            scope: a.scope,
            stepId: a.stepId,
            assertion: a.assertion,
            message: a.message,
          })),
        },
      },
    ];
  },
};

function describe(result: OracleContext['assertions'][number]): string {
  const where = result.scope === 'final' ? 'final state' : `step ${result.stepId ?? '?'}`;
  const what = (result.assertion.description as string | undefined) ?? result.assertion.type;
  return `${where}: ${what}${result.message ? ` (${result.message})` : ''}`;
}
