import { normalizeSignature, nowIso, type Signal, truncate } from '@mutationworkflow/core';
import { errorHeadline, isErrorLine } from './matching.js';

const MAX_LINES = 200;
const MAX_DETAIL_LINES = 20;

/** Build a signal with a stable signature. */
export function createSignal(
  kind: Signal['kind'],
  message: string,
  stepId: string | undefined,
  details?: Record<string, unknown>,
): Signal {
  return {
    kind,
    message: truncate(message, 500),
    signature: normalizeSignature(`${kind} ${message}`),
    ...(stepId === undefined ? {} : { stepId }),
    ...(details === undefined ? {} : { details }),
    at: nowIso(),
  };
}

/**
 * Collects stderr between drains and turns each burst that looks like an error into one
 * `stderr` signal, named by its most telling line, so a stack trace yields one signal rather
 * than one per frame.
 */
export class StderrScanner {
  private partial = '';
  private lines: string[] = [];
  private stepId: string | undefined;

  push(chunk: string, stepId: string | undefined): void {
    if (this.lines.length === 0 && this.partial === '') this.stepId = stepId;
    const parts = (this.partial + chunk).split(/\r?\n/);
    this.partial = parts.pop() ?? '';
    for (const line of parts) {
      if (this.lines.length < MAX_LINES) this.lines.push(line);
    }
  }

  /** Signal for everything collected so far, if any of it looks like an error; then reset. */
  flush(): Signal | undefined {
    const lines = this.partial === '' ? this.lines : [...this.lines, this.partial];
    const stepId = this.stepId;
    this.lines = [];
    this.partial = '';
    this.stepId = undefined;
    const headline = errorHeadline(lines);
    if (headline === undefined) return undefined;
    return createSignal('stderr', headline, stepId, {
      lines: lines.filter(isErrorLine).slice(0, MAX_DETAIL_LINES),
    });
  }
}
