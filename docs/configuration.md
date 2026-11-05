# Configuration

MutationWorkflow reads one configuration file from the project root. It declares the
applications to test (targets), how to start and reset them locally, which users to act as,
what must always hold (invariants), where agents may go (scope), which models to use, and how
mutation, execution, oracles, exploration and scheduling behave. Every section except `version`
and `project` has defaults, so a minimal file is short. This page is the complete reference;
values and defaults are taken from the configuration schema in
`packages/core/src/config/schema.ts` and `packages/core/src/schema/target.ts`.

Related: [README](../README.md) · [CLI](cli.md) · [Workflows](workflows.md) ·
[Adapters](adapters.md) · [Agents](agents.md) · [Memory](memory.md)

## File names and discovery

The first of these files found in the working directory is used:

1. `mutationworkflow.config.yaml`
2. `mutationworkflow.config.yml`
3. `mutationworkflow.config.json`

All relative paths in the file (the store, evidence and reports directories, `cwd` of commands,
`storageStatePath`) resolve against the directory that contains the config file. Target ids
must be unique. Validation errors are reported with the failing path and stop the command
(`CONFIG_INVALID`); a missing file is `CONFIG_NOT_FOUND`.

`mw setup` writes `mutationworkflow.config.yaml` only when no config exists; it re-checks the disk
right before writing, so a second setup never overwrites one and instead writes
`.mutationworkflow/setup-proposal.yaml` for you to merge by hand. After creating a config the
engine reloads it, so a running MCP server can use the new targets without a restart.

## Environment variable interpolation

Any string value may reference environment variables, so secrets and machine-specific values
stay out of the committed file:

| Syntax            | Result                                                      |
| ----------------- | ----------------------------------------------------------- |
| `${VAR}`          | Value of `VAR`; the config is invalid when `VAR` is not set |
| `${VAR:-default}` | Value of `VAR`, or `default` when it is not set             |

Names consist of letters, digits and `_`. Interpolation happens before validation and only
inside strings: `port: ${PORT}` in YAML is a string, so use it where the schema expects a
string (for example `environment.start.env`), not where it expects a number.

## Complete example

Two targets from the repository's examples: the `todo-web` app (a web target) and the
`counter-cli` REPL (a cli target).

```yaml
version: 1

project:
  name: examples
  description: Demo applications with planted sequence bugs

targets:
  - id: todo
    name: Todo web app
    description: Single-page todo list backed by a JSON API with in-memory state
    kind: web # built-in Playwright adapter
    options:
      baseUrl: http://127.0.0.1:4173 # the example server binds 127.0.0.1
      browser: chromium
      headless: true
    environment:
      start:
        command: node server.js
        cwd: examples/todo-web
        env:
          PORT: "${TODO_PORT:-4173}" # env values are strings
        ready:
          url: http://127.0.0.1:4173/api/health
          status: 200
          timeoutMs: 30000
      reset: # runs before each workflow when
        command: curl -X POST http://127.0.0.1:4173/api/reset # execution.resetBetweenRuns is true
    identities: []
    invariants:
      - id: api-healthy
        description: The health endpoint still answers after the workflow
        check: { type: http, url: /api/health, status: 200 }
        when: after-workflow
    scope:
      denyText: ["delete account", "log ?out"] # case-insensitive regular expressions

  - id: counter
    name: Counter REPL
    kind: cli # built-in process adapter
    options:
      command: node # an executable; use shell: true for "node cli.js"
      args: [cli.js]
      cwd: examples/counter-cli
      promptPattern: "^> "

agents:
  maxParallel: 3
  defaults:
    model: claude-opus-5-5 # an example: required for API providers, there is no default
  roles:
    triager: { effort: low }
  budget:
    maxUsdPerJob: 5

mutations:
  maxVariantsPerWorkflow: 25

execution:
  parallel: 2
  screenshots: on-failure

oracles:
  ignoreSignals: ["favicon\\.ico"]
```

