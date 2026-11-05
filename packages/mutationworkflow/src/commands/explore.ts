import type { Command } from 'commander';
import type { Cli } from '../context.js';
import { formatExploreResults } from '../format.js';
import { requireAgents, requireTargets, runJob } from '../jobs.js';
import { commaList, positiveInt } from '../options.js';
import { summarizeExplore, type TargetExploreResult } from '../views.js';

interface ExploreCommandOptions {
  focus?: string[];
  max?: number;
  explorers?: number;
}

export function registerExplore(program: Command, cli: Cli): void {
  program
    .command('explore [target]')
    .description('Discover new workflows with explorer agents (all targets when none is given)')
    .option('--focus <areas>', 'comma-separated areas or features to prioritise', commaList)
    .option('--max <n>', 'maximum new workflows per target', positiveInt)
    .option('--explorers <n>', 'parallel explorer agents', positiveInt)
    .action((targetId: string | undefined, options: ExploreCommandOptions) =>
      cli.withEngine(async (engine) => {
        requireAgents(engine, 'explore');
        const targets = requireTargets(engine, targetId ? [targetId] : undefined);
        const results = cli.completed(
          await runJob(
            engine,
            {
              kind: 'explore',
              params: { targets: targets.map((t) => t.id), ...options },
              work: async (job) => {
                const done: TargetExploreResult[] = [];
                for (const target of targets) {
                  if (job.signal.aborted) break;
                  await job.progress(`Exploring ${target.id}`);
                  const result = await engine.explore(target.id, {
                    focus: options.focus,
                    maxWorkflows: options.max,
                    explorers: options.explorers,
                    jobId: job.job.id,
                    signal: job.signal,
                    onEvent: cli.onAgentEvent,
                  });
                  done.push({ targetId: target.id, result });
                }
                return done;
              },
              summarize: summarizeExplore,
            },
            cli.signal,
          ),
        );
        cli.output.out(formatExploreResults(results));
        cli.output.err('Next: "mw mutate" to derive variants, then "mw run".');
      }),
    );
}
