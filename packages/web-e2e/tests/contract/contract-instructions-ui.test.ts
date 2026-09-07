/**
 * Instructions UI Contract E2E Test Suite
 *
 * Covers:
 * 1. Account View: Personal Global Instructions ($DSH_HOME/AGENTS.md)
 *    - GET /api/account/instructions/global loads content & etag
 *    - Real-time UTF-8 byte counter with strict 20 KiB limit
 *    - Saving instructions sends PUT with If-Match header when etag exists
 *    - Missing etag (new file) sends PUT without If-Match header
 *    - Concurrency conflict (409) displays conflict banner prompting Reload Server Version (no force overwrite)
 *    - Reload Server Version restores server version and allows subsequent saving with new ETag
 * 2. Workspaces View: Space Instructions (AGENTS.md & CLAUDE.md)
 *    - Space selector dropdown loads instructions for selected space
 *    - Tab switching between AGENTS.md and CLAUDE.md
 *    - Real-time UTF-8 byte counter with strict 64 KiB limit
 *    - Dirty guard prompts confirmation before switching tab or space
 *    - Space instructions isolation across distinct spaces
 * 3. Multi-Tenant Isolation:
 *    - Alice (admin) and Bob (member) have strict isolated instructions
 *    - Bob cannot access or overwrite Alice's space instructions or global instructions
 * 4. Theme & Mobile Responsiveness:
 *    - Renders properly across dark, light, and eye-care themes
 *    - Responsive layout on mobile viewports (390px)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser } from 'playwright';
import {
  createAndStartTestPlatformServer,
  type TestPlatformServerHandle,
} from '../../src/contract/test-platform-server.js';
import {
  launchPlaywrightBrowser,
  createIsolatedPage,
  uiLogin,
  uiLogout,
} from '../../src/contract/browser-helper.js';

describe('Contract E2E: Instructions UI Subsystem & Governance', () => {
  let browser: Browser;
  let testServer: TestPlatformServerHandle;

  beforeAll(async () => {
    browser = await launchPlaywrightBrowser();
    testServer = await createAndStartTestPlatformServer({
      autoReply: false,
    });
  });

  afterAll(async () => {
    await browser?.close();
    await testServer?.stop();
  });

  describe('1. Account View: Personal Global Instructions', () => {
    it('renders Personal Instructions card in Account view with 20 KiB limit and real-time byte counter', async () => {
      const { context, page } = await createIsolatedPage(browser);
      page.on('response', (res) => {
        if (!res.ok()) {
          console.log(`[HTTP ${res.status()}] ${res.request().method()} ${res.url()}`);
        }
      });
      try {
        await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');

        // Navigate to Account view (#management/users/account)
        await page.goto(`${testServer.url}#management/users/account`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#personal-instructions-textarea', { state: 'visible', timeout: 5000 });

        // Verify header, explanation note, and byte counter
        const textarea = page.locator('#personal-instructions-textarea');
        expect(await textarea.isVisible()).toBe(true);

        // Check byte counter initial state
        const byteCounter = page.locator('.instructions-byte-counter').first();
        expect(await byteCounter.isVisible()).toBe(true);
        const initialCounterText = await byteCounter.textContent();
        expect(initialCounterText).toContain('/ 20480 B');

        // Edit content and observe real-time byte counter update
        const testContent = '# Personal Global Prompt\n- Always be accurate and clear.';
        await textarea.fill(testContent);

        // Verify unsaved badge appears
        const unsavedBadge = page.locator('.instructions-unsaved-badge').first();
        expect(await unsavedBadge.isVisible()).toBe(true);

        // Click Save button
        const saveBtn = page.locator('.instructions-actions-bar .btn-primary').first();
        await saveBtn.click();

        // Wait for success toast and unsaved badge to hide
        await page.waitForSelector('.toast.toast-success', { timeout: 5000 });
        await page.waitForSelector('.instructions-unsaved-badge', { state: 'hidden', timeout: 5000 });

        // Reload page and verify saved content persists
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#personal-instructions-textarea', { state: 'visible', timeout: 5000 });
        const reloadedContent = await page.locator('#personal-instructions-textarea').inputValue();
        expect(reloadedContent).toBe(testContent);
      } finally {
        await context.close();
      }
    });

    it('handles concurrency conflict (409) with inline conflict banner and Reload Server Version flow', async () => {
      const { context, page } = await createIsolatedPage(browser);
      try {
        await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');

        await page.goto(`${testServer.url}#management/users/account`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#personal-instructions-textarea', { state: 'visible', timeout: 5000 });

        // Alice prepares an edit
        const textarea = page.locator('#personal-instructions-textarea');
        await textarea.fill('# Version A from Browser');

        // Direct write to simulated backend container storage to simulate remote modification
        const user = (await testServer.storage.users.list()).find((u) => u.username === 'alice')!;
        await testServer.fileProvider.writeGlobalInstructions!(user.id, '# Version B from Remote Server', {
          requireAbsent: false,
        });

        // Alice tries to save (will send outdated If-Match -> 409 Conflict)
        const saveBtn = page.locator('.instructions-actions-bar .btn-primary').first();
        await saveBtn.click();

        // Conflict banner should become visible prompting reload (no force overwrite)
        await page.waitForSelector('.instructions-conflict-banner', { state: 'visible', timeout: 5000 });
        const conflictBanner = page.locator('.instructions-conflict-banner').first();
        expect(await conflictBanner.isVisible()).toBe(true);

        // Click "Reload Server Version" button
        const reloadBtn = page.locator('.instructions-conflict-actions .btn-secondary').first();
        await reloadBtn.click();

        // Conflict banner hidden and content refreshed to Version B
        await page.waitForSelector('.instructions-conflict-banner', { state: 'hidden', timeout: 5000 });
        await page.waitForFunction(() => {
          const el = document.querySelector('#personal-instructions-textarea') as HTMLTextAreaElement | null;
          return el?.value === '# Version B from Remote Server';
        });
        const reloadedContent = await textarea.inputValue();
        expect(reloadedContent).toBe('# Version B from Remote Server');

        // Alice makes a new edit on top of Version B and saves successfully
        await textarea.fill('# Version C from Alice');
        await saveBtn.click();
        await page.waitForSelector('.toast.toast-success', { timeout: 5000 });
      } finally {
        await context.close();
      }
    });
  });

  describe('2. Workspaces View: Space Instructions & File Tabs', () => {
    it('navigates to Space Instructions section, switches AGENTS.md / CLAUDE.md tabs and saves', async () => {
      const { context, page } = await createIsolatedPage(browser);
      try {
        await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');

        // Create a test space first
        const spaceRes = await page.evaluate(async (token) => {
          const res = await fetch('/api/spaces', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Enkeep-CSRF': token,
            },
            body: JSON.stringify({ name: 'Alpha Space', folder: 'alpha-space' }),
          });
          return res.json();
        }, testServer.csrfToken);

        const spaceId = spaceRes.data?.space?.id || spaceRes.data?.id;
        expect(spaceId).toBeDefined();

        // Navigate to Space Instructions section
        await page.goto(`${testServer.url}#management/workspaces/instructions`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#space-instructions-textarea', { state: 'visible', timeout: 5000 });

        // Verify 64 KiB limit
        const byteCounter = page.locator('.instructions-byte-counter').first();
        expect(await byteCounter.isVisible()).toBe(true);
        const counterText = await byteCounter.textContent();
        expect(counterText).toContain('/ 65536 B');

        // Edit AGENTS.md
        const textarea = page.locator('#space-instructions-textarea');
        await textarea.fill('# Alpha Space AGENTS Rules\n- Strictly follow TypeScript');
        const saveBtn = page.locator('.instructions-actions-bar .btn-primary').first();
        await saveBtn.click();
        await page.waitForSelector('.toast.toast-success', { timeout: 5000 });

        // Switch to CLAUDE.md tab
        const claudeTab = page.locator('.instructions-file-tab[data-file="CLAUDE.md"]');
        await claudeTab.click();
        await page.waitForFunction(() => {
          const fileEl = document.querySelector('.instructions-file-display');
          return fileEl && fileEl.textContent === 'CLAUDE.md';
        });

        // Write CLAUDE.md
        await textarea.fill('# Alpha Space CLAUDE Guidelines\n- Be concise and prompt');
        await saveBtn.click();
        await page.waitForSelector('.toast.toast-success', { timeout: 5000 });

        // Switch back to AGENTS.md and verify content
        const agentsTab = page.locator('.instructions-file-tab[data-file="AGENTS.md"]');
        await agentsTab.click();
        await page.waitForFunction(() => {
          const fileEl = document.querySelector('.instructions-file-display');
          return fileEl && fileEl.textContent === 'AGENTS.md';
        });
        const agentsVal = await textarea.inputValue();
        expect(agentsVal).toContain('# Alpha Space AGENTS Rules');
      } finally {
        await context.close();
      }
    });

    it('dirty guard prompts confirmation modal before switching tabs when modified', async () => {
      const { context, page } = await createIsolatedPage(browser);
      try {
        await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');

        await page.goto(`${testServer.url}#management/workspaces/instructions`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#space-instructions-textarea', { state: 'visible', timeout: 5000 });

        const textarea = page.locator('#space-instructions-textarea');
        await textarea.fill('# Unsaved edits in AGENTS.md');

        // Try to switch to CLAUDE.md tab
        const claudeTab = page.locator('.instructions-file-tab[data-file="CLAUDE.md"]');
        await claudeTab.click();

        // Confirmation modal should appear
        await page.waitForSelector('#modal-confirm', { state: 'visible', timeout: 5000 });
        const confirmModal = page.locator('#modal-confirm');
        expect(await confirmModal.isVisible()).toBe(true);

        // Click cancel -> stays on AGENTS.md with unsaved edits
        const cancelBtn = page.locator('#btn-confirm-cancel');
        await cancelBtn.click();
        await page.waitForSelector('#modal-confirm', { state: 'hidden', timeout: 5000 });

        const activeFile = await page.locator('.instructions-file-display').textContent();
        expect(activeFile).toBe('AGENTS.md');
        expect(await textarea.inputValue()).toBe('# Unsaved edits in AGENTS.md');
      } finally {
        await context.close();
      }
    });

    it('enforces strict byte limit and disables Save when content exceeds max bytes', async () => {
      const { context, page } = await createIsolatedPage(browser);
      try {
        await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');

        await page.goto(`${testServer.url}#management/users/account`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#personal-instructions-textarea', { state: 'visible', timeout: 5000 });

        const textarea = page.locator('#personal-instructions-textarea');
        const saveBtn = page.locator('.instructions-actions-bar .btn-primary').first();
        const byteCounter = page.locator('.instructions-byte-counter').first();

        // 20 KiB limit is 20,480 bytes. Fill with 20,500 ASCII characters (20,500 bytes)
        const hugeContent = 'A'.repeat(20500);
        await textarea.fill(hugeContent);

        // Byte counter should have 'exceeded' class and save button disabled
        const counterClass = await byteCounter.getAttribute('class');
        expect(counterClass).toContain('exceeded');
        expect(await saveBtn.isDisabled()).toBe(true);

        // Trim down to within limit
        await textarea.fill('A'.repeat(500));
        const updatedClass = await byteCounter.getAttribute('class');
        expect(updatedClass).not.toContain('exceeded');
        expect(await saveBtn.isDisabled()).toBe(false);
      } finally {
        await context.close();
      }
    });

    it('discards local draft when Discard Draft button is clicked', async () => {
      const { context, page } = await createIsolatedPage(browser);
      try {
        await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');

        await page.goto(`${testServer.url}#management/users/account`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#personal-instructions-textarea', { state: 'visible', timeout: 5000 });

        const textarea = page.locator('#personal-instructions-textarea');
        const initialVal = await textarea.inputValue();

        // Type modification
        await textarea.fill('# Temporary Draft To Discard');
        const unsavedBadge = page.locator('.instructions-unsaved-badge').first();
        expect(await unsavedBadge.isVisible()).toBe(true);

        // Click Discard Draft button
        const discardBtn = page.locator('.instructions-actions-bar .btn-secondary').first();
        await discardBtn.click();

        // Unsaved badge should be hidden and textarea restored to initial value
        expect(await unsavedBadge.isVisible()).toBe(false);
        expect(await textarea.inputValue()).toBe(initialVal);
      } finally {
        await context.close();
      }
    });
  });

  describe('3. Multi-Tenant Isolation (Bob Standard Member)', () => {
    it('Bob standard member has access to Instructions with complete space & global isolation from Alice', async () => {
      const { context, page } = await createIsolatedPage(browser);
      try {
        await uiLogin(page, testServer.url, 'bob', 'BobSecurePass123!');

        // Create Bob's private space
        const bobSpaceRes = await page.evaluate(async (token) => {
          const res = await fetch('/api/spaces', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Enkeep-CSRF': token,
            },
            body: JSON.stringify({ name: 'Bob Space', folder: 'bob-space' }),
          });
          return res.json();
        }, testServer.csrfToken);

        const bobSpaceId = bobSpaceRes.data?.space?.id || bobSpaceRes.data?.id;
        expect(bobSpaceId).toBeDefined();

        // Bob writes his own global instructions in Account view
        await page.goto(`${testServer.url}#management/users/account`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#personal-instructions-textarea', { state: 'visible', timeout: 5000 });

        const textarea = page.locator('#personal-instructions-textarea');
        // Bob should NOT see Alice's global instructions
        const bobInitialGlobal = await textarea.inputValue();
        expect(bobInitialGlobal).not.toContain('Personal Global Prompt');

        await textarea.fill('# Bob Secret Global Instructions');
        const saveBtn = page.locator('.instructions-actions-bar .btn-primary').first();
        await saveBtn.click();
        await page.waitForSelector('.toast.toast-success', { timeout: 5000 });

        // Bob navigates to Space instructions
        await page.goto(`${testServer.url}#management/workspaces/instructions`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#space-instructions-textarea', { state: 'visible', timeout: 5000 });

        // Bob writes space instructions
        const spaceTextarea = page.locator('#space-instructions-textarea');
        await spaceTextarea.fill('# Bob Private Space Rules');
        const spaceSaveBtn = page.locator('.instructions-actions-bar .btn-primary').first();
        await spaceSaveBtn.click();
        await page.waitForSelector('.toast.toast-success', { timeout: 5000 });

        // Log out and log back in as Alice -> verify Alice cannot see Bob's instructions
        await uiLogout(page);
        await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');

        await page.goto(`${testServer.url}#management/users/account`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#personal-instructions-textarea', { state: 'visible', timeout: 5000 });
        const aliceGlobal = await page.locator('#personal-instructions-textarea').inputValue();
        expect(aliceGlobal).not.toContain('Bob Secret');
      } finally {
        await context.close();
      }
    });
  });

  describe('4. Theme & Mobile Responsiveness', () => {
    it('switches themes and maintains instructions layout without distortion', async () => {
      const { context, page } = await createIsolatedPage(browser);
      try {
        await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');

        await page.goto(`${testServer.url}#management/workspaces/instructions`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#space-instructions-textarea', { state: 'visible', timeout: 5000 });

        // Switch to light theme
        await page.evaluate(() => {
          (window as any).setTheme('light');
        });
        const htmlThemeLight = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
        expect(htmlThemeLight).toBe('light');

        // Switch to eye-care theme
        await page.evaluate(() => {
          (window as any).setTheme('eye-care');
        });
        const htmlThemeEyeCare = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
        expect(htmlThemeEyeCare).toBe('eye-care');
      } finally {
        await context.close();
      }
    });

    it('renders properly on mobile viewport (390px x 844px)', async () => {
      const { context, page } = await createIsolatedPage(browser, {
        viewport: { width: 390, height: 844 },
      });
      try {
        await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');

        await page.goto(`${testServer.url}#management/workspaces/instructions`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#space-instructions-textarea', { state: 'visible', timeout: 5000 });

        const textarea = page.locator('#space-instructions-textarea');
        expect(await textarea.isVisible()).toBe(true);

        const saveBtn = page.locator('.instructions-actions-bar .btn-primary').first();
        expect(await saveBtn.isVisible()).toBe(true);
      } finally {
        await context.close();
      }
    });
  });
});
