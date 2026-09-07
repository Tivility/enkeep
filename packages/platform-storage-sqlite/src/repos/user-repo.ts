import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { User, CreateUserInput, UpdateUserInput, UserRepository } from '@enkeep/platform-core';
import { NotFoundError } from '@enkeep/platform-core';
import { type DbParam, parseUserRow, queryOne, queryAll, getNumber } from '../utils/db.js';

export class SqliteUserRepository implements UserRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async findById(id: string): Promise<User | null> {
    const stmt = this.db.prepare('SELECT * FROM users WHERE id = ?');
    return queryOne(stmt, parseUserRow, id);
  }

  async findByUsername(username: string): Promise<User | null> {
    const stmt = this.db.prepare('SELECT * FROM users WHERE username = ?');
    return queryOne(stmt, parseUserRow, username);
  }

  async create(input: CreateUserInput): Promise<User> {
    const id = input.id ?? randomUUID();
    const role = input.role ?? 'user';
    const status = input.status ?? 'active';

    const columns: string[] = ['id', 'username', 'password_hash', 'role', 'status', 'created_at', 'updated_at'];
    const placeholders: string[] = ['?', '?', '?', '?', '?', 'CURRENT_TIMESTAMP', 'CURRENT_TIMESTAMP'];
    const params: DbParam[] = [id, input.username, input.passwordHash, role, status];

    if (input.displayName !== undefined) {
      columns.push('display_name');
      placeholders.push('?');
      params.push(input.displayName);
    }
    if (input.locale !== undefined) {
      columns.push('locale');
      placeholders.push('?');
      params.push(input.locale);
    }
    if (input.theme !== undefined) {
      columns.push('theme');
      placeholders.push('?');
      params.push(input.theme);
    }
    if (input.mustChangePassword !== undefined) {
      columns.push('must_change_password');
      placeholders.push('?');
      params.push(input.mustChangePassword ? 1 : 0);
    }

    this.db.prepare(`
      INSERT INTO users (${columns.join(', ')})
      VALUES (${placeholders.join(', ')})
    `).run(...params);

    const user = await this.findById(id);
    if (!user) {
      throw new Error('Failed to retrieve newly created user');
    }
    return user;
  }

  async update(id: string, input: UpdateUserInput): Promise<User> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new NotFoundError('User not found');
    }

    const updates: string[] = ['updated_at = CURRENT_TIMESTAMP'];
    const params: DbParam[] = [];

    if (input.passwordHash !== undefined) {
      updates.push('password_hash = ?');
      params.push(input.passwordHash);
    }
    if (input.role !== undefined) {
      updates.push('role = ?');
      params.push(input.role);
    }
    if (input.status !== undefined) {
      updates.push('status = ?');
      params.push(input.status);
    }
    if (input.displayName !== undefined) {
      updates.push('display_name = ?');
      params.push(input.displayName);
    }
    if (input.locale !== undefined) {
      updates.push('locale = ?');
      params.push(input.locale);
    }
    if (input.theme !== undefined) {
      updates.push('theme = ?');
      params.push(input.theme);
    }
    if (input.mustChangePassword !== undefined) {
      updates.push('must_change_password = ?');
      params.push(input.mustChangePassword ? 1 : 0);
    }

    params.push(id);
    const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...params);

    const updated = await this.findById(id);
    if (!updated) {
      throw new NotFoundError('User not found');
    }
    return updated;
  }

  async list(options?: { role?: string; status?: string; limit?: number; offset?: number }): Promise<User[]> {
    const clauses: string[] = [];
    const params: DbParam[] = [];

    if (options?.role) {
      clauses.push('role = ?');
      params.push(options.role);
    }
    if (options?.status) {
      clauses.push('status = ?');
      params.push(options.status);
    }

    let sql = 'SELECT * FROM users';
    if (clauses.length > 0) {
      sql += ` WHERE ${clauses.join(' AND ')}`;
    }
    sql += ' ORDER BY created_at ASC';

    if (options?.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
      if (options?.offset) {
        sql += ' OFFSET ?';
        params.push(options.offset);
      }
    }

    const stmt = this.db.prepare(sql);
    return queryAll(stmt, parseUserRow, ...params);
  }

  async count(): Promise<number> {
    const stmt = this.db.prepare('SELECT COUNT(*) AS cnt FROM users');
    const result = queryOne(stmt, (row) => getNumber(row, 'cnt'));
    return result ?? 0;
  }
}
