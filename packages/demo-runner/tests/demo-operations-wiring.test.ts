import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { resetDemo, DEMO_FIXTURE_QUOTA_LIMITS } from '../src/reset/index.js';
import { launchDemoSystem, upDemo } from '../src/up/index.js';
import { getDemoPathConfig } from '../src/config.js';
import { FakeUnitRuntimeContainerAdapter } from './support/fake-runtime.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

describe('Demo Operations & Quota Integration Wiring', () => {
  let tempRepo: TempRepo;

  beforeEach(() => {
    tempRepo = createTempRepo();
  });

  afterEach(() => {
    tempRepo.cleanup();
  });

  it('provisions DEMO_FIXTURE_QUOTA_LIMITS for all demo users during resetDemo', async () => {
    await resetDemo({ repoRoot: tempRepo.repoRoot });
    const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot });
    const db = new DatabaseSync(paths.dbPath);

    try {
      const aliceUser = db.prepare("SELECT id FROM users WHERE username = 'alice'").get() as { id: string };
      const bobUser = db.prepare("SELECT id FROM users WHERE username = 'bob'").get() as { id: string };
      expect(aliceUser).toBeDefined();
      expect(bobUser).toBeDefined();

      const limits = db.prepare(`
        SELECT user_id, resource, limit_amount
        FROM quota_limits
        ORDER BY user_id, resource
      `).all() as Array<{ user_id: string; resource: string; limit_amount: number }>;

      expect(limits.length).toBeGreaterThanOrEqual(10); // 5 metrics * 2 users

      const aliceLimits = limits.filter((l) => l.user_id === aliceUser.id);
      const bobLimits = limits.filter((l) => l.user_id === bobUser.id);

      for (const [resource, expectedLimit] of Object.entries(DEMO_FIXTURE_QUOTA_LIMITS)) {
        const aliceRow = aliceLimits.find((l) => l.resource === resource);
        expect(aliceRow).toBeDefined();
        expect(aliceRow?.limit_amount).toBe(expectedLimit);

        const bobRow = bobLimits.find((l) => l.resource === resource);
        expect(bobRow).toBeDefined();
        expect(bobRow?.limit_amount).toBe(expectedLimit);
      }
    } finally {
      db.close();
    }
  });

  it('fails closed when demo DB lacks quota limits configuration with explicit guidance', async () => {
    await resetDemo({ repoRoot: tempRepo.repoRoot });
    const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot });

    // Wipe out quota_limits rows
    const db = new DatabaseSync(paths.dbPath);
    db.exec('DELETE FROM quota_limits');
    db.close();

    const fakeAdapter = new FakeUnitRuntimeContainerAdapter();
    await expect(
      launchDemoSystem({
        repoRoot: tempRepo.repoRoot,
        runtimeAdapter: fakeAdapter,
      })
    ).rejects.toThrow(/FAIL-CLOSED: Missing quota limits configuration in demo database.*pnpm run demo:reset/);
  });

  it('wires quota provider with enforced fail-closed policy into DeliveryRuntimeGateway', async () => {
    await resetDemo({ repoRoot: tempRepo.repoRoot });
    const fakeAdapter = new FakeUnitRuntimeContainerAdapter();
    const system = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: fakeAdapter,
    });

    try {
      const gateway = (system.platformServer as any).runtimeGateway;
      expect(gateway).toBeDefined();
      expect(gateway.quotaProvider).toBeDefined();
    } finally {
      await system.close({ removeVolumes: true });
    }
  });

  it('executes turn with dockerTurnExecutor and passes turnId across generational reset (nativeContextId !== dshSessionId)', async () => {
    await resetDemo({ repoRoot: tempRepo.repoRoot });
    const fakeAdapter = new FakeUnitRuntimeContainerAdapter();
    const system = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: fakeAdapter,
    });

    try {
      const server = system.platformServer;
      const storage = (server as any).storage;
      const gateway = (server as any).runtimeGateway;
      const executor = gateway.executor;

      // 1. Get Alice user
      const alice = await storage.users.findByUsername('alice');
      expect(alice).toBeDefined();

      const spaces = await storage.forTenant(alice.id).spaces.list();
      expect(spaces.length).toBeGreaterThan(0);
      const space = spaces[0];

      const routes = await storage.forTenant(alice.id).sessionRoutes.list();
      expect(routes.length).toBeGreaterThan(0);
      const initialRoute = routes[0];

      // Distinct authoritative dshSessionId for generation 2 (which differs from platform session initialRoute.id)
      const authoritativeDshSessionId = 'dsh_session_gen2_diff_id';

      // 2. Perform generational reset on Alice's session route
      const resetResult = await storage.forTenant(alice.id).sessionRoutes.reset(initialRoute.id, {
        dshSessionId: authoritativeDshSessionId,
        resetReason: 'Integration test generational reset',
        agentProfileSnapshotId: null,
      });
      expect(resetResult.generation.generationNumber).toBe(2);

      // 3. Construct resolved envelope and delivery execution request
      const resolvedEnvelope = {
        id: 'msg_test_turn_1',
        userId: alice.id,
        sessionId: initialRoute.id,
        spaceId: space.id,
        content: 'Check repo status post reset',
        timestamp: new Date().toISOString(),
      };

      // 4. Execute turn using authoritative dshSessionId and explicit turnId
      const testTurnId = 'turn_test_gen_reset_1';
      const result = await executor.execute({
        userId: alice.id,
        platformSpaceId: space.id,
        dshSessionId: authoritativeDshSessionId,
        turnId: testTurnId,
        content: 'Check repo status post reset',
        profile: null,
        envelope: resolvedEnvelope,
      });

      expect(result).toBeDefined();
      expect(result.replyText).toContain('Check repo status post reset');
      expect(result.metadata.persisted).toBe(true);
    } finally {
      await system.close({ removeVolumes: true });
    }
  });
});
