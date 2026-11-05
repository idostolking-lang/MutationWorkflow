import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { CodeMapRule, Footprint } from '../schema/index.js';
import { matchesAnyGlob } from '../util/glob.js';

/**
 * Turn what a workflow touched (pages, endpoints) into the source files that implement them,
 * so a code change can be matched to the workflows worth replaying. Two sources combine:
 * explicit rules from the target config, and a search of the repository for the literal paths
 * (an endpoint such as `/api/todos` usually appears verbatim in the route and in the client).
 */

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'vendor',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.mutationworkflow',
  'test-results',
  'playwright-report',
]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES_PER_PATH = 25;
const MAX_FILES_TOTAL = 60;

/** `POST /api/todos/42?x=1` → `/api/todos/*`; `/settings#tab` → `/settings`. */
export function normalizePath(value: string): string {
  const withoutMethod = value.replace(/^[A-Z]+\s+/, '');
  const path = withoutMethod.split(/[?#]/)[0] ?? '';
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((segment) => (isVolatileSegment(segment) ? '*' : segment));
  return `/${segments.join('/')}`;
}

/** Method prefix of an endpoint, when present. */
export function methodOf(endpoint: string): string | undefined {
  const match = /^([A-Z]+)\s+/.exec(endpoint);
  return match?.[1];
}

/** Ids and other values that change from run to run and never appear in source code. */
function isVolatileSegment(segment: string): boolean {
  return (
    /^\d+$/.test(segment) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
    /^[0-9a-f]{16,}$/i.test(segment) ||
    /^[a-z]+_[0-9a-z]{10,}$/i.test(segment)
  );
}

/**
 * The static prefix of a normalised path worth searching for: everything before the first
 * wildcard, at least one segment, never the bare root.
 */
export function searchablePrefix(normalized: string): string | undefined {
  const segments = normalized.split('/').filter(Boolean);
  const stop = segments.indexOf('*');
  const prefix = (stop >= 0 ? segments.slice(0, stop) : segments).join('/');
  return prefix ? `/${prefix}` : undefined;
}

export interface RepositoryIndex {
  /** Path relative to the root with forward slashes → UTF-8 content. */
  files: Map<string, string>;
}

/** Read every text file of the repository once; the index is reused across lookups. */
export function indexRepository(rootDir: string): RepositoryIndex {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(dir, name);
      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(name)) walk(path);
      } else if (stats.isFile() && stats.size <= MAX_FILE_BYTES) {
        const buffer = readFileSync(path);
        if (!looksBinary(buffer)) {
          files.set(relative(rootDir, path).split(sep).join('/'), buffer.toString('utf8'));
        }
      }
    }
  };
  walk(rootDir);
  return { files };
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 1024).includes(0);
}

export interface CodeMapper {
  /** Files that implement what the footprint touched, sorted, capped. */
  filesFor(footprint: Footprint): string[];
}

export interface CodeMapperOptions {
  rootDir: string;
  /** Explicit rules from the target config. */
  rules: ReadonlyArray<CodeMapRule>;
  /** Supplies the repository index; defaults to indexing `rootDir` on first use. */
  repository?: () => RepositoryIndex;
}

/**
 * Build a mapper for one target. Rules match the normalised path (`/api/todos/*`), the path with
 * its method (`POST /api/todos/*`) and the path with a trailing slash, so `/api/todos/**` covers
 * the collection and its items. The repository search adds files that mention the static part of
 * a path literally. Results are capped so a very generic path cannot claim the whole repository.
 */
export function createCodeMapper(options: CodeMapperOptions): CodeMapper {
  let index: RepositoryIndex | undefined;
  const repository = () => {
    index ??= options.repository ? options.repository() : indexRepository(options.rootDir);
    return index;
  };
  const cache = new Map<string, string[]>();

  const searchFiles = (prefix: string): string[] => {
    const cached = cache.get(prefix);
    if (cached) return cached;
    const hits: string[] = [];
    for (const [file, content] of repository().files) {
      if (content.includes(prefix)) {
        hits.push(file);
        if (hits.length >= MAX_FILES_PER_PATH) break;
      }
    }
    cache.set(prefix, hits);
    return hits;
  };

  return {
    filesFor(footprint) {
      const files = new Set<string>();
      const entries = [
        ...footprint.endpoints.map((endpoint) => ({
          key: normalizePath(endpoint),
          method: methodOf(endpoint),
        })),
        ...footprint.urls.map((url) => ({ key: normalizePath(url), method: undefined })),
      ];
      for (const { key, method } of entries) {
        const candidates = [key, `${key}/`, ...(method ? [`${method} ${key}`] : [])];
        for (const rule of options.rules) {
          if (candidates.some((candidate) => matchesAnyGlob(candidate, [rule.match]))) {
            for (const file of rule.files) files.add(file);
          }
        }
        const prefix = searchablePrefix(key);
        if (prefix) for (const file of searchFiles(prefix)) files.add(file);
        if (files.size >= MAX_FILES_TOTAL) break;
      }
      return [...files].sort().slice(0, MAX_FILES_TOTAL);
    },
  };
}
