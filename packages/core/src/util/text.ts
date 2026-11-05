/** Trim long text for prompts and summaries, marking the cut. */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const marker = ` … [${text.length - maxLength} more characters]`;
  return `${text.slice(0, Math.max(0, maxLength - marker.length))}${marker}`;
}

/** Keep only the last `maxLength` characters, marking the cut. */
export function tail(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const marker = `[… ${text.length - maxLength} earlier characters] `;
  return `${marker}${text.slice(text.length - Math.max(0, maxLength - marker.length))}`;
}

/**
 * Replace parts of an error message that vary between identical failures (ids, numbers,
 * timestamps, hashes, quoted values) so the same failure always yields the same signature.
 */
export function normalizeSignature(message: string): string {
  return message
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hash>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/(["'`]).*?\1/g, '$1<str>$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
