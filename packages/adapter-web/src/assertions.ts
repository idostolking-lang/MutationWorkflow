import { type CheckOutcome, errorMessage, type Scope } from '@mutationworkflow/core';
import type { Page, Locator as PlaywrightLocator } from 'playwright';
import { z } from 'zod';
import { describeLocator, LocatorSchema, toPlaywrightLocator } from './locator.js';
import { outOfScopeReason, parseRegexPattern, resolveUrl, urlMatches } from './scope.js';
import { firstLine, sleep } from './util.js';

const description = z.string().optional().describe('What this assertion verifies, in user terms');

const pattern = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        parseRegexPattern(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Invalid /regex/ pattern' },
  );

export const UrlMatchesAssertionSchema = z
  .object({
    type: z.literal('url-matches'),
    description,
    pattern: pattern.describe(
      'Glob on the full URL ("http://localhost:3000/todos/*"), glob on path and query ("/todos/**"), or /regex/flags',
    ),
  })
  .describe('The current URL matches a pattern');

export const TitleMatchesAssertionSchema = z
  .object({
    type: z.literal('title-matches'),
    description,
    pattern: pattern.describe('Text the page title contains, or /regex/flags'),
  })
  .describe('The page title matches a pattern');

export const TextVisibleAssertionSchema = z
  .object({
    type: z.literal('text-visible'),
    description,
    text: z.string().min(1).describe('Text that must be visible somewhere on the page'),
    exact: z.boolean().optional().describe('Require an element whose whole text equals it'),
  })
  .describe('Some text is visible on the page');

export const TextHiddenAssertionSchema = z
  .object({
    type: z.literal('text-hidden'),
    description,
    text: z.string().min(1).describe('Text that must not be visible anywhere on the page'),
  })
  .describe('No visible element contains some text');

export const ElementVisibleAssertionSchema = z
  .object({
    type: z.literal('element-visible'),
    description,
    target: LocatorSchema.describe('Element that must be visible'),
  })
  .describe('An element is visible');

export const ElementHiddenAssertionSchema = z
  .object({
    type: z.literal('element-hidden'),
    description,
    target: LocatorSchema.describe('Element that must be absent or hidden'),
  })
  .describe('An element is absent or hidden');

export const ElementCountAssertionSchema = z
  .object({
    type: z.literal('element-count'),
    description,
    target: LocatorSchema.describe('Elements to count (hidden ones included)'),
    count: z.number().int().nonnegative().optional().describe('Exact number of matches'),
    min: z.number().int().nonnegative().optional().describe('Minimum number of matches'),
    max: z.number().int().nonnegative().optional().describe('Maximum number of matches'),
  })
  .refine((a) => a.count !== undefined || a.min !== undefined || a.max !== undefined, {
    message: 'element-count needs count, min or max',
  })
  .describe('The number of elements matching a locator');

export const ValueEqualsAssertionSchema = z
  .object({
    type: z.literal('value-equals'),
    description,
    target: LocatorSchema.describe('Input, textarea or select'),
    value: z.string().describe('Expected current value'),
  })
  .describe('A form field holds a value');

export const HttpAssertionSchema = z
  .object({
    type: z.literal('http'),
    description,
    url: z
      .string()
      .min(1)
      .describe('URL to GET with the session cookies, absolute or relative to the base URL'),
    status: z
      .number()
      .int()
      .min(100)
      .max(599)
      .optional()
      .describe('Expected status; any status below 400 when omitted'),
  })
  .describe('A GET request made with the session cookies returns the expected status');

/** Every assertion the web adapter evaluates, discriminated by `type`. */
export const WebAssertionSchema = z.discriminatedUnion('type', [
  UrlMatchesAssertionSchema,
  TitleMatchesAssertionSchema,
  TextVisibleAssertionSchema,
  TextHiddenAssertionSchema,
  ElementVisibleAssertionSchema,
  ElementHiddenAssertionSchema,
  ElementCountAssertionSchema,
  ValueEqualsAssertionSchema,
  HttpAssertionSchema,
]);
export type WebAssertion = z.infer<typeof WebAssertionSchema>;
export type WebAssertionType = WebAssertion['type'];

/** One representative example per assertion type, shown to agents. */
export const ASSERTION_EXAMPLES: {
  [K in WebAssertionType]: Extract<WebAssertion, { type: K }>;
} = {
  'url-matches': { type: 'url-matches', pattern: '/todos/**' },
  'title-matches': { type: 'title-matches', pattern: 'Todos' },
  'text-visible': { type: 'text-visible', text: 'Saved' },
  'text-hidden': { type: 'text-hidden', text: 'Something went wrong' },
  'element-visible': { type: 'element-visible', target: { role: 'heading', name: 'Todos' } },
  'element-hidden': { type: 'element-hidden', target: { role: 'dialog' } },
  'element-count': { type: 'element-count', target: { role: 'listitem' }, count: 3 },
  'value-equals': { type: 'value-equals', target: { label: 'Title' }, value: 'Buy milk' },
  http: { type: 'http', url: '/api/health', status: 200 },
};

