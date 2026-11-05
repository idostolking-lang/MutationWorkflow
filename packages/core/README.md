# @mutationworkflow/core

The engine behind [MutationWorkflow](https://github.com/idostolking-lang/MutationWorkflow):
everything that is not specific to one kind of application.

- **Domain model** (`schema/`): Zod schemas for targets, workflows, runs, evidence, findings,
  questions and jobs, with id and fingerprint helpers.
- **Configuration** (`config/`): the YAML config schema with defaults, loading with environment
  variable interpolation, and writing.
- **Memory** (`store/`): the `Store` interface and its SQLite implementation on Node's built-in
  `node:sqlite`, with full-text search.
- **Environments** (`environment/`): start, ready-check, reset and stop the application under test.
- **Mutations** (`mutations/`): nine deterministic operators and the registry that turns their
  output into deduplicated workflows.
- **Oracles** (`oracles/`): step-failure, app-error, assertions and invariants.
- **Agents** (`agents/`): provider-neutral messages, Anthropic and OpenAI-compatible providers,
  the tool-use runtime with parallel fan-out and budgets, and the role prompts.
- **Engine** (`engine/`): executor, triage, exploration, mutation, setup, run, reports, jobs and
  the `Engine` facade that composes them.

```ts
import { Engine, loadConfig } from '@mutationworkflow/core';

const engine = await Engine.create({
  config: loadConfig({ cwd: process.cwd() }),
  adapters: {
    web: () => import('@mutationworkflow/adapter-web'),
    cli: () => import('@mutationworkflow/adapter-cli'),
  },
});

await engine.mutate('web');
const summary = await engine.run({ trigger: 'manual' });
console.log(summary.findings.map((f) => `${f.severity}: ${f.title}`));
await engine.close();
```

Most people use the engine through the [`mutationworkflow`](../mutationworkflow/README.md)
package, which provides the `mw` command-line interface and the MCP server. Use this package
directly to embed the engine, to write an adapter (implement `Adapter` and `AdapterSession` from
`@mutationworkflow/core`), or to add operators, oracles and model providers.

Documentation: [architecture](../../docs/architecture.md), [configuration](../../docs/configuration.md),
[adapters](../../docs/adapters.md), [mutations](../../docs/mutations.md), [oracles](../../docs/oracles.md),
[agents](../../docs/agents.md), [memory](../../docs/memory.md).

License: Apache-2.0.
