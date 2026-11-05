import { setTimeout as delay } from 'node:timers/promises';
import {
  type Action,
  type ActionOutcome,
  type AdapterSession,
  type Assertion,
  type CheckOutcome,
  type Evidence,
  errorMessage,
  type Observation,
  type SessionOptions,
  type Signal,
  type StepContext,
  tail,
} from '@mutationworkflow/core';
import { type CliAction, CliActionSchemas } from './actions.js';
import { type CliAssertion, CliAssertionSchemas } from './assertions.js';
import { compilePattern, endsWithPrompt } from './matching.js';
import type { ResolvedCliOptions } from './options.js';
import { AppProcess, actionArgsProblem, describeExit } from './process.js';
import { createSignal, StderrScanner } from './signals.js';
import { type OutputOffsets, START_OFFSETS, Transcript } from './transcript.js';
import { parseByType } from './vocabulary.js';

type Result = Omit<ActionOutcome, 'evidence'>;
type WaitResult = 'met' | 'exited' | 'timeout';

const OBSERVATION_CHARS = 4_000;
const EVIDENCE_CHARS = 4_000;
const CLOSE_KILL_TIMEOUT_MS = 2_000;
/** Exit codes shells use for "terminated by signal n" (128 + n). */
const SIGNAL_EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGKILL: 137, SIGTERM: 143 };

/**
 * One interaction with the application: at most one process at a time, plus the transcript of
 * everything every process in the session printed.
 */
export class CliSession implements AdapterSession {
  private readonly transcript = new Transcript();
  private readonly stderr = new StderrScanner();
  private readonly prompt: RegExp | undefined;
  private readonly listeners = new Set<() => void>();
  private signals: Signal[] = [];
  private proc: AppProcess | undefined;
  /** The workflow ended the process (close, exec, session close); its exit is not an app error. */
  private expectedExit = false;
  private requestedSignals = new Set<NodeJS.Signals>();
  private stepId: string | undefined;
  private stepStart: OutputOffsets = START_OFFSETS;
  /** Output position when input was last sent; `wait` looks at what came after it. */
  private inputStart: OutputOffsets = START_OFFSETS;

  constructor(
    private readonly options: ResolvedCliOptions,
    private readonly session: SessionOptions,
    private readonly onClose: () => void = () => undefined,
  ) {
    this.prompt =
      options.promptPattern === undefined ? undefined : compilePattern(options.promptPattern);
  }

  private get running(): boolean {
    return this.proc?.running ?? false;
  }

  async perform(action: Action, context: StepContext = {}): Promise<ActionOutcome> {
    this.stepId = context.stepId;
    this.stepStart = this.transcript.offsets();
    this.transcript.mark(
      `step ${context.stepId ?? context.index ?? '?'}: ${JSON.stringify(action)}`,
    );
    let result: Result;
    try {
      result = await this.run(parseByType(CliActionSchemas, 'action', action));
    } catch (error) {
      result = { status: 'error', message: errorMessage(error) };
    }
    if (result.status === 'ok') return { ...result, evidence: [] };
    this.session.logger.debug('Action not performed', { action, ...result });
    return { ...result, evidence: this.outputEvidence() };
  }

  private async run(action: CliAction): Promise<Result> {
    switch (action.type) {
      case 'start':
        return this.start(action.args);
      case 'exec':
        return this.exec(action.args);
      case 'write':
        return this.write(action.newline ? `${action.text}\n` : action.text);
      case 'wait':
        return this.wait(action);
      case 'signal':
        return this.signal(action.signal);
      case 'close':
        return this.closeProcess();
    }
  }

  private async start(args: string[] = []): Promise<Result> {
    if (this.running) return { status: 'blocked', message: 'The process is already running' };
    const problem = actionArgsProblem(this.options.shell, args);
    if (problem) return { status: 'blocked', message: problem };
    const proc = await this.spawn(args);
    return { status: 'ok', message: `Started ${proc.commandLine}` };
  }

  private async exec(args: string[] = []): Promise<Result> {
    if (this.running) return { status: 'blocked', message: 'A process is already running' };
    const problem = actionArgsProblem(this.options.shell, args);
    if (problem) return { status: 'blocked', message: problem };
    const proc = await this.spawn(args, true);
    proc.endInput();
    const timeoutMs = this.session.stepTimeoutMs;
    if (!(await proc.exitsWithin(timeoutMs))) {
      proc.kill('SIGKILL');
      await proc.closed;
      return { status: 'error', message: `The process did not exit within ${timeoutMs}ms` };
    }
    const exit = await proc.closed;
    return { status: 'ok', message: `The process ${describeExit(exit)}` };
  }

