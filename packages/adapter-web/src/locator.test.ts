import { describe, expect, it } from 'vitest';
import {
  describeLocator,
  type LocatorRoot,
  LocatorSchema,
  locatorStrategy,
  toPlaywrightLocator,
} from './locator.js';

describe('locatorStrategy', () => {
  it('prefers testId over every other field', () => {
    const locator = LocatorSchema.parse({
      testId: 'save',
      role: 'button',
      name: 'Save',
      label: 'x',
      text: 'Save',
      css: '#save',
    });
    expect(locatorStrategy(locator)).toEqual({ by: 'testId', testId: 'save' });
  });

  it('falls through role, label, placeholder, text and css in order', () => {
    const all = { role: 'button', name: 'Go', label: 'L', placeholder: 'P', text: 'T', css: '.c' };
    expect(locatorStrategy(LocatorSchema.parse(all))).toEqual({
      by: 'role',
      role: 'button',
      name: 'Go',
    });
    const { role: _r, name: _n, ...noRole } = all;
    expect(locatorStrategy(LocatorSchema.parse(noRole))).toEqual({ by: 'label', text: 'L' });
    const { label: _l, ...noLabel } = noRole;
    expect(locatorStrategy(LocatorSchema.parse(noLabel))).toEqual({
      by: 'placeholder',
      text: 'P',
    });
    const { placeholder: _p, ...noPlaceholder } = noLabel;
    expect(locatorStrategy(LocatorSchema.parse(noPlaceholder))).toEqual({ by: 'text', text: 'T' });
    expect(locatorStrategy(LocatorSchema.parse({ css: '.c' }))).toEqual({
      by: 'css',
      selector: '.c',
    });
  });

  it('carries exact to name, label and text matching', () => {
    expect(locatorStrategy({ role: 'link', name: 'Home', exact: true })).toEqual({
      by: 'role',
      role: 'link',
      name: 'Home',
      exact: true,
    });
    expect(locatorStrategy({ label: 'Email', exact: false })).toEqual({
      by: 'label',
      text: 'Email',
      exact: false,
    });
    expect(locatorStrategy({ text: 'Hi', exact: true })).toEqual({
      by: 'text',
      text: 'Hi',
      exact: true,
    });
  });
});

describe('LocatorSchema', () => {
  it('requires at least one selector field', () => {
    expect(LocatorSchema.safeParse({}).success).toBe(false);
    expect(LocatorSchema.safeParse({ nth: 1, exact: true }).success).toBe(false);
  });

  it('rejects name without role and negative nth', () => {
    expect(LocatorSchema.safeParse({ name: 'Save' }).success).toBe(false);
    expect(LocatorSchema.safeParse({ css: 'a', nth: -1 }).success).toBe(false);
  });
});

describe('toPlaywrightLocator', () => {
  /** A fake root that records which factory method was called and with what. */
  function fakeRoot() {
    const calls: unknown[][] = [];
    const make =
      (method: string) =>
      (...args: unknown[]) => {
        calls.push([method, ...args]);
        const locator = {
          nth: (index: number) => {
            calls.push(['nth', index]);
            return locator;
          },
        };
        return locator;
      };
    const root = {
      getByTestId: make('getByTestId'),
      getByRole: make('getByRole'),
      getByLabel: make('getByLabel'),
      getByPlaceholder: make('getByPlaceholder'),
      getByText: make('getByText'),
      locator: make('locator'),
    } as unknown as LocatorRoot;
    return { root, calls };
  }

  it('builds the chosen strategy and applies nth last', () => {
    const { root, calls } = fakeRoot();
    toPlaywrightLocator(root, { role: 'button', name: 'Delete', exact: true, nth: 2 });
    expect(calls).toEqual([
      ['getByRole', 'button', { name: 'Delete', exact: true }],
      ['nth', 2],
    ]);
  });

  it('uses css only when nothing better is given', () => {
    const { root, calls } = fakeRoot();
    toPlaywrightLocator(root, { css: 'ul > li' });
    expect(calls).toEqual([['locator', 'ul > li']]);
  });
});

describe('describeLocator', () => {
  it('names the strategy and index', () => {
    expect(describeLocator({ role: 'button', name: 'Add' })).toBe('button "Add"');
    expect(describeLocator({ label: 'Email', nth: 1 })).toBe('label "Email" #1');
    expect(describeLocator({ css: '#x' })).toBe('css "#x"');
  });
});
