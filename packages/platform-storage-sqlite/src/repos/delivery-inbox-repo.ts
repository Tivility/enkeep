import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  DeliveryInboxEntry,
  IngestDeliveryInboxInput,
  IngestDeliveryResult,
  UpdateDeliveryInboxStatusInput,
  TenantScopedDeliveryInboxRepository,
} from '@enkeep/platform-core';
import {
  NotFoundError,
  InvalidStateTransitionError,
} from '@enkeep/platform-core';
import {
  type DbParam,
  parseDeliveryInboxRow,
  queryOne,
  queryAll,
  getNullableString,
  getString,
} from '../utils/db.js';

export class SqliteTenantScopedDeliveryInboxRepository implements TenantScopedDeliveryInboxRepository {
  readonly userId: string;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  async findById(id: string): Promise<DeliveryInboxEntry | null> {
    const stmt = this.db.prepare('SELECT * FROM delivery_inbox WHERE id = ? AND user_id = ?');
    return queryOne(stmt, parseDeliveryInboxRow, id, this.userId);
  }

  async findByDeliveryId(deliveryId: string): Promise<DeliveryInboxEntry | null> {
    const stmt = this.db.prepare('SELECT * FROM delivery_inbox WHERE delivery_id = ? AND user_id = ?');
    return queryOne(stmt, parseDeliveryInboxRow, deliveryId, this.userId);
  }

