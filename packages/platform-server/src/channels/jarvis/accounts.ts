/**
 * Jarvis channel accounts and their bearer tokens (docs/jarvis-channel.md §3.2, §7.1): the account
 * policy shared by the running platform ({@link JarvisRuntimeManager}, which adds the live
 * connections) and offline admin tools (the `demo-runner jarvis-token` CLI). Both register it as
 * the `jarvis` manager of a ChannelManagementService, so accounts are created, rotated and deleted
 * through the same path and checks as the management API.
 *
 * - Creating an account is admin-only and one per user; creation issues a token returned once.
 * - Rotating the token is admin-only; disabling or deleting the account revokes it.
 * - Issue, rotate and revoke are audited with the account id only; tokens never reach logs.
 *
 * This class holds no connections (`closeAccountConnections` closes nothing). A token changed by
 * another process is noticed by a running platform at its next authorization check of each live
 * connection, which compares the hash the connection authenticated with.
 *
 * @module @enkeep/platform-server/channels/jarvis/accounts
 */

import type { DatabaseSync } from 'node:sqlite';
import type { JarvisLogger } from '@enkeep/channel-jarvis';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type AuthAuditAction,
  type ChannelAccount,
  type PlatformStorage,
} from '@enkeep/platform-core';
import type { ChannelAccountLifecycle } from '../channel-routes.js';
import { JarvisTokenOwnerConflictError, JarvisTokenStore } from './token-store.js';

export const JARVIS_CHANNEL_TYPE = 'jarvis';

export interface JarvisAccountLifecycleOptions {
  db: DatabaseSync;
  /** Users (roles) and the audit log. */
  storage: PlatformStorage;
  log?: JarvisLogger;
  /** Extra fields of the token audit entries (issued / rotated / revoked), e.g. `{ via: 'cli' }`. */
  auditDetails?: Record<string, unknown>;
}

export class JarvisAccountLifecycle implements ChannelAccountLifecycle {
  readonly tokens: JarvisTokenStore;
  protected readonly db: DatabaseSync;
  protected readonly storage: PlatformStorage;
  protected readonly log: JarvisLogger;
  private readonly auditDetails: Record<string, unknown>;
  private auditChain: Promise<void> = Promise.resolve();

  constructor(options: JarvisAccountLifecycleOptions) {
    if (!options?.db || !options.storage) {
      throw new TypeError('JarvisAccountLifecycle requires db and storage');
    }
    this.db = options.db;
    this.storage = options.storage;
    this.log = options.log ?? {};
    this.auditDetails = { ...(options.auditDetails ?? {}) };
    this.tokens = new JarvisTokenStore(options.db);
  }

  /** Live connections of one account (none here; the platform's manager holds them). */
  connectionsOf(_accountId: string): number {
    return 0;
  }

  /** Close every live connection of an account; returns how many were closed (none here). */
  closeAccountConnections(_accountId: string, _code?: number, _reason?: string): number {
    return 0;
  }

  async beforeCreateAccount(userId: string): Promise<void> {
    const user = await this.storage.users.findById(userId);
    if (!user || user.role !== 'admin') {
      throw new ForbiddenError('Creating a Jarvis channel is limited to administrators');
    }
    const existing = await this.storage.forTenant(userId).channels.listAccounts(JARVIS_CHANNEL_TYPE);
    if (existing.length > 0) {
      throw new ConflictError('This user already has a Jarvis channel', 'JARVIS_ACCOUNT_EXISTS');
    }
  }

  async provisionAccount(userId: string, account: ChannelAccount): Promise<{ token: string }> {
    let token: string;
    try {
      token = this.tokens.issue(account.id, userId);
    } catch (err) {
      // A concurrent creation won the race for this user's one Jarvis account (the caller
      // deletes the account it just created).
      if (err instanceof JarvisTokenOwnerConflictError) {
        throw new ConflictError('This user already has a Jarvis channel', 'JARVIS_ACCOUNT_EXISTS');
      }
      throw err;
    }
    await this.audit(userId, 'jarvis.token_issued', { accountId: account.id, ...this.auditDetails });
    return { token };
  }

  async rotateAccountToken(userId: string, accountId: string): Promise<{ token: string }> {
    const user = await this.storage.users.findById(userId);
    if (!user || user.role !== 'admin') {
      throw new ForbiddenError('Rotating a Jarvis token is limited to administrators');
    }
    const account = await this.storage.forTenant(userId).channels.findAccountById(accountId);
    if (!account || account.type !== JARVIS_CHANNEL_TYPE) {
      throw new NotFoundError(`Channel account "${accountId}" not found`);
    }
    const token = this.tokens.issue(account.id, userId);
    const closed = this.closeAccountConnections(account.id);
    await this.audit(userId, 'jarvis.token_rotated', { accountId: account.id, closedConnections: closed, ...this.auditDetails });
    return { token };
  }

  async onAccountCreated(_userId: string, _accountId: string): Promise<void> {
    // The token is issued by provisionAccount; nothing runs until a node connects.
  }

  async onAccountUpdated(userId: string, accountId: string): Promise<void> {
    const account = await this.storage.forTenant(userId).channels.findAccountById(accountId);
    if (account && account.status === 'active') return;
    await this.revoke(userId, accountId, account ? 'account_disabled' : 'account_missing');
  }

  async onAccountDeleted(userId: string, accountId: string): Promise<void> {
    await this.revoke(userId, accountId, 'account_deleted');
  }

  async syncAccount(userId: string, accountId: string): Promise<{ connections: number; token: boolean }> {
    const account = await this.storage.forTenant(userId).channels.findAccountById(accountId);
    if (!account || account.status !== 'active') {
      this.closeAccountConnections(accountId);
    }
    return { connections: this.connectionsOf(accountId), token: this.tokens.has(accountId) };
  }

  protected async revoke(userId: string, accountId: string, reason: string): Promise<void> {
    const removed = this.tokens.revoke(accountId);
    const closed = this.closeAccountConnections(accountId);
    // A deleted account's token row may already be gone through the foreign key cascade.
    if (removed || closed > 0 || reason === 'account_deleted') {
      await this.audit(userId, 'jarvis.token_revoked', { accountId, reason, closedConnections: closed, ...this.auditDetails });
    }
  }

  /** Audit entries are written in the order they happen (connection close before rotation, …). */
  protected audit(userId: string, action: AuthAuditAction, details: Record<string, unknown>): Promise<void> {
    const write = this.auditChain.then(() => this.writeAudit(userId, action, details));
    this.auditChain = write;
    return write;
  }

  private async writeAudit(userId: string, action: AuthAuditAction, details: Record<string, unknown>): Promise<void> {
    try {
      const user = await this.storage.users.findById(userId);
      await this.storage.auditLogs.create({
        userId: user ? userId : null,
        username: user?.username ?? null,
        action,
        details,
      });
    } catch (err) {
      this.log.warn?.({ action, err: err instanceof Error ? err.name : typeof err }, 'jarvis: audit log write failed');
    }
  }
}
