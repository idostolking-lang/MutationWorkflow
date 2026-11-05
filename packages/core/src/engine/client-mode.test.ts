import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWorkflow,
  Engine,
  type Finding,
  newId,
  nowIso,
  openSqliteStore,
  parseConfig,
  resolveConfig,
  silentLogger,
} from '../index.js';
import { fakeAdapterModule } from './__fixtures__/fake-adapter.js';

/**
 * The client-driven surface: a connected coding agent asks for a brief, thinks with its own
 * model, and submits the result. These tests play the client with no provider configured.
 */
describe('client-driven engine operations', () => {
  let dir: string;
  let engine: Engine;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mw-client-'));
    engine = await Engine.create({
      config: resolveConfig(
        parseConfig({
          version: 1,
          project: { name: 'client-mode' },
          targets: [{ id: 'app', kind: 'fake' }],
          execution: { screenshots: 'never' },
        }),
        dir,
      ),
      store: openSqliteStore(':memory:'),
      adapters: { fake: async () => fakeAdapterModule },
      providers: new Map(),
      logger: silentLogger,
    });
  });

  afterEach(async () => {
    await engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses in-process agent operations but offers the brief tools', async () => {
    await expect(engine.explore('app')).rejects.toThrow(/brief tools/);
    expect((await engine.status()).agents.enabled).toBe(false);
  });

  it('drives an exploration session tool by tool and closes it', async () => {
    const handle = await engine.openExploration('app', {
      focus: ['adding items'],
      maxWorkflows: 2,
    });
    expect(handle.instructions.system).toContain('In-memory list application');
    expect(handle.instructions.task).toContain('adding items');
    expect(handle.session.remainingBudget).toBe(2);

    const act = async (action: Record<string, unknown>) =>
      handle.session.callTool('act', { action });
    expect((await act({ type: 'go' })).isError).toBeUndefined();
    await act({ type: 'type', value: 'Eggs' });
    const added = await act({ type: 'do', name: 'add' });
    expect(JSON.stringify(added.content)).toContain('recorded as step 3');
    const check = await handle.session.callTool('check', {
      assertion: { type: 'has', value: 'Eggs' },
    });
    expect(JSON.stringify(check.content)).toContain('PASSED');
    const saved = await handle.session.callTool('save_workflow', {
      title: 'Add eggs',
      intent: 'Add an item',
      expect: [
        { type: 'has', value: 'Eggs', description: 'Eggs is listed' },
        { type: 'count', n: 99, description: 'wrong on purpose' },
      ],
    });
    expect(saved.isError).toBeUndefined();
    expect(JSON.stringify(saved.content)).toContain('1 verified expectation');
    expect(JSON.stringify(saved.content)).toContain('Dropped 1 expectation');
    const unknown = await handle.session.callTool('nope', {});
    expect(unknown.isError).toBe(true);

    const result = await handle.close();
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]).toMatchObject({
      title: 'Add eggs',
      status: 'pending-review',
      origin: 'discovered',
    });
    expect(result.workflows[0]?.expect).toHaveLength(1);
    expect(result.questions).toHaveLength(1);
    expect(await handle.close()).toEqual(result);
    expect((await engine.status()).targets[0]?.workflows.pendingReview).toBe(1);
  });

  it('gives an inspection brief and applies a client-written report', async () => {
    const brief = await engine.inspectionBrief({ projectName: 'demo' });
    expect(brief.system).toContain('inspector agent');
    expect(brief.adapters.map((a) => a.kind)).toEqual(['fake']);
    expect(brief.reportSchema).toMatchObject({ type: 'object' });
    expect(JSON.stringify(brief.reportSchema)).toContain('workflows');

    await expect(engine.applyInspectionReport({ summary: 'no targets' })).rejects.toThrow(
      /invalid/,
    );

    const result = await engine.applyInspectionReport({
      summary: 'A list app.',
      stack: ['node'],
      targets: [
        { id: 'app', kind: 'fake' },
        { id: 'other', kind: 'fake' },
      ],
      features: [],
      existingTests: [],
      workflows: [
        {
          targetId: 'app',
          title: 'Add from test',
          intent: 'Add an item',
          steps: [
            { action: { type: 'go' } },
            { action: { type: 'type', value: 'Milk' } },
            { action: { type: 'do', name: 'add' } },
          ],
          source: { file: 'test/add.test.js' },
        },
      ],
      risks: [],
      questions: ['Which database?'],
    });
    // The engine was built in memory without a config file, so setup creates one.
    expect(result.configAction).toBe('created');
    expect(existsSync(result.configPath)).toBe(true);
    expect(readFileSync(result.configPath, 'utf8')).toContain('id: other');
    expect(result.workflows.map((w) => w.origin)).toEqual(['imported-test']);
    expect(result.questions.map((q) => q.kind)).toEqual(['setup']);
    expect(engine.targets().map((t) => t.id)).toEqual(['app', 'other']);
  });

  it('briefs the client on pending findings and applies its decisions', async () => {
    expect(await engine.triageBrief()).toBeUndefined();
    const workflow = createWorkflow(
      'app',
      { title: 'Add twice', intent: 'x', steps: [{ action: { type: 'go' } }] },
      { origin: 'mutation' },
    );
    await engine.store.workflows.insert(workflow);
    const now = nowIso();
    const finding: Finding = {
      id: newId('fnd'),
      targetId: 'app',
      fingerprint: 'fp-1',
      title: 'assertions failed',
      summary: 'count was 2',
      severity: 'medium',
      detectedBy: 'assertions',
      status: 'open',
      triage: { state: 'pending' },
      workflowIds: [workflow.id],
      runIds: [],
      evidenceIds: [],
      reproduction: { workflowId: workflow.id, steps: workflow.steps },
      occurrences: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    };
    await engine.store.findings.insert(finding);

    const brief = await engine.triageBrief();
    expect(brief?.targetId).toBe('app');
    expect(brief?.findingIds).toEqual([finding.id]);
    expect(brief?.task).toContain(finding.id);
    expect(brief?.system).toContain('triager agent');

    await expect(engine.applyTriageDecisions({ decisions: [] })).rejects.toThrow(
      /existing finding/,
    );
    const updated = await engine.applyTriageDecisions({
      decisions: [
        {
          findingId: finding.id,
          verdict: 'bug',
          title: 'Submitting twice creates duplicates',
          summary: 'Add once, add again: two items.',
          severity: 'high',
          rationale: 'Duplicates are never intended.',
        },
      ],
    });
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      title: 'Submitting twice creates duplicates',
      severity: 'high',
      status: 'open',
    });
    expect(updated[0]?.triage).toMatchObject({ state: 'done', verdict: 'bug', model: 'client' });
    expect(await engine.triageBrief()).toBeUndefined();
  });

  it('briefs the client on a workflow and stores its proposed variants', async () => {
    const base = createWorkflow(
      'app',
      {
        title: 'Add an item',
        intent: 'Add Milk',
        steps: [
          { action: { type: 'go' } },
          { action: { type: 'type', value: 'Milk' } },
          { action: { type: 'do', name: 'add' } },
        ],
      },
      { origin: 'seed' },
    );
    await engine.store.workflows.insert(base);
    const brief = await engine.mutationBrief(base.id);
    expect(brief.system).toContain('mutator agent');
    expect(brief.system).toContain('Add an item');
    expect(JSON.stringify(brief.variantsSchema)).toContain('titleSuffix');

    const variants = await engine.applyAgentVariants(base.id, {
      variants: [
        {
          titleSuffix: 'add after refresh',
          description: 'Refresh before adding to test a stale draft',
          steps: [
            { id: 's1', action: { type: 'go' } },
            { id: 's1', action: { type: 'type', value: 'Milk' } },
            { action: { type: 'refresh' } },
            { action: { type: 'do', name: 'add' } },
          ],
        },
        {
          titleSuffix: 'bad action',
          description: 'invalid',
          steps: [{ action: { type: 'teleport' } }],
        },
      ],
    });
    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({
      origin: 'mutation',
      parentId: base.id,
      title: 'Add an item (add after refresh)',
    });
    expect(variants[0]?.mutation?.operator).toBe('agent');
    expect(variants[0]?.steps.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4']);
    expect(variants[0]?.expect).toEqual([]);
    await expect(engine.mutationBrief('wf_missing')).rejects.toThrow(/No workflow/);
  });
});
