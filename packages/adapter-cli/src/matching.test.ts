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
  it('recognises exception classes, crash words and stack frames', () => {
    expect(isErrorLine('TypeError: x is undefined')).toBe(true);
    expect(isErrorLine('Exception in thread "main" java.lang.NullPointerException')).toBe(true);
    expect(isErrorLine('Traceback (most recent call last):')).toBe(true);
    expect(isErrorLine('panic: runtime error: index out of range [3]')).toBe(true);
    expect(isErrorLine('fatal: unable to read config')).toBe(true);
    expect(isErrorLine('Unhandled promise rejection')).toBe(true);
    expect(isErrorLine('Segmentation fault (core dumped)')).toBe(true);
    expect(isErrorLine('    at run (file:///app/cli.js:52:30)')).toBe(true);
    expect(isErrorLine('    at file:///app/cli.js:125:3')).toBe(true);
    expect(isErrorLine('\tat com.example.App.main(App.java:12)')).toBe(true);
    expect(isErrorLine('  File "app.py", line 3, in <module>')).toBe(true);
  });

  it('ignores ordinary diagnostics', () => {
    expect(isErrorLine('error: invalid number')).toBe(false);
    expect(isErrorLine('Error: missing argument <name>')).toBe(false);
    expect(isErrorLine('ERROR: unknown command "bogus"')).toBe(false);
    expect(isErrorLine('warning: deprecated flag')).toBe(false);
    expect(isErrorLine('usage: app [options]')).toBe(false);
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
    expect(errorHeadline(['goroutine 1 [running]:', 'panic: boom'])).toBe('panic: boom');
    expect(errorHeadline(['all good'])).toBeUndefined();
    expect(errorHeadline(['error: invalid number', 'usage: app <n>'])).toBeUndefined();
  });
});
