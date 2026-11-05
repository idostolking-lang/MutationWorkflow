import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type {
  Action,
  Adapter,
  AdapterDescription,
  AdapterSession,
  Assertion,
  Signal,
} from '../index.js';
import {
  createWorkflow,
  Engine,
  FakeProvider,
  fakeText,
  fakeToolCall,
  type ModelProvider,
  newId,
  nowIso,
  openSqliteStore,
  parseConfig,
  resolveConfig,
  silentLogger,
} from '../index.js';

/**
 * A deterministic stand-in for a real application: a list the user adds items to. It has the
 * same kind of sequence bug the example apps have (adding twice duplicates) and a control that
 * crashes, so the whole pipeline can be exercised without a browser or a model.
 */
const description: AdapterDescription = {
  kind: 'fake',
  summary: 'In-memory list application',
  actions: [
    { type: 'go', description: 'Open the app', schema: { type: 'object' } },
    { type: 'type', description: 'Type a value', schema: { type: 'object' } },
    { type: 'do', description: 'Press a control: add, remove, crash', schema: { type: 'object' } },
    { type: 'refresh', description: 'Reload, clearing the draft', schema: { type: 'object' } },
    { type: 'wait', description: 'Wait', schema: { type: 'object' } },
  ],
  assertions: [
    { type: 'count', description: 'Number of items', schema: { type: 'object' } },
    { type: 'has', description: 'An item with a value exists', schema: { type: 'object' } },
  ],
  hints: {
    anchorActionTypes: ['go'],
    inputActions: [{ type: 'type', field: 'value' }],
    interruptSequences: [[{ type: 'refresh' }]],
    waitAction: { type: 'wait', field: 'ms' },
  },
  guide: 'Start with go.',
};

const ACTION_TYPES = new Set(description.actions.map((a) => a.type));

class FakeSession implements AdapterSession {
  items: string[] = [];
  draft = '';
  opened = false;
  private signals: Signal[] = [];

  async perform(action: Action) {
    const type = action.type;
    if (type === 'go') {
      this.opened = true;
      return { status: 'ok' as const, evidence: [] };
    }
    if (!this.opened) return { status: 'blocked' as const, message: 'app not open', evidence: [] };
    if (type === 'type') {
      this.draft = String(action['value'] ?? '');
      return { status: 'ok' as const, evidence: [] };
    }
    if (type === 'refresh') {
      this.draft = '';
      return { status: 'ok' as const, evidence: [] };
    }
    if (type === 'wait') return { status: 'ok' as const, evidence: [] };
    if (type === 'do') {
      const name = action['name'];
      if (name === 'add') {
        if (!this.draft)
          return { status: 'blocked' as const, message: 'nothing to add', evidence: [] };
        this.items.push(this.draft);
        return { status: 'ok' as const, evidence: [] };
      }
      if (name === 'remove') {
        if (this.items.length === 0)
          return { status: 'blocked' as const, message: 'nothing to remove', evidence: [] };
        this.items.pop();
        return { status: 'ok' as const, evidence: [] };
      }
      if (name === 'crash') {
        this.signals.push({
          kind: 'uncaught-exception',
          message: 'TypeError: cannot read properties of null',
          signature: 'uncaught-exception TypeError: cannot read properties of null',
          at: nowIso(),
        });
        return { status: 'ok' as const, evidence: [] };
      }
      return { status: 'blocked' as const, message: `no control "${String(name)}"`, evidence: [] };
    }
    return { status: 'error' as const, message: `unknown action ${type}`, evidence: [] };
  }

  async check(assertion: Assertion) {
    if (assertion.type === 'count') {
      const expected = Number(assertion['n']);
      return { passed: this.items.length === expected, message: `found ${this.items.length}` };
    }
    if (assertion.type === 'has') {
      return { passed: this.items.includes(String(assertion['value'])) };
    }
    return { passed: false, message: `unknown assertion ${assertion.type}` };
  }

