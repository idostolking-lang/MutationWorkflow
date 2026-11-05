import {
  type Finding,
  MutationWorkflowError,
  parseConfig,
  type Run,
  RunSchema,
  type StatusSummary,
  type Workflow,
  WorkflowSchema,
} from '@mutationworkflow/core';
import { describe, expect, it } from 'vitest';
import { formatCheck, nodeVersionOk, providerChecks } from './commands/doctor.js';
import { describeError } from './errors.js';
import {
  compactNumber,
  formatAgentEvent,
  formatDuration,
  formatFindingDetail,
  formatFindings,
  formatImpact,
  formatRunDetail,
  formatRunLine,
  formatSelection,
  formatStatus,
  formatWorkflowDetail,
  oneLine,
  table,
} from './format.js';
import { findingsAtOrAbove } from './views.js';

const NOW = '2026-01-01T00:00:00.000Z';

const workflow: Workflow = WorkflowSchema.parse({
  id: 'wf_1',
  targetId: 'web',
  title: 'Add a todo',
  intent: 'Add an item',
  origin: 'mutation',
  status: 'active',
  parentId: 'wf_0',
  mutation: { operator: 'repeat-step', description: 'repeat step 2' },
  steps: [
    { id: 's1', action: { type: 'navigate', url: '/' } },
    { id: 's2', action: { type: 'click', target: { role: 'button', name: 'Add' } }, note: 'add' },
  ],
  fingerprint: 'abc',
  createdAt: NOW,
  updatedAt: NOW,
});

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'fnd_1',
    targetId: 'web',
    fingerprint: 'f',
    title: 'Double submit creates duplicates',
    summary: 'Two items appear.',
    severity: 'high',
    detectedBy: 'assertions',
    status: 'open',
    triage: { state: 'done', verdict: 'bug', rationale: 'Clearly wrong' },
    workflowIds: ['wf_1'],
    runIds: ['run_1'],
    evidenceIds: ['ev_1'],
    reproduction: { workflowId: 'wf_1', steps: workflow.steps, mutation: workflow.mutation },
    occurrences: 3,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    ...overrides,
  };
}

describe('text helpers', () => {
  it('aligns table columns without padding the last one', () => {
    expect(
      table(
        ['A', 'LONG'],
        [
          ['x', 'y'],
          ['wide', 'z'],
        ],
      ),
    ).toBe('A     LONG\nx     y\nwide  z');
  });

  it('shortens numbers, durations and text', () => {
    expect(compactNumber(950)).toBe('950');
    expect(compactNumber(12_345)).toBe('12.3k');
    expect(compactNumber(4_000_000)).toBe('4M');
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(12_300)).toBe('12.3s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(oneLine('a\n  b   c', 80)).toBe('a b c');
    expect(oneLine('abcdefghij', 5)).toBe('abcd…');
  });
});

