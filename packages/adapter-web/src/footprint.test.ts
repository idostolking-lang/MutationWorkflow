import { ScopeSchema } from '@mutationworkflow/core';
import { describe, expect, it } from 'vitest';
import {
  FOOTPRINT_MAX_ENTRIES,
  FootprintRecorder,
  footprintPath,
  requestEndpoint,
  visitedPath,
} from './footprint.js';

const BASE = 'http://127.0.0.1:4173';
const scope = ScopeSchema.parse({ denyUrls: ['**/admin/**'] });

describe('footprint classification', () => {
  it('normalises paths without host, query or hash', () => {
    expect(footprintPath(`${BASE}/todos?filter=done#top`)).toBe('/todos');
    expect(footprintPath(`${BASE}`)).toBe('/');
    expect(footprintPath('not a url')).toBeUndefined();
  });

  it('records in-scope page visits only', () => {
    expect(visitedPath(`${BASE}/?x=1#a`, scope, BASE)).toBe('/');
    expect(visitedPath('https://example.com/', scope, BASE)).toBeUndefined();
    expect(visitedPath(`${BASE}/admin/users`, scope, BASE)).toBeUndefined();
    expect(visitedPath('about:blank', scope, BASE)).toBeUndefined();
  });

  it('turns fetch, XHR and non-GET requests into endpoints', () => {
    const endpoint = (method: string, resourceType: string, url = `${BASE}/api/todos?page=2`) =>
      requestEndpoint({ url, method, resourceType }, scope, BASE);
    expect(endpoint('GET', 'fetch')).toBe('GET /api/todos');
    expect(endpoint('GET', 'xhr')).toBe('GET /api/todos');
    expect(endpoint('post', 'fetch')).toBe('POST /api/todos');
    expect(endpoint('DELETE', 'xhr', `${BASE}/api/todos/3#x`)).toBe('DELETE /api/todos/3');
    // A form POST is a document request with a side effect.
    expect(endpoint('POST', 'document', `${BASE}/login`)).toBe('POST /login');
  });

  it('ignores document loads, static assets and out-of-scope requests', () => {
    const endpoint = (method: string, resourceType: string, url = `${BASE}/app.js`) =>
      requestEndpoint({ url, method, resourceType }, scope, BASE);
    expect(endpoint('GET', 'document', `${BASE}/`)).toBeUndefined();
    for (const type of ['script', 'stylesheet', 'image', 'font', 'media']) {
      expect(endpoint('GET', type)).toBeUndefined();
    }
    expect(endpoint('GET', 'other')).toBeUndefined();
    expect(endpoint('GET', 'fetch', 'https://example.com/api')).toBeUndefined();
    expect(endpoint('POST', 'fetch', 'https://example.com/charge')).toBeUndefined();
    expect(endpoint('POST', 'fetch', `${BASE}/admin/reset`)).toBeUndefined();
    expect(endpoint('GET', 'fetch', 'data:text/plain,hi')).toBeUndefined();
  });
});

describe('FootprintRecorder', () => {
  it('keeps unique entries in first-seen order', () => {
    const recorder = new FootprintRecorder(scope, BASE);
    recorder.navigated('about:blank');
    recorder.navigated(`${BASE}/`);
    recorder.requested({ url: `${BASE}/api/todos`, method: 'GET', resourceType: 'fetch' });
    recorder.navigated(`${BASE}/about#team`);
    recorder.navigated(`${BASE}/?again=1`);
    recorder.requested({ url: `${BASE}/api/todos`, method: 'POST', resourceType: 'fetch' });
    recorder.requested({ url: `${BASE}/api/todos?x`, method: 'GET', resourceType: 'fetch' });
    expect(recorder.snapshot()).toEqual({
      urls: ['/', '/about'],
      endpoints: ['GET /api/todos', 'POST /api/todos'],
    });
  });

  it('caps each list', () => {
    const recorder = new FootprintRecorder(scope, BASE);
    for (let i = 0; i < FOOTPRINT_MAX_ENTRIES + 10; i++) {
      recorder.navigated(`${BASE}/page/${i}`);
      recorder.requested({ url: `${BASE}/api/${i}`, method: 'PUT', resourceType: 'fetch' });
    }
    const { urls, endpoints } = recorder.snapshot();
    expect(urls).toHaveLength(FOOTPRINT_MAX_ENTRIES);
    expect(endpoints).toHaveLength(FOOTPRINT_MAX_ENTRIES);
    expect(urls.at(-1)).toBe(`/page/${FOOTPRINT_MAX_ENTRIES - 1}`);
  });
});
