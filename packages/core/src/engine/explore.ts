import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { EvidenceSink } from '../adapter/evidence.js';
import type { Adapter, AdapterDescription, AdapterSession, Observation } from '../adapter/types.js';
import {
  type ExplorationSummary,
  ExplorationSummarySchema,
  explorerPrompt,
} from '../agents/prompts/explorer.js';
import type { ImagePart, TextPart } from '../agents/provider.js';
import type { AgentEvent, AgentRuntime, StopCause } from '../agents/runtime.js';
import { type AgentTool, defineTool, fail, ok } from '../agents/tools.js';
import type { Config } from '../config/schema.js';
import {
  ActionSchema,
  AssertionSchema,
  createWorkflow,
  type Evidence,
  newId,
  normalizeSteps,
  nowIso,
  type Question,
  QuestionSchema,
  type StepInput,
  type TargetConfig,
  type Workflow,
  workflowFingerprint,
} from '../schema/index.js';
import type { Store } from '../store/types.js';
import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { truncate } from '../util/text.js';

export interface ExploreDeps {
  store: Store;
  runtime: AgentRuntime;
  config: Config;
  target: TargetConfig;
  adapter: Adapter;
  evidenceRoot: string;
  baseUrl?: string;
  logger: Logger;
  jobId?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export interface ExploreOptions {
  focus?: string[];
  maxWorkflows?: number;
  explorers?: number;
}

export interface ExploreResult {
  workflows: Workflow[];
  questions: Question[];
  summaries: ExplorationSummary[];
  stoppedBecause: StopCause[];
}

/** Default angles when the operator gives no focus, so parallel explorers do not overlap. */
const ANGLES = [
  'the primary user journeys, end to end',
  'edge cases: empty and unusual input, cancel, undo, validation',
  'navigation and recovery: back, reload, revisiting completed flows, stale views',
  'secondary features, settings and less obvious screens or commands',
];

/**
 * Run one or more explorer agents against a live target. Each explorer drives its own isolated
 * adapter session, records every action it performs, and turns coherent journeys into
 * workflows that enter memory as "pending review" together with a question for the team.
 */
export async function explore(
  deps: ExploreDeps,
  options: ExploreOptions = {},
): Promise<ExploreResult> {
  const { config, target, store } = deps;
  const total = options.maxWorkflows ?? config.exploration.maxWorkflows;
  const explorers = Math.max(
    1,
    Math.min(options.explorers ?? config.exploration.parallelExplorers, total),
  );
  const focus = options.focus ?? config.exploration.focus;
  const known = await store.workflows.list({
    targetId: target.id,
    parentId: null,
    status: ['active', 'pending-review'],
  });
  const shared = {
    titles: new Set(known.map((w) => w.title)),
    saved: 0,
    budget: total,
  };
  const assignments = assign(focus, explorers);
  const description = deps.adapter.describe();
  const results = await Promise.all(
    assignments.map((assignment, index) =>
      runExplorer(deps, {
        assignment,
        index,
        description,
        shared,
        maxWorkflows: Math.ceil(total / explorers),
      }),
    ),
  );
  return {
    workflows: results.flatMap((r) => r.workflows),
    questions: results.flatMap((r) => r.questions),
    summaries: results.flatMap((r) => (r.summary ? [r.summary] : [])),
    stoppedBecause: results.map((r) => r.stoppedBecause),
  };
}

function assign(focus: string[], explorers: number): string[] {
  if (focus.length === 0) {
    return Array.from(
      { length: explorers },
      (_, i) => ANGLES[i % ANGLES.length] ?? ANGLES[0] ?? '',
    );
  }
  const buckets: string[][] = Array.from({ length: explorers }, () => []);
  for (const [i, item] of focus.entries()) buckets[i % explorers]?.push(item);
  return buckets.map((items, i) =>
    items.length > 0 ? items.join('; ') : (ANGLES[i % ANGLES.length] ?? ''),
  );
}

interface SharedState {
  titles: Set<string>;
  saved: number;
  budget: number;
}

interface ExplorerRunOptions {
  assignment: string;
  index: number;
  description: AdapterDescription;
  shared: SharedState;
  maxWorkflows: number;
}

interface ExplorerRunResult {
  workflows: Workflow[];
  questions: Question[];
  summary?: ExplorationSummary;
  stoppedBecause: StopCause;
}

async function runExplorer(
  deps: ExploreDeps,
  options: ExplorerRunOptions,
): Promise<ExplorerRunResult> {
  const { target, config, logger } = deps;
  const sessionId = newId('ses');
  const vision = deps.runtime.resolveModel('explorer').vision;
  const session = new ExplorerSession(deps, {
    sessionId,
    vision,
    maxSteps: config.exploration.maxStepsPerWorkflow,
    shared: options.shared,
    maxWorkflows: options.maxWorkflows,
  });
  await session.open();
  try {
    const where = deps.baseUrl ? ` The application is served at ${deps.baseUrl}.` : '';
    const result = await deps.runtime.run({
      role: 'explorer',
      system: explorerPrompt({
        target,
        adapter: options.description,
        focus: [options.assignment],
        maxWorkflows: options.maxWorkflows,
        maxSteps: config.exploration.maxStepsPerWorkflow,
        knownWorkflowTitles: [...options.shared.titles],
      }),
      task: `Explore the application.${where} Your assignment: ${options.assignment}. Start by observing or navigating, record journeys with save_workflow, and call finish when you have saved ${options.maxWorkflows} workflows or run out of worthwhile journeys.`,
      tools: session.tools(),
      output: ExplorationSummarySchema,
      jobId: deps.jobId,
      signal: deps.signal,
      onEvent: deps.onEvent,
    });
    if (result.error) logger.warn(`Explorer ${options.index + 1}: ${result.error}`);
    return {
      workflows: session.saved,
      questions: session.questions,
      summary: result.output as ExplorationSummary | undefined,
      stoppedBecause: result.stoppedBecause,
    };
  } finally {
    await session.close();
  }
}

interface ExplorerSessionOptions {
  sessionId: string;
  vision: boolean;
  maxSteps: number;
  maxWorkflows: number;
  shared: SharedState;
}

/**
 * One explorer's live session: wraps an adapter session, records performed actions, and exposes
 * the tools the explorer agent uses.
 */
class ExplorerSession {
  readonly saved: Workflow[] = [];
  readonly questions: Question[] = [];
  private session: AdapterSession | undefined;
  private recorded: StepInput[] = [];
  private identity: string | undefined;
  private persistedEvidence = 0;
  private readonly sink: EvidenceSink;

