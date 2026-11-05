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

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 2_000 }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim() || undefined);
    });
  });
}
