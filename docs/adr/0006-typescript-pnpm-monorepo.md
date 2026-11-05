# 0006: TypeScript, a pnpm monorepo and strict tooling

Status: accepted

## Context

The tool must drive browsers (Playwright), speak MCP (the official SDK is TypeScript first) and
be approachable to the developers most likely to adopt it. Adapters have heavy, platform-specific
dependencies that the core should not carry.

## Decision

TypeScript with strict settings (`noUncheckedIndexedAccess`, no `any`, no non-null assertions),
ESM, Node 22. A pnpm workspace with four packages: core, the two built-in adapters, and the
published CLI and MCP package. Biome for formatting and linting, Vitest for tests (a `unit`
project without browser or network and an `e2e` project with a real browser), `tsc -b` for
builds. Zod schemas at every boundary; JSON Schema for agent tools is generated from them.

## Consequences

- Adding an adapter is adding a package that implements one interface.
- Contributors need pnpm; the repository pins the version through `packageManager`.
- Tests next to the code keep each package self-contained; the end-to-end suite documents the
  product's behaviour on the example applications.
