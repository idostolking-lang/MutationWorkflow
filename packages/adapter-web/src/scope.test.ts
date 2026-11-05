import { ScopeSchema } from '@mutationworkflow/core';
import { describe, expect, it } from 'vitest';
import {
  compileDenyText,
  effectiveAllowUrls,
  matchingDenyText,
  outOfScopeReason,
  parseRegexPattern,
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
