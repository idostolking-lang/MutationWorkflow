# Oracles, findings and triage

An oracle decides whether a run revealed a problem. For the bugs MutationWorkflow looks for,
that is the hard part: a test case comes with its expected outcome, but nobody wrote down what
should happen when a user submits twice, reloads mid-edit or skips a step. Some outcomes are
wrong whatever the intent (a crash, a 500, a broken invariant); others depend on product intent
(after skipping "add item", the item is rightly missing). MutationWorkflow therefore layers
judgement: deterministic oracles flag candidates, failing results are folded into deduplicated
findings, a triager agent reviews them, and what neither can decide becomes a question for the
team. This page specifies each layer.

Related: [README](../README.md) · [Workflows](workflows.md) · [Mutations](mutations.md) ·
[Agents](agents.md) · [Memory](memory.md) · [CLI](cli.md) · [MCP](mcp.md)

## The oracles

Oracles run after every replay and return results `{ oracle, verdict: pass | fail | skip,
summary, signature, severity, details }`. `oracles.enabled` selects them (default: all four). An
oracle that throws yields a `skip` result instead of failing the run.

### `step-failure`

Fails when the workflow could not be performed to the end: it reports the first step whose
status is `blocked` or `error`. Steps that were performed but whose expectations failed
(`failed`) are left to the `assertions` oracle, so one failed expectation yields one finding.

| Case                                           | Result                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| Run ended with an infrastructure error         | Nothing (the run is `error`)                                     |
| Base workflow, step `blocked`/`error`          | `fail`, severity `high`                                          |
| Mutated workflow, step `blocked`               | `skip`: the app refused an out-of-order action, which is correct |
| Mutated workflow, step `error`                 | `fail`, severity `medium`                                        |

Signature: `step-failure:<status>:<hash of the step's action>`. The action, not its position,
identifies the step, because indices shift between variants of a base workflow.

### `app-error`

Fails when the application emitted error signals, independently of any expectation. One result
per distinct signal signature in the run, with a count.

| Signal kind          | Severity |
| -------------------- | -------- |
| `crash`              | critical |
| `process-exit`       | critical |
| `uncaught-exception` | high     |
| `http-error`         | high     |
| `error-page`         | high     |
| `network-error`      | medium   |
| `console-error`      | medium   |
| `stderr`             | medium   |

Filtering, from the `oracles` config: signals whose kind is in `ignoreSignalKinds` are dropped;
signals whose message matches one of `ignoreSignals` (case-insensitive regular expressions) are
dropped; `http-error` signals with a status below `httpErrorStatus` (default 500) are dropped, so
4xx responses are ignored by default.

Signature: `app-error:<signal signature>:<HTTP status or empty>`. The signal signature already
has timestamps, UUIDs, long hex ids, numbers and quoted strings normalised; the status is
appended because number normalisation would otherwise merge a 500 with a 503.

### `assertions`

Fails when a step or final expectation did not hold (invariants are excluded). One result per
run, keyed on the first failure, with the others listed in `details`.

- Severity `high` on base workflows (a regression), `medium` on mutated ones (the mutation may
  have made the expectation inapplicable, or revealed a real bug).
- Signature: `assertions:<step|final>:<stepId or "final">:<assertion type>`.
- Summary: `step s3: New todo is listed (Text "Buy milk" is not visible)`, using the assertion's
  `description` when present.

### `invariants`

