import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  TurnRun,
  CreateTurnRunInput,
  UpdateTurnRunStatusInput,
  TenantScopedTurnRunRepository,
} from '@enkeep/platform-core';
import { NotFoundError } from '@enkeep/platform-core';
import { type DbParam, parseTurnRunRow, queryOne, queryAll } from '../utils/db.js';

export class SqliteTenantScopedTurnRunRepository implements TenantScopedTurnRunRepository {
  readonly userId: string;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  async findById(id: string): Promise<TurnRun | null> {
    const stmt = this.db.prepare('SELECT * FROM turn_runs WHERE id = ? AND user_id = ?');
    return queryOne(stmt, parseTurnRunRow, id, this.userId);
  }

  async create(input: Omit<CreateTurnRunInput, 'userId'>): Promise<TurnRun> {
    const id = input.id ?? randomUUID();
    const status = input.status ?? 'queued';
    let executionMode: import('@enkeep/platform-core').ExecutionMode = input.executionMode ?? 'container';
    const startedAt = input.startedAt ?? (status === 'running' ? new Date().toISOString() : null);

    // Verify space and route belong to this user
    const checkSpaceStmt = this.db.prepare('SELECT execution_mode FROM spaces WHERE id = ? AND user_id = ?');
    const spaceRow = checkSpaceStmt.get(input.spaceId, this.userId) as { execution_mode: string } | undefined;
    if (!spaceRow) {
      throw new NotFoundError('Space not found');
    }
    if (spaceRow.execution_mode) {
      executionMode = spaceRow.execution_mode as import('@enkeep/platform-core').ExecutionMode;
    }

    const checkRouteStmt = this.db.prepare('SELECT 1 FROM session_routes WHERE id = ? AND user_id = ?');
    if (!checkRouteStmt.get(input.routeId, this.userId)) {
      throw new NotFoundError('Session route not found');
    }

    this.db.prepare(`
      INSERT INTO turn_runs (id, user_id, space_id, route_id, turn_id, status, started_at, finished_at, error, execution_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(id, this.userId, input.spaceId, input.routeId, input.turnId, status, startedAt, executionMode);

    const run = await this.findById(id);
    if (!run) {
      throw new Error('Failed to retrieve newly created turn run');
    }
    return run;
  }

  async updateStatus(id: string, input: UpdateTurnRunStatusInput): Promise<TurnRun> {
    const checkStmt = this.db.prepare('SELECT 1 FROM turn_runs WHERE id = ? AND user_id = ?');
    if (!checkStmt.get(id, this.userId)) {
      throw new NotFoundError('Turn run not found');
    }

    const updates: string[] = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
    const params: DbParam[] = [input.status];

    if (input.startedAt !== undefined) {
      updates.push('started_at = ?');
      params.push(input.startedAt);
    }
    if (input.finishedAt !== undefined) {
      updates.push('finished_at = ?');
      params.push(input.finishedAt);
    }
    if (input.error !== undefined) {
      updates.push('error = ?');
      params.push(input.error);
    }

    params.push(id, this.userId);
    const sql = `UPDATE turn_runs SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`;
    this.db.prepare(sql).run(...params);

    const updated = await this.findById(id);
    if (!updated) {
      throw new NotFoundError('Turn run not found');
    }
    return updated;
  }

  async listByRouteId(routeId: string): Promise<TurnRun[]> {
    const stmt = this.db.prepare('SELECT * FROM turn_runs WHERE route_id = ? AND user_id = ? ORDER BY created_at ASC');
    return queryAll(stmt, parseTurnRunRow, routeId, this.userId);
  }

  async listOpenRuns(): Promise<TurnRun[]> {
    const stmt = this.db.prepare("SELECT * FROM turn_runs WHERE user_id = ? AND status IN ('queued', 'running') ORDER BY created_at ASC");
    return queryAll(stmt, parseTurnRunRow, this.userId);
  }

  async interruptOpenRuns(reason = 'interrupted by system restart'): Promise<number> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE turn_runs
      SET status = 'interrupted',
          finished_at = coalesce(finished_at, ?),
          error = coalesce(error, ?),
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND status IN ('queued', 'running')
    `).run(now, reason, this.userId);
    return Number(result.changes);
  }
}
