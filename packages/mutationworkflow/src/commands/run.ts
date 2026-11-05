import type { RunSummary, Severity } from '@mutationworkflow/core';
import type { Command } from 'commander';
import type { Cli } from '../context.js';
import { ExitCode } from '../errors.js';
import { formatRunLine, formatRunSummary } from '../format.js';
import { requireTargets, runJob } from '../jobs.js';
import { collect, oneOf, positiveInt } from '../options.js';
import { findingsAtOrAbove, summarizeRun } from '../views.js';

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

interface RunCommandOptions {
  workflow: string[];
  include: 'all' | 'base' | 'mutations';
  parallel?: number;
  triage: boolean;
  report: boolean;
  trigger: 'manual' | 'push' | 'schedule';
  failOn?: Severity;
}

export function registerRun(program: Command, cli: Cli): void {
  program
    .command('run [targets...]')
    .description('Replay workflows in a fresh environment, record findings, triage and report')
    .option('--workflow <id>', 'only this workflow (repeatable)', collect, [])
    .option(
      '--include <which>',
      'all, base or mutations',
      oneOf(['all', 'base', 'mutations'] as const),
      'all',
    )
    .option('--parallel <n>', 'concurrent workflow replays', positiveInt)
    .option('--no-triage', 'do not ask the triager agent to review new findings')
    .option('--no-report', 'do not write a Markdown report')
    .option(
      '--trigger <trigger>',
      'recorded on each run: manual, push or schedule',
      oneOf(['manual', 'push', 'schedule'] as const),
      'manual',
    )
    .option(
      '--fail-on <severity>',
      'exit with code 2 when a finding at or above this severity was created or updated',
      oneOf(SEVERITIES),
    )
    .action((targetIds: string[], options: RunCommandOptions) =>
      cli.withEngine(async (engine) => {
        const targets = requireTargets(engine, targetIds);
        const summary: RunSummary = cli.completed(
          await runJob(
            engine,
            {
              kind: 'run',
              params: { targets: targets.map((t) => t.id), ...options },
              work: (job) =>
                engine.run({
                  targetIds: targets.map((t) => t.id),
                  workflowIds: options.workflow.length > 0 ? options.workflow : undefined,
                  include: options.include,
                  parallel: options.parallel,
                  triage: options.triage,
                  report: options.report,
                  trigger: options.trigger,
                  jobId: job.job.id,
                  signal: job.signal,
                  onEvent: cli.onAgentEvent,
                  onRun: (run, workflow, done, total) =>
                    cli.output.out(formatRunLine(run, workflow, done, total, cli.output.colors)),
                }),
              summarize: summarizeRun,
            },
            cli.signal,
          ),
        );
        cli.output.out('');
        cli.output.out(formatRunSummary(summary));
        if (options.failOn) {
          const over = findingsAtOrAbove(summary.findings, options.failOn);
          if (over.length > 0) {
            cli.output.err(
              `${over.length} finding(s) at or above "${options.failOn}"; exiting with code ${ExitCode.threshold}.`,
            );
            cli.exitCode = ExitCode.threshold;
          }
        }
      }),
    );
}
