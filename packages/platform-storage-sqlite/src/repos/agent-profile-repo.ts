import type { DatabaseSync } from 'node:sqlite';
import type {
  AgentProfile,
  AgentProfileSnapshot,
  AgentProfileWithSnapshot,
  CreateAgentProfileInput,
  UpdateAgentProfileInput,
  CreateAgentProfileVersionInput,
  RollbackAgentProfileVersionInput,
  LifecycleStatus,
  TenantScopedAgentProfileRepository,
} from '@enkeep/platform-core';
import {
  NotFoundError,
  ValidationError,
  PlatformError,
} from '@enkeep/platform-core';
import {
  type DbParam,
  parseAgentProfileRow,
  parseAgentProfileSnapshotRow,
  queryOne,
  queryAll,
  withImmediateTransactionSync,
} from '../utils/db.js';
import {
  generateProfileId,
  validateProfileId,
  isValidProfileId,
  generateSnapshotId,
  validateSnapshotId,
  isValidSnapshotId,
  computeSnapshotPromptHash,
} from '../utils/id.js';

export class SqliteTenantScopedAgentProfileRepository implements TenantScopedAgentProfileRepository {
  readonly userId: string;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  async findById(id: string): Promise<AgentProfile | null> {
    if (!isValidProfileId(id)) {
      return null;
    }
    const stmt = this.db.prepare('SELECT * FROM agent_profiles WHERE id = ? AND user_id = ?');
    return queryOne(stmt, parseAgentProfileRow, id, this.userId);
  }

  async findByName(name: string): Promise<AgentProfile | null> {
    const stmt = this.db.prepare('SELECT * FROM agent_profiles WHERE name = ? AND user_id = ?');
    return queryOne(stmt, parseAgentProfileRow, name, this.userId);
  }

  async getWithActiveSnapshot(id: string): Promise<AgentProfileWithSnapshot | null> {
    const profile = await this.findById(id);
    if (!profile) return null;

    const snapshotStmt = this.db.prepare(
      'SELECT * FROM agent_profile_snapshots WHERE profile_id = ? AND version = ? AND user_id = ?'
    );
    const snapshot = queryOne(snapshotStmt, parseAgentProfileSnapshotRow, id, profile.activeVersion, this.userId);

    return {
      ...profile,
      snapshot,
    };
  }

  async getSnapshot(profileId: string, version: number): Promise<AgentProfileSnapshot | null> {
    if (!isValidProfileId(profileId)) {
      return null;
    }
    const stmt = this.db.prepare(
      'SELECT * FROM agent_profile_snapshots WHERE profile_id = ? AND version = ? AND user_id = ?'
    );
    return queryOne(stmt, parseAgentProfileSnapshotRow, profileId, version, this.userId);
  }

  async getSnapshotById(snapshotId: string): Promise<AgentProfileSnapshot | null> {
    if (!isValidSnapshotId(snapshotId)) {
      return null;
    }
    const stmt = this.db.prepare('SELECT * FROM agent_profile_snapshots WHERE id = ? AND user_id = ?');
    return queryOne(stmt, parseAgentProfileSnapshotRow, snapshotId, this.userId);
  }

  async listSnapshots(profileId: string): Promise<AgentProfileSnapshot[]> {
    if (!isValidProfileId(profileId)) {
      return [];
    }
    const stmt = this.db.prepare(
      'SELECT * FROM agent_profile_snapshots WHERE profile_id = ? AND user_id = ? ORDER BY version ASC'
    );
    return queryAll(stmt, parseAgentProfileSnapshotRow, profileId, this.userId);
  }

