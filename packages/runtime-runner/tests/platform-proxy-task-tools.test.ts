/**
 * PlatformProxyHandler Task Tools (cancel / list / get) Test Suite
 *
 * Verifies D4 acceptance:
 * 1. POST /api/manage/tasks/:id/cancel:
 *    - Cancels task, updates status to 'cancelled', returns 200 envelope.
 *    - Rejects cancelling already completed/cancelled task with 409 Conflict.
 *    - Enforces tenant isolation (Alice cannot cancel Bob's task -> 404).
 *    - Validates task ID format (400) and existence (404).
 *    - Rejects non-POST methods with 405 Method Not Allowed.
 * 2. GET /api/manage/tasks:
 *    - Lists tasks for authoritative tenant with 200 envelope.
 *    - Enforces tenant isolation: Alice does not see Bob's tasks.
 *    - Supports status, limit, and offset filtering.
 *    - Rejects invalid status filter or invalid limit with 400.
 * 3. GET /api/manage/tasks/:id:
 *    - Retrieves task details with 200 envelope.
 *    - Enforces tenant isolation: Alice cannot get Bob's task -> 404.
 *    - Returns 404 for non-existent taskId.
 *    - Validates task ID format (400).
 *
 * @module @enkeep/runtime-runner/tests/platform-proxy-task-tools.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Duplex } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformProxyHandler,
  createPlatformProxyHandler,
} from '../src/tunnel/platform-proxy.js';
import type { PlatformOperationsService, Task } from '@enkeep/platform-operations';

export const ALICE_ID = '11111111-1111-4111-8111-111111111111';
export const BOB_ID = '22222222-2222-4222-8222-222222222222';
export const TASK_ALICE_1 = 'task_11111111111111111111111111111111';
export const TASK_ALICE_2 = 'task_11111111111111111111111111111112';
export const TASK_ALICE_COMPLETED = 'task_11111111111111111111111111111113';
export const TASK_BOB = 'task_22222222222222222222222222222222';

function createTestDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');

  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user'
    );

    INSERT INTO users (id, username, password_hash, role) VALUES ('${ALICE_ID}', 'alice', 'hash', 'admin');
    INSERT INTO users (id, username, password_hash, role) VALUES ('${BOB_ID}', 'bob', 'hash', 'user');

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

    INSERT INTO platform_tasks (id, user_id, title, status, priority, due_date, payload, created_at)
    VALUES (
      '${TASK_ALICE_1}',
      '${ALICE_ID}',
      'Alice Task 1',
      'pending',
      'high',
      '2026-10-01T00:00:00.000Z',
      '{"type":"agent_prompt","prompt":"Alice prompt 1"}',
      '2026-09-01T10:00:00.000Z'
    );

    INSERT INTO platform_tasks (id, user_id, title, status, priority, due_date, payload, created_at)
    VALUES (
      '${TASK_ALICE_2}',
      '${ALICE_ID}',
      'Alice Task 2',
      'running',
      'low',
      NULL,
      '{"type":"agent_prompt","prompt":"Alice prompt 2"}',
      '2026-09-02T10:00:00.000Z'
    );

    INSERT INTO platform_tasks (id, user_id, title, status, priority, due_date, payload, created_at)
    VALUES (
      '${TASK_ALICE_COMPLETED}',
      '${ALICE_ID}',
      'Alice Completed Task',
      'completed',
      'medium',
      NULL,
      '{"type":"agent_prompt","prompt":"Completed prompt"}',
      '2026-09-03T10:00:00.000Z'
    );

    INSERT INTO platform_tasks (id, user_id, title, status, priority, due_date, payload, created_at)
    VALUES (
      '${TASK_BOB}',
      '${BOB_ID}',
      'Bob Task',
      'pending',
      'urgent',
      NULL,
      '{"type":"agent_prompt","prompt":"Bob prompt"}',
      '2026-09-01T12:00:00.000Z'
    );
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

interface ParsedResponse {
  statusCode: number;
  statusText: string;
  headers: Record<string, string>;
  body: any;
  rawBody: string;
}

async function sendRequest(
  handler: PlatformProxyHandler,
  method: string,
  path: string,
  body?: unknown,
  customHeaders?: Record<string, string>
): Promise<ParsedResponse> {
  const stream = new TestClientDuplex();
  const bodyBuffer = body !== undefined
    ? (typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(JSON.stringify(body), 'utf8'))
    : Buffer.alloc(0);

  const headerLines = [
    `${method} ${path} HTTP/1.1`,
    'Host: 127.0.0.1:8787',
    'Content-Type: application/json',
    `Content-Length: ${bodyBuffer.length}`,
  ];

  if (customHeaders) {
    for (const [k, v] of Object.entries(customHeaders)) {
      headerLines.push(`${k}: ${v}`);
    }
  }

  headerLines.push('', '');

  stream.pushToStream(Buffer.concat([Buffer.from(headerLines.join('\r\n'), 'utf8'), bodyBuffer]));
  stream.endStream();

  await handler.handle(stream, { kind: 'platform', userId: 'alice' });

  const raw = stream.responseBuffer.toString('utf8');
  const headerEndIdx = raw.indexOf('\r\n\r\n');
  if (headerEndIdx === -1) {
    throw new Error(`Invalid HTTP response: ${raw}`);
  }

  const headerPart = raw.slice(0, headerEndIdx);
  const bodyPart = raw.slice(headerEndIdx + 4);
  const lines = headerPart.split('\r\n');
  const statusParts = lines[0].split(' ');
  const statusCode = parseInt(statusParts[1], 10);
  const statusText = statusParts.slice(2).join(' ');

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colonIdx = lines[i].indexOf(':');
    if (colonIdx > 0) {
      headers[lines[i].slice(0, colonIdx).trim().toLowerCase()] = lines[i].slice(colonIdx + 1).trim();
    }
  }

  let parsedJson: any = null;
  if (bodyPart.length > 0) {
    try {
      parsedJson = JSON.parse(bodyPart);
    } catch {
      parsedJson = bodyPart;
    }
  }

  return {
    statusCode,
    statusText,
    headers,
    body: parsedJson,
    rawBody: bodyPart,
  };
}

describe('PlatformProxyHandler Task Management (cancel / list / get) Tests', () => {
  let db: DatabaseSync;
  let handler: PlatformProxyHandler;

  beforeEach(() => {
    db = createTestDatabase();
    handler = createPlatformProxyHandler({
      db,
      platformUserId: ALICE_ID,
    });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  describe('POST /api/manage/tasks/:id/cancel', () => {
    it('cancels pending task and returns 200 with cancelled flag', async () => {
      const res = await sendRequest(handler, 'POST', `/api/manage/tasks/${TASK_ALICE_1}/cancel`);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(TASK_ALICE_1);
      expect(res.body.data.status).toBe('cancelled');
      expect(res.body.data.cancelled).toBe(true);

      // Verify in DB
      const row = db.prepare('SELECT status FROM platform_tasks WHERE id = ?').get(TASK_ALICE_1) as any;
      expect(row.status).toBe('cancelled');
    });

    it('rejects cancelling completed task with 409 Conflict', async () => {
      const res = await sendRequest(handler, 'POST', `/api/manage/tasks/${TASK_ALICE_COMPLETED}/cancel`);

      expect(res.statusCode).toBe(409);
      expect(res.body.error.code).toBe('TASK_ALREADY_COMPLETED');
    });

    it('enforces tenant isolation: Alice cannot cancel Bob task (returns 404)', async () => {
      const res = await sendRequest(handler, 'POST', `/api/manage/tasks/${TASK_BOB}/cancel`);

      expect(res.statusCode).toBe(404);
      expect(res.body.error.code).toBe('TASK_NOT_FOUND');
    });

    it('rejects invalid task ID format with 400 Validation Error', async () => {
      const res = await sendRequest(handler, 'POST', '/api/manage/tasks/not-a-valid-task-id/cancel');

      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects GET /api/manage/tasks/:id/cancel with 405 Method Not Allowed', async () => {
      const res = await sendRequest(handler, 'GET', `/api/manage/tasks/${TASK_ALICE_1}/cancel`);

      expect(res.statusCode).toBe(405);
      expect(res.body.error.code).toBe('METHOD_NOT_ALLOWED');
    });
  });

  describe('GET /api/manage/tasks (list_tasks)', () => {
    it('lists tasks for tenant and enforces tenant isolation (does not leak Bob)', async () => {
      const res = await sendRequest(handler, 'GET', '/api/manage/tasks');

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(3);

      const ids = res.body.data.map((t: any) => t.id);
      expect(ids).toContain(TASK_ALICE_1);
      expect(ids).toContain(TASK_ALICE_2);
      expect(ids).toContain(TASK_ALICE_COMPLETED);
      expect(ids).not.toContain(TASK_BOB);
    });

    it('filters tasks by status', async () => {
      const res = await sendRequest(handler, 'GET', '/api/manage/tasks?status=pending');

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(TASK_ALICE_1);
      expect(res.body.data[0].status).toBe('pending');
    });

    it('supports pagination with limit and offset', async () => {
      const res = await sendRequest(handler, 'GET', '/api/manage/tasks?limit=1&offset=0');

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
    });

    it('rejects invalid status filter with 400 Validation Error', async () => {
      const res = await sendRequest(handler, 'GET', '/api/manage/tasks?status=not_a_status');

      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects invalid limit with 400 Validation Error', async () => {
      const res = await sendRequest(handler, 'GET', '/api/manage/tasks?limit=0');

      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /api/manage/tasks/:id (get_task)', () => {
    it('retrieves single task details with 200 envelope', async () => {
      const res = await sendRequest(handler, 'GET', `/api/manage/tasks/${TASK_ALICE_1}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(TASK_ALICE_1);
      expect(res.body.data.title).toBe('Alice Task 1');
      expect(res.body.data.status).toBe('pending');
      expect(res.body.data.priority).toBe('high');
      expect(res.body.data.dueDate).toBe('2026-10-01T00:00:00.000Z');
    });

    it('enforces tenant isolation: Alice cannot get Bob task (returns 404)', async () => {
      const res = await sendRequest(handler, 'GET', `/api/manage/tasks/${TASK_BOB}`);

      expect(res.statusCode).toBe(404);
      expect(res.body.error.code).toBe('TASK_NOT_FOUND');
    });

    it('returns 404 for non-existent taskId', async () => {
      const nonExistent = 'task_ffffffffffffffffffffffffffffffff';
      const res = await sendRequest(handler, 'GET', `/api/manage/tasks/${nonExistent}`);

      expect(res.statusCode).toBe(404);
      expect(res.body.error.code).toBe('TASK_NOT_FOUND');
    });

    it('rejects invalid task ID format with 400 Validation Error', async () => {
      const res = await sendRequest(handler, 'GET', '/api/manage/tasks/bad-task-format');

      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('PlatformOperationsService integration', () => {
    it('dispatches cancelTask, getTask, listTasks through operations when configured', async () => {
      const mockCancel = vi.fn(async (id: string) => ({
        id,
        title: 'Mock Cancelled',
        status: 'cancelled' as const,
        priority: 'high' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));

      const mockGet = vi.fn(async (id: string) => ({
        id,
        title: 'Mock Found',
        status: 'running' as const,
        priority: 'medium' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));

      const mockList = vi.fn(async () => [
        {
          id: TASK_ALICE_1,
          title: 'Mock Listed',
          status: 'pending' as const,
          priority: 'low' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);

      const mockOps: PlatformOperationsService = {
        forTenant: (_tenantId: string) => ({
          tasks: {
            cancelTask: mockCancel,
            getTask: mockGet,
            listTasks: mockList,
          } as any,
        } as any),
      } as any;

      const opsHandler = createPlatformProxyHandler({
        operations: mockOps,
        platformUserId: ALICE_ID,
      });

      // 1. Cancel
      const cancelRes = await sendRequest(opsHandler, 'POST', `/api/manage/tasks/${TASK_ALICE_1}/cancel`);
      expect(cancelRes.statusCode).toBe(200);
      expect(mockCancel).toHaveBeenCalledWith(TASK_ALICE_1);

      // 2. Get
      const getRes = await sendRequest(opsHandler, 'GET', `/api/manage/tasks/${TASK_ALICE_1}`);
      expect(getRes.statusCode).toBe(200);
      expect(mockGet).toHaveBeenCalledWith(TASK_ALICE_1);

      // 3. List
      const listRes = await sendRequest(opsHandler, 'GET', '/api/manage/tasks?status=pending');
      expect(listRes.statusCode).toBe(200);
      expect(mockList).toHaveBeenCalledWith({
        status: 'pending',
        priority: undefined,
        limit: undefined,
        offset: undefined,
      });
    });
  });
});
