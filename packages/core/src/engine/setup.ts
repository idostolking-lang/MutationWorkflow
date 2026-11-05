import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { AdapterDescription } from '../adapter/types.js';
import {
  type InspectionReport,
  InspectionReportSchema,
  inspectorPrompt,
} from '../agents/prompts/inspector.js';
import type { AgentEvent, AgentRuntime } from '../agents/runtime.js';
import { writeConfigFile } from '../config/load.js';
import type { Config } from '../config/schema.js';
import type { EnvironmentManager } from '../environment/manager.js';
import {
  createWorkflow,
  newId,
  nowIso,
  type Question,
  QuestionSchema,
  redactTarget,
  type TargetConfig,
  type Workflow,
} from '../schema/index.js';
import type { Store } from '../store/types.js';
import { errorMessage, MutationWorkflowError } from '../util/errors.js';
import { writeFileAtomic } from '../util/fs.js';
import type { Logger } from '../util/logger.js';
import type { AdapterRegistry } from './adapters.js';
import { workflowProblem } from './identity.js';
import { repositoryTools } from './repo-tools.js';

/** What setup needs regardless of who does the inspecting. */
export interface SetupContext {
  store: Store;
  registry: AdapterRegistry;
  environments: EnvironmentManager;
  rootDir: string;
  /** Existing config file path, when one exists. */
  configPath?: string;
  existing?: Config;
  logger: Logger;
}

