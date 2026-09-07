import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSqliteStorage, SqlitePlatformStorage } from '../src/index.js';
import { NotFoundError } from '@enkeep/platform-core';
import { TEST_V9_FULL_MIGRATIONS } from './v9-agent-profiles-repo.test.js';

describe('Tenant Isolation', () => {
  let storage: SqlitePlatformStorage;
  let tenantAId: string;
  let tenantBId: string;

  beforeEach(async () => {
    storage = await createSqliteStorage({ dbPath: ':memory:', migrations: TEST_V9_FULL_MIGRATIONS });

    const userA = await storage.users.create({
      username: 'tenantA',
      passwordHash: 'hash_a',
      role: 'user',
    });
    tenantAId = userA.id;

    const userB = await storage.users.create({
      username: 'tenantB',
      passwordHash: 'hash_b',
      role: 'user',
    });
    tenantBId = userB.id;
  });

  afterEach(async () => {
    await storage.close();
  });

  it('isolates spaces between tenants', async () => {
    const repoA = storage.forTenant(tenantAId).spaces;
    const repoB = storage.forTenant(tenantBId).spaces;

    const spaceA = await repoA.create({
      name: 'Space A',
      folder: 'space-00000000000000000000000000000001',
    });

    // Tenant A can find it
    expect(await repoA.findById(spaceA.id)).not.toBeNull();
    expect(await repoA.findByFolder('space-00000000000000000000000000000001')).not.toBeNull();

    // Tenant B cannot find it
    expect(await repoB.findById(spaceA.id)).toBeNull();
    expect(await repoB.findByFolder('space-00000000000000000000000000000001')).toBeNull();

    // Listing only returns tenant's own spaces
    const listA = await repoA.list();
    const listB = await repoB.list();
    expect(listA.map((s) => s.id)).toEqual([spaceA.id]);
    expect(listB).toEqual([]);

    // Tenant B attempting to update or delete Tenant A's space is rejected / returns false
    await expect(repoB.update(spaceA.id, { name: 'Hacked Space' })).rejects.toThrow(NotFoundError);
    expect(await repoB.delete(spaceA.id)).toBe(false);
  });

  it('isolates session routes between tenants with full route identity (channel, accountId, nativeContextId)', async () => {
    const tenantA = storage.forTenant(tenantAId);
    const tenantB = storage.forTenant(tenantBId);

    const spaceA = await tenantA.spaces.create({
      name: 'Space A',
      folder: 'space-00000000000000000000000000000001',
    });

    const routeA = await tenantA.sessionRoutes.create({
      spaceId: spaceA.id,
      channel: 'web',
      accountId: 'acc-main',
      nativeContextId: 'tab-101',
      dshSessionId: 'ses_00000000000000000000000000000001',
    });

    // Tenant A can access route by ID and by full Route Identity
    expect(await tenantA.sessionRoutes.findById(routeA.id)).not.toBeNull();
    expect(await tenantA.sessionRoutes.findByRouteIdentity('web', 'acc-main', 'tab-101')).not.toBeNull();
    expect(await tenantA.sessionRoutes.findByPeer('web', 'tab-101')).not.toBeNull();
    expect(await tenantA.sessionRoutes.findByDshSessionId('ses_00000000000000000000000000000001')).not.toBeNull();
    expect(await tenantA.sessionRoutes.countBySpaceId(spaceA.id)).toBe(1);
    expect(await tenantA.sessionRoutes.countBySpaceId(spaceA.id, { status: 'active' })).toBe(1);
    expect(await tenantA.sessionRoutes.countBySpaceId(spaceA.id, { status: 'archived' })).toBe(0);

    // Tenant B cannot access Tenant A's route even with identical route identity
    expect(await tenantB.sessionRoutes.findById(routeA.id)).toBeNull();
    expect(await tenantB.sessionRoutes.findByRouteIdentity('web', 'acc-main', 'tab-101')).toBeNull();
    expect(await tenantB.sessionRoutes.findByDshSessionId('ses_00000000000000000000000000000001')).toBeNull();
    expect(await tenantB.sessionRoutes.countBySpaceId(spaceA.id)).toBe(0);

    // Tenant B cannot create route pointing to Tenant A's space
    await expect(
      tenantB.sessionRoutes.create({
        spaceId: spaceA.id,
        channel: 'web',
        accountId: 'acc-main',
        nativeContextId: 'tab-102',
        dshSessionId: 'ses_00000000000000000000000000000002',
      })
    ).rejects.toThrow(NotFoundError);

    // Tenant B cannot update or delete Tenant A's route
    await expect(tenantB.sessionRoutes.update(routeA.id, { dshSessionId: 'ses_00000000000000000000000000000099' })).rejects.toThrow(
      NotFoundError
    );
    expect(await tenantB.sessionRoutes.delete(routeA.id)).toBe(false);
  });

  it('isolates session sources between tenants', async () => {
    const tenantA = storage.forTenant(tenantAId);
    const tenantB = storage.forTenant(tenantBId);

    const spaceA = await tenantA.spaces.create({ name: 'Space A', folder: 'space-00000000000000000000000000000001' });
    const routeA = await tenantA.sessionRoutes.create({
      spaceId: spaceA.id,
      channel: 'discord',
      nativeContextId: 'disc-1',
      dshSessionId: 'ses_00000000000000000000000000000001',
    });

    const sourceA = await tenantA.sessionSources.create({
      routeId: routeA.id,
      sourceType: 'channel_msg',
      sourceId: 'msg-1001',
      metadata: { originalSender: 'userA' },
    });

    expect(await tenantA.sessionSources.findById(sourceA.id)).not.toBeNull();
    expect(await tenantA.sessionSources.findBySource('channel_msg', 'msg-1001')).not.toBeNull();

    // Tenant B cannot see source
    expect(await tenantB.sessionSources.findById(sourceA.id)).toBeNull();
    expect(await tenantB.sessionSources.findBySource('channel_msg', 'msg-1001')).toBeNull();

    // Tenant B cannot create source pointing to Tenant A's route
    await expect(
      tenantB.sessionSources.create({
        routeId: routeA.id,
        sourceType: 'channel_msg',
        sourceId: 'msg-1002',
      })
    ).rejects.toThrow(NotFoundError);
  });

  it('isolates delivery receipts between tenants', async () => {
    const tenantA = storage.forTenant(tenantAId);
    const tenantB = storage.forTenant(tenantBId);

    const spaceA = await tenantA.spaces.create({ name: 'Space A', folder: 'space-00000000000000000000000000000001' });
    const routeA = await tenantA.sessionRoutes.create({
      spaceId: spaceA.id,
      channel: 'feishu',
      nativeContextId: 'feishu-1',
      dshSessionId: 'ses_00000000000000000000000000000001',
    });

    const receiptA = await tenantA.deliveryReceipts.create({
      routeId: routeA.id,
      messageId: 'msg-feishu-1',
      deliveryId: 'del-100',
    });

    expect(await tenantA.deliveryReceipts.findById(receiptA.id)).not.toBeNull();
    expect(await tenantA.deliveryReceipts.findByDeliveryId('del-100')).not.toBeNull();

    // Tenant B cannot see Tenant A's receipt
    expect(await tenantB.deliveryReceipts.findById(receiptA.id)).toBeNull();
    expect(await tenantB.deliveryReceipts.findByDeliveryId('del-100')).toBeNull();

    // Tenant B cannot update Tenant A's receipt
    await expect(
      tenantB.deliveryReceipts.updateStatus(receiptA.id, { status: 'delivered' })
    ).rejects.toThrow(NotFoundError);
  });

  it('isolates event cursors by route/session scope and tenant', async () => {
    const tenantA = storage.forTenant(tenantAId);
    const tenantB = storage.forTenant(tenantBId);

    const spaceA = await tenantA.spaces.create({ name: 'Space A', folder: 'space-00000000000000000000000000000001' });
    const spaceB = await tenantB.spaces.create({ name: 'Space B', folder: 'space-00000000000000000000000000000002' });

    // Same user multiple sessions / routes
    const routeA1 = await tenantA.sessionRoutes.create({
      spaceId: spaceA.id,
      channel: 'web',
      accountId: 'acc1',
      nativeContextId: 'session-1',
      dshSessionId: 'ses_00000000000000000000000000000001',
    });

    const routeA2 = await tenantA.sessionRoutes.create({
      spaceId: spaceA.id,
      channel: 'web',
      accountId: 'acc1',
      nativeContextId: 'session-2',
      dshSessionId: 'ses_00000000000000000000000000000002',
    });

    const routeB1 = await tenantB.sessionRoutes.create({
      spaceId: spaceB.id,
      channel: 'web',
      accountId: 'acc1',
      nativeContextId: 'session-1',
      dshSessionId: 'ses_00000000000000000000000000000003',
    });

    // Set cursors for same consumer on different routes of Tenant A
    await tenantA.eventCursors.setCursor(routeA1.id, 'watermark-a1', 'relay');
    await tenantA.eventCursors.setCursor(routeA2.id, 'watermark-a2', 'relay');

    // Tenant B sets cursor on their own route
    await tenantB.eventCursors.setCursor(routeB1.id, 'watermark-b1', 'relay');

    // Check Tenant A route 1 and route 2 don't collide
    const cursorA1 = await tenantA.eventCursors.getCursor(routeA1.id, 'relay');
    const cursorA2 = await tenantA.eventCursors.getCursor(routeA2.id, 'relay');
    const cursorB1 = await tenantB.eventCursors.getCursor(routeB1.id, 'relay');

    expect(cursorA1?.cursorValue).toBe('watermark-a1');
    expect(cursorA2?.cursorValue).toBe('watermark-a2');
    expect(cursorB1?.cursorValue).toBe('watermark-b1');

    // Tenant B cannot set or get cursor on Tenant A's route
    await expect(tenantB.eventCursors.setCursor(routeA1.id, 'hacked', 'relay')).rejects.toThrow(
      NotFoundError
    );
    expect(await tenantB.eventCursors.getCursor(routeA1.id, 'relay')).toBeNull();
  });

  it('isolates turn runs between tenants', async () => {
    const tenantA = storage.forTenant(tenantAId);
    const tenantB = storage.forTenant(tenantBId);

    const spaceA = await tenantA.spaces.create({ name: 'Space A', folder: 'space-00000000000000000000000000000001' });
    const routeA = await tenantA.sessionRoutes.create({
      spaceId: spaceA.id,
      channel: 'telegram',
      nativeContextId: 'tg-1',
      dshSessionId: 'ses_00000000000000000000000000000001',
    });

    const runA = await tenantA.turnRuns.create({
      spaceId: spaceA.id,
      routeId: routeA.id,
      turnId: 'turn-1',
      status: 'running',
    });

    expect(await tenantA.turnRuns.findById(runA.id)).not.toBeNull();
    expect(await tenantB.turnRuns.findById(runA.id)).toBeNull();

    // Tenant B cannot update Tenant A's turn run
    await expect(
      tenantB.turnRuns.updateStatus(runA.id, { status: 'completed' })
    ).rejects.toThrow(NotFoundError);

    // Tenant B cannot create a turn run referencing Tenant A's space or route
    await expect(
      tenantB.turnRuns.create({
        spaceId: spaceA.id,
        routeId: routeA.id,
        turnId: 'turn-2',
      })
    ).rejects.toThrow(NotFoundError);
  });
});
