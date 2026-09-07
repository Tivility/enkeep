import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  SessionSource,
  CreateSessionSourceInput,
  TenantScopedSessionSourceRepository,
} from '@enkeep/platform-core';
import { NotFoundError } from '@enkeep/platform-core';
import { parseSessionSourceRow, queryOne, queryAll } from '../utils/db.js';

export class SqliteTenantScopedSessionSourceRepository implements TenantScopedSessionSourceRepository {
  readonly userId: string;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  async findById(id: string): Promise<SessionSource | null> {
    const stmt = this.db.prepare('SELECT * FROM session_sources WHERE id = ? AND user_id = ?');
    return queryOne(stmt, parseSessionSourceRow, id, this.userId);
  }

  async findBySource(sourceType: string, sourceId: string): Promise<SessionSource | null> {
    const stmt = this.db.prepare('SELECT * FROM session_sources WHERE user_id = ? AND source_type = ? AND source_id = ?');
    return queryOne(stmt, parseSessionSourceRow, this.userId, sourceType, sourceId);
  }

  async create(input: Omit<CreateSessionSourceInput, 'userId'>): Promise<SessionSource> {
    const id = input.id ?? randomUUID();

    // Ensure the route belongs to this user
    const checkRouteStmt = this.db.prepare('SELECT 1 FROM session_routes WHERE id = ? AND user_id = ?');
    const routeExists = checkRouteStmt.get(input.routeId, this.userId);
    if (!routeExists) {
      throw new NotFoundError('Session route not found');
    }

    const metaStr = input.metadata !== undefined && input.metadata !== null ? JSON.stringify(input.metadata) : null;

    this.db.prepare(`
      INSERT INTO session_sources (id, route_id, source_type, source_id, user_id, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(id, input.routeId, input.sourceType, input.sourceId, this.userId, metaStr);

    const source = await this.findById(id);
    if (!source) {
      throw new Error('Failed to retrieve newly created session source');
    }
    return source;
  }

  async listByRouteId(routeId: string): Promise<SessionSource[]> {
    const stmt = this.db.prepare('SELECT * FROM session_sources WHERE route_id = ? AND user_id = ? ORDER BY created_at ASC');
    return queryAll(stmt, parseSessionSourceRow, routeId, this.userId);
  }
}
