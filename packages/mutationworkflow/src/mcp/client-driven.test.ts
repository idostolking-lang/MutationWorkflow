import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  type Action,
  type Adapter,
  type AdapterDescription,
  type AdapterSession,
  type Assertion,
  createWorkflow,
  Engine,
  FindingSchema,
  newId,
  nowIso,
  openSqliteStore,
  parseConfig,
  resolveConfig,
  silentLogger,
} from '@mutationworkflow/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpServer } from './server.js';

/** A small in-memory list app: go opens it, type sets a draft, do add appends the draft. */
const description: AdapterDescription = {
  kind: 'fake',
  summary: 'In-memory list application',
  actions: [
    { type: 'go', description: 'Open the app', schema: { type: 'object' } },
    { type: 'type', description: 'Type a value', schema: { type: 'object' } },
    { type: 'do', description: 'Press a control: add, remove', schema: { type: 'object' } },
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

  async perform(action: Action) {
    if (action.type === 'go') {
      this.opened = true;
      return { status: 'ok' as const, evidence: [] };
    }
    if (!this.opened) return { status: 'blocked' as const, message: 'app not open', evidence: [] };
    if (action.type === 'type') {
      this.draft = String(action['value'] ?? '');
      return { status: 'ok' as const, evidence: [] };
    }
    if (action.type === 'refresh') {
      this.draft = '';
      return { status: 'ok' as const, evidence: [] };
    }
    if (action.type === 'wait') return { status: 'ok' as const, evidence: [] };
    if (action.type === 'do' && action['name'] === 'add' && this.draft) {
      this.items.push(this.draft);
      return { status: 'ok' as const, evidence: [] };
    }
    if (action.type === 'do' && action['name'] === 'remove' && this.items.length > 0) {
      this.items.pop();
      return { status: 'ok' as const, evidence: [] };
    }
    return { status: 'blocked' as const, message: 'not possible now', evidence: [] };
  }

  async check(assertion: Assertion) {
    if (assertion.type === 'count') {
      return {
        passed: this.items.length === Number(assertion['n']),
        message: `found ${this.items.length}`,
      };
    }
    if (assertion.type === 'has')
      return { passed: this.items.includes(String(assertion['value'])) };
    return { passed: false, message: `unknown assertion ${assertion.type}` };
  }

  async observe() {
    return { summary: `items: [${this.items.join(', ')}] draft: "${this.draft}"` };
  }

  drainSignals() {
    return [];
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

const baseSteps = [
  { action: { type: 'go' } },
  { action: { type: 'type', value: 'Milk' } },
  { action: { type: 'do', name: 'add' } },
];

let dir: string;
let engine: Engine;
let client: Client;

async function connect(targets: unknown[]): Promise<void> {
  const config = parseConfig({
    version: 1,
    project: { name: 'fake-project' },
    targets,
    execution: { screenshots: 'never' },
  });
  engine = await Engine.create({
    config: resolveConfig(config, dir),
    store: openSqliteStore(':memory:'),
    providers: new Map(),
    logger: silentLogger,
    adapters: {
      fake: async () => ({ createAdapter: () => fakeAdapter, describe: () => description }),
    },
  });
  const server = createMcpServer(engine);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mw-mcp-client-'));
});

afterEach(async () => {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function text(result: CallToolResult): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

/** The compact JSON that follows the summary. */
function json(result: CallToolResult): unknown {
  const body = text(result);
  return JSON.parse(body.slice(body.lastIndexOf('\n\n') + 2));
}

const report = {
  summary: 'A tiny list app.',
  stack: ['node'],
  targets: [{ id: 'list', kind: 'fake', description: 'the list app' }],
  features: [{ name: 'List', description: 'Add items', entryPoints: ['/'] }],
  existingTests: [],
  workflows: [{ targetId: 'list', title: 'Add an item', intent: 'Add Milk', steps: baseSteps }],
  risks: ['double submit'],
  questions: ['Is there a staging database?'],
};

describe('client-driven setup', () => {
  beforeEach(() => connect([]));

  it('returns the inspector brief with the report schema', async () => {
    const result = await call('mw_inspect_brief', { projectName: 'demo' });
    expect(result.isError).toBeFalsy();
    const body = text(result);
    expect(body).toContain('mw_inspect_apply');
    expect(body).toContain('You are the inspector agent');
    expect(body).toContain('Report JSON schema');
    expect(body).toContain('"existingTests"');
    expect(body).toContain('In-memory list application');
  });

  it('applies a report: writes the config and seeds workflows', async () => {
    const result = await call('mw_inspect_apply', { report });
    expect(result.isError).toBeFalsy();
    const configPath = join(dir, 'mutationworkflow.config.yaml');
    expect(existsSync(configPath)).toBe(true);
    expect(readFileSync(configPath, 'utf8')).toContain('id: list');
    expect(json(result)).toMatchObject({
      configAction: 'created',
      configPath,
      workflows: [expect.objectContaining({ title: 'Add an item', status: 'pending-review' })],
    });
    expect(engine.targets().map((t) => t.id)).toEqual(['list']);

    const invalid = await call('mw_inspect_apply', { report: { summary: 'missing fields' } });
    expect(invalid.isError).toBe(true);
    expect(text(invalid)).toContain('The inspection report is invalid');
  });
});

describe('client-driven exploration, triage and mutation', () => {
  beforeEach(() => connect([{ id: 'app', kind: 'fake' }]));

  it('explores through a session and closes it', async () => {
    const open = await call('mw_explore_open', { target: 'app', maxWorkflows: 2 });
    expect(open.isError).toBeFalsy();
    const opened = text(open);
    expect(opened).toContain('You are an explorer agent');
    expect(opened).toContain('items: [] draft: ""');
    const sessionId = /"sessionId":"(ses_[^"]+)"/.exec(opened)?.[1] ?? '';
    expect(sessionId).not.toBe('');
    expect(opened).toContain('"remainingBudget":2');

    const again = await call('mw_explore_open', { target: 'app' });
    expect(again.isError).toBe(true);
    expect(text(again)).toContain('already open');

    expect(text(await call('mw_act', { sessionId, action: { type: 'go' } }))).toContain(
      'recorded as step 1',
    );
    await call('mw_act', { sessionId, action: { type: 'type', value: 'Eggs' } });
    const added = await call('mw_act', { sessionId, action: { type: 'do', name: 'add' } });
    expect(text(added)).toContain('items: [Eggs]');
    const blocked = await call('mw_act', { sessionId, action: { type: 'teleport' } });
    expect(blocked.isError).toBe(true);

    const check = await call('mw_check', { sessionId, assertion: { type: 'has', value: 'Eggs' } });
    expect(text(check)).toContain('PASSED');

    const saved = await call('mw_save_workflow', {
      sessionId,
      title: 'Add eggs',
      intent: 'Add an item',
      expect: [{ type: 'has', value: 'Eggs', description: 'Eggs is listed' }],
    });
    expect(saved.isError).toBeFalsy();
    expect(text(saved)).toContain('Remaining budget: 1');
    expect(text(await call('mw_list_known_workflows', { sessionId }))).toContain('Add eggs');
    expect(text(await call('mw_reset_session', { sessionId }))).toContain('Fresh session');

    const closed = await call('mw_explore_close', { sessionId, summary: 'Explored adding.' });
    expect(closed.isError).toBeFalsy();
    expect(json(closed)).toMatchObject({
      workflows: [expect.objectContaining({ title: 'Add eggs', status: 'pending-review' })],
      questions: [expect.objectContaining({ question: expect.stringContaining('Eggs is listed') })],
    });

    const gone = await call('mw_observe', { sessionId });
    expect(gone.isError).toBe(true);
    expect(text(gone)).toContain(`No open exploration session ${sessionId}`);
    expect(
      (await call('mw_act', { sessionId: 'ses_unknown', action: { type: 'go' } })).isError,
    ).toBe(true);
  });

  it('triages pending findings', async () => {
    const empty = await call('mw_triage_brief');
    expect(empty.isError).toBeFalsy();
    expect(text(empty)).toContain('Nothing pending');

    const now = nowIso();
    const finding = FindingSchema.parse({
      id: newId('fnd'),
      targetId: 'app',
      fingerprint: 'fp-1',
      title: 'Assertion failed',
      summary: 'count was 2, expected 1',
      severity: 'medium',
      detectedBy: 'assertions',
      status: 'open',
      triage: { state: 'pending' },
      occurrences: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    });
    await engine.store.findings.insert(finding);

    const brief = await call('mw_triage_brief', { target: 'app' });
    expect(brief.isError).toBeFalsy();
    expect(text(brief)).toContain(finding.id);
    expect(text(brief)).toContain('Decision JSON schema');

    const applied = await call('mw_triage_apply', {
      decisions: [
        {
          findingId: finding.id,
          verdict: 'not-a-bug',
          title: 'Skipped add leaves the list empty',
          summary: 'The mutation removed the add step.',
          severity: 'low',
          rationale: 'Expected given the mutation.',
        },
      ],
    });
    expect(applied.isError).toBeFalsy();
    expect(json(applied)).toEqual([
      expect.objectContaining({ id: finding.id, status: 'dismissed' }),
    ]);
    const detail = await call('mw_finding', { id: finding.id });
    expect(text(detail)).toContain('Skipped add leaves the list empty');
    expect((await engine.store.findings.get(finding.id))?.triage).toMatchObject({
      verdict: 'not-a-bug',
      model: 'mcp-client',
    });

    const bad = await call('mw_triage_apply', { decisions: [{ findingId: 'fnd_missing' }] });
    expect(bad.isError).toBe(true);
  });

  it('applies mutation variants proposed by the client', async () => {
    const base = createWorkflow(
      'app',
      { title: 'Add an item', intent: 'Add Milk', steps: baseSteps },
      { origin: 'seed', status: 'active' },
    );
    await engine.store.workflows.insert(base);

    const brief = await call('mw_mutation_brief', { workflowId: base.id });
    expect(brief.isError).toBeFalsy();
    expect(text(brief)).toContain('You are the mutator agent');
    expect(text(brief)).toContain('Variants JSON schema');

    const applied = await call('mw_mutation_apply', {
      workflowId: base.id,
      variants: [
        {
          titleSuffix: 'double add',
          description: 'Press add twice; could duplicate the item',
          steps: [...baseSteps, { action: { type: 'do', name: 'add' } }],
        },
      ],
    });
    expect(applied.isError).toBeFalsy();
    expect(json(applied)).toEqual([
      expect.objectContaining({ title: 'Add an item (double add)', origin: 'mutation' }),
    ]);
    const [variant] = await engine.store.workflows.list({ parentId: base.id });
    expect(variant?.mutation).toMatchObject({ operator: 'agent' });
  });

  it('points job tools without a provider at the client-driven tools', async () => {
    const explore = await call('mw_explore', {});
    expect(explore.isError).toBe(true);
    expect(text(explore)).toContain('call mw_explore_open');
    expect(text(await call('mw_setup', {}))).toContain('call mw_inspect_brief');
    expect(text(await call('mw_triage', {}))).toContain('call mw_triage_brief');
    expect(text(await call('mw_mutate', { agent: true }))).toContain('call mw_mutation_brief');
    expect(text(await call('mw_status'))).toContain('mw_explore_open');
  });

  it('offers the four prompts', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['explore', 'mutate', 'setup', 'triage']);
    const explore = await client.getPrompt({ name: 'explore', arguments: { target: 'app' } });
    const [message] = explore.messages;
    expect(message?.content.type === 'text' ? message.content.text : '').toContain(
      'mw_explore_open {"target":"app"}',
    );
  });
});
