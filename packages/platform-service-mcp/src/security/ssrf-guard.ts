/**
 * SSRF Guard and DNS/IP Validation for Streamable-HTTP Client
 *
 * Enforces:
 * - Public HTTPS policy (rejects plaintext HTTP for remote hosts)
 * - DNS pre-resolution & post-resolution check against private IP ranges (RFC 1918, RFC 3927, loopback, IPv6 link-local/unique local)
 * - Redirect target re-validation
 * - Header sanitization (removes forbidden host-level / internal hop-by-hop headers)
 *
 * @module @enkeep/platform-service-mcp/security/ssrf-guard
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { McpErrorCode, McpServiceError } from '../errors.js';

export const FORBIDDEN_HTTP_HEADERS = [
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
] as const;

/**
 * Checks if an IPv4 address is in a private, loopback, link-local, or broadcast range.
 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // invalid IP -> fail closed
  }

  const [a, b] = parts;

  // 0.0.0.0/8 (current network)
  if (a === 0) return true;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 10.0.0.0/8 (private)
  if (a === 10) return true;
  // 172.16.0.0/12 (private)
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 (private)
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 (carrier-grade NAT)
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
  // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (documentation)
  if (a === 192 && b === 0 && parts[2] === 2) return true;
  if (a === 198 && b === 51 && parts[2] === 100) return true;
  if (a === 203 && b === 0 && parts[2] === 113) return true;
  // 224.0.0.0/4 (multicast) & 240.0.0.0/4 (reserved)
  if (a !== undefined && a >= 224) return true;

  return false;
}

/**
 * Checks if an IPv6 address is in a private, loopback, or link-local range.
 */
export function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  // ::1 (loopback)
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  // :: (unspecified)
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;
  // fe80::/10 (link-local)
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return true;
  }
  // fc00::/7 (unique local address)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true;
  }
  // IPv4-mapped IPv6 (::ffff:127.0.0.1)
  if (normalized.includes('::ffff:')) {
    const v4Part = normalized.split('::ffff:')[1];
    if (v4Part && isIP(v4Part) === 4) {
      return isPrivateIPv4(v4Part);
    }
  }
  return false;
}

/**
 * Validates a target URL against SSRF policy.
 */
export async function validateSsrfTargetUrl(
  rawUrl: string,
  options: {
    allowLocalHttpForTesting?: boolean;
    allowedHosts?: readonly string[];
  } = {},
): Promise<{ resolvedUrl: URL; ipAddresses: string[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (err) {
    throw new McpServiceError(`Invalid MCP server URL: "${rawUrl}"`, {
      code: McpErrorCode.MCP_BAD_REQUEST,
      cause: err,
    });
  }

  const hostname = url.hostname.toLowerCase();

  // Test bypass for localhost / mock HTTP server during automated tests
  if (options.allowLocalHttpForTesting) {
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return { resolvedUrl: url, ipAddresses: ['127.0.0.1'] };
    }
  }

  // Check protocol: Must be HTTPS for public endpoints
  if (url.protocol !== 'https:') {
    throw new McpServiceError(
      `MCP HTTP server endpoint must use HTTPS (got "${url.protocol}")`,
      {
        code: McpErrorCode.MCP_SSRF_BLOCKED,
        details: { url: rawUrl },
      },
    );
  }

  // Check if explicit allowed host list matches
  if (options.allowedHosts && options.allowedHosts.length > 0) {
    const isAllowed = options.allowedHosts.some(
      (h) => h.toLowerCase() === hostname || hostname.endsWith(`.${h.toLowerCase()}`),
    );
    if (!isAllowed) {
      throw new McpServiceError(
        `Hostname "${hostname}" is not in the allowlist of permitted MCP HTTP hosts`,
        {
          code: McpErrorCode.MCP_SSRF_BLOCKED,
          details: { hostname, allowedHosts: options.allowedHosts },
        },
      );
    }
  }

  // If hostname is directly an IP address
  const ipVer = isIP(hostname);
  if (ipVer === 4) {
    if (isPrivateIPv4(hostname)) {
      throw new McpServiceError(`Direct private IPv4 address "${hostname}" is forbidden by SSRF policy`, {
        code: McpErrorCode.MCP_SSRF_BLOCKED,
        details: { ip: hostname },
      });
    }
    return { resolvedUrl: url, ipAddresses: [hostname] };
  } else if (ipVer === 6) {
    if (isPrivateIPv6(hostname)) {
      throw new McpServiceError(`Direct private IPv6 address "${hostname}" is forbidden by SSRF policy`, {
        code: McpErrorCode.MCP_SSRF_BLOCKED,
        details: { ip: hostname },
      });
    }
    return { resolvedUrl: url, ipAddresses: [hostname] };
  }

  // Reject obvious local names
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === '0.0.0.0'
  ) {
    throw new McpServiceError(`Local hostname "${hostname}" is forbidden by SSRF policy`, {
      code: McpErrorCode.MCP_SSRF_BLOCKED,
      details: { hostname },
    });
  }

  // Perform DNS resolution check to prevent DNS rebinding / private IP resolution
  try {
    const addresses = await lookup(hostname, { all: true });
    const ipList = addresses.map((a) => a.address);

    for (const entry of addresses) {
      if (entry.family === 4 && isPrivateIPv4(entry.address)) {
        throw new McpServiceError(
          `SSRF policy blocked hostname "${hostname}" resolving to private IPv4 address "${entry.address}"`,
          {
            code: McpErrorCode.MCP_SSRF_BLOCKED,
            details: { hostname, resolvedIp: entry.address },
          },
        );
      } else if (entry.family === 6 && isPrivateIPv6(entry.address)) {
        throw new McpServiceError(
          `SSRF policy blocked hostname "${hostname}" resolving to private IPv6 address "${entry.address}"`,
          {
            code: McpErrorCode.MCP_SSRF_BLOCKED,
            details: { hostname, resolvedIp: entry.address },
          },
        );
      }
    }

    return { resolvedUrl: url, ipAddresses: ipList };
  } catch (err) {
    if (err instanceof McpServiceError) throw err;
    throw new McpServiceError(`DNS lookup failed for MCP host "${hostname}"`, {
      code: McpErrorCode.MCP_SERVER_UNAVAILABLE,
      cause: err,
    });
  }
}

/**
 * Sanitizes outgoing HTTP headers for MCP upstream calls.
 */
export function sanitizeHttpHeaders(
  staticHeaders: Record<string, string> = {},
  ephemeralHeaders: Record<string, string> = {},
): Headers {
  const headers = new Headers();

  for (const [k, v] of Object.entries(staticHeaders)) {
    const lower = k.toLowerCase().trim();
    if (!FORBIDDEN_HTTP_HEADERS.includes(lower as any)) {
      headers.set(k, v);
    }
  }

  for (const [k, v] of Object.entries(ephemeralHeaders)) {
    const lower = k.toLowerCase().trim();
    if (!FORBIDDEN_HTTP_HEADERS.includes(lower as any)) {
      headers.set(k, v);
    }
  }

  return headers;
}
