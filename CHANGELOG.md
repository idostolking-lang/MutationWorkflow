# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Parallel exploration over MCP: sessions on one target share its running app, so a connected
  coding agent can open one `mw_explore_open` per sub-agent; `mw_explore_sessions` lists them,
  and `mw_triage_brief` takes `findingIds` so the findings waiting for triage can be split
  between sub-agents. The prompts explain the fan-out.
- Core engine: workflow model, SQLite memory with full-text search, localhost environment
  manager, deterministic replay with evidence capture, oracles, finding deduplication and
  Markdown reports.
- Nine mutation operators: skip, reorder, repeat, truncate, data fuzz, interrupt, timing, role
  swap and interleave, plus optional agent-proposed mutations.
- Agent runtime with inspector, explorer, mutator and triager roles, parallel fan-out under a
  configurable cap, per-job budgets and usage accounting. No default model: roles run through
  the coding agent connected over MCP (brief and apply tools, no API key), through a
  coding-agent command line as a driver (`claude-code`, `codex`), or through a model API
  (`anthropic`, `openai`) with an explicitly chosen model.
- Playwright web adapter and process-based CLI adapter, each with an example application that
  plants sequence bugs.
- `mw` command-line interface and MCP server for Claude Code, Codex and Cursor.
- Continuous mode, cron scheduling and a GitHub Actions recipe for runs on push.
- Change-aware runs: every run records what it touched (`runs.touched`: pages and endpoints from
  the web adapter, command words from the cli adapter), workflows accumulate it with the source
  files behind it (`workflows.touches`, variants teaching their base), and
  `engine.run({ changed })` and `engine.impact()` replay or list only the workflows a change
  affects, plus those never run. The change defaults to the commits since the last run (`last-run-commit`); a shared file
  change or an unreadable git history replays everything.
- `targets[].codemap` rules mapping pages and endpoints to source files, alongside a search of
  the repository for literal paths, and `schedule.cron[].changedOnly`.
- Optional `AdapterSession.footprint()` for adapter authors.
- Run reports embed finding screenshots with paths relative to the report, list what the runs
  exercised, show what each finding's run touched, and say how a change narrowed the run.
- ADR 0010 on change-aware selection.
