/**
 * CompositeManagementRuntimeProvider deduplicates shared managementProvider instances
 * across registered execution modes (synthetic, offline).
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  ManagementRuntimeProvider,
  RuntimeTargetVersionRecord,
  UserRuntimeStatus,
  UserRuntimeUpgradeStatus,
} from '@enkeep/platform-core';
import {
  CompositeManagementRuntimeProvider,
  RuntimeProviderRegistry,
} from '../src/runtime/provider-registry.js';
import type { DeliveryTurnExecutor } from '../src/runtime/delivery-gateway.js';

const ALICE = 'user-alice';
const BOB = 'user-bob';

const stubTurnExecutor: DeliveryTurnExecutor = {
  execute: async () => ({ replyText: 'synthetic' }),
  cancel: async () => false,
};

function makeRuntimeStatus(userId: string, version = '0.1.0'): UserRuntimeStatus {
  return {
    userId,
    status: 'ok',
    networkMode: 'none',
    dshReady: true,
    uptimeSeconds: 100,
    version,
    enkeepBundleLoaded: true,
    toolsCount: 5,
    plugins: {
      receiptStore: true,
      inbound: true,
      eventRelay: true,
      tools: true,
      externalInteraction: true,
      affinityPolicy: true,
      llmAffinity: true,
    },
    toolsOperational: true,
    toolsUnavailableReason: null,
  };
}

function makeUpgradeStatus(
  userId: string,
  version = '0.1.0',
  mode: 'container' | 'host' = 'container'
): UserRuntimeUpgradeStatus {
  return {
    userId,
    mode,
    currentImage: `enkeep-runtime:${version}`,
    targetImage: `enkeep-runtime:${version}`,
    currentDaemonCliPath: '/opt/dsh/cli.js',
    targetDaemonCliPath: '/opt/dsh/cli.js',
    isOutdated: false,
    isIdle: true,
    idleDurationSeconds: 120,
    pendingReason: 'up_to_date',
  };
}

function makeTargetVersion(image = 'enkeep-runtime:0.2.0'): RuntimeTargetVersionRecord {
  return {
    id: 'target-version-1',
    image,
    daemonCliPath: '/opt/dsh/cli.js',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: ALICE,
  };
}

function createMockManagementProvider(
  userId: string,
  version = '0.1.0',
  mode: 'container' | 'host' = 'container'
) {
  const status = makeRuntimeStatus(userId, version);
  const upgrade = makeUpgradeStatus(userId, version, mode);
  const targetVersion = makeTargetVersion(`enkeep-runtime:${version}`);

  const provider: ManagementRuntimeProvider = {
    listRuntimes: vi.fn(async () => [status]),
    getUserRuntime: vi.fn(async (id: string) => (id === userId ? status : null)),
    restartRuntime: vi.fn(async (id?: string) => ({
      restarted: true,
      userIds: [id ?? userId],
      appliedRuntimes: [id ?? userId],
    })),
    stopRuntime: vi.fn(async (id: string) => ({ stopped: true, userId: id })),
    ensureRuntime: vi.fn(async (id: string) => (id === userId ? status : null)),
    getTargetVersion: vi.fn(async () => targetVersion),
    setTargetVersion: vi.fn(async (input) => ({
      id: targetVersion.id,
      image: input.image ?? targetVersion.image,
      daemonCliPath: input.daemonCliPath ?? targetVersion.daemonCliPath,
      updatedAt: '2026-01-02T00:00:00.000Z',
      updatedBy: input.updatedBy ?? null,
    })),
    getUpgradeStatus: vi.fn(async () => [upgrade]),
  };

  return { provider, status, upgrade, targetVersion };
}

describe('CompositeManagementRuntimeProvider deduplication', () => {
  it('calls a shared managementProvider instance only once across container and host modes', async () => {
    const { provider: sharedManagement, upgrade } = createMockManagementProvider(ALICE, '0.1.0');

    const registry = new RuntimeProviderRegistry();
    registry.registerProvider({
      mode: 'container',
      turnExecutor: stubTurnExecutor,
      managementProvider: sharedManagement,
    });
    registry.registerProvider({
      mode: 'host',
      turnExecutor: stubTurnExecutor,
      managementProvider: sharedManagement,
    });

    const composite = new CompositeManagementRuntimeProvider(registry);

    // getUpgradeStatus: no duplicate entries, called once
    const upgrades = await composite.getUpgradeStatus();
    expect(upgrades).toEqual([upgrade]);
    expect(sharedManagement.getUpgradeStatus).toHaveBeenCalledTimes(1);

    // listRuntimes: no duplicate entries, called once
    const runtimes = await composite.listRuntimes();
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]?.userId).toBe(ALICE);
    expect(runtimes[0]?.instanceId).toBe(`${ALICE}:container`);
    expect(runtimes[0]?.mode).toBe('container');
    expect(sharedManagement.listRuntimes).toHaveBeenCalledTimes(1);

    // setTargetVersion: called once
    const updatedTarget = await composite.setTargetVersion({
      image: 'enkeep-runtime:0.2.0',
      updatedBy: ALICE,
    });
    expect(updatedTarget.image).toBe('enkeep-runtime:0.2.0');
    expect(sharedManagement.setTargetVersion).toHaveBeenCalledTimes(1);

    // getTargetVersion when returning null: called once
    vi.mocked(sharedManagement.getTargetVersion!).mockResolvedValueOnce(null);
    expect(await composite.getTargetVersion()).toBeNull();
    expect(sharedManagement.getTargetVersion).toHaveBeenCalledTimes(1);

    // getUserRuntime without mode when missing: called once
    expect(await composite.getUserRuntime(BOB)).toBeNull();
    expect(sharedManagement.getUserRuntime).toHaveBeenCalledTimes(1);

    // ensureRuntime without mode when missing: called once
    expect(await composite.ensureRuntime(BOB)).toBeNull();
    expect(sharedManagement.ensureRuntime).toHaveBeenCalledTimes(1);

    // stopRuntime without mode: called once
    const stopped = await composite.stopRuntime(ALICE);
    expect(stopped).toEqual({ stopped: true, userId: ALICE });
    expect(sharedManagement.stopRuntime).toHaveBeenCalledTimes(1);

    // restartRuntime(userId) without mode: does not falsely treat shared instance as two active runtimes
    vi.mocked(sharedManagement.getUserRuntime).mockClear();
    const restartedUser = await composite.restartRuntime(ALICE);
    expect(restartedUser.restarted).toBe(true);
    expect(sharedManagement.getUserRuntime).toHaveBeenCalledTimes(1);
    expect(sharedManagement.restartRuntime).toHaveBeenCalledTimes(1);

    // restartRuntime() for all without mode: called once
    vi.mocked(sharedManagement.restartRuntime!).mockClear();
    const restartedAll = await composite.restartRuntime();
    expect(restartedAll.restarted).toBe(true);
    expect(sharedManagement.restartRuntime).toHaveBeenCalledTimes(1);

    // restartRuntime(undefined, 'host'): explicit second mode still invokes shared provider
    vi.mocked(sharedManagement.restartRuntime!).mockClear();
    const restartedHost = await composite.restartRuntime(undefined, 'host');
    expect(restartedHost.restarted).toBe(true);
    expect(sharedManagement.restartRuntime).toHaveBeenCalledTimes(1);
  });

  it('continues to aggregate across distinct managementProvider instances', async () => {
    const { provider: containerManagement, upgrade: containerUpgrade } = createMockManagementProvider(
      ALICE,
      '0.1.0-container'
    );
    const { provider: hostManagement, upgrade: hostUpgrade } = createMockManagementProvider(
      BOB,
      '0.1.0-host'
    );

    const registry = new RuntimeProviderRegistry();
    registry.registerProvider({
      mode: 'container',
      turnExecutor: stubTurnExecutor,
      managementProvider: containerManagement,
    });
    registry.registerProvider({
      mode: 'host',
      turnExecutor: stubTurnExecutor,
      managementProvider: hostManagement,
    });

    const composite = new CompositeManagementRuntimeProvider(registry);

    const upgrades = await composite.getUpgradeStatus();
    expect(upgrades).toEqual([containerUpgrade, hostUpgrade]);
    expect(containerManagement.getUpgradeStatus).toHaveBeenCalledTimes(1);
    expect(hostManagement.getUpgradeStatus).toHaveBeenCalledTimes(1);

    const runtimes = await composite.listRuntimes();
    expect(runtimes.map((r) => r.instanceId)).toEqual([`${ALICE}:container`, `${BOB}:host`]);
    expect(containerManagement.listRuntimes).toHaveBeenCalledTimes(1);
    expect(hostManagement.listRuntimes).toHaveBeenCalledTimes(1);

    await composite.setTargetVersion({ image: 'enkeep-runtime:0.3.0', updatedBy: ALICE });
    expect(containerManagement.setTargetVersion).toHaveBeenCalledTimes(1);
    expect(hostManagement.setTargetVersion).toHaveBeenCalledTimes(1);

    const stopped = await composite.stopRuntime(ALICE);
    expect(stopped).toEqual({ stopped: true, userId: ALICE });
    expect(containerManagement.stopRuntime).toHaveBeenCalledTimes(1);
    expect(hostManagement.stopRuntime).toHaveBeenCalledTimes(1);

    const restartedAll = await composite.restartRuntime();
    expect(restartedAll.restarted).toBe(true);
    expect(restartedAll.userIds.sort()).toEqual([ALICE, BOB]);
    expect(containerManagement.restartRuntime).toHaveBeenCalledTimes(1);
    expect(hostManagement.restartRuntime).toHaveBeenCalledTimes(1);
  });

  it('still requires explicit mode in restartRuntime(userId) when two distinct providers have active runtimes', async () => {
    const { provider: containerManagement } = createMockManagementProvider(ALICE, '0.1.0-container');
    const { provider: hostManagement } = createMockManagementProvider(ALICE, '0.1.0-host');

    const registry = new RuntimeProviderRegistry();
    registry.registerProvider({
      mode: 'container',
      turnExecutor: stubTurnExecutor,
      managementProvider: containerManagement,
    });
    registry.registerProvider({
      mode: 'host',
      turnExecutor: stubTurnExecutor,
      managementProvider: hostManagement,
    });

    const composite = new CompositeManagementRuntimeProvider(registry);

    await expect(composite.restartRuntime(ALICE)).rejects.toThrow(
      'Target execution mode ("container" or "host") is required when multiple runtimes exist for user'
    );
  });
});
