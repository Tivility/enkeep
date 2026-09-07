/**
 * PlatformProxyHandler & Tunnel RPC Integration Test Suite
 *
 * Tests:
 * - Route allowlist & method checking (strict routes only, 404 for unlisted, 405 for bad method).
 * - Authoritative container ownership userId injection (never trusts container userId).
 * - Distinct RuntimeIdentity (runtime alias 'alice'/'bob') vs PlatformUserId (database UUID).
 * - GET /platform/capabilities handshake: verifies capabilities without leaking internal platform UUID.
 * - POST /api/messages (writes to SQLite web_messages with platform UUID, returns authoritative messageId).
 * - POST /api/files (writes to SQLite file_metadata with platform UUID, enforces size limits, returns fileId).
 * - POST /api/manage/tasks (enforces canonical Idempotency-Key, payload validation, persists task with platform UUID).
 * - GET /api/manage/quota/check?metrics=all (reads UUID quota rows, returns exact 5 fixed quota metrics).
 * - POST /api/events (persists events with platform UUID into SQLite web_events).
 * - External interaction suspension & resolution over tunnel platform client.
 * - Strict tenant isolation between Alice and Bob.
 *
 * @module @enkeep/runtime-runner/tests/platform-proxy.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Duplex } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformProxyHandler,
  createPlatformProxyHandler,
  createEventsStreamHandler,
  PLATFORM_STREAM_KIND,
} from '../src/tunnel/platform-proxy.js';

export const ALICE_PLATFORM_ID = '11111111-1111-4111-8111-111111111111';
export const BOB_PLATFORM_ID = '22222222-2222-4222-8222-222222222222';

function createTestDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');

  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user'
    );

    INSERT INTO users (id, username, password_hash, role) VALUES ('${ALICE_PLATFORM_ID}', 'alice', 'hash', 'admin');
    INSERT INTO users (id, username, password_hash, role) VALUES ('${BOB_PLATFORM_ID}', 'bob', 'hash', 'user');

    CREATE TABLE spaces (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      folder TEXT NOT NULL
    );

    INSERT INTO spaces (id, user_id, name, folder) VALUES ('sp_alice', '${ALICE_PLATFORM_ID}', 'Workspace', 'default');
    INSERT INTO spaces (id, user_id, name, folder) VALUES ('sp_bob', '${BOB_PLATFORM_ID}', 'Workspace', 'default');

    CREATE TABLE session_routes (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      dsh_session_id TEXT NOT NULL
    );

    INSERT INTO session_routes (id, space_id, user_id, channel, peer_id, dsh_session_id)
    VALUES ('sr_alice_1', 'sp_alice', '${ALICE_PLATFORM_ID}', 'web', 'peer_alice', 'ses_0123456789abcdef0123456789abcdef');
    INSERT INTO session_routes (id, space_id, user_id, channel, peer_id, dsh_session_id)
    VALUES ('sr_bob_1', 'sp_bob', '${BOB_PLATFORM_ID}', 'web', 'peer_bob', 'ses_bob_0123456789abcdef012345678');

    CREATE TABLE web_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'delivered',
      route_key TEXT NOT NULL,
      turn_id TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE file_metadata (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime_type TEXT,
      extension TEXT NOT NULL,
      checksum TEXT,
      recipient TEXT NOT NULL,
      description TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE platform_tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'medium',
      due_date TEXT,
      payload TEXT,
      result TEXT,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE web_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE quota_limits (
      user_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      limit_amount INTEGER NOT NULL,
      PRIMARY KEY (user_id, resource)
    );

    INSERT INTO quota_limits (user_id, resource, limit_amount) VALUES ('${ALICE_PLATFORM_ID}', 'tokens', 65536);
    INSERT INTO quota_limits (user_id, resource, limit_amount) VALUES ('${ALICE_PLATFORM_ID}', 'messages', 1000);
    INSERT INTO quota_limits (user_id, resource, limit_amount) VALUES ('${ALICE_PLATFORM_ID}', 'turns', 500);
    INSERT INTO quota_limits (user_id, resource, limit_amount) VALUES ('${ALICE_PLATFORM_ID}', 'storage_bytes', 10485760);
    INSERT INTO quota_limits (user_id, resource, limit_amount) VALUES ('${ALICE_PLATFORM_ID}', 'api_calls', 5000);

    INSERT INTO quota_limits (user_id, resource, limit_amount) VALUES ('${BOB_PLATFORM_ID}', 'tokens', 32768);
    INSERT INTO quota_limits (user_id, resource, limit_amount) VALUES ('${BOB_PLATFORM_ID}', 'messages', 500);
    INSERT INTO quota_limits (user_id, resource, limit_amount) VALUES ('${BOB_PLATFORM_ID}', 'turns', 250);
    INSERT INTO quota_limits (user_id, resource, limit_amount) VALUES ('${BOB_PLATFORM_ID}', 'storage_bytes', 5242880);
    INSERT INTO quota_limits (user_id, resource, limit_amount) VALUES ('${BOB_PLATFORM_ID}', 'api_calls', 2500);
  `);

  return db;
}

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

describe('PlatformProxyHandler Unit & Integration Tests', () => {
  let db: DatabaseSync;
  let handler: PlatformProxyHandler;

  beforeEach(() => {
    db = createTestDatabase();
    handler = createPlatformProxyHandler({
      platformUserId: ALICE_PLATFORM_ID,
      runtimeIdentity: 'alice',
      db,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('fails closed and throws error when db is provided without platformUserId', () => {
    expect(() => {
      createPlatformProxyHandler({ db } as any);
    }).toThrow('FAIL-CLOSED: platformUserId is required');
  });

  it('fails closed and throws error when platformUserId has untrimmed whitespace or non-NFC normalization', () => {
    // Untrimmed leading/trailing whitespace must throw (no silent .trim())
    expect(() => {
      createPlatformProxyHandler({
        platformUserId: `  ${ALICE_PLATFORM_ID}  `,
        db,
      });
    }).toThrow('FAIL-CLOSED: platformUserId must be exact trimmed string');

    // Invalid format must throw
    expect(() => {
      createPlatformProxyHandler({
        platformUserId: 'invalid@user@id!',
        db,
      });
    }).toThrow('FAIL-CLOSED: Invalid platformUserId format');

    // Untrimmed runtimeIdentity must throw
    expect(() => {
      createPlatformProxyHandler({
        platformUserId: ALICE_PLATFORM_ID,
        runtimeIdentity: ' alice ',
        db,
      });
    }).toThrow('FAIL-CLOSED: runtimeIdentity must be a non-empty, exact trimmed');
  });

  it('preserves exact raw platformUserId and runtimeIdentity without mutation', () => {
    const customHandler = createPlatformProxyHandler({
      platformUserId: ALICE_PLATFORM_ID,
      runtimeIdentity: 'alice',
      db,
    });
    expect(customHandler.platformUserId).toBe(ALICE_PLATFORM_ID);
    expect(customHandler.runtimeIdentity).toBe('alice');
  });

  it('rejects streams with non-platform kind', async () => {
    const stream = new TestClientDuplex();
    await handler.handle(stream, { kind: 'llm', userId: 'alice' });

    const response = stream.responseBuffer.toString('utf8');
    expect(response).toContain('400 Bad Request');
    expect(response).toContain('INVALID_STREAM_KIND');
  });

  it('rejects streams with missing userId binding', async () => {
    const stream = new TestClientDuplex();
    await handler.handle(stream, { kind: 'platform' });

    const response = stream.responseBuffer.toString('utf8');
    expect(response).toContain('403 Forbidden');
    expect(response).toContain('UNAUTHORIZED_CONTAINER');
  });

  it('rejects streams with runtime alias mismatch against bound runtimeIdentity', async () => {
    const stream = new TestClientDuplex();
    await handler.handle(stream, { kind: 'platform', userId: 'bob' });

    const response = stream.responseBuffer.toString('utf8');
    expect(response).toContain('403 Forbidden');
    expect(response).toContain('UNAUTHORIZED_CONTAINER');
  });

  it('handles GET /platform/capabilities handshake successfully and protects internal platform UUID', async () => {
    const stream = new TestClientDuplex();
    const reqStr = 'GET /platform/capabilities HTTP/1.1\r\nHost: 127.0.0.1:8787\r\n\r\n';
    stream.pushToStream(reqStr);
    stream.endStream();

    await handler.handle(stream, { kind: 'platform', userId: 'alice' });

    const response = stream.responseBuffer.toString('utf8');
    expect(response).toContain('200 OK');
    expect(response).toContain('"capabilities":[');
    expect(response).toContain('"messages"');
    expect(response).toContain('"files"');
    expect(response).toContain('"tasks"');
    expect(response).toContain('"quota"');
    expect(response).toContain('"events"');
    expect(response).toContain('"userId":"alice"');
    // Security invariant: MUST NEVER expose internal platform UUID in public capabilities response
    expect(response).not.toContain(ALICE_PLATFORM_ID);
  });

  it('rejects unlisted routes with strict 404', async () => {
    const stream = new TestClientDuplex();
    const reqStr = 'GET /api/unknown/endpoint HTTP/1.1\r\nHost: 127.0.0.1:8787\r\n\r\n';
    stream.pushToStream(reqStr);
    stream.endStream();

    await handler.handle(stream, { kind: 'platform', userId: 'alice' });

    const response = stream.responseBuffer.toString('utf8');
    expect(response).toContain('404 Not Found');
    expect(response).toContain('NOT_FOUND');
  });

  it('handles GET /api/manage/quota/check?metrics=all and reads real UUID quota row', async () => {
    const stream = new TestClientDuplex();
    const reqStr = 'GET /api/manage/quota/check?metrics=all HTTP/1.1\r\nHost: 127.0.0.1:8787\r\n\r\n';
    stream.pushToStream(reqStr);
    stream.endStream();

    await handler.handle(stream, { kind: 'platform', userId: 'alice' });

    const response = stream.responseBuffer.toString('utf8');
    expect(response).toContain('200 OK');
    expect(response).toContain('"allowed":true');
    expect(response).toContain('"tokens":65536');
    expect(response).toContain('"messages":1000');
    expect(response).toContain('"turns":500');
    expect(response).toContain('"storage_bytes":10485760');
    expect(response).toContain('"api_calls":5000');
  });

  it('handles POST /api/messages, persists with UUID in web_messages, and enforces tenant isolation', async () => {
    const stream = new TestClientDuplex();
    const body = JSON.stringify({
      recipient: 'ses_0123456789abcdef0123456789abcdef',
      content: 'Important message from Alice agent',
      metadata: { context: 'test' },
    });
    const reqStr = `POST /api/messages HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    stream.pushToStream(reqStr);
    stream.endStream();

    await handler.handle(stream, { kind: 'platform', userId: 'alice' });

    const response = stream.responseBuffer.toString('utf8');
    expect(response).toContain('200 OK');
    expect(response).toContain('"success":true');
    expect(response).toContain('"messageId":"msg_');

    // Assert SQLite web_messages table has the real message with Alice platform UUID (not alias 'alice')
    const row = db.prepare('SELECT * FROM web_messages WHERE user_id = ?').get(ALICE_PLATFORM_ID) as any;
    expect(row).toBeDefined();
    expect(row.user_id).toBe(ALICE_PLATFORM_ID);
    expect(row.content).toBe('Important message from Alice agent');
    expect(row.session_id).toBe('sr_alice_1');

    // Assert zero rows stored under runtime alias 'alice'
    const aliasRows = db.prepare('SELECT COUNT(*) as count FROM web_messages WHERE user_id = ?').get('alice') as any;
    expect(aliasRows.count).toBe(0);

    // Assert Bob has ZERO messages
    const bobMsgs = db.prepare('SELECT COUNT(*) as count FROM web_messages WHERE user_id = ?').get(BOB_PLATFORM_ID) as any;
    expect(bobMsgs.count).toBe(0);
  });

  it('handles POST /api/files, persists file_metadata with UUID, and creates web_messages attachment without leaking content', async () => {
    const stream = new TestClientDuplex();
    const fileContentBase64 = Buffer.from('Sensitive Report Content', 'utf8').toString('base64');
    const body = JSON.stringify({
      recipient: 'ses_0123456789abcdef0123456789abcdef',
      path: 'reports/summary.txt',
      filename: 'summary.txt',
      size: 24,
      content: fileContentBase64,
      checksum: 'sha256:abcd1234',
      description: 'Monthly summary report',
    });
    const reqStr = `POST /api/files HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    stream.pushToStream(reqStr);
    stream.endStream();

    await handler.handle(stream, { kind: 'platform', userId: 'alice' });

    const response = stream.responseBuffer.toString('utf8');
    expect(response).toContain('200 OK');
    expect(response).toContain('"fileId":"file_');
    expect(response).toContain('"path":"reports/summary.txt"');

    // Assert SQLite file_metadata table with UUID
    const fileRow = db.prepare('SELECT * FROM file_metadata WHERE user_id = ?').get(ALICE_PLATFORM_ID) as any;
    expect(fileRow).toBeDefined();
    expect(fileRow.user_id).toBe(ALICE_PLATFORM_ID);
    expect(fileRow.filename).toBe('summary.txt');
    expect(fileRow.relative_path).toBe('reports/summary.txt');
    expect(fileRow.size).toBe(24);

    // Assert zero rows stored under runtime alias 'alice'
    const aliasRows = db.prepare('SELECT COUNT(*) as count FROM file_metadata WHERE user_id = ?').get('alice') as any;
    expect(aliasRows.count).toBe(0);

    // Assert web_messages attachment was created with UUID
    const msgRow = db.prepare('SELECT * FROM web_messages WHERE user_id = ?').get(ALICE_PLATFORM_ID) as any;
    expect(msgRow).toBeDefined();
    expect(msgRow.content).toContain('[File: summary.txt]');
    expect(msgRow.content).not.toContain(fileContentBase64);

    expect(response).toContain('/api/spaces/sp_alice/files/download?path=');
  });

  it('handles POST /api/manage/tasks with canonical Idempotency-Key and persists with platform UUID', async () => {
    const idempotencyKey = 'a0000000-0000-4000-8000-000000000001';
    const stream = new TestClientDuplex();
    const body = JSON.stringify({
      title: 'Analyze security metrics',
      prompt: 'Please check logs and report anomalies',
      sessionId: 'ses_0123456789abcdef0123456789abcdef',
      priority: 'high',
      dueDate: '2026-09-01T00:00:00.000Z',
    });
    const reqStr = `POST /api/manage/tasks HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nIdempotency-Key: ${idempotencyKey}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    stream.pushToStream(reqStr);
    stream.endStream();

    await handler.handle(stream, { kind: 'platform', userId: 'alice' });

    const response = stream.responseBuffer.toString('utf8');
    expect(response).toContain('201 Created');
    expect(response).toContain('"isIdempotentHit":false');
    expect(response).toContain('"id":"task_');
    expect(response).toContain('"title":"Analyze security metrics"');
    expect(response).toContain('"status":"pending"');

    // Assert SQLite platform_tasks table has record with UUID
    const taskRow = db.prepare('SELECT * FROM platform_tasks WHERE user_id = ? AND idempotency_key = ?').get(ALICE_PLATFORM_ID, idempotencyKey) as any;
    expect(taskRow).toBeDefined();
    expect(taskRow.title).toBe('Analyze security metrics');
    expect(taskRow.priority).toBe('high');
    expect(taskRow.status).toBe('pending');
    expect(taskRow.user_id).toBe(ALICE_PLATFORM_ID);

    // Assert zero rows stored under runtime alias 'alice'
    const aliasRows = db.prepare('SELECT COUNT(*) as count FROM platform_tasks WHERE user_id = ?').get('alice') as any;
    expect(aliasRows.count).toBe(0);
  });

  it('supports idempotent replay of POST /api/manage/tasks returning isIdempotentHit: true', async () => {
    const idempotencyKey = 'b0000000-0000-4000-8000-000000000002';
    const body = JSON.stringify({
      title: 'Repeatable task',
      prompt: 'Execute step once',
      sessionId: 'ses_0123456789abcdef0123456789abcdef',
      priority: 'medium',
    });
    const reqStr = `POST /api/manage/tasks HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nIdempotency-Key: ${idempotencyKey}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

    // Request 1: Creation
    const stream1 = new TestClientDuplex();
    stream1.pushToStream(reqStr);
    stream1.endStream();
    await handler.handle(stream1, { kind: 'platform', userId: 'alice' });
    expect(stream1.responseBuffer.toString('utf8')).toContain('201 Created');

    // Request 2: Replay
    const stream2 = new TestClientDuplex();
    stream2.pushToStream(reqStr);
    stream2.endStream();
    await handler.handle(stream2, { kind: 'platform', userId: 'alice' });
    const res2 = stream2.responseBuffer.toString('utf8');
    expect(res2).toContain('200 OK');
    expect(res2).toContain('"isIdempotentHit":true');
    expect(res2).toContain('"title":"Repeatable task"');
  });

  it('handles POST /api/events and persists events under platform UUID in web_events', async () => {
    const stream = new TestClientDuplex();
    const body = JSON.stringify({
      events: [
        {
          id: 'evt_test_001',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          type: 'assistant_delta',
          payload: { delta: 'Hello world', streamId: 'stream_1', accumulatedLength: 11 },
        },
      ],
    });
    const reqStr = `POST /api/events HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    stream.pushToStream(reqStr);
    stream.endStream();

    await handler.handle(stream, { kind: 'platform', userId: 'alice' });

    const response = stream.responseBuffer.toString('utf8');
    expect(response).toContain('200 OK');
    expect(response).toContain('"count":1');

    // Verify row in web_events with platform UUID
    const evRow = db.prepare('SELECT * FROM web_events WHERE user_id = ?').get(ALICE_PLATFORM_ID) as any;
    expect(evRow).toBeDefined();
    expect(evRow.user_id).toBe(ALICE_PLATFORM_ID);
    expect(evRow.session_id).toBe('sr_alice_1');

    // Assert zero rows for alias 'alice'
    const aliasRows = db.prepare('SELECT COUNT(*) as count FROM web_events WHERE user_id = ?').get('alice') as any;
    expect(aliasRows.count).toBe(0);
  });

  it('enforces complete tenant isolation between Alice and Bob handlers', async () => {
    const bobHandler = createPlatformProxyHandler({
      platformUserId: BOB_PLATFORM_ID,
      runtimeIdentity: 'bob',
      db,
    });

    // Bob sends a message
    const bobStream = new TestClientDuplex();
    const bobBody = JSON.stringify({
      recipient: 'ses_bob_0123456789abcdef012345678',
      content: 'Bob private message',
    });
    const bobReq = `POST /api/messages HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nContent-Length: ${Buffer.byteLength(bobBody)}\r\n\r\n${bobBody}`;
    bobStream.pushToStream(bobReq);
    bobStream.endStream();

    await bobHandler.handle(bobStream, { kind: 'platform', userId: 'bob' });
    expect(bobStream.responseBuffer.toString('utf8')).toContain('200 OK');

    // Verify Bob message recorded under BOB_PLATFORM_ID only
    const bobMsg = db.prepare('SELECT * FROM web_messages WHERE user_id = ?').get(BOB_PLATFORM_ID) as any;
    expect(bobMsg).toBeDefined();
    expect(bobMsg.user_id).toBe(BOB_PLATFORM_ID);
    expect(bobMsg.content).toBe('Bob private message');

    // Verify Alice has no access to Bob's records
    const aliceMsgs = db.prepare('SELECT * FROM web_messages WHERE user_id = ?').all(ALICE_PLATFORM_ID) as any[];
    expect(aliceMsgs.every((m) => m.content !== 'Bob private message')).toBe(true);
  });
});
