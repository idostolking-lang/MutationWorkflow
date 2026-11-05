import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type Adapter,
  type AdapterSession,
  createLogger,
  EvidenceSink,
  type Signal,
} from '@mutationworkflow/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdapter } from '../src/index.js';

const SERVER = resolve(import.meta.dirname, '../../../examples/todo-web/server.js');

let server: ChildProcess;
let baseUrl: string;
let adapter: Adapter;
let session: AdapterSession;
let evidenceRoot: string;
const signals: Signal[] = [];

/** Collect the signals emitted since the last call, keeping a log of all of them. */
function drain(): Signal[] {
  const drained = session.drainSignals();
  signals.push(...drained);
  return drained;
}

beforeAll(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });
  await waitForHealth(`${baseUrl}/api/health`);

  evidenceRoot = mkdtempSync(join(tmpdir(), 'mw-web-e2e-'));
  adapter = createAdapter({
    target: {
      id: 'todo',
      kind: 'web',
      options: { baseUrl },
      environment: {},
      identities: [],
      invariants: [],
      scope: { allowUrls: [], denyUrls: [], denyText: [] },
    },
    rootDir: evidenceRoot,
    logger: createLogger({ level: 'silent' }),
  });
  session = await adapter.open({
    sessionId: 'ses_e2e',
    evidence: new EvidenceSink({ rootDir: evidenceRoot, sessionDir: 'sessions/e2e' }),
    screenshots: 'on-failure',
    stepTimeoutMs: 2_000,
    scope: { allowUrls: [], denyUrls: [], denyText: ['delete everything'] },
    logger: createLogger({ level: 'silent' }),
  });
});

afterAll(async () => {
  await session?.close();
  await adapter?.dispose();
  server?.kill();
  if (evidenceRoot) rmSync(evidenceRoot, { recursive: true, force: true });
});

const addButton = { role: 'button', name: 'Add', exact: true };
const milkItems = { text: 'Buy milk', exact: true };

describe('web adapter against examples/todo-web', () => {
  it('runs the normal add flow', async () => {
    expect(await session.perform({ type: 'navigate', url: '/' }, { stepId: 's1' })).toMatchObject({
      status: 'ok',
      evidence: [],
    });
    expect(await session.check({ type: 'title-matches', pattern: 'Todos' })).toMatchObject({
      passed: true,
    });
    const fill = { type: 'fill', target: { label: 'New todo' }, value: 'Buy milk' };
    expect((await session.perform(fill, { stepId: 's2' })).status).toBe('ok');
    expect((await session.perform({ type: 'click', target: addButton })).status).toBe('ok');
    expect(
      await session.check({ type: 'element-count', target: milkItems, count: 1 }),
    ).toMatchObject({ passed: true });
    expect(await session.check({ type: 'http', url: '/api/health', status: 200 })).toMatchObject({
      passed: true,
    });
    expect(drain()).toEqual([]);
  });

  it('observes the page as an aria snapshot', async () => {
    const observation = await session.observe();
    expect(observation.url).toBe(`${baseUrl}/`);
    expect(observation.title).toBe('Todos');
    expect(observation.summary).toContain('button "Add"');
    expect(observation.summary).toContain('Buy milk');
    expect(observation.screenshot?.kind).toBe('screenshot');
  });

  it('exposes bug (a): a repeated Add creates a duplicate', async () => {
    expect((await session.perform({ type: 'click', target: addButton })).status).toBe('ok');
    expect(
      await session.check({ type: 'element-count', target: milkItems, count: 2 }),
    ).toMatchObject({ passed: true });
  });

  it('exposes bug (b): saving an edit of a deleted todo returns HTTP 500', async () => {
    const edit = { role: 'button', name: 'Edit Buy milk', nth: 0 };
    const remove = { role: 'button', name: 'Delete Buy milk', nth: 0 };
    expect((await session.perform({ type: 'click', target: edit })).status).toBe('ok');
    expect((await session.perform({ type: 'click', target: remove })).status).toBe('ok');
    const save = await session.perform(
      { type: 'click', target: { role: 'button', name: 'Save' } },
      { stepId: 'save' },
    );
    expect(save.status).toBe('ok');
    const drained = drain();
    expect(drained).toContainEqual(
      expect.objectContaining({
        kind: 'http-error',
        stepId: 'save',
        details: expect.objectContaining({ status: 500, method: 'PATCH' }),
      }),
    );
    expect(drained.some((s) => s.kind === 'console-error')).toBe(true);
  });

  it('exposes bug (c): Save after a reload throws in the page', async () => {
    expect((await session.perform({ type: 'reload' })).status).toBe('ok');
    await session.perform({ type: 'click', target: { role: 'button', name: 'Save' } });
    expect(drain()).toContainEqual(
      expect.objectContaining({
        kind: 'uncaught-exception',
        message: expect.stringContaining('TypeError'),
      }),
    );
  });

  it('blocks navigation out of scope', async () => {
    const outcome = await session.perform({ type: 'navigate', url: 'https://example.com/' });
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toMatch(/outside scope/);
    expect(await session.check({ type: 'url-matches', pattern: '/' })).toMatchObject({
      passed: true,
    });
  });

  it('blocks a missing element and saves a screenshot', async () => {
    const outcome = await session.perform(
      { type: 'click', target: { role: 'button', name: 'Does not exist' } },
      { stepId: 'missing', index: 9 },
    );
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toMatch(/not found or not actionable/);
    const screenshot = outcome.evidence.find((e) => e.kind === 'screenshot');
    expect(screenshot?.path).toBeDefined();
    expect(existsSync(join(evidenceRoot, screenshot?.path ?? ''))).toBe(true);
    expect(outcome.evidence.find((e) => e.kind === 'console')?.text).toBeTruthy();
  });

  it('blocks controls matching scope.denyText', async () => {
    const fill = { type: 'fill', target: { label: 'New todo' }, value: 'Everything' };
    expect((await session.perform(fill)).status).toBe('ok');
    expect((await session.perform({ type: 'click', target: addButton })).status).toBe('ok');
    const outcome = await session.perform({
      type: 'click',
      target: { role: 'button', name: 'Delete Everything' },
    });
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toMatch(/denyText/);
    expect(await session.check({ type: 'text-visible', text: 'Everything' })).toMatchObject({
      passed: true,
    });
  });

  it('fails assertions without throwing', async () => {
    const result = await session.check({ type: 'text-visible', text: 'Nonexistent text' });
    expect(result.passed).toBe(false);
    expect(await session.check({ type: 'http', url: '/missing' })).toMatchObject({ passed: false });
  });

  it('captures the DOM', async () => {
    const dom = await session.capture('dom', 'final');
    expect(dom?.kind).toBe('dom');
    expect(existsSync(join(evidenceRoot, dom?.path ?? ''))).toBe(true);
  });
});

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`${url} did not become healthy within ${timeoutMs} ms`);
}
