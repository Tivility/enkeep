import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  ChannelAccount,
  ChannelActivationMode,
  ChannelBinding,
  ChannelInboxItem,
  ChannelOutboxItem,
  CreateChannelAccountInput,
  CreateChannelBindingInput,
  CreateChannelInboxInput,
  CreateChannelOutboxInput,
  TenantScopedChannelRepository,
  UpdateChannelAccountInput,
  UpdateChannelBindingInput,
} from '@enkeep/platform-core';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
} from '@enkeep/platform-core';
import {
  parseChannelAccountRow,
  parseChannelBindingRow,
  parseChannelInboxRow,
  parseChannelOutboxRow,
  queryOne,
  queryAll,
} from '../utils/db.js';

export class SqliteTenantScopedChannelRepository implements TenantScopedChannelRepository {
  readonly userId: string;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  // ──────────────── Account Operations ────────────────

  async listAccounts(type?: string): Promise<ChannelAccount[]> {
    if (type) {
      const stmt = this.db.prepare(
        'SELECT * FROM channel_accounts WHERE user_id = ? AND type = ? ORDER BY created_at ASC'
      );
      return queryAll(stmt, parseChannelAccountRow, this.userId, type);
    }
    const stmt = this.db.prepare(
      'SELECT * FROM channel_accounts WHERE user_id = ? ORDER BY created_at ASC'
    );
    return queryAll(stmt, parseChannelAccountRow, this.userId);
  }

  async findAccountById(id: string): Promise<ChannelAccount | null> {
    if (!id || typeof id !== 'string') return null;
    const stmt = this.db.prepare('SELECT * FROM channel_accounts WHERE id = ? AND user_id = ?');
    return queryOne(stmt, parseChannelAccountRow, id, this.userId);
  }

  async createAccount(input: Omit<CreateChannelAccountInput, 'userId'>): Promise<ChannelAccount> {
    const type = input.type;
    if (!type || typeof type !== 'string' || !type.trim()) {
      throw new ValidationError('Channel type is required');
    }

    const id = input.id && typeof input.id === 'string' && input.id.trim()
      ? input.id.trim()
      : `ca_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    const status = input.status ?? 'active';
    const credentialRef = input.credentialRef ?? null;
    const defaultSpaceId = input.defaultSpaceId ?? null;
    const groupActivationMode = input.groupActivationMode ?? 'mention';

    const insertStmt = this.db.prepare(`
      INSERT INTO channel_accounts (id, user_id, type, status, credential_ref, default_space_id, group_activation_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    insertStmt.run(id, this.userId, type.trim(), status, credentialRef, defaultSpaceId, groupActivationMode);

    const created = await this.findAccountById(id);
    if (!created) {
      throw new Error('Failed to retrieve newly created channel account');
    }
    return created;
  }

  async updateAccount(id: string, input: UpdateChannelAccountInput): Promise<ChannelAccount> {
    const account = await this.findAccountById(id);
    if (!account) {
      throw new NotFoundError(`Channel account "${id}" not found`);
    }

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (input.status !== undefined) {
      updates.push('status = ?');
      params.push(input.status);
    }
    if (input.credentialRef !== undefined) {
      updates.push('credential_ref = ?');
      params.push(input.credentialRef);
    }
    if (input.defaultSpaceId !== undefined) {
      updates.push('default_space_id = ?');
      params.push(input.defaultSpaceId);
    }
    if (input.groupActivationMode !== undefined) {
      updates.push('group_activation_mode = ?');
      params.push(input.groupActivationMode);
    }

    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(id, this.userId);
      const sql = `UPDATE channel_accounts SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`;
      this.db.prepare(sql).run(...params);
    }

    const updated = await this.findAccountById(id);
    if (!updated) {
      throw new Error('Failed to retrieve updated channel account');
    }
    return updated;
  }

  async deleteAccount(id: string): Promise<boolean> {
    const stmt = this.db.prepare('DELETE FROM channel_accounts WHERE id = ? AND user_id = ?');
    const result = stmt.run(id, this.userId);
    return Number(result.changes) > 0;
  }

  // ──────────────── Binding Operations ────────────────

  async listBindings(accountId?: string): Promise<ChannelBinding[]> {
    if (accountId) {
      const stmt = this.db.prepare(
        'SELECT * FROM channel_bindings WHERE user_id = ? AND account_id = ? ORDER BY created_at ASC'
      );
      return queryAll(stmt, parseChannelBindingRow, this.userId, accountId);
    }
    const stmt = this.db.prepare(
      'SELECT * FROM channel_bindings WHERE user_id = ? ORDER BY created_at ASC'
    );
    return queryAll(stmt, parseChannelBindingRow, this.userId);
  }

