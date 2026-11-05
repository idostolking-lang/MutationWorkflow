import type { AgentEvent, Engine, LogLevel, ModelProvider, Store } from '@mutationworkflow/core';
import type { Command } from 'commander';
import { openEngine, resolveProjectDir } from './engine-factory.js';
import { CliExit, ExitCode } from './errors.js';
import { formatAgentEvent } from './format.js';
import type { JobOutcome } from './jobs.js';
import type { Output } from './output.js';

/** Options every command accepts. */
export interface GlobalOptions {
  cwd?: string;
  config?: string;
  logLevel: LogLevel;
}

/** Test seams for engine creation. */
export interface EngineOverrides {
  providers?: Map<string, ModelProvider>;
  store?: Store;
}

/** Shared state of one CLI invocation, handed to every command. */
export class Cli {
  /** Set by commands that end with a non-zero code without throwing. */
  exitCode = 0;
  /** Set by long-running commands (watch, schedule) for which Ctrl+C is the normal way out. */
  interruptExpected = false;

  constructor(
    readonly program: Command,
    readonly output: Output,
    /** Aborted on SIGINT or SIGTERM. */
    readonly signal: AbortSignal,
    readonly env: NodeJS.ProcessEnv = process.env,
    private readonly overrides: EngineOverrides = {},
  ) {}

  globals(): GlobalOptions {
    return this.program.opts<GlobalOptions>();
  }

  /** The project root from `--cwd`, `MW_PROJECT_DIR` or the working directory. */
  projectDir(): string {
    return resolveProjectDir({ cwd: this.globals().cwd, env: this.env });
  }

  /** Open the engine, run `fn`, and always close the engine (stopping adapters). */
  async withEngine<T>(
    fn: (engine: Engine) => Promise<T>,
    options: { allowMissingConfig?: boolean } = {},
  ): Promise<T> {
    const engine = await this.openEngine(options);
    try {
      return await fn(engine);
    } finally {
      await engine.close();
    }
  }

  openEngine(options: { allowMissingConfig?: boolean } = {}): Promise<Engine> {
    const globals = this.globals();
    return openEngine({
      cwd: this.projectDir(),
      configPath: globals.config,
      allowMissing: options.allowMissingConfig,
      logLevel: globals.logLevel,
      env: this.env,
      ...this.overrides,
    });
  }

  /** The job's result, or exit as interrupted when it was cancelled before producing one. */
  completed<T>(outcome: JobOutcome<T>): T {
    if (outcome.result === undefined) {
      throw new CliExit(ExitCode.interrupted, `Job ${outcome.job.id} ${outcome.job.status}.`);
    }
    return outcome.result;
  }

  /** Agent progress as single lines on stderr (skipped when logs are silenced). */
  readonly onAgentEvent = (event: AgentEvent): void => {
    const level = this.globals().logLevel;
    if (level === 'error' || level === 'silent') return;
    const line = formatAgentEvent(event);
    if (line) this.output.err(line);
  };
}
