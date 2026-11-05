# Adapters

An adapter is how MutationWorkflow touches an application. It defines the vocabulary of
actions and assertions that workflows are written in, performs them in isolated sessions,
reports what the application did wrong on its own (signals), captures evidence, and renders the
current state as text for agents. The engine, mutation operators and oracles are
adapter-neutral; everything kind-specific lives here. Two adapters ship with MutationWorkflow:
`web` (Playwright) and `cli` (processes over pipes). This page documents both vocabularies and
how to write your own.

Related: [README](../README.md) · [Configuration](configuration.md) · [Workflows](workflows.md) ·
[Mutations](mutations.md) · [CLI](cli.md)

## Outcomes

Every action returns one of three outcomes, and the distinction matters to the oracles:

| Outcome   | Meaning                                                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`      | The action was performed                                                                                                                                                                                |
| `blocked` | The application did not offer it: missing, hidden, disabled or ambiguous control; process not running; expected output never came; refused by scope. Information about the app, not a failure by itself |
| `error`   | The application or the adapter broke while performing it                                                                                                                                                |

Assertions return `{ passed, message }` and never throw for application state.

## The web adapter (`kind: web`)

Package `@mutationworkflow/adapter-web`. Install it with Playwright and a browser:

```sh
pnpm add -D @mutationworkflow/adapter-web playwright
pnpm exec playwright install chromium
```

| Option             | Default                        | Meaning                                                 |
| ------------------ | ------------------------------ | ------------------------------------------------------- |
| `baseUrl`          | required                       | Root http(s) URL of the application; loopback host only |
| `allowRemoteBaseUrl` | `false`                      | Allow a `baseUrl` that is not a loopback host           |
| `browser`          | `chromium`                     | `chromium`, `firefox` or `webkit`                       |
| `headless`         | `true`                         | Run without a window                                    |
| `viewport`         | `{ width: 1280, height: 800 }` | CSS pixels                                              |
| `launchOptions`    | `{}`                           | Passed unchanged to Playwright's `launch()`             |
| `storageStatePath` | none                           | Playwright storage state file loaded into every session |

One browser is launched lazily per target; every session is a new browser context and page
starting on `about:blank`, so sessions share no cookies, storage or cache.

`baseUrl` must point at a loopback host: `localhost`, `*.localhost`, `127.0.0.0/8` or `[::1]`.
Anything else is rejected with `CONFIG_INVALID` unless `allowRemoteBaseUrl: true` is set. Set it
only for a local instance you started that is reached under another host name (a container or VM
on your machine); never point it at a shared or production environment.

Workflows run in a single tab. Pages the application opens (`target="_blank"`, `window.open`)
never load: they are closed at once, the next action's outcome message says so ("popup to <url>
closed"), and the workflow continues in the original page. Service workers are blocked, because
their requests would bypass scope enforcement.

### Locators

Element-targeting fields (`target`) take a locator. Exactly one strategy is used, chosen by
priority:

| Priority | Field             | Matches                                                |
| -------- | ----------------- | ------------------------------------------------------ |
| 1        | `testId`          | `data-testid` attribute                                |
| 2        | `role` (+ `name`) | ARIA role and accessible name, as in the ARIA snapshot |
| 3        | `label`           | `<label>` text or `aria-label` of a field              |
| 4        | `placeholder`     | Placeholder text                                       |
| 5        | `text`            | Visible text                                           |
| 6        | `css`             | CSS selector; last resort, brittle                     |

Modifiers: `exact: true` makes `name`, `label`, `placeholder` and `text` match the whole string,
case-sensitively (otherwise case-insensitive substring). `nth` (zero-based) picks one of several
matches and applies last. `name` requires `role`. When several elements match and `nth` is
absent, the action is `blocked` as ambiguous.

```json
{ "role": "button", "name": "Save" }
{ "label": "Email" }
{ "role": "button", "name": "Delete", "nth": 1 }
{ "text": "Buy milk", "exact": true }
```

### Web actions

| Type         | Fields                   | Example                                                                          | Notes                                                                     |
| ------------ | ------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `navigate`   | `url`                    | `{ "type": "navigate", "url": "/" }`                                             | Relative to `baseUrl`; scope-checked; waits for `load`                    |
| `click`      | `target`                 | `{ "type": "click", "target": { "role": "button", "name": "Save" } }`            | denyText-guarded                                                          |
| `dblclick`   | `target`                 | `{ "type": "dblclick", "target": { "text": "Buy milk", "exact": true } }`        | denyText-guarded                                                          |
| `fill`       | `target`, `value`        | `{ "type": "fill", "target": { "label": "Email" }, "value": "ada@example.com" }` | Replaces content                                                          |
| `press`      | `key`, `target?`         | `{ "type": "press", "key": "Enter", "target": { "label": "Search" } }`           | Playwright key syntax; focused element without `target`; denyText-guarded |
| `select`     | `target`, `value`        | `{ "type": "select", "target": { "label": "Country" }, "value": "Norway" }`      | Option value or label; denyText-guarded                                   |
| `check`      | `target`                 | `{ "type": "check", "target": { "role": "checkbox", "name": "Remember me" } }`   | denyText-guarded                                                          |
| `uncheck`    | `target`                 | `{ "type": "uncheck", "target": { "role": "checkbox", "name": "Remember me" } }` | denyText-guarded                                                          |
| `hover`      | `target`                 | `{ "type": "hover", "target": { "role": "button", "name": "Account" } }`         |                                                                           |
| `scroll`     | `target`                 | `{ "type": "scroll", "target": { "role": "contentinfo" } }`                      | Into view                                                                 |
| `wait`       | `ms?`, `target?`, `url?` | `{ "type": "wait", "target": { "role": "heading", "name": "Dashboard" } }`       | At least one; `ms` at most 60000; `url` is a glob, path glob or `/regex/` |
| `reload`     |                          | `{ "type": "reload" }`                                                           |                                                                           |
| `back`       |                          | `{ "type": "back" }`                                                             | `ok` with a note when there is no history                                 |
| `forward`    |                          | `{ "type": "forward" }`                                                          | Same                                                                      |
| `screenshot` | `label?`                 | `{ "type": "screenshot", "label": "after-checkout" }`                            | Always saved                                                              |

`blocked` when the element is missing, hidden, disabled, ambiguous or of the wrong kind within
`stepTimeoutMs`, when it matches `scope.denyText`, or when a navigation it caused is out of
scope (the message names the URL). `error` when
the page crashed, a navigation failed or timed out, or Playwright failed otherwise. After each
action the adapter waits until no request has been in flight for 100 ms (at most 3 s), so the
signals an action causes are attributed to its step.

### Web assertions

Every assertion also accepts `description`.

| Type              | Fields                             | Example                                                                           | Passes when                                                              |
| ----------------- | ---------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `url-matches`     | `pattern`                          | `{ "type": "url-matches", "pattern": "/todos/**" }`                               | URL matches a full-URL glob, a path-and-query glob, or `/regex/flags`    |
| `title-matches`   | `pattern`                          | `{ "type": "title-matches", "pattern": "Todos" }`                                 | Title contains the text or matches `/regex/`                             |
| `text-visible`    | `text`, `exact?`                   | `{ "type": "text-visible", "text": "Saved" }`                                     | Some visible element has the text                                        |
| `text-hidden`     | `text`                             | `{ "type": "text-hidden", "text": "Something went wrong" }`                       | No visible element has it                                                |
| `element-visible` | `target`                           | `{ "type": "element-visible", "target": { "role": "heading", "name": "Todos" } }` | A match is visible                                                       |
| `element-hidden`  | `target`                           | `{ "type": "element-hidden", "target": { "role": "dialog" } }`                    | No match is visible                                                      |
| `element-count`   | `target`, `count?`, `min?`, `max?` | `{ "type": "element-count", "target": { "role": "listitem" }, "count": 3 }`       | Match count (hidden included) within bounds; one bound required          |
| `value-equals`    | `target`, `value`                  | `{ "type": "value-equals", "target": { "label": "Title" }, "value": "Buy milk" }` | Field value equals `value`                                               |
| `http`            | `url`, `status?`                   | `{ "type": "http", "url": "/api/health", "status": 200 }`                         | GET with the session's cookies returns `status`, or any status below 400 |

State assertions retry every 100 ms until they hold or `assertionTimeoutMs` passes. `http` is
evaluated once and is subject to scope.

### Web signals and observations

| Signal               | Source                                                                         |
| -------------------- | ------------------------------------------------------------------------------ |
| `console-error`      | `console.error` in the page, except Chromium's "Failed to load resource" lines |
| `uncaught-exception` | Uncaught errors in the page                                                    |
| `network-error`      | Failed requests, except ones the browser cancelled or scope aborted                             |
| `http-error`         | Responses with status 400 or more; `details: { status, url, method }`          |
| `crash`              | The page crashed                                                               |

`observe()` returns `Page "<title>" at <url>` followed by the page's ARIA snapshot (one line
per element, e.g. `- button "Add"`), truncated to 6000 characters, plus a screenshot unless
screenshots are `never`. Agents turn snapshot lines directly into `role` + `name` locators.

## The cli adapter (`kind: cli`)

Package `@mutationworkflow/adapter-cli`. It drives a program through stdin, stdout and stderr
pipes (no pseudo-terminal: programs that require a TTY or draw full-screen UIs are not
supported).

| Option          | Default      | Meaning                                                     |
| --------------- | ------------ | ----------------------------------------------------------- |
| `command`       | required     | Executable to run                                           |
| `args`          | `[]`         | Arguments, before any per-action `args`                     |
| `cwd`           | project root | Relative to the project root                                |
| `env`           | `{}`         | Merged over the current environment                         |
| `shell`         | `false`      | Run through the system shell (arguments are quoted, below)  |
| `promptPattern` | none         | Multiline regex for the prompt shown when input is expected |
| `exitTimeoutMs` | `5000`       | How long `close` waits before SIGTERM, then SIGKILL         |

### CLI actions

A session runs at most one process at a time. "Since the last input" means since the most recent
`start`, `write` or `signal`.

| Type     | Fields                      | Example                                     | Effect                                                                                                                                                                                                                                |
| -------- | --------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`  | `args?`                     | `{ "type": "start" }`                       | Start an interactive process; `blocked` if one runs                                                                                                                                                                                   |
| `exec`   | `args?`                     | `{ "type": "exec", "args": ["--version"] }` | Run to completion with stdin closed; a non-zero exit code is state, not an error                                                                                                                                                      |
| `write`  | `text`, `newline?` (`true`) | `{ "type": "write", "text": "add 5" }`      | Type into stdin; `blocked` if the process is not running or stopped reading                                                                                                                                                           |
| `wait`   | `ms?`, `output?`, `prompt?` | `{ "type": "wait", "prompt": true }`        | Sleep `ms`, or wait until output since the last input matches `output` and/or the prompt is last; with a condition, `ms` is the timeout (default `stepTimeoutMs`); timeout or exit gives `blocked`. `prompt` requires `promptPattern` |
| `signal` | `signal`                    | `{ "type": "signal", "signal": "SIGINT" }`  | `SIGINT`, `SIGTERM` or `SIGKILL` to the process and its children                                                                                                                                                                      |
| `close`  |                             | `{ "type": "close" }`                       | Close stdin, wait `exitTimeoutMs`, then SIGTERM, then SIGKILL                                                                                                                                                                         |

