# MCP server

`mw mcp` (or `npx -y mutationworkflow mcp`) serves MutationWorkflow over the Model Context
Protocol on stdio, so a coding agent such as Claude Code, Codex or Cursor can set it up, explore,
replay and read findings for the project it is working on.

The server works on one project: `$MW_PROJECT_DIR` when set, otherwise the directory the client
starts it in. Without a config it still starts, so `mw_setup` can create one. Logs go to stderr;
stdout carries only the protocol. When the client disconnects, running jobs are cancelled, the
environments they started are stopped, and the database is closed.

Agent tools (`mw_setup`, `mw_explore`, `mw_triage`, `mw_mutate` with `agent`) need a model key
in the server's environment: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Replaying and reading work
without one.

## Connecting

### Claude Code

```sh
claude mcp add mutationworkflow -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY -- npx -y mutationworkflow mcp
```

Or share it with the team in `.mcp.json` at the project root (Claude Code expands `${VAR}` from
your environment):

```json
{
  "mcpServers": {
    "mutationworkflow": {
      "command": "npx",
      "args": ["-y", "mutationworkflow", "mcp"],
      "env": { "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}" }
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
ANTHROPIC_API_KEY = "sk-ant-..."
MW_PROJECT_DIR = "/path/to/your/project"
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
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "MW_PROJECT_DIR": "/path/to/your/project"
      }
    }
  }
}
```

With a local install (`npm i -D mutationworkflow`), replace `npx -y mutationworkflow` with
`npx mw` or the path to `node_modules/.bin/mw`.

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
a missing config, a missing model key and how to pass one).

| Tool                | Arguments                                                                        | Does                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `mw_status`         | none                                                                             | Targets, workflows (base, mutations, pending review), runs, open findings by severity, questions, agents, model usage |
| `mw_setup`          | `validate?`, `wait?`                                                             | Job: inspect the repository, write the config (or a proposal), seed workflows and questions                           |
| `mw_explore`        | `target?`, `focus?: string[]`, `maxWorkflows?`, `wait?`                          | Job: explorer agents discover workflows (pending review) against a fresh environment                                  |
| `mw_mutate`         | `target?`, `agent?`, `wait?`                                                     | Derive variants with the operators (direct); with `agent: true` also the mutator agent (job)                          |
| `mw_run`            | `targets?`, `workflowIds?`, `include?: all\|base\|mutations`, `triage?`, `wait?` | Job: replay, record findings, triage, write a report                                                                  |
| `mw_triage`         | `targets?`, `includeSkipped?`, `wait?`                                           | Job: triager agent reviews findings waiting for triage                                                                |
| `mw_jobs`           | `status?`, `limit?`                                                              | Recent jobs                                                                                                           |
| `mw_job`            | `id`                                                                             | One job: status, progress, error, result                                                                              |
| `mw_cancel_job`     | `id`                                                                             | Cancel a job running in this server                                                                                   |
| `mw_findings`       | `target?`, `status?`, `severity?`, `limit?`                                      | Findings, most recently seen first                                                                                    |
| `mw_finding`        | `id`                                                                             | Summary, triage verdict and rationale, numbered reproduction steps, evidence with absolute paths                      |
| `mw_update_finding` | `id`, `status?`, `notes?`                                                        | Set status (`open`, `confirmed`, `fixed`, `dismissed`) and notes                                                      |
| `mw_workflows`      | `target?`, `origin?`, `status?`, `base?`, `limit?`                               | Workflows; `base: true` base only, `base: false` mutations only                                                       |
| `mw_workflow`       | `id`                                                                             | Intent, steps, expectations, mutation, latest run                                                                     |
| `mw_questions`      | `status?: open\|answered\|all`, `limit?`                                         | Questions for the team (open by default)                                                                              |
| `mw_answer`         | `id`, `decision: confirm\|bug\|dismiss`, `answer?`                               | Record the team's answer; activates/archives the workflow or confirms/dismisses the finding                           |
| `mw_search`         | `query`, `target?`, `limit?`                                                     | Full-text search across workflows and findings                                                                        |
| `mw_report`         | `limit?`                                                                         | Write a Markdown report of the latest runs; returns its path and content                                              |
| `mw_evidence`       | `id`                                                                             | One evidence item: screenshots as an image, console/network/stdout/DOM as text                                        |

Read tools are annotated `readOnlyHint: true`; no tool is destructive (`destructiveHint: false`).
Questions are meant for the human: a client should ask the user before calling `mw_answer`.

## Typical flows

**"Set up MutationWorkflow for this repo."**

1. `mw_status`: no config yet, no targets.
2. `mw_setup {}` → job id; poll `mw_job` until `succeeded`. The result lists the targets, the
   config path, seeded workflows, environment validation and questions.
3. `mw_questions`, then ask the user and record answers with `mw_answer`.

**"Explore and run, then show me the findings."**

1. `mw_explore {"focus": ["checkout"]}` → poll `mw_job`.
2. `mw_mutate {}` (direct).
3. `mw_run {}` → poll `mw_job`; the result lists findings created or updated and the report path.
4. `mw_findings {"status": "open"}`, then `mw_finding {"id": "fnd_..."}` for the worst ones.

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
