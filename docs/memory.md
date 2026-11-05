# Memory

Everything MutationWorkflow learns about a project persists in a local memory: the targets, every
workflow (discovered, imported, mutated), every run with its steps, assertions, signals and oracle
verdicts, the evidence files, deduplicated findings, open questions, background jobs and model
usage. It is a single SQLite database with full-text search, plus directories for evidence and
reports, all under `.mutationworkflow/` by default. This page describes the layout, the tables,
search semantics, how to inspect and back up the data, and what you can safely delete.

Related: [README](../README.md) · [Configuration](configuration.md#where-files-live) ·
[Workflows](workflows.md) · [Oracles](oracles.md) · [Agents](agents.md) · [CLI](cli.md) ·
[MCP](mcp.md)

## Layout

| Path (default)                                    | Config key    | Contents                                                                       |
| ------------------------------------------------- | ------------- | ------------------------------------------------------------------------------ |
| `.mutationworkflow/mw.db`                         | `store.path`  | SQLite database (WAL mode: `mw.db-wal` and `mw.db-shm` exist while it is open) |
| `.mutationworkflow/evidence/runs/<runId>/`        | `evidenceDir` | Evidence of one replay                                                         |
| `.mutationworkflow/evidence/explore/<sessionId>/` | `evidenceDir` | Evidence of one explorer session                                               |
| `.mutationworkflow/reports/<timestamp>-run.md`    | `reportsDir`  | One Markdown report per run command                                            |
| `.mutationworkflow/setup-proposal.yaml`           |               | Setup's proposal when a config already existed                                 |

Relative paths resolve against the directory of the config file. The database and its directory
are created on first use. It uses Node's built-in `node:sqlite` (Node 22.13 or later); no
native module is installed.

Evidence files are named `NNN-<label>.<ext>` in order of capture, for example
`003-2-click.png` (the screenshot after step index 2, a click) or `001-observe.png`. The database
stores evidence paths relative to the evidence directory, so the directory can move.

## Tables

Every record is stored whole as validated JSON in a `json` column; the other columns are indexed
copies of the fields used for filtering, ordering and uniqueness. Reading a row validates it
against its schema again.

| Table           | One row per            | Indexed columns                                                                                                                      |
| --------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `meta`          | Key/value setting      | `key`, `value` (`schema_version` = number of migrations applied)                                                                     |
| `targets`       | Target from the config | `id`, `updated_at`; upserted from the config on every start, never deleted                                                           |
| `workflows`     | Workflow               | `target_id`, `fingerprint`, `origin`, `status`, `parent_id`, `created_at`, `updated_at`; unique `(target_id, fingerprint)`           |
| `workflows_fts` | Workflow (FTS5)        | `id` (unindexed), `title`, `intent`, `tags`, `steps_text`                                                                            |
| `runs`          | Run                    | `workflow_id`, `target_id`, `status`, `trigger`, `job_id`, `started_at`, `finished_at`                                               |
| `evidence`      | Evidence item          | `run_id`, `session_id`, `kind`, `created_at`                                                                                         |
| `findings`      | Finding                | `target_id`, `fingerprint`, `status`, `severity`, `triage_state`, `first_seen_at`, `last_seen_at`; unique `(target_id, fingerprint)` |
| `findings_fts`  | Finding (FTS5)         | `id` (unindexed), `title`, `summary`                                                                                                 |
| `questions`     | Question               | `target_id`, `status`, `created_at`                                                                                                  |
| `jobs`          | Job                    | `kind`, `status`, `created_at`                                                                                                       |
| `usage`         | Model call             | `seq`, `job_id`, `role`, `provider`, `model`, token counts, `cost_usd`, `at`                                                         |

Record shapes are documented in [Workflows](workflows.md#the-record) (workflows, runs, evidence)
and [Oracles](oracles.md) (findings, questions). Ids carry a prefix and sort by creation time:
`wf_`, `run_`, `ev_`, `fnd_`, `q_`, `job_`, `ses_` (explorer sessions). Target ids are the ids from the config.

Migrations are applied in order on every start and recorded in `meta.schema_version`. A database
written by a newer MutationWorkflow (higher schema version) is refused rather than misread.

## Full-text search

Search covers workflows and findings, optionally restricted to a target, ranked by FTS5
relevance, 20 results by default.

| Indexed text | Workflows                                                                                                                       | Findings       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Fields       | title, intent, tags, step notes, and every string parameter of each action, nested ones included (`url`, `value`, `key`, ...)   | title, summary |

Nested parameters include locators, so searching "Save" also finds a workflow that clicks
`{ "role": "button", "name": "Save" }`; the role, name, text, label, placeholder and test id of a
locator are all indexed. Expectations (assertions) are not indexed.

Query semantics:

- The query is split on whitespace. Each token becomes a quoted **prefix** phrase, so `check`
  matches "checkout" and "checked".
- Tokens are combined with AND: `edit save` finds records containing words starting with
  "edit" and with "save", anywhere in the indexed fields.
- Quotes and FTS operators in the input are treated as literal text; there is no OR, NOT,
  NEAR or column filter. A token containing punctuation is matched as a phrase of its parts
  (`api/todos` matches "api todos"). Matching is case-insensitive.
- An empty query or one FTS5 cannot parse returns no results rather than an error.

## Inspecting the database

Use the `sqlite3` CLI (3.38 or later for the `->>` operator; `json_extract` works everywhere).
Opening the database read-only is safe while MutationWorkflow runs.

```sh
sqlite3 -readonly .mutationworkflow/mw.db
```

```sql
-- Workflows waiting for review
SELECT id, json ->> '$.title' AS title, origin
FROM workflows WHERE status = 'pending-review' ORDER BY created_at;

-- Mutations of one base workflow, by operator
SELECT json ->> '$.mutation.operator' AS operator, COUNT(*)
FROM workflows WHERE parent_id = 'wf_01jc...' GROUP BY operator;

-- Run outcomes in the last day
SELECT status, COUNT(*) FROM runs
WHERE started_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day') GROUP BY status;

-- Open findings, most severe and most frequent first
SELECT id, severity, json ->> '$.occurrences' AS seen, json ->> '$.title' AS title
FROM findings WHERE status IN ('open', 'confirmed')
ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         seen DESC;

-- Error signals of one run
SELECT s.value ->> '$.kind', s.value ->> '$.message'
FROM runs, json_each(runs.json, '$.signals') AS s WHERE runs.id = 'run_01jc...';

-- Full-text search, as the engine does it
SELECT w.id, w.json ->> '$.title' FROM workflows_fts f JOIN workflows w ON w.id = f.id
WHERE workflows_fts MATCH '"double"* "submit"*' ORDER BY f.rank LIMIT 20;

-- Open questions
SELECT id, json ->> '$.kind', json ->> '$.question' FROM questions WHERE status = 'open';
```

Do not write to the tables by hand: the JSON column and its indexed copies (and the FTS tables)
must stay consistent. Use the CLI or MCP tools to change records.

## Usage and cost

The `usage` table has one row per model call. `cost_usd` is an estimate and is `NULL` when no price is
known: an unknown model, or an `openai` provider without `pricing` (see [Agents](agents.md#budgets-and-cost)).

```sql
-- Spend per role and model
SELECT role, model, COUNT(*) AS calls,
       SUM(input_tokens) AS input, SUM(output_tokens) AS output,
       SUM(cache_read_tokens) AS cache_read, ROUND(SUM(cost_usd), 2) AS usd
FROM usage GROUP BY role, model ORDER BY usd DESC;

-- Spend of one job
SELECT ROUND(SUM(cost_usd), 2) FROM usage WHERE job_id = 'job_01jc...';
```

## Jobs

Long-running work (setup, explore, mutate, run, triage, a cycle, watch mode) is tracked as a job,
so MCP clients can start it, return immediately and poll, and history survives restarts.

| Field                                  | Meaning                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| `kind`                                 | `setup`, `explore`, `mutate`, `run`, `triage`, `cycle`, `watch`                      |
| `status`                               | `queued` or `running`, then `succeeded`, `failed` or `cancelled`                      |
| `params`                               | The parameters it was started with                                                   |
| `progress`                             | `{ message, current?, total? }`, updated while it runs                               |
| `result`, `error`                      | Outcome                                                                              |
| `createdAt`, `startedAt`, `finishedAt` |                                                                                      |

Runs and usage rows carry the job id, so a job's runs and spend can be queried. When the engine
starts, jobs left `queued` or `running` by a previous process (one that was killed or crashed) are
marked `failed` with the error "Interrupted: the process ended before the job finished".

## Backup and portability

The whole memory is the `.mutationworkflow` directory. To back it up or move it to another
machine, stop MutationWorkflow and copy the directory (including any `-wal` file). For a live
copy of the database, use SQLite's online backup:

```sh
sqlite3 .mutationworkflow/mw.db ".backup 'mw-backup.db'"
```

Evidence paths in the database are relative to the evidence directory, and config paths are
relative to the config file, so a copied project with its `.mutationworkflow` directory works
anywhere. Reports are plain Markdown and mention the absolute evidence path of the machine that
wrote them.

To share memory in CI, cache or restore the directory between jobs; concurrent writers on one
database are serialised by SQLite (a 5 s busy timeout), so run one MutationWorkflow process per
database at a time.

## What is safe to delete

| Path                                 | Effect of deleting                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `reports/`                           | Safe. Reports are output only; nothing reads them back                                                                              |
| `setup-proposal.yaml`                | Safe once merged into the config                                                                                                    |
| `evidence/runs/<runId>/` of old runs | Safe but lossy: database records remain, and findings, triage and reports that reference them show a missing file                   |
| `evidence/explore/`                  | Same; explorer screenshots are referenced by review questions                                                                       |
| `evidence/` entirely                 | Same, for everything                                                                                                                |
| `mw.db` (and `-wal`, `-shm`)         | Erases the memory: workflows, mutations, runs, findings, answers, usage. Only with MutationWorkflow stopped, and only to start over |

Never delete `mw.db-wal` alone: it may hold committed data not yet written to `mw.db`.
Removing a target from the config does not delete its rows; its workflows simply stop running.
