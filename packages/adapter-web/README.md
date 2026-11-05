# @mutationworkflow/adapter-web

Playwright adapter for [MutationWorkflow](../../README.md). It drives a web application in a real
browser, turns what the page does wrong (console errors, uncaught exceptions, failed requests,
HTTP error responses, crashes) into signals, and records screenshots, console output and DOM
snapshots as evidence.

```sh
pnpm add -D @mutationworkflow/adapter-web playwright
pnpm exec playwright install chromium
```

## Target configuration

```yaml
targets:
  - id: todo
    kind: web
    options:
      baseUrl: http://127.0.0.1:4173
    scope:
      denyText: ["delete account", "log ?out"]
```

| Option             | Default                        | Meaning                                                             |
| ------------------ | ------------------------------ | ------------------------------------------------------------------- |
| `baseUrl`          | required                       | Root http(s) URL of the application                                 |
| `browser`          | `chromium`                     | `chromium`, `firefox` or `webkit`                                   |
| `headless`         | `true`                         | Run without a window                                                |
| `viewport`         | `{ width: 1280, height: 800 }` | Viewport in CSS pixels                                              |
| `launchOptions`    | `{}`                           | Passed unchanged to Playwright's `browserType.launch()`             |
| `storageStatePath` | none                           | Storage state file (relative to the project root) for every session |

One browser is launched lazily per adapter; every session gets its own isolated browser context
and page, which start on `about:blank`.

## Locators

Actions and assertions find elements with a locator. Exactly one strategy is used, by priority:
`testId` → `role` (+ `name`) → `label` → `placeholder` → `text` → `css`. `exact` makes name,
label, placeholder and text matching exact (otherwise case-insensitive substring); `nth`
(zero-based) picks one of several matches. When several elements match and `nth` is missing,
the action is `blocked` as ambiguous.

```json
{ "role": "button", "name": "Save" }
{ "label": "Email" }
{ "role": "button", "name": "Delete", "nth": 1 }
```

## Actions

| Type         | Fields                   | Notes                                                     |
| ------------ | ------------------------ | --------------------------------------------------------- |
| `navigate`   | `url`                    | Absolute, or relative to `baseUrl`; checked against scope |
| `click`      | `target`                 |                                                           |
| `dblclick`   | `target`                 |                                                           |
| `fill`       | `target`, `value`        | Replaces the field content                                |
| `press`      | `key`, `target?`         | Playwright key syntax, e.g. `Enter`, `Control+A`          |
| `select`     | `target`, `value`        | Option value or label                                     |
| `check`      | `target`                 |                                                           |
| `uncheck`    | `target`                 |                                                           |
| `hover`      | `target`                 |                                                           |
| `scroll`     | `target`                 | Scrolls the element into view                             |
| `wait`       | `ms?`, `target?`, `url?` | At least one; `url` is a glob, path glob or `/regex/`     |
| `reload`     |                          |                                                           |
| `back`       |                          | `ok` with a note when there is no history entry           |
| `forward`    |                          |                                                           |
| `screenshot` | `label?`                 | Always saves a screenshot                                 |

Outcomes:

- `ok`: the action was performed.
- `blocked`: the element was missing, hidden, disabled or ambiguous within `stepTimeoutMs`; the
  control's text, aria-label or value matched `scope.denyText` (click, dblclick, press on a
  target, check); or the URL is outside the scope. Navigations out of scope caused by an action
  are undone with `back`.
- `error`: the page crashed, a navigation failed or timed out, or Playwright failed unexpectedly.

After every action the adapter waits until no request has been in flight for 100 ms (at most
3 s), so the signals a step causes are attributed to that step.

## Assertions

| Type              | Fields                             | Passes when                                                         |
| ----------------- | ---------------------------------- | ------------------------------------------------------------------- |
| `url-matches`     | `pattern`                          | URL matches a full-URL glob, a path glob (`/todos/**`) or `/regex/` |
| `title-matches`   | `pattern`                          | Title contains the text, or matches `/regex/`                       |
| `text-visible`    | `text`, `exact?`                   | Some visible element has the text                                   |
| `text-hidden`     | `text`                             | No visible element has the text                                     |
| `element-visible` | `target`                           | A matching element is visible                                       |
| `element-hidden`  | `target`                           | No matching element is visible                                      |
| `element-count`   | `target`, `count?`, `min?`, `max?` | Number of matches (hidden included) is within bounds                |
| `value-equals`    | `target`, `value`                  | Field value equals `value`                                          |
| `http`            | `url`, `status?`                   | GET with the session cookies returns `status` (or < 400)            |

State assertions retry until they hold or `stepTimeoutMs` elapses. Assertions never throw for
application state; they return `{ passed, message }`.

## Signals and evidence

| Signal               | Source                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `console-error`      | `console.error` in the page (Chromium's "Failed to load resource" lines are skipped; they are reported as the two below) |
| `uncaught-exception` | Uncaught errors in the page                                                                                              |
| `network-error`      | Failed requests, except ones the browser cancelled (`ERR_ABORTED`)                                                       |
| `http-error`         | Responses with status ≥ 400, with `details: { status, url, method }`                                                     |
| `crash`              | The page crashed                                                                                                         |

Screenshots follow the session's `screenshots` setting (`always`, `on-failure`, `never`); every
non-`ok` outcome also carries the recent console output. `observe()` returns the page's ARIA
snapshot, and `capture()` saves a screenshot, the DOM (`.html`) or the console output.
