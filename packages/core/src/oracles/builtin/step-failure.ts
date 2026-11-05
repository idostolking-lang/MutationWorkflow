import type { OracleResult } from '../../schema/index.js';
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
      if (step.status === 'passed' || step.status === 'skipped') continue;
      if (context.mutated && step.status === 'blocked') {
        results.push({
          oracle: 'step-failure',
          verdict: 'skip',
          summary: `Step ${step.index + 1} was blocked after the mutation: ${step.message ?? 'no detail'}`,
        });
        continue;
      }
      const action = context.workflow.steps[step.index]?.action.type ?? 'unknown';
      results.push({
        oracle: 'step-failure',
        verdict: 'fail',
        severity: context.mutated ? 'medium' : 'high',
        signature: `step-failure:${step.status}:${action}:${step.index}`,
        summary: `Step ${step.index + 1} (${action}) ${step.status}: ${step.message ?? 'no detail'}`,
        details: { stepId: step.stepId, status: step.status },
      });
      break;
    }
    return results;
  },
};
