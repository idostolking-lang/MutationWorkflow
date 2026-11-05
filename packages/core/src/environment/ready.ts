import { connect } from 'node:net';
import type { ReadyCheck } from '../schema/target.js';
import { describeExit, type ShellProcess, settlesWithin } from './process.js';

const POLL_INTERVAL_MS = 250;
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Poll every configured part of `check` (url, port, output) until all pass. Rejects with a
 * plain Error when the process exits first or `check.timeoutMs` elapses.
 */
export async function waitUntilReady(check: ReadyCheck, proc: ShellProcess): Promise<void> {
  const deadline = Date.now() + check.timeoutMs;
  const output = check.output === undefined ? undefined : new RegExp(check.output, 'm');

  for (;;) {
    if (proc.exit) throw new Error(`Start command ${describeExit(proc.exit)} before it was ready`);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Not ready after ${check.timeoutMs}ms (${describeCheck(check)})`);
    }
    const probeTimeout = Math.min(PROBE_TIMEOUT_MS, remaining);
    if (
      (!output || output.test(proc.output.text)) &&
      (check.port === undefined || (await canConnect(check.port, probeTimeout))) &&
      (check.url === undefined || (await urlReady(check.url, check.status, probeTimeout)))
    ) {
      return;
    }
    // Wake early if the process exits, so a crash fails fast instead of at the deadline.
    await settlesWithin(
      proc.exited,
      Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())),
    );
  }
}

/** Fetch `url` once; true when it answers with `status`, or with any status below 500. */
export async function urlReady(
  url: string,
  status: number | undefined,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    await response.body?.cancel();
    return status === undefined ? response.status < 500 : response.status === status;
  } catch {
    return false;
  }
}

/** True when a TCP connection to `port` on localhost succeeds within `timeoutMs`. */
export function canConnect(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((settle) => {
    const socket = connect({ port, host: 'localhost' });
    const finish = (ok: boolean) => {
      socket.destroy();
      settle(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function describeCheck(check: ReadyCheck): string {
  const parts: string[] = [];
  if (check.url !== undefined) parts.push(`url ${check.url}`);
  if (check.port !== undefined) parts.push(`port ${check.port}`);
  if (check.output !== undefined) parts.push(`output /${check.output}/`);
  return `waiting for ${parts.join(', ')}`;
}
