# Agents

MutationWorkflow uses language-model agents for the parts that need judgement: understanding a
repository, discovering what users do with an application, imagining unusual-but-plausible
variants, and reviewing findings. Everything else (replaying workflows, deriving operator
mutations, running oracles, writing reports) is deterministic and runs without a model. This page
describes the four agent roles, how models are configured, parallelism and delegation,
budgets and cost estimates, and how to keep model spend low.

Related: [README](../README.md) · [Configuration](configuration.md#agents) ·
[Workflows](workflows.md) · [Mutations](mutations.md) · [Oracles](oracles.md#triage) ·
[Memory](memory.md) · [CLI](cli.md)

## Roles

| Role        | Used by          | Sees                                                                                                                                  | Tools                                                                                                         | Produces                                                                                                           |
| ----------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `inspector` | setup            | The repository (read-only, credential files hidden), the vocabularies of the registered adapters                                      | `list_files`, `read_file`, `search`                                                                           | An inspection report: summary, stack, proposed targets, features, existing tests, seed workflows, risks, questions |
| `explorer`  | explore          | The target description, identities, invariants and scope; the adapter vocabulary and guide; titles of known workflows; its assignment | `observe`, `act`, `check`, `save_workflow`, `reset`, `list_workflows`, `use_identity` (when identities exist) | `discovered` workflows (`pending-review`) with questions, and a summary of what looked suspicious                  |
| `mutator`   | `mutate --agent` | One base workflow, the target, the vocabulary, existing variant descriptions                                                          | none besides `finish`                                                                                         | Up to 6 variants per base ([Mutations](mutations.md#agent-proposed-mutations))                                     |
| `triager`   | run, triage      | Dossiers of up to 8 pending findings: steps with outcomes, mutation, failed expectations, signals, evidence ids                       | `get_evidence`, `get_run`, `get_workflow`                                                                     | A verdict, title, summary, severity, rationale and optional duplicate per finding ([Oracles](oracles.md#triage))   |

Every agent also gets `finish` (when a structured result is expected). The inspector and the
triager also get `delegate` below the depth limit; explorers and the mutator run without it,
because an explorer's tools are bound to its one live adapter session. All prompts include the
same safety rules: only interact with the local test instance, never trigger real-world side
effects even if the UI offers them, stay in scope and treat a refusal as information.

### What agents do not see

- **Target secrets.** The target description in prompts shows only the options `baseUrl`,
  `command`, `args`, `cwd`, `promptPattern`, `browser`, `headless` and `viewport`, plus identity
  ids and descriptions. Identity steps (logins) and the `env`, `launchOptions` and
  `storageStatePath` options are never sent to a model; the copy stored in the database is
  redacted the same way.
- **Credential files.** The inspector's `list_files`, `read_file` and `search` hide `.env*`,
  `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `id_rsa*` (and other `id_*` keys),
  `credentials*`, `secrets*`, `.npmrc`, `.netrc` and `.aws`/`.azure`/`.gcloud` files, whatever the
  repository's `.gitignore` says. They never follow symbolic links and refuse any path that
  resolves outside the project. Generated and vendored directories (`node_modules` and the like)
  are skipped, and file and listing sizes are capped.
- **Old screenshots.** Only the two most recent images stay in an agent's conversation; older
  ones are replaced by the placeholder `[earlier screenshot omitted to save context]`, which keeps
  long explorations within provider image limits and cost.

### Exploration in detail

`exploration.parallelExplorers` explorers (capped at `maxWorkflows`) run at once, each in its own
adapter session. With no `focus`, they get different angles: primary journeys end to end; edge
cases (empty input, cancel, undo, validation); navigation and recovery (back, reload, stale
views); secondary features. With `focus`, the items are distributed across explorers.

An explorer acts one step at a time with `act`; every action with outcome `ok` is recorded as a
step (blocked and failed ones are not). `save_workflow` turns the recorded steps into a workflow:
it checks each proposed final expectation against the live state and keeps only those that hold
(the agent is told which were dropped), refuses an exact duplicate (same fingerprint), stores a
final screenshot and opens an `expected-behavior` question. `reset` starts a fresh session between
journeys; `use_identity` must be called right after a reset, before any step is recorded. If one
explorer fails fatally (its session cannot open, the runtime breaks), the others are aborted,
since the environment is probably gone; the failures are listed in the result's `errors`. The session budget (`maxWorkflows`) is shared by all explorers; each journey is capped
at `maxStepsPerWorkflow` steps. Evidence goes to `<evidenceDir>/explore/<sessionId>/`.

### Setup in detail

The inspector studies the repository and proposes targets, seed workflows and questions. Its
start and reset commands are model-written, so setup does not run them by default: pass
`--validate` (`mw setup --validate`, or `validate: true` to `mw_setup` over MCP) to start each
proposed environment once. Validation only happens for a config setup just created, never for a
proposal written next to an existing config, and each start command is logged before it runs. A
failing start command becomes a `setup` question.

## Choosing models

Model settings are resolved per role: `agents.defaults`, then `agents.roles.<role>` field by
field on top.

```yaml
agents:
  defaults:
    provider: anthropic
    model: claude-opus-5-5
    effort: medium
  roles:
    explorer: { vision: true, maxTurns: 120 }
    triager: { model: claude-sonnet-5-5, effort: low }
    mutator: { provider: local, model: qwen3-coder }
```

| Setting     | Default when unset                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| `provider`  | The first provider of type `anthropic`, otherwise the first provider                                     |
| `model`     | The provider's default: `claude-opus-5-5` for Anthropic; OpenAI-type providers have none, so set `model` |
| `effort`    | Not sent                                                                                                 |
| `maxTurns`  | `60` model calls per agent run                                                                           |
| `maxTokens` | `16000` output tokens per call                                                                           |
| `vision`    | Whether the provider supports images (both built-in providers do)                                        |

### Providers

With no `providers` section, providers are inferred from the environment:

| Variable            | Provider id | Type        |
| ------------------- | ----------- | ----------- |
| `ANTHROPIC_API_KEY` | `anthropic` | `anthropic` |
| `OPENAI_API_KEY`    | `openai`    | `openai`    |

Explicit entries replace inference entirely. The map key is the provider id that roles refer to:

```yaml
providers:
  anthropic:
    type: anthropic # apiKeyEnv defaults to ANTHROPIC_API_KEY
  local:
    type: openai # any OpenAI-compatible endpoint
    baseUrl: http://127.0.0.1:11434/v1
    apiKeyEnv: LOCAL_LLM_KEY # must be set, any value the server accepts
    pricing: { input: 0.5, output: 1.5 } # optional; enables cost estimates
```

A provider whose key variable is unset is skipped with a warning. With no provider at all,
agent commands (setup, explore, triage, `mutate --agent`) fail early with
`PROVIDER_NOT_CONFIGURED`, as they do when the role they need has no model; runs mark new
findings' triage as `skipped` (also when only the triager role lacks a model).

The Anthropic provider streams requests and enables automatic prompt caching for the whole
prompt prefix, which makes long tool loops cheap. The OpenAI provider uses Chat Completions with
function tools; `effort` maps to `reasoning_effort` (`xhigh` and `max` become `high`).

### Effort and vision

`effort` (`low`, `medium`, `high`, `xhigh`, `max`) is passed to providers that support reasoning
effort. Lower effort suits the triager and mutator; exploration and inspection benefit from more.

With `vision` on, explorers receive a screenshot with every observation and the triager can view
screenshot evidence; with it off, explorers work from the text observation (the ARIA snapshot or
the terminal transcript) and the triager is told where a screenshot is stored instead.
Exploration takes observation screenshots unless `execution.screenshots` is `never`. Only the two
most recent screenshots stay in context (see above).

## Parallelism and delegation

`agents.maxParallel` (default 3) is a single semaphore around **model calls** across every agent
and sub-agent in the process. It is the practical meaning of "use up to 3 agents at a time":
explorers, the inspector's sub-agents and a triager all share the same permits. Only the API call holds a
permit; tool execution (performing actions, reading files, waiting for sub-agents) does not, so a
parent waiting on its delegates never blocks them.

`delegate` lets the inspector or triager split independent work: it takes 1 to `max(2, 2 × maxParallel)` tasks,
each `{ title, task }`, runs a sub-agent per task in parallel with the same role, system prompt
and tools, and returns each sub-agent's final text. Sub-agents have no `finish` tool and are
told to report their results as plain text in their final message. They do not see the parent's
conversation, so tasks must be self-contained. Depth is limited: top-level agents (depth 0) and
their delegates (depth 1) can delegate; depth-2 sub-agents cannot. The inspector is told to use
it for large repositories (tests, routing, infrastructure in parallel).

## Structured results

When a caller needs structured output, the agent gets a `finish` tool whose input schema is that
output (the inspection report, exploration summary, variants, triage decisions). Input is
validated before it is accepted; invalid input returns an error the model can correct. An agent
that stops calling tools without calling `finish` is reminded once; if it still does not, the run
ends with `stoppedBecause: "error"`. Other stop causes: `finished`, `max-turns`, `budget`,
`refusal`, `aborted`. Tool output is truncated to 40,000 characters per text part.

## Budgets and cost

```yaml
agents:
  budget:
    maxTokensPerJob: 2000000 # uncached input + output tokens
    maxUsdPerJob: 10 # estimated cost
```

Budgets apply per job (one CLI command or MCP job, including continuous mode as a whole);
spend is tracked in memory by the running process, and model calls made outside a job are not
budgeted. The check runs before every model call; once a limit is reached, each agent in the job stops with
`stoppedBecause: "budget"` and whatever it produced so far is kept. A call already in flight
completes, so a job can overshoot by the calls running at that moment.

Every model call is recorded in the `usage` table: job, role, provider, model, input, output,
cache-read and cache-write tokens, and the estimated cost. Both providers report input tokens
without cached ones (cached reads are counted separately), so `maxTokensPerJob` means the same
thing for both. Costs are **estimates**:

- Anthropic providers use a built-in table of list prices (USD per million tokens, matched by
  model-id prefix so dated snapshots share a price; cache writes at 1.25× input unless stated).
- A provider entry's `pricing` (`input`, `output`, optional `cacheRead` defaulting to a tenth of
  input, optional `cacheWrite` defaulting to 1.25× input) applies to every model of that entry and
  overrides the table. For `openai` providers it is the only source of estimates.
- Without a price (an unknown model, or an `openai` provider without `pricing`) there is no
  estimate, and `maxUsdPerJob` cannot trigger; use `maxTokensPerJob` there. Your provider's billing is authoritative. Totals appear in reports and
status output; see [Memory](memory.md#usage-and-cost) for querying them.

Agent progress is emitted as events (`turn` with usage, `tool` with a summary, `text`) that the
CLI and MCP server surface.

## What runs without a model

| Works without a provider                                    | Needs a provider                 |
| ----------------------------------------------------------- | -------------------------------- |
| Replaying workflows (`run`), environments, evidence         | `setup` (inspector)              |
| Operator mutations (`mutate`)                               | `explore` (explorers)            |
| All oracles, findings, merging, reopening                   | `mutate --agent` (mutator)       |
| Reports, search, questions and answers, status              | Triage (findings stay `skipped`) |
| Continuous mode (replay and mutate; exploration is skipped) |                                  |

## Saving cost

- Replay is free. Once workflows are in memory, `run` on every push or on a schedule costs
  nothing; operators generate most of the useful variants deterministically.
- Explore occasionally: after features land, with a `focus`, and with a small `maxWorkflows`.
  In continuous mode, raise `schedule.continuous.exploreEveryCycles`.
- Use a cheaper model and `effort: low` for the triager and mutator; triage runs only for new or
  updated pending findings, in batches of 8.
- Leave `vision` off for roles that do well on text observations; screenshots are the largest
  inputs.
- Set `maxUsdPerJob` (with a known price) or `maxTokensPerJob` as a safety net, and lower `maxTurns` for
  roles that wander.
- Prompt caching is automatic with the Anthropic provider; you do not need to configure it.
