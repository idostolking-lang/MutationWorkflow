import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWorkflow,
  Engine,
  openSqliteStore,
  parseConfig,
  resolveConfig,
  silentLogger,
} from '../src/index.js';

/**
 * The whole deterministic pipeline against the example todo app in a real browser: seed two
 * base workflows that pass, derive mutations, replay everything, and expect the three planted
 * sequence bugs to surface as findings. No model is involved.
 */
const rootDir = fileURLToPath(new URL('../../..', import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

const addButton = { role: 'button', name: 'Add', exact: true };

describe('engine against todo-web', () => {
  let dir: string;
  let engine: Engine;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mw-e2e-'));
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const config = parseConfig({
      version: 1,
      project: { name: 'todo-web-e2e' },
      targets: [
        {
          id: 'todo',
          kind: 'web',
          options: { baseUrl },
          environment: {
            start: {
              command: 'node server.js',
              cwd: 'examples/todo-web',
              env: { PORT: String(port) },
              ready: { url: `${baseUrl}/api/health`, status: 200, timeoutMs: 30_000 },
            },
            reset: {
              command: `node -e "fetch('${baseUrl}/api/reset',{method:'POST'}).then((r)=>process.exit(r.ok?0:1))"`,
            },
          },
          invariants: [
            {
              id: 'health',
              description: 'health endpoint answers',
              check: { type: 'http', url: '/api/health', status: 200 },
            },
          ],
        },
      ],
      mutations: {
        operators: ['repeat-step', 'reorder-steps', 'interrupt'],
        maxVariantsPerWorkflow: 30,
      },
      execution: {
        resetBetweenRuns: true,
        stepTimeoutMs: 5_000,
        assertionTimeoutMs: 1_500,
        screenshots: 'on-failure',
      },
      evidenceDir: join(dir, 'evidence'),
      reportsDir: join(dir, 'reports'),
    });
    engine = await Engine.create({
      config: resolveConfig(config, rootDir),
      store: openSqliteStore(':memory:'),
      adapters: { web: () => import('../../adapter-web/src/index.js') },
      providers: new Map(),
      logger: silentLogger,
    });
  });

  afterAll(async () => {
    await engine?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds the planted sequence bugs through mutation', async () => {
    const add = createWorkflow(
      'todo',
      {
        title: 'Add a todo',
        intent: 'Add "Buy milk" to the list',
        steps: [
          { action: { type: 'navigate', url: '/' } },
          { action: { type: 'fill', target: { label: 'New todo' }, value: 'Buy milk' } },
          { action: { type: 'click', target: addButton } },
        ],
        expect: [
          {
            type: 'element-count',
            target: { text: 'Buy milk', exact: true },
            count: 1,
            description: 'exactly one "Buy milk"',
          },
        ],
      },
      { origin: 'imported-test' },
    );
    const editDelete = createWorkflow(
      'todo',
      {
        title: 'Edit and delete a todo',
        intent: 'Open a todo for editing, save it, then delete it',
        steps: [
          { action: { type: 'navigate', url: '/' } },
          { action: { type: 'fill', target: { label: 'New todo' }, value: 'Walk dog' } },
          { action: { type: 'click', target: addButton } },
          { action: { type: 'click', target: { role: 'button', name: 'Edit Walk dog' } } },
          { action: { type: 'click', target: { role: 'button', name: 'Save' } } },
          { action: { type: 'click', target: { role: 'button', name: 'Delete Walk dog' } } },
        ],
        expect: [
          {
            type: 'element-count',
            target: { text: 'Walk dog', exact: true },
            count: 0,
            description: '"Walk dog" is gone',
          },
        ],
      },
      { origin: 'imported-test' },
    );
    await engine.store.workflows.insert(add);
    await engine.store.workflows.insert(editDelete);

    const mutated = await engine.mutate('todo');
    expect(mutated.fromOperators).toBeGreaterThanOrEqual(10);

    const summary = await engine.run({ trigger: 'manual' });
    const byWorkflow = new Map(summary.runs.map((run) => [run.workflowId, run]));
    expect(byWorkflow.get(add.id)?.status).toBe('passed');
    expect(byWorkflow.get(editDelete.id)?.status).toBe('passed');

    const titled = (title: string) => mutated.created.find((w) => w.title === title);
    const repeatAdd = titled('Add a todo (repeat step 3)');
    expect(repeatAdd).toBeDefined();
    const doubleSubmit = summary.findings.find(
      (f) => f.detectedBy === 'assertions' && f.workflowIds.includes(repeatAdd?.id ?? ''),
    );
    expect(doubleSubmit, 'double submit should fail the count expectation').toBeDefined();
    expect(doubleSubmit?.summary).toContain('matches 2 element');

    const serverError = summary.findings.find(
      (f) => f.detectedBy === 'app-error' && /http-error.*500/.test(f.title),
    );
    expect(serverError, 'delete-then-save should produce a 500').toBeDefined();
    expect(serverError?.severity).toBe('high');
    const swapped = titled('Edit and delete a todo (swap steps 5 and 6)');
    expect(serverError?.workflowIds).toContain(swapped?.id);

    const crash = summary.findings.find(
      (f) => f.detectedBy === 'app-error' && /uncaught-exception.*TypeError/.test(f.title),
    );
    expect(crash, 'reload mid-edit then save should throw in the page').toBeDefined();
    expect(
      crash?.workflowIds.some(
        (id) => mutated.created.find((w) => w.id === id)?.mutation?.operator === 'interrupt',
      ),
    ).toBe(true);

    const failedRun = summary.runs.find((run) => run.workflowId === swapped?.id);
    const evidence = await engine.store.evidence.listForRun(failedRun?.id ?? '');
    const screenshot = evidence.find((e) => e.kind === 'screenshot');
    expect(screenshot?.path && existsSync(join(engine.evidenceRoot, screenshot.path))).toBe(true);

    expect(summary.reportPath && existsSync(summary.reportPath)).toBe(true);
    const report = readFileSync(summary.reportPath ?? '', 'utf8');
    expect(report).toContain('## Findings');
    expect(report).toContain('swap steps 5 and 6');

    const status = await engine.status();
    expect(status.targets[0]?.findings.open).toBe(summary.findings.length);
    expect(status.targets[0]?.runs.total).toBe(summary.runs.length);
  }, 300_000);
});