  async observe() {
    return { summary: `items: [${this.items.join(', ')}] draft: "${this.draft}"` };
  }

  drainSignals() {
    const out = this.signals;
    this.signals = [];
    return out;
  }

  async capture() {
    return undefined;
  }

  async close() {}
}

const fakeAdapter: Adapter = {
  kind: 'fake',
  describe: () => description,
  validateAction: (action) => {
    if (!ACTION_TYPES.has(action.type)) throw new Error(`unknown action type ${action.type}`);
    return action;
  },
  validateAssertion: (assertion) => assertion,
  open: async () => new FakeSession(),
  dispose: async () => {},
};

const fakeAdapterModule = { createAdapter: () => fakeAdapter, describe: () => description };

const baseSteps = [
  { action: { type: 'go' } },
  { action: { type: 'type', value: 'Milk' }, note: 'enter an item' },
  { action: { type: 'do', name: 'add' }, note: 'add it' },
];

describe('Engine', () => {
  let dir: string;
  let engines: Engine[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mw-engine-'));
    engines = [];
  });

  afterEach(async () => {
    for (const engine of engines) await engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function createEngine(
    options: {
      providers?: Map<string, ModelProvider>;
      targets?: unknown[];
      withConfigPath?: boolean;
    } = {},
  ) {
    const config = parseConfig({
      version: 1,
      project: { name: 'fake-project' },
      targets: options.targets ?? [
        {
          id: 'app',
          kind: 'fake',
          invariants: [
            {
              id: 'never-more-than-three',
              description: 'at most three items',
              check: { type: 'count-max', n: 3 },
            },
          ],
        },
      ],
      mutations: { maxVariantsPerWorkflow: 40 },
      execution: { screenshots: 'never' },
      schedule: { continuous: { idleMs: 0 } },
      agents: { defaults: { model: 'fake-model' } },
    });
    const engine = await Engine.create({
      config: resolveConfig(
        config,
        dir,
        options.withConfigPath ? join(dir, 'mutationworkflow.config.yaml') : undefined,
      ),
      store: openSqliteStore(':memory:'),
      adapters: { fake: async () => fakeAdapterModule },
      providers: options.providers ?? new Map(),
      logger: silentLogger,
    });
    engines.push(engine);
    return engine;
  }

  async function seedBase(engine: Engine) {
    const workflow = createWorkflow(
      'app',
      {
        title: 'Add an item',
        intent: 'Add Milk to the list',
        steps: baseSteps,
        expect: [{ type: 'count', n: 1, description: 'exactly one item' }],
      },
      { origin: 'seed' },
    );
    await engine.store.workflows.insert(workflow);
    return workflow;
  }

  it('replays a base workflow without findings and reports the run', async () => {
    const engine = await createEngine({ targets: [{ id: 'app', kind: 'fake' }] });
    await seedBase(engine);
    const summary = await engine.run({ trigger: 'manual' });
    expect(summary.stats).toMatchObject({ total: 1, passed: 1 });
    expect(summary.findings).toEqual([]);
    expect(summary.reportPath && existsSync(summary.reportPath)).toBe(true);
    expect(readFileSync(summary.reportPath ?? '', 'utf8')).toContain('Add an item');
    const status = await engine.status();
    expect(status.targets[0]?.workflows).toEqual({ base: 1, mutations: 0, pendingReview: 0 });
    expect(status.targets[0]?.runs.passed).toBe(1);
    expect(status.agents.enabled).toBe(false);
  });

  it('finds the double-submit bug through mutation and marks blocked mutations as graceful', async () => {
    const engine = await createEngine({ targets: [{ id: 'app', kind: 'fake' }] });
    const base = await seedBase(engine);
    const mutated = await engine.mutate('app');
    expect(mutated.fromOperators).toBeGreaterThan(3);
    const titles = mutated.created.map((w) => w.title);
    expect(titles).toContain('Add an item (repeat step 3)');
    expect(titles).toContain('Add an item (skip step 2)');

    const summary = await engine.run({ trigger: 'manual', include: 'mutations' });
    const repeat = summary.runs.find((r) =>
      mutated.created.find((w) => w.id === r.workflowId)?.title.includes('repeat step 3'),
    );
    expect(repeat?.status).toBe('failed');
    const doubleSubmit = summary.findings.find(
      (f) => f.detectedBy === 'assertions' && f.workflowIds.includes(repeat?.workflowId ?? ''),
    );
    expect(doubleSubmit).toBeDefined();
    expect(doubleSubmit?.triage.state).toBe('skipped');
    expect(doubleSubmit?.reproduction?.mutation?.operator).toBe('repeat-step');
    expect(doubleSubmit?.reproduction?.steps).toHaveLength(4);

    const skipType = summary.runs.find((r) =>
      mutated.created.find((w) => w.id === r.workflowId)?.title.includes('skip step 2'),
    );
    expect(skipType?.status).toBe('blocked');
    expect(summary.findings.some((f) => f.workflowIds.includes(skipType?.workflowId ?? ''))).toBe(
      false,
    );

    const again = await engine.run({ trigger: 'manual', include: 'mutations', report: false });
    const merged = again.findings.find((f) => f.fingerprint === doubleSubmit?.fingerprint);
    expect(merged?.occurrences).toBe(2);
    expect(await engine.store.findings.count({ targetId: 'app' })).toBe(summary.findings.length);
    expect((await engine.store.workflows.list({ parentId: base.id })).length).toBe(
      mutated.created.length,
    );
  });

  it('turns application error signals into app-error findings grouped across workflows', async () => {
    const engine = await createEngine({ targets: [{ id: 'app', kind: 'fake' }] });
    for (const [title, value] of [
      ['Crash from the list', 'Milk'],
      ['Crash after adding', 'Eggs'],
    ] as const) {
      await engine.store.workflows.insert(
        createWorkflow(
          'app',
          {
            title,
            intent: 'press the crashing control',
            steps: [
              { action: { type: 'go' } },
              { action: { type: 'type', value } },
              { action: { type: 'do', name: 'add' } },
              { action: { type: 'do', name: 'crash' } },
            ],
          },
          { origin: 'manual' },
        ),
      );
    }
    const summary = await engine.run({ trigger: 'push' });
    expect(summary.stats.failed).toBe(2);
    const crash = summary.findings.filter((f) => f.detectedBy === 'app-error');
    expect(crash).toHaveLength(1);
    expect(crash[0]?.severity).toBe('high');
    expect(crash[0]?.workflowIds).toHaveLength(2);
    expect(crash[0]?.occurrences).toBe(2);
    expect(summary.runs[0]?.trigger).toBe('push');
  });

  it('answers questions: confirm activates, dismiss archives, bug records a finding', async () => {
    const engine = await createEngine({ targets: [{ id: 'app', kind: 'fake' }] });
    const makePending = async (title: string) => {
      const workflow = createWorkflow(
        'app',
        {
          title,
          intent: 'x',
          steps: [{ action: { type: 'go' } }, { action: { type: 'type', value: title } }],
        },
        { origin: 'discovered', status: 'pending-review' },
      );
      await engine.store.workflows.insert(workflow);
      const question = {
        id: newId('q'),
        targetId: 'app',
        kind: 'expected-behavior' as const,
        question: `Is ${title} right?`,
        context: { workflowId: workflow.id, evidenceIds: [] },
        status: 'open' as const,
        createdAt: nowIso(),
      };
      await engine.store.questions.insert(question);
      return { workflow, question };
    };
    const a = await makePending('A');
    const b = await makePending('B');
    const c = await makePending('C');

    expect((await engine.answerQuestion(a.question.id, 'confirm')).workflow?.status).toBe('active');
    expect((await engine.answerQuestion(b.question.id, 'dismiss')).workflow?.status).toBe(
      'archived',
    );
    const bug = await engine.answerQuestion(c.question.id, 'bug', 'The item appears twice');
    expect(bug.finding).toMatchObject({
      status: 'confirmed',
      detectedBy: 'human',
      severity: 'medium',
    });
    expect(bug.finding?.summary).toBe('The item appears twice');
    expect((await engine.store.questions.get(c.question.id))?.status).toBe('answered');
    expect((await engine.status()).openQuestions).toBe(0);
    await expect(engine.answerQuestion('q_missing', 'confirm')).rejects.toThrow(/No question/);
  });

  it('triages pending findings with the triager agent', async () => {
    const provider = new FakeProvider((request) => {
      const task = request.messages[0]?.content[0];
      const ids = [
        ...(task?.type === 'text' ? task.text : '').matchAll(/# Finding (fnd_\w+)/g),
      ].map((m) => m[1]);
      return fakeToolCall({
        name: 'finish',
        input: {
          result: {
            decisions: ids.map((findingId, index) => ({
              findingId,
              verdict: index === 0 ? 'bug' : 'not-a-bug',
              title:
                index === 0
                  ? 'Submitting twice creates duplicate items'
                  : 'Expected consequence of the mutation',
              summary: 'Add once, add again: two identical items appear.',
              severity: 'high',
              rationale:
                index === 0
                  ? 'Duplicates are never intended'
                  : 'The skipped step made the expectation inapplicable',
            })),
          },
        },
      });
    });
    const engine = await createEngine({
      providers: new Map([['fake', provider]]),
      targets: [{ id: 'app', kind: 'fake' }],
    });
    await seedBase(engine);
    await engine.mutate('app', { operators: ['repeat-step', 'data-fuzz'] });
    const summary = await engine.run({ trigger: 'manual', include: 'mutations' });
    const triaged = summary.findings.filter((f) => f.triage.state === 'done');
    expect(triaged.length).toBeGreaterThan(0);
    expect(
      triaged.some(
        (f) => f.title === 'Submitting twice creates duplicate items' && f.status === 'open',
      ),
    ).toBe(true);
    expect(
      triaged
        .filter((f) => f.triage.verdict === 'not-a-bug')
        .every((f) => f.status === 'dismissed'),
    ).toBe(true);
    expect(provider.requests[0]?.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['get_evidence', 'get_run', 'get_workflow', 'finish']),
    );
    expect((await engine.status()).agents).toMatchObject({ enabled: true, providers: ['fake'] });
    const usage = await engine.store.usage.totals();
    expect(usage.calls).toBeGreaterThan(0);
  });

  it('explores with an explorer agent and records pending workflows with questions', async () => {
    const script = [
      fakeToolCall({ name: 'observe', input: {} }),
      fakeToolCall({ name: 'act', input: { action: { type: 'go' }, note: 'open the app' } }),
      fakeToolCall({ name: 'act', input: { action: { type: 'type', value: 'Eggs' } } }),
      fakeToolCall({ name: 'act', input: { action: { type: 'do', name: 'add' } } }),
      fakeToolCall({ name: 'check', input: { assertion: { type: 'has', value: 'Eggs' } } }),
      fakeToolCall({
        name: 'save_workflow',
        input: {
          title: 'Add eggs',
          intent: 'Add an item',
          expect: [{ type: 'has', value: 'Eggs', description: 'Eggs is listed' }],
        },
      }),
      fakeToolCall({ name: 'reset', input: {} }),
      fakeToolCall({
        name: 'finish',
        input: {
          result: {
            summary: 'Explored adding.',
            savedWorkflowTitles: ['Add eggs'],
            suspicious: [],
          },
        },
      }),
    ];
    const provider = new FakeProvider((_request, call) => script[call] ?? fakeText('done'));
    const engine = await createEngine({
      providers: new Map([['fake', provider]]),
      targets: [{ id: 'app', kind: 'fake' }],
    });
    const result = await engine.explore('app', { explorers: 1, maxWorkflows: 3 });
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]).toMatchObject({
      title: 'Add eggs',
      origin: 'discovered',
      status: 'pending-review',
    });
    expect(result.workflows[0]?.steps.map((s) => s.action.type)).toEqual(['go', 'type', 'do']);
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]?.question).toContain('Eggs is listed');
    expect(result.summaries[0]?.summary).toBe('Explored adding.');
    const toolResults = provider.requests[5]?.messages
      .at(-1)
      ?.content.find((p) => p.type === 'tool_result');
    expect(JSON.stringify(toolResults)).toContain('PASSED');
    await expect(engine.explore('nope')).rejects.toThrow(/Unknown target/);
  });

  it('sets up a project from an inspection report', async () => {
    const provider = new FakeProvider((request) => {
      const isDelegate = request.messages[0]?.content.some(
        (p) => p.type === 'text' && p.text.startsWith('look at'),
      );
      if (isDelegate) return fakeText('nothing of note');
      return fakeToolCall({
        name: 'finish',
        input: {
          result: {
            summary: 'A tiny list app.',
            stack: ['node'],
            targets: [{ id: 'list', kind: 'fake', description: 'the list app' }],
            features: [{ name: 'List', description: 'Add items', entryPoints: ['/'] }],
            existingTests: [
              { file: 'test/list.test.js', framework: 'vitest', scenarios: ['adds an item'] },
            ],
            workflows: [
              {
                targetId: 'list',
                title: 'Add item (from test)',
                intent: 'Add an item',
                steps: baseSteps,
                source: { file: 'test/list.test.js', name: 'adds an item' },
              },
              {
                targetId: 'list',
                title: 'Remove item',
                intent: 'Remove an item',
                steps: [...baseSteps, { action: { type: 'do', name: 'remove' } }],
              },
              { targetId: 'missing', title: 'Dropped', intent: 'x', steps: baseSteps },
            ],
            risks: ['double submit'],
            questions: ['Is there a staging database?'],
          },
        },
      });
    });
    const engine = await createEngine({ providers: new Map([['fake', provider]]), targets: [] });
    const result = await engine.setup({ validate: false });
    expect(result.configAction).toBe('created');
    expect(existsSync(result.configPath)).toBe(true);
    expect(readFileSync(result.configPath, 'utf8')).toContain('id: list');
    expect(result.workflows.map((w) => [w.title, w.origin, w.status])).toEqual([
      ['Add item (from test)', 'imported-test', 'active'],
      ['Remove item', 'seed', 'pending-review'],
    ]);
    expect(result.questions.map((q) => q.kind)).toEqual(['setup', 'expected-behavior']);
    expect(provider.requests[0]?.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['list_files', 'read_file', 'search', 'delegate', 'finish']),
    );
    expect(provider.requests[0]?.system).toContain('In-memory list application');
  });

  it('refuses agent operations without a provider and reports unknown oracles and targets', async () => {
    const engine = await createEngine({ targets: [{ id: 'app', kind: 'fake' }] });
    await expect(engine.setup()).rejects.toThrow(/needs a model provider/);
    await expect(engine.triage()).rejects.toThrow(/needs a model provider/);
    expect(() => engine.target('ghost')).toThrow(/Unknown target "ghost"/);
    const schema = z.object({ enabled: z.array(z.string()) });
    expect(schema.parse(engine.config.oracles).enabled).toEqual([
      'step-failure',
      'app-error',
      'assertions',
      'invariants',
    ]);
  });

  it('runs continuous cycles until the cycle limit', async () => {
    const engine = await createEngine({ targets: [{ id: 'app', kind: 'fake' }] });
    await seedBase(engine);
    const cycles: number[] = [];
    const controller = new AbortController();
    const result = await engine.watch({
      signal: controller.signal,
      maxCycles: 2,
      onCycle: (n) => cycles.push(n),
    });
    expect(result.cycles).toBe(2);
    expect(cycles).toEqual([1, 2]);
    expect((await engine.store.runs.stats({ targetId: 'app' })).total).toBeGreaterThan(2);
  });
});
