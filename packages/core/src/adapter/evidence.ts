import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Evidence,
  type EvidenceKind,
  EvidenceSchema,
  newId,
  nowIso,
} from '../schema/index.js';
import { ensureDir, slugify, toPortableRelative } from '../util/fs.js';

export interface EvidenceSinkOptions {
  /** Absolute evidence root from the config. */
  rootDir: string;
  /** Directory for this session, relative to the root (e.g. `runs/run_123`). */
  sessionDir: string;
  sessionId?: string;
  runId?: string;
}

export interface EvidenceMeta {
  stepId?: string;
  label?: string;
  mimeType?: string;
}

/**
 * Writes evidence files for one session and returns records with portable relative paths.
 * Adapters never compute evidence paths themselves.
 */
export class EvidenceSink {
  readonly dir: string;
  private readonly records: Evidence[] = [];
  private counter = 0;

  constructor(private readonly options: EvidenceSinkOptions) {
    this.dir = ensureDir(join(options.rootDir, options.sessionDir));
  }

  /** Everything written through this sink so far. */
  get all(): ReadonlyArray<Evidence> {
    return this.records;
  }

  file(
    kind: EvidenceKind,
    data: Uint8Array | string,
    extension: string,
    meta: EvidenceMeta = {},
  ): Evidence {
    this.counter += 1;
    const name = `${String(this.counter).padStart(3, '0')}-${slugify(meta.label ?? kind)}.${extension}`;
    const absolute = join(this.dir, name);
    writeFileSync(absolute, data);
    return this.record({ kind, ...meta, path: toPortableRelative(this.options.rootDir, absolute) });
  }

  text(kind: EvidenceKind, text: string, meta: EvidenceMeta = {}): Evidence {
    return this.record({ kind, ...meta, text, mimeType: meta.mimeType ?? 'text/plain' });
  }

  private record(partial: Omit<Evidence, 'id' | 'createdAt' | 'runId' | 'sessionId'>): Evidence {
    const evidence = EvidenceSchema.parse({
      ...partial,
      id: newId('ev'),
      runId: this.options.runId,
      sessionId: this.options.sessionId,
      createdAt: nowIso(),
    });
    this.records.push(evidence);
    return evidence;
  }
}
