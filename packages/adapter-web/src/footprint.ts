import type { Footprint, Scope } from '@mutationworkflow/core';
import { outOfScopeReason } from './scope.js';

/** Most distinct entries each footprint list keeps. */
export const FOOTPRINT_MAX_ENTRIES = 200;

/** Resource types that are static assets: never endpoints, whatever their URL. */
const ASSET_RESOURCE_TYPES = new Set([
  'script',
  'stylesheet',
  'image',
  'font',
  'media',
  'texttrack',
  'manifest',
]);

/** Resource types of requests the page's own code makes. */
const API_RESOURCE_TYPES = new Set(['fetch', 'xhr']);

/** The parts of a browser request that decide where it lands in the footprint. */
export interface FootprintRequest {
  url: string;
  method: string;
  /** Playwright's resource type: document, fetch, xhr, script, image, … */
  resourceType: string;
}

/** The path of a URL without host, query or hash; `undefined` for unparseable URLs. */
export function footprintPath(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

/** True for http(s) URLs the scope allows the session to visit. */
function inScope(url: string, scope: Scope, baseUrl: string): boolean {
  return /^https?:/i.test(url) && outOfScopeReason(url, scope, baseUrl) === undefined;
}

/**
 * The page path a main-frame navigation to `url` adds to the footprint, or `undefined` when the
 * URL is out of scope or not http(s) (such as `about:blank`).
 */
export function visitedPath(url: string, scope: Scope, baseUrl: string): string | undefined {
  return inScope(url, scope, baseUrl) ? footprintPath(url) : undefined;
}

/**
 * The endpoint (`"<METHOD> <path>"`) a request adds to the footprint, or `undefined`.
 * Endpoints are in-scope requests that may reach the backend's logic: every method but GET, and
 * GETs the page's code makes with fetch or XHR. Document loads, static assets (scripts, styles,
 * images, fonts, media) and out-of-scope requests (which the scope route blocks when they are
 * not GETs) are not endpoints.
 */
export function requestEndpoint(
  request: FootprintRequest,
  scope: Scope,
  baseUrl: string,
): string | undefined {
  if (ASSET_RESOURCE_TYPES.has(request.resourceType)) return undefined;
  const method = request.method.toUpperCase();
  if (method === 'GET' && !API_RESOURCE_TYPES.has(request.resourceType)) return undefined;
  if (!inScope(request.url, scope, baseUrl)) return undefined;
  const path = footprintPath(request.url);
  return path === undefined ? undefined : `${method} ${path}`;
}

/** Accumulates a session's footprint: unique entries in first-seen order, capped. */
export class FootprintRecorder {
  private readonly urls = new Set<string>();
  private readonly endpoints = new Set<string>();

  constructor(
    private readonly scope: Scope,
    private readonly baseUrl: string,
  ) {}

  /** Record a main-frame navigation (load, link, reload, back/forward, history API). */
  navigated(url: string): void {
    add(this.urls, visitedPath(url, this.scope, this.baseUrl));
  }

  /** Record a request the page issued. */
  requested(request: FootprintRequest): void {
    add(this.endpoints, requestEndpoint(request, this.scope, this.baseUrl));
  }

  snapshot(): Footprint {
    return { urls: [...this.urls], endpoints: [...this.endpoints] };
  }
}

function add(entries: Set<string>, entry: string | undefined): void {
  if (entry !== undefined && entries.size < FOOTPRINT_MAX_ENTRIES) entries.add(entry);
}
