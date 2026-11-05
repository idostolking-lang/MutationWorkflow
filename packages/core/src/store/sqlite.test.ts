import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWorkflow,
  type Evidence,
  type Finding,
  type Job,
  newId,
  type Question,
  type Run,
  type RunStatus,
  TargetConfigSchema,
  type Workflow,
  type WorkflowDraft,
} from '../schema/index.js';
import { MIGRATIONS } from './migrations.js';
import { openSqliteStore, SqliteStore } from './sqlite.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
/** Deterministic timestamps, `minutes` after a fixed origin. */
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

function workflow(
  draft: Partial<WorkflowDraft> = {},
  options: Partial<
    Pick<Workflow, 'origin' | 'status' | 'parentId' | 'createdAt' | 'targetId'>
  > = {},
): Workflow {
  const created = createWorkflow(
    options.targetId ?? 'shop',
    {
      title: 'Add item to cart',
      intent: 'Buy a product',
      steps: [
        { action: { type: 'navigate', url: '/products' }, note: 'Open the catalogue' },
        { action: { type: 'click', selector: '#add-to-cart' }, note: 'Put the mug in the basket' },
      ],
      ...draft,
    },
    { origin: options.origin ?? 'seed', status: options.status, parentId: options.parentId },
  );
  const createdAt = options.createdAt ?? created.createdAt;
  return { ...created, createdAt, updatedAt: createdAt };
}

function run(
  workflowId: string,
  status: RunStatus,
  minutes: number,
  extra: Partial<Run> = {},
): Run {
  return {
    id: newId('run'),
    workflowId,
    targetId: 'shop',
    trigger: 'manual',
    status,
    startedAt: at(minutes),
    finishedAt: at(minutes + 1),
    durationMs: 60_000,
    steps: [],
    assertions: [],
    signals: [],
    oracles: [],
    evidenceIds: [],
    context: { mutated: false },
    touched: { urls: [], endpoints: [] },
    ...extra,
  };
}

function finding(extra: Partial<Finding> = {}): Finding {
  return {
    id: newId('fnd'),
    targetId: 'shop',
    fingerprint: newId('fnd'),
    title: 'Checkout crashes after reload',
    summary: 'A TypeError is thrown when the payment form is reloaded',
    severity: 'high',
    detectedBy: 'app-error',
    status: 'open',
    triage: { state: 'pending' },
    workflowIds: [],
    runIds: [],
    evidenceIds: [],
    occurrences: 1,
    firstSeenAt: at(0),
    lastSeenAt: at(0),
    ...extra,
  };
}

function evidence(runId: string | undefined, minutes: number): Evidence {
  return { id: newId('ev'), runId, kind: 'console', text: 'log line', createdAt: at(minutes) };
}

function question(extra: Partial<Question> = {}): Question {
  return {
    id: newId('q'),
    targetId: 'shop',
    kind: 'expected-behavior',
    question: 'Should an empty cart allow checkout?',
    context: { evidenceIds: [] },
    status: 'open',
    createdAt: at(0),
    ...extra,
  };
}

function job(extra: Partial<Job> = {}): Job {
  return {
    id: newId('job'),
    kind: 'run',
    status: 'queued',
    params: {},
    createdAt: at(0),
    ...extra,
  };
}

let store: SqliteStore;

beforeEach(async () => {
  store = new SqliteStore(':memory:');
  await store.init();
});

afterEach(async () => {
  await store.close();
});

describe('init', () => {
  it('records the schema version and is idempotent', async () => {
    expect(await store.meta.get('schema_version')).toBe(String(MIGRATIONS.length));
    await store.init();
    await store.init();
    expect(await store.meta.get('schema_version')).toBe(String(MIGRATIONS.length));
  });

  it('creates the parent directory of a database file and persists across opens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mw-store-'));
    try {
      const path = join(dir, 'nested', 'mw.db');
      const first = openSqliteStore(path);
      await first.init();
      const wf = workflow();
      await first.workflows.insert(wf);
      await first.close();

      const second = openSqliteStore(path);
      await second.init();
      expect(await second.workflows.get(wf.id)).toEqual(wf);
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a database from a newer version', async () => {
    await store.meta.set('schema_version', String(MIGRATIONS.length + 1));
    await expect(store.init()).rejects.toThrow(/newer/);
  });
});

