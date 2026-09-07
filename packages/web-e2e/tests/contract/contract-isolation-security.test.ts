/**
 * Contract E2E: Tenant Isolation, Malicious Tenant ID Rejection & CSRF/Host Security Tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser } from 'playwright';
import {
  createAndStartTestPlatformServer,
  type RunningTestServer,
  TEST_CSRF_TOKEN,
} from '../../src/contract/test-platform-server.js';
import {
  launchPlaywrightBrowser,
  createIsolatedPage,
  uiLogin,
  uiCreateSpace,
  uiCreateSession,
} from '../../src/contract/browser-helper.js';
import {
  probeProtectedPorts,
  assertProtectedPortsUnmolested,
  type ProtectedPortsSnapshot,
} from '../../src/probes/ports-guard.js';

describe('Contract E2E: Tenant Isolation & Security Negatives', () => {
  let probeBefore: ProtectedPortsSnapshot;
  let browser: Browser;
  let testServer: RunningTestServer;

  beforeAll(async () => {
    probeBefore = await probeProtectedPorts();
    testServer = await createAndStartTestPlatformServer();
    browser = await launchPlaywrightBrowser({ headless: true });
  });

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
    if (testServer) {
      await testServer.stop();
    }
    const probeAfter = await probeProtectedPorts();
    assertProtectedPortsUnmolested(probeBefore, probeAfter);
  });

  it('Tenant Isolation: Alice and Bob cannot see or access each other spaces or sessions', async () => {
    // 1. Alice creates Private Space and Private Session
    const { context: aliceCtx, page: alicePage } = await createIsolatedPage(browser);
    let aliceSessionId = '';

    try {
      await uiLogin(alicePage, testServer.url, 'alice', 'AliceSecurePass123!');
      await alicePage.waitForSelector('#app-view', { state: 'visible', timeout: 6000 });

      await uiCreateSpace(alicePage, {
        name: 'Alice Secret Space',
        folder: 'alice-secret-folder',
      });
      await uiCreateSession(alicePage, { peerId: 'alice-private-peer' });

      // Get Alice active session route key / ID from header
      const titleText = await alicePage.textContent('#current-session-title');
      aliceSessionId = titleText?.replace('Session:', '').trim() || '';
      expect(aliceSessionId.length).toBeGreaterThan(0);
    } finally {
      await aliceCtx.close();
    }

    // 2. Bob logs in in a completely separate browser context
    const { context: bobCtx, page: bobPage } = await createIsolatedPage(browser);
    try {
      await uiLogin(bobPage, testServer.url, 'bob', 'BobSecurePass123!');
      await bobPage.waitForSelector('#app-view', { state: 'visible', timeout: 6000 });

      // Check Bob's space selector: must NOT contain 'Alice Secret Space'
      await bobPage.waitForFunction(() => {
        const sel = document.querySelector('#space-select') as HTMLSelectElement | null;
        return sel && sel.options.length > 0 && sel.options[0].value !== '';
      }, { timeout: 5000 });

      const bobSpaces = await bobPage.$$eval('#space-select option', (opts) =>
        opts.map((o) => o.textContent || '')
      );
      expect(bobSpaces.some((s) => s.includes('Alice Secret Space'))).toBe(false);

      // Check direct API requests by Bob trying to access Alice's session
      const getAliceSessionRes = await bobPage.request.get(
        `${testServer.url}/api/sessions/${aliceSessionId}`
      );
      expect([400, 403, 404]).toContain(getAliceSessionRes.status());

      // Bob tries to read Alice's messages
      const getAliceMessagesRes = await bobPage.request.get(
        `${testServer.url}/api/sessions/${aliceSessionId}/messages`
      );
      expect([400, 403, 404]).toContain(getAliceMessagesRes.status());

      // Bob tries to post a message into Alice's session
      const postAliceMsgRes = await bobPage.request.post(
        `${testServer.url}/api/sessions/${aliceSessionId}/messages`,
        {
          data: { content: 'Malicious cross-tenant injection attempt' },
          headers: {
            'X-Enkeep-Csrf': TEST_CSRF_TOKEN,
            Origin: testServer.url,
          },
        }
      );
      expect([400, 403, 404]).toContain(postAliceMsgRes.status());
    } finally {
      await bobCtx.close();
    }
  });

  it('Foreign tenant body rejected; spoof headers cannot change auth', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      // Bob logs in
      await uiLogin(page, testServer.url, 'bob', 'BobSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 6000 });

      const aliceUser = await testServer.storage.users.findByUsername('alice');
      expect(aliceUser).not.toBeNull();

      // 1. Bob attempts to pass unauthorized body key "userId" -> MUST be rejected with 400 Bad Request
      const userIdBodyRes = await page.request.post(`${testServer.url}/api/spaces`, {
        data: {
          name: 'Spoofed UserId Space',
          folder: 'spoofed-user-folder',
          userId: aliceUser!.id,
        },
        headers: {
          'X-Enkeep-Csrf': TEST_CSRF_TOKEN,
          Origin: testServer.url,
        },
      });
      expect(userIdBodyRes.status()).toBe(400);

      // 2. Bob attempts to pass unauthorized body key "tenantId" -> MUST be rejected with 400 Bad Request
      const tenantIdBodyRes = await page.request.post(`${testServer.url}/api/spaces`, {
        data: {
          name: 'Spoofed TenantId Space',
          folder: 'spoofed-tenant-folder',
          tenantId: aliceUser!.id,
        },
        headers: {
          'X-Enkeep-Csrf': TEST_CSRF_TOKEN,
          Origin: testServer.url,
        },
      });
      expect(tenantIdBodyRes.status()).toBe(400);

      // 3. Bob attempts to spoof tenant identity via HTTP headers (X-Tenant-Id / X-User-Id)
      // Headers are ignored because identity is derived solely from the authenticated session cookie.
      const headerSpoofRes = await page.request.post(`${testServer.url}/api/spaces`, {
        data: {
          name: 'Bob Space with Spoofed Headers',
          folder: 'bob-header-spoof-folder',
        },
        headers: {
          'X-Enkeep-Csrf': TEST_CSRF_TOKEN,
          'X-Tenant-Id': aliceUser!.id,
          'X-User-Id': aliceUser!.id,
          Origin: testServer.url,
        },
      });

      expect(headerSpoofRes.status()).toBe(201);
      const createdSpace = (await headerSpoofRes.json()).data;

      // The space MUST belong to Bob, NOT Alice
      const bobUser = await testServer.storage.users.findByUsername('bob');
      const bobTenant = testServer.storage.forTenant(bobUser!.id);
      const bobSpaces = await bobTenant.spaces.list();
      expect(bobSpaces.some((s) => s.id === createdSpace.id)).toBe(true);

      const bobSpaceRecord = await bobTenant.spaces.findById(createdSpace.id);
      expect(bobSpaceRecord?.userId).toBe(bobUser!.id);

      // Verify Alice tenant has NOT received this space
      const aliceTenant = testServer.storage.forTenant(aliceUser!.id);
      const aliceSpaces = await aliceTenant.spaces.list();
      expect(aliceSpaces.some((s) => s.id === createdSpace.id)).toBe(false);
    } finally {
      await context.close();
    }
  });

  it('CSRF & Host Security Negatives: Bad Host, Forbidden Origin, and CSRF Violations are rejected', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      // 1. Malicious Origin Header on state-modifying POST request -> 403 Forbidden
      const badOriginRes = await page.request.post(`${testServer.url}/api/auth/login`, {
        data: { username: 'alice', password: 'AliceSecurePass123!' },
        headers: {
          Origin: 'http://malicious-attacker-site.com',
          // No valid CSRF token header
        },
      });
      expect(badOriginRes.status()).toBe(403);

      // 2. Mismatched / Forged CSRF Token Header -> 403 Forbidden
      const badCsrfRes = await page.request.post(`${testServer.url}/api/auth/login`, {
        data: { username: 'alice', password: 'AliceSecurePass123!' },
        headers: {
          'X-Enkeep-Csrf': 'forged-invalid-csrf-token-32-chars-long!',
        },
      });
      expect(badCsrfRes.status()).toBe(403);

      // 3. Missing CSRF token on mutating request with untrusted origin -> 403 Forbidden
      const noCsrfRes = await page.request.post(`${testServer.url}/api/auth/login`, {
        data: { username: 'alice', password: 'AliceSecurePass123!' },
        headers: {
          Origin: 'http://evil.com',
        },
      });
      expect(noCsrfRes.status()).toBe(403);

      // 4. Oversized Payload (> 1MB) -> 413 Payload Too Large
      const hugeData = 'x'.repeat(1024 * 1024 + 100);
      const oversizedRes = await page.request.post(`${testServer.url}/api/auth/login`, {
        data: JSON.stringify({ username: 'alice', password: hugeData }),
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': TEST_CSRF_TOKEN,
          Origin: testServer.url,
        },
      });
      expect([413, 400]).toContain(oversizedRes.status());
    } finally {
      await context.close();
    }
  });
});
