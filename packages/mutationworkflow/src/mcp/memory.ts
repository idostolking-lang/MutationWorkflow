/**
 * MCP tools over the project's memory: status, jobs, findings, workflows, questions, search,
 * reports and evidence. All are quick and answer directly.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type Engine,
  FindingStatusSchema,
  JobStatusSchema,
  MutationWorkflowError,
  QuestionDecisionSchema,
  SeveritySchema,
  truncate,
  WorkflowOriginSchema,
  WorkflowStatusSchema,
} from '@mutationworkflow/core';
import { z } from 'zod';
import { getFindingDetail, getWorkflowDetail, listWorkflows, readEvidence } from '../details.js';
import {
  formatFindingDetail,
  formatFindings,
  formatJobDetail,
  formatJobs,
  formatQuestions,
  formatSearch,
  formatStatus,
  formatWorkflowDetail,
  formatWorkflows,
} from '../format.js';
import { writeLatestReport } from '../report.js';
import { findingView, jobView, workflowView } from '../views.js';
import { safe, textResult } from './result.js';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const;
const limit = (fallback: number) =>
  z.number().int().positive().max(500).optional().describe(`Maximum results (default ${fallback})`);
/** Text evidence (DOM snapshots, logs) beyond this size is cut in tool output. */
const MAX_EVIDENCE_CHARS = 100_000;
/** Reports beyond this size are cut in tool output; the file on disk is complete. */
const MAX_REPORT_CHARS = 30_000;

