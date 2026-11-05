# MutationWorkflow

**Finds the bugs that live between your test cases.**

Your tests check the workflows you thought of. Production breaks on the ones you did not: the
submit button clicked twice, the page reloaded halfway through a form, the item deleted in one
tab and edited in another, the role that was never supposed to reach that screen. MutationWorkflow
uses AI agents to discover the workflows users actually perform, derives *mutations* of those
workflows, replays everything deterministically against a local copy of your application, and
remembers what it learned.

> **A note on the word "mutation".** In classic testing, mutation testing changes the *code* to
> check whether the *tests* notice. MutationWorkflow changes the *workflows* to check whether the
> *application* copes. Same word, opposite direction.

## How it works

```
 setup ─▶ discover ─▶ mutate ─▶ replay ─▶ judge ─▶ triage ─▶ remember ─▶ (repeat)
 agents    agents     operators  no model  oracles   agent     SQLite      cron, push,
 read the  drive the  skip/      fresh env           + humans  evidence    continuous,
 repo      live app   repeat/…   per run                       reports     on command
```

1. **Setup.** An inspector agent (which can fan out sub-agents) reads the repository: how to
   start the app locally, which features and roles exist, which end-to-end tests already encode
   intended behaviour. It writes the configuration and seeds workflows from those tests.
2. **Discover.** Explorer agents drive the running application like curious QA engineers,
   through Playwright for web apps or stdin/stdout for terminal apps, and record coherent
   journeys as workflows. Behaviour nobody has confirmed becomes a question for your team.
3. **Mutate.** Deterministic operators derive variants: skip a step, swap two, repeat one,
   abandon midway, reload in between, fuzz the input, swap the role, interleave two flows. A
   mutator agent can add the variants operators cannot think of.
4. **Replay.** Every workflow, base or mutated, replays in a fresh session against an
   environment the tool started itself. No model in the loop: replay is fast, cheap and
   reproducible.
5. **Judge.** Oracles decide what went wrong: the app crashed or threw, a server returned 500, an
   expectation failed, an invariant broke. A blocked step on a mutated workflow is not a bug; it
   is the application correctly refusing an out-of-order action.
6. **Triage.** A triager agent reads the evidence (screenshots, logs, signals), writes a precise
   title and reproduction, sets severity, merges duplicates and dismisses expected consequences of
   a mutation. What it cannot judge becomes a question for a human.
7. **Remember.** Workflows, runs, findings, questions, evidence and model usage live in a SQLite
   database with full-text search, next to Markdown reports. The next run knows what the last one
   found.

## Quick start

Requirements: Node 22.13 or newer, and a model API key for the agent features (replay, mutation
operators, oracles and reports work without one).

```sh
export ANTHROPIC_API_KEY=...           # or OPENAI_API_KEY for an OpenAI-compatible endpoint

cd your-project
npx mutationworkflow setup             # agents inspect the repo and write mutationworkflow.config.yaml
npx playwright install chromium        # once, for web targets
npx mutationworkflow explore           # agents discover workflows against your local app
npx mutationworkflow mutate            # derive variants
npx mutationworkflow run               # replay everything, triage, write a report
npx mutationworkflow findings          # what broke, with reproduction steps
npx mutationworkflow questions         # what the agents want you to confirm
```

`mw` is a shorter alias for `mutationworkflow` once installed (`npm i -g mutationworkflow`).
Prefer to write the config yourself? `mw init` gives you a commented template, and
[docs/configuration.md](docs/configuration.md) documents every field.

### Try it on the examples

The repository ships two tiny apps with deliberately planted sequence bugs. From a clone:

```sh
pnpm install && pnpm build
cd examples/todo-web
cat > mutationworkflow.config.yaml <<'EOF'
version: 1
project: { name: todo-web }
targets:
  - id: todo
    kind: web
    options: { baseUrl: http://127.0.0.1:4173 }
    environment:
      start:
        command: node server.js
        env: { PORT: '4173' }
        ready: { url: http://127.0.0.1:4173/api/health }
      reset: { command: "node -e \"fetch('http://127.0.0.1:4173/api/reset',{method:'POST'})\"" }
execution: { resetBetweenRuns: true }
EOF
../../packages/mutationworkflow/dist/bin.js explore   # needs an API key
../../packages/mutationworkflow/dist/bin.js mutate
../../packages/mutationworkflow/dist/bin.js run
```

