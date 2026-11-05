import { MutationWorkflowError } from '@mutationworkflow/core';
import { describe, expect, it } from 'vitest';
import { parseWebAdapterOptions } from './options.js';

describe('parseWebAdapterOptions', () => {
  it('applies defaults', () => {
    expect(parseWebAdapterOptions({ baseUrl: 'http://localhost:3000' })).toEqual({
      baseUrl: 'http://localhost:3000',
      browser: 'chromium',
      headless: true,
      viewport: { width: 1280, height: 800 },
      launchOptions: {},
    });
  });

  it('keeps explicit values', () => {
    const options = parseWebAdapterOptions({
      baseUrl: 'https://app.test/base',
      browser: 'firefox',
      headless: false,
      viewport: { width: 400, height: 300 },
      launchOptions: { slowMo: 50 },
      storageStatePath: 'auth.json',
    });
    expect(options.browser).toBe('firefox');
    expect(options.launchOptions).toEqual({ slowMo: 50 });
    expect(options.storageStatePath).toBe('auth.json');
  });

  it.each([
    [{}],
    [{ baseUrl: 'not a url' }],
    [{ baseUrl: 'ftp://example.com' }],
    [{ baseUrl: 'http://localhost', browser: 'edge' }],
    [{ baseUrl: 'http://localhost', viewport: { width: 0, height: 10 } }],
  ])('rejects %j with a CONFIG_INVALID error', (input) => {
    expect(() => parseWebAdapterOptions(input, 'web')).toThrow(MutationWorkflowError);
    try {
      parseWebAdapterOptions(input, 'web');
    } catch (error) {
      expect((error as MutationWorkflowError).code).toBe('CONFIG_INVALID');
      expect((error as Error).message).toContain('target "web"');
    }
  });
});
