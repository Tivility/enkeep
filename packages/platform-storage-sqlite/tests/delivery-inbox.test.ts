import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSqliteStorage, SqlitePlatformStorage } from '../src/index.js';
import {
  NotFoundError,
  InvalidStateTransitionError,
} from '@enkeep/platform-core';
import { TEST_V9_FULL_MIGRATIONS } from './v9-agent-profiles-repo.test.js';

describe('Delivery Inbox CAS, Lifecycle & Restart Redrive', () => {
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

  it('atomically ingests messages with initial held state and detects duplicates (delivery_id + tenant uniqueness)', async () => {
    const t1 = storage.forTenant(user1Id);

    // 1. First ingestion of delivery_id 'del-100'
    const result1 = await t1.deliveryInbox.ingest({
      routeId: route1Id,
      messageId: 'msg-100',
      deliveryId: 'del-100',
      payload: { text: 'Hello bot' },
    });

    expect(result1.isDuplicate).toBe(false);
    expect(result1.entry.id).toBeDefined();
    expect(result1.entry.status).toBe('held');
    expect(result1.entry.deliveryId).toBe('del-100');
    expect(result1.entry.payload).toEqual({ text: 'Hello bot' });

    // 2. Second ingestion with same delivery_id 'del-100' for tenant 1
    const result2 = await t1.deliveryInbox.ingest({
      routeId: route1Id,
      messageId: 'msg-100-retry',
      deliveryId: 'del-100',
      payload: { text: 'Hello bot retry' },
    });

    expect(result2.isDuplicate).toBe(true);
    expect(result2.entry.id).toBe(result1.entry.id);
    expect(result2.entry.status).toBe('held');

    // 3. Different tenant can ingest identical delivery_id without collision (scoped per tenant)
    const t2 = storage.forTenant(user2Id);
    const resultUser2 = await t2.deliveryInbox.ingest({
      routeId: route2Id,
      messageId: 'msg-user2',
      deliveryId: 'del-100',
    });

    expect(resultUser2.isDuplicate).toBe(false);
    expect(resultUser2.entry.id).not.toBe(result1.entry.id);
    expect(resultUser2.entry.userId).toBe(user2Id);
  });

  it('enforces single-winner CAS concurrency on claimHeld (held -> processing)', async () => {
    const t1 = storage.forTenant(user1Id);

    const { entry: item } = await t1.deliveryInbox.ingest({
      routeId: route1Id,
      messageId: 'msg-race-1',
      deliveryId: 'del-race-1',
    });

    // Simulate two concurrent dispatchers attempting to claim the same held item
    const claim1Promise = t1.deliveryInbox.claimHeld(item.id);
    const claim2Promise = t1.deliveryInbox.claimHeld(item.id);

    const [claim1, claim2] = await Promise.all([claim1Promise, claim2Promise]);

    // Exactly one claim succeeds and returns the entry in processing status; the other gets null
    const winner = claim1 ?? claim2;
    const loser = claim1 === null ? claim1 : claim2;

    expect(winner).not.toBeNull();
    expect(winner?.status).toBe('processing');
    expect(loser).toBeNull();

    // Held list is now empty, item is in processing list
    expect((await t1.deliveryInbox.listHeld()).length).toBe(0);
    expect((await t1.deliveryInbox.listProcessing()).length).toBe(1);
  });

  it('supports releaseToHeld for retrying failed dispatches (processing -> held)', async () => {
    const t1 = storage.forTenant(user1Id);

    const { entry: item } = await t1.deliveryInbox.ingest({
      routeId: route1Id,
      messageId: 'msg-retry-1',
      deliveryId: 'del-retry-1',
    });

    // Claim
    const claimed = await t1.deliveryInbox.claimHeld(item.id);
    expect(claimed?.status).toBe('processing');

    // Worker fails to deliver to container, releases back to held
    const released = await t1.deliveryInbox.releaseToHeld(item.id, 'Container network transient timeout');
    expect(released.status).toBe('held');
    expect(released.error).toBe('Container network transient timeout');

    // Item is available for claim again
    const reclaimed = await t1.deliveryInbox.claimHeld(item.id);
    expect(reclaimed?.status).toBe('processing');

    // Finally mark delivered from processing status
    const delivered = await t1.deliveryInbox.markDelivered(item.id);
    expect(delivered.status).toBe('delivered');
    expect(delivered.processedAt).not.toBeNull();
  });

  it('rejects invalid state transitions with InvalidStateTransitionError', async () => {
    const t1 = storage.forTenant(user1Id);

    const { entry: item } = await t1.deliveryInbox.ingest({
      routeId: route1Id,
      messageId: 'msg-invalid-1',
      deliveryId: 'del-invalid-1',
    });

    // Cannot release an item that is in held status
    await expect(t1.deliveryInbox.releaseToHeld(item.id)).rejects.toThrow(InvalidStateTransitionError);

    // Cannot directly mark delivered without claiming first
    await expect(t1.deliveryInbox.markDelivered(item.id)).rejects.toThrow(InvalidStateTransitionError);

    // Claim first (held -> processing)
    const claimed = await t1.deliveryInbox.claimHeld(item.id);
    expect(claimed?.status).toBe('processing');

    // Transition to terminal delivered
    await t1.deliveryInbox.markDelivered(item.id);

    // Terminal delivered cannot be claimed, cancelled, duplicated, or released
    await expect(t1.deliveryInbox.markCancelled(item.id, 'Too late')).rejects.toThrow(
      InvalidStateTransitionError
    );
    await expect(t1.deliveryInbox.markDuplicate(item.id)).rejects.toThrow(InvalidStateTransitionError);
    await expect(t1.deliveryInbox.releaseToHeld(item.id)).rejects.toThrow(InvalidStateTransitionError);

    // claimHeld on delivered returns null
    const lateClaim = await t1.deliveryInbox.claimHeld(item.id);
    expect(lateClaim).toBeNull();
  });

  it('redrives in-flight processing entries back to held during restart recovery and returns heldDeliveries', async () => {
    const t1 = storage.forTenant(user1Id);
    const t2 = storage.forTenant(user2Id);

    // 1. Item 1: held
    await t1.deliveryInbox.ingest({
      routeId: route1Id,
      messageId: 'msg-h1',
      deliveryId: 'del-h1',
    });

    // 2. Item 2: in-flight processing during crash
    const { entry: item2 } = await t1.deliveryInbox.ingest({
      routeId: route1Id,
      messageId: 'msg-proc-1',
      deliveryId: 'del-proc-1',
    });
    await t1.deliveryInbox.claimHeld(item2.id);

    // 3. Item 3: already delivered before crash
    const { entry: item3 } = await t1.deliveryInbox.ingest({
      routeId: route1Id,
      messageId: 'msg-d1',
      deliveryId: 'del-d1',
    });
    await t1.deliveryInbox.claimHeld(item3.id);
    await t1.deliveryInbox.markDelivered(item3.id);

    // 4. Tenant 2 item: processing during crash
    const { entry: itemT2 } = await t2.deliveryInbox.ingest({
      routeId: route2Id,
      messageId: 'msg-t2-proc',
      deliveryId: 'del-t2-proc',
    });
    await t2.deliveryInbox.claimHeld(itemT2.id);

    // Create a running turn run
    await t1.turnRuns.create({
      spaceId: space1Id,
      routeId: route1Id,
      turnId: 'turn-running',
      status: 'running',
    });

    // Execute platform restart recovery
    const recovery = await storage.recoverAfterRestart();
    expect(recovery.interruptedTurnRuns).toBe(1);

    // In-flight processing items (del-proc-1 and del-t2-proc) redriven to held
    // Total held deliveries = del-h1 + del-proc-1 + del-t2-proc = 3
    expect(recovery.heldDeliveries.length).toBe(3);

    const heldDeliveryIds = recovery.heldDeliveries.map((d) => d.deliveryId);
    expect(heldDeliveryIds).toContain('del-h1');
    expect(heldDeliveryIds).toContain('del-proc-1');
    expect(heldDeliveryIds).toContain('del-t2-proc');
    expect(heldDeliveryIds).not.toContain('del-d1');

    // Verify item2 can be reclaimed and delivered after restart
    const reclaimedPostRestart = await t1.deliveryInbox.claimHeld(item2.id);
    expect(reclaimedPostRestart).not.toBeNull();
    expect(reclaimedPostRestart?.status).toBe('processing');

    const deliveredPostRestart = await t1.deliveryInbox.markDelivered(item2.id);
    expect(deliveredPostRestart.status).toBe('delivered');
  });

  it('enforces strict tenant isolation on delivery inbox operations', async () => {
    const t1 = storage.forTenant(user1Id);
    const t2 = storage.forTenant(user2Id);

    const { entry: item1 } = await t1.deliveryInbox.ingest({
      routeId: route1Id,
      messageId: 'msg-t1',
      deliveryId: 'del-t1',
    });

    // Tenant 1 can find item
    expect(await t1.deliveryInbox.findById(item1.id)).not.toBeNull();
    expect(await t1.deliveryInbox.findByDeliveryId('del-t1')).not.toBeNull();

    // Tenant 2 cannot see Tenant 1's inbox item
    expect(await t2.deliveryInbox.findById(item1.id)).toBeNull();
    expect(await t2.deliveryInbox.findByDeliveryId('del-t1')).toBeNull();
    expect((await t2.deliveryInbox.listHeld()).length).toBe(0);

    // Tenant 2 cannot ingest inbox item targeting Tenant 1's route
    await expect(
      t2.deliveryInbox.ingest({
        routeId: route1Id,
        messageId: 'msg-hack',
        deliveryId: 'del-hack',
      })
    ).rejects.toThrow(NotFoundError);

    // Tenant 2 cannot claim, deliver, or cancel Tenant 1's inbox item
    await expect(t2.deliveryInbox.claimHeld(item1.id)).rejects.toThrow(NotFoundError);
    await expect(t2.deliveryInbox.markDelivered(item1.id)).rejects.toThrow(NotFoundError);
    await expect(t2.deliveryInbox.markCancelled(item1.id, 'hack')).rejects.toThrow(NotFoundError);

    // Non-existent item throws NotFoundError
    await expect(t1.deliveryInbox.markDelivered('non-existent-id')).rejects.toThrow(NotFoundError);
  });
});
