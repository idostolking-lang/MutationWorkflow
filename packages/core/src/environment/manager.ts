import type { Command, StartCommand, TargetConfig } from '../schema/target.js';
import { errorMessage, MutationWorkflowError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { Semaphore } from '../util/semaphore.js';
import {
  describeExit,
  OutputBuffer,
  type ShellProcess,
  settlesWithin,
  spawnShell,
  stopGroup,
} from './process.js';
import { urlReady, waitUntilReady } from './ready.js';

const LOG_LINES_IN_ERRORS = 40;
const DEFAULT_RESET_TIMEOUT_MS = 60_000;
const BASE_URL_PROBE_TIMEOUT_MS = 2_000;

/** The application environment for one target, as started by {@link EnvironmentManager}. */
export interface RunningEnvironment {
  target: TargetConfig;
  /** `target.options.baseUrl`, when the target has one. */
  baseUrl?: string;
  /** The most recent output of the start and reset commands. */
  readonly logs: string;
  /** Run the target's reset command to completion; a no-op when none is configured. */
  reset(): Promise<void>;
  /** Stop the start command and everything it spawned. Idempotent. */
  stop(): Promise<void>;
}

export interface EnvironmentManagerOptions {
  /** How long to wait for a busy target before failing (default 30 s). */
  lockTimeoutMs?: number;
  /** Project root; command working directories are resolved against it. */
  rootDir: string;
  logger: Logger;
}

/**
 * Starts the local environment a target describes, waits until it is ready, and resets and
 * stops it on request. MutationWorkflow only tests applications it started itself, or that the
 * operator runs on localhost.
 */
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

export class EnvironmentManager {
  private readonly logger: Logger;
  /** One environment per target at a time, so parallel jobs never fight over ports. */
  private readonly locks = new Map<string, Semaphore>();

  constructor(private readonly options: EnvironmentManagerOptions) {
    this.logger = options.logger.child('environment');
  }

  /**
   * Start `target.environment.start` (if configured) and wait for its ready check. Without a
   * start command, probes `target.options.baseUrl` once and only warns when it is unreachable.
   * @throws MutationWorkflowError with code `ENVIRONMENT_FAILED` when the app does not start.
   */
  async start(target: TargetConfig): Promise<RunningEnvironment> {
    const { baseUrl: configuredBaseUrl } = target.options;
    const baseUrl = typeof configuredBaseUrl === 'string' ? configuredBaseUrl : undefined;
    const output = new OutputBuffer();
    const { start } = target.environment;
    let release: () => void;
    try {
      release = await this.lockFor(target.id).acquire(
        this.options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      );
    } catch {
      throw new MutationWorkflowError(
        'ENVIRONMENT_FAILED',
        `Target "${target.id}" is busy: another run or exploration holds its environment. Close it or wait for it to finish.`,
      );
    }
    let proc: ShellProcess | undefined;
    try {
      proc = start ? await this.startProcess(target, start, output) : undefined;
      if (!proc && baseUrl !== undefined) await this.probe(target, baseUrl);
    } catch (error) {
      release();
      throw error;
    }

    let stopping: Promise<void> | undefined;
    const { rootDir } = this.options;
    const logger = this.logger;
    return {
      target,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      get logs() {
        return output.text;
      },
      reset: () => runReset(target, rootDir, output, logger),
      stop: () => {
        stopping ??= (
          proc && start
            ? stopGroup(proc, start.stopSignal, start.stopTimeoutMs).then(() =>
                logger.debug('Stopped environment', { target: target.id }),
              )
            : Promise.resolve()
        ).finally(release);
        return stopping;
      },
    };
  }

  private lockFor(targetId: string): Semaphore {
    let lock = this.locks.get(targetId);
    if (!lock) {
      lock = new Semaphore(1);
      this.locks.set(targetId, lock);
    }
    return lock;
  }

  private async startProcess(
    target: TargetConfig,
    start: StartCommand,
    output: OutputBuffer,
  ): Promise<ShellProcess> {
    this.logger.info('Starting environment', { target: target.id, command: start.command });
    const proc = spawnShell(start, this.options.rootDir, output);
    try {
      await waitUntilReady(start.ready, proc);
    } catch (error) {
      await stopGroup(proc, 'SIGKILL', 0);
      throw environmentError(
        `Environment for target "${target.id}" failed: ${errorMessage(error)}`,
        output,
        error,
      );
    }
    this.logger.info('Environment ready', { target: target.id });
    return proc;
  }

  private async probe(target: TargetConfig, baseUrl: string): Promise<void> {
    if (await urlReady(baseUrl, undefined, BASE_URL_PROBE_TIMEOUT_MS)) return;
    this.logger.warn(
      'Base URL is not reachable and no start command is configured; continuing in case it is started later',
      { target: target.id, baseUrl },
    );
  }
}

/** Run `target.environment.reset` through the shell; throws ENVIRONMENT_FAILED on failure. */
async function runReset(
  target: TargetConfig,
  rootDir: string,
  logs: OutputBuffer,
  logger: Logger,
): Promise<void> {
  const reset: Command | undefined = target.environment.reset;
  if (!reset) return;
  logger.debug('Resetting environment', { target: target.id, command: reset.command });
  const output = new OutputBuffer();
  const proc = spawnShell(reset, rootDir, output);
  const timeoutMs = reset.timeoutMs ?? DEFAULT_RESET_TIMEOUT_MS;
  const finished = await settlesWithin(proc.exited, timeoutMs);
  if (!finished) await stopGroup(proc, 'SIGKILL', 0);
  logs.append(output.text);
  const exit = await proc.exited;
  if (finished && exit.code === 0) return;
  const reason = finished ? describeExit(exit) : `did not finish within ${timeoutMs}ms`;
  throw environmentError(`Reset command for target "${target.id}" ${reason}`, output);
}

function environmentError(
  message: string,
  output: OutputBuffer,
  cause?: unknown,
): MutationWorkflowError {
  const lines = output.lastLines(LOG_LINES_IN_ERRORS);
  return new MutationWorkflowError(
    'ENVIRONMENT_FAILED',
    lines ? `${message}\n--- last output ---\n${lines}` : `${message} (no output)`,
    cause === undefined ? undefined : { cause },
  );
}

/** Start the environment for `target`, run `fn`, and always stop the environment afterwards. */
export async function withEnvironment<T>(
  manager: EnvironmentManager,
  target: TargetConfig,
  fn: (env: RunningEnvironment) => Promise<T>,
): Promise<T> {
  const env = await manager.start(target);
  try {
    return await fn(env);
  } finally {
    await env.stop();
  }
}
