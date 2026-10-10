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
});
