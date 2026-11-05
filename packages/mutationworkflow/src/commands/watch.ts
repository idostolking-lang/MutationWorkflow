import type { Command } from 'commander';
import type { Cli } from '../context.js';
import { formatDuration } from '../format.js';
import { requireTargets, runJob } from '../jobs.js';
import { positiveInt } from '../options.js';

export function registerWatch(program: Command, cli: Cli): void {
  program
    .command('watch [targets...]')
    .description('Continuous mode: replay, mutate and periodically explore until Ctrl+C')
    .option('--max-cycles <n>', 'stop after this many cycles', positiveInt)
    .action((targetIds: string[], options: { maxCycles?: number }) =>
      cli.withEngine(async (engine) => {
        const ids = requireTargets(engine, targetIds).map((t) => t.id);
        cli.interruptExpected = true;
        cli.output.err(`Watching ${ids.join(', ')}. Press Ctrl+C to stop.`);
        const { result } = await runJob(
          engine,
          {
            kind: 'watch',
            params: { targets: ids, maxCycles: options.maxCycles },
            work: (job) =>
              engine.watch({
                targetIds: ids,
                maxCycles: options.maxCycles,
                signal: job.signal,
                jobId: job.job.id,
                onEvent: cli.onAgentEvent,
                onCycle: (cycle, summary, error) => {
                  if (!summary) {
                    cli.output.out(`cycle ${cycle} failed: ${error ?? 'unknown error'}`);
                    return;
                  }
                  const s = summary.stats;
                  cli.output.out(
                    `cycle ${cycle}: ${s.total} runs (${s.passed} passed, ${s.failed} failed, ${s.blocked} blocked, ${s.error} error), ${summary.findings.length} finding(s) touched, ${formatDuration(summary.durationMs)}`,
                  );
                  void job.progress(`Cycle ${cycle} done`, cycle, options.maxCycles);
                },
              }),
            summarize: (value) => value,
          },
          cli.signal,
        );
        cli.output.err(`Stopped after ${result?.cycles ?? 0} cycle(s).`);
      }),
    );
}
