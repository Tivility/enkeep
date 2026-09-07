/**
 * Webhook Security & SSRF Defense Policy
 *
 * Enforces:
 * - Rejection of embedded URL credentials (username:password)
 * - Rejection of sensitive query parameters (e.g. ?token=, ?key=, ?secret=)
 * - RFC 1918 Private IP blocklist (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 * - Loopback blocklist (127.0.0.0/8, ::1)
 * - Link-Local and Cloud Metadata blocklist (169.254.0.0/16, metadata.google.internal)
 * - Multicast / Broadcast / Zero IP blocklist (224.0.0.0/4, 255.255.255.255, 0.0.0.0/8, ::/128)
 * - Pre-flight DNS resolution checking all resolved IPs (DNS rebinding defense)
 * - HTTPS policy with configurable test loopback allowance
 *
 * @module @enkeep/platform-server/notifications
 */

import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

export interface WebhookSecurityOptions {
  /** When true, allows HTTP and 127.0.0.1/localhost only for test fake servers. Default false. */
  allowTestLoopback?: boolean;
  /** When true, requires https protocol. Default true (unless allowTestLoopback is enabled). */
  enforceHttps?: boolean;
}

export class WebhookSecurityError extends Error {
  public readonly code: string;
  constructor(message: string, code = 'SSRF_BLOCKED') {
    super(message);
    this.name = 'WebhookSecurityError';
    this.code = code;
  }
}

const SENSITIVE_QUERY_PARAM_REGEX = /^(?:token|key|secret|password|auth|sig|signature|bearer|apikey|api_key|access_token|credential|private)$/i;

/**
 * Checks whether an IPv4 address falls into private, loopback, link-local, or reserved ranges.
 */
export function isPrivateOrBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // Malformed -> block
  }

  const [a, b] = parts;

  // 0.0.0.0/8 (Current network)
  if (a === 0) return true;

  // 10.0.0.0/8 (Private RFC1918)
  if (a === 10) return true;

  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;

  // 169.254.0.0/16 (Link-local & AWS/GCP metadata)
  if (a === 169 && b === 254) return true;

  // 172.16.0.0/12 (Private RFC1918)
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.168.0.0/16 (Private RFC1918)
  if (a === 192 && b === 168) return true;

  // 100.64.0.0/10 (Shared address space / Carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;

  // 198.18.0.0/15 (Benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true;

  // 224.0.0.0/4 (Multicast)
  if (a >= 224 && a <= 239) return true;

  // 240.0.0.0/4 (Reserved / Future use)
  if (a >= 240) return true;

  // 255.255.255.255 (Broadcast)
  if (parts.every((p) => p === 255)) return true;

  return false;
}

/**
 * Checks whether an IPv6 address falls into private, loopback, link-local, or reserved ranges.
 */
export function isPrivateOrBlockedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().trim();

  // ::1 (Loopback)
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;

  // :: (Unspecified)
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;

  // IPv4 mapped IPv6 (::ffff:x.x.x.x)
  if (normalized.startsWith('::ffff:')) {
    const ipv4Part = normalized.slice('::ffff:'.length);
    if (isIP(ipv4Part) === 4) {
      return isPrivateOrBlockedIPv4(ipv4Part);
    }
    return true;
  }

  // fc00::/7 (Unique Local Address - ULA)
  if (/^f[cd][0-9a-f]{2}:/i.test(normalized)) return true;

  // fe80::/10 (Link-local)
  if (/^fe[89ab][0-9a-f]:/i.test(normalized)) return true;

  // ff00::/8 (Multicast)
  if (normalized.startsWith('ff')) return true;

  return false;
}

/**
 * Validates and normalizes target webhook URL against SSRF rules and protocol policies.
 */
