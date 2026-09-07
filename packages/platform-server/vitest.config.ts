import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    include: [
      'tests/**/*.test.ts',
      'packages/platform-server/tests/**/*.test.ts',
      'src/**/*.test.ts',
    ],
    exclude: ['dist/**', 'node_modules/**', '.demo-data/**'],
  },
});
