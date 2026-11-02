/**
 * Re-sent event frames are stored once.
 *
 * The event relay re-queues a batch when its POST times out, but the platform may already have stored
 * it. Frames carry the id they were first sent with; a frame whose id is already stored is skipped and
 * does not fire completion side effects again. Synthetic data only per AGENTS.md.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Duplex } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { PlatformProxyHandler, createPlatformProxyHandler } from '../src/tunnel/platform-proxy.js';

const ALICE = '11111111-1111-4111-8111-111111111111';

class TestClientDuplex extends Duplex {
  public responseBuffer = Buffer.alloc(0);
  _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.responseBuffer = Buffer.concat([this.responseBuffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)]);
    callback();
  }
  _read(): void {}
}

function createDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL);
    INSERT INTO users VALUES ('${ALICE}', 'alice');
    CREATE TABLE session_routes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, dsh_session_id TEXT NOT NULL);
    INSERT INTO session_routes VALUES ('sr_alice_root', '${ALICE}', 'ses_alice_root_001');
    CREATE TABLE web_events (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_id TEXT NOT NULL,
      type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  return db;
}

async function post(handler: PlatformProxyHandler, events: unknown[]): Promise<any> {
  const stream = new TestClientDuplex();
  const body = JSON.stringify({ events });
  stream.push(Buffer.from(`POST /api/events HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
  stream.push(null);
  await handler.handle(stream, { kind: 'platform', userId: 'alice' });
  const raw = stream.responseBuffer.toString('utf8');
  return JSON.parse(raw.slice(raw.indexOf('\r\n\r\n') + 4));
}

describe('PlatformProxyHandler event ingestion is idempotent per frame id', () => {
  let db: DatabaseSync;
  let completed: ReturnType<typeof vi.fn>;
  let handler: PlatformProxyHandler;

  beforeEach(() => {
    db = createDb();
    completed = vi.fn();
    handler = createPlatformProxyHandler({ platformUserId: ALICE, runtimeIdentity: 'alice', db, onAutonomousTurnCompleted: completed } as any);
  });
  afterEach(() => db.close());

  const batch = [
    { id: 'evt_00000000000a00000000000000000001', sessionId: 'sr_alice_root', type: 'turn_started', turnId: 'turn_auto_x_1', originTurnId: 'turn_origin_1', causeChildId: 'child-1', payload: {}, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'evt_00000000000a00000000000000000002', sessionId: 'sr_alice_root', type: 'assistant_delta', turnId: 'turn_auto_x_1', payload: { delta: 'hello', streamId: 's1', accumulatedLength: 5 }, createdAt: '2026-01-01T00:00:00.001Z' },
    { id: 'evt_00000000000a00000000000000000003', sessionId: 'sr_alice_root', type: 'turn_completed', turnId: 'turn_auto_x_1', originTurnId: 'turn_origin_1', causeChildId: 'child-1', payload: { status: 'completed' }, createdAt: '2026-01-01T00:00:00.002Z' },
  ];

  it('stores a re-sent batch once and reports completion once', async () => {
    const first = await post(handler, batch);
    expect(first.count).toBe(3);
    const again = await post(handler, batch);
    expect(again.success).toBe(true);
    expect(again.count).toBe(0);

    const rows = db.prepare('SELECT id, type FROM web_events ORDER BY rowid').all() as Array<{ id: string; type: string }>;
    expect(rows.map((r) => r.id)).toEqual(batch.map((e) => e.id));
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0][0]).toMatchObject({ turnId: 'turn_auto_x_1', originTurnId: 'turn_origin_1', causeChildId: 'child-1' });
  });

  it('keeps the first stored payload when a frame id is reused', async () => {
    await post(handler, [batch[1]]);
    await post(handler, [{ ...batch[1], payload: { delta: 'changed', streamId: 's1', accumulatedLength: 7 } }]);
    const row = db.prepare('SELECT payload FROM web_events WHERE id = ?').get(batch[1].id) as { payload: string };
    expect(JSON.parse(row.payload).delta).toBe('hello');
  });
});
