import type { OracleResult, Severity, Signal } from '../../schema/index.js';
import type { Oracle, OracleContext } from '../types.js';

const SEVERITY_BY_KIND: Record<Signal['kind'], Severity> = {
  crash: 'critical',
  'process-exit': 'critical',
  'uncaught-exception': 'high',
  'http-error': 'high',
  'error-page': 'high',
  'network-error': 'medium',
  'console-error': 'medium',
  stderr: 'medium',
};

/**
 * The application reported an error on its own: a crash, an uncaught exception, a server error,
 * a failed request. These are bugs regardless of what the workflow expected, which makes them
 * the most reliable signal on mutated workflows.
 */
export const appErrorOracle: Oracle = {
  id: 'app-error',
  description:
    'Fails when the application emits error signals (crashes, exceptions, 5xx responses)',
  evaluate(context: OracleContext): OracleResult[] {
    const ignoreKinds = new Set(context.config.ignoreSignalKinds);
    const ignorePatterns = context.config.ignoreSignals.map((pattern) => new RegExp(pattern, 'i'));
    const bySignature = new Map<string, { signal: Signal; count: number }>();

    for (const signal of context.signals) {
      if (ignoreKinds.has(signal.kind)) continue;
      if (ignorePatterns.some((pattern) => pattern.test(signal.message))) continue;
      if (signal.kind === 'http-error') {
        const status = Number(signal.details?.['status']);
        if (Number.isFinite(status) && status < context.config.httpErrorStatus) continue;
      }
      const existing = bySignature.get(signal.signature);
      if (existing) {
        existing.count += 1;
      } else {
        bySignature.set(signal.signature, { signal, count: 1 });
      }
    }

    return [...bySignature.values()].map(({ signal, count }) => ({
      oracle: 'app-error',
      verdict: 'fail' as const,
      severity: SEVERITY_BY_KIND[signal.kind],
      // Status codes are numbers, which signature normalisation collapses; keep them distinct.
      signature: `app-error:${signal.signature}:${signal.details?.['status'] ?? ''}`,
      summary: `${signal.kind}: ${signal.message}${count > 1 ? ` (${count} times)` : ''}`,
      details: { kind: signal.kind, stepId: signal.stepId, count, ...signal.details },
    }));
  },
};
