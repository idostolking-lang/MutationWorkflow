# Architecture

MutationWorkflow is a small core with sharp edges: a domain model everything agrees on, a handful
of interfaces (adapter, store, operator, oracle, model provider) and an engine that composes them.
Models are used where judgement is needed (reading a repository, exploring an application,
deciding whether a failure is a bug) and kept out of everything that must be cheap and
reproducible (replay, mutation, oracles, reports, deciding which workflows a code change
affects). This document explains the pieces; the reasoning behind the bigger choices is in the
[decision records](adr/README.md).

## The loop

```
                 ┌──────────────────────────────────────────────────────────────────────────┐
                 │                                 Engine                                   │
   repository ──▶│ setup ──▶ discover ──▶ mutate ──▶ replay ──▶ judge ──▶ learn ──▶ triage  │──▶ reports
                 │ inspector explorer   operators   executor   oracles  code map   triager  │    questions
                 └────┬─────────┬──────────┬──────────┬─────────┬──────────┬────────┬───────┘
                      │         │          │          │         │          │        │
              agent runtime  adapter   mutation    adapter    oracle   code map, agent runtime
               (providers,   session   registry    session   registry   impact  (vision, tools)
                semaphore)                                                          │
                      └──────────────────────── store (SQLite) ─────────────────────┘
                 workflows (+ touches) · runs · evidence · findings · questions · jobs · usage · meta
```

| Stage    | Who                                          | Uses a model  | Output                                                |
| -------- | -------------------------------------------- | ------------- | ----------------------------------------------------- |
| setup    | inspector agent + delegates                  | yes           | config file, seed workflows, questions                |
| discover | explorer agents                              | yes           | pending-review workflows, questions, evidence         |
| mutate   | operators (and optionally the mutator agent) | no (optional) | mutation workflows                                    |
| replay   | executor                                     | no            | runs with step results, assertions, signals, evidence |
| judge    | oracles                                      | no            | oracle results attached to the run                    |
| learn    | code map, as each run is recorded            | no            | what each workflow touches: pages, endpoints, files   |
| triage   | fingerprinting, then the triager agent       | partially     | findings (new, merged, dismissed), questions          |
| report   | renderer                                     | no            | Markdown report                                       |

## Who does the thinking

Every agent role is split into a brief (instructions, context and the schema of the expected
result) and an apply step that stores the result. That split lets the same role run three ways:

| Way | Model | Key | Typical use |
| --- | --- | --- | --- |
| Coding agent connected over MCP asks for the brief, thinks, submits | the client's own | none | interactive work in Claude Code, Codex or Cursor |
| Coding agent command line as a driver (`claude-code`, `codex`) | the user's installation | none | autonomous runs on a developer machine |
| Model API provider (`anthropic`, `openai`) | named in the config | API key | CI, servers, continuous mode |

The in-process runtime owns the tool loop for model providers; drivers own their own loop and call
the same tools over MCP; a connected client calls them through the MCP server's fine-grained tools.

## Packages

- **`@mutationworkflow/core`** holds everything that is not specific to one kind of application:
  - `schema/`: Zod schemas and types for targets, workflows, runs, evidence, findings, questions
    and jobs, plus id and fingerprint helpers. Every boundary validates against them.
  - `config/`: the YAML configuration schema with defaults, loading with environment variable
    interpolation, and writing.
  - `adapter/`: the `Adapter` and `AdapterSession` interfaces and the `EvidenceSink` adapters use
    to store files.
  - `store/`: the `Store` interface and the SQLite implementation (Node's built-in `node:sqlite`,
    FTS5 for search, JSON columns validated on read).
  - `environment/`: starts, readies, resets and stops the application under test.
  - `mutations/`: the operator interface, nine built-in operators and the registry that turns
    operator output into deduplicated workflows.
  - `oracles/`: the oracle interface, four built-in oracles and their registry.
  - `agents/`: the provider-neutral message format; model providers (Anthropic, OpenAI-compatible)
    called turn by turn; drivers that hand a whole task to a coding agent's command line (Claude
    Code, Codex) and serve it the task's tools over an ephemeral MCP server; a fake provider for
    tests; the runtime (tool loop, `finish` for structured results, `delegate` for fan-out, the
    semaphore, budgets, usage records) and the role prompts. No model is ever chosen by default.
  - `engine/`: the executor, triage, exploration, mutation, setup, run, report and job modules,
    `codemap` (pages and endpoints to source files), `impact` (which workflows a change
    affects), `git` (commit, branch and changed files), and the `Engine` facade that wires them
    to a configuration.
- **`@mutationworkflow/adapter-web`** drives browsers through Playwright: robust locators
  (test id, role and name, label, placeholder, text, css), an action and assertion vocabulary,
  signals from console errors, page errors, failed requests and error responses, aria snapshots
  as observations, screenshots as evidence, and scope enforcement.
- **`@mutationworkflow/adapter-cli`** drives processes through stdin and stdout: start, exec,
  write, wait, signal and close actions; output and exit-code assertions; stderr and exit
  signals; the transcript as observation and evidence.
- **`mutationworkflow`** is the published entry point: the `mw` command-line interface and the
  MCP server, both thin layers over the engine.

## Key records

- A **workflow** is an ordered list of steps, each an adapter-specific action with optional
  expectations, plus final expectations, an intent and a title. Its **fingerprint** hashes the
  target, identity and actions, so two workflows that perform the same actions are one workflow
  whatever they are called. Mutations are workflows with a `parentId` and a `mutation` record.
