import type { DatabaseSync } from 'node:sqlite';
import type {
  SkillPackage,
  SkillPackageVersion,
  SkillBinding,
  SkillOperation,
  SkillScope,
  SkillSourceType,
  SkillStatus,
  SkillOperationType,
  SkillOperationStatus,
  TenantScopedSkillPackageRepository,
  TenantScopedSkillBindingRepository,
  TenantScopedSkillOperationRepository,
} from '@enkeep/platform-core';
import { NotFoundError, ValidationError } from '@enkeep/platform-core';
import {
  type DbParam,
  type DbRow,
  getString,
  getNullableString,
  getNumber,
  getNullableNumber,
  queryOne,
  queryAll,
} from '../utils/db.js';

function parseSkillPackageRow(row: DbRow): SkillPackage {
  return {
    id: getString(row, 'id'),
    userId: getString(row, 'user_id'),
    name: getString(row, 'name'),
    scope: getString(row, 'scope') as SkillScope,
    spaceId: getNullableString(row, 'space_id'),
    version: getNumber(row, 'version'),
    sourceType: getString(row, 'source_type') as SkillSourceType,
    sourceUrl: getNullableString(row, 'source_url'),
    sourceRef: getNullableString(row, 'source_ref'),
    commitSha: getNullableString(row, 'commit_sha'),
    subdirectory: getNullableString(row, 'subdirectory'),
    contentHash: getString(row, 'content_hash'),
    manifestJson: getNullableString(row, 'manifest_json'),
    status: getString(row, 'status') as SkillStatus,
    createdAt: getString(row, 'created_at'),
    updatedAt: getString(row, 'updated_at'),
  };
}

function parseSkillPackageVersionRow(row: DbRow): SkillPackageVersion {
  return {
    id: getString(row, 'id'),
    packageId: getString(row, 'package_id'),
    version: getNumber(row, 'version'),
    commitSha: getNullableString(row, 'commit_sha'),
    contentHash: getString(row, 'content_hash'),
    manifestJson: getNullableString(row, 'manifest_json'),
    changeSummary: getNullableString(row, 'change_summary'),
    createdAt: getString(row, 'created_at'),
  };
}

function parseSkillBindingRow(row: DbRow): SkillBinding {
  return {
    id: getString(row, 'id'),
    userId: getString(row, 'user_id'),
    spaceId: getString(row, 'space_id'),
    skillName: getString(row, 'skill_name'),
    enabled: getNumber(row, 'enabled') === 1,
    packageId: getNullableString(row, 'package_id'),
    createdAt: getString(row, 'created_at'),
    updatedAt: getString(row, 'updated_at'),
  };
}

function parseSkillOperationRow(row: DbRow): SkillOperation {
  return {
    id: getString(row, 'id'),
    userId: getString(row, 'user_id'),
    operationType: getString(row, 'operation_type') as SkillOperationType,
    skillName: getString(row, 'skill_name'),
    targetScope: getString(row, 'target_scope') as SkillScope,
    targetSpaceId: getNullableString(row, 'target_space_id'),
    idempotencyKey: getNullableString(row, 'idempotency_key'),
    requestHash: getString(row, 'request_hash'),
    status: getString(row, 'status') as SkillOperationStatus,
    detailsJson: getNullableString(row, 'details_json'),
    errorMessage: getNullableString(row, 'error_message'),
    createdAt: getString(row, 'created_at'),
    updatedAt: getString(row, 'updated_at'),
  };
}

export class SqliteTenantScopedSkillPackageRepository implements TenantScopedSkillPackageRepository {
  readonly userId: string;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  async findById(id: string): Promise<SkillPackage | null> {
    const stmt = this.db.prepare('SELECT * FROM skill_packages WHERE id = ? AND user_id = ?');
    return queryOne(stmt, parseSkillPackageRow, id, this.userId);
  }

