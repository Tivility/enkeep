/**
 * Environment Variable Whitelisting and Dangerous Env Stripper
 *
 * Prevents LD_PRELOAD, NODE_OPTIONS, DYLD_*, AWS_*, DSH internal tokens,
 * and host-level credentials from leaking into spawned MCP processes.
 *
 * @module @enkeep/platform-service-mcp/security/env-filter
 */

import { McpErrorCode, McpServiceError } from '../errors.js';

export const DEFAULT_ALLOWED_ENV_VARS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SHELL',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TZ',
  'NODE_ENV',
] as const;

export const DANGEROUS_ENV_PREFIXES = [
  'LD_',
  'DYLD_',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'BUN_INSPECT',
  'DENO_DIR',
  'PYTHON',
  'RUBYOPT',
  'PERL5OPT',
  'SUDO_',
  'SSH_',
  'SSL_',
  'GCM_',
  'AWS_',
  'GOOGLE_',
  'AZURE_',
  'DSH_',
  'ENKEEP_',
  'BOTMUX_',
] as const;

/**
 * Checks whether an environment variable name is considered dangerous.
 */
export function isDangerousEnvVar(key: string): boolean {
  const upper = key.trim().toUpperCase();
  if (
    upper === 'NODE_OPTIONS' ||
    upper === 'NODE_EXTRA_CA_CERTS' ||
    upper === 'PYTHONOPTIMIZE' ||
    upper === 'PERLLIB' ||
    upper === 'PERL5LIB'
  ) {
    return true;
  }
  return DANGEROUS_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export interface EnvFilterOptions {
  /** Optional custom allowed env var names */
  readonly customAllowed?: readonly string[];
  /** Allow specific server-defined env keys if they pass the safety check */
  readonly allowServerConfigured?: boolean;
}

/**
 * Filters and sanitizes environment variables for downstream child process spawn.
 */
export function filterChildEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env,
  serverEnv: Record<string, string> = {},
  ephemeralEnv: Record<string, string> = {},
  options: EnvFilterOptions = {},
): Record<string, string> {
  const allowedSet = new Set<string>([
    ...DEFAULT_ALLOWED_ENV_VARS,
    ...(options.customAllowed ?? []).map((k) => k.toUpperCase()),
  ]);

  const result: Record<string, string> = {};

  // 1. Copy allowed base environment variables
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (allowedSet.has(upper) && !isDangerousEnvVar(upper)) {
      result[key] = value;
    }
  }

  // 2. Merge server-configured static environment variables
  for (const [key, value] of Object.entries(serverEnv)) {
    if (value === undefined) continue;
    if (isDangerousEnvVar(key)) {
      throw new McpServiceError(
        `Environment variable "${key}" is rejected by security policy`,
        {
          code: McpErrorCode.MCP_ENV_VIOLATION,
          details: { rejectedKey: key },
        },
      );
    }
    result[key] = value;
  }

  // 3. Merge ephemeral credentials (e.g. API keys for the downstream MCP server)
  for (const [key, value] of Object.entries(ephemeralEnv)) {
    if (value === undefined) continue;
    if (isDangerousEnvVar(key)) {
      throw new McpServiceError(
        `Ephemeral credential environment variable "${key}" is rejected by security policy`,
        {
          code: McpErrorCode.MCP_ENV_VIOLATION,
          details: { rejectedKey: key },
        },
      );
    }
    result[key] = value;
  }

  return result;
}
