/** Compile a user-supplied regular expression; `^` and `$` match at line boundaries. */
export function compilePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'm');
  } catch (error) {
    throw new SyntaxError(`Invalid regular expression "${pattern}": ${(error as Error).message}`);
  }
}

/** True when `pattern` is a valid regular expression, for schema refinements. */
export function isValidPattern(pattern: string): boolean {
  try {
    compilePattern(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the last match of `prompt` in `text` is followed by nothing but whitespace, that is
 * the application printed its prompt and is now waiting for input.
 */
export function endsWithPrompt(text: string, prompt: RegExp): boolean {
  const global = new RegExp(
    prompt.source,
    prompt.flags.includes('g') ? prompt.flags : `${prompt.flags}g`,
  );
  let end = -1;
  for (const match of text.matchAll(global)) {
    end = match.index + match[0].length;
  }
  return end >= 0 && text.slice(end).trim() === '';
}

/**
 * Words that report a defect rather than a rejected input: Python tracebacks, Go panics, fatal
 * and unhandled errors, and native crashes. Plain `error:` or `warning:` lines do not count,
 * since applications print those when they correctly reject bad input.
 */
const DEFECT_WORDS =
  /\bTraceback\b|\bpanic:|\bfatal\b|\bunhandled\b|\bsegmentation fault\b|\bcore dumped\b/i;
/** Exception class names such as `TypeError` or `NullPointerException`. */
const ERROR_CLASS = /\b[A-Z]\w*(Error|Exception)\b/;
/**
 * Stack frames: JavaScript (`at fn (file:line:col)`, `at file:line:col`), Java
 * (`at pkg.Class.method(File.java:12)`) and Python (`File "app.py", line 3`).
 */
const STACK_FRAMES = [
  /^\s*at\s.*\(?\S+:\d+:\d+\)?\s*$/,
  /^\s*at\s+[\w$.<>/]+\([\w$.-]+:\d+\)\s*$/,
  /^\s*File ".+", line \d+/,
];

function isStackFrame(line: string): boolean {
  return STACK_FRAMES.some((frame) => frame.test(line));
}

/**
 * Heuristic for stderr lines that show a defect: a stack frame, an exception class name, or a
 * crash word (`Traceback`, `panic:`, `fatal`, `unhandled`, `segmentation fault`, `core dumped`).
 * Ordinary diagnostics such as `error: invalid number` are not error lines.
 */
export function isErrorLine(line: string): boolean {
  return ERROR_CLASS.test(line) || DEFECT_WORDS.test(line) || isStackFrame(line);
}

/**
 * The line that best names an error in a block of stderr: the first line naming an exception
 * class, else the first with a crash word, else the first stack frame. Undefined when no line
 * shows a defect.
 */
export function errorHeadline(lines: ReadonlyArray<string>): string | undefined {
  const line =
    lines.find((candidate) => ERROR_CLASS.test(candidate)) ??
    lines.find((candidate) => DEFECT_WORDS.test(candidate)) ??
    lines.find(isStackFrame);
  return line?.trim();
}
