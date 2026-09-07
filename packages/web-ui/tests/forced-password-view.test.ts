import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { en, zhCN, setLocale, t, translateDom } from '../src/static/i18n.js';

describe('Web UI Forced Password Change View & i18n & a11y', () => {
  let htmlContent: string;
  let jsContent: string;

  beforeEach(() => {
    htmlContent = readFileSync(resolve(__dirname, '../src/static/index.html'), 'utf-8');
    jsContent = readFileSync(resolve(__dirname, '../src/static/app.js'), 'utf-8');
  });

  it('1. HTML includes dedicated non-closable #forced-password-view with required fields and a11y attributes', () => {
    expect(htmlContent).toContain('id="forced-password-view"');
    expect(htmlContent).toContain('role="region"');
    expect(htmlContent).toContain('aria-labelledby="forced-password-title"');

    // Input fields
    expect(htmlContent).toContain('id="forced-current-password"');
    expect(htmlContent).toContain('id="forced-new-password"');
    expect(htmlContent).toContain('id="forced-confirm-password"');
    expect(htmlContent).toContain('id="forced-password-locale-select"');
    expect(htmlContent).toContain('id="btn-forced-password-submit"');
    expect(htmlContent).toContain('id="btn-forced-password-logout"');

    // Required autocomplete and types
    expect(htmlContent).toContain('autocomplete="current-password"');
    expect(htmlContent).toContain('autocomplete="new-password"');
    expect(htmlContent).toContain('minlength="8"');
  });

  it('2. i18n dictionaries provide all required forcedPassword keys in both EN and ZH-CN', () => {
    const requiredKeys = [
      'forcedPassword.title',
      'forcedPassword.subtitle',
      'forcedPassword.currentPasswordLabel',
      'forcedPassword.currentPasswordPlaceholder',
      'forcedPassword.newPasswordLabel',
      'forcedPassword.newPasswordPlaceholder',
      'forcedPassword.confirmPasswordLabel',
      'forcedPassword.confirmPasswordPlaceholder',
      'forcedPassword.passwordHelp',
      'forcedPassword.passwordMismatch',
      'forcedPassword.passwordSameAsOld',
      'forcedPassword.passwordTooShort',
      'forcedPassword.submitButton',
      'forcedPassword.updating',
      'forcedPassword.success',
    ];

    for (const k of requiredKeys) {
      expect(en[k as keyof typeof en]).toBeDefined();
      expect(typeof en[k as keyof typeof en]).toBe('string');
      expect(en[k as keyof typeof en].length).toBeGreaterThan(0);

      expect(zhCN[k as keyof typeof zhCN]).toBeDefined();
      expect(typeof zhCN[k as keyof typeof zhCN]).toBe('string');
      expect(zhCN[k as keyof typeof zhCN].length).toBeGreaterThan(0);
    }
  });

  it('3. app.js contains showForcedPasswordView, handleForcedPasswordSubmit, and enforces password change lock on routing', () => {
    expect(jsContent).toContain('function showForcedPasswordView(');
    expect(jsContent).toContain('async function handleForcedPasswordSubmit(');
    expect(jsContent).toContain('mustChangePassword');

    // Verifies that routing checks mustChangePassword
    expect(jsContent).toContain('if (state.currentUser.mustChangePassword)');
  });
});
