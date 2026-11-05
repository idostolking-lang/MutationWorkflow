import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  createWorkflow,
  Engine,
  newId,
  nowIso,
  openSqliteStore,
  parseConfig,
  QuestionSchema,
  RunSchema,
  resolveConfig,
  silentLogger,
} from '@mutationworkflow/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_ADAPTERS } from '../engine-factory.js';
import { createMcpServer } from './server.js';

const TOOLS = [
  'mw_status',
  'mw_setup',
  'mw_explore',
  'mw_mutate',
  'mw_run',
  'mw_triage',
  'mw_jobs',
  'mw_job',
  'mw_cancel_job',
  'mw_findings',
  'mw_finding',
  'mw_update_finding',
  'mw_workflows',
  'mw_workflow',
  'mw_questions',
  'mw_answer',
  'mw_search',
  'mw_report',
  'mw_evidence',
  'mw_run_detail',
  'mw_impact',
  'mw_inspect_brief',
  'mw_inspect_apply',
  'mw_explore_open',
  'mw_observe',
  'mw_act',
  'mw_check',
  'mw_save_workflow',
  'mw_reset_session',
  'mw_use_identity',
  'mw_list_known_workflows',
  'mw_explore_close',
  'mw_triage_brief',
  'mw_triage_apply',
  'mw_mutation_brief',
  'mw_mutation_apply',
];

let dir: string;
let engine: Engine;
let client: Client;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mw-mcp-'));
  const config = parseConfig({
    version: 1,
    project: { name: 'demo' },
    targets: [{ id: 'web', kind: 'web', options: { baseUrl: 'http://127.0.0.1:4173' } }],
  });
  engine = await Engine.create({
    config: resolveConfig(config, dir),
    store: openSqliteStore(':memory:'),
    providers: new Map(),
    logger: silentLogger,
    adapters: { ...BUILTIN_ADAPTERS },
  });
  const server = createMcpServer(engine);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
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

async function insertWorkflow(
  status: 'active' | 'pending-review' = 'active',
  touches?: { urls: string[]; endpoints: string[]; files: string[] },
  button = 'Add',
) {
  const created = createWorkflow(
    'web',
    {
      title: 'Add a todo',
      intent: 'Add an item to the list',
      steps: [
        { action: { type: 'navigate', url: '/' } },
        { action: { type: 'click', target: { role: 'button', name: button } } },
      ],
    },
    { origin: 'discovered', status },
  );
  const workflow = touches ? { ...created, touches: { ...touches, updatedAt: nowIso() } } : created;
  await engine.store.workflows.insert(workflow);
  return workflow;
}

const TODO_TOUCHES = {
  urls: ['/'],
  endpoints: ['POST /api/todos'],
  files: ['server.js', 'src/todos/**'],
};

