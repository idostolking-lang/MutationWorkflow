import { MutationWorkflowError } from '@mutationworkflow/core';
import { describe, expect, it } from 'vitest';
import { parseWebAdapterOptions } from './options.js';

describe('parseWebAdapterOptions', () => {
  it('applies defaults', () => {
    expect(parseWebAdapterOptions({ baseUrl: 'http://localhost:3000' })).toEqual({
      baseUrl: 'http://localhost:3000',
      allowRemoteBaseUrl: false,
      browser: 'chromium',
      headless: true,
      viewport: { width: 1280, height: 800 },
      launchOptions: {},
    });
  });

  it('keeps explicit values', () => {
    const options = parseWebAdapterOptions({
      baseUrl: 'https://app.test/base',
      allowRemoteBaseUrl: true,
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

  it.each([
    'http://localhost:3000',
    'http://app.localhost:8080/',
    'http://127.0.0.1:4173',
    'http://127.12.0.3/',
    'http://[::1]:3000/',
    'https://LOCALHOST./x',
  ])('accepts the loopback baseUrl %s', (baseUrl) => {
    expect(parseWebAdapterOptions({ baseUrl }).baseUrl).toBe(baseUrl);
  });

  it.each([
    'https://example.com',
    'http://localhost.example.com',
    'http://10.0.0.5:3000',
    'http://128.0.0.1',
    'http://[::ffff:127.0.0.1]/',
    'http://0.0.0.0:3000',
  ])('rejects the remote baseUrl %s unless allowRemoteBaseUrl is set', (baseUrl) => {
    expect(() => parseWebAdapterOptions({ baseUrl }, 'web')).toThrow(/allowRemoteBaseUrl/);
    try {
      parseWebAdapterOptions({ baseUrl }, 'web');
    } catch (error) {
      expect((error as MutationWorkflowError).code).toBe('CONFIG_INVALID');
    }
    expect(parseWebAdapterOptions({ baseUrl, allowRemoteBaseUrl: true }).baseUrl).toBe(baseUrl);
  });
});
