/**
 * The idle auto-upgrader rebuilds one outdated runtime. When the same management provider serves
 * both execution modes (the demo does), the mode must reach it, otherwise rebuilding a user's
 * container also stops that user's host runtime (and its background tasks).
 */

import { describe, it, expect, vi } from 'vitest';
import { RuntimeAutoUpgrader } from '../src/runtime/auto-upgrader.js';
import { CompositeManagementRuntimeProvider, RuntimeProviderRegistry } from '../src/runtime/provider-registry.js';

describe('auto-upgrade stops only the outdated runtime mode', () => {
  function setup() {
    const stops: Array<{ userId: string; mode: string | undefined }> = [];
    const shared: any = {
      listRuntimes: async () => [],
      getUpgradeStatus: async () => [
        { userId: 'user-bob', mode: 'container', isOutdated: true, isIdle: true, pendingReason: 'user_asset_mounts' },
        { userId: 'user-bob', mode: 'host', isOutdated: false, isIdle: false },
      ],
      stopRuntime: vi.fn(async (userId: string, mode?: 'container' | 'host') => {
        stops.push({ userId, mode });
        return { stopped: true, userId };
      }),
    };
    const registry = new RuntimeProviderRegistry();
    registry.registerProvider({ mode: 'container', turnExecutor: {} as any, managementProvider: shared });
    registry.registerProvider({ mode: 'host', turnExecutor: {} as any, managementProvider: shared });
    return { stops, composite: new CompositeManagementRuntimeProvider(registry) };
  }

  it('passes the mode through the composite provider', async () => {
    const { stops, composite } = setup();
    await expect(composite.stopRuntime('user-bob', 'container')).resolves.toMatchObject({ stopped: true, mode: 'container' });
    expect(stops).toEqual([{ userId: 'user-bob', mode: 'container' }]);
  });

  it('the upgrader rebuilding the container never asks to stop the host runtime', async () => {
    const { stops, composite } = setup();
    const gateway: any = {
      getUserActiveRoundsCount: () => ({ queued: 0, running: 0 }),
      pauseUserDispatch: vi.fn(),
      resumeUserDispatch: vi.fn(),
      redriveHeld: vi.fn(),
    };
    const upgrader = new RuntimeAutoUpgrader({
      managementProvider: composite,
      deliveryGateway: gateway,
      idleThresholdSeconds: 0,
      pauseSettleMs: 0,
      enabled: true,
    });
    const res = await upgrader.checkAndUpgrade();
    expect(res).toMatchObject({ status: 'upgraded', upgradedUserId: 'user-bob' });
    expect(stops).toEqual([{ userId: 'user-bob', mode: 'container' }]);
  });

  it('an unscoped stop still reaches every provider', async () => {
    const { stops, composite } = setup();
    await composite.stopRuntime('user-bob');
    expect(stops.every((s) => s.mode === undefined)).toBe(true);
    expect(stops.length).toBeGreaterThan(0);
  });
});