export async function validateWebhookUrl(
  rawUrl: string,
  options: WebhookSecurityOptions = {}
): Promise<{ url: URL; resolvedIps: string[] }> {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new WebhookSecurityError('Webhook URL is required', 'INVALID_URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new WebhookSecurityError(`Invalid webhook URL format: "${rawUrl}"`, 'INVALID_URL');
  }

  // 1. Reject embedded URL credentials (username:password)
  if (parsed.username || parsed.password) {
    throw new WebhookSecurityError(
      'Embedded URL credentials (username/password) are forbidden. Use subscription secret header authentication instead',
      'CREDENTIALS_IN_URL_FORBIDDEN'
    );
  }

  // 2. Reject sensitive query parameters in URL (e.g. ?token=, ?key=, ?secret=)
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (SENSITIVE_QUERY_PARAM_REGEX.test(key)) {
      throw new WebhookSecurityError(
        `Sensitive query parameter "${key}" in webhook destination URL is forbidden. Use subscription secret header authentication instead`,
        'SENSITIVE_PARAM_IN_URL_FORBIDDEN'
      );
    }
  }

  const allowLoopback = options.allowTestLoopback === true || process.env.ALLOW_TEST_WEBHOOK_LOOPBACK === '1';
  const enforceHttps = options.enforceHttps !== false && !allowLoopback;

  if (enforceHttps && parsed.protocol !== 'https:') {
    throw new WebhookSecurityError(`Webhook URL must use HTTPS protocol, got "${parsed.protocol}"`, 'INSECURE_PROTOCOL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WebhookSecurityError(`Unsupported protocol "${parsed.protocol}"`, 'UNSUPPORTED_PROTOCOL');
  }

  const hostname = parsed.hostname.toLowerCase().trim();

  // Explicit host blocklist
  if (
    hostname === 'metadata.google.internal' ||
    hostname === 'instance-data' ||
    hostname === '169.254.169.254'
  ) {
    throw new WebhookSecurityError(`Access to cloud metadata endpoint "${hostname}" is forbidden`, 'CLOUD_METADATA_BLOCKED');
  }

  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    if (!allowLoopback) {
      throw new WebhookSecurityError(`Localhost / loopback destination "${hostname}" is forbidden`, 'LOOPBACK_BLOCKED');
    }
  }

  // Pre-flight DNS resolution
  const resolvedIps: string[] = [];
  const ipType = isIP(hostname);

  if (ipType === 4) {
    if (!allowLoopback && isPrivateOrBlockedIPv4(hostname)) {
      throw new WebhookSecurityError(`Private or reserved IPv4 destination "${hostname}" is blocked`, 'PRIVATE_IP_BLOCKED');
    }
    resolvedIps.push(hostname);
  } else if (ipType === 6) {
    if (!allowLoopback && isPrivateOrBlockedIPv6(hostname)) {
      throw new WebhookSecurityError(`Private or reserved IPv6 destination "${hostname}" is blocked`, 'PRIVATE_IP_BLOCKED');
    }
    resolvedIps.push(hostname);
  } else {
    // Resolve DNS records
    try {
      const records = await dns.lookup(hostname, { all: true });
      if (!records || records.length === 0) {
        throw new WebhookSecurityError(`Could not resolve hostname "${hostname}"`, 'DNS_RESOLUTION_FAILED');
      }

      for (const rec of records) {
        resolvedIps.push(rec.address);
        if (!allowLoopback) {
          if (rec.family === 4 && isPrivateOrBlockedIPv4(rec.address)) {
            throw new WebhookSecurityError(`Resolved IP "${rec.address}" for host "${hostname}" is in blocked/private range`, 'DNS_REBINDING_BLOCKED');
          }
          if (rec.family === 6 && isPrivateOrBlockedIPv6(rec.address)) {
            throw new WebhookSecurityError(`Resolved IPv6 "${rec.address}" for host "${hostname}" is in blocked/private range`, 'DNS_REBINDING_BLOCKED');
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof WebhookSecurityError) {
        throw err;
      }
      throw new WebhookSecurityError(`DNS lookup failed for host "${hostname}": ${String((err as Error)?.message || err)}`, 'DNS_LOOKUP_ERROR');
    }
  }

  return { url: parsed, resolvedIps };
}
