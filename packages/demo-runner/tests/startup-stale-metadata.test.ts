/**
 * Startup Stale Metadata Reconciliation Test Suite
 *
 * Verifies:
 * 1. Stale signed volume metadata for ordinary runtime (missing Docker volume / DockerNotFoundError):
 *    - Automatically falls back to provisioning a fresh owned volume and container.
 *    - Updates signed volume metadata and container metadata.
 *    - Does not fail the whole platform.
 * 2. Existing actual volume (e.g. hpc_admin_shadow or preserved user volume):
 *    - Reconnects to the existing owned volume and preserves volume data.
 * 3. Security fail-closed:
 *    - Ownership mismatch (wrong userId/volumeName) throws immediately and refuses fallback.
 * 4. Stale container metadata (missing container on host):
 *    - Reconciles stale container metadata and creates/boots a new container.
 *
 * @module @enkeep/demo-runner/tests/startup-stale-metadata.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  DockerRuntimeAdapter,
  SafeDockerClient,
  DockerNotFoundError,
  DockerOwnershipError,
  type ActiveRuntimeHandle,
} from '@enkeep/runtime-runner';
import { DockerRuntimeContainerAdapter } from '../src/ports/index.js';
import {
  writeSignedVolumeMeta,
  readSignedVolumeMeta,
  writeSignedContainerMeta,
  readSignedContainerMeta,
} from '../src/utils/crypto-meta.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

describe('Startup Stale Metadata Reconciliation', () => {
  let tempRepo: TempRepo;

  beforeEach(async () => {
    tempRepo = await createTempRepo();
  });

  afterEach(async () => {
    await tempRepo.cleanup();
  });

  it('provisions fresh volume when signed volume metadata is stale and Docker volume is missing', async () => {
    const mockDockerClient = new SafeDockerClient();
    vi.spyOn(mockDockerClient, 'isDockerAvailable').mockResolvedValue(true);
    vi.spyOn(mockDockerClient, 'inspectContainer').mockResolvedValue(null);

    const staleVolId = 'vol_11111111111111111111111111111111';
    writeSignedVolumeMeta(
      {
        userId: 'alice',
        volumeName: 'enkeep-demo-dsh-alice',
        volumeId: staleVolId,
        runId: 'run_stale_001',
      },
      { repoRoot: tempRepo.repoRoot }
    );

    let startOwnedCalled = false;
    const startOwnedSpy = vi
      .spyOn(DockerRuntimeAdapter.prototype, 'startRuntimeWithOwnedVolume')
      .mockImplementation(async () => {
        startOwnedCalled = true;
        throw new DockerNotFoundError('Volume not found for reconnection');
      });

    let freshSpecCaptured: any = null;
    const freshHandle: ActiveRuntimeHandle = {
      containerId: 'a'.repeat(64),
      runId: 'run_fresh_001',
      volumeId: 'vol_22222222222222222222222222222222',
      isCreated: true,
      spec: {} as any,
      checkHealth: vi.fn().mockResolvedValue({
        status: 'ok',
        dshReady: true,
        userId: 'alice',
        uptimeSeconds: 5,
        modelProvider: 'cpa-claude',
      }),
      sendFollowup: vi.fn().mockResolvedValue({ status: 'completed', replyText: 'ok', persisted: true }),
      importSeed: vi.fn().mockResolvedValue({ status: 'completed' }),
      cancelTurn: vi.fn().mockResolvedValue({ status: 'cancelled', turnId: 't1' }),
      stop: vi.fn().mockResolvedValue(undefined),
      teardown: vi.fn().mockResolvedValue(undefined),
    };

    const startFreshSpy = vi
      .spyOn(DockerRuntimeAdapter.prototype, 'startRuntime')
      .mockImplementation(async (spec) => {
        freshSpecCaptured = spec;
        freshHandle.volumeId = spec.volume.volumeId;
        freshHandle.runId = spec.runId;
        return freshHandle;
      });

    const adapter = new DockerRuntimeContainerAdapter(mockDockerClient);
    const handle = await adapter.startUserRuntime({
      userId: 'alice',
      repoRoot: tempRepo.repoRoot,
      llmEnabled: false,
    });

    expect(startOwnedCalled).toBe(true);
    expect(startFreshSpy).toHaveBeenCalled();
    expect(handle).toBeDefined();
    expect(handle.volumeId).not.toBe(staleVolId);
    expect(freshSpecCaptured.volume.volumeId).not.toBe(staleVolId);

    // Verify updated signed volume metadata on disk
    const updatedMeta = readSignedVolumeMeta('enkeep-demo-dsh-alice', { repoRoot: tempRepo.repoRoot });
    expect(updatedMeta).not.toBeNull();
    expect(updatedMeta!.volumeId).toBe(handle.volumeId);

    startOwnedSpy.mockRestore();
    startFreshSpy.mockRestore();
  });

  it('reconnects to existing volume when volume actually exists on host', async () => {
    const mockDockerClient = new SafeDockerClient();
    vi.spyOn(mockDockerClient, 'isDockerAvailable').mockResolvedValue(true);
    vi.spyOn(mockDockerClient, 'inspectContainer').mockResolvedValue(null);

    const preservedVolId = 'vol_33333333333333333333333333333333';
    writeSignedVolumeMeta(
      {
        userId: 'hpc_admin_shadow_42559a95',
        volumeName: 'enkeep-demo-dsh-hpc_admin_shadow_42559a95',
        volumeId: preservedVolId,
        runId: 'run_preserved_001',
      },
      { repoRoot: tempRepo.repoRoot }
    );

    let startOwnedCalled = false;
    let capturedSpec: any = null;
    const ownedHandle: ActiveRuntimeHandle = {
      containerId: 'b'.repeat(64),
      runId: 'run_resumed_001',
      volumeId: preservedVolId,
      isCreated: false,
      spec: {} as any,
      checkHealth: vi.fn().mockResolvedValue({
        status: 'ok',
        dshReady: true,
        userId: 'hpc_admin_shadow_42559a95',
        uptimeSeconds: 10,
        modelProvider: 'cpa-claude',
      }),
      sendFollowup: vi.fn().mockResolvedValue({ status: 'completed', replyText: 'ok', persisted: true }),
      importSeed: vi.fn().mockResolvedValue({ status: 'completed' }),
      cancelTurn: vi.fn().mockResolvedValue({ status: 'cancelled', turnId: 't1' }),
      stop: vi.fn().mockResolvedValue(undefined),
      teardown: vi.fn().mockResolvedValue(undefined),
    };

    const startOwnedSpy = vi
      .spyOn(DockerRuntimeAdapter.prototype, 'startRuntimeWithOwnedVolume')
      .mockImplementation(async (spec) => {
        startOwnedCalled = true;
        capturedSpec = spec;
        return ownedHandle;
      });

    const startFreshSpy = vi.spyOn(DockerRuntimeAdapter.prototype, 'startRuntime');

    const adapter = new DockerRuntimeContainerAdapter(mockDockerClient);
    const handle = await adapter.startUserRuntime({
      userId: 'hpc_admin_shadow_42559a95',
      repoRoot: tempRepo.repoRoot,
      llmEnabled: false,
    });

    expect(startOwnedCalled).toBe(true);
    expect(startFreshSpy).not.toHaveBeenCalled();
    expect(handle.volumeId).toBe(preservedVolId);
    expect(capturedSpec.volume.volumeId).toBe(preservedVolId);

    startOwnedSpy.mockRestore();
    startFreshSpy.mockRestore();
  });

  it('fails closed on volume ownership mismatch and never falls back', async () => {
    const mockDockerClient = new SafeDockerClient();
    vi.spyOn(mockDockerClient, 'isDockerAvailable').mockResolvedValue(true);

    writeSignedVolumeMeta(
      {
        userId: 'attacker',
        volumeName: 'enkeep-demo-dsh-bob',
        volumeId: 'vol_44444444444444444444444444444444',
        runId: 'run_attacker_001',
      },
      { repoRoot: tempRepo.repoRoot }
    );

    const startFreshSpy = vi.spyOn(DockerRuntimeAdapter.prototype, 'startRuntime');
    const startOwnedSpy = vi.spyOn(DockerRuntimeAdapter.prototype, 'startRuntimeWithOwnedVolume');

    const adapter = new DockerRuntimeContainerAdapter(mockDockerClient);
    await expect(
      adapter.startUserRuntime({
        userId: 'bob',
        repoRoot: tempRepo.repoRoot,
      })
    ).rejects.toThrow(/FAIL-CLOSED: Signed volume metadata userId mismatch/);

    expect(startFreshSpy).not.toHaveBeenCalled();
    expect(startOwnedSpy).not.toHaveBeenCalled();

    startFreshSpy.mockRestore();
    startOwnedSpy.mockRestore();
  });

  it('reconciles stale container metadata when container disappeared from host', async () => {
    const mockDockerClient = new SafeDockerClient();
    vi.spyOn(mockDockerClient, 'isDockerAvailable').mockResolvedValue(true);
    // Container missing from host
    vi.spyOn(mockDockerClient, 'inspectContainer').mockResolvedValue(null);

    const containerName = 'enkeep-demo-alice';
    writeSignedContainerMeta(
      {
        userId: 'alice',
        containerName,
        containerId: 'c'.repeat(64),
        image: 'enkeep-demo-runtime:acceptance',
        volumeName: 'enkeep-demo-dsh-alice',
        volumeId: 'vol_55555555555555555555555555555555',
        labels: {},
        runId: 'run_old_001',
      },
      { repoRoot: tempRepo.repoRoot }
    );

    const freshHandle: ActiveRuntimeHandle = {
      containerId: 'd'.repeat(64),
      runId: 'run_fresh_002',
      volumeId: 'vol_66666666666666666666666666666666',
      isCreated: true,
      spec: {} as any,
      checkHealth: vi.fn().mockResolvedValue({
        status: 'ok',
        dshReady: true,
        userId: 'alice',
        uptimeSeconds: 1,
        modelProvider: 'cpa-claude',
      }),
      sendFollowup: vi.fn().mockResolvedValue({ status: 'completed', replyText: 'ok', persisted: true }),
      importSeed: vi.fn().mockResolvedValue({ status: 'completed' }),
      cancelTurn: vi.fn().mockResolvedValue({ status: 'cancelled', turnId: 't1' }),
      stop: vi.fn().mockResolvedValue(undefined),
      teardown: vi.fn().mockResolvedValue(undefined),
    };

    const startFreshSpy = vi
      .spyOn(DockerRuntimeAdapter.prototype, 'startRuntime')
      .mockResolvedValue(freshHandle);

    const adapter = new DockerRuntimeContainerAdapter(mockDockerClient);
    const handle = await adapter.startUserRuntime({
      userId: 'alice',
      repoRoot: tempRepo.repoRoot,
      llmEnabled: false,
    });

    expect(handle).toBeDefined();
    expect(handle.containerId).toBe('d'.repeat(64));

    // Verify signed container metadata was updated with new container ID
    const updatedMeta = readSignedContainerMeta(containerName, { repoRoot: tempRepo.repoRoot });
    expect(updatedMeta).not.toBeNull();
    expect(updatedMeta!.containerId).toBe('d'.repeat(64));

    startFreshSpy.mockRestore();
  });
});
