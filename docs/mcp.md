# MCP server

`mw mcp` (or `npx -y mutationworkflow mcp`) serves MutationWorkflow over the Model Context
Protocol on stdio, so a coding agent such as Claude Code, Codex or Cursor can set it up, explore,
replay and read findings for the project it is working on.

The server works on one project: `$MW_PROJECT_DIR` when set, otherwise the directory the client
starts it in. Without a config it still starts, so `mw_setup` can create one. Logs go to stderr;
stdout carries only the protocol. When the client disconnects, running jobs are cancelled, the
environments they started are stopped, and the database is closed.

The agent roles (inspector, explorer, triager, mutator) can run in the server, with a model
provider it is configured with, or in the connected coding agent itself, with the client's own
model and no API key: see [Bring your own agent](#bring-your-own-agent). Replaying and reading
never need a model.

## Connecting

### Claude Code

```sh
claude mcp add mutationworkflow -- npx -y mutationworkflow mcp
```

That is enough for Claude Code to run every role itself. To let the server run them as background
jobs too, pass a key (and set `agents.defaults.model` in the config):

```sh
claude mcp add mutationworkflow -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY -- npx -y mutationworkflow mcp
```

Or share it with the team in `.mcp.json` at the project root (add
`"env": { "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}" }` for server-run roles; Claude Code
expands `${VAR}` from your environment):

```json
{
  "mcpServers": {
    "mutationworkflow": {
      "command": "npx",
      "args": ["-y", "mutationworkflow", "mcp"]
    }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.mutationworkflow]
command = "npx"
args = ["-y", "mutationworkflow", "mcp"]
# Long operations run as jobs, but give the first npx download time.
startup_timeout_sec = 60

[mcp_servers.mutationworkflow.env]
MW_PROJECT_DIR = "/path/to/your/project"
# Optional: only for roles run by the server rather than by Codex itself.
# ANTHROPIC_API_KEY = "sk-ant-..."
```

Codex starts servers from its own working directory, so set `MW_PROJECT_DIR` (or add
`"--cwd", "/path/to/project"` to `args`) when that is not the project.

### Cursor

`.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` for all projects):

```json
{
  "mcpServers": {
    "mutationworkflow": {
      "command": "npx",
      "args": ["-y", "mutationworkflow", "mcp"],
      "env": { "MW_PROJECT_DIR": "/path/to/your/project" }
    }
  }
}
```

Add `"ANTHROPIC_API_KEY"` (or `"OPENAI_API_KEY"`) to `env` only for roles the server should run
itself.

With a local install (`npm i -D mutationworkflow`), replace `npx -y mutationworkflow` with
`npx mw` or the path to `node_modules/.bin/mw`.

## Bring your own agent

MutationWorkflow has no default model. Each agent role runs in one of three ways:

