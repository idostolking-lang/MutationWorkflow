import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import {
  type AdapterLoader,
  createLogger,
  Engine,
  findConfigFile,
  type Logger,
  type LogLevel,
  loadConfig,
  type ModelProvider,
  MutationWorkflowError,
  parseConfig,
  type ResolvedConfig,
  resolveConfig,
  type Store,
} from '@mutationworkflow/core';

/** Environment variable naming the project root, for MCP clients that start servers elsewhere. */
export const PROJECT_DIR_ENV = 'MW_PROJECT_DIR';

/** The adapters shipped with the `mutationworkflow` package, keyed by target kind. */
export const BUILTIN_ADAPTERS: Readonly<Record<string, AdapterLoader>> = {
  web: () => import('@mutationworkflow/adapter-web'),
  cli: () => import('@mutationworkflow/adapter-cli'),
};

export interface ProjectLocation {
  /** Explicit `--cwd`; wins over the environment variable. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** The project root: `--cwd`, then `MW_PROJECT_DIR`, then the process working directory. */
export function resolveProjectDir(location: ProjectLocation = {}): string {
  const env = location.env ?? process.env;
  return resolve(location.cwd ?? env[PROJECT_DIR_ENV] ?? process.cwd());
}

/**
 * Find a config file in `dir` or the closest ancestor, so commands also work from a
 * subdirectory of the project.
 */
export function findConfigUpwards(dir: string): string | undefined {
  let current = resolve(dir);
  for (;;) {
    const found = findConfigFile(current);
    if (found) return found;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export interface LoadProjectConfigOptions {
  cwd: string;
  /** Explicit config file, relative to `cwd`. */
  configPath?: string;
  /** Build an in-memory bootstrap config when no file exists instead of failing. */
  allowMissing?: boolean;
}

/**
 * Load the project's config. Without a file, and when allowed, return a bootstrap config with
 * no targets rooted at `cwd`, so commands such as `setup`, `status` and `mcp` still work.
 */
export function loadProjectConfig(options: LoadProjectConfigOptions): ResolvedConfig {
  if (options.configPath) {
    const path = resolve(options.cwd, options.configPath);
    if (!existsSync(path)) {
      throw new MutationWorkflowError('CONFIG_NOT_FOUND', `Config file ${path} does not exist`);
    }
    return loadConfig({ cwd: options.cwd, path });
  }
  const found = findConfigUpwards(options.cwd);
  if (found) return loadConfig({ cwd: options.cwd, path: found });
  if (!options.allowMissing) return loadConfig({ cwd: options.cwd });
  return bootstrapConfig(options.cwd);
}

/** The minimal in-memory config used before `mw setup` or `mw init` wrote one. */
export function bootstrapConfig(rootDir: string): ResolvedConfig {
  const config = parseConfig(
    { version: 1, project: { name: basename(rootDir) || 'project' }, targets: [] },
    'bootstrap config',
  );
  return resolveConfig(config, rootDir);
}

export interface OpenEngineOptions extends LoadProjectConfigOptions {
  logLevel?: LogLevel;
  logger?: Logger;
  /** Override the providers built from the config (tests use a fake provider). */
  providers?: Map<string, ModelProvider>;
  /** Override the SQLite store from the config (tests use `:memory:`). */
  store?: Store;
  env?: NodeJS.ProcessEnv;
}

/** Load the config (or a bootstrap one) and create an engine with the built-in adapters. */
export function openEngine(options: OpenEngineOptions): Promise<Engine> {
  const config = loadProjectConfig(options);
  return Engine.create({
    config,
    logger: options.logger ?? createLogger({ level: options.logLevel ?? 'info' }),
    adapters: { ...BUILTIN_ADAPTERS },
    providers: options.providers,
    store: options.store,
    env: options.env,
  });
}
