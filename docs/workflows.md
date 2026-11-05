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
| `fingerprint`            | string             | Identity of the workflow's behaviour, below                             |
| `createdAt`, `updatedAt` | ISO 8601           |                                                                         |

A step:

| Field    | Type        | Meaning                                                               |
| -------- | ----------- | --------------------------------------------------------------------- |
| `id`     | string      | Assigned as `s1`, `s2`, ... when missing; existing ids are kept       |
| `action` | object      | `{ "type": ..., ...parameters }` from the adapter's action vocabulary |
| `note`   | string      | Why a user performs this step, in their terms                         |
| `expect` | assertion[] | Checked immediately after the action                                  |

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
Explorer-saved expectations are assertions the agent verified with `check` before saving.

## How a workflow is replayed

Each replay is a run. Runs happen in a freshly started environment (one per `run` command per
target), with up to `execution.parallel` workflows at a time. For each workflow:

1. A fresh adapter session opens: a new browser context on `about:blank`, or a session with
   no process yet. Nothing is shared between runs.
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

`workflowTimeoutMs` is checked between steps; when exceeded, the remaining steps are skipped
and the run is an `error`. A single action is bounded by `stepTimeoutMs`, and each assertion
retries for up to `assertionTimeoutMs`.

Which workflows run: all `active` and `pending-review` workflows of the selected targets, or
only base workflows, or only mutations, or specific ids.

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
| `error`                  | Infrastructure error message when status is `error`                                    |

`signature` on a signal is its message with volatile parts (timestamps, UUIDs, long hex ids,
numbers, quoted strings) normalised, so the same error from different runs groups together.

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

Findings reference the evidence of the failing step plus the last screenshots of the run.