### CLI assertions

`stream` is `stdout`, `stderr` or `both` (default). `since` is `session` (default) or `step`
(output since this step began, or since the input before it when that was earlier). Patterns are
multiline regular expressions. Input is not echoed, so an answer can share a line with the
prompt (`> 5`): anchor with `\b5$`, not `^5$`.

| Type                 | Fields                         | Example                                                             | Passes when                              |
| -------------------- | ------------------------------ | ------------------------------------------------------------------- | ---------------------------------------- |
| `output-matches`     | `pattern`, `stream?`, `since?` | `{ "type": "output-matches", "pattern": "\\b5$", "since": "step" }` | The output contains a match              |
| `output-not-matches` | `pattern`, `stream?`, `since?` | `{ "type": "output-not-matches", "pattern": "NaN" }`                | No match                                 |
| `exit-code`          | `code`                         | `{ "type": "exit-code", "code": 0 }`                                | Exited with `code` (fails while running) |
| `running`            | `expected`                     | `{ "type": "running", "expected": true }`                           | Running state equals `expected`          |
| `stderr-empty`       | `since?`                       | `{ "type": "stderr-empty" }`                                        | Nothing on stderr                        |

### CLI signals and observations

| Signal         | Raised when                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stderr`       | A burst of stderr shows a defect: a stack frame (JavaScript `at fn (file:line:col)`, Java `at pkg.Class.method(File.java:12)`, Python `File "app.py", line 3`), an exception class name such as `TypeError`, or `Traceback`, `panic:`, `fatal`, `unhandled`, `segmentation fault`, `core dumped`. Plain `error:` or `warning:` lines, which apps print when they correctly reject input, do not count. One signal per burst, named by its most telling line |
| `process-exit` | Non-zero exit the workflow did not cause (`exec`, `close`, and 130/143 after a requested SIGINT/SIGTERM are expected)                                |
| `crash`        | Terminated by a signal the workflow did not send                                                                                                     |

`observe()` returns a header (`$ node cli.js (running)` or the exit status) and the last 4000
characters of the transcript: stdout verbatim, stderr lines prefixed `[stderr]`, and `──`
marker lines for steps and process starts and exits. Screenshots and DOM captures are not
available; `capture('output')` stores the full transcript as a `log` file.

## Scope enforcement

Scope (`targets[].scope`, see [Configuration](configuration.md#targetsscope)) is enforced
inside the adapter, so it applies equally to agents exploring and to replays. "In scope" means
matching `allowUrls` (when empty: the `baseUrl` origin followed by `/**`) and not matching
`denyUrls`.

The web adapter enforces it inside the browser, before requests leave it. A route on every
session's browser context aborts:

- every navigation (of the page, an iframe or a popup) to an out-of-scope URL, and
- every out-of-scope request whose method is not `GET` or `HEAD`, since those can have side
  effects.

Out-of-scope `GET` subresources (fonts, scripts or images from a CDN) still load, so local
applications keep working. Aborted requests are noted in the console evidence and are not
reported as `network-error` signals. In addition:

- `navigate` to an out-of-scope URL is refused up front (`blocked`);
- as a backstop, the page URL is checked after every action (redirects are not re-routed), and a
  page that ended up out of scope is left with `back` (`blocked`);
- `denyText` guards `click`, `dblclick`, `check`, `uncheck`, `press` (on its target, or without
  one on the focused element) and `select` (the chosen option's label and value and the select's
  `aria-label`): when the control's text, `aria-label` or `value` matches a pattern, the action is
  `blocked`;
- `http` assertions to out-of-scope URLs fail without a request.

The cli adapter has no URLs or controls and does not apply scope. Its own safety rule concerns
arguments: with `shell: true`, the `command` string goes to the shell as written (so it may use
shell syntax), but on POSIX every configured and per-action argument is single-quoted first, so
`"; rm -rf ~"` reaches the program as one literal argument. On Windows, where `cmd.exe` has no
safe quoting, configured `args` are passed as they are, and `start` or `exec` with per-action
`args` is rejected by validation (and reported `blocked` if it reaches a run).

## Writing your own adapter

An adapter is an npm package (or any module resolvable from the project root) that exports
`createAdapter`. Reference it from a target:

```yaml
targets:
  - id: mobile
    kind: mobile
    adapter: my-adapter-package # resolved from the project root; defaults to `kind`
    options: { device: emulator-5554 }
```

The registry looks up `adapter` (or `kind`) among the registered built-ins first. Otherwise it
tries `import(name)` (which works for flat `node_modules` layouts and hoisted pnpm installs) and,
if the module is not found that way, resolves the name from the project root, where third-party
adapters are installed, and imports the resolved file. ESM-only packages are fine. The module
may export `createAdapter` (and optionally `describe`) directly or on its default export. One
adapter instance is created per target and reused; `dispose()` is called on shutdown.

### The contract

Types come from `@mutationworkflow/core`.

```ts
import type {
  Adapter,
  AdapterFactoryOptions,
  AdapterSession,
  AdapterDescription,
  SessionOptions,
} from '@mutationworkflow/core';

export function createAdapter({ target, rootDir, logger }: AdapterFactoryOptions): Adapter {
  // Validate target.options here and throw a MutationWorkflowError('CONFIG_INVALID', ...) on bad input.
  return new MyAdapter(target, rootDir, logger);
}

/** Optional: the vocabulary without a target, for setup flows. Should equal adapter.describe(). */
export function describe(): AdapterDescription {
  /* ... */
}
```

`Adapter`:

| Member                         | Contract                                                                                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                         | The kind string                                                                                                                                                                                |
| `describe()`                   | Vocabulary: `kind`, `summary`, `actions[]` and `assertions[]` (each `{ type, description, schema, example? }` with a JSON Schema of the whole object), `hints`, and a prose `guide` for agents |
| `validateAction(action)`       | Parse and normalise; throw when the type or fields are invalid. Used before storing seeds, variants and explorer actions                                                                       |
| `validateAssertion(assertion)` | Same for assertions                                                                                                                                                                            |
| `open(options)`                | Start one isolated session                                                                                                                                                                     |
| `dispose()`                    | Release shared resources (a browser, a device connection)                                                                                                                                      |

`SessionOptions` carries `sessionId`, `runId?`, the `evidence` sink, `screenshots`,
`stepTimeoutMs`, `assertionTimeoutMs?` (fall back to `stepTimeoutMs`), `scope` and a `logger`.

`AdapterSession`:

| Member                               | Contract                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `perform(action, { stepId, index })` | Return `{ status: ok \| blocked \| error, message?, evidence[] }`. Never throw for application behaviour; classify instead. Respect `stepTimeoutMs` and scope |
| `check(assertion)`                   | Return `{ passed, message? }`; retry state checks up to `assertionTimeoutMs`                                                                                  |
| `observe()`                          | `{ summary, url?, title?, screenshot? }`: a compact text rendering agents can act on                                                                          |
| `drainSignals()`                     | Error signals since the previous call: `{ kind, message, signature, stepId?, details?, at }`. Use `normalizeSignature()` from core for `signature`            |
| `capture(kind, label?)`              | `screenshot`, `dom` or `output`; return `undefined` when unsupported                                                                                          |
| `close()`                            | Idempotent; release everything the session started                                                                                                            |

### Evidence

Never write evidence files yourself. Use the sink from `SessionOptions`:

```ts
const png = await device.screenshot();
const shot = options.evidence.file('screenshot', png, 'png', { stepId, label: 'after-tap', mimeType: 'image/png' });
const log = options.evidence.text('log', recentLog, { stepId, label: 'device-log' });
return { status: 'blocked', message: 'Button "Pay" is disabled', evidence: [shot, log] };
```

`file()` writes `NNN-<label>.<ext>` into the session directory (`runs/<runId>` or
`explore/<sessionId>`) and returns a record with a path relative to the evidence root; `text()`
stores small content inline. The engine persists every record the sink produced.

### Mutation hints

`describe().hints` tells the adapter-neutral operators how to mutate your vocabulary:

| Field                | Web value                     | CLI value           | Used by                                                                       |
| -------------------- | ----------------------------- | ------------------- | ----------------------------------------------------------------------------- |
| `anchorActionTypes`  | `["navigate"]`                | `["start", "exec"]` | Never skipped, reordered, repeated; interruptions are not inserted after them |
| `inputActions`       | `fill.value`, `select.value`  | `write.text`        | `data-fuzz`                                                                   |
| `interruptSequences` | `[[reload], [back, forward]]` | `[[signal SIGINT]]` | `interrupt`                                                                   |
| `waitAction`         | `wait.ms`                     | `wait.ms`           | `timing`; `repeat-step` skips waits                                           |

Omit `waitAction` if you have no pure pause; `timing` then produces nothing.

### The target-free `describe` export

During setup no target exists yet, but the inspector agent needs the vocabulary to write seed
workflows. The registry calls the module-level `describe()` of every registered adapter for
that; adapters without it are simply not offered to the inspector. It should return the same
value as `adapter.describe()` (the cli adapter's guide adapts to whether a `promptPattern` is
configured, which is the one permitted difference).

### Testing advice

- Unit-test `validateAction`/`validateAssertion` with every example from `describe()`; agents
  copy those examples.
- Run sessions against a small fixture application with planted bugs, as the built-in adapters
  do with `examples/todo-web` and `examples/counter-cli`. Construct the adapter directly with
  `createAdapter({ target, rootDir, logger: createLogger({ level: 'silent' }) })` and an
  `EvidenceSink` pointing at a temporary directory.
- Assert the outcome classification explicitly: a missing control must be `blocked`, not
  `error`, or every skip-step mutation will look like an infrastructure failure.
- Assert that one application error yields exactly one signal with a stable `signature`
  across runs; volatile ids in signatures split one bug into many findings.
- Check that `close()` leaves no processes or browser contexts behind.
