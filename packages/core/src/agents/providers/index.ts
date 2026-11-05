import type { Config } from '../../config/schema.js';
import type { Logger } from '../../util/logger.js';
import type { ModelProvider } from '../provider.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';

export * from './anthropic.js';
export * from './fake.js';
export * from './openai.js';
export * from './pricing.js';

/**
 * Build providers from the config. With no `providers` section, providers are inferred from
 * the API keys present in the environment, so a bare `ANTHROPIC_API_KEY` is enough to start.
 * Providers whose key is missing are skipped with a warning; deterministic commands still work.
 */
export function createProviders(
  config: Config,
  options: { env?: NodeJS.ProcessEnv; logger?: Logger } = {},
): Map<string, ModelProvider> {
  const env = options.env ?? process.env;
  const providers = new Map<string, ModelProvider>();
  const entries = Object.entries(config.providers);

  if (entries.length === 0) {
    if (env['ANTHROPIC_API_KEY']) {
      providers.set('anthropic', new AnthropicProvider({ apiKey: env['ANTHROPIC_API_KEY'] }));
    }
    if (env['OPENAI_API_KEY']) {
      providers.set('openai', new OpenAIProvider({ apiKey: env['OPENAI_API_KEY'] }));
    }
    return providers;
  }

  for (const [id, entry] of entries) {
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
        ? new AnthropicProvider({ id, apiKey, baseUrl: entry.baseUrl })
        : new OpenAIProvider({ id, apiKey, baseUrl: entry.baseUrl }),
    );
  }
  return providers;
}
