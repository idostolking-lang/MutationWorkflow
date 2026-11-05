import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';
import {
  type Evidence,
  EvidenceSchema,
  type Finding,
  FindingSchema,
  type IsoDateTime,
  type Job,
  JobSchema,
  nowIso,
  type Question,
  QuestionSchema,
  type Run,
  RunSchema,
  type TargetConfig,
  TargetConfigSchema,
  type Workflow,
  WorkflowSchema,
} from '../schema/index.js';
import { MutationWorkflowError } from '../util/errors.js';
import { ensureDir } from '../util/fs.js';
import { META_TABLE_SQL, MIGRATIONS } from './migrations.js';
import type {
  FindingFilter,
  JobFilter,
  Page,
  QuestionFilter,
  RunFilter,
  RunStats,
  Store,
  UsageRecord,
  UsageTotals,
  WorkflowFilter,
} from './types.js';

type Row = Record<string, SQLOutputValue>;

let sqliteWarningFiltered = false;

/**
 * Node prints "ExperimentalWarning: SQLite is an experimental feature" the first time
 * `node:sqlite` loads. That is noise for users of a CLI, so filter exactly that warning and pass
 * every other one through. Remove this once node:sqlite is stable.
 */
function filterSqliteExperimentalWarning(): void {
  if (sqliteWarningFiltered) return;
  sqliteWarningFiltered = true;
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
    if (isSqliteExperimentalWarning(warning, rest[0])) return;
    Reflect.apply(emitWarning, process, [warning, ...rest]);
  }) as typeof process.emitWarning;
}

function isSqliteExperimentalWarning(warning: string | Error, typeOrOptions: unknown): boolean {
  let name: unknown = typeof warning === 'string' ? undefined : warning.name;
  if (typeof typeOrOptions === 'string') {
    name = typeOrOptions;
  } else if (
    typeof typeOrOptions === 'object' &&
    typeOrOptions !== null &&
    'type' in typeOrOptions
  ) {
    name = typeOrOptions.type;
  }
  const message = typeof warning === 'string' ? warning : warning.message;
  return name === 'ExperimentalWarning' && message.includes('SQLite');
}

filterSqliteExperimentalWarning();
// Loaded with require, after the filter is installed: a static import would load the module
// (and print the warning) before this file's body runs.
const { DatabaseSync: Database } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite');

/** How one record type maps onto its table. */
interface Entity<T> {
  readonly table: string;
  /** Indexed copies of record fields, in the order `values` returns them. */
  readonly columns: readonly string[];
  values(record: T): SQLInputValue[];
  parse(value: unknown): T;
  readonly fts?: {
    readonly table: string;
    readonly columns: readonly string[];
    values(record: T): string[];
  };
}

const TARGETS: Entity<TargetConfig> = {
  table: 'targets',
  columns: ['updated_at'],
  values: () => [nowIso()],
  parse: (value) => TargetConfigSchema.parse(value),
};

const WORKFLOWS: Entity<Workflow> = {
  table: 'workflows',
  columns: [
    'target_id',
    'fingerprint',
    'origin',
    'status',
    'parent_id',
    'created_at',
    'updated_at',
  ],
  values: (w) => [
    w.targetId,
    w.fingerprint,
    w.origin,
    w.status,
    w.parentId ?? null,
    w.createdAt,
    w.updatedAt,
  ],
  parse: (value) => WorkflowSchema.parse(value),
  fts: {
    table: 'workflows_fts',
    columns: ['title', 'intent', 'tags', 'steps_text'],
    values: (w) => [w.title, w.intent, w.tags.join(' '), stepsText(w)],
  },
};

const RUNS: Entity<Run> = {
  table: 'runs',
  columns: ['workflow_id', 'target_id', 'status', 'trigger', 'job_id', 'started_at', 'finished_at'],
  values: (r) => [
    r.workflowId,
    r.targetId,
    r.status,
    r.trigger,
    r.context.jobId ?? null,
    r.startedAt,
    r.finishedAt,
  ],
  parse: (value) => RunSchema.parse(value),
};

const EVIDENCE: Entity<Evidence> = {
  table: 'evidence',
  columns: ['run_id', 'session_id', 'kind', 'created_at'],
  values: (e) => [e.runId ?? null, e.sessionId ?? null, e.kind, e.createdAt],
  parse: (value) => EvidenceSchema.parse(value),
};

