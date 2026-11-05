import type { Adapter, AdapterSession } from '../adapter/types.js';
import { normalizeSteps, type TargetConfig, type Workflow } from '../schema/index.js';
import { errorMessage, MutationWorkflowError } from '../util/errors.js';

/**
 * Perform an identity's setup steps (log in, choose a tenant) in a fresh session. Throws when
 * the identity is unknown or a setup step cannot be performed: that is an infrastructure
 * problem, not a finding about the application.
 */
export async function applyIdentity(
  session: AdapterSession,
  target: TargetConfig,
  identityId: string | undefined,
): Promise<void> {
  if (!identityId) return;
  const identity = target.identities.find((candidate) => candidate.id === identityId);
  if (!identity) {
    throw new MutationWorkflowError(
      'INVALID_INPUT',
      `Identity "${identityId}" is not defined for target "${target.id}"`,
    );
  }
  for (const step of normalizeSteps(identity.steps)) {
    const outcome = await session.perform(step.action, { stepId: `identity:${step.id}` });
    if (outcome.status !== 'ok') {
      throw new MutationWorkflowError(
        'ENVIRONMENT_FAILED',
        `Identity "${identity.id}" setup failed at ${step.action.type}: ${outcome.message ?? outcome.status}`,
      );
    }
  }
}

/** Check every action and assertion of a workflow against the adapter's vocabulary. */
export function validateWorkflow(
  adapter: Adapter,
  workflow: Pick<Workflow, 'steps' | 'expect'>,
): void {
  for (const step of workflow.steps) {
    adapter.validateAction(step.action);
    for (const assertion of step.expect) adapter.validateAssertion(assertion);
  }
  for (const assertion of workflow.expect) adapter.validateAssertion(assertion);
}

/** Same as {@link validateWorkflow} but returns the problem instead of throwing. */
export function workflowProblem(
  adapter: Adapter,
  workflow: Pick<Workflow, 'steps' | 'expect'>,
): string | undefined {
  try {
    validateWorkflow(adapter, workflow);
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}
