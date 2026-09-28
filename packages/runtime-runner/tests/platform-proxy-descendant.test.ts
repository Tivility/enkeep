/**
 * PlatformProxyHandler Descendant Route & Lineage Integration Tests (G08b Scoped Repair)
 *
 * Generic tests with real boot + actual platform proxy + fake transport without network,
 * verifying deterministic lifecycle, anti-spoofing, and end-to-end tool execution:
 * 1. Platform route operations: POST /api/routes/descendant (200), DELETE (200),
 *    GET denied/405 (diagnostic route removed), alias denied/404.
 * 2. Anti-spoofing & tenant isolation: unknown parent (403), cross-tenant access (403),
 *    unregistered random session (403).
 * 3. Real runtime lifecycle flow:
 *    parent -> spawn child -> awaited registration -> first platform tool 200 in inherited space ->
 *    dispose child -> no lingering route (subsequent calls 403).
 * 4. Failed registration rollback: child with unknown parent fails creation safely,
 *    unwinding inherited listeners without leak.
 * 5. Cold resume re-registration: cold resume of subagent re-registers route via platformClient,
 *    platform tool succeeds (200), disposal cleans up route.
 *
 * @module @enkeep/runtime-runner/tests/platform-proxy-descendant
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Duplex } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import {
  PlatformProxyHandler,
  createPlatformProxyHandler,
  PLATFORM_STREAM_KIND,
  DescendantResolver,
} from '../src/tunnel/platform-proxy.js';
import type { BrowserService, BrowserOpenResult } from '@enkeep/platform-core';
import { bootDshRuntime, type DshBootedRuntime } from '../src/runtime/dsh-boot.js';

const ALICE_PLATFORM_ID = '11111111-1111-4111-8111-111111111111';
const BOB_PLATFORM_ID = '22222222-2222-4222-8222-222222222222';

class TestDuplexStream extends Duplex {
  private chunks: Buffer[] = [];
  public responseRaw = '';

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk);
    this.responseRaw += chunk.toString('utf8');
    callback();
  }

  _read(): void {}

  pushData(data: string): void {
    this.push(Buffer.from(data, 'utf8'));
  }

  finish(): void {
    this.push(null);
  }

  getResponse(): { status: number; headers: Record<string, string>; body: any } {
    const raw = this.responseRaw;
    const headerEndIndex = raw.indexOf('\r\n\r\n');
    if (headerEndIndex === -1) {
      return { status: 0, headers: {}, body: null };
    }

    const headerPart = raw.slice(0, headerEndIndex);
    const bodyPart = raw.slice(headerEndIndex + 4);
    const lines = headerPart.split('\r\n');
    const statusLine = lines[0];
    const statusMatch = statusLine.match(/HTTP\/1\.[01]\s+(\d+)/);
    const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;

    const headers: Record<string, string> = {};
    for (let i = 1; i < lines.length; i++) {
      const idx = lines[i].indexOf(':');
      if (idx !== -1) {
        const key = lines[i].slice(0, idx).trim().toLowerCase();
        const value = lines[i].slice(idx + 1).trim();
        headers[key] = value;
      }
    }

    let body: any = null;
    try {
      body = JSON.parse(bodyPart);
    } catch {
      body = bodyPart;
    }

    return { status, headers, body };
  }
}

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

    INSERT INTO spaces (id, user_id, name, folder) VALUES ('sp_alice', '${ALICE_PLATFORM_ID}', 'Workspace Alice', 'alice-space');
    INSERT INTO spaces (id, user_id, name, folder) VALUES ('sp_bob', '${BOB_PLATFORM_ID}', 'Workspace Bob', 'bob-space');

    CREATE TABLE session_routes (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      dsh_session_id TEXT NOT NULL
    );

    INSERT INTO session_routes (id, space_id, user_id, channel, peer_id, dsh_session_id)
    VALUES ('sr_alice_root', 'sp_alice', '${ALICE_PLATFORM_ID}', 'web', 'peer_alice', 'ses_00000000000000000000000000000001');

    INSERT INTO session_routes (id, space_id, user_id, channel, peer_id, dsh_session_id)
    VALUES ('sr_bob_root', 'sp_bob', '${BOB_PLATFORM_ID}', 'web', 'peer_bob', 'ses_00000000000000000000000000000002');
  `);

  return db;
}

function createMockBrowserService(): BrowserService {
  return {
    open: vi.fn(async (params): Promise<BrowserOpenResult> => ({
      pageId: `page_${Date.now()}`,
      url: params.url,
      title: 'Mock Document Page',
    })),
    getSnapshot: vi.fn(async () => ({
      pageId: 'page_mock',
      url: 'https://internal.test.local/doc',
      title: 'Mock Snapshot',
      domTree: '<html><body>Mock content</body></html>',
    })),
    interact: vi.fn(async () => ({
      pageId: 'page_mock',
      success: true,
    })),
    takeScreenshot: vi.fn(async () => ({
      pageId: 'page_mock',
      imageBytes: Buffer.from('mock-png'),
      mimeType: 'image/png',
    })),
    close: vi.fn(async () => ({
      closed: true,
    })),
    checkHealth: vi.fn(async () => ({
      status: 'healthy',
      activeContexts: 1,
      activePages: 1,
      uptimeSeconds: 100,
    })),
  };
}

async function sendTunnelRequest(
  handler: PlatformProxyHandler,
  runtimeUserId: string,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ status: number; headers: Record<string, string>; body: any }> {
  const stream = new TestDuplexStream();
  const bodyBuffer = body ? Buffer.from(JSON.stringify(body), 'utf8') : Buffer.alloc(0);
  const reqStr = `${method} ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${bodyBuffer.length}\r\n\r\n`;

  const handlePromise = handler.handle(stream, {
    kind: PLATFORM_STREAM_KIND,
    userId: runtimeUserId,
  });

  stream.pushData(reqStr);
  if (bodyBuffer.length > 0) {
    stream.push(bodyBuffer);
  }
  stream.finish();

  await handlePromise;
  return stream.getResponse();
}

/**
 * Creates an in-memory platform client wrapping the actual PlatformProxyHandler over
 * the stdio multiplexed tunnel protocol without requiring network sockets.
 */
