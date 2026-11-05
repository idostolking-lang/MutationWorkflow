/**
 * Client-driven agent roles: the connected coding agent asks for a brief (the role's
 * instructions and the JSON schema of what to submit), does the thinking with its own model,
 * and submits the result. No model provider or API key is needed in the server.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Engine } from '@mutationworkflow/core';
import { z } from 'zod';
import { formatFindings, formatSetupResult, formatWorkflows } from '../format.js';
import { findingView, summarizeSetup, workflowView } from '../views.js';
import { safe, textBlocks, textResult } from './result.js';

const BRIEF = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;
const APPLY = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;

/** Pretty JSON in a fenced block, for schemas the client's model has to follow. */
export function jsonBlock(title: string, value: unknown): string {
  return `## ${title}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

export function instructionBlocks(instructions: { system: string; task: string }): string[] {
  return [`## Role instructions\n\n${instructions.system}`, `## Task\n\n${instructions.task}`];
}

/** Accept either the bare list or the whole document (`{ [key]: [...] }`). */
function wrapList(key: string, value: unknown): unknown {
  return Array.isArray(value) ? { [key]: value } : value;
}

const entries = z.array(z.record(z.string(), z.unknown()));
const document = z.record(z.string(), z.unknown());

/** Register the inspection, triage and mutation brief/apply tools. */
export function registerClientDrivenTools(server: McpServer, engine: Engine): void {
  server.registerTool(
    'mw_inspect_brief',
    {
      title: 'Inspection brief (do setup yourself)',
      description:
        "Returns the inspector's instructions, the adapter vocabularies (actions and assertions) and the JSON schema of the inspection report. Inspect the repository with your own file tools, then submit the report with mw_inspect_apply. Needs no model provider.",
      inputSchema: {
        projectName: z.string().optional().describe('Project name (default: the directory name)'),
      },
      annotations: BRIEF,
    },
    safe(async (args) => {
      const brief = await engine.inspectionBrief({ projectName: args.projectName });
      const outcome = engine.configPath
        ? `A config already exists at ${engine.configPath}: applying writes a proposal to .mutationworkflow/setup-proposal.yaml instead of changing it.`
        : 'No config exists yet: applying writes mutationworkflow.config.yaml at the project root.';
      return textBlocks(
        [
          `Inspector brief for ${engine.rootDir}. You are the inspector.`,
          'Read the repository with your own file tools (where the instructions mention list_files, read_file, search or delegate, use your equivalents). Do not start the app.',
          'When done, call mw_inspect_apply {"report": {...}} with a report that matches the schema below; it replaces the finish tool. Steps in seed workflows must use the actions and assertions of the adapter vocabularies.',
          outcome,
        ].join('\n'),
        ...instructionBlocks(brief),
        jsonBlock('Adapter vocabularies', brief.adapters),
        jsonBlock('Report JSON schema', brief.reportSchema),
      );
    }),
  );

  server.registerTool(
    'mw_inspect_apply',
    {
      title: 'Apply an inspection report',
      description:
        'Submit the inspection report built from mw_inspect_brief. Writes the config (or a proposal when one exists), seeds workflows and records questions for the team. Returns the config path and action, seeded workflows, questions and environment validation. An invalid report returns an error explaining what to fix; correct it and call again.',
      inputSchema: {
        report: document.describe('The inspection report, matching the schema from the brief'),
        validate: z
          .boolean()
          .optional()
          .describe(
            'Start each proposed environment once to check its start command (default false)',
          ),
        projectName: z.string().optional().describe('Project name (default: the directory name)'),
      },
      annotations: APPLY,
    },
    safe(async (args) => {
      const result = await engine.applyInspectionReport(args.report, {
        validate: args.validate,
        projectName: args.projectName,
      });
      const next =
        result.configAction === 'created'
          ? 'Next: review the config with the user, then mw_explore_open to discover workflows and mw_questions for what only the team can answer (ask the user before mw_answer).'
          : 'Next: show the user the proposal so they can merge it into their config.';
      return textResult(`${formatSetupResult(result)}\n\n${next}`, summarizeSetup(result));
    }),
  );

  server.registerTool(
    'mw_triage_brief',
    {
      title: 'Triage brief (judge findings yourself)',
      description:
        "Returns the triager's instructions, one batch of findings waiting for triage as dossiers (workflow, mutation, steps, signals, failed expectations, evidence ids), their ids, the ids of everything still waiting on the target, and the JSON schema of the decisions. Judge each finding, then submit with mw_triage_apply. Says so when nothing is pending. To triage in parallel, split the waiting ids between sub-agents and give each its batch as findingIds.",
      inputSchema: {
        target: z.string().optional().describe('Target id; the first target with pending findings'),
        findingIds: z
          .array(z.string())
          .optional()
          .describe('Brief exactly these findings (all of one target) instead of the next batch'),
        includeSkipped: z
          .boolean()
          .optional()
          .describe('Also include findings skipped earlier, e.g. from runs without a provider'),
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe('Findings per batch (default 8)'),
      },
      annotations: BRIEF,
    },
    safe(async (args) => {
      const brief = await engine.triageBrief({
        targetId: args.target,
        includeSkipped: args.includeSkipped,
        limit: args.limit,
        findingIds: args.findingIds,
      });
      if (!brief) {
        return textResult(
          `Nothing pending: no open findings are waiting for triage${args.target ? ` on ${args.target}` : ''}.${
            args.includeSkipped
              ? ''
              : ' Pass includeSkipped: true to review findings skipped earlier.'
          }`,
          { findingIds: [] },
        );
      }
      return textBlocks(
        [
          `Triage brief for target ${brief.targetId}: ${brief.findingIds.length} finding(s): ${brief.findingIds.join(', ')}. You are the triager. Waiting on this target in total: ${brief.waitingIds.length} (${brief.waitingIds.join(', ')}).`,
          'Look at evidence with mw_evidence {"id": "ev_..."} (where the instructions mention get_evidence), at runs with mw_run_detail (get_run), at workflows with mw_workflow (get_workflow) and at findings with mw_finding; read the code the steps exercise.',
          'Then call mw_triage_apply {"decisions": [...]} with one decision per finding id, matching the schema below; it replaces the finish tool. not-a-bug dismisses the finding, needs-human becomes a question for the team. Call mw_triage_brief again for the next batch.',
        ].join('\n'),
        ...instructionBlocks(brief),
        jsonBlock('Decision JSON schema', brief.decisionSchema),
      );
    }),
  );

  server.registerTool(
    'mw_triage_apply',
    {
      title: 'Apply triage decisions',
      description:
        'Submit triage decisions from mw_triage_brief: either the list of decisions or the whole {"decisions": [...]} document. Updates title, summary, severity, verdict and rationale; not-a-bug dismisses, duplicates are merged, needs-human asks the team. Returns the updated findings.',
      inputSchema: {
        decisions: z
          .union([entries, document])
          .describe('Decisions matching the schema from the brief (array or {"decisions": [...]})'),
      },
      annotations: APPLY,
    },
    safe(async (args) => {
      const findings = await engine.applyTriageDecisions(
        wrapList('decisions', args.decisions),
        'mcp-client',
      );
      return textResult(
        `Updated ${findings.length} finding(s):\n${formatFindings(findings)}\n\nNext: mw_triage_brief for the next batch, or mw_findings to review.`,
        findings.map(findingView),
      );
    }),
  );

  server.registerTool(
    'mw_mutation_brief',
    {
      title: 'Mutation brief (propose variants yourself)',
      description:
        'Returns the mutator\'s instructions for one base workflow (its steps, the adapter vocabulary, variants that already exist) and the JSON schema of the variants. Design variants likely to reveal sequence bugs, then submit them with mw_mutation_apply. Find base workflows with mw_workflows {"base": true}.',
      inputSchema: { workflowId: z.string().describe('Id of a base workflow (wf_...)') },
      annotations: BRIEF,
    },
    safe(async (args) => {
      const brief = await engine.mutationBrief(args.workflowId);
      return textBlocks(
        [
          `Mutation brief for workflow ${brief.workflowId}. You are the mutator.`,
          `When done, call mw_mutation_apply {"workflowId": "${brief.workflowId}", "variants": [...]} with variants matching the schema below; it replaces the finish tool. Duplicates of existing workflows are skipped.`,
        ].join('\n'),
        ...instructionBlocks(brief),
        jsonBlock('Variants JSON schema', brief.variantsSchema),
      );
    }),
  );

  server.registerTool(
    'mw_mutation_apply',
    {
      title: 'Apply mutation variants',
      description:
        'Submit variants from mw_mutation_brief: either the list of variants or the whole {"variants": [...]} document. Stores each as a mutation of the base workflow (operator "agent"), skipping duplicates and steps outside the adapter vocabulary. Returns the created variants; replay them with mw_run {"workflowIds": [...]}.',
      inputSchema: {
        workflowId: z.string().describe('Id of the base workflow the brief was for'),
        variants: z
          .union([entries, document])
          .describe('Variants matching the schema from the brief (array or {"variants": [...]})'),
      },
      annotations: APPLY,
    },
    safe(async (args) => {
      const created = await engine.applyAgentVariants(
        args.workflowId,
        wrapList('variants', args.variants),
      );
      const body =
        created.length > 0
          ? `Created ${created.length} variant(s):\n${formatWorkflows(created)}\n\nNext: mw_run {"workflowIds": [${created.map((w) => `"${w.id}"`).join(', ')}]} to replay them.`
          : 'No new variants: every proposal duplicated an existing workflow or used steps the adapter does not offer (see the server log).';
      return textResult(body, created.map(workflowView));
    }),
  );
}
