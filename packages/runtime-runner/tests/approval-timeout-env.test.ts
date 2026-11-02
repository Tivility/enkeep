/**
 * ENKEEP_APPROVAL_TIMEOUT_MS reaches the runtime process (Docker container env and host-mode
 * daemon env) only as a positive integer string, and the container spec validator admits it.
 * Synthetic users and temp paths only.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DockerRuntimeAdapter } from '../src/docker/adapter.js';
import { HostRuntimeAdapter } from '../src/host/adapter.js';
import { filterHostEnvironment } from '../src/host/security.js';
import {
  ALLOWED_ENV_KEYS,
  normalizeApprovalTimeoutEnv,
  validateContainerSpec,
} from '../src/spec/validator.js';

const KEY = 'ENKEEP_APPROVAL_TIMEOUT_MS';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ENKEEP_APPROVAL_TIMEOUT_MS runtime env', () => {
  it('normalizes only positive integer strings', () => {
    expect(normalizeApprovalTimeoutEnv('600000')).toBe('600000');
    expect(normalizeApprovalTimeoutEnv(' 1000 ')).toBe('1000');
    for (const bad of [undefined, '', '0', '-5', '1.5', '10s', '1e6', '0123', '99999999999999999', 600000]) {
      expect(normalizeApprovalTimeoutEnv(bad as unknown)).toBeUndefined();
    }
  });

  it('is copied into the Docker container env when valid, and the spec validates', () => {
    expect(ALLOWED_ENV_KEYS.has(KEY)).toBe(true);
    const adapter = new DockerRuntimeAdapter();

    vi.stubEnv(KEY, '900000');
    const spec = adapter.createDefaultUserSpec({ userId: 'alice' });
    expect(spec.environment[KEY]).toBe('900000');
    expect(validateContainerSpec(spec)).toEqual(expect.objectContaining({ valid: true }));

    vi.stubEnv(KEY, 'ten-minutes');
    const ignored = adapter.createDefaultUserSpec({ userId: 'alice' });
    expect(KEY in ignored.environment).toBe(false);

    vi.stubEnv(KEY, '');
    expect(KEY in adapter.createDefaultUserSpec({ userId: 'bob' }).environment).toBe(false);
  });

  it('rejects a malformed value in a container spec', () => {
    const adapter = new DockerRuntimeAdapter();
    const spec = adapter.createDefaultUserSpec({ userId: 'alice' });
    const bad = { ...spec, environment: { ...spec.environment, [KEY]: '5 minutes' } };
    const result = validateContainerSpec(bad);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('environment.ENKEEP_APPROVAL_TIMEOUT_MS must be a positive integer string');
  });

  it('is passed to the host-mode daemon env when valid, never when malformed', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-approval-env-'));
    try {
      const spec = new HostRuntimeAdapter().createDefaultUserSpec({ userId: 'alice', dataRoot });

      vi.stubEnv(KEY, '120000');
      expect(filterHostEnvironment(spec)[KEY]).toBe('120000');

      vi.stubEnv(KEY, '-1');
      expect(filterHostEnvironment(spec)[KEY]).toBeUndefined();
      // Explicit overrides are admitted only when well-formed.
      expect(filterHostEnvironment({ ...spec, environment: { [KEY]: '30000' } } as typeof spec)[KEY]).toBe('30000');
      expect(filterHostEnvironment({ ...spec, environment: { [KEY]: 'soon' } } as typeof spec)[KEY]).toBeUndefined();
      expect(filterHostEnvironment(spec, { [KEY]: 'later' })[KEY]).toBeUndefined();
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
