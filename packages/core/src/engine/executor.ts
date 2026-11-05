import { EvidenceSink } from '../adapter/evidence.js';
import type { Adapter, AdapterSession } from '../adapter/types.js';
import type { Config } from '../config/schema.js';
import { evaluateOracles } from '../oracles/registry.js';
import type { Oracle } from '../oracles/types.js';
import {
  type Assertion,
  type AssertionResult,
  type AssertionScope,
  type Evidence,
  newId,
  nowIso,
  type Run,
  type RunContext,
  RunSchema,
  type RunStatus,
  type RunTrigger,
  type Signal,
  type Step,
  type StepResult,
  type StepStatus,
  type TargetConfig,
  type Workflow,
} from '../schema/index.js';
import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { applyIdentity } from './identity.js';

export interface ExecuteOptions {
  workflow: Workflow;
  target: TargetConfig;
  adapter: Adapter;
  config: Pick<Config, 'execution' | 'oracles'>;
  oracles: ReadonlyArray<Oracle>;
  /** Absolute evidence root directory. */
  evidenceRoot: string;
  trigger: RunTrigger;
  context?: Partial<Omit<RunContext, 'mutated'>>;
  logger: Logger;
}

export interface ExecutionResult {
  run: Run;
  evidence: Evidence[];
}

const CLOSE_TIMEOUT_MS = 10_000;

/**
 * Replay one workflow in a fresh adapter session with no model involved: identity setup, each
 * step with its expectations, final expectations, invariants, error signals, then the oracles.
 * Never throws: every problem, including an adapter that hangs or a session that cannot open,
 * ends up in a complete Run record.
 */
export async function executeWorkflow(options: ExecuteOptions): Promise<ExecutionResult> {
  const { workflow, target, adapter, config, logger } = options;
  const runId = newId('run');
  const startedAt = nowIso();
  const started = Date.now();
  const deadline = started + config.execution.workflowTimeoutMs;
  const remaining = () => deadline - Date.now();
  const sink = new EvidenceSink({
    rootDir: options.evidenceRoot,
    sessionDir: `runs/${runId}`,
    runId,
  });
  const steps: StepResult[] = [];
  const assertions: AssertionResult[] = [];
  let signals: Signal[] = [];
  let runError: string | undefined;
  let session: AdapterSession | undefined;

  try {
    session = await withTimeout(
      adapter.open({
        sessionId: runId,
        runId,
        evidence: sink,
        screenshots: config.execution.screenshots,
        stepTimeoutMs: config.execution.stepTimeoutMs,
        assertionTimeoutMs: config.execution.assertionTimeoutMs,
        scope: target.scope,
        logger,
      }),
      remaining(),
      'opening the session',
    );
    await withTimeout(
      applyIdentity(session, target, workflow.identity),
      remaining(),
      'setting up the identity',
    );

    let stopped = false;
    for (const [index, step] of workflow.steps.entries()) {
      if (!stopped && remaining() <= 0) {
        runError = `Workflow exceeded ${config.execution.workflowTimeoutMs} ms`;
        stopped = true;
      }
      if (stopped) {
        steps.push({ stepId: step.id, index, status: 'skipped', durationMs: 0, evidenceIds: [] });
        continue;
      }
      const result = await performStep(session, step, index, assertions, target, remaining);
      steps.push(result);
      if (result.status !== 'passed') stopped = true;
    }
    if (!stopped) {
      await checkAll(session, workflow.expect, 'final', undefined, assertions, remaining);
    }
    await checkInvariants(session, target, 'after-workflow', undefined, assertions, remaining);
    signals = session.drainSignals();

    const troubled =
      steps.some((s) => s.status !== 'passed' && s.status !== 'skipped') ||
      assertions.some((a) => !a.passed) ||
      signals.length > 0;
    if (troubled && config.execution.screenshots !== 'never') {
      // Failures through signals or expectations leave no failed action behind, so capture the
      // final state explicitly for the triager and the report.
      await withTimeout(
        session.capture('screenshot', 'final-state'),
        CLOSE_TIMEOUT_MS,
        'capturing',
      ).catch(() => undefined);
    }
  } catch (error) {
    runError = errorMessage(error);
    logger.error(`Run ${runId} failed: ${runError}`);
    try {
      signals = session?.drainSignals() ?? [];
    } catch {
      // The session is already broken; signals are a bonus here.
    }
  } finally {
    if (session) {
      await withTimeout(session.close(), CLOSE_TIMEOUT_MS, 'closing the session').catch(
        (error: unknown) =>
          logger.warn(`Could not close session for ${runId}: ${errorMessage(error)}`),
      );
    }
  }

  const mutated = workflow.origin === 'mutation';
  const oracles = evaluateOracles(options.oracles, {
    workflow,
    target,
    mutated,
    steps,
    assertions,
    signals,
    runError,
    config: config.oracles,
  });

  const run = RunSchema.parse({
    id: runId,
    workflowId: workflow.id,
    targetId: target.id,
    trigger: options.trigger,
    status: deriveStatus(steps, assertions, oracles, runError),
    startedAt,
    finishedAt: nowIso(),
    durationMs: Date.now() - started,
    steps,
    assertions,
    signals,
    oracles,
    evidenceIds: sink.all.map((e) => e.id),
    context: { ...options.context, mutated },
    error: runError,
  });
  return { run, evidence: [...sink.all] };
}

