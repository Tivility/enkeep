import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@enkeep/channel-lark': path.resolve(__dirname, '../channel-lark/src/index.ts'),
      '@enkeep/web-channel': path.resolve(__dirname, '../web-channel/src/index.ts'),
    },
  },
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
