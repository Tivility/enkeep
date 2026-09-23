/**
 * Lark / Feishu CLI Credential Discovery Bridge & Scoped Configuration Provider.
 *
 * Phase Status: G16-P1 (Scoped Credential Provider Refinement).
 * Static exports transparently available; runtime wiring into @enkeep/dsh-tool-cli executor is P2 pending.
 *
 * Implements G16 / FEI-08 Alignment:
 * 1. Bound App Identity Discovery: Unambiguously resolves bound Lark account for a space / user.
 *    - Strict fail-closed policy: If no explicit space binding or wrong owner, returns null or error.
 *    - Strictly NEVER falls back to another user's account or host global default profile (~/.feishu-cli).
 *    - Multi-binding Ambiguity Protection: If multiple active accounts are bound to a space without
 *      an explicit turn-level accountId, throws structured `LarkAmbiguousBoundAppError` (NEVER implicit LIMIT 1).
 *    - Decoupled Interface: Supports trustedContext, channelBindingSource / repository, and raw SQLite db.
 * 2. Safe Metadata & Discoverability: Returns non-sensitive metadata (displayName, safe appId)
 *    for model prompt / tool metadata. NEVER leaks raw appSecret, tokens, or credentials into model context.
 * 3. Private Scoped Config Provider: Dynamically loads credentials via LarkCredentialResolver
 *    (e.g. LarkEncryptedCredentialStore), creates ephemeral private config (mode 0600) in private scratch root.
 *    - Clean on write failure: If file creation or write fails, temporary file/directory is immediately purged.
 *    - Strict mode 0600 / 0700 file and directory permissions.
 * 4. Caller Disposal Contract: Returns `LarkScopedConfigHandle` with async `dispose()`. Callers MUST invoke
 *    `handle.dispose()` in a `finally` block. (Child process execution is delegated to @enkeep/dsh-tool-cli).
 * 5. Scope Boundary: Bot / App binding only. Platform-level user OAuth is explicitly NOT implemented.
 *
 * @module @enkeep/channel-lark/cli-credential-bridge
 */

