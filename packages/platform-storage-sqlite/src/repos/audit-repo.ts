import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AuthAuditLog,
  CreateAuthAuditLogInput,
  AuthAuditLogRepository,
} from '@enkeep/platform-core';
import { type DbParam, parseAuthAuditLogRow, queryOne, queryAll } from '../utils/db.js';

export class SqliteAuthAuditLogRepository implements AuthAuditLogRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async create(input: CreateAuthAuditLogInput): Promise<AuthAuditLog> {
    const id = input.id ?? randomUUID();
    const detailsStr = input.details !== undefined && input.details !== null
      ? JSON.stringify(input.details)
      : null;

    this.db.prepare(`
      INSERT INTO auth_audit_log (id, user_id, username, action, ip_address, user_agent, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      id,
      input.userId ?? null,
      input.username ?? null,
      input.action,
      input.ipAddress ?? null,
      input.userAgent ?? null,
      detailsStr ?? null
    );

    const stmt = this.db.prepare('SELECT * FROM auth_audit_log WHERE id = ?');
    const audit = queryOne(stmt, parseAuthAuditLogRow, id);
    if (!audit) {
      throw new Error('Failed to retrieve newly created audit log');
    }
    return audit;
  }

  async listByUserId(userId: string, options?: { limit?: number; offset?: number }): Promise<AuthAuditLog[]> {
    let sql = 'SELECT * FROM auth_audit_log WHERE user_id = ? ORDER BY created_at DESC, rowid DESC';
    const params: DbParam[] = [userId];

    if (options?.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
      if (options?.offset) {
        sql += ' OFFSET ?';
        params.push(options.offset);
      }
    }

    const stmt = this.db.prepare(sql);
    return queryAll(stmt, parseAuthAuditLogRow, ...params);
  }

  async listRecent(options?: { limit?: number; offset?: number; action?: string }): Promise<AuthAuditLog[]> {
    const clauses: string[] = [];
    const params: DbParam[] = [];

    if (options?.action) {
      clauses.push('action = ?');
      params.push(options.action);
    }

    let sql = 'SELECT * FROM auth_audit_log';
    if (clauses.length > 0) {
      sql += ` WHERE ${clauses.join(' AND ')}`;
    }
    sql += ' ORDER BY created_at DESC, rowid DESC';

    if (options?.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
      if (options?.offset) {
        sql += ' OFFSET ?';
        params.push(options.offset);
      }
    }

    const stmt = this.db.prepare(sql);
    return queryAll(stmt, parseAuthAuditLogRow, ...params);
  }

  async countRecentFailures(options: { username?: string; ipAddress?: string; windowSeconds?: number }): Promise<number> {
    const windowSeconds = options.windowSeconds ?? 900; // default: 15 minutes (900s)
    const clauses: string[] = ["action IN ('login_failure', 'account_disabled')"];
    const params: DbParam[] = [];

    clauses.push("created_at >= datetime('now', '-' || ? || ' seconds')");
    params.push(windowSeconds);

    if (options.username && options.ipAddress) {
      clauses.push('username = ? AND ip_address = ?');
      params.push(options.username, options.ipAddress);
    } else if (options.username) {
      clauses.push('username = ?');
      params.push(options.username);
    } else if (options.ipAddress) {
      clauses.push('ip_address = ?');
      params.push(options.ipAddress);
    }

    const sql = `SELECT COUNT(*) as count FROM auth_audit_log WHERE ${clauses.join(' AND ')}`;
    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }
}
