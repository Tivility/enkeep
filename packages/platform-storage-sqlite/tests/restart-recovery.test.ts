import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSqliteStorage, SqlitePlatformStorage } from '../src/index.js';
import { TEST_V9_FULL_MIGRATIONS } from './v9-agent-profiles-repo.test.js';

describe('Restart Recovery & Turn Runs', () => {
  let storage: SqlitePlatformStorage;
  let user1Id: string;
  let user2Id: string;
  let space1Id: string;
  let route1Id: string;
  let space2Id: string;
  let route2Id: string;

  beforeEach(async () => {
    storage = await createSqliteStorage({ dbPath: ':memory:', migrations: TEST_V9_FULL_MIGRATIONS });

    const user1 = await storage.users.create({
      username: 'user1',
      passwordHash: 'hash1',
    });
    user1Id = user1.id;

    const user2 = await storage.users.create({
      username: 'user2',
      passwordHash: 'hash2',
    });
    user2Id = user2.id;

    const space1 = await storage.forTenant(user1Id).spaces.create({
      name: 'User1 Space',
      folder: 'space-00000000000000000000000000000001',
    });
    space1Id = space1.id;

    const route1 = await storage.forTenant(user1Id).sessionRoutes.create({
      spaceId: space1Id,
      channel: 'web',
      nativeContextId: 'peer1',
      dshSessionId: 'ses_00000000000000000000000000000001',
    });
    route1Id = route1.id;

    const space2 = await storage.forTenant(user2Id).spaces.create({
      name: 'User2 Space',
      folder: 'space-00000000000000000000000000000002',
    });
    space2Id = space2.id;

    const route2 = await storage.forTenant(user2Id).sessionRoutes.create({
      spaceId: space2Id,
      channel: 'web',
      nativeContextId: 'peer2',
      dshSessionId: 'ses_00000000000000000000000000000002',
    });
    route2Id = route2.id;
  });

  afterEach(async () => {
    await storage.close();
  });

  it('marks all open turns (queued, running) as interrupted across all tenants upon restart', async () => {
    const t1 = storage.forTenant(user1Id);
    const t2 = storage.forTenant(user2Id);

    // Create turn runs with diverse initial statuses
    const run1 = await t1.turnRuns.create({
      spaceId: space1Id,
      routeId: route1Id,
      turnId: 'turn-running-1',
      status: 'running',
    });

    const run2 = await t1.turnRuns.create({
      spaceId: space1Id,
      routeId: route1Id,
      turnId: 'turn-queued-1',
      status: 'queued',
    });

    const run3 = await t1.turnRuns.create({
      spaceId: space1Id,
      routeId: route1Id,
      turnId: 'turn-completed-1',
      status: 'completed',
    });

    const run4 = await t2.turnRuns.create({
      spaceId: space2Id,
      routeId: route2Id,
      turnId: 'turn-running-2',
      status: 'running',
    });

    const run5 = await t2.turnRuns.create({
      spaceId: space2Id,
      routeId: route2Id,
      turnId: 'turn-failed-2',
      status: 'failed',
    });

    // Before recovery
    expect((await t1.turnRuns.listOpenRuns()).length).toBe(2);
    expect((await t2.turnRuns.listOpenRuns()).length).toBe(1);

    // Perform system restart recovery
    const recoveryResult = await storage.recoverAfterRestart({
      interruptedReason: 'system rebooted',
    });

    expect(recoveryResult.interruptedTurnRuns).toBe(3); // run1, run2, run4
    expect(Array.isArray(recoveryResult.heldDeliveries)).toBe(true);

    // Verify statuses
    const updated1 = await t1.turnRuns.findById(run1.id);
    expect(updated1?.status).toBe('interrupted');
    expect(updated1?.finishedAt).not.toBeNull();
    expect(updated1?.error).toBe('system rebooted');

    const updated2 = await t1.turnRuns.findById(run2.id);
    expect(updated2?.status).toBe('interrupted');
    expect(updated2?.finishedAt).not.toBeNull();
    expect(updated2?.error).toBe('system rebooted');

    const updated3 = await t1.turnRuns.findById(run3.id);
    expect(updated3?.status).toBe('completed');
    expect(updated3?.error).toBeNull();

    const updated4 = await t2.turnRuns.findById(run4.id);
    expect(updated4?.status).toBe('interrupted');
    expect(updated4?.finishedAt).not.toBeNull();
    expect(updated4?.error).toBe('system rebooted');

    const updated5 = await t2.turnRuns.findById(run5.id);
    expect(updated5?.status).toBe('failed');

    // No open runs remaining
    expect((await t1.turnRuns.listOpenRuns()).length).toBe(0);
    expect((await t2.turnRuns.listOpenRuns()).length).toBe(0);
  });

  it('supports tenant-scoped interruptOpenRuns', async () => {
    const t1 = storage.forTenant(user1Id);
    const t2 = storage.forTenant(user2Id);

    const run1 = await t1.turnRuns.create({
      spaceId: space1Id,
      routeId: route1Id,
      turnId: 'turn-t1',
      status: 'running',
    });

    const run2 = await t2.turnRuns.create({
      spaceId: space2Id,
      routeId: route2Id,
      turnId: 'turn-t2',
      status: 'running',
    });

    const count = await t1.turnRuns.interruptOpenRuns('tenant-1 canceled');
    expect(count).toBe(1);

    expect((await t1.turnRuns.findById(run1.id))?.status).toBe('interrupted');
    expect((await t1.turnRuns.findById(run1.id))?.error).toBe('tenant-1 canceled');

    // Tenant 2's turn run should still be running
    expect((await t2.turnRuns.findById(run2.id))?.status).toBe('running');
  });
});
