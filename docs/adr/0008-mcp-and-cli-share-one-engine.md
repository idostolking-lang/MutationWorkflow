# 0008: The MCP server and the CLI are thin layers over one engine

Status: accepted

## Context

The primary way people will use the tool is from their coding agent (Claude Code, Codex, Cursor),
which speak MCP. They will also run it from a terminal, from cron and from CI. Two interfaces
that drift apart would double the surface to document and test.

## Decision

All behaviour lives in the `Engine` class in core. The CLI maps commands to engine calls and
formats results; the MCP server maps tools to the same calls and returns text plus compact JSON.
Long operations go through the job manager so MCP clients can start them and poll, while the CLI
awaits them. Both write logs to stderr only, because stdout belongs to the MCP transport.

## Consequences

- A feature is implemented once and exposed twice with a few lines each.
- The engine is tested directly with a fake adapter and a fake provider; the interfaces need
  only smoke tests.
- Third-party integrations (a GitHub Action, a web dashboard) have one API to build on.
