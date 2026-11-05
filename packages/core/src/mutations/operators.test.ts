import { describe, expect, it } from 'vitest';
import type { MutationHints } from '../adapter/types.js';
import { MutationsConfigSchema } from '../config/schema.js';
import {
  createWorkflow,
  type StepInput,
  TargetConfigSchema,
  type Workflow,
  type WorkflowDraft,
} from '../schema/index.js';
import { DEFAULT_FUZZ_VALUES, dataFuzzOperator } from './operators/data-fuzz.js';
import { interleaveOperator } from './operators/interleave.js';
import { interruptOperator } from './operators/interrupt.js';
import { reorderStepsOperator } from './operators/reorder-steps.js';
import { repeatStepOperator } from './operators/repeat-step.js';
import { roleSwapOperator } from './operators/role-swap.js';
import { skipStepOperator } from './operators/skip-step.js';
import { timingOperator } from './operators/timing.js';
import { truncateOperator } from './operators/truncate.js';
import { builtinOperators } from './registry.js';
import type { MutationContext } from './types.js';

const hints: MutationHints = {
  anchorActionTypes: ['navigate'],
  inputActions: [{ type: 'fill', field: 'value' }],
  interruptSequences: [[{ type: 'reload' }], [{ type: 'back' }, { type: 'forward' }]],
  waitAction: { type: 'wait', field: 'ms' },
};

const SIGNUP_STEPS: StepInput[] = [
  { action: { type: 'navigate', url: '/signup' }, note: 'Open the sign-up page' },
  {
    action: { type: 'fill', selector: '#email', value: 'ada@example.com' },
    expect: [{ type: 'value', selector: '#email', equals: 'ada@example.com' }],
  },
  { action: { type: 'click', selector: '#continue' } },
  { action: { type: 'fill', selector: '#name', value: 'Ada Lovelace' } },
  {
    action: { type: 'click', selector: '#submit' },
    expect: [{ type: 'text', contains: 'Welcome' }],
  },
];

function signup(draft: Partial<WorkflowDraft> = {}): Workflow {
  return createWorkflow(
    'shop',
    {
      title: 'Sign up',
      intent: 'Create an account',
      steps: SIGNUP_STEPS,
      expect: [{ type: 'url', equals: '/welcome' }],
      identity: 'member',
      ...draft,
    },
    { origin: 'seed' },
  );
}

function context(overrides: Partial<MutationContext> = {}): MutationContext {
  return {
    target: TargetConfigSchema.parse({
      id: 'shop',
      kind: 'web',
      identities: [{ id: 'member' }, { id: 'admin' }],
    }),
    hints,
    siblings: [],
    config: MutationsConfigSchema.parse({}),
    ...overrides,
  };
}

const types = (steps: ReadonlyArray<StepInput>): string[] => steps.map((s) => s.action.type);
const selectors = (steps: ReadonlyArray<StepInput>): unknown[] =>
  steps.map(({ action: { selector, type } }) => selector ?? type);

describe('every built-in operator', () => {
  it('is deterministic and leaves its input untouched', () => {
    const workflow = signup();
    const before = structuredClone(workflow);
    const sibling = signup({ title: 'Edit profile', steps: SIGNUP_STEPS.slice(1) });
    const ctx = context({ siblings: [sibling] });
    for (const operator of builtinOperators()) {
      const first = operator.mutate(workflow, ctx);
      expect(operator.mutate(workflow, ctx), operator.id).toEqual(first);
      expect(workflow, operator.id).toEqual(before);
    }
  });
});

describe('skip-step', () => {
  it('removes each non-anchor step', () => {
    const variants = skipStepOperator.mutate(signup(), context());
    expect(variants.map((v) => v.titleSuffix)).toEqual([
      'skip step 2',
      'skip step 3',
      'skip step 4',
      'skip step 5',
    ]);
    expect(variants[0]?.params).toEqual({ index: 1 });
    expect(selectors(variants[1]?.steps ?? [])).toEqual(['navigate', '#email', '#name', '#submit']);
    expect(variants.every((v) => v.expect === undefined)).toBe(true);
  });

  it('needs two steps and a non-anchor step left over', () => {
    const one = signup({ steps: SIGNUP_STEPS.slice(1, 2) });
    const anchorAndOne = signup({ steps: SIGNUP_STEPS.slice(0, 2) });
    expect(skipStepOperator.mutate(one, context())).toEqual([]);
    expect(skipStepOperator.mutate(anchorAndOne, context())).toEqual([]);
  });
});

