import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { type AgentTool, defineTool, fail, ok } from '../agents/tools.js';
import { resolveInside } from '../util/fs.js';
import { truncate } from '../util/text.js';

/** Directories that never contain anything the inspector should read. */
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
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
  '.idea',
  '.vscode',
  '.mutationworkflow',
  'test-results',
  'playwright-report',
]);

/**
 * Files that usually hold credentials. They are hidden from listing, reading and searching so
 * secrets never travel to a model provider, whatever the repository's .gitignore says.
 */
const SECRET_FILE_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /^(credentials|secrets?)(\..+)?$/i,
  /^\.npmrc$/,
  /^\.netrc$/,
  /^\.(aws|azure|gcloud)$/,
];

const MAX_FILE_BYTES = 64 * 1024;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 400;
const MAX_SEARCH_RESULTS = 200;

export function isSecretFile(name: string): boolean {
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function isIgnored(name: string, extra: ReadonlySet<string>): boolean {
  return IGNORED_DIRECTORIES.has(name) || extra.has(name);
}

/** Plain directory names listed in the project's .gitignore (patterns are left to the defaults). */
function gitignoredNames(rootDir: string): Set<string> {
  const names = new Set<string>();
  const path = join(rootDir, '.gitignore');
  if (!existsSync(path)) return names;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim().replace(/\/$/, '');
    if (!line || line.startsWith('#') || line.startsWith('!') || /[*?[\]]/.test(line)) continue;
    names.add(line.replace(/^\//, ''));
  }
  return names;
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 1024);
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
  }
  return sample.length > 0 && suspicious / sample.length > 0.1;
}

interface Entry {
  path: string;
  relative: string;
  isDirectory: boolean;
  size: number;
}

/** Walk the tree without following symbolic links, so nothing outside the root is reached. */
function* walk(
  rootDir: string,
  dir: string,
  ignored: ReadonlySet<string>,
  maxDepth: number,
  depth = 0,
): Generator<Entry> {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(dir, name);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(path);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) continue;
    const rel = relative(rootDir, path).split(sep).join('/');
    if (stats.isDirectory()) {
      if (isIgnored(name, ignored)) continue;
      yield { path, relative: rel, isDirectory: true, size: 0 };
      if (depth + 1 < maxDepth) yield* walk(rootDir, path, ignored, maxDepth, depth + 1);
    } else if (stats.isFile() && !isSecretFile(name)) {
      yield { path, relative: rel, isDirectory: false, size: stats.size };
    }
  }
}

/** Resolve a user-supplied path to a real file inside the root, refusing symlink escapes. */
function resolveFile(
  rootDir: string,
  path: string,
): { ok: true; file: string } | { ok: false; reason: string } {
  let candidate: string;
  try {
    candidate = resolveInside(rootDir, path);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  if (!existsSync(candidate)) return { ok: false, reason: `No such path: ${path}` };
  const real = realpathSync(candidate);
  const realRoot = realpathSync(rootDir);
  if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) {
    return { ok: false, reason: `Path "${path}" resolves outside the project` };
  }
  if (isSecretFile(basename(real)))
    return { ok: false, reason: `Path "${path}" looks like a credentials file` };
  return { ok: true, file: real };
}

/**
 * Read-only tools the inspector uses to understand a repository: list, read and search, with
 * generated and vendored directories hidden, credential files excluded, symbolic links ignored
 * and sizes capped so a large repository cannot flood the context. Nothing here executes code
 * or writes files.
 */
export function repositoryTools(rootDir: string): AgentTool[] {
  const ignored = gitignoredNames(rootDir);

  const listFiles = defineTool({
    name: 'list_files',
    description:
      'List files and directories under a path (relative to the project root), skipping generated and vendored directories. Directories end with "/". Use depth to go deeper.',
    schema: z.object({
      path: z.string().default('.').describe('Directory relative to the project root'),
      depth: z.number().int().min(1).max(6).default(2),
    }),
    execute: async ({ path, depth }) => {
      const resolved = resolveFile(rootDir, path);
      if (!resolved.ok) return fail(resolved.reason);
      if (!statSync(resolved.file).isDirectory()) return fail(`Not a directory: ${path}`);
      const lines: string[] = [];
      let total = 0;
      for (const entry of walk(rootDir, resolved.file, ignored, depth)) {
        total += 1;
        if (lines.length < MAX_LIST_ENTRIES) {
          lines.push(
            entry.isDirectory ? `${entry.relative}/` : `${entry.relative} (${entry.size} B)`,
          );
        }
      }
      if (total > lines.length)
        lines.push(`… ${total - lines.length} more entries; narrow the path`);
      return ok(lines.length > 0 ? lines.join('\n') : '(empty)');
    },
  });

  const readFile = defineTool({
    name: 'read_file',
    description: `Read a text file (relative to the project root). Large files are truncated at ${MAX_FILE_BYTES} bytes; use offset to read further.`,
    schema: z.object({
      path: z.string(),
      offset: z.number().int().min(0).default(0).describe('Byte offset to start from'),
    }),
    execute: async ({ path, offset }) => {
      const resolved = resolveFile(rootDir, path);
      if (!resolved.ok) return fail(resolved.reason);
      if (!statSync(resolved.file).isFile()) return fail(`Not a file: ${path}`);
      const buffer = readFileSync(resolved.file);
      if (looksBinary(buffer)) return fail(`${path} looks binary (${buffer.length} bytes)`);
      const slice = buffer.subarray(offset, offset + MAX_FILE_BYTES).toString('utf8');
      const rest = Math.max(0, buffer.length - offset - MAX_FILE_BYTES);
      return ok(
        rest > 0 ? `${slice}\n… ${rest} more bytes (offset ${offset + MAX_FILE_BYTES})` : slice,
      );
    },
  });

  const search = defineTool({
    name: 'search',
    description:
      'Search file contents with a regular expression (case-insensitive). Returns "path:line: text" matches. Optionally restrict to files whose path contains a substring (e.g. "test" or ".tsx").',
    schema: z.object({
      pattern: z.string().min(1),
      pathContains: z.string().optional(),
      maxResults: z.number().int().min(1).max(MAX_SEARCH_RESULTS).default(60),
    }),
    execute: async ({ pattern, pathContains, maxResults }) => {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, 'i');
      } catch (error) {
        return fail(`Invalid regular expression: ${(error as Error).message}`);
      }
      const results: string[] = [];
      let scanned = 0;
      for (const entry of walk(rootDir, resolve(rootDir), ignored, 12)) {
        if (entry.isDirectory || entry.size > MAX_SEARCH_FILE_BYTES) continue;
        if (pathContains && !entry.relative.includes(pathContains)) continue;
        const buffer = readFileSync(entry.path);
        if (looksBinary(buffer)) continue;
        scanned += 1;
        const lines = buffer.toString('utf8').split('\n');
        for (const [index, line] of lines.entries()) {
          if (regex.test(line)) {
            results.push(`${entry.relative}:${index + 1}: ${truncate(line.trim(), 200)}`);
            if (results.length >= maxResults) break;
          }
        }
        if (results.length >= maxResults) break;
      }
      const header = `${results.length} match(es) in ${scanned} file(s)${results.length >= maxResults ? ' (limit reached; refine the pattern)' : ''}`;
      return ok([header, ...results].join('\n'));
    },
  });

  return [listFiles, readFile, search];
}
