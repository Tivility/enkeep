import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { UserSession, CreateUserSessionInput, UpdateUserSessionInput, UserSessionRepository } from '@enkeep/platform-core';
import { NotFoundError } from '@enkeep/platform-core';
import { type DbParam, parseUserSessionRow, queryOne, queryAll } from '../utils/db.js';

export class SqliteUserSessionRepository implements UserSessionRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async findById(id: string): Promise<UserSession | null> {
    const stmt = this.db.prepare('SELECT * FROM user_sessions WHERE id = ?');
    return queryOne(stmt, parseUserSessionRow, id);
  }

  async findByTokenHash(tokenHash: string): Promise<UserSession | null> {
    const stmt = this.db.prepare('SELECT * FROM user_sessions WHERE token_hash = ?');
    return queryOne(stmt, parseUserSessionRow, tokenHash);
  }

  async create(input: CreateUserSessionInput): Promise<UserSession> {
    const id = input.id ?? randomUUID();
    const userAgent = input.userAgent ?? null;
    const ipAddress = input.ipAddress ?? null;

    this.db.prepare(`
      INSERT INTO user_sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at, revoked_at, user_agent, ip_address)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, ?, ?)
    `).run(id, input.userId, input.tokenHash, input.expiresAt, userAgent, ipAddress);

    const session = await this.findById(id);
    if (!session) {
      throw new Error('Failed to retrieve newly created user session');
    }
    return session;
  }

  async update(id: string, input: UpdateUserSessionInput): Promise<UserSession> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new NotFoundError('User session not found');
    }

    const updates: string[] = [];
    const params: DbParam[] = [];

    if (input.lastSeenAt !== undefined) {
      updates.push('last_seen_at = ?');
      params.push(input.lastSeenAt);
    }
    if (input.revokedAt !== undefined) {
      updates.push('revoked_at = ?');
      params.push(input.revokedAt);
    }

    if (updates.length > 0) {
      params.push(id);
      const sql = `UPDATE user_sessions SET ${updates.join(', ')} WHERE id = ?`;
      this.db.prepare(sql).run(...params);
    }

    const updated = await this.findById(id);
    if (!updated) {
      throw new NotFoundError('User session not found');
    }
    return updated;
  }

  async revoke(id: string, revokedAt = new Date().toISOString()): Promise<void> {
    this.db.prepare('UPDATE user_sessions SET revoked_at = ? WHERE id = ?').run(revokedAt, id);
  }

  async revokeAllForUser(userId: string, revokedAt = new Date().toISOString()): Promise<number> {
    const result = this.db.prepare(
      'UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'
    ).run(revokedAt, userId);
    return Number(result.changes);
  }

  async deleteExpired(now = new Date().toISOString()): Promise<number> {
    const result = this.db.prepare(
      'DELETE FROM user_sessions WHERE expires_at < ? OR revoked_at IS NOT NULL'
    ).run(now);
    return Number(result.changes);
  }

  async listByUserId(userId: string, activeOnly = false): Promise<UserSession[]> {
    let sql = 'SELECT * FROM user_sessions WHERE user_id = ?';
    const params: DbParam[] = [userId];

    if (activeOnly) {
      sql += ' AND revoked_at IS NULL AND expires_at >= CURRENT_TIMESTAMP';
    }
    sql += ' ORDER BY created_at DESC';

    const stmt = this.db.prepare(sql);
    return queryAll(stmt, parseUserSessionRow, ...params);
  }
}
