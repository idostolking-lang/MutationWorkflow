/**
 * MCP tools for long-running operations. Each starts a job and returns its id right away
 * (the client polls mw_job), or waits for the result when called with `wait: true`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Engine } from '@mutationworkflow/core';
import { z } from 'zod';
import {
  formatExploreResults,
  formatFindings,
  formatMutateResults,
  formatRunSummary,
  formatSetupResult,
} from '../format.js';
import { type JobSpec, requireAgents, requireTargets, runJob, startJob } from '../jobs.js';
import {
  summarizeExplore,
  summarizeMutate,
  summarizeRun,
  summarizeSetup,
  summarizeTriage,
  type TargetExploreResult,
  type TargetMutateResult,
} from '../views.js';
import { safe, textResult } from './result.js';

const wait = z
  .boolean()
  .optional()
  .describe(
    'Wait for the result instead of returning a job id. Only for short operations; clients may time out.',
  );

const OPERATION = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;

/** Start the job and describe how to poll it, or run it to completion when `wait` is set. */
async function operation<T>(
  engine: Engine,
  waitForResult: boolean | undefined,
  spec: JobSpec<T>,
  render: (result: T) => string,
): Promise<CallToolResult> {
  if (waitForResult) {
    const { job, result } = await runJob(engine, spec);
    if (result === undefined) return textResult(`Job ${job.id} ended with status ${job.status}.`);
    return textResult(`${render(result)}\n\nJob ${job.id} ${job.status}.`, spec.summarize(result));
  }
  const job = await startJob(engine, spec);
  return textResult(
    `Started ${spec.kind} job ${job.id} in the background. Poll it with mw_job {"id":"${job.id}"} every 15-30 seconds until its status is succeeded, failed or cancelled; mw_cancel_job stops it.`,
    { jobId: job.id, kind: job.kind, status: job.status },
  );
}

