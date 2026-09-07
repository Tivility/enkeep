/**
 * Git Source Policy & SSRF Security Guard
 *
 * Enforces strict network boundaries, scheme allowlists, credential rejection,
 * and DNS resolution validation for Git repository access.
 *
 * @module @enkeep/platform-server/skills/git-source-policy
 */

import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import path from 'node:path';
import { ValidationError } from '@enkeep/platform-core';
import {
  isPrivateOrBlockedIPv4,
  isPrivateOrBlockedIPv6,
} from '../notifications/webhook-security-policy.js';

export interface GitSourcePolicy {
  /**
   * Allowed URL schemes. Default: ['https', 'ssh']
   */
  allowedSchemes?: readonly ('https' | 'ssh' | 'http' | 'git' | 'file')[];
  /**
   * Explicit deployment risk flag allowing unencrypted HTTP. Default: false.
   */
  allowInsecureHttp?: boolean;
  /**
   * Explicit deployment risk flag allowing unencrypted git protocol. Default: false.
   */
  allowInsecureGit?: boolean;
  /**
   * Explicit test/admin flag allowing file:// scheme. Default: false.
   */
  allowFileScheme?: boolean;
  /**
   * Canonical filesystem roots permitted when allowFileScheme is enabled.
   */
  allowedFileRoots?: readonly string[];
  /**
   * Allowlisted hostnames/IPs that bypass private IP blocks (e.g. for local test mocks).
   */
  allowedHosts?: readonly string[];
  /**
   * Mandatory path to known_hosts file for StrictHostKeyChecking with SSH.
   */
  knownHostsFile?: string;
}

export const DEFAULT_GIT_SOURCE_POLICY: GitSourcePolicy & {
  allowedSchemes: readonly ('https' | 'ssh' | 'http' | 'git' | 'file')[];
  allowInsecureHttp: boolean;
  allowInsecureGit: boolean;
  allowFileScheme: boolean;
  allowedFileRoots: readonly string[];
  allowedHosts: readonly string[];
  knownHostsFile?: string;
} = Object.freeze({
  allowedSchemes: Object.freeze(['https', 'ssh'] as const),
  allowInsecureHttp: false,
  allowInsecureGit: false,
  allowFileScheme: false,
  allowedFileRoots: Object.freeze([]),
  allowedHosts: Object.freeze([]),
  knownHostsFile: undefined,
});

/**
 * Extracts protocol, host, and path from a git URL (supports standard URLs and scp-like git@host:path).
 */
export function parseGitUrl(rawUrl: string): {
  scheme: string;
  hostname: string;
  hasEmbeddedCredentials: boolean;
  pathname: string;
} {
  if (typeof rawUrl !== 'string' || !rawUrl || rawUrl.trim() !== rawUrl) {
    throw new ValidationError('Git URL must be a non-empty string without leading or trailing whitespace');
  }

  const trimmed = rawUrl.trim();

  // Reject argument injection flags
  if (trimmed.startsWith('-') || trimmed.startsWith('--')) {
    throw new ValidationError('Git URL must not start with dash flags (argument injection defense)');
  }

  // Check SCP-like SSH syntax: git@host:path or user@host:path
  const scpMatch = /^([a-zA-Z0-9._-]+)@([a-zA-Z0-9.-]+):(.+)$/.exec(trimmed);
  if (scpMatch) {
    const user = scpMatch[1];
    const hostname = scpMatch[2];
    const pathname = scpMatch[3];
    return {
      scheme: 'ssh',
      hostname,
      hasEmbeddedCredentials: user !== 'git',
      pathname,
    };
  }

  try {
    const url = new URL(trimmed);
    const scheme = url.protocol.replace(/:$/, '').toLowerCase();
    const hasEmbeddedCredentials = Boolean(url.username || url.password);
    return {
      scheme,
      hostname: url.hostname,
      hasEmbeddedCredentials,
      pathname: url.pathname,
    };
  } catch (_err) {
    throw new ValidationError(`Malformed Git repository URL: "${rawUrl}"`);
  }
}

/**
 * Validates a Git URL against the GitSourcePolicy and runs pre-flight DNS SSRF checks.
 */