  constructor(
    private readonly deps: ExploreDeps,
    private readonly options: ExplorerSessionOptions,
  ) {
    this.sink = new EvidenceSink({
      rootDir: deps.evidenceRoot,
      sessionDir: `explore/${options.sessionId}`,
      sessionId: options.sessionId,
    });
  }

  async open(): Promise<void> {
    const { config, target, logger } = this.deps;
    this.session = await this.deps.adapter.open({
      sessionId: this.options.sessionId,
      evidence: this.sink,
      screenshots: config.execution.screenshots === 'never' ? 'never' : 'on-failure',
      stepTimeoutMs: config.execution.stepTimeoutMs,
      assertionTimeoutMs: config.execution.assertionTimeoutMs,
      scope: target.scope,
      logger: logger.child('explore'),
    });
  }

  async close(): Promise<void> {
    await this.persistEvidence();
    await this.session?.close().catch(() => undefined);
    this.session = undefined;
  }

  tools(): AgentTool[] {
    const target = this.deps.target;
    return [
      defineTool({
        name: 'observe',
        description:
          'Describe the current state of the application (page structure or terminal output).',
        schema: z.object({}),
        execute: async () => ok(await this.observation()),
      }),
      defineTool({
        name: 'act',
        description:
          'Perform one action from the adapter vocabulary and return the resulting state. Successful actions are recorded as steps of the workflow in progress.',
        schema: z.object({
          action: ActionSchema,
          note: z.string().optional().describe('Why a user would do this (kept with the step)'),
        }),
        execute: async ({ action, note }) => {
          const session = this.live();
          let validated: typeof action;
          try {
            validated = this.deps.adapter.validateAction(action);
          } catch (error) {
            return fail(`Invalid action: ${errorMessage(error)}`);
          }
          if (this.recorded.length >= this.options.maxSteps) {
            return fail(
              `This journey already has ${this.options.maxSteps} steps. Save it with save_workflow or reset.`,
            );
          }
          const outcome = await session.perform(validated, {
            stepId: `s${this.recorded.length + 1}`,
          });
          if (outcome.status === 'ok') this.recorded.push({ action: validated, note });
          const signals = session.drainSignals();
          const header = [
            `Outcome: ${outcome.status}${outcome.message ? ` (${outcome.message})` : ''}${outcome.status === 'ok' ? ` · recorded as step ${this.recorded.length}` : ' · not recorded'}`,
            signals.length > 0
              ? `Application signals: ${signals.map((s) => `${s.kind}: ${truncate(s.message, 200)}`).join(' | ')}`
              : undefined,
          ].filter((line): line is string => Boolean(line));
          return ok(await this.observation(header.join('\n')));
        },
      }),
      defineTool({
        name: 'check',
        description:
          'Evaluate an assertion from the adapter vocabulary against the current state without recording anything.',
        schema: z.object({ assertion: AssertionSchema }),
        execute: async ({ assertion }) => {
          try {
            const validated = this.deps.adapter.validateAssertion(assertion);
            const result = await this.live().check(validated);
            return ok(
              `${result.passed ? 'PASSED' : 'FAILED'}${result.message ? `: ${result.message}` : ''}`,
            );
          } catch (error) {
            return fail(`Invalid assertion: ${errorMessage(error)}`);
          }
        },
      }),
      defineTool({
        name: 'save_workflow',
        description:
          'Save the actions recorded since the last save or reset as a workflow, with final-state expectations you verified with check. Creates a review question for the team.',
        schema: z.object({
          title: z
            .string()
            .min(3)
            .describe('Specific title, e.g. "Add two items then complete the first"'),
          intent: z.string().min(3).describe('What the user wants to achieve'),
          expect: z
            .array(AssertionSchema)
            .default([])
            .describe('Final-state assertions that held when you checked'),
          note: z.string().optional().describe('Doubts or observations for the human reviewer'),
        }),
        execute: async ({ title, intent, expect, note }) =>
          this.saveWorkflow(title, intent, expect, note),
      }),
      defineTool({
        name: 'reset',
        description:
          'Start a fresh session (new browser context or process) and clear the recorded steps. Use it between journeys.',
        schema: z.object({}),
        execute: async () => {
          await this.session?.close().catch(() => undefined);
          this.recorded = [];
          this.identity = undefined;
          await this.open();
          return ok('Fresh session started; nothing recorded.');
        },
      }),
      defineTool({
        name: 'list_workflows',
        description: 'List the workflows already in memory for this target, to avoid duplicates.',
        schema: z.object({}),
        execute: async () => {
          const titles = [...this.options.shared.titles];
          return ok(titles.length > 0 ? titles.map((t) => `- ${t}`).join('\n') : '(none yet)');
        },
      }),
      ...(target.identities.length > 0
        ? [
            defineTool({
              name: 'use_identity',
              description: `Set up the session as one of the configured identities (${target.identities.map((i) => i.id).join(', ')}). Workflows saved afterwards replay with that identity.`,
              schema: z.object({ id: z.string() }),
              execute: async ({ id }) => {
                const identity = target.identities.find((i) => i.id === id);
                if (!identity) return fail(`Unknown identity "${id}"`);
                for (const step of normalizeSteps(identity.steps)) {
                  const outcome = await this.live().perform(step.action, {
                    stepId: `identity:${step.id}`,
                  });
                  if (outcome.status !== 'ok')
                    return fail(
                      `Identity setup failed at ${step.action.type}: ${outcome.message ?? outcome.status}`,
                    );
                }
                this.identity = id;
                return ok(await this.observation(`Now acting as "${id}".`));
              },
            }),
          ]
        : []),
    ];
  }

