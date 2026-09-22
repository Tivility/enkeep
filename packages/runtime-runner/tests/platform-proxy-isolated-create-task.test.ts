/**
 * PlatformProxyHandler Isolated Task Creation (POST /api/manage/tasks) Test Suite
 *
 * Verifies:
 * 1. Model tool request with sessionPolicy: 'isolated' extracts sessionPolicy and passes it to operations/storage.
 * 2. Model tool request with alias contextMode: 'isolated' maps consistently to sessionPolicy: 'isolated'.
 * 3. Default legacy requests (omitted sessionPolicy & contextMode) preserve sessionPolicy: 'existing_session'.
 * 4. Conflicting or invalid sessionPolicy / contextMode values are strictly rejected with 400 Bad Request (VALIDATION_ERROR).
 * 5. Direct SQLite fallback correctly persists sessionPolicy: 'isolated' in payload JSON.
 * 6. Zero Feishu/Lark dependencies: Generic synthetic fixtures only.
 *
 * @module @enkeep/runtime-runner/tests/platform-proxy-isolated-create-task.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Duplex } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformProxyHandler,
  createPlatformProxyHandler,
} from '../src/tunnel/platform-proxy.js';
import type { PlatformOperationsService } from '@enkeep/platform-operations';

export const ALICE_PLATFORM_ID = '11111111-1111-4111-8111-111111111111';
export const TEST_SESSION_ID = 'ses_0123456789abcdef0123456789abcdef';

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
  `);

  return db;
}

class TestClientDuplex extends Duplex {
  public responseBuffer = Buffer.alloc(0);

  public pushToStream(data: string | Buffer): void {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    this.push(buf);
  }

  public endStream(): void {
    this.push(null);
  }

  _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.responseBuffer = Buffer.concat([this.responseBuffer, buf]);
    callback();
  }

  _read(_size: number): void {
    // Controlled via pushToStream
  }
}

describe('PlatformProxyHandler Isolated Task Creation', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it('receives model tool request with sessionPolicy: "isolated", validates and forwards to operations with origin sessionId', async () => {
    let capturedCreateInput: any = null;

    const mockOperations = {
      forTenant: vi.fn((userId: string) => ({
        tasks: {
          createTask: vi.fn(async (input: any) => {
            capturedCreateInput = input;
            return {
              isIdempotentHit: false,
              task: {
                id: 'task_00000000000000000000000000000001',
                title: input.title,
                status: 'pending',
                priority: input.priority,
                dueDate: input.dueDate ?? null,
                createdAt: new Date().toISOString(),
              },
            };
          }),
        },
      })),
    } as unknown as PlatformOperationsService;

    const handler = createPlatformProxyHandler({
      platformUserId: ALICE_PLATFORM_ID,
      runtimeIdentity: 'alice',
      db,
      operations: mockOperations,
    });

    const idempotencyKey = 'c0000000-0000-4000-8000-000000000001';
    const body = JSON.stringify({
      title: 'Run scheduled audit in isolated context',
      prompt: 'Check compliance rules without polluting main session',
      sessionId: TEST_SESSION_ID,
      priority: 'high',
      sessionPolicy: 'isolated',
    });

    const stream = new TestClientDuplex();
    const reqStr = `POST /api/manage/tasks HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nIdempotency-Key: ${idempotencyKey}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    stream.pushToStream(reqStr);
    stream.endStream();

    await handler.handle(stream, { kind: 'platform', userId: 'alice' });

    const response = stream.responseBuffer.toString('utf8');
    expect(response).toContain('201 Created');
    expect(response).toContain('"status":"pending"');

    expect(mockOperations.forTenant).toHaveBeenCalledWith(ALICE_PLATFORM_ID);
    expect(capturedCreateInput).toBeDefined();
    expect(capturedCreateInput.payload).toEqual({
      type: 'agent_prompt',
      prompt: 'Check compliance rules without polluting main session',
      sessionId: TEST_SESSION_ID,
      sessionPolicy: 'isolated',
    });
  });

  it('receives alias contextMode: "isolated" and maps to sessionPolicy: "isolated"', async () => {
    let capturedCreateInput: any = null;

    const mockOperations = {
      forTenant: vi.fn((_userId: string) => ({
        tasks: {
          createTask: vi.fn(async (input: any) => {
            capturedCreateInput = input;
            return {
              isIdempotentHit: false,
              task: {
                id: 'task_00000000000000000000000000000002',
                title: input.title,
                status: 'pending',
                priority: input.priority,
                dueDate: null,
                createdAt: new Date().toISOString(),
              },
            };
          }),
        },
      })),
    } as unknown as PlatformOperationsService;

    const handler = createPlatformProxyHandler({
      platformUserId: ALICE_PLATFORM_ID,
      runtimeIdentity: 'alice',
      db,
      operations: mockOperations,
    });

    const idempotencyKey = 'c0000000-0000-4000-8000-000000000002';
    const body = JSON.stringify({
      title: 'Run scheduled maintenance with contextMode alias',
      prompt: 'Verify disk and quota',
      sessionId: TEST_SESSION_ID,
      contextMode: 'isolated',
    });

    const stream = new TestClientDuplex();
    const reqStr = `POST /api/manage/tasks HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nIdempotency-Key: ${idempotencyKey}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    stream.pushToStream(reqStr);
    stream.endStream();

    await handler.handle(stream, { kind: 'platform', userId: 'alice' });

    const response = stream.responseBuffer.toString('utf8');
    expect(response).toContain('201 Created');

    expect(capturedCreateInput).toBeDefined();
    expect(capturedCreateInput.payload).toEqual({
      type: 'agent_prompt',
      prompt: 'Verify disk and quota',
      sessionId: TEST_SESSION_ID,
      sessionPolicy: 'isolated',
      contextMode: 'isolated',
    });
  });

  it('preserves legacy existing_session default when sessionPolicy and contextMode are omitted', async () => {
    let capturedCreateInput: any = null;

    const mockOperations = {
      forTenant: vi.fn((_userId: string) => ({
        tasks: {
          createTask: vi.fn(async (input: any) => {
            capturedCreateInput = input;
            return {
              isIdempotentHit: false,
              task: {
                id: 'task_00000000000000000000000000000003',
                title: input.title,
                status: 'pending',
                priority: input.priority,
                dueDate: null,
                createdAt: new Date().toISOString(),
              },
            };
          }),
        },
      })),
    } as unknown as PlatformOperationsService;

    const handler = createPlatformProxyHandler({
      platformUserId: ALICE_PLATFORM_ID,
      runtimeIdentity: 'alice',
      db,
      operations: mockOperations,
    });

    const idempotencyKey = 'c0000000-0000-4000-8000-000000000003';
    const body = JSON.stringify({
      title: 'Legacy task creation',
      prompt: 'Do something in current conversation',
      sessionId: TEST_SESSION_ID,
    });

    const stream = new TestClientDuplex();
    const reqStr = `POST /api/manage/tasks HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nIdempotency-Key: ${idempotencyKey}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    stream.pushToStream(reqStr);
    stream.endStream();

    await handler.handle(stream, { kind: 'platform', userId: 'alice' });

    const response = stream.responseBuffer.toString('utf8');
    expect(response).toContain('201 Created');

    expect(capturedCreateInput).toBeDefined();
    expect(capturedCreateInput.payload).toEqual({
      type: 'agent_prompt',
      prompt: 'Do something in current conversation',
      sessionId: TEST_SESSION_ID,
      sessionPolicy: 'existing_session',
    });
  });

  it('rejects conflicting and invalid sessionPolicy/contextMode values with 400 VALIDATION_ERROR', async () => {
    const handler = createPlatformProxyHandler({
      platformUserId: ALICE_PLATFORM_ID,
      runtimeIdentity: 'alice',
      db,
    });

    // 1. Conflicting sessionPolicy and contextMode
    {
      const idempotencyKey = 'c0000000-0000-4000-8000-000000000004';
      const body = JSON.stringify({
        title: 'Conflicting task',
        prompt: 'Conflict test',
        sessionId: TEST_SESSION_ID,
        sessionPolicy: 'isolated',
        contextMode: 'group',
      });

      const stream = new TestClientDuplex();
      const reqStr = `POST /api/manage/tasks HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nIdempotency-Key: ${idempotencyKey}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      stream.pushToStream(reqStr);
      stream.endStream();

      await handler.handle(stream, { kind: 'platform', userId: 'alice' });
      const response = stream.responseBuffer.toString('utf8');
      expect(response).toContain('400 Bad Request');
      expect(response).toContain('Conflicting sessionPolicy and contextMode provided');
    }

    // 2. Invalid sessionPolicy value
    {
      const idempotencyKey = 'c0000000-0000-4000-8000-000000000005';
      const body = JSON.stringify({
        title: 'Invalid policy task',
        prompt: 'Invalid policy test',
        sessionId: TEST_SESSION_ID,
        sessionPolicy: 'invalid_policy',
      });

      const stream = new TestClientDuplex();
      const reqStr = `POST /api/manage/tasks HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nIdempotency-Key: ${idempotencyKey}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      stream.pushToStream(reqStr);
      stream.endStream();

      await handler.handle(stream, { kind: 'platform', userId: 'alice' });
      const response = stream.responseBuffer.toString('utf8');
      expect(response).toContain('400 Bad Request');
      expect(response).toContain('Invalid sessionPolicy');
    }

    // 3. Invalid contextMode value
    {
      const idempotencyKey = 'c0000000-0000-4000-8000-000000000006';
      const body = JSON.stringify({
        title: 'Invalid contextMode task',
        prompt: 'Invalid contextMode test',
        sessionId: TEST_SESSION_ID,
        contextMode: 'invalid_mode',
      });

      const stream = new TestClientDuplex();
      const reqStr = `POST /api/manage/tasks HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nIdempotency-Key: ${idempotencyKey}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      stream.pushToStream(reqStr);
      stream.endStream();

      await handler.handle(stream, { kind: 'platform', userId: 'alice' });
      const response = stream.responseBuffer.toString('utf8');
      expect(response).toContain('400 Bad Request');
      expect(response).toContain('Invalid contextMode');
    }
  });

  it('persists sessionPolicy: "isolated" into SQLite fallback payload correctly', async () => {
    const handler = createPlatformProxyHandler({
      platformUserId: ALICE_PLATFORM_ID,
      runtimeIdentity: 'alice',
      db,
    });

    const idempotencyKey = 'c0000000-0000-4000-8000-000000000007';
    const body = JSON.stringify({
      title: 'SQLite fallback isolated task',
      prompt: 'Isolated execution via DB fallback',
      sessionId: TEST_SESSION_ID,
      sessionPolicy: 'isolated',
    });

    const stream = new TestClientDuplex();
    const reqStr = `POST /api/manage/tasks HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nIdempotency-Key: ${idempotencyKey}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    stream.pushToStream(reqStr);
    stream.endStream();

    await handler.handle(stream, { kind: 'platform', userId: 'alice' });

    const response = stream.responseBuffer.toString('utf8');
    expect(response).toContain('201 Created');

    const row = db.prepare('SELECT payload FROM platform_tasks WHERE user_id = ? AND idempotency_key = ?').get(ALICE_PLATFORM_ID, idempotencyKey) as any;
    expect(row).toBeDefined();
    const payload = JSON.parse(row.payload);
    expect(payload).toEqual({
      type: 'agent_prompt',
      prompt: 'Isolated execution via DB fallback',
      sessionId: TEST_SESSION_ID,
      sessionPolicy: 'isolated',
    });
  });
});