  async findByName(name: string, scope?: SkillScope, spaceId?: string | null): Promise<SkillPackage | null> {
    let sql = 'SELECT * FROM skill_packages WHERE user_id = ? AND name = ?';
    const params: DbParam[] = [this.userId, name];

    if (scope !== undefined) {
      sql += ' AND scope = ?';
      params.push(scope);
    }
    if (spaceId !== undefined) {
      if (spaceId === null) {
        sql += ' AND space_id IS NULL';
      } else {
        sql += ' AND space_id = ?';
        params.push(spaceId);
      }
    }

    sql += ' ORDER BY created_at DESC LIMIT 1';
    const stmt = this.db.prepare(sql);
    return queryOne(stmt, parseSkillPackageRow, ...params);
  }

  async create(input: Omit<SkillPackage, 'userId' | 'createdAt' | 'updatedAt'> | SkillPackage): Promise<SkillPackage> {
    const id = input.id ?? `spkg_${crypto.randomUUID()}`;
    const scope = input.scope ?? 'global';
    const spaceId = input.spaceId ?? null;
    const version = input.version ?? 1;
    const sourceType = input.sourceType ?? 'upload';
    const sourceUrl = input.sourceUrl ?? null;
    const sourceRef = input.sourceRef ?? null;
    const commitSha = input.commitSha ?? null;
    const subdirectory = input.subdirectory ?? null;
    const contentHash = input.contentHash;
    const manifestJson = input.manifestJson ?? null;
    const status = input.status ?? 'active';

    this.db.prepare(`
      INSERT INTO skill_packages (
        id, user_id, name, scope, space_id, version,
        source_type, source_url, source_ref, commit_sha, subdirectory,
        content_hash, manifest_json, status, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `).run(
      id,
      this.userId,
      input.name,
      scope,
      spaceId,
      version,
      sourceType,
      sourceUrl,
      sourceRef,
      commitSha,
      subdirectory,
      contentHash,
      manifestJson,
      status
    );

    const created = await this.findById(id);
    if (!created) {
      throw new NotFoundError('Failed to retrieve newly created skill package');
    }
    return created;
  }