describe('MCP server', () => {
  it('lists every tool with annotations', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOLS].sort());
    const status = tools.find((tool) => tool.name === 'mw_status');
    expect(status?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const run = tools.find((tool) => tool.name === 'mw_run');
    expect(run?.annotations?.readOnlyHint).toBe(false);
    expect(run?.inputSchema.properties).toHaveProperty('wait');
  });

  it('reports status', async () => {
    const result = await call('mw_status');
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('demo');
    expect(json(result)).toMatchObject({ targets: [{ id: 'web', kind: 'web' }] });
  });

  it('lists and shows workflows', async () => {
    const workflow = await insertWorkflow();
    const list = await call('mw_workflows', { target: 'web' });
    expect(text(list)).toContain('Add a todo');
    expect(json(list)).toEqual([expect.objectContaining({ id: workflow.id, steps: 2 })]);
    expect(json(await call('mw_workflows', { base: false }))).toEqual([]);

    const detail = await call('mw_workflow', { id: workflow.id });
    expect(text(detail)).toContain('1. navigate url="/"');
  });

  it('answers questions and activates the workflow', async () => {
    const workflow = await insertWorkflow('pending-review');
    const question = QuestionSchema.parse({
      id: newId('q'),
      targetId: 'web',
      kind: 'expected-behavior',
      question: 'Is adding an empty todo intended?',
      context: { workflowId: workflow.id },
      status: 'open',
      createdAt: nowIso(),
    });
    await engine.store.questions.insert(question);

    const open = await call('mw_questions');
    expect(text(open)).toContain(question.id);

    const answer = await call('mw_answer', {
      id: question.id,
      decision: 'confirm',
      answer: 'Yes',
    });
    expect(answer.isError).toBeFalsy();
    expect(text(answer)).toContain('is now active');
    expect((await engine.store.workflows.get(workflow.id))?.status).toBe('active');
    expect(json(await call('mw_questions'))).toEqual([]);
  });

  it('returns text evidence', async () => {
    const id = newId('ev');
    await engine.store.evidence.insertMany([
      { id, kind: 'console', text: 'TypeError: boom', createdAt: nowIso() },
    ]);
    const result = await call('mw_evidence', { id });
    expect(text(result)).toContain('TypeError: boom');
  });

  it('shows a run record', async () => {
    const workflow = await insertWorkflow();
    const run = RunSchema.parse({
      id: newId('run'),
      workflowId: workflow.id,
      targetId: 'web',
      trigger: 'mcp',
      status: 'failed',
      startedAt: nowIso(),
      finishedAt: nowIso(),
      durationMs: 50,
      steps: [{ stepId: 's1', index: 0, status: 'failed', durationMs: 50, message: 'no button' }],
      oracles: [{ oracle: 'step-failure', verdict: 'fail' }],
      context: {},
    });
    await engine.store.runs.insert(run);
    const result = await call('mw_run_detail', { id: run.id });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('1. s1 failed: no button');
    expect(text(result)).toContain('step-failure fail');
    expect(json(result)).toMatchObject({ id: run.id, status: 'failed' });
    const missing = await call('mw_run_detail', { id: 'run_missing' });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain('No run with id run_missing');
  });

  it('turns failures into isError results', async () => {
    const missing = await call('mw_finding', { id: 'fnd_missing' });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain('No finding with id fnd_missing');

    const unknownTarget = await call('mw_findings', { target: 'nope' });
    expect(unknownTarget.isError).toBeFalsy();

    const noProvider = await call('mw_explore', {});
    expect(noProvider.isError).toBe(true);
    expect(text(noProvider)).toContain('claude mcp add mutationworkflow -e ANTHROPIC_API_KEY=');

    const badTarget = await call('mw_run', { targets: ['nope'] });
    expect(badTarget.isError).toBe(true);
    expect(text(badTarget)).toContain('Unknown target "nope"');
  });

  it('reports what a change affects', async () => {
    const known = await insertWorkflow('active', TODO_TOUCHES);
    const fresh = await insertWorkflow('pending-review', undefined, 'Clear');

    const backend = await call('mw_impact', { files: ['src/todos/store.ts'] });
    expect(backend.isError).toBeFalsy();
    expect(text(backend)).toContain('Changed files (1)');
    expect(text(backend)).toContain(`  ${known.id}  Add a todo`);
    expect(json(backend)).toMatchObject({
      changedFiles: ['src/todos/store.ts'],
      targets: [
        {
          targetId: 'web',
          sharedChange: false,
          impacted: [{ id: known.id, touches: { endpoints: ['POST /api/todos'] } }],
          unknown: [{ id: fresh.id }],
          unaffected: [],
        },
      ],
    });

    const docs = json(await call('mw_impact', { files: ['README.md'], targets: ['web'] }));
    expect(docs).toMatchObject({ targets: [{ impacted: [], unaffected: [{ id: known.id }] }] });

    const shared = await call('mw_impact', { files: ['package.json'] });
    expect(text(shared)).toContain('A shared file changed');

    const detail = await call('mw_workflow', { id: known.id });
    expect(text(detail)).toContain('endpoints: POST /api/todos');
    expect(text(detail)).toContain('files: server.js, src/todos/**');
  });

  it('replays only what changed files affect', async () => {
    await insertWorkflow('active', TODO_TOUCHES);
    const result = await call('mw_run', { changedFiles: ['README.md'], wait: true });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain(
      'Change (1 file): web → 0 workflows affected, 0 never run, 1 skipped',
    );
    expect(json(result)).toMatchObject({
      stats: { total: 0 },
      selection: [
        {
          targetId: 'web',
          changedFiles: 1,
          impacted: 0,
          unknown: 0,
          skipped: 1,
          everything: false,
        },
      ],
    });
  });

  it('runs deterministic mutation directly', async () => {
    await insertWorkflow();
    const result = await call('mw_mutate', { target: 'web' });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toMatch(/web: \d+ new variant\(s\) from 1 base workflow/);
    const jobs = await call('mw_jobs');
    expect(json(jobs)).toEqual([expect.objectContaining({ kind: 'mutate', status: 'succeeded' })]);
  });
});
