/**
 * ENKEEP_USER_QUESTIONS (gate, `1`/`0`) and ENKEEP_QUESTION_TIMEOUT_MS reach the runtime process
 * (Docker container env and host-mode daemon env) only in normalized form; a per-user option
 * overrides the platform process's gate; the container spec validator admits them.
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
  normalizeQuestionTimeoutEnv,
  normalizeUserQuestionsEnv,
  validateContainerSpec,
} from '../src/spec/validator.js';

const GATE = 'ENKEEP_USER_QUESTIONS';
const TIMEOUT = 'ENKEEP_QUESTION_TIMEOUT_MS';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('user question runtime env', () => {
  it('normalizes the gate to 1/0 and the timeout to a positive integer string', () => {
    expect(normalizeUserQuestionsEnv('1')).toBe('1');
    expect(normalizeUserQuestionsEnv(' 0 ')).toBe('0');
    for (const bad of [undefined, '', 'true', 'yes', '2', 1]) {
      expect(normalizeUserQuestionsEnv(bad as unknown)).toBeUndefined();
    }
    expect(normalizeQuestionTimeoutEnv('600000')).toBe('600000');
    for (const bad of [undefined, '', '0', '-5', '10m', 600000]) {
      expect(normalizeQuestionTimeoutEnv(bad as unknown)).toBeUndefined();
    }
  });

  it('leaves the Docker container env unchanged when nothing is set', () => {
    vi.stubEnv(GATE, undefined);
    vi.stubEnv(TIMEOUT, undefined);
    const spec = new DockerRuntimeAdapter().createDefaultUserSpec({ userId: 'alice' });
    expect(GATE in spec.environment).toBe(false);
    expect(TIMEOUT in spec.environment).toBe(false);
  });

  it('copies valid values into the Docker container env; a per-user option overrides the gate', () => {
    expect(ALLOWED_ENV_KEYS.has(GATE)).toBe(true);
    expect(ALLOWED_ENV_KEYS.has(TIMEOUT)).toBe(true);
    const adapter = new DockerRuntimeAdapter();

    vi.stubEnv(GATE, '1');
    vi.stubEnv(TIMEOUT, '900000');
    const spec = adapter.createDefaultUserSpec({ userId: 'alice' });
    expect(spec.environment[GATE]).toBe('1');
    expect(spec.environment[TIMEOUT]).toBe('900000');
    expect(validateContainerSpec(spec)).toEqual(expect.objectContaining({ valid: true }));

    expect(adapter.createDefaultUserSpec({ userId: 'bob', userQuestions: false }).environment[GATE]).toBe('0');

    vi.stubEnv(GATE, 'yes');
    vi.stubEnv(TIMEOUT, 'ten minutes');
    const ignored = adapter.createDefaultUserSpec({ userId: 'alice' });
    expect(GATE in ignored.environment).toBe(false);
    expect(TIMEOUT in ignored.environment).toBe(false);
    expect(adapter.createDefaultUserSpec({ userId: 'alice', userQuestions: true }).environment[GATE]).toBe('1');
  });

  it('rejects malformed values in a container spec', () => {
    vi.stubEnv(GATE, undefined);
    vi.stubEnv(TIMEOUT, undefined);
    const spec = new DockerRuntimeAdapter().createDefaultUserSpec({ userId: 'alice' });
    const bad = { ...spec, environment: { ...spec.environment, [GATE]: 'true', [TIMEOUT]: '5 minutes' } };
    const result = validateContainerSpec(bad);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('environment.ENKEEP_USER_QUESTIONS must be "1" or "0"');
    expect(result.errors).toContain('environment.ENKEEP_QUESTION_TIMEOUT_MS must be a positive integer string');
  });

  it('passes valid values to the host-mode daemon env; per-user values override, malformed ones are dropped', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-question-env-'));
    try {
      const adapter = new HostRuntimeAdapter();
      const spec = adapter.createDefaultUserSpec({ userId: 'alice', dataRoot });

      vi.stubEnv(GATE, undefined);
      vi.stubEnv(TIMEOUT, undefined);
      expect(filterHostEnvironment(spec)[GATE]).toBeUndefined();
      expect(filterHostEnvironment(spec)[TIMEOUT]).toBeUndefined();

      vi.stubEnv(GATE, '1');
      vi.stubEnv(TIMEOUT, '120000');
      expect(filterHostEnvironment(spec)[GATE]).toBe('1');
      expect(filterHostEnvironment(spec)[TIMEOUT]).toBe('120000');

      const optedOut = adapter.createDefaultUserSpec({ userId: 'bob', dataRoot, userQuestions: false });
      expect(filterHostEnvironment(optedOut)[GATE]).toBe('0');

      vi.stubEnv(GATE, 'on');
      vi.stubEnv(TIMEOUT, '-1');
      expect(filterHostEnvironment(spec)[GATE]).toBeUndefined();
      expect(filterHostEnvironment(spec)[TIMEOUT]).toBeUndefined();
      const optedIn = adapter.createDefaultUserSpec({ userId: 'alice', dataRoot, userQuestions: true });
      expect(filterHostEnvironment(optedIn)[GATE]).toBe('1');
      expect(filterHostEnvironment({ ...spec, environment: { [GATE]: 'maybe', [TIMEOUT]: 'soon' } } as typeof spec)[GATE]).toBeUndefined();
      expect(filterHostEnvironment(spec, { [GATE]: '1', [TIMEOUT]: '30000' })).toMatchObject({ [GATE]: '1', [TIMEOUT]: '30000' });
      expect(filterHostEnvironment(spec, { [TIMEOUT]: 'later' })[TIMEOUT]).toBeUndefined();
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
