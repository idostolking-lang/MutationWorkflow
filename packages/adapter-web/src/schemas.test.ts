import { createLogger } from '@mutationworkflow/core';
import { describe, expect, it } from 'vitest';
import { ACTION_EXAMPLES, WebActionSchema } from './actions.js';
import { createAdapter } from './adapter.js';
import { ASSERTION_EXAMPLES, WebAssertionSchema } from './assertions.js';

const adapter = createAdapter({
  target: {
    id: 'web',
    kind: 'web',
    options: { baseUrl: 'http://127.0.0.1:4173' },
    environment: {},
    identities: [],
    invariants: [],
    scope: { allowUrls: [], denyUrls: [], denyText: [] },
  },
  rootDir: process.cwd(),
  logger: createLogger({ level: 'silent' }),
});

describe('actions', () => {
  it('accepts every documented example', () => {
    for (const example of Object.values(ACTION_EXAMPLES)) {
      expect(WebActionSchema.safeParse(example).success, example.type).toBe(true);
    }
  });

  it.each([
    [{ type: 'teleport' }],
    [{ type: 'click' }],
    [{ type: 'click', target: {} }],
    [{ type: 'fill', target: { label: 'Name' } }],
    [{ type: 'navigate', url: '' }],
    [{ type: 'wait' }],
    [{ type: 'wait', ms: -5 }],
    [{ type: 'press', target: { label: 'Search' } }],
  ])('rejects %j', (action) => {
    expect(() => adapter.validateAction(action)).toThrow(/Invalid web action/);
  });

  it('normalises by stripping unknown fields', () => {
    expect(adapter.validateAction({ type: 'reload', extra: 1 })).toEqual({ type: 'reload' });
  });
});

describe('assertions', () => {
  it('accepts every documented example and keeps the description', () => {
    for (const example of Object.values(ASSERTION_EXAMPLES)) {
      expect(WebAssertionSchema.safeParse(example).success, example.type).toBe(true);
    }
    expect(
      adapter.validateAssertion({ type: 'text-visible', text: 'Hi', description: 'greets' }),
    ).toEqual({ type: 'text-visible', text: 'Hi', description: 'greets' });
  });

  it.each([
    [{ type: 'element-count', target: { role: 'listitem' } }],
    [{ type: 'url-matches', pattern: '/(/' }],
    [{ type: 'http', url: '/x', status: 42 }],
    [{ type: 'text-visible' }],
    [{ type: 'value-equals', target: { label: 'Title' } }],
  ])('rejects %j', (assertion) => {
    expect(() => adapter.validateAssertion(assertion)).toThrow(/Invalid web assertion/);
  });
});

describe('describe()', () => {
  const description = adapter.describe();

  it('documents every action and assertion with a JSON schema and example', () => {
    expect(description.kind).toBe('web');
    expect(description.actions.map((a) => a.type)).toEqual(Object.keys(ACTION_EXAMPLES));
    expect(description.assertions.map((a) => a.type)).toEqual(Object.keys(ASSERTION_EXAMPLES));
    for (const spec of [...description.actions, ...description.assertions]) {
      expect(spec.description).not.toBe('');
      expect(spec.schema).toHaveProperty('properties.type');
      expect(spec.example?.type).toBe(spec.type);
    }
  });

  it('gives mutation hints that are valid actions', () => {
    const { hints } = description;
    expect(hints.anchorActionTypes).toEqual(['navigate']);
    for (const sequence of hints.interruptSequences) {
      for (const action of sequence) expect(() => adapter.validateAction(action)).not.toThrow();
    }
    expect(hints.waitAction).toEqual({ type: 'wait', field: 'ms' });
  });
});