const FINDINGS: Entity<Finding> = {
  table: 'findings',
  columns: [
    'target_id',
    'fingerprint',
    'status',
    'severity',
    'triage_state',
    'first_seen_at',
    'last_seen_at',
  ],
  values: (f) => [
    f.targetId,
    f.fingerprint,
    f.status,
    f.severity,
    f.triage.state,
    f.firstSeenAt,
    f.lastSeenAt,
  ],
  parse: (value) => FindingSchema.parse(value),
  fts: {
    table: 'findings_fts',
    columns: ['title', 'summary'],
    values: (f) => [f.title, f.summary],
  },
};

const QUESTIONS: Entity<Question> = {
  table: 'questions',
  columns: ['target_id', 'status', 'created_at'],
  values: (q) => [q.targetId ?? null, q.status, q.createdAt],
  parse: (value) => QuestionSchema.parse(value),
};

const JOBS: Entity<Job> = {
  table: 'jobs',
  columns: ['kind', 'status', 'created_at'],
  values: (j) => [j.kind, j.status, j.createdAt],
  parse: (value) => JobSchema.parse(value),
};

/** Searchable text of a workflow's steps: notes, action types and string parameters. */
function stepsText(workflow: Workflow): string {
  const parts: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') parts.push(value);
    else if (Array.isArray(value)) for (const item of value) collect(item);
    else if (value && typeof value === 'object')
      for (const item of Object.values(value)) collect(item);
  };
  for (const step of workflow.steps) {
    if (step.note) parts.push(step.note);
    collect(step.action);
  }
  return parts.join(' ');
}

/**
 * Turn free text into an FTS5 query that cannot contain operators: every whitespace-separated
 * token becomes a quoted prefix phrase ("check"* matches "checkout"), and FTS5 combines
 * adjacent phrases with AND.
 */
function toFtsQuery(query: string): string | undefined {
  const tokens = query.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return undefined;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(' ');
}

function isFtsQueryError(error: unknown): boolean {
  return (
    error instanceof Error && /fts5|syntax error|unterminated|malformed MATCH/i.test(error.message)
  );
}

/** SQL WHERE clause assembled from fixed column names, with every value bound as a parameter. */
class Conditions {
  private readonly clauses: string[] = [];
  readonly params: SQLInputValue[] = [];

  /** `column = value`, or `column IN (...)` for an array; ignored when the value is undefined. */
  match(column: string, value: string | readonly string[] | undefined): this {
    if (value === undefined) return this;
    if (typeof value === 'string') return this.add(`${column} = ?`, value);
    if (value.length === 0) return this.add('0');
    return this.add(`${column} IN (${value.map(() => '?').join(', ')})`, ...value);
  }

  add(clause: string, ...params: SQLInputValue[]): this {
    this.clauses.push(clause);
    this.params.push(...params);
    return this;
  }

  get sql(): string {
    return this.clauses.length === 0 ? '' : ` WHERE ${this.clauses.join(' AND ')}`;
  }
}

function pageSql(page: Page, params: SQLInputValue[]): string {
  if (page.limit === undefined && page.offset === undefined) return '';
  params.push(page.limit ?? -1, page.offset ?? 0);
  return ' LIMIT ? OFFSET ?';
}

function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new Error(`Expected text in column "${column}", got ${typeof value}`);
  }
  return value;
}

