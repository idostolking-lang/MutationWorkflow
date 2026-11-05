import type { LogLevel } from '@mutationworkflow/core';
import { Command, CommanderError, Option } from 'commander';
import { registerDoctor } from './commands/doctor.js';
import { registerExplore } from './commands/explore.js';
import { registerFindings } from './commands/findings.js';
import { registerInit } from './commands/init.js';
import { registerJobs } from './commands/jobs.js';
import { registerMcp } from './commands/mcp.js';
import { registerMutate } from './commands/mutate.js';
import { registerQuestions } from './commands/questions.js';
import { registerReport } from './commands/report.js';
import { registerRun } from './commands/run.js';
import { registerSchedule } from './commands/schedule.js';
import { registerSearch } from './commands/search.js';
import { registerSetup } from './commands/setup.js';
import { registerStatus } from './commands/status.js';
import { registerTriage } from './commands/triage.js';
import { registerWatch } from './commands/watch.js';
import { registerWorkflows } from './commands/workflows.js';
import { Cli, type EngineOverrides } from './context.js';
import { PROJECT_DIR_ENV } from './engine-factory.js';
import { CliExit, describeError, ExitCode, exitCodeFor } from './errors.js';
import { createOutput, type Output } from './output.js';
import { VERSION } from './version.js';

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error', 'silent'];

const HELP_FOOTER = `
Exit codes: 0 success, 1 error, 2 --fail-on threshold met, 3 no config found, 130 interrupted.
Environment: ${PROJECT_DIR_ENV} (project root), MW_LOG_LEVEL, ANTHROPIC_API_KEY, OPENAI_API_KEY.
Docs: https://github.com/idostolking-lang/MutationWorkflow/blob/main/docs/cli.md`;

const COMMANDS = [
  registerInit,
  registerSetup,
  registerExplore,
  registerMutate,
  registerRun,
  registerTriage,
  registerWatch,
  registerSchedule,
  registerStatus,
  registerFindings,
  registerWorkflows,
  registerQuestions,
  registerSearch,
  registerJobs,
  registerReport,
  registerDoctor,
  registerMcp,
];

/** Build the commander program, with every command registered against the returned context. */
export function createProgram(createCli: (program: Command) => Cli): {
  program: Command;
  cli: Cli;
} {
  const program = new Command('mw');
  const cli = createCli(program);
  program
    .description(
      'Discover user workflows with AI agents, mutate them, and replay them to find sequence bugs.',
    )
    .version(VERSION, '-V, --version')
    .option(
      '-C, --cwd <dir>',
      `project root (default: $${PROJECT_DIR_ENV} or the current directory)`,
    )
    .option(
      '-c, --config <path>',
      'config file (default: mutationworkflow.config.yaml, searched upwards)',
    )
    .addOption(
      new Option('--log-level <level>', 'log verbosity on stderr (or MW_LOG_LEVEL)')
        .choices(LOG_LEVELS)
        .default(logLevelFromEnv(cli.env)),
    )
    .option('-v, --verbose', 'same as --log-level debug')
    .option('-q, --quiet', 'same as --log-level error')
    .on('option:verbose', () => program.setOptionValue('logLevel', 'debug'))
    .on('option:quiet', () => program.setOptionValue('logLevel', 'error'))
    .showHelpAfterError('(run "mw help" for usage)')
    .addHelpText('after', HELP_FOOTER)
    .configureOutput({
      writeOut: (text) => cli.output.out(text.trimEnd()),
      writeErr: (text) => cli.output.err(text.trimEnd()),
    });

  for (const register of COMMANDS) register(program, cli);
  program.exitOverride();
  for (const command of program.commands) command.exitOverride();
  return { program, cli };
}

function logLevelFromEnv(env: NodeJS.ProcessEnv): LogLevel {
  const value = env['MW_LOG_LEVEL'];
  return LOG_LEVELS.find((level) => level === value) ?? 'info';
}

export interface MainOptions {
  output?: Output;
  env?: NodeJS.ProcessEnv;
  /** Install SIGINT/SIGTERM handlers (default true). */
  handleSignals?: boolean;
  /** Test seams for engine creation. */
  engine?: EngineOverrides;
}

/**
 * Run the CLI with `argv` (as in `process.argv`) and resolve to the exit code. SIGINT and
 * SIGTERM abort the running operation so environments are stopped before exiting; a second
 * signal exits immediately.
 */
export async function main(argv: string[], options: MainOptions = {}): Promise<number> {
  const output = options.output ?? createOutput();
  const controller = new AbortController();
  const { program, cli } = createProgram(
    (p) => new Cli(p, output, controller.signal, options.env ?? process.env, options.engine),
  );

  const onSignal = (signal: NodeJS.Signals) => {
    if (controller.signal.aborted) {
      output.err(`Received ${signal} again; exiting now.`);
      process.exit(ExitCode.interrupted);
    }
    if (!cli.interruptExpected) {
      output.err(`Received ${signal}; stopping (press Ctrl+C again to force)…`);
    }
    controller.abort();
  };
  if (options.handleSignals !== false) {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }

  try {
    await program.parseAsync(argv);
    if (controller.signal.aborted && !cli.interruptExpected && cli.exitCode === ExitCode.ok) {
      return ExitCode.interrupted;
    }
    return cli.exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help and version end with code 0; usage errors were already printed by commander.
      return error.exitCode === 0 ? ExitCode.ok : ExitCode.error;
    }
    if (!(error instanceof CliExit) || error.message) {
      output.err(`Error: ${describeError(error, 'cli')}`);
    }
    if (error instanceof Error && error.stack && cli.globals().logLevel === 'debug') {
      output.err(error.stack);
    }
    return exitCodeFor(error);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
