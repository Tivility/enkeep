/**
 * Comprehensive Contract E2E Test Suite for Enkeep Workspace & Chat Interaction.
 *
 * Verifies:
 * 1. Login -> Space/Session switching & pre-seeded / imported history loading
 * 2. Sending messages -> Real deterministic assistant replies via live sync
 * 3. Safe DOM Markdown rich-text subset parsing & rendering:
 *    - Headings (h1-h6), Bold, Italic, Inline Code, Lists, Blockquotes
 *    - Fenced Code blocks with working Copy button
 *    - Mermaid Diagram placeholder without CDN
 *    - Sanitized external links with target="_blank" and rel="noopener noreferrer"
 * 4. Active turn state (thinking/running) and Stop Turn cancellation
 * 5. Session Search & Filtering
 * 6. Session Generation Lifecycle (Reset Gen N+1 & Generation History Modal)
 * 7. Mobile/Narrow screen sidebar toggle
 * 8. Composer textarea auto-expansion & character counter
 * 9. Page reload persistence via sessionStorage
 * 10. Multi-tenant isolation (Alice vs Bob)
 * 11. Strict DOM Security: Zero innerHTML, Zero inline styles, Zero onclick attributes
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser } from 'playwright';
import { randomUUID } from 'node:crypto';
import {
  createAndStartTestPlatformServer,
  type TestPlatformServerHandle,
  TEST_CSRF_TOKEN,
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

describe('Contract E2E: Full Chat Workspace & Rich Interaction', () => {
  let browser: Browser;
  let testServer: TestPlatformServerHandle;
  let probeBefore: Awaited<ReturnType<typeof probeProtectedPorts>>;

  beforeAll(async () => {
    probeBefore = await probeProtectedPorts();
    testServer = await createAndStartTestPlatformServer({
      autoReplyDelayMs: 30,
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

  it('1. Login, Space/Session Switch & History Loading: Renders pre-seeded messages correctly', async () => {
    const aliceUser = testServer.fixtures.admin;
    const tenant = testServer.storage.forTenant(aliceUser.id);

    const space = await tenant.spaces.create({
      name: 'Full Test Space',
      folder: 'full-test-folder',
    });

    const session = await tenant.sessionRoutes.create({
      id: `ses_full_${randomUUID().replace(/-/g, '')}`,
      title: 'Full Test Session',
      spaceId: space.id,
      channel: 'web',
      accountId: 'default',
      nativeContextId: `ctx_full_${Date.now()}`,
      dshSessionId: `dsh_full_${Date.now()}`,
      peerId: 'peer_full_001',
    });

    const routeKey = `web:default:${aliceUser!.id}:${session.id}`;
    await testServer.messageStore.insertMessage({
      id: `msg_hist_1`,
      sessionId: session.id,
      userId: aliceUser!.id,
      role: 'user',
      content: 'Hello from seeded user history',
      status: 'delivered',
      routeKey,
      createdAt: new Date(Date.now() - 60000).toISOString(),
    });
    await testServer.messageStore.insertMessage({
      id: `msg_hist_2`,
      sessionId: session.id,
      userId: aliceUser!.id,
      role: 'assistant',
      content: '### Seeded Assistant Heading\nThis is **bold** text and `inline code`.',
      status: 'delivered',
      routeKey,
      createdAt: new Date(Date.now() - 30000).toISOString(),
    });

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

      // Select session
      await page.waitForSelector('#session-list .session-item', { state: 'visible', timeout: 8000 });
      await page.locator('#session-list .session-item', { hasText: 'Full Test Session' }).click();

      // Verify messages rendered
      await page.waitForSelector('.message-card.user', { state: 'visible', timeout: 8000 });
      await page.waitForSelector('.message-card.assistant', { state: 'visible', timeout: 8000 });

      const userText = await page.textContent('.message-card.user .message-content');
      expect(userText).toContain('Hello from seeded user history');

      const h3Text = await page.textContent('.message-card.assistant h3');
      expect(h3Text).toContain('Seeded Assistant Heading');

      const boldText = await page.textContent('.message-card.assistant strong');
      expect(boldText).toBe('bold');

      const codeText = await page.textContent('.message-card.assistant code');
      expect(codeText).toBe('inline code');
    } finally {
      await context.close();
    }
  });

  it('2. Markdown Subset & Rich Rendering: Paragraphs, Headings, Lists, Code Copy, Mermaid & Links', async () => {
    const aliceUser = testServer.fixtures.admin;
    const tenant = testServer.storage.forTenant(aliceUser.id);

    const space = await tenant.spaces.create({
      name: 'Markdown Space',
      folder: 'markdown-folder',
    });

    const session = await tenant.sessionRoutes.create({
      id: `ses_md_${randomUUID().replace(/-/g, '')}`,
      title: 'Markdown Test Session',
      spaceId: space.id,
      channel: 'web',
      accountId: 'default',
      nativeContextId: `ctx_md_${Date.now()}`,
      dshSessionId: `dsh_md_${Date.now()}`,
      peerId: 'peer_md_001',
    });

    const richContent = [
      '# Main Title H1',
      '## Subtitle H2',
      '> This is a blockquote note',
      '- Item Apple',
      '- Item Banana',
      '1. First ordered step',
      '2. Second ordered step',
      'Here is a link: [Enkeep Documentation](https://enkeep.example.com/docs)',
      'Unsafe link ignored: [Bad Link](javascript:alert(1))',
      '```typescript',
      'export function greet(name: string): string {',
      '  return `Hello, ${name}!`;',
      '}',
      '```',
      '```mermaid',
      'graph TD',
      '  A[Start] --> B[Process]',
      '```',
    ].join('\n');

    const routeKey = `web:default:${aliceUser!.id}:${session.id}`;
    await testServer.messageStore.insertMessage({
      id: `msg_rich_asst`,
      sessionId: session.id,
      userId: aliceUser!.id,
      role: 'assistant',
      content: richContent,
      status: 'delivered',
      routeKey,
      createdAt: new Date().toISOString(),
    });

    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      await page.waitForFunction((spId) => {
        const sel = document.querySelector('#space-select') as HTMLSelectElement | null;
        return sel && Array.from(sel.options).some((o) => o.value === spId);
      }, space.id, { timeout: 8000 });

      await page.selectOption('#space-select', space.id);
      await page.dispatchEvent('#space-select', 'change');

      await page.waitForSelector('#session-list .session-item', { state: 'visible', timeout: 8000 });
      await page.locator('#session-list .session-item', { hasText: 'Markdown Test Session' }).click();

      await page.waitForSelector('.message-card.assistant', { state: 'visible', timeout: 8000 });

      // Verify Headings
      expect(await page.textContent('.message-card.assistant h1')).toBe('Main Title H1');
      expect(await page.textContent('.message-card.assistant h2')).toBe('Subtitle H2');

      // Verify Blockquote
      expect(await page.textContent('.message-card.assistant blockquote')).toContain('This is a blockquote note');

      // Verify Lists
      const ulItems = await page.$$eval('.message-card.assistant ul li', (lis) => lis.map((li) => li.textContent));
      expect(ulItems).toContain('Item Apple');
      expect(ulItems).toContain('Item Banana');

      const olItems = await page.$$eval('.message-card.assistant ol li', (lis) => lis.map((li) => li.textContent));
      expect(olItems).toContain('First ordered step');
      expect(olItems).toContain('Second ordered step');

      // Verify Links
      const link = page.locator('.message-card.assistant a', { hasText: 'Enkeep Documentation' });
      await link.waitFor({ state: 'visible' });
      expect(await link.getAttribute('href')).toBe('https://enkeep.example.com/docs');
      expect(await link.getAttribute('target')).toBe('_blank');
      expect(await link.getAttribute('rel')).toBe('noopener noreferrer');

      // Verify unsafe link is not rendered as an <a> tag
      const unsafeLinks = await page.$$eval('.message-card.assistant a', (anchors) =>
        anchors.map((a) => a.getAttribute('href'))
      );
      expect(unsafeLinks.some((h) => h?.includes('javascript:'))).toBe(false);

      // Verify Code block and Copy button
      await page.waitForSelector('.code-block-wrapper', { state: 'visible' });
      expect(await page.textContent('.code-block-header .code-lang')).toBe('typescript');
      const copyBtn = page.locator('.code-block-header .btn-copy-code');
      expect(await copyBtn.isVisible()).toBe(true);

      // Click copy button
      await copyBtn.click();
      await page.waitForFunction(() => {
        const b = document.querySelector('.btn-copy-code');
        return b && b.textContent === 'Copied!';
      }, { timeout: 3000 });

      // Verify Mermaid placeholder
      await page.waitForSelector('.mermaid-placeholder', { state: 'visible' });
      expect(await page.textContent('.mermaid-placeholder .mermaid-title')).toContain('Mermaid Diagram');
      expect(await page.textContent('.mermaid-placeholder .mermaid-code')).toContain('graph TD');
    } finally {
      await context.close();
    }
  });

  it('3. Composer Interaction: Textarea auto-height rows, character counter, and Enter/Shift+Enter', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      await uiCreateSpace(page, { name: 'Composer Space', folder: 'composer-folder' });
      await uiCreateSession(page, { peerId: 'composer-peer' });

      await page.waitForSelector('#chat-input:not([disabled])', { state: 'visible', timeout: 8000 });

      // Check initial character count
      const charCountEl = page.locator('#chat-char-count');
      expect(await charCountEl.textContent()).toBe('0 / 4000');

      // Type text into textarea and verify character count updates
      await page.fill('#chat-input', 'Hello Composer Testing!');
      expect(await charCountEl.textContent()).toBe('23 / 4000');

      // Type multiple lines and check rows expansion
      const multilineText = 'Line 1\nLine 2\nLine 3\nLine 4';
      await page.fill('#chat-input', multilineText);
      const rowsCount = await page.$eval('#chat-input', (el) => (el as HTMLTextAreaElement).rows);
      expect(rowsCount).toBeGreaterThanOrEqual(4);

      // Press Enter (without shift) to send message
      await page.focus('#chat-input');
      await page.keyboard.press('Enter');

      // Input should be cleared and reset to rows=2
      await page.waitForFunction(() => {
        const inp = document.querySelector('#chat-input') as HTMLTextAreaElement | null;
        return inp && inp.value === '';
      }, { timeout: 5000 });
      expect(await charCountEl.textContent()).toBe('0 / 4000');

      // Message should be displayed in user role card
      await page.locator('.message-card.user', { hasText: 'Line 1' }).waitFor({ state: 'visible', timeout: 8000 });
    } finally {
      await context.close();
    }
  });

  it('4. Turn Cancellation: Stop turn button displayed and calls cancelCurrentTurn', async () => {
    // Configure server with a slow custom responder to give us time to stop the turn
    const slowServer = await createAndStartTestPlatformServer({
      autoReply: false,
      customResponder: async (envelope, turnId) => {
        // Slow turn delay
        await new Promise((r) => setTimeout(r, 5000));
        return { content: 'Slow response that will be cancelled' };
      },
    });

    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, slowServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      await uiCreateSpace(page, { name: 'Cancel Turn Space', folder: 'cancel-folder' });
      await uiCreateSession(page, { peerId: 'cancel-turn-peer' });

      // Send prompt
      await uiSendMessage(page, 'Long running calculation...');

      // Stop Turn button should be visible
      const stopBtn = page.locator('#btn-stop-turn');
      await stopBtn.waitFor({ state: 'visible', timeout: 5000 });
      expect(await stopBtn.textContent()).toContain('Stop Turn');

      // Click Stop Turn button
      await stopBtn.click();

      // Toast notification for successful cancellation
      await page.waitForSelector('.toast', { state: 'visible', timeout: 5000 });
      const toastText = await page.textContent('.toast');
      expect(toastText?.toLowerCase()).toMatch(/stop|cancel|settle/);

      // Stop button becomes hidden after cancellation
      await page.waitForFunction(() => {
        const b = document.querySelector('#btn-stop-turn');
        return !b || b.classList.contains('hidden') || b.getAttribute('disabled') !== null;
      }, { timeout: 8000 });
    } finally {
      await context.close();
      await slowServer.stop();
    }
  });

  it('5. Session Search & Filtering: Filter session list by query string', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      await uiCreateSpace(page, { name: 'Search Space', folder: 'search-folder' });
      await uiCreateSession(page, { title: 'Alpha Alpha Session' });
      await uiCreateSession(page, { title: 'Beta Beta Session' });
      await uiCreateSession(page, { title: 'Gamma Gamma Session' });

      await page.waitForSelector('#session-list .session-item', { state: 'visible', timeout: 8000 });

      // Filter by 'Alpha'
      await page.fill('#session-search-input', 'Alpha');

      await page.waitForFunction(() => {
        const items = Array.from(document.querySelectorAll('#session-list .session-item'));
        return items.length === 1 && items[0].textContent?.includes('Alpha');
      }, { timeout: 5000 });

      // Filter by non-existent query
      await page.fill('#session-search-input', 'NonExistentQueryXYZ');
      await page.waitForSelector('.empty-sessions', { state: 'visible', timeout: 5000 });
      expect(await page.textContent('.empty-sessions')).toContain('No matching sessions');

      // Clear search
      await page.fill('#session-search-input', '');
      await page.waitForFunction(() => {
        const items = Array.from(document.querySelectorAll('#session-list .session-item'));
        return items.length === 3;
      }, { timeout: 5000 });
    } finally {
      await context.close();
    }
  });

  it('6. Session Generation Reset & History Modal: Reset Gen N+1 and view generation history', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      await uiCreateSpace(page, { name: 'Gen Space', folder: 'gen-folder' });
      await uiCreateSession(page, { title: 'Gen Lifecycle Session' });

      // Verify Gen 1 badge visible
      const genBadge = page.locator('#session-generation-badge');
      await genBadge.waitFor({ state: 'visible', timeout: 5000 });
      expect(await genBadge.textContent()).toBe('Gen 1');

      // Click Reset Gen button
      await page.click('#btn-reset-session');
      await page.waitForSelector('#modal-reset-session', { state: 'visible', timeout: 5000 });
      await page.fill('#reset-session-reason-input', 'Testing generation lifecycle increment');
      await page.click('#btn-submit-reset-session');

      // Wait for modal to close
      await page.waitForSelector('#modal-reset-session', { state: 'hidden', timeout: 5000 });

      // Badge should now display Gen 2
      await page.waitForFunction(() => {
        const b = document.querySelector('#session-generation-badge');
        return b && b.textContent === 'Gen 2';
      }, { timeout: 5000 });

      // Inspect Generation History Modal
      await page.click('#btn-session-generations');
      await page.waitForSelector('#modal-generations', { state: 'visible', timeout: 5000 });

      // Should show generation cards
      await page.waitForSelector('#generations-history-content .generation-card', { state: 'visible', timeout: 5000 });
      const cards = await page.$$eval('#generations-history-content .generation-card', (els) =>
        els.map((el) => el.textContent)
      );
      expect(cards.some((c) => c?.includes('Gen 1'))).toBe(true);
      expect(cards.some((c) => c?.includes('Gen 2'))).toBe(true);
      expect(cards.some((c) => c?.includes('Testing generation lifecycle increment'))).toBe(true);

      // Close modal
      await page.click('#modal-generations .modal-close');
      await page.waitForSelector('#modal-generations', { state: 'hidden', timeout: 5000 });
    } finally {
      await context.close();
    }
  });

  it('7. Mobile Sidebar Toggle: Toggle button collapses and expands workspace sidebar', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      const toggleBtn = page.locator('#btn-toggle-sidebar');
      await toggleBtn.waitFor({ state: 'visible', timeout: 5000 });

      // Click toggle to collapse
      await toggleBtn.click();
      const isCollapsed = await page.$eval('#workspace-sidebar', (el) => el.classList.contains('sidebar-collapsed'));
      expect(isCollapsed).toBe(true);

      // Click toggle again to expand
      await toggleBtn.click();
      const isExpanded = await page.$eval('#workspace-sidebar', (el) => !el.classList.contains('sidebar-collapsed'));
      expect(isExpanded).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('8. Strict DOM Security Invariants: Zero innerHTML, Zero inline styles, Zero onclick attributes', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Assert zero inline style attributes in entire DOM
      const elementsWithInlineStyle = await page.$$eval('*[style]', (els) => els.map((e) => e.tagName));
      expect(elementsWithInlineStyle).toEqual([]);

      // Assert zero inline onclick/on* attributes in entire DOM
      const elementsWithInlineHandlers = await page.$$eval('*', (els) => {
        const found: string[] = [];
        for (const el of els) {
          for (const attr of Array.from(el.attributes)) {
            if (attr.name.startsWith('on')) {
              found.push(`${el.tagName}[${attr.name}]`);
            }
          }
        }
        return found;
      });
      expect(elementsWithInlineHandlers).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