- A **run** is one replay of a workflow: per-step status and timing, every assertion result,
  the application's error **signals**, the oracle results, and evidence ids. Its status is
  `passed`, `failed`, `blocked` (an action the application did not offer) or `error`
  (infrastructure).
- A workflow also carries **touches**: the pages, endpoints and source files its runs (and,
  for a base, its variants' runs) have exercised. Each run records its own footprint as
  `touched`.
- A **finding** is a deduplicated problem: a fingerprint, title, summary, severity, the oracle
  that detected it, the workflows and runs that exhibit it, a minimal reproduction (the steps of
  the first workflow that hit it), triage state and verdict, and a status the team controls.
- A **question** is something only the team can answer: is this observed behaviour intended, is
  this a bug, is the setup right. Answers flow back into workflow status and findings.
- A **job** tracks long-running work started from the CLI or an MCP client.

## Extension points

| Interface          | Where                         | Registered through                                                  |
| ------------------ | ----------------------------- | ------------------------------------------------------------------- |
| `Adapter`          | `core/src/adapter/types.ts`   | a loader by kind in the CLI, or a package name in the target config |
| `MutationOperator` | `core/src/mutations/types.ts` | `resolveOperators(ids, extra)`                                      |
| `Oracle`           | `core/src/oracles/types.ts`   | `resolveOracles(ids, extra)` or `Engine.create({ oracles })`        |
| `ModelProvider`    | `core/src/agents/provider.ts` | `Engine.create({ providers })` or the `providers` config section    |
| `Store`            | `core/src/store/types.ts`     | `Engine.create({ store })`                                          |

Adapters are the main plugin surface. An adapter owns its vocabulary (actions and assertions,
described with JSON Schema so agents can use them), decides what `blocked` means for its kind of
application, emits signals, and returns observations agents can read. The core never interprets
action parameters; it only knows the hints an adapter publishes for mutation operators.

## Runtime concerns

- **Concurrency.** Workflow executions run in parallel per `execution.parallel` (serial when
  `resetBetweenRuns` is on, since a reset affects every session). Model calls are capped by one
  semaphore of `agents.maxParallel` permits shared by every agent and sub-agent; an agent waiting
  on tools or delegates holds no permit, so fan-out cannot deadlock.
- **Determinism.** Operators are pure functions of the workflow and hints. Replay has no model.
  Runs record the commit and branch so results can be tied to code.
- **Evidence.** Adapters write files only through the `EvidenceSink`, which keeps paths portable
  and relative to `evidenceDir`. Runs live under `evidence/runs/<runId>`, exploration sessions
  under `evidence/explore/<sessionId>`.
- **Logging.** Everything logs to stderr. Stdout is reserved for the MCP transport and for
  machine-readable CLI output.
- **Safety.** Environments are local and started by the tool. Scope rules fence agents in, and
  the prompts forbid real-world side effects even when the UI offers them.

### Change-aware selection

Replaying everything after every commit is the safe default, but slow once there are hundreds
of mutations. So the engine remembers what each workflow touches and, given a change, replays
only what the change can affect.

- **Learning.** Every recorded run merges the adapter's footprint (pages, endpoints or command
  words) into its workflow, and a variant's into its base as well. The code map turns the
  accumulated pages and endpoints into files: explicit `targets[].codemap` rules plus a capped
  search of the repository for the literal paths (see
  [Configuration](configuration.md#targetscodemap)).
- **Classifying.** For a list of changed files, `impact` sorts each base workflow of a target
  into impacted (a changed file is among its files), unknown (no files yet) or unaffected.
- **Selecting.** A change-aware run replays the impacted and unknown bases with all their
  variants; variants are never classified on their own. It replays everything when a shared
  file changed (dependency manifests and lockfiles, `tsconfig*.json`, Vite, Next, webpack or
  Tailwind config, `.env.example`, `Dockerfile`, `docker-compose*.yml`, `Makefile`,
  `prisma/schema.prisma`, anything under a `migration/` or `migrations/` directory), or when no
  workflow of the target is known to be unaffected, since a full run then costs the same.
- **The change.** `engine.run({ changed })` and `engine.impact()` take a `ChangeSpec`: explicit
  `files` (relative to the project root, which wins) or a git `range`. The default range runs
  from the commit of the last run command that replayed something (`last-run-commit` in the
  `meta` table, else `HEAD~1`) to `HEAD`, through `git diff --name-only`.
- **Fallback.** When git cannot list the files (no repository, a shallow clone without that
  commit), `engine.run` logs a warning, adds it to the summary's `errors` and replays
  everything; `engine.impact`, which runs nothing, fails with `GIT_UNAVAILABLE`.

The run summary carries a `SelectionSummary` per target (changed files, impacted, unknown and
skipped counts, and whether everything ran), and the report states how the change narrowed the
run. The reasoning and the limits are in [ADR 0010](adr/0010-change-aware-selection.md).

## Project directory

```
.mutationworkflow/
  mw.db               SQLite memory (WAL mode)
  evidence/           screenshots, transcripts, console logs, DOM captures
  reports/            Markdown run reports
  setup-proposal.yaml what `mw setup` suggests when a config already exists
mutationworkflow.config.yaml
```

## Testing strategy

- Unit tests sit next to the code and run without a browser or network: schemas, operators,
  oracles, store, environment manager, agent runtime with a scripted fake provider, and the
  engine with a fake adapter.
- End-to-end tests in `packages/*/e2e` launch a real browser against `examples/todo-web`, whose
  README lists the planted sequence bugs. The core end-to-end test seeds two hand-written
  workflows and expects mutation plus replay to find all three bugs without a model.
- The example applications double as documentation of what the tool is for.
