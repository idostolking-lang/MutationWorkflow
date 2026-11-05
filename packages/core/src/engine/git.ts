import { execFile } from 'node:child_process';

export interface GitContext {
  commit?: string;
  branch?: string;
}

/** Best-effort commit and branch of the project, so runs can be tied to code versions. */
export async function getGitContext(rootDir: string): Promise<GitContext> {
  const [commit, branch] = await Promise.all([
    git(rootDir, ['rev-parse', 'HEAD']),
    git(rootDir, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ]);
  return {
    ...(commit ? { commit } : {}),
    ...(branch && branch !== 'HEAD' ? { branch } : {}),
  };
}

/** Trimmed stdout of a git command, or undefined when git fails or prints nothing. */
function git(cwd: string, args: string[]): Promise<string | undefined> {
  return gitRaw(cwd, args).then((output) => output?.trim() || undefined);
}

/** Stdout of a git command verbatim, or undefined when git fails (empty output is a result). */
function gitRaw(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 5_000 }, (error, stdout) => {
      resolve(error ? undefined : stdout);
    });
  });
}

/**
 * Files changed in a git range such as `abc123..HEAD` or `HEAD~1..HEAD`, relative to the
 * project root and limited to it (a project may live in a subdirectory of its repository).
 * Returns undefined when git cannot answer (not a repository, unknown ref).
 */
export async function changedFiles(rootDir: string, range: string): Promise<string[] | undefined> {
  const output = await gitRaw(rootDir, ['diff', '--name-only', '--relative', range]);
  if (output === undefined) return undefined;
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
