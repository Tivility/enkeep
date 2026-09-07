import { defineConfig } from 'vitest/config';

const isDocker = process.env.ENKEEP_DOCKER_ACCEPTANCE === '1';

export default defineConfig({
  test: {
    include: isDocker
      ? ['tests/docker-optin.e2e.test.ts', 'tests/daemon-docker-topology.e2e.test.ts']
      : ['tests/**/*.test.ts'],
    exclude: isDocker
      ? ['dist/**', 'node_modules/**']
      : ['dist/**', 'node_modules/**', 'tests/docker-optin.e2e.test.ts', 'tests/daemon-docker-topology.e2e.test.ts'],
  },
});
