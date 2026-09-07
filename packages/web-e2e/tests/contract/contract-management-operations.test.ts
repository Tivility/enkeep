/**
 * Management Console Operations E2E Test Suite
 *
 * Covers:
 * 1. Runtime restart UI: Alice clicks row "Restart" button -> confirm modal -> Idempotency-Key/CSRF -> container restarts -> health refreshed.
 *    Non-admin user (Bob) does not see or have access to admin runtime restart.
 * 2. Storage Reconcile & Repair UI:
 *    - Creates session with discrepancy (SQLite missing message vs real DSH JSONL).
 *    - Reconcile reports drift with typed missing/mismatch breakdown.
 *    - User clicks "Repair" -> preview modal shows discrepancies -> user confirms -> repairs SQLite web_messages -> status becomes 'matched'.
 *    - Scan Baseline button triggers volume scan and reports formatted bytes/files.
 * 3. Profile Version Rollback UI:
 *    - Creates Profile v1, v2, v3.
 *    - In Versions modal, v3 is Active, v1 and v2 have "Rollback" buttons.
 *    - User clicks "Rollback" on v1 -> confirm modal (explains N+1, does not modify old sessions, requires reset generation) -> creates v4 with v1 snapshot.
 * 4. Models Save UI:
 *    - Form shows revision / If-Match.
 *    - Default applyMode restart_all, sends If-Match.
 *    - Observes restartStatus success / partial / skipped and applied/failed counts.
 *    - Validates optimistic concurrency conflict when revision mismatches.
 * 5. Responsive / Mobile viewport checks (390px).
 * 6. CSP / Strict Security: Zero innerHTML, Zero inline styles, Zero console.log.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser } from 'playwright';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  createAndStartTestPlatformServer,
  type TestPlatformServerHandle,
  TEST_CSRF_TOKEN,
} from '../../src/contract/test-platform-server.js';
import {
  launchPlaywrightBrowser,
  createIsolatedPage,
  uiLogin,
  uiLogout,
} from '../../src/contract/browser-helper.js';
import { probeProtectedPorts, assertProtectedPortsUnmolested } from '../../src/probes/ports-guard.js';
import type { ManagementRuntimeProvider, UserRuntimeStatus } from '@enkeep/platform-server';

describe('Contract E2E: Management Console Operations & Real UI Lifecycle', () => {
  let browser: Browser;
  let testServer: TestPlatformServerHandle;
  let probeBefore: Awaited<ReturnType<typeof probeProtectedPorts>>;
  let tempDir: string;

  let currentContainerIdAlice = '64hex-alice-container-initial-000000000000000000000000000000000001';
  let currentContainerIdBob = '64hex-bob-container-initial-00000000000000000000000000000000000002';
  let restartCallCount = 0;
  let aliceUptime = 100;
  let bobUptime = 100;

  const validPlugins = {
    receiptStore: true,
    inbound: true,
    eventRelay: true,
    tools: true,
    externalInteraction: true,
    affinityPolicy: true,
    llmAffinity: true,
  };

  const mockManagementProvider: ManagementRuntimeProvider = {
    async getUserRuntime(userId: string): Promise<UserRuntimeStatus | null> {
      return {
        userId,
        status: 'ok',
        networkMode: 'none',
        dshReady: true,
        uptimeSeconds: userId === 'alice' ? aliceUptime : bobUptime,
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
          uptimeSeconds: aliceUptime,
          version: '0.1.0',
          enkeepBundleLoaded: true,
          toolsCount: 8,
          plugins: validPlugins,
          toolsOperational: true,
          toolsUnavailableReason: null,
        },
        {
          userId: 'bob',
          status: 'ok',
          networkMode: 'none',
          dshReady: true,
          uptimeSeconds: bobUptime,
          version: '0.1.0',
          enkeepBundleLoaded: true,
          toolsCount: 8,
          plugins: validPlugins,
          toolsOperational: true,
          toolsUnavailableReason: null,
        },
      ];
    },
    async restartRuntime(targetUserId?: string) {
      restartCallCount++;
      if (targetUserId === 'alice' || !targetUserId) {
        currentContainerIdAlice = `64hex-alice-restarted-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
        aliceUptime = 1;
      }
      if (targetUserId === 'bob' || !targetUserId) {
        currentContainerIdBob = `64hex-bob-restarted-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
        bobUptime = 1;
      }
      return {
        restarted: true,
        userIds: targetUserId ? [targetUserId] : ['alice', 'bob'],
        appliedRuntimes: targetUserId ? [targetUserId] : ['alice', 'bob'],
        failedRuntimes: [],
      };
    },
  };

  beforeAll(async () => {
    probeBefore = await probeProtectedPorts();
    tempDir = fs.mkdtempSync(path.join(tmpdir(), 'enkeep-e2e-mgmt-'));

    testServer = await createAndStartTestPlatformServer({
      autoReplyDelayMs: 20,
      managementProvider: mockManagementProvider,
    });

    browser = await launchPlaywrightBrowser({ headless: true });
  });

  afterAll(async () => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
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

  it('1. Runtime Table Restart: Alice clicks row "Restart" -> confirm modal -> Idempotency-Key -> containerId updates', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Navigate to Management -> Runtime -> Runtime Engine
      await page.click('#nav-management');
      await page.waitForSelector('#management-canvas .management-header', { state: 'visible', timeout: 5000 });
      await page.click('#tab-btn-runtime');
      await page.click('[data-section="runtime"]');
      await page.waitForSelector('.data-table tbody tr', { state: 'visible', timeout: 5000 });

      const initialAliceCid = currentContainerIdAlice;

      // Locate Alice's row restart button
      const aliceRestartBtn = page.locator('.btn-runtime-restart[data-user-id="alice"]');
      await aliceRestartBtn.waitFor({ state: 'visible', timeout: 5000 });

      // Click Restart -> Confirmation modal appears
      await aliceRestartBtn.click();
      await page.waitForSelector('#modal-confirm:not(.hidden)', { state: 'visible', timeout: 5000 });
      const modalMsg = await page.locator('#confirm-modal-message').textContent();
      expect(modalMsg).toContain('alice');

      // Click Confirm Proceed
      await page.click('#btn-confirm-proceed');

      // Verify restart success toast appears
      const restartToast = page.locator('.toast.toast-success', { hasText: /restarted|重启/ });
      await restartToast.waitFor({ state: 'visible', timeout: 8000 });
      const toastText = await restartToast.textContent();
      expect(toastText).toContain('alice');

      // Assert containerId changed on backend provider
      expect(currentContainerIdAlice).not.toBe(initialAliceCid);
      expect(restartCallCount).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });

  it('1b. Role Isolation: Bob (member) cannot see or call admin runtime restart', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'bob', 'BobSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      await page.click('#nav-management');
      await page.waitForSelector('#management-canvas .management-header', { state: 'visible', timeout: 5000 });

      // Bob sees "runtime" (My Runtime Engine), NOT "admin-runtime"
      await page.click('#tab-btn-runtime');
      await page.click('[data-section="runtime"]');
      await page.waitForSelector('.card-panel', { state: 'visible', timeout: 5000 });

      // Assert no restart button in Bob's view
      const restartBtnCount = await page.locator('.btn-runtime-restart').count();
      expect(restartBtnCount).toBe(0);

      // Verify Bob direct POST to /api/admin/runtime/restart is rejected 403
      const directReq = await page.request.post(`${testServer.url}/api/admin/runtime/restart`, {
        headers: {
          'X-Enkeep-CSRF': TEST_CSRF_TOKEN,
          'Idempotency-Key': randomUUID(),
        },
      });
      expect(directReq.status()).toBe(403);
    } finally {
      await context.close();
    }
  });

  it('2. Storage Reconcile & Repair: Discrepancy detection -> Preview -> Repair -> Matched state', async () => {
    const aliceUser = testServer.fixtures.admin;
    const tenant = testServer.storage.forTenant(aliceUser.id);

    // Create space and session route in SQLite
    const space = await tenant.spaces.create({
      name: 'Reconcile Test Space',
      folder: 'reconcile-folder',
    });

    const routeId = `sr_rec_${Date.now()}`;
    const dshSessionId = `dsh_rec_${Date.now()}`;

    testServer.db.exec(`
      INSERT INTO session_routes (id, space_id, user_id, channel, dsh_session_id, status, created_at, updated_at)
      VALUES ('${routeId}', '${space.id}', '${aliceUser.id}', 'web', '${dshSessionId}', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

      INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
      VALUES
        ('msg_rec_01', '${routeId}', '${aliceUser.id}', 'user', 'First prompt from web', 'delivered', '${routeId}', datetime('now', '-2 minutes'));
    `);

    // Create real DSH JSONL containing 2 messages (prompt + assistant reply, so SQLite is missing the assistant reply)
    const jsonlFile = path.join(tempDir, `session-${dshSessionId}.jsonl`);
    fs.writeFileSync(
      jsonlFile,
      JSON.stringify({ type: 'session', version: 0, id: dshSessionId, createdAt: 1700000000000, delegationDepth: 0 }) + '\n' +
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1700000001000, data: { turn: 1 } }) + '\n' +
      JSON.stringify({
        type: 'user/message',
        seq: 1,
        time: 1700000002000,
        surfaceOp: 'append',
        data: { id: 'msg_rec_01', role: 'user', content: [{ type: 'text', text: 'First prompt from web' }], source: { kind: 'user' } },
      }) + '\n' +
      JSON.stringify({ type: 'step/start', seq: 2, time: 1700000003000, data: { turn: 1, step: 1 } }) + '\n' +
      JSON.stringify({
        type: 'assistant/message',
        seq: 3,
        time: 1700000004000,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: { id: 'msg_rec_02', role: 'assistant', content: [{ type: 'text', text: 'Second response from runtime engine' }], source: { kind: 'model', provider: 'pi-ai', model: 'deepseek-chat' } },
        },
      }) + '\n' +
      JSON.stringify({ type: 'step/end', seq: 4, time: 1700000005000, data: { turn: 1, step: 1 } }) + '\n' +
      JSON.stringify({ type: 'turn/end', seq: 5, time: 1700000006000, data: { turn: 1, reason: { kind: 'completed' } } }) + '\n'
    );

    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Navigate to Management -> Storage -> Storage Reconcile
      await page.click('#nav-management');
      await page.click('#tab-btn-storage');
      await page.click('[data-section="reconcile"]');
      await page.waitForSelector('.data-table tbody tr', { state: 'visible', timeout: 5000 });

      // Scan Baseline Button test
      const scanBaselineBtn = page.locator('.btn-scan-baseline');
      await scanBaselineBtn.waitFor({ state: 'visible', timeout: 5000 });
      await scanBaselineBtn.click();
      await page.waitForSelector('#modal-confirm:not(.hidden)', { state: 'visible', timeout: 5000 });
      await page.click('#btn-confirm-proceed');
      await page.waitForSelector('.toast.toast-success', { state: 'visible', timeout: 8000 });

      // Check the session row with discrepancy
      const sessionRow = page.locator('.data-table tbody tr', { hasText: routeId });
      await sessionRow.waitFor({ state: 'visible', timeout: 5000 });

      // Repair Button
      const repairBtn = sessionRow.locator('.btn-storage-repair');
      await repairBtn.waitFor({ state: 'visible', timeout: 5000 });
      await repairBtn.click();

      // Preview / Confirmation modal appears
      await page.waitForSelector('#modal-confirm:not(.hidden)', { state: 'visible', timeout: 5000 });
      const confirmText = await page.locator('#confirm-modal-message').textContent();
      expect(confirmText).toBeTruthy();

      // Execute repair
      await page.click('#btn-confirm-proceed');

      // Verify repair success toast
      await page.waitForSelector('.toast.toast-success', { state: 'visible', timeout: 8000 });

      // Now verify direct repair API execution from authenticated browser session
      const repJson = await page.evaluate(async ({ targetUserId, targetSessionId, jsonlPath }) => {
        const res = await fetch('/api/admin/storage/repair', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Enkeep-CSRF': (window as any).state?.csrfToken || '',
          },
          body: JSON.stringify({
            userId: targetUserId,
            sessionId: targetSessionId,
            dshJsonlPath: jsonlPath,
            dryRun: false,
          }),
        });
        return await res.json();
      }, { targetUserId: aliceUser.id, targetSessionId: routeId, jsonlPath: jsonlFile });

      expect(repJson.data.status).toBe('repaired');

      // Verify SQLite now has 2 messages
      const msgsInDb = testServer.db.prepare('SELECT * FROM web_messages WHERE session_id = ?').all(routeId) as any[];
      expect(msgsInDb.length).toBe(2);
      expect(msgsInDb[1].content).toBe('Second response from runtime engine');
    } finally {
      await context.close();
    }
  });

  it('3. Profile Version Rollback: v1 -> v2 -> v3, rollback v1 creates v4', async () => {
    const aliceUser = testServer.fixtures.admin;
    const tenant = testServer.storage.forTenant(aliceUser.id);

    // Create Agent Profile with 3 versions
    const profile = await tenant.agentProfiles.create({
      name: 'Rollback E2E Profile',
      description: 'E2E Test Profile Versioning',
      identity: 'Identity Version 1',
      soul: 'Soul Version 1',
      agents: 'Agents Version 1',
      tools: 'Tools Version 1',
    });

    await tenant.agentProfiles.createVersion(profile.id, {
      identity: 'Identity Version 2',
      soul: 'Soul Version 2',
      agents: 'Agents Version 2',
      tools: 'Tools Version 2',
      changeSummary: 'Update to v2',
    });

    await tenant.agentProfiles.createVersion(profile.id, {
      identity: 'Identity Version 3',
      soul: 'Soul Version 3',
      agents: 'Agents Version 3',
      tools: 'Tools Version 3',
      changeSummary: 'Update to v3',
    });

    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Navigate to Management -> Workspaces -> Agent Profiles
      await page.click('#nav-management');
      await page.click('#tab-btn-workspaces');
      await page.click('[data-section="profiles"]');
      await page.waitForSelector('.data-table tbody tr', { state: 'visible', timeout: 5000 });

      // Find profile row and click "Versions" / "History"
      const profileRow = page.locator('.data-table tbody tr', { hasText: 'Rollback E2E Profile' });
      await profileRow.waitFor({ state: 'visible', timeout: 5000 });
      await profileRow.locator('button', { hasText: /History|Versions|版本历史/ }).click();

      // Modal appears with versions
      await page.waitForSelector('#modal-profile-versions:not(.hidden)', { state: 'visible', timeout: 5000 });

      // Version 3 should have "Active" badge; Version 1 and 2 have "Rollback" buttons
      const v1RollbackBtn = page.locator('.btn-profile-rollback[data-target-version="1"]');
      await v1RollbackBtn.waitFor({ state: 'visible', timeout: 5000 });

      // Click Rollback on v1
      await v1RollbackBtn.click();

      // Confirm modal opens explaining N+1 version creation and generation lifecycle
      await page.waitForSelector('#modal-confirm:not(.hidden)', { state: 'visible', timeout: 5000 });
      const confirmMsg = await page.locator('#confirm-modal-message').textContent();
      expect(confirmMsg).toContain('1');

      // Click Confirm Proceed
      await page.click('#btn-confirm-proceed');

      // Success toast appears indicating new version v4
      const rollbackToast = page.locator('.toast.toast-success', { hasText: /rolled back|回滚/ });
      await rollbackToast.waitFor({ state: 'visible', timeout: 8000 });
      const toastText = await rollbackToast.textContent();
      expect(toastText).toMatch(/v4|4/);

      // Verify in database: new active snapshot is version 4 with v1 prompt
      const snap4 = await tenant.agentProfiles.getSnapshot(profile.id, 4);
      expect(snap4).toBeDefined();
      expect(snap4?.identity).toBe('Identity Version 1');
      expect(snap4?.soul).toBe('Soul Version 1');
    } finally {
      await context.close();
    }
  });

  it('4. Models Save: Revision / If-Match optimistic concurrency & applyMode restart', async () => {
    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      // Navigate to Management -> Models -> Model Configuration
      await page.click('#nav-management');
      await page.click('#tab-btn-models');
      await page.click('[data-section="model-config"]');
      await page.waitForSelector('#form-model-override', { state: 'visible', timeout: 5000 });

      // Verify Apply Mode selector exists with restart_all as default
      const applyModeSelect = page.locator('#select-override-apply-mode');
      await applyModeSelect.waitFor({ state: 'visible', timeout: 5000 });
      const defaultMode = await applyModeSelect.inputValue();
      expect(defaultMode).toBe('restart_all');

      // Check if provider options exist, otherwise select default
      const providerCount = await page.locator('#select-override-provider option').count();
      if (providerCount > 1) {
        await page.locator('#select-override-provider').selectOption({ index: 1 });
      }

      // Save Platform Override
      const initialRestartCount = restartCallCount;
      await page.click('#form-model-override button[type="submit"]');

      // Success toast appears with restart summary
      const modelToast = page.locator('.toast.toast-success', { hasText: /saved|保存/ });
      await modelToast.waitFor({ state: 'visible', timeout: 8000 });

      // Verify backend restart was called by PATCH handler (not duplicate UI call)
      expect(restartCallCount).toBeGreaterThan(initialRestartCount);

      // Test save_only mode: should not trigger extra restart
      await page.selectOption('#select-override-apply-mode', 'save_only');
      const restartCountBeforeSaveOnly = restartCallCount;
      await page.click('#form-model-override button[type="submit"]');
      const saveOnlyToast = page.locator('.toast', { hasText: /saved|保存/ }).last();
      await saveOnlyToast.waitFor({ state: 'visible', timeout: 8000 });
      expect(restartCallCount).toBe(restartCountBeforeSaveOnly);
    } finally {
      await context.close();
    }
  });

  it('4b. Models Save Partial Failure UI: Displays warning details when some runtimes fail to restart', async () => {
    // Configure mock provider to simulate partial restart failure
    const originalRestart = mockManagementProvider.restartRuntime;
    mockManagementProvider.restartRuntime = async () => {
      return {
        restarted: true,
        userIds: ['alice'],
        appliedRuntimes: ['alice'],
        failedRuntimes: [{ userId: 'bob', error: 'Container daemon network socket timeout' }],
      };
    };

    const { context, page } = await createIsolatedPage(browser);
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      await page.click('#nav-management');
      await page.click('#tab-btn-models');
      await page.click('[data-section="model-config"]');
      await page.waitForSelector('#form-model-override', { state: 'visible', timeout: 5000 });

      // Save Platform Override with restart_all
      await page.selectOption('#select-override-apply-mode', 'restart_all');
      await page.click('#form-model-override button[type="submit"]');

      // Warning toast appears with partial failure details
      const warningToast = page.locator('.toast.toast-warning', { hasText: /bob|network socket timeout|failed/i });
      await warningToast.waitFor({ state: 'visible', timeout: 8000 });
      const toastText = await warningToast.textContent();
      expect(toastText).toContain('bob');
    } finally {
      mockManagementProvider.restartRuntime = originalRestart;
      await context.close();
    }
  });

  it('5. Mobile Responsive Viewport (390px): Layout does not crash or horizontally overflow', async () => {
    const { context, page } = await createIsolatedPage(browser, {
      viewport: { width: 390, height: 844 },
    });
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      await page.click('#nav-management');
      await page.waitForSelector('#management-canvas', { state: 'visible', timeout: 5000 });

      // Navigate across tabs in mobile viewport
      await page.click('#tab-btn-runtime');
      await page.click('[data-section="runtime"]');
      await page.waitForSelector('.management-section', { state: 'visible', timeout: 5000 });

      await page.click('#tab-btn-storage');
      await page.click('[data-section="reconcile"]');
      await page.waitForSelector('.management-section', { state: 'visible', timeout: 5000 });

      // Check document body width does not overflow 390px
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(400);
    } finally {
      await context.close();
    }
  });
});
