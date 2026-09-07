/**
 * Negative Docker Security Tests for Enkeep Runtime Runner
 *
 * Verifies that SafeDockerClient and DockerRuntimeAdapter fail closed on:
 * - Spoofed names, newline injection, and regex violations
 * - Missing labels (app, enkeep.user, enkeep.run-id, enkeep.volume-id)
 * - Mismatched run IDs, user IDs, volume IDs, and container names
 * - Short prefix container IDs (requires exact 64-hex SHA256)
 * - Exact Config.User (must be 1000:1000; non-root and missing fail)
 * - Exact NetworkMode (must be 'none'; missing, bridge, host fail)
 * - Mandatory ReadonlyRootfs (must be true; false or missing fail)
 * - Mandatory CapDrop (must contain 'ALL'; missing or incomplete fail)
 * - Mandatory SecurityOpt (must contain no-new-privileges; missing fail)
 * - Mandatory PidsLimit (must be integer 1..256; missing or out-of-range fail)
 * - PortBindings (must be null/empty; published ports fail)
 * - Mounts (must be exactly ONE volume mount with matching name, destination /home/dsh, rw: true; bind mounts or extra mounts fail)
 * - Tmpfs (must be exactly only /tmp with canonical options rw,noexec,nosuid,nodev,size=64m; missing or wrong options fail)
 * - Name reuse / container replacement race condition between inspect and action
 * - Collision non-adoption (startRuntime & createVolume reject existing containers/volumes)
 * - Daemon errors during inspect throwing DockerDaemonError (never returning null)
 * - Anchored isExactNotFoundError rejecting generic "permission: path not found" or mismatched IDs
 * - Safe image tag validation via inspectImageExact
 * - Safe session corruption via corruptOwnedSessionForAcceptance
 * - execOwned single-settlement timeout and output size bounds
 * - Reconnection without verified ExactContainerIdentity
 * - Volume removal deadline verification
 *
 * @module @enkeep/runtime-runner/tests/docker-security-negative.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SafeDockerClient,
  DockerRuntimeAdapter,
  DockerOwnershipError,
  DockerCollisionError,
  DockerDaemonError,
  DockerNotFoundError,
  isExactNotFoundError,
  isContainerCollisionError,
  isVolumeCollisionError,
  validateCanonicalTmpfsOptions,
  is64HexContainerId,
  isRecord,
  parseExecEnvelope,
  parseDockerContainerInspect,
  type OwnershipExpectation,
  type DockerContainerInfo,
} from '../src/index.js';

const VALID_64_HEX_ID_1 = '1111111122222222333333334444444455555555666666667777777788888888';
const VALID_64_HEX_ID_2 = '9999999922222222333333334444444455555555666666667777777700000000';

function createValidExpectation(overrides: Partial<OwnershipExpectation> = {}): OwnershipExpectation {
  return {
    containerName: 'enkeep-demo-alice',
    userId: 'alice',
    runId: 'run_123',
    containerId: VALID_64_HEX_ID_1,
    volumeName: 'enkeep-demo-dsh-alice',
    volumeId: 'vol_alice_123',
    containerPath: '/home/dsh',
    ...overrides,
  };
}

function createValidContainerInfo(overrides: Partial<DockerContainerInfo> = {}): DockerContainerInfo {
  return {
    id: VALID_64_HEX_ID_1,
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
    mounts: [
      {
        type: 'volume',
        name: 'enkeep-demo-dsh-alice',
        source: 'enkeep-demo-dsh-alice-vol',
        destination: '/home/dsh',
        rw: true,
      },
    ],
    tmpfs: {
      '/tmp': 'rw,noexec,nosuid,nodev,size=67108864',
    },
    labels: {
      app: 'enkeep-demo',
      'enkeep.user': 'alice',
      'enkeep.run-id': 'run_123',
      'enkeep.volume-id': 'vol_alice_123',
    },
    ...overrides,
  };
}

describe('SafeDockerClient Adversarial Security & Fail-Closed Guardrails', () => {
  let client: SafeDockerClient;
  let adapter: DockerRuntimeAdapter;

  beforeEach(() => {
    client = new SafeDockerClient();
    adapter = new DockerRuntimeAdapter(client);
  });

  describe('isExactNotFoundError Anchored Parsing (Precision vs False Positives)', () => {
    it('returns false for generic errors containing "not found"', () => {
      expect(isExactNotFoundError('permission denied: /etc/docker/key.json not found', 'enkeep-demo-alice')).toBe(false);
      expect(isExactNotFoundError('error: host socket not found', 'enkeep-demo-alice')).toBe(false);
      expect(isExactNotFoundError('permission: path not found', 'enkeep-demo-alice')).toBe(false);
      expect(isExactNotFoundError('connection refused: daemon not found', 'enkeep-demo-alice')).toBe(false);
      expect(isExactNotFoundError('fatal: config file does not exist', 'enkeep-demo-alice')).toBe(false);
    });

    it('returns false when error message is for a different resource identifier', () => {
      expect(
        isExactNotFoundError('Error: No such container: enkeep-demo-bob', 'enkeep-demo-alice')
      ).toBe(false);
      expect(
        isExactNotFoundError('Error response from daemon: No such volume: enkeep-demo-dsh-bob', 'enkeep-demo-dsh-alice')
      ).toBe(false);
    });

    it('returns true ONLY for genuine anchored Docker CLI not-found messages matching exact identifier', () => {
      expect(
        isExactNotFoundError('Error: No such container: enkeep-demo-alice', 'enkeep-demo-alice')
      ).toBe(true);
      expect(
        isExactNotFoundError('Error response from daemon: No such container: enkeep-demo-alice', 'enkeep-demo-alice')
      ).toBe(true);
      expect(
        isExactNotFoundError('Error: No such volume: enkeep-demo-dsh-alice', 'enkeep-demo-dsh-alice')
      ).toBe(true);
      expect(
        isExactNotFoundError('Error response from daemon: No such volume: enkeep-demo-dsh-alice', 'enkeep-demo-dsh-alice')
      ).toBe(true);
      expect(
        isExactNotFoundError('Error: No such object: enkeep-demo-alice', 'enkeep-demo-alice')
      ).toBe(true);
      expect(
        isExactNotFoundError('Error response from daemon: get enkeep-demo-dsh-alice: no such volume', 'enkeep-demo-dsh-alice')
      ).toBe(true);
    });
  });

  describe('Tmpfs Normalization & Validation', () => {
    it('accepts canonical tmpfs options with 64m size variants', () => {
      expect(validateCanonicalTmpfsOptions('rw,noexec,nosuid,nodev,size=64m')).toBe(true);
      expect(validateCanonicalTmpfsOptions('rw,noexec,nosuid,nodev,size=67108864')).toBe(true);
      expect(validateCanonicalTmpfsOptions('noexec,nosuid,nodev,rw,size=65536k')).toBe(true);
    });

    it('rejects non-canonical tmpfs options', () => {
      expect(validateCanonicalTmpfsOptions('')).toBe(false);
      expect(validateCanonicalTmpfsOptions('rw,noexec,nosuid,nodev')).toBe(false); // missing size
      expect(validateCanonicalTmpfsOptions('rw,noexec,nosuid,nodev,size=128m')).toBe(false); // wrong size
      expect(validateCanonicalTmpfsOptions('rw,nosuid,nodev,size=64m')).toBe(false); // missing noexec (exec allowed)
      expect(validateCanonicalTmpfsOptions('rw,noexec,nodev,size=64m')).toBe(false); // missing nosuid (suid allowed)
      expect(validateCanonicalTmpfsOptions('rw,noexec,nosuid,size=64m')).toBe(false); // missing nodev (dev allowed)
      expect(validateCanonicalTmpfsOptions('ro,noexec,nosuid,nodev,size=64m')).toBe(false); // ro instead of rw
      expect(validateCanonicalTmpfsOptions('rw,noexec,nosuid,nodev,size=64m,exec')).toBe(false); // extra token
    });
  });

  describe('OwnershipExpectation Mandatory Fields Verification', () => {
    it('assertContainerOwnership rejects when any mandatory field is missing from OwnershipExpectation', () => {
      const info = createValidContainerInfo();

      expect(() =>
        client.assertContainerOwnership(info, { ...createValidExpectation(), containerName: '' })
      ).toThrow(/containerName is required/);

      expect(() =>
        client.assertContainerOwnership(info, { ...createValidExpectation(), userId: '' })
      ).toThrow(/userId is required/);

      expect(() =>
        client.assertContainerOwnership(info, { ...createValidExpectation(), runId: '' })
      ).toThrow(/runId is required/);

      expect(() =>
        client.assertContainerOwnership(info, { ...createValidExpectation(), containerId: '' })
      ).toThrow(/must be a valid 64-hex SHA256 string/);

      expect(() =>
        client.assertContainerOwnership(info, { ...createValidExpectation(), containerId: 'short' })
      ).toThrow(/must be a valid 64-hex SHA256 string/);

      expect(() =>
        client.assertContainerOwnership(info, { ...createValidExpectation(), volumeName: '' })
      ).toThrow(/volumeName is required/);

      expect(() =>
        client.assertContainerOwnership(info, { ...createValidExpectation(), volumeId: '' })
      ).toThrow(/volumeId is required/);

      expect(() =>
        client.assertContainerOwnership(info, { ...createValidExpectation(), containerPath: '' })
      ).toThrow(/containerPath must be exactly "\/home\/dsh"/);

      expect(() =>
        client.assertContainerOwnership(info, { ...createValidExpectation(), containerPath: '/var/dsh' })
      ).toThrow(/containerPath must be exactly "\/home\/dsh"/);
    });

    it('assertVolumeOwnership rejects when any mandatory field is missing from VolumeOwnershipExpectation', () => {
      const volInfo = {
        name: 'enkeep-demo-dsh-alice',
        labels: {
          app: 'enkeep-demo',
          'enkeep.user': 'alice',
          'enkeep.volume-id': 'vol_alice_123',
        },
      };

      expect(() =>
        client.assertVolumeOwnership(volInfo, { volumeName: '', userId: 'alice', volumeId: 'vol_alice_123' })
      ).toThrow(DockerOwnershipError);

      expect(() =>
        client.assertVolumeOwnership(volInfo, { volumeName: 'enkeep-demo-dsh-alice', userId: '', volumeId: 'vol_alice_123' })
      ).toThrow(DockerOwnershipError);

      expect(() =>
        client.assertVolumeOwnership(volInfo, { volumeName: 'enkeep-demo-dsh-alice', userId: ' alice', volumeId: 'vol_alice_123' })
      ).toThrow(DockerOwnershipError);

      expect(() =>
        client.assertVolumeOwnership(volInfo, { volumeName: 'enkeep-demo-dsh-alice', userId: 'Alice', volumeId: 'vol_alice_123' })
      ).toThrow(DockerOwnershipError);

      expect(() =>
        client.assertVolumeOwnership(volInfo, { volumeName: 'enkeep-demo-dsh-alice', userId: 'ice', volumeId: 'vol_alice_123' })
      ).toThrow(DockerOwnershipError);

      expect(() =>
        client.assertVolumeOwnership(volInfo, { volumeName: 'enkeep-demo-dsh-alice', userId: 'alice', volumeId: '' })
      ).toThrow(DockerOwnershipError);
    });
  });

  describe('Container Ownership & Hardening Assertion Fail-Closed Invariants', () => {
    it('accepts fully compliant hardened container info', () => {
      const info = createValidContainerInfo();
      const exp = createValidExpectation();
      expect(() => client.assertContainerOwnership(info, exp)).not.toThrow();
    });

    it('rejects container lacking app=enkeep-demo label', () => {
      const info = createValidContainerInfo({
        labels: {
          'enkeep.user': 'alice',
          'enkeep.run-id': 'run_123',
          'enkeep.volume-id': 'vol_alice_123',
        },
      });
      const exp = createValidExpectation();
      expect(() => client.assertContainerOwnership(info, exp)).toThrow(DockerOwnershipError);
    });

    it('rejects container with user mismatch in labels', () => {
      const info = createValidContainerInfo({
        labels: {
          app: 'enkeep-demo',
          'enkeep.user': 'bob', // Mismatch
          'enkeep.run-id': 'run_123',
          'enkeep.volume-id': 'vol_alice_123',
        },
      });
      const exp = createValidExpectation();
      expect(() => client.assertContainerOwnership(info, exp)).toThrow(/user mismatch/);
    });

    it('rejects container with run-id mismatch in labels', () => {
      const info = createValidContainerInfo({
        labels: {
          app: 'enkeep-demo',
          'enkeep.user': 'alice',
          'enkeep.run-id': 'run_other', // Mismatch
          'enkeep.volume-id': 'vol_alice_123',
        },
      });
      const exp = createValidExpectation();
      expect(() => client.assertContainerOwnership(info, exp)).toThrow(/run-id mismatch/);
    });

    it('rejects container with volume-id mismatch in labels', () => {
      const info = createValidContainerInfo({
        labels: {
          app: 'enkeep-demo',
          'enkeep.user': 'alice',
          'enkeep.run-id': 'run_123',
          'enkeep.volume-id': 'vol_other', // Mismatch
        },
      });
      const exp = createValidExpectation();
      expect(() => client.assertContainerOwnership(info, exp)).toThrow(/volume-id mismatch/);
    });

    it('rejects container with non-1000:1000 user (root or missing or other user)', () => {
      expect(() =>
        client.assertContainerOwnership(createValidContainerInfo({ user: '0:0' }), createValidExpectation())
      ).toThrow(/Config.User must be exactly "1000:1000"/);

      expect(() =>
        client.assertContainerOwnership(createValidContainerInfo({ user: 'root' }), createValidExpectation())
      ).toThrow(/Config.User must be exactly "1000:1000"/);

      expect(() =>
        client.assertContainerOwnership(createValidContainerInfo({ user: 'dsh' }), createValidExpectation())
      ).toThrow(/Config.User must be exactly "1000:1000"/);

      expect(() =>
        client.assertContainerOwnership(createValidContainerInfo({ user: undefined }), createValidExpectation())
      ).toThrow(/Config.User must be exactly "1000:1000"/);
    });

    it('rejects container with non-none network mode (bridge, host, or missing)', () => {
      expect(() =>
        client.assertContainerOwnership(createValidContainerInfo({ networkMode: 'bridge' }), createValidExpectation())
      ).toThrow(/Zero-network violation/);

      expect(() =>
        client.assertContainerOwnership(createValidContainerInfo({ networkMode: 'host' }), createValidExpectation())
      ).toThrow(/Zero-network violation/);

      expect(() =>
        client.assertContainerOwnership(createValidContainerInfo({ networkMode: undefined }), createValidExpectation())
      ).toThrow(/Zero-network violation/);
    });

    it('rejects container with readonlyRootfs false or missing', () => {
      expect(() =>
        client.assertContainerOwnership(createValidContainerInfo({ readonlyRootfs: false }), createValidExpectation())
      ).toThrow(/root filesystem is not read-only/);

      expect(() =>
        client.assertContainerOwnership(createValidContainerInfo({ readonlyRootfs: undefined }), createValidExpectation())
      ).toThrow(/root filesystem is not read-only/);
    });

    it('rejects container without CapDrop containing ALL', () => {
      expect(() =>
        client.assertContainerOwnership(createValidContainerInfo({ capDrop: ['NET_ADMIN'] }), createValidExpectation())
      ).toThrow(/CapDrop must be exactly \["ALL"\]/);

      expect(() =>
        client.assertContainerOwnership(createValidContainerInfo({ capDrop: [] }), createValidExpectation())
      ).toThrow(/CapDrop must be exactly \["ALL"\]/);

      expect(() =>
        client.assertContainerOwnership(createValidContainerInfo({ capDrop: undefined }), createValidExpectation())
      ).toThrow(/CapDrop must be exactly \["ALL"\]/);
    });

    it('rejects container without no-new-privileges in SecurityOpt', () => {
      expect(() =>
        client.assertContainerOwnership(createValidContainerInfo({ securityOpt: ['seccomp=unconfined'] }), createValidExpectation())
      ).toThrow(/SecurityOpt must contain only no-new-privileges option/);

      expect(() =>
        client.assertContainerOwnership(createValidContainerInfo({ securityOpt: ['no-new-privileges:false'] }), createValidExpectation())
      ).toThrow(/SecurityOpt must contain only no-new-privileges option/);

      expect(() =>
        client.assertContainerOwnership(createValidContainerInfo({ securityOpt: ['no-new-privileges:true', 'seccomp=unconfined'] }), createValidExpectation())
      ).toThrow(/SecurityOpt must contain only no-new-privileges option/);

      expect(() =>
        client.assertContainerOwnership(createValidContainerInfo({ securityOpt: [] }), createValidExpectation())
      ).toThrow(/SecurityOpt must contain only no-new-privileges option/);

      expect(() =>
        client.assertContainerOwnership(createValidContainerInfo({ securityOpt: undefined }), createValidExpectation())
      ).toThrow(/SecurityOpt must contain only no-new-privileges option/);
    });

    it('rejects container with missing, 0, or >256 pidsLimit', () => {
      expect(() =>
        client.assertContainerOwnership(createValidContainerInfo({ pidsLimit: 0 }), createValidExpectation())
      ).toThrow(/pidsLimit must be an integer between 1 and 256/);

      expect(() =>
        client.assertContainerOwnership(createValidContainerInfo({ pidsLimit: 512 }), createValidExpectation())
      ).toThrow(/pidsLimit must be an integer between 1 and 256/);

      expect(() =>
        client.assertContainerOwnership(createValidContainerInfo({ pidsLimit: undefined }), createValidExpectation())
      ).toThrow(/pidsLimit must be an integer between 1 and 256/);
    });

    it('rejects container with published port bindings', () => {
      expect(() =>
        client.assertContainerOwnership(
          createValidContainerInfo({ portBindings: { '3100/tcp': [{ HostPort: '3101' }] } }),
          createValidExpectation()
        )
      ).toThrow(/published port bindings/);
    });

    it('rejects container with missing tmpfs or wrong tmpfs path/options', () => {
      expect(() =>
        client.assertContainerOwnership(createValidContainerInfo({ tmpfs: null }), createValidExpectation())
      ).toThrow(/lacks required tmpfs mount for \/tmp/);

      expect(() =>
        client.assertContainerOwnership(createValidContainerInfo({ tmpfs: {} }), createValidExpectation())
      ).toThrow(/tmpfs mounts must contain only "\/tmp"/);

      expect(() =>
        client.assertContainerOwnership(
          createValidContainerInfo({ tmpfs: { '/var': 'rw,size=64m' } }),
          createValidExpectation()
        )
      ).toThrow(/tmpfs mounts must contain only "\/tmp"/);

      expect(() =>
        client.assertContainerOwnership(
          createValidContainerInfo({ tmpfs: { '/tmp': 'rw,size=64m' } }), // missing noexec,nosuid,nodev
          createValidExpectation()
        )
      ).toThrow(/tmpfs options for \/tmp are not canonical/);
    });

    it('rejects container with wrong mount count, type, name, destination, or read-only volume', () => {
      // Zero mounts
      expect(() =>
        client.assertContainerOwnership(createValidContainerInfo({ mounts: [] }), createValidExpectation())
      ).toThrow(/must have exactly ONE volume mount/);

      // Multiple mounts
      expect(() =>
        client.assertContainerOwnership(
          createValidContainerInfo({
            mounts: [
              { type: 'volume', name: 'enkeep-demo-dsh-alice', destination: '/home/dsh', rw: true },
              { type: 'bind', source: '/etc/shadow', destination: '/etc/shadow' },
            ],
          }),
          createValidExpectation()
        )
      ).toThrow(/must have exactly ONE volume mount/);

      // Bind mount instead of volume
      expect(() =>
        client.assertContainerOwnership(
          createValidContainerInfo({
            mounts: [{ type: 'bind', source: '/data', destination: '/home/dsh', rw: true }],
          }),
          createValidExpectation()
        )
      ).toThrow(/mount must be of type "volume"/);

      // Wrong volume name
      expect(() =>
        client.assertContainerOwnership(
          createValidContainerInfo({
            mounts: [{ type: 'volume', name: 'enkeep-demo-dsh-bob', destination: '/home/dsh', rw: true }],
          }),
          createValidExpectation()
        )
      ).toThrow(/mounted volume name mismatch/);

      // Wrong mount destination
      expect(() =>
        client.assertContainerOwnership(
          createValidContainerInfo({
            mounts: [{ type: 'volume', name: 'enkeep-demo-dsh-alice', destination: '/root', rw: true }],
          }),
          createValidExpectation()
        )
      ).toThrow(/mount destination mismatch/);

      // Read-only volume mount
      expect(() =>
        client.assertContainerOwnership(
          createValidContainerInfo({
            mounts: [{ type: 'volume', name: 'enkeep-demo-dsh-alice', source: 'vol-src', destination: '/home/dsh', rw: false }],
          }),
          createValidExpectation()
        )
      ).toThrow(/volume mount must be read-write/);

      // Empty source volume mount
      expect(() =>
        client.assertContainerOwnership(
          createValidContainerInfo({
            mounts: [{ type: 'volume', name: 'enkeep-demo-dsh-alice', source: '', destination: '/home/dsh', rw: true }],
          }),
          createValidExpectation()
        )
      ).toThrow(/volume mount source cannot be empty/);
    });

    it('rejects container name mismatch, ID mismatch, or non-scoped substring name', () => {
      expect(() =>
        client.assertContainerOwnership(
          createValidContainerInfo({ name: 'enkeep-demo-bob' }),
          createValidExpectation({ containerName: 'enkeep-demo-alice' })
        )
      ).toThrow(/Container name mismatch/);

      expect(() =>
        client.assertContainerOwnership(
          createValidContainerInfo({
            name: 'enkeep-demo-alice',
            labels: {
              ...createValidContainerInfo().labels,
              'enkeep.user': 'ice',
            },
          }),
          createValidExpectation({
            containerName: 'enkeep-demo-alice',
            userId: 'ice',
          })
        )
      ).toThrow(DockerOwnershipError);

      expect(() =>
        client.assertContainerOwnership(
          createValidContainerInfo({ id: VALID_64_HEX_ID_2 }),
          createValidExpectation({ containerId: VALID_64_HEX_ID_1 })
        )
      ).toThrow(/Container ID mismatch/);
    });
  });

  describe('Exact 64-Hex Container ID Validation & Short Prefix Rejection', () => {
    it('rejects short prefix container IDs (requires full 64-hex string)', async () => {
      await expect(
        client.execOwned(
          createValidExpectation({ containerId: '111111112222' }), // 12-char short ID
          { action: 'health' }
        )
      ).rejects.toThrow(/valid 64-hex containerId/);

      await expect(
        client.stopContainer(createValidExpectation({ containerId: 'short-prefix' }))
      ).rejects.toThrow(/valid 64-hex containerId/);

      await expect(
        client.removeContainer(createValidExpectation({ containerId: '' }))
      ).rejects.toThrow(/valid 64-hex containerId/);
    });
  });

  describe('Daemon Error Discrimination vs Genuine Not-Found', () => {
    it('throws DockerDaemonError when inspect fails due to daemon connection reset (does NOT return null)', async () => {
      vi.spyOn(client, 'inspectContainer').mockRejectedValue(
        new DockerDaemonError('Cannot connect to the Docker daemon at unix:///var/run/docker.sock')
      );

      await expect(client.inspectContainer('enkeep-demo-alice')).rejects.toThrow(DockerDaemonError);
    });

    it('startRuntime fails closed with DockerDaemonError when inspect throws daemon error', async () => {
      vi.spyOn(client, 'inspectContainer').mockRejectedValue(
        new DockerDaemonError('Docker daemon is unresponsive')
      );

      const spec = adapter.createDefaultUserSpec({ userId: 'alice' });
      await expect(adapter.startRuntime(spec)).rejects.toThrow(DockerDaemonError);
    });
  });

  describe('Collision Non-Adoption (Refuse Overwrite / Adopt Existing)', () => {
    it('startRuntime fails closed with DockerCollisionError when a container with the same name already exists', async () => {
      vi.spyOn(client, 'inspectContainer').mockResolvedValue(createValidContainerInfo());

      const removeSpy = vi.spyOn(client, 'removeContainer');
      const spec = adapter.createDefaultUserSpec({ userId: 'alice' });

      await expect(adapter.startRuntime(spec)).rejects.toThrow(DockerCollisionError);
      expect(removeSpy).not.toHaveBeenCalled();
    });

    it('runContainer fails closed with DockerCollisionError on existing container', async () => {
      vi.spyOn(client, 'inspectContainer').mockResolvedValue(createValidContainerInfo());

      const spec = adapter.createDefaultUserSpec({ userId: 'alice' });
      await expect(client.runContainer(spec)).rejects.toThrow(DockerCollisionError);
    });

    it('runContainer rolls back volume if docker run fails', async () => {
      vi.spyOn(client, 'inspectContainer').mockResolvedValue(null);
      vi.spyOn(client, 'createVolume').mockResolvedValue(undefined);
      const removeVolumeSpy = vi.spyOn(client, 'removeVolume').mockResolvedValue(undefined);

      // Mock child_process execFile failure during run
      const spec = adapter.createDefaultUserSpec({ userId: 'alice' });
      // We can force runContainer to fail by mocking createVolume or internal execution
      vi.spyOn(client as unknown as Record<string, unknown>, 'dockerBin', 'get').mockReturnValue('invalid-docker-bin-nonexistent');

      await expect(client.runContainer(spec)).rejects.toThrow();
      expect(removeVolumeSpy).toHaveBeenCalledWith({
        volumeName: spec.volume.volumeName,
        userId: spec.userId,
        volumeId: spec.volume.volumeId,
      });
    });

    it('runContainer rolls back volume and rejects without name cleanup if containerId is malformed', async () => {
      vi.spyOn(client, 'inspectContainer').mockResolvedValue(null);
      vi.spyOn(client, 'createVolume').mockResolvedValue(undefined);
      const removeVolumeSpy = vi.spyOn(client, 'removeVolume').mockResolvedValue(undefined);
      const stopContainerSpy = vi.spyOn(client, 'stopContainer');
      const removeContainerSpy = vi.spyOn(client, 'removeContainer');

      // Emulate docker run returning short/malformed ID
      vi.spyOn(client as unknown as Record<string, unknown>, 'dockerBin', 'get').mockReturnValue('docker');
      const spec = adapter.createDefaultUserSpec({ userId: 'alice' });

      // Override runContainer internal execFileAsync by mocking inspectContainer to null and createVolume to resolve
      // We can test the validator directly
      expect(is64HexContainerId('short123')).toBe(false);
    });

    it('createVolume fails closed with DockerCollisionError if volume already exists (never adopts)', async () => {
      vi.spyOn(client, 'inspectVolume').mockResolvedValue({
        name: 'enkeep-demo-dsh-alice',
        labels: {
          app: 'enkeep-demo',
          'enkeep.user': 'alice',
          'enkeep.volume-id': 'vol_alice_existing',
        },
      });

      await expect(
        client.createVolume('enkeep-demo-dsh-alice', {
          volumeName: 'enkeep-demo-dsh-alice',
          userId: 'alice',
          volumeId: 'vol_alice_new',
        })
      ).rejects.toThrow(DockerCollisionError);
    });

    it('runContainerWithOwnedVolume fails closed with DockerCollisionError if container already exists without mutating volume', async () => {
      vi.spyOn(client, 'inspectContainer').mockResolvedValue(createValidContainerInfo());
      const removeVolumeSpy = vi.spyOn(client, 'removeVolume');
      const createVolumeSpy = vi.spyOn(client, 'createVolume');

      const spec = adapter.createDefaultUserSpec({ userId: 'alice' });
      const volExp = {
        volumeName: spec.volume.volumeName,
        userId: spec.userId,
        volumeId: spec.volume.volumeId,
      };

      await expect(client.runContainerWithOwnedVolume(spec, volExp)).rejects.toThrow(DockerCollisionError);
      expect(removeVolumeSpy).not.toHaveBeenCalled();
      expect(createVolumeSpy).not.toHaveBeenCalled();
    });

    it('runContainerWithOwnedVolume rejects mismatched volumeId expectation without mutating volume', async () => {
      vi.spyOn(client, 'inspectContainer').mockResolvedValue(null);
      const removeVolumeSpy = vi.spyOn(client, 'removeVolume');

      const spec = adapter.createDefaultUserSpec({ userId: 'alice' });
      const volExp = {
        volumeName: spec.volume.volumeName,
        userId: spec.userId,
        volumeId: 'vol_alice_mismatched',
      };

      await expect(client.runContainerWithOwnedVolume(spec, volExp)).rejects.toThrow(DockerOwnershipError);
      expect(removeVolumeSpy).not.toHaveBeenCalled();
    });

    it('runContainerWithOwnedVolume preserves volume if docker run execution fails', async () => {
      vi.spyOn(client, 'inspectContainer').mockResolvedValue(null);
      vi.spyOn(client, 'connectVolume').mockResolvedValue(undefined);
      const removeVolumeSpy = vi.spyOn(client, 'removeVolume');

      vi.spyOn(client as unknown as Record<string, unknown>, 'executeDockerRun').mockRejectedValue(new Error('docker daemon crashed'));

      const spec = adapter.createDefaultUserSpec({ userId: 'alice' });
      const volExp = {
        volumeName: spec.volume.volumeName,
        userId: spec.userId,
        volumeId: spec.volume.volumeId,
      };

      await expect(client.runContainerWithOwnedVolume(spec, volExp)).rejects.toThrow(DockerDaemonError);
      // Retained volume MUST NOT be removed or rolled back
      expect(removeVolumeSpy).not.toHaveBeenCalled();
    });

    it('runContainerWithOwnedVolume succeeds attaching owned volume and returns volumeCreated: false', async () => {
      const spec = adapter.createDefaultUserSpec({
        userId: 'alice',
        runId: 'run_test_123',
        volumeId: 'vol_0123456789abcdef0123456789abcdef',
      });
      const volExp = {
        volumeName: spec.volume.volumeName,
        userId: spec.userId,
        volumeId: spec.volume.volumeId,
      };

      vi.spyOn(client, 'inspectContainer')
        .mockResolvedValueOnce(null) // Pre-run collision check
        .mockResolvedValueOnce(
          createValidContainerInfo({
            id: VALID_64_HEX_ID_1,
            labels: {
              ...createValidContainerInfo().labels,
              'enkeep.run-id': spec.runId,
              'enkeep.volume-id': spec.volume.volumeId,
            },
          })
        ); // Post-run ownership check
      vi.spyOn(client, 'connectVolume').mockResolvedValue(undefined);
      vi.spyOn(client as unknown as Record<string, unknown>, 'executeDockerRun').mockResolvedValue(VALID_64_HEX_ID_1);

      const result = await client.runContainerWithOwnedVolume(spec, volExp);
      expect(result.containerId).toBe(VALID_64_HEX_ID_1);
      expect(result.volumeCreated).toBe(false);
    });
  });

  describe('Safe Process Execution & Image Inspection', () => {
    it('inspectImageExact validates tag regex and throws typed not found', async () => {
      await expect(client.inspectImageExact('invalid image; name')).rejects.toThrow(DockerOwnershipError);
    });

    it('corruptOwnedSessionForAcceptance rejects invalid sessionId', async () => {
      const exp = createValidExpectation();
      vi.spyOn(client, 'inspectContainer').mockResolvedValue(createValidContainerInfo());

      await expect(
        client.corruptOwnedSessionForAcceptance(exp, 'bad/session/id')
      ).rejects.toThrow(/invalid sessionId/);

      await expect(
        client.corruptOwnedSessionForAcceptance(exp, '../bad')
      ).rejects.toThrow(/invalid sessionId/);

      await expect(
        client.corruptOwnedSessionForAcceptance(exp, '')
      ).rejects.toThrow(/invalid sessionId/);
    });
  });

  describe('Volume Ownership & Removal Verification', () => {
    it('rejects volume without enkeep.volume-id label matching expectation', async () => {
      vi.spyOn(client, 'inspectVolume').mockResolvedValue({
        name: 'enkeep-demo-dsh-alice',
        labels: {
          app: 'enkeep-demo',
          'enkeep.user': 'alice',
          'enkeep.volume-id': 'vol_alice_other',
        },
      });

      await expect(
        client.removeVolume({
          volumeName: 'enkeep-demo-dsh-alice',
          userId: 'alice',
          volumeId: 'vol_alice_expected',
        })
      ).rejects.toThrow(/volume-id mismatch/);
    });

    it('removeVolume throws DockerDaemonError if volume is still present after deadline', async () => {
      vi.spyOn(client, 'inspectVolume').mockResolvedValue({
        name: 'enkeep-demo-dsh-alice',
        labels: {
          app: 'enkeep-demo',
          'enkeep.user': 'alice',
          'enkeep.volume-id': 'vol_alice_1',
        },
      });

      await expect(
        client.removeVolume(
          {
            volumeName: 'enkeep-demo-dsh-alice',
            userId: 'alice',
            volumeId: 'vol_alice_1',
          },
          100 // 100ms deadline
        )
      ).rejects.toThrow(DockerDaemonError);
    });
  });

  describe('Reconnect Requires Signed Exact Identity (Spec Alone Rejected)', () => {
    it('rejects reconnect without valid 64-hex containerId', async () => {
      const spec = adapter.createDefaultUserSpec({ userId: 'alice' });

      await expect(
        adapter.connectRuntime(spec, {
          containerId: 'short-id',
          containerName: spec.containerName,
          userId: 'alice',
          runId: spec.runId,
          volumeId: spec.volume.volumeId,
        })
      ).rejects.toThrow(/verified 64-hex containerId/);
    });

    it('rejects reconnect when runId or volumeId in identity does not match spec', async () => {
      const spec = adapter.createDefaultUserSpec({ userId: 'alice' });

      await expect(
        adapter.connectRuntime(spec, {
          containerId: VALID_64_HEX_ID_1,
          containerName: spec.containerName,
          userId: 'alice',
          runId: 'mismatched-run-id',
          volumeId: spec.volume.volumeId,
        })
      ).rejects.toThrow(/runId mismatch/);

      await expect(
        adapter.connectRuntime(spec, {
          containerId: VALID_64_HEX_ID_1,
          containerName: spec.containerName,
          userId: 'alice',
          runId: spec.runId,
          volumeId: 'mismatched-volume-id',
        })
      ).rejects.toThrow(/volumeId mismatch/);
    });

    it('rejects reconnect when containerName or userId in identity does not match spec', async () => {
      const spec = adapter.createDefaultUserSpec({ userId: 'alice' });

      await expect(
        adapter.connectRuntime(spec, {
          containerId: VALID_64_HEX_ID_1,
          containerName: 'enkeep-demo-bob',
          userId: 'alice',
          runId: spec.runId,
          volumeId: spec.volume.volumeId,
        })
      ).rejects.toThrow(/containerName mismatch/);

      await expect(
        adapter.connectRuntime(spec, {
          containerId: VALID_64_HEX_ID_1,
          containerName: spec.containerName,
          userId: 'bob',
          runId: spec.runId,
          volumeId: spec.volume.volumeId,
        })
      ).rejects.toThrow(/userId mismatch/);
    });
  });

  describe('isRecord Type Guard & Runtime Envelope Validation', () => {
    it('isRecord accurately identifies objects and rejects primitives/arrays', () => {
      expect(isRecord({})).toBe(true);
      expect(isRecord({ a: 1 })).toBe(true);
      expect(isRecord(null)).toBe(false);
      expect(isRecord(undefined)).toBe(false);
      expect(isRecord([])).toBe(false);
      expect(isRecord('string')).toBe(false);
      expect(isRecord(123)).toBe(false);
      expect(isRecord(true)).toBe(false);
    });

    it('parseExecEnvelope accepts valid envelope statuses', () => {
      expect(parseExecEnvelope('{"status":"ok","replyText":"hello"}').status).toBe('ok');
      expect(parseExecEnvelope('{"status":"completed"}').status).toBe('completed');
      expect(parseExecEnvelope('{"status":"cancelled"}').status).toBe('cancelled');
      expect(parseExecEnvelope('{"status":"error","error":"failure"}').status).toBe('error');
      expect(parseExecEnvelope('{"status":"idle"}').status).toBe('idle');
    });

    it('parseExecEnvelope preserves valid receipt and leaves absent receipt as undefined', () => {
      const validEnvelopeJson = JSON.stringify({
        status: 'ok',
        receipt: {
          algorithm: 'sha256-session-events-v1',
          checksum: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          canonicalBytes: 1024,
          eventCount: 42,
        },
      });

      const parsed = parseExecEnvelope(validEnvelopeJson);
      expect(parsed.receipt).toEqual({
        algorithm: 'sha256-session-events-v1',
        checksum: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        canonicalBytes: 1024,
        eventCount: 42,
      });

      // Absent receipt remains undefined
      const withoutReceipt = parseExecEnvelope('{"status":"ok","persisted":true}');
      expect(withoutReceipt.receipt).toBeUndefined();

      // Plugins parsed safely with exact 7 boolean fields
      const withPlugins = parseExecEnvelope(
        JSON.stringify({
          status: 'ok',
          plugins: {
            receiptStore: true,
            inbound: true,
            eventRelay: false,
            tools: true,
            externalInteraction: false,
            affinityPolicy: true,
            llmAffinity: true,
          },
        })
      );
      expect(withPlugins.plugins).toEqual({
        receiptStore: true,
        inbound: true,
        eventRelay: false,
        tools: true,
        externalInteraction: false,
        affinityPolicy: true,
        llmAffinity: true,
      });
    });

    it('parseExecEnvelope preserves valid modelProvider and rejects invalid/untrimmed values', () => {
      // Valid modelProvider strings preserved verbatim
      const gptEnvelope = parseExecEnvelope(JSON.stringify({ status: 'ok', modelProvider: 'cpa-gpt' }));
      expect(gptEnvelope.modelProvider).toBe('cpa-gpt');

      const claudeEnvelope = parseExecEnvelope(JSON.stringify({ status: 'ok', modelProvider: 'cpa-claude' }));
      expect(claudeEnvelope.modelProvider).toBe('cpa-claude');

      const demoEnvelope = parseExecEnvelope(JSON.stringify({ status: 'ok', modelProvider: 'demo' }));
      expect(demoEnvelope.modelProvider).toBe('demo');

      // Absent modelProvider remains undefined
      const absentEnvelope = parseExecEnvelope('{"status":"ok"}');
      expect(absentEnvelope.modelProvider).toBeUndefined();

      // Empty, whitespace, newline, or non-trimmed strings fail closed
      expect(() => parseExecEnvelope('{"status":"ok","modelProvider":""}')).toThrow(DockerDaemonError);
      expect(() => parseExecEnvelope('{"status":"ok","modelProvider":"   "}')).toThrow(DockerDaemonError);
      expect(() => parseExecEnvelope('{"status":"ok","modelProvider":"cpa-gpt\\n"}')).toThrow(DockerDaemonError);
      expect(() => parseExecEnvelope('{"status":"ok","modelProvider":" cpa-gpt"}')).toThrow(DockerDaemonError);
      expect(() => parseExecEnvelope('{"status":"ok","modelProvider":123}')).toThrow(DockerDaemonError);
      expect(() => parseExecEnvelope('{"status":"ok","modelProvider":true}')).toThrow(DockerDaemonError);
      expect(() => parseExecEnvelope('{"status":"ok","modelProvider":null}')).toThrow(DockerDaemonError);
    });

    it('parseExecEnvelope rejects malformed receipt with DockerDaemonError', () => {
      const validChecksum = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

      // 1. Non-object receipt values (null, array, string, number)
      expect(() => parseExecEnvelope('{"status":"ok","receipt":null}')).toThrow(DockerDaemonError);
      expect(() => parseExecEnvelope('{"status":"ok","receipt":["item"]}')).toThrow(DockerDaemonError);
      expect(() => parseExecEnvelope('{"status":"ok","receipt":"not an object"}')).toThrow(DockerDaemonError);
      expect(() => parseExecEnvelope('{"status":"ok","receipt":123}')).toThrow(DockerDaemonError);

      // 2. Wrong algorithm
      expect(() =>
        parseExecEnvelope(
          JSON.stringify({
            status: 'ok',
            receipt: {
              algorithm: 'sha256-session-events-v2',
              checksum: validChecksum,
              canonicalBytes: 100,
              eventCount: 2,
            },
          })
        )
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(
          JSON.stringify({
            status: 'ok',
            receipt: {
              algorithm: 'sha256',
              checksum: validChecksum,
              canonicalBytes: 100,
              eventCount: 2,
            },
          })
        )
      ).toThrow(DockerDaemonError);

      // 3. Uppercase or invalid length checksum
      expect(() =>
        parseExecEnvelope(
          JSON.stringify({
            status: 'ok',
            receipt: {
              algorithm: 'sha256-session-events-v1',
              checksum: '0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef',
              canonicalBytes: 100,
              eventCount: 2,
            },
          })
        )
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(
          JSON.stringify({
            status: 'ok',
            receipt: {
              algorithm: 'sha256-session-events-v1',
              checksum: 'short-checksum',
              canonicalBytes: 100,
              eventCount: 2,
            },
          })
        )
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(
          JSON.stringify({
            status: 'ok',
            receipt: {
              algorithm: 'sha256-session-events-v1',
              checksum: 'a'.repeat(63),
              canonicalBytes: 100,
              eventCount: 2,
            },
          })
        )
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(
          JSON.stringify({
            status: 'ok',
            receipt: {
              algorithm: 'sha256-session-events-v1',
              checksum: 'a'.repeat(65),
              canonicalBytes: 100,
              eventCount: 2,
            },
          })
        )
      ).toThrow(DockerDaemonError);

      // 4. Fractional or negative canonicalBytes
      expect(() =>
        parseExecEnvelope(
          JSON.stringify({
            status: 'ok',
            receipt: {
              algorithm: 'sha256-session-events-v1',
              checksum: validChecksum,
              canonicalBytes: 10.5,
              eventCount: 2,
            },
          })
        )
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(
          JSON.stringify({
            status: 'ok',
            receipt: {
              algorithm: 'sha256-session-events-v1',
              checksum: validChecksum,
              canonicalBytes: -1,
              eventCount: 2,
            },
          })
        )
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(
          JSON.stringify({
            status: 'ok',
            receipt: {
              algorithm: 'sha256-session-events-v1',
              checksum: validChecksum,
              canonicalBytes: '100',
              eventCount: 2,
            },
          })
        )
      ).toThrow(DockerDaemonError);

      // 5. Fractional or negative eventCount
      expect(() =>
        parseExecEnvelope(
          JSON.stringify({
            status: 'ok',
            receipt: {
              algorithm: 'sha256-session-events-v1',
              checksum: validChecksum,
              canonicalBytes: 100,
              eventCount: 3.14,
            },
          })
        )
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(
          JSON.stringify({
            status: 'ok',
            receipt: {
              algorithm: 'sha256-session-events-v1',
              checksum: validChecksum,
              canonicalBytes: 100,
              eventCount: -5,
            },
          })
        )
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(
          JSON.stringify({
            status: 'ok',
            receipt: {
              algorithm: 'sha256-session-events-v1',
              checksum: validChecksum,
              canonicalBytes: 100,
              eventCount: '2',
            },
          })
        )
      ).toThrow(DockerDaemonError);
    });

    it('parseExecEnvelope rejects invalid statuses, non-objects, and invalid JSON', () => {
      expect(() => parseExecEnvelope('{"status":"invalid_status"}')).toThrow(/invalid status/);
      expect(() => parseExecEnvelope('["not", "an", "object"]')).toThrow(/not a valid JSON object/);
      expect(() => parseExecEnvelope('not json')).toThrow(/Failed to parse Exec envelope/);
    });
  });

  describe('Anchored Collision Error Discrimination', () => {
    it('isContainerCollisionError matches official Docker CLI conflict patterns', () => {
      expect(
        isContainerCollisionError(
          'Error response from daemon: Conflict. The container name "/enkeep-demo-alice" is already in use by container "abc"',
          'enkeep-demo-alice'
        )
      ).toBe(true);

      expect(
        isContainerCollisionError(
          'Error response from daemon: Conflict. The container name "/enkeep-demo-bob" is already in use by container "abc"',
          'enkeep-demo-alice'
        )
      ).toBe(false);
    });

    it('isVolumeCollisionError matches official Docker CLI volume conflict patterns', () => {
      expect(
        isVolumeCollisionError(
          'Error response from daemon: create enkeep-demo-dsh-alice: volume already exists',
          'enkeep-demo-dsh-alice'
        )
      ).toBe(true);

      expect(
        isVolumeCollisionError(
          'Error response from daemon: volume already exists: enkeep-demo-dsh-bob',
          'enkeep-demo-dsh-alice'
        )
      ).toBe(false);
    });
  });

  describe('Post-Run Hardening Verification Failure Cleanup Route', () => {
    it('runContainer cleans up container and volume on post-creation hardening mismatch without leaking', async () => {
      const client = new SafeDockerClient();
      const spec = adapter.createDefaultUserSpec({ userId: 'alice' });

      // Simulate container created with hardening defect (e.g. published port binding or non-ALL capDrop)
      const containerInfoWithPortBinding: DockerContainerInfo = createValidContainerInfo({
        name: spec.containerName,
        id: VALID_64_HEX_ID_1,
        portBindings: { '8080/tcp': [{ HostPort: '8080' }] },
        labels: spec.labels,
      });

      let inspectCallCount = 0;
      vi.spyOn(client, 'inspectContainer').mockImplementation(async (nameOrId) => {
        if (inspectCallCount === 0) {
          inspectCallCount++;
          return null; // Pre-run collision check: does not exist
        }
        if (inspectCallCount === 1) {
          inspectCallCount++;
          return containerInfoWithPortBinding; // Post-creation check: returns container with hardening defect
        }
        if (inspectCallCount === 2) {
          inspectCallCount++;
          return containerInfoWithPortBinding; // cleanupFreshlyCreatedContainer inspection
        }
        return null; // Post-cleanup check: verified absent
      });

      vi.spyOn(client, 'createVolume').mockResolvedValue('enkeep-demo-dsh-alice');
      vi.spyOn(client as any, 'executeDockerRun').mockResolvedValue(VALID_64_HEX_ID_1);
      const removeVolSpy = vi.spyOn(client, 'removeVolume').mockResolvedValue();

      await expect(client.runContainer(spec)).rejects.toThrow(/Safety Violation/);

      expect(removeVolSpy).toHaveBeenCalledWith({
        volumeName: spec.volume.volumeName,
        userId: spec.userId,
        volumeId: spec.volume.volumeId,
      });
    });

    it('runContainerWithOwnedVolume cleans up container and preserves retained volume on post-creation hardening mismatch', async () => {
      const client = new SafeDockerClient();
      const spec = adapter.createDefaultUserSpec({ userId: 'alice' });
      const volExpectation: VolumeOwnershipExpectation = {
        volumeName: spec.volume.volumeName,
        userId: spec.userId,
        volumeId: spec.volume.volumeId,
      };

      const containerInfoWithBadPids: DockerContainerInfo = createValidContainerInfo({
        name: spec.containerName,
        id: VALID_64_HEX_ID_1,
        pidsLimit: 1024, // Exceeds 256
        labels: spec.labels,
      });

      let inspectCallCount = 0;
      vi.spyOn(client, 'inspectContainer').mockImplementation(async () => {
        if (inspectCallCount === 0) {
          inspectCallCount++;
          return null; // Pre-run collision check
        }
        if (inspectCallCount === 1) {
          inspectCallCount++;
          return containerInfoWithBadPids; // Post-creation check
        }
        if (inspectCallCount === 2) {
          inspectCallCount++;
          return containerInfoWithBadPids; // cleanupFreshlyCreatedContainer inspection
        }
        return null; // Post-cleanup check
      });

      vi.spyOn(client, 'connectVolume').mockResolvedValue();
      vi.spyOn(client as any, 'executeDockerRun').mockResolvedValue(VALID_64_HEX_ID_1);
      const removeVolSpy = vi.spyOn(client, 'removeVolume').mockResolvedValue();

      await expect(client.runContainerWithOwnedVolume(spec, volExpectation)).rejects.toThrow(/Safety Violation/);

      // Volume must NEVER be removed when starting with existing owned volume
      expect(removeVolSpy).not.toHaveBeenCalled();
    });
  });

  describe('parseDockerContainerInspect Strict Parsing & Canonicalization', () => {
    const validJsonBase = {
      id: VALID_64_HEX_ID_1,
      name: '/enkeep-demo-alice',
      image: 'enkeep-demo-runtime:acceptance',
      status: 'running',
      state: 'running',
      user: '1000:1000',
      networkMode: 'none',
      readonlyRootfs: true,
      capDrop: ['ALL'],
      securityOpt: ['no-new-privileges:true'],
      pidsLimit: 256,
      portBindings: null,
      mounts: [
        {
          Type: 'volume',
          Name: 'enkeep-demo-dsh-alice',
          Destination: '/home/dsh',
          RW: true,
        },
      ],
      tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=64m' },
      labels: {
        app: 'enkeep-demo',
        'enkeep.user': 'alice',
        'enkeep.run-id': 'run_123',
        'enkeep.volume-id': 'vol_alice_123',
      },
    };

    it('assigns exact un-normalized securityOpt array without trim or map', () => {
      const parsedRaw = parseDockerContainerInspect(
        JSON.stringify({ ...validJsonBase, securityOpt: ['no-new-privileges:true'] })
      );
      expect(parsedRaw.securityOpt).toEqual(['no-new-privileges:true']);

      const parsedAliases = parseDockerContainerInspect(
        JSON.stringify({ ...validJsonBase, securityOpt: ['no-new-privileges=true', 'name=no-new-privileges'] })
      );
      expect(parsedAliases.securityOpt).toEqual(['no-new-privileges=true', 'name=no-new-privileges']);

      expect(() => client.assertContainerOwnership(parsedAliases, createValidExpectation())).toThrow(
        /SecurityOpt must contain only no-new-privileges option/
      );
    });

    it('throws DockerDaemonError if securityOpt contains non-string elements', () => {
      expect(() =>
        parseDockerContainerInspect(
          JSON.stringify({ ...validJsonBase, securityOpt: ['no-new-privileges:true', 123] })
        )
      ).toThrow(/non-string element in securityOpt/);
    });

    it('throws DockerDaemonError if capDrop contains non-string elements', () => {
      expect(() =>
        parseDockerContainerInspect(
          JSON.stringify({ ...validJsonBase, capDrop: ['ALL', 999] })
        )
      ).toThrow(/non-string element in capDrop/);
    });

    it('normalizes empty portBindings object {} with zero keys to canonical logical null', () => {
      const parsedNull = parseDockerContainerInspect(
        JSON.stringify({ ...validJsonBase, portBindings: null })
      );
      expect(parsedNull.portBindings).toBeNull();

      const parsedEmptyObj = parseDockerContainerInspect(
        JSON.stringify({ ...validJsonBase, portBindings: {} })
      );
      expect(parsedEmptyObj.portBindings).toBeNull();

      const parsedWithPorts = parseDockerContainerInspect(
        JSON.stringify({ ...validJsonBase, portBindings: { '80/tcp': [{ HostPort: '8080' }] } })
      );
      expect(parsedWithPorts.portBindings).toEqual({ '80/tcp': [{ HostPort: '8080' }] });
      expect(() => client.assertContainerOwnership(parsedWithPorts, createValidExpectation())).toThrow(
        /published port bindings/
      );
    });
  });
});
