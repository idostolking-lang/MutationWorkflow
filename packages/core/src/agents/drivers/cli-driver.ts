import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import type { Logger } from '../../util/logger.js';
import { tail } from '../../util/text.js';
import type { AgentDriveRequest, AgentDriveResult, AgentDriver, TokenUsage } from '../provider.js';
import { serveTools } from './tool-server.js';

export interface CliDriverOptions {
  id: string;
  /** Executable name or path. */
  command: string;
  /** Extra arguments placed before the driver's own. */
  args?: string[];
  /** Working directory for the agent process; defaults to the current one. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** What a concrete driver tells the base class to run for one task. */
export interface CliInvocation {
  args: string[];
  /** Text written to the process's stdin, when the tool reads its prompt that way. */
  stdin?: string;
  /** Files created for this run, removed afterwards. */
  tempFiles?: string[];
}

export interface CliOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  aborted: boolean;
}

/** Variables that would make a coding agent believe it runs nested inside itself. */
const ENV_TO_STRIP = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'];

/**
 * Base for drivers that run a coding agent's command line as a subprocess: start a tool server,
 * launch the process pointing at it, collect its output, parse the final answer. The agent uses
 * the user's own installation and subscription; MutationWorkflow never sees a credential.
 */
export abstract class CliAgentDriver implements AgentDriver {
  readonly kind = 'driver';
  abstract readonly type: string;
  readonly id: string;

  constructor(protected readonly options: CliDriverOptions) {
    this.id = options.id;
  }

  async drive(request: AgentDriveRequest): Promise<AgentDriveResult> {
    const server = await serveTools(request.tools, request.toolContext, {
      name: 'mw',
      logger: request.logger,
    });
    let invocation: CliInvocation | undefined;
    try {
      invocation = await this.invocation(request, server.url);
      const outcome = await this.spawn(invocation, request.signal, request.logger);
      if (outcome.aborted) {
        return {
          text: '',
          usage: zeroUsage(),
          turns: 0,
          stoppedBecause: 'aborted',
          error: 'Aborted',
        };
      }
      return await this.parse(outcome, request, invocation);
    } catch (error) {
      return {
        text: '',
        usage: zeroUsage(),
        turns: 0,
        stoppedBecause: 'error',
        error: describeSpawnError(error, this.options.command),
      };
    } finally {
      await server.close();
      await Promise.all(
        (invocation?.tempFiles ?? []).map((file) =>
          rm(file, { force: true }).catch(() => undefined),
        ),
      );
    }
  }

  /** Build the command line for one task. */
  protected abstract invocation(
    request: AgentDriveRequest,
    toolServerUrl: string,
  ): Promise<CliInvocation>;

  /** Turn the finished process into a result. */
  protected abstract parse(
    outcome: CliOutcome,
    request: AgentDriveRequest,
    invocation: CliInvocation,
  ): Promise<AgentDriveResult>;

  private spawn(
    invocation: CliInvocation,
    signal: AbortSignal | undefined,
    logger: Logger,
  ): Promise<CliOutcome> {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.options.env };
    for (const name of ENV_TO_STRIP) delete env[name];
    const args = [...(this.options.args ?? []), ...invocation.args];
    logger.debug(`Launching ${this.options.command} with ${args.length} argument(s)`);
    return new Promise<CliOutcome>((resolve, reject) => {
      const child = spawn(this.options.command, args, {
        cwd: this.options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let aborted = false;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      const onAbort = () => {
        aborted = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      });
      child.on('close', (code, exitSignal) => {
        signal?.removeEventListener('abort', onAbort);
        resolve({ stdout, stderr, code, signal: exitSignal, aborted });
      });
      if (invocation.stdin !== undefined) child.stdin.write(invocation.stdin);
      child.stdin.end();
    });
  }
}

export function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function describeSpawnError(error: unknown, command: string): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return `"${command}" is not installed or not on PATH. Install it, or point the provider's "command" option at it.`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The last lines of a failed process's output, for error messages. */
export function outputTail(outcome: CliOutcome): string {
  return tail(`${outcome.stderr}\n${outcome.stdout}`.trim(), 1_500);
}
