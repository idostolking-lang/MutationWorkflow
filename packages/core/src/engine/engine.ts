import type { Provider } from '../agents/provider.js';
import { createProviders } from '../agents/providers/index.js';
import { type AgentEvent, AgentRuntime } from '../agents/runtime.js';
import { loadConfig, type ResolvedConfig } from '../config/load.js';
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
  redactTarget,
  type Severity,
  SeveritySchema,
  type TargetConfig,
  type Workflow,
  WorkflowSchema,
  type WorkflowStatus,
} from '../schema/index.js';
import { openSqliteStore } from '../store/sqlite.js';
import type { RunStats, Store, UsageTotals } from '../store/types.js';
import { errorMessage, MutationWorkflowError } from '../util/errors.js';
import { createLogger, type Logger } from '../util/logger.js';
import { type AdapterLoader, AdapterRegistry } from './adapters.js';
import {
  ExplorationSession,
  type ExploreOptions,
  type ExploreResult,
  explore,
  explorerInstructions,
} from './explore.js';
import { JobManager } from './jobs.js';
import {
  applyAgentVariants,
  type MutateOptions,
  type MutateResult,
  type MutationBrief,
  mutate,
  mutationBrief,
} from './mutate.js';
import { type RunOptions, type RunSummary, runWorkflows } from './run.js';
import {
  applyInspectionReport,
  type InspectionBrief,
  inspectionBrief,
  type SetupContext,
  type SetupOptions,
  type SetupResult,
  setup,
} from './setup.js';
import {
  applyTriageDecisions,
  TRIAGE_BATCH_SIZE,
  type TriageBrief,
  triageBrief,
  triageFindings,
} from './triage.js';

export interface EngineOptions {
  config: ResolvedConfig;
  logger?: Logger;
  /** Adapter loaders by kind or package name; the CLI registers the built-in web and cli adapters. */
  adapters?: Record<string, AdapterLoader>;
  /** Override the providers built from the config (tests use a fake provider). */
  providers?: Map<string, Provider>;
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
    /** Model per role, or the driver's own default when the role runs through a coding agent. */
    models: Partial<Record<AgentRole, string>>;
    /** Roles that cannot run with the current configuration, with the reason. */
    problems: string[];
  };
  usage: UsageTotals;
  openQuestions: number;
}

export interface WatchOptions extends Pick<AgentHooks, 'jobId' | 'onEvent'> {
  targetIds?: string[];
  signal: AbortSignal;
  maxCycles?: number;
  onCycle?: (cycle: number, summary: RunSummary | undefined, error?: string) => void;
}

export interface AnswerResult {
  question: Question;
  workflow?: Workflow;
  finding?: Finding;
}

/**
 * A live exploration driven from outside the engine: a coding agent connected over MCP calls the
 * session's tools one at a time and closes the handle when done. The environment the session
 * runs against stays up until then.
 */
export interface ExplorationHandle {
  id: string;
  targetId: string;
  instructions: { system: string; task: string };
  session: ExplorationSession;
  openedAt: string;
  close(): Promise<{ workflows: Workflow[]; questions: Question[] }>;
}

const ROLES: AgentRole[] = ['inspector', 'explorer', 'mutator', 'triager'];

/**
 * The engine wires configuration, memory, adapters, environments and agents together and
 * exposes every operation the CLI and the MCP server offer. One instance per project. Agent
 * roles can be run three ways: by the in-process runtime against a model API, by a coding
 * agent's command line through a driver, or by a coding agent connected over MCP that asks for a
 * brief, does the thinking itself, and submits the result.
 */
export class Engine {
  readonly rootDir: string;
  readonly store: Store;
  readonly registry: AdapterRegistry;
  readonly environments: EnvironmentManager;
  readonly jobs: JobManager;
  readonly logger: Logger;
  private current: Config;
  private currentPath: string | undefined;
  private currentEvidenceRoot: string;
  private currentReportsDir: string;
  private currentAgents: AgentRuntime;
  private currentOracles: Oracle[];

