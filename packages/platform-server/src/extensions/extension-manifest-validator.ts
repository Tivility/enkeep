/**
 * Canonical Extension Manifest and Package Validation
 *
 * Implements authoritative validation for extension.json and staged extension packages:
 * - schemaVersion: 1
 * - slug, name, description
 * - contributions array (1..16 contributions)
 * - kind: 'skill' | 'mcp' (fails closed on unknown or future kinds)
 * - Strict non-plaintext secrets check across manifest, env, headers, and contributions
 * - MCP transport validation ('stdio' | 'streamable-http')
 * - Command / argv / template syntax validation
 * - SSRF / URL validation for streamable-http endpoints
 * - Credential references as opaque strings / IDs only (never secrets)
 * - Safe DTO serialization
 *
 * @module @enkeep/platform-server/extensions/extension-manifest-validator
 */

import path from 'node:path';
import { ValidationError, type ExtensionKind } from '@enkeep/platform-core';
import { validateSkillName, SKILL_NAME_PATTERN } from '../skills/security-validator.js';
import {
  validateCommandArgv,
  validateEnvTemplate,
  validateHeaders,
  SENSITIVE_FORBIDDEN_MCP_KEYS,
} from '../mcp/security-policy.js';

export interface CanonicalMcpManifest {
  name?: string;
  description?: string;
  whenToUse?: string;
  transport: 'stdio' | 'streamable-http';
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  credentialRefs?: Array<{ id: string; type?: string; scope?: string }>;
  toolTimeoutMs?: number;
  initTimeoutMs?: number;
  maxOutputBytes?: number;
  tools?: string[];
  invocation?: {
    modelInvocable?: boolean;
    userInvocable?: boolean;
  };
  [key: string]: unknown;
}

export interface CanonicalSkillManifest {
  name?: string;
  description?: string;
  whenToUse?: string;
  entrypoint?: string;
  invocation?: {
    modelInvocable?: boolean;
    userInvocable?: boolean;
  };
  [key: string]: unknown;
}

export interface CanonicalCliManifest {
  name?: string;
  description?: string;
  whenToUse?: string;
  command?: string;
  script: string;
  args?: string[];
  fixedArgs?: string[];
  executionMode?: 'container' | 'host' | 'space';
  timeoutMs?: number;
  invocation?: {
    modelInvocable?: boolean;
    userInvocable?: boolean;
  };
  [key: string]: unknown;
}

export interface CanonicalExtensionContribution {
  kind: ExtensionKind;
  key: string;
  manifest: CanonicalMcpManifest | CanonicalSkillManifest | CanonicalCliManifest | Record<string, unknown>;
}

export interface CanonicalExtensionJson {
  schemaVersion: number;
  slug: string;
  name: string;
  description?: string | null;
  contributions: CanonicalExtensionContribution[];
}

export interface ValidatedExtensionPayload {
  slug: string;
  name: string;
  description?: string | null;
  contributions: CanonicalExtensionContribution[];
  isMcp: boolean;
  isCli?: boolean;
  content?: string;
  metadata?: Record<string, unknown>;
  contentHash: string;
  fileCount: number;
  totalBytes: number;
}

export const MAX_CONTRIBUTIONS_PER_PACKAGE = 16;

/**
 * Checks whether an object or string contains sensitive / forbidden secret field names or values.
 * Recursively inspects objects and arrays.
 */