describe('domain formatting', () => {
  it('renders a run line with the mutation', () => {
    const run = { status: 'failed', durationMs: 1_200, error: undefined } as Run;
    expect(formatRunLine(run, workflow, 3, 12)).toBe(
      '[3/12] failed  Add a todo · repeat step 2 (1.2s)',
    );
  });

  it('renders a run in detail', () => {
    const run = RunSchema.parse({
      id: 'run_1',
      workflowId: 'wf_1',
      targetId: 'web',
      trigger: 'mcp',
      status: 'failed',
      startedAt: NOW,
      finishedAt: NOW,
      durationMs: 1_200,
      steps: [
        { stepId: 's1', index: 0, status: 'passed', durationMs: 10 },
        { stepId: 's2', index: 1, status: 'failed', durationMs: 20, message: 'button missing' },
      ],
      assertions: [
        {
          assertion: { type: 'count', n: 1, description: 'one item' },
          scope: 'final',
          passed: false,
          message: 'found 2',
        },
      ],
      signals: [
        { kind: 'console-error', message: 'boom', signature: 'boom', stepId: 's2', at: NOW },
      ],
      oracles: [{ oracle: 'assertions', verdict: 'fail', severity: 'medium', summary: '1 failed' }],
      evidenceIds: ['ev_1'],
      touched: { urls: ['/'], endpoints: ['GET /api/todos', 'POST /api/todos'] },
      context: {},
    });
    const text = formatRunDetail(run);
    expect(text).toContain('Touched:\n  pages: /\n  endpoints: GET /api/todos, POST /api/todos');
    expect(text).toContain('Run run_1: failed (1.2s)');
    expect(text).toContain('workflow: wf_1 · target: web · trigger: mcp');
    expect(text).toContain('2. s2 failed: button missing');
    expect(text).toContain('[final] one item: found 2');
    expect(text).toContain('console-error at s2: boom');
    expect(text).toContain('assertions fail (medium): 1 failed');
    expect(text).toContain('Evidence: ev_1');
  });

  it('renders what a workflow touches only once it is known', () => {
    expect(formatWorkflowDetail({ workflow, variants: 0 })).not.toContain('Touches');
    const learned = {
      ...workflow,
      touches: { urls: ['/'], endpoints: [], files: ['server.js'], updatedAt: NOW },
    };
    const text = formatWorkflowDetail({ workflow: learned, variants: 0 });
    expect(text).toContain(`Touches (learned ${NOW}):\n  pages: /\n  files: server.js`);
    expect(text).not.toContain('endpoints:');
  });

  it('renders how a change narrowed a run', () => {
    const base = { targetId: 'app', changedFiles: 3, impacted: 2, unknown: 1, skipped: 5 };
    expect(formatSelection({ ...base, everything: false })).toBe(
      'Change (3 files): app → 2 workflows affected, 1 never run, 5 skipped',
    );
    expect(formatSelection({ ...base, changedFiles: 1, everything: true })).toBe(
      'Change (1 file): app → every workflow replayed',
    );
  });

  it('renders an impact report', () => {
    const files = Array.from({ length: 22 }, (_, i) => `src/file${i}.ts`);
    const text = formatImpact({
      changedFiles: files,
      range: 'abc..HEAD',
      targets: [
        { targetId: 'web', impacted: [workflow], unknown: [], unaffected: [], sharedChange: true },
      ],
    });
    expect(text).toContain('Changed files (22, abc..HEAD)\n  src/file0.ts');
    expect(text).toContain('  src/file19.ts\n  … and 2 more');
    expect(text).not.toContain('src/file20.ts');
    expect(text).toContain(
      'TARGET  AFFECTED  NEVER RUN  UNAFFECTED\nweb     1         0          0',
    );
    expect(text).toContain('  wf_1  Add a todo');
    expect(text).toContain('A shared file changed (manifest, lockfile or global config)');
    expect(formatImpact({ changedFiles: [], targets: [] })).toBe('Changed files (0)');
  });

  it('prints agent problems in the status', () => {
    const status: StatusSummary = {
      project: { name: 'demo', rootDir: '/demo' },
      targets: [],
      agents: {
        enabled: true,
        providers: ['claude-code'],
        maxParallel: 2,
        models: { explorer: 'claude-code (its own default)' },
        problems: ['triager: no model configured'],
      },
      usage: {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      },
      openQuestions: 0,
    };
    const text = formatStatus(status);
    expect(text).toContain('models: explorer=claude-code (its own default)');
    expect(text).toContain('problem: triager: no model configured');
    expect(text.indexOf('problem:')).toBeGreaterThan(text.indexOf('models:'));
  });

  it('renders findings as a table and in detail', () => {
    expect(formatFindings([])).toBe('No findings.');
    expect(formatFindings([finding()])).toContain('fnd_1  high      open    bug     3x');
    const detail = formatFindingDetail({
      finding: finding(),
      workflow,
      evidence: [{ id: 'ev_1', kind: 'screenshot', path: '/abs/evidence/shot.png' }],
    });
    expect(detail).toContain('Triage: bug: Clearly wrong');
    expect(detail).toContain('Mutation: repeat step 2');
    expect(detail).toContain('  1. navigate url="/"');
    expect(detail).toContain('  2. click target={"role":"button","name":"Add"} (add)');
    expect(detail).toContain('ev_1  screenshot  /abs/evidence/shot.png');
  });

  it('renders agent events as single lines', () => {
    expect(
      formatAgentEvent({
        type: 'tool',
        role: 'explorer',
        depth: 1,
        name: 'click',
        ok: true,
        summary: 'clicked\n"Add"',
      }),
    ).toBe('[explorer#1] ✓ click: clicked "Add"');
    expect(
      formatAgentEvent({
        type: 'turn',
        role: 'explorer',
        depth: 0,
        turn: 1,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    ).toBeUndefined();
  });

  it('selects findings at or above a severity', () => {
    const findings = [
      finding({ id: 'a', severity: 'critical' }),
      finding({ id: 'b', severity: 'medium' }),
      finding({ id: 'c', severity: 'high', status: 'dismissed' }),
    ];
    expect(findingsAtOrAbove(findings, 'high').map((f) => f.id)).toEqual(['a']);
    expect(findingsAtOrAbove(findings, 'low').map((f) => f.id)).toEqual(['a', 'b']);
  });
});

describe('errors and doctor', () => {
  it('explains missing providers per surface', () => {
    const error = new MutationWorkflowError('PROVIDER_NOT_CONFIGURED', 'needs a provider');
    expect(describeError(error, 'mcp')).toContain('claude mcp add mutationworkflow');
    expect(describeError(error, 'cli')).toContain(
      'Install Claude Code or Codex, export ANTHROPIC_API_KEY',
    );
    expect(describeError(new Error('plain'), 'cli')).toBe('plain');
    const git = new MutationWorkflowError('GIT_UNAVAILABLE', 'No git.');
    expect(describeError(git, 'cli')).toBe('No git. Use --file <path> (repeatable).');
    expect(describeError(git, 'mcp')).toContain('`files`');
  });

  it('checks the Node version', () => {
    expect(nodeVersionOk('22.13.0')).toBe(true);
    expect(nodeVersionOk('22.12.9')).toBe(false);
    expect(nodeVersionOk('24.0.0')).toBe(true);
  });

  it('checks API keys without printing them', () => {
    const config = parseConfig({ version: 1, project: { name: 'p' } });
    const [found] = providerChecks(config, { ANTHROPIC_API_KEY: 'sk-secret' });
    expect(found?.state).toBe('ok');
    expect(JSON.stringify(found)).not.toContain('sk-secret');
    expect(providerChecks(config, {})[0]?.state).toBe('warn');
    const configured = parseConfig({
      version: 1,
      project: { name: 'p' },
      providers: { main: { type: 'openai', apiKeyEnv: 'MY_KEY' } },
    });
    expect(providerChecks(configured, {})[0]).toMatchObject({
      state: 'fail',
      label: 'Provider main',
    });
    expect(formatCheck({ state: 'fail', label: 'Config', detail: 'missing' })).toBe(
      '✗ Config  missing',
    );
  });
});
