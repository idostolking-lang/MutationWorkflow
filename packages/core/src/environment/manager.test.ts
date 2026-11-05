import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TargetConfigInput, TargetConfigSchema } from '../schema/target.js';
import { MutationWorkflowError } from '../util/errors.js';
import { createLogger, silentLogger } from '../util/logger.js';
import { EnvironmentManager, type RunningEnvironment, withEnvironment } from './manager.js';
import { canConnect } from './ready.js';

const HTTP_SERVER = `node -e "require('node:http').createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), () => console.log('listening'))"`;
const IDLE = `node -e "setInterval(() => {}, 1000)"`;

function target(input: Partial<TargetConfigInput>) {
  return TargetConfigSchema.parse({ id: 'app', kind: 'web', ...input });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port')),
      );
    });
  });
}

async function startFailure(manager: EnvironmentManager, config: ReturnType<typeof target>) {
  const error = await manager.start(config).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(MutationWorkflowError);
  expect((error as MutationWorkflowError).code).toBe('ENVIRONMENT_FAILED');
  return error as MutationWorkflowError;
}

describe('EnvironmentManager', () => {
  let rootDir: string;
  let manager: EnvironmentManager;
  const running: RunningEnvironment[] = [];

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'mw-env-'));
    manager = new EnvironmentManager({ rootDir, logger: silentLogger });
  });

  afterEach(async () => {
    await Promise.all(running.splice(0).map((env) => env.stop()));
    rmSync(rootDir, { recursive: true, force: true });
  });

  async function start(config: ReturnType<typeof target>): Promise<RunningEnvironment> {
    const env = await manager.start(config);
    running.push(env);
    return env;
  }

  it('waits for a url ready check and stops the server', async () => {
    const port = await freePort();
    const baseUrl = `http://localhost:${port}`;
    const env = await start(
      target({
        options: { baseUrl },
        environment: {
          start: { command: HTTP_SERVER, env: { PORT: String(port) }, ready: { url: baseUrl } },
        },
      }),
    );
    expect(env.baseUrl).toBe(baseUrl);
    expect(await (await fetch(baseUrl)).text()).toBe('ok');
    expect(env.logs).toContain('listening');

    await env.stop();
    await env.stop();
    expect(await canConnect(port, 500)).toBe(false);
  });

  it('waits for a port ready check', async () => {
    const port = await freePort();
    await start(
      target({
        environment: {
          start: { command: HTTP_SERVER, env: { PORT: String(port) }, ready: { port } },
        },
      }),
    );
    expect(await canConnect(port, 500)).toBe(true);
  });

  it('waits for an output ready check', async () => {
    const env = await start(
      target({
        environment: {
          start: {
            command: `node -e "setTimeout(() => console.log('server ready on 4000'), 100); setInterval(() => {}, 1000)"`,
            ready: { output: 'ready on \\d+' },
          },
        },
      }),
    );
    expect(env.logs).toContain('server ready on 4000');
  });

  it('fails fast with the output when the start command exits', async () => {
    const started = Date.now();
    const error = await startFailure(
      manager,
      target({
        environment: {
          start: {
            command: `node -e "console.error('boom: missing config'); process.exit(3)"`,
            ready: { output: 'never', timeoutMs: 20_000 },
          },
        },
      }),
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(error.message).toContain('exited with code 3');
    expect(error.message).toContain('boom: missing config');
  });

  it('fails when the ready check times out', async () => {
    const error = await startFailure(
      manager,
      target({
        environment: {
          start: {
            command: `${IDLE} && echo unreachable`,
            ready: { output: 'never', timeoutMs: 400 },
          },
        },
      }),
    );
    expect(error.message).toContain('Not ready after 400ms');
  });

  it('kills a process that ignores the stop signal after stopTimeoutMs', async () => {
    const port = await freePort();
    const env = await start(
      target({
        environment: {
          start: {
            command: `node -e "process.on('SIGTERM', () => {}); require('node:net').createServer().listen(Number(process.env.PORT))"`,
            env: { PORT: String(port) },
            ready: { port },
            stopTimeoutMs: 300,
          },
        },
      }),
    );
    await env.stop();
    expect(await canConnect(port, 500)).toBe(false);
  });

  it('runs the reset command from cwd', async () => {
    const env = await start(
      target({
        environment: {
          reset: { command: `node -e "require('node:fs').writeFileSync('marker.txt', 'reset')"` },
        },
      }),
    );
    await env.reset();
    expect(existsSync(join(rootDir, 'marker.txt'))).toBe(true);
  });

  it('rejects when the reset command fails or times out', async () => {
    const failing = await start(
      target({
        environment: {
          reset: { command: `node -e "console.log('seed failed'); process.exit(2)"` },
        },
      }),
    );
    await expect(failing.reset()).rejects.toMatchObject({
      code: 'ENVIRONMENT_FAILED',
      message: expect.stringContaining('seed failed'),
    });
    // Only one environment per target runs at a time; release it before starting the next.
    await failing.stop();

    const slow = await start(target({ environment: { reset: { command: IDLE, timeoutMs: 300 } } }));
    await expect(slow.reset()).rejects.toThrow('did not finish within 300ms');
  });

  it('treats a missing reset command as a no-op', async () => {
    await expect((await start(target({}))).reset()).resolves.toBeUndefined();
  });

  it('warns but continues when an external base URL is unreachable', async () => {
    const lines: string[] = [];
    const logged = new EnvironmentManager({
      rootDir,
      logger: createLogger({ level: 'warn', write: (line) => lines.push(line) }),
    });
    const baseUrl = `http://localhost:${await freePort()}`;
    const env = await logged.start(target({ options: { baseUrl } }));
    expect(env.baseUrl).toBe(baseUrl);
    expect(lines.join('\n')).toContain('not reachable');
  });

  it('withEnvironment stops the environment when the callback throws', async () => {
    const port = await freePort();
    const config = target({
      environment: {
        start: { command: HTTP_SERVER, env: { PORT: String(port) }, ready: { port } },
      },
    });
    await expect(
      withEnvironment(manager, config, async () => {
        expect(await canConnect(port, 500)).toBe(true);
        throw new Error('workflow failed');
      }),
    ).rejects.toThrow('workflow failed');
    expect(await canConnect(port, 500)).toBe(false);
  });
});
