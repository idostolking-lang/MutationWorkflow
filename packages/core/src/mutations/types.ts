import type { MutationHints } from '../adapter/types.js';
import type { MutationsConfig } from '../config/schema.js';
import type { Assertion, StepInput, TargetConfig, Workflow } from '../schema/index.js';

export interface MutationContext {
  target: TargetConfig;
  hints: MutationHints;
  /** Other base workflows of the same target, for operators that combine workflows. */
  siblings: ReadonlyArray<Workflow>;
  config: MutationsConfig;
}

/** A proposed change to a workflow. The registry turns it into a stored workflow. */
export interface Variant {
  /** Short label appended to the parent title, e.g. "skip step 3". */
  titleSuffix: string;
  /** What changed and why it might reveal a bug. */
  description: string;
  steps: StepInput[];
  /** Final-state expectations; defaults to the parent's when omitted. */
  expect?: Assertion[];
  identity?: string;
  params?: Record<string, unknown>;
}

/**
 * A mutation operator derives variants of a workflow that a real user could plausibly perform
 * but nobody wrote a test for: skipping a step, doing it twice, interrupting, changing data.
 * Operators are deterministic: the same workflow always yields the same variants.
 */
export interface MutationOperator {
  readonly id: string;
  readonly description: string;
  mutate(workflow: Workflow, context: MutationContext): Variant[];
}
