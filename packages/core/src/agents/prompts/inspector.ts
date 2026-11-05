import { z } from 'zod';
import type { AdapterDescription } from '../../adapter/types.js';
import { TargetConfigSchema } from '../../schema/target.js';
import { WorkflowDraftSchema } from '../../schema/workflow.js';
import { describeAdapter, PRODUCT_BRIEF, SAFETY_RULES } from './common.js';

export const InspectionReportSchema = z.object({
  summary: z.string().describe('What the project is and how it is built, in a few sentences'),
  stack: z.array(z.string()).describe('Languages, frameworks, databases, tooling'),
  targets: z
    .array(TargetConfigSchema)
    .min(1)
    .describe('Proposed MutationWorkflow targets with how to start each app locally'),
  features: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        entryPoints: z.array(z.string()).describe('Routes, screens or commands'),
        targetId: z.string().optional(),
      }),
    )
    .describe('User-facing capabilities, most important first'),
  existingTests: z.array(
    z.object({
      file: z.string(),
      framework: z.string(),
      scenarios: z.array(z.string()).describe('Test or scenario names in the file'),
    }),
  ),
  workflows: z
    .array(WorkflowDraftSchema.extend({ targetId: z.string() }))
    .describe('Seed workflows: translated end-to-end tests first, then the core journeys'),
  risks: z.array(z.string()).describe('Where sequence and state bugs are most likely'),
  questions: z.array(z.string()).describe('What only the team can answer'),
});
export type InspectionReport = z.infer<typeof InspectionReportSchema>;

export function inspectorPrompt(input: {
  projectName: string;
  rootDir: string;
  adapters: AdapterDescription[];
}): string {
  return `You are the inspector agent of MutationWorkflow. ${PRODUCT_BRIEF}

Your job is to understand the project at ${input.rootDir} (${input.projectName}) well enough to configure MutationWorkflow for it, then submit an inspection report with the finish tool.

What the report must establish:
1. How to run the application locally: the exact start command (look at package.json scripts, Makefiles, docker-compose, Procfiles, README), the port and base URL it serves, a ready check (a URL that answers, a port, or a log line), and any reset or seed command. Prefer commands that need no extra services; if a database or service is required, say so in questions.
2. The user-facing features and their entry points (routes, pages, commands), and the roles or identities the app distinguishes, including any test accounts you find in seeds, fixtures or .env.example files.
3. Existing tests, especially end-to-end and integration tests. Translate each end-to-end scenario into a workflow using the adapter vocabulary below; these are the most valuable seeds because they encode intended behaviour. Then add the core journeys the tests do not cover.
4. Invariants worth checking after any workflow (health endpoints, consistency checks) and the areas most likely to hide sequence bugs: multi-step forms, state machines, anything with undo, retries, concurrency or money.

Work efficiently: list the top-level layout first, read the manifest and README, then read tests and routing code. For large repositories, use delegate to investigate areas in parallel (tests, routing and features, scripts and infrastructure) and merge the results. Do not read generated or vendored directories.

Adapters available for targets:
${input.adapters.map(describeAdapter).join('\n\n')}

Target ids are lowercase slugs. For web targets put the base URL in options.baseUrl and set environment.start with command, ready and env (for example a PORT). For CLI targets put the command in options.command. Keep workflows short (3-12 steps), give each a specific title and intent, and express expectations with the adapter's assertions.

${SAFETY_RULES}`;
}