import {
  existsSync,
  mkdirSync,
  openSync,
  writeFileSync,
  closeSync,
  unlinkSync,
  rmdirSync,
  constants,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { LarkCredentialResolver, LarkResolvedCredentials } from './types.js';

/**
 * Base error for Lark CLI credential and binding errors.
 */
export class LarkCliBridgeError extends Error {
  constructor(message: string, public readonly code: string) {
    super(`LarkCliBridgeError [${code}]: ${message}`);
    this.name = 'LarkCliBridgeError';
  }
}

export class LarkBoundAppNotFoundError extends LarkCliBridgeError {
  constructor(spaceId: string, userId: string) {
    super(
      `No active Feishu/Lark channel account is bound to space "${spaceId}" for user "${userId}". Fallback to host global profile is prohibited.`,
      'BOUND_APP_NOT_FOUND'
    );
    this.name = 'LarkBoundAppNotFoundError';
  }
}

export class LarkBoundAppOwnershipError extends LarkCliBridgeError {
  constructor(accountId: string, requestedUserId: string) {
    super(
      `Channel account "${accountId}" does not belong to requesting user "${requestedUserId}". Cross-tenant access is rejected.`,
      'ACCOUNT_OWNERSHIP_MISMATCH'
    );
    this.name = 'LarkBoundAppOwnershipError';
  }
}

export class LarkBoundAppDisabledError extends LarkCliBridgeError {
  constructor(accountId: string) {
    super(`Channel account "${accountId}" bound to this space is disabled or inactive.`, 'ACCOUNT_DISABLED');
    this.name = 'LarkBoundAppDisabledError';
  }
}

export class LarkAccountNotBoundToSpaceError extends LarkCliBridgeError {
  constructor(accountId: string, spaceId: string) {
    super(`Channel account "${accountId}" is not bound to space "${spaceId}".`, 'ACCOUNT_NOT_BOUND_TO_SPACE');
    this.name = 'LarkAccountNotBoundToSpaceError';
  }
}

/**
 * Structured error thrown when multiple active Lark channel accounts are bound to a space
 * without an explicit account selection (channelAccountId).
 * Enforces Fail-Closed and prevents silent implicit LIMIT 1 selection.
 */
export class LarkAmbiguousBoundAppError extends LarkCliBridgeError {
  public readonly spaceId: string;
  public readonly userId: string;
  public readonly candidateAccountIds: readonly string[];

  constructor(spaceId: string, userId: string, candidateAccountIds: readonly string[]) {
    super(
      `Multiple active Feishu/Lark channel accounts (${candidateAccountIds.join(', ')}) are bound to space "${spaceId}" for user "${userId}". Explicit account selection via channelAccountId is required; implicit selection is prohibited.`,
      'AMBIGUOUS_BOUND_APP'
    );
    this.name = 'LarkAmbiguousBoundAppError';
    this.spaceId = spaceId;
    this.userId = userId;
    this.candidateAccountIds = Object.freeze([...candidateAccountIds]);
  }
}

export class LarkCredentialResolutionError extends LarkCliBridgeError {
  constructor(credentialRef: string, reason: string) {
    super(`Failed to resolve credentials for ref "${credentialRef}": ${reason}`, 'CREDENTIAL_RESOLUTION_FAILED');
    this.name = 'LarkCredentialResolutionError';
  }
}

/**
 * Safe, non-sensitive account metadata suitable for model prompt discovery,
 * tool annotations, or UI display. NEVER contains appSecret, tokens, or raw secrets.
 */
export interface LarkSafeAccountMetadata {
  readonly accountId: string;
  readonly credentialRef: string;
  readonly displayName: string;
  readonly appId: string;
  readonly brand: 'feishu' | 'lark';
  readonly boundSpaceId?: string;
  readonly status: string;
}

/**
 * Trusted pre-resolved context passed by the caller (e.g. from session or turn origin),
 * minimizing database query and schema coupling.
 */
export interface LarkTrustedBindingContext {
  readonly accountId?: string;
  readonly credentialRef?: string;
  readonly appId?: string;
  readonly brand?: 'feishu' | 'lark';
  readonly displayName?: string;
  readonly status?: string;
  readonly boundSpaceId?: string;
}

/**
 * Minimal channel binding and account abstraction to decouple from raw SQL.
 * Compatible with TenantScopedChannelRepository from @enkeep/platform-core.
 */
export interface LarkChannelBindingRecord {
  readonly id: string;
  readonly userId?: string;
  readonly accountId: string;
  readonly spaceId: string;
}

export interface LarkChannelAccountRecord {
  readonly id: string;
  readonly userId: string;
  readonly type: string;
  readonly status: string;
  readonly credentialRef: string | null;
  readonly name?: string;
}

export interface LarkChannelBindingSource {
  listBindings?(accountId?: string): Promise<LarkChannelBindingRecord[]> | LarkChannelBindingRecord[];
  findAccountById?(id: string): Promise<LarkChannelAccountRecord | null> | LarkChannelAccountRecord | null;
}

/**
 * Parameters for discovering a bound Lark app for a space / user.
 */
export interface LarkBoundDiscoveryParams {
  readonly userId: string;
  readonly spaceId?: string;
  readonly channelAccountId?: string;
  readonly trustedContext?: LarkTrustedBindingContext;
  readonly channelBindingSource?: LarkChannelBindingSource;
  readonly channelRepo?: LarkChannelBindingSource;
  readonly db?: DatabaseSync | any;
}

/**
 * Default directory for scoped private CLI configs.
 */
export const DEFAULT_LARK_SCOPED_CONFIG_ROOT = join(tmpdir(), 'enkeep-lark-scoped');

/**
 * Disposable handle representing a scoped, private CLI configuration file (mode 0600).
 *
 * IMPORTANT CALLER CONTRACT:
 * Callers MUST call `handle.dispose()` in a `finally` block to securely unlink
 * the 0600 configuration file and remove the temporary private directory.
 */
export interface LarkScopedConfigHandle {
  readonly configPath: string;
  readonly dirPath: string;
  readonly appId: string;
  readonly domain: 'feishu' | 'lark';
  readonly metadata: LarkSafeAccountMetadata;
  dispose(): Promise<void>;
}

/**
 * Options for resolving and creating a scoped CLI configuration.
 */
export interface LarkScopedConfigOptions {
  readonly userId: string;
  readonly spaceId?: string;
  readonly channelAccountId?: string;
  readonly trustedContext?: LarkTrustedBindingContext;
  readonly channelBindingSource?: LarkChannelBindingSource;
  readonly channelRepo?: LarkChannelBindingSource;
  readonly db?: DatabaseSync | any;
  readonly resolver: LarkCredentialResolver;
  readonly scratchRoot?: string;
  readonly baseDir?: string;
  readonly strict?: boolean;
}

/**
 * Manages discovery of space-bound Feishu / Lark channel accounts.
 * Enforces strict per-user/space isolation, unambiguous binding, and fail-closed security.
 */
export class LarkBoundAppDiscovery {
  /**
   * Discovers the bound Lark account for a space or turn context.
   *
   * Security Invariants:
   * 1. Explicit space binding -> owned account only.
   * 2. Strict tenant check (account.user_id === userId).
   * 3. Fail-closed: returns null if no binding exists.
   * 4. Multi-binding ambiguity: Throws `LarkAmbiguousBoundAppError` if multiple active accounts
   *    are bound to the space without explicit channelAccountId (NEVER implicit LIMIT 1).
   * 5. Fallback prohibition: NEVER falls back to another user's account or host ~/.feishu-cli.
   */
  static async discoverBoundAccount(params: LarkBoundDiscoveryParams): Promise<LarkSafeAccountMetadata | null> {
    const { userId, spaceId, channelAccountId, trustedContext, channelBindingSource, channelRepo, db } = params;
    if (!userId || typeof userId !== 'string') {
      throw new LarkCliBridgeError('Valid userId is required for Lark bound app discovery', 'INVALID_USER_ID');
    }

    // 1. Direct trusted binding context if provided (minimizes DB coupling)
    if (trustedContext) {
      const appId = trustedContext.appId || extractAppIdFromCredRef(trustedContext.credentialRef || '');
      if (trustedContext.status && trustedContext.status !== 'active') {
        throw new LarkBoundAppDisabledError(trustedContext.accountId || appId);
      }
      return {
        accountId: trustedContext.accountId || `trusted_${appId}`,
        credentialRef: trustedContext.credentialRef || '',
        displayName: trustedContext.displayName || `Feishu App (${appId})`,
        appId,
        brand: trustedContext.brand ?? 'feishu',
        boundSpaceId: spaceId ?? trustedContext.boundSpaceId,
        status: trustedContext.status ?? 'active',
      };
    }

    const bindingSource = channelBindingSource ?? channelRepo;

    // 2. Channel Binding Service / Repository lookup (abstracted interface)
    if (bindingSource) {
      // 2a. Direct channelAccountId specified
      if (channelAccountId) {
        const account = bindingSource.findAccountById ? await bindingSource.findAccountById(channelAccountId) : null;
        if (!account) {
          throw new LarkCliBridgeError(`Channel account "${channelAccountId}" not found`, 'ACCOUNT_NOT_FOUND');
        }
        if (account.userId !== userId) {
          throw new LarkBoundAppOwnershipError(channelAccountId, userId);
        }
        if (account.type !== 'lark' && account.type !== 'feishu') {
          throw new LarkCliBridgeError(
            `Channel account "${channelAccountId}" is not a Lark/Feishu account`,
            'INVALID_CHANNEL_TYPE'
          );
        }
        if (account.status !== 'active') {
          throw new LarkBoundAppDisabledError(channelAccountId);
        }
        if (spaceId && bindingSource.listBindings) {
          const bindings = await bindingSource.listBindings(channelAccountId);
          const isBound = Array.isArray(bindings) && bindings.some((b) => b.spaceId === spaceId);
          if (!isBound) {
            throw new LarkAccountNotBoundToSpaceError(channelAccountId, spaceId);
          }
        }
        const appId = extractAppIdFromCredRef(account.credentialRef ?? '');
        return {
          accountId: account.id,
          credentialRef: account.credentialRef ?? '',
          displayName: account.name || `Feishu App (${appId})`,
          appId,
          brand: account.type === 'lark' ? 'lark' : 'feishu',
          boundSpaceId: spaceId,
          status: account.status,
        };
      }

      // 2b. Space-level lookup (with ambiguity guard)
      if (spaceId && bindingSource.listBindings) {
        const allBindings = await bindingSource.listBindings();
        const spaceBindings = Array.isArray(allBindings)
          ? allBindings.filter((b) => b.spaceId === spaceId && (!b.userId || b.userId === userId))
          : [];
        const uniqueAccountIds = [...new Set(spaceBindings.map((b) => b.accountId))];

        const activeAccounts: LarkSafeAccountMetadata[] = [];
        for (const accId of uniqueAccountIds) {
          const account = bindingSource.findAccountById ? await bindingSource.findAccountById(accId) : null;
          if (!account) continue;
          if (account.userId !== userId) {
            throw new LarkBoundAppOwnershipError(accId, userId);
          }
          if ((account.type === 'lark' || account.type === 'feishu') && account.status === 'active') {
            const appId = extractAppIdFromCredRef(account.credentialRef ?? '');
            activeAccounts.push({
              accountId: account.id,
              credentialRef: account.credentialRef ?? '',
              displayName: account.name || `Feishu App (${appId})`,
              appId,
              brand: account.type === 'lark' ? 'lark' : 'feishu',
              boundSpaceId: spaceId,
              status: account.status,
            });
          }
        }

        if (activeAccounts.length === 0) {
          return null;
        }
        if (activeAccounts.length > 1) {
          throw new LarkAmbiguousBoundAppError(
            spaceId,
            userId,
            activeAccounts.map((a) => a.accountId)
          );
        }
        return activeAccounts[0];
      }
    }

    // 3. Fallback raw SQLite DB lookup
    if (db && typeof db.prepare === 'function') {
      // 3a. Direct channelAccountId specified
      if (channelAccountId) {
        const stmt = db.prepare(`
          SELECT id, user_id, type, status, credential_ref
          FROM channel_accounts
          WHERE id = ?
        `);
        const row = stmt.get(channelAccountId) as any;
        if (!row) {
          throw new LarkCliBridgeError(`Channel account "${channelAccountId}" not found`, 'ACCOUNT_NOT_FOUND');
        }
        if (row.user_id !== userId) {
          throw new LarkBoundAppOwnershipError(channelAccountId, userId);
        }
        if (row.type !== 'lark' && row.type !== 'feishu') {
          throw new LarkCliBridgeError(
            `Channel account "${channelAccountId}" is not a Lark/Feishu account`,
            'INVALID_CHANNEL_TYPE'
          );
        }
        if (row.status !== 'active') {
          throw new LarkBoundAppDisabledError(channelAccountId);
        }
        if (spaceId) {
          const bindStmt = db.prepare(`
            SELECT id FROM channel_bindings WHERE space_id = ? AND account_id = ? AND user_id = ?
          `);
          const bindRow = bindStmt.get(spaceId, channelAccountId, userId);
          if (!bindRow) {
            throw new LarkAccountNotBoundToSpaceError(channelAccountId, spaceId);
          }
        }
        const appId = extractAppIdFromCredRef(row.credential_ref);
        return {
          accountId: row.id,
          credentialRef: row.credential_ref,
          displayName: `Feishu App (${appId})`,
          appId,
          brand: row.type === 'lark' ? 'lark' : 'feishu',
          boundSpaceId: spaceId,
          status: row.status,
        };
      }

      // 3b. Space-level lookup (NO LIMIT 1, ambiguity detected)
      if (spaceId) {
        const stmt = db.prepare(`
          SELECT cb.id as binding_id, cb.space_id, cb.account_id, cb.user_id as binding_user_id,
                 ca.id as ca_id, ca.user_id as account_user_id, ca.type, ca.status,
                 ca.credential_ref
          FROM channel_bindings cb
          JOIN channel_accounts ca ON ca.id = cb.account_id
          WHERE cb.space_id = ? AND cb.user_id = ?
        `);
        const rows = stmt.all(spaceId, userId) as any[];
        if (!rows || rows.length === 0) {
          return null;
        }

        const activeMap = new Map<string, any>();
        for (const row of rows) {
          if (row.account_user_id !== userId) {
            throw new LarkBoundAppOwnershipError(row.ca_id, userId);
          }
          if ((row.type === 'lark' || row.type === 'feishu') && row.status === 'active') {
            activeMap.set(row.ca_id, row);
          }
        }

        const candidateIds = Array.from(activeMap.keys());
        if (candidateIds.length === 0) {
          return null;
        }
        if (candidateIds.length > 1) {
          throw new LarkAmbiguousBoundAppError(spaceId, userId, candidateIds);
        }

        const selectedRow = activeMap.get(candidateIds[0]);
        const appId = extractAppIdFromCredRef(selectedRow.credential_ref);
        return {
          accountId: selectedRow.ca_id,
          credentialRef: selectedRow.credential_ref,
          displayName: `Feishu App (${appId})`,
          appId,
          brand: selectedRow.type === 'lark' ? 'lark' : 'feishu',
          boundSpaceId: spaceId,
          status: selectedRow.status,
        };
      }
    }

    return null;
  }
}

export function extractAppIdFromCredRef(credRef: string): string {
  if (!credRef) return 'unknown_app';
  const match = credRef.match(/(?:cred_lark_|lark-test-)(cli_[a-zA-Z0-9]+)/);
  if (match && match[1]) {
    return match[1];
  }
  return credRef;
}

function hasUnsafeCredentialCharacters(val: string): boolean {
  return /[\u0000\r\n]/.test(val);
}

function escapeYamlString(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Manages atomic, mode-0600 scoped configuration files for child CLI processes.
 * Ensures secrets never exist in global environment or prompt context.
 * Cleans up immediately if write or file setup fails.
 */
export class LarkPrivateConfigManager {
  private readonly resolver: LarkCredentialResolver;
  private readonly scratchRoot: string;

  constructor(resolver: LarkCredentialResolver, scratchRoot?: string) {
    this.resolver = resolver;
    this.scratchRoot = scratchRoot ?? DEFAULT_LARK_SCOPED_CONFIG_ROOT;
  }

  /**
   * Generates a temporary private config file (mode 0600) for a single execution lifecycle.
   * If any step fails during file/directory creation or write, cleans up immediately before throwing.
   */
  async createScopedConfig(
    userId: string,
    credentialRef: string,
    metadata?: LarkSafeAccountMetadata
  ): Promise<LarkScopedConfigHandle> {
    if (!userId || !credentialRef) {
      throw new LarkCliBridgeError('userId and credentialRef are required to create scoped config', 'INVALID_PARAMS');
    }

    const creds: LarkResolvedCredentials | null = await this.resolver.resolve(userId, credentialRef);
    if (!creds || !creds.appId || !creds.appSecret) {
      throw new LarkCredentialResolutionError(credentialRef, 'Missing appId or appSecret from resolved credentials');
    }

    if (hasUnsafeCredentialCharacters(creds.appId) || hasUnsafeCredentialCharacters(creds.appSecret)) {
      throw new LarkCliBridgeError('Credentials contain forbidden newline or null characters', 'INVALID_CREDENTIAL_CHARS');
    }

    const sessionNonce = randomBytes(12).toString('hex');
    const runDir = join(this.scratchRoot, `${process.pid}-${sessionNonce}`);
    const configPath = join(runDir, 'feishu-cli-config.yaml');
    const domain = creds.domain ?? 'feishu';

    const yamlContent = [
      '# Generated by Enkeep Lark Private Scoped Config Provider (mode 0600)',
      '# Scoped strictly to child command execution. Cleansed on disposal.',
      `app_id: "${escapeYamlString(creds.appId)}"`,
      `app_secret: "${escapeYamlString(creds.appSecret)}"`,
      `appId: "${escapeYamlString(creds.appId)}"`,
      `appSecret: "${escapeYamlString(creds.appSecret)}"`,
      `domain: "${escapeYamlString(domain)}"`,
      '',
    ].join('\n');

    let dirCreated = false;
    let fileCreated = false;
    let fd: number | null = null;

    try {
      if (!existsSync(runDir)) {
        mkdirSync(runDir, { recursive: true, mode: 0o700 });
        dirCreated = true;
      }

      fd = openSync(
        configPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
        0o600
      );
      fileCreated = true;

      writeFileSync(fd, yamlContent, 'utf8');
      closeSync(fd);
      fd = null;

      try {
        chmodSync(configPath, 0o600);
      } catch {}
    } catch (writeErr) {
      // Clean up partially created file/directory on write failure
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {}
      }
      if (fileCreated) {
        try {
          if (existsSync(configPath)) {
            unlinkSync(configPath);
          }
        } catch {}
      }
      if (dirCreated) {
        try {
          if (existsSync(runDir)) {
            rmdirSync(runDir);
          }
        } catch {}
      }
      throw writeErr;
    }

    let disposed = false;
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      try {
        if (existsSync(configPath)) {
          unlinkSync(configPath);
        }
      } catch {}
      try {
        if (existsSync(runDir)) {
          rmdirSync(runDir);
        }
      } catch {}
    };

    const safeMeta: LarkSafeAccountMetadata = metadata ?? {
      accountId: 'ephemeral',
      credentialRef,
      displayName: `Feishu App (${creds.appId})`,
      appId: creds.appId,
      brand: domain === 'lark' ? 'lark' : 'feishu',
      status: 'active',
    };

    return {
      configPath,
      dirPath: runDir,
      appId: creds.appId,
      domain,
      metadata: safeMeta,
      dispose,
    };
  }
}

