import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqliteWebMessageStore } from '../src/storage/web-messages.js';
import { SqlitePlatformWebApiAdapter } from '../src/storage/sqlite-platform-api.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { PlatformServerMigrationRunner, ALL_PLATFORM_MIGRATIONS } from '../src/storage/migrations.js';

describe('Streaming Events Storage, Keyset Cursor & Tenant Isolation', () => {
  let db: DatabaseSync;
  let messageStore: SqliteWebMessageStore;
  let storage: SqlitePlatformStorage;
  let api: SqlitePlatformWebApiAdapter;

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    // Seed Alice and Bob
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('alice', 'alice', 'hash'), ('bob', 'bob', 'hash')").run();
    db.prepare("INSERT INTO spaces (id, user_id, name, folder) VALUES ('spc_alice', 'alice', 'Alice Space', 'alice-folder'), ('spc_bob', 'bob', 'Bob Space', 'bob-folder')").run();
    db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode) VALUES ('ses_alice_1', 'alice', 'spc_alice', 'web', 'acc', 'ses_alice_1', 'peer', 'dsh_alice_1', 'container'), ('ses_bob_1', 'bob', 'spc_bob', 'web', 'acc', 'ses_bob_1', 'peer', 'dsh_bob_1', 'container')").run();

    messageStore = new SqliteWebMessageStore(db);
    storage = new SqlitePlatformStorage(db);
    api = new SqlitePlatformWebApiAdapter({
      db,
      storage,
      messageStore,
    });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  it('inserts batch events and returns incremental polling cursor', async () => {
    const streamId = 'msgstream_11112222333344445555666677778888';

    // Batch 1: delta 1 and thinking
    await messageStore.insertEventsBatch([
      {
        id: 'evt_00000000000000000000000000000001',
        sessionId: 'ses_alice_1',
        userId: 'alice',
        type: 'thinking',
        payload: { streamId, status: 'thinking' },
        createdAt: '2026-08-28T10:00:00.000Z',
      },
      {
        id: 'evt_00000000000000000000000000000002',
        sessionId: 'ses_alice_1',
        userId: 'alice',
        type: 'assistant_delta',
        payload: { streamId, delta: 'First chunk. ', accumulatedLength: 13 },
        createdAt: '2026-08-28T10:00:00.020Z',
      },
    ]);

    const poll1 = await api.pollEvents('alice', 'ses_alice_1');
    expect(poll1.events.length).toBe(2);
    expect(poll1.events[0].type).toBe('thinking');
    expect(poll1.events[1].type).toBe('assistant_delta');
    expect((poll1.events[1] as any).delta).toBe('First chunk. ');
    expect((poll1.events[1] as any).accumulatedLength).toBe(13);
    expect(poll1.nextCursor).toBeDefined();

    // Batch 2: delta 2, tool_status, and stream_end
    await messageStore.insertEventsBatch([
      {
        id: 'evt_00000000000000000000000000000003',
        sessionId: 'ses_alice_1',
        userId: 'alice',
        type: 'tool_status',
        payload: { toolName: 'read', status: 'started' },
        createdAt: '2026-08-28T10:00:00.040Z',
      },
      {
        id: 'evt_00000000000000000000000000000004',
        sessionId: 'ses_alice_1',
        userId: 'alice',
        type: 'assistant_delta',
        payload: { streamId, delta: 'Second chunk.', accumulatedLength: 26 },
        createdAt: '2026-08-28T10:00:00.060Z',
      },
      {
        id: 'evt_00000000000000000000000000000005',
        sessionId: 'ses_alice_1',
        userId: 'alice',
        type: 'assistant_stream_end',
        payload: { streamId },
        createdAt: '2026-08-28T10:00:00.080Z',
      },
    ]);

    // Poll with cursor from poll1
    const poll2 = await api.pollEvents('alice', 'ses_alice_1', poll1.nextCursor!);
    expect(poll2.events.length).toBe(3);
    expect(poll2.events[0].type).toBe('tool_status');
    expect(poll2.events[1].type).toBe('assistant_delta');
    expect((poll2.events[1] as any).delta).toBe('Second chunk.');
    expect(poll2.events[2].type).toBe('assistant_stream_end');

    // Poll again with latest cursor -> 0 new events
    const poll3 = await api.pollEvents('alice', 'ses_alice_1', poll2.nextCursor!);
    expect(poll3.events.length).toBe(0);
  });

  it('enforces strict tenant isolation: Alice events never leak to Bob', async () => {
    // Insert event for Alice
    await messageStore.insertEvent({
      sessionId: 'ses_alice_1',
      userId: 'alice',
      type: 'assistant_delta',
      payload: {
        streamId: 'msgstream_alice_secret',
        delta: 'Alice private stream',
        accumulatedLength: 20,
      },
      createdAt: '2026-08-28T10:00:00.000Z',
    });

    // Insert event for Bob
    await messageStore.insertEvent({
      sessionId: 'ses_bob_1',
      userId: 'bob',
      type: 'assistant_delta',
      payload: {
        streamId: 'msgstream_bob_secret',
        delta: 'Bob private stream',
        accumulatedLength: 18,
      },
      createdAt: '2026-08-28T10:00:00.000Z',
    });

    // Alice polls her session
    const aliceEvents = await api.pollEvents('alice', 'ses_alice_1');
    expect(aliceEvents.events.length).toBe(1);
    expect((aliceEvents.events[0] as any).delta).toBe('Alice private stream');

    // Bob polls his session
    const bobEvents = await api.pollEvents('bob', 'ses_bob_1');
    expect(bobEvents.events.length).toBe(1);
    expect((bobEvents.events[0] as any).delta).toBe('Bob private stream');

    // Bob attempting to poll Alice session throws 403 / TenantAccessDenied
    await expect(api.pollEvents('bob', 'ses_alice_1')).rejects.toThrow();

    // Alice attempting to poll Bob session throws 403 / TenantAccessDenied
    await expect(api.pollEvents('alice', 'ses_bob_1')).rejects.toThrow();
  });
});
