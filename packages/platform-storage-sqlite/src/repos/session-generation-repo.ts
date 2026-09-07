import type { DatabaseSync } from 'node:sqlite';
import type {
  SessionGeneration,
  CreateSessionGenerationInput,
  TenantScopedSessionGenerationRepository,
} from '@enkeep/platform-core';
import {
  NotFoundError,
  ValidationError,
} from '@enkeep/platform-core';
import {
  type DbParam,
  parseSessionGenerationRow,
  queryOne,
  queryAll,
  getString,
} from '../utils/db.js';
import {
  generateGenerationId,
  validateGenerationId,
  isValidGenerationId,
  validateSessionId,
  isValidSessionId,
  validateSnapshotId,
} from '../utils/id.js';

export class SqliteTenantScopedSessionGenerationRepository implements TenantScopedSessionGenerationRepository {
  readonly userId: string;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  async findById(id: string): Promise<SessionGeneration | null> {
    if (!isValidGenerationId(id)) {
      return null;
    }
    const stmt = this.db.prepare('SELECT * FROM session_generations WHERE id = ? AND user_id = ?');
    return queryOne(stmt, parseSessionGenerationRow, id, this.userId);
  }

  async findByRouteAndNumber(routeId: string, generationNumber: number): Promise<SessionGeneration | null> {
    if (!isValidSessionId(routeId)) {
      return null;
    }
    const stmt = this.db.prepare(
      'SELECT * FROM session_generations WHERE route_id = ? AND generation_number = ? AND user_id = ?'
    );
    return queryOne(stmt, parseSessionGenerationRow, routeId, generationNumber, this.userId);
  }

  async getLatestByRouteId(routeId: string): Promise<SessionGeneration | null> {
    if (!isValidSessionId(routeId)) {
      return null;
    }
    const stmt = this.db.prepare(
      'SELECT * FROM session_generations WHERE route_id = ? AND user_id = ? ORDER BY generation_number DESC LIMIT 1'
    );
    return queryOne(stmt, parseSessionGenerationRow, routeId, this.userId);
  }

  async create(input: Omit<CreateSessionGenerationInput, 'userId'>): Promise<SessionGeneration> {
    validateSessionId(input.routeId);

    const checkRoute = this.db.prepare('SELECT dsh_session_id FROM session_routes WHERE id = ? AND user_id = ?');
    const routeRow = queryOne(
      checkRoute,
      (row) => ({
        dshSessionId: getString(row, 'dsh_session_id'),
      }),
      input.routeId,
      this.userId
    );
    if (!routeRow) {
      throw new NotFoundError('Session route not found');
    }

    const id = input.id !== undefined ? validateGenerationId(input.id) : generateGenerationId();

    const rawDshSessionId = input.dshSessionId ?? routeRow.dshSessionId;
    const dshSessionId = validateSessionId(rawDshSessionId);

    let snapshotId: string | null = null;
    if (input.agentProfileSnapshotId !== undefined && input.agentProfileSnapshotId !== null) {
      snapshotId = validateSnapshotId(input.agentProfileSnapshotId);
      const snapStmt = this.db.prepare('SELECT 1 FROM agent_profile_snapshots WHERE id = ? AND user_id = ?');
      const exists = snapStmt.get(snapshotId, this.userId);
      if (!exists) {
        throw new NotFoundError('Agent profile snapshot not found');
      }
    }

    let generationNumber = input.generationNumber;
    if (generationNumber === undefined) {
      const maxGenRow = this.db.prepare(
        'SELECT coalesce(max(generation_number), 0) as max_g FROM session_generations WHERE route_id = ? AND user_id = ?'
      ).get(input.routeId, this.userId) as { max_g: number | bigint };
      generationNumber = Number(maxGenRow.max_g) + 1;
    } else if (!Number.isInteger(generationNumber) || generationNumber <= 0) {
      throw new ValidationError('Invalid generation number');
    }

    this.db.prepare(`
      INSERT INTO session_generations (id, user_id, route_id, generation_number, dsh_session_id, agent_profile_snapshot_id, reset_reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      id,
      this.userId,
      input.routeId,
      generationNumber,
      dshSessionId,
      snapshotId,
      input.resetReason ?? null
    );

    const created = await this.findById(id);
    if (!created) {
      throw new NotFoundError('Session generation not found');
    }
    return created;
  }

  async listByRouteId(routeId: string, options?: { limit?: number; offset?: number }): Promise<SessionGeneration[]> {
    if (!isValidSessionId(routeId)) {
      return [];
    }
    let sql = 'SELECT * FROM session_generations WHERE route_id = ? AND user_id = ? ORDER BY generation_number ASC';
    const params: DbParam[] = [routeId, this.userId];

    if (options?.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
      if (options?.offset) {
        sql += ' OFFSET ?';
        params.push(options.offset);
      }
    }

    const stmt = this.db.prepare(sql);
    return queryAll(stmt, parseSessionGenerationRow, ...params);
  }
}
