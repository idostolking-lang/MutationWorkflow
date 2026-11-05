import { resolve } from 'node:path';
import {
  type Action,
  type Adapter,
  type AdapterDescription,
  type AdapterFactoryOptions,
  type AdapterSession,
  type Assertion,
  type Logger,
  MutationWorkflowError,
  resolveInside,
  type SessionOptions,
} from '@mutationworkflow/core';
import {
  type Browser,
  type BrowserType,
  chromium,
  firefox,
  type LaunchOptions,
  webkit,
} from 'playwright';
import { z } from 'zod';
import { WebActionSchema } from './actions.js';
import { WebAssertionSchema } from './assertions.js';
import { describeWebAdapter } from './describe.js';
import { parseWebAdapterOptions, type WebAdapterOptions } from './options.js';
import { WebSession } from './session.js';

const BROWSERS: Record<WebAdapterOptions['browser'], BrowserType> = { chromium, firefox, webkit };

/**
 * Playwright adapter. Launches one browser lazily on the first session and gives every session
 * its own isolated browser context, so sessions share nothing (cookies, storage, cache).
 */
export class WebAdapter implements Adapter {
  readonly kind = 'web';
  readonly options: WebAdapterOptions;
  private readonly storageState: string | undefined;
  private readonly logger: Logger;
  private browser: Promise<Browser> | undefined;
  private description: AdapterDescription | undefined;

  constructor(factory: AdapterFactoryOptions) {
    this.options = parseWebAdapterOptions(factory.target.options, factory.target.id);
    this.logger = factory.logger.child('web');
    this.storageState =
      this.options.storageStatePath === undefined
        ? undefined
        : resolveInside(resolve(factory.rootDir), this.options.storageStatePath);
  }

  describe(): AdapterDescription {
    this.description ??= describeWebAdapter();
    return this.description;
  }

  validateAction(action: Action): Action {
    return parseOrThrow(WebActionSchema, action, 'action');
  }

  validateAssertion(assertion: Assertion): Assertion {
    return parseOrThrow(WebAssertionSchema, assertion, 'assertion');
  }

  async open(options: SessionOptions): Promise<AdapterSession> {
    const browser = await this.launch();
    const context = await browser.newContext({
      viewport: this.options.viewport,
      ...(this.storageState === undefined ? {} : { storageState: this.storageState }),
    });
    try {
      const page = await context.newPage();
      return new WebSession(context, page, this.options.baseUrl, options);
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    if (!browser) return;
    try {
      await (await browser).close();
    } catch (error) {
      this.logger.debug('Closing the browser failed', { error: String(error) });
    }
  }

  private launch(): Promise<Browser> {
    if (!this.browser) {
      const { browser: name, headless, launchOptions } = this.options;
      this.logger.debug('Launching browser', { browser: name, headless });
      const launching = BROWSERS[name].launch({
        // The CLI owns signal handling: Playwright's defaults would exit the process (SIGINT)
        // or close the browser mid-run (SIGTERM) before the engine can finish cleanly.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        ...(launchOptions as LaunchOptions),
        headless,
      });
      this.browser = launching;
      launching.then(
        (browser) =>
          browser.on('disconnected', () => {
            if (this.browser === launching) this.browser = undefined;
          }),
        () => {
          if (this.browser === launching) this.browser = undefined;
        },
      );
    }
    return this.browser;
  }
}

function parseOrThrow<T extends { type: string }>(
  schema: z.ZodType<T>,
  value: { type: string },
  what: 'action' | 'assertion',
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new MutationWorkflowError(
    'INVALID_INPUT',
    `Invalid web ${what} "${value.type}":\n${z.prettifyError(result.error)}`,
    { details: { [what]: value } },
  );
}

/** Create the web adapter for a target. This is the adapter package's entry point. */
export function createAdapter(options: AdapterFactoryOptions): Adapter {
  return new WebAdapter(options);
}
