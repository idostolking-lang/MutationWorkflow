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

| Option               | Default                        | Meaning                                                             |
| -------------------- | ------------------------------ | ------------------------------------------------------------------- |
| `baseUrl`            | required                       | Root http(s) URL of the application; must be a loopback host        |
| `allowRemoteBaseUrl` | `false`                        | Allow a `baseUrl` that is not loopback (see below)                  |
| `browser`            | `chromium`                     | `chromium`, `firefox` or `webkit`                                   |
| `headless`           | `true`                         | Run without a window                                                |
| `viewport`           | `{ width: 1280, height: 800 }` | Viewport in CSS pixels                                              |
| `launchOptions`      | `{}`                           | Passed unchanged to Playwright's `browserType.launch()`             |
| `storageStatePath`   | none                           | Storage state file (relative to the project root) for every session |

One browser is launched lazily per adapter; every session gets its own isolated browser context
and page, which start on `about:blank`.

`baseUrl` must point at a loopback host: `localhost`, `*.localhost`, `127.0.0.0/8` or `[::1]`.
Anything else is rejected with `CONFIG_INVALID` unless `allowRemoteBaseUrl: true` is set. Set it
only for a local instance you started that is reached under another host name (a container or
VM on your machine); never point it at a shared or production environment.

### Scope enforcement

The target's `scope` is enforced inside the browser, before requests leave it. A route on every
session's browser context aborts:

- every navigation (of the page, an iframe or a popup) whose URL is out of scope, and
- every request with a method other than `GET` or `HEAD` whose URL is out of scope, since those
  can have side effects.

"In scope" means matching `scope.allowUrls` (when empty: the `baseUrl` origin followed by `/**`)
and not matching `scope.denyUrls`. Out-of-scope `GET` subresources (fonts, scripts or images from
a CDN) still load, so local applications keep working. Aborted requests are logged with the
console evidence and are not reported as `network-error` signals. Service workers are blocked,
because their requests would bypass the route. As a backstop the page URL is still checked after
every action (redirects are not re-routed), and a page that ended up out of scope is left with
`back`.

Workflows run in a single tab. Pages the application opens (`target="_blank"`, `window.open`)
never load: they are closed at once, and the next action outcome says so ("popup to <url>
closed"). The workflow continues in the original page.

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
  control's text, aria-label or value matched `scope.denyText`; or the URL is outside the scope.
  The denyText guard covers `click`, `dblclick`, `check`, `uncheck`, `press` (on its target, or
  without one on the focused element), and `select` (the chosen option's label and value and
  the select's aria-label). A navigation out of scope caused by an action is aborted before it
  leaves the browser, and the message names its URL.
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

## Footprint

`WebSession.footprint()` reports what the session touched, cumulatively, so the engine can tell
which workflows exercise code changed by a push. `urls` lists the in-scope pages the main frame
visited (navigate, link clicks, reload, back/forward, history API) as paths without host, query
or hash. `endpoints` lists in-scope backend requests as `"<METHOD> <path>"`: every request whose
method is not GET (fetch, XHR or form POST), plus GETs made with fetch or XHR. Document loads,
static assets (scripts, styles, images, fonts, media) and out-of-scope or scope-blocked requests
are left out. Both lists are unique, in first-seen order, and capped at 200 entries.
