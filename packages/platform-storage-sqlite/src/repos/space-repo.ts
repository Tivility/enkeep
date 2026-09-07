import type { DatabaseSync } from 'node:sqlite';
import type {
  Space,
  CreateSpaceInput,
  UpdateSpaceInput,
  TenantScopedSpaceRepository,
  EffectiveAgentProfile,
  LifecycleStatus,
} from '@enkeep/platform-core';
import {
  NotFoundError,
  ValidationError,
  composeAgentProfilePrompt,
} from '@enkeep/platform-core';
import {
  type DbParam,
  parseSpaceRow,
  parseAgentProfileSnapshotRow,
  parseAgentProfileRow,
  queryOne,
  queryAll,
} from '../utils/db.js';
import {
  generateSpaceId,
  validateSpaceId,
  isValidSpaceId,
  validateSpaceFolder,
  validateProfileId,
  validateSnapshotId,
} from '../utils/id.js';

export class SqliteTenantScopedSpaceRepository implements TenantScopedSpaceRepository {
  readonly userId: string;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  async findById(id: string): Promise<Space | null> {
    if (!isValidSpaceId(id)) {
      return null;
    }
    const stmt = this.db.prepare('SELECT * FROM spaces WHERE id = ? AND user_id = ?');
    return queryOne(stmt, parseSpaceRow, id, this.userId);
  }

  async findByFolder(folder: string): Promise<Space | null> {
    const stmt = this.db.prepare('SELECT * FROM spaces WHERE folder = ? AND user_id = ?');
    return queryOne(stmt, parseSpaceRow, folder, this.userId);
  }

