import {
  type FindingStatus,
  FindingStatusSchema,
  type Severity,
  SeveritySchema,
} from '@mutationworkflow/core';
import type { Command } from 'commander';
import type { Cli } from '../context.js';
import { getFindingDetail } from '../details.js';
import { formatFindingDetail, formatFindings } from '../format.js';
import { oneOf, positiveInt } from '../options.js';

interface FindingsOptions {
  status?: FindingStatus;
  severity?: Severity;
  limit: number;
  json?: boolean;
}

interface FindingOptions {
  json?: boolean;
  status?: FindingStatus;
  note?: string;
}

export function registerFindings(program: Command, cli: Cli): void {
  program
    .command('findings [target]')
    .description('List findings, most recently seen first')
    .option(
      '--status <status>',
      'open, confirmed, fixed or dismissed',
      oneOf(FindingStatusSchema.options),
    )
    .option('--severity <severity>', 'critical, high, medium or low', oneOf(SeveritySchema.options))
    .option('--limit <n>', 'maximum number of findings', positiveInt, 50)
    .option('--json', 'print JSON')
    .action((targetId: string | undefined, options: FindingsOptions) =>
      cli.withEngine(async (engine) => {
        if (targetId) engine.target(targetId);
        const findings = await engine.store.findings.list({
          targetId,
          status: options.status,
          severity: options.severity,
          limit: options.limit,
        });
        if (options.json) cli.output.json(findings);
        else cli.output.out(formatFindings(findings));
      }),
    );

  program
    .command('finding <id>')
    .description('Show a finding with reproduction steps and evidence; optionally update it')
    .option(
      '--status <status>',
      'set the status: open, confirmed, fixed or dismissed',
      oneOf(FindingStatusSchema.options),
    )
    .option('--note <text>', 'set the notes')
    .option('--json', 'print JSON')
    .action((id: string, options: FindingOptions) =>
      cli.withEngine(async (engine) => {
        if (options.status || options.note !== undefined) {
          await engine.updateFinding(id, {
            ...(options.status ? { status: options.status } : {}),
            ...(options.note !== undefined ? { notes: options.note } : {}),
          });
        }
        const detail = await getFindingDetail(engine, id);
        if (options.json) cli.output.json(detail);
        else cli.output.out(formatFindingDetail(detail));
      }),
    );
}
