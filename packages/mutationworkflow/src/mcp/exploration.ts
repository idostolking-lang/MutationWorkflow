/**
 * Client-driven exploration: the connected coding agent opens a live session against a freshly
 * started environment and drives it one tool call at a time, seeing the same observations
 * (including screenshots) an in-process explorer would.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type Engine, MutationWorkflowError, type TargetConfig } from '@mutationworkflow/core';
import { z } from 'zod';
import { formatQuestions, formatWorkflows } from '../format.js';
import { requireTargets } from '../jobs.js';
import { workflowView } from '../views.js';
import { instructionBlocks } from './client-driven.js';
import { safe, textResult, toolOutputResult } from './result.js';
import type { ExplorationRegistry } from './sessions.js';

const ACT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;
const LOOK = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

const sessionId = z.string().describe('Session id from mw_explore_open (ses_...)');
const assertion = z
  .record(z.string(), z.unknown())
  .describe('One assertion from the adapter vocabulary, e.g. {"type": "...", ...}');

const TOOL_MAP =
  'Tool names in the instructions map to MCP tools: observe → mw_observe, act → mw_act, check → mw_check, save_workflow → mw_save_workflow, reset → mw_reset_session, use_identity → mw_use_identity, list_workflows → mw_list_known_workflows, finish → mw_explore_close (pass your summary). Every call needs the sessionId.';

function pickTarget(engine: Engine, id: string | undefined): TargetConfig {
  const targets = requireTargets(engine, id ? [id] : undefined);
  const [first] = targets;
  if (!first || targets.length > 1) {
    throw new MutationWorkflowError(
      'INVALID_INPUT',
      `Pass a target: one of ${targets.map((t) => t.id).join(', ')}.`,
    );
  }
  return first;
}

/** Register mw_explore_open, mw_explore_sessions, the per-session tools and mw_explore_close. */
export function registerExplorationTools(
  server: McpServer,
  engine: Engine,
  sessions: ExplorationRegistry,
): void {
  server.registerTool(
    'mw_explore_open',
    {
      title: 'Open an exploration (explore yourself)',
      description:
        "Start the target's app in a fresh local environment (or join the one already running for it) and open a live session you drive yourself. Returns the sessionId, the explorer's instructions, the remaining workflow budget and the first observation (with a screenshot when the adapter takes one). Then use mw_act / mw_check / mw_save_workflow / mw_reset_session, and finish with mw_explore_close. To explore in parallel, open one session per sub-agent, each with its own focus: sessions on one target share the app and the saved titles, each has its own browser or process. Sessions idle for 30 minutes are closed. Needs no model provider.",
      inputSchema: {
        target: z.string().optional().describe('Target id (optional when only one is configured)'),
        focus: z.array(z.string()).optional().describe('Areas or features to prioritise'),
        maxWorkflows: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('How many workflows this session may save (default from the config)'),
      },
      annotations: ACT,
    },
    safe(async (args) => {
      const target = pickTarget(engine, args.target);
      const handle = await engine.openExploration(target.id, {
        focus: args.focus,
        maxWorkflows: args.maxWorkflows,
      });
      sessions.add(handle);
      const observation = toolOutputResult(await sessions.call(handle.id, 'observe', {}));
      const others = sessions.forTarget(target.id).filter((h) => h.id !== handle.id);
      const info = {
        sessionId: handle.id,
        targetId: handle.targetId,
        remainingBudget: handle.session.remainingBudget,
        otherSessionsOnTarget: others.map((h) => h.id),
      };
      const header = [
        `Opened exploration session ${handle.id} on ${handle.targetId}. You are the explorer; you may save up to ${info.remainingBudget} workflow(s).`,
        TOOL_MAP,
        'Record one journey at a time: mw_act each step, verify with mw_check, mw_save_workflow with expectations that hold now, then mw_reset_session before the next journey. Close with mw_explore_close when the budget is used or nothing worthwhile is left; the app keeps running until the last session on it closes.',
        others.length > 0
          ? `${others.length} other session(s) explore this target right now; mw_list_known_workflows shows what they saved.`
          : undefined,
        JSON.stringify(info),
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n');
      return {
        content: [
          { type: 'text', text: header },
          ...instructionBlocks(handle.instructions).map((text) => ({
            type: 'text' as const,
            text,
          })),
          { type: 'text', text: '## First observation' },
          ...observation.content,
        ],
      };
    }),
  );

  server.registerTool(
    'mw_explore_sessions',
    {
      title: 'Open exploration sessions',
      description:
        'The exploration sessions open right now: id, target, when they opened, workflows saved and remaining budget. Use it to coordinate parallel explorers or to close a session a sub-agent left open.',
      inputSchema: {},
      annotations: LOOK,
    },
    safe(async () => {
      const list = sessions.list().map((handle) => ({
        sessionId: handle.id,
        targetId: handle.targetId,
        openedAt: handle.openedAt,
        saved: handle.session.saved.length,
        remainingBudget: handle.session.remainingBudget,
      }));
      const text =
        list.length === 0
          ? 'No exploration session is open.'
          : list
              .map(
                (s) =>
                  `${s.sessionId}  ${s.targetId}  opened ${s.openedAt}  saved ${s.saved}  budget left ${s.remainingBudget}`,
              )
              .join('\n');
      return textResult(text, { sessions: list });
    }),
  );

  /** A tool that forwards to the session's agent tool of the same meaning. */
  const forward = (
    name: string,
    tool: string,
    config: { title: string; description: string; readOnly?: boolean },
    shape: z.ZodRawShape,
    toInput: (args: Record<string, unknown>) => unknown = () => ({}),
  ) =>
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: { sessionId, ...shape },
        annotations: config.readOnly ? LOOK : ACT,
      },
      safe(async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const id = String(args['sessionId']);
        const output = await sessions.call(id, tool, toInput(args));
        const result = toolOutputResult(output);
        if (tool === 'save_workflow' && !output.isError) {
          const remaining = sessions.get(id).session.remainingBudget;
          result.content.push({
            type: 'text',
            text:
              remaining > 0
                ? `Remaining budget: ${remaining}. Call mw_reset_session before the next journey.`
                : 'Budget reached: call mw_explore_close with your summary.',
          });
        }
        return result;
      }),
    );

  forward(
    'mw_observe',
    'observe',
    {
      title: 'Observe the app',
      description:
        'Returns the current state of the app in the session: page structure or terminal output, plus a screenshot when available. Records nothing.',
      readOnly: true,
    },
    {},
  );

  forward(
    'mw_act',
    'act',
    {
      title: 'Perform an action',
      description:
        'Perform one action from the adapter vocabulary. Returns the outcome (ok, blocked, error), any application error signals and the resulting state. Successful actions are recorded as steps of the journey in progress; blocked or failed ones are not.',
    },
    {
      action: z
        .record(z.string(), z.unknown())
        .describe('One action from the adapter vocabulary, e.g. {"type": "...", ...}'),
      note: z.string().optional().describe('Why a user would do this (kept with the step)'),
    },
    (args) => ({ action: args['action'], note: args['note'] }),
  );

  forward(
    'mw_check',
    'check',
    {
      title: 'Check an assertion',
      description:
        'Evaluate an assertion from the adapter vocabulary against the current state. Returns PASSED or FAILED with a message. Records nothing; use it to pick expectations for mw_save_workflow.',
      readOnly: true,
    },
    { assertion },
    (args) => ({ assertion: args['assertion'] }),
  );

  forward(
    'mw_save_workflow',
    'save_workflow',
    {
      title: 'Save the journey as a workflow',
      description:
        'Save the actions recorded since the last save or reset as a workflow "pending review", with a question for the team. Expectations are verified now; ones that do not hold are dropped. Returns the workflow id and the remaining budget. Call mw_reset_session before the next journey.',
    },
    {
      title: z
        .string()
        .min(3)
        .describe('Specific title, e.g. "Add two items then complete the first"'),
      intent: z.string().min(3).describe('What the user wants to achieve'),
      expect: z.array(assertion).optional().describe('Final-state assertions that hold right now'),
      note: z.string().optional().describe('Doubts or observations for the human reviewer'),
    },
    (args) => ({
      title: args['title'],
      intent: args['intent'],
      expect: args['expect'] ?? [],
      note: args['note'],
    }),
  );

  forward(
    'mw_reset_session',
    'reset',
    {
      title: 'Reset the session',
      description:
        'Start a fresh browser context or process in the same environment and clear the recorded steps. Use it between journeys.',
    },
    {},
  );

  forward(
    'mw_use_identity',
    'use_identity',
    {
      title: 'Act as an identity',
      description:
        "Set up the session as one of the target's configured identities (right after mw_reset_session, before any step); workflows saved afterwards replay with it. Returns the resulting state. Errors when the target has no identities.",
    },
    { id: z.string().describe('Identity id from the target config') },
    (args) => ({ id: args['id'] }),
  );

  forward(
    'mw_list_known_workflows',
    'list_workflows',
    {
      title: 'List known workflows',
      description:
        'Returns the titles of the workflows already in memory for this target (including those saved in this session), to avoid duplicates.',
      readOnly: true,
    },
    {},
  );

  server.registerTool(
    'mw_explore_close',
    {
      title: 'Close an exploration',
      description:
        'Close the session and stop its environment. Returns the workflows saved in the session (pending review) and the questions raised for the team. Next: mw_questions with the user, or mw_mutate / mw_run.',
      inputSchema: {
        sessionId,
        summary: z
          .string()
          .optional()
          .describe('What you explored and anything suspicious you noticed (logged)'),
      },
      annotations: ACT,
    },
    safe(async (args) => {
      const handle = sessions.get(args.sessionId);
      const { workflows, questions } = await sessions.close(args.sessionId);
      if (args.summary) {
        engine.logger.info(`Exploration ${args.sessionId} summary: ${args.summary}`);
      }
      const lines = [
        `Closed exploration session ${args.sessionId} on ${handle.targetId}: ${workflows.length} workflow(s) saved (pending review), ${questions.length} question(s) for the team.`,
      ];
      if (workflows.length > 0) lines.push(formatWorkflows(workflows));
      if (questions.length > 0) lines.push('', formatQuestions(questions));
      lines.push(
        '',
        'Next: ask the user about the questions (mw_questions, then mw_answer), mw_mutate to derive variants, mw_run to replay.',
      );
      return textResult(lines.join('\n'), {
        sessionId: args.sessionId,
        targetId: handle.targetId,
        workflows: workflows.map(workflowView),
        questions: questions.map((q) => ({ id: q.id, question: q.question })),
      });
    }),
  );
}
