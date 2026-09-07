/**
 * SSRF Security and Network Guard Tests
 *
 * Verifies that:
 * - Forbidden URL schemes (file:, data:, javascript:, blob:, ws:, etc.) are rejected
 * - Direct private IPv4 and IPv6 addresses are blocked
 * - Cloud metadata endpoints (169.254.169.254, 100.100.100.200) are blocked
 * - Localhost and internal hostnames (.internal, .local) are blocked
 * - DNS pre-resolution blocks hostnames resolving to private IPs
 * - Playwright route interception blocks redirects to private IPs
 * - URL and credential sanitization removes passwords and sensitive query params
 * - Explicit allowlist enforcement works
 *
 * @module @enkeep/platform-service-browser/tests/ssrf-security.test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  isPrivateIPv4,
  isPrivateIPv6,
  validateBrowserTargetUrl,
  sanitizeUrl,
  getCleanOriginAndPath,
  BrowserErrorCode,
  BrowserServiceError,
  createBrowserService,
} from '../src/index.js';
import { createTestHttpServer, type TestHttpServer } from './fixtures/test-http-server.js';

describe('SSRF Guard and Network Security Tests', () => {
  let server: TestHttpServer;

  beforeAll(async () => {
    server = await createTestHttpServer();
  });

  afterAll(async () => {
    await server.close();
  });

  describe('isPrivateIPv4', () => {
    it('correctly classifies private, loopback, link-local, and reserved IPv4 ranges', () => {
      // Loopback
      expect(isPrivateIPv4('127.0.0.1')).toBe(true);
      expect(isPrivateIPv4('127.255.255.254')).toBe(true);

      // RFC 1918 Private ranges
      expect(isPrivateIPv4('10.0.0.1')).toBe(true);
      expect(isPrivateIPv4('10.254.0.1')).toBe(true);
      expect(isPrivateIPv4('172.16.0.1')).toBe(true);
      expect(isPrivateIPv4('172.31.255.255')).toBe(true);
      expect(isPrivateIPv4('192.168.0.1')).toBe(true);
      expect(isPrivateIPv4('192.168.1.254')).toBe(true);

      // Link-local & Cloud Metadata (169.254.0.0/16)
      expect(isPrivateIPv4('169.254.169.254')).toBe(true);
      expect(isPrivateIPv4('169.254.1.1')).toBe(true);

      // Carrier-grade NAT (100.64.0.0/10) & Alibaba Metadata (100.100.100.200)
      expect(isPrivateIPv4('100.64.0.1')).toBe(true);
      expect(isPrivateIPv4('100.100.100.200')).toBe(true);

      // Current network (0.0.0.0/8) & Multicast (224.0.0.0/4)
      expect(isPrivateIPv4('0.0.0.0')).toBe(true);
      expect(isPrivateIPv4('224.0.0.1')).toBe(true);
      expect(isPrivateIPv4('255.255.255.255')).toBe(true);

      // Public IPs (should be allowed)
      expect(isPrivateIPv4('8.8.8.8')).toBe(false);
      expect(isPrivateIPv4('1.1.1.1')).toBe(false);
      expect(isPrivateIPv4('93.184.216.34')).toBe(false); // example.com
      expect(isPrivateIPv4('172.15.0.1')).toBe(false); // Outside 172.16-31
      expect(isPrivateIPv4('172.32.0.1')).toBe(false);
    });

    it('fails closed on invalid IPv4 strings', () => {
      expect(isPrivateIPv4('not-an-ip')).toBe(true);
      expect(isPrivateIPv4('999.999.999.999')).toBe(true);
      expect(isPrivateIPv4('1.2.3')).toBe(true);
      expect(isPrivateIPv4('')).toBe(true);
    });
  });

  describe('isPrivateIPv6', () => {
    it('correctly classifies private, loopback, and link-local IPv6 ranges', () => {
      // Loopback
      expect(isPrivateIPv6('::1')).toBe(true);
      expect(isPrivateIPv6('0:0:0:0:0:0:0:1')).toBe(true);

      // Unspecified
      expect(isPrivateIPv6('::')).toBe(true);
      expect(isPrivateIPv6('0:0:0:0:0:0:0:0')).toBe(true);

      // Link-local (fe80::/10)
      expect(isPrivateIPv6('fe80::1')).toBe(true);
      expect(isPrivateIPv6('fe80::abcd:1234')).toBe(true);

      // Unique local (fc00::/7)
      expect(isPrivateIPv6('fc00::1')).toBe(true);
      expect(isPrivateIPv6('fd12:3456:789a::1')).toBe(true);

      // IPv4-mapped IPv6
      expect(isPrivateIPv6('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateIPv6('::ffff:10.0.0.1')).toBe(true);
      expect(isPrivateIPv6('::ffff:192.168.1.1')).toBe(true);
      expect(isPrivateIPv6('::ffff:8.8.8.8')).toBe(false);

      // Public IPv6 (should be allowed)
      expect(isPrivateIPv6('2606:4700:4700::1111')).toBe(false); // Cloudflare DNS
      expect(isPrivateIPv6('2001:4860:4860::8888')).toBe(false); // Google DNS
    });
  });

  describe('validateBrowserTargetUrl', () => {
    it('rejects forbidden URL protocols', async () => {
      const forbiddenProtocols = [
        'file:///etc/passwd',
        'data:text/html,<h1>PWNED</h1>',
        'javascript:alert(1)',
        'blob:https://example.com/uuid',
        'ws://127.0.0.1:8080',
        'wss://example.com/socket',
        'unix:/var/run/docker.sock',
        'gopher://gopher.floodgap.com',
        'about:blank',
        'chrome://settings',
      ];

      for (const rawUrl of forbiddenProtocols) {
        await expect(validateBrowserTargetUrl(rawUrl)).rejects.toThrow(BrowserServiceError);
        await expect(validateBrowserTargetUrl(rawUrl)).rejects.toMatchObject({
          code: BrowserErrorCode.BROWSER_SSRF_BLOCKED,
        });
      }
    });

    it('rejects direct private IPv4 and metadata IP URLs', async () => {
      const privateUrls = [
        'http://127.0.0.1/admin',
        'http://127.0.0.1:8080/metrics',
        'http://10.0.0.5/',
        'http://192.168.1.1:80/',
        'http://172.16.10.1/',
        'http://169.254.169.254/latest/meta-data/',
        'http://100.100.100.200/latest/meta-data/',
        'http://0.0.0.0:3000',
      ];

      for (const url of privateUrls) {
        await expect(validateBrowserTargetUrl(url)).rejects.toThrow(BrowserServiceError);
        await expect(validateBrowserTargetUrl(url)).rejects.toMatchObject({
          code: BrowserErrorCode.BROWSER_SSRF_BLOCKED,
        });
      }
    });

    it('rejects direct private IPv6 URLs', async () => {
      const privateIpv6Urls = [
        'http://[::1]/',
        'http://[::1]:8080/metrics',
        'http://[fe80::1]/',
        'http://[fc00::1]/',
      ];

      for (const url of privateIpv6Urls) {
        await expect(validateBrowserTargetUrl(url)).rejects.toThrow(BrowserServiceError);
        await expect(validateBrowserTargetUrl(url)).rejects.toMatchObject({
          code: BrowserErrorCode.BROWSER_SSRF_BLOCKED,
        });
      }
    });

    it('rejects internal and local hostnames', async () => {
      const localHostnames = [
        'http://localhost:3000',
        'http://subdomain.localhost:8080',
        'http://myservice.local/api',
        'http://internal-db.internal/',
        'http://metadata.google.internal/computeMetadata/v1/',
      ];

      for (const url of localHostnames) {
        await expect(validateBrowserTargetUrl(url)).rejects.toThrow(BrowserServiceError);
        await expect(validateBrowserTargetUrl(url)).rejects.toMatchObject({
          code: BrowserErrorCode.BROWSER_SSRF_BLOCKED,
        });
      }
    });

    it('blocks DNS rebinding / hostnames resolving to private IPs via custom DNS resolver', async () => {
      // Mock resolver returning private IP for a public-looking domain
      const fakeDnsResolver = async (host: string) => {
        if (host === 'evil-rebinding.com') {
          return ['127.0.0.1'];
        }
        if (host === 'metadata-rebinding.com') {
          return ['169.254.169.254'];
        }
        return ['93.184.216.34'];
      };

      await expect(
        validateBrowserTargetUrl('https://evil-rebinding.com/steal', {
          customDnsResolver: fakeDnsResolver,
        }),
      ).rejects.toMatchObject({
        code: BrowserErrorCode.BROWSER_SSRF_BLOCKED,
      });

      await expect(
        validateBrowserTargetUrl('https://metadata-rebinding.com/credentials', {
          customDnsResolver: fakeDnsResolver,
        }),
      ).rejects.toMatchObject({
        code: BrowserErrorCode.BROWSER_SSRF_BLOCKED,
      });

      // Public resolution succeeds
      const result = await validateBrowserTargetUrl('https://example.com/', {
        customDnsResolver: fakeDnsResolver,
      });
      expect(result.resolvedUrl.hostname).toBe('example.com');
      expect(result.ipAddresses).toContain('93.184.216.34');
    });

    it('enforces explicit allowedHosts whitelist when configured', async () => {
      const allowedHosts = ['example.com', 'api.trusted.org'];

      // Allowed host passes
      const fakeDnsResolver = async () => ['93.184.216.34'];
      const ok = await validateBrowserTargetUrl('https://example.com/page', {
        allowedHosts,
        customDnsResolver: fakeDnsResolver,
      });
      expect(ok.resolvedUrl.hostname).toBe('example.com');

      // Disallowed host is blocked
      await expect(
        validateBrowserTargetUrl('https://untrusted-site.org/page', {
          allowedHosts,
          customDnsResolver: fakeDnsResolver,
        }),
      ).rejects.toMatchObject({
        code: BrowserErrorCode.BROWSER_SSRF_BLOCKED,
      });
    });

    it('permits localhost when allowLocalForTesting is explicitly set to true', async () => {
      const result = await validateBrowserTargetUrl('http://127.0.0.1:3000/test', {
        allowLocalForTesting: true,
      });
      expect(result.resolvedUrl.hostname).toBe('127.0.0.1');
      expect(result.ipAddresses).toContain('127.0.0.1');
    });
  });

  describe('URL & Credential Sanitization', () => {
    it('strips userinfo/basic auth credentials from URLs', () => {
      const input = 'https://admin:SuperSecretPassword123@example.com/dashboard';
      const output = sanitizeUrl(input);
      expect(output).toBe('https://example.com/dashboard');
      expect(output).not.toContain('admin');
      expect(output).not.toContain('SuperSecretPassword123');
    });

    it('redacts sensitive query parameters while preserving safe ones', () => {
      const input =
        'https://example.com/search?q=playwright&token=secret_jwt_token&api_key=sk-123456&page=2&password=myPassWord';
      const output = sanitizeUrl(input);
      const url = new URL(output);

      expect(url.searchParams.get('q')).toBe('playwright');
      expect(url.searchParams.get('page')).toBe('2');
      expect(url.searchParams.get('token')).toBe('***');
      expect(url.searchParams.get('api_key')).toBe('***');
      expect(url.searchParams.get('password')).toBe('***');
    });

    it('extracts clean origin and path without query or hash', () => {
      const input = 'https://user:pass@example.com:8443/docs/api?token=abc#section-2';
      const output = getCleanOriginAndPath(input);
      expect(output).toBe('https://example.com:8443/docs/api');
    });
  });

  describe('Route Interception & Redirect SSRF Blocking in BrowserService', () => {
    it('blocks redirect to private IP / metadata in page navigation', async () => {
      const service = createBrowserService({
        mode: 'in-process',
        allowLocalForTesting: true, // Allow initial connection to 127.0.0.1 fixture
      });

      try {
        const sessionKey = { userId: 'alice', spaceId: 'sp1', sessionId: 'sess1' };

        // Attempting to navigate to an endpoint that redirects to 10.0.0.1
        // The initial 127.0.0.1 is allowed by allowLocalForTesting, but redirect to 10.0.0.1 must be blocked by route interceptor!
        await expect(
          service.open({
            sessionKey,
            url: `${server.origin}/redirect-private`,
          }),
        ).rejects.toThrow();
      } finally {
        await service.dispose();
      }
    });
  });

  describe('Chromium Sandbox Guard and Test Mode Verification', () => {
    it('rejects disableChromiumSandboxForTesting when NODE_ENV is production', () => {
      const origEnv = process.env.NODE_ENV;
      const origVitest = process.env.VITEST;
      try {
        process.env.NODE_ENV = 'production';
        delete process.env.VITEST;

        expect(() => {
          createBrowserService({
            mode: 'in-process',
            disableChromiumSandboxForTesting: true,
          });
        }).toThrow(BrowserServiceError);

        expect(() => {
          createBrowserService({
            mode: 'in-process',
            disableChromiumSandboxForTesting: true,
          });
        }).toThrowError(/disableChromiumSandboxForTesting is strictly forbidden/);
      } finally {
        process.env.NODE_ENV = origEnv;
        if (origVitest) process.env.VITEST = origVitest;
      }
    });
  });

  describe('Error Sanitization and Credential/Path Redaction Tests', () => {
    it('redacts tokens, passwords, and absolute system paths in BrowserServiceError', () => {
      const rawMsg =
        'Failed to connect to https://admin:SuperSecretPassword@internal.db:8443/api?token=sk-99887766 and open file /Users/<user>/ClaudeCodeWS/secret_keys.pem';
      const err = new BrowserServiceError(rawMsg, {
        code: BrowserErrorCode.BROWSER_ACTION_FAILED,
        details: {
          path: '/Users/<user>/ClaudeCodeWS/DSH-Claw/secret.txt',
          userToken: 'sk-99887766',
        },
      });

      expect(err.message).not.toContain('SuperSecretPassword');
      expect(err.message).not.toContain('sk-99887766');
      expect(err.message).not.toContain('/Users/<user>');
      expect(err.message).toContain('***:***@');
      expect(err.message).toContain('token=***');
      expect(err.message).toContain('[PATH]');

      expect(err.details.userToken).toBe('***');
      expect(err.details.path).toBe('[PATH]');
    });
  });
});