export function assertNoSecretFieldsInManifest(
  obj: unknown,
  pathPrefix = 'manifest'
): void {
  if (!obj || typeof obj !== 'object') {
    return;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      assertNoSecretFieldsInManifest(obj[i], `${pathPrefix}[${i}]`);
    }
    return;
  }

  const record = obj as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    const lowerKey = key.toLowerCase();

    // Inside credentialRefs array items, 'id', 'type', 'scope' are allowed reference identifiers
    if (pathPrefix.endsWith('credentialRefs') || pathPrefix.includes('credentialRefs[')) {
      if (key === 'id' || key === 'type' || key === 'scope') {
        if (typeof value === 'string') {
          // Verify that the reference id itself is not a raw token
          if (/^(?:ghp_|gho_|github_pat_|sk-[a-zA-Z0-9]{20,}|Bearer\s+|ey[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,})/.test(value)) {
            throw new ValidationError(
              `Credential reference "${key}" at "${pathPrefix}.${key}" appears to be a raw secret token instead of an opaque credential reference ID.`
            );
          }
        }
        continue;
      }
    }

    for (const forbidden of SENSITIVE_FORBIDDEN_MCP_KEYS) {
      if (lowerKey === forbidden || lowerKey.replace(/[-_]/g, '') === forbidden.replace(/[-_]/g, '')) {
        throw new ValidationError(
          `Plaintext secret field "${key}" at "${pathPrefix}.${key}" is strictly forbidden in extension manifest. Pass credentials via secure credential reference (credentialRef).`
        );
      }
    }

    if (value && typeof value === 'object') {
      assertNoSecretFieldsInManifest(value, `${pathPrefix}.${key}`);
    }
  }
}

/**
 * Validates a parsed extension.json object against the canonical specification.
 */
export function validateExtensionJson(rawJson: unknown): CanonicalExtensionJson {
  if (!rawJson || typeof rawJson !== 'object' || Array.isArray(rawJson)) {
    throw new ValidationError('extension.json must be a JSON object');
  }

  const raw = rawJson as Record<string, unknown>;

  // 1. schemaVersion
  if (raw.schemaVersion !== 1) {
    throw new ValidationError(
      `Unsupported extension.json schemaVersion: ${String(raw.schemaVersion)}. schemaVersion must be 1.`
    );
  }

  // 2. slug
  if (typeof raw.slug !== 'string' || !raw.slug.trim()) {
    throw new ValidationError('extension.json requires a non-empty string "slug" field');
  }
  const slug = raw.slug.trim();
  validateSkillName(slug);

  // 3. name
  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    throw new ValidationError('extension.json requires a non-empty string "name" field');
  }
  const name = raw.name.trim();
  if (name.normalize('NFC') !== name) {
    throw new ValidationError('extension.json "name" field must be in Unicode NFC form');
  }
  if (name.length > 128) {
    throw new ValidationError('extension.json "name" field exceeds maximum length of 128 characters');
  }

  // 4. description
  let description: string | null = null;
  if (raw.description !== undefined && raw.description !== null) {
    if (typeof raw.description !== 'string') {
      throw new ValidationError('extension.json "description" must be a string if provided');
    }
    description = raw.description.trim();
    if (description.length > 2048) {
      throw new ValidationError('extension.json "description" exceeds maximum length of 2048 characters');
    }
  }

  // 5. contributions
  if (!Array.isArray(raw.contributions) || raw.contributions.length === 0) {
    throw new ValidationError('extension.json requires a non-empty "contributions" array');
  }

  if (raw.contributions.length > MAX_CONTRIBUTIONS_PER_PACKAGE) {
    throw new ValidationError(
      `extension.json "contributions" exceeds maximum allowed limit of ${MAX_CONTRIBUTIONS_PER_PACKAGE} items`
    );
  }

  // Global secret scan
  assertNoSecretFieldsInManifest(raw, 'extension.json');

  const validatedContribs: CanonicalExtensionContribution[] = [];
  let packageKind: ExtensionKind | null = null;

  for (let i = 0; i < raw.contributions.length; i++) {
    const item = raw.contributions[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ValidationError(`extension.json contribution at index ${i} must be an object`);
    }

    const c = item as Record<string, unknown>;
    const kind = c.kind as ExtensionKind;

    // Strict kind check: only 'skill', 'mcp', and 'cli' are supported for user uploads
    if (kind === 'dsh-plugin') {
      throw new ValidationError(
        `FAIL-CLOSED: Contribution kind "dsh-plugin" at index ${i} is strictly forbidden in user uploaded packages. Only compiled platform trusted plugins can create dsh-plugin contributions.`
      );
    }

    if (kind !== 'skill' && kind !== 'mcp' && kind !== 'cli') {
      throw new ValidationError(
        `FAIL-CLOSED: Unsupported or invalid contribution kind "${String(kind)}" at index ${i}. Supported kinds: "skill", "mcp", "cli".`
      );
    }

    // Single-kind invariant per package in P1-2
    if (packageKind === null) {
      packageKind = kind;
    } else if (packageKind !== kind) {
      throw new ValidationError(
        `Mixed contribution kinds in single package are prohibited in P1 (found "${packageKind}" and "${kind}")`
      );
    }

    if (kind === 'mcp' && validatedContribs.length >= 1) {
      throw new ValidationError('P1 allows at most one MCP contribution per extension package');
    }

    // Contribution key
    if (typeof c.key !== 'string' || !c.key.trim()) {
      throw new ValidationError(`extension.json contribution at index ${i} requires a non-empty "key" string`);
    }
    const key = c.key.trim();
    validateSkillName(key);

    // Contribution manifest
    if (!c.manifest || typeof c.manifest !== 'object' || Array.isArray(c.manifest)) {
      throw new ValidationError(`extension.json contribution at index ${i} requires a "manifest" object`);
    }

    const manifestObj = c.manifest as Record<string, unknown>;

    if (kind === 'mcp') {
      const validatedMcpManifest = validateMcpManifest(manifestObj, `contributions[${i}].manifest`);
      validatedContribs.push({
        kind: 'mcp',
        key,
        manifest: validatedMcpManifest,
      });
    } else if (kind === 'skill') {
      const validatedSkillManifest = validateSkillManifest(manifestObj, `contributions[${i}].manifest`);
      validatedContribs.push({
        kind: 'skill',
        key,
        manifest: validatedSkillManifest,
      });
    } else if (kind === 'cli') {
      const validatedCliManifest = validateCliManifest(manifestObj, `contributions[${i}].manifest`);
      validatedContribs.push({
        kind: 'cli',
        key,
        manifest: validatedCliManifest,
      });
    }
  }

  return {
    schemaVersion: 1,
    slug,
    name,
    description,
    contributions: validatedContribs,
  };
}

