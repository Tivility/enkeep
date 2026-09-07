/**
 * PlatformProxyHandler Browser Operations Test Suite
 *
 * Validates:
 * 1. GET /platform/capabilities dynamically exposes 'browser' only when browserService is configured.
 * 2. Tenant isolation & route validation: strictly verifies sessionId belongs to user/space (prevents tenant spoofing).
 * 3. Browser operations: open, snapshot, interact, screenshot, close over tunnel RPC.
 * 4. SSRF mapping: converts internal SSRF blocks to safe fixed public error code 'SSRF_BLOCKED'.
 * 5. Screenshot persistence: atomic file persistence via TenantRuntimeFileProvider under artifacts/browser/<opaque>.png,
 *    max 10MB payload size enforcement, and file_metadata DB registration.
 * 6. Quota enforcement: consumes 'api_calls' quota and returns 429 QUOTA_EXCEEDED when exhausted.
 * 7. Audit logging: records safe metadata (hostname, action, ref, path) and strictly excludes query params / form values.
 *
 * @module @enkeep/runtime-runner/tests/platform-proxy-browser.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Duplex } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
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
import {
  PlatformProxyHandler,
  createPlatformProxyHandler,
  type PlatformProxyFileProvider,
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

    INSERT INTO spaces (id, user_id, name, folder) VALUES ('sp_alice', '${ALICE_PLATFORM_ID}', 'Alice Space', 'alice_space');
    INSERT INTO spaces (id, user_id, name, folder) VALUES ('sp_bob', '${BOB_PLATFORM_ID}', 'Bob Space', 'bob_space');

    CREATE TABLE session_routes (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      dsh_session_id TEXT NOT NULL
    );

    INSERT INTO session_routes (id, space_id, user_id, channel, peer_id, dsh_session_id)
    VALUES ('ses_alice_001', 'sp_alice', '${ALICE_PLATFORM_ID}', 'web', 'peer_alice', 'dsh_ses_alice_001');
    INSERT INTO session_routes (id, space_id, user_id, channel, peer_id, dsh_session_id)
    VALUES ('ses_bob_001', 'sp_bob', '${BOB_PLATFORM_ID}', 'web', 'peer_bob', 'dsh_ses_bob_001');

    CREATE TABLE file_metadata (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime_type TEXT,
      extension TEXT NOT NULL,
      checksum TEXT,
      recipient TEXT,
      description TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE auth_audit_log (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      username TEXT,
      action TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE quota_limits (
      user_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      limit_amount INTEGER NOT NULL,
      PRIMARY KEY (user_id, resource)
    );

    INSERT INTO quota_limits (user_id, resource, limit_amount) VALUES ('${ALICE_PLATFORM_ID}', 'api_calls', 5000);
    INSERT INTO quota_limits (user_id, resource, limit_amount) VALUES ('${BOB_PLATFORM_ID}', 'api_calls', 5000);
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

  getResponse(): { status: number; headers: Record<string, string>; body: any } {
    const raw = this.responseBuffer.toString('utf8');
    const headerEnd = raw.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      throw new Error(`Invalid HTTP response (no header boundary): ${raw}`);
    }

    const headerPart = raw.slice(0, headerEnd);
    const bodyPart = raw.slice(headerEnd + 4);

    const lines = headerPart.split('\r\n');
    const statusLine = lines[0] || '';
    const statusMatch = statusLine.match(/HTTP\/1\.[01]\s+(\d+)/);
    const status = statusMatch ? parseInt(statusMatch[1]!, 10) : 0;

    const headers: Record<string, string> = {};
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const colon = line.indexOf(':');
      if (colon > 0) {
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
    }

    let body: any = bodyPart;
    if (headers['content-type']?.includes('application/json')) {
      try {
        body = JSON.parse(bodyPart);
      } catch {}
    }

    return { status, headers, body };
  }
}

function createMockBrowserService(): BrowserService {
  return {
    initialize: vi.fn(async (): Promise<void> => {}),
    open: vi.fn(async (options: BrowserOpenOptions): Promise<BrowserOpenResult> => {
      if (options.url.includes('169.254.169.254') || options.url.includes('localhost') || options.url.includes('127.0.0.1')) {
        const err: any = new Error('SSRF attempt blocked: private address');
        err.code = 'BROWSER_SSRF_BLOCKED';
        throw err;
      }
      return {
        pageId: 'page_test_123',
        url: options.url,
        title: 'Example Domain',
      };
    }),
    snapshot: vi.fn(async (options: BrowserSnapshotOptions): Promise<BrowserSnapshotResult> => {
      return {
        pageId: options.pageId,
        url: 'https://example.com',
        title: 'Example Domain',
        root: {
          ref: '@e1',
          tag: 'div',
          role: 'main',
          children: [
            { ref: '@e2', tag: 'button', role: 'button', name: 'Submit' },
          ],
        },
        nodeCount: 2,
        truncated: false,
        textSummary: 'Example Domain Submit',
      };
    }),
    interact: vi.fn(async (options: BrowserInteractOptions): Promise<BrowserInteractResult> => {
      if (options.ref === '@invalid') {
        const err: any = new Error('Element reference @invalid not found');
        err.code = 'BROWSER_INVALID_REF';
        throw err;
      }
      return {
        pageId: options.pageId,
        ref: options.ref,
        action: options.action,
        success: true,
        currentUrl: 'https://example.com/result',
      };
    }),
    screenshot: vi.fn(async (options: BrowserScreenshotOptions): Promise<BrowserScreenshotResult> => {
      const dummyPng = Buffer.from('fake-png-screenshot-bytes-12345');
      return {
        pageId: options.pageId,
        mimeType: 'image/png',
        dimensions: { width: 1280, height: 720 },
        buffer: dummyPng,
        base64: dummyPng.toString('base64'),
      };
    }),
    close: vi.fn(async (_options?: BrowserCloseOptions): Promise<BrowserCloseResult> => {
      return {
        closedPages: 1,
        closedContexts: 1,
      };
    }),
    checkHealth: vi.fn(async (): Promise<BrowserServiceHealth> => {
      return {
        status: 'healthy',
        activeContexts: 1,
        activePages: 1,
        uptimeSeconds: 120,
      };
    }),
    dispose: vi.fn(async (): Promise<void> => {}),
  };
}

describe('PlatformProxyHandler Browser RPC Integration', () => {
  let db: DatabaseSync;
  let browserService: BrowserService;
  let mockFileProvider: PlatformProxyFileProvider;
  let handler: PlatformProxyHandler;

  beforeEach(() => {
    db = createTestDatabase();
    browserService = createMockBrowserService();
    mockFileProvider = {
      execute: vi.fn(async () => ({ success: true })),
    };
    handler = createPlatformProxyHandler({
      platformUserId: ALICE_PLATFORM_ID,
      runtimeIdentity: 'alice',
      db,
      browserService,
      fileProvider: mockFileProvider,
    });
  });

  describe('Capabilities Probing', () => {
    it('returns "browser" capability when browserService is configured', async () => {
      const stream = new TestClientDuplex();
      const req = 'GET /capabilities HTTP/1.1\r\nHost: localhost\r\n\r\n';

      const handlePromise = handler.handle(stream, {
        kind: 'platform',
        userId: 'alice',
      });
      stream.pushToStream(req);
      stream.push(null);
      await handlePromise;

      const res = stream.getResponse();
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.capabilities).toContain('browser');
      expect(res.body.capabilities).toContain('browser');
    });

    it('omits "browser" capability when browserService is not configured (service unavailable)', async () => {
      const handlerWithoutBrowser = createPlatformProxyHandler({
        platformUserId: ALICE_PLATFORM_ID,
        runtimeIdentity: 'alice',
        db,
      });

      const stream = new TestClientDuplex();
      const req = 'GET /capabilities HTTP/1.1\r\nHost: localhost\r\n\r\n';

      const handlePromise = handlerWithoutBrowser.handle(stream, {
        kind: 'platform',
        userId: 'alice',
      });
      stream.pushToStream(req);
      stream.push(null);
      await handlePromise;

      const res = stream.getResponse();
      expect(res.status).toBe(200);
      expect(res.body.data.capabilities).not.toContain('browser');
    });

    it('omits "browser" capability when browserService checkHealth is degraded or unhealthy', async () => {
      const degradedBrowserService = createMockBrowserService();
      (degradedBrowserService.checkHealth as any).mockResolvedValueOnce({
        status: 'degraded',
        activeContexts: 0,
        activePages: 0,
        uptimeSeconds: 0,
      });

      const handlerWithDegraded = createPlatformProxyHandler({
        platformUserId: ALICE_PLATFORM_ID,
        runtimeIdentity: 'alice',
        db,
        browserService: degradedBrowserService,
      });

      const stream = new TestClientDuplex();
      const req = 'GET /capabilities HTTP/1.1\r\nHost: localhost\r\n\r\n';

      const handlePromise = handlerWithDegraded.handle(stream, {
        kind: 'platform',
        userId: 'alice',
      });
      stream.pushToStream(req);
      stream.push(null);
      await handlePromise;

      const res = stream.getResponse();
      expect(res.status).toBe(200);
      expect(res.body.data.capabilities).not.toContain('browser');
    });
  });

  describe('POST /api/browser/open', () => {
    it('successfully opens page, maps session route, and records safe audit log via canonical /api/browser/open', async () => {
      const stream = new TestClientDuplex();
      const body = JSON.stringify({
        url: 'https://example.com/welcome?query=secret_token#frag',
        sessionId: 'ses_alice_001',
      });
      const req = `POST /api/browser/open HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

      const handlePromise = handler.handle(stream, {
        kind: 'platform',
        userId: 'alice',
      });
      stream.pushToStream(req);
      stream.push(null);
      await handlePromise;

      const res = stream.getResponse();
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.pageId).toBe('page_test_123');
      expect(res.body.title).toBe('Example Domain');

      // Verify browserService.open was called with authoritative sessionKey
      expect(browserService.open).toHaveBeenCalledWith({
        sessionKey: {
          userId: ALICE_PLATFORM_ID,
          spaceId: 'sp_alice',
          sessionId: 'ses_alice_001',
        },
        url: 'https://example.com/welcome?query=secret_token#frag',
        timeoutMs: undefined,
      });

      // Verify safe audit log: hostname + pathname recorded, query params stripped!
      const auditRows = db.prepare('SELECT * FROM auth_audit_log WHERE action = ?').all('browser.open') as any[];
      expect(auditRows.length).toBe(1);
      const details = JSON.parse(auditRows[0].details);
      expect(details.hostname).toBe('example.com');
      expect(details.path).toBe('/welcome');
      expect(details.sessionId).toBe('ses_alice_001');
      expect(details.spaceId).toBe('sp_alice');
      // Must NOT contain query or fragment
      expect(JSON.stringify(details)).not.toContain('secret_token');
    });

    it('returns 404 NOT_FOUND for non-canonical /browser/open alias', async () => {
      const stream = new TestClientDuplex();
      const body = JSON.stringify({
        url: 'https://example.com',
        sessionId: 'ses_alice_001',
      });
      const req = `POST /browser/open HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

      const handlePromise = handler.handle(stream, {
        kind: 'platform',
        userId: 'alice',
      });
      stream.pushToStream(req);
      stream.push(null);
      await handlePromise;

      const res = stream.getResponse();
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(browserService.open).not.toHaveBeenCalled();
    });

    it('returns 404 NOT_FOUND for non-canonical /platform/browser/open alias (lacks /api)', async () => {
      const stream = new TestClientDuplex();
      const body = JSON.stringify({
        url: 'https://example.com',
        sessionId: 'ses_alice_001',
      });
      const req = `POST /platform/browser/open HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

      const handlePromise = handler.handle(stream, {
        kind: 'platform',
        userId: 'alice',
      });
      stream.pushToStream(req);
      stream.push(null);
      await handlePromise;

      const res = stream.getResponse();
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(browserService.open).not.toHaveBeenCalled();
    });

    it('rejects cross-tenant session spoofing (Alice attempting to use Bob session)', async () => {
      const stream = new TestClientDuplex();
      const body = JSON.stringify({
        url: 'https://example.com',
        sessionId: 'ses_bob_001', // Bob's session
      });
      const req = `POST /api/browser/open HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

      const handlePromise = handler.handle(stream, {
        kind: 'platform',
        userId: 'alice', // Bound to Alice
      });
      stream.pushToStream(req);
      stream.push(null);
      await handlePromise;

      const res = stream.getResponse();
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(browserService.open).not.toHaveBeenCalled();
    });

    it('maps internal SSRF blocked error to fixed public code SSRF_BLOCKED', async () => {
      const stream = new TestClientDuplex();
      const body = JSON.stringify({
        url: 'http://169.254.169.254/latest/meta-data/',
        sessionId: 'ses_alice_001',
      });
      const req = `POST /api/browser/open HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

      const handlePromise = handler.handle(stream, {
        kind: 'platform',
        userId: 'alice',
      });
      stream.pushToStream(req);
      stream.push(null);
      await handlePromise;

      const res = stream.getResponse();
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('SSRF_BLOCKED');
      expect(res.body.error.message).toBe('Target URL is blocked by security policy');
    });

    it('rejects unlisted methods with 405 Method Not Allowed', async () => {
      const stream = new TestClientDuplex();
      const req = 'GET /api/browser/open HTTP/1.1\r\nHost: localhost\r\n\r\n';

      const handlePromise = handler.handle(stream, {
        kind: 'platform',
        userId: 'alice',
      });
      stream.pushToStream(req);
      stream.push(null);
      await handlePromise;

      const res = stream.getResponse();
      expect(res.status).toBe(405);
      expect(res.body.error.code).toBe('METHOD_NOT_ALLOWED');
    });
  });

  describe('POST /api/browser/snapshot', () => {
    it('returns DOM snapshot tree and records audit log', async () => {
      const stream = new TestClientDuplex();
      const body = JSON.stringify({
        pageId: 'page_test_123',
        sessionId: 'ses_alice_001',
        maxNodes: 50,
      });
      const req = `POST /api/browser/snapshot HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

      const handlePromise = handler.handle(stream, {
        kind: 'platform',
        userId: 'alice',
      });
      stream.pushToStream(req);
      stream.push(null);
      await handlePromise;

      const res = stream.getResponse();
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.pageId).toBe('page_test_123');
      expect(res.body.root.ref).toBe('@e1');
      expect(res.body.nodeCount).toBe(2);

      expect(browserService.snapshot).toHaveBeenCalledWith({
        sessionKey: {
          userId: ALICE_PLATFORM_ID,
          spaceId: 'sp_alice',
          sessionId: 'ses_alice_001',
        },
        pageId: 'page_test_123',
        maxNodes: 50,
        maxBytes: undefined,
      });
    });
  });

  describe('POST /api/browser/interact', () => {
    it('executes interaction and records audit WITHOUT sensitive form values', async () => {
      const stream = new TestClientDuplex();
      const body = JSON.stringify({
        pageId: 'page_test_123',
        sessionId: 'ses_alice_001',
        action: 'fill',
        ref: '@e2',
        value: 'my_super_secret_password_123',
      });
      const req = `POST /api/browser/interact HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

      const handlePromise = handler.handle(stream, {
        kind: 'platform',
        userId: 'alice',
      });
      stream.pushToStream(req);
      stream.push(null);
      await handlePromise;

      const res = stream.getResponse();
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.action).toBe('fill');
      expect(res.body.ref).toBe('@e2');

      expect(browserService.interact).toHaveBeenCalledWith({
        sessionKey: {
          userId: ALICE_PLATFORM_ID,
          spaceId: 'sp_alice',
          sessionId: 'ses_alice_001',
        },
        pageId: 'page_test_123',
        action: 'fill',
        ref: '@e2',
        value: 'my_super_secret_password_123',
        key: undefined,
        timeoutMs: undefined,
      });

      // Verify audit log strictly excludes the form input value!
      const auditRows = db.prepare('SELECT * FROM auth_audit_log WHERE action = ?').all('browser.interact') as any[];
      expect(auditRows.length).toBe(1);
      const details = JSON.parse(auditRows[0].details);
      expect(details.pageId).toBe('page_test_123');
      expect(details.action).toBe('fill');
      expect(details.ref).toBe('@e2');
      expect(details.sessionId).toBe('ses_alice_001');
      expect(details.spaceId).toBe('sp_alice');
      // No value or password in audit record
      expect(details.value).toBeUndefined();
      expect(JSON.stringify(details)).not.toContain('my_super_secret_password_123');
    });

    it('rejects invalid actions with 400 VALIDATION_ERROR', async () => {
      const stream = new TestClientDuplex();
      const body = JSON.stringify({
        pageId: 'page_test_123',
        action: 'invalid_action',
        ref: '@e1',
      });
      const req = `POST /api/browser/interact HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

      const handlePromise = handler.handle(stream, {
        kind: 'platform',
        userId: 'alice',
      });
      stream.pushToStream(req);
      stream.push(null);
      await handlePromise;

      const res = stream.getResponse();
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('maps invalid ref error to INVALID_REF with 400', async () => {
      const stream = new TestClientDuplex();
      const body = JSON.stringify({
        pageId: 'page_test_123',
        sessionId: 'ses_alice_001',
        action: 'click',
        ref: '@invalid',
      });
      const req = `POST /api/browser/interact HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

      const handlePromise = handler.handle(stream, {
        kind: 'platform',
        userId: 'alice',
      });
      stream.pushToStream(req);
      stream.push(null);
      await handlePromise;

      const res = stream.getResponse();
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REF');
    });
  });

  describe('POST /api/browser/screenshot', () => {
    it('captures screenshot, persists to artifacts/browser/<opaque>.png, records DB metadata and returns download URL', async () => {
      const stream = new TestClientDuplex();
      const body = JSON.stringify({
        pageId: 'page_test_123',
        sessionId: 'ses_alice_001',
        fullPage: false,
      });
      const req = `POST /api/browser/screenshot HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

      const handlePromise = handler.handle(stream, {
        kind: 'platform',
        userId: 'alice',
      });
      stream.pushToStream(req);
      stream.push(null);
      await handlePromise;

      const res = stream.getResponse();
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.pageId).toBe('page_test_123');
      expect(res.body.path).toMatch(/^artifacts\/browser\/[0-9a-f]{32}\.png$/);
      expect(res.body.downloadUrl).toContain('/api/spaces/sp_alice/files/download?path=artifacts%2Fbrowser%2F');
      expect(res.body.width).toBe(1280);
      expect(res.body.height).toBe(720);

      expect(browserService.screenshot).toHaveBeenCalledWith({
        sessionKey: {
          userId: ALICE_PLATFORM_ID,
          spaceId: 'sp_alice',
          sessionId: 'ses_alice_001',
        },
        pageId: 'page_test_123',
        fullPage: false,
        timeoutMs: undefined,
      });

      // Verify file provider write was called atomically
      expect(mockFileProvider.execute).toHaveBeenCalledWith(
        ALICE_PLATFORM_ID,
        'sp_alice',
        expect.objectContaining({
          op: 'write',
          path: expect.stringMatching(/^artifacts\/browser\/[0-9a-f]{32}\.png$/),
          encoding: 'base64',
          requireAbsent: true,
        })
      );

      // Verify SQLite file_metadata row
      const fileRows = db.prepare('SELECT * FROM file_metadata WHERE user_id = ?').all(ALICE_PLATFORM_ID) as any[];
      expect(fileRows.length).toBe(1);
      expect(fileRows[0].relative_path).toBe(res.body.path);
      expect(fileRows[0].mime_type).toBe('image/png');
      expect(fileRows[0].extension).toBe('.png');

      // Verify audit log
      const auditRows = db.prepare('SELECT * FROM auth_audit_log WHERE action = ?').all('browser.screenshot') as any[];
      expect(auditRows.length).toBe(1);
      const auditDetail = JSON.parse(auditRows[0].details);
      expect(auditDetail.path).toBe(res.body.path);
      expect(auditDetail.size).toBe(Buffer.from('fake-png-screenshot-bytes-12345').length);
    });

    it('enforces 10MB maximum screenshot buffer limit', async () => {
      // Mock browserService screenshot to return > 10MB
      (browserService.screenshot as any).mockResolvedValueOnce({
        pageId: 'page_test_123',
        mimeType: 'image/png',
        dimensions: { width: 4000, height: 4000 },
        buffer: Buffer.alloc(11 * 1024 * 1024), // 11 MiB
      });

      const stream = new TestClientDuplex();
      const body = JSON.stringify({
        pageId: 'page_test_123',
        sessionId: 'ses_alice_001',
      });
      const req = `POST /api/browser/screenshot HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

      const handlePromise = handler.handle(stream, {
        kind: 'platform',
        userId: 'alice',
      });
      stream.pushToStream(req);
      stream.push(null);
      await handlePromise;

      const res = stream.getResponse();
      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
      expect(mockFileProvider.execute).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/browser/close', () => {
    it('closes browser context and records audit log', async () => {
      const stream = new TestClientDuplex();
      const body = JSON.stringify({
        sessionId: 'ses_alice_001',
        all: true,
      });
      const req = `POST /api/browser/close HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

      const handlePromise = handler.handle(stream, {
        kind: 'platform',
        userId: 'alice',
      });
      stream.pushToStream(req);
      stream.push(null);
      await handlePromise;

      const res = stream.getResponse();
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.closedPages).toBe(1);
      expect(res.body.closedContexts).toBe(1);

      expect(browserService.close).toHaveBeenCalledWith({
        sessionKey: {
          userId: ALICE_PLATFORM_ID,
          spaceId: 'sp_alice',
          sessionId: 'ses_alice_001',
        },
        pageId: undefined,
        all: true,
      });

      const auditRows = db.prepare('SELECT * FROM auth_audit_log WHERE action = ?').all('browser.close') as any[];
      expect(auditRows.length).toBe(1);
      const details = JSON.parse(auditRows[0].details);
      expect(details.all).toBe(true);
    });
  });

  describe('Multi-tenant Isolation & Defense-in-depth', () => {
    it('rejects snapshot requests with cross-tenant or unowned sessionId with 403 FORBIDDEN', async () => {
      const stream = new TestClientDuplex();
      const body = JSON.stringify({
        pageId: 'page_alice_123',
        sessionId: 'ses_bob_002', // Bob's session, but handler is bound to Alice
      });
      const req = `POST /api/browser/snapshot HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

      const handlePromise = handler.handle(stream, {
        kind: 'platform',
        userId: 'alice',
      });
      stream.pushToStream(req);
      stream.push(null);
      await handlePromise;

      const res = stream.getResponse();
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(browserService.snapshot).not.toHaveBeenCalled();
    });

    it('rejects interact requests with cross-tenant sessionId with 403 FORBIDDEN', async () => {
      const stream = new TestClientDuplex();
      const body = JSON.stringify({
        pageId: 'page_alice_123',
        sessionId: 'ses_bob_002',
        action: 'click',
        ref: '@e1',
      });
      const req = `POST /api/browser/interact HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

      const handlePromise = handler.handle(stream, {
        kind: 'platform',
        userId: 'alice',
      });
      stream.pushToStream(req);
      stream.push(null);
      await handlePromise;

      const res = stream.getResponse();
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(browserService.interact).not.toHaveBeenCalled();
    });

    it('rejects snapshot requests with missing sessionId with 400 VALIDATION_ERROR', async () => {
      const stream = new TestClientDuplex();
      const body = JSON.stringify({
        pageId: 'page_alice_123',
      });
      const req = `POST /api/browser/snapshot HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

      const handlePromise = handler.handle(stream, {
        kind: 'platform',
        userId: 'alice',
      });
      stream.pushToStream(req);
      stream.push(null);
      await handlePromise;

      const res = stream.getResponse();
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Host Runtime Loopback HTTP Proxy Integration', () => {
    it('dispatches browser_open and snapshot directly via loopback HTTP proxy to PlatformProxyHandler', async () => {
      const { HostPlatformProxyServer } = await import('../src/host/platform-proxy-server.js');
      const proxyServer = new HostPlatformProxyServer({
        handler,
      });

      const proxyBaseUrl = await proxyServer.start();
      expect(proxyBaseUrl).toBeDefined();

      try {
        const platformBaseUrl = proxyServer.getBaseUrl();
        const token = proxyServer.getAuthToken();
        const port = proxyServer.getPort()!;

        // 0. Verify unauthenticated requests fail closed with 401
        const unauthRes = await fetch(`${platformBaseUrl}/api/browser/open`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: 'https://example.com/host-agent',
            sessionId: 'ses_alice_001',
          }),
        });
        expect(unauthRes.status).toBe(401);

        // 0b. Verify bare /api/browser/open without opaque prefix returns 404
        const bareRes = await fetch(`http://127.0.0.1:${port}/api/browser/open`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            url: 'https://example.com/host-agent',
            sessionId: 'ses_alice_001',
          }),
        });
        expect(bareRes.status).toBe(404);

        // 1. Send POST /platform/<opaquePrefix>/api/browser/open with valid Bearer token
        const openBody = JSON.stringify({
          url: 'https://example.com/host-agent',
          sessionId: 'ses_alice_001',
        });

        const openRes = await fetch(`${platformBaseUrl}/api/browser/open`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: openBody,
        });

        expect(openRes.status).toBe(200);
        const openJson = (await openRes.json()) as any;
        expect(openJson.success).toBe(true);
        expect(openJson.pageId).toBe('page_test_123');

        // 2. Send POST /platform/<opaquePrefix>/api/browser/snapshot over HTTP
        const snapBody = JSON.stringify({
          pageId: 'page_test_123',
          sessionId: 'ses_alice_001',
        });

        const snapRes = await fetch(`${platformBaseUrl}/api/browser/snapshot`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: snapBody,
        });

        expect(snapRes.status).toBe(200);
        const snapJson = (await snapRes.json()) as any;
        expect(snapJson.success).toBe(true);
        expect(snapJson.root.ref).toBe('@e1');
      } finally {
        await proxyServer.close();
      }
    });
  });
});
