import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { SqliteWebMessageStore } from '../src/storage/web-messages.js';
import { SqlitePlatformApi } from '../src/storage/sqlite-platform-api.js';
import { PlatformServerMigrationRunner, ALL_PLATFORM_MIGRATIONS } from '../src/storage/migrations.js';

/**
 * web_events can contain internal or legacy rows (for example `session_recovery_required`, written
 * next to the public `turn_failed` RECOVERY_REQUIRED event). Polling must skip them, keep returning
 * the public events around them and advance the cursor past them.
 */
describe('pollEvents with unknown or legacy event types', () => {
  const userId = 'user-alice';
  const spaceId = 'spc_00000000000000000000000000000001';
  const sessionId = 'ses_00000000000000000000000000000001';
  let db: DatabaseSync;
  let store: SqliteWebMessageStore;

  function insertRaw(id: string, type: string, payload: string, createdAt: string) {
    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, sessionId, userId, type, payload, createdAt);
  }

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    await new PlatformServerMigrationRunner(db).migrate(ALL_PLATFORM_MIGRATIONS);
    store = new SqliteWebMessageStore(db);
    db.exec(`
      INSERT INTO users (id, username, password_hash, status) VALUES ('${userId}', 'alice', 'hash', 'active');
      INSERT INTO spaces (id, user_id, name, folder, status, execution_mode)
      VALUES ('${spaceId}', '${userId}', 'Alice Space', 'alice-space', 'active', 'container');
      INSERT INTO session_routes (id, space_id, user_id, channel, dsh_session_id, status, execution_mode)
      VALUES ('${sessionId}', '${spaceId}', '${userId}', 'web', 'ses_00000000000000000000000000000101', 'active', 'container');
    `);
    insertRaw('evt_00000000000000000000000000000001', 'turn_failed', JSON.stringify({ code: 'RECOVERY_REQUIRED' }), '2026-01-01T00:00:01.000Z');
    insertRaw('evt_00000000000000000000000000000002', 'session_recovery_required', JSON.stringify({ code: 'RECOVERY_REQUIRED' }), '2026-01-01T00:00:02.000Z');
    insertRaw('evt_00000000000000000000000000000003', 'some_future_type', 'not-json', '2026-01-01T00:00:03.000Z');
    insertRaw('evt_00000000000000000000000000000004', 'turn_status', JSON.stringify({ status: 'completed' }), '2026-01-01T00:00:04.000Z');
  });

  it('skips unknown types in the store and keeps the surrounding public events', async () => {
    const polled = await store.pollEvents(userId, sessionId);
    expect(polled.events.map((e) => e.type)).toEqual(['turn_failed', 'turn_status']);
    expect(polled.hasMore).toBe(false);

    // The cursor points past the last scanned row, so a follow-up poll returns nothing new.
    const next = await store.pollEvents(userId, sessionId, { cursor: polled.nextCursor! });
    expect(next.events).toEqual([]);
  });

  it('advances the cursor past trailing unknown rows', async () => {
    const first = await store.pollEvents(userId, sessionId, { limit: 2 });
    expect(first.events.map((e) => e.id)).toEqual(['evt_00000000000000000000000000000001']);
    expect(first.hasMore).toBe(true);

    const second = await store.pollEvents(userId, sessionId, { cursor: first.nextCursor!, limit: 1 });
    expect(second.events).toEqual([]);
    expect(second.nextCursor).not.toBe(first.nextCursor);

    const third = await store.pollEvents(userId, sessionId, { cursor: second.nextCursor!, limit: 5 });
    expect(third.events.map((e) => e.id)).toEqual(['evt_00000000000000000000000000000004']);
  });

  it('serves the public poll API without failing', async () => {
    const storage = new SqlitePlatformStorage({ database: db });
    const api = new SqlitePlatformApi({ storage, messageStore: store, db });
    const result = await api.pollEvents(userId, sessionId);
    expect(result.events.map((e: any) => e.type)).toEqual(['turn_status', 'turn_status']);
    expect(result.events[0]).toMatchObject({ status: 'failed' });
    expect(result.events[1]).toMatchObject({ status: 'completed' });
  });
});
