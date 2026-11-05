import { MutationWorkflowError } from '@mutationworkflow/core';
import type { Command } from 'commander';
import type { Cli } from '../context.js';
import { formatJobDetail, formatJobs } from '../format.js';
import { positiveInt } from '../options.js';

export function registerJobs(program: Command, cli: Cli): void {
  program
    .command('jobs')
    .description('Recent jobs (setup, explore, mutate, run, triage, watch), newest first')
    .option('--limit <n>', 'maximum number of jobs', positiveInt, 20)
    .option('--json', 'print JSON')
    .action((options: { limit: number; json?: boolean }) =>
      cli.withEngine(async (engine) => {
        const jobs = await engine.jobs.list({ limit: options.limit });
        if (options.json) cli.output.json(jobs);
        else cli.output.out(formatJobs(jobs));
      }),
    );

  program
    .command('job <id>')
    .description('Show a job with its progress, parameters and result')
    .option('--json', 'print JSON')
    .action((id: string, options: { json?: boolean }) =>
      cli.withEngine(async (engine) => {
        const job = await engine.jobs.get(id);
        if (!job) throw new MutationWorkflowError('NOT_FOUND', `No job with id ${id}`);
        if (options.json) cli.output.json(job);
        else cli.output.out(formatJobDetail(job));
      }),
    );
}
