import { describe, expect, it } from 'vitest';
import { BUILTIN_ORACLE_IDS, OraclesConfigSchema } from '../config/schema.js';
import { createWorkflow, type OracleContext, type Signal, TargetConfigSchema } from '../index.js';
import { builtinOracles, evaluateOracles, resolveOracles } from './registry.js';

const target = TargetConfigSchema.parse({ id: 'web', kind: 'web' });
const workflow = createWorkflow(
  'web',
  {
    title: 'Add item',
    intent: 'Add an item',
    steps: [
      { action: { type: 'navigate', url: '/' } },
      { action: { type: 'fill', target: { label: 'Todo' }, value: 'Milk' } },
      { action: { type: 'click', target: { role: 'button', name: 'Add' } } },
    ],
  },
  { origin: 'seed' },
);

function context(overrides: Partial<OracleContext> = {}): OracleContext {
  return {
    workflow,
    target,
    mutated: false,
    steps: workflow.steps.map((step, index) => ({
      stepId: step.id,
      index,
      status: 'passed' as const,
      durationMs: 1,
      evidenceIds: [],
    })),
    assertions: [],
    signals: [],
    config: OraclesConfigSchema.parse({}),
    ...overrides,
  };
}

function signal(kind: Signal['kind'], message: string, details?: Record<string, unknown>): Signal {
  return { kind, message, signature: `${kind} ${message}`, details, at: new Date().toISOString() };
}

describe('oracle registry', () => {
  it('ships exactly the built-in oracle ids from the config schema', () => {
    expect(builtinOracles().map((o) => o.id)).toEqual([...BUILTIN_ORACLE_IDS]);
  });

  it('rejects unknown oracle ids', () => {
    expect(() => resolveOracles(['nope'])).toThrow(/Unknown oracle "nope"/);
  });

  it('passes a clean run', () => {
    const results = evaluateOracles(builtinOracles(), context());
    expect(results.filter((r) => r.verdict === 'fail')).toHaveLength(0);
  });
});

describe('step-failure', () => {
  it('fails a base workflow whose step was blocked', () => {
    const ctx = context();
    ctx.steps[2] = {
      ...ctx.steps[2],
      status: 'blocked',
      message: 'no such button',
    } as OracleContext['steps'][number];
    const [result] = resolveOracles(['step-failure']).flatMap((o) => o.evaluate(ctx));
    expect(result?.verdict).toBe('fail');
    expect(result?.severity).toBe('high');
    expect(result?.summary).toContain('Step 3');
  });

  it('skips a blocked step on a mutated workflow but fails an errored one', () => {
    const blocked = context({ mutated: true });
    blocked.steps[1] = { ...blocked.steps[1], status: 'blocked' } as OracleContext['steps'][number];
    expect(resolveOracles(['step-failure'])[0]?.evaluate(blocked)[0]?.verdict).toBe('skip');

    const errored = context({ mutated: true });
    errored.steps[1] = {
      ...errored.steps[1],
      status: 'error',
      message: 'page crashed',
    } as OracleContext['steps'][number];
    const result = resolveOracles(['step-failure'])[0]?.evaluate(errored)[0];
    expect(result?.verdict).toBe('fail');
    expect(result?.severity).toBe('medium');
  });

  it('says nothing when the run itself errored', () => {
    expect(resolveOracles(['step-failure'])[0]?.evaluate(context({ runError: 'boom' }))).toEqual(
      [],
    );
  });
});

describe('app-error', () => {
  const oracle = () => resolveOracles(['app-error'])[0];

  it('groups identical signals into one result and counts them', () => {
    const ctx = context({
      signals: [
        signal('console-error', 'TypeError: x is undefined'),
        signal('console-error', 'TypeError: x is undefined'),
        signal('uncaught-exception', 'ReferenceError: y'),
      ],
    });
    const results = oracle()?.evaluate(ctx) ?? [];
    expect(results).toHaveLength(2);
    expect(results[0]?.summary).toContain('(2 times)');
    expect(results[1]?.severity).toBe('high');
  });

  it('ignores http errors below the configured status and ignored kinds and patterns', () => {
    const ctx = context({
      signals: [
        signal('http-error', 'GET /missing 404', { status: 404 }),
        signal('http-error', 'POST /items 500', { status: 500 }),
        signal('network-error', 'favicon failed'),
        signal('stderr', 'DeprecationWarning: error'),
      ],
      config: OraclesConfigSchema.parse({
        ignoreSignalKinds: ['network-error'],
        ignoreSignals: ['Deprecation'],
      }),
    });
    const results = oracle()?.evaluate(ctx) ?? [];
    expect(results).toHaveLength(1);
    expect(results[0]?.summary).toContain('500');
    expect(results[0]?.severity).toBe('high');
  });
});

describe('assertions and invariants', () => {
  it('reports failed assertions with triage-friendly severity on mutated workflows', () => {
    const ctx = context({
      mutated: true,
      assertions: [
        {
          assertion: { type: 'element-count', description: 'exactly one item' },
          scope: 'final',
          passed: false,
          message: 'found 2',
        },
        { assertion: { type: 'text-visible' }, scope: 'step', stepId: 's2', passed: true },
      ],
    });
    const result = resolveOracles(['assertions'])[0]?.evaluate(ctx)[0];
    expect(result?.verdict).toBe('fail');
    expect(result?.severity).toBe('medium');
    expect(result?.summary).toContain('exactly one item');
    expect(result?.summary).toContain('found 2');
  });

  it('treats invariant violations separately and as high severity', () => {
    const ctx = context({
      assertions: [
        {
          assertion: { type: 'http', description: 'health endpoint answers' },
          scope: 'invariant',
          passed: false,
          message: '503',
        },
      ],
    });
    expect(resolveOracles(['assertions'])[0]?.evaluate(ctx)).toEqual([]);
    const result = resolveOracles(['invariants'])[0]?.evaluate(ctx)[0];
    expect(result?.verdict).toBe('fail');
    expect(result?.severity).toBe('high');
    expect(result?.summary).toContain('health endpoint answers');
  });
});
