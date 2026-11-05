import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changedFiles, getGitContext } from './git.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
}

describe('git helpers', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mw-git-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists the files changed in a range and the current commit', async () => {
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'first');
    const first = git(dir, 'rev-parse', 'HEAD');
    writeFileSync(join(dir, 'b.txt'), 'b\n');
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'second');

    expect(await changedFiles(dir, `${first}..HEAD`)).toEqual(['a.txt', 'b.txt']);
    expect(await changedFiles(dir, 'HEAD~1..HEAD')).toEqual(['a.txt', 'b.txt']);
    expect(await changedFiles(dir, 'HEAD..HEAD')).toEqual([]);
    expect(await changedFiles(dir, 'no-such-ref..HEAD')).toBeUndefined();
    expect(await getGitContext(dir)).toEqual({
      commit: git(dir, 'rev-parse', 'HEAD'),
      branch: 'main',
    });
  });

  it('answers undefined outside a repository', async () => {
    expect(await changedFiles(dir, 'HEAD~1..HEAD')).toBeUndefined();
    expect(await getGitContext(dir)).toEqual({});
  });
});
