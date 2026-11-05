import type { Command } from 'commander';
import type { Cli } from '../context.js';
import { formatMutateResults } from '../format.js';
import { requireAgents, requireTargets, runJob } from '../jobs.js';
import { commaList, positiveInt } from '../options.js';
import { summarizeMutate, type TargetMutateResult } from '../views.js';

interface MutateCommandOptions {
  agent?: boolean;
  max?: number;
  operators?: string[];
}

export function registerMutate(program: Command, cli: Cli): void {
  program
    .command('mutate [target]')
    .description('Derive mutation variants of the base workflows (all targets when none is given)')
    .option('--agent', 'also ask the mutator agent for variants the operators cannot produce')
    .option('--max <n>', 'maximum variants per base workflow', positiveInt)
    .option(
      '--operators <ids>',
      'comma-separated operator ids, e.g. skip-step,repeat-step',
      commaList,
    )
    .action((targetId: string | undefined, options: MutateCommandOptions) =>
      cli.withEngine(async (engine) => {
        if (options.agent) requireAgents(engine, 'mutate --agent');
        const targets = requireTargets(engine, targetId ? [targetId] : undefined);
        const results = cli.completed(
          await runJob(
            engine,
            {
              kind: 'mutate',
              params: { targets: targets.map((t) => t.id), ...options },
              work: async (job) => {
                const done: TargetMutateResult[] = [];
                for (const target of targets) {
                  if (job.signal.aborted) break;
                  const result = await engine.mutate(target.id, {
                    agent: options.agent,
                    maxVariantsPerWorkflow: options.max,
                    operators: options.operators,
                    jobId: job.job.id,
                    signal: job.signal,
                    onEvent: cli.onAgentEvent,
                  });
                  done.push({ targetId: target.id, result });
                }
                return done;
              },
              summarize: summarizeMutate,
            },
            cli.signal,
          ),
        );
        cli.output.out(formatMutateResults(results));
      }),
    );
}
