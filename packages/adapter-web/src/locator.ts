import type { Page, Locator as PlaywrightLocator } from 'playwright';
import { z } from 'zod';

/**
 * How an action or assertion finds an element. Exactly one strategy is used, chosen by
 * priority: testId, role (with name), label, placeholder, text, css. `nth` applies last.
 */
export const LocatorSchema = z
  .object({
    role: z
      .string()
      .min(1)
      .optional()
      .describe('ARIA role as shown in the aria snapshot, e.g. "button", "link", "textbox"'),
    name: z
      .string()
      .optional()
      .describe('Accessible name for role, e.g. the button text; substring unless exact'),
    text: z.string().min(1).optional().describe('Visible text of the element'),
    label: z.string().min(1).optional().describe('Text of the <label> or aria-label of a field'),
    placeholder: z.string().min(1).optional().describe('Placeholder text of an input'),
    testId: z.string().min(1).optional().describe('Value of the data-testid attribute'),
    css: z.string().min(1).optional().describe('CSS selector; last resort, brittle'),
    nth: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Zero-based index when several elements match'),
    exact: z
      .boolean()
      .optional()
      .describe('Match name, label, placeholder and text exactly (case-sensitive, whole string)'),
  })
  .refine(
    (l) => Boolean(l.testId ?? l.role ?? l.label ?? l.placeholder ?? l.text ?? l.css),
    'A locator needs one of testId, role, label, placeholder, text or css',
  )
  .refine((l) => l.name === undefined || l.role !== undefined, '"name" requires "role"')
  .describe('Element locator; prefer role+name, label or testId over css');
export type Locator = z.infer<typeof LocatorSchema>;

/** The single Playwright strategy a locator resolves to. */
export type LocatorStrategy =
  | { by: 'testId'; testId: string }
  | { by: 'role'; role: string; name?: string; exact?: boolean }
  | { by: 'label' | 'placeholder' | 'text'; text: string; exact?: boolean }
  | { by: 'css'; selector: string };

/** Pick the strategy for a locator by priority: testId, role, label, placeholder, text, css. */
export function locatorStrategy(locator: Locator): LocatorStrategy {
  const exact = locator.exact === undefined ? {} : { exact: locator.exact };
  if (locator.testId !== undefined) return { by: 'testId', testId: locator.testId };
  if (locator.role !== undefined) {
    return {
      by: 'role',
      role: locator.role,
      ...(locator.name === undefined ? {} : { name: locator.name }),
      ...exact,
    };
  }
  if (locator.label !== undefined) return { by: 'label', text: locator.label, ...exact };
  if (locator.placeholder !== undefined) {
    return { by: 'placeholder', text: locator.placeholder, ...exact };
  }
  if (locator.text !== undefined) return { by: 'text', text: locator.text, ...exact };
  if (locator.css !== undefined) return { by: 'css', selector: locator.css };
  throw new Error('A locator needs one of testId, role, label, placeholder, text or css');
}

/** The part of a Playwright `Page` used to build locators. */
export type LocatorRoot = Pick<
  Page,
  'getByTestId' | 'getByRole' | 'getByLabel' | 'getByPlaceholder' | 'getByText' | 'locator'
>;

type AriaRole = Parameters<Page['getByRole']>[0];

/** Build the Playwright locator for a validated locator. */
export function toPlaywrightLocator(root: LocatorRoot, locator: Locator): PlaywrightLocator {
  const strategy = locatorStrategy(locator);
  const resolved = buildLocator(root, strategy);
  return locator.nth === undefined ? resolved : resolved.nth(locator.nth);
}

function buildLocator(root: LocatorRoot, strategy: LocatorStrategy): PlaywrightLocator {
  switch (strategy.by) {
    case 'testId':
      return root.getByTestId(strategy.testId);
    case 'role':
      // Roles are free text in the schema; an unknown role simply matches nothing.
      return root.getByRole(strategy.role as AriaRole, {
        ...(strategy.name === undefined ? {} : { name: strategy.name }),
        ...(strategy.exact === undefined ? {} : { exact: strategy.exact }),
      });
    case 'label':
      return root.getByLabel(strategy.text, { exact: strategy.exact });
    case 'placeholder':
      return root.getByPlaceholder(strategy.text, { exact: strategy.exact });
    case 'text':
      return root.getByText(strategy.text, { exact: strategy.exact });
    case 'css':
      return root.locator(strategy.selector);
  }
}

/** Human-readable form of a locator for outcome messages, e.g. `button "Add"`. */
export function describeLocator(locator: Locator): string {
  const strategy = locatorStrategy(locator);
  const q = (value: string) => JSON.stringify(value);
  let text: string;
  switch (strategy.by) {
    case 'testId':
      text = `testId ${q(strategy.testId)}`;
      break;
    case 'role':
      text = strategy.name === undefined ? strategy.role : `${strategy.role} ${q(strategy.name)}`;
      break;
    case 'css':
      text = `css ${q(strategy.selector)}`;
      break;
    default:
      text = `${strategy.by} ${q(strategy.text)}`;
  }
  return locator.nth === undefined ? text : `${text} #${locator.nth}`;
}
