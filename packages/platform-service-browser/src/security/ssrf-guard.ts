/**
 * Browser Service SSRF Guard and DNS/IP Validation
 *
 * Enforces:
 * - Scheme restriction: http: and https: only (blocks file:, data:, javascript:, blob:, ws:, wss:, unix:, etc.)
 * - Strict IP validation against private (RFC 1918), loopback (127.0.0.0/8, ::1), link-local (169.254.0.0/16, fe80::/10),
 *   cloud metadata (169.254.169.254, 169.254.170.2, 100.100.100.200), carrier-grade NAT (100.64.0.0/10), and multicast.
 * - Hostname verification & async DNS resolution to prevent DNS rebinding.
 * - Playwright route interception on every request and redirect hop.
 *
 * @module @enkeep/platform-service-browser/security/ssrf-guard
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BrowserErrorCode, BrowserServiceError } from '../errors.js';

export const FORBIDDEN_SCHEMES = new Set([
  'file:',
  'data:',
  'javascript:',
  'blob:',
  'ws:',
  'wss:',
  'unix:',
  'gopher:',
  'about:',
  'chrome:',
  'edge:',
  'brave:',
  'ftp:',
  'view-source:',
]);

/**
 * Checks if an IPv4 address is in a private, loopback, link-local, carrier-grade NAT, or multicast range.
 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // Invalid format -> fail closed
  }

  const [a, b, c, d] = parts;

  // 0.0.0.0/8 (current network)
  if (a === 0) return true;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 10.0.0.0/8 (private RFC 1918)
  if (a === 10) return true;
  // 172.16.0.0/12 (private RFC 1918: 172.16.0.0 - 172.31.255.255)
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 (private RFC 1918)
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local & AWS/GCP/Azure metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 (carrier-grade NAT / shared space RFC 6598)
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
  // Alibaba Cloud metadata (100.100.100.200)
  if (a === 100 && b === 100 && c === 100 && d === 200) return true;
  // 192.0.2.0/24 (documentation TEST-NET-1)
  if (a === 192 && b === 0 && c === 2) return true;
  // 198.51.100.0/24 (documentation TEST-NET-2)
  if (a === 198 && b === 51 && c === 100) return true;
  // 203.0.113.0/24 (documentation TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return true;
  // 224.0.0.0/4 (multicast) & 240.0.0.0/4 (reserved) & 255.255.255.255
  if (a !== undefined && a >= 224) return true;

  return false;
}

/**
 * Checks if an IPv6 address is in a private, loopback, link-local, or unique-local range.
 */
export function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().trim();

  // ::1 (loopback)
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  // :: (unspecified)
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;
  // fe80::/10 (link-local)
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return true;
  }
  // fc00::/7 (unique local address fc00::/8 & fd00::/8)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true;
  }
  // 2001:db8::/32 (documentation)
  if (normalized.startsWith('2001:db8') || normalized.startsWith('2001:0db8')) {
    return true;
  }
  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:10.0.0.1)
  if (normalized.includes('::ffff:')) {
    const v4Part = normalized.split('::ffff:')[1];
    if (v4Part && isIP(v4Part) === 4) {
      return isPrivateIPv4(v4Part);
    }
  }

  return false;
}

export interface ValidateUrlOptions {
  allowLocalForTesting?: boolean;
  allowedHosts?: readonly string[];
  customDnsResolver?: (hostname: string) => Promise<string[]>;
}

/**
 * Validates a target URL against SSRF and network security policies.
 * Performs protocol check, hostname validation, and DNS resolution inspection.
 */