  private constructor(
    private readonly options: EngineOptions,
    resolved: ResolvedConfig,
    fields: {
      store: Store;
      registry: AdapterRegistry;
      environments: EnvironmentManager;
      jobs: JobManager;
      logger: Logger;
    },
  ) {
    this.rootDir = resolved.rootDir;
    this.store = fields.store;
    this.registry = fields.registry;
    this.environments = fields.environments;
    this.jobs = fields.jobs;
    this.logger = fields.logger;
    this.current = resolved.config;
    this.currentPath = resolved.path;
    this.currentEvidenceRoot = resolved.resolvePath(resolved.config.evidenceDir);
    this.currentReportsDir = resolved.resolvePath(resolved.config.reportsDir);
    this.currentOracles = options.oracles ?? resolveOracles(resolved.config.oracles.enabled);
    this.currentAgents = this.buildAgents(resolved.config);
  }

  static async create(options: EngineOptions): Promise<Engine> {
    const logger = options.logger ?? createLogger();
    const { config, rootDir, resolvePath } = options.config;
    const store = options.store ?? openSqliteStore(resolvePath(config.store.path));
    await store.init();
    for (const target of config.targets) await store.targets.upsert(redactTarget(target));
    const registry = new AdapterRegistry({ rootDir, logger });
    for (const [name, loader] of Object.entries(options.adapters ?? {})) {
      registry.register(name, loader);
    }
    const jobs = new JobManager(store, logger);
    const recovered = await jobs.recover();
    if (recovered > 0) {
      logger.warn(`Marked ${recovered} interrupted job(s) from a previous process as failed`);
    }
    return new Engine(options, options.config, {
      store,
      registry,
      environments: new EnvironmentManager({ rootDir, logger }),
      jobs,
      logger,
    });
  }

  get config(): Config {
    return this.current;
  }

  get configPath(): string | undefined {
    return this.currentPath;
  }

  get evidenceRoot(): string {
    return this.currentEvidenceRoot;
  }

  get reportsDir(): string {
    return this.currentReportsDir;
  }

  get agents(): AgentRuntime {
    return this.currentAgents;
  }

  get oracles(): Oracle[] {
    return this.currentOracles;
  }

