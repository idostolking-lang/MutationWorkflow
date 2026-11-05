import { defineConfig } from 'vitest/config';

const shared = {
  environment: 'node' as const,
  testTimeout: 30_000,
  hookTimeout: 60_000,
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts'],
        },
      },
      {
        test: {
          ...shared,
          name: 'e2e',
          include: ['packages/*/e2e/**/*.test.ts'],
          testTimeout: 120_000,
        },
      },
    ],
  },
});
