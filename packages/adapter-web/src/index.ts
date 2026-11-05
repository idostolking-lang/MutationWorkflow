/**
 * Playwright adapter for MutationWorkflow: drives web applications in a real browser and
 * collects screenshots, console output and network errors as evidence.
 */
import { createAdapter } from './adapter.js';

export * from './actions.js';
export { createAdapter, WebAdapter } from './adapter.js';
export * from './assertions.js';
export { describeWebAdapter, describeWebAdapter as describe, WEB_GUIDE } from './describe.js';
export * from './locator.js';
export * from './options.js';
export { WebSession } from './session.js';

export default { createAdapter };
