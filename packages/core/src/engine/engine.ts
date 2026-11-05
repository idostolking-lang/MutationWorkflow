import type { ModelProvider } from '../agents/provider.js';
import { createProviders } from '../agents/providers/index.js';
import { type AgentEvent, AgentRuntime } from '../agents/runtime.js';
import type { ResolvedConfig } from '../config/load.js';
import type { AgentRole, Config } from '../config/schema.js';
import { EnvironmentManager, withEnvironment } from '../environment/manager.js';
import { resolveOracles } from '../oracles/registry.js';
import type { Oracle } from '../oracles/types.js';
import {
  type Finding,
  FindingSchema,
  type FindingStatus,
  fingerprint,
  newId,
  nowIso,
  type Question,
  type QuestionDecision,
  QuestionSchema,
  type Severity,
  SeveritySchema,
  type TargetConfig,
  type Workflow,
  WorkflowSchema,
} from '../schema/index.js';
import { openSqliteStore } from '../store/sqlite.js';
import type { RunStats, Store, UsageTotals } from '../store/types.js';
import { MutationWorkflowError } from '../util/errors.js';
import { createLogger, type Logger } from '../util/logger.js';
import { type AdapterLoader, AdapterRegistry } from './adapters.js';
import { type ExploreOptions, type ExploreResult, explore } from './explore.js';
import { JobManager } from './jobs.js';
import { type MutateOptions, type MutateResult, mutate } from './mutate.js';
import { type RunOptions, type RunSummary, runWorkflows } from './run.js';
import { type SetupOptions, type SetupResult, setup } from './setup.js';
import { triageFindings } from './triage.js';

export interface EngineOptions {
  config: ResolvedConfig;
  logger?: Logger;
  /** Adapter loaders by kind or package name; the CLI registers the built-in web and cli adapters. */
  adapters?: Record<string, AdapterLoader>;
  /** Override the providers built from the config (tests use a fake provider). */
  providers?: Map<string, ModelProvider>;
  env?: NodeJS.ProcessEnv;
  store?: Store;
  oracles?: Oracle[];
}

/** Hooks every agent-driven operation accepts. */
export interface AgentHooks {
  jobId?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export interface TargetStatus {
  id: string;
  kind: string;
  name?: string;
  workflows: { base: number; mutations: number; pendingReview: number };
  runs: RunStats;
  findings: { open: number; confirmed: number; bySeverity: Record<Severity, number> };
  openQuestions: number;
}

export interface StatusSummary {
  project: { name: string; rootDir: string; configPath?: string };
  targets: TargetStatus[];
  agents: {
    enabled: boolean;
    providers: string[];
    maxParallel: number;
    models: Partial<Record<AgentRole, string>>;
  };
  usage: UsageTotals;
  openQuestions: number;
}

export interface WatchOptions extends Pick<AgentHooks, 'jobId' | 'onEvent'> {
  targetIds?: string[];
  signal: AbortSignal;
  maxCycles?: number;
  onCycle?: (cycle: number, summary: RunSummary) => void;
}

export interface AnswerResult {
  question: Question;
  workflow?: Workflow;
  finding?: Finding;
}

const ROLES: AgentRole[] = ['inspector', 'explorer', 'mutator', 'triager'];

interface EngineFields {
  config: Config;
  rootDir: string;
  configPath: string | undefined;
  evidenceRoot: string;
  reportsDir: string;
  store: Store;
  registry: AdapterRegistry;
  environments: EnvironmentManager;
  agents: AgentRuntime;
  jobs: JobManager;
  logger: Logger;
  oracles: Oracle[];
}

/**
 * The engine wires configuration, memory, adapters, environments and agents together and
 * exposes every operation the CLI and the MCP server offer. One instance per project.
 */
export class Engine {
  readonly config: Config;
  readonly rootDir: string;
  readonly configPath: string | undefined;
  readonly evidenceRoot: string;
  readonly reportsDir: string;
  readonly store: Store;
  readonly registry: AdapterRegistry;
  readonly environments: EnvironmentManager;
  readonly agents: AgentRuntime;
  readonly jobs: JobManager;
  readonly logger: Logger;
  readonly oracles: Oracle[];

  private constructor(fields: EngineFields) {
    this.config = fields.config;
    this.rootDir = fields.rootDir;
    this.configPath = fields.configPath;
    this.evidenceRoot = fields.evidenceRoot;
    this.reportsDir = fields.reportsDir;
    this.store = fields.store;
    this.registry = fields.registry;
    this.environments = fields.environments;
    this.agents = fields.agents;
    this.jobs = fields.jobs;
    this.logger = fields.logger;
    this.oracles = fields.oracles;
  }

