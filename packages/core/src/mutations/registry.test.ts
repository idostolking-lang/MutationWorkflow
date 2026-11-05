import { describe, expect, it } from 'vitest';
import { BUILTIN_OPERATOR_IDS, MutationsConfigSchema } from '../config/schema.js';
import { createWorkflow, TargetConfigSchema, type Workflow } from '../schema/index.js';
import { MutationWorkflowError } from '../util/errors.js';
import { builtinOperators, generateVariants, resolveOperators } from './registry.js';
import type { MutationContext, MutationOperator } from './types.js';

const context: MutationContext = {
  target: TargetConfigSchema.parse({
    id: 'shop',
    kind: 'web',
    identities: [{ id: 'member' }, { id: 'admin' }],
  }),
  hints: {
    anchorActionTypes: ['navigate'],
    inputActions: [{ type: 'fill', field: 'value' }],
    interruptSequences: [[{ type: 'reload' }]],
    waitAction: { type: 'wait', field: 'ms' },
  },
  siblings: [],
  config: MutationsConfigSchema.parse({ fuzzValues: ['', 'x'.repeat(300)] }),
};

function checkout(status: Workflow['status'] = 'active'): Workflow {
  return createWorkflow(
    'shop',
    {
      title: 'Checkout',
      intent: 'Pay for the cart',
      steps: [
        { id: 'open', action: { type: 'navigate', url: '/cart' } },
        { id: 'card', action: { type: 'fill', selector: '#card', value: '4242' } },
        { id: 'pay', action: { type: 'click', selector: '#pay' }, note: 'Pay' },
        { id: 'zip', action: { type: 'fill', selector: '#zip', value: '10115' } },
        { id: 'done', action: { type: 'click', selector: '#confirm' } },
      ],
      expect: [{ type: 'text', contains: 'Thank you' }],
      identity: 'member',
      tags: ['payments'],
    },
    { origin: 'seed', status },
  );
}

/** Variant content without the parts that differ on every call. */
function stable(workflows: Workflow[]): unknown[] {
  return workflows.map(({ id: _id, createdAt: _c, updatedAt: _u, ...rest }) => rest);
}

const constant = (id: string, variants: ReturnType<MutationOperator['mutate']>) =>
  ({ id, description: id, mutate: () => variants }) satisfies MutationOperator;

describe('builtinOperators', () => {
  it('matches BUILTIN_OPERATOR_IDS exactly, in order', () => {
    expect(builtinOperators().map((operator) => operator.id)).toEqual([...BUILTIN_OPERATOR_IDS]);
  });
});

describe('resolveOperators', () => {
  it('resolves ids in the order given', () => {
    expect(resolveOperators(['timing', 'skip-step']).map((o) => o.id)).toEqual([
      'timing',
      'skip-step',
    ]);
  });

  it('accepts extra operators, which may replace built-ins', () => {
    const custom = constant('custom', []);
    const timing = constant('timing', []);
    expect(resolveOperators(['custom', 'timing'], [custom, timing])).toEqual([custom, timing]);
  });

  it('rejects unknown ids', () => {
    expect(() => resolveOperators(['skip-step', 'nope'])).toThrow(MutationWorkflowError);
    try {
      resolveOperators(['nope']);
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_INPUT' });
    }
  });
});

describe('generateVariants', () => {
  it('builds mutation workflows linked to their parent', () => {
    const parent = checkout();
    const [variant] = generateVariants(parent, resolveOperators(['skip-step']), context, {
      maxVariants: 1,
    });
    expect(variant).toMatchObject({
      targetId: 'shop',
      title: 'Checkout (skip step 2)',
      intent: 'Pay for the cart',
      origin: 'mutation',
      status: 'active',
      parentId: parent.id,
      identity: 'member',
      expect: parent.expect,
      tags: ['payments', 'mutation', 'skip-step'],
      mutation: { operator: 'skip-step', params: { index: 1 } },
    });
    expect(variant?.mutation?.description).toMatch(/Skips step 2/);
    expect(variant?.steps.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4']);
    expect(variant?.steps[1]?.note).toBe('Pay');
  });

  it('applies variant expectations and identity, and keeps archived parents archived', () => {
    const parent = checkout('archived');
    const variants = generateVariants(parent, resolveOperators(['role-swap']), context, {
      maxVariants: 10,
    });
    expect(variants.map((v) => [v.title, v.identity, v.expect, v.status])).toEqual([
      ['Checkout (as admin)', 'admin', [], 'archived'],
      ['Checkout (anonymous)', undefined, [], 'archived'],
    ]);
    const pending = { ...checkout(), status: 'pending-review' as const };
    const [fromPending] = generateVariants(pending, resolveOperators(['truncate']), context, {
      maxVariants: 1,
    });
    expect(fromPending?.status).toBe('active');
  });

  it('runs every built-in operator with unique fingerprints and stops at the cap', () => {
    const parent = checkout();
    const all = generateVariants(parent, builtinOperators(), context, { maxVariants: 1000 });
    const fingerprints = new Set(all.map((v) => v.fingerprint));
    expect(fingerprints.size).toBe(all.length);
    expect(fingerprints.has(parent.fingerprint)).toBe(false);
    expect(new Set(all.map((v) => v.mutation?.operator))).toEqual(
      new Set(BUILTIN_OPERATOR_IDS.filter((id) => id !== 'interleave')),
    );

    const capped = generateVariants(parent, builtinOperators(), context, { maxVariants: 7 });
    expect(stable(capped)).toEqual(stable(all.slice(0, 7)));
  });

  it('drops variants equal to the parent, to each other or to existing workflows', () => {
    const parent = checkout();
    const same = constant('same', [
      { titleSuffix: 'unchanged', description: 'same steps', steps: parent.steps },
      { titleSuffix: 'first', description: 'one', steps: parent.steps.slice(1) },
      { titleSuffix: 'again', description: 'one again', steps: parent.steps.slice(1) },
      { titleSuffix: 'other', description: 'two', steps: parent.steps.slice(2) },
    ]);
    const all = generateVariants(parent, [same], context, { maxVariants: 10 });
    expect(all.map((v) => v.title)).toEqual(['Checkout (first)', 'Checkout (other)']);

    const existing = new Set([all[0]?.fingerprint ?? '']);
    const fresh = generateVariants(parent, [same], context, {
      maxVariants: 10,
      existingFingerprints: existing,
    });
    expect(fresh.map((v) => v.title)).toEqual(['Checkout (other)']);
  });

  it('is deterministic', () => {
    const parent = checkout();
    const run = () => generateVariants(parent, builtinOperators(), context, { maxVariants: 50 });
    expect(stable(run())).toEqual(stable(run()));
  });
});
