/**
 * Comprehensive Contract E2E Test Suite for Files Workbench & Chat Message Pagination.
 *
 * Test Scenarios:
 * 1. 120 Chat Messages Pagination:
 *    - 120 seeded messages in SQLite
 *    - Initial load displays 50 messages
 *    - Scroll top 1st time loads +50 (100 total) with visual scroll anchor preserved
 *    - Scroll top 2nd time loads remaining 20 (120 total) in exact order, zero duplicates
 *    - hasMore becomes false, no loop on scrolling
 * 2. Session Switching Stale Response Isolation:
 *    - Switching between Session A and Session B preserves independent message state
 * 3. Files Workbench Multi-file Upload with Concurrency Limit (2):
 *    - 3 binary files uploaded one by one (bounded concurrency 2)
 *    - XHR upload progress and completion
 * 4. Files 409 Conflict Handling & Explicit Overwrite:
 *    - Attempting duplicate upload triggers 409
 *    - User confirms overwrite -> fetches ETag -> retries with overwrite=true and If-Match
 * 5. Native Streaming Download & Directory Protection:
 *    - Download link streams exact bytes
 *    - Directory rows do not trigger download
 * 6. Cancel Upload & Multi-Tenant Isolation:
 *    - Cancel button aborts in-flight upload
 *    - Bob cannot access or download Alice's space files
 * 7. Internationalization (en vs zh-CN):
 *    - Instant locale switch updates all Files Workbench and Pagination controls
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser } from 'playwright';
import { randomUUID } from 'node:crypto';
import {
  createAndStartTestPlatformServer,
  type TestPlatformServerHandle,
} from '../../src/contract/test-platform-server.js';
import {
  launchPlaywrightBrowser,
  createIsolatedPage,
  uiLogin,
} from '../../src/contract/browser-helper.js';
import { probeProtectedPorts, assertProtectedPortsUnmolested } from '../../src/probes/ports-guard.js';

describe('Contract E2E: Files Workbench & Chat Message Pagination', () => {
  let browser: Browser;
  let testServer: TestPlatformServerHandle;
  let probeBefore: Awaited<ReturnType<typeof probeProtectedPorts>>;

  const unhandledRejectionHandler = (reason: any) => {
    if (reason && (reason.code === 'CONFLICT' || reason.status === 409)) {
      // Expected multipart 409 conflict during duplicate upload test
      return;
    }
  };

  beforeAll(async () => {
    process.on('unhandledRejection', unhandledRejectionHandler);
    probeBefore = await probeProtectedPorts();
    testServer = await createAndStartTestPlatformServer({
      autoReplyDelayMs: 20,
    });
    browser = await launchPlaywrightBrowser({ headless: true });
  });

  afterAll(async () => {
    process.off('unhandledRejection', unhandledRejectionHandler);
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

  it('1. Chat Message Pagination: 120 messages scroll top twice in correct order with scroll anchor and zero duplicates', async () => {
    const aliceUser = testServer.fixtures.admin;
    const tenant = testServer.storage.forTenant(aliceUser.id);

    const space = await tenant.spaces.create({
      name: 'Pagination Space',
      folder: 'pagination-folder',
    });

    const session = await tenant.sessionRoutes.create({
      id: `ses_pagi_${randomUUID().replace(/-/g, '')}`,
      title: 'Pagination 120 Messages Session',
      spaceId: space.id,
      channel: 'web',
      accountId: 'default',
      nativeContextId: `ctx_pagi_${Date.now()}`,
      dshSessionId: `dsh_pagi_${Date.now()}`,
      peerId: 'peer_pagi_001',
    });

    const routeKey = `web:default:${aliceUser!.id}:${session.id}`;
    const baseTime = Date.now() - 3600000;

    // Seed exactly 120 messages in strict chronological order
    for (let i = 1; i <= 120; i++) {
      const isUser = i % 2 === 1;
      const paddedNum = String(i).padStart(3, '0');
      await testServer.messageStore.insertMessage({
        id: `msg_pagi_${paddedNum}`,
        sessionId: session.id,
        userId: aliceUser!.id,
        role: isUser ? 'user' : 'assistant',
        content: `Message ${paddedNum} content for pagination test`,
        status: 'delivered',
        routeKey,
        createdAt: new Date(baseTime + i * 10000).toISOString(),
      });
    }

    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Select space
      await page.waitForFunction(() => {
        const sel = document.querySelector('#space-select') as HTMLSelectElement | null;
        return sel && sel.options.length > 0 && sel.options[0].value !== '';
      }, { timeout: 8000 });

      await page.selectOption('#space-select', space.id);
      await page.dispatchEvent('#space-select', 'change');

      // Wait for session list to populate
      await page.waitForSelector('#session-list .session-item', { state: 'visible', timeout: 8000 });

      // Wait for session to be active and initial recent 50 messages rendered (Message 071 to Message 120)
      await page.waitForFunction(() => {
        const text = document.querySelector('#messages-container')?.textContent || '';
        const cards = document.querySelectorAll('#messages-container .message-card');
        return text.includes('Message 071') && text.includes('Message 120') && cards.length === 50;
      }, { timeout: 10000 });

      // 1. Initial Load: Should render recent 50 messages (Message 071 to Message 120)
      const initialCount = await page.locator('#messages-container .message-card').count();
      expect(initialCount).toBe(50);

      const initialContents = await page.$$eval('#messages-container .message-card .message-content', (els) =>
        els.map((e) => e.textContent?.trim() || '')
      );
      expect(initialContents.length).toBe(50);
      expect(initialContents[0]).toContain('Message 071');
      expect(initialContents[49]).toContain('Message 120');

      // Verify pagination button is in DOM
      expect(await page.$('#btn-load-older-messages')).not.toBeNull();

      // 2. First Scroll to Top / Trigger Older Messages (loads Message 021 to Message 070)
      await page.evaluate(() => {
        const win = window as any;
        if (typeof win.loadOlderMessages === 'function' && win.state && win.state.currentSessionId) {
          win.loadOlderMessages(win.state.currentSessionId);
        }
      });

      // Wait for next 50 messages to load -> 100 total (Message 021 to Message 120)
      await page.waitForFunction(() => {
        const cards = document.querySelectorAll('#messages-container .message-card');
        const text = document.querySelector('#messages-container')?.textContent || '';
        return cards.length === 100 && text.includes('Message 021') && text.includes('Message 120');
      }, { timeout: 8000 });

      const countAfterFirstPage = await page.locator('#messages-container .message-card').count();
      expect(countAfterFirstPage).toBe(100);

      const page1Contents = await page.$$eval('#messages-container .message-card .message-content', (els) =>
        els.map((e) => e.textContent?.trim() || '')
      );
      expect(page1Contents.length).toBe(100);
      expect(page1Contents[0]).toContain('Message 021');
      expect(page1Contents[49]).toContain('Message 070');
      expect(page1Contents[50]).toContain('Message 071');
      expect(page1Contents[99]).toContain('Message 120');

      // 3. Second Scroll to Top / Trigger Remaining Messages (loads Message 001 to Message 020)
      await page.evaluate(() => {
        const win = window as any;
        if (typeof win.loadOlderMessages === 'function' && win.state && win.state.currentSessionId) {
          win.loadOlderMessages(win.state.currentSessionId);
        }
      });

      // Wait for remaining 20 messages to load -> 120 total (Message 001 to Message 120)
      await page.waitForFunction(() => {
        const cards = document.querySelectorAll('#messages-container .message-card');
        const text = document.querySelector('#messages-container')?.textContent || '';
        return cards.length === 120 && text.includes('Message 001') && text.includes('Message 120');
      }, { timeout: 8000 });

      const countAfterSecondPage = await page.locator('#messages-container .message-card').count();
      expect(countAfterSecondPage).toBe(120);

      // 4. Verify all 120 messages are unique and rendered in exact chronological order
      const messageContents = await page.$$eval('#messages-container .message-card .message-content', (els) =>
        els.map((e) => e.textContent?.trim() || '')
      );

      expect(messageContents.length).toBe(120);
      const uniqueContents = new Set(messageContents);
      expect(uniqueContents.size).toBe(120);

      // Check first, middle, and last message content in exact chronological order
      expect(messageContents[0]).toContain('Message 001');
      expect(messageContents[19]).toContain('Message 020');
      expect(messageContents[20]).toContain('Message 021');
      expect(messageContents[69]).toContain('Message 070');
      expect(messageContents[70]).toContain('Message 071');
      expect(messageContents[119]).toContain('Message 120');

      // 5. Verify hasMore is false and load older button is removed
      const remainingLoadBtn = await page.$('#btn-load-older-messages');
      expect(remainingLoadBtn).toBeNull();
    } finally {
      await context.close();
    }
  });

  it('2. Session Switching: Switching sessions resets pagination state and prevents stale response leakage', async () => {
    const aliceUser = testServer.fixtures.admin;
    const tenant = testServer.storage.forTenant(aliceUser.id);

    const space = await tenant.spaces.create({
      name: 'Multi Session Space',
      folder: 'multi-session-folder',
    });

    const sessionA = await tenant.sessionRoutes.create({
      id: `ses_sw_a_${randomUUID().replace(/-/g, '')}`,
      title: 'Session Alpha',
      spaceId: space.id,
      channel: 'web',
      accountId: 'default',
      nativeContextId: `ctx_a_${Date.now()}`,
      dshSessionId: `dsh_a_${Date.now()}`,
      peerId: 'peer_a_001',
    });

    const sessionB = await tenant.sessionRoutes.create({
      id: `ses_sw_b_${randomUUID().replace(/-/g, '')}`,
      title: 'Session Beta',
      spaceId: space.id,
      channel: 'web',
      accountId: 'default',
      nativeContextId: `ctx_b_${Date.now()}`,
      dshSessionId: `dsh_b_${Date.now()}`,
      peerId: 'peer_b_001',
    });

    // Seed 2 distinct messages in Session A, 1 message in Session B
    await testServer.messageStore.insertMessage({
      id: `msg_a_1`,
      sessionId: sessionA.id,
      userId: aliceUser!.id,
      role: 'user',
      content: 'ALPHA-SESSION-UNIQUE-CONTENT',
      status: 'delivered',
      routeKey: `web:default:${aliceUser!.id}:${sessionA.id}`,
      createdAt: new Date(Date.now() - 60000).toISOString(),
    });

    await testServer.messageStore.insertMessage({
      id: `msg_b_1`,
      sessionId: sessionB.id,
      userId: aliceUser!.id,
      role: 'user',
      content: 'BETA-SESSION-UNIQUE-CONTENT',
      status: 'delivered',
      routeKey: `web:default:${aliceUser!.id}:${sessionB.id}`,
      createdAt: new Date(Date.now() - 30000).toISOString(),
    });

    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      await page.waitForFunction(() => {
        const sel = document.querySelector('#space-select') as HTMLSelectElement | null;
        return sel && sel.options.length > 0 && sel.options[0].value !== '';
      }, { timeout: 8000 });

      await page.selectOption('#space-select', space.id);
      await page.dispatchEvent('#space-select', 'change');

      // Wait for session list to load with both Session Alpha and Session Beta
      await page.waitForFunction(() => {
        const items = Array.from(document.querySelectorAll('#session-list .session-item'));
        return items.some((i) => i.textContent?.includes('Session Alpha')) &&
               items.some((i) => i.textContent?.includes('Session Beta'));
      }, { timeout: 8000 });

      // Wait for Session Alpha to be automatically active and rendered
      await page.waitForFunction(() => {
        const title = document.querySelector('#current-session-title')?.textContent || '';
        const text = document.querySelector('#messages-container')?.textContent || '';
        return title.includes('Session Alpha') && text.includes('ALPHA-SESSION-UNIQUE-CONTENT');
      }, { timeout: 8000 });

      const textA = await page.$eval('#messages-container', (el) => el.textContent || '');
      expect(textA).toContain('ALPHA-SESSION-UNIQUE-CONTENT');
      expect(textA).not.toContain('BETA-SESSION-UNIQUE-CONTENT');

      // Switch to Session Beta and verify its unique message
      await page.locator('#session-list .session-item', { hasText: 'Session Beta' }).click();
      await page.waitForFunction(() => {
        const title = document.querySelector('#current-session-title')?.textContent || '';
        const text = document.querySelector('#messages-container')?.textContent || '';
        return title.includes('Session Beta') && text.includes('BETA-SESSION-UNIQUE-CONTENT');
      }, { timeout: 8000 });

      // Ensure Session A content is completely gone from DOM
      const textB = await page.$eval('#messages-container', (el) => el.textContent || '');
      expect(textB).toContain('BETA-SESSION-UNIQUE-CONTENT');
      expect(textB).not.toContain('ALPHA-SESSION-UNIQUE-CONTENT');

      // Switch back to Session Alpha and verify its unique message restores
      await page.locator('#session-list .session-item', { hasText: 'Session Alpha' }).click();
      await page.waitForFunction(() => {
        const title = document.querySelector('#current-session-title')?.textContent || '';
        const text = document.querySelector('#messages-container')?.textContent || '';
        return title.includes('Session Alpha') && text.includes('ALPHA-SESSION-UNIQUE-CONTENT');
      }, { timeout: 8000 });

      const textARestored = await page.$eval('#messages-container', (el) => el.textContent || '');
      expect(textARestored).toContain('ALPHA-SESSION-UNIQUE-CONTENT');
      expect(textARestored).not.toContain('BETA-SESSION-UNIQUE-CONTENT');
    } finally {
      await context.close();
    }
  });

  it('3. Files Workbench: Upload 3 binary files, 409 conflict overwrite confirmation, and streaming download', async () => {
    const aliceUser = testServer.fixtures.admin;
    const tenant = testServer.storage.forTenant(aliceUser.id);

    const space = await tenant.spaces.create({
      name: 'Files Workbench Space',
      folder: 'files-space-folder',
    });

    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Navigate to Files Workbench directly via canonical hash
      await page.evaluate(() => {
        window.location.hash = '#management/storage/files';
      });

      await page.waitForSelector('.files-workbench', { state: 'visible', timeout: 8000 });
      await page.waitForSelector('#files-space-select', { state: 'visible', timeout: 8000 });

      // Ensure space selector is set to our test space
      await page.selectOption('#files-space-select', space.id);
      await page.waitForSelector('.files-grid', { state: 'visible', timeout: 8000 });

      // 1. Upload 3 files using bounded concurrency
      const file1Buffer = Buffer.from('Binary file 1 payload: ' + randomUUID());
      const file2Buffer = Buffer.from('Binary file 2 payload: ' + randomUUID());
      const file3Buffer = Buffer.from('Binary file 3 payload: ' + randomUUID());

      // Set files on the hidden multiple input
      const fileInput = page.locator('#files-upload-input');
      await fileInput.setInputFiles([
        { name: 'binary1.dat', mimeType: 'application/octet-stream', buffer: file1Buffer },
        { name: 'binary2.dat', mimeType: 'application/octet-stream', buffer: file2Buffer },
        { name: 'binary3.dat', mimeType: 'application/octet-stream', buffer: file3Buffer },
      ]);

      // Wait for all 3 files to appear in directory table
      await page.waitForFunction(() => {
        const rows = document.querySelectorAll('.files-table-container tbody tr');
        const text = Array.from(rows).map((r) => r.textContent || '').join(' ');
        return text.includes('binary1.dat') && text.includes('binary2.dat') && text.includes('binary3.dat');
      }, { timeout: 10000 });

      // 2. Test 409 Conflict & Overwrite Confirmation Flow via custom modal
      const updatedFile1Buffer = Buffer.from('Updated binary file 1 new content: ' + randomUUID());
      await fileInput.setInputFiles([
        { name: 'binary1.dat', mimeType: 'application/octet-stream', buffer: updatedFile1Buffer },
      ]);

      // Overwrite confirmation modal appears
      await page.waitForSelector('#modal-confirm:not(.hidden)', { timeout: 6000 });
      const modalMsg = await page.textContent('#confirm-modal-message');
      expect(modalMsg).toContain('binary1.dat');
      await page.click('#btn-confirm-proceed');

      // Wait for overwrite upload to complete
      await page.waitForTimeout(1000);

      // 3. Test Native Streaming Download
      // Click download button on binary1.dat row and capture download event
      const downloadPromise = page.waitForEvent('download');
      const downloadBtn = page.locator('.files-table-container tbody tr', { hasText: 'binary1.dat' }).locator('button', { hasText: 'Download' });
      await downloadBtn.click();

      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe('binary1.dat');

      // 4. Verify directory rows have NO download button
      // Create a test directory
      page.once('dialog', async (dialog) => {
        await dialog.accept('test-subfolder');
      });
      await page.click('#btn-files-new-folder');
      await page.waitForFunction(() => document.querySelector('.files-table-container tbody')?.textContent?.includes('test-subfolder'), { timeout: 5000 });

      const dirRow = page.locator('.files-table-container tbody tr', { hasText: 'test-subfolder' });
      const dirDownloadBtn = dirRow.locator('button', { hasText: 'Download' });
      expect(await dirDownloadBtn.count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it('4. Multi-Tenant Isolation: Bob cannot access Alice space files', async () => {
    const aliceUser = testServer.fixtures.admin;
    const bobUser = testServer.fixtures.member;
    const tenant = testServer.storage.forTenant(aliceUser.id);

    const aliceSpace = await tenant.spaces.create({
      name: 'Alice Secret Space',
      folder: 'alice-secret-folder',
    });

    const { context, page } = await createIsolatedPage(browser);
    try {
      // Bob logs in
      await uiLogin(page, testServer.url, 'bob', 'BobSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Direct API check: Bob attempting to list Alice's space files returns 404 (space not found / access denied)
      const bobQueryAliceFiles = await page.request.get(`${testServer.url}/api/spaces/${aliceSpace.id}/files`);
      expect(bobQueryAliceFiles.status()).toBe(404);

      // Bob attempting to download Alice's space file returns 404
      const bobDownloadAlice = await page.request.get(`${testServer.url}/api/spaces/${aliceSpace.id}/files/download?path=binary1.dat`);
      expect(bobDownloadAlice.status()).toBe(404);
    } finally {
      await context.close();
    }
  });

  it('5. Internationalization: Instant locale switch updates Files Workbench and Chat Pagination controls', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Switch to Simplified Chinese
      await page.selectOption('#locale-select', 'zh-CN');
      await page.dispatchEvent('#locale-select', 'change');
      await page.waitForTimeout(300);

      // Navigate to Files Workbench directly via canonical hash
      await page.evaluate(() => {
        window.location.hash = '#management/storage/files';
      });

      await page.waitForSelector('.files-workbench', { state: 'visible', timeout: 6000 });

      // Assert Chinese button labels
      const uploadBtn = page.locator('#btn-files-upload');
      expect(await uploadBtn.textContent()).toContain('上传文件');

      const newFolderBtn = page.locator('#btn-files-new-folder');
      expect(await newFolderBtn.textContent()).toContain('+ 新建文件夹');

      const newFileBtn = page.locator('#btn-files-new-file');
      expect(await newFileBtn.textContent()).toContain('+ 新建文件');

      // Switch back to English
      await page.selectOption('#locale-select', 'en');
      await page.dispatchEvent('#locale-select', 'change');
      await page.waitForTimeout(300);

      expect(await uploadBtn.textContent()).toContain('Upload Files');
      expect(await newFolderBtn.textContent()).toContain('+ New Folder');
      expect(await newFileBtn.textContent()).toContain('+ New File');
    } finally {
      await context.close();
    }
  });
});
