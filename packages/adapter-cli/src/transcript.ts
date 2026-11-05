export type Stream = 'stdout' | 'stderr';
export type StreamSelector = Stream | 'both';

/** Lengths of the captured output at one moment, used to search only what came after it. */
export interface OutputOffsets {
  stdout: number;
  stderr: number;
  both: number;
}

export const START_OFFSETS: OutputOffsets = Object.freeze({ stdout: 0, stderr: 0, both: 0 });

interface Entry {
  kind: Stream | 'marker';
  text: string;
}

const STDERR_PREFIX = '[stderr] ';
const MARKER_PREFIX = '── ';

/**
 * Everything a session's processes printed, in arrival order, plus markers for steps and process
 * lifecycle. Output is kept per stream (for assertions) and interleaved (for humans and agents).
 * Sessions are short-lived, so the full output is kept in memory.
 */
export class Transcript {
  private readonly text: Record<StreamSelector, string> = { stdout: '', stderr: '', both: '' };
  private readonly entries: Entry[] = [];

  append(stream: Stream, chunk: string): void {
    if (chunk === '') return;
    this.text[stream] += chunk;
    this.text.both += chunk;
    const last = this.entries.at(-1);
    if (last?.kind === stream) {
      last.text += chunk;
    } else {
      this.entries.push({ kind: stream, text: chunk });
    }
  }

  /** Add a line such as "step 2: write "add 5"" that is shown in renders but never matched. */
  mark(line: string): void {
    this.entries.push({ kind: 'marker', text: line });
  }

  offsets(): OutputOffsets {
    return {
      stdout: this.text.stdout.length,
      stderr: this.text.stderr.length,
      both: this.text.both.length,
    };
  }

  /** Output of `stream`, optionally only what was printed after `from`. */
  output(stream: StreamSelector, from: OutputOffsets = START_OFFSETS): string {
    return this.text[stream].slice(from[stream]);
  }

  /** Interleaved transcript: stdout verbatim, stderr lines prefixed, markers on their own lines. */
  render(): string {
    let out = '';
    let previous: Entry['kind'] | undefined;
    for (const entry of this.entries) {
      if (previous !== undefined && previous !== entry.kind && out !== '' && !out.endsWith('\n')) {
        out += '\n';
      }
      if (entry.kind === 'marker') {
        out += `${MARKER_PREFIX}${entry.text}\n`;
      } else if (entry.kind === 'stderr') {
        out += entry.text.replace(/^(?=.)/gm, STDERR_PREFIX);
      } else {
        out += entry.text;
      }
      previous = entry.kind;
    }
    return out;
  }
}
