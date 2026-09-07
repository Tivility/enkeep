/**
 * Contract E2E: Staged HappyClaw Migration UI Wizard & Integration Test
 *
 * Validates:
 * 1. Admin navigates to #management/storage/imports.
 * 2. 5-Step Wizard flow:
 *    - Step 1: Discovers staged SQLite databases, selects database, triggers inspect.
 *    - Step 2: Renders schema compatibility, counts, diagnostic issues, attachment notice banner, search filter, conversation checkboxes.
 *    - Step 3: Sets target user ID, runs Dry-Run Preview, inspects plan.
 *    - Step 4 & 5: Executes migration, displays real-time progress, transitions to Step 5.
 *    - Step 5: Shows success completion card with clickable links to imported Space/Session.
 * 3. Role isolation: Member Bob on #management/storage/imports sees only personal receipts and cannot see or call admin staged wizard.
 * 4. Locale switching: Instant switch between en and zh-CN updates all wizard controls accurately.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Browser } from 'playwright'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import {
  createAndStartTestPlatformServer,
  type TestPlatformServerHandle,
} from '../../src/contract/test-platform-server.js'
import {
  launchPlaywrightBrowser,
  createIsolatedPage,
  uiLogin,
  uiLogout,
} from '../../src/contract/browser-helper.js'
import { probeProtectedPorts, assertProtectedPortsUnmolested } from '../../src/probes/ports-guard.js'

function createTestStagedDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO router_state (key, value) VALUES ('schema_version', '64');

    CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      chat_jid TEXT,
      sender TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      attachments TEXT
    );
    CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, name TEXT, folder TEXT, execution_mode TEXT);

    INSERT INTO chats (jid, name, last_message_time) VALUES
      ('web:staged_space_1', 'Staged Project Space', '2026-08-01T12:01:00.000Z'),
      ('web:staged_space_2', 'Second Project Space', '2026-08-01T12:06:00.000Z');

    INSERT INTO registered_groups (jid, name, folder, execution_mode) VALUES
      ('web:staged_space_1', 'Staged Project Space', 'staged-space-1', 'container'),
      ('web:staged_space_2', 'Second Project Space', 'staged-space-2', 'container');

    INSERT INTO messages (id, chat_jid, sender, content, timestamp, is_from_me, attachments) VALUES
      ('m1', 'web:staged_space_1', 'alice', 'Hello from staged database', '2026-08-01T12:00:00.000Z', 0, NULL),
      ('m2', 'web:staged_space_1', 'assistant', 'I am here in the imported session.', '2026-08-01T12:01:00.000Z', 1, NULL),
      ('m3', 'web:staged_space_2', 'bob', 'Discussion in second space.', '2026-08-01T12:05:00.000Z', 0, '["spec.pdf"]'),
      ('m4', 'web:staged_space_2', 'assistant', 'Second space response.', '2026-08-01T12:06:00.000Z', 1, NULL);
  `)
  db.close()
}

describe('Contract E2E: Staged HappyClaw Migration UI Wizard', () => {
  let browser: Browser
  let testServer: TestPlatformServerHandle
  let probeBefore: Awaited<ReturnType<typeof probeProtectedPorts>>
  let tempDir: string
  let stagedDir: string

  beforeAll(async () => {
    probeBefore = await probeProtectedPorts()
    tempDir = path.join(tmpdir(), `enkeep-staged-e2e-${randomUUID()}`)
    stagedDir = path.join(tempDir, 'staged')
    fs.mkdirSync(stagedDir, { recursive: true })

    createTestStagedDb(path.join(stagedDir, 'messages.db'))

    testServer = await createAndStartTestPlatformServer({
      stagedImportsDir: stagedDir,
      allowlistedImportRoots: [stagedDir],
    })

    browser = await launchPlaywrightBrowser()
  })

  afterAll(async () => {
    if (browser) await browser.close()
    if (testServer) await testServer.stop()
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
    const probeAfter = await probeProtectedPorts()
    assertProtectedPortsUnmolested(probeBefore, probeAfter)
  })

  it('1. Admin uses 5-step wizard to inspect, dry-run, execute migration and click result session link', async () => {
    const { page, context } = await createIsolatedPage(browser)
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!')
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 })

      // Navigate to Storage -> Imports
      await page.click('#nav-management')
      await page.waitForSelector('#management-canvas .management-header', { state: 'visible', timeout: 5000 })
      await page.click('#tab-btn-storage')
      await page.click('[data-section="imports"]')
      await page.waitForSelector('.staged-wizard-container', { state: 'visible', timeout: 5000 })

      // Step 1: Select Database
      // Verify default Pilot V2 mode, then switch to Standard V1 for the 5-step HappyClaw migration flow
      const initialTitle = await page.textContent('.staged-wizard-title')
      expect(initialTitle).toContain('Migration Pilot V2')

      await page.click('button:has-text("Standard V1")')
      const wizardTitle = await page.textContent('.staged-wizard-title')
      expect(wizardTitle).toContain('HappyClaw')

      // Wait for staged DB item to appear
      await page.waitForSelector('.staged-db-item', { state: 'visible', timeout: 5000 })
      const dbItem = page.locator('.staged-db-item').first()
      await dbItem.click()

      // Click Next to Inspect
      const nextInspectBtn = page.locator('button:has-text("Next: Inspect Database")')
      await nextInspectBtn.click()

      // Step 2: Inspect & Filter
      await page.waitForSelector('.staged-schema-summary', { state: 'visible', timeout: 5000 })
      const schemaSummary = await page.textContent('.staged-schema-summary')
      expect(schemaSummary).toContain('Compatibility')

      // Verify Attachment Notice Banner (Requirement 4)
      const noticeText = await page.textContent('.staged-info-banner')
      expect(noticeText).toContain('Notice: Text transcripts')

      // Verify conversations table rendered with 2 items
      await page.waitForSelector('.data-table tbody tr', { state: 'visible', timeout: 5000 })
      const rows = await page.locator('.data-table tbody tr').count()
      expect(rows).toBe(2)

      // Click Next: Target & Dry-Run
      const nextTargetBtn = page.locator('#staged-step2-next')
      await nextTargetBtn.click()

      // Step 3: Target & Plan
      await page.waitForSelector('#staged-target-user', { state: 'visible', timeout: 5000 })
      const userInputVal = await page.inputValue('#staged-target-user')
      expect(userInputVal.length).toBeGreaterThan(0)

      // Run Dry-Run Preview
      const dryRunBtn = page.locator('button:has-text("Run Dry-Run Preview")')
      await dryRunBtn.click()

      await page.waitForSelector('#staged-dryrun-result .staged-info-banner', { state: 'visible', timeout: 5000 })
      const dryRunText = await page.textContent('#staged-dryrun-result')
      expect(dryRunText).toContain('Dry-Run Migration Plan')

      // Click Start Migration
      const startMigrateBtn = page.locator('button:has-text("Start Migration")')
      await startMigrateBtn.click()

      // Step 5: Completed
      await page.waitForSelector('.staged-success-card', { state: 'visible', timeout: 5000 })
      const successText = await page.textContent('.staged-success-card')
      expect(successText).toContain('Migration Completed Successfully')

      // Verify clickable link to imported session
      const sessionLinks = page.locator('.staged-session-link-item')
      const linkCount = await sessionLinks.count()
      expect(linkCount).toBeGreaterThanOrEqual(1)

      const firstLinkHref = await sessionLinks.first().getAttribute('href')
      expect(firstLinkHref).toContain('#space=')
      expect(firstLinkHref).toContain('session=')
    } finally {
      await context.close()
    }
  })

  it('2. Member (Bob) sees only personal import receipts and cannot see or call admin staged wizard', async () => {
    const { page, context } = await createIsolatedPage(browser)
    try {
      await uiLogin(page, testServer.url, 'bob', 'BobSecurePass123!')
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 })

      await page.click('#nav-management')
      await page.waitForSelector('#management-canvas .management-header', { state: 'visible', timeout: 5000 })
      await page.click('#tab-btn-storage')
      await page.click('[data-section="imports"]')
      await page.waitForSelector('#imports-history-container', { state: 'visible', timeout: 5000 })

      // Staged wizard must NOT be rendered for member
      const wizardEl = await page.locator('.staged-wizard-container').count()
      expect(wizardEl).toBe(0)

      // API direct call to /api/admin/imports/staged must return 403 Forbidden
      const res = await page.evaluate(async () => {
        const resp = await fetch('/api/admin/imports/staged')
        return { status: resp.status }
      })
      expect(res.status).toBe(403)
    } finally {
      await context.close()
    }
  })

  it('3. Instant locale switch updates all wizard elements to Chinese (zh-CN) seamlessly', async () => {
    const { page, context } = await createIsolatedPage(browser)
    try {
      await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!')
      await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 })

      await page.click('#nav-management')
      await page.waitForSelector('#management-canvas .management-header', { state: 'visible', timeout: 5000 })
      await page.click('#tab-btn-storage')
      await page.click('[data-section="imports"]')
      await page.waitForSelector('.staged-wizard-container', { state: 'visible', timeout: 5000 })

      // Switch locale to zh-CN via locale selector
      await page.selectOption('#locale-select', 'zh-CN')

      // Verify translated elements in default Pilot V2 mode
      await page.waitForSelector('.staged-wizard-title', { state: 'visible', timeout: 5000 })
      const wizardTitle = await page.textContent('.staged-wizard-title')
      expect(wizardTitle).toContain('迁移试点 V2')

      // Switch to Standard V1 mode and verify Chinese translation
      await page.click('button:has-text("标准 V1")')
      const wizardTitleV1 = await page.textContent('.staged-wizard-title')
      expect(wizardTitleV1).toContain('受控迁移向导')

      const refreshBtnText = await page.textContent('button:has-text("刷新暂存列表")')
      expect(refreshBtnText).toContain('刷新暂存列表')
    } finally {
      await context.close()
    }
  })
})
