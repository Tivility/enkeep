/**
 * Synthetic Test Suite: Reuse Runtimes on Platform Restart & Hot SIGTERM
 *
 * Verifies:
 * 1. Platform exit (system.close with retainContainers / SIGTERM) does NOT teardown/stop/remove containers.
 * 2. Platform restart reuses existing running containers without calling remove/create.
 * 3. When image is outdated, container is reused and getUpgradeStatus correctly reports isOutdated: true.
 * 4. When container is absent or stopped, a fresh container is created.
 * 5. Platform exit in normal mode (down / system.close) stops and cleans up.
 *
 * @module @enkeep/demo-runner/tests/reuse-runtimes-on-restart.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  DockerRuntimeAdapter,
  SafeDockerClient,
  computeSessionEventsChecksum,
  canonicalJsonStringify,
} from '@enkeep/runtime-runner';
import { resetDemo } from '../src/reset/index.js';
import { launchDemoSystem } from '../src/up/index.js';
import { downDemo } from '../src/down/index.js';
import { getDemoPathConfig } from '../src/config.js';
import { readSignedContainerMeta } from '../src/utils/crypto-meta.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

describe('Reuse Runtimes On Restart Integration', () => {
  let tempRepo: TempRepo;
  let paths: ReturnType<typeof getDemoPathConfig>;
  const resourceSuffix = 'synthreuse';

  beforeEach(() => {
    tempRepo = createTempRepo();
    paths = getDemoPathConfig(tempRepo.repoRoot);
  });

  afterEach(async () => {
    await downDemo({ repoRoot: tempRepo.repoRoot, resourceSuffix, removeVolumes: true });
    tempRepo.cleanup();
  });

  function createMockHandle(spec: any, cid: string, isCreated: boolean, stoppedIds: string[], removedIds: string[]) {
    const importedSessions = new Set<string>();
    return {
      containerId: cid,
      runId: spec.runId,
      volumeId: spec.volume.volumeId,
      isCreated,
      spec,
      startTunnel: vi.fn().mockResolvedValue({ registerHandler: vi.fn(), close: vi.fn() }),
      startTransport: vi.fn().mockResolvedValue(undefined),
      checkHealth: vi.fn().mockResolvedValue({
        status: 'ok',
        dshReady: true,
        userId: spec.userId,
        uptimeSeconds: isCreated ? 10 : 100,
        version: '0.1.0',
        enkeepBundleLoaded: true,
        toolsCount: 5,
        plugins: {
          receiptStore: true,
          inbound: true,
          eventRelay: true,
          externalInteraction: true,
          affinityPolicy: true,
          llmAffinity: true,
          tools: true,
        },
        toolsOperational: true,
        toolsUnavailableReason: null,
        modelProvider: 'cpa-claude',
      }),
      importSeed: vi.fn().mockImplementation(async (sessionId, seed) => {
        const checksum = computeSessionEventsChecksum(seed);
        const canonicalJson = canonicalJsonStringify(seed);
        const canonicalBytes = Buffer.byteLength(canonicalJson, 'utf8');
        const isDup = importedSessions.has(sessionId);
        importedSessions.add(sessionId);
        const evCount = Array.isArray(seed) ? seed.length : 1;
        return {
          status: 'completed',
          sessionId,
          persisted: true,
          eventsCount: evCount,
          receipt: {
            algorithm: 'sha256-session-events-v1' as const,
            checksum,
            canonicalBytes,
            eventCount: evCount,
          },
          duplicate: isDup,
        };
      }),
      stop: vi.fn().mockImplementation(async () => {
        stoppedIds.push(cid);
      }),
      teardown: vi.fn().mockImplementation(async () => {
        removedIds.push(cid);
      }),
    };
  }

  it('1. Reuses existing running containers on platform restart without calling remove/create', async () => {
    await resetDemo({ repoRoot: tempRepo.repoRoot, resourceSuffix });

    // Mock SafeDockerClient & DockerRuntimeAdapter
    const createdContainerIds: string[] = [];
    const stoppedContainerIds: string[] = [];
    const removedContainerIds: string[] = [];
    let startRuntimeCallCount = 0;
    let connectRuntimeCallCount = 0;

    const mockContainers = new Map<string, any>();

    vi.spyOn(SafeDockerClient.prototype, 'isDockerAvailable').mockResolvedValue(true);
    vi.spyOn(SafeDockerClient.prototype, 'inspectContainer').mockImplementation(async (idOrName) => {
      const found = mockContainers.get(idOrName);
      if (found) return found;
      for (const info of mockContainers.values()) {
        if (info.id === idOrName || info.name === idOrName) {
          return info;
        }
      }
      return null;
    });

    vi.spyOn(SafeDockerClient.prototype, 'connectVolume').mockResolvedValue(undefined as any);
    vi.spyOn(SafeDockerClient.prototype, 'assertContainerOwnership').mockImplementation(() => {});

    vi.spyOn(DockerRuntimeAdapter.prototype, 'startRuntime').mockImplementation(async (spec) => {
      startRuntimeCallCount++;
      const cid = 'a'.repeat(60) + String(startRuntimeCallCount).padStart(4, '0');
      createdContainerIds.push(cid);
      const containerInfo = {
        id: cid,
        name: spec.containerName,
        image: spec.image,
        status: 'running',
        state: 'running',
        user: '1000:1000',
        networkMode: spec.networkMode || 'none',
        readonlyRootfs: true,
        capDrop: ['ALL'],
        securityOpt: ['no-new-privileges:true'],
        pidsLimit: 256,
        portBindings: null,
        mounts: [
          {
            type: 'volume',
            name: spec.volume.volumeName,
            destination: '/home/dsh',
            rw: true,
            source: '/var/lib/docker/volumes/' + spec.volume.volumeName,
          },
        ],
        labels: {
          app: 'enkeep-demo',
          'enkeep.user': spec.userId,
          'enkeep.run-id': spec.runId,
          'enkeep.volume-id': spec.volume.volumeId,
        },
      };
      mockContainers.set(cid, containerInfo);
      mockContainers.set(spec.containerName, containerInfo);

      return createMockHandle(spec, cid, true, stoppedContainerIds, removedContainerIds) as any;
    });

    vi.spyOn(DockerRuntimeAdapter.prototype, 'connectRuntime').mockImplementation(async (spec, identity) => {
      connectRuntimeCallCount++;
      const cid = typeof identity === 'object' ? identity.containerId : 'a'.repeat(60) + '0001';
      return createMockHandle(spec, cid, false, stoppedContainerIds, removedContainerIds) as any;
    });

    // 1. First Boot: container does not exist yet -> created via startRuntime
    const system1 = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
    });
    expect(system1.result.ok).toBe(true);
    expect(startRuntimeCallCount).toBe(2); // Alice & Bob created
    expect(connectRuntimeCallCount).toBe(0);
    const initialAliceMeta = readSignedContainerMeta(`enkeep-demo-alice-${resourceSuffix}`, { repoRoot: tempRepo.repoRoot, resourceSuffix });
    expect(initialAliceMeta).not.toBeNull();

    // 2. Graceful exit with retainContainers: true (SIGTERM simulation)
    await system1.close({ removeVolumes: false, retainContainers: true });

    // Ensure teardown/stop were NOT called on containers
    expect(stoppedContainerIds).toHaveLength(0);
    expect(removedContainerIds).toHaveLength(0);

    // Ensure container metadata was retained
    const retainedAliceMeta = readSignedContainerMeta(`enkeep-demo-alice-${resourceSuffix}`, { repoRoot: tempRepo.repoRoot, resourceSuffix });
    expect(retainedAliceMeta).not.toBeNull();
    expect(retainedAliceMeta?.containerId).toBe(initialAliceMeta?.containerId);

    // 3. Second Boot: restart platform -> should REUSE existing containers via connectRuntime
    const system2 = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
    });
    expect(system2.result.ok).toBe(true);
    expect(connectRuntimeCallCount).toBe(2); // Alice & Bob reconnected
    expect(startRuntimeCallCount).toBe(2); // No new creation!

    const reconnectedAliceMeta = readSignedContainerMeta(`enkeep-demo-alice-${resourceSuffix}`, { repoRoot: tempRepo.repoRoot, resourceSuffix });
    expect(reconnectedAliceMeta?.containerId).toBe(initialAliceMeta?.containerId);

    // 4. Teardown with normal system.close (full shutdown)
    await system2.close({ removeVolumes: true });
    expect(removedContainerIds.length).toBeGreaterThan(0);
  });

  it('2. Reuses container when image is outdated and upgrade-status reflects isOutdated', async () => {
    await resetDemo({ repoRoot: tempRepo.repoRoot, resourceSuffix });

    const mockContainers = new Map<string, any>();
    const stoppedContainerIds: string[] = [];
    const removedContainerIds: string[] = [];
    let startRuntimeCallCount = 0;
    let connectRuntimeCallCount = 0;

    vi.spyOn(SafeDockerClient.prototype, 'isDockerAvailable').mockResolvedValue(true);
    vi.spyOn(SafeDockerClient.prototype, 'inspectContainer').mockImplementation(async (idOrName) => {
      const found = mockContainers.get(idOrName);
      if (found) return found;
      for (const info of mockContainers.values()) {
        if (info.id === idOrName || info.name === idOrName) {
          return info;
        }
      }
      return null;
    });

    vi.spyOn(SafeDockerClient.prototype, 'connectVolume').mockResolvedValue(undefined as any);
    vi.spyOn(SafeDockerClient.prototype, 'assertContainerOwnership').mockImplementation(() => {});

    vi.spyOn(DockerRuntimeAdapter.prototype, 'startRuntime').mockImplementation(async (spec) => {
      startRuntimeCallCount++;
      const cid = 'b'.repeat(60) + String(startRuntimeCallCount).padStart(4, '0');
      const containerInfo = {
        id: cid,
        name: spec.containerName,
        image: 'enkeep-demo-runtime:old-v1', // Older image
        status: 'running',
        state: 'running',
        user: '1000:1000',
        networkMode: spec.networkMode || 'none',
        readonlyRootfs: true,
        capDrop: ['ALL'],
        securityOpt: ['no-new-privileges:true'],
        pidsLimit: 256,
        portBindings: null,
        mounts: [
          {
            type: 'volume',
            name: spec.volume.volumeName,
            destination: '/home/dsh',
            rw: true,
            source: '/var/lib/docker/volumes/' + spec.volume.volumeName,
          },
        ],
        labels: {
          app: 'enkeep-demo',
          'enkeep.user': spec.userId,
          'enkeep.run-id': spec.runId,
          'enkeep.volume-id': spec.volume.volumeId,
        },
      };
      mockContainers.set(cid, containerInfo);
      mockContainers.set(spec.containerName, containerInfo);

      return createMockHandle(spec, cid, true, stoppedContainerIds, removedContainerIds) as any;
    });

    vi.spyOn(DockerRuntimeAdapter.prototype, 'connectRuntime').mockImplementation(async (spec, identity) => {
      connectRuntimeCallCount++;
      const cid = typeof identity === 'object' ? identity.containerId : 'b'.repeat(60) + '0001';
      return createMockHandle(spec, cid, false, stoppedContainerIds, removedContainerIds) as any;
    });

    // 1. Initial launch
    const system1 = await launchDemoSystem({ repoRoot: tempRepo.repoRoot, resourceSuffix });
    await system1.close({ retainContainers: true });

    // 2. Set new target version in database (image: enkeep-demo-runtime:new-v2)
    const directDb = new DatabaseSync(paths.dbPath);
    try {
      directDb.prepare(
        "INSERT OR REPLACE INTO runtime_target_version (id, image, daemon_cli_path, updated_by, updated_at) VALUES ('default', 'enkeep-demo-runtime:new-v2', NULL, NULL, datetime('now'))"
      ).run();
    } finally {
      directDb.close();
    }

    // 3. Re-launch platform: should reuse existing old container without rebuilding on startup
    const system2 = await launchDemoSystem({ repoRoot: tempRepo.repoRoot, resourceSuffix });
    expect(system2.result.ok).toBe(true);
    expect(connectRuntimeCallCount).toBe(2);
    expect(startRuntimeCallCount).toBe(2); // Not recreated!

    // 4. Query upgrade status via management provider: isOutdated must be TRUE
    const mgmt = system2.managementProvider;
    expect(mgmt).toBeDefined();
    const upgradeStatuses = await mgmt?.getUpgradeStatus?.();
    expect(upgradeStatuses).toBeDefined();
    expect(upgradeStatuses?.length).toBe(2);
    const aliceUser = await system2.storage.users.findByUsername('alice');
    const aliceStatus = upgradeStatuses?.find((s) => s.userId === aliceUser?.id);
    expect(aliceStatus).toBeDefined();
    expect(aliceStatus?.isOutdated).toBe(true);
    expect(aliceStatus?.targetImage).toBe('enkeep-demo-runtime:new-v2');

    await system2.close({ removeVolumes: true });
  });

  it('3. Creates a fresh container when container does not exist or was stopped/dead', async () => {
    await resetDemo({ repoRoot: tempRepo.repoRoot, resourceSuffix });

    const mockContainers = new Map<string, any>();
    const stoppedContainerIds: string[] = [];
    const removedContainerIds: string[] = [];
    let startRuntimeCallCount = 0;
    let connectRuntimeCallCount = 0;

    vi.spyOn(SafeDockerClient.prototype, 'isDockerAvailable').mockResolvedValue(true);
    vi.spyOn(SafeDockerClient.prototype, 'inspectContainer').mockImplementation(async (idOrName) => {
      const found = mockContainers.get(idOrName);
      if (found) return found;
      for (const info of mockContainers.values()) {
        if (info.id === idOrName || info.name === idOrName) {
          return info;
        }
      }
      return null;
    });

    vi.spyOn(SafeDockerClient.prototype, 'connectVolume').mockResolvedValue(undefined as any);
    vi.spyOn(SafeDockerClient.prototype, 'assertContainerOwnership').mockImplementation(() => {});

    vi.spyOn(DockerRuntimeAdapter.prototype, 'startRuntime').mockImplementation(async (spec) => {
      startRuntimeCallCount++;
      const cid = 'c'.repeat(60) + String(startRuntimeCallCount).padStart(4, '0');
      const containerInfo = {
        id: cid,
        name: spec.containerName,
        image: spec.image,
        status: 'running',
        state: 'running',
        user: '1000:1000',
        networkMode: spec.networkMode || 'none',
        readonlyRootfs: true,
        capDrop: ['ALL'],
        securityOpt: ['no-new-privileges:true'],
        pidsLimit: 256,
        portBindings: null,
        mounts: [
          {
            type: 'volume',
            name: spec.volume.volumeName,
            destination: '/home/dsh',
            rw: true,
            source: '/var/lib/docker/volumes/' + spec.volume.volumeName,
          },
        ],
        labels: {
          app: 'enkeep-demo',
          'enkeep.user': spec.userId,
          'enkeep.run-id': spec.runId,
          'enkeep.volume-id': spec.volume.volumeId,
        },
      };
      mockContainers.set(cid, containerInfo);
      mockContainers.set(spec.containerName, containerInfo);

      return createMockHandle(spec, cid, true, stoppedContainerIds, removedContainerIds) as any;
    });

    vi.spyOn(DockerRuntimeAdapter.prototype, 'startRuntimeWithOwnedVolume').mockImplementation(async (spec) => {
      startRuntimeCallCount++;
      const cid = 'd'.repeat(60) + String(startRuntimeCallCount).padStart(4, '0');
      const containerInfo = {
        id: cid,
        name: spec.containerName,
        image: spec.image,
        status: 'running',
        state: 'running',
        user: '1000:1000',
        networkMode: spec.networkMode || 'none',
        readonlyRootfs: true,
        capDrop: ['ALL'],
        securityOpt: ['no-new-privileges:true'],
        pidsLimit: 256,
        portBindings: null,
        mounts: [
          {
            type: 'volume',
            name: spec.volume.volumeName,
            destination: '/home/dsh',
            rw: true,
            source: '/var/lib/docker/volumes/' + spec.volume.volumeName,
          },
        ],
        labels: {
          app: 'enkeep-demo',
          'enkeep.user': spec.userId,
          'enkeep.run-id': spec.runId,
          'enkeep.volume-id': spec.volume.volumeId,
        },
      };
      mockContainers.set(cid, containerInfo);
      mockContainers.set(spec.containerName, containerInfo);

      return createMockHandle(spec, cid, false, stoppedContainerIds, removedContainerIds) as any;
    });

    vi.spyOn(DockerRuntimeAdapter.prototype, 'connectRuntime').mockImplementation(async (spec, identity) => {
      connectRuntimeCallCount++;
      const cid = typeof identity === 'object' ? identity.containerId : 'c'.repeat(60) + '0001';
      return createMockHandle(spec, cid, false, stoppedContainerIds, removedContainerIds) as any;
    });

    // 1. Initial launch
    const system1 = await launchDemoSystem({ repoRoot: tempRepo.repoRoot, resourceSuffix });
    expect(startRuntimeCallCount).toBe(2);

    // 2. Full shutdown: removes containers
    await system1.close({ removeVolumes: false }); // retainContainers is false, teardown called

    // Simulate containers being removed from Docker host
    mockContainers.clear();

    // 3. Restart platform: since containers do not exist on host, fresh ones are started mounting the owned volumes
    const system2 = await launchDemoSystem({ repoRoot: tempRepo.repoRoot, resourceSuffix });
    expect(system2.result.ok).toBe(true);
    expect(startRuntimeCallCount).toBe(4); // 2 more created via startRuntimeWithOwnedVolume

    await system2.close({ removeVolumes: true });
  });
});
