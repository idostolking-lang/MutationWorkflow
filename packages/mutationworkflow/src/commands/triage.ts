import type { Command } from 'commander';
import type { Cli } from '../context.js';
import { formatFindings } from '../format.js';
import { requireAgents, requireTargets, runJob } from '../jobs.js';
import { summarizeTriage } from '../views.js';

export function registerTriage(program: Command, cli: Cli): void {
  program
    .command('triage [target]')
    .description('Let the triager agent review open findings that are waiting for triage')
    .option('--include-skipped', 'also review findings skipped earlier (e.g. run without a key)')
    .action((targetId: string | undefined, options: { includeSkipped?: boolean }) =>
      cli.withEngine(async (engine) => {
        requireAgents(engine, 'triage');
        const targetIds = requireTargets(engine, targetId ? [targetId] : undefined).map(
          (t) => t.id,
        );
        const findings = cli.completed(
          await runJob(
            engine,
            {
              kind: 'triage',
              params: { targets: targetIds, includeSkipped: options.includeSkipped === true },
              work: (job) =>
                engine.triage({
                  targetIds,
                  includeSkipped: options.includeSkipped,
                  jobId: job.job.id,
                  signal: job.signal,
                  onEvent: cli.onAgentEvent,
                }),
              summarize: summarizeTriage,
            },
            cli.signal,
          ),
        );
        cli.output.out(
          findings.length === 0
            ? 'Nothing was waiting for triage.'
            : `Reviewed ${findings.length} finding(s):\n${formatFindings(findings)}`,
        );
      }),
    );
}
