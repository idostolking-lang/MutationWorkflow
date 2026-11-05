/**
 * The `mutationworkflow` package: the `mw` command-line interface and the MCP server. The
 * engine itself lives in `@mutationworkflow/core`.
 */
export { createProgram, type MainOptions, main } from './cli.js';
export {
  BUILTIN_ADAPTERS,
  bootstrapConfig,
  findConfigUpwards,
  loadProjectConfig,
  type OpenEngineOptions,
  openEngine,
  PROJECT_DIR_ENV,
  resolveProjectDir,
} from './engine-factory.js';
export { CliExit, describeError, ExitCode } from './errors.js';
export {
  createMcpServer,
  type McpServerOptions,
  type ServeOptions,
  serveStdio,
} from './mcp/server.js';
export { VERSION } from './version.js';
