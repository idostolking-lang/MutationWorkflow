import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
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

export interface SetupDeps {
  store: Store;
  runtime: AgentRuntime;
  registry: AdapterRegistry;
  environments: EnvironmentManager;
  rootDir: string;
  /** Existing config file path, when one exists. */
  configPath?: string;
  existing?: Config;
  logger: Logger;
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

/**
 * Let the inspector agent (and its delegates) study the repository, then turn its report into a
 * configuration, seed workflows and questions. Existing config files are never rewritten; the
 * proposal is saved next to the database for the team to merge by hand.
 */
export async function setup(deps: SetupDeps, options: SetupOptions = {}): Promise<SetupResult> {
  const { rootDir, logger, store } = deps;
  const projectName = options.projectName ?? deps.existing?.project.name ?? basename(rootDir);
  const adapters = await deps.registry.describeRegistered();

  const result = await deps.runtime.run({
    role: 'inspector',
    system: inspectorPrompt({ projectName, rootDir, adapters }),
    task: `Inspect the project at ${rootDir} and submit the inspection report with the finish tool.`,
    tools: repositoryTools(rootDir),
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
  const report = result.output as InspectionReport;
  const targets = report.targets.filter((target) => {
    const adapter = target.adapter ?? target.kind;
    if (deps.registry.has(adapter) || adapters.some((a) => a.kind === adapter)) return true;
    logger.warn(
      `Dropping proposed target "${target.id}": no adapter named "${adapter}" is available`,
    );
    return false;
  });

  const defaultPath = deps.configPath ?? join(rootDir, 'mutationworkflow.config.yaml');
  // Re-check on disk: the config may have appeared since this engine was created.
  const configExists = Boolean(deps.existing) || existsSync(defaultPath);
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
  for (const target of deps.existing?.targets ?? []) knownTargets.set(target.id, target);
  for (const target of targets) {
    if (!knownTargets.has(target.id)) {
      knownTargets.set(target.id, target);
      await store.targets.upsert(redactTarget(target));
    }
  }

  const workflows = await seedWorkflows(deps, report, knownTargets);
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
      if (deps.signal?.aborted) break;
      logger.info(
        `Validating start command for "${target.id}": ${target.environment.start?.command}`,
      );
      const outcome = await validateEnvironment(deps.environments, target);
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
  deps: SetupDeps,
  report: InspectionReport,
  targets: Map<string, TargetConfig>,
): Promise<Workflow[]> {
  const { store, logger } = deps;
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
    const adapter = await deps.registry.forTarget(target).catch(() => undefined);
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
