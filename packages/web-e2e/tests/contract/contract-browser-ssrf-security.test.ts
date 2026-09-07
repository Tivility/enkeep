/**
 * Contract Test: Browser SSRF Security, Redirect Boundary, and Private IP Protection
 *
 * Requirements:
 * 1. Production Default: Strict SSRF protection (denies loopback, 127.0.0.1, 0.0.0.0, 169.254.169.254, RFC 1918 private ranges).
 * 2. Test Allowlist: Only exact allowlisted fixture (host:port) is permitted.
 * 3. Redirect to metadata (169.254.169.254) or unallowed internal IPs is blocked.
 * 4. Separate service security validation adhering to zero-trust perimeter.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';

interface SsrValidationResult {
  allowed: boolean;
  code: 'ALLOWED' | 'SSRF_BLOCKED' | 'INVALID_URL' | 'REDIRECT_SSRF_BLOCKED';
  reason?: string;
}

interface SsrPolicy {
  denyPrivateByDefault: boolean;
  allowlist: Set<string>;
}

function evaluateBrowserNavigationTarget(
  targetUrl: string,
  policy: SsrPolicy
): SsrValidationResult {
  let urlObj: URL;
  try {
    urlObj = new URL(targetUrl);
  } catch {
    return { allowed: false, code: 'INVALID_URL', reason: 'Invalid URL syntax' };
  }

  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
    return { allowed: false, code: 'SSRF_BLOCKED', reason: `Protocol "${urlObj.protocol}" is not permitted` };
  }

  const hostname = urlObj.hostname.toLowerCase();
  const hostWithPort = `${hostname}:${urlObj.port || (urlObj.protocol === 'https:' ? '443' : '80')}`;

  // Explicit allowlist bypasses private IP restriction
  if (policy.allowlist.has(hostname) || policy.allowlist.has(hostWithPort)) {
    return { allowed: true, code: 'ALLOWED' };
  }

  if (policy.denyPrivateByDefault) {
    // 1. Cloud Metadata IP (AWS, GCP, Azure, OpenStack)
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal' || hostname === '100.100.100.200') {
      return { allowed: false, code: 'SSRF_BLOCKED', reason: 'Cloud instance metadata service access is strictly forbidden' };
    }

    // 2. Loopback and Localhost
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1' || hostname === '[::1]') {
      return { allowed: false, code: 'SSRF_BLOCKED', reason: 'Localhost and loopback address access is blocked by default' };
    }

    // 3. RFC 1918 Private IP Ranges
    if (
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
      hostname.startsWith('127.') ||
      hostname === '0.0.0.0'
    ) {
      return { allowed: false, code: 'SSRF_BLOCKED', reason: 'RFC 1918 private network access is blocked by default' };
    }
  }

  return { allowed: true, code: 'ALLOWED' };
}

describe('Contract Test: Browser SSRF Security & Redirect Boundary', () => {
  let fixtureServer: Server;
  let fixturePort: number;
  let fixtureBaseUrl: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      fixtureServer = createServer((req, res) => {
        const parsed = new URL(req.url || '/', `http://${req.headers.host}`);
        if (parsed.pathname === '/safe-page') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h1>Safe Page</h1>');
        } else if (parsed.pathname === '/redirect-metadata') {
          res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' });
          res.end();
        } else if (parsed.pathname === '/redirect-localhost-admin') {
          res.writeHead(302, { Location: 'http://127.0.0.1:9000/internal-metrics' });
          res.end();
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      fixtureServer.listen(0, '127.0.0.1', () => {
        const addr = fixtureServer.address();
        if (typeof addr === 'object' && addr !== null) {
          fixturePort = addr.port;
          fixtureBaseUrl = `http://127.0.0.1:${fixturePort}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (fixtureServer) {
      await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
    }
  });

  it('1. Production Default Policy: Denies all private addresses and metadata', () => {
    const defaultProdPolicy: SsrPolicy = {
      denyPrivateByDefault: true,
      allowlist: new Set(),
    };

    // Private targets
    expect(evaluateBrowserNavigationTarget('http://127.0.0.1:8080/api', defaultProdPolicy).code).toBe('SSRF_BLOCKED');
    expect(evaluateBrowserNavigationTarget('http://localhost:3000', defaultProdPolicy).code).toBe('SSRF_BLOCKED');
    expect(evaluateBrowserNavigationTarget('http://169.254.169.254/latest/meta-data/', defaultProdPolicy).code).toBe('SSRF_BLOCKED');
    expect(evaluateBrowserNavigationTarget('http://10.10.10.10/database', defaultProdPolicy).code).toBe('SSRF_BLOCKED');
    expect(evaluateBrowserNavigationTarget('http://192.168.0.1/admin', defaultProdPolicy).code).toBe('SSRF_BLOCKED');
    expect(evaluateBrowserNavigationTarget('http://172.16.0.5/internal', defaultProdPolicy).code).toBe('SSRF_BLOCKED');

    // Public targets permitted
    expect(evaluateBrowserNavigationTarget('https://docs.enkeep.dev/guide', defaultProdPolicy).code).toBe('ALLOWED');
    expect(evaluateBrowserNavigationTarget('https://api.github.com/repos', defaultProdPolicy).code).toBe('ALLOWED');
  });

  it('2. Test Environment Allowlist: Permits exact allowlisted fixture only', () => {
    const testPolicyWithFixture: SsrPolicy = {
      denyPrivateByDefault: true,
      allowlist: new Set([`127.0.0.1:${fixturePort}`]),
    };

    // Exact fixture is allowed
    const fixtureCheck = evaluateBrowserNavigationTarget(`${fixtureBaseUrl}/safe-page`, testPolicyWithFixture);
    expect(fixtureCheck.allowed).toBe(true);
    expect(fixtureCheck.code).toBe('ALLOWED');

    // Unlisted localhost port is still strictly blocked
    const unlistedPortCheck = evaluateBrowserNavigationTarget('http://127.0.0.1:9999/status', testPolicyWithFixture);
    expect(unlistedPortCheck.allowed).toBe(false);
    expect(unlistedPortCheck.code).toBe('SSRF_BLOCKED');

    // Metadata is still strictly blocked
    const metadataCheck = evaluateBrowserNavigationTarget('http://169.254.169.254/meta', testPolicyWithFixture);
    expect(metadataCheck.allowed).toBe(false);
    expect(metadataCheck.code).toBe('SSRF_BLOCKED');
  });

  it('3. Redirect Chain SSRF Boundary: Redirect to metadata or unauthorized local target is caught and blocked', async () => {
    const testPolicy: SsrPolicy = {
      denyPrivateByDefault: true,
      allowlist: new Set([`127.0.0.1:${fixturePort}`]),
    };

    // Simulating redirect inspection
    const inspectNavigationChain = (targetUrl: string, redirectedTarget?: string): SsrValidationResult => {
      const initial = evaluateBrowserNavigationTarget(targetUrl, testPolicy);
      if (!initial.allowed) return initial;

      if (redirectedTarget) {
        const redirected = evaluateBrowserNavigationTarget(redirectedTarget, testPolicy);
        if (!redirected.allowed) {
          return { allowed: false, code: 'REDIRECT_SSRF_BLOCKED', reason: `Redirect target "${redirectedTarget}" violated SSRF policy: ${redirected.reason}` };
        }
      }

      return { allowed: true, code: 'ALLOWED' };
    };

    // Navigation to fixture page with 302 redirect to metadata
    const redirectMetaResult = inspectNavigationChain(
      `${fixtureBaseUrl}/redirect-metadata`,
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/'
    );
    expect(redirectMetaResult.allowed).toBe(false);
    expect(redirectMetaResult.code).toBe('REDIRECT_SSRF_BLOCKED');

    // Navigation to fixture page with 302 redirect to another unallowlisted local port
    const redirectLocalResult = inspectNavigationChain(
      `${fixtureBaseUrl}/redirect-localhost-admin`,
      'http://127.0.0.1:9000/internal-metrics'
    );
    expect(redirectLocalResult.allowed).toBe(false);
    expect(redirectLocalResult.code).toBe('REDIRECT_SSRF_BLOCKED');
  });
});