/** What an assertion needs from the session. */
export interface AssertionContext {
  page: Page;
  baseUrl: string;
  scope: Scope;
  /** How long state assertions keep retrying before they fail. */
  timeoutMs: number;
}

const POLL_INTERVAL_MS = 100;

/**
 * Evaluate a validated assertion. State assertions are retried until they hold or the timeout
 * elapses, so they tolerate rendering that finishes shortly after an action. Never throws.
 */
export async function evaluateAssertion(
  assertion: WebAssertion,
  context: AssertionContext,
): Promise<CheckOutcome> {
  if (assertion.type === 'http') return checkHttp(assertion, context);
  return eventually(() => probe(assertion, context.page), context.timeoutMs);
}

async function probe(
  assertion: Exclude<WebAssertion, { type: 'http' }>,
  page: Page,
): Promise<CheckOutcome> {
  switch (assertion.type) {
    case 'url-matches': {
      const url = page.url();
      return outcome(urlMatches(url, assertion.pattern), `URL is ${url}`);
    }
    case 'title-matches': {
      const title = await page.title();
      const regex = parseRegexPattern(assertion.pattern);
      const passed = regex ? regex.test(title) : title.includes(assertion.pattern);
      return outcome(passed, `Title is ${JSON.stringify(title)}`);
    }
    case 'text-visible': {
      const visible = await anyVisible(page.getByText(assertion.text, { exact: assertion.exact }));
      return outcome(visible, `Text ${JSON.stringify(assertion.text)} is ${visibility(visible)}`);
    }
    case 'text-hidden': {
      const visible = await anyVisible(page.getByText(assertion.text));
      return outcome(!visible, `Text ${JSON.stringify(assertion.text)} is ${visibility(visible)}`);
    }
    case 'element-visible': {
      const visible = await anyVisible(toPlaywrightLocator(page, assertion.target));
      return outcome(visible, `${describeLocator(assertion.target)} is ${visibility(visible)}`);
    }
    case 'element-hidden': {
      const visible = await anyVisible(toPlaywrightLocator(page, assertion.target));
      return outcome(!visible, `${describeLocator(assertion.target)} is ${visibility(visible)}`);
    }
    case 'element-count': {
      const count = await toPlaywrightLocator(page, assertion.target).count();
      const passed =
        (assertion.count === undefined || count === assertion.count) &&
        (assertion.min === undefined || count >= assertion.min) &&
        (assertion.max === undefined || count <= assertion.max);
      return outcome(passed, `${describeLocator(assertion.target)} matches ${count} element(s)`);
    }
    case 'value-equals': {
      const value = await toPlaywrightLocator(page, assertion.target).inputValue({
        timeout: POLL_INTERVAL_MS,
      });
      return outcome(
        value === assertion.value,
        `${describeLocator(assertion.target)} has value ${JSON.stringify(value)}`,
      );
    }
  }
}

async function checkHttp(
  assertion: Extract<WebAssertion, { type: 'http' }>,
  context: AssertionContext,
): Promise<CheckOutcome> {
  let url: string;
  try {
    url = resolveUrl(assertion.url, context.baseUrl);
  } catch {
    return { passed: false, message: `Invalid URL ${JSON.stringify(assertion.url)}` };
  }
  const reason = outOfScopeReason(url, context.scope, context.baseUrl);
  if (reason) return { passed: false, message: `Not requested: ${reason}` };
  try {
    const response = await context.page.request.get(url, {
      timeout: context.timeoutMs,
      failOnStatusCode: false,
    });
    const status = response.status();
    const passed = assertion.status === undefined ? status < 400 : status === assertion.status;
    return { passed, message: `GET ${url} returned ${status}` };
  } catch (error) {
    return { passed: false, message: `GET ${url} failed: ${firstLine(errorMessage(error))}` };
  }
}

/** Retry a probe until it passes or time runs out; probe errors count as failures. */
async function eventually(
  run: () => Promise<CheckOutcome>,
  timeoutMs: number,
): Promise<CheckOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let result: CheckOutcome;
    try {
      result = await run();
    } catch (error) {
      result = { passed: false, message: firstLine(errorMessage(error)) };
    }
    if (result.passed || Date.now() >= deadline) return result;
    await sleep(POLL_INTERVAL_MS);
  }
}

/** True when at least one element matched by the locator is visible. */
async function anyVisible(locator: PlaywrightLocator, limit = 50): Promise<boolean> {
  const count = Math.min(await locator.count(), limit);
  for (let i = 0; i < count; i++) {
    if (await locator.nth(i).isVisible()) return true;
  }
  return false;
}

function outcome(passed: boolean, message: string): CheckOutcome {
  return { passed, message };
}

function visibility(visible: boolean): string {
  return visible ? 'visible' : 'not visible';
}
