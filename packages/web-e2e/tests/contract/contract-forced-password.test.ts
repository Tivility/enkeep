import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser } from 'playwright';
import { createAndStartTestPlatformServer, type RunningTestServer } from '../../src/contract/test-platform-server.js';
import { launchPlaywrightBrowser, createIsolatedPage } from '../../src/contract/browser-helper.js';

describe('Contract E2E: Forced Password Change Browser Flow', () => {
  let ctx: RunningTestServer;
  let browser: Browser;

  beforeAll(async () => {
    ctx = await createAndStartTestPlatformServer({});
    browser = await launchPlaywrightBrowser({ headless: true });
  });

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
    if (ctx) {
      await ctx.stop();
    }
  });

  it('proves complete forced password change browser journey (temp login -> forced view -> validation -> submit -> enter workspace)', async () => {
    const { page, context } = await createIsolatedPage(browser);

    // 1. Create a new user with temporary password via Admin API
    const aliceLogin = await fetch(`${ctx.url}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': ctx.csrfToken,
        Origin: ctx.url,
      },
      body: JSON.stringify({
        username: 'alice',
        password: 'AliceSecurePass123!',
      }),
    });
    expect(aliceLogin.ok).toBe(true);
    const aliceCookie = aliceLogin.headers.get('set-cookie')!.split(';')[0]!;

    const createUserRes = await fetch(`${ctx.url}/api/admin/users`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': ctx.csrfToken,
        Origin: ctx.url,
      },
      body: JSON.stringify({
        username: 'david_temp',
        displayName: 'David Temporary',
        role: 'user',
      }),
    });
    expect(createUserRes.status).toBe(201);
    const createUserData = await createUserRes.json();
    const tempPassword = createUserData.data.tempPassword;
    expect(typeof tempPassword).toBe('string');

    // 2. Open login page in browser
    await page.goto(ctx.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#auth-view:not(.hidden)');

    // 3. Login with David's temporary password
    await page.fill('#login-username', 'david_temp');
    await page.fill('#login-password', tempPassword);
    await page.click('#btn-login-submit');

    // 4. Assert: Forced password change screen is shown, App workspace is hidden
    await page.waitForSelector('#forced-password-view:not(.hidden)');
    const appViewHidden = await page.$eval('#app-view', (el) => el.classList.contains('hidden'));
    expect(appViewHidden).toBe(true);

    // 5. Test i18n switching on forced password screen (EN -> ZH-CN)
    await page.selectOption('#forced-password-locale-select', 'zh-CN');
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');

    const titleZh = await page.textContent('#forced-password-title');
    expect(titleZh).toContain('需要修改密码');

    // Switch back to EN
    await page.selectOption('#forced-password-locale-select', 'en');
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    const titleEn = await page.textContent('#forced-password-title');
    expect(titleEn).toContain('Password Change Required');

    // 6. Test password mismatch validation error toast
    await page.fill('#forced-current-password', tempPassword);
    await page.fill('#forced-new-password', 'PermanentDavidPass123!');
    await page.fill('#forced-confirm-password', 'DifferentPass123!');
    await page.click('#btn-forced-password-submit');

    await page.waitForSelector('.toast.toast-error');
    const errorToast = await page.textContent('.toast.toast-error');
    expect(errorToast).toContain('do not match');

    // 7. Submit valid permanent password
    await page.fill('#forced-current-password', tempPassword);
    await page.fill('#forced-new-password', 'PermanentDavidPass123!');
    await page.fill('#forced-confirm-password', 'PermanentDavidPass123!');
    await page.click('#btn-forced-password-submit');

    // 8. Assert: Forced view is hidden and App workspace is visible
    await page.waitForSelector('#app-view:not(.hidden)');
    const forcedHidden = await page.$eval('#forced-password-view', (el) => el.classList.contains('hidden'));
    expect(forcedHidden).toBe(true);

    // Verify user display name is David
    const displayName = await page.textContent('#user-display-name');
    expect(displayName).toContain('David');

    // 9. Verify that user is now in workspace and can interact with spaces/chat
    await page.waitForSelector('#view-workspace:not(.hidden)');
    await context.close();
  });
});