async function performStep(
  session: AdapterSession,
  step: Step,
  index: number,
  assertions: AssertionResult[],
  target: TargetConfig,
  remaining: () => number,
): Promise<StepResult> {
  const started = Date.now();
  let status: StepStatus;
  let message: string | undefined;
  let evidenceIds: string[] = [];
  try {
    const outcome = await withTimeout(
      session.perform(step.action, { stepId: step.id, index }),
      remaining(),
      `performing step ${index + 1}`,
    );
    status =
      outcome.status === 'ok' ? 'passed' : outcome.status === 'blocked' ? 'blocked' : 'error';
    message = outcome.message;
    evidenceIds = outcome.evidence.map((e) => e.id);
  } catch (error) {
    status = 'error';
    message = errorMessage(error);
  }
  if (status === 'passed') {
    const failed = await checkAll(session, step.expect, 'step', step.id, assertions, remaining);
    await checkInvariants(session, target, 'after-step', step.id, assertions, remaining);
    if (failed) {
      status = 'failed';
      message = failed;
    }
  }
  return { stepId: step.id, index, status, durationMs: Date.now() - started, message, evidenceIds };
}

/** Check assertions, record the results, and return the first failure message if any. */
async function checkAll(
  session: AdapterSession,
  list: ReadonlyArray<Assertion>,
  scope: AssertionScope,
  stepId: string | undefined,
  into: AssertionResult[],
  remaining: () => number,
): Promise<string | undefined> {
  let firstFailure: string | undefined;
  for (const assertion of list) {
    let result: { passed: boolean; message?: string };
    try {
      result = await withTimeout(session.check(assertion), remaining(), 'checking an assertion');
    } catch (error) {
      result = {
        passed: false,
        message: `Assertion could not be evaluated: ${errorMessage(error)}`,
      };
    }
    into.push({ assertion, scope, stepId, passed: result.passed, message: result.message });
    if (!result.passed && firstFailure === undefined) {
      const what = (assertion.description as string | undefined) ?? assertion.type;
      firstFailure = `${what}${result.message ? `: ${result.message}` : ''}`;
    }
  }
  return firstFailure;
}

async function checkInvariants(
  session: AdapterSession,
  target: TargetConfig,
  when: 'after-step' | 'after-workflow',
  stepId: string | undefined,
  into: AssertionResult[],
  remaining: () => number,
): Promise<void> {
  const checks = target.invariants
    .filter((invariant) => invariant.when === when)
    .map((invariant) => ({
      ...invariant.check,
      description: invariant.description ?? invariant.id,
    }));
  await checkAll(session, checks, 'invariant', stepId, into, remaining);
}

function deriveStatus(
  steps: StepResult[],
  assertions: AssertionResult[],
  oracles: Run['oracles'],
  runError: string | undefined,
): RunStatus {
  if (runError) return 'error';
  if (steps.some((s) => s.status === 'failed' || s.status === 'error')) return 'failed';
  if (assertions.some((a) => !a.passed)) return 'failed';
  if (oracles.some((o) => o.verdict === 'fail')) return 'failed';
  if (steps.some((s) => s.status === 'blocked')) return 'blocked';
  return 'passed';
}

/** Reject when `promise` does not settle within `ms`; the underlying work is not cancelled. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  const limit = Math.max(1, ms);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${limit} ms while ${what}`)),
      limit,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
