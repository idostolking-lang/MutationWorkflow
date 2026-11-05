import { truncate } from '@mutationworkflow/core';

/** First line of an error message, without the call log Playwright appends. */
export function firstLine(message: string): string {
  return truncate(message.split('\n')[0] ?? message, 300);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
