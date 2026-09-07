import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Duplex } from 'node:stream';
import {
  PlatformProxyHandler,
  createEventsStreamHandler,
} from '../src/tunnel/platform-proxy.js';

class TestClientDuplex extends Duplex {
  public responseBuffer = Buffer.alloc(0);

  _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.responseBuffer = Buffer.concat([this.responseBuffer, buf]);
    callback();
  }

  _read(): void {}

  pushToStream(data: string | Buffer): void {
    this.push(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  }

  endStream(): void {
    this.push(null);
  }
}

export const ALICE_PLATFORM_ID = '44444444-4444-4444-8444-444444444444';

describe('Streaming Events Transport via PlatformProxyHandler & EventsStreamHandler', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE TABLE spaces (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE TABLE session_routes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        space_id TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'web',
        dsh_session_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE TABLE web_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
    `);

    db.prepare(`INSERT INTO users (id, username) VALUES ('${ALICE_PLATFORM_ID}', 'alice')`).run();
    db.prepare(`INSERT INTO spaces (id, user_id, name) VALUES ('spc_1', '${ALICE_PLATFORM_ID}', 'Main')`).run();
    db.prepare(`INSERT INTO session_routes (id, user_id, space_id, dsh_session_id) VALUES ('ses_1', '${ALICE_PLATFORM_ID}', 'spc_1', 'dsh_ses_1')`).run();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  it('ingests batched streaming events from container and persists sanitized records in web_events', async () => {
    const handler = new PlatformProxyHandler({
      platformUserId: ALICE_PLATFORM_ID,
      runtimeIdentity: 'alice',
      db,
    });
    const stream = new TestClientDuplex();

    const eventsPayload = {
      events: [
        {
          sessionId: 'ses_1',
          type: 'turn_started',
          turnId: 'turn_SECRET_INTERNAL_ID_1',
          payload: { status: 'running', internalTurnId: 'LEAK_TURN_ID' },
          createdAt: '2026-08-28T10:00:00.000Z',
        },
        {
          sessionId: 'ses_1',
          type: 'thinking_delta',
          turnId: 'turn_SECRET_INTERNAL_ID_1',
          payload: {
            streamId: 'msgstream_0123456789abcdef0123456789abcdef',
            status: 'thinking',
            rawReasoning: 'SECRET_THINKING_CONTENT_DO_NOT_LEAK',
          },
          createdAt: '2026-08-28T10:00:00.050Z',
        },
        {
          sessionId: 'ses_1',
          type: 'assistant_delta',
          turnId: 'turn_SECRET_INTERNAL_ID_1',
          payload: {
            streamId: 'msgstream_0123456789abcdef0123456789abcdef',
            delta: 'Hello, ',
            accumulatedLength: 7,
          },
          createdAt: '2026-08-28T10:00:00.100Z',
        },
        {
          sessionId: 'ses_1',
          type: 'tool_started',
          turnId: 'turn_SECRET_INTERNAL_ID_1',
          payload: {
            toolName: 'check_quota',
            arguments: '{"secret":"arg_val"}',
          },
          createdAt: '2026-08-28T10:00:00.150Z',
        },
        {
          sessionId: 'ses_1',
          type: 'tool_completed',
          turnId: 'turn_SECRET_INTERNAL_ID_1',
          payload: {
            toolName: 'check_quota',
            status: 'completed',
            result: { sensitive: 'data' },
          },
          createdAt: '2026-08-28T10:00:00.200Z',
        },
        {
          sessionId: 'ses_1',
          type: 'assistant_delta',
          turnId: 'turn_SECRET_INTERNAL_ID_1',
          payload: {
            streamId: 'msgstream_0123456789abcdef0123456789abcdef',
            delta: 'world!',
            accumulatedLength: 13,
          },
          createdAt: '2026-08-28T10:00:00.250Z',
        },
        {
          sessionId: 'ses_1',
          type: 'assistant_stream_end',
          payload: {
            streamId: 'msgstream_0123456789abcdef0123456789abcdef',
          },
          createdAt: '2026-08-28T10:00:00.300Z',
        },
        {
          sessionId: 'ses_1',
          type: 'turn_completed',
          payload: { status: 'completed' },
          createdAt: '2026-08-28T10:00:00.350Z',
        },
      ],
    };

    const bodyStr = JSON.stringify(eventsPayload);
    const httpRequest = [
      'POST /api/events HTTP/1.1',
      'Host: 127.0.0.1:8787',
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(bodyStr, 'utf8')}`,
      '',
      bodyStr,
    ].join('\r\n');

    stream.pushToStream(httpRequest);
    stream.endStream();

    await handler.handle(stream, { kind: 'platform', userId: 'alice' });

    const response = stream.responseBuffer.toString('utf8');
    expect(response).toContain('200 OK');
    expect(response).toContain('"success":true');

    // Query web_events from SQLite database
    const rows = db.prepare('SELECT id, session_id, user_id, type, payload, created_at FROM web_events WHERE user_id = ? ORDER BY created_at ASC').all(ALICE_PLATFORM_ID) as any[];
    expect(rows.length).toBe(8);

    // 1. Invariant: Strict user_id and session_id binding
    for (const r of rows) {
      expect(r.user_id).toBe(ALICE_PLATFORM_ID);
      expect(r.session_id).toBe('ses_1');
      expect(r.id).toMatch(/^evt_[0-9a-f]{32}$/);
    }

    // Assert zero rows recorded under alias 'alice'
    const aliasRows = db.prepare('SELECT COUNT(*) as count FROM web_events WHERE user_id = ?').get('alice') as any;
    expect(aliasRows.count).toBe(0);

    // 2. Invariant: NO turnId in public payload
    for (const r of rows) {
      expect(r.payload).not.toContain('turn_SECRET_INTERNAL_ID_1');
      expect(r.payload).not.toContain('LEAK_TURN_ID');
    }

    // 3. Invariant: Thinking payload has NO raw reasoning text
    const thinkingRow = rows.find((r) => r.type === 'thinking');
    expect(thinkingRow).toBeDefined();
    const thinkingPayload = JSON.parse(thinkingRow.payload);
    expect(thinkingPayload.status).toBe('thinking');
    expect(thinkingPayload.rawReasoning).toBeUndefined();
    expect(thinkingRow.payload).not.toContain('SECRET_THINKING_CONTENT_DO_NOT_LEAK');

    // 4. Invariant: Tool payload has NO arguments and NO result
    const toolStartRow = rows.find((r) => r.type === 'tool_status' && r.payload.includes('started'));
    expect(toolStartRow).toBeDefined();
    const toolStartPayload = JSON.parse(toolStartRow.payload);
    expect(toolStartPayload.toolName).toBe('check_quota');
    expect(toolStartPayload.status).toBe('started');
    expect(toolStartPayload.arguments).toBeUndefined();
    expect(toolStartRow.payload).not.toContain('secret');

    const toolEndRow = rows.find((r) => r.type === 'tool_status' && r.payload.includes('completed'));
    expect(toolEndRow).toBeDefined();
    const toolEndPayload = JSON.parse(toolEndRow.payload);
    expect(toolEndPayload.toolName).toBe('check_quota');
    expect(toolEndPayload.status).toBe('completed');
    expect(toolEndPayload.result).toBeUndefined();
    expect(toolEndRow.payload).not.toContain('sensitive');

    // 5. Invariant: assistant_delta has public streamId, delta, accumulatedLength
    const deltaRows = rows.filter((r) => r.type === 'assistant_delta');
    expect(deltaRows.length).toBe(2);

    const delta1 = JSON.parse(deltaRows[0].payload);
    expect(delta1.streamId).toBe('msgstream_0123456789abcdef0123456789abcdef');
    expect(delta1.delta).toBe('Hello, ');
    expect(delta1.accumulatedLength).toBe(7);

    const delta2 = JSON.parse(deltaRows[1].payload);
    expect(delta2.streamId).toBe('msgstream_0123456789abcdef0123456789abcdef');
    expect(delta2.delta).toBe('world!');
    expect(delta2.accumulatedLength).toBe(13);
  });

  it('works identically via EventsStreamHandler on kind: events', async () => {
    const eventsHandler = createEventsStreamHandler({
      platformUserId: ALICE_PLATFORM_ID,
      runtimeIdentity: 'alice',
      db,
    });
    expect(eventsHandler.kind).toBe('events');

    const stream = new TestClientDuplex();

    const bodyStr = JSON.stringify({
      events: [
        {
          sessionId: 'ses_1',
          type: 'assistant_delta',
          payload: {
            streamId: 'msgstream_abcdef0123456789abcdef0123456789',
            delta: 'Streaming event via kind:events',
            accumulatedLength: 31,
          },
        },
      ],
    });

    const httpRequest = [
      'POST /events HTTP/1.1',
      'Host: 127.0.0.1:8787',
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(bodyStr, 'utf8')}`,
      '',
      bodyStr,
    ].join('\r\n');

    stream.pushToStream(httpRequest);
    stream.endStream();

    await eventsHandler.handle(stream, { kind: 'events', userId: 'alice' });

    const response = stream.responseBuffer.toString('utf8');
    expect(response).toContain('200 OK');
    const rows = db.prepare('SELECT * FROM web_events WHERE type = ? AND user_id = ?').all('assistant_delta', ALICE_PLATFORM_ID) as any[];
    expect(rows.length).toBe(1);

    const aliasRows = db.prepare("SELECT * FROM web_events WHERE type = 'assistant_delta' AND user_id = 'alice'").all() as any[];
    expect(aliasRows.length).toBe(0);
  });
});
