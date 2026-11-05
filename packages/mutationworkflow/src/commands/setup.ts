import type { Command } from 'commander';
import type { Cli } from '../context.js';
import { formatSetupResult } from '../format.js';
import { requireAgents, runJob } from '../jobs.js';
import { summarizeSetup } from '../views.js';

export function registerSetup(program: Command, cli: Cli): void {
  program
    .command('setup')
    .description(
      'Let the inspector agent study the repository and write the config and seed workflows',
    )
    .option('--no-validate', 'do not start each proposed environment to check its start command')
    .option('--name <name>', 'project name (default: the directory name)')
    .action((options: { validate: boolean; name?: string }) =>
      cli.withEngine(
        async (engine) => {
          requireAgents(engine, 'setup');
          const result = cli.completed(
            await runJob(
              engine,
              {
                kind: 'setup',
                params: { validate: options.validate, projectName: options.name },
                work: (job) =>
                  engine.setup({
                    projectName: options.name,
                    validate: options.validate,
                    jobId: job.job.id,
                    signal: job.signal,
                    onEvent: cli.onAgentEvent,
                  }),
                summarize: summarizeSetup,
              },
              cli.signal,
            ),
          );
          cli.output.out(formatSetupResult(result));
        },
        { allowMissingConfig: true },
      ),
    );
}
