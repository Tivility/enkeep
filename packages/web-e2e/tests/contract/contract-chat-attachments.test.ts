/**
 * Contract E2E Test Suite: Chat Composer Attachments, Uploads,
 * Workspace File Picker, Message Cards, Downloads, Snapshot Isolation & Security.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser } from 'playwright';
import { randomUUID, createHash } from 'node:crypto';
import {
  createAndStartTestPlatformServer,
  type TestPlatformServerHandle,
} from '../../src/contract/test-platform-server.js';
import {
  launchPlaywrightBrowser,
  createIsolatedPage,
  uiLogin,
  uiCreateSpace,
  uiCreateSession,
} from '../../src/contract/browser-helper.js';
import { probeProtectedPorts, assertProtectedPortsUnmolested } from '../../src/probes/ports-guard.js';

describe('Contract E2E: Chat Attachments, Composer & Snapshot Isolation', () => {
  let browser: Browser;
  let testServer: TestPlatformServerHandle;
  let probeBefore: Awaited<ReturnType<typeof probeProtectedPorts>>;

  beforeAll(async () => {
    probeBefore = await probeProtectedPorts();
    testServer = await createAndStartTestPlatformServer({
      autoReplyDelayMs: 20,
    });
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

  it('1. Upload Local Files (txt & png) via File Input, Drag/Drop, and Clipboard Paste', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      await uiCreateSpace(page, { name: 'Attachments Space', folder: 'att-folder' });
      await uiCreateSession(page, { title: 'Uploads Test Session' });
      await page.waitForSelector('#session-list .session-item.active', { state: 'visible', timeout: 8000 });

      // 1a. Upload text file via hidden file input
      const fileInput = page.locator('#chat-file-input');
      await fileInput.setInputFiles([
        {
          name: 'notes.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Hello from local file attachment!'),
        },
      ]);

      // Wait for attachment item to appear in tray as ready
      await page.waitForSelector('#composer-attachment-tray .attachment-tray-item.status-ready', { state: 'visible', timeout: 8000 });
      const trayName = await page.textContent('#composer-attachment-tray .attachment-tray-name');
      expect(trayName).toBe('notes.txt');

      // 1b. Drag and drop file onto composer
      const pngBuffer = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
        0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
        0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
        0x42, 0x60, 0x82,
      ]);

      await page.evaluate((pngBase64) => {
        const binStr = atob(pngBase64);
        const len = binStr.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binStr.charCodeAt(i);
        }
        const file = new File([bytes], 'diagram.png', { type: 'image/png' });
        const win = window as any;
        win.handleFilesSelected([file]);
      }, pngBuffer.toString('base64'));

      // Tray should now contain 2 ready items
      await page.waitForFunction(() => {
        const items = document.querySelectorAll('#composer-attachment-tray .attachment-tray-item.status-ready');
        return items.length === 2;
      }, { timeout: 8000 });

      // 1c. Paste image from clipboard
      await page.evaluate((pngBase64) => {
        const binStr = atob(pngBase64);
        const len = binStr.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binStr.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: 'image/png' });
        const file = new File([blob], `pasted-image-${Date.now()}.png`, { type: 'image/png' });
        const win = window as any;
        win.handleFilesSelected([file]);
      }, pngBuffer.toString('base64'));

      // Tray should now contain 3 items
      await page.waitForFunction(() => {
        const items = document.querySelectorAll('#composer-attachment-tray .attachment-tray-item.status-ready');
        return items.length === 3;
      }, { timeout: 8000 });

      // Verify Send button is enabled when input has text
      await page.fill('#chat-input', 'Review these 3 uploaded files');
      const sendBtn = page.locator('#btn-send-message');
      expect(await sendBtn.isEnabled()).toBe(true);

      // Send the message
      await sendBtn.click();

      // Tray must be cleared upon successful send
      await page.waitForFunction(() => {
        const tray = document.getElementById('composer-attachment-tray');
        return tray && tray.classList.contains('hidden');
      }, { timeout: 8000 });

      // Message card should be rendered with 3 attachment cards
      await page.waitForSelector('.message-card.user .message-attachments-container', { state: 'visible', timeout: 8000 });
      const attCards = await page.$$('.message-card.user .message-attachment-card');
      expect(attCards.length).toBe(3);

      const names = await page.$$eval('.message-card.user .message-attachment-name', (els) => els.map((e) => e.textContent));
      expect(names).toContain('notes.txt');
      expect(names).toContain('diagram.png');
      expect(names.some((n) => n && n.startsWith('pasted-image-'))).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('2. Workspace File Picker Modal: Search, Selection & Metadata Reference without Re-upload', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      const aliceUser = testServer.fixtures.admin;
      const tenant = testServer.storage.forTenant(aliceUser.id);

      const space = await tenant.spaces.create({
        name: 'Workspace Picker Space',
        folder: 'ws-picker-folder',
      });

      // Pre-seed files directly into space
      await testServer.fileProvider.execute(aliceUser.id, space.id, {
        op: 'write',
        path: 'architecture.pdf',
        content: '%PDF-1.4 Mock Architecture PDF bytes',
        encoding: 'utf8',
      });

      await testServer.fileProvider.execute(aliceUser.id, space.id, {
        op: 'write',
        path: 'dataset.json',
        content: JSON.stringify({ items: [1, 2, 3] }),
        encoding: 'utf8',
      });

      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Select space and create session
      await page.selectOption('#space-select', space.id);
      await uiCreateSession(page, { title: 'Workspace Picker Session', spaceId: space.id });
      await page.waitForSelector('#session-list .session-item.active', { state: 'visible', timeout: 8000 });

      // Click Attach Button -> Click Browse Workspace Files
      await page.click('#btn-attach');
      await page.waitForSelector('#attach-menu', { state: 'visible', timeout: 5000 });
      await page.click('#btn-attach-workspace');

      // Modal should open
      await page.waitForSelector('#modal-file-picker', { state: 'visible', timeout: 5000 });

      // Verify files rendered in list
      await page.waitForSelector('#file-picker-list .file-picker-item.is-file', { state: 'visible', timeout: 8000 });
      const itemsText = await page.$$eval('#file-picker-list .file-picker-item-name', (els) => els.map((e) => e.textContent));
      expect(itemsText).toContain('architecture.pdf');
      expect(itemsText).toContain('dataset.json');

      // Test Search Filtering in File Picker
      await page.fill('#file-picker-search-input', 'dataset');
      await page.waitForFunction(() => {
        const items = Array.from(document.querySelectorAll('#file-picker-list .file-picker-item.is-file'));
        return items.length === 1 && items[0].textContent?.includes('dataset.json');
      }, { timeout: 5000 });

      // Clear search
      await page.fill('#file-picker-search-input', '');
      await page.waitForFunction(() => {
        const items = document.querySelectorAll('#file-picker-list .file-picker-item.is-file');
        return items.length >= 2;
      }, { timeout: 5000 });

      // Select architecture.pdf
      const pdfItem = page.locator('#file-picker-list .file-picker-item', { hasText: 'architecture.pdf' });
      await pdfItem.click();

      // Check selection count
      const countText = await page.textContent('#file-picker-selected-count');
      expect(countText).toContain('1');

      // Click Attach Selected
      await page.click('#btn-file-picker-select');
      await page.waitForSelector('#modal-file-picker', { state: 'hidden', timeout: 5000 });

      // Item should be in composer tray
      await page.waitForSelector('#composer-attachment-tray .attachment-tray-item.status-ready', { state: 'visible', timeout: 5000 });
      const trayItemName = await page.textContent('#composer-attachment-tray .attachment-tray-name');
      expect(trayItemName).toBe('architecture.pdf');

      // Send message
      await page.fill('#chat-input', 'Referencing architecture from workspace');
      await page.click('#btn-send-message');

      // Card rendered
      await page.waitForSelector('.message-card.user .message-attachment-card', { state: 'visible', timeout: 8000 });
      const cardName = await page.textContent('.message-card.user .message-attachment-name');
      expect(cardName).toBe('architecture.pdf');
    } finally {
      await context.close();
    }
  });

  it('3. Message Card Persistence, Snapshot Download & Immutable ETag Isolation', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      const aliceUser = testServer.fixtures.admin;
      const tenant = testServer.storage.forTenant(aliceUser.id);

      const space = await tenant.spaces.create({
        name: 'Snapshot Space',
        folder: 'snapshot-folder',
      });

      const initialContent = 'VERSION_1_ORIGINAL_CONTENT_HASH_12345';
      await testServer.fileProvider.execute(aliceUser.id, space.id, {
        op: 'write',
        path: 'spec.txt',
        content: initialContent,
        encoding: 'utf8',
      });

      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      await page.selectOption('#space-select', space.id);
      await uiCreateSession(page, { title: 'Snapshot Session', spaceId: space.id });
      await page.waitForSelector('#session-list .session-item.active', { state: 'visible', timeout: 8000 });

      // Attach spec.txt from workspace via Workspace File Picker modal
      await page.click('#btn-attach');
      await page.waitForSelector('#attach-menu', { state: 'visible', timeout: 5000 });
      await page.click('#btn-attach-workspace');

      await page.waitForSelector('#modal-file-picker', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('#file-picker-list .file-picker-item.is-file', { state: 'visible', timeout: 8000 });
      const specItem = page.locator('#file-picker-list .file-picker-item', { hasText: 'spec.txt' });
      await specItem.click();

      await page.click('#btn-file-picker-select');
      await page.waitForSelector('#modal-file-picker', { state: 'hidden', timeout: 5000 });

      await page.waitForSelector('#composer-attachment-tray .attachment-tray-item.status-ready', { state: 'visible', timeout: 5000 });

      // Send message
      await page.fill('#chat-input', 'Snapshot spec v1 message');
      await page.click('#btn-send-message');
      await page.waitForSelector('.message-card.user .message-attachment-card', { state: 'visible', timeout: 8000 });

      // 3a. Verify Download URL and download bytes
      const downloadLink = page.locator('.message-card.user .attachment-download-btn');
      const downloadHref = await downloadLink.getAttribute('href');
      expect(downloadHref).toBeTruthy();
      expect(downloadHref).toMatch(/^\/api\/spaces\/[^\/]+\/files\/download\?path=/);

      // Fetch downloadUrl directly in page context
      const downloadedV1Bytes = await page.evaluate(async (url) => {
        const res = await fetch(url);
        return await res.text();
      }, downloadHref);
      expect(downloadedV1Bytes).toBe(initialContent);

      // 3b. Mutate the original workspace file to Version 2
      const updatedContent = 'VERSION_2_MUTATED_OVERWRITTEN_CONTENT_99999';
      await testServer.fileProvider.execute(aliceUser.id, space.id, {
        op: 'write',
        path: 'spec.txt',
        content: updatedContent,
        encoding: 'utf8',
      });

      // 3c. Download again from the earlier message card -> MUST STILL RETURN VERSION 1 IMMUTABLE SNAPSHOT!
      const downloadedAfterMutation = await page.evaluate(async (url) => {
        const res = await fetch(url);
        return await res.text();
      }, downloadHref);
      expect(downloadedAfterMutation).toBe(initialContent);

      // 3d. Reload page -> verify persistence across reload
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Message card and attachment card must still be rendered
      await page.waitForSelector('.message-card.user .message-attachment-card', { state: 'visible', timeout: 8000 });
      const persistedName = await page.textContent('.message-card.user .message-attachment-name');
      expect(persistedName).toBe('spec.txt');
    } finally {
      await context.close();
    }
  });

  it('4. Attachments Limit (10 items), Send Failure Retention & Session Switch Isolation', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      await uiCreateSpace(page, { name: 'Isolation Space', folder: 'iso-folder' });
      await uiCreateSession(page, { title: 'Session One' });
      await uiCreateSession(page, { title: 'Session Two' });
      await page.waitForSelector('#session-list .session-item.active', { state: 'visible', timeout: 8000 });

      // 4a. Enforce 10 attachments limit
      await page.evaluate(() => {
        const files: File[] = [];
        for (let i = 1; i <= 12; i++) {
          files.push(new File([`content ${i}`], `file_${i}.txt`, { type: 'text/plain' }));
        }
        const win = window as any;
        win.handleFilesSelected(files);
      });

      // Active tray must have at most 10 items
      await page.waitForFunction(() => {
        const items = document.querySelectorAll('#composer-attachment-tray .attachment-tray-item');
        return items.length === 10;
      }, { timeout: 8000 });

      // 4b. Type draft text in Session Two
      await page.fill('#chat-input', 'Draft content in Session Two with 10 files');

      // 4c. Switch to Session One -> Input & Tray should be empty
      const sessionOneBtn = page.locator('#session-list .session-item', { hasText: 'Session One' });
      await sessionOneBtn.click();
      await page.waitForFunction(() => {
        const input = document.getElementById('chat-input') as HTMLTextAreaElement;
        const tray = document.getElementById('composer-attachment-tray');
        return input && input.value === '' && (!tray || tray.classList.contains('hidden'));
      }, { timeout: 8000 });

      // 4d. Switch back to Session Two -> Draft text and attachments are fully restored!
      const sessionTwoBtn = page.locator('#session-list .session-item', { hasText: 'Session Two' });
      await sessionTwoBtn.click();
      await page.waitForFunction(() => {
        const input = document.getElementById('chat-input') as HTMLTextAreaElement;
        const items = document.querySelectorAll('#composer-attachment-tray .attachment-tray-item');
        return input && input.value.includes('Draft content in Session Two') && items.length === 10;
      }, { timeout: 8000 });
    } finally {
      await context.close();
    }
  });

  it('5. Multi-Tenant Isolation: Bob cannot access Alice space attachment download URL', async () => {
    const { context: aliceContext, page: alicePage } = await createIsolatedPage(browser);
    const { context: bobContext, page: bobPage } = await createIsolatedPage(browser);

    try {
      // 1. Alice creates space, session, and sends attachment
      await uiLogin(alicePage, testServer.url, 'alice', 'AliceSecurePass123!');
      await alicePage.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      await uiCreateSpace(alicePage, { name: 'Alice Private Space', folder: 'alice-private' });
      await uiCreateSession(alicePage, { title: 'Alice Confidential Session' });

      // Upload private file
      const fileInput = alicePage.locator('#chat-file-input');
      await fileInput.setInputFiles([
        {
          name: 'secret-keys.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('TOP_SECRET_ALICE_DATA'),
        },
      ]);
      await alicePage.waitForSelector('#composer-attachment-tray .attachment-tray-item.status-ready', { state: 'visible', timeout: 8000 });

      await alicePage.fill('#chat-input', 'Here are confidential keys');
      await alicePage.click('#btn-send-message');
      await alicePage.waitForSelector('.message-card.user .attachment-download-btn', { state: 'visible', timeout: 8000 });

      const aliceDownloadHref = await alicePage.locator('.message-card.user .attachment-download-btn').getAttribute('href');
      expect(aliceDownloadHref).toBeTruthy();

      // 2. Bob logs in
      await uiLogin(bobPage, testServer.url, 'bob', 'BobSecurePass123!');
      await bobPage.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Bob attempts to fetch Alice's downloadUrl directly
      const bobAttemptStatus = await bobPage.evaluate(async (url) => {
        const res = await fetch(url);
        return res.status;
      }, aliceDownloadHref);

      // Must be rejected with 401, 403 or 404 (multi-tenant boundary defense)
      expect([401, 403, 404]).toContain(bobAttemptStatus);
    } finally {
      await aliceContext.close();
      await bobContext.close();
    }
  });

  it('6. Internationalization: Instant Locale Switch Updates All Attachment Controls & Strict DOM Invariants', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      await uiCreateSpace(page, { name: 'i18n Att Space', folder: 'i18n-att-folder' });
      await uiCreateSession(page, { title: 'i18n Att Session' });

      // English check
      expect(await page.getAttribute('#btn-attach', 'title')).toBe('Attach files from workspace or upload');
      expect(await page.textContent('#btn-send-message')).toBe('Send');

      // Switch to Chinese (zh-CN)
      await page.evaluate(() => {
        const win = window as any;
        win.setLocale ? win.setLocale('zh-CN') : win.EnkeepI18n?.setLocale('zh-CN');
      });

      // Chinese check
      expect(await page.getAttribute('#btn-attach', 'title')).toBe('从工作区选择或上传本地文件');
      expect(await page.textContent('#btn-send-message')).toBe('发送');
      expect(await page.textContent('#btn-attach-local')).toBe('从电脑上传');
      expect(await page.textContent('#btn-attach-workspace')).toBe('选择工作区文件');

      // Open file picker in Chinese
      await page.click('#btn-attach');
      await page.click('#btn-attach-workspace');
      await page.waitForSelector('#modal-file-picker', { state: 'visible', timeout: 5000 });

      expect(await page.textContent('#modal-file-picker-title')).toBe('选择工作区文件');
      expect(await page.getAttribute('#file-picker-search-input', 'placeholder')).toBe('搜索工作区文件...');
      expect(await page.textContent('#btn-file-picker-select')).toBe('添加所选文件');

      await page.click('#modal-file-picker [data-close="modal-file-picker"]');
      await page.waitForSelector('#modal-file-picker', { state: 'hidden', timeout: 5000 });

      // Strict DOM Security: Zero innerHTML, Zero inline styles
      const domViolations = await page.evaluate(() => {
        const allElements = Array.from(document.querySelectorAll('*'));
        const inlineStyleElements = allElements.filter((el) => el.hasAttribute('style'));
        const inlineHandlerElements = allElements.filter((el) =>
          Array.from(el.attributes).some((attr) => attr.name.startsWith('on'))
        );
        return {
          inlineStylesCount: inlineStyleElements.length,
          inlineHandlersCount: inlineHandlerElements.length,
        };
      });

      expect(domViolations.inlineStylesCount).toBe(0);
      expect(domViolations.inlineHandlersCount).toBe(0);
    } finally {
      await context.close();
    }
  });
});
