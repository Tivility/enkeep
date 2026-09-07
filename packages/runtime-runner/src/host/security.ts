/**
 * Security & Environment Isolation for Host Runtime
 *
 * Implements strict environment filtering, credential placeholder substitution,
 * and path confinement validation to prevent privilege escalation or arbitrary directory access.
 *
 * @module @enkeep/runtime-runner/host/security
 */

import path from 'node:path';
import fs from 'node:fs';
import { HostOwnershipError } from '../spec/provider.js';
import type { HostRuntimeSpec } from './types.js';
import { validateMountSpec, isPathContained } from '../spec/mount-security.js';
import type { RuntimeMountSpec } from '../spec/types.js';

export const ALLOWED_HOST_ENV_KEYS = new Set([
  'PATH',
  'NODE_ENV',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'DSH_USER',
  'ENKEEP_USER_ID',
  'DSH_HOME',
  'DSH_SPACES',
  'DSH_DAEMON_SOCKET_PATH',
  'DSH_MOUNTS_JSON',
  'DSH_MOUNTS_FILE',
  'DSH_MAX_AGENTS',
  'DSH_IDLE_AGENT_TIMEOUT_MS',
  'DSH_MAX_CONCURRENT_SESSIONS',
  'ENKEEP_LLM_ENABLED',
  'ENKEEP_LLM_PROVIDER',
  'ENKEEP_LLM_MODEL',
  'ENKEEP_LLM_BASE_URL',
  'ENKEEP_LLM_PROVIDERS',
  'DSH_LLM_BASE_URL',
  'ENKEEP_LLM_PROXY_TOKEN',
  'ENKEEP_PLATFORM_BASE_URL',
  'ENKEEP_PLATFORM_PROXY_TOKEN',
  'ENKEEP_PLATFORM_TOKEN',
  'IN_CONTAINER_PLACEHOLDER',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
]);

const SENSITIVE_KEY_PATTERNS = [
  /KEY/i,
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /AUTH/i,
  /CREDENTIAL/i,
  /AWS_/i,
  /GITHUB_/i,
  /NPM_/i,
];

/**
 * Resolves a path with realpath traversal across existing parent ancestors.
 */
export function resolveRealPath(p: string): string {
  const resolved = path.resolve(p);
  if (fs.existsSync(resolved)) {
    try {
      return fs.realpathSync(resolved);
    } catch {
      return resolved;
    }
  }
  let cur = resolved;
  const segments: string[] = [];
  while (!fs.existsSync(cur) && path.dirname(cur) !== cur) {
    segments.unshift(path.basename(cur));
    cur = path.dirname(cur);
  }
  const realAncestor = fs.existsSync(cur) ? fs.realpathSync(cur) : cur;
  return path.join(realAncestor, ...segments);
}

export { isPathContained };

/**
 * Validates that the spec paths strictly adhere to the controlled Enkeep data root
 * and forbids arbitrary paths or mounts.
 */
export function validateHostRuntimePaths(spec: {
  userId: string;
  dataRoot: string;
  dshHome: string;
  spacesDir: string;
  runDir: string;
  socketPath?: string;
  mounts?: readonly RuntimeMountSpec[];
}): void {
  if (!spec.userId || typeof spec.userId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(spec.userId)) {
    throw new HostOwnershipError(`Invalid userId in host runtime spec: "${spec.userId}"`);
  }

  if (!spec.dataRoot || !path.isAbsolute(spec.dataRoot)) {
    throw new HostOwnershipError('dataRoot must be a non-empty absolute path');
  }

  const expectedUserRoot = path.join(path.resolve(spec.dataRoot), 'host-runtimes', spec.userId);
  const expectedDshHome = path.join(expectedUserRoot, '.dsh');
  const expectedSpacesDir = path.join(expectedUserRoot, 'spaces');
  const expectedRunDir = path.join(expectedUserRoot, 'run');

  const normDshHome = resolveRealPath(spec.dshHome);
  const normSpacesDir = resolveRealPath(spec.spacesDir);
  const normRunDir = resolveRealPath(spec.runDir);

  const realUserRoot = resolveRealPath(expectedUserRoot);
  const realDshHome = resolveRealPath(expectedDshHome);
  const realSpacesDir = resolveRealPath(expectedSpacesDir);
  const realRunDir = resolveRealPath(expectedRunDir);

  if (
    !isPathContained(normDshHome, realUserRoot) ||
    (normDshHome !== realDshHome && normDshHome !== resolveRealPath(path.join(expectedUserRoot, 'dsh_home')))
  ) {
    throw new HostOwnershipError(
      `DSH_HOME "${spec.dshHome}" must reside strictly at controlled user root "${expectedDshHome}"`
    );
  }

  if (!isPathContained(normSpacesDir, realUserRoot) || normSpacesDir !== realSpacesDir) {
    throw new HostOwnershipError(
      `spacesDir "${spec.spacesDir}" must reside strictly at controlled user root "${expectedSpacesDir}"`
    );
  }

  if (!isPathContained(normRunDir, realUserRoot) || normRunDir !== realRunDir) {
    throw new HostOwnershipError(
      `runDir "${spec.runDir}" must reside strictly at controlled user root "${expectedRunDir}"`
    );
  }

  // Sibling invariant required by dsh-boot: dirname(dshHome) === dirname(spacesDir) and basename(spacesDir) === 'spaces'
  if (path.dirname(normDshHome) !== path.dirname(normSpacesDir) || path.basename(normSpacesDir) !== 'spaces') {
    throw new HostOwnershipError(
      'dshHome and spacesDir must be siblings under the user host runtime root'
    );
  }

  if (spec.socketPath) {
    const normSocket = resolveRealPath(spec.socketPath);
    const isInsideRunDir = isPathContained(normSocket, realRunDir);
    const isSafeShortTmpSocket =
      normSocket.startsWith(resolveRealPath('/tmp')) &&
      /^\/(?:private\/)?tmp\/ek_[0-9a-f]{16}\.sock$/.test(normSocket);

    if (!isInsideRunDir && !isSafeShortTmpSocket) {
      throw new HostOwnershipError(
        `socketPath "${spec.socketPath}" must reside strictly inside runDir "${expectedRunDir}" or safe short path`
      );
    }
  }

  if (spec.mounts) {
    if (!Array.isArray(spec.mounts)) {
      throw new HostOwnershipError('Host spec mounts must be an array');
    }
    const seenIds = new Set<string>();
    for (const m of spec.mounts) {
      const res = validateMountSpec(m, {
        dataRoot: spec.dataRoot,
        dshHome: spec.dshHome,
        spacesDir: spec.spacesDir,
        runDir: spec.runDir,
      });
      if (!res.valid) {
        throw new HostOwnershipError(`Invalid mount spec "${(m as any)?.name}": ${res.errors.join('; ')}`);
      }
      if (seenIds.has(m.id)) {
        throw new HostOwnershipError(`Duplicate mount ID "${m.id}" in host runtime spec`);
      }
      seenIds.add(m.id);
    }
  }
}

