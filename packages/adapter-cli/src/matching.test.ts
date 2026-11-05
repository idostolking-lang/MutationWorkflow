import { describe, expect, it } from 'vitest';
import { compilePattern, endsWithPrompt, errorHeadline, isErrorLine } from './matching.js';

describe('compilePattern', () => {
  it('compiles multiline patterns', () => {
    expect(compilePattern('^5$').test('add 5\n5\n> ')).toBe(true);
  });

  it('names the pattern when it is invalid', () => {
    expect(() => compilePattern('(')).toThrow('Invalid regular expression "("');
  });
});

describe('endsWithPrompt', () => {
  const prompt = compilePattern('^> ');

  it('is true when the prompt is the last thing printed', () => {
    expect(endsWithPrompt('5\n> ', prompt)).toBe(true);
    expect(endsWithPrompt('> 5\n> \n', prompt)).toBe(true);
  });

  it('is false when output follows the prompt or no prompt appeared', () => {
    expect(endsWithPrompt('> 5\n', prompt)).toBe(false);
    expect(endsWithPrompt('working', prompt)).toBe(false);
    expect(endsWithPrompt('', prompt)).toBe(false);
  });
});

describe('error heuristics', () => {
  it('recognises error words and stack frames', () => {
    expect(isErrorLine('TypeError: x is undefined')).toBe(true);
    expect(isErrorLine('Traceback (most recent call last):')).toBe(true);
    expect(isErrorLine('    at run (file:///app/cli.js:52:30)')).toBe(true);
    expect(isErrorLine('    at file:///app/cli.js:125:3')).toBe(true);
    expect(isErrorLine('warning: deprecated flag')).toBe(false);
    expect(isErrorLine('terrors are not errors')).toBe(false);
  });

  it('picks the line that names the error', () => {
    const lines = [
      'file:///app/cli.js:52',
      '    at run (file:///app/cli.js:52:30)',
      "TypeError: Cannot read properties of null (reading 'value')",
    ];
    expect(errorHeadline(lines)).toBe(
      "TypeError: Cannot read properties of null (reading 'value')",
    );
    expect(errorHeadline(lines.slice(0, 2))).toBe('at run (file:///app/cli.js:52:30)');
    expect(errorHeadline(['all good'])).toBeUndefined();
  });
});