  async create(input: Omit<CreateAgentProfileInput, 'userId'>): Promise<AgentProfileWithSnapshot> {
    const profileId = input.id !== undefined ? validateProfileId(input.id) : generateProfileId();

    if (typeof input.name !== 'string' || !input.name.trim()) {
      throw new ValidationError('Invalid agent profile name');
    }
    const name = input.name;

    if (input.promptMode && input.promptMode !== 'append') {
      throw new ValidationError('Invalid prompt mode');
    }

    const snapshotId = generateSnapshotId();
    const identity = input.identity ?? '';
    const soul = input.soul ?? '';
    const agents = input.agents ?? '';
    const tools = input.tools ?? '';
    const description = input.description ?? null;
    const changeSummary = input.changeSummary ?? 'Initial version';

    const promptHash = computeSnapshotPromptHash({ identity, soul, agents, tools });

    return withImmediateTransactionSync(this.db, () => {
      this.db.prepare(`
        INSERT INTO agent_profiles (id, user_id, name, description, status, active_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(profileId, this.userId, name, description);

      this.db.prepare(`
        INSERT INTO agent_profile_snapshots (id, user_id, profile_id, version, prompt_mode, prompt_hash, identity, soul, agents, tools, change_summary, created_at)
        VALUES (?, ?, ?, 1, 'append', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(snapshotId, this.userId, profileId, promptHash, identity, soul, agents, tools, changeSummary);

      const profileStmt = this.db.prepare('SELECT * FROM agent_profiles WHERE id = ? AND user_id = ?');
      const profile = queryOne(profileStmt, parseAgentProfileRow, profileId, this.userId);

      const snapStmt = this.db.prepare('SELECT * FROM agent_profile_snapshots WHERE id = ? AND user_id = ?');
      const snapshot = queryOne(snapStmt, parseAgentProfileSnapshotRow, snapshotId, this.userId);

      if (!profile || !snapshot) {
        throw new NotFoundError('Agent profile not found');
      }

      return {
        ...profile,
        snapshot,
      };
    });
  }

  async update(id: string, input: UpdateAgentProfileInput): Promise<AgentProfile> {
    validateProfileId(id);

    const checkStmt = this.db.prepare('SELECT 1 FROM agent_profiles WHERE id = ? AND user_id = ?');
    const existing = checkStmt.get(id, this.userId);
    if (!existing) {
      throw new NotFoundError('Agent profile not found');
    }

    const updates: string[] = ['updated_at = CURRENT_TIMESTAMP'];
    const params: DbParam[] = [];

    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || !input.name.trim()) {
        throw new ValidationError('Invalid agent profile name');
      }
      updates.push('name = ?');
      params.push(input.name);
    }
    if (input.description !== undefined) {
      updates.push('description = ?');
      params.push(input.description);
    }
    if (input.status !== undefined) {
      if (!['active', 'archived', 'deleted'].includes(input.status)) {
        throw new ValidationError('Invalid status');
      }
      updates.push('status = ?');
      params.push(input.status);
    }

    params.push(id, this.userId);
    const sql = `UPDATE agent_profiles SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`;
    this.db.prepare(sql).run(...params);

    const updated = await this.findById(id);
    if (!updated) {
      throw new NotFoundError('Agent profile not found');
    }
    return updated;
  }