  async findBindingById(id: string): Promise<ChannelBinding | null> {
    if (!id || typeof id !== 'string') return null;
    const stmt = this.db.prepare('SELECT * FROM channel_bindings WHERE id = ? AND user_id = ?');
    return queryOne(stmt, parseChannelBindingRow, id, this.userId);
  }

  async findBindingByContext(accountId: string, nativeContextId: string): Promise<ChannelBinding | null> {
    if (!accountId || !nativeContextId) return null;
    const stmt = this.db.prepare(
      'SELECT * FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?'
    );
    return queryOne(stmt, parseChannelBindingRow, this.userId, accountId, nativeContextId);
  }

  async createBinding(input: Omit<CreateChannelBindingInput, 'userId'>): Promise<ChannelBinding> {
    const { accountId, spaceId, nativeContextId } = input;
    if (!accountId || !spaceId || !nativeContextId) {
      throw new ValidationError('accountId, spaceId, and nativeContextId are required');
    }

    // Verify account exists and belongs to user
    const checkAccount = await this.findAccountById(accountId);
    if (!checkAccount) {
      throw new NotFoundError(`Channel account "${accountId}" not found`);
    }

    // Verify space exists and belongs to user
    const checkSpace = this.db.prepare('SELECT 1 FROM spaces WHERE id = ? AND user_id = ?').get(spaceId, this.userId);
    if (!checkSpace) {
      throw new NotFoundError(`Space "${spaceId}" not found`);
    }

    const existingBinding = await this.findBindingByContext(accountId, nativeContextId);
    if (existingBinding) {
      throw new ConflictError(
        `Binding for account "${accountId}" and native context "${nativeContextId}" already exists`
      );
    }

    const id = input.id && typeof input.id === 'string' && input.id.trim()
      ? input.id.trim()
      : `cb_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    const activationMode = input.activationMode ?? 'mention';
    const chatType = input.chatType ?? null;

    const insertStmt = this.db.prepare(`
      INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id, activation_mode, chat_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    insertStmt.run(id, this.userId, accountId, spaceId, nativeContextId, activationMode, chatType);

    const created = await this.findBindingById(id);
    if (!created) {
      throw new Error('Failed to retrieve newly created channel binding');
    }
    return created;
  }

  async updateBinding(id: string, input: UpdateChannelBindingInput): Promise<ChannelBinding> {
    const binding = await this.findBindingById(id);
    if (!binding) {
      throw new NotFoundError(`Channel binding "${id}" not found`);
    }

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (input.spaceId !== undefined) {
      const checkSpace = this.db.prepare('SELECT 1 FROM spaces WHERE id = ? AND user_id = ?').get(input.spaceId, this.userId);
      if (!checkSpace) {
        throw new NotFoundError(`Space "${input.spaceId}" not found`);
      }
      updates.push('space_id = ?');
      params.push(input.spaceId);
    }
    if (input.activationMode !== undefined) {
      updates.push('activation_mode = ?');
      params.push(input.activationMode);
    }
    if (input.chatType !== undefined) {
      updates.push('chat_type = ?');
      params.push(input.chatType);
    }

    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(id, this.userId);
      const sql = `UPDATE channel_bindings SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`;
      this.db.prepare(sql).run(...params);
    }

