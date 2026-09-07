/**
 * MCP Security Policy & Command Guard
 *
 * Enforces:
 * - Strict non-plaintext secrets policy (zero secrets stored in DB plaintext)
 * - Command execution allowlist (only admin-configured or safe binaries allowed for regular users)
 * - Prevention of arbitrary shell command execution (argv array only, no shell interpolation)
 * - SSRF protection on HTTP endpoints (rejecting loopback/private/metadata ranges)
 * - Rejection of embedded credentials in URLs and header keys
 *
 * @module @enkeep/platform-server/mcp/security-policy
 */

import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import path from 'node:path';
import { ValidationError, ForbiddenError } from '@enkeep/platform-core';
import {
  isPrivateOrBlockedIPv4,
  isPrivateOrBlockedIPv6,
} from '../notifications/webhook-security-policy.js';

/**
 * Standard allowlisted command binaries permitted for standard (non-admin) users.
 * Regular users cannot supply arbitrary host binaries.
 */
export const DEFAULT_ALLOWED_STDIO_BINARIES: readonly string[] = Object.freeze([
  'node',
  'npx',
  'python',
  'python3',
  'uvx',
  'bun',
  'bunx',
  'deno',
]);

/**
 * Sensitive field names that are strictly forbidden in plaintext headers, env, or payloads.
 */
export const SENSITIVE_FORBIDDEN_MCP_KEYS: readonly string[] = Object.freeze([
  'authorization',
  'auth_token',
  'authtoken',
  'api_key',
  'apikey',
  'secret',
  'password',
  'token',
  'private_key',
  'privatekey',
  'bearer',
]);

export interface McpSecurityPolicyOptions {
  allowedStdioBinaries?: readonly string[];
  allowInsecureHttp?: boolean;
  allowTestLoopback?: boolean;
  allowedHosts?: readonly string[];
}

export const DEFAULT_MCP_SECURITY_POLICY: Required<McpSecurityPolicyOptions> = Object.freeze({
  allowedStdioBinaries: DEFAULT_ALLOWED_STDIO_BINARIES,
  allowInsecureHttp: false,
  allowTestLoopback: false,
  allowedHosts: Object.freeze([]),
});

/**
 * Validates that command argv does not contain shell operators or suspicious shell execution wrappers.
 */
