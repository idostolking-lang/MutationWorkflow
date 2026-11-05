# Command-line interface

The `mutationworkflow` package installs two equivalent binaries, `mw` and `mutationworkflow`.

```sh
npm i -D mutationworkflow playwright      # or: npx mutationworkflow <command>
npx playwright install --with-deps chromium   # only for web targets
```

Results go to stdout; logs, agent progress and hints go to stderr. Commands that list or show
records accept `--json` and then print JSON only, so `mw findings --json | jq` works.

## Global options

| Option                | Meaning                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `-C, --cwd <dir>`     | Project root. Defaults to `$MW_PROJECT_DIR`, then the current directory                                 |
| `-c, --config <path>` | Config file. Default: `mutationworkflow.config.{yaml,yml,json}`, searched upwards from the project root |
| `--log-level <level>` | `debug`, `info` (default, or `$MW_LOG_LEVEL`), `warn`, `error`, `silent`                                |
| `-v, --verbose`       | Same as `--log-level debug` (also prints stack traces)                                                  |
| `-q, --quiet`         | Same as `--log-level error`; also hides agent progress                                                  |
| `-V, --version`       | Print the version                                                                                       |

Unless the config has a `providers` section, providers are inferred from what is available: an
installed Claude Code or Codex command line (used through your own subscription, no key) and the
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` variables. API providers also need a model named in
`agents.defaults.model`; there is no default. Commands that need agents (`setup`, `explore`,
`triage`, `mutate --agent`) fail fast with a clear message otherwise; `run`, `mutate`, `watch` and
every read command work without any model.

## Exit codes

| Code  | Meaning                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------- |
| `0`   | Success                                                                                                       |
| `1`   | Error (bad input, failed check, unexpected failure)                                                           |
| `2`   | `run --fail-on`: a finding at or above the threshold was created or updated                                   |
| `3`   | No config file found; run `mw init` or `mw setup`                                                             |
| `130` | Interrupted by SIGINT/SIGTERM (not for `watch`, `schedule` and `mcp`, where Ctrl+C is the normal way to stop) |

On the first SIGINT or SIGTERM the running operation is aborted, environments the engine
started are stopped, and the command exits. A second signal exits immediately.

## Getting started

### `mw init`

Write a minimal, commented `mutationworkflow.config.yaml` with one target, without agents.
Refuses to overwrite an existing config.

| Option             | Meaning                                                        |
| ------------------ | -------------------------------------------------------------- |
| `--name <name>`    | Project name (default: the directory name)                     |
| `--kind web\|cli`  | Target kind (default `web`)                                    |
| `--base-url <url>` | Web: base URL (default `http://127.0.0.1:3000`)                |
| `--command <cmd>`  | Web: the command that starts the app; cli: the command to test |

```sh
mw init --base-url http://127.0.0.1:4173 --command "npm run dev"
mw init --kind cli --command "node cli.js"
```

### `mw setup`

The inspector agent studies the repository (stack, start commands, existing end-to-end tests,
features, risks), writes the config, seeds workflows and records questions for the team. When a
config already exists it is left untouched and the proposal is written to
`.mutationworkflow/setup-proposal.yaml`. Agent progress streams to stderr.

| Option          | Meaning                                                           |
| --------------- | ----------------------------------------------------------------- |
| `--validate` | Start each proposed environment once to check its start command (off by default: review the model-written commands first) |
| `--name <name>` | Project name                                                      |

### `mw doctor`

Checks, one line each (`✓` ok, `!` warning, `✗` failure): Node.js ≥ 22.13, config found and
valid, database opens, each target's adapter loads with its options, each target has an
environment start command (warning when missing), Playwright and Chromium are installed (when a
web target exists), and the configured or inferred providers (API keys present, coding-agent
command lines installed; key values are never printed).
Exits with 1 when any check fails.

## The loop

### `mw explore [target]`

Start the target's environment and let explorer agents discover workflows. New workflows enter
memory as `pending-review`, each with a question. All targets when `target` is omitted.

| Option              | Meaning                          |
| ------------------- | -------------------------------- |
| `--focus <a,b,...>` | Areas or features to prioritise  |
| `--max <n>`         | Maximum new workflows per target |
| `--explorers <n>`   | Parallel explorer agents         |

### `mw mutate [target]`

Derive variants of every base workflow with the deterministic operators (`skip-step`,
`reorder-steps`, `repeat-step`, `truncate`, `data-fuzz`, `interrupt`, `timing`, `role-swap`,
`interleave`). Variants that already exist are not stored twice.

| Option                 | Meaning                                        |
| ---------------------- | ---------------------------------------------- |
| `--agent`              | Also ask the mutator agent (needs a model key) |
| `--max <n>`            | Maximum variants per base workflow             |
| `--operators <id,...>` | Only these operators                           |

