import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { SqliteWebMessageStore } from '../src/storage/web-messages.js';
import { SqlitePlatformApi } from '../src/storage/sqlite-platform-api.js';
import { PlatformServerMigrationRunner, ALL_PLATFORM_MIGRATIONS } from '../src/storage/migrations.js';

/**
 * web_events rows keep `turnId` / `originTurnId` in their stored payload: the platform reads them
 * to route continuations back to the turn that launched them. The public poll projection rebuilds
 * each event from an allowlist and must never hand those internal ids to a browser.
 */
describe('pollEvents public projection omits internal turn ids', () => {
  const userId = 'user-alice';
  const spaceId = 'spc_00000000000000000000000000000001';
  const sessionId = 'ses_00000000000000000000000000000001';
  const turnId = 'turn_00000000000000000000000000000001';
  const originTurnId = 'turn_00000000000000000000000000000002';
  let db: DatabaseSync;
  let store: SqliteWebMessageStore;
  let seq = 0;

  function insert(type: string, payload: Record<string, unknown>) {
    seq += 1;
    const n = String(seq).padStart(32, '0');
    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      `evt_${n}`,
      sessionId,
      userId,
      type,
      JSON.stringify({ ...payload, turnId, originTurnId }),
      `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`
    );
  }

  beforeEach(async () => {
    seq = 0;
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
    const streamId = 'msgstream_00000000000000000000000000000001';
    insert('turn_status', { status: 'running' });
    insert('thinking', { status: 'thinking', streamId });
    insert('tool_status', { toolName: 'read_file', status: 'started', callId: 'call_1' });
    insert('assistant_delta', { streamId, delta: 'Hello', accumulatedLength: 5 });
    insert('assistant_stream_end', { streamId });
    insert('message', { message: { id: 'msg_1', role: 'assistant', content: 'Hello', status: 'delivered' } });
    insert('turn_status', { status: 'completed' });
  });

  it('keeps the ids in storage for internal routing', () => {
    const rows = db.prepare('SELECT payload FROM web_events WHERE session_id = ?').all(sessionId) as Array<{ payload: string }>;
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(JSON.parse(row.payload)).toMatchObject({ turnId, originTurnId });
    }
  });

  it('returns every public event without turnId or originTurnId', async () => {
    const storage = new SqlitePlatformStorage({ database: db });
    const api = new SqlitePlatformApi({ storage, messageStore: store, db });
    const result = await api.pollEvents(userId, sessionId);

    expect(result.events.map((e: any) => e.type)).toEqual([
      'turn_status',
      'thinking',
      'tool_status',
      'assistant_delta',
      'assistant_stream_end',
      'message',
      'turn_status',
    ]);
    const serialized = JSON.stringify(result.events);
    expect(serialized).not.toContain(turnId);
    expect(serialized).not.toContain(originTurnId);
    expect(serialized).not.toMatch(/"(origin)?[tT]urnId"/);
  });
});
