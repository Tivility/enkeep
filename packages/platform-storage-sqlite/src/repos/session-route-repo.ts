import type { DatabaseSync } from 'node:sqlite';
import type {
  SessionRoute,
  CreateSessionRouteInput,
  UpdateSessionRouteInput,
  ResetSessionRouteInput,
  TenantScopedSessionRouteRepository,
  EffectiveAgentProfile,
  LifecycleStatus,
  SessionGeneration,
} from '@enkeep/platform-core';
import {
  NotFoundError,
  ValidationError,
  composeAgentProfilePrompt,
} from '@enkeep/platform-core';
import {
  type DbParam,
  parseSessionRouteRow,
  parseSessionGenerationRow,
  parseAgentProfileSnapshotRow,
  parseAgentProfileRow,
  queryOne,
  queryAll,
  withImmediateTransactionSync,
} from '../utils/db.js';
import {
  generateSessionId,
  validateSessionId,
  isValidSessionId,
  generateGenerationId,
  validateSpaceId,
  validateProfileId,
  validateSnapshotId,
} from '../utils/id.js';
import { SqliteTenantScopedSpaceRepository } from './space-repo.js';

export class SqliteTenantScopedSessionRouteRepository implements TenantScopedSessionRouteRepository {
  readonly userId: string;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  async findById(id: string): Promise<SessionRoute | null> {
    if (!isValidSessionId(id)) {
      return null;
    }
    const stmt = this.db.prepare('SELECT * FROM session_routes WHERE id = ? AND user_id = ?');
    return queryOne(stmt, parseSessionRouteRow, id, this.userId);
  }

  async findByRouteIdentity(channel: string, accountId: string, nativeContextId: string): Promise<SessionRoute | null> {
    const stmt = this.db.prepare(
      'SELECT * FROM session_routes WHERE user_id = ? AND channel = ? AND account_id = ? AND native_context_id = ?'
    );
    return queryOne(stmt, parseSessionRouteRow, this.userId, channel, accountId, nativeContextId);
  }

  async findByPeer(channel: string, peerId: string): Promise<SessionRoute | null> {
    const stmt = this.db.prepare(
      'SELECT * FROM session_routes WHERE user_id = ? AND channel = ? AND (peer_id = ? OR native_context_id = ?)'
    );
    return queryOne(stmt, parseSessionRouteRow, this.userId, channel, peerId, peerId);
  }

  async findByDshSessionId(dshSessionId: string): Promise<SessionRoute | null> {
    if (!isValidSessionId(dshSessionId)) {
      return null;
    }
    const stmt = this.db.prepare('SELECT * FROM session_routes WHERE dsh_session_id = ? AND user_id = ?');
    return queryOne(stmt, parseSessionRouteRow, dshSessionId, this.userId);
  }

