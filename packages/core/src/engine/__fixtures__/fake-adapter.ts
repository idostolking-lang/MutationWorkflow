import {
  type Action,
  type Adapter,
  type AdapterDescription,
  type AdapterSession,
  type Assertion,
  type Footprint,
  nowIso,
  type Signal,
} from '../../index.js';

/**
 * A deterministic stand-in for a real application: a list the user adds items to. It has the
 * same kind of sequence bug the example apps have (adding twice duplicates) and a control that
 * crashes, so the whole pipeline can be exercised without a browser or a model.
 */
export const description: AdapterDescription = {
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

export class FakeSession implements AdapterSession {
  items: string[] = [];
  draft = '';
  opened = false;
  private signals: Signal[] = [];
  private readonly touched: Footprint = { urls: [], endpoints: [] };

  async perform(action: Action) {
    const type = action.type;
    if (type === 'go') {
      this.opened = true;
      this.visit('/');
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
        this.call('POST /api/items');
        return { status: 'ok' as const, evidence: [] };
      }
      if (name === 'remove') {
        if (this.items.length === 0)
          return { status: 'blocked' as const, message: 'nothing to remove', evidence: [] };
        this.items.pop();
        this.call(`DELETE /api/items/${this.items.length + 1}`);
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

  footprint(): Footprint {
    return { urls: [...this.touched.urls], endpoints: [...this.touched.endpoints] };
  }

  private visit(path: string) {
    if (!this.touched.urls.includes(path)) this.touched.urls.push(path);
  }

  private call(endpoint: string) {
    if (!this.touched.endpoints.includes(endpoint)) this.touched.endpoints.push(endpoint);
  }

  async capture() {
    return undefined;
  }

  async close() {}
}

export const fakeAdapter: Adapter = {
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

export const fakeAdapterModule = { createAdapter: () => fakeAdapter, describe: () => description };
