import type { Command } from 'commander';
import type { Cli } from '../context.js';
import { formatImpact } from '../format.js';
import { collect } from '../options.js';
import { impactView } from '../views.js';

interface ImpactOptions {
  file: string[];
  json?: boolean;
}

export function registerImpact(program: Command, cli: Cli): void {
  program
    .command('impact [range]')
    .description(
      'Show which workflows a change affects, from what earlier runs learned (nothing runs)',
    )
    .option(
      '--file <path>',
      'a changed file, relative to the project root (repeatable; wins over the range)',
      collect,
      [],
    )
    .option('--json', 'print JSON')
    .addHelpText(
      'after',
      "\nWithout a range or --file, the change is the last run's commit..HEAD (or HEAD~1..HEAD).",
    )
    .action((range: string | undefined, options: ImpactOptions) =>
      cli.withEngine(async (engine) => {
        const report = await engine.impact({
          ...(options.file.length > 0 ? { files: options.file } : {}),
          ...(range ? { range } : {}),
        });
        if (options.json) cli.output.json(impactView(report));
        else cli.output.out(formatImpact(report));
      }),
    );
}