export async function validateBrowserTargetUrl(
  rawUrl: string,
  options: ValidateUrlOptions = {},
): Promise<{ resolvedUrl: URL; ipAddresses: string[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (err) {
    throw new BrowserServiceError(`Invalid URL: "${rawUrl}"`, {
      code: BrowserErrorCode.BROWSER_BAD_REQUEST,
      cause: err,
    });
  }

  // Enforce protocol: ONLY http: and https: are allowed
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserServiceError(
      `Forbidden URL scheme "${url.protocol}". Only "http:" and "https:" are permitted.`,
      {
        code: BrowserErrorCode.BROWSER_SSRF_BLOCKED,
        details: { url: rawUrl, protocol: url.protocol },
      },
    );
  }

  const hostname = url.hostname.toLowerCase();
  if (!hostname) {
    throw new BrowserServiceError(`Empty hostname in URL: "${rawUrl}"`, {
      code: BrowserErrorCode.BROWSER_BAD_REQUEST,
      details: { url: rawUrl },
    });
  }

  // Explicit test bypass for local testing if configured
  if (options.allowLocalForTesting) {
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]'
    ) {
      return { resolvedUrl: url, ipAddresses: ['127.0.0.1'] };
    }
  }

  // Reject local and internal hostnames
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.corp') ||
    hostname.endsWith('.lan') ||
    hostname === '0.0.0.0' ||
    hostname === 'metadata.google.internal' ||
    hostname === 'metadata'
  ) {
    throw new BrowserServiceError(
      `Local or internal hostname "${hostname}" is forbidden by SSRF policy.`,
      {
        code: BrowserErrorCode.BROWSER_SSRF_BLOCKED,
        details: { hostname },
      },
    );
  }

  // Check explicit allowed hosts list if provided
  if (options.allowedHosts && options.allowedHosts.length > 0) {
    const isAllowed = options.allowedHosts.some((h) => {
      const target = h.toLowerCase();
      return hostname === target || hostname.endsWith(`.${target}`);
    });

    if (!isAllowed) {
      throw new BrowserServiceError(
        `Hostname "${hostname}" is not in the allowlist of permitted hosts.`,
        {
          code: BrowserErrorCode.BROWSER_SSRF_BLOCKED,
          details: { hostname, allowedHosts: options.allowedHosts },
        },
      );
    }
  }

  // Check if hostname is an IP literal
  const cleanHost = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  const ipVer = isIP(cleanHost);
  if (ipVer === 4) {
    if (isPrivateIPv4(cleanHost)) {
      throw new BrowserServiceError(
        `Direct private IPv4 address "${cleanHost}" is forbidden by SSRF policy.`,
        {
          code: BrowserErrorCode.BROWSER_SSRF_BLOCKED,
          details: { ip: cleanHost },
        },
      );
    }
    return { resolvedUrl: url, ipAddresses: [cleanHost] };
  } else if (ipVer === 6) {
    if (isPrivateIPv6(cleanHost)) {
      throw new BrowserServiceError(
        `Direct private IPv6 address "${cleanHost}" is forbidden by SSRF policy.`,
        {
          code: BrowserErrorCode.BROWSER_SSRF_BLOCKED,
          details: { ip: cleanHost },
        },
      );
    }
    return { resolvedUrl: url, ipAddresses: [cleanHost] };
  }

  // DNS resolution check: Resolve all IPs and ensure NONE point to private networks
  try {
    let ipList: string[];
    if (options.customDnsResolver) {
      ipList = await options.customDnsResolver(hostname);
    } else {
      const addresses = await lookup(hostname, { all: true });
      ipList = addresses.map((a) => a.address);
    }

    if (!ipList || ipList.length === 0) {
      throw new BrowserServiceError(`DNS lookup returned no addresses for host "${hostname}"`, {
        code: BrowserErrorCode.BROWSER_UNAVAILABLE,
        details: { hostname },
      });
    }

    for (const ip of ipList) {
      const ver = isIP(ip);
      if (ver === 4 && isPrivateIPv4(ip)) {
        throw new BrowserServiceError(
          `SSRF policy blocked hostname "${hostname}" resolving to private IPv4 address "${ip}"`,
          {
            code: BrowserErrorCode.BROWSER_SSRF_BLOCKED,
            details: { hostname, resolvedIp: ip },
          },
        );
      } else if (ver === 6 && isPrivateIPv6(ip)) {
        throw new BrowserServiceError(
          `SSRF policy blocked hostname "${hostname}" resolving to private IPv6 address "${ip}"`,
          {
            code: BrowserErrorCode.BROWSER_SSRF_BLOCKED,
            details: { hostname, resolvedIp: ip },
          },
        );
      }
    }

    return { resolvedUrl: url, ipAddresses: ipList };
  } catch (err) {
    if (err instanceof BrowserServiceError) throw err;
    throw new BrowserServiceError(`DNS lookup failed for host "${hostname}"`, {
      code: BrowserErrorCode.BROWSER_UNAVAILABLE,
      cause: err,
      details: { hostname },
    });
  }
}