  async update(id: string, input: Partial<Omit<SkillPackage, 'id' | 'userId' | 'createdAt' | 'updatedAt'>>): Promise<SkillPackage> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new NotFoundError(`Skill package not found: ${id}`);
    }

    const updates: string[] = ['updated_at = CURRENT_TIMESTAMP'];
    const params: DbParam[] = [];

    if (input.name !== undefined) {
      updates.push('name = ?');
      params.push(input.name);
    }
    if (input.scope !== undefined) {
      updates.push('scope = ?');
      params.push(input.scope);
    }
    if (input.spaceId !== undefined) {
      updates.push('space_id = ?');
      params.push(input.spaceId);
    }
    if (input.version !== undefined) {
      updates.push('version = ?');
      params.push(input.version);
    }
    if (input.sourceType !== undefined) {
      updates.push('source_type = ?');
      params.push(input.sourceType);
    }
    if (input.sourceUrl !== undefined) {
      updates.push('source_url = ?');
      params.push(input.sourceUrl);
    }
    if (input.sourceRef !== undefined) {
      updates.push('source_ref = ?');
      params.push(input.sourceRef);
    }
    if (input.commitSha !== undefined) {
      updates.push('commit_sha = ?');
      params.push(input.commitSha);
    }
    if (input.subdirectory !== undefined) {
      updates.push('subdirectory = ?');
      params.push(input.subdirectory);
    }
    if (input.contentHash !== undefined) {
      updates.push('content_hash = ?');
      params.push(input.contentHash);
    }
    if (input.manifestJson !== undefined) {
      updates.push('manifest_json = ?');
      params.push(input.manifestJson);
    }
    if (input.status !== undefined) {
      updates.push('status = ?');
      params.push(input.status);
    }

    params.push(id, this.userId);
    this.db.prepare(`
      UPDATE skill_packages
      SET ${updates.join(', ')}
      WHERE id = ? AND user_id = ?
    `).run(...params);

    const updated = await this.findById(id);
    if (!updated) {
      throw new NotFoundError('Failed to retrieve updated skill package');
    }
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const res = this.db.prepare('DELETE FROM skill_packages WHERE id = ? AND user_id = ?').run(id, this.userId);
    return Number(res.changes) > 0;
  }

  async createVersion(input: Omit<SkillPackageVersion, 'createdAt'> | SkillPackageVersion): Promise<SkillPackageVersion> {
    const id = input.id ?? `spver_${crypto.randomUUID()}`;
    this.db.prepare(`
      INSERT INTO skill_package_versions (
        id, package_id, version, commit_sha, content_hash, manifest_json, change_summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      id,
      input.packageId,
      input.version,
      input.commitSha ?? null,
      input.contentHash,
      input.manifestJson ?? null,
      input.changeSummary ?? null
    );

    const row = this.db.prepare('SELECT * FROM skill_package_versions WHERE id = ?').get(id) as DbRow | undefined;
    if (!row) {
      throw new NotFoundError('Failed to retrieve newly created skill package version');
    }
    return parseSkillPackageVersionRow(row);
  }

  async listVersions(packageId: string): Promise<SkillPackageVersion[]> {
    const stmt = this.db.prepare('SELECT * FROM skill_package_versions WHERE package_id = ? ORDER BY version ASC');
    return queryAll(stmt, parseSkillPackageVersionRow, packageId);
  }

  async getVersion(packageId: string, version: number): Promise<SkillPackageVersion | null> {
    const stmt = this.db.prepare('SELECT * FROM skill_package_versions WHERE package_id = ? AND version = ?');
    return queryOne(stmt, parseSkillPackageVersionRow, packageId, version);
  }

  async list(options?: { scope?: SkillScope; spaceId?: string | null; status?: SkillStatus; limit?: number; offset?: number }): Promise<SkillPackage[]> {
    let sql = 'SELECT * FROM skill_packages WHERE user_id = ?';
    const params: DbParam[] = [this.userId];

    if (options?.scope) {
      sql += ' AND scope = ?';
      params.push(options.scope);
    }
    if (options?.spaceId !== undefined) {
      if (options.spaceId === null) {
        sql += ' AND space_id IS NULL';
      } else {
        sql += ' AND space_id = ?';
        params.push(options.spaceId);
      }
    }
    if (options?.status) {
      sql += ' AND status = ?';
      params.push(options.status);
    }

    sql += ' ORDER BY created_at ASC';

    if (options?.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    if (options?.offset !== undefined) {
      sql += ' OFFSET ?';
      params.push(options.offset);
    }

    const stmt = this.db.prepare(sql);
    return queryAll(stmt, parseSkillPackageRow, ...params);
  }
}

export class SqliteTenantScopedSkillBindingRepository implements TenantScopedSkillBindingRepository {
  readonly userId: string;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  async findById(id: string): Promise<SkillBinding | null> {
    const stmt = this.db.prepare('SELECT * FROM skill_bindings WHERE id = ? AND user_id = ?');
    return queryOne(stmt, parseSkillBindingRow, id, this.userId);
  }

  async findBySpaceAndSkill(spaceId: string, skillName: string): Promise<SkillBinding | null> {
    const stmt = this.db.prepare('SELECT * FROM skill_bindings WHERE user_id = ? AND space_id = ? AND skill_name = ?');
    return queryOne(stmt, parseSkillBindingRow, this.userId, spaceId, skillName);
  }

  async listBySpace(spaceId: string): Promise<SkillBinding[]> {
    const stmt = this.db.prepare('SELECT * FROM skill_bindings WHERE user_id = ? AND space_id = ? ORDER BY skill_name ASC');
    return queryAll(stmt, parseSkillBindingRow, this.userId, spaceId);
  }

  async listBySkill(skillName: string): Promise<SkillBinding[]> {
    const stmt = this.db.prepare('SELECT * FROM skill_bindings WHERE user_id = ? AND skill_name = ? ORDER BY space_id ASC');
    return queryAll(stmt, parseSkillBindingRow, this.userId, skillName);
  }

  async setBinding(spaceId: string, skillName: string, enabled: boolean, packageId?: string | null): Promise<SkillBinding> {
    const existing = await this.findBySpaceAndSkill(spaceId, skillName);
    const enabledInt = enabled ? 1 : 0;

    if (existing) {
      this.db.prepare(`
        UPDATE skill_bindings
        SET enabled = ?, package_id = coalesce(?, package_id), updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `).run(enabledInt, packageId ?? null, existing.id, this.userId);

      const updated = await this.findById(existing.id);
      return updated!;
    }

    const id = `sbind_${crypto.randomUUID()}`;
    this.db.prepare(`
      INSERT INTO skill_bindings (id, user_id, space_id, skill_name, enabled, package_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(id, this.userId, spaceId, skillName, enabledInt, packageId ?? null);

    const created = await this.findById(id);
    return created!;
  }

  async deleteBySkill(skillName: string): Promise<number> {
    const res = this.db.prepare('DELETE FROM skill_bindings WHERE user_id = ? AND skill_name = ?').run(this.userId, skillName);
    return Number(res.changes);
  }

  async deleteBySpace(spaceId: string): Promise<number> {
    const res = this.db.prepare('DELETE FROM skill_bindings WHERE user_id = ? AND space_id = ?').run(this.userId, spaceId);
    return Number(res.changes);
  }

  async list(options?: { spaceId?: string; limit?: number; offset?: number }): Promise<SkillBinding[]> {
    let sql = 'SELECT * FROM skill_bindings WHERE user_id = ?';
    const params: DbParam[] = [this.userId];

    if (options?.spaceId) {
      sql += ' AND space_id = ?';
      params.push(options.spaceId);
    }
    sql += ' ORDER BY created_at ASC';

    if (options?.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    if (options?.offset !== undefined) {
      sql += ' OFFSET ?';
      params.push(options.offset);
    }

    const stmt = this.db.prepare(sql);
    return queryAll(stmt, parseSkillBindingRow, ...params);
  }
}

export class SqliteTenantScopedSkillOperationRepository implements TenantScopedSkillOperationRepository {
  readonly userId: string;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  async findById(id: string): Promise<SkillOperation | null> {
    const stmt = this.db.prepare('SELECT * FROM skill_operations WHERE id = ? AND user_id = ?');
    return queryOne(stmt, parseSkillOperationRow, id, this.userId);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<SkillOperation | null> {
    const stmt = this.db.prepare('SELECT * FROM skill_operations WHERE user_id = ? AND idempotency_key = ? LIMIT 1');
    return queryOne(stmt, parseSkillOperationRow, this.userId, idempotencyKey);
  }

  async create(input: Omit<SkillOperation, 'userId' | 'createdAt' | 'updatedAt'> | SkillOperation): Promise<SkillOperation> {
    const id = input.id ?? `spop_${crypto.randomUUID()}`;
    this.db.prepare(`
      INSERT INTO skill_operations (
        id, user_id, operation_type, skill_name, target_scope, target_space_id,
        idempotency_key, request_hash, status, details_json, error_message,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      id,
      this.userId,
      input.operationType,
      input.skillName,
      input.targetScope,
      input.targetSpaceId ?? null,
      input.idempotencyKey ?? null,
      input.requestHash,
      input.status,
      input.detailsJson ?? null,
      input.errorMessage ?? null
    );

    const created = await this.findById(id);
    if (!created) {
      throw new NotFoundError('Failed to retrieve newly created skill operation');
    }
    return created;
  }

  async list(options?: { status?: SkillOperationStatus; limit?: number; offset?: number }): Promise<SkillOperation[]> {
    let sql = 'SELECT * FROM skill_operations WHERE user_id = ?';
    const params: DbParam[] = [this.userId];

    if (options?.status) {
      sql += ' AND status = ?';
      params.push(options.status);
    }
    sql += ' ORDER BY created_at DESC';

    if (options?.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    if (options?.offset !== undefined) {
      sql += ' OFFSET ?';
      params.push(options.offset);
    }

    const stmt = this.db.prepare(sql);
    return queryAll(stmt, parseSkillOperationRow, ...params);
  }
}
