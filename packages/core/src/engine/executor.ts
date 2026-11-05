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
  normalizeSteps,
  nowIso,
  type Run,
  type RunContext,
  RunSchema,
  type RunStatus,
  type RunTrigger,
  type Step,
  type StepResult,
  type StepStatus,
  type TargetConfig,
  type Workflow,
} from '../schema/index.js';
import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';

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

/**
 * Replay one workflow in a fresh adapter session with no model involved: identity setup, each
 * step with its expectations, final expectations, invariants, error signals, then the oracles.
 * The result is a complete, self-contained Run record.
 */
export async function executeWorkflow(options: ExecuteOptions): Promise<ExecutionResult> {
  const { workflow, target, adapter, config, logger } = options;
  const runId = newId('run');
  const startedAt = nowIso();
  const started = Date.now();
  const sink = new EvidenceSink({
    rootDir: options.evidenceRoot,
    sessionDir: `runs/${runId}`,
    runId,
  });
  const steps: StepResult[] = [];
  const assertions: AssertionResult[] = [];
  let signals: Run['signals'] = [];
  let runError: string | undefined;

  const session = await adapter.open({
    sessionId: runId,
    runId,
    evidence: sink,
    screenshots: config.execution.screenshots,
    stepTimeoutMs: config.execution.stepTimeoutMs,
    assertionTimeoutMs: config.execution.assertionTimeoutMs,
    scope: target.scope,
    logger,
  });

  const deadline = started + config.execution.workflowTimeoutMs;
  const timedOut = () => Date.now() > deadline;

  try {
    await setUpIdentity(session, workflow, target);
    let stopped = false;
    for (const [index, step] of workflow.steps.entries()) {
      if (stopped || timedOut()) {
        steps.push({ stepId: step.id, index, status: 'skipped', durationMs: 0, evidenceIds: [] });
        if (!stopped) runError = `Workflow exceeded ${config.execution.workflowTimeoutMs} ms`;
        stopped = true;
        continue;
      }
      const result = await performStep(session, step, index, assertions, target);
      steps.push(result);
      if (result.status !== 'passed') stopped = true;
    }
    if (!stopped) {
      await checkAll(session, workflow.expect, 'final', undefined, assertions);
    }
    await checkInvariants(session, target, 'after-workflow', undefined, assertions);
    signals = session.drainSignals();
  } catch (error) {
    runError = errorMessage(error);
    logger.error(`Run ${runId} failed: ${runError}`);
    try {
      signals = session.drainSignals();
    } catch {
      // The session is already broken; signals are a bonus here.
    }
  } finally {
    await session.close().catch((error: unknown) => {
      logger.warn(`Could not close session for ${runId}: ${errorMessage(error)}`);
    });
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

  const finishedAt = nowIso();
  const run = RunSchema.parse({
    id: runId,
    workflowId: workflow.id,
    targetId: target.id,
    trigger: options.trigger,
    status: deriveStatus(steps, assertions, oracles, runError),
    startedAt,
    finishedAt,
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

async function setUpIdentity(
  session: AdapterSession,
  workflow: Workflow,
  target: TargetConfig,
): Promise<void> {
  if (!workflow.identity) return;
  const identity = target.identities.find((candidate) => candidate.id === workflow.identity);
  if (!identity) {
    throw new Error(`Identity "${workflow.identity}" is not defined for target "${target.id}"`);
  }
  for (const step of normalizeSteps(identity.steps)) {
    const outcome = await session.perform(step.action, { stepId: `identity:${step.id}` });
    if (outcome.status !== 'ok') {
      throw new Error(
        `Identity "${identity.id}" setup failed at ${step.action.type}: ${outcome.message ?? outcome.status}`,
      );
    }
  }
}

async function performStep(
  session: AdapterSession,
  step: Step,
  index: number,
  assertions: AssertionResult[],
  target: TargetConfig,
): Promise<StepResult> {
  const started = Date.now();
  const outcome = await session.perform(step.action, { stepId: step.id, index });
  let status: StepStatus =
    outcome.status === 'ok' ? 'passed' : outcome.status === 'blocked' ? 'blocked' : 'error';
  let message = outcome.message;
  if (status === 'passed') {
    const failed = await checkAll(session, step.expect, 'step', step.id, assertions);
    await checkInvariants(session, target, 'after-step', step.id, assertions);
    if (failed) {
      status = 'failed';
      message = failed;
    }
  }
  return {
    stepId: step.id,
    index,
    status,
    durationMs: Date.now() - started,
    message,
    evidenceIds: outcome.evidence.map((e) => e.id),
  };
}

/** Check assertions, record the results, and return the first failure message if any. */
async function checkAll(
  session: AdapterSession,
  list: ReadonlyArray<Assertion>,
  scope: AssertionScope,
  stepId: string | undefined,
  into: AssertionResult[],
): Promise<string | undefined> {
  let firstFailure: string | undefined;
  for (const assertion of list) {
    let result: { passed: boolean; message?: string };
    try {
      result = await session.check(assertion);
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
): Promise<void> {
  const checks = target.invariants
    .filter((invariant) => invariant.when === when)
    .map((invariant) => ({
      ...invariant.check,
      description: invariant.description ?? invariant.id,
    }));
  await checkAll(session, checks, 'invariant', stepId, into);
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