  static async create(options: EngineOptions): Promise<Engine> {
    const logger = options.logger ?? createLogger();
    const { config, rootDir, path, resolvePath } = options.config;
    const store = options.store ?? openSqliteStore(resolvePath(config.store.path));
    await store.init();
    for (const target of config.targets) await store.targets.upsert(target);
    const registry = new AdapterRegistry({ rootDir, logger });
    for (const [name, loader] of Object.entries(options.adapters ?? {}))
      registry.register(name, loader);
    const providers = options.providers ?? createProviders(config, { env: options.env, logger });
    return new Engine({
      config,
      rootDir,
      configPath: path,
      evidenceRoot: resolvePath(config.evidenceDir),
      reportsDir: resolvePath(config.reportsDir),
      store,
      registry,
      environments: new EnvironmentManager({ rootDir, logger }),
      agents: new AgentRuntime({ providers, config: config.agents, store, logger }),
      jobs: new JobManager(store, logger),
      logger,
      oracles: options.oracles ?? resolveOracles(config.oracles.enabled),
    });
  }

  /** All configured targets, or the named ones (throws on unknown ids). */
  targets(ids?: string[]): TargetConfig[] {
    if (!ids || ids.length === 0) return this.config.targets;
    return ids.map((id) => this.target(id));
  }

  target(id: string): TargetConfig {
    const target = this.config.targets.find((candidate) => candidate.id === id);
    if (!target) {
      const known =
        this.config.targets.map((t) => t.id).join(', ') || 'none (run "mw setup" first)';
      throw new MutationWorkflowError(
        'TARGET_NOT_FOUND',
        `Unknown target "${id}". Configured targets: ${known}`,
      );
    }
    return target;
  }

  async status(): Promise<StatusSummary> {
    const targets: TargetStatus[] = [];
    for (const target of this.config.targets) {
      const live = {
        targetId: target.id,
        status: ['active', 'pending-review'] as Workflow['status'][],
      };
      const total = await this.store.workflows.count(live);
      const base = await this.store.workflows.count({ ...live, parentId: null });
      const bySeverity = {} as Record<Severity, number>;
      for (const severity of SeveritySchema.options) {
        bySeverity[severity] = await this.store.findings.count({
          targetId: target.id,
          status: ['open', 'confirmed'],
          severity,
        });
      }
      targets.push({
        id: target.id,
        kind: target.kind,
        name: target.name,
        workflows: {
          base,
          mutations: total - base,
          pendingReview: await this.store.workflows.count({
            targetId: target.id,
            status: 'pending-review',
          }),
        },
        runs: await this.store.runs.stats({ targetId: target.id }),
        findings: {
          open: await this.store.findings.count({ targetId: target.id, status: 'open' }),
          confirmed: await this.store.findings.count({ targetId: target.id, status: 'confirmed' }),
          bySeverity,
        },
        openQuestions: (await this.store.questions.list({ targetId: target.id, status: 'open' }))
          .length,
      });
    }
    const models: Partial<Record<AgentRole, string>> = {};
    if (this.agents.enabled) {
      for (const role of ROLES) {
        try {
          models[role] = this.agents.resolveModel(role).model;
        } catch {
          // Reported as missing; the error surfaces when the role is actually used.
        }
      }
    }
    return {
      project: {
        name: this.config.project.name,
        rootDir: this.rootDir,
        configPath: this.configPath,
      },
      targets,
      agents: {
        enabled: this.agents.enabled,
        providers: this.providerIds(),
        maxParallel: this.config.agents.maxParallel,
        models,
      },
      usage: await this.store.usage.totals(),
      openQuestions: (await this.store.questions.list({ status: 'open' })).length,
    };
  }

  /** Inspect the repository with agents and write the configuration and seed workflows. */
  setup(options: SetupOptions & AgentHooks = {}): Promise<SetupResult> {
    this.requireAgents('setup');
    const { jobId, signal, onEvent, ...rest } = options;
    return setup(
      {
        store: this.store,
        runtime: this.agents,
        registry: this.registry,
        environments: this.environments,
        rootDir: this.rootDir,
        configPath: this.configPath,
        existing: this.configPath ? this.config : undefined,
        logger: this.logger,
        jobId,
        signal,
        onEvent,
      },
      rest,
    );
  }

