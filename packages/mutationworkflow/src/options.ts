import { InvalidArgumentError } from 'commander';

/** Commander parser for positive integers. */
export function positiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('Expected a positive integer.');
  }
  return parsed;
}

/** Commander parser for comma-separated lists: "a,b, c" → ["a", "b", "c"]. */
export function commaList(value: string, previous: string[] = []): string[] {
  return [
    ...previous,
    ...value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  ];
}

/** Commander parser for repeatable options: `--workflow a --workflow b`. */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Commander parser restricted to a fixed set of values. */
export function oneOf<const T extends string>(values: ReadonlyArray<T>): (value: string) => T {
  return (value) => {
    const found = values.find((candidate) => candidate === value);
    if (!found) throw new InvalidArgumentError(`Expected one of: ${values.join(', ')}.`);
    return found;
  };
}
