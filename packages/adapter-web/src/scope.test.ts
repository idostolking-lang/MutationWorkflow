import { ScopeSchema } from '@mutationworkflow/core';
import { describe, expect, it } from 'vitest';
import {
  compileDenyText,
  effectiveAllowUrls,
  isLoopbackUrl,
  matchingDenyText,
  outOfScopeReason,
  parseRegexPattern,
  requestBlockReason,
  resolveUrl,
  urlMatches,
} from './scope.js';

const BASE = 'http://127.0.0.1:4173';

describe('scope', () => {
  it('defaults allowUrls to the base URL origin', () => {
    const scope = ScopeSchema.parse({});
    expect(effectiveAllowUrls(scope, `${BASE}/app/`)).toEqual([`${BASE}/**`]);
    expect(outOfScopeReason(`${BASE}/todos`, scope, BASE)).toBeUndefined();
    expect(outOfScopeReason('https://example.com/', scope, BASE)).toMatch(/allowUrls/);
    expect(outOfScopeReason('about:blank', scope, BASE)).toBeUndefined();
  });

  it('applies configured allow and deny globs', () => {
    const scope = ScopeSchema.parse({
      allowUrls: [`${BASE}/app/**`],
      denyUrls: ['**/admin/**'],
    });
    expect(outOfScopeReason(`${BASE}/app/home`, scope, BASE)).toBeUndefined();
    expect(outOfScopeReason(`${BASE}/other`, scope, BASE)).toMatch(/allowUrls/);
    expect(outOfScopeReason(`${BASE}/app/admin/users`, scope, BASE)).toMatch(/denyUrls/);
  });

  it('resolves relative URLs against the base URL', () => {
    expect(resolveUrl('/todos', BASE)).toBe(`${BASE}/todos`);
    expect(resolveUrl('https://example.com/x', BASE)).toBe('https://example.com/x');
  });

  it('matches denyText case-insensitively and rejects invalid patterns', () => {
    const deny = compileDenyText(['delete account', '^log ?out$']);
    expect(matchingDenyText('Delete Account', deny)?.source).toBe('delete account');
    expect(matchingDenyText('Logout', deny)?.source).toBe('^log ?out$');
    expect(matchingDenyText('Save', deny)).toBeUndefined();
    expect(() => compileDenyText(['('])).toThrow(/denyText/);
  });
});

describe('patterns', () => {
  it('parses /regex/flags and ignores other text', () => {
    expect(parseRegexPattern('/to+dos/i')?.flags).toBe('i');
    expect(parseRegexPattern('/todos/**')).toBeUndefined();
    expect(parseRegexPattern('Todos')).toBeUndefined();
  });

  it('matches URLs by full glob, path glob or regex', () => {
    const url = `${BASE}/todos/12?tab=done`;
    expect(urlMatches(url, `${BASE}/todos`)).toBe(false);
    expect(urlMatches(url, `${BASE}/todos/**`)).toBe(true);
    expect(urlMatches(url, '/todos/*')).toBe(true);
    expect(urlMatches(url, '/todos')).toBe(false);
    expect(urlMatches(url, '/todos\\/\\d+/')).toBe(true);
  });
});

describe('requestBlockReason', () => {
  const scope = ScopeSchema.parse({ denyUrls: ['**/admin/**'] });
  const decide = (url: string, method: string, isNavigation: boolean) =>
    requestBlockReason({ url, method, isNavigation }, scope, BASE);

  it('blocks navigations out of scope and lets in-scope ones through', () => {
    expect(decide(`${BASE}/todos`, 'GET', true)).toBeUndefined();
    expect(decide('https://example.com/', 'GET', true)).toMatch(/example\.com.*allowUrls/);
    expect(decide(`${BASE}/admin/users`, 'GET', true)).toMatch(/denyUrls/);
    expect(decide('https://example.com/form', 'POST', true)).toMatch(/allowUrls/);
    expect(decide('data:text/html,hi', 'GET', true)).toMatch(/not an http/);
  });

  it('lets out-of-scope GET and HEAD subresources load', () => {
    expect(decide('https://cdn.example.com/font.woff2', 'GET', false)).toBeUndefined();
    expect(decide('https://cdn.example.com/lib.js', 'head', false)).toBeUndefined();
    expect(decide(`${BASE}/admin/logo.png`, 'GET', false)).toBeUndefined();
    expect(decide('data:image/png;base64,AA==', 'GET', false)).toBeUndefined();
  });

  it('blocks state-changing requests out of scope', () => {
    expect(decide(`${BASE}/api/todos`, 'POST', false)).toBeUndefined();
    expect(decide(`${BASE}/api/todos/1`, 'delete', false)).toBeUndefined();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(decide('https://api.example.com/charge', method, false)).toMatch(/allowUrls/);
    }
    expect(decide(`${BASE}/admin/reset`, 'POST', false)).toMatch(/denyUrls/);
    expect(decide('http://127.0.0.1:9999/other-app', 'POST', false)).toMatch(/allowUrls/);
  });
});

describe('isLoopbackUrl', () => {
  it.each([
    ['http://localhost', true],
    ['http://a.b.localhost:3000/', true],
    ['http://127.0.0.1:4173', true],
    ['http://127.255.255.254/', true],
    ['http://127.1/', true],
    ['http://[::1]:8080/', true],
    ['http://[0:0:0:0:0:0:0:1]/', true],
    ['http://localhost.evil.test/', false],
    ['http://evillocalhost/', false],
    ['http://192.168.1.10/', false],
    ['http://0.0.0.0/', false],
    ['http://[::2]/', false],
    ['https://example.com', false],
    ['not a url', false],
  ])('%s -> %s', (url, expected) => {
    expect(isLoopbackUrl(url)).toBe(expected);
  });
});
