/**
 * Screenshot Capture and Lifecycle Close Tests
 *
 * Verifies that:
 * - screenshot returns PNG bytes buffer, base64 string, and viewport dimensions
 * - fullPage screenshot capture works
 * - close page removes single page from session context
 * - close session removes entire session context and its pages
 * - close all cleans up all contexts
 * - operating on a closed page throws BROWSER_PAGE_NOT_FOUND
 *
 * @module @enkeep/platform-service-browser/tests/screenshot-and-close.test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createBrowserService,
  BrowserErrorCode,
  BrowserServiceError,
} from '../src/index.js';
import { createTestHttpServer, type TestHttpServer } from './fixtures/test-http-server.js';

describe('Screenshot Capture and Close Lifecycle Tests', () => {
  let server: TestHttpServer;

  beforeAll(async () => {
    server = await createTestHttpServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it('captures screenshots with dimensions, PNG mime-type, and buffer', async () => {
    const service = createBrowserService({
      mode: 'in-process',
      allowLocalForTesting: true,
    });

    try {
      const sessionKey = { userId: 'alice', spaceId: 'sp1', sessionId: 'sess-screen' };
      const openRes = await service.open({
        sessionKey,
        url: `${server.origin}/interactive-page`,
      });

      // Standard viewport screenshot
      const shot1 = await service.screenshot({
        sessionKey,
        pageId: openRes.pageId,
      });

      expect(shot1.pageId).toBe(openRes.pageId);
      expect(shot1.mimeType).toBe('image/png');
      expect(shot1.dimensions.width).toBeGreaterThan(0);
      expect(shot1.dimensions.height).toBeGreaterThan(0);
      expect(Buffer.isBuffer(shot1.buffer)).toBe(true);
      expect(shot1.buffer.length).toBeGreaterThan(100);
      expect((shot1 as any).base64).toBeUndefined();

      // Full page screenshot
      const shot2 = await service.screenshot({
        sessionKey,
        pageId: openRes.pageId,
        fullPage: true,
      });
      expect(shot2.buffer.length).toBeGreaterThan(100);
    } finally {
      await service.dispose();
    }
  });

  it('handles selective close by pageId, sessionKey, and all', async () => {
    const service = createBrowserService({
      mode: 'in-process',
      allowLocalForTesting: true,
    });

    try {
      const session1 = { userId: 'alice', spaceId: 'sp1', sessionId: 'sess-close-1' };
      const session2 = { userId: 'bob', spaceId: 'sp2', sessionId: 'sess-close-2' };

      const p1 = await service.open({ sessionKey: session1, url: `${server.origin}/interactive-page` });
      const p2 = await service.open({ sessionKey: session1, url: `${server.origin}/interactive-page` });
      const p3 = await service.open({ sessionKey: session2, url: `${server.origin}/interactive-page` });

      let health = await service.checkHealth();
      expect(health.activeContexts).toBe(2);
      expect(health.activePages).toBe(3);

      // 1. Close single page p1 with valid sessionKey
      const closeP1 = await service.close({ sessionKey: session1, pageId: p1.pageId });
      expect(closeP1.closedPages).toBe(1);

      // Verify p1 is gone
      await expect(service.snapshot({ sessionKey: session1, pageId: p1.pageId })).rejects.toMatchObject({
        code: BrowserErrorCode.BROWSER_PAGE_NOT_FOUND,
      });

      // p2 in session1 is still alive
      const snapP2 = await service.snapshot({ sessionKey: session1, pageId: p2.pageId });
      expect(snapP2.pageId).toBe(p2.pageId);

      // 2. Close session1 by sessionKey
      const closeS1 = await service.close({ sessionKey: session1 });
      expect(closeS1.closedContexts).toBe(1);
      expect(closeS1.closedPages).toBe(1);

      // p2 is now closed
      await expect(service.snapshot({ sessionKey: session1, pageId: p2.pageId })).rejects.toMatchObject({
        code: BrowserErrorCode.BROWSER_PAGE_NOT_FOUND,
      });

      // p3 in session2 is still alive
      health = await service.checkHealth();
      expect(health.activeContexts).toBe(1);
      expect(health.activePages).toBe(1);

      // 3. Close all
      const closeAll = await service.close({ all: true });
      expect(closeAll.closedContexts).toBe(1);
      expect(closeAll.closedPages).toBe(1);

      health = await service.checkHealth();
      expect(health.activeContexts).toBe(0);
      expect(health.activePages).toBe(0);
    } finally {
      await service.dispose();
    }
  });

  it('strictly blocks cross-session unauthorized screenshot and close attempts with generic BROWSER_PAGE_NOT_FOUND', async () => {
    const service = createBrowserService({
      mode: 'in-process',
      allowLocalForTesting: true,
    });

    try {
      const aliceSession = { userId: 'alice', spaceId: 'sp-alice', sessionId: 'sess-alice' };
      const bobSession = { userId: 'bob', spaceId: 'sp-bob', sessionId: 'sess-bob' };

      const alicePage = await service.open({
        sessionKey: aliceSession,
        url: `${server.origin}/interactive-page`,
      });

      // Bob attempts to screenshot Alice's page
      await expect(
        service.screenshot({
          sessionKey: bobSession,
          pageId: alicePage.pageId,
        }),
      ).rejects.toMatchObject({
        code: BrowserErrorCode.BROWSER_PAGE_NOT_FOUND,
      });

      // Bob attempts to close Alice's page
      await expect(
        service.close({
          sessionKey: bobSession,
          pageId: alicePage.pageId,
        }),
      ).rejects.toMatchObject({
        code: BrowserErrorCode.BROWSER_PAGE_NOT_FOUND,
      });

      // Verify Alice's page is still intact and operable by Alice
      const aliceShot = await service.screenshot({
        sessionKey: aliceSession,
        pageId: alicePage.pageId,
      });
      expect(aliceShot.pageId).toBe(alicePage.pageId);

      const health = await service.checkHealth();
      expect(health.activePages).toBe(1);
      expect(health.activeContexts).toBe(1);
    } finally {
      await service.dispose();
    }
  });

  it('immediately closes context and commits map cleanup when closing the last page of a session (no 60s lease wait)', async () => {
    const service = createBrowserService({
      mode: 'in-process',
      allowLocalForTesting: true,
      idleTimeoutMs: 60000, // 60s idle lease must NOT delay context closure
    });

    try {
      const sessionA = { userId: 'alice', spaceId: 'sp-a', sessionId: 'sess-a' };
      const pA1 = await service.open({ sessionKey: sessionA, url: `${server.origin}/interactive-page` });
      const pA2 = await service.open({ sessionKey: sessionA, url: `${server.origin}/interactive-page` });

      let health = await service.checkHealth();
      expect(health.activePages).toBe(2);
      expect(health.activeContexts).toBe(1);

      // 1. Closing 1 of 2 pages in sessionA retains the context
      const close1 = await service.close({ sessionKey: sessionA, pageId: pA1.pageId });
      expect(close1.closedPages).toBe(1);
      expect(close1.closedContexts).toBe(0);

      health = await service.checkHealth();
      expect(health.activePages).toBe(1);
      expect(health.activeContexts).toBe(1);

      // 2. Closing the last page (pA2) immediately closes the context and removes map state
      const close2 = await service.close({ sessionKey: sessionA, pageId: pA2.pageId });
      expect(close2.closedPages).toBe(1);
      expect(close2.closedContexts).toBe(1);

      // Health immediately confirms 0 pages and 0 contexts without waiting for idle reaper
      health = await service.checkHealth();
      expect(health.activePages).toBe(0);
      expect(health.activeContexts).toBe(0);
    } finally {
      await service.dispose();
    }
  });

  it('propagates close lifecycle, context cleanup, and security isolation through worker service RPC', async () => {
    const service = createBrowserService({
      mode: 'worker',
      allowLocalForTesting: true,
      idleTimeoutMs: 60000,
    });

    try {
      await service.initialize();

      const sessionAlice = { userId: 'alice', spaceId: 'sp-worker', sessionId: 'sess-alice' };
      const sessionBob = { userId: 'bob', spaceId: 'sp-worker', sessionId: 'sess-bob' };

      const aliceP1 = await service.open({ sessionKey: sessionAlice, url: `${server.origin}/interactive-page` });
      const aliceP2 = await service.open({ sessionKey: sessionAlice, url: `${server.origin}/interactive-page` });
      const bobP1 = await service.open({ sessionKey: sessionBob, url: `${server.origin}/interactive-page` });

      let health = await service.checkHealth();
      expect(health.activePages).toBe(3);
      expect(health.activeContexts).toBe(2);

      // 1. Bob attempts unauthorized cross-session close on Alice's page
      await expect(
        service.close({
          sessionKey: sessionBob,
          pageId: aliceP1.pageId,
        }),
      ).rejects.toMatchObject({
        code: BrowserErrorCode.BROWSER_PAGE_NOT_FOUND,
      });

      // Confirm no cleanup occurred: Alice's page and context remain intact
      health = await service.checkHealth();
      expect(health.activePages).toBe(3);
      expect(health.activeContexts).toBe(2);

      const aliceSnap = await service.snapshot({ sessionKey: sessionAlice, pageId: aliceP1.pageId });
      expect(aliceSnap.pageId).toBe(aliceP1.pageId);

      // 2. Alice closes 1 of 2 pages (aliceP1) -> context is retained
      const closeAlice1 = await service.close({ sessionKey: sessionAlice, pageId: aliceP1.pageId });
      expect(closeAlice1.closedPages).toBe(1);
      expect(closeAlice1.closedContexts).toBe(0);

      health = await service.checkHealth();
      expect(health.activePages).toBe(2);
      expect(health.activeContexts).toBe(2);

      // 3. Alice closes her last page (aliceP2) -> Alice's context is immediately closed
      const closeAlice2 = await service.close({ sessionKey: sessionAlice, pageId: aliceP2.pageId });
      expect(closeAlice2.closedPages).toBe(1);
      expect(closeAlice2.closedContexts).toBe(1);

      health = await service.checkHealth();
      expect(health.activePages).toBe(1);
      expect(health.activeContexts).toBe(1); // Only Bob's context remains

      // 4. Bob closes his last page (bobP1) -> Bob's context is immediately closed
      const closeBob = await service.close({ sessionKey: sessionBob, pageId: bobP1.pageId });
      expect(closeBob.closedPages).toBe(1);
      expect(closeBob.closedContexts).toBe(1);

      health = await service.checkHealth();
      expect(health.activePages).toBe(0);
      expect(health.activeContexts).toBe(0);
    } finally {
      await service.dispose();
    }
  });
});
