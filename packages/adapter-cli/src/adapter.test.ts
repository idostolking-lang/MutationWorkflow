import { silentLogger, type TargetConfigInput, TargetConfigSchema } from '@mutationworkflow/core';
import { describe, expect, it } from 'vitest';
import { CliAdapter, createAdapter } from './adapter.js';
import defaultExport from './index.js';

function adapter(options: Record<string, unknown>, extra: Partial<TargetConfigInput> = {}) {
  const target = TargetConfigSchema.parse({ id: 'counter', kind: 'cli', options, ...extra });
  return createAdapter({ target, rootDir: '/project', logger: silentLogger });
}

describe('CliAdapter options', () => {
  it('applies defaults and resolves cwd against the root', () => {
    const cli = adapter({ command: 'node', cwd: 'examples/counter-cli' });
    expect(cli).toBeInstanceOf(CliAdapter);
    expect(cli.options).toMatchObject({
      command: 'node',
      args: [],
      cwd: '/project/examples/counter-cli',
      shell: false,
      exitTimeoutMs: 5000,
    });
    expect(defaultExport.createAdapter).toBe(createAdapter);
  });

  it('rejects missing commands and invalid prompt patterns', () => {
    expect(() => adapter({})).toThrow(/Invalid options for cli target "counter"/);
    expect(() => adapter({ command: 'node', promptPattern: '(' })).toThrow(
      /valid regular expression/,
    );
  });
});

describe('CliAdapter vocabulary', () => {
  const cli = adapter({ command: 'node', promptPattern: '^> ' });

  it('normalises valid actions', () => {
    expect(cli.validateAction({ type: 'write', text: 'add 5' })).toEqual({
      type: 'write',
      text: 'add 5',
      newline: true,
    });
    expect(cli.validateAction({ type: 'wait', prompt: true })).toEqual({
      type: 'wait',
      prompt: true,
    });
  });

  it('rejects unknown and invalid actions', () => {
    expect(() => cli.validateAction({ type: 'click' })).toThrow(/Unknown cli action "click"/);
    expect(() => cli.validateAction({ type: 'wait' })).toThrow(/wait needs ms, output or prompt/);
    expect(() => cli.validateAction({ type: 'signal', signal: 'SIGHUP' })).toThrow(/signal/);
    expect(() => cli.validateAction({ type: 'wait', output: '[' })).toThrow(/regular expression/);
    expect(() => cli.validateAction({ type: 'write' })).toThrow(/text/);
  });

  it('requires promptPattern for wait.prompt', () => {
    expect(() =>
      adapter({ command: 'node' }).validateAction({ type: 'wait', prompt: true }),
    ).toThrow(/promptPattern/);
  });

  it('validates assertions and keeps their description', () => {
    expect(
      cli.validateAssertion({ type: 'output-matches', pattern: '^5$', description: 'shows 5' }),
    ).toEqual({
      type: 'output-matches',
      pattern: '^5$',
      description: 'shows 5',
      stream: 'both',
      since: 'session',
    });
    expect(() => cli.validateAssertion({ type: 'exit-code' })).toThrow(/code/);
    expect(() => cli.validateAssertion({ type: 'title' })).toThrow(/Unknown cli assertion/);
  });

  it('describes its vocabulary with JSON Schemas and mutation hints', () => {
    const description = cli.describe();
    expect(description.kind).toBe('cli');
    expect(description.actions.map((spec) => spec.type)).toEqual([
      'start',
      'exec',
      'write',
      'wait',
      'signal',
      'close',
    ]);
    expect(description.assertions.map((spec) => spec.type)).toEqual([
      'output-matches',
      'output-not-matches',
      'exit-code',
      'running',
      'stderr-empty',
    ]);
    const write = description.actions.find((spec) => spec.type === 'write');
    expect(write?.schema).toMatchObject({
      type: 'object',
      required: ['type', 'text'],
      properties: { text: { type: 'string', description: 'Text typed into the process' } },
    });
    for (const spec of [...description.actions, ...description.assertions]) {
      expect(spec.description).not.toBe(spec.type);
      expect(spec.example?.type).toBe(spec.type);
    }
    expect(description.hints).toEqual({
      anchorActionTypes: ['start', 'exec'],
      inputActions: [{ type: 'write', field: 'text' }],
      interruptSequences: [[{ type: 'signal', signal: 'SIGINT' }]],
      waitAction: { type: 'wait', field: 'ms' },
    });
    expect(description.guide).toContain('wait {prompt: true}');
  });
});
