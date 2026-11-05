# mutationworkflow

The command-line interface (`mw`) and MCP server of [MutationWorkflow](../../README.md). AI
agents discover the workflows users perform in your app; MutationWorkflow mutates them (skip,
reorder, repeat, interrupt, fuzz) and replays them deterministically against a local environment
it starts itself, to find the bugs that live between your test cases.

```sh
npm i -D mutationworkflow playwright
npx playwright install --with-deps chromium   # web targets only
export ANTHROPIC_API_KEY=...                  # or OPENAI_API_KEY; agents only

npx mw setup     # agents inspect the repo, write the config, seed workflows
npx mw explore   # discover more workflows
npx mw mutate    # derive variants
npx mw run       # replay, record findings, triage, write a report
npx mw findings
```

Without a key, `mw init` writes a config by hand and `mutate`, `run`, `watch` and every read
command work deterministically.

## Commands

| Command                               | Purpose                                                     |
| ------------------------------------- | ----------------------------------------------------------- |
| `init`                                | Write a minimal config with one target                      |
| `setup`                               | Agent-driven setup: config, seed workflows, questions       |
| `explore [target]`                    | Discover workflows with explorer agents                     |
| `mutate [target]`                     | Derive mutation variants                                    |
| `run [targets...]`                    | Replay, record findings, triage, report; `--fail-on` for CI |
| `triage [target]`                     | Review findings waiting for triage                          |
| `watch [targets...]`                  | Continuous replay, mutation and exploration                 |
| `schedule`                            | Run the config's cron entries                               |
| `status`                              | Overview of targets, findings, agents and usage             |
| `findings`, `finding <id>`            | List and inspect (or update) findings                       |
| `workflows`, `workflow <id>`          | List and inspect workflows                                  |
| `questions`, `answer <id> <decision>` | Questions for the team and their answers                    |
| `search <query>`                      | Full-text search                                            |
| `jobs`, `job <id>`                    | Recorded jobs                                               |
| `report`                              | Report of the latest runs                                   |
| `doctor`                              | Check the installation and configuration                    |
| `mcp`                                 | Serve the MCP server on stdio                               |

Exit codes: 0 success, 1 error, 2 `--fail-on` threshold met, 3 no config found, 130 interrupted.
Full reference: [docs/cli.md](../../docs/cli.md).

## MCP

```sh
claude mcp add mutationworkflow -- npx -y mutationworkflow mcp
```

The connected coding agent can run every agent role itself, with its own model and no API key:
it asks the server for a brief, does the thinking, and calls fine-grained tools. The `setup`,
`explore`, `triage` and `mutate` prompts (slash commands in Claude Code) walk it through. Give the
server a provider instead (`-e ANTHROPIC_API_KEY=...` plus `agents.defaults.model`, or a
`claude-code` / `codex` provider) to run the roles inside the server as background jobs.

| Tools                                                                                                            | For                                     |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `mw_status`, `mw_findings`, `mw_finding`, `mw_update_finding`, `mw_workflows`, `mw_workflow`, `mw_run_detail`, `mw_evidence`      | Reading and bookkeeping                 |
| `mw_questions`, `mw_answer`, `mw_search`, `mw_report`, `mw_jobs`, `mw_job`, `mw_cancel_job`                     | Questions, search, reports, jobs        |
| `mw_mutate`, `mw_run`                                                                                            | Deterministic mutation and replay (job) |
| `mw_setup`, `mw_explore`, `mw_triage`, `mw_mutate {agent}`                                                       | Roles run by the server's provider (job) |
| `mw_inspect_brief`, `mw_inspect_apply`                                                                           | Setup by the client                     |
| `mw_explore_open`, `mw_observe`, `mw_act`, `mw_check`, `mw_save_workflow`, `mw_reset_session`, `mw_use_identity`, `mw_list_known_workflows`, `mw_explore_close` | Exploration by the client |
| `mw_triage_brief`, `mw_triage_apply`                                                                             | Triage by the client                    |
| `mw_mutation_brief`, `mw_mutation_apply`                                                                         | Agent mutation by the client            |

Long operations return a job id to poll with `mw_job`. Setup for Codex and Cursor, the tool
reference, the session model and example flows: [docs/mcp.md](../../docs/mcp.md).

## Programmatic use

```ts
import { createMcpServer, main, openEngine } from 'mutationworkflow';

const engine = await openEngine({ cwd: process.cwd() });
console.log(await engine.status());
await engine.close();
```

`openEngine` loads the config (searched upwards), registers the built-in `web` and `cli`
adapters and returns an `Engine` from `@mutationworkflow/core`. `createMcpServer(engine)` returns
an `McpServer` you can connect to any transport; it closes the engine when the connection
closes.
