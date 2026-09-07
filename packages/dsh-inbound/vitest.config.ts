import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.spec.ts',
      'packages/dsh-inbound/tests/**/*.test.ts',
      'packages/dsh-inbound/tests/**/*.spec.ts',
      'src/**/*.test.ts',
      'src/**/*.spec.ts',
    ],
    exclude: ['dist/**', 'node_modules/**', '.demo-data/**'],
  },
});
