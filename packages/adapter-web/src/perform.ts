import { errorMessage, type Scope } from '@mutationworkflow/core';
import { errors, type Page, type Locator as PlaywrightLocator } from 'playwright';
import type { WebAction } from './actions.js';
import { describeLocator, type Locator, toPlaywrightLocator } from './locator.js';
import { matchingDenyText, outOfScopeReason, resolveUrl, urlMatches } from './scope.js';
import { firstLine, sleep } from './util.js';

/** What performing an action needs from the session. */
export interface PerformContext {
  page: Page;
  baseUrl: string;
  scope: Scope;
  denyText: ReadonlyArray<RegExp>;
  timeoutMs: number;
}

/** Result of running one action, before the session attaches evidence. */
export interface PerformResult {
  status: 'ok' | 'blocked' | 'error';
  message?: string;
}

/** Thrown inside an action when the application or the scope does not allow it. */
class Blocked extends Error {}

/** Actions whose time-outs mean the application hung rather than a missing control. */
const NAVIGATION_TYPES = new Set<WebAction['type']>(['navigate', 'reload', 'back', 'forward']);

/** Playwright errors that mean the element exists but does not accept this action. */
const NOT_APPLICABLE =
  /strict mode violation|not a checkbox|Element is not an? <|Cannot type text into|Malformed value|not a select|Element is not attached/i;

/**
 * Perform one validated action (except `screenshot`, which the session handles). Never throws:
 * missing or refused controls become `blocked`, anything else that goes wrong becomes `error`.
 */
export async function runAction(
  action: WebAction,
  context: PerformContext,
): Promise<PerformResult> {
  try {
    const message = await dispatch(action, context);
    return message === undefined ? { status: 'ok' } : { status: 'ok', message };
  } catch (error) {
    return classifyError(action, error, context.timeoutMs);
  }
}

function classifyError(action: WebAction, error: unknown, timeoutMs: number): PerformResult {
  if (error instanceof Blocked) return { status: 'blocked', message: error.message };
  const message = firstLine(errorMessage(error));
  const target = 'target' in action && action.target ? describeLocator(action.target) : undefined;
  if (error instanceof errors.TimeoutError) {
    if (NAVIGATION_TYPES.has(action.type)) {
      return { status: 'error', message: `${action.type} timed out after ${timeoutMs} ms` };
    }
    const what = target ?? 'The awaited condition';
    return {
      status: 'blocked',
      message: `${what} was not found or not actionable within ${timeoutMs} ms`,
    };
  }
  if (NOT_APPLICABLE.test(message)) {
    return { status: 'blocked', message: target ? `${target}: ${message}` : message };
  }
  return { status: 'error', message: `${action.type} failed: ${message}` };
}

async function dispatch(action: WebAction, context: PerformContext): Promise<string | undefined> {
  const { page, timeoutMs } = context;
  const timeout = { timeout: timeoutMs };
  const locate = (target: Locator) => toPlaywrightLocator(page, target);

  switch (action.type) {
    case 'navigate': {
      const url = resolveUrl(action.url, context.baseUrl);
      const reason = outOfScopeReason(url, context.scope, context.baseUrl);
      if (reason) throw new Blocked(`Not navigating: ${reason}`);
      const response = await page.goto(url, { ...timeout, waitUntil: 'load' });
      const status = response?.status();
      return status !== undefined && status >= 400 ? `${url} returned ${status}` : undefined;
    }
    case 'click':
      await guardDenyText(locate(action.target), action.target, context);
      await locate(action.target).click(timeout);
      return undefined;
    case 'dblclick':
      await guardDenyText(locate(action.target), action.target, context);
      await locate(action.target).dblclick(timeout);
      return undefined;
    case 'fill':
      await locate(action.target).fill(action.value, timeout);
      return undefined;
    case 'press':
      if (action.target) {
        await guardDenyText(locate(action.target), action.target, context);
        await locate(action.target).press(action.key, timeout);
      } else {
        await page.keyboard.press(action.key);
      }
      return undefined;
    case 'select':
      await locate(action.target).selectOption(action.value, timeout);
      return undefined;
    case 'check':
      await guardDenyText(locate(action.target), action.target, context);
      await locate(action.target).check(timeout);
      return undefined;
    case 'uncheck':
      await locate(action.target).uncheck(timeout);
      return undefined;
    case 'hover':
      await locate(action.target).hover(timeout);
      return undefined;
    case 'scroll':
      await locate(action.target).scrollIntoViewIfNeeded(timeout);
      return undefined;
    case 'wait':
      if (action.ms !== undefined) await sleep(action.ms);
      if (action.target) await locate(action.target).waitFor({ ...timeout, state: 'visible' });
      if (action.url !== undefined) {
        const pattern = action.url;
        await page.waitForURL((url) => urlMatches(url.href, pattern), timeout);
      }
      return undefined;
    case 'reload':
      await page.reload({ ...timeout, waitUntil: 'load' });
      return undefined;
    case 'back':
    case 'forward': {
      const before = page.url();
      const options = { ...timeout, waitUntil: 'load' as const };
      await (action.type === 'back' ? page.goBack(options) : page.goForward(options));
      // goBack/goForward return null both without history and for same-document navigation.
      return page.url() === before
        ? `No ${action.type} history entry; nothing happened`
        : undefined;
    }
    case 'screenshot':
      throw new Error('screenshot actions are handled by the session');
  }
}

/** Refuse to activate a control whose text matches `scope.denyText`. */
async function guardDenyText(
  locator: PlaywrightLocator,
  target: Locator,
  context: PerformContext,
): Promise<void> {
  if (context.denyText.length === 0) return;
  const timeout = { timeout: context.timeoutMs };
  const text = [
    await locator.textContent(timeout),
    await locator.getAttribute('aria-label', timeout),
    await locator.getAttribute('value', timeout),
  ].join(' ');
  const pattern = matchingDenyText(text, context.denyText);
  if (pattern) {
    throw new Blocked(`${describeLocator(target)} matches scope.denyText ${pattern.source}`);
  }
}
