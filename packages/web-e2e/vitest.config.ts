import { defineConfig } from 'vitest/config';

const isDocker = process.env.ENKEEP_DOCKER_ACCEPTANCE === '1' || process.env.RUN_DOCKER_TESTS === '1';

export default defineConfig({
  test: {
    include: isDocker
      ? ['tests/docker/**/*.test.ts']
      : ['tests/contract/**/*.test.ts'],
    exclude: isDocker
      ? ['dist/**', 'node_modules/**', '.demo-data/**']
      : ['dist/**', 'node_modules/**', '.demo-data/**', 'tests/docker/**'],
    testTimeout: 240000,
    hookTimeout: 240000,
    fileParallelism: false,
    pool: 'forks',
    singleFork: true,
  },
});
