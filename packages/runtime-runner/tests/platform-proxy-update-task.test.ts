/**
 * PlatformProxyHandler Task Update (PUT /api/manage/tasks/:id) Test Suite
 *
 * Verifies:
 * 1. Valid payload: Updates task attributes and returns canonical 200 JSON envelope.
 * 2. Bad method: Rejects non-PUT methods (PATCH, POST, GET, DELETE) with 405 Method Not Allowed.
 * 3. Ownscope / Security:
 *    - Rejects attempts to spoof userId, user_id, or owner with 400 Bad Request.
 *    - Rejects attempts to modify sessionId or spaceId with 400 Bad Request.
 *    - Enforces tenant isolation: Alice cannot update Bob's task (returns 404 Not Found).
 *    - Rejects updates to claimed/running tasks with 409 Conflict (TaskAlreadyClaimedError).
 *    - Rejects updates to completed tasks with 409 Conflict (TaskAlreadyCompletedError).
 *    - Rejects invalid task ID format with 400 Validation Error.
 *    - Rejects empty update payload with 400 Validation Error.
 * 4. Strict JSON: All responses are strictly parseable JSON without raw leaks or undefined values.
 * 5. Zero Feishu/Lark dependencies: Generic synthetic fixtures only.
 *
 * @module @enkeep/runtime-runner/tests/platform-proxy-update-task.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Duplex } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformProxyHandler,
  createPlatformProxyHandler,
} from '../src/tunnel/platform-proxy.js';
import type { PlatformOperationsService, Task } from '@enkeep/platform-operations';
import {
  TaskNotFoundError,
  TaskAlreadyClaimedError,
} from '@enkeep/platform-operations';

export const ALICE_ID = '11111111-1111-4111-8111-111111111111';
export const BOB_ID = '22222222-2222-4222-8222-222222222222';
export const TASK_ALICE = 'task_11111111111111111111111111111111';
export const TASK_BOB = 'task_22222222222222222222222222222222';
export const TASK_CLAIMED = 'task_33333333333333333333333333333333';
export const TASK_COMPLETED = 'task_44444444444444444444444444444444';

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

    INSERT INTO platform_tasks (id, user_id, title, status, priority, due_date, payload)
    VALUES (
      '${TASK_ALICE}',
      '${ALICE_ID}',
      'Original Alice Task',
      'pending',
      'medium',
      '2026-10-01T00:00:00.000Z',
      '{"type":"agent_prompt","prompt":"Original prompt"}'
    );

    INSERT INTO platform_tasks (id, user_id, title, status, priority, due_date, payload)
    VALUES (
      '${TASK_BOB}',
      '${BOB_ID}',
      'Original Bob Task',
      'pending',
      'low',
      NULL,
      '{"type":"agent_prompt","prompt":"Bob prompt"}'
    );

    INSERT INTO platform_tasks (id, user_id, title, status, priority, due_date, payload)
    VALUES (
      '${TASK_CLAIMED}',
      '${ALICE_ID}',
      'Claimed Task',
      'claimed',
      'high',
      NULL,
      '{"type":"agent_prompt","prompt":"Claimed prompt"}'
    );

    INSERT INTO platform_tasks (id, user_id, title, status, priority, due_date, payload)
    VALUES (
      '${TASK_COMPLETED}',
      '${ALICE_ID}',
      'Completed Task',
      'completed',
      'low',
      NULL,
      '{"type":"agent_prompt","prompt":"Completed prompt"}'
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
    parsedJson = JSON.parse(bodyPart);
  }

  return {
    statusCode,
    statusText,
    headers,
    body: parsedJson,
    rawBody: bodyPart,
  };
}

describe('PlatformProxyHandler PUT /api/manage/tasks/:id Tests', () => {
  let db: DatabaseSync;
  let handler: PlatformProxyHandler;

  beforeEach(() => {
    db = createTestDatabase();
    handler = createPlatformProxyHandler({
      platformUserId: ALICE_ID,
      runtimeIdentity: 'alice',
      db,
    });
  });

  afterEach(() => {
    db.close();
  });

  describe('1. Valid Payload Handling', () => {
    it('updates title, prompt, priority, and dueDate successfully', async () => {
      const updatePayload = {
        title: 'Updated Alice Task',
        prompt: 'Updated agent instructions',
        priority: 'urgent',
        dueDate: '2026-12-31T23:59:59.000Z',
      };

      const res = await sendRequest(handler, 'PUT', `/api/manage/tasks/${TASK_ALICE}`, updatePayload);

      expect(res.statusCode).toBe(200);
      expect(res.statusText).toBe('OK');
      expect(res.body).toEqual({
        success: true,
        data: {
          id: TASK_ALICE,
          status: 'pending',
          updated: true,
          task: {
            id: TASK_ALICE,
            title: 'Updated Alice Task',
            status: 'pending',
            priority: 'urgent',
            dueDate: '2026-12-31T23:59:59.000Z',
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
          },
        },
      });

      // Verify persistence in SQLite
      const row = db.prepare('SELECT * FROM platform_tasks WHERE id = ?').get(TASK_ALICE) as any;
      expect(row.title).toBe('Updated Alice Task');
      expect(row.priority).toBe('urgent');
      expect(row.due_date).toBe('2026-12-31T23:59:59.000Z');
      const payload = JSON.parse(row.payload);
      expect(payload.prompt).toBe('Updated agent instructions');
    });

    it('updates partial fields (only priority)', async () => {
      const res = await sendRequest(handler, 'PUT', `/api/manage/tasks/${TASK_ALICE}`, {
        priority: 'low',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.data.task.priority).toBe('low');
      expect(res.body.data.task.title).toBe('Original Alice Task');
    });

    it('supports canonical trailing slash in pathname', async () => {
      const res = await sendRequest(handler, 'PUT', `/api/manage/tasks/${TASK_ALICE}/`, {
        title: 'Trailing Slash Updated',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.data.task.title).toBe('Trailing Slash Updated');
    });

    it('returns strict JSON with no undefined string serialization', async () => {
      const res = await sendRequest(handler, 'PUT', `/api/manage/tasks/${TASK_ALICE}`, {
        title: 'Strict JSON Task',
      });

      expect(res.statusCode).toBe(200);
      expect(res.rawBody).not.toContain('undefined');
      expect(JSON.parse(res.rawBody)).toBeDefined();
    });
  });

  describe('2. Bad Method Checking (no PATCH alias, 405 Method Not Allowed)', () => {
    it('rejects PATCH /api/manage/tasks/:id with 405 Method Not Allowed', async () => {
      const res = await sendRequest(handler, 'PATCH', `/api/manage/tasks/${TASK_ALICE}`, {
        title: 'Patch Attempt',
      });

      expect(res.statusCode).toBe(405);
      expect(res.statusText).toBe('Method Not Allowed');
      expect(res.body.error.code).toBe('METHOD_NOT_ALLOWED');
    });

    it('rejects POST /api/manage/tasks/:id with 405 Method Not Allowed', async () => {
      const res = await sendRequest(handler, 'POST', `/api/manage/tasks/${TASK_ALICE}`, {
        title: 'Post Id Attempt',
      });

      expect(res.statusCode).toBe(405);
      expect(res.body.error.code).toBe('METHOD_NOT_ALLOWED');
    });

    it('rejects GET /api/manage/tasks/:id with 405 Method Not Allowed', async () => {
      const res = await sendRequest(handler, 'GET', `/api/manage/tasks/${TASK_ALICE}`);

      expect(res.statusCode).toBe(405);
      expect(res.body.error.code).toBe('METHOD_NOT_ALLOWED');
    });

    it('rejects DELETE /api/manage/tasks/:id with 405 Method Not Allowed', async () => {
      const res = await sendRequest(handler, 'DELETE', `/api/manage/tasks/${TASK_ALICE}`);

      expect(res.statusCode).toBe(405);
      expect(res.body.error.code).toBe('METHOD_NOT_ALLOWED');
    });

    it('rejects PUT /api/manage/tasks (without task ID) with 405 Method Not Allowed', async () => {
      const res = await sendRequest(handler, 'PUT', '/api/manage/tasks', {
        title: 'Put Base Attempt',
      });

      expect(res.statusCode).toBe(405);
      expect(res.body.error.code).toBe('METHOD_NOT_ALLOWED');
    });
  });

  describe('3. Ownscope Errors, Auth Spoofing & Tenant Isolation', () => {
    it('rejects auth spoofing with userId in body with 400 Bad Request', async () => {
      const res = await sendRequest(handler, 'PUT', `/api/manage/tasks/${TASK_ALICE}`, {
        userId: BOB_ID,
        title: 'Spoof Attempt',
      });

      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toBe('Task ownership is immutable');
    });

    it('rejects auth spoofing with user_id in body with 400 Bad Request', async () => {
      const res = await sendRequest(handler, 'PUT', `/api/manage/tasks/${TASK_ALICE}`, {
        user_id: BOB_ID,
        title: 'Spoof Attempt 2',
      });

      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toBe('Task ownership is immutable');
    });

    it('rejects auth spoofing with owner in body with 400 Bad Request', async () => {
      const res = await sendRequest(handler, 'PUT', `/api/manage/tasks/${TASK_ALICE}`, {
        owner: 'bob',
        title: 'Spoof Attempt 3',
      });

      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toBe('Task ownership is immutable');
    });

    it('rejects spaceId tampering with 400 Bad Request', async () => {
      const res = await sendRequest(handler, 'PUT', `/api/manage/tasks/${TASK_ALICE}`, {
        spaceId: 'sp_other',
        title: 'Space Tamper',
      });

      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toBe('Task session and space bindings are immutable');
    });

    it('rejects sessionId tampering with 400 Bad Request', async () => {
      const res = await sendRequest(handler, 'PUT', `/api/manage/tasks/${TASK_ALICE}`, {
        sessionId: 'ses_other',
        title: 'Session Tamper',
      });

      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toBe('Task session and space bindings are immutable');
    });

    it('enforces tenant isolation: Alice cannot update Bob task (returns 404 Not Found)', async () => {
      const res = await sendRequest(handler, 'PUT', `/api/manage/tasks/${TASK_BOB}`, {
        title: 'Cross Tenant Update',
      });

      expect(res.statusCode).toBe(404);
      expect(res.statusText).toBe('Not Found');
      expect(res.body.error.code).toBe('NOT_FOUND');

      // Bob's task remains unchanged
      const bobRow = db.prepare('SELECT * FROM platform_tasks WHERE id = ?').get(TASK_BOB) as any;
      expect(bobRow.title).toBe('Original Bob Task');
    });

    it('returns 404 for non-existent taskId', async () => {
      const fakeTaskId = 'task_99999999999999999999999999999999';
      const res = await sendRequest(handler, 'PUT', `/api/manage/tasks/${fakeTaskId}`, {
        title: 'Ghost Task',
      });

      expect(res.statusCode).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('rejects updating claimed task with 409 Conflict', async () => {
      const res = await sendRequest(handler, 'PUT', `/api/manage/tasks/${TASK_CLAIMED}`, {
        title: 'Modify Claimed',
      });

      expect(res.statusCode).toBe(409);
      expect(res.statusText).toBe('Conflict');
      expect(res.body.error.code).toBe('TASK_ALREADY_CLAIMED');
    });

    it('rejects updating completed task with 409 Conflict', async () => {
      const res = await sendRequest(handler, 'PUT', `/api/manage/tasks/${TASK_COMPLETED}`, {
        title: 'Modify Completed',
      });

      expect(res.statusCode).toBe(409);
      expect(res.statusText).toBe('Conflict');
      expect(res.body.error.code).toBe('TASK_ALREADY_COMPLETED');
    });

    it('rejects invalid task ID format with 400 Validation Error', async () => {
      const res = await sendRequest(handler, 'PUT', '/api/manage/tasks/not_a_valid_id', {
        title: 'Bad ID',
      });

      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toBe('Invalid task ID format');
    });

    it('rejects empty update body with 400 Validation Error', async () => {
      const res = await sendRequest(handler, 'PUT', `/api/manage/tasks/${TASK_ALICE}`, {});

      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects invalid JSON body with 400 Bad Request', async () => {
      const res = await sendRequest(handler, 'PUT', `/api/manage/tasks/${TASK_ALICE}`, 'invalid-json{{{');

      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('INVALID_JSON');
    });

    it('fails closed with 503 when platformUserId is not bound', async () => {
      const unauthenticatedHandler = createPlatformProxyHandler({
        platformUserId: ALICE_ID,
        runtimeIdentity: 'alice',
        db,
      });
      // Override platformUserId to empty
      (unauthenticatedHandler as any).platformUserId = undefined;

      const res = await sendRequest(unauthenticatedHandler, 'PUT', `/api/manage/tasks/${TASK_ALICE}`, {
        title: 'No Auth Bound',
      });

      expect(res.statusCode).toBe(503);
      expect(res.body.error.code).toBe('OPERATIONS_UNAVAILABLE');
    });
  });

  describe('4. Platform Operations Service Integration', () => {
    it('dispatches to PlatformOperationsService and returns canonical envelope', async () => {
      let updatedInputReceived: any = null;
      const fakeTask: Task = {
        id: TASK_ALICE,
        userId: ALICE_ID,
        title: 'Ops Updated Title',
        priority: 'high',
        status: 'pending',
        scheduleType: 'once',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-22T12:00:00.000Z',
        payload: { type: 'agent_prompt', prompt: 'Ops updated prompt' },
      };

      const mockOperations: PlatformOperationsService = {
        forTenant: (userId: string) => {
          expect(userId).toBe(ALICE_ID);
          return {
            tasks: {
              updateTask: async (taskId: string, input: any) => {
                expect(taskId).toBe(TASK_ALICE);
                updatedInputReceived = input;
                return fakeTask;
              },
            },
          } as any;
        },
      } as any;

      const opsHandler = createPlatformProxyHandler({
        platformUserId: ALICE_ID,
        runtimeIdentity: 'alice',
        operations: mockOperations,
      });

      const res = await sendRequest(opsHandler, 'PUT', `/api/manage/tasks/${TASK_ALICE}`, {
        title: 'Ops Updated Title',
        priority: 'high',
        prompt: 'Ops updated prompt',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(TASK_ALICE);
      expect(res.body.data.updated).toBe(true);
      expect(res.body.data.task.title).toBe('Ops Updated Title');
      expect(res.body.data.task.priority).toBe('high');
      expect(updatedInputReceived.title).toBe('Ops Updated Title');
      expect(updatedInputReceived.priority).toBe('high');
      expect(updatedInputReceived.prompt).toBe('Ops updated prompt');
    });

    it('maps TaskNotFoundError from operations to 404 HTTP status', async () => {
      const mockOperations: PlatformOperationsService = {
        forTenant: (_userId: string) => ({
          tasks: {
            updateTask: async (taskId: string) => {
              throw new TaskNotFoundError(taskId);
            },
          },
        } as any),
      } as any;

      const opsHandler = createPlatformProxyHandler({
        platformUserId: ALICE_ID,
        runtimeIdentity: 'alice',
        operations: mockOperations,
      });

      const nonExistent = 'task_11111111111111111111111111111111';
      const res = await sendRequest(opsHandler, 'PUT', `/api/manage/tasks/${nonExistent}`, {
        title: 'Ops Ghost Task',
      });

      expect(res.statusCode).toBe(404);
      expect(res.statusText).toBe('Not Found');
      expect(res.body.error.code).toBe('TASK_NOT_FOUND');
    });

    it('maps TaskAlreadyClaimedError from operations to 409 HTTP status', async () => {
      const mockOperations: PlatformOperationsService = {
        forTenant: (_userId: string) => ({
          tasks: {
            updateTask: async (taskId: string) => {
              throw new TaskAlreadyClaimedError(taskId, 'worker_busy_node_1');
            },
          },
        } as any),
      } as any;

      const opsHandler = createPlatformProxyHandler({
        platformUserId: ALICE_ID,
        runtimeIdentity: 'alice',
        operations: mockOperations,
      });

      const res = await sendRequest(opsHandler, 'PUT', `/api/manage/tasks/${TASK_ALICE}`, {
        title: 'Ops Claimed Task',
      });

      expect(res.statusCode).toBe(409);
      expect(res.statusText).toBe('Conflict');
      expect(res.body.error.code).toBe('TASK_ALREADY_CLAIMED');
    });
  });
});