/**
 * Validates MCP contribution manifest properties.
 */
export function validateMcpManifest(manifest: Record<string, unknown>, contextPath = 'manifest'): CanonicalMcpManifest {
  const transport = manifest.transport;
  if (transport !== 'stdio' && transport !== 'streamable-http') {
    throw new ValidationError(
      `${contextPath} requires "transport" to be "stdio" or "streamable-http", got "${String(transport)}"`
    );
  }

  const out: CanonicalMcpManifest = {
    ...manifest,
    transport,
  };

  if (manifest.name !== undefined) {
    if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
      throw new ValidationError(`${contextPath}.name must be a non-empty string`);
    }
    out.name = manifest.name.trim();
  }

  if (manifest.description !== undefined && manifest.description !== null) {
    if (typeof manifest.description !== 'string') {
      throw new ValidationError(`${contextPath}.description must be a string`);
    }
    out.description = manifest.description.trim();
  }

  if (manifest.whenToUse !== undefined && manifest.whenToUse !== null) {
    if (typeof manifest.whenToUse !== 'string') {
      throw new ValidationError(`${contextPath}.whenToUse must be a string`);
    }
    out.whenToUse = manifest.whenToUse.trim();
  }

  // Validate CredentialRefs
  if (manifest.credentialRefs !== undefined && manifest.credentialRefs !== null) {
    if (!Array.isArray(manifest.credentialRefs)) {
      throw new ValidationError(`${contextPath}.credentialRefs must be an array of credential reference objects or string IDs`);
    }
    const refs: Array<{ id: string; type?: string; scope?: string }> = [];
    for (let j = 0; j < manifest.credentialRefs.length; j++) {
      const refItem = manifest.credentialRefs[j];
      if (typeof refItem === 'string') {
        const id = refItem.trim();
        if (!id) {
          throw new ValidationError(`${contextPath}.credentialRefs[${j}] string ID cannot be empty`);
        }
        refs.push({ id });
      } else if (refItem && typeof refItem === 'object' && !Array.isArray(refItem)) {
        const r = refItem as Record<string, unknown>;
        if (typeof r.id !== 'string' || !r.id.trim()) {
          throw new ValidationError(`${contextPath}.credentialRefs[${j}] requires a non-empty string "id"`);
        }
        refs.push({
          id: r.id.trim(),
          type: typeof r.type === 'string' && r.type.trim() ? r.type.trim() : undefined,
          scope: typeof r.scope === 'string' && r.scope.trim() ? r.scope.trim() : undefined,
        });
      } else {
        throw new ValidationError(`${contextPath}.credentialRefs[${j}] must be an object with "id" or a string ID`);
      }
    }
    out.credentialRefs = refs;
  }

  if (transport === 'stdio') {
    if (typeof manifest.command !== 'string' || !manifest.command.trim()) {
      throw new ValidationError(`${contextPath} for stdio transport requires a non-empty "command" string`);
    }
    const command = manifest.command.trim();

    let args: string[] = [];
    if (manifest.args !== undefined && manifest.args !== null) {
      if (!Array.isArray(manifest.args)) {
        throw new ValidationError(`${contextPath}.args must be an array of strings`);
      }
      args = manifest.args.map((a, idx) => {
        if (typeof a !== 'string' || !a.trim()) {
          throw new ValidationError(`${contextPath}.args[${idx}] must be a non-empty string`);
        }
        return a.trim();
      });
    }

    // Validate command argv safety
    validateCommandArgv([command, ...args]);
    out.command = command;
    out.args = args.length > 0 ? args : undefined;

    if (manifest.cwd !== undefined && manifest.cwd !== null) {
      if (typeof manifest.cwd !== 'string' || !manifest.cwd.trim()) {
        throw new ValidationError(`${contextPath}.cwd must be a non-empty string`);
      }
      out.cwd = manifest.cwd.trim();
    }

    if (manifest.env !== undefined && manifest.env !== null) {
      out.env = validateEnvTemplate(manifest.env as Record<string, string>);
    }
  } else if (transport === 'streamable-http') {
    if (typeof manifest.url !== 'string' || !manifest.url.trim()) {
      throw new ValidationError(`${contextPath} for streamable-http transport requires a non-empty "url" string`);
    }
    const rawUrl = manifest.url.trim();
    if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
      throw new ValidationError(`${contextPath}.url must start with http:// or https://`);
    }
    try {
      const parsed = new URL(rawUrl);
      if (parsed.username || parsed.password) {
        throw new ValidationError('Embedded credentials in MCP HTTP URL are strictly prohibited');
      }
    } catch {
      throw new ValidationError(`Malformed MCP HTTP URL: "${rawUrl}"`);
    }
    out.url = rawUrl;

    if (manifest.headers !== undefined && manifest.headers !== null) {
      out.headers = validateHeaders(manifest.headers as Record<string, string>);
    }
  }

  if (manifest.toolTimeoutMs !== undefined && manifest.toolTimeoutMs !== null) {
    if (typeof manifest.toolTimeoutMs !== 'number' || manifest.toolTimeoutMs <= 0 || !Number.isFinite(manifest.toolTimeoutMs)) {
      throw new ValidationError(`${contextPath}.toolTimeoutMs must be a positive number`);
    }
    out.toolTimeoutMs = manifest.toolTimeoutMs;
  }

  return out;
}

