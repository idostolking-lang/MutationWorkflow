# Contributing

Thanks for helping make MutationWorkflow better. This guide covers how the repository is laid
out, how to run it locally, and what a good change looks like.

## Development setup

Requirements: Node 22.13 or newer and pnpm 10 (`corepack enable` installs the pinned version).

```sh
pnpm install
pnpm build                     # tsc -b, builds every package in dependency order
pnpm test                      # unit tests (fast, no browser, no network)
pnpm exec playwright install chromium
pnpm test:e2e                  # end-to-end tests against the example apps in a real browser
pnpm check                     # lint + typecheck + unit tests, what CI runs first
```

Use the CLI from source with `pnpm mw <command>` (runs `packages/mutationworkflow/dist/bin.js`,
so build first).

## Repository layout

| Path | What lives there |
| --- | --- |
| `packages/core` | Domain model (Zod schemas), config, SQLite memory, environment manager, mutation operators, oracles, agent runtime and prompts, the engine |
| `packages/adapter-web` | Playwright adapter for web applications |
| `packages/adapter-cli` | Process adapter for command-line applications |
| `packages/mutationworkflow` | The `mw` CLI and the MCP server (the published entry point) |
| `examples/` | Dependency-free sample apps with deliberately planted sequence bugs |
| `docs/` | User documentation and architecture decision records (`docs/adr`) |

Each package keeps tests next to the code (`*.test.ts`, run by the `unit` Vitest project).
Tests that need a browser live in `packages/*/e2e` and run in the `e2e` project.

## Conventions

- TypeScript in strict mode with `noUncheckedIndexedAccess`. No `any`, no non-null assertions.
- ESM everywhere; relative imports end in `.js`.
- Biome formats and lints (`pnpm lint:fix` applies fixes). Single quotes, two spaces, 100 columns.
- Every record that crosses a boundary (config file, database, agent tool input) has a Zod
  schema. Validate at the edge, trust the types inside.
- Logs go to stderr through the `Logger` from core, never `console.log`: stdout belongs to the
  MCP transport and to machine-readable CLI output.
- Public functions carry a short JSDoc that says what they do and why, not how.
- Keep modules small and single-purpose. Prefer a new file over a long one.

## Adding things

- **A mutation operator**: implement `MutationOperator` in `packages/core/src/mutations/operators/`,
  add its id to `BUILTIN_OPERATOR_IDS` in `config/schema.ts`, register it in `registry.ts`, and
  add tests. Operators must be deterministic.
- **An oracle**: implement `Oracle` in `packages/core/src/oracles/builtin/`, add its id to
  `BUILTIN_ORACLE_IDS`, register it, and give every failing result a stable `signature`.
- **An adapter**: see [docs/adapters.md](docs/adapters.md). Third-party adapters can live in
  their own package; the engine loads them by package name from the project under test.
- **An MCP tool or CLI command**: `packages/mutationworkflow/src/mcp` and `src/commands`.
  Keep formatting in pure functions so it can be tested without spawning a process.

## Pull requests

- One topic per pull request, with tests for behaviour you add or change.
- Run `pnpm check` before pushing. CI runs the same plus the end-to-end suite.
- Explain the why in the description. If the change affects users, update the docs and add a
  line under "Unreleased" in `CHANGELOG.md`.
- Architectural changes deserve an ADR in `docs/adr/` (copy the format of the existing ones).

## Reporting bugs

Open an issue with the version, the config (secrets removed), what you ran, and what you
expected. Reports and evidence under `.mutationworkflow/` are usually the fastest way to show
what happened.
