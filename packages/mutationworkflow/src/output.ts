import pc from 'picocolors';
import type { Colors } from 'picocolors/types.js';

/**
 * The CLI's only way to print. Results go to stdout, progress and diagnostics to stderr, so
 * `mw findings --json | jq` stays machine-readable.
 */
export interface Output {
  /** A line (or block) of results on stdout. */
  out(text: string): void;
  /** JSON on stdout, pretty-printed. */
  json(value: unknown): void;
  /** A line on stderr. */
  err(text: string): void;
  /** Colours for stdout, disabled when stdout is not a terminal. */
  colors: Colors;
}

interface Writable {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

export function createOutput(
  stdout: Writable = process.stdout,
  stderr: Writable = process.stderr,
): Output {
  return {
    out: (text) => stdout.write(`${text}\n`),
    json: (value) => stdout.write(`${JSON.stringify(value, null, 2)}\n`),
    err: (text) => stderr.write(`${text}\n`),
    colors: pc.createColors(pc.isColorSupported && stdout.isTTY === true),
  };
}