Without a `providers` section, providers are inferred from `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, and the `claude` and `codex` command lines on `PATH`; when more than one is
available, `agents.defaults.provider` must name one (see [Agents](agents.md#providers)). Without
any provider, every deterministic command (replay, mutation by operators, oracles, reports) still
works.

## Field reference

### Top level

| Field         | Type   | Default                      | Meaning                               |
| ------------- | ------ | ---------------------------- | ------------------------------------- |
| `version`     | `1`    | required                     | Config format version                 |
| `project`     | object | required                     | See below                             |
| `targets`     | array  | `[]`                         | Applications under test               |
| `providers`   | map    | `{}` (inferred, see below)   | Model providers and drivers by id     |
| `agents`      | object | see below                    | Model settings, parallelism, budget   |
| `mutations`   | object | see below                    | Mutation operators                    |
| `execution`   | object | see below                    | Replay settings                       |
| `oracles`     | object | see below                    | Oracle selection and signal filtering |
| `exploration` | object | see below                    | Explorer agents                       |
| `schedule`    | object | see below                    | Continuous mode and cron entries      |
| `store.path`  | string | `.mutationworkflow/mw.db`    | SQLite database                       |
| `evidenceDir` | string | `.mutationworkflow/evidence` | Screenshots, logs, DOM snapshots      |
| `reportsDir`  | string | `.mutationworkflow/reports`  | Markdown run reports                  |

### `project`

| Field         | Type   | Default  | Meaning                       |
| ------------- | ------ | -------- | ----------------------------- |
| `name`        | string | required | Project name, non-empty       |
| `description` | string | none     | Shown to agents and in status |

### `targets[]`

| Field         | Type   | Default    | Meaning                                                                      |
| ------------- | ------ | ---------- | ---------------------------------------------------------------------------- |
| `id`          | string | required   | Lowercase letters, digits, `-`, `_`; starts with a letter or digit           |
| `name`        | string | none       | Display name                                                                 |
| `description` | string | none       | What the application does, for the agents                                    |
| `kind`        | string | required   | Adapter kind: `web`, `cli`, or a custom kind                                 |
| `adapter`     | string | the `kind` | Adapter package to load, e.g. `my-adapter-package` ([Adapters](adapters.md)) |
| `options`     | map    | `{}`       | Adapter options, validated by the adapter                                    |
| `environment` | object | `{}`       | `start` and `reset` commands                                                 |
| `identities`  | array  | `[]`       | Users workflows can act as                                                   |
| `invariants`  | array  | `[]`       | Checks that must hold after any workflow                                     |
| `scope`       | object | see below  | Boundaries for agents and replays                                            |
| `codemap`     | array  | `[]`       | Rules from pages and endpoints to source files, for change-aware runs        |

Adapter options are documented in [Adapters](adapters.md): `baseUrl`, `allowRemoteBaseUrl`,
`browser`, `headless`, `viewport`, `launchOptions`, `storageStatePath` for `web`; `command`,
`args`, `cwd`, `env`, `shell`, `promptPattern`, `exitTimeoutMs` for `cli`. Two rules matter when
writing them:

- `web`: `baseUrl` must be a loopback host (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`).
  Any other host is rejected with `CONFIG_INVALID` unless `allowRemoteBaseUrl: true` is set, which
  is meant only for a local instance reached under another name (a container or VM on your
  machine), never a shared or production environment.
- `cli`: with `shell: true` the `command` string goes to the shell as written, but on POSIX every
  configured and per-action argument is single-quoted, so arguments are always literal data. On
  Windows with `shell: true`, `start`/`exec` actions with per-action `args` are rejected.

