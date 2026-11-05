import { MutationWorkflowError, matchesAnyGlob, type Scope } from '@mutationworkflow/core';

/** Resolve an absolute or relative URL against the base URL, like a link would. */
export function resolveUrl(url: string, baseUrl: string): string {
  return new URL(url, baseUrl).href;
}

/** Allowed URL globs: the configured ones, or everything under the base URL's origin. */
export function effectiveAllowUrls(scope: Scope, baseUrl: string): string[] {
  return scope.allowUrls.length > 0 ? scope.allowUrls : [`${new URL(baseUrl).origin}/**`];
}

/**
 * Why a URL is out of scope, or `undefined` when it may be visited. `about:blank` is always
 * allowed: it is where every page starts.
 */
export function outOfScopeReason(url: string, scope: Scope, baseUrl: string): string | undefined {
  if (url === 'about:blank') return undefined;
  if (matchesAnyGlob(url, scope.denyUrls)) return `${url} matches scope.denyUrls`;
  if (!matchesAnyGlob(url, effectiveAllowUrls(scope, baseUrl))) {
    return `${url} is outside scope.allowUrls`;
  }
  return undefined;
}

/** Compile `scope.denyText` into case-insensitive regexes; throws `CONFIG_INVALID` on bad ones. */
export function compileDenyText(patterns: ReadonlyArray<string>): RegExp[] {
  return patterns.map((pattern) => {
    try {
      return new RegExp(pattern, 'i');
    } catch (error) {
      throw new MutationWorkflowError('CONFIG_INVALID', `Invalid scope.denyText "${pattern}"`, {
        cause: error,
      });
    }
  });
}

/** The first deny pattern matching the text, if any. */
export function matchingDenyText(
  text: string,
  denyText: ReadonlyArray<RegExp>,
): RegExp | undefined {
  return denyText.find((pattern) => pattern.test(text));
}

/**
 * Parse a `/regex/flags` pattern. Returns `undefined` for anything else, which callers treat as
 * a glob or plain text.
 */
export function parseRegexPattern(pattern: string): RegExp | undefined {
  const match = /^\/(.+)\/([dgimsuvy]*)$/s.exec(pattern);
  if (!match?.[1]) return undefined;
  return new RegExp(match[1], match[2]);
}

/**
 * Match a URL against a `/regex/` (searched anywhere in the URL) or a glob. A glob with a scheme
 * (`http://…`) matches the full URL; any other glob matches the path plus query, e.g. `/todos/*`.
 */
export function urlMatches(url: string, pattern: string): boolean {
  const regex = parseRegexPattern(pattern);
  if (regex) return regex.test(url);
  if (pattern.includes('://')) return matchesAnyGlob(url, [pattern]);
  const parsed = new URL(url);
  return matchesAnyGlob(`${parsed.pathname}${parsed.search}`, [pattern]);
}