describe('targets', () => {
  it('upserts, gets and lists', async () => {
    const web = TargetConfigSchema.parse({ id: 'web', kind: 'web', options: { baseUrl: 'x' } });
    const cli = TargetConfigSchema.parse({ id: 'cli', kind: 'cli' });
    await store.targets.upsert(web);
    await store.targets.upsert(cli);
    await store.targets.upsert({ ...web, name: 'Web shop' });
    expect(await store.targets.get('web')).toEqual({ ...web, name: 'Web shop' });
    expect(await store.targets.get('missing')).toBeUndefined();
    expect((await store.targets.list()).map((t) => t.id)).toEqual(['cli', 'web']);
  });
});

describe('workflows', () => {
  it('inserts and reads back by id and fingerprint', async () => {
    const wf = workflow();
    await store.workflows.insert(wf);
    expect(await store.workflows.get(wf.id)).toEqual(wf);
    expect(await store.workflows.getByFingerprint('shop', wf.fingerprint)).toEqual(wf);
    expect(await store.workflows.getByFingerprint('other', wf.fingerprint)).toBeUndefined();
    expect(await store.workflows.get('missing')).toBeUndefined();
  });

  it('rejects a duplicate fingerprint on the same target', async () => {
    await store.workflows.insert(workflow());
    await expect(store.workflows.insert(workflow({ title: 'Same actions' }))).rejects.toThrow();
  });

  it('lists in creation order with every filter', async () => {
    const base = workflow({ tags: ['cart'] }, { createdAt: at(2) });
    const discovered = workflow(
      { title: 'Search', steps: [{ action: { type: 'navigate', url: '/search' } }] },
      { origin: 'discovered', status: 'pending-review', createdAt: at(1) },
    );
    const variant = workflow(
      { title: 'Variant', steps: [{ action: { type: 'navigate', url: '/v' } }] },
      { origin: 'mutation', parentId: base.id, status: 'archived', createdAt: at(3) },
    );
    const otherTarget = workflow({}, { targetId: 'admin', createdAt: at(0) });
    for (const wf of [base, discovered, variant, otherTarget]) await store.workflows.insert(wf);

    const ids = async (filter: Parameters<typeof store.workflows.list>[0]) =>
      (await store.workflows.list(filter)).map((wf) => wf.id);

    expect(await ids({})).toEqual([otherTarget.id, discovered.id, base.id, variant.id]);
    expect(await ids({ targetId: 'shop' })).toEqual([discovered.id, base.id, variant.id]);
    expect(await ids({ ids: [variant.id, base.id] })).toEqual([base.id, variant.id]);
    expect(await ids({ ids: [] })).toEqual([]);
    expect(await ids({ origin: 'discovered' })).toEqual([discovered.id]);
    expect(await ids({ origin: ['discovered', 'mutation'] })).toEqual([discovered.id, variant.id]);
    expect(await ids({ status: 'archived' })).toEqual([variant.id]);
    expect(await ids({ status: ['active', 'pending-review'], targetId: 'shop' })).toEqual([
      discovered.id,
      base.id,
    ]);
    expect(await ids({ parentId: base.id })).toEqual([variant.id]);
    expect(await ids({ parentId: null, targetId: 'shop' })).toEqual([discovered.id, base.id]);
    expect(await ids({ tag: 'cart' })).toEqual([base.id]);
    expect(await ids({ limit: 2 })).toEqual([otherTarget.id, discovered.id]);
    expect(await ids({ limit: 2, offset: 1 })).toEqual([discovered.id, base.id]);
    expect(await ids({ offset: 3 })).toEqual([variant.id]);

    expect(await store.workflows.count()).toBe(4);
    expect(await store.workflows.count({ targetId: 'shop', parentId: null })).toBe(2);
    expect(await store.workflows.count({ limit: 1 })).toBe(4);
  });

  it('updates the record, indexed columns and search index', async () => {
    const wf = workflow();
    await store.workflows.insert(wf);
    const updated: Workflow = { ...wf, title: 'Renamed checkout journey', status: 'archived' };
    await store.workflows.update(updated);

    expect(await store.workflows.get(wf.id)).toEqual(updated);
    expect(await store.workflows.list({ status: 'archived' })).toHaveLength(1);
    expect(await store.workflows.search('journey')).toEqual([updated]);
    expect(await store.workflows.search('Add item')).toEqual([]);
  });

  it('fails to update a workflow that does not exist', async () => {
    await expect(store.workflows.update(workflow())).rejects.toThrow(/No workflows record/);
  });

  it('searches titles, intents, notes and parameters', async () => {
    const cart = workflow();
    const login = workflow(
      {
        title: 'Sign in',
        intent: 'Access the account dashboard',
        steps: [{ action: { type: 'fill', selector: '#email', value: 'ada@example.com' } }],
      },
      { targetId: 'admin' },
    );
    await store.workflows.insert(cart);
    await store.workflows.insert(login);

    expect(await store.workflows.search('cart')).toEqual([cart]);
    expect(await store.workflows.search('dashboard')).toEqual([login]);
    expect(await store.workflows.search('basket')).toEqual([cart]);
    expect(await store.workflows.search('ada@example.com')).toEqual([login]);
    expect(await store.workflows.search('ADD   item')).toEqual([cart]);
    expect(await store.workflows.search('add dashboard')).toEqual([]);
    expect(await store.workflows.search('dashboard', { targetId: 'shop' })).toEqual([]);
    expect(await store.workflows.search('navigate click', { limit: 0 })).toEqual([]);
    expect(await store.workflows.search('   ')).toEqual([]);
  });

  it('never throws on FTS syntax in user queries', async () => {
    await store.workflows.insert(workflow());
    for (const query of ['"', 'cart"', 'a OR', 'NOT', '(', '*', 'title:cart', 'cart AND', '^-+']) {
      await expect(store.workflows.search(query)).resolves.toBeInstanceOf(Array);
    }
    expect(await store.workflows.search('"cart"')).toHaveLength(1);
  });
});

