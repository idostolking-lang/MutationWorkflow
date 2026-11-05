import { describe, expect, it } from 'vitest';
import { createWorkflow, nowIso, type Workflow } from '../schema/index.js';
import { openSqliteStore } from '../store/sqlite.js';
import { impactOnTarget, isSharedFile, selectForChange, touches } from './impact.js';

function workflow(title: string, files: string[] | undefined, parentId?: string): Workflow {
  const created = createWorkflow(
    'app',
    { title, intent: title, steps: [{ action: { type: 'go', page: title } }] },
    { origin: parentId ? 'mutation' : 'seed', parentId },
  );
  return files
    ? { ...created, touches: { urls: ['/'], endpoints: [], files, updatedAt: nowIso() } }
    : created;
}

describe('shared files and touch matching', () => {
  it('recognises manifests, lockfiles and global config as shared', () => {
    for (const file of [
      'package.json',
      'apps/web/package.json',
      'pnpm-lock.yaml',
      'requirements.txt',
      'go.mod',
      'tsconfig.base.json',
      'Dockerfile',
      'prisma/schema.prisma',
      'db/migrations/0001_init.sql',
    ]) {
      expect(isSharedFile(file), file).toBe(true);
    }
    for (const file of ['src/app.ts', 'README.md', 'package.json.bak', 'docs/package.jsonx']) {
      expect(isSharedFile(file), file).toBe(false);
    }
  });

  it('matches exact files, directories and globs', () => {
    expect(touches(['src/todos.js'], 'src/todos.js')).toBe(true);
    expect(touches(['src/todos'], 'src/todos/index.js')).toBe(true);
    expect(touches(['src/todos'], 'src/todos-archive/index.js')).toBe(false);
    expect(touches(['src/**/*.css'], 'src/pages/home/style.css')).toBe(true);
    expect(touches(['src/*.js'], 'src/pages/home.js')).toBe(false);
  });
});

describe('impact on a target', () => {
  it('sorts base workflows into impacted, unaffected and unknown, and picks their variants', async () => {
    const store = openSqliteStore(':memory:');
    await store.init();
    const checkout = workflow('Checkout', ['src/checkout/**', 'src/api/orders.ts']);
    const profile = workflow('Profile', ['src/profile.ts']);
    const fresh = workflow('Never run', undefined);
    const variant = workflow('Checkout twice', undefined, checkout.id);
    for (const w of [checkout, profile, fresh, variant]) await store.workflows.insert(w);

    const impact = await impactOnTarget(store, 'app', ['src/api/orders.ts', 'docs/guide.md']);
    expect(impact.impacted.map((w) => w.id)).toEqual([checkout.id]);
    expect(impact.unaffected.map((w) => w.id)).toEqual([profile.id]);
    expect(impact.unknown.map((w) => w.id)).toEqual([fresh.id]);
    expect(impact.sharedChange).toBe(false);

    const ids = await selectForChange(store, impact);
    expect(ids?.sort()).toEqual([checkout.id, variant.id, fresh.id].sort());

    const shared = await impactOnTarget(store, 'app', ['package.json']);
    expect(shared.sharedChange).toBe(true);
    expect(await selectForChange(store, shared)).toBeUndefined();

    const nothingKnown = await impactOnTarget(store, 'other', ['src/x.ts']);
    expect(await selectForChange(store, nothingKnown)).toBeUndefined();

    const docsOnly = await impactOnTarget(store, 'app', ['docs/guide.md']);
    expect(docsOnly.impacted).toEqual([]);
    expect((await selectForChange(store, docsOnly))?.sort()).toEqual([fresh.id]);
    await store.close();
  });
});
