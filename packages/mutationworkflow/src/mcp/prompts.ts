/**
 * MCP prompts: short walkthroughs a user can invoke as slash commands (for example
 * `/mcp__mutationworkflow__explore` in Claude Code) so the connected agent runs a role itself.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

function prompt(text: string): GetPromptResult {
  return { messages: [{ role: 'user', content: { type: 'text', text } }] };
}

const json = (value: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)));

export const SETUP_PROMPT = `Set up MutationWorkflow for this repository yourself, using the mutationworkflow MCP tools and your own file tools.
1. Call mw_status. If a config already exists, setup only writes a proposal; tell me and ask whether to continue.
2. Call mw_inspect_brief. Follow its role instructions: read the repository with your own tools (README, package manifests, start scripts, routes or commands, end-to-end tests). Do not start the app and do not change files. If you can run sub-agents in parallel, give each an area (start scripts and infrastructure; routes, pages and features; existing tests) and merge what they report.
3. Build the inspection report exactly as the report JSON schema says: targets with how to start each app locally, features, existing tests, seed workflows whose steps use only the adapter vocabularies, codemap rules where the routing is clear, risks, and questions for the team.
4. Call mw_inspect_apply {"report": {...}}. If it returns an error, fix the report as the message says and call it again.
5. Show me the config path, the targets and their start commands, the seeded workflows, and the open questions. Ask me the questions before recording any answer with mw_answer.`;

function explorePrompt(target?: string, focus?: string): string {
  const open = json({ target, focus: focus ? [focus] : undefined });
  return `Explore the app with MutationWorkflow yourself, using the mutationworkflow MCP tools.
1. Call mw_explore_open ${open}. It starts the app and returns a sessionId, your explorer instructions, the workflow budget and the first observation. Follow the instructions.
2. For each user journey: mw_act {"sessionId", "action": {...}} one step at a time, using only actions from the adapter vocabulary in the instructions; read every observation and screenshot. Confirm the end state with mw_check {"sessionId", "assertion": {...}}.
3. Save the journey with mw_save_workflow {"sessionId", "title", "intent", "expect": [assertions that passed]}; then mw_reset_session before starting the next one. Use mw_list_known_workflows to avoid duplicates.
4. Stop when the budget is used or nothing worthwhile is left: call mw_explore_close {"sessionId", "summary"}. Always close the session, also after errors; the app stops when the last session on it closes.
5. Show me the saved workflows and the questions for the team, and ask me before answering any with mw_answer.
To explore in parallel, if you can run sub-agents: give each one a distinct focus (a feature, a role, a recovery path) and have it call mw_explore_open ${json({ target })} with that focus, drive its own session with steps 2 to 4, and close it. Sessions on one target share the running app and the list of saved titles; mw_explore_sessions lists the open ones.
Never cause real-world side effects (payments, emails to real people) even if the app offers them.`;
}

function triagePrompt(target?: string): string {
  return `Triage MutationWorkflow findings yourself, using the mutationworkflow MCP tools.
1. Call mw_triage_brief ${json({ target })}. If it says nothing is pending, tell me and stop.
2. Follow the triager instructions for each finding in the dossiers: look at evidence with mw_evidence {"id": "ev_..."}, at runs with mw_run_detail {"id": "run_..."}, at the workflow with mw_workflow, and read the application code the steps exercise.
3. Decide each finding: bug, not-a-bug or needs-human, with a specific title, summary, severity, rationale, and duplicateOf when two findings are the same problem.
4. Call mw_triage_apply {"decisions": [...]} with one decision per finding id, matching the decision JSON schema. If it returns an error, fix the decisions and call it again.
5. Repeat from step 1 until nothing is pending, then summarize the bugs for me, worst first.
To triage in parallel, if you can run sub-agents: the brief reports how many findings are waiting and their ids; split the ids into batches, and have each sub-agent call mw_triage_brief {"findingIds": [...]} for its batch, judge them with steps 2 and 3, and submit its own mw_triage_apply.`;
}

function mutatePrompt(workflowId?: string): string {
  const pick = workflowId
    ? `Work on workflow ${workflowId}.`
    : 'Call mw_workflows {"base": true, "status": "active"} and pick the base workflows with the most state changes (at most three unless I say otherwise).';
  return `Propose mutation variants of MutationWorkflow workflows yourself, using the mutationworkflow MCP tools.
1. ${pick}
2. For each: mw_mutation_brief {"workflowId"}. Follow the mutator instructions: design variants likely to reveal sequence bugs (double submit, back and resubmit, interrupt mid-flow, stale view, out-of-order steps) that the deterministic operators do not already cover. Use only actions from the adapter vocabulary.
3. Submit them with mw_mutation_apply {"workflowId", "variants": [...]}, matching the variants JSON schema. If it returns an error, fix the variants and call it again.
4. Replay the new variants with mw_run {"workflowIds": [...]} and poll mw_job until it finishes; then show me the findings.
Workflows are independent: if you can run sub-agents in parallel, give each one a workflow and have it do steps 2 and 3 for it.`;
}

/** Register the setup, explore, triage and mutate prompts. */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'setup',
    {
      title: 'Set up MutationWorkflow (your own model)',
      description: 'Inspect this repository yourself and write the MutationWorkflow config',
    },
    () => prompt(SETUP_PROMPT),
  );
  server.registerPrompt(
    'explore',
    {
      title: 'Explore the app (your own model)',
      description: 'Drive the app yourself and record user workflows',
      argsSchema: {
        target: z.string().optional().describe('Target id'),
        focus: z.string().optional().describe('Area or feature to prioritise'),
      },
    },
    (args) => prompt(explorePrompt(args.target, args.focus)),
  );
  server.registerPrompt(
    'triage',
    {
      title: 'Triage findings (your own model)',
      description: 'Judge the findings waiting for triage yourself',
      argsSchema: { target: z.string().optional().describe('Target id') },
    },
    (args) => prompt(triagePrompt(args.target)),
  );
  server.registerPrompt(
    'mutate',
    {
      title: 'Propose mutations (your own model)',
      description: 'Design mutation variants of base workflows yourself',
      argsSchema: { workflowId: z.string().optional().describe('Base workflow id') },
    },
    (args) => prompt(mutatePrompt(args.workflowId)),
  );
}