describe('runs', () => {
  it('inserts, lists newest first, and filters', async () => {
    const a = run('wf_a', 'passed', 0);
    const b = run('wf_a', 'failed', 10, { context: { mutated: true, jobId: 'job_1' } });
    const c = run('wf_b', 'error', 5, { targetId: 'admin' });
    for (const r of [a, b, c]) await store.runs.insert(r);

    const ids = async (filter: Parameters<typeof store.runs.list>[0]) =>
      (await store.runs.list(filter)).map((r) => r.id);
    expect(await store.runs.get(b.id)).toEqual(b);
    expect(await ids({})).toEqual([b.id, c.id, a.id]);
    expect(await ids({ workflowId: 'wf_a' })).toEqual([b.id, a.id]);
    expect(await ids({ targetId: 'admin' })).toEqual([c.id]);
    expect(await ids({ status: ['passed', 'error'] })).toEqual([c.id, a.id]);
    expect(await ids({ jobId: 'job_1' })).toEqual([b.id]);
    expect(await ids({ since: at(5) })).toEqual([b.id, c.id]);
    expect(await ids({ limit: 1, offset: 1 })).toEqual([c.id]);
    expect(await store.runs.latestForWorkflow('wf_a')).toEqual(b);
    expect(await store.runs.latestForWorkflow('wf_none')).toBeUndefined();
  });

  it('computes stats', async () => {
    expect(await store.runs.stats()).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      error: 0,
    });
    await store.runs.insert(run('wf_a', 'passed', 0));
    await store.runs.insert(run('wf_a', 'passed', 1));
    await store.runs.insert(run('wf_a', 'blocked', 7, { context: { mutated: true, jobId: 'j' } }));
    await store.runs.insert(run('wf_b', 'failed', 3, { targetId: 'admin' }));

    expect(await store.runs.stats()).toEqual({
      total: 4,
      passed: 2,
      failed: 1,
      blocked: 1,
      error: 0,
      lastRunAt: at(7),
    });
    expect(await store.runs.stats({ targetId: 'admin' })).toMatchObject({ total: 1, failed: 1 });
    expect(await store.runs.stats({ since: at(1) })).toMatchObject({ total: 3, passed: 1 });
    expect(await store.runs.stats({ jobId: 'j' })).toMatchObject({ total: 1, blocked: 1 });
  });
});

