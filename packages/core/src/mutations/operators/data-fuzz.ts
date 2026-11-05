import type { MutationOperator, Variant } from '../types.js';

/** Boundary and hostile inputs used by `data-fuzz` unless the config provides its own. */
export const DEFAULT_FUZZ_VALUES: readonly string[] = [
  '',
  ' ',
  'x'.repeat(2000),
  'Ünïcødé 🧪 テスト',
  '<script>alert(1)</script>',
  "' OR 1=1 --",
  '-1',
  '0',
  '99999999999999999999',
  '  padded  ',
  'line1\nline2',
  '{{template}}',
  'null',
  'undefined',
];

/** Short, single-line label for a fuzz value, used in variant titles. */
function fuzzLabel(value: string): string {
  if (value === '') return 'empty value';
  if (value.trim() === '') return 'whitespace';
  if (value.length > 24) return `${value.length}-char value`;
  return JSON.stringify(value);
}

/**
 * Replace user-provided data with boundary values. Expectations about the original data no
 * longer apply, so the fuzzed step's and the final expectations are dropped: these variants find
 * crashes, server errors and broken invariants, not validation messages.
 */
export const dataFuzzOperator: MutationOperator = {
  id: 'data-fuzz',
  description: 'Replaces input values with empty, huge, unicode and injection-style data',
  mutate(workflow, { hints, config }) {
    const values = config.fuzzValues ?? DEFAULT_FUZZ_VALUES;
    const { steps } = workflow;
    const variants: Variant[] = [];
    steps.forEach((step, index) => {
      for (const input of hints.inputActions) {
        if (input.type !== step.action.type || !(input.field in step.action)) continue;
        for (const value of values) {
          const fuzzed = { ...step, action: { ...step.action, [input.field]: value }, expect: [] };
          const label = fuzzLabel(value);
          variants.push({
            titleSuffix: `fuzz step ${index + 1} with ${label}`,
            description: `Enters ${label} as "${input.field}" in step ${index + 1} (${step.action.type}); the app should validate it or handle it, never crash`,
            // Later expectations may legitimately differ once the data changed; keep earlier ones.
            steps: steps.map((original, i) =>
              i === index ? fuzzed : i > index ? { ...original, expect: [] } : original,
            ),
            expect: [],
            params: { index, value },
          });
        }
      }
    });
    return variants;
  },
};
