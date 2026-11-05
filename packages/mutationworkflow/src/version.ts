import { readFileSync } from 'node:fs';

/** Version of the `mutationworkflow` package, read from its package.json. */
export const VERSION: string = readVersion();

function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'version' in parsed) {
      return String(parsed.version);
    }
  } catch {
    // Fall through: a missing package.json only affects the reported version.
  }
  return '0.0.0';
}