### `mw run [targets...]`

Start each target's environment, replay workflows, record runs and evidence, fold failures into
findings, triage new findings (with a model key) and write a Markdown report. One line per run
is printed as it completes, then a summary table and the findings that were created or updated.

| Option                                  | Meaning                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--workflow <id>`                       | Only this workflow; repeatable                                                                                     |
| `--include all\|base\|mutations`        | Which workflows (default `all`)                                                                                    |
| `--parallel <n>`                        | Concurrent replays (default from `execution.parallel`)                                                             |
| `--no-triage`                           | Do not ask the triager agent                                                                                       |
| `--no-report`                           | Do not write a report                                                                                              |
| `--trigger manual\|push\|schedule`      | Recorded on each run (default `manual`)                                                                            |
| `--fail-on critical\|high\|medium\|low` | Exit 2 when a finding at or above this severity was created or updated (dismissed and fixed findings do not count) |
| `--changed [range]`                     | Replay only the workflows a git range affects, plus those never run (default range: the commit of the last run up to `HEAD`, else `HEAD~1..HEAD`) |
| `--changed-file <path>`                 | A changed file, relative to the project root; repeatable; implies `--changed` and wins over a range                |

```text
$ mw run --include mutations
[1/12] passed  Add a todo · Performs step 3 (click) twice, like a double click or a retried submit (0.8s)
[2/12] failed  Edit then delete · Reorders steps 2 and 3 (1.1s)
...
PASSED  FAILED  BLOCKED  ERROR  TOTAL  DURATION
10      2       0        0      12     9.4s
```

Every run records the pages and endpoints it touched, and the engine maps them to the repository
files behind them (`targets[].codemap` rules, plus a search of the repository for the literal
endpoint and page paths). With `--changed` or `--changed-file`, only the base workflows whose
files overlap the change replay, with their variants, plus the ones nothing is known about yet.
Everything replays when a shared file changed (a manifest, lockfile or global config) or when no
workflow is known to be unaffected. When git cannot list the changed files (no repository, or a
shallow clone without that history), everything replays and a warning says so. After the summary
table, one line per target says what the change selected:

```text
Change (3 files): web → 2 workflows affected, 1 never run, 5 skipped
Change (1 file): api → every workflow replayed
```

`--changed` takes an optional value, so put target names before it (`mw run web --changed`) or
give the range (`mw run --changed main..HEAD web`).

### `mw impact [range]`

Show which base workflows a change affects, from what earlier runs learned; nothing runs. The
change is `range` (a git range such as `abc123..HEAD`), the `--file` paths, or by default the
commit of the last run up to `HEAD` (`HEAD~1..HEAD` before any run). Variants follow their base
and are not listed. Exits 0 whatever the change affects; when git cannot answer it exits 1 and
asks for `--file`.

| Option          | Meaning                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| `--file <path>` | A changed file, relative to the project root; repeatable; wins over the range |
| `--json`        | Print the report as JSON (workflows in their compact form, with `touches`)    |

```text
$ mw impact main..HEAD
Changed files (3, main..HEAD)
  src/api/todos.ts
  src/components/TodoList.tsx
  README.md

TARGET  AFFECTED  NEVER RUN  UNAFFECTED
web     2         1          5
  wf_01jc2k9x7m3ab5nq8r4t  Add a todo
  wf_01jc2kb4f2q6w8e1r3ty  Edit then delete
```

`NEVER RUN` counts workflows with no file knowledge yet (never run, or their pages and endpoints
map to no file); a run with `--changed` replays them. When a shared file changed, a note says a
run will replay everything.

### `mw triage [target]`

Let the triager agent review open findings waiting for triage. `--include-skipped` also reviews
findings that were skipped because no model key was available when they were recorded.

### `mw watch [targets...]`

Continuous mode: every cycle mutates and replays, and every `schedule.continuous.exploreEveryCycles`
cycles also explores (with a model key). Waits `schedule.continuous.idleMs` between cycles.
Prints one line per cycle; Ctrl+C stops after the current step.

| Option             | Meaning                     |
| ------------------ | --------------------------- |
| `--max-cycles <n>` | Stop after this many cycles |

### `mw schedule`

Run the `schedule.cron` entries of the config until Ctrl+C. Each entry has an `expression`
(standard cron, optionally with seconds), an `action` (`run`, `explore`, `mutate` or `cycle`:
explore with a model key, then mutate, then run) and an optional `target`. Only one tick runs at
a time; a tick that fires while another is running is skipped and logged. Exits with an error
when no entries are configured. With `changedOnly: true`, the `run` and `cycle` actions replay
only the workflows affected by the commits since the last run (as `mw run --changed`), plus
those never run.

```yaml
schedule:
  cron:
    - expression: "0 3 * * *" # nightly full cycle
      action: cycle
    - expression: "*/30 9-18 * * 1-5" # every 30 minutes during work hours, what changed
      action: run
      target: web
      changedOnly: true
