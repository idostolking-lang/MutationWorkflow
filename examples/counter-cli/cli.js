#!/usr/bin/env node
// A tiny counter with undo, redo and one save slot. It has three deliberate sequence bugs
// (see README.md) for MutationWorkflow to find. Zero dependencies; works without a TTY.
import { createInterface } from 'node:readline';

const HELP = `Commands:
  add <n>    add n to the counter
  sub <n>    subtract n from the counter
  undo       undo the last change
  redo       redo the last undone change
  reset      set the counter back to 0
  history    list the values you can undo to
  save       remember the current value
  load       restore the remembered value
  help       show this help
  quit       exit`;

const state = {
  value: 0,
  /** `{ value }` entries to return to on undo; `null` marks a reset, which undo must not cross. */
  undo: [],
  redo: [],
  /** The save slot; created by the first `save`. */
  slot: undefined,
};

function change(next) {
  state.undo.push({ value: state.value });
  state.redo = [];
  state.value = next;
  return String(state.value);
}

function parseAmount(raw) {
  const amount = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(amount) ? amount : undefined;
}

/** Run one command and return the text to print. */
function run(name, arg) {
  switch (name) {
    case 'add':
    case 'sub': {
      const amount = parseAmount(arg);
      if (amount === undefined) return `usage: ${name} <number>`;
      return change(name === 'add' ? state.value + amount : state.value - amount);
    }
    case 'undo': {
      if (state.undo.length === 0) return 'nothing to undo';
      // BUG (a): the reset marker is popped like any other entry and dereferenced.
      const previous = state.undo.pop().value;
      // BUG (b): unshift instead of push, so the redo stack comes back in the wrong order.
      state.redo.unshift(state.value);
      state.value = previous;
      return String(state.value);
    }
    case 'redo': {
      if (state.redo.length === 0) return 'nothing to redo';
      state.undo.push({ value: state.value });
      state.value = state.redo.pop();
      return String(state.value);
    }
    case 'reset':
      state.value = 0;
      state.undo.push(null);
      state.redo = [];
      // BUG (c): clears the saved value but keeps the slot, so `load` thinks something is saved.
      if (state.slot) state.slot.value = undefined;
      return '0';
    case 'history':
      return state.undo.length === 0
        ? 'history: (empty)'
        : `history: ${state.undo.map((entry) => (entry === null ? 'reset' : entry.value)).join(' ')}`;
    case 'save':
      state.slot = { value: state.value };
      return `saved ${state.value}`;
    case 'load':
      if (!state.slot) return 'nothing saved';
      return change(Number(state.slot.value));
    case 'help':
      return HELP;
    default:
      return undefined;
  }
}

/** Non-interactive mode: `counter add 5 sub 2` runs each command and prints the final value. */
function runArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    const takesArg = name === 'add' || name === 'sub';
    const output = run(name, takesArg ? args[++i] : undefined);
    if (output === undefined || output.startsWith('usage:')) {
      process.stderr.write(`${output ?? `unknown command "${name}"`}\n`);
      process.exit(2);
    }
  }
  console.log(String(state.value));
}

/** Interactive mode: one command per line on stdin, `> ` prompt on stdout. */
function repl() {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.setPrompt('> ');
  console.log('counter ready. Type "help" for commands.');
  rl.prompt();
  rl.on('line', (line) => {
    const [name = '', arg] = line.trim().split(/\s+/);
    if (name === 'quit') {
      console.log('bye');
      rl.close();
      return;
    }
    if (name !== '') {
      console.log(run(name, arg) ?? `unknown command "${name}". Type "help" for commands.`);
    }
    rl.prompt();
  });
  rl.on('close', () => process.exit(0));
}

const args = process.argv.slice(2);
if (args.length > 0) {
  runArgs(args);
} else {
  repl();
}
