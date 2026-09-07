/**
 * Browser Worker Subprocess and Fault Isolation Tests
 *
 * Verifies that:
 * - Worker subprocess executes browser operations isolated from Platform host process
 * - Worker crash (e.g. SIGKILL / OOM) does not crash the host process
 * - Subsequent requests after worker termination auto-recover and succeed
 * - Navigation timeout (e.g. hanging server) triggers BROWSER_TIMEOUT cleanly
 * - Graceful disposal shuts down child process and cleans up resources
 *
 * @module @enkeep/platform-service-browser/tests/worker-fault-isolation.test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createBrowserService,
  BrowserErrorCode,
  BrowserServiceError,
} from '../src/index.js';
import { createTestHttpServer, type TestHttpServer } from './fixtures/test-http-server.js';

describe('Browser Worker Subprocess and Fault Isolation Tests', () => {
  let server: TestHttpServer;

  beforeAll(async () => {
    server = await createTestHttpServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it('executes full browser operations lifecycle through worker subprocess RPC', async () => {
    const service = createBrowserService({
      mode: 'worker',
      allowLocalForTesting: true,
      navigationTimeoutMs: 15000,
      operationTimeoutMs: 10000,
    });

    try {
      const sessionKey = { userId: 'alice', spaceId: 'sp-worker', sessionId: 'sess-worker-1' };

      // 1. Health check
      const health1 = await service.checkHealth();
      expect(health1.status).toBeDefined();

      // 2. Open page
      const openRes = await service.open({
        sessionKey,
        url: `${server.origin}/interactive-page`,
      });
      expect(openRes.pageId).toBeDefined();
      expect(openRes.title).toBe('Test Interactive Page');

      // 3. Snapshot
      const snap = await service.snapshot({ sessionKey, pageId: openRes.pageId });
      expect(snap.pageId).toBe(openRes.pageId);
      expect(snap.textSummary).toContain('Submit Button');

      // 4. Interact
      const findRef = (node: any, text: string): string | null => {
        if (node.name && node.name.includes(text)) return node.ref;
        if (node.children) {
          for (const c of node.children) {
            const found = findRef(c, text);
            if (found) return found;
          }
        }
        return null;
      };

      const btnRef = findRef(snap.root, 'Submit Button');
      expect(btnRef).not.toBeNull();

      const interactRes = await service.interact({
        sessionKey,
        pageId: openRes.pageId,
        action: 'click',
        ref: btnRef!,
      });
      expect(interactRes.success).toBe(true);

      // 5. Screenshot
      const shot = await service.screenshot({ sessionKey, pageId: openRes.pageId });
      expect(shot.mimeType).toBe('image/png');
      expect(shot.dimensions.width).toBeGreaterThan(0);
      expect(Buffer.isBuffer(shot.buffer)).toBe(true);
      expect(shot.buffer.length).toBeGreaterThan(100);
      expect((shot as any).base64).toBeUndefined();

      // 6. Close
      const closeRes = await service.close({ sessionKey, pageId: openRes.pageId });
      expect(closeRes.closedPages).toBe(1);
    } finally {
      await service.dispose();
    }
  });

  it('handles worker subprocess crash gracefully and auto-heals on subsequent request', async () => {
    const service = createBrowserService({
      mode: 'worker',
      allowLocalForTesting: true,
    });

    try {
      const sessionKey = { userId: 'alice', spaceId: 'sp-crash', sessionId: 'sess-crash-1' };

      // Open page in worker
      const open1 = await service.open({
        sessionKey,
        url: `${server.origin}/interactive-page`,
      });
      expect(open1.pageId).toBeDefined();

      const health = await service.checkHealth();
      expect(health.workerPid).toBeDefined();

      // Simulate abrupt worker crash by sending SIGKILL to the child process
      if (health.workerPid) {
        try {
          process.kill(health.workerPid, 'SIGKILL');
        } catch {
          // Process already dead
        }
      }

      // Small delay to let OS process exit settle
      await new Promise((r) => setTimeout(r, 100));

      // Subsequent call automatically restarts worker subprocess and succeeds cleanly
      const open2 = await service.open({
        sessionKey: { userId: 'alice', spaceId: 'sp-crash', sessionId: 'sess-crash-2' },
        url: `${server.origin}/interactive-page`,
      });
      expect(open2.pageId).toBeDefined();
      expect(open2.title).toBe('Test Interactive Page');

      const health2 = await service.checkHealth();
      expect(health2.workerPid).toBeDefined();
      expect(health2.workerPid).not.toBe(health.workerPid);
    } finally {
      await service.dispose();
    }
  });

  it('enforces navigation timeout on hanging network requests', async () => {
    const service = createBrowserService({
      mode: 'worker',
      allowLocalForTesting: true,
      navigationTimeoutMs: 1500, // Short timeout for test
    });

    try {
      const sessionKey = { userId: 'alice', spaceId: 'sp-timeout', sessionId: 'sess-time-1' };

      await expect(
        service.open({
          sessionKey,
          url: `${server.origin}/hanging-page`,
          timeoutMs: 1500,
        }),
      ).rejects.toMatchObject({
        code: BrowserErrorCode.BROWSER_TIMEOUT,
      });
    } finally {
      await service.dispose();
    }
  });

  it('verifies initialize idempotency, post-dispose rejection, and health transitions', async () => {
    const service = createBrowserService({
      mode: 'worker',
      allowLocalForTesting: true,
    });

    try {
      // 1. Before initialize, checkHealth returns degraded (lazy worker not yet spawned)
      const healthBefore = await service.checkHealth();
      expect(healthBefore.status).toBe('degraded');
      expect(healthBefore.activePages).toBe(0);
      expect(healthBefore.activeContexts).toBe(0);

      // 2. Initialize once and concurrently (idempotent)
      await Promise.all([
        service.initialize(),
        service.initialize(),
        service.initialize(),
      ]);

      // 3. After initialize, checkHealth returns healthy
      const healthAfter = await service.checkHealth();
      expect(healthAfter.status).toBe('healthy');
      expect(healthAfter.activePages).toBe(0);
      expect(healthAfter.activeContexts).toBe(0);

      // 4. Calling initialize again is a safe no-op
      await service.initialize();
    } finally {
      // 5. Dispose once and multiple times (idempotent)
      await service.dispose();
      await service.dispose();
    }

    // 6. After dispose, checkHealth returns unhealthy
    const healthDisposed = await service.checkHealth();
    expect(healthDisposed.status).toBe('unhealthy');

    // 7. After dispose, initialize rejects with BrowserServiceError (BROWSER_UNAVAILABLE)
    await expect(service.initialize()).rejects.toThrow(BrowserServiceError);
    await expect(service.initialize()).rejects.toMatchObject({
      code: BrowserErrorCode.BROWSER_UNAVAILABLE,
    });
  });

  it('fails with safe BROWSER_UNAVAILABLE error when Chromium executable path is invalid', async () => {
    const service = createBrowserService({
      mode: 'in-process',
      chromiumExecutablePath: '/nonexistent/custom/path/to/chromium-binary',
    });

    try {
      await expect(service.initialize()).rejects.toThrow(BrowserServiceError);
      await expect(service.initialize()).rejects.toMatchObject({
        code: BrowserErrorCode.BROWSER_UNAVAILABLE,
      });
    } finally {
      await service.dispose();
    }
  });
});
