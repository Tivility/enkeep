import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import {
  writeProcessMetadata,
  readProcessMetadata,
  listDemoProcesses,
  removeProcessMetadata,
  planProcessTeardown,
  validateDockerContainerName,
  validateDockerLabels,
  validateContainerMetadata,
  getPidMetadataDir,
  getServicePidFilePath,
} from '../../scripts/safety/ownership.js';
import {
  DEMO_OWNERSHIP_TAG,
  DEMO_DOCKER_CONTAINER_PREFIX,
  DEMO_DOCKER_LABEL_KEY,
  DEMO_DOCKER_LABEL_VALUE,
} from '../../scripts/safety/constants.js';
import { SafetyViolationError } from '../../scripts/safety/errors.js';
import { findRepoRoot } from '../../scripts/safety/preflight.js';

describe('Ownership & Process Safeguards Module', () => {
  const repoRoot = findRepoRoot();
  const testPidDir = getPidMetadataDir(repoRoot);

  beforeEach(() => {
    // Clean test pid directory before each test
    if (existsSync(testPidDir)) {
      rmSync(testPidDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  afterEach(() => {
    // Clean up test pid directory after each test
    if (existsSync(testPidDir)) {
      rmSync(testPidDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  describe('writeProcessMetadata & readProcessMetadata', () => {
    it('writes and reads valid PID metadata with enkeep-demo owner', () => {
      const meta = writeProcessMetadata(
        {
          service: 'platform',
          pid: process.pid,
          port: 3100,
          command: 'node server.js',
        },
        repoRoot
      );

      expect(meta.owner).toBe(DEMO_OWNERSHIP_TAG);
      expect(meta.service).toBe('platform');
      expect(meta.pid).toBe(process.pid);
      expect(meta.port).toBe(3100);
      expect(meta.startedAt).toBeDefined();

      const read = readProcessMetadata('platform', repoRoot);
      expect(read).not.toBeNull();
      expect(read?.service).toBe('platform');
      expect(read?.pid).toBe(process.pid);
      expect(read?.owner).toBe(DEMO_OWNERSHIP_TAG);
      expect(read?.port).toBe(3100);
    });

    it('returns null when metadata file does not exist', () => {
      const read = readProcessMetadata('non-existent-service', repoRoot);
      expect(read).toBeNull();
    });

    it('throws when writing invalid metadata (invalid PID or missing service)', () => {
      expect(() =>
        writeProcessMetadata({ service: '', pid: 1234 }, repoRoot)
      ).toThrow(SafetyViolationError);

      expect(() =>
        writeProcessMetadata({ service: 'bad-pid', pid: -5 }, repoRoot)
      ).toThrow(SafetyViolationError);

      expect(() =>
        writeProcessMetadata({ service: 'zero-pid', pid: 0 }, repoRoot)
      ).toThrow(SafetyViolationError);
    });

    it('throws when metadata file has forged / invalid ownership tag', () => {
      // Manually create a tampered metadata file
      const filePath = getServicePidFilePath('forged-service', repoRoot);
      writeProcessMetadata({ service: 'forged-service', pid: 1234 }, repoRoot);

      // Tamper file content
      const tampered = {
        service: 'forged-service',
        pid: 1234,
        owner: 'foreign-system',
        startedAt: new Date().toISOString(),
      };
      writeFileSync(filePath, JSON.stringify(tampered), 'utf-8');

      expect(() => readProcessMetadata('forged-service', repoRoot)).toThrow(
        SafetyViolationError
      );
      try {
        readProcessMetadata('forged-service', repoRoot);
      } catch (err: any) {
        expect(err.code).toBe('UNVERIFIED_PROCESS_OWNERSHIP');
      }
    });

    it('throws when metadata JSON is malformed', () => {
      const filePath = getServicePidFilePath('corrupt-service', repoRoot);
      writeProcessMetadata({ service: 'corrupt-service', pid: 1234 }, repoRoot);
      writeFileSync(filePath, '{ malformed json ...', 'utf-8');

      expect(() => readProcessMetadata('corrupt-service', repoRoot)).toThrow(
        SafetyViolationError
      );
    });
  });

  describe('listDemoProcesses & removeProcessMetadata', () => {
    it('lists all valid registered processes', () => {
      writeProcessMetadata({ service: 'service-a', pid: 1111, port: 3101 }, repoRoot);
      writeProcessMetadata({ service: 'service-b', pid: 2222, port: 3102 }, repoRoot);

      const list = listDemoProcesses(repoRoot);
      expect(list).toHaveLength(2);
      const names = list.map(p => p.service).sort();
      expect(names).toEqual(['service-a', 'service-b']);
    });

    it('removes metadata cleanly on request', () => {
      writeProcessMetadata({ service: 'cleanup-service', pid: 3333 }, repoRoot);
      expect(readProcessMetadata('cleanup-service', repoRoot)).not.toBeNull();

      const removed = removeProcessMetadata('cleanup-service', repoRoot);
      expect(removed).toBe(true);
      expect(readProcessMetadata('cleanup-service', repoRoot)).toBeNull();

      // Second removal returns false
      expect(removeProcessMetadata('cleanup-service', repoRoot)).toBe(false);
    });
  });

  describe('planProcessTeardown', () => {
    it('refuses teardown if service has no metadata', () => {
      const plan = planProcessTeardown('untracked-service', repoRoot);
      expect(plan.canTerminate).toBe(false);
      expect(plan.reason).toContain('No metadata file found');
    });

    it('refuses teardown if service metadata has invalid ownership', () => {
      const filePath = getServicePidFilePath('foreign-service', repoRoot);
      writeProcessMetadata({ service: 'foreign-service', pid: 9999 }, repoRoot);

      writeFileSync(
        filePath,
        JSON.stringify({
          service: 'foreign-service',
          pid: 9999,
          owner: 'not-enkeep',
        }),
        'utf-8'
      );

      const plan = planProcessTeardown('foreign-service', repoRoot);
      expect(plan.canTerminate).toBe(false);
      expect(plan.reason).toContain('Safety verification error');
    });

    it('approves teardown for legitimate enkeep-demo registered process', () => {
      writeProcessMetadata({ service: 'legit-service', pid: process.pid }, repoRoot);

      const plan = planProcessTeardown('legit-service', repoRoot);
      expect(plan.canTerminate).toBe(true);
      expect(plan.service).toBe('legit-service');
      expect(plan.pid).toBe(process.pid);
      expect(plan.reason).toContain('Valid enkeep-demo process');
    });
  });

  describe('Docker Container Ownership Safeguards', () => {
    describe('validateDockerContainerName', () => {
      it('accepts container names starting with enkeep-demo-', () => {
        expect(() => validateDockerContainerName('enkeep-demo-platform')).not.toThrow();
        expect(() => validateDockerContainerName('enkeep-demo-bridge-1')).not.toThrow();
        expect(() => validateDockerContainerName('enkeep-demo-pg')).not.toThrow();
      });

      it('rejects containers without enkeep-demo- prefix', () => {
        expect(() => validateDockerContainerName('happyclaw-server')).toThrow(
          SafetyViolationError
        );
        expect(() => validateDockerContainerName('production-db')).toThrow(
          SafetyViolationError
        );
        expect(() => validateDockerContainerName('dsh-core')).toThrow(
          SafetyViolationError
        );
        expect(() => validateDockerContainerName('')).toThrow(
          SafetyViolationError
        );
      });
    });

    describe('validateDockerLabels', () => {
      it('accepts containers with app=enkeep-demo label', () => {
        expect(() =>
          validateDockerLabels({
            [DEMO_DOCKER_LABEL_KEY]: DEMO_DOCKER_LABEL_VALUE,
            env: 'test',
          })
        ).not.toThrow();
      });

      it('rejects containers missing app=enkeep-demo label or with wrong value', () => {
        expect(() => validateDockerLabels({})).toThrow(SafetyViolationError);
        expect(() =>
          validateDockerLabels({ app: 'production' })
        ).toThrow(SafetyViolationError);
        expect(() =>
          validateDockerLabels({ service: 'enkeep-demo' })
        ).toThrow(SafetyViolationError);
      });
    });

    describe('validateContainerMetadata', () => {
      it('validates both name prefix and label ownership', () => {
        expect(() =>
          validateContainerMetadata({
            name: `${DEMO_DOCKER_CONTAINER_PREFIX}test`,
            labels: { [DEMO_DOCKER_LABEL_KEY]: DEMO_DOCKER_LABEL_VALUE },
          })
        ).not.toThrow();

        expect(() =>
          validateContainerMetadata({
            name: 'wrong-name',
            labels: { [DEMO_DOCKER_LABEL_KEY]: DEMO_DOCKER_LABEL_VALUE },
          })
        ).toThrow(SafetyViolationError);
      });
    });
  });
});