export interface SetupDeps extends SetupContext {
  runtime: AgentRuntime;
  jobId?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export interface SetupOptions {
  projectName?: string;
  /**
   * Start each proposed environment once to confirm its start command works. Off by default:
   * the commands were written by a model, so review them in the config first. Never done when a
   * config already exists (the proposal is written for a human to merge).
   */
  validate?: boolean;
}

export interface SetupResult {
  report: InspectionReport;
  /** Where the config was written, or where the proposal went when a config already existed. */
  configPath: string;
  configAction: 'created' | 'proposal-written';
  workflows: Workflow[];
  questions: Question[];
  validation: Array<{ targetId: string; ok: boolean; message?: string }>;
}

/** Everything an inspector needs to know, for an in-process agent or a connected coding agent. */
export interface InspectionBrief {
  system: string;
  task: string;
  /** JSON Schema of the report to submit. */
  reportSchema: Record<string, unknown>;
  adapters: AdapterDescription[];
}

export async function inspectionBrief(
  context: SetupContext,
  options: SetupOptions = {},
): Promise<InspectionBrief> {
  const projectName =
    options.projectName ?? context.existing?.project.name ?? basename(context.rootDir);
  const adapters = await context.registry.describeRegistered();
  const { $schema: _ignored, ...reportSchema } = z.toJSONSchema(InspectionReportSchema, {
    io: 'input',
    target: 'draft-2020-12',
  }) as Record<string, unknown>;
  return {
    system: inspectorPrompt({ projectName, rootDir: context.rootDir, adapters }),
    task: `Inspect the project at ${context.rootDir} and submit the inspection report.`,
    reportSchema,
    adapters,
  };
}

/**
 * Let the inspector agent (and its delegates) study the repository, then turn its report into a
 * configuration, seed workflows and questions. Existing config files are never rewritten; the
 * proposal is saved next to the database for the team to merge by hand.
 */
export async function setup(deps: SetupDeps, options: SetupOptions = {}): Promise<SetupResult> {
  const brief = await inspectionBrief(deps, options);
  const result = await deps.runtime.run({
    role: 'inspector',
    system: brief.system,
    task: `${brief.task} Use the finish tool for the report.`,
    tools: repositoryTools(deps.rootDir),
    output: InspectionReportSchema,
    jobId: deps.jobId,
    signal: deps.signal,
    onEvent: deps.onEvent,
  });
  if (!result.output) {
    throw new MutationWorkflowError(
      'AGENT_FAILED',
      `The inspector did not produce a report (${result.stoppedBecause}${result.error ? `: ${result.error}` : ''})`,
    );
  }
  return applyInspectionReport(deps, result.output as InspectionReport, options);
}

/**
 * Turn an inspection report into configuration, seed workflows and questions. The report may come
 * from the in-process inspector or from a coding agent that inspected the repository itself.
 */
export async function applyInspectionReport(
  context: SetupContext,
  rawReport: unknown,
  options: SetupOptions = {},
): Promise<SetupResult> {
  const { rootDir, logger, store } = context;
  const parsed = InspectionReportSchema.safeParse(rawReport);
  if (!parsed.success) {
    throw new MutationWorkflowError(
      'INVALID_INPUT',
      `The inspection report is invalid:\n${z.prettifyError(parsed.error)}`,
    );
  }
  const report = parsed.data;
  const projectName = options.projectName ?? context.existing?.project.name ?? basename(rootDir);
  const adapters = await context.registry.describeRegistered();
  const targets = report.targets.filter((target) => {
    const adapter = target.adapter ?? target.kind;
    if (context.registry.has(adapter) || adapters.some((a) => a.kind === adapter)) return true;
    logger.warn(
      `Dropping proposed target "${target.id}": no adapter named "${adapter}" is available`,
    );
    return false;
  });

  const defaultPath = context.configPath ?? join(rootDir, 'mutationworkflow.config.yaml');
  // Re-check on disk: the config may have appeared since this engine was created.
  const configExists = Boolean(context.existing) || existsSync(defaultPath);
  let configPath: string;
  let configAction: SetupResult['configAction'];
  if (!configExists) {
    configPath = defaultPath;
    writeConfigFile(configPath, {
      version: 1,
      project: { name: projectName, description: report.summary },
      targets,
    });
    configAction = 'created';
    logger.info(`Config written to ${configPath}`);
  } else {
    configPath = join(rootDir, '.mutationworkflow', 'setup-proposal.yaml');
    writeFileAtomic(
      configPath,
      `# Proposal from "mw setup". Merge what you want into your config file.\n${stringifyYaml({
        targets,
        features: report.features,
        risks: report.risks,
      })}`,
    );
    configAction = 'proposal-written';
    logger.info(`Config already exists; proposal written to ${configPath}`);
  }

  const knownTargets = new Map<string, TargetConfig>();
  for (const target of context.existing?.targets ?? []) knownTargets.set(target.id, target);
  for (const target of targets) {
    if (!knownTargets.has(target.id)) {
      knownTargets.set(target.id, target);
      await store.targets.upsert(redactTarget(target));
    }
  }

  const workflows = await seedWorkflows(context, report, knownTargets);
  const questions: Question[] = [];
  for (const text of report.questions) {
    questions.push(await ask(store, { kind: 'setup', question: text }));
  }
  for (const workflow of workflows.filter((w) => w.status === 'pending-review')) {
    questions.push(
      await ask(store, {
        kind: 'expected-behavior',
        targetId: workflow.targetId,
        question: `Seed workflow "${workflow.title}": ${workflow.intent}. It was inferred from the code rather than from a test. Confirm to activate it, or dismiss it.`,
        workflowId: workflow.id,
      }),
    );
  }

  const validation: SetupResult['validation'] = [];
  if (options.validate === true && configAction === 'created') {
    for (const target of targets.filter((t) => t.environment.start)) {
      logger.info(
        `Validating start command for "${target.id}": ${target.environment.start?.command}`,
      );
      const outcome = await validateEnvironment(context.environments, target);
      validation.push(outcome);
      if (!outcome.ok) {
        questions.push(
          await ask(store, {
            kind: 'setup',
            targetId: target.id,
            question: `The start command for target "${target.id}" did not come up: ${outcome.message}. Fix environment.start in the config.`,
          }),
        );
      }
    }
  }
  return { report, configPath, configAction, workflows, questions, validation };
}

async function seedWorkflows(
  context: SetupContext,
  report: InspectionReport,
  targets: Map<string, TargetConfig>,
): Promise<Workflow[]> {
  const { store, logger } = context;
  const created: Workflow[] = [];
  for (const draft of report.workflows) {
    const target = targets.get(draft.targetId);
    if (!target) {
      logger.warn(`Skipping seed workflow "${draft.title}": unknown target "${draft.targetId}"`);
      continue;
    }
    const origin = draft.source?.file ? 'imported-test' : 'seed';
    let workflow: Workflow;
    try {
      workflow = createWorkflow(target.id, draft, {
        origin,
        status: origin === 'imported-test' ? 'active' : 'pending-review',
      });
    } catch (error) {
      logger.warn(`Skipping seed workflow "${draft.title}": ${errorMessage(error)}`);
      continue;
    }
    const adapter = await context.registry.forTarget(target).catch(() => undefined);
    const problem = adapter ? workflowProblem(adapter, workflow) : undefined;
    if (problem) {
      logger.warn(`Skipping seed workflow "${draft.title}": ${problem}`);
      continue;
    }
    if (await store.workflows.getByFingerprint(target.id, workflow.fingerprint)) continue;
    await store.workflows.insert(workflow);
    created.push(workflow);
  }
  logger.info(`Seeded ${created.length} workflow(s)`);
  return created;
}

async function ask(
  store: Store,
  input: { kind: Question['kind']; question: string; targetId?: string; workflowId?: string },
): Promise<Question> {
  const question = QuestionSchema.parse({
    id: newId('q'),
    targetId: input.targetId,
    kind: input.kind,
    question: input.question,
    context: { workflowId: input.workflowId, evidenceIds: [] },
    status: 'open',
    createdAt: nowIso(),
  });
  await store.questions.insert(question);
  return question;
}

async function validateEnvironment(
  environments: EnvironmentManager,
  target: TargetConfig,
): Promise<SetupResult['validation'][number]> {
  try {
    const env = await environments.start(target);
    await env.stop();
    return { targetId: target.id, ok: true };
  } catch (error) {
    return { targetId: target.id, ok: false, message: errorMessage(error) };
  }
}
