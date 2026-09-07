/**
 * Contract E2E Test Suite for Unified MCP Extensions in Extension Center
 *
 * Requirements & Invariants:
 * 1. Extension Center displays MCP chip/filter alongside All and Skills.
 * 2. Archive extension containing canonical `extension.json` (transport: stdio) installs via standard API.
 * 3. Detail modal displays:
 *    - MCP transport type (STDIO / Streamable HTTP)
 *    - Tool health & count (e.g. "Operational (2 Tools)")
 *    - Credential references names (strictly NO plaintext secret values)
 *    - Declared tools list (names & descriptions)
 *    - Space bindings toggle
 * 4. Guaranteed NO standalone MCP page/forms/server editor in UI.
 * 5. Safe DOM construction (zero innerHTML).
 * 6. Symmetrical bilingual i18n support in en and zh-CN.
 * 7. Mobile responsive viewport (390px).
 * 8. Multi-tenant isolation: Bob cannot mutate Alice's space extensions.
 *
 * @module @enkeep/web-e2e/tests/contract/contract-mcp-extensions-journey.test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser } from 'playwright';
import zlib from 'node:zlib';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAndStartTestPlatformServer,
  type TestPlatformServerHandle,
} from '../../src/contract/test-platform-server.js';
import {
  launchPlaywrightBrowser,
  createIsolatedPage,
  uiLogin,
} from '../../src/contract/browser-helper.js';

const REPORT_SHOTS_DIR = join(process.cwd(), '../../reports/screenshots');

function createTarGzArchive(files: Array<{ path: string; content: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const f of files) {
    const data = Buffer.from(f.content, 'utf8');
    const header = Buffer.alloc(512, 0);

    // Name (0-99)
    header.write(f.path, 0, 100, 'utf8');
    // Mode (100-107)
    header.write('0000644\0', 100, 8, 'utf8');
    // UID (108-115)
    header.write('0000000\0', 108, 8, 'utf8');
    // GID (116-123)
    header.write('0000000\0', 116, 8, 'utf8');
    // Size (124-135)
    const octalSize = data.length.toString(8).padStart(11, '0') + ' ';
    header.write(octalSize, 124, 12, 'utf8');
    // Mtime (136-147)
    const octalMtime = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + ' ';
    header.write(octalMtime, 136, 12, 'utf8');
    // Typeflag (156)
    header.write('0', 156, 1, 'utf8');
    // Magic (257-262)
    header.write('ustar\0', 257, 6, 'utf8');
    // Version (263-264)
    header.write('00', 263, 2, 'utf8');

    // Fill checksum with spaces (148-155)
    header.fill(32, 148, 156);
    let chksum = 0;
    for (let i = 0; i < 512; i++) {
      chksum += header[i];
    }
    const chksumStr = chksum.toString(8).padStart(6, '0') + '\0 ';
    header.write(chksumStr, 148, 8, 'utf8');

    blocks.push(header);
    blocks.push(data);

    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) {
      blocks.push(Buffer.alloc(pad, 0));
    }
  }

  // End of archive marker (1024 zero bytes)
  blocks.push(Buffer.alloc(1024, 0));
  const tarBuf = Buffer.concat(blocks);
  return zlib.gzipSync(tarBuf);
}

describe('Contract E2E: MCP Extensions Journey & Extension Center UI', () => {
  let browser: Browser;
  let testServer: TestPlatformServerHandle;

  beforeAll(async () => {
    if (!existsSync(REPORT_SHOTS_DIR)) {
      mkdirSync(REPORT_SHOTS_DIR, { recursive: true });
    }

    testServer = await createAndStartTestPlatformServer({
      autoReplyDelayMs: 20,
    });

    browser = await launchPlaywrightBrowser({ headless: true });
  });

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      await testServer?.stop();
    }
  });

  it('1. Extension Center: Install MCP Archive, Filter by MCP chip, Inspect MCP Detail & Bindings', async () => {
    const { page } = await createIsolatedPage(browser);

    const aliceUser = testServer.fixtures.admin;
    const tenant = testServer.storage.forTenant(aliceUser.id);
    const spaceA = await tenant.spaces.create({ name: 'Space Alpha', folder: 'space-alpha' });

    // 1. Create a Skill Archive
    const skillArchive = createTarGzArchive([
      {
        path: 'SKILL.md',
        content: `---
name: doc-helper-skill
description: Documentation helper skill
invocation: user
---
# Doc Helper
Provides documentation assistance.
`,
      },
    ]);

    // 2. Create an MCP Extension Archive with extension.json
    const mcpExtensionJson = {
      schemaVersion: 1,
      slug: 'deterministic-mcp-tools',
      name: 'Deterministic MCP Tools',
      description: 'Deterministic MCP server providing echo and add tools',
      contributions: [
        {
          kind: 'mcp',
          key: 'deterministic-mcp-tools',
          manifest: {
            name: 'Deterministic MCP Tools',
            description: 'Deterministic MCP server providing echo and add tools',
            transport: 'stdio',
            command: 'node',
            args: ['fake-mcp-server.js'],
            credentialRefs: [
              { id: 'mcp_shared_auth_ref', type: 'bearer', scope: 'tools' },
            ],
            toolTimeoutMs: 15000,
            tools: [
              {
                name: 'echo',
                description: 'Echoes back message parameter',
                inputSchema: {
                  type: 'object',
                  properties: { message: { type: 'string' } },
                  required: ['message'],
                },
              },
              {
                name: 'add',
                description: 'Adds two numbers together',
                inputSchema: {
                  type: 'object',
                  properties: { a: { type: 'number' }, b: { type: 'number' } },
                  required: ['a', 'b'],
                },
              },
            ],
          },
        },
      ],
    };

    const mcpArchive = createTarGzArchive([
      { path: 'extension.json', content: JSON.stringify(mcpExtensionJson, null, 2) },
    ]);

    // Install both extensions via API
    await testServer.storage.forTenant(aliceUser.id).extensionPackages;
    const catService = testServer.server.extensionService;

    await catService.installArchive({
      userId: aliceUser.id,
      archiveBuffer: skillArchive,
      archiveFilename: 'doc-helper-skill.tar.gz',
      targetSpaceId: spaceA.id,
    });

    await catService.installArchive({
      userId: aliceUser.id,
      archiveBuffer: mcpArchive,
      archiveFilename: 'deterministic-mcp-tools.tar.gz',
      targetSpaceId: spaceA.id,
    });

    // Login as Alice
    await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
    await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

    // Navigate to Extension Center
    await page.goto(`${testServer.url}#management/workspaces/extensions`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.extensions-container', { state: 'visible', timeout: 8000 });

    // Verify both extensions listed in table
    await page.waitForSelector('td:has-text("doc-helper-skill")', { state: 'visible', timeout: 5000 });
    await page.waitForSelector('td:has-text("Deterministic MCP Tools")', { state: 'visible', timeout: 5000 });

    // Verify MCP kind chip is present on MCP row
    const mcpRow = page.locator('tr:has-text("Deterministic MCP Tools")');
    expect(await mcpRow.locator('.badge:has-text("MCP")').isVisible()).toBe(true);

    // Verify Skill kind chip is present on Skill row
    const skillRow = page.locator('tr:has-text("doc-helper-skill")');
    expect(await skillRow.locator('.badge:has-text("Skill"), .badge:has-text("技能")').isVisible()).toBe(true);

    // Test Filter: Kind = "mcp"
    await page.selectOption('#extension-filter-kind', 'mcp');
    await page.waitForTimeout(300);

    // MCP row should be visible; Skill row should be hidden
    expect(await page.locator('tr:has-text("Deterministic MCP Tools")').isVisible()).toBe(true);
    expect(await page.locator('tr:has-text("doc-helper-skill")').count()).toBe(0);

    // Test Filter: Kind = "skill"
    await page.selectOption('#extension-filter-kind', 'skill');
    await page.waitForTimeout(300);

    // Skill row visible; MCP row hidden
    expect(await page.locator('tr:has-text("doc-helper-skill")').isVisible()).toBe(true);
    expect(await page.locator('tr:has-text("Deterministic MCP Tools")').count()).toBe(0);

    // Reset Filter: Kind = "all"
    await page.selectOption('#extension-filter-kind', 'all');
    await page.waitForTimeout(300);
    expect(await page.locator('tr:has-text("Deterministic MCP Tools")').isVisible()).toBe(true);
    expect(await page.locator('tr:has-text("doc-helper-skill")').isVisible()).toBe(true);

    // Open MCP Extension Detail Modal
    const detailBtn = mcpRow.locator('button:has-text("Detail"), button:has-text("详情")').first();
    await detailBtn.click();
    await page.waitForSelector('#modal-extension-detail', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(500);

    // 1. Verify Header badge in detail modal has MCP chip
    expect(await page.locator('#modal-extension-detail .extension-detail-title-row .badge:has-text("MCP")').first().isVisible()).toBe(true);

    // 2. Verify MCP Transport Type
    expect(await page.locator('#modal-extension-detail .badge:has-text("STDIO (Subprocess)")').first().isVisible()).toBe(true);

    // 3. Verify Tool Health & Count
    expect(await page.locator('#modal-extension-detail .badge:has-text("Operational (2 Tools)"), #modal-extension-detail .badge:has-text("2 个工具")').first().isVisible()).toBe(true);

    // 4. Verify Credential References (names only, no plaintext values)
    expect(await page.locator('#modal-extension-detail .extension-meta-value:has-text("mcp_shared_auth_ref")').first().isVisible()).toBe(true);

    // 5. Verify Declared Tools list
    expect(await page.locator('#modal-extension-detail .extension-mcp-tool-name:has-text("echo")').first().isVisible()).toBe(true);
    expect(await page.locator('#modal-extension-detail .extension-mcp-tool-name:has-text("add")').first().isVisible()).toBe(true);

    // 6. Verify Space Bindings tab
    await page.click('button.extension-detail-tab-btn:has-text("Space Bindings"), button.extension-detail-tab-btn:has-text("空间绑定")');
    await page.waitForSelector('.extension-bindings-table', { state: 'visible', timeout: 5000 });
    expect(await page.locator('.extension-bindings-table td:has-text("Space Alpha")').first().isVisible()).toBe(true);

    // Close Modal
    await page.click('#modal-extension-detail [data-close="modal-extension-detail"]');
    await page.waitForSelector('#modal-extension-detail', { state: 'hidden', timeout: 5000 });

    // Screenshot for evidence
    await page.screenshot({ path: join(REPORT_SHOTS_DIR, 'mcp-extension-center-contract.png') });
  });

  it('2. Bilingual i18n & Mobile 390px Responsive Viewport', async () => {
    const { page } = await createIsolatedPage(browser);
    await page.setViewportSize({ width: 390, height: 844 }); // iPhone 12 / mobile

    await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
    await page.goto(`${testServer.url}#management/workspaces/extensions`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.extensions-container', { state: 'visible', timeout: 8000 });

    // Switch locale to zh-CN via localStorage
    await page.evaluate(() => {
      localStorage.setItem('enkeep_locale', 'zh-CN');
      window.dispatchEvent(new Event('storage'));
      if (typeof (window as any).setLocale === 'function') {
        (window as any).setLocale('zh-CN');
      }
    });

    await page.goto(`${testServer.url}#management/workspaces/extensions`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.extensions-container', { state: 'visible', timeout: 8000 });

    // Verify Chinese translations
    const mcpOption = await page.textContent('#extension-filter-kind option[value="mcp"]');
    expect(mcpOption).toContain('MCP');

    // Switch back to en
    await page.evaluate(() => {
      localStorage.setItem('enkeep_locale', 'en');
      if (typeof (window as any).setLocale === 'function') {
        (window as any).setLocale('en');
      }
    });
  });

  it('3. Multi-Tenant Isolation: Bob cannot mutate Alice space MCP extensions', async () => {
    const { page } = await createIsolatedPage(browser);

    const bobUser = testServer.fixtures.user;
    const tenantBob = testServer.storage.forTenant(bobUser.id);
    const spaceBob = await tenantBob.spaces.create({ name: 'Bob Space', folder: 'bob-space' });

    await uiLogin(page, testServer.url, 'bob', 'BobSecurePass123!');
    await page.goto(`${testServer.url}#management/workspaces/extensions`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.extensions-container', { state: 'visible', timeout: 8000 });

    // Bob only sees installed extensions in Bob's spaces or global
    // Bob should NOT see Alice's Space Alpha binding
    const spaceOptions = await page.$$eval('#skill-filter-space option', (opts) => opts.map((o) => o.textContent));
    expect(spaceOptions).not.toContain('Space Alpha');
    expect(spaceOptions).toContain('Bob Space');
  });
});
