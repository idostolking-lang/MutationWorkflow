import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { Transcript } from './transcript.js';

const IS_WINDOWS = process.platform === 'win32';

export interface ExitStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface SpawnRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  shell: boolean;
}

/** A child process whose output is recorded into a transcript. */
export class AppProcess {
  readonly commandLine: string;
  /** Settles after the process exited and its output streams closed. */
  readonly closed: Promise<ExitStatus>;
  private exitStatus: ExitStatus | undefined;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    request: SpawnRequest,
  ) {
    this.commandLine = [request.command, ...request.args].map(quote).join(' ');
    this.closed = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        this.exitStatus = { code, signal };
        resolve(this.exitStatus);
      });
    });
  }

  /**
   * Spawn with plain pipes (no pseudo-terminal). On POSIX the process leads its own process
   * group, so signals reach it and its children the way Ctrl+C does in a terminal.
   * Rejects when the executable cannot be started.
   */
  static async spawn(
    request: SpawnRequest,
    transcript: Transcript,
    onOutput: (stream: 'stdout' | 'stderr', chunk: string) => void,
  ): Promise<AppProcess> {
    const child = spawn(request.command, spawnArgs(request.args, request.shell), {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      shell: request.shell,
      stdio: 'pipe',
      detached: !IS_WINDOWS,
      windowsHide: true,
    });
    const proc = new AppProcess(child, request);
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].setEncoding('utf8').on('data', (chunk: string) => {
        transcript.append(stream, chunk);
        onOutput(stream, chunk);
      });
    }
    // Writing to a process that has exited raises EPIPE here; `write` reports it instead.
    child.stdin.on('error', () => undefined);
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    return proc;
  }

  get exit(): ExitStatus | undefined {
    return this.exitStatus;
  }

  get running(): boolean {
    return this.exitStatus === undefined;
  }

  /** Write to stdin; rejects when the process no longer accepts input. */
  write(text: string): Promise<void> {
    const { stdin } = this.child;
    if (!stdin.writable) return Promise.reject(new Error('stdin is closed'));
    return new Promise((resolve, reject) => {
      stdin.write(text, (error) => (error ? reject(error) : resolve()));
    });
  }

  endInput(): void {
    this.child.stdin.end();
  }

  /** Send `signal` to the process group (POSIX) or the process (Windows). */
  kill(signal: NodeJS.Signals): void {
    try {
      if (!IS_WINDOWS && this.child.pid !== undefined) {
        process.kill(-this.child.pid, signal);
      } else {
        this.child.kill(signal);
      }
    } catch {
      // Already gone.
    }
  }

  /** True when the process exits within `ms`. */
  async exitsWithin(ms: number): Promise<boolean> {
    if (!this.running) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    try {
      return await Promise.race([this.closed.then(() => true as const), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Human-readable description of how a process ended. */
export function describeExit(exit: ExitStatus): string {
  return exit.signal ? `was terminated by ${exit.signal}` : `exited with code ${exit.code}`;
}

/** Why per-action `args` cannot be used with these options, or undefined when they can. */
export function actionArgsProblem(
  shell: boolean,
  actionArgs: ReadonlyArray<string>,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!shell || platform !== 'win32' || actionArgs.length === 0) return undefined;
  return 'Per-action args are not supported when the target option shell is true on Windows (cmd.exe cannot quote them safely); configure the arguments in the target options or turn shell off';
}

/**
 * The arguments to hand to `spawn`. With `shell`, Node joins command and arguments with spaces
 * and gives the result to the shell, so on POSIX every argument is single-quoted and reaches the
 * program as one literal argument. On Windows arguments are passed as they are; per-action
 * arguments are refused there (see `actionArgsProblem`).
 */
export function spawnArgs(
  args: ReadonlyArray<string>,
  shell: boolean,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return shell && platform !== 'win32' ? args.map(shellQuote) : [...args];
}

/** Quote `arg` for a POSIX shell: wrap in single quotes, closing them around each `'`. */
export function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg);
}
