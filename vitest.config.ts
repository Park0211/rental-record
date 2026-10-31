import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    restoreMocks: true,
  },
});
