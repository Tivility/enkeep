/**
 * PlatformProxyHandler Descendant Events Drop Tests (Item A Correction)
 *
 * Verifies that:
 * 1. Child / descendant session event frames are DROPPED per-frame instead of remapping to parent route.
 * 2. SQLite foreign key constraints (PRAGMA foreign_keys = ON) are satisfied because unmapped frames are never inserted.
 * 3. Dropping is accompanied by a rate-limited warning (once per session id per minute).
 * 4. Mixed batches persist parent frames while dropping child/unmapped frames without failing the batch (no 500).
 * 5. Tenant isolation ensures session routes of other users cannot be targeted.
 *
 * Synthetic data only per AGENTS.md.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Duplex } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformProxyHandler,
  createPlatformProxyHandler,
  DescendantResolver,
} from '../src/tunnel/platform-proxy.js';

const ALICE_PLATFORM_ID = '11111111-1111-4111-8111-111111111111';
const BOB_PLATFORM_ID = '22222222-2222-4222-8222-222222222222';

class TestClientDuplex extends Duplex {
  public responseBuffer = Buffer.alloc(0);

  _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.responseBuffer = Buffer.concat([this.responseBuffer, buf]);
    callback();
  }

  _read(_size: number): void {}

  pushToStream(data: string | Buffer): void {
    this.push(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  }

  endStream(): void {
    this.push(null);
  }
}

function createStrictTestDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user'
    );

    INSERT INTO users (id, username, password_hash, role) VALUES ('${ALICE_PLATFORM_ID}', 'alice', 'hash', 'admin');
    INSERT INTO users (id, username, password_hash, role) VALUES ('${BOB_PLATFORM_ID}', 'bob', 'hash', 'user');

    CREATE TABLE spaces (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      folder TEXT NOT NULL
    );

    INSERT INTO spaces (id, user_id, name, folder) VALUES ('sp_alice', '${ALICE_PLATFORM_ID}', 'Workspace', 'default');
    INSERT INTO spaces (id, user_id, name, folder) VALUES ('sp_bob', '${BOB_PLATFORM_ID}', 'Workspace', 'default');

    CREATE TABLE session_routes (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      dsh_session_id TEXT NOT NULL
    );

    INSERT INTO session_routes (id, space_id, user_id, channel, peer_id, dsh_session_id)
    VALUES ('sr_alice_root', 'sp_alice', '${ALICE_PLATFORM_ID}', 'web', 'peer_alice', 'ses_alice_root_001');

    INSERT INTO session_routes (id, space_id, user_id, channel, peer_id, dsh_session_id)
    VALUES ('sr_bob_root', 'sp_bob', '${BOB_PLATFORM_ID}', 'web', 'peer_bob', 'ses_bob_root_001');

    CREATE TABLE web_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );
  `);

  return db;
}

async function sendEventsRequest(
  handler: PlatformProxyHandler,
  events: unknown[],
  userId: string = 'alice'
): Promise<{ status: number; body: any }> {
  const stream = new TestClientDuplex();
  const body = JSON.stringify({ events });
  const reqStr = `POST /api/events HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  stream.pushToStream(reqStr);
  stream.endStream();

  await handler.handle(stream, { kind: 'platform', userId });

  const raw = stream.responseBuffer.toString('utf8');
  const headerEndIndex = raw.indexOf('\r\n\r\n');
  if (headerEndIndex === -1) {
    return { status: 0, body: null };
  }
  const statusMatch = raw.slice(0, headerEndIndex).split('\r\n')[0].match(/HTTP\/1\.[01]\s+(\d+)/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
  let parsedBody: any = null;
  try {
    parsedBody = JSON.parse(raw.slice(headerEndIndex + 4));
  } catch {}

  return { status, body: parsedBody };
}

describe('Item A: PlatformProxyHandler Unmapped and Descendant Events Dropping', () => {
  let db: DatabaseSync;
  let descendantResolver: DescendantResolver;
  let handler: PlatformProxyHandler;

  beforeEach(() => {
    db = createStrictTestDatabase();
    descendantResolver = new DescendantResolver();
    handler = createPlatformProxyHandler({
      platformUserId: ALICE_PLATFORM_ID,
      runtimeIdentity: 'alice',
      db,
      descendantResolver,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('drops child session event frame per-frame instead of remapping to parent route', async () => {
    const childSessionId = 'ses_child_subagent_001';

    // Even if registered in descendantResolver, event frame must be dropped
    descendantResolver.register({
      childSessionId,
      parentSessionId: 'sr_alice_root',
      spaceId: 'sp_alice',
      platformUserId: ALICE_PLATFORM_ID,
    });

    const res = await sendEventsRequest(handler, [
      {
        id: 'evt_child_001',
        sessionId: childSessionId,
        type: 'assistant_delta',
        payload: { delta: 'Subagent reply delta', streamId: 'stream_child_1' },
      },
    ]);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(0);

    // Verify row was NOT persisted in web_events
    const row = db.prepare('SELECT * FROM web_events WHERE id = ?').get('evt_child_001');
    expect(row).toBeUndefined();
  });

  it('drops unmapped session event frame and applies rate-limited warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const unknownSessionId1 = 'ses_completely_unmapped_001';
    const unknownSessionId2 = 'ses_completely_unmapped_002';

    const res = await sendEventsRequest(handler, [
      {
        id: 'evt_unknown_001',
        sessionId: unknownSessionId1,
        type: 'assistant_delta',
        payload: { delta: 'Orphan event 1' },
      },
      {
        id: 'evt_unknown_002',
        sessionId: unknownSessionId1, // Same session ID in same batch
        type: 'assistant_delta',
        payload: { delta: 'Orphan event 2' },
      },
      {
        id: 'evt_unknown_003',
        sessionId: unknownSessionId2, // Different session ID
        type: 'assistant_delta',
        payload: { delta: 'Orphan event 3' },
      },
    ]);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(0);

    // Verify no row in web_events
    const countRow = db.prepare('SELECT COUNT(*) as cnt FROM web_events').get() as any;
    expect(countRow.cnt).toBe(0);

    // Warn should be logged once for unknownSessionId1 (rate-limited) and once for unknownSessionId2
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenNthCalledWith(
      1,
      '[platform-proxy] Dropping event frame for unmapped session',
      expect.objectContaining({ sessionId: unknownSessionId1 })
    );
    expect(warnSpy).toHaveBeenNthCalledWith(
      2,
      '[platform-proxy] Dropping event frame for unmapped session',
      expect.objectContaining({ sessionId: unknownSessionId2 })
    );

    warnSpy.mockRestore();
  });

  it('handles mixed batch: persists parent frames and drops child / unmapped frames without 500 error', async () => {
    const childSessionId = 'ses_child_subagent_002';
    descendantResolver.register({
      childSessionId,
      parentSessionId: 'sr_alice_root',
      spaceId: 'sp_alice',
      platformUserId: ALICE_PLATFORM_ID,
    });

    const res = await sendEventsRequest(handler, [
      {
        id: 'evt_parent_001',
        sessionId: 'ses_alice_root_001', // direct dsh_session_id
        type: 'turn_started',
        payload: {},
      },
      {
        id: 'evt_child_001',
        sessionId: childSessionId, // child session -> dropped
        type: 'assistant_delta',
        payload: { delta: 'Child text' },
      },
      {
        id: 'evt_unmapped_001',
        sessionId: 'ses_nonexistent_999', // unmapped -> dropped
        type: 'assistant_delta',
        payload: { delta: 'Ignored' },
      },
      {
        id: 'evt_parent_002',
        sessionId: 'sr_alice_root', // direct route id
        type: 'turn_completed',
        payload: {},
      },
    ]);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(2);

    const rows = db.prepare('SELECT id, session_id FROM web_events ORDER BY id ASC').all() as any[];
    expect(rows.length).toBe(2);
    expect(rows[0].id).toBe('evt_parent_001');
    expect(rows[0].session_id).toBe('sr_alice_root');
    expect(rows[1].id).toBe('evt_parent_002');
    expect(rows[1].session_id).toBe('sr_alice_root');
  });

  it('drops multi-level descendant hierarchy frames per-frame', async () => {
    const childSessionId = 'ses_child_depth_1';
    const grandChildSessionId = 'ses_child_depth_2';

    descendantResolver.register({
      childSessionId,
      parentSessionId: 'sr_alice_root',
      spaceId: 'sp_alice',
      platformUserId: ALICE_PLATFORM_ID,
    });

    descendantResolver.register({
      childSessionId: grandChildSessionId,
      parentSessionId: childSessionId,
      spaceId: 'sp_alice',
      platformUserId: ALICE_PLATFORM_ID,
    });

    const res = await sendEventsRequest(handler, [
      {
        id: 'evt_grandchild_001',
        sessionId: grandChildSessionId,
        type: 'turn_completed',
        payload: {},
      },
    ]);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);

    const row = db.prepare('SELECT * FROM web_events WHERE id = ?').get('evt_grandchild_001');
    expect(row).toBeUndefined();
  });

  it('enforces tenant isolation: Bob cannot map or persist events to Alice session route', async () => {
    // Bob handler
    const bobHandler = createPlatformProxyHandler({
      platformUserId: BOB_PLATFORM_ID,
      runtimeIdentity: 'bob',
      db,
      descendantResolver,
    });

    const res = await sendEventsRequest(
      bobHandler,
      [
        {
          id: 'evt_bob_spoofed',
          sessionId: 'sr_alice_root',
          type: 'assistant_delta',
          payload: { delta: 'Spoof attempt' },
        },
      ],
      'bob'
    );

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);

    const countRow = db.prepare('SELECT COUNT(*) as cnt FROM web_events WHERE user_id = ?').get(BOB_PLATFORM_ID) as any;
    expect(countRow.cnt).toBe(0);
  });
});
