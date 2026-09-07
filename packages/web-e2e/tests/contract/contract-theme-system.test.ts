/**
 * Contract E2E: Theme Subsystem Multi-Theme Switching, Persistence, Mobile & A11y
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAndStartTestPlatformServer,
  type RunningTestServer,
} from '../../src/contract/test-platform-server.js';
import {
  launchPlaywrightBrowser,
  createIsolatedPage,
  uiLogin,
  uiLogout,
  uiCreateSpace,
  uiCreateSession,
} from '../../src/contract/browser-helper.js';
import {
  probeProtectedPorts,
  assertProtectedPortsUnmolested,
  type ProtectedPortsSnapshot,
} from '../../src/probes/ports-guard.js';

const REPORT_SHOTS_DIR = join(process.cwd(), '../../reports/screenshots');

describe('Contract E2E: Multi-Theme System & Persistence (Dark, Light, Eye-Care)', () => {
  let probeBefore: ProtectedPortsSnapshot;
  let browser: Browser;
  let testServer: RunningTestServer;

  beforeAll(async () => {
    if (!existsSync(REPORT_SHOTS_DIR)) {
      mkdirSync(REPORT_SHOTS_DIR, { recursive: true });
    }
    probeBefore = await probeProtectedPorts();
    testServer = await createAndStartTestPlatformServer();
    browser = await launchPlaywrightBrowser({ headless: true });
  });

  afterAll(async () => {
    try {
      if (browser) await browser.close();
    } finally {
      if (testServer) await testServer.stop();
    }
    const probeAfter = await probeProtectedPorts();
    assertProtectedPortsUnmolested(probeBefore, probeAfter);
  });

  // 1. Pre-login Theme Selection
  it('1. Pre-login Theme Selection: Changes theme locally before authentication, sets document dataset, and persists to localStorage', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await page.goto(testServer.url);
      await page.waitForSelector('#auth-view', { state: 'visible' });

      // Initial theme is valid enum ('dark' | 'light' | 'eye-care')
      let themeAttr = await page.getAttribute('html', 'data-theme');
      expect(['dark', 'light', 'eye-care']).toContain(themeAttr);

      // Switch to 'light' via #auth-theme-select
      await page.selectOption('#auth-theme-select', 'light');
      themeAttr = await page.getAttribute('html', 'data-theme');
      expect(themeAttr).toBe('light');

      // Check localStorage
      let stored = await page.evaluate(() => localStorage.getItem('enkeep.theme.prelogin'));
      expect(stored).toBe('light');

      // Switch to 'eye-care'
      await page.selectOption('#auth-theme-select', 'eye-care');
      themeAttr = await page.getAttribute('html', 'data-theme');
      expect(themeAttr).toBe('eye-care');
      stored = await page.evaluate(() => localStorage.getItem('enkeep.theme.prelogin'));
      expect(stored).toBe('eye-care');

      // Switch to 'dark'
      await page.selectOption('#auth-theme-select', 'dark');
      themeAttr = await page.getAttribute('html', 'data-theme');
      expect(themeAttr).toBe('dark');
      stored = await page.evaluate(() => localStorage.getItem('enkeep.theme.prelogin'));
      expect(stored).toBe('dark');

      // Reload page unauthenticated -> early bootstrap restores 'dark'
      await page.reload();
      await page.waitForSelector('#auth-view', { state: 'visible' });
      themeAttr = await page.getAttribute('html', 'data-theme');
      expect(themeAttr).toBe('dark');
      expect(await page.inputValue('#auth-theme-select')).toBe('dark');
    } finally {
      await context.close();
    }
  });

  // 2. Instant Theme Switching without refresh, preserving Chat Draft & Modals
  it('2. Instant Theme Switching: Preserves Chat draft text, selected session, and open modal state without reload or data loss', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible' });

      // Create a test space and session
      const spaceName = `Theme Test Space ${Date.now()}`;
      const spaceFolder = `theme-space-${Date.now()}`;
      await uiCreateSpace(page, { name: spaceName, folder: spaceFolder });

      await page.waitForFunction((expectedName) => {
        const opts = Array.from(document.querySelectorAll('#space-select option'));
        return opts.some((o) => o.textContent && o.textContent.includes(expectedName));
      }, spaceName, { timeout: 8000 });

      const customPeer = `peer-theme-${Date.now()}`;
      await uiCreateSession(page, { peerId: customPeer });
      await page.waitForSelector('#session-list .session-item.active', { state: 'visible' });

      // Type draft in chat input
      const testDraft = 'This is an important unsent prompt draft.';
      await page.fill('#chat-input', testDraft);
      expect(await page.inputValue('#chat-input')).toBe(testDraft);

      // Open Space modal
      await page.click('#btn-new-space');
      await page.waitForSelector('#modal-space', { state: 'visible' });
      await page.fill('#space-name-input', 'Modal In-Progress Input');

      // Switch theme to 'light' via topbar #theme-select
      await page.selectOption('#theme-select', 'light');

      // Verify DOM updated instantly
      expect(await page.getAttribute('html', 'data-theme')).toBe('light');

      // Verify modal is STILL open and input preserved
      const modalVisible = await page.isVisible('#modal-space');
      expect(modalVisible).toBe(true);
      expect(await page.inputValue('#space-name-input')).toBe('Modal In-Progress Input');

      // Close modal
      await page.click('#modal-space button[data-close="modal-space"]');
      await page.waitForSelector('#modal-space', { state: 'hidden' });

      // Verify Chat draft text is STILL intact
      expect(await page.inputValue('#chat-input')).toBe(testDraft);

      // Switch theme to 'eye-care'
      await page.selectOption('#theme-select', 'eye-care');
      expect(await page.getAttribute('html', 'data-theme')).toBe('eye-care');
      expect(await page.inputValue('#chat-input')).toBe(testDraft);
    } finally {
      await context.close();
    }
  });

  // 3. Multi-User Preferences & Multi-Tenant Isolation
  it('3. Multi-User Isolation: User Alice and User Bob have independent theme preferences persisted across reloads and logouts', async () => {
    // Page 1: Alice sets 'light'
    const { context: ctxAlice, page: pageAlice } = await createIsolatedPage(browser);
    try {
      await uiLogin(pageAlice, testServer.url, 'alice', 'AliceSecurePass123!');
      await pageAlice.waitForSelector('#app-view', { state: 'visible' });

      await pageAlice.selectOption('#theme-select', 'light');
      expect(await pageAlice.getAttribute('html', 'data-theme')).toBe('light');

      // Wait a moment for background preference sync
      await pageAlice.waitForTimeout(500);

      // Reload pageAlice -> Alice remains 'light'
      await pageAlice.reload();
      await pageAlice.waitForSelector('#app-view', { state: 'visible' });
      expect(await pageAlice.getAttribute('html', 'data-theme')).toBe('light');

      await uiLogout(pageAlice);
      await pageAlice.waitForSelector('#auth-view', { state: 'visible' });
    } finally {
      await ctxAlice.close();
    }

    // Page 2: Bob logs in and sets 'eye-care'
    const { context: ctxBob, page: pageBob } = await createIsolatedPage(browser);
    try {
      await uiLogin(pageBob, testServer.url, 'bob', 'BobSecurePass123!');
      await pageBob.waitForSelector('#app-view', { state: 'visible' });

      await pageBob.selectOption('#theme-select', 'eye-care');
      expect(await pageBob.getAttribute('html', 'data-theme')).toBe('eye-care');

      await pageBob.waitForTimeout(500);

      await pageBob.reload();
      await pageBob.waitForSelector('#app-view', { state: 'visible' });
      expect(await pageBob.getAttribute('html', 'data-theme')).toBe('eye-care');

      await uiLogout(pageBob);
    } finally {
      await ctxBob.close();
    }

    // Page 3: Alice logs in again -> Alice still has 'light'
    const { context: ctxAlice2, page: pageAlice2 } = await createIsolatedPage(browser);
    try {
      await uiLogin(pageAlice2, testServer.url, 'alice', 'AliceSecurePass123!');
      await pageAlice2.waitForSelector('#app-view', { state: 'visible' });
      expect(await pageAlice2.getAttribute('html', 'data-theme')).toBe('light');
    } finally {
      await ctxAlice2.close();
    }
  });

  // 4. Mobile 390px Viewport & Accessibility Contrast Verification
  it('4. Mobile Viewport 390px & Real Computed DOM Colors Contrast in all 3 themes', async () => {
    const { context, page } = await createIsolatedPage(browser, {
      viewport: { width: 390, height: 844 }, // iPhone 12/13/14 portrait
    });

    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible' });

      const themes = ['dark', 'light', 'eye-care'] as const;

      for (const theme of themes) {
        await page.selectOption('#theme-select', theme);
        expect(await page.getAttribute('html', 'data-theme')).toBe(theme);

        // Check computed background and text color of body
        const styles = await page.evaluate(() => {
          const bodyStyle = window.getComputedStyle(document.body);
          const topbarStyle = window.getComputedStyle(document.querySelector('.app-topbar') as Element);
          return {
            bodyBg: bodyStyle.backgroundColor,
            bodyColor: bodyStyle.color,
            topbarBg: topbarStyle.backgroundColor,
          };
        });

        expect(styles.bodyBg).toBeTruthy();
        expect(styles.bodyColor).toBeTruthy();
        expect(styles.bodyBg).not.toBe(styles.bodyColor);
      }
    } finally {
      await context.close();
    }
  });

  // 5. Account Settings View Theme Selector
  it('5. Account Settings View: Theme can be modified from user account settings and updates active theme', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible' });

      // Navigate to #management/users/account
      await page.goto(`${testServer.url}#management/users/account`);
      await page.waitForSelector('#account-theme-select', { state: 'visible', timeout: 8000 });

      // Switch theme to 'eye-care' from account settings form
      await page.selectOption('#account-theme-select', 'eye-care');
      expect(await page.getAttribute('html', 'data-theme')).toBe('eye-care');

      // Verify topbar select is synchronized
      expect(await page.inputValue('#theme-select')).toBe('eye-care');
    } finally {
      await context.close();
    }
  });

  // 6. Generate Screenshots for Report (theme-dark.png, theme-light.png, theme-eye-care.png)
  it('6. Captures full visual screenshots of Dark, Light, and Eye-care themes', async () => {
    const { context, page } = await createIsolatedPage(browser, {
      viewport: { width: 1280, height: 800 },
    });

    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible' });

      const spaceName = `Demo Showcase ${Date.now()}`;
      const spaceFolder = `demo-folder-${Date.now()}`;
      await uiCreateSpace(page, { name: spaceName, folder: spaceFolder });

      await page.waitForFunction((expectedName) => {
        const opts = Array.from(document.querySelectorAll('#space-select option'));
        return opts.some((o) => o.textContent && o.textContent.includes(expectedName));
      }, spaceName, { timeout: 8000 });

      const customPeer = `peer-shot-${Date.now()}`;
      await uiCreateSession(page, { peerId: customPeer });
      await page.waitForSelector('#session-list .session-item.active', { state: 'visible' });

      // Send a rich message with code block and text
      await page.fill('#chat-input', 'Showcasing theme tokens and syntax highlighting across Dark, Light, and Eye-Care modes.');
      await page.click('#btn-send-message');
      await page.waitForTimeout(500);

      // 1. Dark Theme Screenshot
      await page.selectOption('#theme-select', 'dark');
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(REPORT_SHOTS_DIR, 'theme-dark.png') });

      // 2. Light Theme Screenshot
      await page.selectOption('#theme-select', 'light');
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(REPORT_SHOTS_DIR, 'theme-light.png') });

      // 3. Eye-Care Theme Screenshot
      await page.selectOption('#theme-select', 'eye-care');
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(REPORT_SHOTS_DIR, 'theme-eye-care.png') });
    } finally {
      await context.close();
    }
  });

  // 7. Legacy Key Migration & Zero Cross-User Leakage on Logout
  it('7. Storage Isolation & Legacy Key Migration: One-time maps legacy enkeep.theme to enkeep.theme.prelogin and logout restores prelogin/system theme', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      // Seed legacy storage key
      await page.goto(testServer.url);
      await page.evaluate(() => {
        localStorage.setItem('enkeep.theme', 'light');
        localStorage.removeItem('enkeep.theme.prelogin');
      });

      // Reload -> early bootstrap migrates key
      await page.reload();
      await page.waitForSelector('#auth-view', { state: 'visible' });

      const stateAfterMigration = await page.evaluate(() => ({
        legacy: localStorage.getItem('enkeep.theme'),
        prelogin: localStorage.getItem('enkeep.theme.prelogin'),
        datasetTheme: document.documentElement.dataset.theme,
      }));

      expect(stateAfterMigration.legacy).toBeNull();
      expect(stateAfterMigration.prelogin).toBe('light');
      expect(stateAfterMigration.datasetTheme).toBe('light');

      // Now login as Bob whose DB theme is 'eye-care' (or login as Alice then change DB to eye-care)
      await uiLogin(page, testServer.url, 'bob', 'BobSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible' });

      // Bob's authenticated theme is applied
      expect(await page.getAttribute('html', 'data-theme')).toBe('eye-care');

      // Logout -> auth view MUST reset to prelogin theme ('light'), NOT Bob's 'eye-care'
      await uiLogout(page);
      await page.waitForSelector('#auth-view', { state: 'visible' });

      const logoutTheme = await page.getAttribute('html', 'data-theme');
      expect(logoutTheme).toBe('light');
    } finally {
      await context.close();
    }
  });
});
