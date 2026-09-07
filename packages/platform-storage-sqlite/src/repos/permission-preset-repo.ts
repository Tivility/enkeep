import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  PermissionPresetRecord,
  SetPermissionPresetInput,
} from '@enkeep/platform-core';
import {
  PermissionPresetRevisionMismatchError,
  ValidationError,
} from '@enkeep/platform-core';
import { queryOne, queryAll } from '../utils/db.js';

export function parsePermissionPresetRow(row: any): PermissionPresetRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    spaceId: row.space_id ? String(row.space_id) : null,
    profileId: row.profile_id ? String(row.profile_id) : null,
    preset: row.preset,
    sandboxMode: row.sandbox_mode,
    approvalPolicy: row.approval_policy,
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class PermissionPresetRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly userId: string
  ) {}

  async getEffectivePreset(params: {
    userId?: string;
    spaceId?: string | null;
    profileId?: string | null;
  }): Promise<PermissionPresetRecord | null> {
    const targetUserId = params.userId ?? this.userId;
    // 1. Space + Profile match
    if (params.spaceId && params.profileId) {
      const stmt = this.db.prepare(
        'SELECT * FROM permission_presets WHERE user_id = ? AND space_id = ? AND profile_id = ? LIMIT 1'
      );
      const row = queryOne(stmt, parsePermissionPresetRow, targetUserId, params.spaceId, params.profileId);
      if (row) return row;
    }

    // 2. Space-specific match
    if (params.spaceId) {
      const stmt = this.db.prepare(
        'SELECT * FROM permission_presets WHERE user_id = ? AND space_id = ? AND profile_id IS NULL LIMIT 1'
      );
      const row = queryOne(stmt, parsePermissionPresetRow, targetUserId, params.spaceId);
      if (row) return row;
    }

    // 3. Profile-specific match
    if (params.profileId) {
      const stmt = this.db.prepare(
        'SELECT * FROM permission_presets WHERE user_id = ? AND profile_id = ? AND space_id IS NULL LIMIT 1'
      );
      const row = queryOne(stmt, parsePermissionPresetRow, targetUserId, params.profileId);
      if (row) return row;
    }

    // 4. User default match
    const stmt = this.db.prepare(
      'SELECT * FROM permission_presets WHERE user_id = ? AND space_id IS NULL AND profile_id IS NULL LIMIT 1'
    );
    return queryOne(stmt, parsePermissionPresetRow, targetUserId);
  }

  async getPresetById(id: string): Promise<PermissionPresetRecord | null> {
    const stmt = this.db.prepare(
      'SELECT * FROM permission_presets WHERE id = ? AND user_id = ? LIMIT 1'
    );
    return queryOne(stmt, parsePermissionPresetRow, id, this.userId);
  }

  async listPresets(userId?: string): Promise<PermissionPresetRecord[]> {
    const targetUserId = userId ?? this.userId;
    const stmt = this.db.prepare(
      'SELECT * FROM permission_presets WHERE user_id = ? ORDER BY created_at ASC'
    );
    return queryAll(stmt, parsePermissionPresetRow, targetUserId);
  }

  async setPreset(input: SetPermissionPresetInput): Promise<PermissionPresetRecord> {
    const targetUserId = input.userId ?? this.userId;
    const spaceId = input.spaceId ?? null;
    const profileId = input.profileId ?? null;
    const preset = input.preset;

    let sandboxMode = input.sandboxMode;
    let approvalPolicy = input.approvalPolicy;

    if (!sandboxMode || !approvalPolicy) {
      switch (preset) {
        case 'read-only':
          sandboxMode = sandboxMode ?? 'read-only';
          approvalPolicy = approvalPolicy ?? 'ask';
          break;
        case 'workspace-write':
          sandboxMode = sandboxMode ?? 'workspace-write';
          approvalPolicy = approvalPolicy ?? 'ask';
          break;
        case 'danger-full-access':
          sandboxMode = sandboxMode ?? 'danger-full-access';
          approvalPolicy = approvalPolicy ?? 'never';
          break;
        case 'custom':
          sandboxMode = sandboxMode ?? 'workspace-write';
          approvalPolicy = approvalPolicy ?? 'ask';
          break;
        default:
          throw new ValidationError(`Unknown permission preset: ${String(preset)}`);
      }
    }

    let existing: PermissionPresetRecord | null = null;
    if (input.id) {
      existing = await this.getPresetById(input.id);
    } else {
      let findStmt;
      if (spaceId && profileId) {
        findStmt = this.db.prepare(
          'SELECT * FROM permission_presets WHERE user_id = ? AND space_id = ? AND profile_id = ? LIMIT 1'
        );
        existing = queryOne(findStmt, parsePermissionPresetRow, targetUserId, spaceId, profileId);
      } else if (spaceId) {
        findStmt = this.db.prepare(
          'SELECT * FROM permission_presets WHERE user_id = ? AND space_id = ? AND profile_id IS NULL LIMIT 1'
        );
        existing = queryOne(findStmt, parsePermissionPresetRow, targetUserId, spaceId);
      } else if (profileId) {
        findStmt = this.db.prepare(
          'SELECT * FROM permission_presets WHERE user_id = ? AND profile_id = ? AND space_id IS NULL LIMIT 1'
        );
        existing = queryOne(findStmt, parsePermissionPresetRow, targetUserId, profileId);
      } else {
        findStmt = this.db.prepare(
          'SELECT * FROM permission_presets WHERE user_id = ? AND space_id IS NULL AND profile_id IS NULL LIMIT 1'
        );
        existing = queryOne(findStmt, parsePermissionPresetRow, targetUserId);
      }
    }

    if (existing) {
      if (input.revision !== undefined && input.revision !== existing.revision) {
        throw new PermissionPresetRevisionMismatchError(
          `Permission preset revision mismatch: expected ${existing.revision}, got ${input.revision}`,
          existing.revision,
          input.revision
        );
      }

      const nextRevision = existing.revision + 1;
      const updateStmt = this.db.prepare(`
        UPDATE permission_presets
        SET preset = ?, sandbox_mode = ?, approval_policy = ?, revision = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND revision = ? AND user_id = ?
      `);
      const result = updateStmt.run(
        preset,
        sandboxMode,
        approvalPolicy,
        nextRevision,
        existing.id,
        existing.revision,
        targetUserId
      );

      if (result.changes === 0) {
        const current = await this.getPresetById(existing.id);
        throw new PermissionPresetRevisionMismatchError(
          `Concurrent update conflict on permission preset ${existing.id}`,
          current?.revision,
          input.revision
        );
      }

      return (await this.getPresetById(existing.id))!;
    } else {
      const id = input.id ?? `preset_${randomUUID().replace(/-/g, '')}`;
      const insertStmt = this.db.prepare(`
        INSERT INTO permission_presets (id, user_id, space_id, profile_id, preset, sandbox_mode, approval_policy, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `);
      insertStmt.run(id, targetUserId, spaceId, profileId, preset, sandboxMode, approvalPolicy);

      return (await this.getPresetById(id))!;
    }
  }

  async deletePreset(id: string): Promise<boolean> {
    const stmt = this.db.prepare(
      'DELETE FROM permission_presets WHERE id = ? AND user_id = ?'
    );
    const result = stmt.run(id, this.userId);
    return result.changes > 0;
  }
}
