import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@mutationworkflow/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../cli.js';
import { plain } from '../format.js';
import type { Output } from '../output.js';
import { buildInitConfig, initProject } from './init.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mw-init-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function captureOutput() {
  const lines = { out: [] as string[], err: [] as string[] };
  const output: Output = {
    out: (text) => lines.out.push(text),
    json: (value) => lines.out.push(JSON.stringify(value)),
    err: (text) => lines.err.push(text),
    colors: plain,
  };
  return { output, lines };
}

describe('init', () => {
  it('writes a valid, commented web config', () => {
    const path = initProject(dir, {
      name: 'shop',
      baseUrl: 'http://127.0.0.1:4173',
      command: 'npm run dev',
    });
    const { config } = loadConfig({ cwd: dir });
    expect(config.project.name).toBe('shop');
    expect(config.targets).toHaveLength(1);
    expect(config.targets[0]).toMatchObject({
      id: 'web',
      kind: 'web',
      options: { baseUrl: 'http://127.0.0.1:4173' },
      environment: { start: { command: 'npm run dev', ready: { url: 'http://127.0.0.1:4173' } } },
    });
    expect(readFileSync(path, 'utf8')).toContain('# schedule:');
  });

  it('refuses to overwrite an existing config', () => {
    initProject(dir);
    expect(() => initProject(dir)).toThrow(/already exists/);
  });

  it('requires a command for cli targets', () => {
    expect(() => buildInitConfig(dir, { kind: 'cli' })).toThrow(/--command/);
    expect(buildInitConfig(dir, { kind: 'cli', command: 'node cli.js' }).targets).toEqual([
      { id: 'cli', kind: 'cli', options: { command: 'node cli.js', shell: true } },
    ]);
  });

  it('runs through the CLI with exit codes', async () => {
    const { output, lines } = captureOutput();
    const argv = ['node', 'mw', '--cwd', dir, '--quiet'];
    const run = (...args: string[]) => main([...argv, ...args], { output, handleSignals: false });

    expect(await run('findings')).toBe(3);
    expect(lines.err.join('\n')).toContain('mw init');
    expect(await run('init', '--kind', 'cli', '--command', 'node cli.js')).toBe(0);
    expect(lines.out.join('\n')).toContain('mutationworkflow.config.yaml');
    expect(await run('init')).toBe(1);
    expect(await run('findings', '--json')).toBe(0);
    expect(lines.out.at(-1)).toBe('[]');
  });
});
