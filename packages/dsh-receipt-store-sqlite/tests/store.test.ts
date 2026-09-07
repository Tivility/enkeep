import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteReceiptStore,
  DuplicateDeliveryIdError,
  ReceiptNotFoundError,
  ReceiptStoreClosedError,
  MigrationError,
  MigrationDowngradeError,
} from '../src/index.js';

describe('SqliteReceiptStore Unit Tests', () => {
  let store: SqliteReceiptStore;

  beforeEach(() => {
    store = new SqliteReceiptStore({
      path: ':memory:',
      userId: 'test-user-1',
    });
    store.init();
  });

  afterEach(async () => {
    await store.close();
  });

  describe('Delivery Receipts CRUD', () => {
    it('records a new pending receipt and retrieves by deliveryId and messageId', async () => {
      const receipt = await store.recordReceipt({
        deliveryId: 'del-001',
        messageId: 'msg-001',
        routeId: 'route-001',
      });

      expect(receipt.deliveryId).toBe('del-001');
      expect(receipt.messageId).toBe('msg-001');
      expect(receipt.routeId).toBe('route-001');
      expect(receipt.status).toBe('pending');
      expect(receipt.error).toBeNull();
      expect(receipt.userId).toBe('test-user-1');

      const byDel = await store.getReceiptByDeliveryId('del-001');
      expect(byDel).toEqual(receipt);

      const byMsg = await store.getReceiptByMessageId('msg-001');
      expect(byMsg).toEqual(receipt);
    });

    it('rejects duplicate deliveryId for the same user with DuplicateDeliveryIdError', async () => {
      await store.recordReceipt({
        deliveryId: 'del-dup',
        messageId: 'msg-1',
      });

      await expect(
        store.recordReceipt({
          deliveryId: 'del-dup',
          messageId: 'msg-2',
        })
      ).rejects.toThrow(DuplicateDeliveryIdError);
    });

    it('updates receipt status from pending to delivered', async () => {
      await store.recordReceipt({
        deliveryId: 'del-status',
        messageId: 'msg-status',
      });

      const updated = await store.updateReceiptStatus('del-status', 'delivered');
      expect(updated.status).toBe('delivered');
      expect(updated.error).toBeNull();

      const refetched = await store.getReceiptByDeliveryId('del-status');
      expect(refetched?.status).toBe('delivered');
    });

    it('updates receipt status to failed with error message', async () => {
      await store.recordReceipt({
        deliveryId: 'del-fail',
        messageId: 'msg-fail',
      });

      const updated = await store.updateReceiptStatus(
        'del-fail',
        'failed',
        'Dispatch timeout after 30s'
      );
      expect(updated.status).toBe('failed');
      expect(updated.error).toBe('Dispatch timeout after 30s');
    });

    it('throws ReceiptNotFoundError when updating non-existent deliveryId', async () => {
      await expect(
        store.updateReceiptStatus('del-404', 'delivered')
      ).rejects.toThrow(ReceiptNotFoundError);
    });
  });

  describe('Session Sources', () => {
    it('records and retrieves session sources with metadata', async () => {
      const source = await store.recordSessionSource({
        routeId: 'route-telegram-1',
        sourceType: 'telegram',
        sourceId: 'chat_12345:msg_67890',
        metadata: { username: 'alice', forwarded: false },
      });

      expect(source.routeId).toBe('route-telegram-1');
      expect(source.sourceType).toBe('telegram');
      expect(source.sourceId).toBe('chat_12345:msg_67890');
      expect(source.metadata).toEqual({ username: 'alice', forwarded: false });

      const fetched = await store.getSessionSource('telegram', 'chat_12345:msg_67890');
      expect(fetched).toEqual(source);
    });

    it('updates routeId and metadata on conflict for same sourceType and sourceId', async () => {
      await store.recordSessionSource({
        routeId: 'route-old',
        sourceType: 'slack',
        sourceId: 'slack-thread-1',
        metadata: { step: 1 },
      });

      const updated = await store.recordSessionSource({
        routeId: 'route-new',
        sourceType: 'slack',
        sourceId: 'slack-thread-1',
        metadata: { step: 2 },
      });

      expect(updated.routeId).toBe('route-new');
      expect(updated.metadata).toEqual({ step: 2 });
    });

    it('queries session sources by routeId', async () => {
      await store.recordSessionSource({
        routeId: 'route-multi',
        sourceType: 'slack',
        sourceId: 'thread-1',
      });
      await store.recordSessionSource({
        routeId: 'route-multi',
        sourceType: 'slack',
        sourceId: 'thread-2',
      });

      const sources = await store.getSessionSourcesByRouteId('route-multi');
      expect(sources).toHaveLength(2);
      expect(sources.map((s) => s.sourceId)).toEqual(['thread-1', 'thread-2']);
    });
  });

  describe('Per-Session Event Cursors', () => {
    it('sets and retrieves event cursor per sessionId and consumer', async () => {
      const cursor = await store.setEventCursor('session-alpha', 'session-alpha:10', 'consumer-1');
      expect(cursor.sessionId).toBe('session-alpha');
      expect(cursor.consumer).toBe('consumer-1');
      expect(cursor.cursorValue).toBe('session-alpha:10');

      const fetched = await store.getEventCursor('session-alpha', 'consumer-1');
      expect(fetched?.cursorValue).toBe('session-alpha:10');

      // Update cursor
      const updated = await store.setEventCursor('session-alpha', 'session-alpha:25', 'consumer-1');
      expect(updated.cursorValue).toBe('session-alpha:25');

      const refetched = await store.getEventCursor('session-alpha', 'consumer-1');
      expect(refetched?.cursorValue).toBe('session-alpha:25');
    });

    it('isolates cursors across distinct sessions for the same consumer', async () => {
      await store.setEventCursor('session-A', 'session-A:5', 'relay-worker');
      await store.setEventCursor('session-B', 'session-B:12', 'relay-worker');

      const curA = await store.getEventCursor('session-A', 'relay-worker');
      const curB = await store.getEventCursor('session-B', 'relay-worker');

      expect(curA?.cursorValue).toBe('session-A:5');
      expect(curB?.cursorValue).toBe('session-B:12');
    });

    it('returns null for unrecorded session cursor', async () => {
      const cur = await store.getEventCursor('session-empty', 'default');
      expect(cur).toBeNull();
    });
  });

  describe('Closed Store & Error Handling', () => {
    it('throws ReceiptStoreClosedError when operating on closed store', async () => {
      await store.close();
      expect(store.isClosed).toBe(true);

      await expect(
        store.recordReceipt({ deliveryId: 'del-x', messageId: 'msg-x' })
      ).rejects.toThrow(ReceiptStoreClosedError);

      await expect(
        store.getEventCursor('session-1')
      ).rejects.toThrow(ReceiptStoreClosedError);
    });
  });
});