Without an API key, the end-to-end test in `packages/core/e2e` shows the deterministic half of
the pipeline finding all three planted bugs from two hand-written workflows.

## Use it from Claude Code, Codex or Cursor

MutationWorkflow is also an MCP server, so your coding agent can set it up, run it and discuss
its findings with you.

```sh
# Claude Code
claude mcp add mutationworkflow -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY -- npx -y mutationworkflow mcp
```

```toml
# Codex: ~/.codex/config.toml
[mcp_servers.mutationworkflow]
command = "npx"
args = ["-y", "mutationworkflow", "mcp"]
```

```json
// Cursor: .cursor/mcp.json
{ "mcpServers": { "mutationworkflow": { "command": "npx", "args": ["-y", "mutationworkflow", "mcp"] } } }
```

Then ask things like *"set up MutationWorkflow for this repo"*, *"explore the checkout and run
the mutations"*, *"show me the open findings with their reproduction steps"*, or *"is finding
fnd_… a real bug?"*. Long operations run as jobs the agent can poll. See [docs/mcp.md](docs/mcp.md).

## Running it continuously

- **On every push:** a GitHub Actions step running `npx mutationworkflow run --trigger push
  --fail-on high` (recipe in [docs/cli.md](docs/cli.md)).
- **On a schedule:** cron entries in the config, executed by `mw schedule`.
- **Around the clock:** `mw watch` replays, mutates and periodically explores, within the token
  and cost budgets you set.

## Models, parallelism and cost

Agents default to `claude-opus-5-5`; set a different model or provider per role under
`agents.roles`. `agents.maxParallel` caps concurrent model calls across every agent and
sub-agent, so "use up to 3 agents at a time" is one line of config. Budgets per job
(`maxTokensPerJob`, `maxUsdPerJob`) stop runaway sessions, and every call is recorded with its
estimated cost. Replay never calls a model, so the expensive part (discovery and triage) happens
only when something is new. Details in [docs/agents.md](docs/agents.md).

## Safety

MutationWorkflow only ever drives an application it started locally or a localhost URL you point
it at. Agents are fenced by `scope`: allowed and denied URL patterns, and text patterns of
controls they must never activate (`"Pay"`, `"Delete account"`). The config file runs the
commands you put in it, so review it like code. See [SECURITY.md](SECURITY.md).

## Architecture

| Package | Role |
| --- | --- |
| `@mutationworkflow/core` | Domain model, config, SQLite memory, environments, operators, oracles, agent runtime, engine |
| `@mutationworkflow/adapter-web` | Playwright adapter for web applications |
| `@mutationworkflow/adapter-cli` | Process adapter for command-line applications |
| `mutationworkflow` | The `mw` CLI and the MCP server |

Adapters are plugins behind one interface; desktop and game adapters can live in their own
packages. [docs/architecture.md](docs/architecture.md) explains the pieces and the decisions
behind them are recorded in [docs/adr](docs/adr).

## Documentation

- [Configuration](docs/configuration.md) · [Workflows](docs/workflows.md) ·
  [Adapters](docs/adapters.md) · [Mutations](docs/mutations.md) · [Oracles and findings](docs/oracles.md) ·
  [Agents](docs/agents.md) · [Memory](docs/memory.md)
- [CLI reference](docs/cli.md) · [MCP server](docs/mcp.md) · [Architecture](docs/architecture.md)

## Status

Early and opinionated: version 0.1. The core loop works end to end for web and command-line
applications. Planned next: a pseudo-terminal driver for full-screen terminal apps, desktop
adapters through accessibility APIs, export and import of workflows as files so CI needs no
cache, a Postgres store for teams, and richer invariants.
Contributions welcome; start with [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
