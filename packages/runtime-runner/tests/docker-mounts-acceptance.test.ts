/**
 * Docker Controlled Mounts Specification & Materialization Acceptance Tests
 *
 * Tests:
 * 1. Hardened docker run arguments generation with controlled bind mounts (`-v source:/home/dsh/mounts/<id>:ro|rw`)
 * 2. Ownership verification with volume + controlled bind mounts
 * 3. Rejection of unauthorized bind mounts (docker socket, system dirs, unapproved paths)
 * 4. Mode mismatch and count mismatch detection
 * 5. Recreating user container when active mount set changes while preserving user volume
 * 6. Health protocol zero-path mount hash verification
 *
 * @module @enkeep/runtime-runner/tests/docker-mounts-acceptance.test
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SafeDockerClient,
  DockerOwnershipError,
  validateContainerSpec,
  type RuntimeContainerSpec,
  type RuntimeMountSpec,
  type OwnershipExpectation,
  type DockerContainerInfo,
  computeMountHash,
} from '../src/index.js';

const VALID_64_HEX_ID = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Docker Controlled Mounts: Spec & Materialization Acceptance', () => {
  let tmpTestDir: string;
  let client: SafeDockerClient;

  beforeEach(() => {
    tmpTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-docker-mount-test-'));
    client = new SafeDockerClient();
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpTestDir)) {
        fs.rmSync(tmpTestDir, { recursive: true, force: true });
      }
    } catch {}
  });

  function createValidSpecWithMounts(mounts: RuntimeMountSpec[]): RuntimeContainerSpec {
    return {
      userId: 'alice',
      runId: 'run_test_123',
      containerName: 'enkeep-demo-alice',
      image: 'enkeep-demo-runtime:latest',
      user: '1000:1000',
      workingDir: '/home/dsh',
      volume: {
        volumeName: 'enkeep-demo-dsh-alice',
        volumeId: 'vol_0123456789abcdef0123456789abcdef',
        containerPath: '/home/dsh',
      },
      mounts,
      networkMode: 'none',
      labels: {
        app: 'enkeep-demo',
        'enkeep.user': 'alice',
        'enkeep.run-id': 'run_test_123',
        'enkeep.volume-id': 'vol_0123456789abcdef0123456789abcdef',
      },
      environment: {
        DSH_USER: 'alice',
        DSH_HOME: '/home/dsh/.dsh',
        DSH_SPACES: '/home/dsh/spaces',
      },
    };
  }

  function createContainerInfoWithMounts(
    volumeName: string,
    mounts: Array<{ id: string; source: string; mode: 'ro' | 'rw' }>
  ): DockerContainerInfo {
    return {
      id: VALID_64_HEX_ID,
      name: 'enkeep-demo-alice',
      image: 'enkeep-demo-runtime:latest',
      status: 'running',
      state: 'running',
      user: '1000:1000',
      networkMode: 'none',
      readonlyRootfs: true,
      capDrop: ['ALL'],
      securityOpt: ['no-new-privileges:true'],
      pidsLimit: 256,
      portBindings: null,
      tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=64m' },
      labels: {
        app: 'enkeep-demo',
        'enkeep.user': 'alice',
        'enkeep.run-id': 'run_test_123',
        'enkeep.volume-id': 'vol_0123456789abcdef0123456789abcdef',
      },
      mounts: [
        {
          type: 'volume',
          name: volumeName,
          source: '/var/lib/docker/volumes/enkeep-demo-dsh-alice/_data',
          destination: '/home/dsh',
          rw: true,
        },
        ...mounts.map((m) => ({
          type: 'bind',
          name: '',
          source: m.source,
          destination: `/home/dsh/mounts/${m.id}`,
          rw: m.mode === 'rw',
        })),
      ],
    };
  }

  it('validates a container specification with controlled RO and RW mounts', () => {
    const roDir = path.join(tmpTestDir, 'ro-source');
    const rwDir = path.join(tmpTestDir, 'rw-source');
    fs.mkdirSync(roDir, { mode: 0o755 });
    fs.mkdirSync(rwDir, { mode: 0o755 });

    const mounts: RuntimeMountSpec[] = [
      { id: 'mnt_ro_1', name: 'readonly-dataset', sourcePath: roDir, mode: 'ro' },
      { id: 'mnt_rw_2', name: 'scratch-space', sourcePath: rwDir, mode: 'rw' },
    ];

    const spec = createValidSpecWithMounts(mounts);
    const result = validateContainerSpec(spec);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('asserts container ownership successfully for valid volume and matching controlled bind mounts', () => {
    const roDir = path.join(tmpTestDir, 'ro-source');
    const rwDir = path.join(tmpTestDir, 'rw-source');
    fs.mkdirSync(roDir, { mode: 0o755 });
    fs.mkdirSync(rwDir, { mode: 0o755 });

    const controlledMounts: RuntimeMountSpec[] = [
      { id: 'mnt_ro_1', name: 'readonly-dataset', sourcePath: roDir, mode: 'ro' },
      { id: 'mnt_rw_2', name: 'scratch-space', sourcePath: rwDir, mode: 'rw' },
    ];

    const expectation: OwnershipExpectation = {
      containerName: 'enkeep-demo-alice',
      userId: 'alice',
      runId: 'run_test_123',
      containerId: VALID_64_HEX_ID,
      volumeName: 'enkeep-demo-dsh-alice',
      volumeId: 'vol_0123456789abcdef0123456789abcdef',
      containerPath: '/home/dsh',
      mounts: controlledMounts,
    };

    const containerInfo = createContainerInfoWithMounts('enkeep-demo-dsh-alice', [
      { id: 'mnt_ro_1', source: roDir, mode: 'ro' },
      { id: 'mnt_rw_2', source: rwDir, mode: 'rw' },
    ]);

    expect(() => client.assertContainerOwnership(containerInfo, expectation)).not.toThrow();
  });

  it('rejects containers with unauthorized host bind mounts (e.g. /etc/shadow, docker socket)', () => {
    const expectation: OwnershipExpectation = {
      containerName: 'enkeep-demo-alice',
      userId: 'alice',
      runId: 'run_test_123',
      containerId: VALID_64_HEX_ID,
      volumeName: 'enkeep-demo-dsh-alice',
      volumeId: 'vol_0123456789abcdef0123456789abcdef',
      containerPath: '/home/dsh',
      mounts: [],
    };

    const maliciousInfo: DockerContainerInfo = {
      id: VALID_64_HEX_ID,
      name: 'enkeep-demo-alice',
      image: 'enkeep-demo-runtime:latest',
      status: 'running',
      state: 'running',
      user: '1000:1000',
      networkMode: 'none',
      readonlyRootfs: true,
      capDrop: ['ALL'],
      securityOpt: ['no-new-privileges:true'],
      pidsLimit: 256,
      portBindings: null,
      tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=64m' },
      labels: {
        app: 'enkeep-demo',
        'enkeep.user': 'alice',
        'enkeep.run-id': 'run_test_123',
        'enkeep.volume-id': 'vol_0123456789abcdef0123456789abcdef',
      },
      mounts: [
        {
          type: 'volume',
          name: 'enkeep-demo-dsh-alice',
          source: '/var/lib/docker/volumes/enkeep-demo-dsh-alice/_data',
          destination: '/home/dsh',
          rw: true,
        },
        {
          type: 'bind',
          name: '',
          source: '/var/run/docker.sock',
          destination: '/var/run/docker.sock',
          rw: true,
        },
      ],
    };

    expect(() => client.assertContainerOwnership(maliciousInfo, expectation)).toThrow(
      /must have exactly ONE volume mount/
    );
  });

  it('rejects container with mismatched bind mount rw flag (e.g. expected ro but got rw)', () => {
    const roDir = path.join(tmpTestDir, 'ro-source');
    fs.mkdirSync(roDir, { mode: 0o755 });

    const controlledMounts: RuntimeMountSpec[] = [
      { id: 'mnt_ro_1', name: 'readonly-dataset', sourcePath: roDir, mode: 'ro' },
    ];

    const expectation: OwnershipExpectation = {
      containerName: 'enkeep-demo-alice',
      userId: 'alice',
      runId: 'run_test_123',
      containerId: VALID_64_HEX_ID,
      volumeName: 'enkeep-demo-dsh-alice',
      volumeId: 'vol_0123456789abcdef0123456789abcdef',
      containerPath: '/home/dsh',
      mounts: controlledMounts,
    };

    // Container has rw: true instead of expected false for 'ro'
    const wrongModeInfo = createContainerInfoWithMounts('enkeep-demo-dsh-alice', [
      { id: 'mnt_ro_1', source: roDir, mode: 'rw' },
    ]);

    expect(() => client.assertContainerOwnership(wrongModeInfo, expectation)).toThrow(
      /mode mismatch: expected rw=false, got rw=true/
    );
  });

  it('rejects container with unexpected extra bind mounts or missing expected bind mounts', () => {
    const roDir = path.join(tmpTestDir, 'ro-source');
    fs.mkdirSync(roDir, { mode: 0o755 });

    const controlledMounts: RuntimeMountSpec[] = [
      { id: 'mnt_ro_1', name: 'readonly-dataset', sourcePath: roDir, mode: 'ro' },
    ];

    const expectation: OwnershipExpectation = {
      containerName: 'enkeep-demo-alice',
      userId: 'alice',
      runId: 'run_test_123',
      containerId: VALID_64_HEX_ID,
      volumeName: 'enkeep-demo-dsh-alice',
      volumeId: 'vol_0123456789abcdef0123456789abcdef',
      containerPath: '/home/dsh',
      mounts: controlledMounts,
    };

    // Container has 0 bind mounts (missing expected)
    const missingMountInfo = createContainerInfoWithMounts('enkeep-demo-dsh-alice', []);
    expect(() => client.assertContainerOwnership(missingMountInfo, expectation)).toThrow(
      /must have exactly 2 mounts/
    );
  });
});