/**
 * Resolves bound Lark account and provides an ephemeral, mode-0600 scoped CLI configuration.
 *
 * Caller Contract:
 * - Returns a disposable `LarkScopedConfigHandle` containing `configPath` and `metadata`.
 * - The caller (e.g. @enkeep/dsh-tool-cli executor) MUST call `handle.dispose()` in a `finally` block.
 * - If multiple active accounts are bound to the space without turn-level channelAccountId,
 *   throws `LarkAmbiguousBoundAppError` (NEVER silently selects LIMIT 1).
 * - Safe account metadata contains NO secrets or credentials, safe for model prompt/context.
 *
 * @param options Scoped configuration options
 * @returns Ephemeral config handle or null if no binding found (unless strict is true)
 */
export async function resolveLarkCliScopedConfig(
  options: LarkScopedConfigOptions
): Promise<LarkScopedConfigHandle | null> {
  const {
    userId,
    spaceId,
    channelAccountId,
    trustedContext,
    channelBindingSource,
    channelRepo,
    db,
    resolver,
    scratchRoot,
    baseDir,
    strict = false,
  } = options;

  if (!userId || typeof userId !== 'string') {
    throw new LarkCliBridgeError('Valid userId is required for Lark CLI scoped config', 'INVALID_USER_ID');
  }
  if (!resolver || typeof resolver.resolve !== 'function') {
    throw new LarkCliBridgeError('Valid LarkCredentialResolver is required', 'INVALID_RESOLVER');
  }

  const boundAccount = await LarkBoundAppDiscovery.discoverBoundAccount({
    userId,
    spaceId,
    channelAccountId,
    trustedContext,
    channelBindingSource: channelBindingSource ?? channelRepo,
    db,
  });

  if (!boundAccount) {
    if (strict) {
      throw new LarkBoundAppNotFoundError(spaceId ?? 'unspecified_space', userId);
    }
    return null;
  }

  const effectiveScratchRoot = scratchRoot ?? baseDir ?? DEFAULT_LARK_SCOPED_CONFIG_ROOT;
  const configManager = new LarkPrivateConfigManager(resolver, effectiveScratchRoot);

  return configManager.createScopedConfig(userId, boundAccount.credentialRef, boundAccount);
}
