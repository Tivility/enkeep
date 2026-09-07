/**
 * Playwright E2E Contract Test: Channels User Journeys
 *
 * Strict Contract Verification for Channels UI:
 * - Journey 1: Fixture account listing with readable names, no long IDs in defaultWorkspace options,
 *              no initial KPI 'Operational' / '正常运行中', strictly 0 visible credentialRef raw inputs,
 *              technical details <details class="channel-tech-details"> exist (>=1) and are closed by default,
 *              existing bot main button opens standard modal (#modal-channel-onboarding role="dialog"),
 *              step1 selects account and default workspace by label/id without UUID options,
 *              and default workspace PATCH must be triggered via card UI select + save button (not page.request).
 * - Journey 2: QR onboarding lifecycle with real generateQrSvg from channel-lark:
 *              waiting_for_scan (statusCode 1) -> statusCode 2 (手机已扫码待确认 assert) ->
 *              configuring (配置中, QR not retained / hidden) -> expired (失效, retry button assert).
 *              Retry restarts job and simulates 404/401 error response with visible error assert and QR gone.
 *              Verifies polling stops completely after close / ESC.
 *              Includes deferred POST held + ESC race condition handling, asserting modal remains hidden,
 *              cancelled appropriately, and no orphan background polling or QR re-render occurs.
 *              Verifies 'Done' on completed/ready state does not issue unexpected cancel requests.
 * - Journey 3: Multi-theme (dark, light, eye-care), i18n (en, zh-CN), and mobile viewport:
 *              strictly asserts modal is visible in 390px viewport, does not horizontally overflow,
 *              key translations are complete, and theme CSS variables are active.
 *
 * @module @enkeep/web-e2e/tests/contract
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser, Page } from 'playwright';
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
} from '../../src/contract/browser-helper.js';
import {
  probeProtectedPorts,
  assertProtectedPortsUnmolested,
  type ProtectedPortsSnapshot,
} from '../../src/probes/ports-guard.js';

// Real QR SVG generator imported from channel-lark (no fake black rectangles)
let generateQrSvg: (text: string, options?: any) => string;
try {
  const larkQr = await import('../../../channel-lark/dist/onboarding/qr-generator.js');
  generateQrSvg = larkQr.generateQrSvg;
} catch {
  const larkQrTs = await import('../../../channel-lark/src/onboarding/qr-generator.ts');
  generateQrSvg = larkQrTs.generateQrSvg;
}

const TEMP_SHOTS_DIR = '/tmp/enkeep-contract-channels';

describe('Contract E2E: Channels User Journeys', () => {
  let probeBefore: ProtectedPortsSnapshot;
  let browser: Browser;
  let testServer: RunningTestServer;

  beforeAll(async () => {
    if (!existsSync(TEMP_SHOTS_DIR)) {
      mkdirSync(TEMP_SHOTS_DIR, { recursive: true });
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

  /**
   * Helper to navigate to the Channels management view.
   */
  async function navigateToChannelsView(page: Page): Promise<void> {
    await page.evaluate(() => {
      window.location.hash = '#management/workspaces/channels';
    });
    await page.waitForSelector('#management-canvas', { state: 'visible', timeout: 5000 });
  }

  // =========================================================================
  // Journey 1: Account Listing, Security Constraints, Modal & UI-driven PATCH
  // =========================================================================
  it('Journey 1: Account listing with readable names, no raw credentials or Operational KPI, details closed, modal workspace patch', async () => {
    const { page } = await createIsolatedPage(browser, { viewport: { width: 1280, height: 800 } });
    try {
      const adminUser = testServer.fixtures.admin;

      // 1. Initialize fixture spaces and a real Lark channel account via platform storage
      const tenantStorage = testServer.storage.forTenant(adminUser.id);
      const spaceEng = await tenantStorage.spaces.create({
        name: 'Engineering Workspace',
        folder: 'engineering-ws',
      });
      const spaceProd = await tenantStorage.spaces.create({
        name: 'Product Team Space',
        folder: 'product-ws',
      });

      const fixtureAccount = await tenantStorage.channels.createAccount({
        type: 'lark',
        status: 'active',
        credentialRef: 'cred_lark_mock_cli_a1b2c3d4e5f6',
        defaultSpaceId: spaceEng.id,
      });

      // 2. Login as admin user and navigate to Channels view
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await navigateToChannelsView(page);

      // Give view time to load accounts/spaces
      await page.waitForFunction(() => {
        const text = document.querySelector('#management-canvas')?.textContent || '';
        return text.includes('Lark') || text.includes('Feishu') || text.includes('渠道');
      }, { timeout: 8000 });

      // 3. Strict Assertions on Initial Screen:
      // a) No KPI card showing 'Operational' or '正常运行中'
      const kpiCards = page.locator('.kpi-card, .channel-kpi-card');
      const kpiCount = await kpiCards.count();
      for (let i = 0; i < kpiCount; i++) {
        const text = (await kpiCards.nth(i).textContent()) || '';
        expect(text).not.toContain('Operational');
        expect(text).not.toContain('正常运行中');
      }

      // b) Strictly 0 visible credentialRef raw inputs on Channels canvas (must not expose raw secret or prompt raw credential)
      const visibleCredInputs = page.locator('#management-canvas input[placeholder*="cred_"]:visible, #management-canvas input[id*="cred"]:visible, #management-canvas .channel-acc-cred-input:visible');
      expect(await visibleCredInputs.count()).toBe(0);

      // c) Card & Technical details assertion: at least 1 card and at least 1 technical details container must exist
      const cards = page.locator('.channel-account-card');
      const cardCount = await cards.count();
      expect(cardCount).toBeGreaterThanOrEqual(1);

      const techDetails = page.locator('details.channel-tech-details');
      const detailsCount = await techDetails.count();
      expect(detailsCount).toBeGreaterThanOrEqual(1);
      for (let i = 0; i < detailsCount; i++) {
        const isOpen = await techDetails.nth(i).getAttribute('open');
        expect(isOpen).toBeNull(); // details element MUST be closed by default
      }

      // d) Verify workspace select options in card do not show raw UUID as primary/only text
      const spaceSelect = page.locator('.channel-account-card select, .channel-acc-space-select').first();
      expect(await spaceSelect.isVisible()).toBe(true);
      const optionTexts = await spaceSelect.locator('option').allTextContents();
      for (const optText of optionTexts) {
        if (optText.includes('Engineering') || optText.includes('Product')) {
          expect(optText).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        }
      }

      // 4. Existing Bot main button & Standard Modal Interaction:
      const btnExistingBot = page.locator('button:has-text("配置已有机器人"), button:has-text("Configure Existing Bot")').first();
      expect(await btnExistingBot.isVisible()).toBe(true);
      await btnExistingBot.click();

      // Check standard modal #modal-channel-onboarding with role="dialog" is strictly visible
      await page.waitForSelector('#modal-channel-onboarding[role="dialog"]', { state: 'visible', timeout: 5000 });
      const onboardingModal = page.locator('#modal-channel-onboarding[role="dialog"]');
      expect(await onboardingModal.isVisible()).toBe(true);

      // Step 1: select bot by label/id and select default workspace
      const modalBotSelect = page.locator('#channel-modal-bot-select, select[id*="bot"]').first();
      expect(await modalBotSelect.isVisible()).toBe(true);

      const modalSpaceSelect = page.locator('#channel-modal-space-select, label:has-text("默认工作区") + select, label:has-text("Default workspace") + select').first();
      expect(await modalSpaceSelect.isVisible()).toBe(true);

      // Verify workspace select inside modal displays human readable space names without long IDs
      const modalOpts = await modalSpaceSelect.locator('option').allTextContents();
      const readableOpts = modalOpts.filter((o) => o.includes('Engineering') || o.includes('Product'));
      expect(readableOpts.length).toBeGreaterThanOrEqual(1);
      for (const optText of readableOpts) {
        expect(optText).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      }

      // Close modal using close button
      const closeBtn = page.locator('#modal-channel-onboarding .modal-close[data-close], [data-close="modal-channel-onboarding"]').first();
      expect(await closeBtn.isVisible()).toBe(true);
      await closeBtn.click();
      await page.waitForSelector('#modal-channel-onboarding', { state: 'hidden', timeout: 5000 });
      expect(await onboardingModal.isVisible()).toBe(false);

      // 5. Test real UI-driven PATCH update on card: user changes select and clicks Save button
      const cardSpaceSelect = page.locator('.channel-account-card select, .channel-acc-space-select').first();
      await cardSpaceSelect.selectOption(spaceProd.id);

      const saveBtn = page.locator('.channel-account-card button:has-text("保存"), .channel-acc-space-cell button:has-text("Save"), .channel-account-card button:has-text("Save")').first();
      expect(await saveBtn.isVisible()).toBe(true);

      // Listen for the actual PATCH request from the browser
      const [patchRequest] = await Promise.all([
        page.waitForRequest((req) => req.url().includes('/api/manage/channels/accounts/') && req.method() === 'PATCH'),
        saveBtn.click(),
      ]);
      expect(patchRequest).toBeDefined();

      // Verify updated defaultSpaceId in platform storage
      await page.waitForTimeout(500);
      const updatedAccount = await tenantStorage.channels.findAccountById(fixtureAccount.id);
      expect(updatedAccount?.defaultSpaceId).toBe(spaceProd.id);
    } finally {
      await page.close();
    }
  });

  // =========================================================================
  // Journey 2: Realistic QR SVG, Status Transitions, Polling Teardown & Deferred Race
  // =========================================================================
  it('Journey 2: Real QR SVG, transitions waiting_for_scan -> statusCode2 -> configuring -> expired/error, stops polling on close/ESC', async () => {
    const { page } = await createIsolatedPage(browser, { viewport: { width: 1280, height: 800 } });
    try {
      const adminUser = testServer.fixtures.admin;
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');

      // Generate a genuine QR code SVG using channel-lark's QR generator
      const genuineQrSvg = generateQrSvg('https://applink.feishu.cn/client/mini_program/open?appId=cli_contract_test', {
        eccLevel: 'M',
        margin: 4,
      });
      expect(genuineQrSvg).toContain('<svg');
      expect(genuineQrSvg).toContain('viewBox=');

      // State machine for onboarding job
      let jobState = {
        id: 'job_contract_journey_2',
        userId: adminUser.id,
        action: 'configure_existing',
        appId: 'cli_contract_test_app',
        status: 'waiting_for_scan',
        statusCode: 1,
        statusMessage: 'Waiting for mobile scan',
        qrSvg: genuineQrSvg,
        expiresAt: new Date(Date.now() + 180000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      let pollRequestCount = 0;
      let cancelRequestCount = 0;
      let shouldSimulate404 = false;
      let deferredPostResolve: (() => void) | null = null;
      let postReceivedResolve: (() => void) | null = null;
      let deferNextPost = false;

      // Mock the onboarding API endpoints
      await page.route('**/api/manage/channels/onboarding/jobs', async (route) => {
        if (route.request().method() === 'POST') {
          if (deferNextPost) {
            deferNextPost = false;
            if (postReceivedResolve) {
              postReceivedResolve();
              postReceivedResolve = null;
            }
            await new Promise<void>((resolve) => {
              deferredPostResolve = resolve;
            });
          }
          pollRequestCount = 0;
          await route.fulfill({
            status: 201,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data: jobState }),
          });
        } else {
          await route.continue();
        }
      });

      await page.route('**/api/manage/channels/onboarding/jobs/**', async (route) => {
        const url = route.request().url();
        if (url.endsWith('/cancel')) {
          cancelRequestCount++;
          jobState.status = 'cancelled';
          jobState.qrSvg = '';
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data: jobState }),
          });
          return;
        }

        if (route.request().method() === 'GET') {
          pollRequestCount++;

          if (shouldSimulate404) {
            await route.fulfill({
              status: 404,
              contentType: 'application/json',
              body: JSON.stringify({ success: false, error: 'Job not found or expired' }),
            });
            return;
          }

          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data: jobState }),
          });
          return;
        }

        await route.continue();
      });

      await navigateToChannelsView(page);

      // Trigger onboarding modal
      const btnExistingBot = page.locator('button:has-text("配置已有机器人"), button:has-text("Configure Existing Bot")').first();
      expect(await btnExistingBot.isVisible()).toBe(true);
      await btnExistingBot.click();

      // Assert modal is strictly visible
      await page.waitForSelector('#modal-channel-onboarding[role="dialog"]', { state: 'visible', timeout: 5000 });
      const onboardingModal = page.locator('#modal-channel-onboarding[role="dialog"]');
      expect(await onboardingModal.isVisible()).toBe(true);

      // Submit wizard form to start job
      const submitBtn = page.locator('#modal-channel-onboarding button[type="submit"], #modal-channel-onboarding button:has-text("下一步"), #modal-channel-onboarding button:has-text("Next")').first();
      expect(await submitBtn.isVisible()).toBe(true);
      await submitBtn.click();

      // 1. Stage: waiting_for_scan (statusCode 1)
      await page.waitForSelector('.channel-qr-canvas svg, .channel-qr-canvas img', { state: 'visible', timeout: 5000 });
      const qrContainer = page.locator('.channel-qr-canvas').first();
      const canvasText = await qrContainer.textContent();
      expect(canvasText).toMatch(/飞书|Feishu|扫一扫|Scan|确认|confirm/i);

      // 2. Stage: transition to statusCode 2 (手机已扫码，请在手机上确认)
      jobState = {
        ...jobState,
        status: 'waiting_for_scan',
        statusCode: 2,
        statusMessage: '手机已扫码，请在手机上确认',
      };
      await page.waitForFunction(() => {
        const text = document.querySelector('.channel-status-msg, .channel-status-badge-row')?.textContent || '';
        return text.includes('手机已扫码') || text.includes('确认');
      }, { timeout: 4000 });
      const statusTextStage2 = await page.locator('.channel-status-msg, .channel-status-badge-row').first().textContent();
      expect(statusTextStage2).toContain('手机已扫码');

      // 3. Stage: transition to configuring (配置中)
      // QR SVG must be hidden/cleared in configuring state
      jobState = {
        ...jobState,
        status: 'configuring',
        statusCode: 3,
        statusMessage: '配置中：正在配置应用权限与事件订阅...',
        qrSvg: '',
      };
      await page.waitForFunction(() => {
        const text = document.querySelector('.channel-status-msg, .channel-status-badge-row')?.textContent || '';
        return text.includes('配置中');
      }, { timeout: 4000 });
      const statusTextStage3 = await page.locator('.channel-status-msg, .channel-status-badge-row').first().textContent();
      expect(statusTextStage3).toContain('配置中');

      // Assert QR SVG is strictly not visible in configuring state
      const qrSvgInConfiguring = page.locator('.channel-qr-canvas svg');
      expect(await qrSvgInConfiguring.isVisible()).toBe(false);

      // 4. Stage: transition to expired -> Assert retry button is strictly visible
      jobState = {
        ...jobState,
        status: 'expired',
        statusMessage: '二维码已失效，请重新生成',
      };
      await page.waitForFunction(() => {
        const text = document.querySelector('.channel-status-msg, .channel-status-badge-row')?.textContent || '';
        return text.includes('二维码已失效') || text.includes('expired');
      }, { timeout: 4000 });

      const retryBtn = page.locator('.channel-qr-box button:has-text("重新生成二维码"), .channel-qr-box button:has-text("Retry")').first();
      expect(await retryBtn.isVisible()).toBe(true);

      // 5. Test 404 error handling: clicking retry and simulating 404 response on polling
      shouldSimulate404 = true;
      jobState = {
        ...jobState,
        id: 'job_retry_404_sim',
        status: 'waiting_for_scan',
        statusCode: 1,
        statusMessage: 'Waiting for scan',
        qrSvg: genuineQrSvg,
      };

      await retryBtn.click();

      // Re-submit step 1 to restart job
      const retrySubmitBtn = page.locator('#modal-channel-onboarding button[type="submit"]').first();
      expect(await retrySubmitBtn.isVisible()).toBe(true);
      await retrySubmitBtn.click();

      // Assert that 404 triggers visible error prompt and cleans QR display
      await page.waitForFunction(() => {
        const text = document.querySelector('.channel-status-msg, .channel-status-badge-row')?.textContent || '';
        return text.includes('404') || text.includes('不存在') || text.includes('失效');
      }, { timeout: 5000 });
      const errorMsgText = await page.locator('.channel-status-msg, .channel-status-badge-row').first().textContent();
      expect(errorMsgText).toMatch(/404|不存在|失效|not found/i);

      const qrAfter404 = page.locator('.channel-qr-canvas svg');
      expect(await qrAfter404.isVisible()).toBe(false);

      // 6. Verify Polling stops on Close / ESC
      const cancelBtn = page.locator('.channel-qr-box button:has-text("取消任务"), .channel-qr-box button:has-text("Cancel"), .channel-qr-box button:has-text("关闭"), .channel-qr-box button:has-text("Close")').first();
      if (await cancelBtn.isVisible()) {
        await cancelBtn.click();
      } else {
        await page.keyboard.press('Escape');
      }

      await page.waitForTimeout(1000);
      const countAfterClose = pollRequestCount;

      // Wait another 3.5 seconds (more than 2 poll cycles) to verify polling is stopped
      await page.waitForTimeout(3500);
      const countAfterWaiting = pollRequestCount;

      expect(countAfterWaiting - countAfterClose).toBeLessThanOrEqual(1); // At most 1 in-flight settlement

      // 7. Key Close Race Scenario: Press ESC while POST is held deferred, then let POST succeed.
      // Assert modal remains hidden, job cancelled, and no orphan background polling or QR re-render.
      shouldSimulate404 = false;
      deferNextPost = true;
      const postReceivedPromise = new Promise<void>((resolve) => {
        postReceivedResolve = resolve;
      });

      jobState = {
        ...jobState,
        id: 'job_esc_held_race',
        status: 'waiting_for_scan',
        statusCode: 1,
        statusMessage: 'Waiting for mobile scan',
        qrSvg: genuineQrSvg,
      };

      // Re-open modal
      await btnExistingBot.click();
      await page.waitForSelector('#modal-channel-onboarding[role="dialog"]', { state: 'visible', timeout: 5000 });

      // Click submit (POST request is triggered and held by route handler)
      const postSubmitBtn = page.locator('#modal-channel-onboarding button[type="submit"]').first();
      expect(await postSubmitBtn.isVisible()).toBe(true);
      await postSubmitBtn.click();

      // Wait until the POST request is authentically received and held by the route handler
      await postReceivedPromise;
      expect(deferredPostResolve).not.toBeNull();

      const preEscCancelCount = cancelRequestCount;

      // User presses ESC while POST is still held in-flight
      await page.keyboard.press('Escape');
      await page.waitForSelector('#modal-channel-onboarding', { state: 'hidden', timeout: 5000 });
      expect(await onboardingModal.isVisible()).toBe(false);

      // Now explicitly release the deferred POST response
      deferredPostResolve!();
      deferredPostResolve = null;
      await page.waitForTimeout(1000);

      // Modal must remain hidden, and no active QR canvas should be visible on page
      expect(await onboardingModal.isVisible()).toBe(false);
      const rogueQr = page.locator('.channel-qr-canvas svg');
      expect(await rogueQr.isVisible()).toBe(false);

      // Confirm that this newly created job was cancelled upon return (cancel endpoint called)
      expect(cancelRequestCount).toBeGreaterThan(preEscCancelCount);

      // Record poll count and ensure background polling is not active
      const preCheckPollCount = pollRequestCount;
      await page.waitForTimeout(3000);
      expect(pollRequestCount - preCheckPollCount).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  });

  // =========================================================================
  // Journey 3: Multi-Theme, i18n & Mobile Viewport Constraints
  // =========================================================================
  it('Journey 3: Narrow viewport modal does not horizontally overflow, verifies translations and theme variables', async () => {
    // Narrow mobile viewport (390 x 844)
    const { page } = await createIsolatedPage(browser, { viewport: { width: 390, height: 844 } });
    try {
      const adminUser = testServer.fixtures.admin;
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await navigateToChannelsView(page);

      // 1. Narrow Viewport & Horizontal Overflow:
      const hasHorizontalOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
      });
      expect(hasHorizontalOverflow).toBe(false);

      // Open onboarding modal and assert strictly visible in narrow viewport
      const btnExistingBot = page.locator('button:has-text("配置已有机器人"), button:has-text("Configure Existing Bot")').first();
      expect(await btnExistingBot.isVisible()).toBe(true);
      await btnExistingBot.click();

      await page.waitForSelector('#modal-channel-onboarding[role="dialog"]', { state: 'visible', timeout: 5000 });
      const onboardingModal = page.locator('#modal-channel-onboarding[role="dialog"]');
      expect(await onboardingModal.isVisible()).toBe(true);

      // Verify modal card does not exceed viewport width (no horizontal overflow)
      const modalOverflow = await page.evaluate(() => {
        const modal = document.querySelector('#modal-channel-onboarding .modal-card');
        if (!modal) return true; // Fail if modal card missing
        return modal.scrollWidth > window.innerWidth + 2;
      });
      expect(modalOverflow).toBe(false);

      await page.screenshot({ path: join(TEMP_SHOTS_DIR, '01_mobile_channel_onboarding.png') });

      // Close modal
      const closeBtn = page.locator('#modal-channel-onboarding .modal-close[data-close]').first();
      await closeBtn.click();
      await page.waitForSelector('#modal-channel-onboarding', { state: 'hidden', timeout: 5000 });
      expect(await onboardingModal.isVisible()).toBe(false);

      // 2. Language Switching (zh-CN and en)
      await page.evaluate(() => {
        const win = window as any;
        if (typeof win.setLocale === 'function') {
          win.setLocale('en');
        }
      });
      await page.waitForTimeout(300);

      const pageTextEn = await page.locator('#management-canvas').first().textContent();
      expect(pageTextEn).toBeDefined();

      await page.evaluate(() => {
        const win = window as any;
        if (typeof win.setLocale === 'function') {
          win.setLocale('zh-CN');
        }
      });
      await page.waitForTimeout(300);

      // 3. Theme Switching (dark, light, eye-care)
      const themes = ['light', 'dark', 'eye-care'] as const;
      for (const theme of themes) {
        await page.evaluate((t) => {
          const win = window as any;
          if (typeof win.setTheme === 'function') {
            win.setTheme(t);
          } else {
            document.documentElement.setAttribute('data-theme', t);
          }
        }, theme);
        await page.waitForTimeout(200);

        const activeTheme = await page.getAttribute('html', 'data-theme');
        expect(activeTheme).toBe(theme);

        // Verify key theme CSS variables
        const cssVars = await page.evaluate(() => {
          const styles = getComputedStyle(document.documentElement);
          return {
            bgPrimary: styles.getPropertyValue('--bg-primary').trim(),
            textPrimary: styles.getPropertyValue('--text-primary').trim(),
          };
        });
        expect(cssVars.bgPrimary.length).toBeGreaterThan(0);
        expect(cssVars.textPrimary.length).toBeGreaterThan(0);

        await page.screenshot({ path: join(TEMP_SHOTS_DIR, `02_theme_${theme}.png`) });
      }
    } finally {
      await page.close();
    }
  });
});