/**
 * Builds a strictly filtered environment for the spawned Host daemon child process.
 * Never inherits arbitrary variables or secrets from the parent platform process.
 */
export function filterHostEnvironment(
  spec: HostRuntimeSpec,
  extraAllowlist?: Record<string, string>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  // Standard safe system variables
  env.PATH = process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  env.NODE_ENV = process.env.NODE_ENV || 'production';
  env.LANG = process.env.LANG || 'en_US.UTF-8';
  env.LC_ALL = process.env.LC_ALL || 'en_US.UTF-8';
  env.LC_CTYPE = process.env.LC_CTYPE || 'en_US.UTF-8';

  // Isolated user and home pointing to controlled runtime directories
  env.USER = spec.userId;
  env.LOGNAME = spec.userId;
  env.HOME = spec.dshHome;
  env.TMPDIR = spec.runDir;
  env.TEMP = spec.runDir;
  env.TMP = spec.runDir;

  // DSH Core configuration
  env.DSH_USER = spec.userId;
  env.ENKEEP_USER_ID = spec.userId;
  env.DSH_HOME = spec.dshHome;
  env.DSH_SPACES = spec.spacesDir;
  env.DSH_DAEMON_SOCKET_PATH = spec.socketPath;

  if (spec.mounts && spec.mounts.length > 0) {
    env.DSH_MOUNTS_JSON = JSON.stringify(spec.mounts);
  }

  if (spec.maxAgents !== undefined) {
    env.DSH_MAX_AGENTS = String(spec.maxAgents);
  }
  if (spec.idleAgentTimeoutMs !== undefined) {
    env.DSH_IDLE_AGENT_TIMEOUT_MS = String(spec.idleAgentTimeoutMs);
  }
  if (spec.maxConcurrentSessions !== undefined) {
    env.DSH_MAX_CONCURRENT_SESSIONS = String(spec.maxConcurrentSessions);
  }

  // LLM and placeholder credentials
  env.ENKEEP_LLM_ENABLED = spec.llmEnabled ? '1' : '0';
  if (spec.llmProvider) {
    env.ENKEEP_LLM_PROVIDER = spec.llmProvider;
  }
  if (spec.llmModel) {
    env.ENKEEP_LLM_MODEL = spec.llmModel;
  }
  if (spec.llmBaseUrl) {
    env.ENKEEP_LLM_BASE_URL = spec.llmBaseUrl;
    env.DSH_LLM_BASE_URL = spec.llmBaseUrl;
  }
  if (spec.llmProviders) {
    env.ENKEEP_LLM_PROVIDERS =
      typeof spec.llmProviders === 'string'
        ? spec.llmProviders
        : JSON.stringify(spec.llmProviders);
  }

  if (spec.llmProxyToken) {
    env.ENKEEP_LLM_PROXY_TOKEN = spec.llmProxyToken;
  }

  if (spec.platformBaseUrl) {
    env.ENKEEP_PLATFORM_BASE_URL = spec.platformBaseUrl;
  }

  if (spec.platformProxyToken) {
    env.ENKEEP_PLATFORM_PROXY_TOKEN = spec.platformProxyToken;
    env.ENKEEP_PLATFORM_TOKEN = spec.platformProxyToken;
  }

  // Explicit placeholder values (never real API keys)
  env.IN_CONTAINER_PLACEHOLDER = 'in-container-placeholder';
  env.OPENAI_API_KEY = 'in-container-placeholder';
  env.ANTHROPIC_API_KEY = 'in-container-placeholder';
  env.DEEPSEEK_API_KEY = 'in-container-placeholder';

  // Apply spec.environment overrides if they are explicitly allowed
  if (spec.environment) {
    for (const [key, val] of Object.entries(spec.environment)) {
      if (ALLOWED_HOST_ENV_KEYS.has(key)) {
        let isSensitive = false;
        for (const pattern of SENSITIVE_KEY_PATTERNS) {
          if (pattern.test(key) && key !== 'IN_CONTAINER_PLACEHOLDER') {
            isSensitive = true;
            break;
          }
        }
        if (!isSensitive) {
          env[key] = val;
        }
      }
    }
  }

  if (extraAllowlist) {
    for (const [key, val] of Object.entries(extraAllowlist)) {
      if (ALLOWED_HOST_ENV_KEYS.has(key)) {
        env[key] = val;
      }
    }
  }

  return env;
}