  async create(input: Omit<CreateSessionRouteInput, 'userId'>): Promise<SessionRoute> {
    const id = input.id !== undefined ? validateSessionId(input.id) : generateSessionId();

    validateSpaceId(input.spaceId);
    const checkSpaceStmt = this.db.prepare('SELECT execution_mode FROM spaces WHERE id = ? AND user_id = ?');
    const spaceRow = checkSpaceStmt.get(input.spaceId, this.userId) as { execution_mode: string } | undefined;
    if (!spaceRow) {
      throw new NotFoundError('Space not found');
    }
    const spaceExecutionMode = (spaceRow.execution_mode ?? 'container') as import('@enkeep/platform-core').ExecutionMode;
    if (input.executionMode !== undefined && input.executionMode !== spaceExecutionMode) {
      throw new ValidationError('Session executionMode cannot override or mismatch space executionMode');
    }

    if (typeof input.channel !== 'string' || !input.channel.trim()) {
      throw new ValidationError('Invalid channel');
    }
    if (typeof input.nativeContextId !== 'string' || !input.nativeContextId.trim()) {
      throw new ValidationError('Invalid native context ID');
    }
    if (!input.dshSessionId || typeof input.dshSessionId !== 'string') {
      throw new ValidationError('dshSessionId is required to create session route');
    }

    const dshSessionId = validateSessionId(input.dshSessionId);
    const executionMode = spaceExecutionMode;

    const accountId = input.accountId ?? 'default';
    const nativeContextId = input.nativeContextId;
    const peerId = input.peerId ?? nativeContextId;
    const status: LifecycleStatus = input.status ?? 'active';
    if (!['active', 'archived', 'deleted'].includes(status)) {
      throw new ValidationError('Invalid status');
    }

    const title = input.title ?? null;

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

    let initialGenSnapshotId = agentProfileSnapshotId;
    if (!initialGenSnapshotId) {
      const spaceSnapRow = this.db.prepare(
        'SELECT agent_profile_snapshot_id FROM spaces WHERE id = ? AND user_id = ?'
      ).get(input.spaceId, this.userId) as { agent_profile_snapshot_id: string | null } | undefined;
      if (spaceSnapRow && spaceSnapRow.agent_profile_snapshot_id) {
        initialGenSnapshotId = spaceSnapRow.agent_profile_snapshot_id;
      }
    }

    return withImmediateTransactionSync(this.db, () => {
      this.db.prepare(`
        INSERT INTO session_routes (
          id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode,
          status, title, last_reset_at, reset_count, current_generation, agent_profile_id, agent_profile_snapshot_id,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 1, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(
        id,
        input.spaceId,
        this.userId,
        input.channel,
        accountId,
        nativeContextId,
        peerId,
        dshSessionId,
        executionMode,
        status,
        title,
        agentProfileId,
        agentProfileSnapshotId
      );

      const genId = generateGenerationId();
      this.db.prepare(`
        INSERT INTO session_generations (
          id, user_id, route_id, generation_number, dsh_session_id, agent_profile_snapshot_id, reset_reason, created_at
        )
        VALUES (?, ?, ?, 1, ?, ?, 'initial', CURRENT_TIMESTAMP)
      `).run(
        genId,
        this.userId,
        id,
        dshSessionId,
        initialGenSnapshotId ?? null
      );

      const routeStmt = this.db.prepare('SELECT * FROM session_routes WHERE id = ? AND user_id = ?');
      const route = queryOne(routeStmt, parseSessionRouteRow, id, this.userId);
      if (!route) {
        throw new NotFoundError('Session route not found');
      }
      return route;
    });
  }

  async update(id: string, input: UpdateSessionRouteInput): Promise<SessionRoute> {
    validateSessionId(id);

    const checkStmt = this.db.prepare('SELECT 1 FROM session_routes WHERE id = ? AND user_id = ?');
    const existing = checkStmt.get(id, this.userId);
    if (!existing) {
      throw new NotFoundError('Session route not found');
    }

    if (input.spaceId !== undefined) {
      validateSpaceId(input.spaceId);
      const checkSpaceStmt = this.db.prepare('SELECT 1 FROM spaces WHERE id = ? AND user_id = ?');
      const spaceExists = checkSpaceStmt.get(input.spaceId, this.userId);
      if (!spaceExists) {
        throw new NotFoundError('Space not found');
      }
    }

    if (input.dshSessionId !== undefined) {
      validateSessionId(input.dshSessionId);
    }

    if (input.status !== undefined) {
      if (!['active', 'archived', 'deleted'].includes(input.status)) {
        throw new ValidationError('Invalid status');
      }
    }

    const updates: string[] = ['updated_at = CURRENT_TIMESTAMP'];
    const params: DbParam[] = [];

    if (input.spaceId !== undefined) {
      updates.push('space_id = ?');
      params.push(input.spaceId);
    }
    if (input.dshSessionId !== undefined) {
      updates.push('dsh_session_id = ?');
      params.push(input.dshSessionId);
    }
    if (input.status !== undefined) {
      updates.push('status = ?');
      params.push(input.status);
    }
    if (input.title !== undefined) {
      updates.push('title = ?');
      params.push(input.title);
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
    const sql = `UPDATE session_routes SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`;
    this.db.prepare(sql).run(...params);

    const updated = await this.findById(id);
    if (!updated) {
      throw new NotFoundError('Session route not found');
    }
    return updated;
  }

  async reset(id: string, input: ResetSessionRouteInput): Promise<{ route: SessionRoute; generation: SessionGeneration }> {
    validateSessionId(id);

    if (!input || typeof input !== 'object') {
      throw new ValidationError('Invalid reset input: object required');
    }

    if (!input.dshSessionId || typeof input.dshSessionId !== 'string') {
      throw new ValidationError('dshSessionId is required for session reset');
    }
    const newDshSessionId = validateSessionId(input.dshSessionId);

    return withImmediateTransactionSync(this.db, () => {
      const route = queryOne(
        this.db.prepare('SELECT * FROM session_routes WHERE id = ? AND user_id = ?'),
        parseSessionRouteRow,
        id,
        this.userId
      );

      if (!route) {
        throw new NotFoundError('Session route not found');
      }

      let snapshotId: string | null = route.agentProfileSnapshotId ?? null;
      if (input.agentProfileSnapshotId !== undefined) {
        if (input.agentProfileSnapshotId !== null) {
          snapshotId = validateSnapshotId(input.agentProfileSnapshotId);
          const snapStmt = this.db.prepare('SELECT 1 FROM agent_profile_snapshots WHERE id = ? AND user_id = ?');
          const exists = snapStmt.get(snapshotId, this.userId);
          if (!exists) {
            throw new NotFoundError('Agent profile snapshot not found');
          }
        } else {
          snapshotId = null;
        }
      }

      const nextGenerationNumber = route.currentGeneration + 1;
      const nextResetCount = route.resetCount + 1;
      const nowIso = new Date().toISOString();
      const generationId = generateGenerationId();

      // 1. Insert generation record
      this.db.prepare(`
        INSERT INTO session_generations (
          id, user_id, route_id, generation_number, dsh_session_id, agent_profile_snapshot_id, reset_reason, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        generationId,
        this.userId,
        id,
        nextGenerationNumber,
        newDshSessionId,
        snapshotId,
        input.resetReason ?? null
      );

      // 2. Update session route
      this.db.prepare(`
        UPDATE session_routes
        SET current_generation = ?,
            reset_count = ?,
            last_reset_at = ?,
            dsh_session_id = ?,
            agent_profile_snapshot_id = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `).run(nextGenerationNumber, nextResetCount, nowIso, newDshSessionId, snapshotId, id, this.userId);

      const updatedRoute = queryOne(
        this.db.prepare('SELECT * FROM session_routes WHERE id = ? AND user_id = ?'),
        parseSessionRouteRow,
        id,
        this.userId
      );
      const createdGeneration = queryOne(
        this.db.prepare('SELECT * FROM session_generations WHERE id = ? AND user_id = ?'),
        parseSessionGenerationRow,
        generationId,
        this.userId
      );

      if (!updatedRoute || !createdGeneration) {
        throw new NotFoundError('Session route not found');
      }

      return {
        route: updatedRoute,
        generation: createdGeneration,
      };
    });
  }

  async archive(id: string): Promise<SessionRoute> {
    return this.update(id, { status: 'archived' });
  }

  async restore(id: string): Promise<SessionRoute> {
    return this.update(id, { status: 'active' });
  }

  async delete(id: string): Promise<boolean> {
    if (!isValidSessionId(id)) {
      return false;
    }
    const result = this.db.prepare('DELETE FROM session_routes WHERE id = ? AND user_id = ?').run(id, this.userId);
    return Number(result.changes) > 0;
  }

  async listBySpaceId(spaceId: string, options?: { status?: LifecycleStatus }): Promise<SessionRoute[]> {
    let sql = 'SELECT * FROM session_routes WHERE space_id = ? AND user_id = ?';
    const params: DbParam[] = [spaceId, this.userId];

    if (options?.status) {
      sql += ' AND status = ?';
      params.push(options.status);
    }

    sql += ' ORDER BY created_at ASC';
    const stmt = this.db.prepare(sql);
    return queryAll(stmt, parseSessionRouteRow, ...params);
  }

  async countBySpaceId(spaceId: string, options?: { status?: LifecycleStatus }): Promise<number> {
    let sql = 'SELECT COUNT(*) as count FROM session_routes WHERE space_id = ? AND user_id = ?';
    const params: DbParam[] = [spaceId, this.userId];

    if (options?.status) {
      sql += ' AND status = ?';
      params.push(options.status);
    }

    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  async list(options?: { status?: LifecycleStatus; limit?: number; offset?: number }): Promise<SessionRoute[]> {
    let sql = 'SELECT * FROM session_routes WHERE user_id = ?';
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
    return queryAll(stmt, parseSessionRouteRow, ...params);
  }

  async resolveAgentProfile(routeId: string): Promise<EffectiveAgentProfile> {
    const route = await this.findById(routeId);
    if (!route) {
      return {
        source: 'none',
        identity: '',
        soul: '',
        agents: '',
        tools: '',
        composedPrompt: '',
      };
    }

    // 1. Route-level explicit snapshot override
    if (route.agentProfileSnapshotId) {
      const snapStmt = this.db.prepare(
        'SELECT * FROM agent_profile_snapshots WHERE id = ? AND user_id = ?'
      );
      const snapshot = queryOne(snapStmt, parseAgentProfileSnapshotRow, route.agentProfileSnapshotId, this.userId);
      if (snapshot) {
        return {
          source: 'route',
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

    // 2. Route-level profile active version override
    if (route.agentProfileId) {
      const profStmt = this.db.prepare(
        'SELECT * FROM agent_profiles WHERE id = ? AND user_id = ?'
      );
      const profile = queryOne(profStmt, parseAgentProfileRow, route.agentProfileId, this.userId);
      if (profile) {
        const snapStmt = this.db.prepare(
          'SELECT * FROM agent_profile_snapshots WHERE profile_id = ? AND version = ? AND user_id = ?'
        );
        const snapshot = queryOne(snapStmt, parseAgentProfileSnapshotRow, profile.id, profile.activeVersion, this.userId);
        if (snapshot) {
          return {
            source: 'route',
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

    // 3. Cascading fallback to Space default binding
    const spaceRepo = new SqliteTenantScopedSpaceRepository(this.db, this.userId);
    return spaceRepo.resolveAgentProfile(route.spaceId);
  }
}
