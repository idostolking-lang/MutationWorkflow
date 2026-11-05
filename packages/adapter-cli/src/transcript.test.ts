import { describe, expect, it } from 'vitest';
import { StderrScanner } from './signals.js';
import { Transcript } from './transcript.js';

describe('Transcript', () => {
  it('keeps per-stream output and searches from offsets', () => {
    const transcript = new Transcript();
    transcript.append('stdout', 'ready\n> ');
    const offsets = transcript.offsets();
    transcript.mark('step 1: write');
    transcript.append('stdout', '5\n');
    transcript.append('stderr', 'oops\n');

    expect(transcript.output('stdout')).toBe('ready\n> 5\n');
    expect(transcript.output('stdout', offsets)).toBe('5\n');
    expect(transcript.output('stderr', offsets)).toBe('oops\n');
    expect(transcript.output('both', offsets)).toBe('5\noops\n');
  });

  it('renders markers and prefixed stderr without mixing them into the output', () => {
    const transcript = new Transcript();
    transcript.mark('$ node cli.js');
    transcript.append('stdout', '> ');
    transcript.mark('step s1: write');
    transcript.append('stdout', '5\n');
    transcript.append('stderr', 'Error: one\nat two');
    transcript.append('stdout', '> ');

    expect(transcript.render()).toBe(
      '── $ node cli.js\n> \n── step s1: write\n5\n[stderr] Error: one\n[stderr] at two\n> ',
    );
    expect(transcript.output('both')).not.toContain('step');
  });
});

describe('StderrScanner', () => {
  it('turns a stack trace into one signal named by its error line', () => {
    const scanner = new StderrScanner();
    scanner.push('file:///app/cli.js:52\n\nTypeError: Cannot read properties of null', 's3');
    scanner.push(" (reading 'value')\n    at run (file:///app/cli.js:52:30)\n", 's4');

    const signal = scanner.flush();
    expect(signal).toMatchObject({
      kind: 'stderr',
      message: "TypeError: Cannot read properties of null (reading 'value')",
      stepId: 's3',
    });
    expect(signal?.signature).toBe(
      "stderr TypeError: Cannot read properties of null (reading '<str>')",
    );
    expect(scanner.flush()).toBeUndefined();
  });

  it('ignores stderr that does not look like an error', () => {
    const scanner = new StderrScanner();
    scanner.push('listening on port 3000\n', undefined);
    expect(scanner.flush()).toBeUndefined();
  });
});
