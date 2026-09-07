/**
 * Comprehensive Contract E2E Test Suite for Chat & Workspace Internationalization (i18n).
 *
 * Verifies:
 * 1. Alice switches to Chinese (zh-CN) -> All key Chat controls render in Chinese:
 *    - Header, buttons, sidebar, badges, composer hint & placeholder, role labels
 *    - Message content is preserved verbatim (not translated)
 * 2. Instant switch to English (en) -> All key Chat controls instantly update to English
 * 3. In-flight streaming delta flow during language switch -> Does not lose accumulated deltas
 * 4. Page refresh persistence -> Language preference is retained upon page reload
 * 5. Multi-tenant isolation -> Alice (zh-CN) and Bob (en) maintain independent language preferences
 * 6. Code blocks & copy button -> Copy state translates correctly (Copy / 复制 -> Copied! / 已复制！)
 * 7. Bare English strings scan -> Validates zero untranslated bare English UI text in Chinese mode
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
  uiCreateSpace,
  uiCreateSession,
  uiSendMessage,
} from '../../src/contract/browser-helper.js';
import { probeProtectedPorts, assertProtectedPortsUnmolested } from '../../src/probes/ports-guard.js';

describe('Contract E2E: Chat & Workspace Internationalization (i18n)', () => {
  let browser: Browser;
  let testServer: TestPlatformServerHandle;
  let probeBefore: Awaited<ReturnType<typeof probeProtectedPorts>>;

  beforeAll(async () => {
    probeBefore = await probeProtectedPorts();
    testServer = await createAndStartTestPlatformServer({
      autoReplyDelayMs: 40,
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

  it('1. Alice in Chinese: All Chat controls render in Chinese, sent message body remains raw', async () => {
    const aliceUser = testServer.fixtures.admin;
    const tenant = testServer.storage.forTenant(aliceUser.id);

    const space = await tenant.spaces.create({
      name: '中文测试空间',
      folder: 'zh-test-folder',
    });

    const session = await tenant.sessionRoutes.create({
      id: `ses_zh_${randomUUID().replace(/-/g, '')}`,
      title: '中文测试会话',
      spaceId: space.id,
      channel: 'web',
      accountId: 'default',
      nativeContextId: `ctx_zh_${Date.now()}`,
      dshSessionId: `dsh_zh_${Date.now()}`,
      peerId: 'peer_zh_001',
    });

    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Switch language to zh-CN via topbar or client API
      await page.evaluate(() => {
        const win = window as any;
        if (win.setLocale) {
          win.setLocale('zh-CN');
        } else if (win.EnkeepI18n?.setLocale) {
          win.EnkeepI18n.setLocale('zh-CN');
        }
      });

      // Select space and session
      await page.waitForFunction(() => {
        const sel = document.querySelector('#space-select') as HTMLSelectElement | null;
        return sel && sel.options.length > 0;
      }, { timeout: 8000 });

      await page.selectOption('#space-select', space.id);
      await page.dispatchEvent('#space-select', 'change');

      await page.waitForSelector('#session-list .session-item', { state: 'visible', timeout: 8000 });
      await page.locator('#session-list .session-item', { hasText: '中文测试会话' }).click();

      // Verify Chinese UI controls
      expect(await page.textContent('#btn-new-space')).toContain('空间');
      expect(await page.textContent('#btn-rename-space')).toContain('重命名');
      expect(await page.textContent('#btn-archive-space')).toContain('归档');
      expect(await page.textContent('#btn-new-session')).toContain('会话');
      expect(await page.textContent('#btn-send-message')).toContain('发送');
      expect(await page.textContent('#polling-badge')).toContain('实时同步');
      expect(await page.textContent('.composer-hint')).toContain('按 Enter 发送');

      const placeholder = await page.getAttribute('#session-search-input', 'placeholder');
      expect(placeholder).toContain('搜索会话');

      // Send a message
      const rawUserMessage = '这是一条原生用户测试消息，包含英文 Technical Code: `const x = 123;`';
      await uiSendMessage(page, rawUserMessage);

      // Verify user message is rendered verbatim (content not translated)
      await page.waitForSelector('.message-card.user', { state: 'visible', timeout: 8000 });
      const userCardText = await page.textContent('.message-card.user .message-content');
      expect(userCardText).toContain('这是一条原生用户测试消息，包含英文 Technical Code:');
      expect(await page.textContent('.message-card.user code')).toBe('const x = 123;');

      // Verify role sender label is localized
      const userSenderLabel = await page.textContent('.message-card.user .sender');
      expect(userSenderLabel).toBe('您');

      // Verify assistant reply arrived via live sync
      await page.waitForSelector('.message-card.assistant', { state: 'visible', timeout: 15000 });
      const asstSenderLabel = await page.textContent('.message-card.assistant .sender');
      expect(asstSenderLabel).toBe('AI 助手');

      // Verify message status badge in Chinese
      const userStatusBadge = await page.textContent('.message-card.user .message-status');
      expect(userStatusBadge).toBe('已投递');
    } finally {
      await context.close();
    }
  });

  it('2. Instant switch to English and back: All Chat controls immediately update without losing state', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Start in zh-CN
      await page.evaluate(() => {
        const win = window as any;
        win.setLocale ? win.setLocale('zh-CN') : win.EnkeepI18n?.setLocale('zh-CN');
      });

      expect(await page.textContent('#btn-send-message')).toBe('发送');
      expect(await page.textContent('#btn-new-space')).toContain('空间');

      // Switch to English
      await page.evaluate(() => {
        const win = window as any;
        win.setLocale ? win.setLocale('en') : win.EnkeepI18n?.setLocale('en');
      });

      expect(await page.textContent('#btn-send-message')).toBe('Send');
      expect(await page.textContent('#btn-new-space')).toContain('Space');
      expect(await page.textContent('#polling-badge')).toBe('Live Sync');

      // Switch back to Chinese
      await page.evaluate(() => {
        const win = window as any;
        win.setLocale ? win.setLocale('zh-CN') : win.EnkeepI18n?.setLocale('zh-CN');
      });

      expect(await page.textContent('#btn-send-message')).toBe('发送');
      expect(await page.textContent('#btn-new-space')).toContain('空间');
      expect(await page.textContent('#polling-badge')).toBe('实时同步');
    } finally {
      await context.close();
    }
  });

  it('3. Streaming in-flight delta flow: Switching locale preserves stream buffer and accumulator', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Create an active session
      await uiCreateSpace(page, { name: `Stream Space ${Date.now()}`, folder: `stream-folder-${Date.now()}` });
      await uiCreateSession(page, { peerId: 'stream-peer-001' });
      await page.waitForSelector('#session-list .session-item.active', { state: 'visible', timeout: 8000 });

      // Simulate streaming state in client state
      await page.evaluate(() => {
        const win = window as any;
        win.state.streamingState = {
          sessionId: win.state.currentSessionId,
          streamId: 'msgstream_test_001',
          text: 'Streaming delta chunk 1... ',
          accumulatedLength: 26,
          createdAt: new Date().toISOString(),
          isThinking: false,
          streamEnded: false,
          cancelled: false,
        };
        win.renderMessages();
      });

      // Switch locale during simulated streaming
      await page.evaluate(() => {
        const win = window as any;
        win.setLocale ? win.setLocale('zh-CN') : win.EnkeepI18n?.setLocale('zh-CN');
      });

      // Streaming bubble text must be preserved
      await page.waitForSelector('.message-card.assistant.streaming', { state: 'visible', timeout: 5000 });
      const streamContent = await page.textContent('.message-card.assistant.streaming .message-content');
      expect(streamContent).toContain('Streaming delta chunk 1...');

      // Assistant sender label is updated to Chinese
      const streamSender = await page.textContent('.message-card.assistant.streaming .sender');
      expect(streamSender).toBe('AI 助手');

      // Streaming badge is updated to Chinese
      const streamBadge = await page.textContent('.message-card.assistant.streaming .message-status');
      expect(streamBadge).toBe('流式传输中');
    } finally {
      await context.close();
    }
  });

  it('4. Refresh Persistence: Reloading page preserves language preference', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Set language to zh-CN with localStorage persistence
      await page.evaluate(() => {
        const win = window as any;
        win.setLocale ? win.setLocale('zh-CN') : win.EnkeepI18n?.setLocale('zh-CN');
      });

      expect(await page.textContent('#btn-send-message')).toBe('发送');

      // Reload page
      await page.reload();
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Verify Chinese language is preserved after reload
      expect(await page.textContent('#btn-send-message')).toBe('发送');
      expect(await page.textContent('#btn-new-space')).toContain('空间');
    } finally {
      await context.close();
    }
  });

  it('5. Multi-Tenant Independent Preferences: Alice (zh-CN) vs Bob (en)', async () => {
    // Session 1: Alice in zh-CN
    const { context: aliceContext, page: alicePage } = await createIsolatedPage(browser);
    // Session 2: Bob in en
    const { context: bobContext, page: bobPage } = await createIsolatedPage(browser);

    try {
      // Alice logs in and selects zh-CN
      await uiLogin(alicePage, testServer.url, 'alice', 'AliceSecurePass123!');
      await alicePage.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });
      await alicePage.evaluate(() => {
        const win = window as any;
        win.setLocale ? win.setLocale('zh-CN') : win.EnkeepI18n?.setLocale('zh-CN');
      });

      // Bob logs in and selects en
      await uiLogin(bobPage, testServer.url, 'bob', 'BobSecurePass123!');
      await bobPage.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });
      await bobPage.evaluate(() => {
        const win = window as any;
        win.setLocale ? win.setLocale('en') : win.EnkeepI18n?.setLocale('en');
      });

      // Verify Alice has Chinese UI
      expect(await alicePage.textContent('#btn-send-message')).toBe('发送');
      expect(await alicePage.textContent('#polling-badge')).toBe('实时同步');

      // Verify Bob has English UI
      expect(await bobPage.textContent('#btn-send-message')).toBe('Send');
      expect(await bobPage.textContent('#polling-badge')).toBe('Live Sync');
    } finally {
      await aliceContext.close();
      await bobContext.close();
    }
  });

  it('6. Code Block Copy Button Localization: Copy -> Copied! / 复制 -> 已复制！', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Create an active session
      await uiCreateSpace(page, { name: `Code Space ${Date.now()}`, folder: `code-folder-${Date.now()}` });
      await uiCreateSession(page, { peerId: 'code-peer-001' });
      await page.waitForSelector('#session-list .session-item.active', { state: 'visible', timeout: 8000 });

      // Simulate message with fenced code block in zh-CN
      await page.evaluate(() => {
        const win = window as any;
        win.setLocale ? win.setLocale('zh-CN') : win.EnkeepI18n?.setLocale('zh-CN');
        win.state.messages = [
          {
            id: 'msg_code_test',
            role: 'assistant',
            content: '```javascript\nconsole.log("hello i18n");\n```',
            status: 'delivered',
            createdAt: new Date().toISOString(),
          },
        ];
        win.renderMessages();
      });

      await page.waitForSelector('.code-block-wrapper', { state: 'visible', timeout: 5000 });

      // Verify language identifier is unlocalized
      const langText = await page.textContent('.code-block-header .code-lang');
      expect(langText).toBe('javascript');

      // Verify copy button is localized in Chinese
      const copyBtn = page.locator('.code-block-header .btn-copy-code');
      expect(await copyBtn.textContent()).toBe('复制');

      // Click copy button and assert copied state
      await copyBtn.click();
      await page.waitForFunction(() => {
        const btn = document.querySelector('.btn-copy-code');
        return btn && btn.textContent === '已复制！';
      }, { timeout: 3000 });
    } finally {
      await context.close();
    }
  });

  it('7. Whitelist Scan: Zero untranslated bare English UI strings in Chat workspace scope under zh-CN', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Create a test space & session and select it
      const spaceName = `扫描空间_${Date.now()}`;
      await uiCreateSpace(page, { name: spaceName, folder: `scan-folder-${Date.now()}` });
      await uiCreateSession(page, { peerId: 'scan-peer' });

      // Switch to Chinese
      await page.evaluate(() => {
        const win = window as any;
        win.setLocale ? win.setLocale('zh-CN') : win.EnkeepI18n?.setLocale('zh-CN');
      });

      await page.waitForSelector('#view-workspace', { state: 'visible', timeout: 5000 });

      // Scan all text nodes and user-visible strings inside #view-workspace (excluding user message body & code contents)
      const chatScopeStrings: string[] = await page.evaluate(() => {
        const workspaceEl = document.getElementById('view-workspace');
        if (!workspaceEl) return [];

        const results: string[] = [];
        const walker = document.createTreeWalker(workspaceEl, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            // Ignore script, style, user message markdown contents, and code blocks
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (parent.closest('.message-content') || parent.closest('code') || parent.closest('pre')) {
              return NodeFilter.FILTER_REJECT;
            }
            if (parent.closest('#space-select') || parent.closest('#session-space-select')) {
              return NodeFilter.FILTER_REJECT;
            }
            const text = (node.nodeValue || '').trim();
            if (!text || /^[\d\s•/:/,\.\-_~+=#@!?()\[\]{}%&*|\\]+$/.test(text)) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        });

        while (walker.nextNode()) {
          const val = (walker.currentNode.nodeValue || '').trim();
          if (val) results.push(val);
        }

        // Also check placeholders and titles
        const inputs = workspaceEl.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea, button');
        inputs.forEach((el) => {
          if (el.placeholder) results.push(el.placeholder.trim());
          if (el.title) results.push(el.title.trim());
        });

        return results;
      });

      // Whitelisted non-translatable patterns:
      // Numbers, punctuation, timestamps, brand name 'Enkeep', symbols, user-named space/session titles
      const englishWordPattern = /\b[A-Za-z]{3,}\b/;
      const WHITELISTED_TERMS = [
        'Enkeep',
        'Gen',
        'Enter',
        'Shift',
        'Line',
        'Model',
        'count',
        'Docker',
        'Host',
        spaceName,
        'scan-peer',
        'alice',
        'user',
        'admin',
      ];

      const bareEnglishViolations = chatScopeStrings.filter((str) => {
        if (WHITELISTED_TERMS.some((term) => str.includes(term))) {
          return false;
        }
        return englishWordPattern.test(str);
      });

      expect(bareEnglishViolations).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