1. **The connected coding agent itself** (Claude Code, Codex, Cursor). The client asks the
   server for a brief (the role's instructions and the JSON schema of what to submit), does the
   thinking with whatever model the user runs, and calls fine-grained tools. No API key and no
   provider configuration. The `setup`, `explore`, `triage` and `mutate` prompts walk the client
   through each role; in Claude Code they appear as `/mcp__mutationworkflow__setup` and so on.
2. **A coding-agent CLI driver**: a provider of type `claude-code` or `codex` in the config. The
   server starts that CLI for each role, which uses its own login and default model unless
   `model` is set. `mw_status` then shows the model as `<provider> (its own default)`.
3. **An API provider** (`anthropic`, `openai`, OpenAI-compatible) with an explicit model:
   `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the server's environment and
   `agents.defaults.model` (or a per-role model) in the config.

Ways 2 and 3 power the job tools (`mw_setup`, `mw_explore`, `mw_triage`, `mw_mutate` with
`agent`). Without a provider those tools fail with a message naming the client-driven tool to
call instead. `mw_status` reports `agents.models` (model per role) and `agents.problems` (roles
that cannot run with the current configuration, and why).

### Client-driven tools

| Tool                      | Arguments                                                | Returns; what to do next                                                                                                                 |
| ------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `mw_inspect_brief`        | `projectName?`                                           | Inspector instructions, adapter vocabularies, report JSON schema. Read the repo with your own tools, then `mw_inspect_apply`              |
| `mw_inspect_apply`        | `report`, `validate?`, `projectName?`                    | Config path and action (`created` or `proposal-written`), seeded workflows, questions, validation. An invalid report is an error to fix |
| `mw_explore_open`         | `target?`, `focus?: string[]`, `maxWorkflows?`           | `sessionId`, explorer instructions, remaining budget, first observation (with screenshot). Then the session tools                       |
| `mw_observe`              | `sessionId`                                              | Current state (page structure or terminal output) and a screenshot when available                                                        |
| `mw_act`                  | `sessionId`, `action`, `note?`                           | Outcome (ok, blocked, error), application error signals, resulting state. Successful actions are recorded as steps                      |
| `mw_check`                | `sessionId`, `assertion`                                 | PASSED or FAILED with a message; records nothing                                                                                         |
| `mw_save_workflow`        | `sessionId`, `title`, `intent`, `expect?`, `note?`       | Saves the recorded steps as a pending-review workflow with a question; expectations that do not hold are dropped. Remaining budget      |
| `mw_reset_session`        | `sessionId`                                              | Fresh browser context or process, recorded steps cleared. Use between journeys                                                           |
| `mw_use_identity`         | `sessionId`, `id`                                        | Acts as a configured identity (right after a reset); error when the target has none                                                     |
| `mw_list_known_workflows` | `sessionId`                                              | Titles already in memory for the target, to avoid duplicates                                                                             |
| `mw_explore_close`        | `sessionId`, `summary?`                                  | Stops the environment; the saved workflows and the questions raised. The summary is logged                                               |
| `mw_triage_brief`         | `target?`, `includeSkipped?`, `limit?`                   | Triager instructions, dossiers of one batch (8 by default), finding ids, decision JSON schema; or "Nothing pending"                     |
| `mw_triage_apply`         | `decisions` (array, or `{"decisions": [...]}`)           | The updated findings. `not-a-bug` dismisses, `duplicateOf` merges, `needs-human` asks the team. Decided by `mcp-client`                 |
| `mw_mutation_brief`       | `workflowId`                                             | Mutator instructions for one base workflow (with its steps and existing variants) and the variants JSON schema                          |
| `mw_mutation_apply`       | `workflowId`, `variants` (array, or `{"variants": [...]}`) | The created variants (origin `mutation`, operator `agent`); duplicates and steps outside the vocabulary are skipped                     |

The role instructions were written for the in-process runtime, so they name its tools. The briefs
say how they map: `finish` is the apply tool (or `mw_explore_close`), the inspector's
`list_files` / `read_file` / `search` / `delegate` are the client's own tools, the triager's
`get_evidence`, `get_run` and `get_workflow` are `mw_evidence`, `mw_run_detail` and
`mw_workflow`, and the explorer's `observe`, `act`, `check`, `save_workflow`, `reset`,
`use_identity` and `list_workflows` are the `mw_*` session tools above.

### Prompts

| Prompt    | Arguments               | Walks the client through                                                                       |
| --------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| `setup`   | none                    | `mw_status`, `mw_inspect_brief`, reading the repo, `mw_inspect_apply`, reviewing the questions |
| `explore` | `target?`, `focus?`     | `mw_explore_open`, act / check / save / reset per journey, `mw_explore_close`                  |
| `triage`  | `target?`               | `mw_triage_brief`, evidence and code, `mw_triage_apply`, until nothing is pending              |
| `mutate`  | `workflowId?`           | Picking base workflows, `mw_mutation_brief`, `mw_mutation_apply`, replaying with `mw_run`      |

### Exploration sessions

`mw_explore_open` starts the target's environment (its `environment.start` command, or a probe of
its `baseUrl`) and opens one adapter session against it. The server keeps a registry of open
sessions keyed by session id:

- One session per target at a time: sessions and replays of a target share its environment, so a
  second `mw_explore_open` on the same target is refused, and `mw_run` on that target waits until
  the session is closed.
- Calls on one session run one after another.
- A session idle for 30 minutes (no call naming it) is closed and its environment stopped; later
  calls get an error saying to open a new one. What was saved stays saved.
- When the client disconnects, every session is closed and every environment stopped.
- Saved workflows enter memory as `pending review`, each with a question for the team, exactly as
  with `mw_explore`.

### Example flows

**Setup.**

1. `mw_inspect_brief {}` → instructions, adapter vocabularies, report schema.
2. The client reads the README, manifests, start scripts, routes and end-to-end tests itself.
3. `mw_inspect_apply {"report": {"summary": "...", "stack": [...], "targets": [{"id": "web", "kind": "web", "environment": {...}, "options": {...}}], "features": [...], "existingTests": [...], "workflows": [...], "risks": [...], "questions": [...]}}`
   → config path, seeded workflows, questions. On an error, fix what it names and resubmit.

**Exploration.**

1. `mw_explore_open {"target": "web", "focus": ["checkout"], "maxWorkflows": 3}` →
   `{"sessionId": "ses_...", "remainingBudget": 3}`, instructions and a first observation.
2. `mw_act {"sessionId": "ses_...", "action": {"type": "navigate", "url": "/"}}`, then more
   actions, reading each observation and screenshot.
3. `mw_check {"sessionId": "ses_...", "assertion": {...}}` → `PASSED`.
4. `mw_save_workflow {"sessionId": "ses_...", "title": "Add two items then check out", "intent": "Buy two items", "expect": [{...}]}`,
   then `mw_reset_session` and the next journey.
5. `mw_explore_close {"sessionId": "ses_...", "summary": "Covered cart and checkout"}` → the
   saved workflows and questions; ask the user before answering with `mw_answer`.

**Triage.**

1. `mw_triage_brief {}` → dossiers and finding ids, or "Nothing pending".
2. `mw_evidence {"id": "ev_..."}`, `mw_run_detail {"id": "run_..."}`, `mw_workflow {"id": "wf_..."}`, and the code the steps exercise.
3. `mw_triage_apply {"decisions": [{"findingId": "fnd_...", "verdict": "bug", "title": "Submitting twice creates duplicate items", "summary": "...", "severity": "high", "rationale": "..."}]}`
4. Repeat until `mw_triage_brief` says nothing is pending.

**Mutation.**

1. `mw_workflows {"base": true}` → pick a base workflow.
2. `mw_mutation_brief {"workflowId": "wf_..."}` → instructions and the variants schema.
3. `mw_mutation_apply {"workflowId": "wf_...", "variants": [{"titleSuffix": "submit twice", "description": "...", "steps": [...]}]}`
   → the created variants.
4. `mw_run {"workflowIds": ["wf_..."]}` and poll `mw_job`.

## Jobs and polling

Setup, exploration, replay, triage and agent mutation take minutes, longer than most clients
wait for a tool call. These tools start a job and return at once:

```text
Started run job job_01jc2k9x7m3ab5nq8r4t in the background. Poll it with mw_job {"id":"job_01jc2k9x7m3ab5nq8r4t"} every 15-30 seconds until its status is succeeded, failed or cancelled; mw_cancel_job stops it.

{"jobId":"job_01jc2k9x7m3ab5nq8r4t","kind":"run","status":"running"}
```

`mw_job` reports `status` (`running`, `succeeded`, `failed`, `cancelled`), `progress` (for
example `Add a todo: failed (3/12)`), the `error` of a failed job and, once finished, a compact
`result` (for `mw_run`: run stats, report path, findings created or updated, runs that did not
pass). Pass `wait: true` to get the result in the same call instead; use it only for operations
you know are short. Deterministic `mw_mutate` (without `agent`) always answers directly.

Jobs run inside the server process: closing the client cancels them. Jobs are also recorded in
the database, so `mw jobs` in a terminal shows them.

## Tools

Every tool answers with a short human-readable summary followed by compact JSON where useful.
Failures come back as `isError: true` with an actionable message (unknown ids, unknown targets,
a missing config, a missing provider and the client-driven tool to call instead).

| Tool                | Arguments                                                                        | Does                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `mw_status`         | none                                                                             | Targets, workflows (base, mutations, pending review), runs, open findings by severity, questions, agents, model usage |
| `mw_setup`          | `validate?`, `wait?`                                                             | Job (server provider): inspect the repository, write the config (or a proposal), seed workflows and questions          |
| `mw_explore`        | `target?`, `focus?: string[]`, `maxWorkflows?`, `wait?`                          | Job: explorer agents discover workflows (pending review) against a fresh environment                                  |
| `mw_mutate`         | `target?`, `agent?`, `wait?`                                                     | Derive variants with the operators (direct); with `agent: true` also the mutator agent (job)                          |
| `mw_run`            | `targets?`, `workflowIds?`, `include?: all\|base\|mutations`, `triage?`, `changed?`, `range?`, `changedFiles?: string[]`, `wait?` | Job: replay, record findings, triage, write a report. `changed: true` replays only what the commits since the last run affect (plus workflows never run); `range` (a git range) or `changedFiles` (wins) name the change and imply it. The result says per target what the change selected |
| `mw_impact`         | `files?: string[]`, `range?`, `targets?: string[]`                               | Read-only: which base workflows a change affects (affected, never run, unaffected) and whether a shared file changed. Default change: the last run's commit up to `HEAD` |
| `mw_triage`         | `targets?`, `includeSkipped?`, `wait?`                                           | Job: triager agent reviews findings waiting for triage                                                                |
| `mw_jobs`           | `status?`, `limit?`                                                              | Recent jobs                                                                                                           |
| `mw_job`            | `id`                                                                             | One job: status, progress, error, result                                                                              |
| `mw_cancel_job`     | `id`                                                                             | Cancel a job running in this server                                                                                   |
| `mw_findings`       | `target?`, `status?`, `severity?`, `limit?`                                      | Findings, most recently seen first                                                                                    |
| `mw_finding`        | `id`                                                                             | Summary, triage verdict and rationale, numbered reproduction steps, evidence with absolute paths                      |
| `mw_update_finding` | `id`, `status?`, `notes?`                                                        | Set status (`open`, `confirmed`, `fixed`, `dismissed`) and notes                                                      |
| `mw_workflows`      | `target?`, `origin?`, `status?`, `base?`, `limit?`                               | Workflows; `base: true` base only, `base: false` mutations only                                                       |
| `mw_workflow`       | `id`                                                                             | Intent, steps, expectations, mutation, what it touches (pages, endpoints, files), latest run                          |
| `mw_run_detail`     | `id`                                                                             | One run: status, trigger, timing, step statuses and messages, failed assertions, signals, oracle verdicts, pages and endpoints touched |
| `mw_questions`      | `status?: open\|answered\|all`, `limit?`                                         | Questions for the team (open by default)                                                                              |
| `mw_answer`         | `id`, `decision: confirm\|bug\|dismiss`, `answer?`                               | Record the team's answer; activates/archives the workflow or confirms/dismisses the finding                           |
| `mw_search`         | `query`, `target?`, `limit?`                                                     | Full-text search across workflows and findings                                                                        |
| `mw_report`         | `limit?`                                                                         | Write a Markdown report of the latest runs; returns its path and content                                              |
| `mw_evidence`       | `id`                                                                             | One evidence item: screenshots as an image, console/network/stdout/DOM as text                                        |

The client-driven tools are listed under [Bring your own agent](#bring-your-own-agent).

Read tools are annotated `readOnlyHint: true`; no tool is destructive (`destructiveHint: false`).
Questions are meant for the human: a client should ask the user before calling `mw_answer`.

## Typical flows

**"Set up MutationWorkflow for this repo."**

1. `mw_status`: no config yet, no targets.
2. `mw_setup {}` → job id; poll `mw_job` until `succeeded`. The result lists the targets, the
   config path, seeded workflows, environment validation and questions. Without a provider,
   run the `setup` prompt (or `mw_inspect_brief` → `mw_inspect_apply`) instead.
3. `mw_questions`, then ask the user and record answers with `mw_answer`.

**"Explore and run, then show me the findings."**

1. `mw_explore {"focus": ["checkout"]}` → poll `mw_job`.
2. `mw_mutate {}` (direct).
3. `mw_run {}` → poll `mw_job`; the result lists findings created or updated and the report path.
4. `mw_findings {"status": "open"}`, then `mw_finding {"id": "fnd_..."}` for the worst ones.

**After a push.**

1. `mw_impact {}` → the files changed since the last run and, per target, the workflows they
   affect, the ones never run and the ones unaffected (or `{"files": ["src/api/todos.ts"]}` for
   uncommitted work; without git history, pass `files`).
2. `mw_run {"changed": true}` → poll `mw_job`; only the affected and never-run workflows replay,
   with their variants, and the result says per target what was selected. A changed manifest,
   lockfile or global config replays everything.

**"Is finding X real?"**

1. `mw_finding {"id": "fnd_..."}`: triage verdict and rationale, reproduction steps with the
   mutation applied, evidence ids and paths.
2. `mw_evidence {"id": "ev_..."}` for the failing screenshot or console log; read the code the
   steps exercise.
3. Replay just that workflow: `mw_run {"workflowIds": ["wf_..."], "wait": true}`.
4. Record the decision: `mw_update_finding {"id": "fnd_...", "status": "confirmed"}` (or
   `dismissed`, with `notes`), and `fixed` once a fix makes the replay pass.

## Where things live

All paths are relative to the project root and configurable (`store.path`, `evidenceDir`,
`reportsDir`):

- `.mutationworkflow/mw.db`: the SQLite memory (workflows, runs, findings, questions, jobs, usage).
- `.mutationworkflow/evidence/`: screenshots, console, network and DOM captures. `mw_finding`
  and `mw_evidence` return absolute paths, so a client can also open the files directly.
- `.mutationworkflow/reports/`: Markdown reports from `mw_run` and `mw_report`.
- `.mutationworkflow/setup-proposal.yaml`: `mw_setup`'s proposal when a config already exists.
