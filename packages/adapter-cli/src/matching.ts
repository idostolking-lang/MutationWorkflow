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

const ERROR_WORDS = /\b(error|exception|traceback|panic|unhandled|fatal)\b/i;
/** Exception class names such as `TypeError` or `NullPointerException`. */
const ERROR_CLASS = /\b[A-Z]\w*(Error|Exception)\b/;
const STACK_FRAME = /^\s*at\s.*\(?\S+:\d+:\d+\)?\s*$/;

/** Heuristic for stderr lines that report an error rather than ordinary diagnostics. */
export function isErrorLine(line: string): boolean {
  return ERROR_WORDS.test(line) || ERROR_CLASS.test(line) || STACK_FRAME.test(line);
}

/**
 * The line that best names an error in a block of stderr: the first line naming an exception
 * class, else the first with an error word, else the first stack frame. Undefined when no line
 * looks like an error.
 */
export function errorHeadline(lines: ReadonlyArray<string>): string | undefined {
  const line =
    lines.find((candidate) => ERROR_CLASS.test(candidate)) ??
    lines.find((candidate) => ERROR_WORDS.test(candidate)) ??
    lines.find((candidate) => STACK_FRAME.test(candidate));
  return line?.trim();
}
