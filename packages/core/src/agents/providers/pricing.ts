import type { TokenUsage } from '../provider.js';

/** USD per million tokens. Estimates used for budgets and reports; billing is authoritative. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** Cache writes cost 1.25x input unless stated. */
  cacheWrite?: number;
}

/**
 * Known Anthropic list prices (first-party API). Matched by prefix so dated snapshots of a model
 * share its price. Unknown models yield no estimate rather than a wrong one.
 */
export const ANTHROPIC_PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};

export function findPrice(
  model: string,
  table: Record<string, ModelPrice>,
): ModelPrice | undefined {
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  const key = keys.find((candidate) => model === candidate || model.startsWith(`${candidate}-`));
  return key ? table[key] : undefined;
}

export function estimateCost(price: ModelPrice, usage: TokenUsage): number {
  const perToken = (perMillion: number) => perMillion / 1_000_000;
  return (
    usage.inputTokens * perToken(price.input) +
    usage.outputTokens * perToken(price.output) +
    usage.cacheReadTokens * perToken(price.cacheRead) +
    usage.cacheWriteTokens * perToken(price.cacheWrite ?? price.input * 1.25)
  );
}