  /** Discover new workflows with explorer agents against a freshly started environment. */
  async explore(
    targetId: string,
    options: ExploreOptions & AgentHooks = {},
  ): Promise<ExploreResult> {
    this.requireAgents('explore');
    const target = this.target(targetId);
    const adapter = await this.registry.forTarget(target);
    const { jobId, signal, onEvent, ...rest } = options;
    return withEnvironment(this.environments, target, (env) =>
      explore(
        {
          store: this.store,
          runtime: this.agents,
          config: this.config,
          target,
          adapter,
          evidenceRoot: this.evidenceRoot,
          baseUrl: env.baseUrl,
          logger: this.logger,
          jobId,
          signal,
          onEvent,
        },
        rest,
      ),
    );
  }

  /** Derive mutation variants of a target's base workflows. */
  async mutate(targetId: string, options: MutateOptions & AgentHooks = {}): Promise<MutateResult> {
    const target = this.target(targetId);
    const adapter = await this.registry.forTarget(target);
    const { jobId, signal, onEvent, ...rest } = options;
    return mutate(
      {
        store: this.store,
        config: this.config,
        target,
        adapter,
        runtime: this.agents,
        logger: this.logger,
        jobId,
        signal,
        onEvent,
      },
      rest,
    );
  }

  /** Replay workflows, record runs, fold failures into findings, triage and report. */
  run(options: Omit<RunOptions, 'targets'> & { targetIds?: string[] }): Promise<RunSummary> {
    const { targetIds, ...rest } = options;
    return runWorkflows(
      {
        store: this.store,
        config: this.config,
        rootDir: this.rootDir,
        evidenceRoot: this.evidenceRoot,
        reportsDir: this.reportsDir,
        registry: this.registry,
        environments: this.environments,
        oracles: this.oracles,
        runtime: this.agents,
        logger: this.logger,
      },
      { ...rest, targets: this.targets(targetIds) },
    );
  }

  /** Review findings that are waiting for triage (optionally including ones skipped earlier). */
  async triage(
    options: { targetIds?: string[]; includeSkipped?: boolean } & AgentHooks = {},
  ): Promise<Finding[]> {
    this.requireAgents('triage');
    const updated: Finding[] = [];
    for (const target of this.targets(options.targetIds)) {
      const pending = await this.store.findings.list({
        targetId: target.id,
        status: 'open',
        triageState: 'pending',
      });
      const skipped = options.includeSkipped
        ? await this.store.findings.list({
            targetId: target.id,
            status: 'open',
            triageState: 'skipped',
          })
        : [];
      const candidates = [
        ...pending,
        ...skipped.map((f) => FindingSchema.parse({ ...f, triage: { state: 'pending' } })),
      ];
      if (candidates.length === 0) continue;
      updated.push(
        ...(await triageFindings(
          {
            store: this.store,
            runtime: this.agents,
            target,
            evidenceRoot: this.evidenceRoot,
            logger: this.logger,
            jobId: options.jobId,
            signal: options.signal,
            onEvent: options.onEvent,
          },
          candidates,
        )),
      );
    }
    return updated;
  }

  /**
   * Continuous mode: replay everything, mutate, and periodically explore, until aborted or the
   * cycle limit is reached. Exploration only happens when a model provider is configured.
   */
  async watch(options: WatchOptions): Promise<{ cycles: number }> {
    const { continuous } = this.config.schedule;
    const targets = this.targets(options.targetIds);
    const max = options.maxCycles ?? continuous.maxCycles;
    let cycle = 0;
    while (!options.signal.aborted && (max === undefined || cycle < max)) {
      cycle += 1;
      const exploreNow = this.agents.enabled && (cycle - 1) % continuous.exploreEveryCycles === 0;
      this.logger.info(`Cycle ${cycle}${exploreNow ? ' (with exploration)' : ''}`);
      for (const target of targets) {
        if (options.signal.aborted) break;
        if (exploreNow) {
          await this.explore(target.id, {
            jobId: options.jobId,
            signal: options.signal,
            onEvent: options.onEvent,
          }).catch((error: unknown) =>
            this.logger.error(`Exploration of "${target.id}" failed: ${String(error)}`),
          );
        }
        await this.mutate(target.id, { jobId: options.jobId }).catch((error: unknown) =>
          this.logger.error(`Mutation of "${target.id}" failed: ${String(error)}`),
        );
      }
      if (options.signal.aborted) break;
      const summary = await this.run({
        targetIds: targets.map((t) => t.id),
        trigger: 'continuous',
        jobId: options.jobId,
        signal: options.signal,
        onEvent: options.onEvent,
      });
      options.onCycle?.(cycle, summary);
      if (max !== undefined && cycle >= max) break;
      await sleep(continuous.idleMs, options.signal);
    }
    return { cycles: cycle };
  }