export async function validateGitUrlAgainstPolicy(
  rawUrl: string,
  policy: GitSourcePolicy = {}
): Promise<{ scheme: string; hostname: string; sanitizedUrl: string }> {
  const parsed = parseGitUrl(rawUrl);

  // 1. Strict rejection of embedded credentials (tokens/passwords in URL)
  if (parsed.hasEmbeddedCredentials) {
    throw new ValidationError(
      'Embedded credentials (username/password/token) in Git repository URL are strictly prohibited. Pass authentication tokens via secure authorization configuration.'
    );
  }

  const allowedSchemes = policy.allowedSchemes ?? DEFAULT_GIT_SOURCE_POLICY.allowedSchemes;

  // 2. Scheme enforcement
  if (parsed.scheme === 'file') {
    if (!policy.allowFileScheme) {
      throw new ValidationError(
        'file:// scheme is strictly disabled by default. Git repositories must be hosted on secure remote remotes (https:// or ssh://).'
      );
    }
    // Validate file path is within allowedFileRoots
    const fileRoots = policy.allowedFileRoots ?? [];
    if (fileRoots.length === 0) {
      throw new ValidationError('file:// scheme is enabled but allowedFileRoots is empty');
    }
    const resolvedPath = path.resolve(decodeURIComponent(parsed.pathname));
    const isInsideAllowedRoot = fileRoots.some((root) => {
      const canonicalRoot = path.resolve(root);
      const rel = path.relative(canonicalRoot, resolvedPath);
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    });

    if (!isInsideAllowedRoot) {
      throw new ValidationError(
        `Local Git repository path "${resolvedPath}" is not within any allowed file roots`
      );
    }
    return { scheme: 'file', hostname: 'localhost', sanitizedUrl: rawUrl };
  }

  if (parsed.scheme === 'http') {
    if (!policy.allowInsecureHttp) {
      throw new ValidationError(
        'Insecure http:// scheme is prohibited for Git repositories. Use https:// or enable explicit deployment risk flag allowInsecureHttp.'
      );
    }
  }

  if (parsed.scheme === 'git') {
    if (!policy.allowInsecureGit) {
      throw new ValidationError(
        'Insecure unauthenticated git:// scheme is prohibited. Use https:// or ssh://.'
      );
    }
  }

  if (!allowedSchemes.includes(parsed.scheme as any)) {
    throw new ValidationError(
      `Disallowed Git URL scheme "${parsed.scheme}". Allowed schemes: ${allowedSchemes.join(', ')}`
    );
  }

  // 3. DNS SSRF Defense for network schemes (https, http, ssh, git)
  const hostname = parsed.hostname;
  if (!hostname) {
    throw new ValidationError('Git URL must have a valid hostname');
  }

  const allowedHosts = policy.allowedHosts ?? [];
  if (allowedHosts.includes(hostname)) {
    return { scheme: parsed.scheme, hostname, sanitizedUrl: rawUrl };
  }

  // If hostname is directly an IP literal
  const ipVer = isIP(hostname);
  if (ipVer === 4) {
    if (isPrivateOrBlockedIPv4(hostname)) {
      throw new ValidationError(
        `SSRF protection: Git host IP "${hostname}" is in a private, loopback, or cloud metadata range.`
      );
    }
    return { scheme: parsed.scheme, hostname, sanitizedUrl: rawUrl };
  } else if (ipVer === 6) {
    if (isPrivateOrBlockedIPv6(hostname)) {
      throw new ValidationError(
        `SSRF protection: Git host IPv6 "${hostname}" is in a private or loopback range.`
      );
    }
    return { scheme: parsed.scheme, hostname, sanitizedUrl: rawUrl };
  }

  // Check known cloud metadata hostnames
  const lowerHost = hostname.toLowerCase();
  if (
    lowerHost === 'localhost' ||
    lowerHost.endsWith('.localhost') ||
    lowerHost === 'metadata.google.internal' ||
    lowerHost === 'instance-data'
  ) {
    throw new ValidationError(
      `SSRF protection: Git host "${hostname}" is a forbidden loopback or metadata domain.`
    );
  }

  // Resolve all DNS records
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (dnsErr) {
    throw new ValidationError(
      `Failed to resolve DNS for Git host "${hostname}": ${dnsErr instanceof Error ? dnsErr.message : 'lookup error'}`
    );
  }

  if (!addresses || addresses.length === 0) {
    throw new ValidationError(`DNS resolution returned zero records for Git host "${hostname}"`);
  }

  for (const record of addresses) {
    if (record.family === 4 && isPrivateOrBlockedIPv4(record.address)) {
      throw new ValidationError(
        `SSRF protection: Git host "${hostname}" resolved to private/blocked IP ${record.address}`
      );
    }
    if (record.family === 6 && isPrivateOrBlockedIPv6(record.address)) {
      throw new ValidationError(
        `SSRF protection: Git host "${hostname}" resolved to private/blocked IPv6 ${record.address}`
      );
    }
  }

  return { scheme: parsed.scheme, hostname, sanitizedUrl: rawUrl };
}
