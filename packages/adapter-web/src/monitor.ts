import { normalizeSignature, nowIso, type Signal, type SignalKind } from '@mutationworkflow/core';
import type { ConsoleMessage, Page, Request, Response } from 'playwright';
import { sleep } from './util.js';

const CONSOLE_BUFFER_SIZE = 200;
const QUIET_WINDOW_MS = 100;
const SETTLE_POLL_MS = 20;

/** Request failures caused by the browser cancelling a request, not by the application. */
const ABORTED_REQUEST = /ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i;

/**
 * Chromium logs a console error for every failed resource load; those are already reported as
 * `http-error` or `network-error` signals, so they are not repeated as `console-error`.
 */
const RESOURCE_LOAD_ERROR = /^Failed to load resource:/;

/** Long-lived requests that never finish and must not delay settling. */
const STREAMING_RESOURCE_TYPES = new Set(['eventsource', 'websocket']);

/**
 * Watches one page: turns console errors, uncaught exceptions, failed requests, error responses
 * and crashes into signals, keeps recent console output for evidence, and tracks in-flight
 * requests so the session can wait for the page to settle after an action.
 */
export class PageMonitor {
  /** Step the signals are attributed to: the step in progress, or the last one performed. */
  stepId: string | undefined;
  private signals: Signal[] = [];
  private readonly consoleLines: string[] = [];
  private readonly pending = new Set<Request>();
  /** Requests the scope route aborted: the adapter's doing, not the application's. */
  private readonly blocked = new WeakSet<Request>();
  private crashed = false;

  constructor(page: Page) {
    page.on('console', (message) => this.onConsole(message));
    page.on('pageerror', (error) => {
      const message = `${error.name}: ${error.message}`;
      this.log(`[uncaught] ${message}`);
      this.emit('uncaught-exception', message);
    });
    page.on('request', (request) => {
      if (!STREAMING_RESOURCE_TYPES.has(request.resourceType())) this.pending.add(request);
    });
    page.on('requestfinished', (request) => this.pending.delete(request));
    page.on('requestfailed', (request) => this.onRequestFailed(request));
    page.on('response', (response) => this.onResponse(response));
    page.on('crash', () => {
      this.crashed = true;
      this.emit('crash', `Page crashed at ${page.url()}`);
    });
  }

  /** True once the page has crashed; it cannot be used any more. */
  get hasCrashed(): boolean {
    return this.crashed;
  }

  /** Signals collected since the previous call. */
  drain(): Signal[] {
    const drained = this.signals;
    this.signals = [];
    return drained;
  }

  /**
   * Record that the scope route aborted a request, so its failure is logged as such and not
   * reported as a `network-error` signal.
   */
  markBlocked(request: Request, reason: string): void {
    this.blocked.add(request);
    this.log(`[scope] blocked ${request.method()} ${request.url()}: ${reason}`);
  }

  /** The most recent console output, oldest first. */
  recentConsole(): string[] {
    return [...this.consoleLines];
  }

  /**
   * Wait until no request has been in flight for a short quiet window, or `maxMs` elapses.
   * Lets responses (and the signals they cause) land in the step that triggered them.
   */
  async settle(maxMs: number): Promise<boolean> {
    const deadline = Date.now() + maxMs;
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      await sleep(SETTLE_POLL_MS);
      if (this.pending.size > 0) {
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= QUIET_WINDOW_MS) {
        return true;
      }
    }
    return false;
  }

  private onConsole(message: ConsoleMessage): void {
    const text = message.text();
    this.log(`[${message.type()}] ${text}`);
    if (message.type() === 'error' && !RESOURCE_LOAD_ERROR.test(text)) {
      this.emit('console-error', text);
    }
  }

  private onRequestFailed(request: Request): void {
    this.pending.delete(request);
    if (this.blocked.has(request)) return;
    const failure = request.failure()?.errorText ?? 'unknown failure';
    if (ABORTED_REQUEST.test(failure)) return;
    const message = `${request.method()} ${request.url()} failed: ${failure}`;
    this.log(`[network] ${message}`);
    this.emit('network-error', message, { url: request.url(), method: request.method(), failure });
  }

  private onResponse(response: Response): void {
    // A response counts as settled once its headers arrive: bodies the page never reads (for
    // example of an error response) may never report "requestfinished".
    this.pending.delete(response.request());
    const status = response.status();
    if (status < 400) return;
    const method = response.request().method();
    const url = response.url();
    const message = `${method} ${url} returned ${status} ${response.statusText()}`.trim();
    this.log(`[http] ${message}`);
    this.emit('http-error', message, { status, url, method });
  }

  private emit(kind: SignalKind, message: string, details?: Record<string, unknown>): void {
    this.signals.push({
      kind,
      message,
      signature: normalizeSignature(`${kind} ${message}`),
      ...(this.stepId === undefined ? {} : { stepId: this.stepId }),
      ...(details === undefined ? {} : { details }),
      at: nowIso(),
    });
  }

  private log(line: string): void {
    this.consoleLines.push(line);
    if (this.consoleLines.length > CONSOLE_BUFFER_SIZE) this.consoleLines.shift();
  }
}