  async create(input: Omit<CreateSpaceInput, 'userId'>): Promise<Space> {
    const id = input.id !== undefined ? validateSpaceId(input.id) : generateSpaceId();

    if (typeof input.name !== 'string' || !input.name.trim()) {
      throw new ValidationError('Invalid space name');
    }
    const name = input.name;

    const folder = validateSpaceFolder(input.folder);
    const executionMode = input.executionMode ?? 'container';
    if (executionMode !== 'container' && executionMode !== 'host') {
      throw new ValidationError('Invalid executionMode: Expected container or host');
    }

    const status: LifecycleStatus = input.status ?? 'active';
    if (!['active', 'archived', 'deleted'].includes(status)) {
      throw new ValidationError('Invalid status');
    }

    let agentProfileId: string | null = null;
    if (input.agentProfileId !== undefined && input.agentProfileId !== null) {
      agentProfileId = validateProfileId(input.agentProfileId);
      const profStmt = this.db.prepare('SELECT 1 FROM agent_profiles WHERE id = ? AND user_id = ?');
      const exists = profStmt.get(agentProfileId, this.userId);
      if (!exists) {
        throw new NotFoundError('Agent profile not found');
      }
    }

    let agentProfileSnapshotId: string | null = null;
    if (input.agentProfileSnapshotId !== undefined && input.agentProfileSnapshotId !== null) {
      agentProfileSnapshotId = validateSnapshotId(input.agentProfileSnapshotId);
      const snapStmt = this.db.prepare('SELECT 1 FROM agent_profile_snapshots WHERE id = ? AND user_id = ?');
      const exists = snapStmt.get(agentProfileSnapshotId, this.userId);
      if (!exists) {
        throw new NotFoundError('Agent profile snapshot not found');
      }
    }

    this.db.prepare(`
      INSERT INTO spaces (id, user_id, name, folder, execution_mode, status, agent_profile_id, agent_profile_snapshot_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(id, this.userId, name, folder, executionMode, status, agentProfileId, agentProfileSnapshotId);

    const space = await this.findById(id);
    if (!space) {
      throw new NotFoundError('Space not found');
    }
    return space;
  }

  async update(id: string, input: UpdateSpaceInput): Promise<Space> {
    validateSpaceId(id);

    const checkStmt = this.db.prepare('SELECT 1 FROM spaces WHERE id = ? AND user_id = ?');
    const existing = checkStmt.get(id, this.userId);
    if (!existing) {
      throw new NotFoundError('Space not found');
    }

    const updates: string[] = ['updated_at = CURRENT_TIMESTAMP'];
    const params: DbParam[] = [];

    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || !input.name.trim()) {
        throw new ValidationError('Invalid space name');
      }
      updates.push('name = ?');
      params.push(input.name);
    }
    if (input.folder !== undefined) {
      validateSpaceFolder(input.folder);
      updates.push('folder = ?');
      params.push(input.folder);
    }
    if (input.status !== undefined) {
      if (!['active', 'archived', 'deleted'].includes(input.status)) {
        throw new ValidationError('Invalid status');
      }
      updates.push('status = ?');
      params.push(input.status);
    }
    if (input.agentProfileId !== undefined) {
      if (input.agentProfileId !== null) {
        const profileId = validateProfileId(input.agentProfileId);
        const profStmt = this.db.prepare('SELECT 1 FROM agent_profiles WHERE id = ? AND user_id = ?');
        const exists = profStmt.get(profileId, this.userId);
        if (!exists) {
          throw new NotFoundError('Agent profile not found');
        }
        updates.push('agent_profile_id = ?');
        params.push(profileId);
      } else {
        updates.push('agent_profile_id = ?');
        params.push(null);
      }
    }
    if (input.agentProfileSnapshotId !== undefined) {
      if (input.agentProfileSnapshotId !== null) {
        const snapshotId = validateSnapshotId(input.agentProfileSnapshotId);
        const snapStmt = this.db.prepare('SELECT 1 FROM agent_profile_snapshots WHERE id = ? AND user_id = ?');
        const exists = snapStmt.get(snapshotId, this.userId);
        if (!exists) {
          throw new NotFoundError('Agent profile snapshot not found');
        }
        updates.push('agent_profile_snapshot_id = ?');
        params.push(snapshotId);
      } else {
        updates.push('agent_profile_snapshot_id = ?');
        params.push(null);
      }
    }

    params.push(id, this.userId);
    const sql = `UPDATE spaces SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`;
    this.db.prepare(sql).run(...params);

    const updated = await this.findById(id);
    if (!updated) {
      throw new NotFoundError('Space not found');
    }
    return updated;
  }

  async archive(id: string): Promise<Space> {
    return this.update(id, { status: 'archived' });
  }

  async restore(id: string): Promise<Space> {
    return this.update(id, { status: 'active' });
  }

  async delete(id: string): Promise<boolean> {
    if (!isValidSpaceId(id)) {
      return false;
    }
    const result = this.db.prepare('DELETE FROM spaces WHERE id = ? AND user_id = ?').run(id, this.userId);
    return Number(result.changes) > 0;
  }

  async list(options?: { status?: LifecycleStatus; limit?: number; offset?: number }): Promise<Space[]> {
    let sql = 'SELECT * FROM spaces WHERE user_id = ?';
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
    return queryAll(stmt, parseSpaceRow, ...params);
  }

  async resolveAgentProfile(spaceId: string): Promise<EffectiveAgentProfile> {
    const space = await this.findById(spaceId);
    if (!space) {
      return {
        source: 'none',
        identity: '',
        soul: '',
        agents: '',
        tools: '',
        composedPrompt: '',
      };
    }

    // 1. Direct snapshot binding
    if (space.agentProfileSnapshotId) {
      const snapStmt = this.db.prepare(
        'SELECT * FROM agent_profile_snapshots WHERE id = ? AND user_id = ?'
      );
      const snapshot = queryOne(snapStmt, parseAgentProfileSnapshotRow, space.agentProfileSnapshotId, this.userId);
      if (snapshot) {
        return {
          source: 'space',
          profileId: snapshot.profileId,
          snapshotId: snapshot.id,
          version: snapshot.version,
          promptMode: 'append',
          identity: snapshot.identity,
          soul: snapshot.soul,
          agents: snapshot.agents,
          tools: snapshot.tools,
          composedPrompt: composeAgentProfilePrompt(snapshot),
        };
      }
    }

    // 2. Profile active version binding
    if (space.agentProfileId) {
      const profStmt = this.db.prepare(
        'SELECT * FROM agent_profiles WHERE id = ? AND user_id = ?'
      );
      const profile = queryOne(profStmt, parseAgentProfileRow, space.agentProfileId, this.userId);
      if (profile) {
        const snapStmt = this.db.prepare(
          'SELECT * FROM agent_profile_snapshots WHERE profile_id = ? AND version = ? AND user_id = ?'
        );
        const snapshot = queryOne(snapStmt, parseAgentProfileSnapshotRow, profile.id, profile.activeVersion, this.userId);
        if (snapshot) {
          return {
            source: 'space',
            profileId: profile.id,
            snapshotId: snapshot.id,
            version: snapshot.version,
            promptMode: 'append',
            identity: snapshot.identity,
            soul: snapshot.soul,
            agents: snapshot.agents,
            tools: snapshot.tools,
            composedPrompt: composeAgentProfilePrompt(snapshot),
          };
        }
      }
    }

    return {
      source: 'none',
      identity: '',
      soul: '',
      agents: '',
      tools: '',
      composedPrompt: '',
    };
  }
}