export function validateCommandArgv(command: readonly string[]): void {
  if (!Array.isArray(command) || command.length === 0) {
    throw new ValidationError('MCP command must be a non-empty array of argument strings');
  }

  for (let i = 0; i < command.length; i++) {
    const arg = command[i];
    if (typeof arg !== 'string' || !arg.trim()) {
      throw new ValidationError(`MCP command argument at index ${i} must be a non-empty string`);
    }

    // Shell metacharacter detection
    if (/[;&|`$<>]/.test(arg)) {
      throw new ValidationError(
        `MCP command argument at index ${i} contains forbidden shell metacharacters: "${arg}". Commands are executed directly via argv without shell interpolation.`
      );
    }

    // Check for runtime template expressions ${VAR}
    if (/\$\{[^}]+\}/.test(arg)) {
      throw new ValidationError(
        `MCP command argument at index ${i} contains forbidden template variable syntax: "${arg}". Use static parameters and credentialRef.`
      );
    }
  }

  // Check binary name (argv[0])
  const binary = path.basename(command[0]);
  const forbiddenShells = ['sh', 'bash', 'zsh', 'csh', 'ksh', 'cmd.exe', 'powershell.exe', 'pwsh'];
  if (forbiddenShells.includes(binary.toLowerCase())) {
    throw new ValidationError(
      `Direct shell invocation (${binary}) is strictly forbidden as MCP stdio binary. Specify the target CLI tool directly.`
    );
  }
}

/**
 * Validates whether a user is authorized to execute the specified stdio command binary.
 * Admins can execute any valid binary; standard users can ONLY execute allowlisted binaries.
 */
export function validateUserCommandAuthorization(
  command: readonly string[],
  userRole: string,
  policy: McpSecurityPolicyOptions = DEFAULT_MCP_SECURITY_POLICY
): void {
  validateCommandArgv(command);

  if (userRole === 'admin') {
    return; // Admin authorized
  }

  const binary = path.basename(command[0]);
  const allowedList = policy.allowedStdioBinaries ?? DEFAULT_ALLOWED_STDIO_BINARIES;
  const isAllowed = allowedList.some((allowed) => allowed.toLowerCase() === binary.toLowerCase());

  if (!isAllowed) {
    throw new ForbiddenError(
      `Non-admin users cannot configure arbitrary host binary "${binary}". Permitted binaries: ${allowedList.join(', ')}.`
    );
  }
}

/**
 * Validates environment template dictionary. Ensures no plaintext secrets are embedded.
 */
export function validateEnvTemplate(env?: Record<string, string> | null): Record<string, string> | undefined {
  if (!env) return undefined;
  if (typeof env !== 'object' || Array.isArray(env)) {
    throw new ValidationError('envTemplate must be a key-value dictionary object');
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new ValidationError(`Invalid environment variable key: "${key}"`);
    }
    if (typeof value !== 'string') {
      throw new ValidationError(`Environment variable value for "${key}" must be a string`);
    }

    const lowerKey = key.toLowerCase();
    for (const forbidden of SENSITIVE_FORBIDDEN_MCP_KEYS) {
      if (lowerKey.includes(forbidden)) {
        throw new ValidationError(
          `Environment variable "${key}" appears to contain sensitive credentials. Plaintext secrets in DB are strictly forbidden. Use credentialRef.`
        );
      }
    }

    if (/\$\{[^}]+\}/.test(value)) {
      throw new ValidationError(`Environment variable "${key}" contains unsupported runtime template syntax: "${value}"`);
    }

    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validates headers dictionary. Ensures no sensitive authorization headers are stored in plaintext.
 */
export function validateHeaders(headers?: Record<string, string> | null): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    throw new ValidationError('headers must be a key-value dictionary object');
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const trimmedKey = key.trim();
    if (!trimmedKey || /[\r\n]/.test(trimmedKey)) {
      throw new ValidationError(`Invalid header name: "${key}"`);
    }
    if (typeof value !== 'string' || /[\r\n]/.test(value)) {
      throw new ValidationError(`Invalid header value for "${key}"`);
    }

    const lowerKey = trimmedKey.toLowerCase();
    if (lowerKey === 'authorization' || lowerKey.includes('secret') || lowerKey.includes('token') || lowerKey.includes('api-key')) {
      throw new ValidationError(
        `Header "${key}" appears to contain sensitive credentials. Pass authentication via secure credential reference (credentialRef).`
      );
    }

    out[trimmedKey] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validates an MCP HTTP URL against SSRF policies.
 */
export async function validateMcpHttpUrl(
  rawUrl: string,
  policy: McpSecurityPolicyOptions = DEFAULT_MCP_SECURITY_POLICY
): Promise<string> {
  if (typeof rawUrl !== 'string' || !rawUrl || rawUrl.trim() !== rawUrl) {
    throw new ValidationError('MCP HTTP URL must be a non-empty string without leading or trailing whitespace');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ValidationError(`Malformed MCP HTTP URL: "${rawUrl}"`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(`Invalid MCP URL protocol "${parsed.protocol}". Only http: and https: are supported.`);
  }

  if (parsed.username || parsed.password) {
    throw new ValidationError('Embedded credentials (username:password) in MCP URL are strictly prohibited.');
  }

  if (parsed.protocol === 'http:' && !policy.allowInsecureHttp && !policy.allowTestLoopback) {
    throw new ValidationError('Insecure http:// is prohibited for remote MCP endpoints. Use https:// or enable allowInsecureHttp.');
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    throw new ValidationError('MCP URL must have a valid hostname');
  }

  const allowedHosts = policy.allowedHosts ?? [];
  if (allowedHosts.includes(hostname)) {
    return parsed.toString();
  }

  if (policy.allowTestLoopback && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1')) {
    return parsed.toString();
  }

  const ipVer = isIP(hostname);
  if (ipVer === 4) {
    if (isPrivateOrBlockedIPv4(hostname)) {
      throw new ValidationError(`SSRF protection: MCP host IP "${hostname}" is in a private or loopback range.`);
    }
    return parsed.toString();
  } else if (ipVer === 6) {
    if (isPrivateOrBlockedIPv6(hostname)) {
      throw new ValidationError(`SSRF protection: MCP host IPv6 "${hostname}" is in a private or loopback range.`);
    }
    return parsed.toString();
  }

  const lowerHost = hostname.toLowerCase();
  if (
    lowerHost === 'localhost' ||
    lowerHost.endsWith('.localhost') ||
    lowerHost === 'metadata.google.internal' ||
    lowerHost === 'instance-data'
  ) {
    throw new ValidationError(`SSRF protection: MCP host "${hostname}" is a forbidden loopback or metadata domain.`);
  }

  // Pre-flight DNS resolution
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (dnsErr) {
    throw new ValidationError(
      `Failed to resolve DNS for MCP host "${hostname}": ${dnsErr instanceof Error ? dnsErr.message : 'lookup error'}`
    );
  }

  if (!addresses || addresses.length === 0) {
    throw new ValidationError(`DNS resolution returned zero records for MCP host "${hostname}"`);
  }

  for (const record of addresses) {
    if (record.family === 4 && isPrivateOrBlockedIPv4(record.address)) {
      throw new ValidationError(`SSRF protection: MCP host "${hostname}" resolved to private/blocked IP ${record.address}`);
    }
    if (record.family === 6 && isPrivateOrBlockedIPv6(record.address)) {
      throw new ValidationError(`SSRF protection: MCP host "${hostname}" resolved to private/blocked IPv6 ${record.address}`);
    }
  }

  return parsed.toString();
}
