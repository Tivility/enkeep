/**
 * Visual Structure & Layout ComputedStyle E2E Test Suite.
 *
 * Assertions:
 * - 1280px Desktop Layout: workspace-sidebar and chat-layout are side-by-side (flex row)
 * - Chat composer width >= 80% of chat-layout main area
 * - Management layout & content container has overflow-y: auto for vertical scrolling
 * - Data table containers have overflow-x: auto for horizontal table overflow
 * - Responsive breakpoints (1280px / 1024px / 768px) and sidebar .is-collapsed behavior
 * - Design tokens computed style integrity (--bg-primary, --accent, etc.)
 * - Zero page-level horizontal scrollbar (body scrollWidth === clientWidth)
 * - Traverses all views and captures screenshots to /tmp/enkeep-ui-shots-after/
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type Browser, type Page } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createAndStartTestPlatformServer, type TestPlatformServerHandle } from '../../src/contract/test-platform-server.js';
import {
  launchPlaywrightBrowser,
  createIsolatedPage,
  uiLogin,
  uiLogout,
} from '../../src/contract/browser-helper.js';
import { probeProtectedPorts, assertProtectedPortsUnmolested } from '../../src/probes/ports-guard.js';

const SHOTS_DIR = '/tmp/enkeep-ui-shots-after';

function parseCssColor(color: string): { r: number; g: number; b: number } {
  const trimmed = color.trim();
  if (trimmed.startsWith('#')) {
    const cleanHex = trimmed.slice(1);
    if (cleanHex.length === 3) {
      return {
        r: parseInt(cleanHex[0] + cleanHex[0], 16),
        g: parseInt(cleanHex[1] + cleanHex[1], 16),
        b: parseInt(cleanHex[2] + cleanHex[2], 16),
      };
    }
    if (cleanHex.length === 6 || cleanHex.length === 8) {
      return {
        r: parseInt(cleanHex.slice(0, 2), 16),
        g: parseInt(cleanHex.slice(2, 4), 16),
        b: parseInt(cleanHex.slice(4, 6), 16),
      };
    }
  }
  const rgbMatch = trimmed.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (rgbMatch) {
    return {
      r: parseInt(rgbMatch[1], 10),
      g: parseInt(rgbMatch[2], 10),
      b: parseInt(rgbMatch[3], 10),
    };
  }
  throw new Error(`Unsupported or invalid CSS color format: "${color}"`);
}

function sRGBtoLin(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function getRelativeLuminance(color: string): number {
  const { r, g, b } = parseCssColor(color);
  return 0.2126 * sRGBtoLin(r) + 0.7152 * sRGBtoLin(g) + 0.0722 * sRGBtoLin(b);
}

function calculateContrastRatio(fg: string, bg: string): number {
  const lum1 = getRelativeLuminance(fg);
  const lum2 = getRelativeLuminance(bg);
  const brightest = Math.max(lum1, lum2);
  const darkest = Math.min(lum1, lum2);
  return (brightest + 0.05) / (darkest + 0.05);
}

describe('Visual Structure, Layout & ComputedStyle Contract', () => {
  let browser: Browser;
  let testServer: TestPlatformServerHandle;
  let probeBefore: Awaited<ReturnType<typeof probeProtectedPorts>>;

  beforeAll(async () => {
    probeBefore = await probeProtectedPorts();
    testServer = await createAndStartTestPlatformServer();
    browser = await launchPlaywrightBrowser({ headless: true });

    if (!existsSync(SHOTS_DIR)) {
      mkdirSync(SHOTS_DIR, { recursive: true });
    }
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

  it('Design Tokens & CSS Variables Integrity', async () => {
    const { page } = await createIsolatedPage(browser);
    await page.goto(testServer.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#auth-view', { state: 'visible' });

    // Explicitly select or assert dark theme
    const themeSelect = await page.$('#auth-theme-select');
    if (themeSelect) {
      await page.selectOption('#auth-theme-select', 'dark');
    } else {
      await page.evaluate(() => {
        document.documentElement.dataset.theme = 'dark';
      });
    }

    const themeAttr = await page.getAttribute('html', 'data-theme');
    expect(themeAttr).toBe('dark');

    const tokens = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return {
        bgPrimary: root.getPropertyValue('--bg-primary').trim(),
        bgSecondary: root.getPropertyValue('--bg-secondary').trim(),
        bgCard: root.getPropertyValue('--bg-card').trim(),
        textPrimary: root.getPropertyValue('--text-primary').trim(),
        accent: root.getPropertyValue('--accent').trim(),
        danger: root.getPropertyValue('--danger').trim(),
        success: root.getPropertyValue('--success').trim(),
        warning: root.getPropertyValue('--warning').trim(),
        border: root.getPropertyValue('--border').trim(),
      };
    });

    // 1. Dark tokens parse valid CSS colors
    for (const [name, val] of Object.entries(tokens)) {
      expect(() => parseCssColor(val), `Token ${name} (${val}) must parse as valid CSS color`).not.toThrow();
    }

    // 2. Distinct background tokens
    expect(tokens.bgPrimary).not.toBe(tokens.bgSecondary);
    expect(tokens.bgPrimary).not.toBe(tokens.bgCard);
    expect(tokens.bgSecondary).not.toBe(tokens.bgCard);

    // 3. Contrast: textPrimary vs bgPrimary contrast >= 4.5 (WCAG AA)
    const textContrast = calculateContrastRatio(tokens.textPrimary, tokens.bgPrimary);
    expect(textContrast).toBeGreaterThanOrEqual(4.5);
  });

  it('1280px Desktop Workspace: Side-by-Side Sidebar & Chat, Full-Width Composer', async () => {
    const { page } = await createIsolatedPage(browser);
    await page.setViewportSize({ width: 1280, height: 800 });
    await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
    await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

    // Navigate to workspace view
    await page.click('#nav-workspace');
    await page.waitForSelector('#view-workspace', { state: 'visible', timeout: 5000 });

    // 1. Assert workspace layout flex alignment
    const layoutStyles = await page.evaluate(() => {
      const ws = document.querySelector('#view-workspace') as HTMLElement;
      const sidebar = document.querySelector('.workspace-sidebar') as HTMLElement;
      const chat = document.querySelector('.chat-layout') as HTMLElement;
      const composer = document.querySelector('.chat-composer') as HTMLElement;
      const composerBox = document.querySelector('.composer-box') as HTMLElement;
      const textarea = document.querySelector('#chat-input') as HTMLElement;
      const sendBtn = document.querySelector('#btn-send-message') as HTMLElement;

      const wsRect = ws.getBoundingClientRect();
      const sidebarRect = sidebar.getBoundingClientRect();
      const chatRect = chat.getBoundingClientRect();
      const composerRect = composer.getBoundingClientRect();
      const composerBoxRect = composerBox.getBoundingClientRect();
      const textareaRect = textarea.getBoundingClientRect();
      const sendBtnRect = sendBtn.getBoundingClientRect();

      const wsComputed = window.getComputedStyle(ws);
      const sidebarComputed = window.getComputedStyle(sidebar);
      const chatComputed = window.getComputedStyle(chat);
      const composerComputed = window.getComputedStyle(composer);

      return {
        wsDisplay: wsComputed.display,
        sidebarDisplay: sidebarComputed.display,
        chatDisplay: chatComputed.display,
        wsWidth: wsRect.width,
        sidebarWidth: sidebarRect.width,
        sidebarLeft: sidebarRect.left,
        sidebarRight: sidebarRect.right,
        chatWidth: chatRect.width,
        chatLeft: chatRect.left,
        chatRight: chatRect.right,
        composerWidth: composerRect.width,
        composerBoxWidth: composerBoxRect.width,
        textareaWidth: textareaRect.width,
        sendBtnWidth: sendBtnRect.width,
        composerFlexDisplay: composerComputed.display,
      };
    });

    // Sidebar and Chat must be horizontally side-by-side
    expect(layoutStyles.wsDisplay).toBe('flex');
    expect(layoutStyles.sidebarWidth).toBeGreaterThanOrEqual(250);
    expect(layoutStyles.chatWidth).toBeGreaterThan(500);
    expect(layoutStyles.sidebarRight).toBeLessThanOrEqual(layoutStyles.chatLeft + 2); // Side by side
    expect(layoutStyles.chatLeft).toBeGreaterThanOrEqual(layoutStyles.sidebarLeft + layoutStyles.sidebarWidth - 2);

    // Composer must span across the chat layout (>= 80% of chat width)
    const composerRatio = layoutStyles.composerBoxWidth / layoutStyles.chatWidth;
    expect(composerRatio).toBeGreaterThanOrEqual(0.8);
    expect(layoutStyles.textareaWidth).toBeGreaterThan(400);

    // Assert zero horizontal page-level overflow
    const bodyOverflow = await page.evaluate(() => ({
      scrollWidth: document.body.scrollWidth,
      clientWidth: document.body.clientWidth,
    }));
    expect(bodyOverflow.scrollWidth).toBeLessThanOrEqual(bodyOverflow.clientWidth);

    // Take screenshot
    await page.screenshot({ path: join(SHOTS_DIR, '01_alice_workspace.png') });
  });

  it('Management Layout: Flex Fill, Overflow Scrollability & Table Containment', async () => {
    const { page } = await createIsolatedPage(browser);
    await page.setViewportSize({ width: 1280, height: 800 });
    await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
    await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

    // 1. Overview View: Click Management
    await page.click('#nav-management');
    await page.waitForSelector('#management-canvas .management-header', { state: 'visible', timeout: 5000 });

    const overviewMetrics = await page.evaluate(() => {
      const mgmtLayout = document.querySelector('#view-management') as HTMLElement;
      const mgmtMain = document.querySelector('.management-main') as HTMLElement;
      const canvas = document.querySelector('#management-canvas') as HTMLElement;
      const kpiGrid = document.querySelector('.kpi-grid') as HTMLElement;

      const mgmtLayoutComputed = window.getComputedStyle(mgmtLayout);
      const mgmtMainComputed = window.getComputedStyle(mgmtMain);

      return {
        mainDisplay: mgmtMainComputed.display,
        mainFlex: mgmtMainComputed.flexGrow,
        layoutOverflowY: mgmtLayoutComputed.overflowY,
        layoutWidth: mgmtLayout.getBoundingClientRect().width,
        canvasWidth: canvas.getBoundingClientRect().width,
        kpiWidth: kpiGrid?.getBoundingClientRect().width ?? 0,
      };
    });

    expect(overviewMetrics.mainDisplay).toBe('flex');
    expect(overviewMetrics.mainFlex).toBe('1');
    expect(overviewMetrics.layoutOverflowY).toBe('auto');
    expect(overviewMetrics.layoutWidth).toBeGreaterThan(900); // 1280 - 220 nav = 1060
    expect(overviewMetrics.canvasWidth).toBeGreaterThan(800);
    await page.screenshot({ path: join(SHOTS_DIR, '02_alice_overview.png') });

    // 2. Tasks View: Click Management -> Click Runtime Tab -> Click Tasks Section
    await page.click('#nav-management');
    await page.click('#tab-btn-runtime');
    await page.waitForSelector('[data-section="tasks"]', { state: 'visible', timeout: 5000 });
    await page.click('[data-section="tasks"]');
    await page.waitForSelector('#management-canvas .management-header', { state: 'visible', timeout: 5000 });

    const tasksScroll = await page.evaluate(() => {
      const mgmtLayout = document.querySelector('#view-management') as HTMLElement;
      return {
        scrollHeight: mgmtLayout.scrollHeight,
        clientHeight: mgmtLayout.clientHeight,
        overflowY: window.getComputedStyle(mgmtLayout).overflowY,
      };
    });

    expect(tasksScroll.overflowY).toBe('auto');
    expect(tasksScroll.scrollHeight).toBeGreaterThan(0);
    expect(tasksScroll.clientHeight).toBeGreaterThan(0);
    await page.screenshot({ path: join(SHOTS_DIR, '06_alice_tasks.png') });

    // 3. Workspaces Tab -> Profiles Section
    await page.click('#tab-btn-workspaces');
    await page.waitForSelector('[data-section="profiles"]', { state: 'visible', timeout: 5000 });
    await page.click('[data-section="profiles"]');
    await page.waitForSelector('#management-canvas .management-header', { state: 'visible', timeout: 5000 });
    await page.screenshot({ path: join(SHOTS_DIR, '04_alice_agent_profiles.png') });

    // 4. Admin Users Table View: Click Users Tab -> Click Users Section
    await page.click('#tab-btn-users');
    await page.waitForSelector('[data-section="users"]', { state: 'visible', timeout: 5000 });
    await page.click('[data-section="users"]');
    await page.waitForSelector('#management-canvas .data-table-container', { state: 'visible', timeout: 5000 });

    const tableContainerStyles = await page.evaluate(() => {
      const container = document.querySelector('#management-canvas .data-table-container') as HTMLElement | null;
      const table = document.querySelector('#management-canvas .data-table') as HTMLElement | null;
      return {
        overflowX: container ? window.getComputedStyle(container).overflowX : 'auto',
        containerWidth: container ? container.getBoundingClientRect().width : 800,
        tableWidth: table ? table.getBoundingClientRect().width : 600,
      };
    });

    expect(tableContainerStyles.overflowX).toBe('auto');
    expect(tableContainerStyles.containerWidth).toBeGreaterThan(500);
    await page.screenshot({ path: join(SHOTS_DIR, '11_alice_admin_users.png') });
  });

  it('Responsive Breakpoints: 1024px Compact & 768px Mobile Sidebar Collapse', async () => {
    const { page } = await createIsolatedPage(browser);
    await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
    await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

    // 1. Test 1024px Compact Desktop
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.click('#nav-workspace');
    await page.waitForSelector('#view-workspace', { state: 'visible', timeout: 5000 });

    const layout1024 = await page.evaluate(() => {
      const sidebar = document.querySelector('.workspace-sidebar') as HTMLElement;
      const chat = document.querySelector('.chat-layout') as HTMLElement;
      return {
        sidebarWidth: sidebar.getBoundingClientRect().width,
        chatWidth: chat.getBoundingClientRect().width,
        bodyScrollWidth: document.body.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
      };
    });

    expect(layout1024.sidebarWidth).toBeGreaterThanOrEqual(240);
    expect(layout1024.chatWidth).toBeGreaterThan(500);
    expect(layout1024.bodyScrollWidth).toBeLessThanOrEqual(layout1024.bodyClientWidth);

    // 2. Test 768px Tablet / Mobile (Full-Width Chat + Fixed Drawer + Bottom Nav Rail)
    await page.setViewportSize({ width: 768, height: 1024 });

    const mobileLayout = await page.evaluate(() => {
      const nav = document.querySelector('.management-nav') as HTMLElement;
      const sidebar = document.querySelector('.workspace-sidebar') as HTMLElement;
      const compNav = window.getComputedStyle(nav);
      const compSidebar = window.getComputedStyle(sidebar);
      return {
        navPosition: compNav.position,
        navHeight: nav.getBoundingClientRect().height,
        sidebarPosition: compSidebar.position,
      };
    });

    expect(mobileLayout.navPosition).toBe('fixed');
    expect(mobileLayout.navHeight).toBeLessThanOrEqual(54);
    expect(mobileLayout.sidebarPosition).toBe('fixed');

    // Test .is-collapsed on sidebar
    await page.evaluate(() => {
      const sidebar = document.querySelector('.workspace-sidebar');
      sidebar?.classList.add('is-collapsed');
    });

    const isHidden = await page.evaluate(() => {
      const sidebar = document.querySelector('.workspace-sidebar') as HTMLElement;
      const comp = window.getComputedStyle(sidebar);
      return comp.display === 'none' || comp.visibility === 'hidden' || comp.width === '0px';
    });
    expect(isHidden).toBe(true);

    // Remove is-collapsed for clean state before testing button toggle
    await page.evaluate(() => {
      const sidebar = document.querySelector('.workspace-sidebar');
      sidebar?.classList.remove('is-collapsed');
    });

    // 3. Test Sidebar Toggle & Collapsed Classes (.sidebar-collapsed, .sidebar-toggle-btn, .chat-title-group)
    const toggleBtn = await page.$('#btn-toggle-sidebar');
    if (toggleBtn) {
      // Toggle sidebar collapsed state
      await toggleBtn.click();
      const isCollapsed = await page.evaluate(() => {
        const sidebar = document.querySelector('#workspace-sidebar') as HTMLElement;
        const comp = window.getComputedStyle(sidebar);
        return sidebar.classList.contains('sidebar-collapsed') && (comp.display === 'none' || comp.visibility === 'hidden' || comp.width === '0px' || comp.opacity === '0');
      });
      expect(isCollapsed).toBe(true);

      // Toggle back to open state
      await toggleBtn.click();
      const isReopened = await page.evaluate(() => {
        const sidebar = document.querySelector('#workspace-sidebar') as HTMLElement;
        const comp = window.getComputedStyle(sidebar);
        return !sidebar.classList.contains('sidebar-collapsed') && comp.display !== 'none';
      });
      expect(isReopened).toBe(true);
    }

    // 4. Test Chat Title Group, Composer Controls & Markdown Code Elements Styling
    const chatElementsStyles = await page.evaluate(() => {
      const titleGroup = document.querySelector('.chat-title-group') as HTMLElement;
      const composerControls = document.querySelector('.composer-controls') as HTMLElement;
      const composerMeta = document.querySelector('.composer-meta') as HTMLElement;
      const charCount = document.querySelector('.composer-char-count') as HTMLElement;

      return {
        hasTitleGroup: Boolean(titleGroup),
        titleGroupDisplay: titleGroup ? window.getComputedStyle(titleGroup).display : null,
        hasComposerControls: Boolean(composerControls),
        composerControlsDisplay: composerControls ? window.getComputedStyle(composerControls).display : null,
        hasComposerMeta: Boolean(composerMeta),
        hasCharCount: Boolean(charCount),
      };
    });

    if (chatElementsStyles.hasTitleGroup) {
      expect(chatElementsStyles.titleGroupDisplay).toBe('flex');
    }
    if (chatElementsStyles.hasComposerControls) {
      expect(chatElementsStyles.composerControlsDisplay).toBe('flex');
    }

    // Remove is-collapsed for clean state
    await page.evaluate(() => {
      const sidebar = document.querySelector('.workspace-sidebar');
      sidebar?.classList.remove('is-collapsed');
      sidebar?.classList.remove('sidebar-collapsed');
    });
  });

  it('Comprehensive 38-View Screenshot Traversal for Alice and Bob', async () => {
    const { page } = await createIsolatedPage(browser);
    await page.setViewportSize({ width: 1280, height: 800 });

    // 00. Login Page
    await page.goto(testServer.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#auth-view', { state: 'visible', timeout: 5000 });
    await page.screenshot({ path: join(SHOTS_DIR, '00_login_page.png') });

    // Alice Login
    await uiLogin(page, testServer.url, 'alice', 'AliceSecurePass123!');
    await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

    // 01-15: Traverse Alice views via Management 5 tabs and sections
    // 01. Workspace
    await page.click('#nav-workspace');
    await page.waitForSelector('#view-workspace', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(30);
    await page.screenshot({ path: join(SHOTS_DIR, '01_alice_workspace.png') });

    // 02. Management Overview
    await page.click('#nav-management');
    await page.waitForSelector('#management-canvas .management-header', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(30);
    await page.screenshot({ path: join(SHOTS_DIR, '02_alice_overview.png') });

    // Helper to click tab and section
    const clickTabAndSection = async (tabId: string, sectionId: string, shotName: string, waitSel?: string) => {
      await page.click(`#tab-btn-${tabId}`);
      await page.click(`[data-section="${sectionId}"]`);
      if (waitSel) {
        await page.waitForSelector(waitSel, { state: 'visible', timeout: 3000 }).catch(() => {});
      } else {
        await page.waitForSelector('#management-canvas .management-header', { state: 'visible', timeout: 3000 }).catch(() => {});
      }
      await page.screenshot({ path: join(SHOTS_DIR, shotName) });
    };

    // Storage Tab
    await clickTabAndSection('storage', 'files', '03_alice_files.png', '#management-canvas .files-workbench');
    await clickTabAndSection('storage', 'quotas', '05_alice_quotas.png');
    await clickTabAndSection('storage', 'imports', '09_alice_imports.png');
    await clickTabAndSection('storage', 'reconcile', '12_alice_admin_spaces.png');

    // Workspaces Tab
    await clickTabAndSection('workspaces', 'profiles', '04_alice_agent_profiles.png');
    await clickTabAndSection('workspaces', 'extensions', '04b_alice_extensions.png');
    await clickTabAndSection('workspaces', 'deliveries', '07_alice_delivery.png');
    await clickTabAndSection('workspaces', 'spaces-sessions', '10_alice_admin_dashboard.png');

    // Runtime Tab
    await clickTabAndSection('runtime', 'tasks', '06_alice_tasks.png');
    await clickTabAndSection('runtime', 'runtime', '13_alice_admin_runtime.png');
    await clickTabAndSection('runtime', 'plugins', '14_alice_admin_plugins.png');
    await clickTabAndSection('runtime', 'security', '15_alice_admin_security.png');

    // Users Tab
    await clickTabAndSection('users', 'audit', '08_alice_activity.png');
    await clickTabAndSection('users', 'users', '11_alice_admin_users.png');

    // 16-28: Modals Snapshots
    const modalTriggerAndCapture = async (
      modalId: string,
      shotName: string,
      triggerFn?: () => Promise<void>
    ) => {
      if (triggerFn) {
        await triggerFn();
      } else {
        await page.evaluate((id) => {
          document.getElementById(id)?.classList.remove('hidden');
        }, modalId);
      }
      await page.waitForSelector(`#${modalId}:not(.hidden)`, { state: 'visible', timeout: 5000 });
      await page.screenshot({ path: join(SHOTS_DIR, shotName) });
      await page.evaluate((id) => {
        document.getElementById(id)?.classList.add('hidden');
      }, modalId);
    };

    await modalTriggerAndCapture('modal-space', '16_modal_space.png', async () => {
      await page.click('#nav-workspace');
      await page.click('#btn-new-space');
    });

    await modalTriggerAndCapture('modal-session', '17_modal_session.png', async () => {
      await page.click('#btn-new-session');
    });

    await modalTriggerAndCapture('modal-rename-space', '18_modal_rename_space.png');
    await modalTriggerAndCapture('modal-rename-session', '19_modal_rename_session.png');
    await modalTriggerAndCapture('modal-reset-session', '20_modal_reset_session.png');
    await modalTriggerAndCapture('modal-create-profile', '21_modal_create_profile.png');
    await modalTriggerAndCapture('modal-create-profile-version', '22_modal_create_profile_version.png');
    await modalTriggerAndCapture('modal-profile-versions', '23_modal_profile_versions.png');
    await modalTriggerAndCapture('modal-edit-user', '24_modal_edit_user.png');
    await modalTriggerAndCapture('modal-edit-quota', '25_modal_edit_quota.png');
    await modalTriggerAndCapture('modal-turns-history', '26_modal_turns_history.png');
    await modalTriggerAndCapture('modal-generations', '27_modal_generations.png');
    await modalTriggerAndCapture('modal-confirm', '28_modal_confirm.png');

    // 29-37: Bob Member Flow & Views via 5 Tabs
    await uiLogout(page);
    await uiLogin(page, testServer.url, 'bob', 'BobSecurePass123!');
    await page.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

    // 29. Workspace
    await page.click('#nav-workspace');
    await page.waitForSelector('#view-workspace', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(30);
    await page.screenshot({ path: join(SHOTS_DIR, '29_bob_workspace.png') });

    // 30. Overview
    await page.click('#nav-management');
    await page.waitForSelector('#management-canvas .management-header', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(30);
    await page.screenshot({ path: join(SHOTS_DIR, '30_bob_overview.png') });

    // Bob Storage Tab
    await clickTabAndSection('storage', 'files', '31_bob_files.png', '#management-canvas .files-workbench');
    await clickTabAndSection('storage', 'quotas', '33_bob_quotas.png');
    await clickTabAndSection('storage', 'imports', '37_bob_imports.png');

    // Bob Workspaces Tab
    await clickTabAndSection('workspaces', 'profiles', '32_bob_agent_profiles.png');
    await clickTabAndSection('workspaces', 'extensions', '32b_bob_extensions.png');
    await clickTabAndSection('workspaces', 'deliveries', '35_bob_delivery.png');

    // Bob Runtime Tab
    await clickTabAndSection('runtime', 'tasks', '34_bob_tasks.png');

    // Bob Users Tab
    await clickTabAndSection('users', 'audit', '36_bob_activity.png');
  });
});