/** Register mw_setup, mw_explore, mw_mutate, mw_run and mw_triage. */
export function registerOperationTools(server: McpServer, engine: Engine): void {
  server.registerTool(
    'mw_setup',
    {
      title: 'Set up MutationWorkflow',
      description:
        'Let the inspector agent study this repository, then write mutationworkflow.config.yaml (or a proposal next to an existing one), seed workflows and questions for the team. Needs a model provider key. Runs for minutes: returns a job id to poll with mw_job.',
      inputSchema: {
        validate: z
          .boolean()
          .optional()
          .describe(
            'Start each proposed environment once to check its start command (default true)',
          ),
        wait,
      },
      annotations: OPERATION,
    },
    safe(async (args) => {
      requireAgents(engine, 'setup');
      return operation(
        engine,
        args.wait,
        {
          kind: 'setup',
          params: { validate: args.validate },
          work: (job) =>
            engine.setup({ validate: args.validate, jobId: job.job.id, signal: job.signal }),
          summarize: summarizeSetup,
        },
        formatSetupResult,
      );
    }),
  );

  server.registerTool(
    'mw_explore',
    {
      title: 'Explore the app',
      description:
        'Start the app in a local environment and let explorer agents discover new user workflows. New workflows are "pending review" with questions for the team. Needs a model provider key. Returns a job id to poll with mw_job.',
      inputSchema: {
        target: z.string().optional().describe('Target id; all targets when omitted'),
        focus: z.array(z.string()).optional().describe('Areas or features to prioritise'),
        maxWorkflows: z.number().int().positive().optional().describe('New workflows per target'),
        wait,
      },
      annotations: OPERATION,
    },
    safe(async (args) => {
      requireAgents(engine, 'explore');
      const targets = requireTargets(engine, args.target ? [args.target] : undefined);
      return operation(
        engine,
        args.wait,
        {
          kind: 'explore',
          params: { targets: targets.map((t) => t.id), focus: args.focus },
          work: async (job) => {
            const results: TargetExploreResult[] = [];
            for (const target of targets) {
              if (job.signal.aborted) break;
              await job.progress(`Exploring ${target.id}`);
              results.push({
                targetId: target.id,
                result: await engine.explore(target.id, {
                  focus: args.focus,
                  maxWorkflows: args.maxWorkflows,
                  jobId: job.job.id,
                  signal: job.signal,
                }),
              });
            }
            return results;
          },
          summarize: summarizeExplore,
        },
        formatExploreResults,
      );
    }),
  );

  server.registerTool(
    'mw_mutate',
    {
      title: 'Mutate workflows',
      description:
        'Derive variants of the base workflows (skip, reorder, repeat, truncate, fuzz, interrupt, ...). Deterministic operators are fast and return directly; with agent=true the mutator agent adds variants in a background job.',
      inputSchema: {
        target: z.string().optional().describe('Target id; all targets when omitted'),
        agent: z.boolean().optional().describe('Also ask the mutator agent (needs a model key)'),
        wait,
      },
      annotations: OPERATION,
    },
    safe(async (args) => {
      if (args.agent) requireAgents(engine, 'mutate with agent');
      const targets = requireTargets(engine, args.target ? [args.target] : undefined);
      const spec: JobSpec<TargetMutateResult[]> = {
        kind: 'mutate',
        params: { targets: targets.map((t) => t.id), agent: args.agent === true },
        work: async (job) => {
          const results: TargetMutateResult[] = [];
          for (const target of targets) {
            if (job.signal.aborted) break;
            results.push({
              targetId: target.id,
              result: await engine.mutate(target.id, {
                agent: args.agent,
                jobId: job.job.id,
                signal: job.signal,
              }),
            });
          }
          return results;
        },
        summarize: summarizeMutate,
      };
      return operation(engine, args.wait || !args.agent, spec, formatMutateResults);
    }),
  );

  server.registerTool(
    'mw_run',
    {
      title: 'Replay workflows',
      description:
        'Start the app in a fresh local environment, replay workflows (base and mutations), record runs and evidence, fold failures into findings, triage them and write a report. Returns a job id to poll with mw_job; the result lists findings created or updated.',
      inputSchema: {
        targets: z.array(z.string()).optional().describe('Target ids; all targets when omitted'),
        workflowIds: z.array(z.string()).optional().describe('Only these workflows'),
        include: z
          .enum(['all', 'base', 'mutations'])
          .optional()
          .describe('Which workflows to replay (default all)'),
        triage: z
          .boolean()
          .optional()
          .describe('Let the triager agent review new findings (default true with a model key)'),
        wait,
      },
      annotations: OPERATION,
    },
    safe(async (args) => {
      const targetIds = requireTargets(engine, args.targets).map((t) => t.id);
      return operation(
        engine,
        args.wait,
        {
          kind: 'run',
          params: { targets: targetIds, workflowIds: args.workflowIds, include: args.include },
          work: (job) =>
            engine.run({
              targetIds,
              workflowIds: args.workflowIds,
              include: args.include,
              triage: args.triage,
              trigger: 'mcp',
              jobId: job.job.id,
              signal: job.signal,
              onRun: (run, workflow, done, total) => {
                void job.progress(`${workflow.title}: ${run.status}`, done, total);
              },
            }),
          summarize: summarizeRun,
        },
        formatRunSummary,
      );
    }),
  );

  server.registerTool(
    'mw_triage',
    {
      title: 'Triage findings',
      description:
        'Let the triager agent review open findings that are waiting for triage, deciding bug / not-a-bug / needs-human with a rationale. Needs a model provider key. Returns a job id to poll with mw_job.',
      inputSchema: {
        targets: z.array(z.string()).optional().describe('Target ids; all targets when omitted'),
        includeSkipped: z
          .boolean()
          .optional()
          .describe('Also review findings skipped earlier, e.g. from runs without a model key'),
        wait,
      },
      annotations: OPERATION,
    },
    safe(async (args) => {
      requireAgents(engine, 'triage');
      const targetIds = requireTargets(engine, args.targets).map((t) => t.id);
      return operation(
        engine,
        args.wait,
        {
          kind: 'triage',
          params: { targets: targetIds, includeSkipped: args.includeSkipped === true },
          work: (job) =>
            engine.triage({
              targetIds,
              includeSkipped: args.includeSkipped,
              jobId: job.job.id,
              signal: job.signal,
            }),
          summarize: summarizeTriage,
        },
        (findings) =>
          findings.length === 0
            ? 'Nothing was waiting for triage.'
            : `Reviewed ${findings.length} finding(s):\n${formatFindings(findings)}`,
      );
    }),
  );
}
