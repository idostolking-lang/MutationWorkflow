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

/** The parts of a browser request the scope route decides on. */
export interface ScopedRequest {
  url: string;
  method: string;
  /** True for document loads of a frame, including popups and iframes. */
  isNavigation: boolean;
}

/** Methods without side effects; anything else (POST, PUT, PATCH, DELETE, …) may change state. */
const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * Why a request must be aborted before it leaves the browser, or `undefined` when it may
 * continue. Navigations and state-changing requests (any method but GET and HEAD) must stay in
 * scope; other GET subresources (fonts, scripts from a CDN) may load from anywhere so local
 * applications keep working.
 */
export function requestBlockReason(
  request: ScopedRequest,
  scope: Scope,
  baseUrl: string,
): string | undefined {
  const method = request.method.toUpperCase();
  if (!request.isNavigation && SAFE_METHODS.has(method)) return undefined;
  if (!/^https?:/i.test(request.url)) {
    // Navigations to data:, blob: or other schemes never reach the network; still keep the
    // tab on the application.
    return request.isNavigation ? `${request.url} is not an http(s) URL` : undefined;
  }
  return outOfScopeReason(request.url, scope, baseUrl);
}

/**
 * True when a URL's host is a loopback address: `localhost`, `*.localhost`, `127.0.0.0/8` or
 * `[::1]`. Other spellings of the same addresses are normalised by the URL parser first.
 */
export function isLoopbackUrl(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === '[::1]') return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  return octets?.slice(1).every((octet) => Number(octet) <= 255) ?? false;
}
