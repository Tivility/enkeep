/**
 * Layer A: Contract E2E Test Suite - Spaces, Sessions, Messages & Persistence.
 *
 * Requirements:
 * - Historical spaces & sessions rendered in UI
 * - New space & session creation via UI modals
 * - Send message & verify in-process Contract Test-Only Driver reply
 * - Refresh persistence (page reload preserves active session and messages)
 * - Server restart persistence (stopping and rebooting PlatformServer retains SQLite data)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type Browser } from 'playwright';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAndStartTestPlatformServer, type TestPlatformServerHandle } from '../../src/contract/test-platform-server.js';
import {
  launchPlaywrightBrowser,
  createIsolatedPage,
  uiLogin,
  uiCreateSpace,
  uiCreateSession,
  uiSendMessage,
} from '../../src/contract/browser-helper.js';
import { probeProtectedPorts, assertProtectedPortsUnmolested } from '../../src/probes/ports-guard.js';

describe('Contract E2E: Spaces, Sessions, Messages & Persistence', () => {
  let browser: Browser;
  let testServer: TestPlatformServerHandle;
  let probeBefore: Awaited<ReturnType<typeof probeProtectedPorts>>;

  beforeAll(async () => {
    probeBefore = await probeProtectedPorts();
    testServer = await createAndStartTestPlatformServer();
    browser = await launchPlaywrightBrowser({ headless: true });
  });

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      try {
        await testServer?.stop();
      } finally {
        const probeAfter = await probeProtectedPorts();
        assertProtectedPortsUnmolested(probeBefore, probeAfter);
      }
    }
  });

  it('Historical Spaces & Sessions: Pre-seeded spaces and sessions render in UI', async () => {
    const aliceUser = testServer.fixtures.admin;
    const tenant = testServer.storage.forTenant(aliceUser.id);

    // Pre-seed an additional historical space & session for Alice
    const seededSpace = await tenant.spaces.create({
      name: 'Historical Seeded Space',
      folder: 'seeded-folder',
    });

    const seededSession = await tenant.sessionRoutes.create({
      id: `ses_seed_${randomUUID().replace(/-/g, '')}`,
      title: 'Historical Seeded Session',
      spaceId: seededSpace.id,
      channel: 'web',
      accountId: 'default',
      nativeContextId: `seed_ctx_${Date.now()}`,
      dshSessionId: `dsh_seed_${Date.now()}`,
      peerId: 'peer_historical_001',
    });

    const routeKey = `web:default:${aliceUser!.id}:${seededSession.id}`;
    await testServer.messageStore.insertMessage({
      id: `msg_seed_1`,
      sessionId: seededSession.id,
      userId: aliceUser!.id,
      role: 'user',
      content: 'Historical message pre-seeded in database',
      status: 'delivered',
      routeKey,
      createdAt: new Date(Date.now() - 3600000).toISOString(),
    });
    await testServer.messageStore.insertMessage({
      id: `msg_seed_2`,
      sessionId: seededSession.id,
      userId: aliceUser!.id,
      role: 'assistant',
      content: 'Welcome to your historical seeded session!',
      status: 'delivered',
      routeKey,
      createdAt: new Date(Date.now() - 1800000).toISOString(),
    });

    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Verify seeded space appears in space selector
      await page.waitForFunction(() => {
        const sel = document.querySelector('#space-select') as HTMLSelectElement | null;
        return sel && sel.options.length > 0 && sel.options[0].value !== '';
      }, { timeout: 8000 });

      await page.selectOption('#space-select', seededSpace.id);
      await page.dispatchEvent('#space-select', 'change');

      // Verify seeded session appears in session list by title only (authoritative ID is not displayed)
      await page.waitForSelector('#session-list .session-item', { state: 'visible', timeout: 8000 });
      const sessionTitles = await page.$$eval('#session-list .session-item', (items) =>
        items.map((i) => i.textContent)
      );
      expect(sessionTitles.some((t) => t?.includes('Historical Seeded Session'))).toBe(true);
      expect(sessionTitles.some((t) => t?.includes(seededSession.id))).toBe(false);

      // Select session and assert historical message rendered
      await page.waitForSelector('.message-card.assistant', { state: 'visible', timeout: 8000 });
      const messageContent = await page.textContent('.message-card.assistant .message-content');
      expect(messageContent).toContain('Welcome to your historical seeded session!');
    } finally {
      await context.close();
    }
  });

  it('New Space & Session Creation: User creates space and session via UI modals', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Create a brand new space
      const newSpaceName = `UI Space ${Date.now()}`;
      const newSpaceFolder = `ui-space-${Date.now()}`;
      await uiCreateSpace(page, {
        name: newSpaceName,
        folder: newSpaceFolder,
      });

      // Assert new space is in space-select options
      await page.waitForFunction((expectedName) => {
        const opts = Array.from(document.querySelectorAll('#space-select option'));
        return opts.some((o) => o.textContent && o.textContent.includes(expectedName));
      }, newSpaceName, { timeout: 8000 });

      // Create a new session in this space
      const customPeerId = `peer-${Date.now()}`;
      await uiCreateSession(page, { peerId: customPeerId });

      // Session should be active
      await page.waitForSelector('#session-list .session-item.active', { state: 'visible', timeout: 8000 });
      const metaText = await page.textContent('#current-session-meta');
      expect(metaText).toContain(customPeerId);
    } finally {
      await context.close();
    }
  });

  it('Send Message UI & Contract Test-Only Driver: User message sent, driver replies via live sync', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Create an isolated space & session for this test
      const spaceName = `Chat Space ${Date.now()}`;
      await uiCreateSpace(page, { name: spaceName, folder: `chat-folder-${Date.now()}` });
      await uiCreateSession(page, { peerId: 'chat-driver-peer' });
      await page.waitForSelector('#session-list .session-item.active', { state: 'visible', timeout: 8000 });

      // Send prompt
      const promptText = `Hello AI from Contract Driver test ${Date.now()}`;
      await uiSendMessage(page, promptText);

      // Verify User Message rendered
      await page.locator('.message-card.user', { hasText: promptText }).waitFor({ state: 'visible', timeout: 8000 });

      // Verify Assistant Reply rendered (via in-process Contract Test-Only Driver + live sync)
      await page.waitForSelector('.message-card.assistant', { state: 'visible', timeout: 15000 });
      const asstCardText = await page.textContent('.message-card.assistant .message-content');
      expect(asstCardText).toContain('[Contract-Driver-Reply]');
      expect(asstCardText).toContain(promptText);
    } finally {
      await context.close();
    }
  });

  it('Refresh Persistence: Reloading page preserves active session state and messages', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Create a dedicated space for this refresh test to isolate session list
      const refreshSpaceName = `Refresh Space ${Date.now()}`;
      await uiCreateSpace(page, { name: refreshSpaceName, folder: `refresh-folder-${Date.now()}` });

      const refreshSpaceId = await page.$eval(
        '#space-select',
        (el) => (el as HTMLSelectElement).value
      );

      // Create session and send message
      const peerId = `refresh-test-peer-${Date.now()}`;
      await uiCreateSession(page, { peerId });
      await page.waitForSelector('#session-list .session-item.active', { state: 'visible', timeout: 8000 });

      const testMsg = `Persistence test message ${Date.now()}`;
      await uiSendMessage(page, testMsg);

      await page.locator('.message-card.user', { hasText: testMsg }).waitFor({ state: 'visible', timeout: 8000 });
      await page.waitForSelector('.message-card.assistant', { state: 'visible', timeout: 15000 });

      // Reload the page
      await page.reload();

      // UI automatically restores logged in session
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });
      const displayName = await page.textContent('#user-display-name');
      expect(displayName).toContain('Alice');

      // Select the dedicated refresh space
      await page.waitForFunction(() => {
        const sel = document.querySelector('#space-select') as HTMLSelectElement | null;
        return sel && sel.options.length > 0 && sel.options[0].value !== '';
      }, { timeout: 8000 });
      await page.selectOption('#space-select', refreshSpaceId);
      await page.dispatchEvent('#space-select', 'change');

      // Session automatically selects or is clicked
      await page.waitForSelector('#session-list .session-item', { state: 'visible', timeout: 8000 });
      await page.locator('#session-list .session-item', { hasText: peerId }).click();

      await page.locator('.message-card.user', { hasText: testMsg }).waitFor({ state: 'visible', timeout: 10000 });
      await page.waitForSelector('.message-card.assistant', { state: 'visible', timeout: 10000 });

      const asstCardText = await page.textContent('.message-card.assistant .message-content');
      expect(asstCardText).toContain('[Contract-Driver-Reply]');
    } finally {
      await context.close();
    }
  });

  it('Server Restart Persistence: Stopping and starting PlatformServer retains DB state and messages', async () => {
    // 1. Create a dedicated SQLite file for restart testing
    const tempDbPath = join(tmpdir(), `enkeep-restart-test-${randomUUID()}.db`);

    // 2. Start Server 1
    const server1 = await createAndStartTestPlatformServer({ dbPath: tempDbPath });
    const { context: context1, page: page1 } = await createIsolatedPage(browser);

    const restartMsg = `Important message before reboot ${Date.now()}`;
    const restartPeer = `restart-peer-${Date.now()}`;

    try {
      await uiLogin(page1, server1.url, 'alice', 'AliceSecurePass123!');
      await page1.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Create dedicated space for restart test
      await uiCreateSpace(page1, { name: 'Restart Space', folder: 'restart-folder' });

      // Create session
      await uiCreateSession(page1, { peerId: restartPeer });
      await page1.waitForSelector('#session-list .session-item.active', { state: 'visible', timeout: 8000 });

      // Send message
      await uiSendMessage(page1, restartMsg);
      await page1.locator('.message-card.user', { hasText: restartMsg }).waitFor({ state: 'visible', timeout: 8000 });
      await page1.waitForSelector('.message-card.assistant', { state: 'visible', timeout: 15000 });
    } finally {
      await context1.close();
      // 3. Stop Server 1
      await server1.stop();
    }

    // 4. Start Server 2 on a new dynamic port with the same SQLite DB file
    const server2 = await createAndStartTestPlatformServer({ dbPath: tempDbPath });
    const { context: context2, page: page2 } = await createIsolatedPage(browser);

    try {
      // Log in on Server 2
      await uiLogin(page2, server2.url, 'alice', 'AliceSecurePass123!');
      await page2.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Wait for spaces and select the restart space
      await page2.waitForFunction(() => {
        const sel = document.querySelector('#space-select') as HTMLSelectElement | null;
        return sel && sel.options.length > 0 && sel.options[0].value !== '';
      }, { timeout: 8000 });

      const options = await page2.$$eval('#space-select option', (opts) =>
        opts.map((o) => ({ id: (o as HTMLOptionElement).value, text: o.textContent || '' }))
      );
      const targetOpt = options.find((o) => o.text.includes('Restart Space'));
      expect(targetOpt).toBeDefined();

      await page2.selectOption('#space-select', targetOpt!.id);
      await page2.dispatchEvent('#space-select', 'change');

      // Session and messages should automatically restore
      await page2.waitForSelector('#session-list .session-item', { state: 'visible', timeout: 8000 });
      await page2.locator('#session-list .session-item', { hasText: restartPeer }).click();

      // Verify user message and assistant reply persisted
      await page2.locator('.message-card.user', { hasText: restartMsg }).waitFor({ state: 'visible', timeout: 10000 });
      await page2.waitForSelector('.message-card.assistant', { state: 'visible', timeout: 10000 });

      const asstMsg = await page2.textContent('.message-card.assistant .message-content');
      expect(asstMsg).toContain('[Contract-Driver-Reply]');
    } finally {
      await context2.close();
      await server2.stop();
    }
  });
});