```

## Memory

| Command                     | Options                                                                                      | Shows                                                                                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mw status`                 | `--json`                                                                                     | Per target: base workflows, mutations, pending review, runs (passed/failed/blocked/error), open findings by severity, open questions; agents: enabled, providers, models, max parallel; model usage |
| `mw findings [target]`      | `--status open\|confirmed\|fixed\|dismissed`, `--severity <s>`, `--limit <n>` (50), `--json` | Findings, most recently seen first                                                                                                                                                                  |
| `mw finding <id>`           | `--status <s>`, `--note <text>`, `--json`                                                    | Summary, triage verdict, numbered reproduction steps, evidence with absolute paths; `--status`/`--note` update it first                                                                             |
| `mw workflows [target]`     | `--origin <o>`, `--status <s>`, `--base` or `--mutations`, `--limit <n>` (100), `--json`     | Workflows                                                                                                                                                                                           |
| `mw workflow <id>`          | `--json`                                                                                     | Intent, numbered steps, expectations, mutation, variants, what it touches (pages, endpoints, files), latest run                                                                                     |
| `mw questions`              | `--all`, `--json`                                                                            | Open questions (all with `--all`)                                                                                                                                                                   |
| `mw answer <id> <decision>` | `--note <text>`                                                                              | `confirm` activates the workflow; `bug` confirms or records a finding; `dismiss` archives the workflow or dismisses the finding                                                                     |
| `mw search <query>`         | `--target <id>`, `--limit <n>` (20), `--json`                                                | Full-text search across workflows and findings                                                                                                                                                      |
| `mw jobs`                   | `--limit <n>` (20), `--json`                                                                 | Recent jobs; every `setup`, `explore`, `mutate`, `run`, `triage` and `watch` is recorded as one                                                                                                     |
| `mw job <id>`               | `--json`                                                                                     | Status, progress, parameters, result                                                                                                                                                                |
| `mw report`                 | `--limit <n>` (50)                                                                           | Writes a report of the latest runs and prints its path                                                                                                                                              |

```sh
mw findings --severity high --status open
mw finding fnd_01jc2k9x7m3ab5nq8r4t
mw finding fnd_01jc2k9x7m3ab5nq8r4t --status fixed --note "Fixed in #42"
mw questions
mw answer q_01jc2k9x7m3ab5nq8r4t confirm --note "Yes, duplicates are rejected"
```

Everything lives under the project root, configurable in the config file:

| Path                          | Contents                                                       |
| ----------------------------- | -------------------------------------------------------------- |
| `.mutationworkflow/mw.db`     | SQLite memory (`store.path`)                                   |
| `.mutationworkflow/evidence/` | Screenshots, console, network and DOM captures (`evidenceDir`) |
| `.mutationworkflow/reports/`  | Markdown reports (`reportsDir`)                                |

## MCP

`mw mcp` serves the MCP server on stdio. See [mcp.md](mcp.md).

## Continuous integration

`mw run` starts the application itself, so a CI job only needs Node, the browser and, for
triage, a model provider: in CI that is usually an API key plus a model named in
`agents.defaults.model` in the committed config (no coding agent is logged in there). `--fail-on high` fails the build when a high or critical finding was created or updated.
Commit the config file; keep `.mutationworkflow/` out of Git, or cache it between builds to keep
the memory (workflows and finding history). `--changed` replays only what the pushed commits
affect; it needs the commit history (`fetch-depth: 0`) and the memory from earlier runs, because
that is where workflows learn which files they touch: without the cache every workflow is "never
run" and the whole suite replays.

```yaml
# .github/workflows/mutationworkflow.yml
name: MutationWorkflow
on:
  push:
    branches: [main]
  pull_request:

jobs:
  replay:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # --changed diffs the pushed commits
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - uses: actions/cache@v4
        with:
          path: .mutationworkflow
          key: mutationworkflow-${{ github.ref_name }}-${{ github.run_id }}
          restore-keys: mutationworkflow-${{ github.ref_name }}-
      - run: npx mutationworkflow mutate
      - run: npx mutationworkflow run --trigger push --changed ${{ github.event.pull_request.base.sha || github.event.before }}..${{ github.sha }} --fail-on high
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: mutationworkflow-report
          path: |
            .mutationworkflow/reports
            .mutationworkflow/evidence
```

On a push the range is `${{ github.event.before }}..${{ github.sha }}`; pull requests have no
`before`, hence the base commit. When the range cannot be read (the first push of a branch, a
force push), everything replays. Drop `--changed` for a full replay on every build.

For nightly exploration, run `npx mutationworkflow explore` on a `schedule:` trigger before
`run`, or keep a machine running `mw schedule`.
