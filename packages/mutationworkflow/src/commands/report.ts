import type { Command } from 'commander';
import type { Cli } from '../context.js';
import { positiveInt } from '../options.js';
import { writeLatestReport } from '../report.js';

export function registerReport(program: Command, cli: Cli): void {
  program
    .command('report')
    .description('Write a Markdown report of the latest runs and print its path')
    .option('--limit <n>', 'number of latest runs to include', positiveInt, 50)
    .action((options: { limit: number }) =>
      cli.withEngine(async (engine) => {
        const report = await writeLatestReport(engine, options.limit);
        cli.output.out(report.path ?? report.markdown);
      }),
    );
}