describe('reorder-steps', () => {
  it('swaps adjacent non-anchor steps', () => {
    const variants = reorderStepsOperator.mutate(signup(), context());
    expect(variants.map((v) => v.titleSuffix)).toEqual([
      'swap steps 2 and 3',
      'swap steps 3 and 4',
      'swap steps 4 and 5',
    ]);
    expect(selectors(variants[0]?.steps ?? [])).toEqual([
      'navigate',
      '#continue',
      '#email',
      '#name',
      '#submit',
    ]);
  });
});

describe('repeat-step', () => {
  it('duplicates each non-anchor, non-wait step without its expectations', () => {
    const steps = [...SIGNUP_STEPS.slice(0, 2), { action: { type: 'wait', ms: 100 } }];
    const variants = repeatStepOperator.mutate(signup({ steps }), context());
    expect(variants.map((v) => v.titleSuffix)).toEqual(['repeat step 2']);
    const repeated = variants[0]?.steps ?? [];
    expect(types(repeated)).toEqual(['navigate', 'fill', 'fill', 'wait']);
    expect(repeated[1]?.expect).toHaveLength(1);
    expect(repeated[2]?.expect).toEqual([]);
  });

  it('covers every interactive step of the sample', () => {
    expect(repeatStepOperator.mutate(signup(), context())).toHaveLength(4);
  });
});

describe('truncate', () => {
  it('stops after each step past the leading anchors and drops final expectations', () => {
    const variants = truncateOperator.mutate(signup(), context());
    expect(variants.map((v) => v.titleSuffix)).toEqual([
      'stop after step 2',
      'stop after step 3',
      'stop after step 4',
    ]);
    expect(variants.map((v) => v.steps.length)).toEqual([2, 3, 4]);
    expect(variants.every((v) => v.expect?.length === 0)).toBe(true);
  });

  it('ignores short workflows', () => {
    expect(truncateOperator.mutate(signup({ steps: SIGNUP_STEPS.slice(0, 2) }), context())).toEqual(
      [],
    );
  });
});

describe('data-fuzz', () => {
  it('replaces each input value with every default fuzz value', () => {
    const variants = dataFuzzOperator.mutate(signup(), context());
    expect(variants).toHaveLength(2 * DEFAULT_FUZZ_VALUES.length);
    const first = variants[0];
    expect(first?.titleSuffix).toBe('fuzz step 2 with empty value');
    expect(first?.params).toEqual({ index: 1, value: '' });
    expect(first?.expect).toEqual([]);
    expect(first?.steps[1]).toMatchObject({
      action: { type: 'fill', selector: '#email', value: '' },
      expect: [],
    });
    // Expectations after the fuzzed step no longer apply once the data changed.
    expect(first?.steps[4]?.expect).toEqual([]);
    const titles = variants.map((v) => v.titleSuffix);
    expect(titles).toContain('fuzz step 2 with 2000-char value');
    expect(titles).toContain('fuzz step 4 with "line1\\nline2"');
    expect(titles).toContain('fuzz step 4 with whitespace');
  });

  it('uses configured values and skips steps without the field', () => {
    const steps = [...SIGNUP_STEPS, { action: { type: 'fill', selector: '#x' } }];
    const config = MutationsConfigSchema.parse({ fuzzValues: ['ü'] });
    const variants = dataFuzzOperator.mutate(signup({ steps }), context({ config }));
    expect(variants.map((v) => v.titleSuffix)).toEqual([
      'fuzz step 2 with "ü"',
      'fuzz step 4 with "ü"',
    ]);
  });
});

