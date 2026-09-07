import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.spec.ts',
      'packages/dsh-receipt-store-sqlite/tests/**/*.test.ts',
      'packages/dsh-receipt-store-sqlite/tests/**/*.spec.ts',
      'src/**/*.test.ts',
      'src/**/*.spec.ts',
    ],
    exclude: ['dist/**', 'node_modules/**', '.demo-data/**'],
  },
});
