import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/test/unit/**/*.test.ts', 'apps/**/test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/**/test/integration/**/*.test.ts', 'apps/**/test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['./test/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false, // tests share one database; each file resets it
        },
      },
    ],
  },
});
