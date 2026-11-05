import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

/** ISO 8601 timestamp with timezone offset, as produced by `Date#toISOString`. */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true }).describe('ISO 8601 timestamp');
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

/** Current time as an ISO 8601 string. */
export function nowIso(): IsoDateTime {
  return new Date().toISOString();
}

/** Prefixes make ids self-describing in logs, reports and the database. */
export type IdPrefix = 'tgt' | 'wf' | 'run' | 'ev' | 'fnd' | 'q' | 'job' | 'ses' | 'step';

// Crockford base32 without the ambiguous letters i, l, o, u.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * Create a time-sortable identifier such as `wf_01jc2k9x7m3ab5nq8r4t`.
 * The first nine characters encode the creation time, so ids sort chronologically.
 */
export function newId(prefix: IdPrefix): string {
  let time = Date.now();
  let encodedTime = '';
  for (let i = 0; i < 9; i++) {
    encodedTime = ALPHABET[time % 32] + encodedTime;
    time = Math.floor(time / 32);
  }
  let random = '';
  for (const byte of randomBytes(10)) {
    random += ALPHABET[byte % 32];
  }
  return `${prefix}_${encodedTime}${random}`;
}

/**
 * Deterministic JSON serialisation with sorted object keys, so structurally equal
 * values always produce the same string regardless of insertion order.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) {
        sorted[key] = sortKeys(entry);
      }
    }
    return sorted;
  }
  return value;
}

/** Short, stable content hash used for workflow and finding fingerprints. */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 24);
}

export const SeveritySchema = z
  .enum(['critical', 'high', 'medium', 'low'])
  .describe('How much a problem matters to users of the application under test');
export type Severity = z.infer<typeof SeveritySchema>;
