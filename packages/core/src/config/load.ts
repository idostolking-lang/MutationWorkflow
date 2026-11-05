import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { MutationWorkflowError } from '../util/errors.js';
import { writeFileAtomic } from '../util/fs.js';
import { type Config, type ConfigInput, ConfigSchema } from './schema.js';

export const CONFIG_FILE_NAMES = [
  'mutationworkflow.config.yaml',
  'mutationworkflow.config.yml',
  'mutationworkflow.config.json',
] as const;

/** A validated configuration together with the paths it resolves against. */
export interface ResolvedConfig {
  config: Config;
  /** Absolute path of the config file, or undefined when built in memory. */
  path: string | undefined;
  /** Directory all relative paths in the config resolve against. */
  rootDir: string;
  resolvePath(relativeOrAbsolute: string): string;
}

export function findConfigFile(cwd: string): string | undefined {
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = resolve(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Replace `${VAR}` and `${VAR:-default}` in string values with environment variables, so
 * secrets and machine-specific paths stay out of the committed config file.
 */
export function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === 'string') {
    return value.replace(
      /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi,
      (_, name: string, fallback?: string) => {
        const found = env[name];
        if (found !== undefined) return found;
        if (fallback !== undefined) return fallback;
        throw new MutationWorkflowError(
          'CONFIG_INVALID',
          `Environment variable ${name} is referenced in the config but not set`,
        );
      },
    );
  }
  if (Array.isArray(value)) return value.map((item) => interpolateEnv(item, env));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolateEnv(v, env)]),
    );
  }
  return value;
}

export function parseConfig(raw: unknown, source = 'config'): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new MutationWorkflowError(
      'CONFIG_INVALID',
      `${source} is invalid:\n${z.prettifyError(result.error)}`,
    );
  }
  const ids = new Set<string>();
  for (const target of result.data.targets) {
    if (ids.has(target.id)) {
      throw new MutationWorkflowError(
        'CONFIG_INVALID',
        `${source}: duplicate target id "${target.id}"`,
      );
    }
    ids.add(target.id);
  }
  return result.data;
}

export function resolveConfig(config: Config, rootDir: string, path?: string): ResolvedConfig {
  return {
    config,
    path,
    rootDir,
    resolvePath: (p) => (isAbsolute(p) ? p : resolve(rootDir, p)),
  };
}

/** Load the config file at `path`, or discover one in `cwd`. */
export function loadConfig(options: { cwd?: string; path?: string } = {}): ResolvedConfig {
  const cwd = options.cwd ?? process.cwd();
  const path = options.path ? resolve(cwd, options.path) : findConfigFile(cwd);
  if (!path || !existsSync(path)) {
    throw new MutationWorkflowError(
      'CONFIG_NOT_FOUND',
      `No MutationWorkflow config found in ${cwd}. Run "mw init" or "mw setup" to create one.`,
    );
  }
  const text = readFileSync(path, 'utf8');
  const raw = path.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  const config = parseConfig(interpolateEnv(raw), path);
  return resolveConfig(config, dirname(path), path);
}

const HEADER = `# MutationWorkflow configuration.
# Reference: https://github.com/idostolking-lang/MutationWorkflow/blob/main/docs/configuration.md
`;

/** Serialise a config to YAML (validating it first) and write it atomically. */
export function writeConfigFile(path: string, config: ConfigInput): void {
  parseConfig(config, path);
  writeFileAtomic(path, `${HEADER}\n${stringifyYaml(config, { lineWidth: 100 })}`);
}
