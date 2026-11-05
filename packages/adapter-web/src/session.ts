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
  truncate,
} from '@mutationworkflow/core';
import type { BrowserContext, Page } from 'playwright';
import { z } from 'zod';
import { WebActionSchema } from './actions.js';
import { evaluateAssertion, WebAssertionSchema } from './assertions.js';
import { PageMonitor } from './monitor.js';
import { type PerformResult, runAction } from './perform.js';
import { compileDenyText, outOfScopeReason } from './scope.js';
import { firstLine } from './util.js';

const SUMMARY_MAX_CHARS = 6000;
const CONSOLE_EVIDENCE_LINES = 50;
const CONSOLE_EVIDENCE_MAX_CHARS = 8000;
const SETTLE_MAX_MS = 3000;

/** One isolated browser context and page, driven step by step. */
export class WebSession implements AdapterSession {
  private readonly monitor: PageMonitor;
  private readonly denyText: RegExp[];
  private closed = false;

  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly options: SessionOptions,
  ) {
    this.denyText = compileDenyText(options.scope.denyText);
    this.monitor = new PageMonitor(page);
    context.setDefaultTimeout(options.stepTimeoutMs);
  }

  async perform(action: Action, step: StepContext = {}): Promise<ActionOutcome> {
    const parsed = WebActionSchema.safeParse(action);
    if (!parsed.success) {
      return {
        status: 'error',
        message: `Invalid action: ${z.prettifyError(parsed.error)}`,
        evidence: [],
      };
    }
    const unusable = this.unusableReason();
    if (unusable) return { status: 'error', message: unusable, evidence: [] };

    const webAction = parsed.data;
    this.monitor.stepId = step.stepId;
    const label = step.index === undefined ? webAction.type : `${step.index}-${webAction.type}`;
    const meta = { stepId: step.stepId, label };

    if (webAction.type === 'screenshot') {
      const shot = await this.screenshot({ stepId: step.stepId, label: webAction.label ?? label });
      return shot
        ? { status: 'ok', evidence: [shot] }
        : { status: 'error', message: 'Could not take a screenshot', evidence: [] };
    }

    let result = await runAction(webAction, {
      page: this.page,
      baseUrl: this.baseUrl,
      scope: this.options.scope,
      denyText: this.denyText,
      timeoutMs: this.options.stepTimeoutMs,
    });
    result = await this.afterAction(result);
    this.options.logger.debug('action', { type: webAction.type, ...result, stepId: step.stepId });

    const evidence: Evidence[] = [];
    const failed = result.status !== 'ok';
    if (this.options.screenshots === 'always' || (failed && this.options.screenshots !== 'never')) {
      const shot = await this.screenshot(meta);
      if (shot) evidence.push(shot);
    }
    if (failed) {
      const console = this.consoleEvidence(meta);
      if (console) evidence.push(console);
    }
    return { ...result, evidence };
  }

  async check(assertion: Assertion): Promise<CheckOutcome> {
    const parsed = WebAssertionSchema.safeParse(assertion);
    if (!parsed.success) {
      return { passed: false, message: `Invalid assertion: ${z.prettifyError(parsed.error)}` };
    }
    const unusable = this.unusableReason();
    if (unusable) return { passed: false, message: unusable };
    return evaluateAssertion(parsed.data, {
      page: this.page,
      baseUrl: this.baseUrl,
      scope: this.options.scope,
      timeoutMs: this.options.assertionTimeoutMs ?? this.options.stepTimeoutMs,
    });
  }

  async observe(): Promise<Observation> {
    const unusable = this.unusableReason();
    if (unusable) return { summary: unusable };
    const url = this.page.url();
    const title = await this.page.title().catch(() => '');
    let snapshot: string;
    try {
      snapshot = await this.page
        .locator('body')
        .ariaSnapshot({ timeout: this.options.stepTimeoutMs });
    } catch (error) {
      snapshot = `(aria snapshot unavailable: ${firstLine(errorMessage(error))})`;
    }
    const summary = truncate(
      `Page ${JSON.stringify(title)} at ${url}\n${snapshot}`,
      SUMMARY_MAX_CHARS,
    );
    const screenshot =
      this.options.screenshots === 'never'
        ? undefined
        : await this.screenshot({ label: 'observe', stepId: this.monitor.stepId });
    return { url, title, summary, ...(screenshot ? { screenshot } : {}) };
  }

  drainSignals(): Signal[] {
    return this.monitor.drain();
  }

  async capture(
    kind: 'screenshot' | 'dom' | 'output',
    label?: string,
  ): Promise<Evidence | undefined> {
    if (this.unusableReason()) return undefined;
    const meta = { label: label ?? kind, stepId: this.monitor.stepId };
    switch (kind) {
      case 'screenshot':
        return this.screenshot(meta);
      case 'dom':
        try {
          const html = await this.page.content();
          return this.options.evidence.file('dom', html, 'html', {
            ...meta,
            mimeType: 'text/html',
          });
        } catch (error) {
          this.options.logger.debug('DOM capture failed', { error: errorMessage(error) });
          return undefined;
        }
      case 'output':
        return this.consoleEvidence(meta);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.context.close().catch((error: unknown) => {
      this.options.logger.debug('Closing the browser context failed', {
        error: errorMessage(error),
      });
    });
  }

  /** Let the page settle, then undo any navigation that left the scope. */
  private async afterAction(result: PerformResult): Promise<PerformResult> {
    if (this.monitor.hasCrashed) return { status: 'error', message: 'The page crashed' };
    await this.monitor.settle(Math.min(this.options.stepTimeoutMs, SETTLE_MAX_MS));
    const url = this.page.url();
    const reason = outOfScopeReason(url, this.options.scope, this.baseUrl);
    if (!reason) return result;
    await this.page.goBack({ timeout: this.options.stepTimeoutMs }).catch((error: unknown) =>
      this.options.logger.warn('Could not leave an out-of-scope page', {
        url,
        error: errorMessage(error),
      }),
    );
    return {
      status: 'blocked',
      message: `The action navigated out of scope (${reason}); went back`,
    };
  }

  private unusableReason(): string | undefined {
    if (this.closed) return 'The session is closed';
    if (this.monitor.hasCrashed) return 'The page crashed';
    return undefined;
  }

  private async screenshot(meta: {
    stepId?: string;
    label: string;
  }): Promise<Evidence | undefined> {
    try {
      const png = await this.page.screenshot({ type: 'png', timeout: this.options.stepTimeoutMs });
      return this.options.evidence.file('screenshot', png, 'png', {
        ...meta,
        mimeType: 'image/png',
      });
    } catch (error) {
      this.options.logger.debug('Screenshot failed', { error: errorMessage(error) });
      return undefined;
    }
  }

  private consoleEvidence(meta: { stepId?: string; label: string }): Evidence | undefined {
    const lines = this.monitor.recentConsole().slice(-CONSOLE_EVIDENCE_LINES);
    if (lines.length === 0) return undefined;
    return this.options.evidence.text(
      'console',
      tail(lines.join('\n'), CONSOLE_EVIDENCE_MAX_CHARS),
      {
        ...meta,
        label: `${meta.label}-console`,
      },
    );
  }
}
