import {
  type WorkflowOrigin,
  WorkflowOriginSchema,
  type WorkflowStatus,
  WorkflowStatusSchema,
} from '@mutationworkflow/core';
import type { Command } from 'commander';
import type { Cli } from '../context.js';
import { getWorkflowDetail, listWorkflows } from '../details.js';
import { formatWorkflowDetail, formatWorkflows } from '../format.js';
import { oneOf, positiveInt } from '../options.js';

interface WorkflowsOptions {
  origin?: WorkflowOrigin;
  status?: WorkflowStatus;
  base?: boolean;
  mutations?: boolean;
  limit: number;
  json?: boolean;
}

export function registerWorkflows(program: Command, cli: Cli): void {
  program
    .command('workflows [target]')
    .description('List workflows in memory')
    .option(
      '--origin <origin>',
      WorkflowOriginSchema.options.join(', '),
      oneOf(WorkflowOriginSchema.options),
    )
    .option(
      '--status <status>',
      WorkflowStatusSchema.options.join(', '),
      oneOf(WorkflowStatusSchema.options),
    )
    .option('--base', 'base workflows only')
    .option('--mutations', 'mutation variants only')
    .option('--limit <n>', 'maximum number of workflows', positiveInt, 100)
    .option('--json', 'print JSON')
    .action((targetId: string | undefined, options: WorkflowsOptions) =>
      cli.withEngine(async (engine) => {
        if (targetId) engine.target(targetId);
        const workflows = await listWorkflows(engine, {
          targetId,
          origin: options.origin,
          status: options.status,
          base: options.base ? true : options.mutations ? false : undefined,
          limit: options.limit,
        });
        if (options.json) cli.output.json(workflows);
        else cli.output.out(formatWorkflows(workflows));
      }),
    );

  program
    .command('workflow <id>')
    .description('Show a workflow with its steps and latest run')
    .option('--json', 'print JSON')
    .action((id: string, options: { json?: boolean }) =>
      cli.withEngine(async (engine) => {
        const detail = await getWorkflowDetail(engine, id);
        if (options.json) cli.output.json(detail);
        else cli.output.out(formatWorkflowDetail(detail));
      }),
    );
}