describe('interrupt', () => {
  it('inserts each interruption after each non-anchor step but the last', () => {
    const variants = interruptOperator.mutate(signup(), context());
    expect(variants.map((v) => v.titleSuffix)).toEqual([
      'reload after step 2',
      'back then forward after step 2',
      'reload after step 3',
      'back then forward after step 3',
      'reload after step 4',
      'back then forward after step 4',
    ]);
    expect(types(variants[1]?.steps ?? [])).toEqual([
      'navigate',
      'fill',
      'back',
      'forward',
      'click',
      'fill',
      'click',
    ]);
    expect(variants.every((v) => v.expect === undefined)).toBe(true);
    expect(variants[0]?.steps[5]?.expect).toHaveLength(1);
  });
});

describe('timing', () => {
  it('pauses before the last step', () => {
    const variants = timingOperator.mutate(signup(), context());
    expect(variants.map((v) => v.titleSuffix)).toEqual(['pause before last step']);
    expect(variants[0]?.steps[4]?.action).toEqual({ type: 'wait', ms: 2000 });
    expect(variants[0]?.steps).toHaveLength(6);
  });

  it('removes waits when there are any', () => {
    const steps = [SIGNUP_STEPS[0], { action: { type: 'wait', ms: 500 } }, SIGNUP_STEPS[2]].filter(
      (step) => step !== undefined,
    );
    const variants = timingOperator.mutate(signup({ steps }), context());
    expect(variants.map((v) => v.titleSuffix)).toEqual(['no waits', 'pause before last step']);
    expect(types(variants[0]?.steps ?? [])).toEqual(['navigate', 'click']);
  });

  it('needs a wait action', () => {
    const noWait = { ...hints, waitAction: undefined };
    expect(timingOperator.mutate(signup(), context({ hints: noWait }))).toEqual([]);
  });
});

describe('role-swap', () => {
  it('swaps to every other identity and to anonymous', () => {
    const variants = roleSwapOperator.mutate(signup(), context());
    expect(variants.map((v) => v.titleSuffix)).toEqual(['as admin', 'anonymous']);
    expect(variants[0]?.identity).toBe('admin');
    expect(variants[1] && 'identity' in variants[1]).toBe(true);
    expect(variants[1]?.identity).toBeUndefined();
    expect(variants.every((v) => v.expect?.length === 0)).toBe(true);
  });

  it('has no anonymous variant for an anonymous workflow', () => {
    const variants = roleSwapOperator.mutate(signup({ identity: undefined }), context());
    expect(variants.map((v) => v.titleSuffix)).toEqual(['as member', 'as admin']);
  });
});

describe('interleave', () => {
  it('alternates with up to three eligible siblings, ordered by title', () => {
    const workflow = signup();
    const sibling = (title: string, extra: Partial<WorkflowDraft> = {}) =>
      signup({
        title,
        steps: [
          { action: { type: 'navigate', url: '/signup' } },
          { action: { type: 'click', selector: `#${title.toLowerCase()}` } },
        ],
        ...extra,
      });
    const mutation = createWorkflow(
      'shop',
      { title: 'Aaa mutation', intent: 'x', steps: SIGNUP_STEPS, identity: 'member' },
      { origin: 'mutation', parentId: workflow.id },
    );
    const siblings = [
      sibling('Delta'),
      sibling('Bravo'),
      sibling('Alpha', { identity: 'admin' }),
      sibling('Aardvark', { steps: SIGNUP_STEPS.slice(0, 1) }),
      sibling('Echo'),
      sibling('Charlie'),
      mutation,
      workflow,
    ];
    const variants = interleaveOperator.mutate(workflow, context({ siblings }));
    expect(variants.map((v) => v.titleSuffix)).toEqual([
      'interleaved with "Bravo"',
      'interleaved with "Charlie"',
      'interleaved with "Delta"',
    ]);
    expect(variants[0]?.params).toEqual({ siblingId: siblings[1]?.id });
    expect(variants[0]?.expect).toEqual([]);
    // The sibling's navigate repeats the one just performed, so it is dropped.
    expect(selectors(variants[0]?.steps ?? [])).toEqual([
      'navigate',
      '#email',
      '#bravo',
      '#continue',
      '#name',
      '#submit',
    ]);
  });

  it('needs at least two steps', () => {
    const short = signup({ steps: SIGNUP_STEPS.slice(0, 1) });
    expect(interleaveOperator.mutate(short, context({ siblings: [signup()] }))).toEqual([]);
  });
});
