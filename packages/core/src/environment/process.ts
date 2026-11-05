import { type ChildProcess, spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Command } from '../schema/target.js';

const IS_WINDOWS = process.platform === 'win32';
/** How long to wait for SIGKILLed processes to disappear. */
const KILL_GRACE_MS = 2_000;
const GROUP_POLL_MS = 25;

/** Keeps only the most recent output of a process, so a chatty server cannot exhaust memory. */
export class OutputBuffer {
  private buffer = '';

  constructor(private readonly maxLength = 64 * 1024) {}

  append(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > this.maxLength) {
      this.buffer = this.buffer.slice(this.buffer.length - this.maxLength);
    }
  }

  get text(): string {
    return this.buffer;
  }

  /** The last `count` lines, for error messages. */
  lastLines(count: number): string {
    return this.buffer.trimEnd().split(/\r?\n/).slice(-count).join('\n');
  }
}

/** A shell command running in its own process group, with its output captured. */
export interface ShellProcess {
  readonly child: ChildProcess;
  readonly output: OutputBuffer;
  /** Settles when the process has exited; never rejects. */
  readonly exited: Promise<ExitInfo>;
  /** Set once the process has exited. */
  readonly exit: ExitInfo | undefined;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process could not be spawned at all. */
  error?: Error;
}

/** Process groups still alive, killed if this process exits without stopping them. */
const liveGroups = new Set<ChildProcess>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const child of liveGroups) killGroup(child, 'SIGKILL');
  });
}

/**
 * Run `command.command` through the shell from `cwd` (resolved against `rootDir`), with the
 * configured variables merged over the current environment. On POSIX the process leads a new
 * process group so it can be stopped together with everything it started.
 */
export function spawnShell(
  command: Command,
  rootDir: string,
  output = new OutputBuffer(),
): ShellProcess {
  installExitHook();
  const child = spawn(command.command, {
    cwd: resolve(rootDir, command.cwd ?? '.'),
    env: { ...process.env, ...command.env },
    shell: true,
    detached: !IS_WINDOWS,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  liveGroups.add(child);
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => output.append(chunk));
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => output.append(chunk));

  const state: { exit: ExitInfo | undefined } = { exit: undefined };
  const exited = new Promise<ExitInfo>((settle) => {
    const done = (info: ExitInfo) => {
      if (state.exit) return;
      state.exit = info;
      liveGroups.delete(child);
      settle(info);
    };
    child.once('exit', (code, signal) => done({ code, signal }));
    child.once('error', (error) => done({ code: null, signal: null, error }));
  });

  return {
    child,
    output,
    exited,
    get exit() {
      return state.exit;
    },
  };
}

/** Send `signal` to the process group (POSIX) or the process (Windows); ignores dead processes. */
export function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (!IS_WINDOWS && child.pid !== undefined) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // Already gone.
  }
}

/**
 * Stop a process group: send `signal`, wait up to `timeoutMs` for every process in the group to
 * exit, then SIGKILL whatever is left. Resolves once the group is gone (or after a short grace
 * period if a process cannot be reaped).
 */
export async function stopGroup(
  proc: ShellProcess,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<void> {
  if (!isGroupAlive(proc)) return;
  killGroup(proc.child, signal);
  if (await waitForGroupExit(proc, timeoutMs)) return;
  killGroup(proc.child, 'SIGKILL');
  await waitForGroupExit(proc, KILL_GRACE_MS);
}

function isGroupAlive(proc: ShellProcess): boolean {
  const pgid = proc.child.pid;
  if (IS_WINDOWS || pgid === undefined) return proc.exit === undefined;
  try {
    process.kill(-pgid, 0);
  } catch {
    return false;
  }
  return process.platform === 'linux' ? hasLiveLinuxMember(pgid) : true;
}

/**
 * Orphaned members become zombies until the init process reaps them, which minimal container
 * inits do late or never. Zombies hold no ports or files, so on Linux they do not count.
 */
function hasLiveLinuxMember(pgid: number): boolean {
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
    } catch {
      continue;
    }
    // Fields after "pid (comm) ": state, ppid, pgrp, ...
    const [state, , pgrp] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (pgrp === String(pgid) && (!isDead(state) || hasLiveThreads(entry))) return true;
  }
  return false;
}

function isDead(state: string | undefined): boolean {
  return state === 'Z' || state === 'X';
}

/** A zombie group leader can still have threads tearing down, holding its sockets open. */
function hasLiveThreads(pid: string): boolean {
  try {
    return readdirSync(`/proc/${pid}/task`).length > 1;
  } catch {
    return false;
  }
}

/** The leader exiting is not enough: a shell's children may still be shutting down. */
async function waitForGroupExit(proc: ShellProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  await settlesWithin(proc.exited, timeoutMs);
  while (isGroupAlive(proc)) {
    if (Date.now() >= deadline) return false;
    await delay(GROUP_POLL_MS);
  }
  return true;
}

/** True when `promise` settles within `ms`. */
export async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((settle) => {
    timer = setTimeout(() => settle(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Human-readable description of how a process ended. */
export function describeExit(exit: ExitInfo): string {
  if (exit.error) return `failed to start: ${exit.error.message}`;
  if (exit.signal) return `was terminated by ${exit.signal}`;
  return `exited with code ${exit.code}`;
}
