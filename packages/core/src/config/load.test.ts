import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MutationWorkflowError } from '../util/errors.js';
import {
  findConfigFile,
  interpolateEnv,
  loadConfig,
  parseConfig,
  writeConfigFile,
} from './load.js';

describe('config loading', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mw-config-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('interpolates environment variables with fallbacks and fails on missing ones', () => {
    const env = { TOKEN: 'abc', PORT: '4000' };
    expect(
      interpolateEnv({ a: 'x-${TOKEN}', nested: ['${PORT}', { b: '${NOPE:-default}' }] }, env),
    ).toEqual({
      a: 'x-abc',
      nested: ['4000', { b: 'default' }],
    });
    expect(interpolateEnv(42, env)).toBe(42);
    expect(() => interpolateEnv('${MISSING}', env)).toThrow(MutationWorkflowError);
    expect(() => interpolateEnv('${MISSING}', env)).toThrow(/MISSING/);
  });

  it('rejects duplicate target ids and reports invalid fields readably', () => {
    const base = { version: 1, project: { name: 'p' } };
    expect(() =>
      parseConfig({
        ...base,
        targets: [
          { id: 'a', kind: 'web' },
          { id: 'a', kind: 'cli' },
        ],
      }),
    ).toThrow(/duplicate target id "a"/);
    expect(() => parseConfig({ ...base, targets: [{ id: 'Bad Id', kind: 'web' }] })).toThrow(
      /lowercase/,
    );
    expect(() => parseConfig({ ...base, agents: { maxParallel: 0 } })).toThrow(/maxParallel/);
  });

  it('writes a YAML config and loads it back with resolved paths', () => {
    const path = join(dir, 'mutationworkflow.config.yaml');
    writeConfigFile(path, {
      version: 1,
      project: { name: 'demo' },
      targets: [{ id: 'web', kind: 'web', options: { baseUrl: 'http://127.0.0.1:4173' } }],
      store: { path: 'state/mw.db' },
    });
    expect(findConfigFile(dir)).toBe(path);
    const resolved = loadConfig({ cwd: dir });
    expect(resolved.path).toBe(path);
    expect(resolved.rootDir).toBe(dir);
    expect(resolved.config.project.name).toBe('demo');
    expect(resolved.config.targets[0]?.options).toEqual({ baseUrl: 'http://127.0.0.1:4173' });
    expect(resolved.config.agents.maxParallel).toBe(3);
    expect(resolved.resolvePath(resolved.config.store.path)).toBe(join(dir, 'state/mw.db'));
    expect(resolved.resolvePath('/absolute/path.db')).toBe('/absolute/path.db');
  });

  it('loads JSON configs, interpolates variables, and explains a missing config', () => {
    writeFileSync(
      join(dir, 'mutationworkflow.config.json'),
      JSON.stringify({ version: 1, project: { name: '${MW_TEST_NAME:-json-demo}' }, targets: [] }),
    );
    expect(loadConfig({ cwd: dir }).config.project.name).toBe('json-demo');
    const empty = mkdtempSync(join(tmpdir(), 'mw-empty-'));
    try {
      expect(() => loadConfig({ cwd: empty })).toThrow(/No MutationWorkflow config found/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('refuses to write an invalid config', () => {
    const path = join(dir, 'bad.yaml');
    expect(() => writeConfigFile(path, { version: 1, project: { name: '' }, targets: [] })).toThrow(
      /invalid/,
    );
    expect(findConfigFile(dir)).toBeUndefined();
  });
});
