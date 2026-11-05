# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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
