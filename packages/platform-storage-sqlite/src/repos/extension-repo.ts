/**
 * SQLite Repositories for Unified Extension Catalog (Migration 30)
 *
 * Implements tenant-scoped persistence for extension packages,
 * versions, contributions (skill, mcp, cli, dsh-plugin, browser),
 * bindings per space/contribution, and idempotent operations.
 *
 * @module @enkeep/platform-storage-sqlite/repos/extension-repo
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  PlatformError,
  NotFoundError,
  ValidationError,
  type ExtensionKind,
  type ExtensionSourceKind,
  type ExtensionPackageStatus,
  type ExtensionContributionStatus,
  type ExtensionPackageRecord,
  type ExtensionVersionRecord,
  type ExtensionContributionRecord,
  type ExtensionBindingRecord,
  type TenantScopedExtensionPackageRepository,
  type TenantScopedExtensionBindingRepository,
} from '@enkeep/platform-core';
import {
  type DbParam,
  queryOne,
  queryAll,
  withImmediateTransactionSync,
} from '../utils/db.js';
import { generateId } from '../utils/id.js';

// ---- Row Parsers ----

export function parseExtensionPackageRow(row: Record<string, unknown>): ExtensionPackageRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    slug: String(row.slug),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    sourceKind: row.source_kind as ExtensionSourceKind,
    sourceRef: row.source_ref ? String(row.source_ref) : null,
    installedVersion: Number(row.installed_version),
    activeVersion: Number(row.active_version),
    status: row.status as ExtensionPackageStatus,
    integritySha256: String(row.integrity_sha256),
    provenanceJson: row.provenance_json ? String(row.provenance_json) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function parseExtensionContributionRow(row: Record<string, unknown>): ExtensionContributionRecord {
  return {
    id: String(row.id),
    packageId: String(row.package_id),
    kind: row.kind as ExtensionKind,
    contributionKey: String(row.contribution_key),
    manifestJson: String(row.manifest_json),
    status: row.status as ExtensionContributionStatus,
    createdAt: row.created_at ? String(row.created_at) : undefined,
    updatedAt: row.updated_at ? String(row.updated_at) : undefined,
  };
}

export function parseExtensionBindingRow(row: Record<string, unknown>): ExtensionBindingRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    spaceId: String(row.space_id),
    contributionId: String(row.contribution_id),
    enabled: Number(row.enabled) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function parseExtensionVersionRow(row: Record<string, unknown>): ExtensionVersionRecord {
  return {
    id: String(row.id),
    packageId: String(row.package_id),
    version: Number(row.version),
    sourceKind: row.source_kind as ExtensionSourceKind,
    sourceRef: row.source_ref ? String(row.source_ref) : null,
    commitSha: row.commit_sha ? String(row.commit_sha) : null,
    integritySha256: String(row.integrity_sha256),
    manifestJson: row.manifest_json ? String(row.manifest_json) : null,
    artifactPath: row.artifact_path ? String(row.artifact_path) : null,
    changeSummary: row.change_summary ? String(row.change_summary) : null,
    createdAt: String(row.created_at),
  };
}

// ---- Package Repository ----

export class SqliteTenantScopedExtensionPackageRepository implements TenantScopedExtensionPackageRepository {
  readonly userId: string;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  async findById(id: string): Promise<ExtensionPackageRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM extension_packages WHERE id = ? AND user_id = ?');
    return queryOne(stmt, parseExtensionPackageRow, id, this.userId);
  }

  async findBySlug(slug: string): Promise<ExtensionPackageRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM extension_packages WHERE slug = ? AND user_id = ?');
    return queryOne(stmt, parseExtensionPackageRow, slug, this.userId);
  }

  async create(input: Omit<ExtensionPackageRecord, 'userId' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<ExtensionPackageRecord> {
    const id = input.id || generateId('ext_pkg');
    return withImmediateTransactionSync(this.db, () => {
      this.db.prepare(`
        INSERT INTO extension_packages (
          id, user_id, slug, name, description, source_kind,
          source_ref, installed_version, active_version, status,
          integrity_sha256, provenance_json, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `).run(
        id,
        this.userId,
        input.slug,
        input.name,
        input.description ?? null,
        input.sourceKind,
        input.sourceRef ?? null,
        input.installedVersion ?? 1,
        input.activeVersion ?? 1,
        input.status ?? 'active',
        input.integritySha256,
        input.provenanceJson ?? null
      );

      const stmt = this.db.prepare('SELECT * FROM extension_packages WHERE id = ? AND user_id = ?');
      const record = queryOne(stmt, parseExtensionPackageRow, id, this.userId);
      if (!record) {
        throw new PlatformError('Failed to retrieve newly created extension package record', 'INTERNAL_ERROR', 500);
      }
      return record;
    });
  }

  async update(id: string, input: Partial<Omit<ExtensionPackageRecord, 'id' | 'userId' | 'createdAt' | 'updatedAt'>>): Promise<ExtensionPackageRecord> {
    return withImmediateTransactionSync(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM extension_packages WHERE id = ? AND user_id = ?').get(id, this.userId);
      if (!existing) {
        throw new NotFoundError(`Extension package "${id}" not found`);
      }

      const updates: string[] = ['updated_at = CURRENT_TIMESTAMP'];
      const params: DbParam[] = [];

      if (input.name !== undefined) {
        updates.push('name = ?');
        params.push(input.name);
      }
      if (input.slug !== undefined) {
        updates.push('slug = ?');
        params.push(input.slug);
      }
      if (input.description !== undefined) {
        updates.push('description = ?');
        params.push(input.description ?? null);
      }
      if (input.sourceKind !== undefined) {
        updates.push('source_kind = ?');
        params.push(input.sourceKind);
      }
      if (input.sourceRef !== undefined) {
        updates.push('source_ref = ?');
        params.push(input.sourceRef ?? null);
      }
      if (input.installedVersion !== undefined) {
        updates.push('installed_version = ?');
        params.push(input.installedVersion);
      }
      if (input.activeVersion !== undefined) {
        updates.push('active_version = ?');
        params.push(input.activeVersion);
      }
      if (input.status !== undefined) {
        updates.push('status = ?');
        params.push(input.status);
      }
      if (input.integritySha256 !== undefined) {
        updates.push('integrity_sha256 = ?');
        params.push(input.integritySha256);
      }
      if (input.provenanceJson !== undefined) {
        updates.push('provenance_json = ?');
        params.push(input.provenanceJson ?? null);
      }

      params.push(id, this.userId);
      this.db.prepare(`UPDATE extension_packages SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);

      const stmt = this.db.prepare('SELECT * FROM extension_packages WHERE id = ? AND user_id = ?');
      const updated = queryOne(stmt, parseExtensionPackageRow, id, this.userId);
      if (!updated) {
        throw new PlatformError('Failed to retrieve updated extension package record', 'INTERNAL_ERROR', 500);
      }
      return updated;
    });
  }

  async delete(id: string): Promise<boolean> {
    const res = this.db.prepare('DELETE FROM extension_packages WHERE id = ? AND user_id = ?').run(id, this.userId);
    return Number(res.changes) > 0;
  }

  async list(options?: {
    kind?: ExtensionKind;
    sourceKind?: ExtensionSourceKind;
    status?: ExtensionPackageStatus;
    limit?: number;
    offset?: number;
  }): Promise<ExtensionPackageRecord[]> {
    let sql = 'SELECT * FROM extension_packages WHERE user_id = ?';
    const params: DbParam[] = [this.userId];

    if (options?.sourceKind) {
      sql += ' AND source_kind = ?';
      params.push(options.sourceKind);
    }
    if (options?.status) {
      sql += ' AND status = ?';
      params.push(options.status);
    }
    if (options?.kind) {
      sql += ' AND id IN (SELECT package_id FROM extension_contributions WHERE kind = ?)';
      params.push(options.kind);
    }

    sql += ' ORDER BY name ASC';

    if (options?.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
      if (options?.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(options.offset);
      }
    }

    const stmt = this.db.prepare(sql);
    return queryAll(stmt, parseExtensionPackageRow, ...params);
  }

  // ---- Version History ----

  async createVersion(input: Omit<ExtensionVersionRecord, 'createdAt'> & { id?: string }): Promise<ExtensionVersionRecord> {
    const id = input.id || generateId('ext_ver');
    return withImmediateTransactionSync(this.db, () => {
      this.db.prepare(`
        INSERT INTO extension_versions (
          id, package_id, version, source_kind, source_ref,
          commit_sha, integrity_sha256, manifest_json, artifact_path,
          change_summary, created_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, CURRENT_TIMESTAMP
        )
      `).run(
        id,
        input.packageId,
        input.version,
        input.sourceKind,
        input.sourceRef ?? null,
        input.commitSha ?? null,
        input.integritySha256,
        input.manifestJson ?? null,
        input.artifactPath ?? null,
        input.changeSummary ?? null
      );

      const stmt = this.db.prepare('SELECT * FROM extension_versions WHERE id = ?');
      const row = queryOne(stmt, parseExtensionVersionRow, id);
      if (!row) {
        throw new PlatformError('Failed to retrieve newly created extension version record', 'INTERNAL_ERROR', 500);
      }
      return row;
    });
  }

  async listVersions(packageId: string): Promise<ExtensionVersionRecord[]> {
    const stmt = this.db.prepare('SELECT * FROM extension_versions WHERE package_id = ? ORDER BY version DESC');
    return queryAll(stmt, parseExtensionVersionRow, packageId);
  }

  async getVersion(packageId: string, version: number): Promise<ExtensionVersionRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM extension_versions WHERE package_id = ? AND version = ?');
    return queryOne(stmt, parseExtensionVersionRow, packageId, version);
  }

  // ---- Contributions ----

  async createContribution(input: Omit<ExtensionContributionRecord, 'createdAt' | 'updatedAt'> & { id?: string }): Promise<ExtensionContributionRecord> {
    const id = input.id || generateId('ext_contrib');
    return withImmediateTransactionSync(this.db, () => {
      this.db.prepare(`
        INSERT INTO extension_contributions (
          id, package_id, kind, contribution_key, manifest_json, status, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `).run(
        id,
        input.packageId,
        input.kind,
        input.contributionKey,
        input.manifestJson,
        input.status ?? 'active'
      );

      const stmt = this.db.prepare('SELECT * FROM extension_contributions WHERE id = ?');
      const row = queryOne(stmt, parseExtensionContributionRow, id);
      if (!row) {
        throw new PlatformError('Failed to retrieve newly created extension contribution', 'INTERNAL_ERROR', 500);
      }
      return row;
    });
  }

  async updateContribution(id: string, input: Partial<Pick<ExtensionContributionRecord, 'manifestJson' | 'status'>>): Promise<ExtensionContributionRecord> {
    return withImmediateTransactionSync(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM extension_contributions WHERE id = ?').get(id);
      if (!existing) {
        throw new NotFoundError(`Extension contribution "${id}" not found`);
      }

      const updates: string[] = ['updated_at = CURRENT_TIMESTAMP'];
      const params: DbParam[] = [];

      if (input.manifestJson !== undefined) {
        updates.push('manifest_json = ?');
        params.push(input.manifestJson);
      }
      if (input.status !== undefined) {
        updates.push('status = ?');
        params.push(input.status);
      }

      params.push(id);
      this.db.prepare(`UPDATE extension_contributions SET ${updates.join(', ')} WHERE id = ?`).run(...params);

      const stmt = this.db.prepare('SELECT * FROM extension_contributions WHERE id = ?');
      const updated = queryOne(stmt, parseExtensionContributionRow, id);
      if (!updated) {
        throw new PlatformError('Failed to retrieve updated extension contribution', 'INTERNAL_ERROR', 500);
      }
      return updated;
    });
  }

  async listContributions(packageId: string): Promise<ExtensionContributionRecord[]> {
    const stmt = this.db.prepare('SELECT * FROM extension_contributions WHERE package_id = ? ORDER BY created_at ASC');
    return queryAll(stmt, parseExtensionContributionRow, packageId);
  }

  async listAllContributions(options?: {
    kind?: ExtensionKind;
    status?: ExtensionContributionStatus;
    limit?: number;
    offset?: number;
  }): Promise<ExtensionContributionRecord[]> {
    let sql = `
      SELECT ec.* FROM extension_contributions ec
      JOIN extension_packages ep ON ep.id = ec.package_id
      WHERE ep.user_id = ?
    `;
    const params: DbParam[] = [this.userId];

    if (options?.kind) {
      sql += ' AND ec.kind = ?';
      params.push(options.kind);
    }
    if (options?.status) {
      sql += ' AND ec.status = ?';
      params.push(options.status);
    }

    sql += ' ORDER BY ec.created_at ASC';

    if (options?.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
      if (options?.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(options.offset);
      }
    }

    const stmt = this.db.prepare(sql);
    return queryAll(stmt, parseExtensionContributionRow, ...params);
  }

  async findContributionById(contributionId: string): Promise<ExtensionContributionRecord | null> {
    const stmt = this.db.prepare(`
      SELECT ec.* FROM extension_contributions ec
      JOIN extension_packages ep ON ep.id = ec.package_id
      WHERE ec.id = ? AND ep.user_id = ?
    `);
    return queryOne(stmt, parseExtensionContributionRow, contributionId, this.userId);
  }

  async findContributionByKey(packageId: string, kind: ExtensionKind, key: string): Promise<ExtensionContributionRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM extension_contributions WHERE package_id = ? AND kind = ? AND contribution_key = ?');
    return queryOne(stmt, parseExtensionContributionRow, packageId, kind, key);
  }

  async deleteContribution(id: string): Promise<boolean> {
    const res = this.db.prepare('DELETE FROM extension_contributions WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }
}

// ---- Binding Repository ----

export class SqliteTenantScopedExtensionBindingRepository implements TenantScopedExtensionBindingRepository {
  readonly userId: string;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  async findById(id: string): Promise<ExtensionBindingRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM extension_bindings WHERE id = ? AND user_id = ?');
    return queryOne(stmt, parseExtensionBindingRow, id, this.userId);
  }

  async findBySpaceAndContribution(spaceId: string, contributionId: string): Promise<ExtensionBindingRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM extension_bindings WHERE user_id = ? AND space_id = ? AND contribution_id = ?');
    return queryOne(stmt, parseExtensionBindingRow, this.userId, spaceId, contributionId);
  }

  async findBySpaceAndContributionKey(spaceId: string, kind: ExtensionKind, key: string): Promise<ExtensionBindingRecord | null> {
    const stmt = this.db.prepare(`
      SELECT eb.* FROM extension_bindings eb
      JOIN extension_contributions ec ON ec.id = eb.contribution_id
      WHERE eb.user_id = ? AND eb.space_id = ? AND ec.kind = ? AND ec.contribution_key = ?
    `);
    return queryOne(stmt, parseExtensionBindingRow, this.userId, spaceId, kind, key);
  }

  async setBinding(spaceId: string, contributionId: string, enabled: boolean): Promise<ExtensionBindingRecord> {
    return withImmediateTransactionSync(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM extension_bindings WHERE space_id = ? AND contribution_id = ?').get(spaceId, contributionId) as Record<string, unknown> | undefined;

      if (existing) {
        this.db.prepare(`
          UPDATE extension_bindings
          SET enabled = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND user_id = ?
        `).run(enabled ? 1 : 0, String(existing.id), this.userId);

        const stmt = this.db.prepare('SELECT * FROM extension_bindings WHERE id = ? AND user_id = ?');
        return queryOne(stmt, parseExtensionBindingRow, String(existing.id), this.userId)!;
      }

      const id = generateId('ext_bind');
      this.db.prepare(`
        INSERT INTO extension_bindings (id, user_id, space_id, contribution_id, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(id, this.userId, spaceId, contributionId, enabled ? 1 : 0);

      const stmt = this.db.prepare('SELECT * FROM extension_bindings WHERE id = ? AND user_id = ?');
      return queryOne(stmt, parseExtensionBindingRow, id, this.userId)!;
    });
  }

  async deleteBinding(spaceId: string, contributionId: string): Promise<boolean> {
    const res = this.db.prepare('DELETE FROM extension_bindings WHERE user_id = ? AND space_id = ? AND contribution_id = ?').run(this.userId, spaceId, contributionId);
    return Number(res.changes) > 0;
  }

  async deleteByContribution(contributionId: string): Promise<number> {
    const res = this.db.prepare('DELETE FROM extension_bindings WHERE user_id = ? AND contribution_id = ?').run(this.userId, contributionId);
    return Number(res.changes);
  }

  async deleteBySpace(spaceId: string): Promise<number> {
    const res = this.db.prepare('DELETE FROM extension_bindings WHERE user_id = ? AND space_id = ?').run(this.userId, spaceId);
    return Number(res.changes);
  }

  async listBySpace(spaceId: string): Promise<ExtensionBindingRecord[]> {
    const stmt = this.db.prepare('SELECT * FROM extension_bindings WHERE user_id = ? AND space_id = ? ORDER BY created_at ASC');
    return queryAll(stmt, parseExtensionBindingRow, this.userId, spaceId);
  }

  async listByContribution(contributionId: string): Promise<ExtensionBindingRecord[]> {
    const stmt = this.db.prepare('SELECT * FROM extension_bindings WHERE user_id = ? AND contribution_id = ? ORDER BY space_id ASC');
    return queryAll(stmt, parseExtensionBindingRow, this.userId, contributionId);
  }

  async list(options?: { spaceId?: string; limit?: number; offset?: number }): Promise<ExtensionBindingRecord[]> {
    let sql = 'SELECT * FROM extension_bindings WHERE user_id = ?';
    const params: DbParam[] = [this.userId];

    if (options?.spaceId) {
      sql += ' AND space_id = ?';
      params.push(options.spaceId);
    }

    sql += ' ORDER BY created_at ASC';

    if (options?.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
      if (options?.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(options.offset);
      }
    }

    const stmt = this.db.prepare(sql);
    return queryAll(stmt, parseExtensionBindingRow, ...params);
  }
}

