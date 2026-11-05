import type { OracleResult } from '../../schema/index.js';
import type { Oracle, OracleContext } from '../types.js';

/**
 * Invariants are properties the operator declared must hold after any workflow (the health
 * endpoint answers, totals add up). A broken invariant is a bug whatever the workflow did.
 */
export const invariantsOracle: Oracle = {
  id: 'invariants',
  description: 'Fails when a target-level invariant is violated',
  evaluate(context: OracleContext): OracleResult[] {
    return context.assertions
      .filter((a) => a.scope === 'invariant' && !a.passed)
      .map((a) => ({
        oracle: 'invariants',
        verdict: 'fail' as const,
        severity: 'high' as const,
        signature: `invariants:${a.assertion.type}:${(a.assertion.description as string | undefined) ?? ''}`,
        summary: `Invariant violated: ${(a.assertion.description as string | undefined) ?? a.assertion.type}${a.message ? ` (${a.message})` : ''}`,
        details: { assertion: a.assertion, stepId: a.stepId, message: a.message },
      }));
  },
};
