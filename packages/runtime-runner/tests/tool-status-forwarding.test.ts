import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Duplex } from 'node:stream';
import { PlatformProxyHandler } from '../src/tunnel/platform-proxy.js';

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

export const SYNTHETIC_USER_ID = '00000000-0000-4000-8000-000000000001';

describe('Tool status event forwarding with callId, summary, and facts', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL
      );
      CREATE TABLE session_routes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        dsh_session_id TEXT NOT NULL
      );
      CREATE TABLE web_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run(SYNTHETIC_USER_ID, 'user-alice');
    db.prepare('INSERT INTO session_routes (id, user_id, dsh_session_id) VALUES (?, ?, ?)').run('ses_1', SYNTHETIC_USER_ID, 'ses_1');
  });

  it('forwards sanitized callId, summary, and facts to web_events', async () => {
    const handler = new PlatformProxyHandler({
      platformUserId: SYNTHETIC_USER_ID,
      runtimeIdentity: 'alice',
      db,
    });
    const stream = new TestClientDuplex();

    const eventsPayload = {
      events: [
        {
          sessionId: 'ses_1',
          type: 'tool_started',
          payload: {
            toolName: 'read',
            callId: 'call_synth_01',
            summary: '/workspace/src/index.ts',
          },
          createdAt: '2026-10-18T10:00:00.000Z',
        },
        {
          sessionId: 'ses_1',
          type: 'tool_completed',
          payload: {
            toolName: 'read',
            status: 'completed',
            callId: 'call_synth_01',
            summary: '/workspace/src/index.ts',
            facts: '150 lines',
          },
          createdAt: '2026-10-18T10:00:00.120Z',
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

    const rows = db.prepare('SELECT type, payload FROM web_events WHERE session_id = ? ORDER BY created_at ASC').all('ses_1') as Array<{ type: string; payload: string }>;
    expect(rows.length).toBe(2);

    const startPayload = JSON.parse(rows[0].payload);
    expect(startPayload.toolName).toBe('read');
    expect(startPayload.status).toBe('started');
    expect(startPayload.callId).toBe('call_synth_01');
    expect(startPayload.summary).toBe('/workspace/src/index.ts');

    const endPayload = JSON.parse(rows[1].payload);
    expect(endPayload.toolName).toBe('read');
    expect(endPayload.status).toBe('completed');
    expect(endPayload.callId).toBe('call_synth_01');
    expect(endPayload.facts).toBe('150 lines');
  });
});
