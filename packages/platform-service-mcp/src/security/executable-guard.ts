/**
 * Executable Allowlist and Direct Argv Guard
 *
 * Enforces:
 * - Direct argv execution only (NEVER shell interpolated, no `sh -c`, `cmd.exe`, etc.)
 * - Strict allowlist of binaries (e.g. `node`, `python3`, `bun`, `bunx`, `npx`, `uvx`, `pnpm`, `deno`, or specific paths within package roots)
 * - Absolute path containment validation (no `..` traversal out of package roots)
 * - Rejection of shell metacharacters in executable name or direct invocation of dangerous shells
 * - Extension contribution manifest validation and Admin approval checks
 *
 * @module @enkeep/platform-service-mcp/security/executable-guard
 */

import { resolve, normalize, isAbsolute, relative } from 'node:path';
import { McpErrorCode, McpServiceError } from '../errors.js';
import type {
  McpContributionManifest,
  McpServerDescriptor,
  McpStdioServerDescriptor,
  McpHttpServerDescriptor,
} from '../types.js';

export const DEFAULT_ALLOWED_EXECUTABLE_NAMES = [
  'node',
  'nodejs',
  'bun',
  'bunx',
  'python',
  'python3',
  'npx',
  'uvx',
  'pnpm',
  'deno',
] as const;

export const FORBIDDEN_SHELL_NAMES = [
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'wscript',
  'cscript',
] as const;