/** Register every read and bookkeeping tool. */
export function registerMemoryTools(server: McpServer, engine: Engine): void {
  server.registerTool(
    'mw_status',
    {
      title: 'Project status',
      description:
        'Overview: targets, workflows (base, mutations, pending review), runs, open findings by severity, open questions, agent configuration and model usage. Call this first.',
      inputSchema: {},
      annotations: READ,
    },
    safe(async () => {
      const status = await engine.status();
      return textResult(formatStatus(status), status);
    }),
  );

  server.registerTool(
    'mw_jobs',
    {
      title: 'List jobs',
      description: 'Recent jobs (setup, explore, mutate, run, triage), newest first.',
      inputSchema: {
        status: JobStatusSchema.optional().describe('Only jobs with this status'),
        limit: limit(20),
      },
      annotations: READ,
    },
    safe(async (args) => {
      const jobs = await engine.jobs.list({ status: args.status, limit: args.limit ?? 20 });
      return textResult(formatJobs(jobs), jobs.map(jobView));
    }),
  );

  server.registerTool(
    'mw_job',
    {
      title: 'Get a job',
      description:
        'Status, progress, error and result of one job. Poll this after starting an operation until the status is succeeded, failed or cancelled.',
      inputSchema: { id: z.string().describe('Job id, e.g. job_...') },
      annotations: READ,
    },
    safe(async (args) => {
      const job = await engine.jobs.get(args.id);
      if (!job) throw new MutationWorkflowError('NOT_FOUND', `No job with id ${args.id}`);
      const hint =
        job.status === 'running' || job.status === 'queued'
          ? '\n\nStill running; poll again in 15-30 seconds.'
          : '';
      const { result, ...rest } = job;
      return textResult(`${formatJobDetail(rest)}${hint}`, result);
    }),
  );

  server.registerTool(
    'mw_cancel_job',
    {
      title: 'Cancel a job',
      description: 'Stop a running job started by this server; its environment is shut down.',
      inputSchema: { id: z.string().describe('Job id') },
      annotations: WRITE,
    },
    safe(async (args) => {
      if (engine.jobs.cancel(args.id)) {
        return textResult(`Cancelling ${args.id}; poll mw_job to see it end.`);
      }
      const job = await engine.jobs.get(args.id);
      if (!job) throw new MutationWorkflowError('NOT_FOUND', `No job with id ${args.id}`);
      return textResult(
        `${args.id} is ${job.status} and not running in this server process, so there is nothing to cancel.`,
      );
    }),
  );

  server.registerTool(
    'mw_findings',
    {
      title: 'List findings',
      description:
        'Deduplicated problems found by replaying workflows, most recently seen first. Use mw_finding for reproduction steps and evidence.',
      inputSchema: {
        target: z.string().optional().describe('Target id'),
        status: FindingStatusSchema.optional(),
        severity: SeveritySchema.optional(),
        limit: limit(50),
      },
      annotations: READ,
    },
    safe(async (args) => {
      const findings = await engine.store.findings.list({
        targetId: args.target,
        status: args.status,
        severity: args.severity,
        limit: args.limit ?? 50,
      });
      return textResult(formatFindings(findings), findings.map(findingView));
    }),
  );

  server.registerTool(
    'mw_finding',
    {
      title: 'Get a finding',
      description:
        'One finding: summary, severity, triage verdict and rationale, numbered reproduction steps (with the mutation applied) and evidence with absolute file paths. Use mw_evidence to read an item.',
      inputSchema: { id: z.string().describe('Finding id, e.g. fnd_...') },
      annotations: READ,
    },
    safe(async (args) => {
      const detail = await getFindingDetail(engine, args.id);
      return textResult(formatFindingDetail(detail), {
        finding: detail.finding,
        evidence: detail.evidence.map(({ text, ...item }) =>
          text === undefined ? item : { ...item, text: text.slice(0, 2_000) },
        ),
      });
    }),
  );

  server.registerTool(
    'mw_update_finding',
    {
      title: 'Update a finding',
      description:
        "Set a finding's status (open, confirmed, fixed, dismissed) and/or notes, e.g. after deciding it is real or fixing it.",
      inputSchema: {
        id: z.string().describe('Finding id'),
        status: FindingStatusSchema.optional(),
        notes: z.string().optional().describe('Replaces the notes'),
      },
      annotations: WRITE,
    },
    safe(async (args) => {
      const finding = await engine.updateFinding(args.id, {
        ...(args.status ? { status: args.status } : {}),
        ...(args.notes !== undefined ? { notes: args.notes } : {}),
      });
      return textResult(`Updated ${finding.id}: ${finding.status}`, findingView(finding));
    }),
  );

  server.registerTool(
    'mw_workflows',
    {
      title: 'List workflows',
      description:
        'Workflows in memory: user journeys (base) and their mutation variants, with origin and status.',
      inputSchema: {
        target: z.string().optional().describe('Target id'),
        origin: WorkflowOriginSchema.optional(),
        status: WorkflowStatusSchema.optional(),
        base: z
          .boolean()
          .optional()
          .describe('true: base workflows only; false: mutation variants only'),
        limit: limit(100),
      },
      annotations: READ,
    },
    safe(async (args) => {
      const workflows = await listWorkflows(engine, {
        targetId: args.target,
        origin: args.origin,
        status: args.status,
        base: args.base,
        limit: args.limit ?? 100,
      });
      return textResult(formatWorkflows(workflows), workflows.map(workflowView));
    }),
  );

  server.registerTool(
    'mw_workflow',
    {
      title: 'Get a workflow',
      description: 'One workflow: intent, numbered steps, expectations, mutation and latest run.',
      inputSchema: { id: z.string().describe('Workflow id, e.g. wf_...') },
      annotations: READ,
    },
    safe(async (args) => {
      const detail = await getWorkflowDetail(engine, args.id);
      return textResult(formatWorkflowDetail(detail), detail.workflow);
    }),
  );

  server.registerTool(
    'mw_questions',
    {
      title: 'List questions',
      description:
        'Questions the agents raised for the team ("is this the intended behaviour?"). Answer them with mw_answer, ideally after asking the user.',
      inputSchema: {
        status: z.enum(['open', 'answered', 'all']).optional().describe('Default open'),
        limit: limit(50),
      },
      annotations: READ,
    },
    safe(async (args) => {
      const status = args.status ?? 'open';
      const questions = await engine.store.questions.list({
        ...(status === 'all' ? {} : { status }),
        limit: args.limit ?? 50,
      });
      return textResult(formatQuestions(questions), questions);
    }),
  );

  server.registerTool(
    'mw_answer',
    {
      title: 'Answer a question',
      description:
        "Record the team's answer. confirm: the observed behaviour is intended (activates the workflow). bug: it is a bug (confirms or records a finding). dismiss: not relevant (archives the workflow or dismisses the finding).",
      inputSchema: {
        id: z.string().describe('Question id, e.g. q_...'),
        decision: QuestionDecisionSchema,
        answer: z.string().optional().describe('Free-text answer or rationale'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    safe(async (args) => {
      const result = await engine.answerQuestion(args.id, args.decision, args.answer);
      const effects = [
        result.workflow && `workflow ${result.workflow.id} is now ${result.workflow.status}`,
        result.finding && `finding ${result.finding.id} is now ${result.finding.status}`,
      ].filter(Boolean);
      return textResult(
        `Answered ${args.id} (${args.decision})${effects.length > 0 ? `: ${effects.join('; ')}` : ''}.`,
        {
          question: result.question,
          ...(result.workflow ? { workflow: workflowView(result.workflow) } : {}),
          ...(result.finding ? { finding: findingView(result.finding) } : {}),
        },
      );
    }),
  );

  server.registerTool(
    'mw_search',
    {
      title: 'Search memory',
      description: 'Full-text search across workflows and findings.',
      inputSchema: {
        query: z.string().min(1).describe('Words to search for'),
        target: z.string().optional().describe('Target id'),
        limit: limit(20),
      },
      annotations: READ,
    },
    safe(async (args) => {
      const result = await engine.search(args.query, {
        targetId: args.target,
        limit: args.limit ?? 20,
      });
      return textResult(formatSearch(result), {
        workflows: result.workflows.map(workflowView),
        findings: result.findings.map(findingView),
      });
    }),
  );

  server.registerTool(
    'mw_report',
    {
      title: 'Write a report',
      description:
        'Render a Markdown report of the latest runs (summary, findings with reproduction steps, run table), write it to the reports directory and return it.',
      inputSchema: { limit: limit(50).describe('Number of latest runs (default 50)') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    safe(async (args) => {
      const report = await writeLatestReport(engine, args.limit ?? 50);
      const markdown =
        report.markdown.length > MAX_REPORT_CHARS
          ? `${report.markdown.slice(0, MAX_REPORT_CHARS)}\n\n[… truncated; read the file for the rest]`
          : report.markdown;
      return textResult(report.path ? `Report written to ${report.path}\n\n${markdown}` : markdown);
    }),
  );

  server.registerTool(
    'mw_evidence',
    {
      title: 'Read evidence',
      description:
        'Content of one evidence item from mw_finding: screenshots as images, console/network/stdout/DOM captures as text.',
      inputSchema: { id: z.string().describe('Evidence id, e.g. ev_...') },
      annotations: READ,
    },
    safe(async (args) => {
      const content = await readEvidence(engine, args.id);
      const { item } = content;
      const header = `${item.id} · ${item.kind}${item.label ? ` "${item.label}"` : ''}${item.path ? ` · ${item.path}` : ''}`;
      if (content.type === 'image') {
        return {
          content: [
            { type: 'text', text: header },
            { type: 'image', data: content.data.toString('base64'), mimeType: content.mimeType },
          ],
        };
      }
      return textResult(`${header}\n\n${truncate(content.text, MAX_EVIDENCE_CHARS)}`);
    }),
  );
}
