import type { Config } from '../../config/schema.js';
import { findExecutable } from '../../util/exec.js';
import type { Logger } from '../../util/logger.js';
import { ClaudeCodeDriver } from '../drivers/claude-code.js';
import { CodexDriver } from '../drivers/codex.js';
import type { Provider } from '../provider.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import type { ModelPrice } from './pricing.js';

export * from './anthropic.js';
export * from './fake.js';
export * from './openai.js';
export * from './pricing.js';

export interface CreateProvidersOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  /** Working directory for coding-agent drivers; usually the project root. */
  rootDir?: string;
}

/**
 * Build providers from the config. Four kinds exist: `anthropic` and `openai` call a model API
 * with a key from the environment; `claude-code` and `codex` run the user's own coding agent as
 * a subprocess and need no key at all. With no `providers` section, whatever is available is
 * offered: API keys found in the environment and coding-agent command lines found on PATH. When
 * several are available the configuration must say which one to use; nothing is assumed, and no
 * model is ever chosen on the user's behalf.
 */
export function createProviders(
  config: Config,
  options: CreateProvidersOptions = {},
): Map<string, Provider> {
  const env = options.env ?? process.env;
  const providers = new Map<string, Provider>();
  const entries = Object.entries(config.providers);

  if (entries.length === 0) {
    if (env['ANTHROPIC_API_KEY']) {
      providers.set('anthropic', new AnthropicProvider({ apiKey: env['ANTHROPIC_API_KEY'] }));
    }
    if (env['OPENAI_API_KEY']) {
      providers.set('openai', new OpenAIProvider({ apiKey: env['OPENAI_API_KEY'] }));
    }
    if (findExecutable('claude', env)) {
      providers.set(
        'claude-code',
        new ClaudeCodeDriver({ id: 'claude-code', command: 'claude', cwd: options.rootDir }),
      );
    }
    if (findExecutable('codex', env)) {
      providers.set(
        'codex',
        new CodexDriver({ id: 'codex', command: 'codex', cwd: options.rootDir }),
      );
    }
    return providers;
  }

  for (const [id, entry] of entries) {
    switch (entry.type) {
      case 'anthropic':
      case 'openai': {
        const apiKey = env[entry.apiKeyEnv];
        if (!apiKey) {
          options.logger?.warn(
            `Provider "${id}" skipped: environment variable ${entry.apiKeyEnv} is not set`,
          );
          continue;
        }
        providers.set(
          id,
          entry.type === 'anthropic'
            ? new AnthropicProvider({
                id,
                apiKey,
                baseUrl: entry.baseUrl,
                pricing: toPrice(entry.pricing),
              })
            : new OpenAIProvider({
                id,
                apiKey,
                baseUrl: entry.baseUrl,
                pricing: toPrice(entry.pricing),
              }),
        );
        break;
      }
      case 'claude-code':
      case 'codex': {
        const isPath = entry.command.includes('/') || entry.command.includes('\\');
        if (!isPath && !findExecutable(entry.command, env)) {
          options.logger?.warn(
            `Provider "${id}" skipped: "${entry.command}" is not on PATH. Install it or set the command option.`,
          );
          continue;
        }
        const driverOptions = {
          id,
          command: entry.command,
          args: entry.args,
          cwd: options.rootDir,
        };
        providers.set(
          id,
          entry.type === 'claude-code'
            ? new ClaudeCodeDriver(driverOptions)
            : new CodexDriver(driverOptions),
        );
        break;
      }
    }
  }
  return providers;
}

function toPrice(
  pricing: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | undefined,
): ModelPrice | undefined {
  if (!pricing) return undefined;
  return {
    input: pricing.input,
    output: pricing.output,
    cacheRead: pricing.cacheRead ?? pricing.input * 0.1,
    cacheWrite: pricing.cacheWrite,
  };
}
