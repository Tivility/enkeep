import { describe, it, expect } from 'vitest';
import {
  encodeWeChatClientVersion,
  resolveWeChatRedirectBaseUrl,
  startWeChatQrOnboarding,
  pollWeChatQrOnboarding,
  generateQrSvg,
  generateQrDataUrl,
} from '../src/onboarding/qr.js';

describe('WeChat QR Onboarding Protocol (F-01)', () => {
  it('encodes semver version to uint32 client version correctly', () => {
    // 1.0.0 => (1 << 16) | (0 << 8) | 0 = 65536
    expect(encodeWeChatClientVersion('1.0.0')).toBe(65536);
    // 2.3.4 => (2 << 16) | (3 << 8) | 4 = 131072 + 768 + 4 = 131844
    expect(encodeWeChatClientVersion('2.3.4')).toBe(131844);
  });

  describe('resolveWeChatRedirectBaseUrl security checks', () => {
    it('accepts qq.com and subdomains of qq.com with HTTPS', () => {
      expect(resolveWeChatRedirectBaseUrl('qq.com')).toBe('https://qq.com');
      expect(resolveWeChatRedirectBaseUrl('ilinkai.weixin.qq.com')).toBe('https://ilinkai.weixin.qq.com');
      expect(resolveWeChatRedirectBaseUrl('sz.weixin.qq.com')).toBe('https://sz.weixin.qq.com');
      expect(resolveWeChatRedirectBaseUrl('  sh.weixin.qq.com  ')).toBe('https://sh.weixin.qq.com');
    });

    it('rejects empty, non-qq.com, or malicious URLs and SSRF attempts', () => {
      expect(resolveWeChatRedirectBaseUrl(undefined)).toBeUndefined();
      expect(resolveWeChatRedirectBaseUrl('')).toBeUndefined();
      expect(resolveWeChatRedirectBaseUrl('attacker.com')).toBeUndefined();
      expect(resolveWeChatRedirectBaseUrl('notqq.com')).toBeUndefined();
      expect(resolveWeChatRedirectBaseUrl('fake-qq.com')).toBeUndefined();
      expect(resolveWeChatRedirectBaseUrl('qq.com.attacker.com')).toBeUndefined();
      expect(resolveWeChatRedirectBaseUrl('qq.com/path')).toBeUndefined();
      expect(resolveWeChatRedirectBaseUrl('user@qq.com')).toBeUndefined();
      expect(resolveWeChatRedirectBaseUrl('qq.com:8080')).toBeUndefined();
      expect(resolveWeChatRedirectBaseUrl('qq.com\\evil')).toBeUndefined();
    });
  });

  describe('generateQrSvg & generateQrDataUrl', () => {
    it('generates valid svg and data URL for payload', () => {
      const payload = 'weixin://qr/test_synth_payload_123';
      const svg = generateQrSvg(payload);
      expect(svg).toContain('<svg');
      expect(svg).toContain('</svg>');

      const dataUrl = generateQrDataUrl(payload);
      expect(dataUrl.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    });

    it('throws error for empty payload', () => {
      expect(() => generateQrSvg('')).toThrow('QR payload must be a non-empty string');
      expect(() => generateQrDataUrl('')).toThrow('QR payload must be a non-empty string');
    });
  });

  describe('startWeChatQrOnboarding', () => {
    it('calls get_bot_qrcode and returns qrcode and SVG/dataUrl', async () => {
      const mockFetch: typeof fetch = async (input, init) => {
        const urlStr = String(input);
        expect(urlStr).toContain('/ilink/bot/get_bot_qrcode?bot_type=3');
        expect(init?.method).toBe('POST');
        const headers = init?.headers as Record<string, string>;
        expect(headers['iLink-App-Id']).toBe('bot');

        const body = JSON.parse(String(init?.body));
        expect(Array.isArray(body.local_token_list)).toBe(true);

        return new Response(
          JSON.stringify({
            qrcode: 'synth_qr_code_xyz',
            qrcode_img_content: 'weixin://qr/synth_content_456',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const result = await startWeChatQrOnboarding({
        fetchImpl: mockFetch,
        localTokenList: ['token-1', 'token-2'],
      });

      expect(result.qrcode).toBe('synth_qr_code_xyz');
      expect(result.qrcodeImgContent).toBe('weixin://qr/synth_content_456');
      expect(result.qrSvg).toContain('<svg');
      expect(result.qrDataUrl.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    });

    it('throws on HTTP error or missing qrcode in response', async () => {
      const mockFetchFail: typeof fetch = async () => {
        return new Response('Internal Server Error', { status: 500 });
      };

      await expect(
        startWeChatQrOnboarding({ fetchImpl: mockFetchFail })
      ).rejects.toThrow('WeChat API get_bot_qrcode HTTP 500');

      const mockFetchNoQr: typeof fetch = async () => {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      await expect(
        startWeChatQrOnboarding({ fetchImpl: mockFetchNoQr })
      ).rejects.toThrow('WeChat QR response did not include qrcode');
    });
  });

  describe('pollWeChatQrOnboarding', () => {
    it('polls status correctly for various states', async () => {
      // 1. scaned_but_redirect
      const mockFetchRedirect: typeof fetch = async (input) => {
        expect(String(input)).toContain('/ilink/bot/get_qrcode_status?qrcode=test_qr');
        return new Response(
          JSON.stringify({
            status: 'scaned_but_redirect',
            redirect_host: 'sz.weixin.qq.com',
            baseurl: 'https://sz.weixin.qq.com',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const redirectRes = await pollWeChatQrOnboarding('test_qr', {
        fetchImpl: mockFetchRedirect,
      });
      expect(redirectRes.status).toBe('scaned_but_redirect');
      expect(redirectRes.redirectHost).toBe('sz.weixin.qq.com');
      expect(redirectRes.baseUrl).toBe('https://sz.weixin.qq.com');

      // 2. need_verifycode & submitting verifyCode
      const mockFetchVerify: typeof fetch = async (input) => {
        const url = new URL(String(input));
        expect(url.searchParams.get('qrcode')).toBe('test_qr');
        expect(url.searchParams.get('verify_code')).toBe('123456');
        return new Response(
          JSON.stringify({
            status: 'confirmed',
            bot_token: 'synth_tok_secret_999',
            ilink_bot_id: 'bot_synth_alice@im.wechat',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const verifyRes = await pollWeChatQrOnboarding('test_qr', {
        verifyCode: '123456',
        fetchImpl: mockFetchVerify,
      });
      expect(verifyRes.status).toBe('confirmed');
      expect(verifyRes.botToken).toBe('synth_tok_secret_999');
      expect(verifyRes.ilinkBotId).toBe('bot_synth_alice@im.wechat');

      // 3. binded_redirect
      const mockFetchBinded: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            status: 'binded_redirect',
            bot_token: 'synth_tok_existing',
            ilink_bot_id: 'bot_synth_bob',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const bindedRes = await pollWeChatQrOnboarding('test_qr', {
        fetchImpl: mockFetchBinded,
      });
      expect(bindedRes.status).toBe('binded_redirect');
      expect(bindedRes.alreadyConnected).toBe(true);

      // 4. expired
      const mockFetchExpired: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            status: 'expired',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const expiredRes = await pollWeChatQrOnboarding('test_qr', {
        fetchImpl: mockFetchExpired,
      });
      expect(expiredRes.status).toBe('expired');
    });
  });
});