  /**
   * Record the team's answer to a question. Confirming an observed behaviour activates its
   * workflow; dismissing archives it; "bug" records a confirmed finding.
   */
  async answerQuestion(
    id: string,
    decision: QuestionDecision,
    answer?: string,
  ): Promise<AnswerResult> {
    const question = await this.store.questions.get(id);
    if (!question) throw new MutationWorkflowError('NOT_FOUND', `No question with id ${id}`);
    const now = nowIso();
    const updated = QuestionSchema.parse({
      ...question,
      status: 'answered',
      decision,
      answer,
      answeredAt: now,
    });
    await this.store.questions.update(updated);
    const result: AnswerResult = { question: updated };

    const workflow = question.context.workflowId
      ? await this.store.workflows.get(question.context.workflowId)
      : undefined;
    if (workflow) {
      if (decision === 'confirm' && workflow.status === 'pending-review') {
        result.workflow = WorkflowSchema.parse({ ...workflow, status: 'active', updatedAt: now });
        await this.store.workflows.update(result.workflow);
      } else if (decision === 'dismiss' && workflow.status === 'pending-review') {
        result.workflow = WorkflowSchema.parse({ ...workflow, status: 'archived', updatedAt: now });
        await this.store.workflows.update(result.workflow);
      } else if (decision === 'bug' && !question.context.findingId) {
        result.finding = FindingSchema.parse({
          id: newId('fnd'),
          targetId: workflow.targetId,
          fingerprint: fingerprint({ targetId: workflow.targetId, question: question.id }),
          title: `Unexpected behaviour in "${workflow.title}"`,
          summary: answer ?? question.question,
          severity: 'medium',
          detectedBy: 'human',
          status: 'confirmed',
          triage: {
            state: 'done',
            verdict: 'bug',
            rationale: answer ?? 'Reported while reviewing the workflow',
            at: now,
          },
          workflowIds: [workflow.id],
          runIds: question.context.runId ? [question.context.runId] : [],
          evidenceIds: question.context.evidenceIds,
          reproduction: {
            workflowId: workflow.id,
            steps: workflow.steps,
            mutation: workflow.mutation,
          },
          occurrences: 1,
          firstSeenAt: now,
          lastSeenAt: now,
        });
        await this.store.findings.insert(result.finding);
      }
    }

    const finding = question.context.findingId
      ? await this.store.findings.get(question.context.findingId)
      : undefined;
    if (finding) {
      const isBug = decision !== 'dismiss';
      result.finding = FindingSchema.parse({
        ...finding,
        status: isBug ? 'confirmed' : 'dismissed',
        triage: {
          state: 'done',
          verdict: isBug ? 'bug' : 'not-a-bug',
          rationale: answer ?? `Decided by the team (${decision})`,
          at: now,
        },
      });
      await this.store.findings.update(result.finding);
    }
    return result;
  }

  async updateFinding(
    id: string,
    patch: { status?: FindingStatus; notes?: string },
  ): Promise<Finding> {
    const finding = await this.store.findings.get(id);
    if (!finding) throw new MutationWorkflowError('NOT_FOUND', `No finding with id ${id}`);
    const updated = FindingSchema.parse({ ...finding, ...patch });
    await this.store.findings.update(updated);
    return updated;
  }

  /** Full-text search across the memory. */
  async search(
    query: string,
    options: { targetId?: string; limit?: number } = {},
  ): Promise<{ workflows: Workflow[]; findings: Finding[] }> {
    const [workflows, findings] = await Promise.all([
      this.store.workflows.search(query, options),
      this.store.findings.search(query, options),
    ]);
    return { workflows, findings };
  }

  async close(): Promise<void> {
    await this.registry.disposeAll();
    await this.store.close();
  }

  private providerIds(): string[] {
    const ids: string[] = [];
    for (const role of ROLES) {
      try {
        const id = this.agents.resolveModel(role).provider.id;
        if (!ids.includes(id)) ids.push(id);
      } catch {
        // No provider for this role.
      }
    }
    return ids;
  }

  private requireAgents(action: string): void {
    if (this.agents.enabled) return;
    throw new MutationWorkflowError(
      'PROVIDER_NOT_CONFIGURED',
      `"${action}" needs a model provider. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or add a providers section to the config.`,
    );
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
