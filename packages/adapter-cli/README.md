# @mutationworkflow/adapter-cli

Process adapter for [MutationWorkflow](../../README.md). It drives command-line and terminal
applications through stdin, stdout and stderr, so agents can discover workflows in a REPL or a
one-shot CLI and MutationWorkflow can replay mutated versions of them.

```yaml
targets:
  - id: counter
    kind: cli
    options:
      command: node
      args: [cli.js]
      cwd: examples/counter-cli
      promptPattern: "^> "
```

## Options (`target.options`)

| Option          | Default      | Meaning                                                                              |
| --------------- | ------------ | ------------------------------------------------------------------------------------ |
| `command`       | (required)   | Executable to run                                                                    |
| `args`          | `[]`         | Arguments, before any per-action `args`                                              |
| `cwd`           | project root | Working directory, relative to the project root                                      |
| `env`           | `{}`         | Variables merged over the current environment                                        |
| `shell`         | `false`      | Run the command through the system shell                                             |
| `promptPattern` | none         | Multiline regular expression for the prompt shown when input is expected, e.g. `^> ` |
| `exitTimeoutMs` | `5000`       | How long `close` waits before sending SIGTERM, then SIGKILL                          |

## Actions

A session runs at most one process at a time.

| Action                                          | Effect                                                                                                                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start {args?}`                                 | Start an interactive process. `blocked` if one is already running.                                                                                                                                                                                |
| `exec {args?}`                                  | Run to completion with stdin closed and record the exit code (timeout: the step timeout). A non-zero exit code is state for assertions, not an error.                                                                                             |
| `write {text, newline?=true}`                   | Type into stdin. `blocked` if the process is not running or stopped reading.                                                                                                                                                                      |
| `wait {ms?, output?, prompt?}`                  | Sleep `ms`, or wait until output printed since the last input matches `output` and/or the prompt is the last thing printed. With a condition, `ms` is the timeout (default: the step timeout); timing out or the process exiting gives `blocked`. |
| `signal {signal: SIGINT \| SIGTERM \| SIGKILL}` | Signal the process and its children, like Ctrl+C in a terminal.                                                                                                                                                                                   |
| `close {}`                                      | Close stdin, wait `exitTimeoutMs` for an exit, then SIGTERM, then SIGKILL.                                                                                                                                                                        |

"Since the last input" means since the most recent `start`, `write` or `signal`, so a `wait`
right after a `write` also sees an answer that arrived before the wait began.

## Assertions

| Assertion                                       | Passes when                                          |
| ----------------------------------------------- | ---------------------------------------------------- |
| `output-matches {pattern, stream?, since?}`     | the output contains a match                          |
| `output-not-matches {pattern, stream?, since?}` | the output contains no match                         |
| `exit-code {code}`                              | the process exited with `code` (fails while it runs) |
| `running {expected}`                            | the process is (or is not) running                   |
| `stderr-empty {since?}`                         | nothing was printed on stderr                        |

`stream` is `stdout`, `stderr` or `both` (default). `since` is `session` (default) or `step`: the
output since the current step began, or since the input before it when that came earlier.
Patterns are multiline regular expressions. Input is not echoed, so an answer can share a line with
the prompt before it (`> 5`); anchor with `\b5$` rather than `^5$`.

## Signals

- `stderr`: stderr output that looks like an error (error words such as `error`, `exception`,
  `traceback`, `panic`, exception class names like `TypeError`, or stack frames). Each burst of
  stderr between steps becomes one signal named by its most telling line.
- `process-exit`: the process exited with a non-zero code when the workflow did not end it
  (`exec`, `close` and the exit codes 130/143 after a requested SIGINT/SIGTERM are expected).
- `crash`: the process was terminated by a signal the workflow did not send.

## Evidence

Observations show a header (command, running or exit status) and the last 4000 characters of
the transcript: stdout verbatim, stderr lines prefixed with `[stderr]`, and `──` marker lines for
steps and process starts and exits. `capture('output')` stores the full transcript as a `log`
file; screenshots and DOM captures are not available. When an action is not `ok`, the tails of
stdout and stderr are attached to its outcome.

## Limitations

The process runs with plain pipes, not a pseudo-terminal. Applications that check for a TTY may
behave differently than in a terminal: they may disable prompts, colours or line editing, buffer
their output, or refuse to run. Full-screen terminal UIs are not supported. A pty-based driver is
on the roadmap.
