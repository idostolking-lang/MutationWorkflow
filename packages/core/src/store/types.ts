import type {
  Evidence,
  Finding,
  FindingStatus,
  IsoDateTime,
  Job,
  JobKind,
  JobStatus,
  Question,
  Run,
  RunStatus,
  Severity,
  TargetConfig,
  Workflow,
  WorkflowOrigin,
  WorkflowStatus,
} from '../schema/index.js';

export interface Page {
  limit?: number;
  offset?: number;
}

export interface WorkflowFilter extends Page {
  targetId?: string;
  ids?: string[];
  origin?: WorkflowOrigin | WorkflowOrigin[];
  status?: WorkflowStatus | WorkflowStatus[];
  /** `null` selects base workflows only (no parent); a string selects one parent's variants. */
  parentId?: string | null;
  /** `true` selects mutation variants only, `false` base workflows only. */
  hasParent?: boolean;
  tag?: string;
}

export interface RunFilter extends Page {
  targetId?: string;
  workflowId?: string;
  status?: RunStatus | RunStatus[];
  jobId?: string;
  since?: IsoDateTime;
}

export interface FindingFilter extends Page {
  targetId?: string;
  status?: FindingStatus | FindingStatus[];
  severity?: Severity | Severity[];
  triageState?: Finding['triage']['state'];
}

export interface QuestionFilter extends Page {
  targetId?: string;
  status?: Question['status'];
}

export interface JobFilter extends Page {
  kind?: JobKind;
  status?: JobStatus | JobStatus[];
}

export interface RunStats {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  error: number;
  lastRunAt?: IsoDateTime;
}

export interface UsageRecord {
  jobId?: string;
  role: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
  at: IsoDateTime;
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/**
 * Persistent memory of everything the system knows about a project: workflows, runs,
 * findings, open questions, jobs and model usage. The default implementation is SQLite with
 * full-text search; the interface is async so remote stores can implement it too.
 */
export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;

  targets: {
    upsert(target: TargetConfig): Promise<void>;
    get(id: string): Promise<TargetConfig | undefined>;
    list(): Promise<TargetConfig[]>;
  };

  workflows: {
    insert(workflow: Workflow): Promise<void>;
    update(workflow: Workflow): Promise<void>;
    get(id: string): Promise<Workflow | undefined>;
    getByFingerprint(targetId: string, fingerprint: string): Promise<Workflow | undefined>;
    list(filter?: WorkflowFilter): Promise<Workflow[]>;
    count(filter?: WorkflowFilter): Promise<number>;
    search(query: string, options?: { targetId?: string; limit?: number }): Promise<Workflow[]>;
  };

  runs: {
    insert(run: Run): Promise<void>;
    get(id: string): Promise<Run | undefined>;
    list(filter?: RunFilter): Promise<Run[]>;
    latestForWorkflow(workflowId: string): Promise<Run | undefined>;
    stats(filter?: { targetId?: string; since?: IsoDateTime; jobId?: string }): Promise<RunStats>;
  };

  evidence: {
    insertMany(items: ReadonlyArray<Evidence>): Promise<void>;
    get(id: string): Promise<Evidence | undefined>;
    getMany(ids: ReadonlyArray<string>): Promise<Evidence[]>;
    listForRun(runId: string): Promise<Evidence[]>;
  };

  findings: {
    insert(finding: Finding): Promise<void>;
    update(finding: Finding): Promise<void>;
    get(id: string): Promise<Finding | undefined>;
    getByFingerprint(targetId: string, fingerprint: string): Promise<Finding | undefined>;
    list(filter?: FindingFilter): Promise<Finding[]>;
    count(filter?: FindingFilter): Promise<number>;
    search(query: string, options?: { targetId?: string; limit?: number }): Promise<Finding[]>;
  };

  questions: {
    insert(question: Question): Promise<void>;
    update(question: Question): Promise<void>;
    get(id: string): Promise<Question | undefined>;
    list(filter?: QuestionFilter): Promise<Question[]>;
  };

  jobs: {
    insert(job: Job): Promise<void>;
    update(job: Job): Promise<void>;
    get(id: string): Promise<Job | undefined>;
    list(filter?: JobFilter): Promise<Job[]>;
  };

  usage: {
    record(usage: UsageRecord): Promise<void>;
    totals(filter?: { jobId?: string; since?: IsoDateTime }): Promise<UsageTotals>;
  };

  meta: {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
  };
}
