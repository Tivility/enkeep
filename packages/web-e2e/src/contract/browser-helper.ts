/**
 * Playwright Browser Helper and UI Action Utilities.
 *
 * Provides:
 * - Launching Chromium with user-friendly error messages if browser binary is missing
 * - BrowserContext isolation for multi-tenant and multi-user testing
 * - UI Automation actions for Web UI interactions
 */

import { chromium, type Browser, type BrowserContext, type Page, type LaunchOptions } from 'playwright';

export interface LaunchBrowserOptions extends LaunchOptions {
  headless?: boolean;
}

/**
 * Launches Chromium browser instance with helpful diagnostic message if not installed.
 */
export async function launchPlaywrightBrowser(options: LaunchBrowserOptions = {}): Promise<Browser> {
  try {
    const browser = await chromium.launch({
      headless: options.headless ?? true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
      ...options,
    });
    return browser;
  } catch (err: unknown) {
    const errorWithMsg = err as { message?: string };
    if (errorWithMsg?.message?.includes("Executable doesn't exist") || errorWithMsg?.message?.includes('playwright install')) {
      console.error('\n================================================================');
      console.error('[PLAYWRIGHT BROWSER MISSING ERROR]');
      console.error('Playwright Chromium browser binary was not found.');
      console.error('Please run:');
      console.error('  npx playwright install chromium');
      console.error('  or: pnpm exec playwright install chromium');
      console.error('================================================================\n');
    }
    throw err;
  }
}

/**
 * Creates a clean isolated browser context and page.
 */
export async function createIsolatedPage(
  browser: Browser,
  options: { viewport?: { width: number; height: number }; userAgent?: string } = {}
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 800 },
    userAgent: options.userAgent ?? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 EnkeepWebE2E',
  });
  const page = await context.newPage();
  page.on('console', (msg) => console.log(`[Browser Console ${msg.type()}]: ${msg.text()}`));
  page.on('pageerror', (err) => console.error(`[Browser Page Error]: ${err.stack || err.message}`));
  return { context, page };
}

/**
 * UI Action: Logs in a user through the Web UI form.
 */
export async function uiLogin(
  page: Page,
  serverUrl: string,
  username: string,
  password: string,
  options: { expectSuccess?: boolean } = {}
): Promise<void> {
  const expectSuccess = options.expectSuccess ?? true;
  await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });

  // Check if already authenticated via session cookie
  try {
    const isAppVisible = await page.waitForSelector('#app-view', { state: 'visible', timeout: 1000 });
    if (isAppVisible) {
      return;
    }
  } catch {
    // Not already logged in, proceed to fill form
  }

  await page.waitForSelector('#auth-view', { state: 'visible', timeout: 6000 });

  // Wait briefly for app.js init CSRF fetch to settle
  await page.waitForFunction(() => {
    const win = window as unknown as { state?: { csrfToken?: string } };
    return typeof win.state?.csrfToken === 'string' && win.state.csrfToken.length > 0;
  }, { timeout: 5000 }).catch(() => {});

  await page.fill('#login-username', username);
  await page.fill('#login-password', password);
  await page.click('#btn-login-submit');

  if (expectSuccess) {
    await page.waitForSelector('#app-view', { state: 'visible', timeout: 10000 });
  }
}

/**
 * UI Action: Logs out current user.
 */
export async function uiLogout(page: Page): Promise<void> {
  await page.waitForSelector('#btn-logout', { state: 'visible', timeout: 5000 });
  await page.click('#btn-logout');
  await page.waitForSelector('#auth-view', { state: 'visible', timeout: 5000 });
}

/**
 * UI Action: Creates a new space through the UI modal.
 */
export async function uiCreateSpace(
  page: Page,
  input: { name: string; folder?: string; executionMode?: 'container' | 'host'; confirmHost?: boolean }
): Promise<void> {
  await page.waitForSelector('#btn-new-space', { state: 'visible', timeout: 5000 });
  await page.click('#btn-new-space');

  await page.waitForSelector('#modal-space', { state: 'visible', timeout: 5000 });
  await page.fill('#space-name-input', input.name);

  // If space-folder-input exists in DOM, fill it
  const folderInput = await page.$('#space-folder-input');
  if (folderInput && input.folder) {
    await page.fill('#space-folder-input', input.folder);
  }

  if (input.executionMode && input.executionMode === 'host') {
    const execSelect = await page.$('#space-exec-mode-select');
    if (execSelect) {
      await page.selectOption('#space-exec-mode-select', 'host');
      if (input.confirmHost !== false) {
        await page.waitForSelector('#modal-confirm', { state: 'visible', timeout: 3000 }).catch(() => {});
        const confirmBtn = await page.$('#btn-confirm-proceed');
        if (confirmBtn) {
          await page.click('#btn-confirm-proceed');
        }
      }
    }
  }

  await page.click('#modal-space button[type="submit"]');
  await page.waitForSelector('#modal-space', { state: 'hidden', timeout: 5000 });
}

/**
 * UI Action: Creates a new session through the UI modal.
 */
export async function uiCreateSession(
  page: Page,
  input: { peerId?: string; spaceId?: string; title?: string } = {}
): Promise<void> {
  // Sync the target or current selected space into the modal select
  const currentSpaceVal = input.spaceId || await page.$eval(
    '#space-select',
    (el) => (el as HTMLSelectElement).value
  ).catch(() => '');

  await page.waitForSelector('#btn-new-session', { state: 'visible', timeout: 5000 });
  await page.click('#btn-new-session');

  await page.waitForSelector('#modal-session', { state: 'visible', timeout: 5000 });

  if (currentSpaceVal) {
    await page.selectOption('#session-space-select', currentSpaceVal).catch(() => {});
  }

  const titleVal = input.title || input.peerId;
  const titleInput = await page.$('#session-title-input');
  if (titleInput && titleVal) {
    await page.fill('#session-title-input', titleVal);
  }

  const peerInput = await page.$('#session-peer-input');
  if (peerInput && input.peerId) {
    await page.fill('#session-peer-input', input.peerId);
  }

  await page.click('#modal-session button[type="submit"]');
  await page.waitForSelector('#modal-session', { state: 'hidden', timeout: 5000 });
}

/**
 * UI Action: Sends a message in the active chat session.
 */
export async function uiSendMessage(page: Page, content: string): Promise<void> {
  await page.waitForSelector('#chat-input:not([disabled])', { state: 'visible', timeout: 8000 });
  await page.fill('#chat-input', content);
  await page.click('#btn-send-message');
}
