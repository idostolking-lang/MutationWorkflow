import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

/** Write a file without leaving a partially written file behind if the process dies. */
export function writeFileAtomic(path: string, content: string | Uint8Array): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** Resolve `path` against `root` and refuse to escape it. */
export function resolveInside(root: string, path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return absolute;
  }
  throw new Error(`Path "${path}" escapes "${root}"`);
}

/** Portable relative path with forward slashes, for storing in the database. */
export function toPortableRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}

/** Turn free text into a safe file name fragment. */
export function slugify(text: string, maxLength = 48): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLength) || 'item'
  );
}
