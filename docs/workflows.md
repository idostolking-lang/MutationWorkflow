# Workflows

A workflow is an ordered sequence of user actions with an intent ("add a todo and mark it
done"), the expectations checked after each step and at the end, and optionally the identity it
runs as. Workflows are the unit MutationWorkflow remembers, mutates and replays. They are plain
data: fully serialisable, adapter-specific in their actions, and replayed deterministically
without a model in the loop. This page describes the record, how workflows enter memory, how a
replay works, and what a run records.

Related: [README](../README.md) · [Configuration](configuration.md) · [Adapters](adapters.md) ·
[Mutations](mutations.md) · [Oracles](oracles.md) · [Memory](memory.md) · [CLI](cli.md)

## The record

| Field                    | Type               | Meaning                                                                 |
| ------------------------ | ------------------ | ----------------------------------------------------------------------- |
| `id`                     | string             | `wf_` followed by a time-sortable id                                    |
| `targetId`               | string             | Target from the config                                                  |
| `title`                  | string             | Short and specific, e.g. "Add item then undo"                           |
| `intent`                 | string             | What the user is trying to achieve                                      |
| `origin`                 | enum               | `seed`, `imported-test`, `discovered`, `mutation`, `manual`             |
| `status`                 | enum               | `active`, `pending-review`, `archived`                                  |
| `parentId`               | string             | Base workflow a mutation was derived from                               |
| `mutation`               | object             | `{ operator, description, params? }`; `operator` is an id or `agent`    |
| `identity`               | string             | Identity from the target config to set up first; anonymous when absent  |
| `steps`                  | array (at least 1) | Steps, below                                                            |
| `expect`                 | assertion[]        | Final-state assertions, checked after the last step                     |
| `tags`                   | string[]           | Free labels; mutations get `mutation` plus the operator id              |
| `source`                 | object             | `{ file?, name?, framework? }`: the test this workflow was derived from |
| `touches`                | object             | What its runs exercised: `{ urls, endpoints, files, updatedAt }`, below |
| `fingerprint`            | string             | Identity of the workflow's behaviour, below                             |
| `createdAt`, `updatedAt` | ISO 8601           |                                                                         |

A step:

| Field    | Type        | Meaning                                                               |
| -------- | ----------- | --------------------------------------------------------------------- |
| `id`     | string      | `s1`, `s2`, ... by position when missing; see below                  |
| `action` | object      | `{ "type": ..., ...parameters }` from the adapter's action vocabulary |
| `note`   | string      | Why a user performs this step, in their terms                         |
| `expect` | assertion[] | Checked immediately after the action                                  |

Existing step ids are kept when they are unique. If any two steps share an id (typically a
model copied a step together with its id), every step gets a positional id instead, so ids stay
unambiguous. Mutation variants, including agent-proposed ones, always get positional ids.

Actions and assertions are adapter-specific objects with a `type` and parameters; assertions may
also carry a `description`, which is used in findings. The full vocabularies are in
[Adapters](adapters.md).

### Fingerprints

Two workflows are the same when they perform the same actions on the same target as the same
identity. The fingerprint is a hash of `{ targetId, identity, actions }`; titles, notes, tags
and expectations do not change it. The store enforces one workflow per `(target, fingerprint)`,
so rediscovering or re-deriving a known sequence never creates a duplicate.

### Status lifecycle

```text
                 confirm
pending-review ───────────▶ active
      │
      │ dismiss
      ▼
  archived
```

- `active`: expectations are confirmed. Imported tests and manual workflows start here.
- `pending-review`: describes observed or inferred behaviour nobody has confirmed (discovered
  workflows and seeds inferred from code). These still run, because a crash is a bug whatever
  the intended behaviour is. Each one comes with an `expected-behavior` question; answering it
  with `confirm` activates the workflow, `dismiss` archives it (see [Oracles](oracles.md#questions-for-humans)).
- `archived`: kept in memory, never replayed or mutated.

Mutations inherit their base's status: variants of a `pending-review` base are
`pending-review` too. When the base is confirmed or dismissed, its variants move to the same
new status.

## Examples

A web workflow for the `todo-web` example:

```json
{
  "title": "Add a todo and complete it",
  "intent": "Record a task and tick it off",
  "steps": [
    { "action": { "type": "navigate", "url": "/" } },
    {
      "action": { "type": "fill", "target": { "label": "New todo" }, "value": "Buy milk" },
      "note": "Type the task"
    },
    {
      "action": { "type": "click", "target": { "role": "button", "name": "Add" } },
      "expect": [
        { "type": "text-visible", "text": "Buy milk", "description": "New todo is listed" }
      ]
    },
    { "action": { "type": "check", "target": { "role": "checkbox", "name": "Buy milk" } } }
  ],
  "expect": [{ "type": "element-count", "target": { "role": "listitem" }, "min": 1 }],
  "tags": ["todos"]
}
```

A cli workflow for the `counter-cli` example, in YAML:

```yaml
title: Add, undo and redo
intent: Correct a mistake and restore it
steps:
  - action: { type: start }
  - action: { type: wait, prompt: true }
  - action: { type: write, text: add 5 }
  - action: { type: wait, prompt: true }
    expect:
      - { type: output-matches, pattern: '\b5$', since: step }
  - action: { type: write, text: undo }
  - action: { type: wait, prompt: true }
  - action: { type: write, text: redo }
  - action: { type: wait, prompt: true }
    expect:
      - { type: output-matches, pattern: '\b5$', since: step, description: Redo restores 5 }
expect:
  - { type: stderr-empty }
```

These are drafts: `id`, `targetId`, `origin`, `status`, `fingerprint` and timestamps are added
when the workflow is stored.

## How workflows enter memory

| Origin          | Created by                                                                      | Initial status                     |
| --------------- | ------------------------------------------------------------------------------- | ---------------------------------- |
| `imported-test` | Setup: the inspector translates an existing end-to-end test (has `source.file`) | `active`                           |
| `seed`          | Setup: a core journey the inspector inferred from the code                      | `pending-review`                   |
| `discovered`    | Exploration: an explorer agent performed and saved a journey                    | `pending-review`                   |
| `mutation`      | `mutate`: an operator or the mutator agent derived it from a base               | The base's status                  |
| `manual`        | Added by a person, for example through the CLI or MCP server                    | `active`                           |

Every action and assertion is validated against the target's adapter before a seed or
mutation is stored; invalid ones are skipped with a warning. Explorers record only actions that
succeeded (`ok`), so a discovered workflow is a sequence the application actually accepted.
When an explorer saves a workflow, each proposed final expectation is checked against the live
state first; expectations that do not hold are dropped (and the agent is told which).

## How a workflow is replayed

Each replay is a run. Runs happen in a freshly started environment (one per `run` command per
target), with up to `execution.parallel` workflows at a time. For each workflow:

1. A fresh adapter session opens: a new browser context on `about:blank`, or a session with
   no process yet. Nothing is shared between runs. If the session cannot open, the run is
   recorded as `error`.
2. If the workflow has an `identity`, its steps run first. Any outcome other than `ok` aborts
   the run with status `error`.
3. Each step: the action is performed. If it is `ok`, the step's `expect` assertions are
   checked, then `after-step` invariants. The step is `passed`, `failed` (an expectation did
   not hold), `blocked` (the action could not be performed) or `error` (the application or
   adapter broke). The first step that does not pass stops the workflow; the remaining steps
   are `skipped`.
4. If every step passed, the final `expect` assertions are checked.
5. `after-workflow` invariants are checked, also after an early stop.
6. Error signals the application emitted during the run are collected (console errors,
   uncaught exceptions, HTTP errors, stderr errors, crashes; see [Adapters](adapters.md)).
7. The oracles judge the run, and failing oracle results become findings
   ([Oracles](oracles.md)).

`workflowTimeoutMs` bounds the whole run: opening the session, identity setup, and every action
and assertion are each limited to the time that remains, so a hanging adapter call becomes a
step `error` instead of a stuck run. When the budget is used up, the remaining steps are skipped
and the run is an `error`. Within that, a single action is bounded by `stepTimeoutMs`, and each
assertion retries for up to `assertionTimeoutMs`.

One workflow that cannot be run or recorded does not stop the others: the run command collects
such problems (and environment or triage failures) in its `errors` list and still writes the
report.

Which workflows run: all `active` and `pending-review` workflows of the selected targets, or
only base workflows, or only mutations, or specific ids. A run can also be narrowed to the
workflows a code change affects; see [What a workflow touches](#what-a-workflow-touches).

## Run status

| Status    | Meaning                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `passed`  | Every step ran, every assertion held, no oracle failed                                                                               |
| `failed`  | A step failed or errored, an assertion or invariant failed, or an oracle failed (e.g. an error signal)                               |
| `blocked` | Nothing failed, but an action could not be performed                                                                                 |
| `error`   | Infrastructure problem: adapter crash, identity setup failed, environment down, workflow timeout. Says nothing about the application |

`blocked` on a mutated workflow usually means the application refused an out-of-order action:
the delete button is gone after skipping "open the menu", the CLI process exited after an
injected `SIGINT`. That is correct behaviour, so the `step-failure` oracle does not report it
for mutations. Signals, invariants and earlier expectations are still judged, so a mutation that
crashes the server before being blocked is still `failed`. On a base workflow, a blocked step is
a regression: the sequence worked when it was recorded.

## The run record

| Field                    | Contents                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `id`                     | `run_...`                                                                              |
| `workflowId`, `targetId` |                                                                                        |
| `trigger`                | `manual`, `mcp`, `schedule`, `push`, `continuous`, `explore`                           |
| `status`                 | As above                                                                               |
| `steps[]`                | `{ stepId, index, status, durationMs, message?, evidenceIds }`                         |
| `assertions[]`           | `{ assertion, scope: step \| final \| invariant, passed, message?, stepId? }`          |
| `signals[]`              | `{ kind, message, signature, stepId?, details?, at }`                                  |
| `oracles[]`              | `{ oracle, verdict: pass \| fail \| skip, summary?, signature?, severity?, details? }` |
| `evidenceIds`            | Evidence captured during the run                                                       |
| `context`                | `{ jobId?, commit?, branch?, baseUrl?, mutated }`                                      |
| `touched`                | `{ urls, endpoints }`: what this run exercised, from the adapter (empty when unknown)  |
| `error`                  | Infrastructure error message when status is `error`                                    |

`signature` on a signal is its message with volatile parts (timestamps, UUIDs, long hex ids,
numbers, quoted strings) normalised, so the same error from different runs groups together.

## What a workflow touches

Every run records what the session exercised, as reported by the adapter
([Adapters](adapters.md#footprints)): the pages or screens it visited (`urls`, paths without
host) and the backend endpoints or commands it used (`endpoints`, such as `POST /api/todos` or
`add`). The engine folds each run's footprint into the workflow's `touches`, which accumulates
across runs:

| Field       | Contents                                                                   |
| ----------- | -------------------------------------------------------------------------- |
| `urls`      | Every page path any run of the workflow visited, in first-seen order       |
| `endpoints` | Every endpoint or command any run used, in first-seen order                |
| `files`     | Source files or globs behind those pages and endpoints, from the code map  |
| `updatedAt` | When the record last changed                                               |

How it is learned:

- After every replay, the run's footprint is merged into the workflow. A run of a mutation
  variant also teaches its base, so a base workflow knows the endpoints its variants reach
  (a repeated submit, a delete after a skipped step) even when its own sequence never does.
- `files` is recomputed from the accumulated pages and endpoints on every merge, by the code
  map: explicit `targets[].codemap` rules ([Configuration](configuration.md#targetscodemap)),
  plus a search of the repository for files that mention the static part of each path
  literally. `/api/todos/42` is normalised to `/api/todos/*` first, and `/api/todos` is
  searched for, because ids never appear in source code.
- A run that touched nothing (an adapter without footprints, a session that failed to open)
  teaches nothing. Learning happens on replay (`run`) only, not during exploration.

How it drives replay: given a change (a list of files, or a git range), each base workflow of a
target is one of

| Class        | Meaning                                                                       |
| ------------ | ----------------------------------------------------------------------------- |
| `impacted`   | A changed file equals one of its `files`, lies under one, or matches its glob |
| `unknown`    | No `files` yet: it never ran, or nothing it touched maps to a file            |
| `unaffected` | It has `files`, and none of them covers a changed file                        |

A change-aware run replays the impacted and unknown bases and all their variants, and skips the
unaffected ones. Variants are not classified on their own: they follow their base. Everything
runs when a shared file changed (a dependency manifest or lockfile, `tsconfig*.json`, Vite,
Next, webpack or Tailwind config, `Dockerfile`, `docker-compose*.yml`, `Makefile`, a Prisma
schema or a `migrations/` directory) or when no workflow of the target is known to be
unaffected, since a full run then costs the same and teaches more. Without an explicit change,
the files changed since the commit of the last run are used. See
[Architecture](architecture.md#change-aware-selection) for the full rules.

## Evidence

Adapters write evidence through an evidence sink; files land in
`<evidenceDir>/runs/<runId>/` with names like `003-2-click.png`, and the database stores a record
per item (`ev_...`, kind, label, step, path relative to the evidence directory, or inline text).

| Kind               | Web adapter                                                                                         | CLI adapter                             |
| ------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `screenshot`       | After a non-`ok` action (`on-failure`), after every action (`always`), and for `screenshot` actions | not available                           |
| `console`          | Last 50 console lines with every non-`ok` action                                                    |                                         |
| `dom`              | On request (`capture('dom')`)                                                                       |                                         |
| `stdout`, `stderr` |                                                                                                     | Output tails with every non-`ok` action |
| `log`              |                                                                                                     | Full transcript on request              |

When a run is troubled (a step did not pass, an assertion failed or the application emitted a
signal) and screenshots are not `never`, a `final-state` screenshot is captured before the
session closes, because expectation and signal failures leave no failed action with its own
screenshot. Findings reference the evidence of the failing step plus the last screenshots of the
run.