  private async write(text: string): Promise<Result> {
    const proc = this.proc;
    if (!proc?.running) return { status: 'blocked', message: 'The process is not running' };
    this.inputStart = this.transcript.offsets();
    try {
      await proc.write(text);
    } catch (error) {
      return {
        status: 'blocked',
        message: `The process is not accepting input: ${errorMessage(error)}`,
      };
    }
    return { status: 'ok' };
  }

  private async wait(action: Extract<CliAction, { type: 'wait' }>): Promise<Result> {
    const conditions: Array<{ label: string; met: () => boolean }> = [];
    if (action.output !== undefined) {
      const pattern = compilePattern(action.output);
      conditions.push({
        label: `output /${action.output}/`,
        met: () => pattern.test(this.transcript.output('both', this.inputStart)),
      });
    }
    if (action.prompt) {
      const prompt = this.prompt;
      if (!prompt) {
        return { status: 'error', message: 'wait.prompt needs the target option promptPattern' };
      }
      conditions.push({
        label: 'the prompt',
        met: () => endsWithPrompt(this.transcript.output('stdout', this.inputStart), prompt),
      });
    }
    if (conditions.length === 0) {
      await delay(action.ms ?? 0);
      return { status: 'ok' };
    }

    const timeoutMs = action.ms ?? this.session.stepTimeoutMs;
    const label = conditions.map((condition) => condition.label).join(' and ');
    const result = await this.waitFor(() => conditions.every((c) => c.met()), timeoutMs);
    if (result === 'met') return { status: 'ok' };
    if (result === 'exited') {
      const exit = this.proc?.exit;
      const how = exit ? describeExit(exit) : 'was not started';
      return { status: 'blocked', message: `The process ${how} while waiting for ${label}` };
    }
    return { status: 'blocked', message: `Timed out after ${timeoutMs}ms waiting for ${label}` };
  }

  private async signal(signal: NodeJS.Signals): Promise<Result> {
    const proc = this.proc;
    if (!proc?.running) return { status: 'blocked', message: 'The process is not running' };
    this.requestedSignals.add(signal);
    this.inputStart = this.transcript.offsets();
    proc.kill(signal);
    return { status: 'ok', message: `Sent ${signal}` };
  }

