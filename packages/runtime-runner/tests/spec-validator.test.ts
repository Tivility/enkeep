/**
 * Container Specification Validator Tests (Package Local)
 *
 * @module @enkeep/runtime-runner/tests/spec-validator.test
 */

import { describe, it, expect } from 'vitest';
import {
  validateContainerSpec,
  validateCrossUserIsolation,
  is64HexContainerId,
  DEMO_LABEL_KEY,
  DEMO_LABEL_VALUE,
  USER_LABEL_KEY,
  RUN_ID_LABEL_KEY,
  VOLUME_ID_LABEL_KEY,
  type RuntimeContainerSpec,
} from '../src/index.js';

const VALID_VOL_ID_ALICE = 'vol_0123456789abcdef0123456789abcdef';
const VALID_VOL_ID_BOB = 'vol_fedcba9876543210fedcba9876543210';

function createValidSpec(overrides: Partial<RuntimeContainerSpec> = {}): RuntimeContainerSpec {
  const userId = overrides.userId || 'alice';
  const runId = overrides.runId || 'run_test_123';
  const volumeId = overrides.volume?.volumeId || (userId === 'bob' ? VALID_VOL_ID_BOB : VALID_VOL_ID_ALICE);
  return {
    userId,
    runId,
    containerName: `enkeep-demo-${userId}`,
    image: 'enkeep-demo-runtime:latest',
    user: '1000:1000',
    workingDir: '/home/dsh',
    volume: {
      volumeName: `enkeep-demo-dsh-${userId}`,
      volumeId,
      containerPath: '/home/dsh',
      ...overrides.volume,
    },
    networkMode: 'none', // Strictly zero-network
    labels: {
      [DEMO_LABEL_KEY]: DEMO_LABEL_VALUE,
      [USER_LABEL_KEY]: userId,
      [RUN_ID_LABEL_KEY]: runId,
      [VOLUME_ID_LABEL_KEY]: volumeId,
      ...overrides.labels,
    },
    environment: {
      DSH_USER: userId,
      DSH_HOME: '/home/dsh/.dsh',
      DSH_SPACES: '/home/dsh/spaces',
    },
    ...overrides,
  };
}

