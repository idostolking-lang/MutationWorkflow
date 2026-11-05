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
import type { BrowserContext, Page, Request, Route } from 'playwright';
import { z } from 'zod';
import { WebActionSchema } from './actions.js';
import { evaluateAssertion, WebAssertionSchema } from './assertions.js';
import { PageMonitor } from './monitor.js';
import { type PerformResult, runAction } from './perform.js';
import { compileDenyText, outOfScopeReason, requestBlockReason } from './scope.js';
import { firstLine } from './util.js';

const SUMMARY_MAX_CHARS = 6000;
const CONSOLE_EVIDENCE_LINES = 50;
const CONSOLE_EVIDENCE_MAX_CHARS = 8000;
const SETTLE_MAX_MS = 3000;

/**
 * One isolated browser context and page, driven step by step. Workflows run in a single tab:
 * pages the application opens (target=_blank, window.open) are closed at once.
 *
 * Scope is enforced before requests leave the browser: a route on the context aborts every
 * navigation, and every request with a method other than GET or HEAD, whose URL is out of scope.
 * Checking the page URL after each action remains as a backstop (for example for redirects).
 */
export class WebSession implements AdapterSession {
  private readonly monitor: PageMonitor;
  private readonly denyText: RegExp[];
  /** Main-frame navigations the route aborted since the last action began, as reasons. */
  private blockedNavigations: string[] = [];
  /** Notes for the next outcome message, such as closed popups. */
  private notes: string[] = [];
  private closed = false;

  private constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly options: SessionOptions,
  ) {
    this.denyText = compileDenyText(options.scope.denyText);
    this.monitor = new PageMonitor(page);
    context.setDefaultTimeout(options.stepTimeoutMs);
    context.on('page', (opened) => {
      if (opened !== this.page) void this.closePopup(opened);
    });
  }

  /**
   * Start a session on a fresh context and its page; installs the scope route before anything
   * is loaded. The context should block service workers, whose requests bypass routes.
   */
  static async start(
    context: BrowserContext,
    page: Page,
    baseUrl: string,
    options: SessionOptions,
  ): Promise<WebSession> {
    const session = new WebSession(context, page, baseUrl, options);
    await context.route('**/*', (route) => session.onRoute(route));
    return session;
  }

  /**
   * The Playwright page, for tests and extensions. Whatever is done with it directly still goes
   * through the scope route, but not through the denyText guard.
   */
  get playwrightPage(): Page {
    return this.page;
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
    // Navigations blocked between steps were not caused by this action.
    for (const reason of this.takeBlockedNavigations()) {
      this.addNote(`navigation blocked before this step (${reason})`);
    }
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

  /**
   * Let the page settle, report navigations the scope route aborted, undo any navigation that
   * still left the scope, and attach pending notes.
   */
  private async afterAction(result: PerformResult): Promise<PerformResult> {
    if (this.monitor.hasCrashed) return { status: 'error', message: 'The page crashed' };
    await this.monitor.settle(Math.min(this.options.stepTimeoutMs, SETTLE_MAX_MS));
    const blocked = this.takeBlockedNavigations();
    if (blocked.length > 0) {
      result = {
        status: 'blocked',
        message: `The action tried to navigate out of scope (${blocked.join('; ')}); the navigation was aborted`,
      };
    }
    const url = this.page.url();
    const reason = outOfScopeReason(url, this.options.scope, this.baseUrl);
    if (reason) {
      await this.page.goBack({ timeout: this.options.stepTimeoutMs }).catch((error: unknown) =>
        this.options.logger.warn('Could not leave an out-of-scope page', {
          url,
          error: errorMessage(error),
        }),
      );
      result = {
        status: 'blocked',
        message:
          blocked.length > 0
            ? `${result.message}; went back`
            : `The action navigated out of scope (${reason}); went back`,
      };
    }
    return this.withNotes(result);
  }

  /** Decide one request before it leaves the browser: continue it or abort it. */
  private async onRoute(route: Route): Promise<void> {
    const request = route.request();
    try {
      const isNavigation = request.isNavigationRequest();
      const inMainPage = this.isFromMainPage(request);
      if (isNavigation && !inMainPage) {
        // A popup or new tab: it never loads anything; the page itself is closed.
        this.monitor.markBlocked(request, 'popups are not followed');
        this.addNote(`popup to ${request.url()} closed`);
        await route.abort('aborted');
        return;
      }
      const reason = requestBlockReason(
        { url: request.url(), method: request.method(), isNavigation },
        this.options.scope,
        this.baseUrl,
      );
      if (reason === undefined) {
        await route.continue();
        return;
      }
      this.monitor.markBlocked(request, reason);
      this.options.logger.debug('Request blocked by scope', {
        method: request.method(),
        url: request.url(),
        reason,
      });
      if (isNavigation) {
        if (this.isMainFrame(request)) this.blockedNavigations.push(reason);
        else this.addNote(`frame navigation blocked (${reason})`);
      }
      // An aborted navigation leaves the current document in place; other error codes would
      // replace it with the browser's error page.
      await route.abort(isNavigation ? 'aborted' : 'blockedbyclient');
    } catch (error) {
      // The page or context closed while deciding; nothing is left to load.
      this.options.logger.debug('Routing a request failed', {
        url: request.url(),
        error: errorMessage(error),
      });
    }
  }

  /**
   * True when the request belongs to the session's page. A popup's first navigation is issued
   * before its frame exists, which Playwright reports by throwing.
   */
  private isFromMainPage(request: Request): boolean {
    try {
      return request.frame().page() === this.page;
    } catch {
      return !request.isNavigationRequest();
    }
  }

  private isMainFrame(request: Request): boolean {
    try {
      return request.frame() === this.page.mainFrame();
    } catch {
      return false;
    }
  }

  /** Close a page the application opened; the workflow continues in the original page. */
  private async closePopup(popup: Page): Promise<void> {
    const url = popup.url();
    if (/^https?:/i.test(url)) this.addNote(`popup to ${url} closed`);
    this.options.logger.debug('Closing a popup', { url });
    await popup
      .close()
      .catch((error: unknown) =>
        this.options.logger.debug('Closing a popup failed', { error: errorMessage(error) }),
      );
  }

  private takeBlockedNavigations(): string[] {
    const blocked = this.blockedNavigations;
    this.blockedNavigations = [];
    return blocked;
  }

  private addNote(note: string): void {
    if (!this.notes.includes(note)) this.notes.push(note);
  }

  private withNotes(result: PerformResult): PerformResult {
    if (this.notes.length === 0) return result;
    const notes = this.notes.join('; ');
    this.notes = [];
    return { ...result, message: result.message ? `${result.message}; ${notes}` : notes };
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
