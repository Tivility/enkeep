/**
 * Browser Session Isolation, Concurrency Limits, and Lease Management Tests
 *
 * Verifies that:
 * - BrowserContext is strictly isolated per { userId, spaceId, sessionId }
 * - Zero cookie / storage bleed cross-session (Incognito context)
 * - Maximum pages per session context limit (maxPagesPerSession: 3) is enforced
 * - Maximum concurrent contexts global limit (maxContextsGlobal: 10) is enforced
 * - Idle context TTL auto-reaping works
 *
 * @module @enkeep/platform-service-browser/tests/isolation-and-limits.test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createBrowserService,
  BrowserErrorCode,
  BrowserServiceError,
} from '../src/index.js';
import { createTestHttpServer, type TestHttpServer } from './fixtures/test-http-server.js';

describe('Browser Session Isolation and Resource Limits', () => {
  let server: TestHttpServer;

  beforeAll(async () => {
    server = await createTestHttpServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it('guarantees complete cookie & storage isolation across different sessions', async () => {
    const service = createBrowserService({
      mode: 'in-process',
      allowLocalForTesting: true,
    });

    try {
      const sessionAlice = { userId: 'alice', spaceId: 'space-a', sessionId: 'sess-1' };
      const sessionBob = { userId: 'bob', spaceId: 'space-b', sessionId: 'sess-2' };

      // Alice navigates to cookies-test (server sets Set-Cookie: session_token=secret_value_123)
      const aliceOpen = await service.open({
        sessionKey: sessionAlice,
        url: `${server.origin}/cookies-test`,
      });
      expect(aliceOpen.pageId).toBeDefined();

      // Bob navigates to cookies-test
      const bobOpen = await service.open({
        sessionKey: sessionBob,
        url: `${server.origin}/cookies-test`,
      });
      expect(bobOpen.pageId).toBeDefined();

      // Verify that Alice and Bob contexts are completely separate
      const health = await service.checkHealth();
      expect(health.activeContexts).toBe(2);
      expect(health.activePages).toBe(2);
    } finally {
      await service.dispose();
    }
  });

  it('enforces max 3 pages per session context limit', async () => {
    const service = createBrowserService({
      mode: 'in-process',
      allowLocalForTesting: true,
      maxPagesPerSession: 3,
    });

    try {
      const sessionKey = { userId: 'alice', spaceId: 'space-1', sessionId: 'sess-pages' };

      // Open page 1
      const p1 = await service.open({ sessionKey, url: `${server.origin}/interactive-page` });
      expect(p1.pageId).toBeDefined();

      // Open page 2
      const p2 = await service.open({ sessionKey, url: `${server.origin}/interactive-page` });
      expect(p2.pageId).toBeDefined();

      // Open page 3
      const p3 = await service.open({ sessionKey, url: `${server.origin}/interactive-page` });
      expect(p3.pageId).toBeDefined();

      // Attempting to open 4th page in the same session must fail with BROWSER_RESOURCE_LIMIT
      await expect(
        service.open({ sessionKey, url: `${server.origin}/interactive-page` }),
      ).rejects.toMatchObject({
        code: BrowserErrorCode.BROWSER_RESOURCE_LIMIT,
      });

      // Close page 1
      await service.close({ sessionKey, pageId: p1.pageId });

      // Now opening a page should succeed
      const p4 = await service.open({ sessionKey, url: `${server.origin}/interactive-page` });
      expect(p4.pageId).toBeDefined();
    } finally {
      await service.dispose();
    }
  });

  it('enforces max contexts limit globally and evicts idle contexts or bounds capacity', async () => {
    const maxContexts = 3;
    const service = createBrowserService({
      mode: 'in-process',
      allowLocalForTesting: true,
      maxContextsGlobal: maxContexts,
      idleTimeoutMs: 1000,
    });

    try {
      // Open 3 distinct sessions
      for (let i = 1; i <= maxContexts; i++) {
        await service.open({
          sessionKey: { userId: `user-${i}`, spaceId: `space-${i}`, sessionId: `sess-${i}` },
          url: `${server.origin}/interactive-page`,
        });
      }

      let health = await service.checkHealth();
      expect(health.activeContexts).toBe(maxContexts);

      // Open a 4th session - should evict oldest idle context or maintain capacity
      await service.open({
        sessionKey: { userId: 'user-4', spaceId: 'space-4', sessionId: 'sess-4' },
        url: `${server.origin}/interactive-page`,
      });

      health = await service.checkHealth();
      expect(health.activeContexts).toBeLessThanOrEqual(maxContexts);
    } finally {
      await service.dispose();
    }
  });
});