    const updated = await this.findBindingById(id);
    if (!updated) {
      throw new Error('Failed to retrieve updated channel binding');
    }
    return updated;
  }

  async setGroupActivationModeForAccountBindings(
    accountId: string,
    mode: ChannelActivationMode
  ): Promise<number> {
    if (!accountId || typeof accountId !== 'string') return 0;
    const stmt = this.db.prepare(
      `UPDATE channel_bindings
       SET activation_mode = ?, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND account_id = ? AND chat_type = 'group' AND activation_mode != ?`
    );
    const result = stmt.run(mode, this.userId, accountId, mode);
    return Number(result.changes);
  }

  async deleteBinding(id: string): Promise<boolean> {
    const stmt = this.db.prepare('DELETE FROM channel_bindings WHERE id = ? AND user_id = ?');
    const result = stmt.run(id, this.userId);
    return Number(result.changes) > 0;
  }

  // ──────────────── Inbox Operations ────────────────

  async findInboxByEvent(accountId: string, nativeEventId: string): Promise<ChannelInboxItem | null> {
    if (!accountId || !nativeEventId) return null;
    const stmt = this.db.prepare(
      'SELECT * FROM channel_inbox WHERE user_id = ? AND account_id = ? AND native_event_id = ?'
    );
    return queryOne(stmt, parseChannelInboxRow, this.userId, accountId, nativeEventId);
  }

  async createInboxItem(
    input: Omit<CreateChannelInboxInput, 'userId'>
  ): Promise<{ item: ChannelInboxItem; isDuplicate: boolean }> {
    const { accountId, nativeEventId, nativeContextId, payloadJson } = input;
    if (!accountId || !nativeEventId || !nativeContextId) {
      throw new ValidationError('accountId, nativeEventId, and nativeContextId are required');
    }

    // Check if event already exists
    const existing = await this.findInboxByEvent(accountId, nativeEventId);
    if (existing) {
      return { item: existing, isDuplicate: true };
    }

    const id = input.id && typeof input.id === 'string' && input.id.trim()
      ? input.id.trim()
      : `inb_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    const status = input.status ?? 'held';

    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO channel_inbox (id, user_id, account_id, native_event_id, native_context_id, payload_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    const res = insertStmt.run(id, this.userId, accountId, nativeEventId, nativeContextId, payloadJson, status);

    if (Number(res.changes) === 0) {
      // Race condition hit: another process inserted duplicate
      const raceItem = await this.findInboxByEvent(accountId, nativeEventId);
      if (raceItem) {
        return { item: raceItem, isDuplicate: true };
      }
    }

    const stmt = this.db.prepare('SELECT * FROM channel_inbox WHERE id = ? AND user_id = ?');
    const created = queryOne(stmt, parseChannelInboxRow, id, this.userId);
    if (!created) {
      throw new Error('Failed to retrieve newly created channel inbox item');
    }
    return { item: created, isDuplicate: false };
  }

  async updateInboxStatus(id: string, status: ChannelInboxItem['status']): Promise<ChannelInboxItem> {
    const stmt = this.db.prepare(`
      UPDATE channel_inbox
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `);
    stmt.run(status, id, this.userId);

    const getStmt = this.db.prepare('SELECT * FROM channel_inbox WHERE id = ? AND user_id = ?');
    const updated = queryOne(getStmt, parseChannelInboxRow, id, this.userId);
    if (!updated) {
      throw new NotFoundError(`Channel inbox item "${id}" not found`);
    }
    return updated;
  }

  async claimInboxForProcessing(id: string): Promise<ChannelInboxItem | null> {
    const stmt = this.db.prepare(`
      UPDATE channel_inbox
      SET status = 'processing', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ? AND status IN ('held', 'failed')
    `);
    const result = stmt.run(id, this.userId);
    if (Number(result.changes) === 0) {
      return null;
    }
    const getStmt = this.db.prepare('SELECT * FROM channel_inbox WHERE id = ? AND user_id = ?');
    return queryOne(getStmt, parseChannelInboxRow, id, this.userId);
  }

  async listHeldInbox(limit = 50, accountId?: string): Promise<ChannelInboxItem[]> {
    if (accountId) {
      const stmt = this.db.prepare(
        "SELECT * FROM channel_inbox WHERE user_id = ? AND account_id = ? AND status = 'held' ORDER BY created_at ASC LIMIT ?"
      );
      return queryAll(stmt, parseChannelInboxRow, this.userId, accountId, limit);
    }
    const stmt = this.db.prepare(
      "SELECT * FROM channel_inbox WHERE user_id = ? AND status = 'held' ORDER BY created_at ASC LIMIT ?"
    );
    return queryAll(stmt, parseChannelInboxRow, this.userId, limit);
  }

  // ──────────────── Outbox Operations ────────────────

  async createOutboxItem(input: Omit<CreateChannelOutboxInput, 'userId'>): Promise<ChannelOutboxItem> {
    const { accountId, sessionId, nativeContextId, payloadJson } = input;
    if (!accountId || !sessionId || !nativeContextId) {
      throw new ValidationError('accountId, sessionId, and nativeContextId are required');
    }

    const id = input.id && typeof input.id === 'string' && input.id.trim()
      ? input.id.trim()
      : `out_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    const status = input.status ?? 'pending';
    const replyToNativeId = input.replyToNativeId ?? null;

    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO channel_outbox (id, user_id, account_id, session_id, native_context_id, reply_to_native_id, payload_json, status, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    insertStmt.run(id, this.userId, accountId, sessionId, nativeContextId, replyToNativeId, payloadJson, status);

    const created = await this.findOutboxById(id);
    if (!created) {
      throw new Error('Failed to retrieve channel outbox item');
    }
    return created;
  }

  async findOutboxById(id: string): Promise<ChannelOutboxItem | null> {
    if (!id || typeof id !== 'string') return null;
    const stmt = this.db.prepare('SELECT * FROM channel_outbox WHERE id = ? AND user_id = ?');
    return queryOne(stmt, parseChannelOutboxRow, id, this.userId);
  }

  async listPendingOutbox(limit = 50, accountId?: string): Promise<ChannelOutboxItem[]> {
    if (accountId) {
      const stmt = this.db.prepare(
        "SELECT * FROM channel_outbox WHERE user_id = ? AND account_id = ? AND status IN ('pending', 'sending') ORDER BY created_at ASC LIMIT ?"
      );
      return queryAll(stmt, parseChannelOutboxRow, this.userId, accountId, limit);
    }
    const stmt = this.db.prepare(
      "SELECT * FROM channel_outbox WHERE user_id = ? AND status IN ('pending', 'sending') ORDER BY created_at ASC LIMIT ?"
    );
    return queryAll(stmt, parseChannelOutboxRow, this.userId, limit);
  }

  async claimPendingOutboxItem(id: string, accountId?: string): Promise<ChannelOutboxItem | null> {
    if (accountId) {
      const stmt = this.db.prepare(`
        UPDATE channel_outbox
        SET status = 'sending', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ? AND account_id = ? AND status = 'pending'
      `);
      const res = stmt.run(id, this.userId, accountId);
      if (Number(res.changes) === 0) {
        return null;
      }
    } else {
      const stmt = this.db.prepare(`
        UPDATE channel_outbox
        SET status = 'sending', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ? AND status = 'pending'
      `);
      const res = stmt.run(id, this.userId);
      if (Number(res.changes) === 0) {
        return null;
      }
    }
    const getStmt = this.db.prepare('SELECT * FROM channel_outbox WHERE id = ? AND user_id = ?');
    return queryOne(getStmt, parseChannelOutboxRow, id, this.userId);
  }

  async updateOutboxStatus(
    id: string,
    status: ChannelOutboxItem['status'],
    incrementAttempt = false
  ): Promise<ChannelOutboxItem> {
    const sql = incrementAttempt
      ? `UPDATE channel_outbox SET status = ?, attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`
      : `UPDATE channel_outbox SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`;

    this.db.prepare(sql).run(status, id, this.userId);

    const updated = await this.findOutboxById(id);
    if (!updated) {
      throw new NotFoundError(`Channel outbox item "${id}" not found`);
    }
    return updated;
  }

  async recoverStaleSendingOutbox(staleAfterSeconds = 60, accountId?: string): Promise<number> {
    const modifier = `-${Math.max(1, staleAfterSeconds)} seconds`;
    let changes = 0;

    // Reset sending items that have attempts < 3 back to pending
    if (accountId) {
      const resetStmt = this.db.prepare(`
        UPDATE channel_outbox
        SET status = 'pending', updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND account_id = ? AND status = 'sending' AND attempts < 3
          AND datetime(updated_at) < datetime('now', ?)
      `);
      const res = resetStmt.run(this.userId, accountId, modifier);
      changes += Number(res.changes);

      // Mark sending items with attempts >= 3 as failed
      const failStmt = this.db.prepare(`
        UPDATE channel_outbox
        SET status = 'failed', updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND account_id = ? AND status = 'sending' AND attempts >= 3
          AND datetime(updated_at) < datetime('now', ?)
      `);
      const failRes = failStmt.run(this.userId, accountId, modifier);
      changes += Number(failRes.changes);
    } else {
      const resetStmt = this.db.prepare(`
        UPDATE channel_outbox
        SET status = 'pending', updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND status = 'sending' AND attempts < 3
          AND datetime(updated_at) < datetime('now', ?)
      `);
      const res = resetStmt.run(this.userId, modifier);
      changes += Number(res.changes);

      const failStmt = this.db.prepare(`
        UPDATE channel_outbox
        SET status = 'failed', updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND status = 'sending' AND attempts >= 3
          AND datetime(updated_at) < datetime('now', ?)
      `);
      const failRes = failStmt.run(this.userId, modifier);
      changes += Number(failRes.changes);
    }

    return changes;
  }
}
