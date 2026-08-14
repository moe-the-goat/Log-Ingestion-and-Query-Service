import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    // Integration files share one database and truncate between tests, so they cannot overlap.
    fileParallelism: false,
  },
});
