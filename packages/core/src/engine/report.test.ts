import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkflow, type Finding, nowIso, type Run } from '../schema/index.js';
import { describeAction, renderReport, writeReport } from './report.js';

const workflow = createWorkflow(
  'web',
  {
    title: 'Add a todo',
    intent: 'Add an item',
    steps: [
      { action: { type: 'navigate', url: '/' } },
      { action: { type: 'click', target: { role: 'button', name: 'Add' } }, note: 'submit' },
    ],
  },
  { origin: 'seed' },
);

const run: Run = {
  id: 'run_1',
  workflowId: workflow.id,
  targetId: 'web',
  trigger: 'manual',
  status: 'failed',
  startedAt: nowIso(),
  finishedAt: nowIso(),
  durationMs: 1234,
  steps: [],
  assertions: [],
  signals: [],
  oracles: [],
  evidenceIds: [],
  context: { mutated: false },
};

const finding: Finding = {
  id: 'fnd_1',
  targetId: 'web',
  fingerprint: 'fp',
  title: 'Submitting twice creates duplicates',
  summary: 'Two identical items appear.',
  severity: 'high',
  detectedBy: 'assertions',
  status: 'open',
  triage: { state: 'done', verdict: 'bug', rationale: 'Duplicates are never intended' },
  workflowIds: [workflow.id],
  runIds: [run.id],
  evidenceIds: ['ev_1', 'ev_2'],
  reproduction: {
    workflowId: workflow.id,
    steps: workflow.steps,
    mutation: { operator: 'repeat-step', description: 'Performs step 2 twice' },
  },
  occurrences: 3,
  firstSeenAt: nowIso(),
  lastSeenAt: nowIso(),
};

describe('reports', () => {
  it('renders summary, findings with reproduction steps, and the run table', () => {
    const markdown = renderReport({
      title: 'Nightly run',
      generatedAt: '2026-11-05T00:00:00.000Z',
      targetIds: ['web'],
      runs: [run],
      workflows: new Map([[workflow.id, workflow]]),
      findings: [finding],
      stats: { total: 1, passed: 0, failed: 1, blocked: 0, error: 0 },
      usage: {
        calls: 4,
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.0123,
      },
      evidenceRoot: '/tmp/evidence',
    });
    expect(markdown).toContain('# Nightly run');
    expect(markdown).toContain('| 0 | 1 | 0 | 0 | 1 |');
    expect(markdown).toContain('about $0.01');
    expect(markdown).toContain('### Submitting twice creates duplicates');
    expect(markdown).toContain('Severity: **high**');
    expect(markdown).toContain('Triage: bug (Duplicates are never intended)');
    expect(markdown).toContain('Mutation: Performs step 2 twice');
    expect(markdown).toContain('1. navigate url="/"');
    expect(markdown).toContain('2. click target={"role":"button","name":"Add"} (submit)');
    expect(markdown).toContain('2 items under `/tmp/evidence`');
    expect(markdown).toContain('| failed | Add a todo |  | 1.2s | `run_1` |');
  });

  it('describes actions compactly and writes report files', () => {
    expect(describeAction({ type: 'reload' })).toBe('reload');
    expect(describeAction({ type: 'fill', value: 'Milk', target: { label: 'Todo' } })).toBe(
      'fill value="Milk" target={"label":"Todo"}',
    );
    const dir = mkdtempSync(join(tmpdir(), 'mw-report-'));
    try {
      const path = writeReport(dir, 'Run (manual)', '# hello');
      expect(path.startsWith(dir)).toBe(true);
      expect(path.endsWith('-run-manual.md')).toBe(true);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('# hello');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
