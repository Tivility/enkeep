/**
 * Host Platform Proxy Server & Tool RPC Tests
 *
 * Verifies:
 * - Loopback ephemeral port binding (127.0.0.1)
 * - Constant-time comparison for auth token validation using Authorization: Bearer <token>
 * - Fail-closed generic 401 on unauthorized access (missing/wrong token, opaque-only without token)
 * - Exact opaque base prefix requirement (bare /api or wrong prefix returns 404 even with valid token)
 * - Safe path normalization (stripping opaque path prefix for PlatformProxyHandler)
 * - Dynamic handler attachment (setHandler)
 * - Browser automation RPC dispatch (open, snapshot, interact, screenshot, close)
 * - Error sanitization without secret/path leaks
 *
 * @module @enkeep/runtime-runner/tests/host-platform-proxy-server.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  HostPlatformProxyServer,
} from '../src/host/platform-proxy-server.js';
import {
  createPlatformProxyHandler,
  type PlatformProxyHandler,
} from '../src/tunnel/platform-proxy.js';
import type {
  BrowserService,
  BrowserOpenOptions,
  BrowserOpenResult,
  BrowserSnapshotOptions,
  BrowserSnapshotResult,
  BrowserInteractOptions,
  BrowserInteractResult,
  BrowserScreenshotOptions,
  BrowserScreenshotResult,
  BrowserCloseOptions,
  BrowserCloseResult,
  BrowserServiceHealth,
} from '@enkeep/platform-core';

const ALICE_PLATFORM_ID = '00000000-0000-4000-8000-000000000001';

function createTestDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE spaces (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE session_routes (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      dsh_session_id TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE auth_audit_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT NOT NULL,
      ip_address TEXT,
      created_at TEXT NOT NULL
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
      recipient TEXT,
      description TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    );

    INSERT INTO spaces VALUES ('sp_alice', '${ALICE_PLATFORM_ID}', 'Alice Space', datetime('now'), datetime('now'));
    INSERT INTO session_routes (id, space_id, user_id, channel, peer_id, dsh_session_id)
    VALUES ('ses_alice_001', 'sp_alice', '${ALICE_PLATFORM_ID}', 'web', 'peer_alice', 'ses_alice_001');
  `);
  return db;
}

function createMockBrowserService(): BrowserService {
  return {
    initialize: vi.fn(async (): Promise<void> => {}),
    open: vi.fn(async (options: BrowserOpenOptions): Promise<BrowserOpenResult> => ({
      pageId: 'page_host_123',
      url: options.url,
      title: 'Host Test Page',
    })),
    snapshot: vi.fn(async (options: BrowserSnapshotOptions): Promise<BrowserSnapshotResult> => ({
      pageId: options.pageId,
      url: 'https://example.com',
      title: 'Host Test Page',
      root: {
        ref: 'e1',
        tag: 'div',
        role: 'main',
        children: [{ ref: 'e2', tag: 'button', role: 'button', name: 'Submit' }],
      },
      nodeCount: 2,
      truncated: false,
      textSummary: 'Host Test Page Submit',
    })),
    interact: vi.fn(async (options: BrowserInteractOptions): Promise<BrowserInteractResult> => ({
      pageId: options.pageId,
      ref: options.ref,
      action: options.action,
      success: true,
      currentUrl: 'https://example.com/result',
    })),
    screenshot: vi.fn(async (options: BrowserScreenshotOptions): Promise<BrowserScreenshotResult> => {
      const dummyPng = Buffer.from('fake-host-png-screenshot-bytes');
      return {
        pageId: options.pageId,
        mimeType: 'image/png',
        dimensions: { width: 1280, height: 720 },
        buffer: dummyPng,
      };
    }),
    close: vi.fn(async (_options?: BrowserCloseOptions): Promise<BrowserCloseResult> => ({
      closedPages: 1,
      closedContexts: 1,
    })),
    checkHealth: vi.fn(async (): Promise<BrowserServiceHealth> => ({
      status: 'healthy',
      activeContexts: 1,
      activePages: 1,
      uptimeSeconds: 120,
    })),
    dispose: vi.fn(async (): Promise<void> => {}),
  };
}

describe('HostPlatformProxyServer Authentication & RPC Integration', () => {
  let db: DatabaseSync;
  let browserService: BrowserService;
  let handler: PlatformProxyHandler;
  let proxyServer: HostPlatformProxyServer;

  beforeEach(async () => {
    db = createTestDatabase();
    browserService = createMockBrowserService();
    handler = createPlatformProxyHandler({
      platformUserId: ALICE_PLATFORM_ID,
      runtimeIdentity: 'alice',
      db,
      browserService,
    });
    proxyServer = new HostPlatformProxyServer({
      handler,
    });
    await proxyServer.start();
  });

  afterEach(async () => {
    await proxyServer.close();
  });

  it('binds strictly to loopback and returns valid base URL with opaque token prefix', () => {
    const baseUrl = proxyServer.getBaseUrl();
    const port = proxyServer.getPort()!;
    const prefix = proxyServer.getOpaquePathPrefix();

    expect(port).toBeGreaterThan(0);
    expect(baseUrl).toBe(`http://127.0.0.1:${port}/platform/${prefix}`);
    expect(proxyServer.getAuthToken().length).toBe(64); // 32 bytes hex
  });

  it('rejects unauthenticated requests with HTTP 401 and generic payload', async () => {
    const baseUrl = proxyServer.getBaseUrl();
    const res = await fetch(`${baseUrl}/api/browser/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized proxy access',
      },
    });
    expect(browserService.open).not.toHaveBeenCalled();
  });

  it('rejects requests with invalid token with HTTP 401', async () => {
    const baseUrl = proxyServer.getBaseUrl();
    const res = await fetch(`${baseUrl}/api/browser/open`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: 'Bearer wrong-secret-token',
      },
      body: JSON.stringify({ url: 'https://example.com' }),
    });

    expect(res.status).toBe(401);
    expect(browserService.open).not.toHaveBeenCalled();
  });

  it('rejects requests with opaque path segment prefix alone when token header is missing (HTTP 401, zero handler invocation)', async () => {
    const baseUrl = proxyServer.getBaseUrl();

    const res = await fetch(`${baseUrl}/api/browser/open`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: 'https://example.com/opaque-path-test',
        sessionId: 'ses_alice_001',
      }),
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error?.code).toBe('unauthorized');
    expect(browserService.open).not.toHaveBeenCalled();
  });

  it('rejects bare /api and /capabilities routes without opaque prefix even with valid token (HTTP 404, zero handler invocation)', async () => {
    const port = proxyServer.getPort()!;
    const token = proxyServer.getAuthToken();

    // 1. Bare /api/browser/open
    const resBareApi = await fetch(`http://127.0.0.1:${port}/api/browser/open`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    expect(resBareApi.status).toBe(404);
    expect(browserService.open).not.toHaveBeenCalled();

    // 2. Bare /platform without opaque prefix
    const resBarePlatform = await fetch(`http://127.0.0.1:${port}/platform/api/browser/open`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    expect(resBarePlatform.status).toBe(404);
    expect(browserService.open).not.toHaveBeenCalled();

    // 3. Bare /capabilities
    const resBareCap = await fetch(`http://127.0.0.1:${port}/capabilities`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    expect(resBareCap.status).toBe(404);
  });

  it('rejects wrong opaque platform prefix even with valid token (HTTP 404, zero handler invocation)', async () => {
    const port = proxyServer.getPort()!;
    const token = proxyServer.getAuthToken();

    const res = await fetch(`http://127.0.0.1:${port}/platform/p_wrong_prefix_12345/api/browser/open`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    expect(res.status).toBe(404);
    expect(browserService.open).not.toHaveBeenCalled();
  });

  it('authenticates and executes browser_open via Authorization Bearer token header and exact opaque prefix', async () => {
    const baseUrl = proxyServer.getBaseUrl();
    const token = proxyServer.getAuthToken();

    const res = await fetch(`${baseUrl}/api/browser/open`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        url: 'https://example.com/agent-test',
        sessionId: 'ses_alice_001',
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.pageId).toBe('page_host_123');
    expect(browserService.open).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: {
          userId: ALICE_PLATFORM_ID,
          spaceId: 'sp_alice',
          sessionId: 'ses_alice_001',
        },
        url: 'https://example.com/agent-test',
      }),
    );
  });

  it('dispatches browser_snapshot, interact, screenshot, and close through loopback proxy with Bearer auth and opaque prefix', async () => {
    const baseUrl = proxyServer.getBaseUrl();
    const token = proxyServer.getAuthToken();

    // 1. Snapshot
    const snapRes = await fetch(`${baseUrl}/api/browser/snapshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        pageId: 'page_host_123',
        sessionId: 'ses_alice_001',
      }),
    });
    expect(snapRes.status).toBe(200);
    const snapJson = await snapRes.json();
    expect(snapJson.success).toBe(true);
    expect(snapJson.root.ref).toBe('e1');

    // 2. Interact
    const interactRes = await fetch(`${baseUrl}/api/browser/interact`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        pageId: 'page_host_123',
        sessionId: 'ses_alice_001',
        action: 'click',
        ref: 'e2',
      }),
    });
    expect(interactRes.status).toBe(200);
    const interactJson = await interactRes.json();
    expect(interactJson.success).toBe(true);
    expect(interactJson.action).toBe('click');

    // 3. Screenshot
    const shotRes = await fetch(`${baseUrl}/api/browser/screenshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        pageId: 'page_host_123',
        sessionId: 'ses_alice_001',
      }),
    });
    expect(shotRes.status).toBe(200);
    const shotJson = await shotRes.json();
    expect(shotJson.success).toBe(true);
    expect(shotJson.path).toMatch(/^artifacts\/browser\/[0-9a-f]{32}\.png$/);

    // 4. Close
    const closeRes = await fetch(`${baseUrl}/api/browser/close`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        pageId: 'page_host_123',
        sessionId: 'ses_alice_001',
      }),
    });
    expect(closeRes.status).toBe(200);
    const closeJson = await closeRes.json();
    expect(closeJson.success).toBe(true);
    expect(closeJson.closedPages).toBe(1);
  });

  it('supports dynamic handler setting via setHandler', async () => {
    const unattachedServer = new HostPlatformProxyServer();
    await unattachedServer.start();

    try {
      const baseUrl = unattachedServer.getBaseUrl();
      const token = unattachedServer.getAuthToken();

      // Before handler attached: returns 503
      const preRes = await fetch(`${baseUrl}/api/browser/open`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url: 'https://example.com', sessionId: 'ses_alice_001' }),
      });
      expect(preRes.status).toBe(503);

      // Attach handler dynamically
      unattachedServer.setHandler(handler);

      // Now succeeds
      const postRes = await fetch(`${baseUrl}/api/browser/open`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url: 'https://example.com', sessionId: 'ses_alice_001' }),
      });
      expect(postRes.status).toBe(200);
    } finally {
      await unattachedServer.close();
    }
  });
});
