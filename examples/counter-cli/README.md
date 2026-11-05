# counter-cli

A tiny interactive counter used to demonstrate and test the
[`@mutationworkflow/adapter-cli`](../../packages/adapter-cli) process adapter. It has no
dependencies and does not need a terminal: it reads one command per line from stdin and prints a
`> ` prompt, so it can be driven through plain pipes.

```console
$ node cli.js
counter ready. Type "help" for commands.
> add 5
5
> sub 2
3
> quit
bye
```

It also has a non-interactive mode that runs the commands given as arguments and prints the final
value:

```console
$ node cli.js add 5 sub 2
3
```

| Command   | Effect                             |
| --------- | ---------------------------------- |
| `add <n>` | add `n` to the counter             |
| `sub <n>` | subtract `n` from the counter      |
| `undo`    | undo the last change               |
| `redo`    | redo the last undone change        |
| `reset`   | set the counter back to 0          |
| `history` | list the values you can undo to    |
| `save`    | remember the current value         |
| `load`    | restore the remembered value       |
| `help`    | list the commands                  |
| `quit`    | exit (closing stdin does the same) |

## Planted bugs

Every command works on its own, and the happy paths (`add`, `sub`, `undo`, `redo`, `save`,
`load`) behave correctly. The bugs only appear for particular **sequences** of commands, which is
exactly what MutationWorkflow's skip, reorder, repeat and interleave mutations are meant to reach.

| Bug            | Triggering sequence                                                 | Expected                                         | Actual                                                                                            |
| -------------- | ------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| (a) crash      | `reset` → `undo` (also any `undo` that reaches back past a `reset`) | `nothing to undo`, or the value before the reset | `TypeError: Cannot read properties of null (reading 'value')`, stack trace on stderr, exit code 1 |
| (b) wrong redo | `add 5` → `add 3` → `undo` → `undo` → `redo`                        | `5`                                              | `8` (the redo stack is rebuilt in reverse order)                                                  |
| (c) NaN        | `save` → `reset` → `load`                                           | `nothing saved` (or the saved value)             | `NaN`                                                                                             |

Causes, for reference: `reset` pushes a `null` marker onto the undo stack that `undo` dereferences;
`undo` uses `unshift` instead of `push` on the redo stack; `reset` clears the saved value but
keeps the save slot, so `load` converts `undefined` to a number.

A single `undo` followed by `redo` works, as does `save` → `load`, so a recorded happy-path
workflow passes: only mutated sequences fail.