  private async closeProcess(): Promise<Result> {
    const proc = this.proc;
    if (!proc?.running) return { status: 'blocked', message: 'The process is not running' };
    this.expectedExit = true;
    proc.endInput();
    const { exitTimeoutMs } = this.options;
    let how = 'after end of input';
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      if (await proc.exitsWithin(exitTimeoutMs)) break;
      how = `after ${signal}`;
      proc.kill(signal);
    }
    const exit = await proc.closed;
    return { status: 'ok', message: `The process ${describeExit(exit)} ${how}` };
  }

  /** Spawn the configured command; `oneShot` marks its exit as expected from the start. */
  private async spawn(args: string[], oneShot = false): Promise<AppProcess> {
    const { command, cwd, env, shell } = this.options;
    const proc = await AppProcess.spawn(
      { command, args: [...this.options.args, ...args], cwd, env, shell },
      this.transcript,
      (stream, chunk) => {
        if (stream === 'stderr') this.stderr.push(chunk, this.stepId);
        this.notify();
      },
    );
    this.proc = proc;
    this.expectedExit = oneShot;
    this.requestedSignals = new Set();
    this.inputStart = this.transcript.offsets();
    this.transcript.mark(`$ ${proc.commandLine}`);
    this.session.logger.debug('Started process', { command: proc.commandLine });
    void proc.closed.then(() => this.onExit(proc));
    return proc;
  }

  private onExit(proc: AppProcess): void {
    const exit = proc.exit;
    if (!exit) return;
    this.transcript.mark(`process ${describeExit(exit)}`);
    const stderr = this.stderr.flush();
    if (stderr) this.signals.push(stderr);
    if (!this.expectedExit) {
      const requested = [...this.requestedSignals];
      if (exit.signal && !requested.includes(exit.signal)) {
        this.signals.push(
          createSignal('crash', `Process was terminated by ${exit.signal}`, this.stepId, {
            signal: exit.signal,
          }),
        );
      } else if (
        exit.code !== null &&
        exit.code !== 0 &&
        !requested.some((signal) => SIGNAL_EXIT_CODES[signal] === exit.code)
      ) {
        this.signals.push(
          createSignal(
            'process-exit',
            `Process exited unexpectedly with code ${exit.code}`,
            this.stepId,
            {
              code: exit.code,
            },
          ),
        );
      }
    }
    this.notify();
  }

  /** Resolve when `predicate` holds, the process is no longer running, or `timeoutMs` passes. */
  private waitFor(predicate: () => boolean, timeoutMs: number): Promise<WaitResult> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (result: WaitResult) => {
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(result);
      };
      const check = () => {
        if (predicate()) finish('met');
        else if (!this.running) finish('exited');
      };
      timer = setTimeout(() => finish('timeout'), timeoutMs);
      this.listeners.add(check);
      check();
    });
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  async check(assertion: Assertion): Promise<CheckOutcome> {
    let parsed: CliAssertion;
    try {
      parsed = parseByType(CliAssertionSchemas, 'assertion', assertion);
    } catch (error) {
      return { passed: false, message: errorMessage(error) };
    }
    return this.evaluate(parsed);
  }

  private evaluate(assertion: CliAssertion): CheckOutcome {
    switch (assertion.type) {
      case 'output-matches':
      case 'output-not-matches': {
        const text = this.transcript.output(assertion.stream, this.since(assertion.since));
        const match = compilePattern(assertion.pattern).exec(text);
        const where = `${assertion.stream === 'both' ? '' : `${assertion.stream} `}output since the ${assertion.since} began`;
        if (assertion.type === 'output-matches') {
          return match
            ? { passed: true }
            : {
                passed: false,
                message: `/${assertion.pattern}/ not found in ${where}; it ends with ${JSON.stringify(tail(text, 200))}`,
              };
        }
        return match
          ? { passed: false, message: `Found ${JSON.stringify(match[0])} in ${where}` }
          : { passed: true };
      }
      case 'exit-code': {
        const proc = this.proc;
        if (!proc) return { passed: false, message: 'No process was started' };
        if (!proc.exit) return { passed: false, message: 'The process is still running' };
        return proc.exit.code === assertion.code
          ? { passed: true }
          : { passed: false, message: `The process ${describeExit(proc.exit)}` };
      }
      case 'running':
        return this.running === assertion.expected
          ? { passed: true }
          : {
              passed: false,
              message: this.running ? 'The process is still running' : 'The process is not running',
            };
      case 'stderr-empty': {
        const text = this.transcript.output('stderr', this.since(assertion.since));
        return text.trim() === ''
          ? { passed: true }
          : { passed: false, message: `stderr: ${JSON.stringify(tail(text, 300))}` };
      }
    }
  }

  /**
   * Where `since` searches begin. For `step` that is the start of the current step, or the last
   * input when it came earlier, so a `wait` step's assertions see the answer to the preceding
   * `write` even if it arrived before the wait began.
   */
  private since(since: 'step' | 'session'): OutputOffsets {
    if (since === 'session') return START_OFFSETS;
    return this.inputStart.both < this.stepStart.both ? this.inputStart : this.stepStart;
  }

  async observe(): Promise<Observation> {
    const transcript = this.transcript.render();
    return {
      summary: `${this.header()}\n\n${transcript === '' ? '(no output yet)' : tail(transcript, OBSERVATION_CHARS)}`,
    };
  }

  private header(): string {
    const proc = this.proc;
    if (!proc) return 'No process started yet.';
    if (!proc.exit) return `$ ${proc.commandLine} (running)`;
    return `$ ${proc.commandLine} (${describeExit(proc.exit).replace(/^was /, '')})`;
  }

  drainSignals(): Signal[] {
    const stderr = this.stderr.flush();
    if (stderr) this.signals.push(stderr);
    const drained = this.signals;
    this.signals = [];
    return drained;
  }

  async capture(
    kind: 'screenshot' | 'dom' | 'output',
    label = 'transcript',
  ): Promise<Evidence | undefined> {
    if (kind !== 'output') return undefined;
    return this.session.evidence.file('log', this.transcript.render(), 'txt', {
      label,
      ...this.stepMeta(),
    });
  }

  private outputEvidence(): Evidence[] {
    const evidence: Evidence[] = [];
    for (const stream of ['stdout', 'stderr'] as const) {
      const text = this.transcript.output(stream);
      if (text === '') continue;
      evidence.push(
        this.session.evidence.text(stream, tail(text, EVIDENCE_CHARS), {
          label: stream,
          ...this.stepMeta(),
        }),
      );
    }
    return evidence;
  }

  private stepMeta(): { stepId?: string } {
    return this.stepId === undefined ? {} : { stepId: this.stepId };
  }

  async close(): Promise<void> {
    const proc = this.proc;
    if (proc?.running) {
      this.expectedExit = true;
      proc.kill('SIGKILL');
      await proc.exitsWithin(CLOSE_KILL_TIMEOUT_MS);
    }
    this.onClose();
  }
}
