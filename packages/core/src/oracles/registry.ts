import { BUILTIN_ORACLE_IDS } from '../config/schema.js';
import type { OracleResult } from '../schema/index.js';
import { MutationWorkflowError } from '../util/errors.js';
import { appErrorOracle } from './builtin/app-error.js';
import { assertionsOracle } from './builtin/assertions.js';
import { invariantsOracle } from './builtin/invariants.js';
import { stepFailureOracle } from './builtin/step-failure.js';
import type { Oracle, OracleContext } from './types.js';

export function builtinOracles(): Oracle[] {
  return [stepFailureOracle, appErrorOracle, assertionsOracle, invariantsOracle];
}

/** Resolve oracle ids from the config, allowing extra (custom) oracles to be registered. */
export function resolveOracles(
  ids: ReadonlyArray<string>,
  extra: ReadonlyArray<Oracle> = [],
): Oracle[] {
  const available = new Map<string, Oracle>();
  for (const oracle of [...builtinOracles(), ...extra]) available.set(oracle.id, oracle);
  return ids.map((id) => {
    const oracle = available.get(id);
    if (!oracle) {
      throw new MutationWorkflowError(
        'INVALID_INPUT',
        `Unknown oracle "${id}". Built-in oracles: ${BUILTIN_ORACLE_IDS.join(', ')}`,
      );
    }
    return oracle;
  });
}

/** Run every oracle and collect their results; an oracle that throws becomes a skipped result. */
export function evaluateOracles(
  oracles: ReadonlyArray<Oracle>,
  context: OracleContext,
): OracleResult[] {
  const results: OracleResult[] = [];
  for (const oracle of oracles) {
    try {
      results.push(...oracle.evaluate(context));
    } catch (error) {
      results.push({
        oracle: oracle.id,
        verdict: 'skip',
        summary: `Oracle crashed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return results;
}
