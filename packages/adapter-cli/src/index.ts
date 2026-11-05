import { createAdapter } from './adapter.js';

export * from './actions.js';
export {
  CliAdapter,
  createAdapter,
  describeCliAdapter,
  describeCliAdapter as describe,
} from './adapter.js';
export * from './assertions.js';
export { type CliTargetOptions, CliTargetOptionsSchema } from './options.js';
export { CliSession } from './session.js';

export default { createAdapter };