The stored copy of a target (the `targets` table) and what agents see leave out identity steps
and the `env`, `launchOptions` and `storageStatePath` options; see [Memory](memory.md#tables).

### `targets[].environment`

MutationWorkflow only tests an application it started itself, or one already running on
localhost. Each replay and exploration starts the environment, waits for it, and stops it (with
its whole process group) at the end. Setup starts proposed environments only when asked to
validate them (`mw setup --validate`, or `validate: true` over MCP), only for a config it just
created, and logs each start command first, since a model wrote it.

| Field                    | Type                               | Default   | Meaning                                                           |
| ------------------------ | ---------------------------------- | --------- | ----------------------------------------------------------------- |
| `start`                  | object                             | none      | Starts the app; omit when it is already running                   |
| `start.command`          | string                             | required  | Shell command                                                     |
| `start.cwd`              | string                             | root      | Directory relative to the project root                            |
| `start.env`              | map of string                      | `{}`      | Merged over the current environment                               |
| `start.ready`            | object                             | required  | Ready check, below                                                |
| `start.stopSignal`       | `SIGTERM` \| `SIGINT` \| `SIGKILL` | `SIGTERM` | Signal sent to stop the process group                             |
| `start.stopTimeoutMs`    | integer                            | `10000`   | Wait before escalating to `SIGKILL`                               |
| `reset`                  | object                             | none      | Restores a known state (reseed a database)                        |
| `reset.command`          | string                             | required  | Shell command, must exit 0                                        |
| `reset.cwd`, `reset.env` | as for `start`                     |           |                                                                   |
| `reset.timeoutMs`        | integer                            | `60000`   | Killed and reported as failed after this                          |

Ready check (`start.ready`): at least one of `url`, `port`, `output`. Every condition you give
must hold at the same time; the check polls until then or until `timeoutMs`, and fails early
when the process exits. `start` has no `timeoutMs` of its own: `ready.timeoutMs` bounds startup.

| Field       | Type    | Default | Meaning                                                    |
| ----------- | ------- | ------- | ---------------------------------------------------------- |
| `url`       | string  | none    | Must answer; with `status`, with exactly that status       |
| `status`    | integer | none    | Expected status for `url`; any status below 500 if omitted |
| `port`      | integer | none    | TCP port on localhost that must accept connections         |
| `output`    | string  | none    | Regular expression matched against the process output      |
| `timeoutMs` | integer | `60000` | Startup deadline                                           |

Without `start`, the engine probes `options.baseUrl` once and only warns when it does not
answer. The `reset` command runs before every workflow only when `execution.resetBetweenRuns`
is `true`; nothing else runs it.

### `targets[].identities[]`

| Field         | Type   | Default  | Meaning                                                   |
| ------------- | ------ | -------- | --------------------------------------------------------- |
| `id`          | string | required | Referenced by `workflow.identity`                         |
| `description` | string | none     | Shown to agents                                           |
| `steps`       | array  | `[]`     | Steps (action, note, expect) that log in or prepare state |

Identity steps run before the workflow's own steps in the same session; any outcome other than
`ok` makes the run an `error`. Example:

```yaml
identities:
  - id: admin
    steps:
      - action: { type: navigate, url: /login }
      - action: { type: fill, target: { label: Email }, value: admin@example.test }
      - action: { type: fill, target: { label: Password }, value: "${ADMIN_PASSWORD}" }
      - action: { type: click, target: { role: button, name: Sign in } }
```

### `targets[].invariants[]`

| Field         | Type                             | Default          | Meaning                                   |
| ------------- | -------------------------------- | ---------------- | ----------------------------------------- |
| `id`          | string                           | required         | Identifier                                |
| `description` | string                           | none             | Used in findings; falls back to `id`      |
| `check`       | assertion                        | required         | Any assertion from the adapter vocabulary |
| `when`        | `after-workflow` \| `after-step` | `after-workflow` | When to check                             |

`after-step` invariants run after every step whose action succeeded; `after-workflow`
invariants run once at the end, even when the workflow stopped early.

### `targets[].scope`

| Field       | Type     | Default | Meaning                                                                         |
| ----------- | -------- | ------- | ------------------------------------------------------------------------------- |
| `allowUrls` | string[] | `[]`    | URL globs that may be visited; empty means everything under the base URL origin |
| `denyUrls`  | string[] | `[]`    | URL globs never visited                                                         |
| `denyText`  | string[] | `[]`    | Case-insensitive regular expressions; matching controls are never activated     |

Scope is enforced by the adapter, during exploration and replay alike. The built-in `web`
adapter enforces all three; the `cli` adapter has no URLs or controls and ignores scope.

### `targets[].codemap`

Explicit rules that tie what workflows touch (pages and endpoints, see
[Workflows](workflows.md#what-a-workflow-touches)) to the source files that implement them. A
change-aware run replays a workflow when a changed file is among its files. Rules are optional:
without them the engine searches the repository for files that mention each path literally,
which finds routes and clients written as `'/api/todos'` but not code that builds its paths.

| Field         | Type     | Default  | Meaning                                                         |
| ------------- | -------- | -------- | --------------------------------------------------------------- |
| `match`       | string   | required | Glob over a normalised page path or endpoint                    |
| `files`       | string[] | required | At least one path or glob, relative to the project root         |
| `description` | string   | none     | What the rule covers, for people reading the config             |

`match` is tested against each page and endpoint a workflow touched, after normalisation:
query strings and fragments are removed, and segments that look like ids (all digits, a UUID,
16 or more hex characters, or a prefixed id such as `wf_01jc8x9k2m`) become `*`. So
`DELETE /api/todos/42?force=1` is matched as `/api/todos/*` and as `DELETE /api/todos/*`, and
also with a trailing slash (`/api/todos/*/`). In the glob, `*` matches within one segment and
`**` across segments. Because of the trailing slash, `/api/todos/**` covers the collection
`/api/todos` as well as every item below it. A pattern with a method restricts a rule to that
method and gets the same treatment, so `POST /api/todos/**` covers posts to the collection and
to its items. For `cli` targets, command words are plain tokens: `match: add` covers the `add`
command, and the repository is not searched for bare words.

```yaml
targets:
  - id: todo
    kind: web
    options: { baseUrl: http://127.0.0.1:4173 }
    codemap:
      - match: /api/todos/**
        description: Todo API and the client code that calls it
        files: [server.js, public/app.js]
      - match: /settings
        files: ["src/settings/**"]
```

A file in `files` that is a directory path (no glob characters) also covers everything under
it. The repository search reads text files up to 512 KiB, skips `.git`, `node_modules`,
`dist`, `build`, `out`, `coverage`, `target`, `vendor`, `.next`, `.nuxt`, `.turbo`, `.cache`,
`.venv`, `venv`, `__pycache__`, `.mutationworkflow`, `test-results` and `playwright-report`,
keeps at most 25 files per path, and a workflow keeps at most 60 files in all, so a generic
path cannot claim the whole repository. Root-only paths (`/`) are never searched for.

### `providers`

A map from a provider id of your choice (what `agents.*.provider` refers to) to one entry. There
are four types, of two kinds: model providers call an API turn by turn with a key from the
environment; drivers run a whole agent task through your installed coding-agent command line,
with its own login or subscription and no API key (see [Agents](agents.md#drivers)).

| `type`        | Kind           | Fields (default)                                                         | Notes                                              |
| ------------- | -------------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| `anthropic`   | Model provider | `apiKeyEnv` (`ANTHROPIC_API_KEY`), `baseUrl` (API default), `pricing`    | `model` required                                   |
| `openai`      | Model provider | `apiKeyEnv` (`OPENAI_API_KEY`), `baseUrl` (API default; any OpenAI-compatible server), `pricing` | `model` required          |
| `claude-code` | Driver         | `command` (`claude`), `args` (`[]`)                                       | `model` optional (passed as `--model`); reports usage and cost |
| `codex`       | Driver         | `command` (`codex`), `args` (`[]`)                                        | Experimental, not tested in CI; `model` optional; no usage or cost reported |

`command` may be a name looked up on `PATH` or a path; `args` are extra arguments placed before
the driver's own on every invocation. A model provider whose key variable is unset, or a driver
whose command is not on `PATH`, is skipped with a warning.

With no `providers` section, providers are inferred: `ANTHROPIC_API_KEY` gives `anthropic`,
`OPENAI_API_KEY` gives `openai`, `claude` on `PATH` gives `claude-code`, `codex` on `PATH` gives
`codex` (each with the default fields). Exactly one available provider is used automatically;
with several, `agents.defaults.provider` or a role's `provider` must choose, or agent commands
fail with `PROVIDER_NOT_CONFIGURED` listing them.

```yaml
providers:
  claude: { type: claude-code } # your Claude Code login; no API key
  api: { type: anthropic, pricing: { input: 4, output: 20 } }
agents:
  defaults: { provider: claude } # model optional for drivers
  roles:
    triager: { provider: api, model: claude-sonnet-5-5 } # model required for API providers
```

`pricing` (model providers only) applies to every model used through that provider entry. For `anthropic` it overrides
the built-in price table; for `openai` it is the only way to get cost estimates and therefore
`maxUsdPerJob` budgets.

| Field        | Type   | Default        | Meaning                     |
| ------------ | ------ | -------------- | --------------------------- |
| `input`      | number | required       | Uncached input tokens       |
| `output`     | number | required       | Output tokens               |
| `cacheRead`  | number | `input` × 0.1  | Cached input tokens read    |
| `cacheWrite` | number | `input` × 1.25 | Input tokens written to cache |

### `agents`

| Field                    | Type    | Default | Meaning                                                     |
| ------------------------ | ------- | ------- | ----------------------------------------------------------- |
| `maxParallel`            | integer | `3`     | Concurrent model calls across all agents and sub-agents; a driver task holds one for its whole run |
| `defaults`               | object  | `{}`    | Model settings for every role                               |
| `roles.<role>`           | object  | none    | Overrides for `inspector`, `explorer`, `mutator`, `triager` |
| `budget.maxTokensPerJob` | integer | none    | Stop agents in a job after this many input + output tokens  |
| `budget.maxUsdPerJob`    | number  | none    | Stop agents in a job after this estimated cost              |

Model settings (in `defaults` and each role; role values win field by field):

| Field       | Type                                            | Default                                                             | Meaning                       |
| ----------- | ----------------------------------------------- | ------------------------------------------------------------------- | ----------------------------- |
| `provider`  | string                                          | the only available provider; required when several are               | Provider id                   |
| `model`     | string                                          | none: required for `anthropic`/`openai`; drivers use the CLI's own setting | Model id                |
| `effort`    | `low` \| `medium` \| `high` \| `xhigh` \| `max` | none                                                                | Reasoning effort (model providers only) |
| `maxTurns`  | integer                                         | `60`                                                                | Model calls per agent run     |
| `maxTokens` | integer                                         | `16000`                                                             | Output tokens per call (model providers only) |
| `vision`    | boolean                                         | provider capability                                                 | Send screenshots to the model |

There is no default model. A role that resolves to `anthropic` or `openai` without a `model`
fails with `PROVIDER_NOT_CONFIGURED` naming the role; model ids in these docs are examples.

### `mutations`

| Field                    | Type     | Default                      | Meaning                                     |
| ------------------------ | -------- | ---------------------------- | ------------------------------------------- |
| `operators`              | string[] | all nine built-ins, in order | Operator ids, applied in the given order    |
| `maxVariantsPerWorkflow` | integer  | `25`                         | Total variants per base workflow; existing ones count |
| `fuzzValues`             | string[] | built-in boundary set        | Replacement values for `data-fuzz`          |

Built-in ids: `skip-step`, `reorder-steps`, `repeat-step`, `truncate`, `data-fuzz`,
`interrupt`, `timing`, `role-swap`, `interleave`. See [Mutations](mutations.md).

### `execution`

| Field                | Type                                | Default      | Meaning                                                                      |
| -------------------- | ----------------------------------- | ------------ | ---------------------------------------------------------------------------- |
| `parallel`           | integer                             | `2`          | Concurrent workflow replays per target                                       |
| `stepTimeoutMs`      | integer                             | `15000`      | Time an action may take (finding a control, navigating)                      |
| `assertionTimeoutMs` | integer                             | `5000`       | How long an assertion may retry before it fails                              |
| `workflowTimeoutMs`  | integer                             | `180000`     | Checked between steps; remaining steps are skipped and the run is an `error` |
| `screenshots`        | `always` \| `on-failure` \| `never` | `on-failure` | When adapters capture screenshots                                            |
| `resetBetweenRuns`   | boolean                             | `false`      | Run `environment.reset` before every workflow; forces `parallel` to 1        |

### `oracles`

| Field               | Type     | Default  | Meaning                                                           |
| ------------------- | -------- | -------- | ----------------------------------------------------------------- |
| `enabled`           | string[] | all four | `step-failure`, `app-error`, `assertions`, `invariants`           |
| `ignoreSignalKinds` | string[] | `[]`     | Signal kinds the `app-error` oracle ignores                       |
| `ignoreSignals`     | string[] | `[]`     | Case-insensitive regular expressions on signal messages to ignore |
| `httpErrorStatus`   | integer  | `500`    | `http-error` signals below this status are ignored                |

Signal kinds: `console-error`, `uncaught-exception`, `network-error`, `http-error`,
`error-page`, `stderr`, `process-exit`, `crash`. See [Oracles](oracles.md).

### `exploration`

| Field                 | Type     | Default | Meaning                                               |
| --------------------- | -------- | ------- | ----------------------------------------------------- |
| `maxWorkflows`        | integer  | `10`    | New workflows per exploration session (all explorers) |
| `maxStepsPerWorkflow` | integer  | `25`    | Longest journey an explorer may record                |
| `parallelExplorers`   | integer  | `2`     | Explorer agents, capped at `maxWorkflows`             |
| `focus`               | string[] | `[]`    | Areas to prioritise, distributed across explorers     |

### `schedule`

| Field                           | Type                                      | Default   | Meaning                                                |
| ------------------------------- | ----------------------------------------- | --------- | ------------------------------------------------------ |
| `continuous.idleMs`             | integer                                   | `600000`  | Pause between cycles in continuous mode                |
| `continuous.exploreEveryCycles` | integer                                   | `3`       | Explore on the first cycle, then every N cycles (needs a provider) |
| `continuous.maxCycles`          | integer                                   | unlimited | Stop after this many cycles                            |
| `cron[].expression`             | string                                    | required  | Cron expression                                        |
| `cron[].action`                 | `run` \| `explore` \| `mutate` \| `cycle` | `cycle`   | What to do                                             |
| `cron[].target`                 | string                                    | all       | Restrict to one target id                              |
| `cron[].changedOnly`            | boolean                                   | `false`   | Replay only workflows affected by commits since the last run |

A continuous cycle explores (on exploration cycles), mutates every target, then replays
everything. With `changedOnly: true`, the replay of a `run` or `cycle` entry is limited to the
workflows whose learned files overlap the files changed between the commit of the last run and
`HEAD`, plus workflows nothing is known about yet; a change to a shared file, or a git history
that cannot be read, replays everything (see
[Architecture](architecture.md#change-aware-selection)). See [CLI](cli.md) for the commands
that use these settings.

## Where files live

With the defaults, everything MutationWorkflow writes is under `.mutationworkflow/` next to
the config file:

```text
.mutationworkflow/
  mw.db                     # SQLite memory (plus mw.db-wal / mw.db-shm while open)
  evidence/runs/<runId>/    # evidence of each replay
  evidence/explore/<sessionId>/  # evidence of each explorer session
  reports/                  # <timestamp>-run.md reports
  setup-proposal.yaml       # setup's proposal when a config already exists
```

Add `.mutationworkflow/` to `.gitignore`. See [Memory](memory.md) for backups and cleanup.
