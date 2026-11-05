/**
 * Ordered schema migrations for the SQLite store. Entry `n` upgrades a database from schema
 * version `n` to `n + 1`; `meta.schema_version` records how many have been applied. Never edit
 * a released migration: append a new one instead.
 *
 * Every record is stored whole as validated JSON in a `json` column; the other columns are
 * copies of the fields that filters, ordering and uniqueness need.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE targets (
    id TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    target_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    origin TEXT NOT NULL,
    status TEXT NOT NULL,
    parent_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    json TEXT NOT NULL,
    UNIQUE (target_id, fingerprint)
  );
  CREATE INDEX workflows_target_status ON workflows (target_id, status);
  CREATE INDEX workflows_parent ON workflows (parent_id);
  CREATE INDEX workflows_created ON workflows (created_at);

  CREATE VIRTUAL TABLE workflows_fts USING fts5 (id UNINDEXED, title, intent, tags, steps_text);

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    status TEXT NOT NULL,
    trigger TEXT NOT NULL,
    job_id TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    json TEXT NOT NULL
  );
  CREATE INDEX runs_workflow_started ON runs (workflow_id, started_at);
  CREATE INDEX runs_target_started ON runs (target_id, started_at);
  CREATE INDEX runs_job ON runs (job_id);

  CREATE TABLE evidence (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    session_id TEXT,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    json TEXT NOT NULL
  );
  CREATE INDEX evidence_run ON evidence (run_id);
  CREATE INDEX evidence_session ON evidence (session_id);

  CREATE TABLE findings (
    id TEXT PRIMARY KEY,
    target_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL,
    severity TEXT NOT NULL,
    triage_state TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    json TEXT NOT NULL,
    UNIQUE (target_id, fingerprint)
  );
  CREATE INDEX findings_target_status ON findings (target_id, status);
  CREATE INDEX findings_last_seen ON findings (last_seen_at);

  CREATE VIRTUAL TABLE findings_fts USING fts5 (id UNINDEXED, title, summary);

  CREATE TABLE questions (
    id TEXT PRIMARY KEY,
    target_id TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    json TEXT NOT NULL
  );
  CREATE INDEX questions_status ON questions (status, created_at);

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    json TEXT NOT NULL
  );
  CREATE INDEX jobs_created ON jobs (created_at);

  CREATE TABLE usage (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT,
    role TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    cost_usd REAL,
    at TEXT NOT NULL
  );
  CREATE INDEX usage_job ON usage (job_id);
  CREATE INDEX usage_at ON usage (at);
  `,
];

/** Created before migrations run, because it records which migrations have been applied. */
export const META_TABLE_SQL =
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)';
