import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ALL_PLATFORM_MIGRATIONS, PlatformServerMigrationRunner } from '@enkeep/platform-server';
import { RuntimeTargetVersionRepo } from '@enkeep/platform-storage-sqlite';
import { upDemo } from '../src/up/index.js';
import { DockerRuntimeContainerAdapter, HostRuntimePortAdapter } from '../src/ports/index.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

describe('Demo Runner Dynamic On-Demand Boot with Target Version', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-demo-target-ver-'));
    dbPath = path.join(tmpDir, 'platform.db');

    const db = new DatabaseSync(dbPath);
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    // Insert active users
    db.exec(`
      INSERT INTO users (id, username, password_hash, role, status) VALUES ('u_alice', 'alice', 'h', 'admin', 'active');
      INSERT INTO users (id, username, password_hash, role, status) VALUES ('u_bob', 'bob', 'h', 'user', 'active');
      INSERT INTO quota_limits (user_id, resource, limit_amount) VALUES ('u_alice', 'turns', 100);
      INSERT INTO quota_limits (user_id, resource, limit_amount) VALUES ('u_bob', 'turns', 100);
    `);
    db.close();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('boots runtime with custom target version persisted in DB', async () => {
    const db = new DatabaseSync(dbPath);
    const repo = new RuntimeTargetVersionRepo(db);
    repo.setTargetVersion({
      image: 'enkeep-runtime:target-custom-tag-v9',
      daemonCliPath: '/custom/target/daemon-cli.js',
    });
    db.close();

    const startedImages: string[] = [];
    const mockContainerAdapter: any = {
      startUserRuntime: vi.fn(async (opts) => {
        startedImages.push(opts.image);
        return {
          userId: opts.userId,
          containerName: `test-${opts.userId}`,
          containerId: 'c_test_1',
          volumeId: 'vol_test_1',
          runId: 'run_1',
          volumeCreated: false,
          checkHealth: async () => ({
            status: 'ok',
            uptimeSeconds: 10,
            userId: opts.userId,
            dshReady: true,
            enkeepBundleLoaded: true,
            modelProvider: 'demo',
            plugins: { receiptStore: true, inbound: true, eventRelay: true, tools: true, externalInteraction: true, affinityPolicy: true, llmAffinity: true },
            toolsCount: 4,
            toolsOperational: true,
            toolsUnavailableReason: null,
            version: '1.0.0',
          }),
          stop: async () => {},
          teardown: async () => {},
        };
      }),
      listActiveRuntimes: vi.fn().mockResolvedValue([]),
    };

    const system = await upDemo({
      repoRoot: tmpDir,
      dataRoot: tmpDir,
      mode: 'ephemeral',
      cookieSecret: 'test-secret-key-32-chars-minimum-length!',
      csrfToken: 'test-csrf-token-32-chars-long-valid!',
      runtimeAdapter: mockContainerAdapter,
      llmEnabled: false,
      port: 0,
    });

    try {
      expect(startedImages).toContain('enkeep-runtime:target-custom-tag-v9');
      const mgmt = system.managementProvider;
      expect(mgmt).toBeDefined();
      const target = await mgmt?.getTargetVersion?.();
      expect(target?.image).toBe('enkeep-runtime:target-custom-tag-v9');

      const upgradeStatuses = await mgmt?.getUpgradeStatus?.();
      expect(upgradeStatuses).toBeDefined();
      expect(upgradeStatuses!.every((s) => !s.isOutdated)).toBe(true);
    } finally {
      await system.close();
    }
  });

  it('getUpgradeStatus fails closed on activity error or timeout and handles inspect resolution', async () => {
    const db = new DatabaseSync(dbPath);
    const repo = new RuntimeTargetVersionRepo(db);
    repo.setTargetVersion({
      image: 'enkeep-runtime:target-custom-tag-v9',
      daemonCliPath: '/custom/target/daemon-cli.js',
    });
    db.close();

    const mockContainerAdapter: any = {
      startUserRuntime: vi.fn(async (opts) => {
        return {
          userId: opts.userId,
          containerName: `test-${opts.userId}`,
          containerId: opts.userId === 'u_bob' ? '' : 'c_test_1',
          volumeId: 'vol_test_1',
          runId: 'run_1',
          volumeCreated: false,
          checkHealth: async () => ({
            status: 'ok',
            uptimeSeconds: 10,
            userId: opts.userId,
            dshReady: true,
            enkeepBundleLoaded: true,
            modelProvider: 'demo',
            plugins: { receiptStore: true, inbound: true, eventRelay: true, tools: true, externalInteraction: true, affinityPolicy: true, llmAffinity: true },
            toolsCount: 4,
            toolsOperational: true,
            toolsUnavailableReason: null,
            version: '1.0.0',
          }),
          stop: async () => {},
          teardown: async () => {},
        };
      }),
      listActiveRuntimes: vi.fn().mockResolvedValue([]),
    };

    const system = await upDemo({
      repoRoot: tmpDir,
      dataRoot: tmpDir,
      mode: 'ephemeral',
      cookieSecret: 'test-secret-key-32-chars-minimum-length!',
      csrfToken: 'test-csrf-token-32-chars-long-valid!',
      runtimeAdapter: mockContainerAdapter,
      llmEnabled: false,
      port: 0,
    });

    try {
      const mgmt = system.managementProvider;
      expect(mgmt).toBeDefined();

      // Update target version to a newer version so Alice (which launched with target-custom-tag-v9) is now outdated
      await mgmt?.setTargetVersion?.({
        image: 'enkeep-runtime:target-v10-new',
      });

      const upgradeStatuses = await mgmt?.getUpgradeStatus?.();
      expect(upgradeStatuses).toBeDefined();

      // u_alice has containerId 'c_test_1' but queryContainerActivity fails (no docker running) -> isIdle=false, pendingReason='activity_unavailable'
      const aliceStatus = upgradeStatuses?.find((s) => s.userId === 'u_alice');
      expect(aliceStatus).toBeDefined();
      expect(aliceStatus?.isOutdated).toBe(true);
      expect(aliceStatus?.isIdle).toBe(false);
      expect(aliceStatus?.pendingReason).toBe('activity_unavailable');
      expect(aliceStatus?.currentImage).toBe('enkeep-runtime:target-custom-tag-v9');

      // Clear u_bob's launchedImage to test inspect failure fallback (currentImage=null -> isOutdated=true)
      const userHandle = system.getUserRuntime ? await system.getUserRuntime('u_bob') : null;
      const internalHandle = (system as any).runtimeHandles?.get('u_bob');

      const bobStatus = upgradeStatuses?.find((s) => s.userId === 'u_bob');
      expect(bobStatus).toBeDefined();
      expect(bobStatus?.isOutdated).toBe(true);
      expect(bobStatus?.isIdle).toBe(false);
      expect(bobStatus?.pendingReason).toBe('activity_unavailable');
    } finally {
      await system.close();
    }
  });
});