describe('evidence', () => {
  it('inserts many and reads them back', async () => {
    const first = evidence('run_1', 2);
    const second = evidence('run_1', 1);
    const loose = { ...evidence(undefined, 0), sessionId: 'ses_1' };
    await store.evidence.insertMany([first, second, loose]);
    await store.evidence.insertMany([]);

    expect(await store.evidence.get(loose.id)).toEqual(loose);
    expect(await store.evidence.getMany([loose.id, 'missing', first.id])).toEqual([loose, first]);
    expect(await store.evidence.getMany([])).toEqual([]);
    expect(await store.evidence.listForRun('run_1')).toEqual([second, first]);
  });

  it('inserts nothing when one item fails', async () => {
    const item = evidence('run_1', 0);
    await expect(store.evidence.insertMany([item, item])).rejects.toThrow();
    expect(await store.evidence.listForRun('run_1')).toEqual([]);
  });
});

describe('findings', () => {
  it('inserts, gets, filters, counts, updates and searches', async () => {
    const crash = finding({ lastSeenAt: at(5) });
    const minor = finding({
      title: 'Typo in footer',
      summary: 'Copyright year is wrong',
      severity: 'low',
      status: 'dismissed',
      triage: { state: 'done', verdict: 'not-a-bug' },
      lastSeenAt: at(9),
    });
    const other = finding({ targetId: 'admin', lastSeenAt: at(1) });
    for (const f of [crash, minor, other]) await store.findings.insert(f);

    const ids = async (filter: Parameters<typeof store.findings.list>[0]) =>
      (await store.findings.list(filter)).map((f) => f.id);
    expect(await store.findings.get(crash.id)).toEqual(crash);
    expect(await store.findings.getByFingerprint('shop', crash.fingerprint)).toEqual(crash);
    expect(await store.findings.getByFingerprint('admin', crash.fingerprint)).toBeUndefined();
    expect(await ids({})).toEqual([minor.id, crash.id, other.id]);
    expect(await ids({ targetId: 'shop' })).toEqual([minor.id, crash.id]);
    expect(await ids({ status: ['open', 'confirmed'] })).toEqual([crash.id, other.id]);
    expect(await ids({ severity: 'low' })).toEqual([minor.id]);
    expect(await ids({ triageState: 'pending' })).toEqual([crash.id, other.id]);
    expect(await ids({ limit: 1, offset: 2 })).toEqual([other.id]);
    expect(await store.findings.count({ targetId: 'shop' })).toBe(2);
    expect(await store.findings.count({ status: 'fixed' })).toBe(0);

    expect(await store.findings.search('reload')).toHaveLength(2);
    expect(await store.findings.search('reload', { targetId: 'admin' })).toEqual([other]);
    expect(await store.findings.search('copyright')).toEqual([minor]);

    const confirmed: Finding = {
      ...crash,
      title: 'Payment form loses state',
      status: 'confirmed',
      occurrences: 2,
      lastSeenAt: at(20),
    };
    await store.findings.update(confirmed);
    expect(await store.findings.get(crash.id)).toEqual(confirmed);
    expect(await ids({})).toEqual([crash.id, minor.id, other.id]);
    expect(await ids({ status: 'confirmed' })).toEqual([crash.id]);
    expect(await store.findings.search('loses state')).toEqual([confirmed]);
    // Prefix matching: "reload" also matches "reloading" in the updated summary.
    expect((await store.findings.search('reload')).map((f) => f.id).sort()).toEqual(
      [confirmed.id, other.id].sort(),
    );
    expect(await store.findings.search('" OR')).toEqual([]);
  });
});

