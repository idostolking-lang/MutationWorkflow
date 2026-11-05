# Mutations

In classic testing, "mutation testing" mutates the code to check that the tests notice. In
MutationWorkflow, a mutation is a change to a user **workflow**, not to code: skip a step, do it
twice, reload in the middle, type something odd, act as another role, interleave two journeys.
The application stays as it is; the mutated workflow tests it in the sequences real users
produce and nobody wrote a test for. Deterministic operators derive these variants from every
base workflow; an optional mutator agent proposes semantically richer ones. Variants are stored
as ordinary workflows and replayed like any other.

Related: [README](../README.md) · [Workflows](workflows.md) · [Oracles](oracles.md) ·
[Adapters](adapters.md#mutation-hints) · [Configuration](configuration.md#mutations) ·
[CLI](cli.md)

## How variants are generated

`mutate` takes the target's base workflows (no parent; `active` or `pending-review`), and for
each one runs the configured operators (`mutations.operators`, default all nine, in this
order):

`skip-step`, `reorder-steps`, `repeat-step`, `truncate`, `data-fuzz`, `interrupt`, `timing`,
`role-swap`, `interleave`

Operators are pure and deterministic: the same workflow always yields the same candidates in
the same order. They are adapter-neutral; the adapter's [mutation hints](adapters.md#mutation-hints)
tell them which actions are anchors (`navigate`; `start`, `exec`), which carry user input,
which sequences interrupt a flow, and which action waits.

Each accepted variant becomes a workflow with:

| Field      | Value                                                        |
| ---------- | ------------------------------------------------------------ |
| `title`    | `<base title> (<suffix>)`, e.g. `Add a todo (repeat step 3)` |
| `intent`   | The base's intent                                            |
| `origin`   | `mutation`                                                   |
| `status`   | The base's status (`active` or `pending-review`)             |
| `parentId` | The base workflow's id                                       |
| `mutation` | `{ operator, description, params }`                          |
| `tags`     | The base's tags plus `mutation` and the operator id          |
| `steps`    | Renumbered `s1`, `s2`, ...                                   |
| `expect`   | The operator's choice (below), otherwise the base's          |

Every action and assertion is validated by the adapter before storing; invalid variants are
skipped with a warning.

### Fairness, cap and dedupe

- **Round-robin.** Generation takes one candidate from each operator in turn, so a prolific
  operator (`data-fuzz` produces one candidate per input step per fuzz value) cannot use the
  whole budget before `interrupt`, `timing` or `interleave` produce anything.
- **Cap.** `mutations.maxVariantsPerWorkflow` (default 25) is a total per base workflow:
  variants already stored for the base (by operators or the agent) count against it, and a base
  that has reached it gets no new operator variants.
- **Dedupe.** A candidate whose fingerprint (target, identity, actions) equals the base's, an
  earlier candidate's, or any workflow already stored for the target is dropped and does not
  count toward the cap.

Running `mutate` again therefore converges: it only fills the remaining room under the cap
(for example after you raise it or delete variants), and continuous mode stops adding operator
variants once every base is full. A base whose status changes from `pending-review` to `active`
(or `archived`) takes its variants with it.

## The operators

"Keeps" refers to step expectations (`steps[].expect`) and final expectations (`expect`).
Anchors are never removed, moved or repeated.

### `skip-step`

Removes one non-anchor step at a time. Suffix: `skip step N`. Applies to workflows with at least
two steps, as long as a non-anchor step remains. Keeps all expectations: the application should
refuse the next action cleanly (a `blocked` step, which is not reported on mutations) or recover;
a failed expectation becomes a finding for triage.

### `reorder-steps`

Swaps each adjacent pair of non-anchor steps. Suffix: `swap steps N and N+1`. Keeps all
expectations; they travel with their steps. The app should handle the other order or refuse it.

### `repeat-step`

Performs one non-anchor, non-wait step twice in a row: double clicks, double submits, retried
requests. Suffix: `repeat step N`. The inserted copy has no expectations (they describe the state
after one performance); the original step's and the final expectations are kept, so "submitting
twice created two items" fails a final `element-count`.

### `truncate`

Abandons the workflow part-way: keeps the leading anchors plus 1, 2, ... up to all but the last
step. Suffix: `stop after step K`. Applies to workflows with at least three steps. Clears final
expectations (they no longer apply); kept steps keep theirs. Only crashes, server errors and
invariants (for example "no orphaned records") can fail these.

### `data-fuzz`

For every step whose action is an input action (`fill.value`, `select.value`; `write.text`),
replaces the value with each fuzz value. Suffix: `fuzz step N with <label>`, where the label is
`empty value`, `whitespace`, `<length>-char value` for values over 24 characters, or the quoted
value. Clears expectations from the fuzzed step onward (that step's, every later step's and the
final ones), since everything after the changed data may legitimately differ; earlier steps keep
theirs. These variants find crashes, server errors and broken invariants, not validation
messages.

`DEFAULT_FUZZ_VALUES`, used unless `mutations.fuzzValues` is set:

| Value                         | Probes               |
| ----------------------------- | -------------------- |
| `""`                          | Empty input          |
| `" "`                         | Whitespace only      |
| `"x"` repeated 2000 times     | Length limits        |
| `"Ünïcødé 🧪 テスト"`         | Unicode, emoji, CJK  |
| `"<script>alert(1)</script>"` | HTML injection       |
| `"' OR 1=1 --"`               | SQL injection        |
| `"-1"`, `"0"`                 | Numeric boundaries   |
| `"99999999999999999999"`      | Overflow             |
| `"  padded  "`                | Trimming             |
| `"line1\nline2"`              | Embedded newline     |
| `"{{template}}"`              | Template injection   |
| `"null"`, `"undefined"`       | Stringly-typed nulls |

For the cli adapter, a fuzzed `write` sends the value as typed input (a newline inside it
submits two lines).

### `interrupt`

Inserts each interrupt sequence after each non-anchor step except the last: `reload` and
`back, forward` for web, `signal SIGINT` for cli. Suffix: `reload after step N`,
`back then forward after step N`, `signal after step N`. Keeps all expectations: the rest of the
workflow should still work, or the app should refuse it cleanly. State kept only in memory is
lost; a handler that assumes it is not (the todo-web "reload mid-edit, then save" bug) throws.

### `timing`

Needs the adapter's wait action. Two variants:

- `no waits`: removes every wait step, so the app receives actions as fast as possible (only
  when the workflow has some waits and something else). Keeps expectations.
- `pause before last step`: inserts a 2000 ms wait before the last step, so debounces, timers
  and expiring state fire. Keeps expectations.

On the cli adapter, `wait {prompt}` steps are wait actions too, so `no waits` removes the
synchronisation on the prompt as well.

### `role-swap`

Performs the same steps as each other configured identity (suffix `as <identity>`) and, when the
workflow has an identity, anonymously (suffix `anonymous`). Clears final expectations, since
another role may legitimately be refused; step expectations are kept. What remains: crashes,
invariants, and the question whether a step that should have been refused was allowed.
Produces nothing for targets without identities and anonymous workflows.

### `interleave`

Alternates this workflow's steps with those of another base workflow of the same identity, as
a user with two tabs or two tasks in flight would. Partners: other non-mutation workflows with at
least two steps, sorted by title, at most three. A step whose action equals the previous step's
action is dropped, so two workflows that both start with `navigate /` share one. Suffix:
`interleaved with "<other title>"`. Clears final expectations (neither holds for the mixture);
step expectations are kept.

## Agent-proposed mutations

`mutate --agent` additionally asks the mutator agent (see [Agents](agents.md)) for variants the
operators cannot express: stale views, revisiting a finished flow, undo after side effects, data
valid in one step and invalid in a later one. For each of the first 10 base workflows, the agent
sees the workflow, the target, the adapter vocabulary and the descriptions of existing variants,
and proposes up to 6 complete step lists, each with a `titleSuffix`, a `description` and
optional final expectations.

Agent variants are stored like operator variants with `mutation.operator: "agent"` and tags
`mutation` and `agent`; they keep the base's identity, are deduplicated by fingerprint and
validated by the adapter, and take the base's status. When a proposal omits `expect`, the
variant gets no final expectations (`expect: []`), so only crashes, server errors and invariants
can fail it. The agent's up to 6 proposals are not limited by the remaining cap, but they count
against it for later operator runs. Proposed step ids are discarded and every step gets a
positional id (`s1`, `s2`, ...), since a model copying ids from the base would create collisions.

Without a model provider, or without a model for the `mutator` role, `mutate --agent` fails
with `PROVIDER_NOT_CONFIGURED` before doing anything; plain `mutate` needs no model.

## Reading results from mutated workflows

A mutated workflow failing is not automatically a bug. The engine accounts for that:

- **Blocked is fine.** If the app refuses a mutated sequence (a control is missing, the process
  has exited), the step is `blocked` and the `step-failure` oracle stays silent. The run status
  is `blocked`, not `failed`.
- **Errors are bugs.** Crashes, uncaught exceptions, 5xx responses, unexpected exits and broken
  invariants fail the run whatever the mutation was. These are the most reliable results;
  `app-error` and `invariants` findings group across workflows, so ten variants hitting the
  same server error are one finding with ten occurrences. Failed expectations and failed steps
  are grouped per exact workflow, so each variant reports its own.
- **Failed expectations need judgement.** On a mutation, a failed expectation is `medium`
  severity and goes to triage: "an item is missing because the step that adds it was skipped"
  is not a bug; "submitting twice created two items" is. The triager decides, or asks you.

Practical reading order: open findings by severity, look at the mutation description in the
reproduction, replay the single variant, and compare its run with the latest run of the parent
(`parentId`). When a base workflow fails, fix or update it first: its variants inherit its
expectations.