describe('Container Specification Validator (Zero-Network Architecture)', () => {
  describe('Valid Specification Acceptance', () => {
    it('accepts a valid Alice zero-network container specification with volumeId', () => {
      const spec = createValidSpec();
      const result = validateContainerSpec(spec);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts a valid Bob zero-network container specification with volumeId', () => {
      const spec = createValidSpec({
        userId: 'bob',
      });
      const result = validateContainerSpec(spec);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('64-Hex Container ID Validation', () => {
    it('correctly validates valid full 64-hex SHA256 IDs (lowercase only)', () => {
      expect(is64HexContainerId('a'.repeat(64))).toBe(true);
      expect(is64HexContainerId('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')).toBe(true);
    });

    it('rejects uppercase, invalid or truncated container IDs', () => {
      expect(is64HexContainerId('')).toBe(false);
      expect(is64HexContainerId('a'.repeat(63))).toBe(false);
      expect(is64HexContainerId('a'.repeat(65))).toBe(false);
      expect(is64HexContainerId('cid-short-prefix')).toBe(false);
      expect(is64HexContainerId('g'.repeat(64))).toBe(false); // 'g' is not hex
      expect(is64HexContainerId('ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789')).toBe(false); // uppercase rejected
      expect(is64HexContainerId(undefined)).toBe(false);
      expect(is64HexContainerId(null)).toBe(false);
      expect(is64HexContainerId(12345)).toBe(false);
    });
  });

  describe('Strict Zero-Network Enforcement', () => {
    it('rejects networkMode bridge', () => {
      const spec: Record<string, unknown> = {
        ...createValidSpec(),
        networkMode: 'bridge',
      };
      const result = validateContainerSpec(spec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('networkMode MUST be "none"'))).toBe(true);
    });

    it('rejects published ports under zero-network mode', () => {
      const spec: Record<string, unknown> = {
        ...createValidSpec(),
        publishedPorts: [
          { hostIp: '127.0.0.1', hostPort: 3101, containerPort: 3100 },
        ],
      };
      const result = validateContainerSpec(spec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('publishedPorts is strictly forbidden'))).toBe(true);
    });

    it('rejects environment with unexpected keys such as HOST 0.0.0.0 binding', () => {
      const spec = createValidSpec({
        environment: {
          DSH_USER: 'alice',
          DSH_HOME: '/home/dsh/.dsh',
          DSH_SPACES: '/home/dsh/spaces',
          HOST: '0.0.0.0',
        },
      });
      const result = validateContainerSpec(spec);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some(
          (e) =>
            e.includes('Forbidden extra environment variable') ||
            e.includes('Forbidden listening host pattern')
        )
      ).toBe(true);
    });
  });

  describe('Non-Root Security Guardrail', () => {
    it('rejects root user "0"', () => {
      const spec = createValidSpec({ user: '0' });
      const result = validateContainerSpec(spec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('MUST run as non-root'))).toBe(true);
    });

    it('rejects root user "root"', () => {
      const spec = createValidSpec({ user: 'root' });
      const result = validateContainerSpec(spec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('MUST run as non-root'))).toBe(true);
    });

    it('rejects root user "0:0"', () => {
      const spec = createValidSpec({ user: '0:0' });
      const result = validateContainerSpec(spec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('MUST run as non-root'))).toBe(true);
    });
  });

  describe('Container & Volume Isolation & Regex Guardrails', () => {
    it('rejects container name without enkeep-demo- prefix', () => {
      const spec = createValidSpec({ containerName: 'my-custom-container' });
      const result = validateContainerSpec(spec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('must match pattern'))).toBe(true);
    });

    it('rejects container name with newline or command injection characters', () => {
      const spec1 = createValidSpec({ containerName: 'enkeep-demo-alice\nmalicious' });
      expect(validateContainerSpec(spec1).valid).toBe(false);

      const spec2 = createValidSpec({ containerName: 'enkeep-demo-alice; rm -rf /' });
      expect(validateContainerSpec(spec2).valid).toBe(false);

      const spec3 = createValidSpec({ containerName: 'enkeep-demo-alice`touch /tmp/pwn`' });
      expect(validateContainerSpec(spec3).valid).toBe(false);
    });

    it('rejects volume name with newline or command injection characters', () => {
      const spec = createValidSpec({
        volume: {
          volumeName: 'enkeep-demo-dsh-alice\nmalicious',
          volumeId: VALID_VOL_ID_ALICE,
          containerPath: '/home/dsh',
        },
      });
      const result = validateContainerSpec(spec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('must match pattern'))).toBe(true);
    });

    it('rejects volume name without enkeep-demo-dsh- prefix', () => {
      const spec = createValidSpec({
        volume: {
          volumeName: 'custom-volume-alice',
          volumeId: VALID_VOL_ID_ALICE,
          containerPath: '/home/dsh',
        },
      });
      const result = validateContainerSpec(spec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('must match pattern'))).toBe(true);
    });

    it('rejects volume name not scoped to userId', () => {
      const spec = createValidSpec({
        userId: 'alice',
        volume: {
          volumeName: 'enkeep-demo-dsh-bob',
          volumeId: VALID_VOL_ID_ALICE,
          containerPath: '/home/dsh',
        },
      });
      const result = validateContainerSpec(spec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('must be scoped to user'))).toBe(true);
    });

    it('rejects substring collisions (e.g. user "ice" with "enkeep-demo-dsh-alice" volume)', () => {
      const spec = createValidSpec({
        userId: 'ice',
        containerName: 'enkeep-demo-ice',
        volume: {
          volumeName: 'enkeep-demo-dsh-alice',
          volumeId: 'vol_00000000000000000000000000000001',
          containerPath: '/home/dsh',
        },
        labels: {
          [DEMO_LABEL_KEY]: DEMO_LABEL_VALUE,
          [USER_LABEL_KEY]: 'ice',
          [RUN_ID_LABEL_KEY]: 'run_test_123',
          [VOLUME_ID_LABEL_KEY]: 'vol_00000000000000000000000000000001',
        },
        environment: {
          DSH_USER: 'ice',
          DSH_HOME: '/home/dsh/.dsh',
          DSH_SPACES: '/home/dsh/spaces',
        },
      });
      const result = validateContainerSpec(spec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('must be scoped to user'))).toBe(true);
    });

    it('rejects containerName substring collisions (e.g. user "ice" with "enkeep-demo-alice" container)', () => {
      const spec = createValidSpec({
        userId: 'ice',
        containerName: 'enkeep-demo-alice',
        volume: {
          volumeName: 'enkeep-demo-dsh-ice',
          volumeId: 'vol_00000000000000000000000000000001',
          containerPath: '/home/dsh',
        },
        labels: {
          [DEMO_LABEL_KEY]: DEMO_LABEL_VALUE,
          [USER_LABEL_KEY]: 'ice',
          [RUN_ID_LABEL_KEY]: 'run_test_123',
          [VOLUME_ID_LABEL_KEY]: 'vol_00000000000000000000000000000001',
        },
        environment: {
          DSH_USER: 'ice',
          DSH_HOME: '/home/dsh/.dsh',
          DSH_SPACES: '/home/dsh/spaces',
        },
      });
      const result = validateContainerSpec(spec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('must be scoped to userId'))).toBe(true);
    });

    it('rejects userId with trim differences, leading/trailing whitespace, or uppercase characters', () => {
      const whitespaceSpec1 = createValidSpec({ userId: ' alice' });
      expect(validateContainerSpec(whitespaceSpec1).valid).toBe(false);

      const whitespaceSpec2 = createValidSpec({ userId: 'alice ' });
      expect(validateContainerSpec(whitespaceSpec2).valid).toBe(false);

      const uppercaseSpec = createValidSpec({ userId: 'Alice' });
      expect(validateContainerSpec(uppercaseSpec).valid).toBe(false);
    });

    it('rejects volume.readOnly=true as runtime requires a writable home volume', () => {
      const spec = createValidSpec({
        volume: {
          volumeName: 'enkeep-demo-dsh-alice',
          volumeId: VALID_VOL_ID_ALICE,
          containerPath: '/home/dsh',
          readOnly: true,
        },
      });
      const result = validateContainerSpec(spec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('volume.readOnly=true is forbidden'))).toBe(true);
    });

    it('accepts volume with readOnly=false or undefined', () => {
      const spec1 = createValidSpec({
        volume: {
          volumeName: 'enkeep-demo-dsh-alice',
          volumeId: VALID_VOL_ID_ALICE,
          containerPath: '/home/dsh',
          readOnly: false,
        },
      });
      expect(validateContainerSpec(spec1).valid).toBe(true);
    });

    it('rejects missing or invalid volumeId format', () => {
      const spec1 = createValidSpec({
        volume: {
          volumeName: 'enkeep-demo-dsh-alice',
          volumeId: '',
          containerPath: '/home/dsh',
        },
      });
      expect(validateContainerSpec(spec1).valid).toBe(false);

      const spec2 = createValidSpec({
        volume: {
          volumeName: 'enkeep-demo-dsh-alice',
          volumeId: 'invalid-no-vol-prefix',
          containerPath: '/home/dsh',
        },
      });
      expect(validateContainerSpec(spec2).valid).toBe(false);
    });

    it('rejects missing or invalid runId format', () => {
      const spec1 = createValidSpec({ runId: '' });
      expect(validateContainerSpec(spec1).valid).toBe(false);

      const spec2 = createValidSpec({ runId: 'invalid-no-run-prefix' });
      expect(validateContainerSpec(spec2).valid).toBe(false);
    });

    it('rejects missing app=enkeep-demo label', () => {
      const spec = createValidSpec({
        labels: {
          [USER_LABEL_KEY]: 'alice',
          [RUN_ID_LABEL_KEY]: 'run_123',
          [VOLUME_ID_LABEL_KEY]: VALID_VOL_ID_ALICE,
        },
      });
      const result = validateContainerSpec(spec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('labels must contain app: enkeep-demo'))).toBe(true);
    });

    it('rejects mismatched user label', () => {
      const spec = createValidSpec({
        userId: 'alice',
        labels: {
          [DEMO_LABEL_KEY]: DEMO_LABEL_VALUE,
          [USER_LABEL_KEY]: 'bob',
          [RUN_ID_LABEL_KEY]: 'run_123',
          [VOLUME_ID_LABEL_KEY]: VALID_VOL_ID_ALICE,
        },
      });
      const result = validateContainerSpec(spec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('matching the container userId'))).toBe(true);
    });

    it('rejects mismatched volumeId label', () => {
      const spec = createValidSpec({
        userId: 'alice',
        volume: {
          volumeName: 'enkeep-demo-dsh-alice',
          volumeId: VALID_VOL_ID_ALICE,
          containerPath: '/home/dsh',
        },
        labels: {
          [DEMO_LABEL_KEY]: DEMO_LABEL_VALUE,
          [USER_LABEL_KEY]: 'alice',
          [RUN_ID_LABEL_KEY]: 'run_123',
          [VOLUME_ID_LABEL_KEY]: VALID_VOL_ID_BOB,
        },
      });
      const result = validateContainerSpec(spec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('matching the volumeId'))).toBe(true);
    });
  });

  describe('Cross-User Pair Isolation Verification', () => {
    it('passes for independent Alice and Bob specifications', () => {
      const aliceSpec = createValidSpec({ userId: 'alice' });
      const bobSpec = createValidSpec({ userId: 'bob' });

      const result = validateCrossUserIsolation(aliceSpec, bobSpec);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects cross-user volume leak when Alice and Bob share the same volume', () => {
      const aliceSpec = createValidSpec({
        userId: 'alice',
        volume: { volumeName: 'enkeep-demo-dsh-shared', volumeId: VALID_VOL_ID_ALICE, containerPath: '/home/dsh' },
      });
      const bobSpec = createValidSpec({
        userId: 'bob',
        volume: { volumeName: 'enkeep-demo-dsh-shared', volumeId: VALID_VOL_ID_BOB, containerPath: '/home/dsh' },
      });

      const result = validateCrossUserIsolation(aliceSpec, bobSpec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('CRITICAL VOLUME LEAK'))).toBe(true);
    });

    it('rejects cross-user volumeId collision', () => {
      const aliceSpec = createValidSpec({
        userId: 'alice',
        volume: { volumeName: 'enkeep-demo-dsh-alice', volumeId: VALID_VOL_ID_ALICE, containerPath: '/home/dsh' },
      });
      const bobSpec = createValidSpec({
        userId: 'bob',
        volume: { volumeName: 'enkeep-demo-dsh-bob', volumeId: VALID_VOL_ID_ALICE, containerPath: '/home/dsh' },
      });

      const result = validateCrossUserIsolation(aliceSpec, bobSpec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('share volumeId'))).toBe(true);
    });

    it('rejects container name collision between different users', () => {
      const aliceSpec = createValidSpec({
        userId: 'alice',
        containerName: 'enkeep-demo-colliding',
      });
      const bobSpec = createValidSpec({
        userId: 'bob',
        containerName: 'enkeep-demo-colliding',
      });

      const result = validateCrossUserIsolation(aliceSpec, bobSpec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Container name collision'))).toBe(true);
    });
  });
});
