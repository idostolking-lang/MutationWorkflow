import { errorMessage, MutationWorkflowError } from '@mutationworkflow/core';

/** Process exit codes of the `mw` command. */
export const ExitCode = {
  ok: 0,
  error: 1,
  /** A finding at or above the `--fail-on` severity was created or updated. */
  threshold: 2,
  /** No config file was found. */
  noConfig: 3,
  /** Stopped by SIGINT or SIGTERM. */
  interrupted: 130,
} as const;

/** Thrown by commands to end with a specific exit code and an optional message on stderr. */
export class CliExit extends Error {
  constructor(
    readonly exitCode: number,
    message = '',
  ) {
    super(message);
    this.name = 'CliExit';
  }
}

/** Where an error is shown; hints differ between a terminal and an MCP client. */
export type Surface = 'cli' | 'mcp';

const MCP_KEY_HINT =
  'Pass a key to the MCP server, e.g. `claude mcp add mutationworkflow -e ANTHROPIC_API_KEY=... -- npx -y mutationworkflow mcp` (or set OPENAI_API_KEY), then restart the server.';
const CLI_KEY_HINT =
  'Install Claude Code or Codex, export ANTHROPIC_API_KEY or OPENAI_API_KEY, or configure `providers` in the config, and retry.';

/** A friendly, actionable message for any error, keyed on MutationWorkflowError codes. */
export function describeError(error: unknown, surface: Surface): string {
  if (!(error instanceof MutationWorkflowError)) return errorMessage(error);
  switch (error.code) {
    case 'CONFIG_NOT_FOUND':
      return surface === 'mcp'
        ? `${error.message} Call mw_setup to let the agents write one, or run \`npx mutationworkflow init\` in the project. If the server runs outside the project, set MW_PROJECT_DIR.`
        : `${error.message} Use --cwd <dir> to point at another project.`;
    case 'PROVIDER_NOT_CONFIGURED':
      return `${error.message}\n${surface === 'mcp' ? MCP_KEY_HINT : CLI_KEY_HINT}`;
    case 'CONFIG_INVALID':
      return `The configuration is invalid. ${error.message}`;
    case 'ADAPTER_NOT_FOUND':
      return `${error.message}\nBuilt-in kinds are "web" and "cli"; other adapters must be installed in the project.`;
    case 'ENVIRONMENT_FAILED':
      return `The application environment could not be started. ${error.message}`;
    case 'BUDGET_EXCEEDED':
      return `The model budget for this job was exhausted. ${error.message}`;
    default:
      return error.message;
  }
}

/** Exit code for an error that escaped a command. */
export function exitCodeFor(error: unknown): number {
  if (error instanceof CliExit) return error.exitCode;
  if (error instanceof MutationWorkflowError && error.code === 'CONFIG_NOT_FOUND') {
    return ExitCode.noConfig;
  }
  return ExitCode.error;
}
