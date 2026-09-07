import { randomUUID } from 'node:crypto';
import type {
  DeliveryReceipt,
  CreateDeliveryReceiptInput,
  UpdateDeliveryReceiptStatusInput,
  TenantScopedDeliveryReceiptRepository,
} from '@enkeep/platform-core';
import { NotFoundError } from '../../src/errors/index.js';

export class FakeTenantScopedDeliveryReceiptRepository implements TenantScopedDeliveryReceiptRepository {
  readonly userId: string;
  private readonly receipts = new Map<string, DeliveryReceipt>();

  constructor(userId: string) {
    this.userId = userId;
  }

  async findById(id: string): Promise<DeliveryReceipt | null> {
    const r = this.receipts.get(id);
    if (!r || r.userId !== this.userId) return null;
    return { ...r };
  }

  async findByDeliveryId(deliveryId: string): Promise<DeliveryReceipt | null> {
    for (const r of this.receipts.values()) {
      if (r.userId === this.userId && r.deliveryId === deliveryId) {
        return { ...r };
      }
    }
    return null;
  }

  async create(input: Omit<CreateDeliveryReceiptInput, 'userId'>): Promise<DeliveryReceipt> {
    // Simulate unique constraint on (userId, deliveryId)
    for (const r of this.receipts.values()) {
      if (r.userId === this.userId && r.deliveryId === input.deliveryId) {
        throw new Error(
          `UNIQUE constraint failed: delivery receipt with deliveryId "${input.deliveryId}" already exists for tenant "${this.userId}"`
        );
      }
    }

    const id = input.id || `rcpt_${randomUUID().replace(/-/g, '')}`;
    const now = new Date().toISOString();

    const receipt: DeliveryReceipt = {
      id,
      userId: this.userId,
      routeId: input.routeId,
      messageId: input.messageId,
      deliveryId: input.deliveryId,
      status: input.status || 'pending',
      error: input.error ?? null,
      createdAt: now,
      updatedAt: now,
    };

    this.receipts.set(id, receipt);
    return { ...receipt };
  }

  async updateStatus(id: string, input: UpdateDeliveryReceiptStatusInput): Promise<DeliveryReceipt> {
    const existing = this.receipts.get(id);
    if (!existing || existing.userId !== this.userId) {
      throw new NotFoundError(`Delivery receipt ${id} not found for tenant ${this.userId}`);
    }

    const updated: DeliveryReceipt = {
      ...existing,
      status: input.status,
      error: input.error !== undefined ? input.error : existing.error,
      updatedAt: new Date().toISOString(),
    };

    this.receipts.set(id, updated);
    return { ...updated };
  }

  async listPending(options?: { limit?: number }): Promise<DeliveryReceipt[]> {
    const pending = Array.from(this.receipts.values())
      .filter((r) => r.userId === this.userId && r.status === 'pending')
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    const limit = options?.limit ?? pending.length;
    return pending.slice(0, limit).map((r) => ({ ...r }));
  }

  async listByRouteId(routeId: string): Promise<DeliveryReceipt[]> {
    return Array.from(this.receipts.values())
      .filter((r) => r.userId === this.userId && r.routeId === routeId)
      .map((r) => ({ ...r }));
  }
}
