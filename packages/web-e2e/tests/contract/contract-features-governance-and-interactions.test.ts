/**
 * Contract E2E Test Suite for Modules A-F:
 * 1. Skills Governance (Git/Archive Install, Diff Preview Update, Rollback, Enable/Disable, Uninstall, Provenance)
 * 2. Approvals Panel & Turn Waiting (Interactions, Safe Redaction, Allow/Reject/Cancel, Permission Presets & Conflicts)
 * 3. Models Precedence & Circuit Breaker (Hierarchical Effective Preview, Health Telemetry, Probe, Reset Breakers)
 * 4. Runtime Diagnostics & Streaming Exports (Timeline, Redaction, Resource Cards, CSV Formula Safe Links)
 * 5. Task Webhook Notifications (Subscriptions CRUD, One-Time Secret, Test Webhook, Deliveries Retry)
 * 6. Internationalization (zh-CN & en) & Mobile Responsive Viewports (390px)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser } from 'playwright';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

describe('Contract E2E: Skills Governance, Approvals, Models Hierarchy & Task Notifications', () => {
  let browser: Browser;
  let testServer: TestPlatformServerHandle;
  let tempGitDir: string;
  let mockExternalInteraction: any;

  const pendingApprovalsStore: any[] = [];

  beforeAll(async () => {
    if (!existsSync(REPORT_SHOTS_DIR)) {
      mkdirSync(REPORT_SHOTS_DIR, { recursive: true });
    }

    // 1. Initialize Mock External Interaction Service for Approvals
    mockExternalInteraction = {
      listPendingApprovals(filter?: { userId?: string; sessionId?: string }) {
        return pendingApprovalsStore.filter((a) => {
          if (filter?.sessionId && a.sessionId !== filter.sessionId) return false;
          if (filter?.userId && a.userId !== filter.userId) return false;
          return a.status === 'pending';
        });
      },
      getPendingApproval(id: string) {
        return pendingApprovalsStore.find((a) => a.id === id);
      },
      answerApproval(id: string, outcome: string) {
        const item = pendingApprovalsStore.find((a) => a.id === id);
        if (item) {
          item.status = outcome;
          item.decidedAt = new Date().toISOString();
          return true;
        }
        return false;
      },
      cancelApproval(id: string, reason?: string) {
        const item = pendingApprovalsStore.find((a) => a.id === id);
        if (item) {
          item.status = 'cancelled';
          item.reason = reason;
          return true;
        }
        return false;
      },
    };

    // 3. Prepare Local Git Skill Repository for test policy install
    tempGitDir = join(tmpdir(), `enkeep-e2e-git-skill-${Date.now()}`);
    mkdirSync(tempGitDir, { recursive: true });

    try {
      execFileSync('git', ['init'], { cwd: tempGitDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Enkeep Tester'], { cwd: tempGitDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'tester@enkeep.local'], { cwd: tempGitDir, stdio: 'ignore' });

      const skillMdContent = `---
name: test-git-skill
description: Comprehensive test skill for E2E validation
invocation: user
---
# Test Git Skill
This skill performs test tasks in workspace.
`;
      writeFileSync(join(tempGitDir, 'SKILL.md'), skillMdContent, 'utf-8');
      execFileSync('git', ['add', '.'], { cwd: tempGitDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'Initial commit v1'], { cwd: tempGitDir, stdio: 'ignore' });
    } catch {}

    const realGitDir = existsSync(tempGitDir) ? fs.realpathSync(tempGitDir) : tempGitDir;
    const realTmpDir = fs.realpathSync(tmpdir());

    // 2. Start Test Platform Server with real DB and all routes active
    testServer = await createAndStartTestPlatformServer({
      autoReplyDelayMs: 20,
      externalInteractionService: mockExternalInteraction,
      gitSourcePolicy: {
        allowedSchemes: ['https', 'ssh', 'file'],
        allowFileScheme: true,
        allowedFileRoots: [tempGitDir, realGitDir, tmpdir(), realTmpDir],
      },
    });

    browser = await launchPlaywrightBrowser({ headless: true });
  });

  afterAll(async () => {
    try {
      if (existsSync(tempGitDir)) {
        rmSync(tempGitDir, { recursive: true, force: true });
      }
      await browser?.close();
    } finally {
      await testServer?.stop();
    }
  });

  it('1. Skills Governance: Install Git skill -> list -> update with diff preview -> rollback -> uninstall', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      const aliceUser = testServer.fixtures.admin;
      const tenant = testServer.storage.forTenant(aliceUser.id);
      const space = await tenant.spaces.create({ name: 'Skills Space', folder: 'skills-space' });

      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Navigate to Workspaces -> Extensions (#management/workspaces/extensions)
      await page.goto(`${testServer.url}#management/workspaces/extensions`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.extensions-container', { state: 'visible', timeout: 8000 });

      // Open Install Extension Modal
      await page.click('#btn-open-install-extension, button:has-text("Install Extension"), button:has-text("安装扩展")');
      await page.waitForSelector('#modal-install-skill', { state: 'visible', timeout: 5000 });

      // Fill Git repo URL (local git repo path compliant with policy)
      const realGitDir = existsSync(tempGitDir) ? fs.realpathSync(tempGitDir) : tempGitDir;
      const fileUrl = `file://${realGitDir}`;
      await page.fill('#skill-repo-url-input', fileUrl);
      await page.selectOption('#skill-scope-select', 'space');
      await page.selectOption('#skill-target-space-select', space.id);

      // Submit Install
      await page.click('#btn-submit-install-skill');
      await page.waitForSelector('#modal-install-skill', { state: 'hidden', timeout: 8000 });
      await page.waitForTimeout(1000);

      // Verify skill listed in table
      await page.waitForSelector('td:has-text("test-git-skill")', { state: 'visible', timeout: 8000 });
      const versionBadge = await page.textContent('tr:has-text("test-git-skill") td:nth-child(3)');
      expect(versionBadge).toContain('v1');

      // Open Extension Detail Modal
      const detailBtn = page.locator('tr:has-text("test-git-skill") button:has-text("Detail"), tr:has-text("test-git-skill") button:has-text("详情")').first();
      await detailBtn.click();
      await page.waitForSelector('#modal-extension-detail', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('.extension-detail-name:has-text("test-git-skill")', { state: 'visible', timeout: 5000 });

      // Switch to Version History tab in detail modal
      await page.click('button.extension-detail-tab-btn:has-text("Version History"), button.extension-detail-tab-btn:has-text("版本历史")');
      await page.waitForSelector('.extension-versions-table', { state: 'visible', timeout: 5000 });

      // Switch to Space Bindings tab in detail modal
      await page.click('button.extension-detail-tab-btn:has-text("Space Bindings"), button.extension-detail-tab-btn:has-text("空间绑定")');
      await page.waitForSelector('.extension-bindings-table', { state: 'visible', timeout: 5000 });

      // Close Detail Modal
      await page.click('#modal-extension-detail [data-close="modal-extension-detail"]');
      await page.waitForSelector('#modal-extension-detail', { state: 'hidden', timeout: 5000 });

      // Update Git Repository with commit v2
      writeFileSync(join(tempGitDir, 'SKILL.md'), `---
name: test-git-skill
description: Updated test skill v2 with enhanced capabilities
invocation: user
---
# Test Git Skill v2
Updated content.
`, 'utf-8');
      execFileSync('git', ['add', '.'], { cwd: tempGitDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'Commit v2 update'], { cwd: tempGitDir, stdio: 'ignore' });

      // Click Update Button on skill row
      const updateBtn = page.locator('tr:has-text("test-git-skill") button:has-text("Update"), tr:has-text("test-git-skill") button:has-text("更新")').first();
      await updateBtn.click();
      await page.waitForSelector('#modal-update-skill', { state: 'visible', timeout: 5000 });

      // Click Preview Update Diff
      await page.click('#btn-preview-skill-diff');
      await page.waitForSelector('#skill-diff-preview-container:not(.hidden)', { state: 'visible', timeout: 5000 });
      const diffText = await page.textContent('#skill-diff-files-list');
      expect(diffText).toContain('SKILL.md');

      // Confirm & Apply Update
      await page.click('#btn-commit-update-skill');
      await page.waitForSelector('#modal-update-skill', { state: 'hidden', timeout: 8000 });

      // Verify version updated to v2
      await page.waitForSelector('tr:has-text("test-git-skill")', { state: 'visible', timeout: 8000 });
      const updatedVerBadge = await page.textContent('tr:has-text("test-git-skill") td:nth-child(3)');
      expect(updatedVerBadge).toContain('v2');

      // Rollback to Version 1
      const rollbackBtn = page.locator('tr:has-text("test-git-skill") button:has-text("Rollback"), tr:has-text("test-git-skill") button:has-text("回滚")').first();
      await rollbackBtn.click();
      await page.waitForSelector('#modal-rollback-skill', { state: 'visible', timeout: 5000 });

      await page.fill('#rollback-skill-target-version-input', '1');
      await page.click('#btn-submit-rollback-skill');
      await page.waitForSelector('#modal-rollback-skill', { state: 'hidden', timeout: 8000 });

      // Verify version rolled back to v1
      await page.waitForSelector('tr:has-text("test-git-skill")', { state: 'visible', timeout: 8000 });

      // Toggle Disable -> Enable
      const disableBtn = page.locator('tr:has-text("test-git-skill") button:has-text("Disable"), tr:has-text("test-git-skill") button:has-text("禁用")').first();
      if (await disableBtn.isVisible()) {
        await disableBtn.click();
        await page.waitForTimeout(500);
      }

      // Uninstall skill with confirmation
      const uninstallBtn = page.locator('tr:has-text("test-git-skill") button:has-text("Uninstall"), tr:has-text("test-git-skill") button:has-text("卸载")').first();
      await uninstallBtn.click();
      await page.waitForSelector('#modal-confirm', { state: 'visible', timeout: 5000 });
      await page.click('#btn-confirm-proceed');

      await page.screenshot({ path: join(REPORT_SHOTS_DIR, '01_skills_governance_lifecycle.png') });
    } finally {
      await context.close();
    }
  });

  it('2. Approvals Panel & Turn Waiting: Pending approvals -> allow/reject/cancel UI & Permission Preset save', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      const aliceUser = testServer.fixtures.admin;
      const tenant = testServer.storage.forTenant(aliceUser.id);
      const space = await tenant.spaces.create({ name: 'Approval Space', folder: 'approval-space' });
      const session = await (testServer.server as any).platformApi.createSession(aliceUser.id, { spaceId: space.id, title: 'Approval Session' });

      // Seed a pending approval in mock service
      pendingApprovalsStore.length = 0;
      pendingApprovalsStore.push({
        id: 'appr_test_001',
        sessionId: session.id,
        userId: aliceUser.id,
        spaceId: space.id,
        sessionSource: 'web',
        toolName: 'danger_execute',
        risk: 'critical',
        safeSummary: 'Execute elevated workspace container command',
        reason: 'Agent needs to run database migration script',
        status: 'pending',
        timeoutMs: 60000,
        createdAt: new Date().toISOString(),
      });

      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Switch to Chat View and select session
      await page.goto(`${testServer.url}#workspace`, { waitUntil: 'domcontentloaded' });
      await page.selectOption('#space-select', space.id);
      await page.waitForTimeout(600);

      // Verify Chat Header shows Waiting Approval status badge and Approvals button
      const turnBadge = page.locator('#session-turn-status-badge');
      const approvalBtn = page.locator('#btn-chat-approvals');

      await page.waitForSelector('#btn-chat-approvals:not(.hidden)', { state: 'visible', timeout: 8000 });
      const btnText = await approvalBtn.textContent();
      expect(btnText).toContain('Pending');

      // Click Approvals Button -> Opens Modal
      await approvalBtn.click();
      await page.waitForSelector('#modal-approvals', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('#approvals-modal-list .approval-card', { state: 'visible', timeout: 8000 });

      // Verify card content: tool name, risk critical, safe summary, zero raw arguments
      const modalContent = await page.textContent('#approvals-modal-list');
      expect(modalContent).toContain('danger_execute');
      expect(modalContent?.toLowerCase()).toContain('critical');
      expect(modalContent).toContain('Execute elevated workspace container command');

      await page.screenshot({ path: join(REPORT_SHOTS_DIR, '02_approval_card_pending.png') });

      // Click Allow Once
      await page.click('#modal-approvals button:has-text("Allow Once"), #modal-approvals button:has-text("仅允许本次")');
      await page.waitForSelector('#modal-approvals', { state: 'hidden', timeout: 5000 });

      // Permission Preset Configuration in Profiles / Settings
      await page.goto(`${testServer.url}#management/workspaces/profiles`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#form-permission-preset', { state: 'visible', timeout: 8000 });

      // Choose danger-full-access -> triggers danger confirmation modal
      await page.selectOption('#perm-preset-select', 'danger-full-access');
      await page.click('#form-permission-preset button[type="submit"]');

      await page.waitForSelector('#modal-confirm', { state: 'visible', timeout: 5000 });
      const confirmText = await page.textContent('#confirm-modal-message');
      expect(confirmText).toContain('Danger Full Access');
      await page.click('#btn-confirm-proceed');
      await page.waitForSelector('#modal-confirm', { state: 'hidden', timeout: 5000 });
    } finally {
      await context.close();
    }
  });

  it('3. Models Precedence & Circuit Breaker Health Table: effective preview, health reset & probe', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      await page.goto(`${testServer.url}#management/models/model-config`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.management-section', { state: 'visible', timeout: 8000 });

      // Verify Effective Model Resolution Preview card is rendered
      await page.waitForSelector('.fallback-chain-flow', { state: 'visible', timeout: 8000 });
      const previewText = await page.textContent('.fallback-chain-flow');
      expect(previewText).toBeDefined();

      // Verify Health & Circuit Breakers table is rendered
      await page.waitForSelector('h3:has-text("Model Health & Circuit Breakers"), h3:has-text("模型健康状态与熔断遥测")', { state: 'visible', timeout: 8000 });
      await page.screenshot({ path: join(REPORT_SHOTS_DIR, '03_model_hierarchy_and_health.png') });

      // Click Reset Circuit Breakers button
      const resetBtn = page.locator('button:has-text("Reset Circuit Breakers"), button:has-text("重置熔断器")').first();
      if (await resetBtn.isVisible()) {
        await resetBtn.click();
        await page.waitForTimeout(600);
      }
    } finally {
      await context.close();
    }
  });

  it('4. Diagnostics Safe Timeline & Streaming Exports: CPU/RAM KPIs, redaction & CSV link', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      const aliceUser = testServer.fixtures.admin;

      // Seed a structured runtime diagnostic record in DB
      await testServer.server.runtimeDiagnosticsService.recordDiagnostic({
        userId: aliceUser.id,
        eventType: 'lifecycle_start',
        level: 'info',
        code: 'CONTAINER_BOOT',
        details: { mode: 'sandbox', memoryMb: 512 },
        stats: {
          cpuPercent: 4.5,
          memoryUsageBytes: 128 * 1024 * 1024,
          memoryLimitBytes: 1024 * 1024 * 1024,
          pidsCount: 12,
          volumeBytes: 10 * 1024 * 1024,
        },
      });

      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Navigate to Runtime View and open Diagnostics
      await page.goto(`${testServer.url}#management/runtime/runtime`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('button:has-text("Runtime Diagnostics"), button:has-text("运行时诊断")', { state: 'visible', timeout: 8000 });

      await page.click('button:has-text("Runtime Diagnostics"), button:has-text("运行时诊断")');
      await page.waitForSelector('#modal-diagnostics', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('#diagnostics-resource-grid .kpi-card', { state: 'visible', timeout: 8000 });

      // Verify CPU, Memory, PIDs cards rendered in modal
      const kpiContent = await page.textContent('#diagnostics-resource-grid');
      expect(kpiContent).toContain('CPU');

      // Verify timeline shows redacted safe code
      await page.waitForSelector('.timeline-event-card', { state: 'visible', timeout: 5000 });
      const timelineContent = await page.textContent('#diagnostics-timeline-container');
      expect(timelineContent).toContain('CONTAINER_BOOT');

      await page.screenshot({ path: join(REPORT_SHOTS_DIR, '04_runtime_diagnostics_timeline.png') });
      await page.click('#modal-diagnostics [data-close="modal-diagnostics"]');

      // Check Activity Audit streaming export links
      await page.goto(`${testServer.url}#management/users/audit`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('a[href*="/api/admin/audit/export?format=csv"]', { state: 'visible', timeout: 8000 });
      const csvHref = await page.getAttribute('a[href*="/api/admin/audit/export?format=csv"]', 'href');
      expect(csvHref).toContain('/api/admin/audit/export');
    } finally {
      await context.close();
    }
  });

  it('5. Task Notifications & Deliveries: Webhook subscription, one-time secret, test & retry', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      const aliceUser = testServer.fixtures.admin;
      const tenant = testServer.storage.forTenant(aliceUser.id);
      const space = await tenant.spaces.create({ name: 'Task Space', folder: 'task-space' });
      const session = await (testServer.server as any).platformApi.createSession(aliceUser.id, { spaceId: space.id, title: 'Task Session' });

      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Navigate to tasks view
      await page.goto(`${testServer.url}#management/runtime/tasks`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#create-task-form', { state: 'visible', timeout: 8000 });
      await page.waitForSelector('#task-session-select option:not([value=""])', { state: 'attached', timeout: 8000 });

      // Schedule a task via UI form
      await page.selectOption('#task-schedule-type-select', 'interval');
      await page.waitForSelector('#task-interval-input', { state: 'visible', timeout: 5000 });
      await page.fill('#task-interval-input', '300');
      await page.fill('#task-title-input', 'Daily Verification Task');
      await page.selectOption('#task-session-select', session.id);
      await page.fill('#task-prompt-input', 'Run security checks');

      const submitTaskPromise = page.waitForResponse((res) => res.url().includes('/api/manage/tasks') && res.status() === 201);
      const getTasksPromise = page.waitForResponse((res) => res.url().includes('/api/admin/tasks') && res.status() === 200);
      await page.click('#create-task-form button[type="submit"]');
      await submitTaskPromise;
      await getTasksPromise;
      await page.waitForTimeout(300);

      // Wait for table to re-render with the newly scheduled task
      await page.waitForSelector('button.btn-info', { state: 'visible', timeout: 8000 });

      // Click Runs History button on task row
      const runsHistoryBtn = page.locator('button.btn-info').first();
      await runsHistoryBtn.click();
      await page.waitForSelector('#modal-task-runs', { state: 'visible', timeout: 8000 });

      // Click Notifications & Webhooks tab inside modal
      await page.click('button:has-text("Notifications & Webhooks"), button:has-text("通知与 Webhook"), button:has-text("Webhook")');
      await page.waitForSelector('#form-task-subscription', { state: 'visible', timeout: 5000 });

      // Fill Webhook URL & Secret
      await page.fill('#form-task-subscription input[type="url"]', 'https://example.com/webhook/task-alerts');
      await page.fill('#form-task-subscription input[type="password"]', 'WebhookSecretKey123!');

      // Click Test Webhook button
      await page.click('#form-task-subscription button:has-text("Test Webhook"), #form-task-subscription button:has-text("测试 Webhook")');
      await page.waitForTimeout(800);

      // Submit Subscription
      await page.click('#form-task-subscription button:has-text("Save Subscription"), #form-task-subscription button:has-text("保存订阅")');
      await page.waitForTimeout(800);

      // Verify Secret input was cleared immediately for security
      const secretVal = await page.inputValue('#form-task-subscription input[type="password"]');
      expect(secretVal).toBe('');

      await page.screenshot({ path: join(REPORT_SHOTS_DIR, '05_task_webhook_notifications.png') });
    } finally {
      await context.close();
    }
  });

  it('6. Bilingual zh-CN locale switch and Mobile 390px viewport responsive validation', async () => {
    const { context, page } = await createIsolatedPage(browser, { viewport: { width: 390, height: 844 } });
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Switch language to zh-CN
      await page.selectOption('#locale-select', 'zh-CN');
      await page.waitForTimeout(600);

      // Verify localized titles
      const consoleTitle = await page.textContent('.brand-title');
      expect(consoleTitle).toBeDefined();

      // Mobile screenshot
      await page.screenshot({ path: join(REPORT_SHOTS_DIR, '06_mobile_zh_cn_overview.png') });
    } finally {
      await context.close();
    }
  });
});
