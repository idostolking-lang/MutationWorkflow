export type ErrorCode =
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_INVALID'
  | 'ADAPTER_NOT_FOUND'
  | 'TARGET_NOT_FOUND'
  | 'WORKFLOW_NOT_FOUND'
  | 'ENVIRONMENT_FAILED'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'BUDGET_EXCEEDED'
  | 'AGENT_FAILED'
  | 'INVALID_INPUT'
  | 'GIT_UNAVAILABLE'
  | 'NOT_FOUND';

/** Error with a stable code so callers (CLI, MCP) can map it to a message without parsing text. */
export class MutationWorkflowError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MutationWorkflowError';
    this.details = options?.details;
  }

  readonly details: Record<string, unknown> | undefined;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
