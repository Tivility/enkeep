/**
 * Focused Contract & Interaction Tests for WeChat QR Onboarding UI (F-04)
 *
 * Verifies:
 * 1. Toolbar action button for "WeChat QR Onboarding" and Rebind button on WeChat accounts
 * 2. i18n translation keys in en & zh-CN catalogs
 * 3. openChannelOnboardingModal with channel === 'wechat' (workspace select only, hides appId/appName)
 * 4. Job status rendering (waiting_for_scan, need_verifycode, configuring, verifying, ready, expired)
 * 5. WeChat verification code submission section and /verify endpoint integration
 * 6. Zero inline styles, zero innerHTML, zero console logging
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWebUiAsset } from '../src/index.js';
import { en, zhCN, catalogs, SUPPORTED_LOCALES } from '../src/static/i18n.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('WeChat QR Onboarding UI Contract (F-04)', () => {
  const appJsAsset = getWebUiAsset('app.js');
  const appJs = appJsAsset.content.toString('utf-8');
  const cssAsset = getWebUiAsset('style.css');
  const cssCode = cssAsset.content.toString('utf-8');

  describe('1. Internationalization (i18n) Contract', () => {
    it('defines all required WeChat QR onboarding keys in en and zh-CN catalogs', () => {
      expect(SUPPORTED_LOCALES).toContain('en');
      expect(SUPPORTED_LOCALES).toContain('zh-CN');

      const enCat = catalogs['en'] || en;
      const zhCat = catalogs['zh-CN'] || zhCN;

      // English
      expect(enCat['channels.btnWeChatScan']).toBe('WeChat QR Onboarding');
      expect(enCat['channels.btnSubmitVerifyCode']).toBe('Submit Code');
      expect(enCat['channels.onboardingModalTitleWeChat']).toBe('WeChat QR Integration');
      expect(enCat['channels.wechatVerifyCodeTitle']).toBe('Enter WeChat Verification Code');
      expect(enCat['channels.wechatVerifyCodeDesc']).toContain('WeChat requires secondary confirmation');
      expect(enCat['channels.wechatVerifyCodePlaceholder']).toBe('Enter numeric code');
      expect(enCat['channels.wechatScanPrompt']).toContain('Please scan with WeChat App');
      expect(enCat['channels.wechatReadyAlert']).toContain('WeChat Bot onboarding successful');

      // Chinese
      expect(zhCat['channels.btnWeChatScan']).toBe('微信扫码接入');
      expect(zhCat['channels.btnSubmitVerifyCode']).toBe('提交验证码');
      expect(zhCat['channels.onboardingModalTitleWeChat']).toBe('微信扫码接入');
      expect(zhCat['channels.wechatVerifyCodeTitle']).toBe('输入微信验证码');
      expect(zhCat['channels.wechatVerifyCodeDesc']).toContain('微信可能要求二次确认');
      expect(zhCat['channels.wechatVerifyCodePlaceholder']).toBe('输入数字验证码');
      expect(zhCat['channels.wechatScanPrompt']).toContain('请使用微信扫描二维码');
      expect(zhCat['channels.wechatReadyAlert']).toContain('微信机器人接入完成');
    });

    it('contains WeChat onboarding i18n keys inside app.js dictionaries', () => {
      expect(appJs).toContain("'channels.btnWeChatScan': 'WeChat QR Onboarding'");
      expect(appJs).toContain("'channels.btnWeChatScan': '微信扫码接入'");
      expect(appJs).toContain("'channels.btnSubmitVerifyCode': 'Submit Code'");
      expect(appJs).toContain("'channels.btnSubmitVerifyCode': '提交验证码'");
      expect(appJs).toContain("'channels.wechatVerifyCodeTitle': 'Enter WeChat Verification Code'");
      expect(appJs).toContain("'channels.wechatVerifyCodeTitle': '输入微信验证码'");
    });
  });

  describe('2. WeChat QR Onboarding Logic & Form Rendering', () => {
    it('supports channel parameter in openChannelOnboardingModal defaulting to lark', () => {
      expect(appJs).toContain("function openChannelOnboardingModal(action, accounts = [], spaces = [], initialAccountId = null, channel = 'lark')");
      expect(appJs).toContain("const isWeChat = channel === 'wechat'");
    });

    it('hides appId/appName inputs when onboarding WeChat and only prompts workspace selector', () => {
      expect(appJs).toContain('if (!isWeChat) {');
      expect(appJs).toContain("const wechatAccounts = accounts.filter((a) => a.type === 'wechat');");
      expect(appJs).toContain("opt.textContent = `${a.name || (getLocale() === 'zh-CN' ? '微信账号' : 'WeChat Account')} (${a.id.slice(-6)})`");
    });

    it('passes channel: wechat in payload when starting onboarding job', () => {
      expect(appJs).toContain('const payload = {');
      expect(appJs).toContain('channel,');
      expect(appJs).toContain("apiRequest('/api/manage/channels/onboarding/jobs'");
    });

    it('renders WeChat specific QR prompt and title', () => {
      expect(appJs).toContain("const isWeChatJob = currentJob.channel === 'wechat' || isWeChat;");
      expect(appJs).toContain("qrImg.alt = isWeChatJob ? 'WeChat QR Code' : 'Feishu QR Code';");
      expect(appJs).toContain("channels.wechatScanPrompt");
      expect(appJs).toContain("channels.wechatReadyAlert");
    });

    it('renders verification code input and submits to /jobs/:id/verify when need_verifycode is received', () => {
      expect(appJs).toContain('channel-verify-section');
      expect(appJs).toContain('channel-wechat-verify-input');
      expect(appJs).toContain("if (currentJob.status === 'need_verifycode')");
      expect(appJs).toContain('/verify');
      expect(appJs).toContain('/^\\d{1,12}$/');
    });

    it('includes need_verifycode in cancellableStatuses for controller cleanup', () => {
      expect(appJs).toContain("const cancellableStatuses = ['waiting_for_scan', 'need_verifycode', 'configuring', 'verifying', 'waiting', 'pending'];");
    });
  });

  describe('3. Channels Management Toolbar & Account Card Actions', () => {
    it('renders WeChat QR Onboarding button in toolbar', () => {
      expect(appJs).toContain('btnWeChatScan');
      expect(appJs).toContain("openChannelOnboardingModal('create_new', accounts, spaces, null, 'wechat')");
    });

    it('renders Rebind button for WeChat account cards', () => {
      expect(appJs).toContain("else if (acc.type === \"wechat\")");
      expect(appJs).toContain("channel-rebind-acc-btn");
      expect(appJs).toContain("openChannelOnboardingModal('configure_existing', accounts, spaces, acc.id, 'wechat')");
    });
  });

  describe('4. CSS & Code Safety Invariants', () => {
    it('defines styles for channel verify section in style.css', () => {
      expect(cssCode).toContain('.channel-verify-section');
      expect(cssCode).toContain('.channel-verify-title');
      expect(cssCode).toContain('.channel-verify-desc');
      expect(cssCode).toContain('.channel-verify-input-row');
    });

    it('strictly satisfies zero inline styles, zero innerHTML, and zero console logs in app.js', () => {
      expect(appJs).not.toContain('.style.');
      expect(appJs).not.toContain('.style =');
      expect(appJs).not.toContain('innerHTML =');
      expect(appJs).not.toContain('console.log(');
    });
  });
});