/**
 * Validates Skill contribution manifest properties.
 */
export function validateSkillManifest(manifest: Record<string, unknown>, contextPath = 'manifest'): CanonicalSkillManifest {
  const out: CanonicalSkillManifest = {
    ...manifest,
  };

  if (manifest.name !== undefined) {
    if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
      throw new ValidationError(`${contextPath}.name must be a non-empty string`);
    }
    out.name = manifest.name.trim();
  }

  if (manifest.description !== undefined && manifest.description !== null) {
    if (typeof manifest.description !== 'string') {
      throw new ValidationError(`${contextPath}.description must be a string`);
    }
    out.description = manifest.description.trim();
  }

  if (manifest.entrypoint !== undefined && manifest.entrypoint !== null) {
    if (typeof manifest.entrypoint !== 'string' || !manifest.entrypoint.trim()) {
      throw new ValidationError(`${contextPath}.entrypoint must be a non-empty string`);
    }
    out.entrypoint = manifest.entrypoint.trim();
  }

  return out;
}

/**
 * Validates CLI contribution manifest properties.
 */
export function validateCliManifest(manifest: Record<string, unknown>, contextPath = 'manifest'): CanonicalCliManifest {
  const out: CanonicalCliManifest = {
    ...manifest,
    script: '',
  };

  if (manifest.command !== undefined && manifest.command !== null) {
    if (typeof manifest.command !== 'string' || !manifest.command.trim()) {
      throw new ValidationError(`${contextPath}.command must be a non-empty string`);
    }
    const cmd = manifest.command.trim();
    const baseCmd = path.basename(cmd);
    if (baseCmd !== 'node' && baseCmd !== 'nodejs') {
      throw new ValidationError(
        `Deterministic CLI contribution requires command to be "node", got "${cmd}". Arbitrary system binaries are forbidden.`
      );
    }
    out.command = 'node';
  } else {
    out.command = 'node';
  }

  if (typeof manifest.script !== 'string' || !manifest.script.trim()) {
    throw new ValidationError(`${contextPath}.script must be a non-empty relative path string`);
  }
  const script = manifest.script.trim();
  if (path.isAbsolute(script) || script.startsWith('/') || script.startsWith('\\') || script.split(/[\\/]/).includes('..')) {
    throw new ValidationError(`${contextPath}.script must be a safe relative path within the package, got "${script}"`);
  }
  out.script = script;

  if (manifest.args !== undefined && manifest.args !== null) {
    if (!Array.isArray(manifest.args)) {
      throw new ValidationError(`${contextPath}.args must be an array of strings`);
    }
    out.args = manifest.args.map((a, idx) => {
      if (typeof a !== 'string') {
        throw new ValidationError(`${contextPath}.args[${idx}] must be a string`);
      }
      if (/[;&|`$<>]/.test(a)) {
        throw new ValidationError(`${contextPath}.args[${idx}] contains forbidden shell metacharacters: "${a}"`);
      }
      return a;
    });
  }

  if (manifest.fixedArgs !== undefined && manifest.fixedArgs !== null) {
    if (!Array.isArray(manifest.fixedArgs)) {
      throw new ValidationError(`${contextPath}.fixedArgs must be an array of strings`);
    }
    out.fixedArgs = manifest.fixedArgs.map((a, idx) => {
      if (typeof a !== 'string') {
        throw new ValidationError(`${contextPath}.fixedArgs[${idx}] must be a string`);
      }
      if (/[;&|`$<>]/.test(a)) {
        throw new ValidationError(`${contextPath}.fixedArgs[${idx}] contains forbidden shell metacharacters: "${a}"`);
      }
      return a;
    });
  }

  if (manifest.executionMode !== undefined && manifest.executionMode !== null) {
    if (manifest.executionMode !== 'container' && manifest.executionMode !== 'host' && manifest.executionMode !== 'space') {
      throw new ValidationError(`${contextPath}.executionMode must be "container", "host", or "space"`);
    }
    out.executionMode = manifest.executionMode;
  }

  if (manifest.timeoutMs !== undefined && manifest.timeoutMs !== null) {
    if (typeof manifest.timeoutMs !== 'number' || manifest.timeoutMs <= 0 || !Number.isFinite(manifest.timeoutMs)) {
      throw new ValidationError(`${contextPath}.timeoutMs must be a positive number`);
    }
    if (manifest.timeoutMs > 60000) {
      throw new ValidationError(`${contextPath}.timeoutMs cannot exceed 60000ms`);
    }
    out.timeoutMs = manifest.timeoutMs;
  }

  if (manifest.name !== undefined) {
    if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
      throw new ValidationError(`${contextPath}.name must be a non-empty string`);
    }
    out.name = manifest.name.trim();
  }

  if (manifest.description !== undefined && manifest.description !== null) {
    if (typeof manifest.description !== 'string') {
      throw new ValidationError(`${contextPath}.description must be a string`);
    }
    out.description = manifest.description.trim();
  }

  if (manifest.whenToUse !== undefined && manifest.whenToUse !== null) {
    if (typeof manifest.whenToUse !== 'string') {
      throw new ValidationError(`${contextPath}.whenToUse must be a string`);
    }
    out.whenToUse = manifest.whenToUse.trim();
  }

  return out;
}
