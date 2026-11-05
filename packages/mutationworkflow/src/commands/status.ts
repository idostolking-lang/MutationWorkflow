import type { Command } from 'commander';
import type { Cli } from '../context.js';
import { formatStatus } from '../format.js';

export function registerStatus(program: Command, cli: Cli): void {
  program
    .command('status')
    .description('Targets, workflows, runs, open findings, questions, agents and model usage')
    .option('--json', 'print JSON')
    .action((options: { json?: boolean }) =>
      cli.withEngine(
        async (engine) => {
          const status = await engine.status();
          if (options.json) cli.output.json(status);
          else cli.output.out(formatStatus(status));
        },
        { allowMissingConfig: true },
      ),
    );
}
