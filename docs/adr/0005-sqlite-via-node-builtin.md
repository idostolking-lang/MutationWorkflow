# 0005: SQLite through Node's built-in module as the memory

Status: accepted

## Context

The memory holds workflows, runs, evidence metadata, findings, questions, jobs and model usage,
needs full-text search, and must work with zero configuration inside a project directory. A
native SQLite binding would add a compiled dependency to a tool installed with `npx`.

## Decision

Use `node:sqlite`, the SQLite module built into Node 22.13 and later, with FTS5 virtual tables
for search and JSON columns validated on read against the Zod schemas. The `Store` interface is
asynchronous so a remote store (for example Postgres) can be added without touching callers.

## Consequences

- Node 22.13 or newer is required.
- `node:sqlite` still prints an experimental warning; the store suppresses exactly that warning
  and nothing else. The suppression goes away when the module stabilises.
- The database lives at `.mutationworkflow/mw.db` and is ignored by git by default; teams who
  want shared memory can commit it, sync the directory, or implement a shared store later.
