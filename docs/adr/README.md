# Architecture decision records

Short records of the decisions that shape MutationWorkflow, in the order they were made. Each
record states the context, the decision and its consequences. Supersede a record with a new one
rather than editing history.

| #                                                        | Decision                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| [0001](0001-mutate-workflows-not-code.md)                | Mutate user workflows, not code                                     |
| [0002](0002-deterministic-replay-models-at-the-edges.md) | Deterministic replay; models only at the edges                      |
| [0003](0003-judgement-over-confidence-scores.md)         | Judgement by a strong model and humans instead of confidence scores |
| [0004](0004-local-environments-only.md)                  | Only local environments the tool starts itself                      |
| [0005](0005-sqlite-via-node-builtin.md)                  | SQLite through Node's built-in module as the memory                 |
| [0006](0006-typescript-pnpm-monorepo.md)                 | TypeScript, a pnpm monorepo and strict tooling                      |
| [0007](0007-one-semaphore-for-model-calls.md)            | One semaphore over model calls defines parallelism                  |
| [0008](0008-mcp-and-cli-share-one-engine.md)             | The MCP server and the CLI are thin layers over one engine          |
