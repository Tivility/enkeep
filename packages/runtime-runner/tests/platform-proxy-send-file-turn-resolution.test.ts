import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createPlatformProxyHandler } from '../src/tunnel/platform-proxy.js';
import { PassThrough } from 'node:stream';

describe('B-01 & B-02: Platform Proxy send_file turn resolution and forwarding', () => {
  let db: DatabaseSync;
  let tmpDir: string;
  let spacesDir: string;
  const userId = 'user_synth_proxy_01';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-file-test-'));
    spacesDir = path.join(tmpDir, 'spaces');
    fs.mkdirSync(spacesDir, { recursive: true });
    fs.mkdirSync(path.join(spacesDir, 'spc_001'), { recursive: true });

    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      INSERT INTO users (id) VALUES ('${userId}');

      CREATE TABLE spaces (id TEXT PRIMARY KEY, folder TEXT);
      INSERT INTO spaces (id, folder) VALUES ('spc_001', 'spc_001');

      CREATE TABLE session_routes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        space_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        account_id TEXT,
        native_context_id TEXT,
        peer_id TEXT,
        dsh_session_id TEXT
      );

      CREATE TABLE file_metadata (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mime_type TEXT,
        extension TEXT,
        checksum TEXT,
        recipient TEXT NOT NULL,
        description TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE web_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        route_key TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE session_child_origins (
        session_id TEXT NOT NULL,
        child_id TEXT NOT NULL,
        origin_turn_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        PRIMARY KEY (session_id, child_id)
      );
    `);
  });

  it('resolves turnId and sessionId from body and forwards to operations.sendFile', async () => {
    const sessionRouteId = 'ses_route_001';
    const turnId = 'turn_explicit_001';

    db.exec(`
      INSERT INTO session_routes (id, user_id, space_id, channel, dsh_session_id)
      VALUES ('${sessionRouteId}', '${userId}', 'spc_001', 'web', 'dsh_ses_001');
    `);

    const mockSendFile = vi.fn().mockResolvedValue({
      success: true,
      fileId: 'file_001',
      recipient: sessionRouteId,
      deliveryStatus: 'recorded',
    });

    const mockOperations = {
      forTenant: vi.fn(() => ({
        files: {
          sendFile: mockSendFile,
        },
      })),
    };

    const handler = createPlatformProxyHandler({
      platformUserId: userId,
      db,
      operations: mockOperations as any,
    });

    const requestBody = JSON.stringify({
      recipient: sessionRouteId,
      path: 'result.txt',
      filename: 'result.txt',
      size: 42,
      content: Buffer.from('data').toString('base64'),
      sessionId: sessionRouteId,
      turnId,
    });

    const stream = new PassThrough();
    let responseData = '';
    stream.on('data', (chunk) => {
      responseData += chunk.toString();
    });

    const fakeReq = {
      method: 'POST',
      url: '/api/files',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(requestBody)),
      },
      body: Buffer.from(requestBody),
    };

    await (handler as any).handleSendFile(fakeReq, stream);

    expect(mockSendFile).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: sessionRouteId,
        path: 'result.txt',
        sessionId: sessionRouteId,
        turnId,
      })
    );

    expect(responseData).toContain('"deliveryStatus":"recorded"');
  });

  it('subagent child session without turnId in body resolves turnId via session_child_origins', async () => {
    const parentSessionId = 'ses_parent_001';
    const childSessionId = 'ses_child_subagent_001';
    const originTurnId = 'turn_origin_from_parent';

    db.exec(`
      INSERT INTO session_routes (id, user_id, space_id, channel, dsh_session_id)
      VALUES ('${parentSessionId}', '${userId}', 'spc_001', 'web', 'dsh_p_001');

      INSERT INTO session_child_origins (session_id, child_id, origin_turn_id)
      VALUES ('${parentSessionId}', '${childSessionId}', '${originTurnId}');
    `);

    const mockSendFile = vi.fn().mockResolvedValue({
      success: true,
      fileId: 'file_child_001',
      recipient: childSessionId,
      deliveryStatus: 'recorded',
    });

    const mockOperations = {
      forTenant: vi.fn(() => ({
        files: {
          sendFile: mockSendFile,
        },
      })),
    };

    const handler = createPlatformProxyHandler({
      platformUserId: userId,
      db,
      operations: mockOperations as any,
    });

    const requestBody = JSON.stringify({
      recipient: childSessionId,
      path: 'subagent_artifact.pdf',
      filename: 'subagent_artifact.pdf',
      size: 1024,
      content: Buffer.from('data').toString('base64'),
      sessionId: childSessionId,
    });

    const stream = new PassThrough();
    await (handler as any).handleSendFile({
      method: 'POST',
      url: '/api/files',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(requestBody)),
      },
      body: Buffer.from(requestBody),
    }, stream);

    expect(mockSendFile).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: childSessionId,
        path: 'subagent_artifact.pdf',
        sessionId: childSessionId,
        turnId: originTurnId,
      })
    );
  });

  it('session without turnId and not in session_child_origins passes undefined turnId resulting in no target resolution', async () => {
    const directSessionId = 'ses_main_standalone_001';

    db.exec(`
      INSERT INTO session_routes (id, user_id, space_id, channel, dsh_session_id)
      VALUES ('${directSessionId}', '${userId}', 'spc_001', 'web', 'dsh_main_001');
    `);

    const mockSendFile = vi.fn().mockResolvedValue({
      success: true,
      fileId: 'file_standalone_001',
      recipient: directSessionId,
      deliveryStatus: 'recorded',
    });

    const mockOperations = {
      forTenant: vi.fn(() => ({
        files: {
          sendFile: mockSendFile,
        },
      })),
    };

    const handler = createPlatformProxyHandler({
      platformUserId: userId,
      db,
      operations: mockOperations as any,
    });

    const requestBody = JSON.stringify({
      recipient: directSessionId,
      path: 'standalone.txt',
      filename: 'standalone.txt',
      size: 10,
      content: Buffer.from('data').toString('base64'),
      sessionId: directSessionId,
    });

    const stream = new PassThrough();
    await (handler as any).handleSendFile({
      method: 'POST',
      url: '/api/files',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(requestBody)),
      },
      body: Buffer.from(requestBody),
    }, stream);

    expect(mockSendFile).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: directSessionId,
        path: 'standalone.txt',
        sessionId: directSessionId,
        turnId: undefined,
      })
    );
  });
});
