import {
  type Engine,
  errorMessage,
  MutationWorkflowError,
  type ScheduleAction,
} from '@mutationworkflow/core';
import type { Command } from 'commander';
import { Cron } from 'croner';
import type { Cli } from '../context.js';
import { requireTargets, runJob } from '../jobs.js';
import { summarizeMutate, summarizeRun } from '../views.js';

interface CronEntry {
  expression: string;
  action: ScheduleAction;
  target?: string;
}

/**
 * Run one scheduled action. `cycle` explores (when a model provider is configured), mutates and
 * replays; the other actions do just that step.
 */
export async function runScheduledAction(
  engine: Engine,
  entry: CronEntry,
  signal: AbortSignal,
  log: (line: string) => void,
): Promise<void> {
  const targets = requireTargets(engine, entry.target ? [entry.target] : undefined);
  const ids = targets.map((t) => t.id);
  const explore = entry.action === 'explore' || (entry.action === 'cycle' && engine.agents.enabled);
  const mutate = entry.action === 'mutate' || entry.action === 'cycle';
  const replay = entry.action === 'run' || entry.action === 'cycle';

  await runJob(
    engine,
    {
      kind: entry.action === 'cycle' ? 'cycle' : entry.action,
      params: { schedule: entry.expression, targets: ids },
      work: async (job) => {
        const outcome: Record<string, unknown> = {};
        for (const id of explore ? ids : []) {
          if (job.signal.aborted) break;
          const result = await engine.explore(id, { jobId: job.job.id, signal: job.signal });
          log(`  explored ${id}: ${result.workflows.length} new workflow(s)`);
        }
        if (mutate && !job.signal.aborted) {
          const results = [];
          for (const id of ids) {
            results.push({ targetId: id, result: await engine.mutate(id, { jobId: job.job.id }) });
          }
          outcome['mutate'] = summarizeMutate(results);
          log(
            `  mutated: ${results.map((r) => `${r.targetId} +${r.result.created.length}`).join(', ')}`,
          );
        }
        if (replay && !job.signal.aborted) {
          const summary = await engine.run({
            targetIds: ids,
            trigger: 'schedule',
            jobId: job.job.id,
            signal: job.signal,
          });
          const s = summary.stats;
          log(
            `  ran ${s.total}: ${s.passed} passed, ${s.failed} failed, ${s.blocked} blocked, ${s.error} error; ${summary.findings.length} finding(s) touched`,
          );
          outcome['run'] = summarizeRun(summary);
        }
        return outcome;
      },
      summarize: (outcome) => outcome,
    },
    signal,
  );
}

export function registerSchedule(program: Command, cli: Cli): void {
  program
    .command('schedule')
    .description('Run the cron entries from schedule.cron in the config until Ctrl+C')
    .action(() =>
      cli.withEngine(async (engine) => {
        const entries = engine.config.schedule.cron;
        if (entries.length === 0) {
          throw new MutationWorkflowError(
            'CONFIG_INVALID',
            'No schedule.cron entries are configured, e.g.\nschedule:\n  cron:\n    - expression: "0 3 * * *"\n      action: cycle',
          );
        }
        for (const entry of entries) {
          if (entry.target) engine.target(entry.target);
        }
        cli.interruptExpected = true;
        // One tick at a time: environments of different entries would compete for ports.
        let current: Promise<void> | undefined;
        const tick = async (entry: CronEntry) => {
          const label = `${entry.action}${entry.target ? ` ${entry.target}` : ''} (${entry.expression})`;
          const now = new Date().toISOString();
          if (current) {
            cli.output.err(`${now} skipped ${label}: the previous tick is still running`);
            return;
          }
          cli.output.out(`${now} ${label}`);
          current = runScheduledAction(engine, entry, cli.signal, (line) => cli.output.out(line))
            .catch((error: unknown) => cli.output.err(`  failed: ${errorMessage(error)}`))
            .finally(() => {
              current = undefined;
            });
          await current;
        };
        const jobs = entries.map((entry) => new Cron(entry.expression, () => tick(entry)));
        for (const [index, job] of jobs.entries()) {
          const entry = entries[index];
          cli.output.err(
            `${entry?.action ?? ''} "${entry?.expression ?? ''}": next at ${job.nextRun()?.toISOString() ?? 'never'}`,
          );
        }
        cli.output.err('Press Ctrl+C to stop.');
        await new Promise<void>((resolve) => {
          if (cli.signal.aborted) resolve();
          cli.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        for (const job of jobs) job.stop();
        await current;
      }),
    );
}