  /**
   * Re-read the configuration file and rewire what depends on it (targets, agents, oracles,
   * directories). Used after setup wrote a config into a project that had none. The database
   * stays the one this engine was opened with.
   */
  async reloadConfig(): Promise<void> {
    const resolved = loadConfig({ cwd: this.rootDir });
    this.current = resolved.config;
    this.currentPath = resolved.path;
    this.currentEvidenceRoot = resolved.resolvePath(resolved.config.evidenceDir);
    this.currentReportsDir = resolved.resolvePath(resolved.config.reportsDir);
    this.currentOracles = this.options.oracles ?? resolveOracles(resolved.config.oracles.enabled);
    this.currentAgents = this.buildAgents(resolved.config);
    for (const target of resolved.config.targets) {
      await this.store.targets.upsert(redactTarget(target));
    }
    this.logger.info(`Configuration reloaded from ${resolved.path}`);
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
          base: await this.store.workflows.count({ ...live, hasParent: false }),
          mutations: await this.store.workflows.count({ ...live, hasParent: true }),
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
    const problems: string[] = [];
    if (this.agents.enabled) {
      for (const role of ROLES) {
        try {
          const resolved = this.agents.resolveModel(role);
          models[role] = resolved.model ?? `${resolved.provider.id} (its own default)`;
        } catch (error) {
          problems.push(`${role}: ${errorMessage(error)}`);
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
        problems,
      },
      usage: await this.store.usage.totals(),
      openQuestions: (await this.store.questions.list({ status: 'open' })).length,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Agent-driven operations: in-process runtime or coding-agent driver.

  /**
   * Inspect the repository with agents and write the configuration and seed workflows. When a
   * config is created, the engine reloads it so the new targets are usable right away.
   */
  async setup(options: SetupOptions & AgentHooks = {}): Promise<SetupResult> {
    this.requireAgents('setup', 'inspector');
    const { jobId, signal, onEvent, ...rest } = options;
    const result = await setup(
      { ...this.setupContext(), runtime: this.agents, jobId, signal, onEvent },
      rest,
    );
    if (result.configAction === 'created') await this.reloadConfig();
    return result;
  }

  /** Discover new workflows with explorer agents against a freshly started environment. */
  async explore(
    targetId: string,
    options: ExploreOptions & AgentHooks = {},
  ): Promise<ExploreResult> {
    this.requireAgents('explore', 'explorer');
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
    if (options.agent) this.requireAgents('mutate --agent', 'mutator');
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
  async run(options: Omit<RunOptions, 'targets'> & { targetIds?: string[] }): Promise<RunSummary> {
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
    this.requireAgents('triage', 'triager');
    const updated: Finding[] = [];
    for (const target of this.targets(options.targetIds)) {
      const candidates = await this.triageCandidates(target.id, options.includeSkipped ?? false);
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
   * cycle limit is reached. Exploration only happens when a model provider is configured. A
   * failing cycle is reported and the loop carries on.
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
      try {
        for (const target of targets) {
          if (options.signal.aborted) break;
          if (exploreNow) {
            await this.explore(target.id, {
              jobId: options.jobId,
              signal: options.signal,
              onEvent: options.onEvent,
            }).catch((error: unknown) =>
              this.logger.error(`Exploration of "${target.id}" failed: ${errorMessage(error)}`),
            );
          }
          await this.mutate(target.id, { jobId: options.jobId }).catch((error: unknown) =>
            this.logger.error(`Mutation of "${target.id}" failed: ${errorMessage(error)}`),
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
      } catch (error) {
        const message = errorMessage(error);
        this.logger.error(`Cycle ${cycle} failed: ${message}`);
        options.onCycle?.(cycle, undefined, message);
      }
      if (max !== undefined && cycle >= max) break;
      await sleep(continuous.idleMs, options.signal);
    }
    return { cycles: cycle };
  }

  // ---------------------------------------------------------------------------------------------
  // Client-driven operations: a coding agent connected over MCP does the thinking itself.

  /** The inspector's instructions and report schema, for a client that inspects the repo itself. */
  inspectionBrief(options: SetupOptions = {}): Promise<InspectionBrief> {
    return inspectionBrief(this.setupContext(), options);
  }

  /** Apply a report produced by a client; creates the config (and reloads it) or a proposal. */
  async applyInspectionReport(report: unknown, options: SetupOptions = {}): Promise<SetupResult> {
    const result = await applyInspectionReport(this.setupContext(), report, options);
    if (result.configAction === 'created') await this.reloadConfig();
    return result;
  }

  /**
   * Start an exploration a client drives itself: the environment comes up, a session opens, and
   * the handle exposes the session's tools together with the explorer's instructions.
   */
  async openExploration(
    targetId: string,
    options: { focus?: string[]; maxWorkflows?: number; vision?: boolean } = {},
  ): Promise<ExplorationHandle> {
    const target = this.target(targetId);
    const adapter = await this.registry.forTarget(target);
    const env = await this.environments.start(target);
    const known = await this.store.workflows.list({
      targetId: target.id,
      parentId: null,
      status: ['active', 'pending-review'],
    });
    const maxWorkflows = options.maxWorkflows ?? this.config.exploration.maxWorkflows;
    const deps = {
      store: this.store,
      config: this.config,
      target,
      adapter,
      evidenceRoot: this.evidenceRoot,
      logger: this.logger,
    };
    const session = new ExplorationSession(deps, {
      vision: options.vision ?? true,
      shared: { titles: new Set(known.map((w) => w.title)), saved: 0, budget: maxWorkflows },
    });
    try {
      await session.open();
    } catch (error) {
      await env.stop();
      throw error;
    }
    const assignment =
      options.focus && options.focus.length > 0
        ? options.focus.join('; ')
        : 'the main user journeys first, then edge cases and recovery paths';
    const instructions = explorerInstructions(deps, {
      assignment,
      maxWorkflows,
      knownTitles: known.map((w) => w.title),
      baseUrl: env.baseUrl,
    });
    let closed: Promise<{ workflows: Workflow[]; questions: Question[] }> | undefined;
    return {
      id: session.id,
      targetId: target.id,
      instructions,
      session,
      openedAt: nowIso(),
      close: () => {
        closed ??= (async () => {
          await session.close();
          await env.stop();
          return { workflows: session.saved, questions: session.questions };
        })();
        return closed;
      },
    };
  }

  /**
   * Pending findings of one target with the triager's instructions, for a client that judges
   * them itself. Returns undefined when nothing is waiting.
   */
  async triageBrief(
    options: { targetId?: string; includeSkipped?: boolean; limit?: number } = {},
  ): Promise<(TriageBrief & { targetId: string }) | undefined> {
    const targets = options.targetId ? [this.target(options.targetId)] : this.config.targets;
    for (const target of targets) {
      const candidates = await this.triageCandidates(target.id, options.includeSkipped ?? false);
      if (candidates.length === 0) continue;
      const batch = candidates.slice(0, options.limit ?? TRIAGE_BATCH_SIZE);
      const brief = await triageBrief({ store: this.store, target, logger: this.logger }, batch);
      return { ...brief, targetId: target.id };
    }
    return undefined;
  }

  /** Apply triage decisions a client made; the findings are looked up by the ids it names. */
  async applyTriageDecisions(decision: unknown, decidedBy = 'client'): Promise<Finding[]> {
    const ids = extractFindingIds(decision);
    const batch: Finding[] = [];
    for (const id of ids) {
      const finding = await this.store.findings.get(id);
      if (finding) batch.push(finding);
    }
    if (batch.length === 0) {
      throw new MutationWorkflowError(
        'NOT_FOUND',
        'None of the decisions name an existing finding',
      );
    }
    const byTarget = new Map<string, Finding[]>();
    for (const finding of batch) {
      const list = byTarget.get(finding.targetId) ?? [];
      list.push(finding);
      byTarget.set(finding.targetId, list);
    }
    const updated: Finding[] = [];
    for (const [targetId, findings] of byTarget) {
      updated.push(
        ...(await applyTriageDecisions(
          { store: this.store, target: this.target(targetId), logger: this.logger },
          findings,
          decision,
          decidedBy,
        )),
      );
    }
    return updated;
  }

  /** The mutator's instructions for one base workflow, for a client that proposes variants itself. */
  async mutationBrief(workflowId: string): Promise<MutationBrief & { workflowId: string }> {
    const workflow = await this.workflow(workflowId);
    const target = this.target(workflow.targetId);
    const adapter = await this.registry.forTarget(target);
    const brief = await mutationBrief(
      { store: this.store, target, adapter, logger: this.logger },
      workflow,
    );
    return { ...brief, workflowId };
  }

  /** Store variants a client proposed for a base workflow. */
  async applyAgentVariants(workflowId: string, variants: unknown): Promise<Workflow[]> {
    const workflow = await this.workflow(workflowId);
    const target = this.target(workflow.targetId);
    const adapter = await this.registry.forTarget(target);
    return applyAgentVariants(
      { store: this.store, target, adapter, logger: this.logger },
      workflow,
      variants,
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Memory operations.

  /**
   * Record the team's answer to a question. For a question about observed behaviour: confirm
   * activates the workflow, dismiss archives it, bug records a confirmed finding. For a question
   * about a finding: bug confirms it, confirm (the behaviour is intended) and dismiss close it.
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

    if (question.context.findingId) {
      // A question about a finding decides that finding and leaves its workflow alone.
      const finding = await this.store.findings.get(question.context.findingId);
      if (finding) {
        const isBug = decision === 'bug';
        result.finding = FindingSchema.parse({
          ...finding,
          status: isBug ? 'confirmed' : 'dismissed',
          triage: {
            state: 'done',
            verdict: isBug ? 'bug' : 'not-a-bug',
            rationale:
              answer ??
              (decision === 'confirm'
                ? 'The team confirmed this behaviour is intended'
                : decision === 'bug'
                  ? 'Confirmed as a bug by the team'
                  : 'Dismissed by the team'),
            at: now,
          },
        });
        await this.store.findings.update(result.finding);
      }
      return result;
    }

    const workflow = question.context.workflowId
      ? await this.store.workflows.get(question.context.workflowId)
      : undefined;
    if (!workflow) return result;

    if (decision === 'bug') {
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
      return result;
    }

    if (workflow.status === 'pending-review') {
      result.workflow = await this.setWorkflowStatus(
        workflow,
        decision === 'confirm' ? 'active' : 'archived',
        now,
      );
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

  // ---------------------------------------------------------------------------------------------

  private async workflow(id: string): Promise<Workflow> {
    const workflow = await this.store.workflows.get(id);
    if (!workflow)
      throw new MutationWorkflowError('WORKFLOW_NOT_FOUND', `No workflow with id ${id}`);
    return workflow;
  }

  private async triageCandidates(targetId: string, includeSkipped: boolean): Promise<Finding[]> {
    const pending = await this.store.findings.list({
      targetId,
      status: 'open',
      triageState: 'pending',
    });
    const skipped = includeSkipped
      ? await this.store.findings.list({ targetId, status: 'open', triageState: 'skipped' })
      : [];
    return [
      ...pending,
      ...skipped.map((f) => FindingSchema.parse({ ...f, triage: { state: 'pending' } })),
    ];
  }

  private setupContext(): SetupContext {
    return {
      store: this.store,
      registry: this.registry,
      environments: this.environments,
      rootDir: this.rootDir,
      configPath: this.configPath,
      existing: this.configPath ? this.config : undefined,
      logger: this.logger,
    };
  }

  /** Change a workflow's status and propagate it to its mutation variants. */
  private async setWorkflowStatus(
    workflow: Workflow,
    status: WorkflowStatus,
    at: string,
  ): Promise<Workflow> {
    const updated = WorkflowSchema.parse({ ...workflow, status, updatedAt: at });
    await this.store.workflows.update(updated);
    for (const variant of await this.store.workflows.list({ parentId: workflow.id })) {
      await this.store.workflows.update(
        WorkflowSchema.parse({ ...variant, status, updatedAt: at }),
      );
    }
    return updated;
  }

  private buildAgents(config: Config): AgentRuntime {
    const providers =
      this.options.providers ??
      createProviders(config, {
        env: this.options.env,
        logger: this.logger,
        rootDir: this.rootDir,
      });
    return new AgentRuntime({
      providers,
      config: config.agents,
      store: this.store,
      logger: this.logger,
    });
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

  /** Agent operations need a provider and a model for the role; fail early with guidance. */
  private requireAgents(action: string, role: AgentRole): void {
    if (!this.agents.enabled) {
      throw new MutationWorkflowError(
        'PROVIDER_NOT_CONFIGURED',
        `"${action}" needs a model provider. Install Claude Code or Codex, set ANTHROPIC_API_KEY or OPENAI_API_KEY, or add a providers section to the config. A coding agent connected over MCP can also do this itself through the brief tools.`,
      );
    }
    this.agents.resolveModel(role);
  }
}

/** Finding ids named in a decision document, before full validation. */
function extractFindingIds(decision: unknown): string[] {
  if (!decision || typeof decision !== 'object') return [];
  const list = (decision as { decisions?: unknown }).decisions;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) =>
    entry &&
    typeof entry === 'object' &&
    typeof (entry as { findingId?: unknown }).findingId === 'string'
      ? [(entry as { findingId: string }).findingId]
      : [],
  );
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
