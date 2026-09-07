import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  DeliveryReceipt,
  CreateDeliveryReceiptInput,
  UpdateDeliveryReceiptStatusInput,
  TenantScopedDeliveryReceiptRepository,
} from '@enkeep/platform-core';
import { NotFoundError } from '@enkeep/platform-core';
import { type DbParam, parseDeliveryReceiptRow, queryOne, queryAll } from '../utils/db.js';

export class SqliteTenantScopedDeliveryReceiptRepository implements TenantScopedDeliveryReceiptRepository {
  readonly userId: string;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  async findById(id: string): Promise<DeliveryReceipt | null> {
    const stmt = this.db.prepare('SELECT * FROM delivery_receipts WHERE id = ? AND user_id = ?');
    return queryOne(stmt, parseDeliveryReceiptRow, id, this.userId);
  }

  async findByDeliveryId(deliveryId: string): Promise<DeliveryReceipt | null> {
    const stmt = this.db.prepare('SELECT * FROM delivery_receipts WHERE delivery_id = ? AND user_id = ?');
    return queryOne(stmt, parseDeliveryReceiptRow, deliveryId, this.userId);
  }

  async create(input: Omit<CreateDeliveryReceiptInput, 'userId'>): Promise<DeliveryReceipt> {
    const id = input.id ?? randomUUID();
    const status = input.status ?? 'pending';

    // Verify the route belongs to this user
    const checkRouteStmt = this.db.prepare('SELECT 1 FROM session_routes WHERE id = ? AND user_id = ?');
    const routeExists = checkRouteStmt.get(input.routeId, this.userId);
    if (!routeExists) {
      throw new NotFoundError('Session route not found');
    }

    this.db.prepare(`
      INSERT INTO delivery_receipts (id, user_id, route_id, message_id, delivery_id, status, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(id, this.userId, input.routeId, input.messageId, input.deliveryId, status, input.error ?? null);

    const receipt = await this.findById(id);
    if (!receipt) {
      throw new Error('Failed to retrieve newly created delivery receipt');
    }
    return receipt;
  }

  async updateStatus(id: string, input: UpdateDeliveryReceiptStatusInput): Promise<DeliveryReceipt> {
    const checkStmt = this.db.prepare('SELECT 1 FROM delivery_receipts WHERE id = ? AND user_id = ?');
    const exists = checkStmt.get(id, this.userId);

    if (!exists) {
      throw new NotFoundError('Delivery receipt not found');
    }

    const updates: string[] = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
    const params: DbParam[] = [input.status];

    if (input.error !== undefined) {
      updates.push('error = ?');
      params.push(input.error);
    }

    params.push(id, this.userId);
    const sql = `UPDATE delivery_receipts SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`;
    this.db.prepare(sql).run(...params);

    const updated = await this.findById(id);
    if (!updated) {
      throw new NotFoundError('Delivery receipt not found');
    }
    return updated;
  }

  async listPending(options?: { limit?: number }): Promise<DeliveryReceipt[]> {
    let sql = "SELECT * FROM delivery_receipts WHERE user_id = ? AND status = 'pending' ORDER BY created_at ASC";
    const params: DbParam[] = [this.userId];

    if (options?.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    const stmt = this.db.prepare(sql);
    return queryAll(stmt, parseDeliveryReceiptRow, ...params);
  }

  async listByRouteId(routeId: string): Promise<DeliveryReceipt[]> {
    const stmt = this.db.prepare('SELECT * FROM delivery_receipts WHERE route_id = ? AND user_id = ? ORDER BY created_at ASC');
    return queryAll(stmt, parseDeliveryReceiptRow, routeId, this.userId);
  }
}
