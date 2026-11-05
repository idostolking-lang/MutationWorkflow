import { fingerprint, type OracleResult } from '../../schema/index.js';
import type { Oracle, OracleContext } from '../types.js';

/**
 * A base workflow that cannot complete is a regression: every step was performed before.
 * On a mutated workflow only infrastructure-free `error` steps count; `blocked` means the
 * application refused an out-of-order action, which is what it should do.
 */
export const stepFailureOracle: Oracle = {
  id: 'step-failure',
  description: 'Fails when a workflow cannot be performed to the end',
  evaluate(context: OracleContext): OracleResult[] {
    if (context.runError) {
      return [];
    }
    const results: OracleResult[] = [];
    for (const step of context.steps) {
      // Failed expectations are reported by the assertions oracle; this one covers steps that
      // could not be performed at all.
      if (step.status === 'passed' || step.status === 'skipped' || step.status === 'failed')
        continue;
      if (context.mutated && step.status === 'blocked') {
        results.push({
          oracle: 'step-failure',
          verdict: 'skip',
          summary: `Step ${step.index + 1} was blocked after the mutation: ${step.message ?? 'no detail'}`,
        });
        continue;
      }
      const stepAction = context.workflow.steps[step.index]?.action;
      const action = stepAction?.type ?? 'unknown';
      results.push({
        oracle: 'step-failure',
        verdict: 'fail',
        severity: context.mutated ? 'medium' : 'high',
        // Hash the action rather than its position: indices shift between variants of a base.
        signature: `step-failure:${step.status}:${fingerprint(stepAction ?? action)}`,
        summary: `Step ${step.index + 1} (${action}) ${step.status}: ${step.message ?? 'no detail'}`,
        details: { stepId: step.stepId, status: step.status },
      });
      break;
    }
    return results;
  },
};
