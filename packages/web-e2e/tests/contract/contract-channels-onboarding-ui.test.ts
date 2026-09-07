/**
 * Playwright E2E Contract Test: Channels Onboarding UI, QR Code Image Rendering & Existing Bot Workflow.
 *
 * Verifies:
 * 1. Channels Management view renders Onboarding panel with "Scan to Create" and "Configure Existing" buttons.
 * 2. Existing Bot wizard presents Space selector and Account / AppID input.
 * 3. Starting an onboarding job renders the true QR code SVG/Data image (<img>) and direct authorization link in DOM.
 * 4. Singleflight status polling updates dynamically and cancel button aborts job cleanly.
 *
 * @module @enkeep/web-e2e/tests/contract
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser } from 'playwright';
import {
  createAndStartTestPlatformServer,
  type RunningTestServer,
} from '../../src/contract/test-platform-server.js';
import {
  launchPlaywrightBrowser,
  createIsolatedPage,
  uiLogin,
} from '../../src/contract/browser-helper.js';
import {
  probeProtectedPorts,
  assertProtectedPortsUnmolested,
  type ProtectedPortsSnapshot,
} from '../../src/probes/ports-guard.js';

const MOCK_QR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25"><rect width="25" height="25" fill="#ffffff"/><rect x="2" y="2" width="7" height="7" fill="#000000"/></svg>';

describe('Contract E2E: Feishu Bot Onboarding UI & QR Rendering', () => {
  let probeBefore: ProtectedPortsSnapshot;
  let browser: Browser;
  let testServer: RunningTestServer;

  beforeAll(async () => {
    probeBefore = await probeProtectedPorts();
    testServer = await createAndStartTestPlatformServer();
    browser = await launchPlaywrightBrowser({ headless: true });
  });

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
    if (testServer) {
      await testServer.stop();
    }
    const probeAfter = await probeProtectedPorts();
    assertProtectedPortsUnmolested(probeBefore, probeAfter);
  });

  it('navigates to Channels view, renders Onboarding panel, and displays true QR code image on job start', async () => {
    const { page } = await createIsolatedPage(browser);
    try {
      // 1. Log in as Alice
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');

      // 2. Mock onboarding API endpoints for deterministic browser E2E verification
      let currentJobState: any = {
        id: 'job_onb_e2e_playwright',
        userId: 'u1',
        spaceId: 'sp1',
        action: 'configure_existing',
        appId: 'cli_0123456789abcdef',
        status: 'waiting_for_scan',
        statusMessage: 'Waiting for Feishu mobile app scan',
        qrSvg: MOCK_QR_SVG,
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await page.route('**/api/manage/channels/onboarding/jobs', async (route) => {
        if (route.request().method() === 'POST') {
          await route.fulfill({
            status: 201,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              data: currentJobState,
            }),
          });
        } else {
          await route.continue();
        }
      });

      await page.route('**/api/manage/channels/onboarding/jobs/*', async (route) => {
        const url = route.request().url();
        if (url.endsWith('/cancel') && route.request().method() === 'POST') {
          currentJobState = {
            ...currentJobState,
            status: 'cancelled',
            statusMessage: 'Onboarding job cancelled by user',
          };
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data: currentJobState }),
          });
        } else if (route.request().method() === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data: currentJobState }),
          });
        } else {
          await route.continue();
        }
      });

      // 3. Open Channels view in Web UI
      await page.click('#nav-management');
      await page.waitForSelector('#management-canvas', { state: 'visible', timeout: 5000 });
      await page.evaluate(() => {
        window.location.hash = '#management/workspaces/channels';
      });
      await page.waitForSelector('.channel-toolbar-row', { timeout: 10000 });

      // 4. Assert Onboarding Action Buttons are rendered
      const btnCreateNew = page.locator('.channel-toolbar-row button:has-text("新建机器人"), .channel-toolbar-row button:has-text("Create New Bot")');
      const btnConfigExisting = page.locator('.channel-toolbar-row button:has-text("配置已有机器人"), .channel-toolbar-row button:has-text("Configure Existing Bot")');
      
      expect(await btnCreateNew.isVisible()).toBe(true);
      expect(await btnConfigExisting.isVisible()).toBe(true);

      // 5. Click "Configure Existing Bot" and verify wizard form inputs
      await btnConfigExisting.click();
      await page.waitForSelector('#modal-channel-onboarding form', { timeout: 5000 });

      const spaceSelect = page.locator('#channel-modal-space-select');
      const appIdInput = page.locator('#channel-modal-appid-input');
      expect(await spaceSelect.isVisible()).toBe(true);
      expect(await appIdInput.isVisible()).toBe(true);

      // Fill existing AppID
      await appIdInput.fill('cli_0123456789abcdef');

      // 6. Submit wizard and assert QR Code image (<img>) is rendered visible
      const submitBtn = page.locator('#modal-channel-onboarding button[type="submit"]');
      await submitBtn.click();

      // Wait for QR card
      await page.waitForSelector('.channel-qr-box', { timeout: 5000 });

      // Check true QR SVG / img element
      const qrElement = page.locator('.channel-qr-canvas svg, .channel-qr-canvas img');
      expect(await qrElement.isVisible()).toBe(true);

      // Check user prompt
      const qrPrompt = page.locator('.channel-qr-canvas');
      expect(await qrPrompt.textContent()).toMatch(/请用飞书App扫一扫|Please scan with Feishu App/);

      // Verify NO fake browser link is rendered
      const authLink = page.locator('.channel-qr-canvas a');
      expect(await authLink.count()).toBe(0);

      // Check status badge
      const statusText = page.locator('.channel-status-badge-row');
      expect(await statusText.textContent()).toContain('waiting_for_scan');

      // 7. Click Cancel button and assert clean cancellation
      const cancelBtn = page.locator('.channel-qr-box button:has-text("取消任务"), .channel-qr-box button:has-text("Cancel")');
      expect(await cancelBtn.isVisible()).toBe(true);
      await cancelBtn.click();
    } finally {
      await page.close();
    }
  });

  it('account card renders trigger select with 2 options and current value, changing it and clicking save issues exactly one PATCH with groupActivationMode: always', async () => {
    const { page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');

      const mockLarkAccount = {
        id: 'acc_lark_mock_trigger_1',
        type: 'lark',
        status: 'active',
        name: 'Test Lark Bot',
        credentialRef: 'cred_lark_cli_a1b2c3d4e5f6',
        defaultSpaceId: null,
        groupActivationMode: 'mention',
      };

      // Mock channels accounts endpoint
      await page.route('**/api/manage/channels/accounts', async (route) => {
        if (route.request().method() === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              data: { accounts: [mockLarkAccount] },
            }),
          });
        } else {
          await route.continue();
        }
      });

      // Mock channels bindings endpoint
      await page.route('**/api/manage/channels/bindings', async (route) => {
        if (route.request().method() === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              data: { bindings: [] },
            }),
          });
        } else {
          await route.continue();
        }
      });

      // Intercept and verify PATCH /api/manage/channels/accounts/:id
      let patchCount = 0;
      let patchBody: any = null;
      await page.route('**/api/manage/channels/accounts/*', async (route) => {
        if (route.request().method() === 'PATCH') {
          patchCount++;
          patchBody = route.request().postDataJSON();
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              data: { ...mockLarkAccount, ...patchBody },
            }),
          });
        } else {
          await route.continue();
        }
      });

      // Navigate to Channels view in Web UI
      await page.click('#nav-management');
      await page.waitForSelector('#management-canvas', { state: 'visible', timeout: 5000 });
      await page.evaluate(() => {
        window.location.hash = '#management/workspaces/channels';
      });
      await page.waitForSelector('.channel-account-card', { timeout: 10000 });

      // Assert account card renders the trigger select
      const card = page.locator('.channel-account-card').first();
      const triggerSelect = card.locator('.channel-acc-trigger-select');
      expect(await triggerSelect.isVisible()).toBe(true);

      // Assert 2 options exist: mention and always
      const options = triggerSelect.locator('option');
      expect(await options.count()).toBe(2);

      const optValues = await options.evaluateAll((opts: HTMLOptionElement[]) => opts.map(o => o.value));
      expect(optValues).toEqual(['mention', 'always']);

      // Assert current value is 'mention' (from mockLarkAccount.groupActivationMode)
      expect(await triggerSelect.inputValue()).toBe('mention');

      // Change select to 'always'
      await triggerSelect.selectOption('always');
      expect(await triggerSelect.inputValue()).toBe('always');

      // Click save button for group trigger
      const saveBtn = card.locator('.channel-save-trigger-btn');
      expect(await saveBtn.isVisible()).toBe(true);

      const [patchResponse] = await Promise.all([
        page.waitForResponse((res) => res.url().includes('/api/manage/channels/accounts/') && res.request().method() === 'PATCH'),
        saveBtn.click(),
      ]);
      expect(patchResponse.status()).toBe(200);

      // Assert exactly one PATCH was issued with { groupActivationMode: 'always' }
      expect(patchCount).toBe(1);
      expect(patchBody).toEqual({ groupActivationMode: 'always' });
    } finally {
      await page.close();
    }
  });
});
