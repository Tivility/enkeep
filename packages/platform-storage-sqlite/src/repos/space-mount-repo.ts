import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  SpaceMount,
  CreateSpaceMountInput,
  TenantScopedSpaceMountRepository,
} from '@enkeep/platform-core';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  validateMountName,
  validateMountMode,
} from '@enkeep/platform-core';
import { queryOne, queryAll } from '../utils/db.js';

export function parseSpaceMountRow(row: any): SpaceMount {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    spaceId: String(row.space_id),
    name: String(row.name),
    sourcePathEncrypted: String(row.source_path_encrypted),
    sourceFingerprint: String(row.source_fingerprint),
    mode: row.mode === 'rw' ? 'rw' : 'ro',
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class SqliteTenantScopedSpaceMountRepository implements TenantScopedSpaceMountRepository {
  readonly userId: string;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  async findById(id: string): Promise<SpaceMount | null> {
    if (!id || typeof id !== 'string') return null;
    const stmt = this.db.prepare('SELECT * FROM space_mounts WHERE id = ? AND user_id = ?');
    return queryOne(stmt, parseSpaceMountRow, id, this.userId);
  }

  async findByName(spaceId: string, name: string): Promise<SpaceMount | null> {
    if (!spaceId || !name) return null;
    const stmt = this.db.prepare('SELECT * FROM space_mounts WHERE space_id = ? AND name = ? AND user_id = ?');
    return queryOne(stmt, parseSpaceMountRow, spaceId, name, this.userId);
  }

  async listBySpace(spaceId: string): Promise<SpaceMount[]> {
    if (!spaceId) return [];
    const stmt = this.db.prepare('SELECT * FROM space_mounts WHERE space_id = ? AND user_id = ? ORDER BY created_at ASC');
    return queryAll(stmt, parseSpaceMountRow, spaceId, this.userId);
  }

  async listAllForUser(): Promise<SpaceMount[]> {
    const stmt = this.db.prepare('SELECT * FROM space_mounts WHERE user_id = ? ORDER BY created_at ASC');
    return queryAll(stmt, parseSpaceMountRow, this.userId);
  }

  async create(input: CreateSpaceMountInput): Promise<SpaceMount> {
    const spaceId = input.spaceId;
    if (!spaceId || typeof spaceId !== 'string') {
      throw new ValidationError('spaceId is required');
    }

    // Verify space exists and belongs to this user
    const checkSpace = this.db.prepare('SELECT 1 FROM spaces WHERE id = ? AND user_id = ?').get(spaceId, this.userId);
    if (!checkSpace) {
      throw new NotFoundError(`Space "${spaceId}" not found`);
    }

    const name = validateMountName(input.name);
    const mode = validateMountMode(input.mode);

    if (!input.sourcePathEncrypted || typeof input.sourcePathEncrypted !== 'string') {
      throw new ValidationError('sourcePathEncrypted is required');
    }
    if (!input.sourceFingerprint || typeof input.sourceFingerprint !== 'string') {
      throw new ValidationError('sourceFingerprint is required');
    }

    // Check duplicate name in space
    const existingName = await this.findByName(spaceId, name);
    if (existingName) {
      throw new ConflictError(`Mount name "${name}" already exists in space "${spaceId}"`);
    }

    const id = input.id && typeof input.id === 'string' && input.id.trim()
      ? input.id.trim()
      : `mnt_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    const insertStmt = this.db.prepare(`
      INSERT INTO space_mounts (id, user_id, space_id, name, source_path_encrypted, source_fingerprint, mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    insertStmt.run(id, this.userId, spaceId, name, input.sourcePathEncrypted, input.sourceFingerprint, mode);

    const created = await this.findById(id);
    if (!created) {
      throw new Error('Failed to create space mount');
    }
    return created;
  }

  async restore(mount: SpaceMount): Promise<SpaceMount> {
    if (!mount || !mount.id || !mount.spaceId) {
      throw new ValidationError('Valid mount is required for restore');
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO space_mounts (id, user_id, space_id, name, source_path_encrypted, source_fingerprint, mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      mount.id,
      this.userId,
      mount.spaceId,
      mount.name,
      mount.sourcePathEncrypted,
      mount.sourceFingerprint,
      mount.mode,
      mount.createdAt,
      mount.updatedAt
    );

    const restored = await this.findById(mount.id);
    if (!restored) {
      throw new Error('Failed to restore space mount');
    }
    return restored;
  }

  async delete(id: string): Promise<boolean> {
    const res = this.db.prepare('DELETE FROM space_mounts WHERE id = ? AND user_id = ?').run(id, this.userId);
    return Number(res.changes) > 0;
  }

  async deleteBySpace(spaceId: string): Promise<number> {
    const res = this.db.prepare('DELETE FROM space_mounts WHERE space_id = ? AND user_id = ?').run(spaceId, this.userId);
    return Number(res.changes);
  }
}