function number(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

function workflowConditions(filter: WorkflowFilter): Conditions {
  const where = new Conditions()
    .match('target_id', filter.targetId)
    .match('id', filter.ids)
    .match('origin', filter.origin)
    .match('status', filter.status);
  if (filter.parentId === null) where.add('parent_id IS NULL');
  else where.match('parent_id', filter.parentId);
  if (filter.hasParent === true) where.add('parent_id IS NOT NULL');
  else if (filter.hasParent === false) where.add('parent_id IS NULL');
  if (filter.tag !== undefined) {
    where.add(
      "EXISTS (SELECT 1 FROM json_each(workflows.json, '$.tags') WHERE value = ?)",
      filter.tag,
    );
  }
  return where;
}

function runConditions(filter: Omit<RunFilter, keyof Page>): Conditions {
  const where = new Conditions()
    .match('target_id', filter.targetId)
    .match('workflow_id', filter.workflowId)
    .match('status', filter.status)
    .match('job_id', filter.jobId);
  if (filter.since !== undefined) where.add('started_at >= ?', filter.since);
  return where;
}

function findingConditions(filter: FindingFilter): Conditions {
  return new Conditions()
    .match('target_id', filter.targetId)
    .match('status', filter.status)
    .match('severity', filter.severity)
    .match('triage_state', filter.triageState);
}

/** Largest number of ids bound in one `IN (...)` list; well below SQLite's parameter limit. */
const IN_CHUNK = 500;

/**
 * {@link Store} backed by a single SQLite file through Node's built-in `node:sqlite`. Records are
 * stored whole as JSON and validated with their zod schemas when read; workflows and findings
 * are full-text indexed with FTS5. All calls are synchronous underneath.
 */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private closed = false;

  /** Open (or create) the database at `path`, which may be `:memory:`. Call {@link init} next. */
  constructor(path: string) {
    const memory = path === ':memory:';
    if (!memory) ensureDir(dirname(path));
    this.db = new Database(path);
    if (!memory) this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA synchronous = NORMAL');
  }

  /** Apply pending migrations. Safe to call on every start. */
  async init(): Promise<void> {
    this.db.exec(META_TABLE_SQL);
    const current = Number(this.readMeta('schema_version') ?? '0');
    if (!Number.isInteger(current) || current > MIGRATIONS.length) {
      throw new MutationWorkflowError(
        'INVALID_INPUT',
        `Database schema version ${current} is not supported (latest known: ${MIGRATIONS.length}); it was probably created by a newer MutationWorkflow`,
      );
    }
    if (current === MIGRATIONS.length) return;
    this.transaction(() => {
      for (const migration of MIGRATIONS.slice(current)) this.db.exec(migration);
      this.writeMeta('schema_version', String(MIGRATIONS.length));
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }

  readonly targets: Store['targets'] = {
    upsert: async (target) => {
      this.run(
        'INSERT INTO targets (id, updated_at, json) VALUES (?, ?, ?) ' +
          'ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, json = excluded.json',
        [target.id, ...TARGETS.values(target), JSON.stringify(target)],
      );
    },
    get: async (id) => this.getRecord(TARGETS, id),
    list: async () => this.listRecords(TARGETS, new Conditions(), 'id ASC'),
  };

  readonly workflows: Store['workflows'] = {
    insert: async (workflow) => this.insertRecord(WORKFLOWS, workflow.id, workflow),
    update: async (workflow) => this.updateRecord(WORKFLOWS, workflow.id, workflow),
    get: async (id) => this.getRecord(WORKFLOWS, id),
    getByFingerprint: async (targetId, fingerprint) =>
      this.listRecords(
        WORKFLOWS,
        new Conditions().match('target_id', targetId).match('fingerprint', fingerprint),
        'id',
      )[0],
    list: async (filter = {}) =>
      this.listRecords(WORKFLOWS, workflowConditions(filter), 'created_at ASC, id ASC', filter),
    count: async (filter = {}) => this.countRecords(WORKFLOWS, workflowConditions(filter)),
    search: async (query, options = {}) => this.search(WORKFLOWS, query, options),
  };

  readonly runs: Store['runs'] = {
    insert: async (run) => this.insertRecord(RUNS, run.id, run),
    get: async (id) => this.getRecord(RUNS, id),
    list: async (filter = {}) =>
      this.listRecords(RUNS, runConditions(filter), 'started_at DESC, id DESC', filter),
    latestForWorkflow: async (workflowId) =>
      this.listRecords(RUNS, runConditions({ workflowId }), 'started_at DESC, id DESC', {
        limit: 1,
      })[0],
    stats: async (filter = {}) => {
      const where = runConditions(filter);
      const rows = this.all(
        `SELECT status, COUNT(*) AS n, MAX(started_at) AS last FROM runs${where.sql} GROUP BY status`,
        where.params,
      );
      const stats: RunStats = { total: 0, passed: 0, failed: 0, blocked: 0, error: 0 };
      for (const row of rows) {
        const status = text(row, 'status');
        const count = number(row, 'n');
        const last = text(row, 'last');
        stats.total += count;
        if (
          status === 'passed' ||
          status === 'failed' ||
          status === 'blocked' ||
          status === 'error'
        ) {
          stats[status] += count;
        }
        if (stats.lastRunAt === undefined || last > stats.lastRunAt) stats.lastRunAt = last;
      }
      return stats;
    },
  };

  readonly evidence: Store['evidence'] = {
    insertMany: async (items) => {
      this.transaction(() => {
        for (const item of items) this.insertRow(EVIDENCE, item.id, item);
      });
    },
    get: async (id) => this.getRecord(EVIDENCE, id),
    getMany: async (ids) => {
      const found = new Map<string, Evidence>();
      for (let start = 0; start < ids.length; start += IN_CHUNK) {
        const chunk = ids.slice(start, start + IN_CHUNK);
        for (const item of this.listRecords(EVIDENCE, new Conditions().match('id', chunk), 'id')) {
          found.set(item.id, item);
        }
      }
      return ids.flatMap((id) => found.get(id) ?? []);
    },
    listForRun: async (runId) =>
      this.listRecords(EVIDENCE, new Conditions().match('run_id', runId), 'created_at ASC, id ASC'),
  };

  readonly findings: Store['findings'] = {
    insert: async (finding) => this.insertRecord(FINDINGS, finding.id, finding),
    update: async (finding) => this.updateRecord(FINDINGS, finding.id, finding),
    get: async (id) => this.getRecord(FINDINGS, id),
    getByFingerprint: async (targetId, fingerprint) =>
      this.listRecords(
        FINDINGS,
        new Conditions().match('target_id', targetId).match('fingerprint', fingerprint),
        'id',
      )[0],
    list: async (filter = {}) =>
      this.listRecords(FINDINGS, findingConditions(filter), 'last_seen_at DESC, id DESC', filter),
    count: async (filter = {}) => this.countRecords(FINDINGS, findingConditions(filter)),
    search: async (query, options = {}) => this.search(FINDINGS, query, options),
  };

  readonly questions: Store['questions'] = {
    insert: async (question) => this.insertRecord(QUESTIONS, question.id, question),
    update: async (question) => this.updateRecord(QUESTIONS, question.id, question),
    get: async (id) => this.getRecord(QUESTIONS, id),
    list: async (filter: QuestionFilter = {}) =>
      this.listRecords(
        QUESTIONS,
        new Conditions().match('target_id', filter.targetId).match('status', filter.status),
        'created_at ASC, id ASC',
        filter,
      ),
  };

  readonly jobs: Store['jobs'] = {
    insert: async (job) => this.insertRecord(JOBS, job.id, job),
    update: async (job) => this.updateRecord(JOBS, job.id, job),
    get: async (id) => this.getRecord(JOBS, id),
    list: async (filter: JobFilter = {}) =>
      this.listRecords(
        JOBS,
        new Conditions().match('kind', filter.kind).match('status', filter.status),
        'created_at DESC, id DESC',
        filter,
      ),
  };

  readonly usage: Store['usage'] = {
    record: async (usage: UsageRecord) => {
      this.run(
        'INSERT INTO usage (job_id, role, provider, model, input_tokens, output_tokens, ' +
          'cache_read_tokens, cache_write_tokens, cost_usd, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          usage.jobId ?? null,
          usage.role,
          usage.provider,
          usage.model,
          usage.inputTokens,
          usage.outputTokens,
          usage.cacheReadTokens,
          usage.cacheWriteTokens,
          usage.costUsd ?? null,
          usage.at,
        ],
      );
    },
    totals: async (filter: { jobId?: string; since?: IsoDateTime } = {}): Promise<UsageTotals> => {
      const where = new Conditions().match('job_id', filter.jobId);
      if (filter.since !== undefined) where.add('at >= ?', filter.since);
      const row = this.all(
        'SELECT COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output, ' +
          'SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, ' +
          `SUM(COALESCE(cost_usd, 0)) AS cost FROM usage${where.sql}`,
        where.params,
      )[0];
      return {
        calls: row ? number(row, 'calls') : 0,
        inputTokens: row ? number(row, 'input') : 0,
        outputTokens: row ? number(row, 'output') : 0,
        cacheReadTokens: row ? number(row, 'cache_read') : 0,
        cacheWriteTokens: row ? number(row, 'cache_write') : 0,
        costUsd: row ? number(row, 'cost') : 0,
      };
    },
  };

  readonly meta: Store['meta'] = {
    get: async (key) => this.readMeta(key),
    set: async (key, value) => this.writeMeta(key, value),
  };

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private all(sql: string, params: readonly SQLInputValue[] = []): Row[] {
    return this.statement(sql).all(...params);
  }

  private run(sql: string, params: readonly SQLInputValue[]): number {
    return Number(this.statement(sql).run(...params).changes);
  }

  private transaction(work: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      work();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private readMeta(key: string): string | undefined {
    const row = this.all('SELECT value FROM meta WHERE key = ?', [key])[0];
    return row ? text(row, 'value') : undefined;
  }

  private writeMeta(key: string, value: string): void {
    this.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      [key, value],
    );
  }

  private insertRecord<T>(entity: Entity<T>, id: string, record: T): void {
    if (entity.fts) this.transaction(() => this.insertRow(entity, id, record));
    else this.insertRow(entity, id, record);
  }

  private insertRow<T>(entity: Entity<T>, id: string, record: T): void {
    const columns = ['id', ...entity.columns, 'json'];
    this.run(
      `INSERT INTO ${entity.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      [id, ...entity.values(record), JSON.stringify(record)],
    );
    this.insertFts(entity, id, record);
  }

  private updateRecord<T>(entity: Entity<T>, id: string, record: T): void {
    const assignments = [...entity.columns, 'json'].map((column) => `${column} = ?`).join(', ');
    this.transaction(() => {
      const changes = this.run(`UPDATE ${entity.table} SET ${assignments} WHERE id = ?`, [
        ...entity.values(record),
        JSON.stringify(record),
        id,
      ]);
      if (changes === 0) {
        throw new MutationWorkflowError('NOT_FOUND', `No ${entity.table} record with id "${id}"`);
      }
      if (entity.fts) {
        this.run(`DELETE FROM ${entity.fts.table} WHERE id = ?`, [id]);
        this.insertFts(entity, id, record);
      }
    });
  }

  private insertFts<T>(entity: Entity<T>, id: string, record: T): void {
    if (!entity.fts) return;
    const columns = ['id', ...entity.fts.columns];
    this.run(
      `INSERT INTO ${entity.fts.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      [id, ...entity.fts.values(record)],
    );
  }

  private getRecord<T>(entity: Entity<T>, id: string): T | undefined {
    return this.listRecords(entity, new Conditions().match('id', id), 'id')[0];
  }

  private listRecords<T>(
    entity: Entity<T>,
    where: Conditions,
    orderBy: string,
    page: Page = {},
  ): T[] {
    const params = [...where.params];
    const sql = `SELECT json FROM ${entity.table}${where.sql} ORDER BY ${orderBy}${pageSql(page, params)}`;
    return this.all(sql, params).map((row) => entity.parse(JSON.parse(text(row, 'json'))));
  }

  private countRecords<T>(entity: Entity<T>, where: Conditions): number {
    const row = this.all(`SELECT COUNT(*) AS n FROM ${entity.table}${where.sql}`, where.params)[0];
    return row ? number(row, 'n') : 0;
  }

  private search<T>(
    entity: Entity<T>,
    query: string,
    options: { targetId?: string; limit?: number },
  ): T[] {
    const fts = entity.fts;
    const match = toFtsQuery(query);
    if (!fts || match === undefined) return [];
    const where = new Conditions().add(`${fts.table} MATCH ?`, match);
    if (options.targetId !== undefined) where.add('r.target_id = ?', options.targetId);
    const sql =
      `SELECT r.json FROM ${fts.table} JOIN ${entity.table} r ON r.id = ${fts.table}.id` +
      `${where.sql} ORDER BY ${fts.table}.rank LIMIT ?`;
    try {
      return this.all(sql, [...where.params, options.limit ?? 20]).map((row) =>
        entity.parse(JSON.parse(text(row, 'json'))),
      );
    } catch (error) {
      if (isFtsQueryError(error)) return [];
      throw error;
    }
  }
}

/**
 * Open the SQLite store at `path` (created with its parent directory when missing; `:memory:`
 * for a throwaway database). Call `init()` before use to apply migrations.
 */
export function openSqliteStore(path: string): Store {
  return new SqliteStore(path);
}
