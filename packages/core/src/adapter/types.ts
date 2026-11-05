import type { Action, Assertion } from '../schema/action.js';
import type { Evidence, Signal } from '../schema/run.js';
import type { Scope, TargetConfig } from '../schema/target.js';
import type { Logger } from '../util/logger.js';
import type { EvidenceSink } from './evidence.js';

/** Documentation of one action type, shown to agents and used to validate workflows. */
export interface ActionSpec {
  type: string;
  description: string;
  /** JSON Schema of the whole action object, including "type". */
  schema: Record<string, unknown>;
  example?: Action;
}

export interface AssertionSpec {
  type: string;
  description: string;
  schema: Record<string, unknown>;
  example?: Assertion;
}

/** What mutation operators need to know about an adapter's vocabulary. */
export interface MutationHints {
  /** Action types that set the stage (navigate, start); never removed or reordered. */
  anchorActionTypes: string[];
  /** Actions carrying user-provided data, with the field to fuzz. */
  inputActions: Array<{ type: string; field: string }>;
  /**
   * Action sequences that interrupt a flow and can be inserted between steps, for example
   * `[[reload]]` or `[[back, forward]]` for web, `[[signal SIGINT]]` for terminals.
   */
  interruptSequences: Action[][];
  /** The adapter's wait action, if any, with the field holding milliseconds. */
  waitAction?: { type: string; field: string };
}

export interface AdapterDescription {
  kind: string;
  summary: string;
  actions: ActionSpec[];
  assertions: AssertionSpec[];
  hints: MutationHints;
  /** Prose for agents: how to read observations and choose robust actions. */
  guide: string;
}

export interface SessionOptions {
  sessionId: string;
  runId?: string;
  evidence: EvidenceSink;
  screenshots: 'always' | 'on-failure' | 'never';
  stepTimeoutMs: number;
  /** How long an assertion may keep retrying before it fails; defaults to stepTimeoutMs. */
  assertionTimeoutMs?: number;
  scope: Scope;
  logger: Logger;
}

/**
 * `ok`: the action was performed.
 * `blocked`: the action could not be performed because the application did not offer it
 *   (missing control, disabled button, unknown command). Not an application error by itself.
 * `error`: the application or the adapter broke while performing it.
 */
export interface ActionOutcome {
  status: 'ok' | 'blocked' | 'error';
  message?: string;
  evidence: Evidence[];
}

export interface CheckOutcome {
  passed: boolean;
  message?: string;
}

/** A text rendering of the current application state, for agents. */
export interface Observation {
  summary: string;
  url?: string;
  title?: string;
  screenshot?: Evidence;
}

export interface StepContext {
  stepId?: string;
  index?: number;
}

/** One isolated interaction with the application: a browser context or a process. */
export interface AdapterSession {
  perform(action: Action, context?: StepContext): Promise<ActionOutcome>;
  check(assertion: Assertion): Promise<CheckOutcome>;
  observe(): Promise<Observation>;
  /** Error signals collected since the previous call. */
  drainSignals(): Signal[];
  capture(kind: 'screenshot' | 'dom' | 'output', label?: string): Promise<Evidence | undefined>;
  close(): Promise<void>;
}

export interface Adapter {
  readonly kind: string;
  describe(): AdapterDescription;
  /** Parse and normalise an action; throws when it is not in the vocabulary. */
  validateAction(action: Action): Action;
  validateAssertion(assertion: Assertion): Assertion;
  open(options: SessionOptions): Promise<AdapterSession>;
  /** Release shared resources such as a browser. */
  dispose(): Promise<void>;
}

export interface AdapterFactoryOptions {
  target: TargetConfig;
  rootDir: string;
  logger: Logger;
}

export type AdapterFactory = (options: AdapterFactoryOptions) => Promise<Adapter> | Adapter;

/** Shape of an adapter package's default export or module namespace. */
export interface AdapterModule {
  createAdapter: AdapterFactory;
  /**
   * The adapter's vocabulary without a target, for setup flows that run before any target is
   * configured (the inspector needs it to write workflows). Should equal `adapter.describe()`.
   */
  describe?: () => AdapterDescription;
}