  async ingest(input: Omit<IngestDeliveryInboxInput, 'userId'>): Promise<IngestDeliveryResult> {
    // 1. Verify route belongs to this tenant
    const checkRouteStmt = this.db.prepare('SELECT 1 FROM session_routes WHERE id = ? AND user_id = ?');
    const routeExists = checkRouteStmt.get(input.routeId, this.userId);
    if (!routeExists) {
      throw new NotFoundError('Session route not found');
    }

    // 2. Check if deliveryId already exists for this tenant (tenant-scoped idempotency)
    const existing = await this.findByDeliveryId(input.deliveryId);
    if (existing) {
      return {
        entry: existing,
        isDuplicate: true,
      };
    }

    const id = input.id ?? randomUUID();
    const receivedAt = input.receivedAt ?? new Date().toISOString();
    const payloadStr = input.payload !== undefined && input.payload !== null ? JSON.stringify(input.payload) : null;

    try {
      this.db.prepare(`
        INSERT INTO delivery_inbox (id, user_id, route_id, message_id, delivery_id, status, payload, error, received_at, processed_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'held', ?, NULL, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(id, this.userId, input.routeId, input.messageId, input.deliveryId, payloadStr, receivedAt);
    } catch (err) {
      // If concurrent insert occurred with identical (user_id, delivery_id), fetch and return duplicate
      const duplicate = await this.findByDeliveryId(input.deliveryId);
      if (duplicate) {
        return {
          entry: duplicate,
          isDuplicate: true,
        };
      }
      throw err;
    }

    const created = await this.findById(id);
    if (!created) {
      throw new Error('Failed to retrieve newly ingested delivery inbox entry');
    }

    return {
      entry: created,
      isDuplicate: false,
    };
  }

  /**
   * Atomic CAS transition: held -> processing
   * Returns DeliveryInboxEntry if claimed, or null if item is not in held status (e.g. lost race)
   */
  async claimHeld(id: string): Promise<DeliveryInboxEntry | null> {
    this.checkOwnershipAndGet(id);

    const result = this.db.prepare(`
      UPDATE delivery_inbox
      SET status = 'processing', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ? AND status = 'held'
    `).run(id, this.userId);

    if (Number(result.changes) === 0) {
      return null;
    }

    return this.findById(id);
  }

  /**
   * Atomic CAS transition: processing -> held (for redelivery/retry)
   */
  async releaseToHeld(id: string, error?: string): Promise<DeliveryInboxEntry> {
    const existing = this.checkOwnershipAndGet(id);

    const result = this.db.prepare(`
      UPDATE delivery_inbox
      SET status = 'held', error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ? AND status = 'processing'
    `).run(error ?? null, id, this.userId);

    if (Number(result.changes) === 0) {
      const current = await this.findById(id);
      throw new InvalidStateTransitionError(
        current ? current.status : existing.status,
        'held',
        `Cannot release to held: item is in '${current ? current.status : existing.status}' status, expected 'processing'`
      );
    }

    const updated = await this.findById(id);
    if (!updated) {
      throw new NotFoundError(`DeliveryInboxEntry with id '${id}' not found after release`);
    }
    return updated;
  }

  /**
   * Atomic CAS transition: processing -> delivered
   * Requires prior claimHeld (held -> processing).
   */
  async markDelivered(id: string, processedAt?: string): Promise<DeliveryInboxEntry> {
    const existing = this.checkOwnershipAndGet(id);
    const ts = processedAt ?? new Date().toISOString();

    const result = this.db.prepare(`
      UPDATE delivery_inbox
      SET status = 'delivered', processed_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ? AND status = 'processing'
    `).run(ts, id, this.userId);

    if (Number(result.changes) === 0) {
      const current = await this.findById(id);
      throw new InvalidStateTransitionError(
        current ? current.status : existing.status,
        'delivered',
        `Cannot mark delivered: item is in '${current ? current.status : existing.status}' status, expected 'processing'`
      );
    }

    const updated = await this.findById(id);
    if (!updated) {
      throw new NotFoundError(`DeliveryInboxEntry with id '${id}' not found after markDelivered`);
    }
    return updated;
  }

  /**
   * Atomic CAS transition: (held | processing) -> duplicate
   */
  async markDuplicate(id: string, error?: string): Promise<DeliveryInboxEntry> {
    const existing = this.checkOwnershipAndGet(id);
    const errText = error ?? 'Duplicate delivery detected';

    const result = this.db.prepare(`
      UPDATE delivery_inbox
      SET status = 'duplicate', error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ? AND status IN ('held', 'processing')
    `).run(errText, id, this.userId);

    if (Number(result.changes) === 0) {
      const current = await this.findById(id);
      throw new InvalidStateTransitionError(
        current ? current.status : existing.status,
        'duplicate',
        `Cannot mark duplicate: item is in '${current ? current.status : existing.status}' status, expected 'held' or 'processing'`
      );
    }

    const updated = await this.findById(id);
    if (!updated) {
      throw new NotFoundError(`DeliveryInboxEntry with id '${id}' not found after markDuplicate`);
    }
    return updated;
  }

  /**
   * Atomic CAS transition: (held | processing) -> cancelled
   */
  async markCancelled(id: string, error?: string): Promise<DeliveryInboxEntry> {
    const existing = this.checkOwnershipAndGet(id);
    const errText = error ?? 'Delivery cancelled';

    const result = this.db.prepare(`
      UPDATE delivery_inbox
      SET status = 'cancelled', error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ? AND status IN ('held', 'processing')
    `).run(errText, id, this.userId);

    if (Number(result.changes) === 0) {
      const current = await this.findById(id);
      throw new InvalidStateTransitionError(
        current ? current.status : existing.status,
        'cancelled',
        `Cannot mark cancelled: item is in '${current ? current.status : existing.status}' status, expected 'held' or 'processing'`
      );
    }

    const updated = await this.findById(id);
    if (!updated) {
      throw new NotFoundError(`DeliveryInboxEntry with id '${id}' not found after markCancelled`);
    }
    return updated;
  }

  async updateStatus(id: string, input: UpdateDeliveryInboxStatusInput): Promise<DeliveryInboxEntry> {
    switch (input.status) {
      case 'processing': {
        const claimed = await this.claimHeld(id);
        if (!claimed) {
          const current = await this.findById(id);
          throw new InvalidStateTransitionError(
            current ? current.status : 'unknown',
            'processing',
            `Cannot transition to processing: item is in '${current ? current.status : 'unknown'}' status`
          );
        }
        return claimed;
      }
      case 'held':
        return this.releaseToHeld(id, input.error ?? undefined);
      case 'delivered':
        return this.markDelivered(id, input.processedAt ?? undefined);
      case 'duplicate':
        return this.markDuplicate(id, input.error ?? undefined);
      case 'cancelled':
        return this.markCancelled(id, input.error ?? undefined);
      default:
        throw new InvalidStateTransitionError('unknown', String(input.status));
    }
  }

  async listHeld(options?: { limit?: number }): Promise<DeliveryInboxEntry[]> {
    let sql = "SELECT * FROM delivery_inbox WHERE user_id = ? AND status = 'held' ORDER BY received_at ASC";
    const params: DbParam[] = [this.userId];

    if (options?.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    const stmt = this.db.prepare(sql);
    return queryAll(stmt, parseDeliveryInboxRow, ...params);
  }

  async listProcessing(options?: { limit?: number }): Promise<DeliveryInboxEntry[]> {
    let sql = "SELECT * FROM delivery_inbox WHERE user_id = ? AND status = 'processing' ORDER BY received_at ASC";
    const params: DbParam[] = [this.userId];

    if (options?.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    const stmt = this.db.prepare(sql);
    return queryAll(stmt, parseDeliveryInboxRow, ...params);
  }

  async listByRouteId(routeId: string, options?: { limit?: number; offset?: number }): Promise<DeliveryInboxEntry[]> {
    let sql = 'SELECT * FROM delivery_inbox WHERE route_id = ? AND user_id = ? ORDER BY received_at ASC';
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
    return queryAll(stmt, parseDeliveryInboxRow, ...params);
  }

  private checkOwnershipAndGet(id: string): { userId: string; status: string } {
    const checkStmt = this.db.prepare('SELECT user_id, status FROM delivery_inbox WHERE id = ? AND user_id = ?');
    const row = checkStmt.get(id, this.userId) as Record<string, string> | undefined;

    if (!row) {
      throw new NotFoundError('Delivery inbox entry not found');
    }

    return {
      userId: getString(row, 'user_id'),
      status: getString(row, 'status'),
    };
  }
}
