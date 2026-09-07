import { describe, it, beforeAll, afterAll } from 'vitest';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright';
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

const REPORT_SHOTS_DIR = join(process.cwd(), '../../reports/screenshots');

describe('Generate Chat Attachments Report Screenshots', () => {
  let browser: Browser;
  let testServer: TestPlatformServerHandle;

  beforeAll(async () => {
    if (!existsSync(REPORT_SHOTS_DIR)) {
      mkdirSync(REPORT_SHOTS_DIR, { recursive: true });
    }
    testServer = await createAndStartTestPlatformServer({ autoReplyDelayMs: 20 });
    browser = await launchPlaywrightBrowser({ headless: true });
  });

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      await testServer?.stop();
    }
  });

  it('captures all attachment states, tray, modal, message cards in en and zh-CN', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      const aliceUser = testServer.fixtures.admin;
      const tenant = testServer.storage.forTenant(aliceUser.id);

      const space = await tenant.spaces.create({
        name: 'Report Space',
        folder: 'report-folder',
      });

      // Seed files for picker
      await testServer.fileProvider.execute(aliceUser.id, space.id, {
        op: 'write',
        path: 'Architecture-Overview.pdf',
        content: '%PDF Mock Architecture Doc',
        encoding: 'utf8',
      });
      await testServer.fileProvider.execute(aliceUser.id, space.id, {
        op: 'write',
        path: 'schema-design.json',
        content: '{"tables": ["users", "messages"]}',
        encoding: 'utf8',
      });

      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });
      await page.selectOption('#space-select', space.id);
      await uiCreateSession(page, { title: 'Attachment Demo Session', spaceId: space.id });
      await page.waitForSelector('#session-list .session-item.active', { state: 'visible', timeout: 8000 });

      // 1. Initial Empty Composer with Attach Button
      await page.screenshot({ path: join(REPORT_SHOTS_DIR, '01_composer_initial.png') });

      // 2. Attach Menu Open
      await page.click('#btn-attach');
      await page.waitForSelector('#attach-menu', { state: 'visible', timeout: 5000 });
      await page.screenshot({ path: join(REPORT_SHOTS_DIR, '02_attach_dropdown_menu.png') });

      // 3. Workspace File Picker Modal
      await page.click('#btn-attach-workspace');
      await page.waitForSelector('#modal-file-picker', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('#file-picker-list .file-picker-item.is-file', { state: 'visible', timeout: 5000 });
      await page.screenshot({ path: join(REPORT_SHOTS_DIR, '03_workspace_file_picker_modal.png') });

      // Select both files
      const items = await page.$$('#file-picker-list .file-picker-item.is-file');
      for (const item of items) {
        await item.click();
      }
      await page.screenshot({ path: join(REPORT_SHOTS_DIR, '04_workspace_file_picker_selected.png') });

      // Apply selection
      await page.click('#btn-file-picker-select');
      await page.waitForSelector('#modal-file-picker', { state: 'hidden', timeout: 5000 });

      // 4. Composer Attachment Tray (Ready state)
      await page.waitForSelector('#composer-attachment-tray .attachment-tray-item.status-ready', { state: 'visible', timeout: 5000 });
      await page.screenshot({ path: join(REPORT_SHOTS_DIR, '05_composer_tray_ready.png') });

      // 5. Send message with attachments
      await page.fill('#chat-input', 'Please analyze the attached architecture specification and JSON schema design.');
      await page.screenshot({ path: join(REPORT_SHOTS_DIR, '06_composer_filled_with_attachments.png') });
      await page.click('#btn-send-message');

      // 6. Message Card with Safe Attachment Cards
      await page.waitForSelector('.message-card.user .message-attachment-card', { state: 'visible', timeout: 8000 });
      await page.screenshot({ path: join(REPORT_SHOTS_DIR, '07_message_card_attachments_en.png') });

      // 7. Instant Locale Switch to zh-CN
      await page.evaluate(() => {
        const win = window as any;
        win.setLocale ? win.setLocale('zh-CN') : win.EnkeepI18n?.setLocale('zh-CN');
      });
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(REPORT_SHOTS_DIR, '08_message_card_attachments_zh.png') });

      // 8. Mobile 390px Viewport
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(REPORT_SHOTS_DIR, '09_mobile_390px_attachments.png') });

      // Reset desktop viewport
      await page.setViewportSize({ width: 1280, height: 800 });

      // 10. Skills Governance & Permission Presets (EN)
      await page.evaluate(() => {
        const win = window as any;
        win.setLocale ? win.setLocale('en') : win.EnkeepI18n?.setLocale('en');
      });
      await page.goto(`${testServer.url}#management/workspaces/profiles`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.skills-container', { state: 'visible', timeout: 8000 });
      await page.screenshot({ path: join(REPORT_SHOTS_DIR, '10_skills_and_permission_presets_en.png') });

      // 11. Skills Governance in zh-CN
      await page.evaluate(() => {
        const win = window as any;
        win.setLocale ? win.setLocale('zh-CN') : win.EnkeepI18n?.setLocale('zh-CN');
      });
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(REPORT_SHOTS_DIR, '11_skills_and_permission_presets_zh.png') });

      // 12. Model Configuration Hierarchy & Health Circuit Breaker
      await page.goto(`${testServer.url}#management/models/model-config`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.management-section', { state: 'visible', timeout: 8000 });
      await page.screenshot({ path: join(REPORT_SHOTS_DIR, '12_models_hierarchy_and_health_table.png') });

      // 13. Runtime Diagnostics Modal
      await page.goto(`${testServer.url}#management/runtime/runtime`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('button:has-text("运行时诊断"), button:has-text("Runtime Diagnostics")', { state: 'visible', timeout: 8000 });
      await page.click('button:has-text("运行时诊断"), button:has-text("Runtime Diagnostics")');
      await page.waitForSelector('#modal-diagnostics', { state: 'visible', timeout: 5000 });
      await page.screenshot({ path: join(REPORT_SHOTS_DIR, '13_runtime_diagnostics_modal.png') });
      await page.click('#modal-diagnostics [data-close="modal-diagnostics"]');

      // 14. Activity Audit Export Controls
      await page.goto(`${testServer.url}#management/users/audit`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.filter-toolbar', { state: 'visible', timeout: 8000 });
      await page.screenshot({ path: join(REPORT_SHOTS_DIR, '14_activity_audit_streaming_export.png') });
    } finally {
      await context.close();
    }
  });
});
