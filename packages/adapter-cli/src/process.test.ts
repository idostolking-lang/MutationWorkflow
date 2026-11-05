import { describe, expect, it } from 'vitest';
import { actionArgsProblem, shellQuote, spawnArgs } from './process.js';

describe('shellQuote', () => {
  it('single-quotes every argument and closes the quotes around embedded quotes', () => {
    expect(shellQuote('plain')).toBe("'plain'");
    expect(shellQuote('')).toBe("''");
    expect(shellQuote('; rm -rf ~')).toBe("'; rm -rf ~'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('$(id) `id` $HOME *')).toBe("'$(id) `id` $HOME *'");
  });
});

describe('spawnArgs', () => {
  it('quotes arguments only when a POSIX shell interprets them', () => {
    expect(spawnArgs(['a b', '$x'], false, 'linux')).toEqual(['a b', '$x']);
    expect(spawnArgs(['a b', '$x'], true, 'linux')).toEqual(["'a b'", "'$x'"]);
    expect(spawnArgs(['a b'], true, 'darwin')).toEqual(["'a b'"]);
    expect(spawnArgs(['a b'], true, 'win32')).toEqual(['a b']);
  });
});

describe('actionArgsProblem', () => {
  it('refuses per-action args only with shell on Windows', () => {
    expect(actionArgsProblem(true, ['x'], 'win32')).toMatch(/not supported .* shell is true/);
    expect(actionArgsProblem(true, [], 'win32')).toBeUndefined();
    expect(actionArgsProblem(false, ['x'], 'win32')).toBeUndefined();
    expect(actionArgsProblem(true, ['x'], 'linux')).toBeUndefined();
  });
});