const DANGEROUS_SHELL_CHARS_REGEX = /[;&|`$><!\n\r\t]/;

export interface ExecutableValidationOptions {
  readonly globalAllowlist?: readonly string[];
  readonly serverAllowlist?: readonly string[];
  readonly packageRoots?: readonly string[];
}

/**
 * Validates whether a command and its arguments are safe to spawn directly.
 */
export function validateExecutable(
  command: string,
  args: readonly string[] = [],
  options: ExecutableValidationOptions = {},
): { resolvedCommand: string; resolvedArgs: string[] } {
  if (!command || typeof command !== 'string') {
    throw new McpServiceError('Executable command is empty or invalid', {
      code: McpErrorCode.MCP_SPAWN_FORBIDDEN,
    });
  }

  const trimmed = command.trim();

  // 1. Reject shell metacharacters in executable command
  if (DANGEROUS_SHELL_CHARS_REGEX.test(trimmed)) {
    throw new McpServiceError('Executable command contains forbidden shell metacharacters', {
      code: McpErrorCode.MCP_SPAWN_FORBIDDEN,
      details: { command: trimmed },
    });
  }

  // 2. Reject shell metacharacters or template injections in arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== 'string') {
      throw new McpServiceError(`Argument at index ${i} is not a valid string`, {
        code: McpErrorCode.MCP_INVALID_ARGUMENTS,
      });
    }
    if (DANGEROUS_SHELL_CHARS_REGEX.test(arg)) {
      throw new McpServiceError(
        `Argument "${arg}" at index ${i} contains forbidden shell metacharacters. Direct argv execution only.`,
        {
          code: McpErrorCode.MCP_SPAWN_FORBIDDEN,
          details: { arg, index: i },
        },
      );
    }
  }

  // 3. Extract binary name
  const isPath = trimmed.includes('/') || trimmed.includes('\\');
  const baseName = isPath ? trimmed.split(/[/\\]/).pop()! : trimmed;

  // 4. Reject direct shells
  if (FORBIDDEN_SHELL_NAMES.includes(baseName.toLowerCase() as any)) {
    throw new McpServiceError(
      `Direct shell invocation of "${baseName}" is forbidden by security policy`,
      {
        code: McpErrorCode.MCP_SPAWN_FORBIDDEN,
        details: { command: trimmed },
      },
    );
  }

  const allowedNames = new Set<string>([
    ...DEFAULT_ALLOWED_EXECUTABLE_NAMES,
    ...(options.globalAllowlist ?? []).map((x) => x.toLowerCase()),
    ...(options.serverAllowlist ?? []).map((x) => x.toLowerCase()),
  ]);

  // 5. Check if standard allowed binary name
  if (!isPath) {
    if (allowedNames.has(trimmed.toLowerCase())) {
      return { resolvedCommand: trimmed, resolvedArgs: [...args] };
    }

    throw new McpServiceError(
      `Binary "${trimmed}" is not in the allowlist of permitted MCP executables`,
      {
        code: McpErrorCode.MCP_SPAWN_FORBIDDEN,
        details: { command: trimmed, allowed: Array.from(allowedNames) },
      },
    );
  }

  // 6. If it's a path, check if it's within allowlisted package roots or server allowlist
  const normalizedPath = normalize(resolve(trimmed));

  // Check if explicit path is in server allowlist or global allowlist
  const isExplicitlyAllowed = (options.serverAllowlist ?? [])
    .concat(options.globalAllowlist ?? [])
    .some((allowed) => normalize(resolve(allowed)) === normalizedPath);

  if (isExplicitlyAllowed) {
    return { resolvedCommand: normalizedPath, resolvedArgs: [...args] };
  }

  // Check containment within packageRoots
  const packageRoots = options.packageRoots ?? [];
  let isContainedInRoot = false;
  for (const root of packageRoots) {
    const normRoot = normalize(resolve(root));
    const rel = relative(normRoot, normalizedPath);
    if (!rel.startsWith('..') && !isAbsolute(rel)) {
      isContainedInRoot = true;
      break;
    }
  }

  if (isContainedInRoot) {
    return { resolvedCommand: normalizedPath, resolvedArgs: [...args] };
  }

  // Check if base binary is in allowedNames (e.g. /usr/local/bin/node or /usr/bin/python3)
  if (allowedNames.has(baseName.toLowerCase())) {
    return { resolvedCommand: normalizedPath, resolvedArgs: [...args] };
  }

  throw new McpServiceError(
    `Executable path "${trimmed}" is not contained in allowlisted package roots and not on allowlist`,
    {
      code: McpErrorCode.MCP_SPAWN_FORBIDDEN,
      details: { command: trimmed, resolvedPath: normalizedPath },
    },
  );
}

export interface ManifestValidationOptions {
  readonly requireAdminApproval?: boolean;
  readonly globalAllowlist?: readonly string[];
}

/**
 * Validates and normalizes an MCP contribution manifest received from an extension or platform config.
 */
export function validateMcpContributionManifest(
  manifest: McpContributionManifest,
  options: ManifestValidationOptions = {},
): McpServerDescriptor {
  if (!manifest || typeof manifest !== 'object') {
    throw new McpServiceError('Contribution manifest must be a non-null object', {
      code: McpErrorCode.MCP_BAD_REQUEST,
    });
  }

  const id = manifest.id || (manifest as any).contributionId;
  if (!id || typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(id)) {
    throw new McpServiceError(`Invalid contribution manifest ID "${id}"`, {
      code: McpErrorCode.MCP_BAD_REQUEST,
      details: { id },
    });
  }

  const transport = manifest.transport;
  if (transport !== 'stdio' && transport !== 'streamable-http' && transport !== 'http') {
    throw new McpServiceError(`Unsupported MCP transport "${transport}". Must be 'stdio' or 'http'`, {
      code: McpErrorCode.MCP_BAD_REQUEST,
      details: { transport },
    });
  }

  // Security Policy Check:
  // User extensions with MCP contributions require Admin approval / enable
  const source = manifest.source ?? 'builtin';
  const isUserExtension = source === 'user-extension' || source === 'extension';
  if (options.requireAdminApproval !== false && isUserExtension && !manifest.adminApproved) {
    throw new McpServiceError(
      `MCP contribution "${id}" from extension requires Admin approval before activation`,
      {
        code: McpErrorCode.MCP_APPROVAL_REQUIRED,
        details: { contributionId: id, source },
      },
    );
  }

  if (transport === 'stdio') {
    const stdio = manifest as McpStdioServerDescriptor;
    if (!stdio.command || typeof stdio.command !== 'string') {
      throw new McpServiceError(`Missing command in stdio contribution manifest for "${id}"`, {
        code: McpErrorCode.MCP_BAD_REQUEST,
      });
    }

    const argv = stdio.argv ?? stdio.args ?? [];
    // Validate executable and args
    const { resolvedCommand, resolvedArgs } = validateExecutable(
      stdio.command,
      argv,
      {
        globalAllowlist: options.globalAllowlist,
        serverAllowlist: stdio.allowlistedExecutables,
        packageRoots: stdio.packageRoots,
      },
    );

    return {
      ...stdio,
      id,
      contributionId: (manifest as any).contributionId || id,
      name: stdio.name || id,
      transport: 'stdio',
      command: resolvedCommand,
      args: resolvedArgs,
      argv: resolvedArgs,
    };
  } else {
    const http = manifest as McpHttpServerDescriptor;
    if (!http.url || typeof http.url !== 'string') {
      throw new McpServiceError(`Missing url in HTTP contribution manifest for "${id}"`, {
        code: McpErrorCode.MCP_BAD_REQUEST,
      });
    }

    return {
      ...http,
      id,
      contributionId: (manifest as any).contributionId || id,
      name: http.name || id,
      transport: 'streamable-http',
      url: http.url,
    };
  }
}
