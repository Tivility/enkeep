import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  TaskNotificationSubscription,
  TaskNotificationDelivery,
  TaskNotificationChannel,
  TaskNotificationEventType,
  TaskNotificationDeliveryStatus,
  CreateTaskNotificationSubscriptionInput,
  UpdateTaskNotificationSubscriptionInput,
} from '@enkeep/platform-core';

interface DbSubscriptionRow {
  id: unknown;
  task_id: unknown;
  user_id: unknown;
  channel: unknown;
  destination: unknown;
  secret_hash: unknown;
  secret_ciphertext: unknown;
  enabled: unknown;
  events: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface DbDeliveryRow {
  id: unknown;
  subscription_id: unknown;
  task_id: unknown;
  run_id: unknown;
  user_id: unknown;
  channel: unknown;
  event: unknown;
  status: unknown;
  attempts: unknown;
  max_attempts: unknown;
  next_retry_at: unknown;
  last_error: unknown;
  payload_json: unknown;
  response_status: unknown;
  response_time_ms: unknown;
  idempotency_key: unknown;
  created_at: unknown;
  updated_at: unknown;
}

function parseSubscriptionRow(row: DbSubscriptionRow): TaskNotificationSubscription {
  let events: TaskNotificationEventType[] = ['completed', 'failed', 'cancelled', 'timeout'];
  if (row.events && typeof row.events === 'string') {
    try {
      const parsed = JSON.parse(row.events);
      if (Array.isArray(parsed)) {
        events = parsed;
      }
    } catch {
      // Keep fallback
    }
  }

  const hasSecret = Boolean(row.secret_ciphertext || row.secret_hash);
  const secretFingerprint = row.secret_hash ? `sha256:${String(row.secret_hash).slice(0, 8)}` : null;

  return {
    id: String(row.id),
    taskId: String(row.task_id),
    userId: String(row.user_id),
    channel: String(row.channel) as TaskNotificationChannel,
    destination: row.destination ? String(row.destination) : null,
    secretConfigured: hasSecret,
    secretFingerprint,
    enabled: Number(row.enabled) === 1,
    events,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseDeliveryRow(row: DbDeliveryRow): TaskNotificationDelivery {
  let payload: Record<string, unknown> = {};
  if (row.payload_json && typeof row.payload_json === 'string') {
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = {};
    }
  }

  return {
    id: String(row.id),
    subscriptionId: String(row.subscription_id),
    taskId: String(row.task_id),
    runId: row.run_id ? String(row.run_id) : null,
    userId: String(row.user_id),
    channel: String(row.channel) as TaskNotificationChannel,
    event: String(row.event) as TaskNotificationEventType,
    status: String(row.status) as TaskNotificationDeliveryStatus,
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 5),
    nextRetryAt: row.next_retry_at ? String(row.next_retry_at) : null,
    lastError: row.last_error ? String(row.last_error) : null,
    payload,
    responseStatus: row.response_status !== null && row.response_status !== undefined ? Number(row.response_status) : null,
    responseTimeMs: row.response_time_ms !== null && row.response_time_ms !== undefined ? Number(row.response_time_ms) : null,
    idempotencyKey: String(row.idempotency_key),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export interface StoredSubscriptionInput {
  taskId: string;
  userId: string;
  channel: TaskNotificationChannel;
  destination?: string | null;
  secretHash?: string | null;
  secretCiphertext?: string | null;
  events?: TaskNotificationEventType[];
  enabled?: boolean;
}

export interface UpdateStoredSubscriptionInput {
  id: string;
  userId: string;
  destination?: string | null;
  secretHash?: string | null;
  secretCiphertext?: string | null;
  events?: TaskNotificationEventType[];
  enabled?: boolean;
}

export interface CreateDeliveryInput {
  id?: string;
  subscriptionId: string;
  taskId: string;
  runId?: string | null;
  userId: string;
  channel: TaskNotificationChannel;
  event: TaskNotificationEventType;
  status?: TaskNotificationDeliveryStatus;
  attempts?: number;
  maxAttempts?: number;
  nextRetryAt?: string | null;
  lastError?: string | null;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export interface UpdateDeliveryStatusInput {
  status: TaskNotificationDeliveryStatus;
  attempts?: number;
  nextRetryAt?: string | null;
  lastError?: string | null;
  responseStatus?: number | null;
  responseTimeMs?: number | null;
}

export class SqliteTaskNotificationRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async createSubscription(input: StoredSubscriptionInput): Promise<TaskNotificationSubscription> {
    const id = `sub_${randomUUID().replace(/-/g, '')}`;
    const now = new Date().toISOString();
    const events = input.events ?? ['completed', 'failed', 'cancelled', 'timeout'];
    const eventsJson = JSON.stringify(events);
    const enabledInt = input.enabled === false ? 0 : 1;

    this.db.prepare(`
      INSERT INTO task_notification_subscriptions (
        id, task_id, user_id, channel, destination, secret_hash, secret_ciphertext, enabled, events, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.taskId,
      input.userId,
      input.channel,
      input.destination ?? null,
      input.secretHash ?? null,
      input.secretCiphertext ?? null,
      enabledInt,
      eventsJson,
      now,
      now
    );

    const hasSecret = Boolean(input.secretCiphertext || input.secretHash);
    const secretFingerprint = input.secretHash ? `sha256:${input.secretHash.slice(0, 8)}` : null;

    return {
      id,
      taskId: input.taskId,
      userId: input.userId,
      channel: input.channel,
      destination: input.destination ?? null,
      secretConfigured: hasSecret,
      secretFingerprint,
      enabled: enabledInt === 1,
      events,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getSubscription(id: string, userId: string): Promise<TaskNotificationSubscription | null> {
    const row = this.db.prepare(`
      SELECT * FROM task_notification_subscriptions WHERE id = ? AND user_id = ?
    `).get(id, userId) as unknown as DbSubscriptionRow | undefined;

    if (!row) return null;
    return parseSubscriptionRow(row);
  }

  async getSubscriptionCiphertext(id: string): Promise<string | null> {
    const row = this.db.prepare(`
      SELECT secret_ciphertext FROM task_notification_subscriptions WHERE id = ?
    `).get(id) as { secret_ciphertext: string | null } | undefined;

    return row?.secret_ciphertext ? String(row.secret_ciphertext) : null;
  }

  async listSubscriptions(taskId: string, userId: string): Promise<TaskNotificationSubscription[]> {
    const rows = this.db.prepare(`
      SELECT * FROM task_notification_subscriptions WHERE task_id = ? AND user_id = ? ORDER BY created_at ASC
    `).all(taskId, userId) as unknown as DbSubscriptionRow[];

    return rows.map(parseSubscriptionRow);
  }

  async findSubscriptionsForEvent(taskId: string, event: TaskNotificationEventType): Promise<TaskNotificationSubscription[]> {
    const rows = this.db.prepare(`
      SELECT * FROM task_notification_subscriptions WHERE task_id = ? AND enabled = 1
    `).all(taskId) as unknown as DbSubscriptionRow[];

    const allSubs = rows.map(parseSubscriptionRow);
    return allSubs.filter((s) => s.events.includes(event));
  }

  async updateSubscription(input: UpdateStoredSubscriptionInput): Promise<TaskNotificationSubscription | null> {
    const now = new Date().toISOString();
    const existingRow = this.db.prepare(`
      SELECT * FROM task_notification_subscriptions WHERE id = ? AND user_id = ?
    `).get(input.id, input.userId) as unknown as DbSubscriptionRow | undefined;

    if (!existingRow) return null;

    const destination = input.destination !== undefined ? input.destination : (existingRow.destination ? String(existingRow.destination) : null);
    const secretHash = input.secretHash !== undefined ? input.secretHash : (existingRow.secret_hash ? String(existingRow.secret_hash) : null);
    const secretCiphertext = input.secretCiphertext !== undefined ? input.secretCiphertext : (existingRow.secret_ciphertext ? String(existingRow.secret_ciphertext) : null);
    const enabled = input.enabled !== undefined ? input.enabled : Number(existingRow.enabled) === 1;

    let events = ['completed', 'failed', 'cancelled', 'timeout'];
    if (input.events !== undefined) {
      events = input.events;
    } else if (existingRow.events && typeof existingRow.events === 'string') {
      try {
        events = JSON.parse(existingRow.events);
      } catch {
        // Keep fallback
      }
    }

    this.db.prepare(`
      UPDATE task_notification_subscriptions
      SET destination = ?,
          secret_hash = ?,
          secret_ciphertext = ?,
          enabled = ?,
          events = ?,
          updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(
      destination,
      secretHash,
      secretCiphertext,
      enabled ? 1 : 0,
      JSON.stringify(events),
      now,
      input.id,
      input.userId
    );

    const hasSecret = Boolean(secretCiphertext || secretHash);
    const secretFingerprint = secretHash ? `sha256:${secretHash.slice(0, 8)}` : null;

    return {
      id: input.id,
      taskId: String(existingRow.task_id),
      userId: input.userId,
      channel: String(existingRow.channel) as TaskNotificationChannel,
      destination,
      secretConfigured: hasSecret,
      secretFingerprint,
      enabled,
      events: events as TaskNotificationEventType[],
      createdAt: String(existingRow.created_at),
      updatedAt: now,
    };
  }

  async deleteSubscription(id: string, userId: string): Promise<boolean> {
    const res = this.db.prepare(`
      DELETE FROM task_notification_subscriptions WHERE id = ? AND user_id = ?
    `).run(id, userId);

    return Number((res as any)?.changes ?? 0) > 0;
  }

  async createDelivery(input: CreateDeliveryInput): Promise<TaskNotificationDelivery> {
    const id = input.id || `del_${randomUUID().replace(/-/g, '')}`;
    const now = new Date().toISOString();
    const status = input.status || 'pending';
    const attempts = input.attempts ?? 0;
    const maxAttempts = input.maxAttempts ?? 5;
    const payloadJson = JSON.stringify(input.payload);

    this.db.prepare(`
      INSERT INTO task_notification_deliveries (
        id, subscription_id, task_id, run_id, user_id, channel, event, status,
        attempts, max_attempts, next_retry_at, last_error, payload_json, idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.subscriptionId,
      input.taskId,
      input.runId ?? null,
      input.userId,
      input.channel,
      input.event,
      status,
      attempts,
      maxAttempts,
      input.nextRetryAt ?? null,
      input.lastError ?? null,
      payloadJson,
      input.idempotencyKey,
      now,
      now
    );

    return {
      id,
      subscriptionId: input.subscriptionId,
      taskId: input.taskId,
      runId: input.runId ?? null,
      userId: input.userId,
      channel: input.channel,
      event: input.event,
      status,
      attempts,
      maxAttempts,
      nextRetryAt: input.nextRetryAt ?? null,
      lastError: input.lastError ?? null,
      payload: input.payload,
      responseStatus: null,
      responseTimeMs: null,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getDelivery(id: string, userId: string): Promise<TaskNotificationDelivery | null> {
    const row = this.db.prepare(`
      SELECT * FROM task_notification_deliveries WHERE id = ? AND user_id = ?
    `).get(id, userId) as unknown as DbDeliveryRow | undefined;

    if (!row) return null;
    return parseDeliveryRow(row);
  }

  async getDeliveryById(id: string): Promise<TaskNotificationDelivery | null> {
    const row = this.db.prepare(`
      SELECT * FROM task_notification_deliveries WHERE id = ?
    `).get(id) as unknown as DbDeliveryRow | undefined;

    if (!row) return null;
    return parseDeliveryRow(row);
  }

  async listDeliveries(taskId: string, userId: string, limit = 50, offset = 0): Promise<{ items: TaskNotificationDelivery[]; total: number }> {
    const countRow = this.db.prepare(`
      SELECT COUNT(*) as total FROM task_notification_deliveries WHERE task_id = ? AND user_id = ?
    `).get(taskId, userId) as { total: unknown } | undefined;
    const total = Number(countRow?.total ?? 0);

    const rows = this.db.prepare(`
      SELECT * FROM task_notification_deliveries
      WHERE task_id = ? AND user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(taskId, userId, limit, offset) as unknown as DbDeliveryRow[];

    return {
      items: rows.map(parseDeliveryRow),
      total,
    };
  }

  async updateDeliveryStatus(id: string, updates: UpdateDeliveryStatusInput): Promise<TaskNotificationDelivery | null> {
    const now = new Date().toISOString();
    const existing = await this.getDeliveryById(id);
    if (!existing) return null;

    const attempts = updates.attempts !== undefined ? updates.attempts : existing.attempts;
    const nextRetryAt = updates.nextRetryAt !== undefined ? updates.nextRetryAt : existing.nextRetryAt;
    const lastError = updates.lastError !== undefined ? updates.lastError : existing.lastError;
    const responseStatus = updates.responseStatus !== undefined ? updates.responseStatus : existing.responseStatus;
    const responseTimeMs = updates.responseTimeMs !== undefined ? updates.responseTimeMs : existing.responseTimeMs;

    this.db.prepare(`
      UPDATE task_notification_deliveries
      SET status = ?,
          attempts = ?,
          next_retry_at = ?,
          last_error = ?,
          response_status = ?,
          response_time_ms = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      updates.status,
      attempts,
      nextRetryAt,
      lastError,
      responseStatus,
      responseTimeMs,
      now,
      id
    );

    return {
      ...existing,
      status: updates.status,
      attempts,
      nextRetryAt,
      lastError,
      responseStatus,
      responseTimeMs,
      updatedAt: now,
    };
  }

  async findPendingDeliveries(now = new Date().toISOString(), limit = 50): Promise<TaskNotificationDelivery[]> {
    const rows = this.db.prepare(`
      SELECT * FROM task_notification_deliveries
      WHERE (status = 'pending')
         OR (status = 'failed' AND attempts < max_attempts AND next_retry_at IS NOT NULL AND next_retry_at <= ?)
      ORDER BY created_at ASC
      LIMIT ?
    `).all(now, limit) as unknown as DbDeliveryRow[];

    return rows.map(parseDeliveryRow);
  }
}
