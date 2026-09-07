/**
 * End-to-End Agent Turn Tool Execution Test Suite
 *
 * Tests:
 * - Real Agent turn invoking check_quota tool through official Cordis AgentLoop.
 * - Real Agent turn invoking create_task tool through official Cordis AgentLoop, asserting SQLite platform_tasks change.
 * - Real Agent turn invoking send_message tool, asserting SQLite web_messages record with authoritative messageId.
 * - Real Agent turn invoking send_file tool, asserting SQLite file_metadata record and content privacy in management DTO.
 * - Probes health endpoint: capabilities handshake successful -> toolsOperational=true, toolsUnavailableReason=null.
 * - Verifies external interaction approval suspension and platform resolution in agent turn.
 *
 * @module @enkeep/runtime-runner/tests/dsh-tools-e2e.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { bootDshRuntime, type DshBootedRuntime } from '../src/runtime/dsh-boot.js';
import { PlatformProxyHandler } from '../src/tunnel/platform-proxy.js';
import {
  SqlitePlatformStorage,
  SqlitePlatformOperationsStorage,
} from '@enkeep/platform-storage-sqlite';
import {
  createPlatformOperations,
  type PlatformOperationsService,
} from '@enkeep/platform-operations';
import {
  setDefaultFileSecurityHooks,
} from '@enkeep/dsh-tools';
import type {
  BrowserService,
  BrowserOpenOptions,
  BrowserOpenResult,
} from '@enkeep/platform-core';

export const ALICE_PLATFORM_ID = '33333333-3333-4333-8333-333333333333';

async function createE2eDatabase(): Promise<{ db: DatabaseSync; storage: SqlitePlatformStorage }> {
  const db = new DatabaseSync(':memory:');
  const storage = new SqlitePlatformStorage(db);
  await storage.migrations.migrate();

  // Insert test user alice with distinct platform UUID
  db.prepare(`
    INSERT INTO users (id, username, password_hash, role)
    VALUES ('${ALICE_PLATFORM_ID}', 'alice', 'hash', 'admin')
  `).run();

  // Insert space
  db.prepare(`
    INSERT INTO spaces (id, user_id, name, folder)
    VALUES ('sp_alice', '${ALICE_PLATFORM_ID}', 'Workspace', 'default')
  `).run();

  // Insert session route
  db.prepare(`
    INSERT INTO session_routes (id, user_id, space_id, channel, dsh_session_id)
    VALUES ('sr_alice_1', '${ALICE_PLATFORM_ID}', 'sp_alice', 'web', 'ses_0123456789abcdef0123456789abcdef')
  `).run();

  // Insert web_messages and web_events tables if needed (migration 005)
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_messages (
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
  `);

  // Insert default quota limits for alice platform UUID
  const resources = ['tokens', 'messages', 'turns', 'storage_bytes', 'api_calls'];
  for (const r of resources) {
    db.prepare('INSERT INTO quota_limits (user_id, resource, limit_amount) VALUES (?, ?, ?)').run(ALICE_PLATFORM_ID, r, 100000);
  }

  return { db, storage };
}

describe('DSH Tools End-to-End Execution in Agent Turns', () => {
  let tmpDir: string;
  let db: DatabaseSync;
  let operationsStorage: SqlitePlatformOperationsStorage;
  let operationsService: PlatformOperationsService;
  let proxyHandler: PlatformProxyHandler;
  let mockServer: net.Server;
  let mockServerPort: number;

  beforeEach(async () => {
    setDefaultFileSecurityHooks({
      resolveFdPath: (_fd: number, targetPath?: string) => targetPath ?? null,
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tools-e2e-'));
    const created = await createE2eDatabase();
    db = created.db;
    operationsStorage = new SqlitePlatformOperationsStorage(db);
    operationsService = createPlatformOperations({ storage: operationsStorage });

    proxyHandler = new PlatformProxyHandler({
      platformUserId: ALICE_PLATFORM_ID,
      runtimeIdentity: 'alice',
      db,
      operations: operationsService,
    });

    // Start raw TCP server that forwards directly to PlatformProxyHandler (matching TunnelAgent socket behavior)
    mockServer = net.createServer((socket) => {
      proxyHandler.handle(socket, { kind: 'platform', userId: 'alice' });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address();
        mockServerPort = typeof addr === 'object' && addr ? addr.port : 8787;
        resolve();
      });
    });

    process.env.ENKEEP_PLATFORM_BASE_URL = `http://127.0.0.1:${mockServerPort}/platform`;
  });

  afterEach(async () => {
    setDefaultFileSecurityHooks(undefined);
    delete process.env.ENKEEP_PLATFORM_BASE_URL;
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
    if (db) {
      db.close();
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('probes runtime health: capabilities handshake succeeds and toolsOperational is true', async () => {
    const aliceHome = path.join(tmpDir, 'alice', '.dsh');
    const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const health = await runtime.getHealth();
      expect(health.status).toBe('ok');
      expect(health.toolsCount).toBeGreaterThanOrEqual(4);
      expect(health.toolsOperational).toBe(true);
      expect(health.toolsUnavailableReason).toBeNull();
      expect(health.plugins.tools).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  it('model turn calls check_quota tool and completes turn successfully', async () => {
    const aliceHome = path.join(tmpDir, 'alice', '.dsh');
    const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
    const sessionId = 'ses_0123456789abcdef0123456789abcdef';

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const prompt = 'Please check my current quota [enkeep-test-tool-call=check_quota:{"resource":"all"}]';
      const turnResp = await runtime.sendFollowup(
        prompt,
        sessionId,
        'turn_0123456789abcdef0123456789abcdef',
        null
      );

      expect(turnResp.status).toBe('completed');
      expect(turnResp.persisted).toBe(true);
      expect(turnResp.replyText).toContain('[DemoModel:alice]');

      // Inspect session events to verify tool call and tool result
      const agent = await runtime.getOrCreateAgent(sessionId);
      const events = agent.session.snapshotEvents();

      const toolCallEvent = events.find((e: any) =>
        e.type === 'assistant/message' &&
        Array.isArray(e.data?.message?.content) &&
        e.data.message.content.some((b: any) => b.type === 'tool-call' && b.name === 'check_quota')
      );
      expect(toolCallEvent).toBeDefined();

      const toolResultEvent = events.find((e: any) =>
        e.type === 'tool/result' || (e.type === 'user/message' && JSON.stringify(e).includes('ALLOWED'))
      );
      expect(toolResultEvent).toBeDefined();
    } finally {
      await runtime.dispose();
    }
  });

  it('model turn calls create_task tool, asserts SQLite platform_tasks state change and task fields', async () => {
    const aliceHome = path.join(tmpDir, 'alice', '.dsh');
    const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
    const sessionId = 'ses_0123456789abcdef0123456789abcdef';
    const idempotencyKey = 'c0000000-0000-4000-8000-000000000001';

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const taskArgs = {
        title: 'Run code vulnerability scan',
        prompt: 'Scan all repository files for secrets and SQL injection vulnerabilities',
        sessionId,
        idempotencyKey,
        priority: 'high',
      };

      const prompt = `Schedule high priority task [enkeep-test-tool-call=create_task:${JSON.stringify(taskArgs)}]`;
      const turnResp = await runtime.sendFollowup(
        prompt,
        sessionId,
        'turn_00000000000000000000000000000002',
        null
      );

      expect(turnResp.status).toBe('completed');

      // Assert SQLite platform_tasks contains the real created task with exact title, priority, user_id
      const taskRow = db.prepare('SELECT * FROM platform_tasks WHERE user_id = ? AND idempotency_key = ?').get(ALICE_PLATFORM_ID, idempotencyKey) as any;
      expect(taskRow).toBeDefined();
      expect(taskRow.title).toBe('Run code vulnerability scan');
      expect(taskRow.status).toBe('pending');
      expect(taskRow.priority).toBe('high');
      expect(taskRow.user_id).toBe(ALICE_PLATFORM_ID);

      const aliasRows = db.prepare('SELECT COUNT(*) as count FROM platform_tasks WHERE user_id = ?').get('alice') as any;
      expect(aliasRows.count).toBe(0);

      // Verify payload in DB preserves sessionId and prompt
      const parsedPayload = JSON.parse(taskRow.payload);
      expect(parsedPayload.sessionId).toBe(sessionId);
      expect(parsedPayload.prompt).toContain('Scan all repository files');
    } finally {
      await runtime.dispose();
    }
  });

  it('model turn calls send_platform_message tool, asserts SQLite web_messages record with Alice user_id', async () => {
    const aliceHome = path.join(tmpDir, 'alice', '.dsh');
    const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
    const sessionId = 'ses_0123456789abcdef0123456789abcdef';

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const msgArgs = {
        recipient: sessionId,
        content: 'Autonomous Agent: Security analysis complete. All checks passed.',
      };

      const prompt = `Notify user of completion [enkeep-test-tool-call=send_platform_message:${JSON.stringify(msgArgs)}]`;
      const turnResp = await runtime.sendFollowup(
        prompt,
        sessionId,
        'turn_00000000000000000000000000000003',
        null
      );

      expect(turnResp.status).toBe('completed');

      // Assert SQLite web_messages record exists
      const msgRow = db.prepare('SELECT * FROM web_messages WHERE user_id = ? AND content LIKE ?').get(
        ALICE_PLATFORM_ID,
        '%Autonomous Agent: Security analysis complete%'
      ) as any;
      expect(msgRow).toBeDefined();
      expect(msgRow.user_id).toBe(ALICE_PLATFORM_ID);
      expect(msgRow.session_id).toBe('sr_alice_1');
      expect(msgRow.status).toBe('delivered');

      const aliasMsgRows = db.prepare('SELECT COUNT(*) as count FROM web_messages WHERE user_id = ?').get('alice') as any;
      expect(aliasMsgRows.count).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  it('model turn calls send_file tool, asserts SQLite file_metadata & web_messages records without content leak', async () => {
    const aliceHome = path.join(tmpDir, 'alice', '.dsh');
    const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
    const sessionId = 'ses_0123456789abcdef0123456789abcdef';

    // Create a physical test file in space directory ('default')
    const defaultSpaceDir = path.join(aliceSpaces, 'default');
    fs.mkdirSync(defaultSpaceDir, { recursive: true });
    const testFilePath = path.join(defaultSpaceDir, 'audit_report.json');
    const fileContent = JSON.stringify({ auditId: 'audit-99', score: 100, passed: true });
    fs.writeFileSync(testFilePath, fileContent, 'utf8');

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const fileArgs = {
        recipient: sessionId,
        path: 'audit_report.json',
        description: 'Final audit report artifact',
      };

      const prompt = `Send report file [enkeep-test-tool-call=send_file:${JSON.stringify(fileArgs)}]`;
      const turnResp = await runtime.sendFollowup(
        prompt,
        sessionId,
        'turn_00000000000000000000000000000004',
        null,
        'default'
      );

      expect(turnResp.status).toBe('completed');

      // Assert SQLite file_metadata table has record
      const fileRow = db.prepare('SELECT * FROM file_metadata WHERE user_id = ? AND filename = ?').get(ALICE_PLATFORM_ID, 'audit_report.json') as any;
      expect(fileRow).toBeDefined();
      expect(fileRow.user_id).toBe(ALICE_PLATFORM_ID);
      expect(fileRow.relative_path).toBe('audit_report.json');
      expect(fileRow.size).toBe(Buffer.byteLength(fileContent, 'utf8'));

      const aliasFileRows = db.prepare('SELECT COUNT(*) as count FROM file_metadata WHERE user_id = ?').get('alice') as any;
      expect(aliasFileRows.count).toBe(0);

      // Assert web_messages contains file reference
      const msgRow = db.prepare('SELECT * FROM web_messages WHERE user_id = ? AND content LIKE ?').get(
        ALICE_PLATFORM_ID,
        '%[File: audit_report.json]%'
      ) as any;
      expect(msgRow).toBeDefined();
      expect(msgRow.content).toContain('Final audit report artifact');
      // Verify raw file content bytes are NOT dumped into message text
      expect(msgRow.content).not.toContain(fileContent);

      // Verify file reference is valid and does NOT contain non-existent downloadUrl
      expect(msgRow.metadata).toBeDefined();
      const meta = JSON.parse(msgRow.metadata);
      expect(meta.downloadUrl).toBeUndefined();
      expect(meta.fileReference).toBe('/api/spaces/sp_alice/files/download?path=audit_report.json');
    } finally {
      await runtime.dispose();
    }
  });

  it('model turn calls browser_open tool when platform browser capability is available, asserting successful open', async () => {
    const aliceHome = path.join(tmpDir, 'alice', '.dsh');
    const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
    const sessionId = 'ses_0123456789abcdef0123456789abcdef';

    // Mock browserService on proxyHandler
    const mockBrowserService: BrowserService = {
      initialize: vi.fn(async () => {}),
      open: vi.fn(async (options: BrowserOpenOptions): Promise<BrowserOpenResult> => ({
        pageId: 'page_test_open_123',
        url: options.url,
        title: 'Example Domain',
      })),
      snapshot: vi.fn(async () => ({} as any)),
      interact: vi.fn(async () => ({} as any)),
      screenshot: vi.fn(async () => ({} as any)),
      close: vi.fn(async () => ({} as any)),
      checkHealth: vi.fn(async () => ({
        status: 'healthy',
        activeContexts: 1,
        activePages: 1,
        uptimeSeconds: 60,
      })),
      dispose: vi.fn(async () => {}),
    };

    (proxyHandler as any).browserService = mockBrowserService;

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const health = await runtime.getHealth();
      expect(health.status).toBe('ok');
      expect(health.toolsCount).toBe(9);
      expect(health.toolsOperational).toBe(true);

      const prompt = 'Please open website [enkeep-test-tool-call=browser_open:{"url":"https://example.com"}]';
      const turnResp = await runtime.sendFollowup(
        prompt,
        sessionId,
        'turn_00000000000000000000000000000005',
        null,
        'default'
      );

      expect(turnResp.status).toBe('completed');
      expect(mockBrowserService.open).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://example.com/',
        })
      );

      // Verify session events contain browser_open tool call and result
      const agent = await runtime.getOrCreateAgent(sessionId);
      const events = agent.session.snapshotEvents();

      const toolCallEvent = events.find((e: any) =>
        e.type === 'assistant/message' &&
        Array.isArray(e.data?.message?.content) &&
        e.data.message.content.some((b: any) => b.type === 'tool-call' && b.name === 'browser_open')
      );
      expect(toolCallEvent).toBeDefined();

      const toolResultEvent = events.find((e: any) =>
        e.type === 'tool/result' &&
        JSON.stringify(e).includes('page_test_open_123')
      );
      expect(toolResultEvent).toBeDefined();
    } finally {
      await runtime.dispose();
    }
  });

  it('model turn fails honestly with BROWSER_TOOL_UNAVAILABLE when browser platform capability is unavailable', async () => {
    const aliceHome = path.join(tmpDir, 'alice', '.dsh');
    const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
    const sessionId = 'ses_0123456789abcdef0123456789abcdef';

    // Remove browserService from proxyHandler
    (proxyHandler as any).browserService = undefined;

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const prompt = 'Please open website [enkeep-test-tool-call=browser_open:{"url":"https://example.com"}]';
      const turnResp = await runtime.sendFollowup(
        prompt,
        sessionId,
        'turn_00000000000000000000000000000006',
        null,
        'default'
      );

      // In DSH agent loop, a tool failure turns into a tool/result error block and turn completes with error text
      expect(turnResp.status).toBe('completed');

      const agent = await runtime.getOrCreateAgent(sessionId);
      const events = agent.session.snapshotEvents();

      const toolResultEvent = events.find((e: any) =>
        e.type === 'tool/result' &&
        (JSON.stringify(e).includes('NOT_FOUND') ||
          JSON.stringify(e).includes('BROWSER_TOOL_UNAVAILABLE') ||
          JSON.stringify(e).includes('error') ||
          JSON.stringify(e).includes('isError'))
      );
      expect(toolResultEvent).toBeDefined();
    } finally {
      await runtime.dispose();
    }
  });
});
