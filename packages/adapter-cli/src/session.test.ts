import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Action,
  type AdapterSession,
  EvidenceSink,
  ScopeSchema,
  silentLogger,
  TargetConfigSchema,
} from '@mutationworkflow/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CliAdapter, createAdapter } from './adapter.js';

const COUNTER_DIR = resolve(fileURLToPath(import.meta.url), '../../../../examples/counter-cli');

describe('CliSession with examples/counter-cli', () => {
  let evidenceDir: string;
  const adapters: CliAdapter[] = [];
  let session: AdapterSession;

  beforeEach(async () => {
    evidenceDir = mkdtempSync(join(tmpdir(), 'mw-cli-'));
    session = await openSession({
      command: process.execPath,
      args: ['cli.js'],
      promptPattern: '^> ',
      exitTimeoutMs: 1000,
    });
  });

  async function openSession(options: Record<string, unknown>): Promise<AdapterSession> {
    const adapter = createAdapter({
      target: TargetConfigSchema.parse({ id: 'counter', kind: 'cli', options }),
      rootDir: COUNTER_DIR,
      logger: silentLogger,
    });
    adapters.push(adapter);
    return adapter.open({
      sessionId: 'ses_test',
      evidence: new EvidenceSink({ rootDir: evidenceDir, sessionDir: 'session' }),
      screenshots: 'never',
      stepTimeoutMs: 5_000,
      scope: ScopeSchema.parse({}),
      logger: silentLogger,
    });
  }

  afterEach(async () => {
    await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
    rmSync(evidenceDir, { recursive: true, force: true });
  });

  async function steps(actions: Action[], target = session) {
    const outcomes = [];
    for (const [index, action] of actions.entries()) {
      outcomes.push(await target.perform(action, { stepId: `s${index + 1}`, index }));
    }
    return outcomes;
  }

  const enter = (text: string): Action[] => [
    { type: 'write', text },
    { type: 'wait', prompt: true },
  ];

  it('drives the REPL and checks its answers', async () => {
    const outcomes = await steps([
      { type: 'start' },
      { type: 'wait', prompt: true },
      ...enter('add 5'),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['ok', 'ok', 'ok', 'ok']);

    expect(await session.check({ type: 'output-matches', pattern: '\\b5$' })).toEqual({
      passed: true,
    });
    expect(
      await session.check({ type: 'output-matches', pattern: '\\b5$', since: 'step' }),
    ).toEqual({
      passed: true,
    });
    expect(await session.check({ type: 'running', expected: true })).toEqual({ passed: true });
    expect(await session.check({ type: 'stderr-empty' })).toEqual({ passed: true });
    expect((await session.check({ type: 'exit-code', code: 0 })).message).toBe(
      'The process is still running',
    );

    await steps(enter('sub 2'));
    expect(
      await session.check({ type: 'output-not-matches', pattern: '\\b5$', since: 'step' }),
    ).toEqual({ passed: true });
    const failed = await session.check({ type: 'output-matches', pattern: '^42$', since: 'step' });
    expect(failed.passed).toBe(false);
    expect(failed.message).toContain('not found');

    const observation = await session.observe();
    expect(observation.summary).toMatch(/cli\.js \(running\)/);
    expect(observation.summary).toContain('── step s2');

    const [close] = await steps([{ type: 'close' }]);
    expect(close?.status).toBe('ok');
    expect(await session.check({ type: 'exit-code', code: 0 })).toEqual({ passed: true });
    expect(session.drainSignals()).toEqual([]);

    const log = await session.capture('output');
    expect(log?.kind).toBe('log');
    expect(readFileSync(join(evidenceDir, log?.path ?? ''), 'utf8')).toContain('add 5');
    expect(await session.capture('screenshot')).toBeUndefined();
  });

  it('reports the reset → undo crash as signals', async () => {
    const outcomes = await steps([
      { type: 'start' },
      { type: 'wait', prompt: true },
      ...enter('reset'),
      ...enter('undo'),
    ]);
    const crashedWait = outcomes.at(-1);
    expect(crashedWait?.status).toBe('blocked');
    expect(crashedWait?.message).toMatch(/exited with code 1 while waiting for the prompt/);
    expect(crashedWait?.evidence.map((evidence) => evidence.kind)).toEqual(['stdout', 'stderr']);

    const signals = session.drainSignals();
    expect(signals.map((signal) => signal.kind)).toEqual(['stderr', 'process-exit']);
    expect(signals[0]?.message).toContain('TypeError');
    // The crash happens while step 5 (write) or step 6 (wait) runs.
    expect(signals[1]).toMatchObject({
      details: { code: 1 },
      stepId: expect.stringMatching(/^s[56]$/),
    });
    expect(await session.check({ type: 'exit-code', code: 1 })).toEqual({ passed: true });
    expect((await session.check({ type: 'stderr-empty' })).passed).toBe(false);
  });

  it('runs one-shot commands with exec', async () => {
    const [exec] = await steps([{ type: 'exec', args: ['add', '5', 'sub', '2'] }]);
    expect(exec).toMatchObject({ status: 'ok', message: 'The process exited with code 0' });
    expect(await session.check({ type: 'output-matches', pattern: '^3$' })).toEqual({
      passed: true,
    });

    const [failing] = await steps([{ type: 'exec', args: ['bogus'] }]);
    expect(failing?.status).toBe('ok');
    expect(await session.check({ type: 'exit-code', code: 2 })).toEqual({ passed: true });
    // An exec's exit code is state for assertions, not an unexpected exit.
    expect(session.drainSignals()).toEqual([]);
  });

  it('blocks actions the process cannot take', async () => {
    const outcomes = await steps([
      { type: 'write', text: 'add 1' },
      { type: 'signal', signal: 'SIGINT' },
      { type: 'close' },
      { type: 'start' },
      { type: 'start' },
      { type: 'wait', output: 'never printed', ms: 200 },
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'blocked',
      'blocked',
      'blocked',
      'ok',
      'blocked',
      'blocked',
    ]);
    expect(outcomes.at(-1)?.message).toBe(
      'Timed out after 200ms waiting for output /never printed/',
    );
  });

  it('returns error when the executable cannot be started', async () => {
    const missing = await openSession({ command: 'mw-no-such-executable' });
    const [start] = await steps([{ type: 'start' }], missing);
    expect(start).toMatchObject({ status: 'error', message: expect.stringContaining('ENOENT') });
    expect(await missing.check({ type: 'running', expected: false })).toEqual({ passed: true });
  });

  it('treats a requested SIGINT as expected', async () => {
    await steps([
      { type: 'start' },
      { type: 'wait', prompt: true },
      { type: 'signal', signal: 'SIGINT' },
      { type: 'wait', ms: 300 },
    ]);
    expect(await session.check({ type: 'running', expected: false })).toEqual({ passed: true });
    expect(session.drainSignals()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'passes hostile args to a shell command as literal arguments',
    async () => {
      const marker = join(evidenceDir, 'pwned');
      const hostile = [
        `; touch ${marker}`,
        `$(touch ${marker})`,
        `\`touch ${marker}\``,
        "it's",
        '',
        'a  b',
        '$HOME',
        '*',
        '"quoted"',
        '\\',
      ];
      const shelled = await openSession({
        command: process.execPath,
        args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--', 'config arg'],
        shell: true,
      });
      const [exec] = await steps([{ type: 'exec', args: hostile }], shelled);
      expect(exec).toMatchObject({ status: 'ok', message: 'The process exited with code 0' });
      const log = await shelled.capture('output');
      const printed = readFileSync(join(evidenceDir, log?.path ?? ''), 'utf8')
        .split('\n')
        .find((line) => line.startsWith('['));
      expect(JSON.parse(printed ?? 'null')).toEqual(['config arg', ...hostile]);
      expect(existsSync(marker)).toBe(false);
    },
  );

  it('reports no stderr signal for ordinary validation errors', async () => {
    const rejecting = await openSession({
      command: process.execPath,
      args: ['-e', "console.error('error: invalid number'); process.exit(2)"],
    });
    await steps([{ type: 'start' }, { type: 'wait', output: 'never', ms: 2000 }], rejecting);
    expect(rejecting.drainSignals().map((signal) => signal.kind)).toEqual(['process-exit']);
  });

  it('reports termination by a signal nobody sent as a crash', async () => {
    const selfKilling = await openSession({
      command: process.execPath,
      args: ['-e', "setTimeout(() => process.kill(process.pid, 'SIGABRT'), 50)"],
    });
    const outcomes = await steps(
      [{ type: 'start' }, { type: 'wait', output: 'never' }],
      selfKilling,
    );
    expect(outcomes.at(-1)?.message).toMatch(/terminated by SIGABRT while waiting/);
    expect(selfKilling.drainSignals()).toMatchObject([
      { kind: 'crash', message: 'Process was terminated by SIGABRT', stepId: 's2' },
    ]);
  });
});