describe('questions', () => {
  it('inserts, updates and lists oldest first', async () => {
    const first = question({ createdAt: at(1) });
    const second = question({ createdAt: at(2), targetId: undefined, kind: 'setup' });
    await store.questions.insert(second);
    await store.questions.insert(first);

    expect(await store.questions.get(first.id)).toEqual(first);
    expect((await store.questions.list()).map((q) => q.id)).toEqual([first.id, second.id]);
    expect((await store.questions.list({ targetId: 'shop' })).map((q) => q.id)).toEqual([first.id]);

    const answered: Question = {
      ...first,
      status: 'answered',
      decision: 'bug',
      answer: 'No, that is a bug',
      answeredAt: at(3),
    };
    await store.questions.update(answered);
    expect(await store.questions.get(first.id)).toEqual(answered);
    expect(await store.questions.list({ status: 'open' })).toEqual([second]);
    expect(await store.questions.list({ status: 'answered', limit: 1 })).toEqual([answered]);
  });
});

describe('jobs', () => {
  it('inserts, updates and lists newest first', async () => {
    const older = job({ createdAt: at(1) });
    const newer = job({ kind: 'explore', createdAt: at(2) });
    await store.jobs.insert(older);
    await store.jobs.insert(newer);

    expect((await store.jobs.list()).map((j) => j.id)).toEqual([newer.id, older.id]);
    expect(await store.jobs.list({ kind: 'run' })).toEqual([older]);

    const running: Job = {
      ...older,
      status: 'running',
      startedAt: at(3),
      progress: { message: 'x' },
    };
    await store.jobs.update(running);
    expect(await store.jobs.get(older.id)).toEqual(running);
    expect(await store.jobs.list({ status: ['running', 'failed'] })).toEqual([running]);
    expect(await store.jobs.list({ status: 'queued', limit: 5, offset: 0 })).toEqual([newer]);
  });
});

describe('usage', () => {
  it('records calls and sums totals', async () => {
    expect(await store.usage.totals()).toEqual({
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    });
    const base = {
      role: 'explorer',
      provider: 'anthropic',
      model: 'claude',
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 50,
      cacheWriteTokens: 5,
    };
    await store.usage.record({ ...base, jobId: 'job_1', costUsd: 0.25, at: at(0) });
    await store.usage.record({ ...base, jobId: 'job_1', at: at(1) });
    await store.usage.record({ ...base, costUsd: 0.5, at: at(2) });

    expect(await store.usage.totals()).toEqual({
      calls: 3,
      inputTokens: 300,
      outputTokens: 30,
      cacheReadTokens: 150,
      cacheWriteTokens: 15,
      costUsd: 0.75,
    });
    expect(await store.usage.totals({ jobId: 'job_1' })).toMatchObject({
      calls: 2,
      inputTokens: 200,
      costUsd: 0.25,
    });
    expect(await store.usage.totals({ since: at(1) })).toMatchObject({ calls: 2, costUsd: 0.5 });
  });
});

describe('meta', () => {
  it('gets and overwrites values', async () => {
    expect(await store.meta.get('cursor')).toBeUndefined();
    await store.meta.set('cursor', 'a');
    await store.meta.set('cursor', 'b');
    expect(await store.meta.get('cursor')).toBe('b');
  });
});
