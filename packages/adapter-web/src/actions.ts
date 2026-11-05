import { z } from 'zod';
import { LocatorSchema } from './locator.js';

const target = LocatorSchema.describe('Element to act on');

export const NavigateActionSchema = z
  .object({
    type: z.literal('navigate'),
    url: z
      .string()
      .min(1)
      .describe('Absolute URL, or a URL relative to the base URL such as "/settings"'),
  })
  .describe('Open a URL in the current tab and wait for it to load');

export const ClickActionSchema = z
  .object({ type: z.literal('click'), target })
  .describe('Click an element');

export const DblclickActionSchema = z
  .object({ type: z.literal('dblclick'), target })
  .describe('Double-click an element');

export const FillActionSchema = z
  .object({
    type: z.literal('fill'),
    target: LocatorSchema.describe('Text field, textarea or contenteditable element'),
    value: z.string().describe('Text that replaces the current content of the field'),
  })
  .describe('Replace the content of a text field');

export const PressActionSchema = z
  .object({
    type: z.literal('press'),
    key: z
      .string()
      .min(1)
      .describe('Key or chord in Playwright syntax, e.g. "Enter", "Escape", "Control+A"'),
    target: LocatorSchema.optional().describe(
      'Element to focus before pressing; the focused element when omitted',
    ),
  })
  .describe('Press a key or key combination');

export const SelectActionSchema = z
  .object({
    type: z.literal('select'),
    target: LocatorSchema.describe('A <select> element'),
    value: z.string().describe('Option value or visible option label to select'),
  })
  .describe('Choose an option in a <select>');

export const CheckActionSchema = z
  .object({
    type: z.literal('check'),
    target: LocatorSchema.describe('Checkbox or radio button'),
  })
  .describe('Check a checkbox or radio button');

export const UncheckActionSchema = z
  .object({ type: z.literal('uncheck'), target: LocatorSchema.describe('Checkbox') })
  .describe('Uncheck a checkbox');

export const HoverActionSchema = z
  .object({ type: z.literal('hover'), target })
  .describe('Move the mouse over an element, e.g. to open a menu or tooltip');

export const ScrollActionSchema = z
  .object({ type: z.literal('scroll'), target })
  .describe('Scroll until an element is in view');

export const WaitActionSchema = z
  .object({
    type: z.literal('wait'),
    ms: z.number().int().nonnegative().max(60_000).optional().describe('Milliseconds to pause'),
    target: LocatorSchema.optional().describe('Wait until this element is visible'),
    url: z
      .string()
      .min(1)
      .optional()
      .describe('Wait until the URL matches this glob, path glob (e.g. "/done*") or /regex/'),
  })
  .refine((a) => a.ms !== undefined || a.target !== undefined || a.url !== undefined, {
    message: 'wait needs ms, target or url',
  })
  .describe('Pause, or wait for an element or URL; element and URL waits use the step timeout');

export const ReloadActionSchema = z
  .object({ type: z.literal('reload') })
  .describe('Reload the current page');

export const BackActionSchema = z
  .object({ type: z.literal('back') })
  .describe('Go back in browser history');

export const ForwardActionSchema = z
  .object({ type: z.literal('forward') })
  .describe('Go forward in browser history');

export const ScreenshotActionSchema = z
  .object({
    type: z.literal('screenshot'),
    label: z.string().min(1).optional().describe('Name for the screenshot in the evidence'),
  })
  .describe('Save a screenshot of the page as evidence');

/** Every action the web adapter performs, discriminated by `type`. */
export const WebActionSchema = z.discriminatedUnion('type', [
  NavigateActionSchema,
  ClickActionSchema,
  DblclickActionSchema,
  FillActionSchema,
  PressActionSchema,
  SelectActionSchema,
  CheckActionSchema,
  UncheckActionSchema,
  HoverActionSchema,
  ScrollActionSchema,
  WaitActionSchema,
  ReloadActionSchema,
  BackActionSchema,
  ForwardActionSchema,
  ScreenshotActionSchema,
]);
export type WebAction = z.infer<typeof WebActionSchema>;
export type WebActionType = WebAction['type'];

/** One representative example per action type, shown to agents. */
export const ACTION_EXAMPLES: { [K in WebActionType]: Extract<WebAction, { type: K }> } = {
  navigate: { type: 'navigate', url: '/' },
  click: { type: 'click', target: { role: 'button', name: 'Save' } },
  dblclick: { type: 'dblclick', target: { text: 'Buy milk', exact: true } },
  fill: { type: 'fill', target: { label: 'Email' }, value: 'ada@example.com' },
  press: { type: 'press', key: 'Enter', target: { label: 'Search' } },
  select: { type: 'select', target: { label: 'Country' }, value: 'Norway' },
  check: { type: 'check', target: { role: 'checkbox', name: 'Remember me' } },
  uncheck: { type: 'uncheck', target: { role: 'checkbox', name: 'Remember me' } },
  hover: { type: 'hover', target: { role: 'button', name: 'Account' } },
  scroll: { type: 'scroll', target: { role: 'contentinfo' } },
  wait: { type: 'wait', target: { role: 'heading', name: 'Dashboard' } },
  reload: { type: 'reload' },
  back: { type: 'back' },
  forward: { type: 'forward' },
  screenshot: { type: 'screenshot', label: 'after-checkout' },
};