function createTunnelPlatformClient(handler: PlatformProxyHandler, runtimeUserId = 'alice') {
  return {
    async request<T = any>(reqPath: string, options?: any) {
      const method = (options?.method ?? 'GET').toUpperCase();
      const body = options?.body;
      const res = await sendTunnelRequest(handler, runtimeUserId, method, reqPath, body);
      return {
        status: res.status,
        headers: res.headers,
        body: res.body as T,
        data: res.body?.data,
      };
    },
  };
}

describe('PlatformProxyHandler Descendant Route Resolution & Lifecycle (G08b)', () => {
  let db: DatabaseSync;
  let browserService: BrowserService;
  let aliceHandler: PlatformProxyHandler;
  let bobHandler: PlatformProxyHandler;
  let tmpDir: string;
  let dshHome: string;
  let spacesDir: string;
  let spaceAlphaPath: string;
  let runtime: DshBootedRuntime | undefined;
  const trackedHandles: AgentHandle[] = [];

  beforeEach(() => {
    db = createTestDatabase();
    browserService = createMockBrowserService();

    aliceHandler = createPlatformProxyHandler({
      platformUserId: ALICE_PLATFORM_ID,
      runtimeIdentity: 'alice',
      db,
      browserService,
    });

    bobHandler = createPlatformProxyHandler({
      platformUserId: BOB_PLATFORM_ID,
      runtimeIdentity: 'bob',
      db,
      browserService,
    });
  });

  afterEach(async () => {
    for (const h of trackedHandles) {
      try {
        await h.dispose();
      } catch {}
    }
    trackedHandles.length = 0;

    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }

    if (tmpDir && fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  // Test 1: Single internal registration and unregistration, no GET diagnostic, no aliases
  it('1. registers and unregisters descendant route via single internal route; denies GET and alias routes', async () => {
    const childSessionId = 'ses_child_alice_001';
    const parentSessionId = 'sr_alice_root';

    // 1a. POST valid registration -> 200 OK
    const res = await sendTunnelRequest(aliceHandler, 'alice', 'POST', '/api/routes/descendant', {
      childSessionId,
      parentSessionId,
      origin: 'subagent',
      metadata: { delegationDepth: 1 },
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.childSessionId).toBe(childSessionId);
    expect(res.body.data.parentSessionId).toBe(parentSessionId);
    expect(res.body.data.spaceId).toBe('sp_alice');
    expect(res.body.data.origin).toBe('subagent');

    // 1b. GET diagnostic route is removed -> 405 Method Not Allowed
    const getRes = await sendTunnelRequest(
      aliceHandler,
      'alice',
      'GET',
      `/api/routes/descendant/${childSessionId}`
    );
    expect(getRes.status).toBe(405);

    // 1c. Alias route /api/internal/session-routes/descendant is removed -> 404 Not Found
    const aliasRes = await sendTunnelRequest(
      aliceHandler,
      'alice',
      'POST',
      '/api/internal/session-routes/descendant',
      { childSessionId, parentSessionId }
    );
    expect(aliasRes.status).toBe(404);

    // 1d. DELETE unregister -> 200 OK
    const delRes = await sendTunnelRequest(
      aliceHandler,
      'alice',
      'DELETE',
      `/api/routes/descendant/${childSessionId}`
    );
    expect(delRes.status).toBe(200);
    expect(delRes.body.data.unregistered).toBe(true);
  });

  // Test 2: Anti-spoofing and cross-tenant isolation
  it('2. denies unknown parent registration, cross-tenant child access, and unregistered sibling sessions', async () => {
    // 2a. Alice tries to register a child claiming Bob's parent session -> 403 Forbidden
    const spoofRegisterRes = await sendTunnelRequest(
      aliceHandler,
      'alice',
      'POST',
      '/api/routes/descendant',
      {
        childSessionId: 'ses_spoofed_child',
        parentSessionId: 'sr_bob_root', // Belongs to Bob, not Alice
        origin: 'subagent',
      }
    );
    expect(spoofRegisterRes.status).toBe(403);
    expect(spoofRegisterRes.body.error.code).toBe('FORBIDDEN');

    // 2b. Unknown/non-existent parent session -> 403 Forbidden
    const unknownParentRes = await sendTunnelRequest(
      aliceHandler,
      'alice',
      'POST',
      '/api/routes/descendant',
      {
        childSessionId: 'ses_unknown_child',
        parentSessionId: 'sr_nonexistent_parent',
        origin: 'subagent',
      }
    );
    expect(unknownParentRes.status).toBe(403);
    expect(unknownParentRes.body.error.code).toBe('FORBIDDEN');

    // 2c. Register legitimate Alice child
    await aliceHandler.registerDescendantRoute({
      childSessionId: 'ses_child_alice_isolated',
      parentSessionId: 'sr_alice_root',
      origin: 'subagent',
    });

    // Bob tries to access Alice's child session via browser/open -> 403 Forbidden
    const bobCrossTenantRes = await sendTunnelRequest(bobHandler, 'bob', 'POST', '/api/browser/open', {
      url: 'https://internal.test.local/doc',
      sessionId: 'ses_child_alice_isolated',
    });
    expect(bobCrossTenantRes.status).toBe(403);
    expect(bobCrossTenantRes.body.error.code).toBe('FORBIDDEN');

    // 2d. Unregistered random sibling session -> 403 Forbidden
    const unregisteredRes = await sendTunnelRequest(aliceHandler, 'alice', 'POST', '/api/browser/open', {
      url: 'https://internal.test.local/doc',
      sessionId: 'ses_unregistered_sibling_random',
    });
    expect(unregisteredRes.status).toBe(403);
    expect(unregisteredRes.body.error.code).toBe('FORBIDDEN');
  });

  // Test 3: Real runtime lifecycle: parent -> spawn -> first platform tool 200 -> dispose -> no lingering route
  it('3. realboot runtime: parent -> spawn -> first platform tool 200 -> dispose -> no lingering route', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-g08b-e2e-'));
    dshHome = path.join(tmpDir, '.dsh');
    spacesDir = path.join(tmpDir, 'spaces');
    spaceAlphaPath = path.join(spacesDir, 'space-alpha');

    fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spaceAlphaPath, { recursive: true, mode: 0o700 });

    const fakeClient = createTunnelPlatformClient(aliceHandler, 'alice');

    // Boot real DSH runtime with fake platform client transport
    runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome,
      spacesDir,
      platformClient: fakeClient,
    });

    // 1. Create parent agent in runtime and register its route in test DB
    const parentSessionId = 'ses_00000000000000000000000000000001';
    const parentAgent = await runtime.getOrCreateAgent(parentSessionId, null, 'space-alpha');
    expect(parentAgent).toBeDefined();

    const childSessionId = 'ses_00000000000000000000000000000011';

    // 2. Spawn child subagent via agents.create; setup synchronously binds scope/fs AND awaits registration with platform
    const childHandle = await runtime.context.agents.create({
      sessionId: SessionId(childSessionId),
      meta: {
        origin: 'subagent',
        parentSession: SessionId(parentSessionId),
        cwd: spaceAlphaPath,
      },
    });
    trackedHandles.push(childHandle);

    expect(childHandle.agent.id).toBe(childSessionId);

    // Verify child route was automatically registered in DescendantResolver before creation resolved
    const routeBefore = await aliceHandler.resolveSessionRoute(childSessionId);
    expect(routeBefore).not.toBeNull();
    expect(routeBefore?.matchedSpaceId).toBe('sp_alice');
    expect(routeBefore?.parentSessionId).toBe('sr_alice_root');

    // 3. Child executes first platform tool: POST /api/browser/open using childSessionId -> 200 OK
    const toolRes = await sendTunnelRequest(aliceHandler, 'alice', 'POST', '/api/browser/open', {
      url: 'https://internal.test.local/doc',
      sessionId: childSessionId,
    });

    expect(toolRes.status).toBe(200);
    expect(toolRes.body.success).toBe(true);
    expect(toolRes.body.pageId).toBeDefined();
    expect(browserService.open).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: {
          userId: ALICE_PLATFORM_ID,
          spaceId: 'sp_alice',
          sessionId: childSessionId,
        },
        url: 'https://internal.test.local/doc',
      })
    );

    // 4. Dispose child subagent
    await childHandle.dispose();

    // 5. Verify no lingering route remains
    const routeAfter = await aliceHandler.resolveSessionRoute(childSessionId);
    expect(routeAfter).toBeNull();
    expect(aliceHandler.getDescendantResolver().resolve(childSessionId, ALICE_PLATFORM_ID)).toBeUndefined();

    // Subsequent tool call returns 403 Forbidden
    const toolResAfter = await sendTunnelRequest(aliceHandler, 'alice', 'POST', '/api/browser/open', {
      url: 'https://internal.test.local/doc',
      sessionId: childSessionId,
    });
    expect(toolResAfter.status).toBe(403);
    expect(toolResAfter.body.error.code).toBe('FORBIDDEN');
  });

  // Test 4: Registration failure safely aborts child creation and rolls back listeners without leaking
  it('4. registration failure aborts child creation and rolls back inherited listeners without leak', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-g08b-abort-'));
    dshHome = path.join(tmpDir, '.dsh');
    spacesDir = path.join(tmpDir, 'spaces');
    spaceAlphaPath = path.join(spacesDir, 'space-alpha');

    fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spaceAlphaPath, { recursive: true, mode: 0o700 });

    const fakeClient = createTunnelPlatformClient(aliceHandler, 'alice');

    runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome,
      spacesDir,
      platformClient: fakeClient,
    });

    const parentSessionId = 'ses_00000000000000000000000000000001';
    await runtime.getOrCreateAgent(parentSessionId, null, 'space-alpha');

    // Create a parent that exists in DSH but is NOT authorized on the platform proxy
    const unauthorizedParentId = 'ses_00000000000000000000000000000099';
    await runtime.getOrCreateAgent(unauthorizedParentId, null, 'space-alpha');

    const failingChildId = 'ses_00000000000000000000000000000098';

    // Creating child linked to unauthorized parent should fail registration with HTTP 403 and abort creation
    await expect(
      runtime.context.agents.create({
        sessionId: SessionId(failingChildId),
        meta: {
          origin: 'subagent',
          parentSession: SessionId(unauthorizedParentId),
          cwd: spaceAlphaPath,
        },
      })
    ).rejects.toThrow(/Failed to register subagent descendant route/);

    // Verify child agent was never published into the registry
    expect(runtime.context.agents.get(SessionId(failingChildId))).toBeUndefined();

    // Verify no lingering route exists
    expect(aliceHandler.getDescendantResolver().resolve(failingChildId, ALICE_PLATFORM_ID)).toBeUndefined();
  });

  // Test 5: Cold resume re-registers descendant route using trusted header and known parent route
  it('5. cold resume re-registers descendant route using trusted header and known parent route', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-g08b-resume-'));
    dshHome = path.join(tmpDir, '.dsh');
    spacesDir = path.join(tmpDir, 'spaces');
    spaceAlphaPath = path.join(spacesDir, 'space-alpha');

    fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spaceAlphaPath, { recursive: true, mode: 0o700 });

    const fakeClient = createTunnelPlatformClient(aliceHandler, 'alice');

    runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome,
      spacesDir,
      platformClient: fakeClient,
    });

    const parentSessionId = 'ses_00000000000000000000000000000001';
    await runtime.getOrCreateAgent(parentSessionId, null, 'space-alpha');

    const childSessionId = 'ses_00000000000000000000000000000021';

    // 1. First spawn child
    const initialHandle = await runtime.context.agents.create({
      sessionId: SessionId(childSessionId),
      meta: {
        origin: 'subagent',
        parentSession: SessionId(parentSessionId),
        cwd: spaceAlphaPath,
      },
    });

    // Dispose initial handle and simulate server restart: clear memory resolver
    await initialHandle.dispose();
    aliceHandler.getDescendantResolver().clear();
    expect(aliceHandler.getDescendantResolver().resolve(childSessionId, ALICE_PLATFORM_ID)).toBeUndefined();

    // 2. Cold resume child agent: reads persisted session header, re-registers route with platform
    const resumedHandle = await runtime.context.agents.resume({
      resumeSessionId: SessionId(childSessionId),
    });
    trackedHandles.push(resumedHandle);

    // Route should be re-registered in DescendantResolver
    const routeAfterResume = await aliceHandler.resolveSessionRoute(childSessionId);
    expect(routeAfterResume).not.toBeNull();
    expect(routeAfterResume?.matchedSpaceId).toBe('sp_alice');

    // 3. Child executes platform tool -> 200 OK
    const toolRes = await sendTunnelRequest(aliceHandler, 'alice', 'POST', '/api/browser/open', {
      url: 'https://internal.test.local/doc',
      sessionId: childSessionId,
    });
    expect(toolRes.status).toBe(200);

    // 4. Dispose cleans up route
    await resumedHandle.dispose();
    expect(aliceHandler.getDescendantResolver().resolve(childSessionId, ALICE_PLATFORM_ID)).toBeUndefined();
  });
});
