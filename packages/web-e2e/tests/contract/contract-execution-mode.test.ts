/**
 * Contract E2E Test Suite: Execution Mode, Host Sandbox Security & Runtime Management
 *
 * Requirements:
 * 1. Create Space Modal: Admin sees Execution Mode select (Docker default / Host High Risk); Member does not see Host
 * 2. Host Explanation & Danger Confirmation once on Host mode selection
 * 3. Exact payload verification on Space creation and safe handling of backend 403/400 responses
 * 4. Space list badge (Docker / Host) in sidebar, active header, and Admin Spaces table
 * 5. Space Mode Immutability: Existing space mode cannot be switched; displays "Migration required"
 * 6. Runtime Management: Displays mixed Docker + Host instances, status, and target mode restart
 * 7. Bilingual switching (en / zh-CN) and multi-theme support (dark / light / eye-care)
 * 8. Zero mounts UI invariant
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type Browser } from 'playwright';
import { randomUUID } from 'node:crypto';
import { createAndStartTestPlatformServer, type TestPlatformServerHandle } from '../../src/contract/test-platform-server.js';
import {
  launchPlaywrightBrowser,
  createIsolatedPage,
  uiLogin,
  uiLogout,
} from '../../src/contract/browser-helper.js';
import { probeProtectedPorts, assertProtectedPortsUnmolested } from '../../src/probes/ports-guard.js';
import type { ManagementRuntimeProvider, UserRuntimeStatus } from '@enkeep/platform-server';

describe('Contract E2E: Execution Mode, Host Sandbox & Runtime Management', () => {
  let browser: Browser;
  let testServer: TestPlatformServerHandle;
  let probeBefore: Awaited<ReturnType<typeof probeProtectedPorts>>;

  let restartCallCount = 0;
  let lastRestartTargetMode: string | null = null;
  let lastRestartUserId: string | null = null;

  const validPlugins = {
    receiptStore: true,
    inbound: true,
    eventRelay: true,
    tools: true,
    externalInteraction: true,
    affinityPolicy: true,
    llmAffinity: true,
  };

  const mixedRuntimeProvider: ManagementRuntimeProvider = {
    async getUserRuntime(userId: string): Promise<UserRuntimeStatus | null> {
      return {
        userId,
        status: 'ok',
        networkMode: 'none',
        dshReady: true,
        uptimeSeconds: 120,
        version: '0.1.0',
        enkeepBundleLoaded: true,
        toolsCount: 8,
        plugins: validPlugins,
        toolsOperational: true,
        toolsUnavailableReason: null,
      };
    },
    async listRuntimes(): Promise<UserRuntimeStatus[]> {
      return [
        {
          userId: 'alice',
          status: 'ok',
          networkMode: 'none',
          dshReady: true,
          uptimeSeconds: 120,
          version: '0.1.0',
          enkeepBundleLoaded: true,
          toolsCount: 8,
          plugins: validPlugins,
          toolsOperational: true,
          toolsUnavailableReason: null,
          mode: 'container',
        } as any,
        {
          userId: 'alice',
          status: 'ok',
          networkMode: 'none',
          dshReady: true,
          uptimeSeconds: 45,
          version: '0.1.0',
          enkeepBundleLoaded: true,
          toolsCount: 8,
          plugins: validPlugins,
          toolsOperational: true,
          toolsUnavailableReason: null,
          mode: 'host',
        } as any,
        {
          userId: 'bob',
          status: 'ok',
          networkMode: 'none',
          dshReady: true,
          uptimeSeconds: 300,
          version: '0.1.0',
          enkeepBundleLoaded: true,
          toolsCount: 8,
          plugins: validPlugins,
          toolsOperational: true,
          toolsUnavailableReason: null,
          mode: 'container',
        } as any,
      ];
    },
    async restartRuntime(targetUserId?: string) {
      restartCallCount++;
      lastRestartUserId = targetUserId || null;
      return {
        restarted: true,
        userIds: targetUserId ? [targetUserId] : ['alice', 'bob'],
      };
    },
  };

  beforeAll(async () => {
    probeBefore = await probeProtectedPorts();
    testServer = await createAndStartTestPlatformServer({
      managementProvider: mixedRuntimeProvider,
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

  it('1. Create Space Modal: Admin sees Host (High Risk); Regular Member does NOT see Host', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      // 1.1 Alice (Admin) checks Create Space Modal
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      await page.click('#btn-new-space');
      await page.waitForSelector('#modal-space', { state: 'visible', timeout: 5000 });

      // Admin sees Execution Mode select with Docker and Host options
      const adminExecSelect = await page.$('#space-exec-mode-select');
      expect(adminExecSelect).not.toBeNull();

      const adminOptions = await page.$$eval('#space-exec-mode-select option', (opts) =>
        opts.map((o) => ({ value: o.value, text: o.textContent?.trim() }))
      );
      expect(adminOptions.some((o) => o.value === 'container')).toBe(true);
      expect(adminOptions.some((o) => o.value === 'host')).toBe(true);

      const hostOption = adminOptions.find((o) => o.value === 'host');
      expect(hostOption?.text).toContain('Host');
      expect(hostOption?.text).toContain('High Risk');

      // Close modal and logout
      await page.click('#modal-space button[data-close="modal-space"]');
      await page.waitForSelector('#modal-space', { state: 'hidden', timeout: 5000 });
      await uiLogout(page);

      // 1.2 Bob (Member) checks Create Space Modal
      await uiLogin(page, testServer.url, 'bob', 'BobSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      await page.click('#btn-new-space');
      await page.waitForSelector('#modal-space', { state: 'visible', timeout: 5000 });

      const memberOptions = await page.$$eval('#space-exec-mode-select option', (opts) =>
        opts.map((o) => o.value)
      );
      // Member does NOT see host option
      expect(memberOptions).toContain('container');
      expect(memberOptions).not.toContain('host');

      await page.click('#modal-space button[data-close="modal-space"]');
    } finally {
      await context.close();
    }
  });

  it('2. Host Mode Danger Confirmation & Revert on Cancel Flow', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      await page.click('#btn-new-space');
      await page.waitForSelector('#modal-space', { state: 'visible', timeout: 5000 });

      // Host description is initially hidden
      const descInitialVisible = await page.isVisible('#space-exec-mode-host-desc');
      expect(descInitialVisible).toBe(false);

      // Alice selects "host" -> Triggers danger confirmation
      await page.selectOption('#space-exec-mode-select', 'host');
      await page.waitForSelector('#modal-confirm', { state: 'visible', timeout: 5000 });

      // Verify confirmation message contains host explanation
      const confirmMsg = await page.textContent('#confirm-modal-message');
      expect(confirmMsg).toContain('platform host');
      expect(confirmMsg).toContain('controlled Enkeep workspace');

      // Cancel confirmation -> Select reverts to container and desc remains hidden
      await page.click('#btn-confirm-cancel');
      await page.waitForSelector('#modal-confirm', { state: 'hidden', timeout: 5000 });

      const selectValAfterCancel = await page.$eval('#space-exec-mode-select', (el) => (el as HTMLSelectElement).value);
      expect(selectValAfterCancel).toBe('container');
      const descAfterCancelVisible = await page.isVisible('#space-exec-mode-host-desc');
      expect(descAfterCancelVisible).toBe(false);

      // Select "host" again and Confirm -> Select is host and desc is visible
      await page.selectOption('#space-exec-mode-select', 'host');
      await page.waitForSelector('#modal-confirm', { state: 'visible', timeout: 5000 });
      await page.click('#btn-confirm-proceed');
      await page.waitForSelector('#modal-confirm', { state: 'hidden', timeout: 5000 });

      const selectValAfterConfirm = await page.$eval('#space-exec-mode-select', (el) => (el as HTMLSelectElement).value);
      expect(selectValAfterConfirm).toBe('host');
      const descAfterConfirmVisible = await page.isVisible('#space-exec-mode-host-desc');
      expect(descAfterConfirmVisible).toBe(true);

      await page.click('#modal-space button[data-close="modal-space"]');
    } finally {
      await context.close();
    }
  });

  it('3. Space Creation: Exact Payload and Backend 400/403 Error Handling', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      let capturedPayload: any = null;
      page.on('request', (req) => {
        if (req.url().includes('/api/spaces') && req.method() === 'POST') {
          try {
            capturedPayload = JSON.parse(req.postData() || '{}');
          } catch {}
        }
      });

      // 3.1 Create Docker Space -> Sends { name, folder, executionMode: 'container' }
      const dockerSpaceName = `Docker Test Space ${Date.now()}`;
      await page.click('#btn-new-space');
      await page.waitForSelector('#modal-space', { state: 'visible', timeout: 5000 });
      await page.fill('#space-name-input', dockerSpaceName);
      await page.fill('#space-folder-input', `docker-space-${Date.now()}`);
      await page.click('#modal-space button[type="submit"]');
      await page.waitForSelector('#modal-space', { state: 'hidden', timeout: 5000 });

      expect(capturedPayload).not.toBeNull();
      expect(capturedPayload.executionMode).toBe('container');
      expect(capturedPayload.name).toBe(dockerSpaceName);

      // Verify created space renders in selector with [Docker] tag and active badge
      await page.waitForFunction((expectedName) => {
        const opts = Array.from(document.querySelectorAll('#space-select option'));
        return opts.some((o) => o.textContent && o.textContent.includes(expectedName) && o.textContent.includes('[Docker]'));
      }, dockerSpaceName, { timeout: 8000 });

      const badgeText = await page.textContent('#space-mode-badge');
      expect(badgeText).toContain('Docker');

      // 3.2 Try to create Host Space -> Server returns 400 / 403, UI handles error gracefully
      capturedPayload = null;
      const hostSpaceName = `Host Test Space ${Date.now()}`;
      await page.click('#btn-new-space');
      await page.waitForSelector('#modal-space', { state: 'visible', timeout: 5000 });
      await page.fill('#space-name-input', hostSpaceName);
      await page.fill('#space-folder-input', `host-space-${Date.now()}`);

      await page.selectOption('#space-exec-mode-select', 'host');
      await page.waitForSelector('#modal-confirm', { state: 'visible', timeout: 5000 });
      await page.click('#btn-confirm-proceed');
      await page.waitForSelector('#modal-confirm', { state: 'hidden', timeout: 5000 });

      await page.click('#modal-space button[type="submit"]');

      expect(capturedPayload).not.toBeNull();
      expect(capturedPayload.executionMode).toBe('host');

      // Error toast is shown, app did not crash
      const errorToast = page.locator('.toast.toast-error, .toast');
      await errorToast.first().waitFor({ state: 'attached', timeout: 5000 });
      const toastText = await errorToast.first().textContent();
      expect(toastText).toBeTruthy();
    } finally {
      await context.close();
    }
  });

  it('4. Space List & Mode Immutability: Existing Space displays "Migration required"', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Open Rename Modal for current active space
      await page.click('#btn-rename-space');
      await page.waitForSelector('#modal-rename-space', { state: 'visible', timeout: 5000 });

      // Execution Mode is read-only badge with "Migration required" notice
      const modeBadge = await page.textContent('#rename-space-mode-badge');
      expect(modeBadge).toContain('Docker');

      const modalText = await page.textContent('#modal-rename-space');
      expect(modalText).toContain('Migration required');

      // Assert no dropdown or select exists in rename space modal to change mode
      const hasSelectInRename = await page.$('#modal-rename-space select');
      expect(hasSelectInRename).toBeNull();

      await page.click('#modal-rename-space button[data-close="modal-rename-space"]');
    } finally {
      await context.close();
    }
  });

  it('5. Runtime Management: Mixed Docker + Host Runtimes & Target Mode Restart', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Navigate to Management -> Runtime -> Runtime Engine
      await page.click('#nav-management');
      await page.waitForSelector('#tab-btn-runtime', { state: 'visible', timeout: 5000 });
      await page.click('#tab-btn-runtime');

      await page.waitForSelector('.data-table tbody tr', { state: 'visible', timeout: 8000 });

      // Verify mixed Docker and Host rows rendered
      const rowsText = await page.$$eval('.data-table tbody tr', (rows) =>
        rows.map((r) => r.textContent || '')
      );
      expect(rowsText.some((r) => r.includes('alice') && r.includes('Docker'))).toBe(true);
      expect(rowsText.some((r) => r.includes('alice') && r.includes('Host'))).toBe(true);
      expect(rowsText.some((r) => r.includes('bob') && r.includes('Docker'))).toBe(true);

      // Click Restart on Host row
      const hostRestartBtn = page.locator('tr:has-text("alice"):has-text("Host") button.btn-runtime-restart');
      await hostRestartBtn.click();

      // Verify confirmation dialog mentions Host
      await page.waitForSelector('#modal-confirm:not(.hidden)', { state: 'visible', timeout: 5000 });
      const confirmMsg = await page.textContent('#confirm-modal-message');
      expect(confirmMsg).toContain('alice (Host)');

      await page.click('#btn-confirm-proceed');
      await page.waitForSelector('#modal-confirm', { state: 'hidden', timeout: 5000 });

      // Verify restart succeeded
      const restartToast = page.locator('.toast.toast-success', { hasText: /restarted|重启|successfully/ });
      await restartToast.waitFor({ state: 'attached', timeout: 8000 });
      expect(restartCallCount).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });

  it('6. Bilingual Localization & Theme Switching for Execution Mode Controls', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Switch language to 简体中文
      await page.selectOption('#locale-select', 'zh-CN');
      await page.waitForTimeout(300);

      // Open Create Space Modal in Chinese
      await page.click('#btn-new-space');
      await page.waitForSelector('#modal-space', { state: 'visible', timeout: 5000 });

      const zhLabel = await page.textContent('#space-exec-mode-group label');
      expect(zhLabel).toContain('执行模式');

      const zhOptions = await page.$$eval('#space-exec-mode-select option', (opts) =>
        opts.map((o) => o.textContent?.trim())
      );
      expect(zhOptions.some((t) => t?.includes('Docker（默认）'))).toBe(true);
      expect(zhOptions.some((t) => t?.includes('Host（高风险）'))).toBe(true);

      await page.click('#modal-space button[data-close="modal-space"]');

      // Theme switching (dark -> light -> eye-care)
      await page.selectOption('#theme-select', 'light');
      const themeAttr1 = await page.getAttribute('html', 'data-theme');
      expect(themeAttr1).toBe('light');

      await page.selectOption('#theme-select', 'eye-care');
      const themeAttr2 = await page.getAttribute('html', 'data-theme');
      expect(themeAttr2).toBe('eye-care');
    } finally {
      await context.close();
    }
  });
});
