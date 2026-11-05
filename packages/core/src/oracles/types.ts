import type { OraclesConfig } from '../config/schema.js';
import type {
  AssertionResult,
  OracleResult,
  Signal,
  StepResult,
  TargetConfig,
  Workflow,
} from '../schema/index.js';

export interface OracleContext {
  workflow: Workflow;
  target: TargetConfig;
  /** True when the workflow is a mutation of a base workflow. */
  mutated: boolean;
  steps: StepResult[];
  assertions: AssertionResult[];
  signals: Signal[];
  /** Set when the run ended with an infrastructure error. */
  runError?: string;
  config: OraclesConfig;
}

/**
 * An oracle decides whether a run revealed a problem. It returns one result per distinct
 * problem (each failing result becomes, or joins, a finding) and may return an empty array
 * when it has nothing to say.
 */
export interface Oracle {
  readonly id: string;
  readonly description: string;
  evaluate(context: OracleContext): OracleResult[];
}
