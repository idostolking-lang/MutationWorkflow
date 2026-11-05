import type { Command } from 'commander';
import type { Cli } from '../context.js';
import { formatSearch } from '../format.js';
import { positiveInt } from '../options.js';

export function registerSearch(program: Command, cli: Cli): void {
  program
    .command('search <query>')
    .description('Full-text search across workflows and findings')
    .option('--target <id>', 'restrict to one target')
    .option('--limit <n>', 'maximum results per kind', positiveInt, 20)
    .option('--json', 'print JSON')
    .action((query: string, options: { target?: string; limit: number; json?: boolean }) =>
      cli.withEngine(async (engine) => {
        const result = await engine.search(query, {
          targetId: options.target,
          limit: options.limit,
        });
        if (options.json) cli.output.json(result);
        else cli.output.out(formatSearch(result));
      }),
    );
}