  private live(): AdapterSession {
    if (!this.session) throw new Error('Session is not open');
    return this.session;
  }

  private async observation(header?: string): Promise<Array<TextPart | ImagePart>> {
    let observation: Observation;
    try {
      observation = await this.live().observe();
    } catch (error) {
      return [
        {
          type: 'text',
          text: `${header ? `${header}\n` : ''}Could not observe: ${errorMessage(error)}`,
        },
      ];
    }
    const parts: Array<TextPart | ImagePart> = [
      { type: 'text', text: `${header ? `${header}\n\n` : ''}${observation.summary}` },
    ];
    if (this.options.vision && observation.screenshot?.path) {
      try {
        const data = readFileSync(
          join(this.deps.evidenceRoot, observation.screenshot.path),
        ).toString('base64');
        parts.push({ type: 'image', mediaType: 'image/png', data });
      } catch {
        // A missing screenshot is not worth failing the observation.
      }
    }
    return parts;
  }

  private async saveWorkflow(
    title: string,
    intent: string,
    expect: Workflow['expect'],
    note: string | undefined,
  ) {
    const { store, target, adapter } = this.deps;
    if (this.recorded.length === 0)
      return fail('No steps recorded since the last save or reset. Perform the journey first.');
    if (this.options.shared.saved >= this.options.shared.budget) {
      return fail(
        'The workflow budget for this session is used up. Call finish with your summary.',
      );
    }
    try {
      for (const assertion of expect) adapter.validateAssertion(assertion);
    } catch (error) {
      return fail(`Invalid expectation: ${errorMessage(error)}`);
    }
    const steps = normalizeSteps(this.recorded);
    const fingerprint = workflowFingerprint(target.id, this.identity, steps);
    const existing = await store.workflows.getByFingerprint(target.id, fingerprint);
    this.recorded = [];
    if (existing) {
      return ok(
        `An identical workflow already exists: "${existing.title}" (${existing.id}). Nothing saved; try a different journey.`,
      );
    }
    const workflow = createWorkflow(
      target.id,
      { title, intent, steps, expect, identity: this.identity, tags: ['discovered'] },
      { origin: 'discovered', status: 'pending-review' },
    );
    await store.workflows.insert(workflow);
    this.saved.push(workflow);
    this.options.shared.saved += 1;
    this.options.shared.titles.add(title);

    const screenshot = await this.live()
      .capture('screenshot', `final-${workflow.id}`)
      .catch(() => undefined);
    await this.persistEvidence();
    const question = QuestionSchema.parse({
      id: newId('q'),
      targetId: target.id,
      kind: 'expected-behavior',
      question: [
        `Workflow "${title}": ${intent}.`,
        expect.length > 0
          ? `Observed final state: ${expect.map((a) => (a.description as string | undefined) ?? JSON.stringify(a)).join('; ')}.`
          : 'No final-state expectations were recorded.',
        note ? `Explorer's note: ${note}` : undefined,
        'Is this the intended behaviour? Confirm to activate the workflow, mark it as a bug, or dismiss it.',
      ]
        .filter(Boolean)
        .join('\n'),
      context: { workflowId: workflow.id, evidenceIds: screenshot ? [screenshot.id] : [] },
      status: 'open',
      createdAt: nowIso(),
    });
    await store.questions.insert(question);
    this.questions.push(question);
    const remaining = this.options.shared.budget - this.options.shared.saved;
    return ok(
      `Saved workflow ${workflow.id} with ${steps.length} step(s) and ${expect.length} expectation(s). ${remaining > 0 ? `${remaining} more can be saved in this session.` : 'Budget reached: call finish with your summary.'} Call reset before starting the next journey.`,
    );
  }

  private async persistEvidence(): Promise<void> {
    const fresh: Evidence[] = this.sink.all.slice(this.persistedEvidence);
    if (fresh.length === 0) return;
    this.persistedEvidence = this.sink.all.length;
    await this.deps.store.evidence.insertMany(fresh);
  }
}
