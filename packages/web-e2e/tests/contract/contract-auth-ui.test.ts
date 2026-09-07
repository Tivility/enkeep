/**
 * Contract E2E: Authentication, CSRF Bootstrap, and Login/Logout UI Flows
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
  uiLogout,
} from '../../src/contract/browser-helper.js';
import {
  probeProtectedPorts,
  assertProtectedPortsUnmolested,
  type ProtectedPortsSnapshot,
} from '../../src/probes/ports-guard.js';

describe('Contract E2E: Auth, CSRF Bootstrap & User Flows', () => {
  let probeBefore: ProtectedPortsSnapshot;
  let browser: Browser;
  let testServer: RunningTestServer;

  beforeAll(async () => {
    // 1. Probe 3000/3080 before test suite
    probeBefore = await probeProtectedPorts();

    // 2. Start Test Platform Server on 127.0.0.1:0 with TestOnly runtime gateway
    testServer = await createAndStartTestPlatformServer();

    // 3. Launch Playwright Chromium
    browser = await launchPlaywrightBrowser({ headless: true });
  });

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
    if (testServer) {
      await testServer.stop();
    }

    // 4. Probe 3000/3080 after test suite and assert ZERO change
    const probeAfter = await probeProtectedPorts();
    assertProtectedPortsUnmolested(probeBefore, probeAfter);
  });

  it('CSRF Bootstrap: /api/auth/csrf provides valid token and protects state endpoints', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      // 1. Unauthenticated GET /api/auth/csrf returns token
      const res = await page.request.get(`${testServer.url}/api/auth/csrf`);
      expect(res.status()).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.csrfToken).toBe(TEST_CSRF_TOKEN);

      // 2. POST without CSRF token or with bad CSRF token is rejected with 403
      const badCsrfRes = await page.request.post(`${testServer.url}/api/auth/login`, {
        data: { username: 'alice', password: 'AliceSecurePass123!' },
        headers: {
          'X-Enkeep-Csrf': 'invalid-csrf-token-that-fails-validation!',
        },
      });
      expect(badCsrfRes.status()).toBe(403);
    } finally {
      await context.close();
    }
  });

  it('Alice Login: Admin user logs in successfully and UI displays workspace with management navigation', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');

      // App view becomes visible
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 6000 });
      await page.waitForSelector('#auth-view', { state: 'hidden', timeout: 6000 });

      // User display name updated
      const displayName = await page.textContent('#user-display-name');
      expect(displayName).toContain('Alice');

      // Admin role badge displayed
      const roleBadge = await page.textContent('#user-role-badge');
      expect(roleBadge).toContain('Admin');

      // Main 2-item navigation (Chat & Management) and management tabs bar are present
      await page.waitForSelector('#management-nav', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('#nav-workspace', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('#nav-management', { state: 'visible', timeout: 5000 });

      // Spaces select populated
      await page.waitForFunction(() => {
        const sel = document.querySelector('#space-select') as HTMLSelectElement | null;
        return sel && sel.options.length > 0 && sel.options[0].value !== '';
      }, { timeout: 5000 });

      const spaceOptions = await page.$$eval('#space-select option', (opts) =>
        opts.map((o) => o.textContent)
      );
      expect(spaceOptions.some((txt) => txt?.includes('Alice'))).toBe(true);

      // Alice can navigate to Management console
      await page.click('#nav-management');
      await page.waitForSelector('#view-management:not(.hidden)', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('#management-content', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('#management-tabs-bar', { state: 'visible', timeout: 5000 });

      const isWorkspaceHidden = await page.$eval('#view-workspace', (el) => el.classList.contains('hidden'));
      expect(isWorkspaceHidden).toBe(true);

      // Alice can navigate across tabs: Runtime, Workspaces, Storage, Users, Models
      await page.click('#tab-btn-runtime');
      await page.waitForSelector('#management-canvas .management-header', { state: 'visible', timeout: 5000 });
      expect(page.url()).toContain('#management/runtime');

      await page.click('#tab-btn-users');
      await page.waitForSelector('#management-canvas .management-header', { state: 'visible', timeout: 5000 });
      expect(page.url()).toContain('#management/users');

      // Navigate back to workspace
      await page.click('#nav-workspace');
      await page.waitForSelector('#view-workspace:not(.hidden)', { state: 'visible', timeout: 5000 });
    } finally {
      await context.close();
    }
  });

  it('Bob Login: Regular user logs in successfully and UI enforces role-restricted nav', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'bob', 'BobSecurePass123!');

      await page.waitForSelector('#app-view', { state: 'visible', timeout: 6000 });
      await page.waitForSelector('#auth-view', { state: 'hidden', timeout: 6000 });

      const displayName = await page.textContent('#user-display-name');
      expect(displayName).toContain('Bob');

      // Member role badge displayed for non-admin
      const roleBadge = await page.textContent('#user-role-badge');
      expect(roleBadge).toContain('Member');

      // Left navigation strictly contains Chat, Management, Account
      await page.waitForSelector('#nav-workspace', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('#nav-management', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('#nav-account', { state: 'visible', timeout: 5000 });

      await page.waitForFunction(() => {
        const sel = document.querySelector('#space-select') as HTMLSelectElement | null;
        return sel && sel.options.length > 0 && sel.options[0].value !== '';
      }, { timeout: 5000 });

      const spaceOptions = await page.$$eval('#space-select option', (opts) =>
        opts.map((o) => o.textContent)
      );
      expect(spaceOptions.some((txt) => txt?.includes('Bob'))).toBe(true);

      // Direct hash navigation attempt by Bob to admin-restricted route redirects safely to management
      await page.evaluate(() => {
        window.location.hash = '#admin-users';
      });

      // Wait for hashchange handler to redirect to #management
      await page.waitForFunction(() => window.location.hash.startsWith('#management'), { timeout: 5000 });
      expect(page.url()).toContain('#management');
      await page.waitForSelector('#view-management:not(.hidden)', { state: 'visible', timeout: 5000 });
    } finally {
      await context.close();
    }
  });

  it('Disabled Account Rejection: Charlie (disabled) login attempt is rejected with error', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'charlie_disabled', 'CharlieDisabledPass123!', { expectSuccess: false });

      // Auth view remains visible
      await page.waitForSelector('#auth-view', { state: 'visible', timeout: 5000 });

      // Error toast is shown
      await page.waitForSelector('.toast.toast-error', { state: 'visible', timeout: 5000 });
      const toastText = await page.textContent('.toast.toast-error');
      expect(toastText?.toLowerCase()).toMatch(/disabled|failed|invalid|error/);

      // App view remains hidden
      const isAppHidden = await page.$eval('#app-view', (el) => el.classList.contains('hidden'));
      expect(isAppHidden).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('Logout Flow: User signs out, UI returns to login form, and session is cleared', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 6000 });

      // Click sign out
      await uiLogout(page);

      // Auth view is visible again
      await page.waitForSelector('#auth-view', { state: 'visible', timeout: 5000 });
      const isAppHidden = await page.$eval('#app-view', (el) => el.classList.contains('hidden'));
      expect(isAppHidden).toBe(true);

      // Attempting to call /api/auth/me now returns 401
      const meRes = await page.request.get(`${testServer.url}/api/auth/me`);
      expect(meRes.status()).toBe(401);
    } finally {
      await context.close();
    }
  });
});
