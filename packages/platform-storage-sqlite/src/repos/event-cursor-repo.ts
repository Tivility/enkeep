import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  EventCursor,
  TenantScopedEventCursorRepository,
} from '@enkeep/platform-core';
import { NotFoundError } from '@enkeep/platform-core';
import { parseEventCursorRow, queryOne, queryAll } from '../utils/db.js';

export class SqliteTenantScopedEventCursorRepository implements TenantScopedEventCursorRepository {
  readonly userId: string;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  async getCursor(routeId: string, consumer = 'default'): Promise<EventCursor | null> {
    const stmt = this.db.prepare(
      'SELECT * FROM event_cursors WHERE user_id = ? AND route_id = ? AND consumer = ?'
    );
    return queryOne(stmt, parseEventCursorRow, this.userId, routeId, consumer);
  }

  async setCursor(routeId: string, cursorValue: string, consumer = 'default'): Promise<EventCursor> {
    // Verify route belongs to this user
    const checkRouteStmt = this.db.prepare('SELECT 1 FROM session_routes WHERE id = ? AND user_id = ?');
    const routeExists = checkRouteStmt.get(routeId, this.userId);
    if (!routeExists) {
      throw new NotFoundError('Session route not found');
    }

    const existing = await this.getCursor(routeId, consumer);
    if (existing) {
      this.db.prepare(`
        UPDATE event_cursors
        SET cursor_value = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND route_id = ? AND consumer = ?
      `).run(cursorValue, this.userId, routeId, consumer);
    } else {
      const id = randomUUID();
      this.db.prepare(`
        INSERT INTO event_cursors (id, user_id, route_id, consumer, cursor_value, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(id, this.userId, routeId, consumer, cursorValue);
    }

    const updated = await this.getCursor(routeId, consumer);
    if (!updated) {
      throw new Error('Failed to retrieve event cursor');
    }
    return updated;
  }

  async listByRouteId(routeId: string): Promise<EventCursor[]> {
    const stmt = this.db.prepare(
      'SELECT * FROM event_cursors WHERE user_id = ? AND route_id = ? ORDER BY consumer ASC'
    );
    return queryAll(stmt, parseEventCursorRow, this.userId, routeId);
  }

  async list(): Promise<EventCursor[]> {
    const stmt = this.db.prepare(
      'SELECT * FROM event_cursors WHERE user_id = ? ORDER BY route_id ASC, consumer ASC'
    );
    return queryAll(stmt, parseEventCursorRow, this.userId);
  }
}