Fails once per violated invariant check (see [Configuration](configuration.md#targetsinvariants)).
Severity `high`. Signature: `invariants:<assertion type>:<invariant description or id>`. A broken
invariant is a bug whatever the workflow did.

## From oracle results to findings

Each failing oracle result is recorded as a finding or merged into an existing one. The finding
fingerprint is a hash of:

| Part        | Value                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `targetId`  | The target                                                                                                     |
| `oracle`    | The oracle id                                                                                                  |
| `signature` | The result's signature (or its summary when it has none)                                                       |
| `scopeKey`  | `null` for `app-error` and `invariants`; otherwise the id of the exact workflow that ran (base or variant)      |

So problems the application reports itself (a given server error, a broken invariant) are
grouped **across all workflows**, because a 500 from one endpoint is one bug however it was
reached. Failed steps and expectations are grouped **per exact workflow**: a mutated sequence
that breaks an expectation is a problem of that sequence, and its steps are the reproduction.

A new finding:

| Field          | Value                                                                      |
| -------------- | -------------------------------------------------------------------------- |
| `id`           | `fnd_...`                                                                  |
| `title`        | The oracle summary, at most 140 characters                                 |
| `summary`      | The summary, the workflow title and intent, the mutation, the failing step |
| `severity`     | From the oracle (`medium` if none)                                         |
| `detectedBy`   | The oracle id (`human` for findings created from answers)                  |
| `status`       | `open`                                                                     |
| `triage`       | `{ state: "pending" }`                                                     |
| `reproduction` | `{ workflowId, steps, mutation }` of the run that found it                 |
| `evidenceIds`  | Evidence of the failing step plus the run's last screenshots               |
| `occurrences`  | `1`, with `firstSeenAt` = `lastSeenAt` = now                               |

When a finding with the same fingerprint exists, it is updated: `occurrences` + 1,
`lastSeenAt`, the workflow and run ids added, the newest 30 evidence ids kept. A `fixed`
finding that reappears is **reopened** (`open`) with a note "Reappeared on <time> after being
marked fixed." `open`, `confirmed` and `dismissed` findings keep their status and triage.

### Finding statuses

| Status      | Set by                                                     |
| ----------- | ---------------------------------------------------------- |
| `open`      | New findings; reopened `fixed` findings                    |
| `confirmed` | The team, or an answer that says it is a bug               |
| `fixed`     | The team, after a fix; reopened automatically if it recurs |
| `dismissed` | Triage verdict `not-a-bug`, a duplicate, or the team       |

## Triage

Triage is the review of automatically detected findings.

| `triage.state` | Meaning                                                        |
| -------------- | -------------------------------------------------------------- |
| `pending`      | Waiting for the triager agent (or a human)                     |
| `done`         | Carries `verdict`, `rationale`, `model` and `at`               |
| `skipped`      | No model provider was configured when the finding was created  |

After each `run`, the findings it created or updated that are still `pending` are triaged per
target, in batches of 8. The triager receives a dossier per finding: detector, severity guess,
occurrences, the workflow with its origin and status (a `pending-review` workflow's expectations
were written by an agent and nobody confirmed them; an `imported-test` one encodes confirmed
intent), every step's outcome, the mutation, for a variant the base workflow's latest run result
(if the unmodified sequence passes, the variant is compared against it), failed expectations,
error signals and evidence ids. It can call `get_evidence` (screenshots as images when vision is on),
`get_run` and `get_workflow`. It returns one decision per finding:

| Verdict       | Effect                                                                  |
| ------------- | ----------------------------------------------------------------------- |
| `bug`         | Title, summary and severity replaced by the triager's; status unchanged |
| `not-a-bug`   | Same, and status `dismissed`                                            |
| `needs-human` | Same, and an `is-this-a-bug` question is created                        |

`duplicateOf: <finding id>` dismisses the finding with a note "Duplicate of <id>." and merges
its run ids, workflow ids and occurrences into the primary. It is honoured only when the primary
is another existing finding of the same target, is `open` or `confirmed`, and is not itself
marked as a duplicate in the same batch; otherwise (an invented id, a cycle, a dismissed primary)
it is ignored with a warning and the verdict applies on its own, so a real bug is never dismissed
on a typo. Each finding is re-read before its decision is applied, so occurrences that a
concurrent run added are kept.

Findings the triager leaves out stay `pending`. If the agent fails, runs out of budget, or the
model call errors (rate limits, network), the batch stays `pending`, the run carries on, and the
failure is listed in the run's `errors`.

Without a model provider, or without a model for the `triager` role, pending findings from a run
are marked `skipped` so they do not look stuck. Once a provider is configured, `mw triage --include-skipped` ([CLI](cli.md)) revisits them
along with pending ones; only `open` findings are considered.

The triager's rules of thumb: a crash, unhandled exception, server error or corrupted state is
always a bug, however unusual the sequence; a failed expectation on a mutation is a bug only when
the app should have prevented or handled the mutated sequence.

## Questions for humans

Questions record what only the team can answer. Each has a `kind`, the question text, a
`context` (`workflowId`, `runId`, `findingId`, `evidenceIds`), and a status `open` or `answered`.

| Kind                | Raised by                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `expected-behavior` | Every workflow an explorer saves; every `pending-review` seed from setup                          |
| `is-this-a-bug`     | A triage verdict `needs-human`                                                                    |
| `setup`             | Questions in the inspector's report; a start command that did not come up during setup validation |

Answering takes a decision (`confirm`, `bug` or `dismiss`) and optional text, and marks the
question `answered`. `confirm` always means "this behaviour is intended", `bug` means "the
application misbehaved", `dismiss` means "ignore it". Effects:

| Question references             | `confirm`                                              | `bug`                                                                                                                         | `dismiss`                                               |
| ------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| A finding                       | Finding `dismissed`, verdict `not-a-bug`               | Finding `confirmed`, verdict `bug`                                                                                            | Finding `dismissed`, verdict `not-a-bug`                |
| A workflow (no finding)         | If `pending-review`: workflow and its variants `active` | New finding: `confirmed`, severity `medium`, `detectedBy: human`, verdict `bug`, titled `Unexpected behaviour in "<title>"`; workflow unchanged | If `pending-review`: workflow and its variants `archived` |

A question that references a finding decides only the finding, even when it also names the
reproduction workflow (as `is-this-a-bug` questions from triage do): only `bug` confirms the
finding; `confirm` (intended behaviour) and `dismiss` both dismiss it with verdict `not-a-bug`; the
workflow's status never changes. The question text the triager writes ends with these three
choices spelled out. The answer text, or a default such as "The team confirmed this behaviour is
intended", becomes the triage rationale.

## Reports

Every `run` that executed at least one workflow writes a Markdown report to
`<reportsDir>/<timestamp>-run.md` (e.g. `.mutationworkflow/reports/2026-11-05T14-03-12-345Z-run.md`):

```markdown
# MutationWorkflow run (manual)

Generated 2026-11-05T14:03:12.345Z for `todo`.

## Summary

| Passed | Failed | Blocked | Error | Total |
| ------ | ------ | ------- | ----- | ----- |
| 41     | 3      | 12      | 0     | 56    |

Model usage: 4 calls, 38,112 input and 2,406 output tokens, about $0.20.

## Findings (1)

### Saving an edit after deleting the todo returns HTTP 500

- Severity: **high** · Status: open · Detected by: app-error · Seen 2 times
- Triage: bug (PATCH on a deleted id throws a TypeError on the server)
- Id: `fnd_01jc...`

Reproduction (workflow "Edit a todo (swap steps 3 and 4)"):

Mutation: Performs step 4 (click) before step 3 (click); ...

1. navigate url="/"
2. click target={"role":"button","name":"Edit Buy milk"}
   ...

## Runs (56, 15 not passing)

| Status | Workflow | Mutation | Duration | Run |
| ------ | -------- | -------- | -------- | --- |
```

Sections: summary counts, model usage for the job (when any), each finding created or updated
by the run (severity, status, detector, occurrences, triage verdict and rationale, summary,
reproduction steps, evidence count), and one row per run.

### Errors that do not stop a run

A run command does not abort when one part fails. A workflow that cannot be executed or
recorded, a target whose adapter or environment cannot start, a failed triage call, and a report
that cannot be written are each logged and collected in the run summary's `errors` list
(`RunSummary.errors`), and the remaining workflows and targets still run. The report is written
for whatever ran. Session and identity failures inside a workflow are not in `errors`: they are
recorded as runs with status `error` (see [Workflows](workflows.md#run-status)).
