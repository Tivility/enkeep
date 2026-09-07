/**
 * Real Docker E2E Acceptance Test (Layer B).
 *
 * Runs exclusively under `pnpm run test:docker` (with ENKEEP_RUNTIME_IMAGE).
 * Completely excluded from normal unit test runs.
 * Fails closed immediately if Docker daemon or ENKEEP_RUNTIME_IMAGE is missing.
 *
 * @module @enkeep/web-e2e/tests/docker/docker-e2e.test
 */

import { describe, it, expect } from 'vitest';
import { runRealDockerE2ETest } from '../../src/docker/docker-e2e-runner.js';

describe('Real Docker E2E Acceptance (Layer B)', () => {
  it('executes full live Docker E2E browser and container verification', async () => {
    const result = await runRealDockerE2ETest();
    expect(result.passed).toBe(true);
  }, 360000);
});