  async createVersion(profileId: string, input: CreateAgentProfileVersionInput): Promise<AgentProfileSnapshot> {
    validateProfileId(profileId);

    if (input.promptMode && input.promptMode !== 'append') {
      throw new ValidationError('Invalid prompt mode');
    }

    return withImmediateTransactionSync(this.db, () => {
      const checkStmt = this.db.prepare('SELECT 1 FROM agent_profiles WHERE id = ? AND user_id = ?');
      const existing = checkStmt.get(profileId, this.userId);
      if (!existing) {
        throw new NotFoundError('Agent profile not found');
      }

      const maxVerRow = this.db.prepare(
        'SELECT coalesce(max(version), 0) as max_v FROM agent_profile_snapshots WHERE profile_id = ? AND user_id = ?'
      ).get(profileId, this.userId) as { max_v: number | bigint };
      const nextVersion = Number(maxVerRow.max_v) + 1;

      const snapshotId = generateSnapshotId();
      const identity = input.identity ?? '';
      const soul = input.soul ?? '';
      const agents = input.agents ?? '';
      const tools = input.tools ?? '';
      const changeSummary = input.changeSummary ?? `Version ${nextVersion}`;

      const promptHash = computeSnapshotPromptHash({ identity, soul, agents, tools });

      this.db.prepare(`
        INSERT INTO agent_profile_snapshots (id, user_id, profile_id, version, prompt_mode, prompt_hash, identity, soul, agents, tools, change_summary, created_at)
        VALUES (?, ?, ?, ?, 'append', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(snapshotId, this.userId, profileId, nextVersion, promptHash, identity, soul, agents, tools, changeSummary);

      this.db.prepare(`
        UPDATE agent_profiles
        SET active_version = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `).run(nextVersion, profileId, this.userId);

      const snapStmt = this.db.prepare('SELECT * FROM agent_profile_snapshots WHERE id = ? AND user_id = ?');
      const snapshot = queryOne(snapStmt, parseAgentProfileSnapshotRow, snapshotId, this.userId);

      if (!snapshot) {
        throw new NotFoundError('Agent profile snapshot not found');
      }
      return snapshot;
    });
  }

  async rollbackVersion(profileId: string, input: RollbackAgentProfileVersionInput): Promise<AgentProfileSnapshot> {
    validateProfileId(profileId);

    if (!input || typeof input.targetVersion !== 'number' || !Number.isSafeInteger(input.targetVersion) || input.targetVersion < 1) {
      throw new ValidationError('Target version must be a positive safe integer');
    }

    return withImmediateTransactionSync(this.db, () => {
      const checkStmt = this.db.prepare('SELECT id, status, active_version FROM agent_profiles WHERE id = ? AND user_id = ?');
      const existing = checkStmt.get(profileId, this.userId) as { id: string; status: string; active_version: number } | undefined;
      if (!existing) {
        throw new NotFoundError('Agent profile not found');
      }

      if (existing.status === 'archived' || existing.status === 'deleted') {
        throw new ValidationError('Cannot modify or rollback archived or deleted agent profile');
      }

      if (input.targetVersion === existing.active_version) {
        throw new ValidationError('Cannot rollback to the current active version');
      }

      const targetStmt = this.db.prepare(
        'SELECT * FROM agent_profile_snapshots WHERE profile_id = ? AND version = ? AND user_id = ?'
      );
      const targetSnapshot = queryOne(targetStmt, parseAgentProfileSnapshotRow, profileId, input.targetVersion, this.userId);

      if (!targetSnapshot) {
        throw new NotFoundError('Agent profile snapshot not found');
      }

      const maxVerRow = this.db.prepare(
        'SELECT coalesce(max(version), 0) as max_v FROM agent_profile_snapshots WHERE profile_id = ? AND user_id = ?'
      ).get(profileId, this.userId) as { max_v: number | bigint };
      const nextVersion = Number(maxVerRow.max_v) + 1;

      const snapshotId = generateSnapshotId();
      const changeSummary = input.changeSummary ?? `Rollback to v${input.targetVersion}`;

      const promptHash = computeSnapshotPromptHash({
        identity: targetSnapshot.identity,
        soul: targetSnapshot.soul,
        agents: targetSnapshot.agents,
        tools: targetSnapshot.tools,
      });

      this.db.prepare(`
        INSERT INTO agent_profile_snapshots (id, user_id, profile_id, version, prompt_mode, prompt_hash, identity, soul, agents, tools, change_summary, created_at)
        VALUES (?, ?, ?, ?, 'append', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        snapshotId,
        this.userId,
        profileId,
        nextVersion,
        promptHash,
        targetSnapshot.identity,
        targetSnapshot.soul,
        targetSnapshot.agents,
        targetSnapshot.tools,
        changeSummary
      );

      this.db.prepare(`
        UPDATE agent_profiles
        SET active_version = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `).run(nextVersion, profileId, this.userId);

      // Atomic Audit Log in same transaction (strictly IDs and version numbers only, no prompt, no changeSummary)
      const actorId = input.actorUserId || this.userId;
      let canonicalUsername: string | null = null;
      try {
        const userRow = this.db.prepare('SELECT username FROM users WHERE id = ?').get(actorId) as { username: string } | undefined;
        if (userRow && typeof userRow.username === 'string') {
          canonicalUsername = userRow.username;
        }
      } catch (userLookupErr: unknown) {
        canonicalUsername = null;
      }

      try {
        const auditId = `aud_${crypto.randomUUID().replace(/-/g, '')}`;
        this.db.prepare(`
          INSERT INTO auth_audit_log (id, user_id, username, action, details, created_at)
          VALUES (?, ?, ?, 'profile_version_rolled_back', ?, CURRENT_TIMESTAMP)
        `).run(
          auditId,
          actorId,
          canonicalUsername,
          JSON.stringify({
            profileId,
            version: nextVersion,
            newVersion: nextVersion,
            targetVersion: input.targetVersion,
          })
        );
      } catch (auditErr: unknown) {
        // If auth_audit_log table exists and fails, transaction must roll back atomically
        throw new PlatformError(
          'Failed to record audit log during profile rollback.',
          'INTERNAL_ERROR',
          500
        );
      }

      const snapStmt = this.db.prepare('SELECT * FROM agent_profile_snapshots WHERE id = ? AND user_id = ?');
      const snapshot = queryOne(snapStmt, parseAgentProfileSnapshotRow, snapshotId, this.userId);

      if (!snapshot) {
        throw new NotFoundError('Agent profile snapshot not found');
      }
      return snapshot;
    });
  }

  async archive(id: string): Promise<AgentProfile> {
    return this.update(id, { status: 'archived' });
  }

  async delete(id: string): Promise<boolean> {
    if (!isValidProfileId(id)) {
      return false;
    }
    const prof = this.db.prepare('SELECT 1 FROM agent_profiles WHERE id = ? AND user_id = ?').get(id, this.userId);
    if (!prof) {
      return false;
    }
    const spaceRef = this.db.prepare('SELECT 1 FROM spaces WHERE agent_profile_id = ? AND user_id = ? LIMIT 1').get(id, this.userId);
    const routeRef = this.db.prepare('SELECT 1 FROM session_routes WHERE agent_profile_id = ? AND user_id = ? LIMIT 1').get(id, this.userId);
    const snapRef = this.db.prepare('SELECT 1 FROM agent_profile_snapshots WHERE profile_id = ? AND user_id = ? LIMIT 1').get(id, this.userId);
    if (spaceRef || routeRef || snapRef) {
      throw new ValidationError('Agent profile is referenced and cannot be deleted; archive only');
    }
    const result = this.db.prepare('DELETE FROM agent_profiles WHERE id = ? AND user_id = ?').run(id, this.userId);
    return Number(result.changes) > 0;
  }

  async list(options?: { status?: LifecycleStatus; limit?: number; offset?: number }): Promise<AgentProfile[]> {
    let sql = 'SELECT * FROM agent_profiles WHERE user_id = ?';
    const params: DbParam[] = [this.userId];

    if (options?.status) {
      sql += ' AND status = ?';
      params.push(options.status);
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
    return queryAll(stmt, parseAgentProfileRow, ...params);
  }
}
