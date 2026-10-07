import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.{ts,tsx}'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['apps/*/src/**/*.int.test.ts'],
          environment: 'node',
          globalSetup: ['apps/core/test/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
