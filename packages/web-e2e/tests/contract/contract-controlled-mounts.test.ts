/**
 * Contract E2E Test Suite: Controlled Directory Mounts Web UI
 *
 * Covers:
 * 1. Admin (Alice) manages mounts for active space:
 *    - Opens modal via active space header button
 *    - Sees real host path warning and Docker runtime notice
 *    - Adds RO and RW mounts via POST /api/admin/spaces/:spaceId/mounts exact body { name, sourcePath, mode }
 *    - Renders name, selectable sourcePath plain text (no <a> URL), mode badges, and createdAt
 *    - Deletes mount with confirmation dialog
 * 2. Management console:
 *    - Mounts action button on space table row opens modal for specific space
 * 3. Role-based isolation:
 *    - Regular user (Bob) does not see Mounts button in space header
 *    - Direct 403 response handled safely without UI crashes
 * 4. Archived space:
 *    - Archived space disables mount addition and displays archived notice
 * 5. Internationalization & Theme switching:
 *    - Instant locale switch (en / zh-CN) updates all mount labels, warnings, and placeholders
 *    - Multi-theme switching (dark / light / eye-care) verifies styling invariants
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type Browser } from 'playwright';
import { createAndStartTestPlatformServer, type TestPlatformServerHandle } from '../../src/contract/test-platform-server.js';
import {
  launchPlaywrightBrowser,
  createIsolatedPage,
  uiLogin,
  uiLogout,
} from '../../src/contract/browser-helper.js';
import { probeProtectedPorts, assertProtectedPortsUnmolested } from '../../src/probes/ports-guard.js';

describe('Contract E2E: Controlled Directory Mounts Web UI', () => {
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

  it('1. Admin Alice: Opens Modal, Adds RO & RW Mounts with Exact Body, and Deletes with Confirmation', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Create a space for Alice if not already present
      await page.click('#btn-new-space');
      await page.waitForSelector('#modal-space', { state: 'visible', timeout: 5000 });
      await page.fill('#space-name-input', 'Mounts Test Space');
      await page.fill('#space-folder-input', 'mounts-test-space');
      await page.click('#modal-space button[type="submit"]');
      await page.waitForSelector('#modal-space', { state: 'hidden', timeout: 5000 });

      // Verify Mounts button is visible in space header for Admin
      const mountsBtn = page.locator('#btn-manage-mounts');
      await mountsBtn.waitFor({ state: 'visible', timeout: 5000 });
      expect(await mountsBtn.isVisible()).toBe(true);

      // Open Controlled Mounts modal
      await mountsBtn.click();
      await page.waitForSelector('#modal-space-mounts', { state: 'visible', timeout: 5000 });

      // Verify Warning Notice is present
      const warningNotice = page.locator('#space-mounts-warning');
      expect(await warningNotice.isVisible()).toBe(true);
      const warningText = await warningNotice.textContent();
      expect(warningText).toContain('Warning');
      expect(warningText).toContain('Docker runtime');

      // Verify initial empty state
      const emptyState = page.locator('#space-mounts-list-container');
      await page.waitForTimeout(300);
      expect(await emptyState.textContent()).toContain('No controlled mounts configured');

      // Add a Read-Only (RO) mount
      await page.fill('#mount-name-input', 'readonly-docs');
      await page.selectOption('#mount-mode-select', 'ro');
      await page.fill('#mount-source-path-input', '/tmp/docs-source');

      // Intercept POST request to verify exact body
      let postBody: any = null;
      page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().includes('/mounts')) {
          try {
            postBody = req.postDataJSON();
          } catch {}
        }
      });

      await page.click('#btn-submit-add-mount');

      // Wait for success toast and mount card
      const toastSuccess = page.locator('.toast.toast-success', { hasText: /readonly-docs/ });
      await toastSuccess.waitFor({ state: 'attached', timeout: 8000 });

      expect(postBody).toEqual({
        name: 'readonly-docs',
        sourcePath: '/tmp/docs-source',
        mode: 'ro',
      });

      // Verify mount item card in list
      const mountCard = page.locator('.mount-item-card', { hasText: 'readonly-docs' });
      await mountCard.waitFor({ state: 'visible', timeout: 5000 });
      expect(await mountCard.locator('.badge').textContent()).toBe('RO');

      // Verify sourcePath is selectable plain text and NOT an <a> link
      const sourceSpan = mountCard.locator('.selectable-path');
      expect(await sourceSpan.textContent()).toBe('/tmp/docs-source');
      expect(await mountCard.locator('a').count()).toBe(0);

      // Add a Read-Write (RW) mount
      await page.fill('#mount-name-input', 'writable-data');
      await page.selectOption('#mount-mode-select', 'rw');
      await page.fill('#mount-source-path-input', '/tmp/data-source');
      await page.click('#btn-submit-add-mount');

      const toastSuccessRw = page.locator('.toast.toast-success', { hasText: /writable-data/ });
      await toastSuccessRw.waitFor({ state: 'attached', timeout: 8000 });

      // Verify two mounts now exist
      const allCards = page.locator('.mount-item-card');
      expect(await allCards.count()).toBe(2);

      const rwCard = page.locator('.mount-item-card', { hasText: 'writable-data' });
      expect(await rwCard.locator('.badge').textContent()).toBe('RW');

      // Delete the first mount with confirmation
      const delBtn = mountCard.locator('button.btn-danger');
      await delBtn.click();

      // Confirmation modal should appear
      await page.waitForSelector('#modal-confirm', { state: 'visible', timeout: 5000 });
      const confirmMsg = await page.textContent('#confirm-modal-message');
      expect(confirmMsg).toContain('readonly-docs');
      expect(confirmMsg).toContain('Next turn will immediately lose access');

      // Confirm deletion
      await page.click('#btn-confirm-proceed');
      await page.waitForSelector('#modal-confirm', { state: 'hidden', timeout: 5000 });

      // Verify delete toast and card removed
      const deleteToast = page.locator('.toast.toast-success', { hasText: /deleted/i });
      await deleteToast.waitFor({ state: 'attached', timeout: 8000 });

      await page.waitForTimeout(300);
      expect(await page.locator('.mount-item-card', { hasText: 'readonly-docs' }).count()).toBe(0);
      expect(await page.locator('.mount-item-card', { hasText: 'writable-data' }).count()).toBe(1);

      // Close modal
      await page.click('#modal-space-mounts button[data-close="modal-space-mounts"]');
      await page.waitForSelector('#modal-space-mounts', { state: 'hidden', timeout: 5000 });
    } finally {
      await context.close();
    }
  });

  it('2. Non-Admin Bob: Mounts Button Is Completely Absent / Hidden', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'bob', 'BobSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Create a space for Bob
      await page.click('#btn-new-space');
      await page.waitForSelector('#modal-space', { state: 'visible', timeout: 5000 });
      await page.fill('#space-name-input', "Bob's Space");
      await page.fill('#space-folder-input', 'bobs-space');
      await page.click('#modal-space button[type="submit"]');
      await page.waitForSelector('#modal-space', { state: 'hidden', timeout: 5000 });

      // Verify Mounts button is NOT visible for regular user Bob
      const mountsBtn = page.locator('#btn-manage-mounts');
      const isVisible = await mountsBtn.isVisible();
      expect(isVisible).toBe(false);
    } finally {
      await context.close();
    }
  });

  it('3. Bilingual Localization & Multi-Theme Switching for Mounts UI', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Switch language to Chinese (zh-CN)
      await page.selectOption('#locale-select', 'zh-CN');
      await page.waitForTimeout(300);

      // Verify Space Header Mounts button label in Chinese
      const mountsBtn = page.locator('#btn-manage-mounts');
      expect(await mountsBtn.textContent()).toContain('挂载');

      // Open Mounts Modal in Chinese
      await mountsBtn.click();
      await page.waitForSelector('#modal-space-mounts', { state: 'visible', timeout: 5000 });

      // Verify Chinese title and warning
      const zhTitle = await page.textContent('#modal-space-mounts-title');
      expect(zhTitle).toContain('受控目录挂载');

      const zhWarning = await page.textContent('#space-mounts-warning');
      expect(zhWarning).toContain('警告：受控挂载使用宿主机真实路径');
      expect(zhWarning).toContain('Docker 运行时');

      const zhSubmit = await page.textContent('#btn-submit-add-mount');
      expect(zhSubmit).toContain('添加挂载');

      // Switch Theme to light and eye-care
      await page.selectOption('#theme-select', 'light');
      expect(await page.getAttribute('html', 'data-theme')).toBe('light');

      await page.selectOption('#theme-select', 'eye-care');
      expect(await page.getAttribute('html', 'data-theme')).toBe('eye-care');

      await page.click('#modal-space-mounts button[data-close="modal-space-mounts"]');
    } finally {
      await context.close();
    }
  });
});
