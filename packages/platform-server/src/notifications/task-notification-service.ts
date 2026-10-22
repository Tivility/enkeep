/**
 * Task Notification Backend Service
 *
 * Implements:
 * 1. Notification subscriptions per task (in_app required, webhook optional).
 * 2. SSRF defense, private IP / cloud metadata blocklist, DNS rebinding prevention.
 * 3. AES-256-GCM credential encryption for stored webhook secrets via CredentialCipherPort.
 * 4. HMAC-SHA256 signing (X-Enkeep-Signature) over raw JSON payload.
 * 5. Safe webhook payload construction: NO prompt or model text, URL secrets redacted.
 * 6. At-least-once delivery worker with exponential backoff & dead-letter queue.
 * 7. Test webhook verification endpoint.
 * 8. task_route channel: failure / timeout / missed-run notices on the task's own route
 *    (payload.delivery → IM chat bound to the anchor session → in-app message), one per run.
 *
 * @module @enkeep/platform-server/notifications
 */

import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { DatabaseSync } from 'node:sqlite';
import {
  type TaskNotificationSubscription,
  type TaskNotificationDelivery,
  type TaskNotificationChannel,
  type TaskNotificationEventType,
  type CreateTaskNotificationSubscriptionInput,
  type UpdateTaskNotificationSubscriptionInput,
  type CredentialCipherPort,
} from '@enkeep/platform-core';
import {
  SqliteTaskNotificationRepository,
  type CreateDeliveryInput,
} from '@enkeep/platform-storage-sqlite';
import {
  validateWebhookUrl,
  WebhookSecurityError,
  type WebhookSecurityOptions,
} from './webhook-security-policy.js';
import {
  AesGcmCredentialCipher,
  computeSecretFingerprint,
  computeSecretHash,
  CredentialDecryptionError,
} from './credential-cipher.js';
import {
  TASK_ROUTE_EVENTS,
  DEFAULT_MISSED_RUN_THRESHOLD_MS,
  DEFAULT_FAILURE_LOOKBACK_MS,
  buildMissedRunMessage,
  buildRunFailureMessage,
  computeScanFloor,
  findMissedRuns,
  findUnnotifiedFailedRuns,
  loadRun,
  loadTaskContext,
  missedRouteKey,
  resolveTaskRouteTarget,
  runRouteKey,
  type TaskRouteTarget,
} from './task-failure-notifier.js';

/**
 * Sends a proactive IM message for the task_route channel (lark / wechat).
 * Must be idempotent per outboxId.
 */
export type TaskRouteSender = (params: {
  userId: string;
  channel: 'lark' | 'wechat';
  accountId: string;
  chatId: string;
  text: string;
  title?: string;
  sessionId?: string;
  outboxId: string;
}) => Promise<{ success: boolean; messageId?: string; error?: string } | void>;

export interface TaskRouteReconcileResult {
  failedRuns: number;
  missedRuns: number;
  retried: number;
}

const FAILED_RUN_STATUSES = new Set(['failed', 'timeout', 'lease_lost']);

export interface TaskNotificationServiceOptions {
  db: DatabaseSync;
  securityOptions?: WebhookSecurityOptions;
  maxDeliveryAttempts?: number;
  deliveryTimeoutMs?: number;
  cipher?: CredentialCipherPort;
  cipherKey?: string | Buffer;
  /** IM sender of the task_route channel; can also be set later with setTaskRouteSender(). */
  taskRouteSender?: TaskRouteSender;
  /** A pending task whose due time is older than this without any run is reported (default 30 min). */
  missedRunThresholdMs?: number;
  /** Failed runs older than this are never reported by the reconciler (default 24h). */
  failureLookbackMs?: number;
}

const BACKOFF_INTERVALS_MS = [
  5 * 1000,        // 1st retry: 5s
  30 * 1000,       // 2nd retry: 30s
  2 * 60 * 1000,   // 3rd retry: 2m
  10 * 60 * 1000,  // 4th retry: 10m
];

/**
 * Computes HMAC-SHA256 signature for payload string using given secret.
 */
export function computeWebhookSignature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

export type WebhookTestErrorCode =
  | 'WEBHOOK_HTTP_ERROR'
  | 'WEBHOOK_NETWORK_ERROR'
  | 'WEBHOOK_TIMEOUT'
  | 'WEBHOOK_POLICY_REJECTED';

export interface WebhookTestResult {
  readonly success: boolean;
  readonly statusCode?: number;
  readonly responseTimeMs?: number;
  readonly errorCode?: WebhookTestErrorCode;
}

export class TaskNotificationService {
  private readonly db: DatabaseSync;
  private readonly repo: SqliteTaskNotificationRepository;
  private readonly securityOptions: WebhookSecurityOptions;
  private readonly maxDeliveryAttempts: number;
  private readonly deliveryTimeoutMs: number;
  private readonly cipher: CredentialCipherPort | null;
  private workerTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private taskRouteSender: TaskRouteSender | null;
  private readonly missedRunThresholdMs: number;
  private readonly failureLookbackMs: number;
  private readonly inFlightDeliveries = new Set<string>();

  constructor(options: TaskNotificationServiceOptions) {
    this.db = options.db;
    this.repo = new SqliteTaskNotificationRepository(options.db);
    this.securityOptions = options.securityOptions ?? {};
    this.maxDeliveryAttempts = options.maxDeliveryAttempts ?? 5;
    this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? 5000;
    this.taskRouteSender = options.taskRouteSender ?? null;
    this.missedRunThresholdMs = options.missedRunThresholdMs ?? DEFAULT_MISSED_RUN_THRESHOLD_MS;
    this.failureLookbackMs = options.failureLookbackMs ?? DEFAULT_FAILURE_LOOKBACK_MS;

    if (options.cipher) {
      this.cipher = options.cipher;
    } else if (options.cipherKey) {
      this.cipher = new AesGcmCredentialCipher(options.cipherKey);
    } else {
      this.cipher = null;
    }
  }

  // --- Subscription Management ---

  setTaskRouteSender(sender: TaskRouteSender | null): void {
    this.taskRouteSender = sender;
  }

  async createSubscription(input: CreateTaskNotificationSubscriptionInput): Promise<TaskNotificationSubscription> {
    if (input.channel === 'task_route') {
      throw new Error('task_route subscription is implicit per task; use the failure notification settings instead');
    }
    if (input.channel === 'webhook') {
      if (!input.destination) {
        throw new Error('Webhook subscription requires destination URL');
      }
      // Validate destination against SSRF policy
      await validateWebhookUrl(input.destination, this.securityOptions);
    }

    let secretCiphertext: string | null = null;
    let secretHash: string | null = null;

    if (input.secret) {
      if (!this.cipher) {
        throw new Error('Credential encryption is not configured on this server: cannot store webhook secret');
      }
      secretCiphertext = await this.cipher.encrypt(input.secret);
      secretHash = computeSecretHash(input.secret);
    }

    return this.repo.createSubscription({
      taskId: input.taskId,
      userId: input.userId,
      channel: input.channel,
      destination: input.destination ?? null,
      secretHash,
      secretCiphertext,
      events: input.events,
      enabled: input.enabled,
    });
  }

  async getSubscription(id: string, userId: string): Promise<TaskNotificationSubscription | null> {
    return this.repo.getSubscription(id, userId);
  }

  async listSubscriptions(taskId: string, userId: string): Promise<TaskNotificationSubscription[]> {
    return this.repo.listSubscriptions(taskId, userId);
  }

  async updateSubscription(input: UpdateTaskNotificationSubscriptionInput): Promise<TaskNotificationSubscription | null> {
    if (input.destination) {
      await validateWebhookUrl(input.destination, this.securityOptions);
    }

    let secretCiphertext: string | null | undefined;
    let secretHash: string | null | undefined;

    if (input.secret !== undefined) {
      if (input.secret === null || input.secret.trim().length === 0) {
        secretCiphertext = null;
        secretHash = null;
      } else {
        if (!this.cipher) {
          throw new Error('Credential encryption is not configured on this server: cannot store webhook secret');
        }
        secretCiphertext = await this.cipher.encrypt(input.secret);
        secretHash = computeSecretHash(input.secret);
      }
    }

    return this.repo.updateSubscription({
      id: input.id,
      userId: input.userId,
      destination: input.destination,
      secretHash,
      secretCiphertext,
      events: input.events,
      enabled: input.enabled,
    });
  }

  async deleteSubscription(id: string, userId: string): Promise<boolean> {
    const existing = await this.repo.getSubscription(id, userId);
    if (existing?.channel === 'task_route') {
      throw new Error('task_route subscription cannot be deleted; disable it instead');
    }
    return this.repo.deleteSubscription(id, userId);
  }

  // --- task_route: failure notifications on the task's own route ---

  /**
   * Returns the failure-notification setting of a task (materializing the implicit
   * task_route subscription), or null when the task does not belong to the user.
   */
  async getFailureNotificationSetting(taskId: string, userId: string): Promise<TaskNotificationSubscription | null> {
    return this.repo.ensureTaskRouteSubscription(taskId, userId, { events: TASK_ROUTE_EVENTS, enabled: true });
  }

  /**
   * Enables or disables failure notifications of one task.
   */
  async setFailureNotificationEnabled(
    taskId: string,
    userId: string,
    enabled: boolean
  ): Promise<TaskNotificationSubscription | null> {
    const sub = await this.getFailureNotificationSetting(taskId, userId);
    if (!sub) return null;
    if (sub.enabled === enabled) return sub;
    return this.repo.updateSubscription({ id: sub.id, userId, enabled });
  }

  /**
   * Describes where failure notifications of a task would go right now.
   */
  resolveFailureRoute(taskId: string, userId: string): TaskRouteTarget | null {
    const task = loadTaskContext(this.db, taskId, userId);
    return task ? resolveTaskRouteTarget(this.db, task) : null;
  }

  /**
   * Creates (at most once per run) and dispatches the task_route notice of a failed run.
   * Returns null when the run is not a failure, the task is gone, or the notice is disabled.
   */
  async notifyRunFailure(userId: string, runId: string, options: { dispatch?: 'async' | 'await' } = {}): Promise<TaskNotificationDelivery | null> {
    const run = loadRun(this.db, runId, userId);
    if (!run || !FAILED_RUN_STATUSES.has(run.status)) return null;
    if (await this.repo.hasDeliveryWithKey(runRouteKey(run.id))) return null;

    const task = loadTaskContext(this.db, run.taskId, userId);
    if (!task) return null;
    const sub = await this.getFailureNotificationSetting(task.id, userId);
    if (!sub || !sub.enabled) return null;

    const message = buildRunFailureMessage(task, run);
    if (!sub.events.includes(message.event)) return null;

    return this.createTaskRouteDelivery({
      subscriptionId: sub.id,
      taskId: task.id,
      runId: run.id,
      userId,
      event: message.event,
      idempotencyKey: runRouteKey(run.id),
      kind: 'run_failure',
      target: resolveTaskRouteTarget(this.db, task),
      message,
      dispatch: options.dispatch ?? 'async',
    });
  }

  /**
   * Creates (at most once per task and due time) and dispatches a missed-run notice.
   */
  async notifyMissedRun(
    userId: string,
    taskId: string,
    dueAt: string,
    now = new Date(),
    options: { dispatch?: 'async' | 'await' } = {}
  ): Promise<TaskNotificationDelivery | null> {
    const key = missedRouteKey(taskId, dueAt);
    if (await this.repo.hasDeliveryWithKey(key)) return null;
    const task = loadTaskContext(this.db, taskId, userId);
    if (!task) return null;
    const sub = await this.getFailureNotificationSetting(task.id, userId);
    if (!sub || !sub.enabled) return null;
    const message = buildMissedRunMessage(task, dueAt, now);
    if (!sub.events.includes(message.event)) return null;

    return this.createTaskRouteDelivery({
      subscriptionId: sub.id,
      taskId: task.id,
      runId: null,
      userId,
      event: message.event,
      idempotencyKey: key,
      kind: 'missed_run',
      target: resolveTaskRouteTarget(this.db, task),
      message,
      dispatch: options.dispatch ?? 'async',
      extra: { dueAt },
    });
  }

  /**
   * Scheduler maintenance pass: reports failed runs that have no notice yet (lease expiry,
   * timeouts, restarts and anything the fast path missed) and runs that never started.
   */
  async reconcileTaskRoute(now = new Date(), options: { dispatch?: 'async' | 'await' } = {}): Promise<TaskRouteReconcileResult> {
    const floor = computeScanFloor(this.db, now, this.failureLookbackMs);
    const dispatch = options.dispatch ?? 'await';
    let failedRuns = 0;
    let missedRuns = 0;

    for (const run of findUnnotifiedFailedRuns(this.db, floor)) {
      try {
        if (await this.notifyRunFailure(run.userId, run.id, { dispatch })) failedRuns++;
      } catch {
        // One broken task must not block the others
      }
    }

    for (const missed of findMissedRuns(this.db, now, this.missedRunThresholdMs, floor)) {
      try {
        if (await this.notifyMissedRun(missed.userId, missed.taskId, missed.dueAt, now, { dispatch })) missedRuns++;
      } catch {
        // Continue with the next task
      }
    }

    const retried = await this.processPendingDeliveries('task_route');
    return { failedRuns, missedRuns, retried };
  }

  private async createTaskRouteDelivery(input: {
    subscriptionId: string;
    taskId: string;
    runId: string | null;
    userId: string;
    event: TaskNotificationEventType;
    idempotencyKey: string;
    kind: 'run_failure' | 'missed_run';
    target: TaskRouteTarget;
    message: { title: string; text: string };
    dispatch: 'async' | 'await';
    extra?: Record<string, unknown>;
  }): Promise<TaskNotificationDelivery | null> {
    const { created, delivery } = await this.repo.createDeliveryIfAbsent({
      subscriptionId: input.subscriptionId,
      taskId: input.taskId,
      runId: input.runId,
      userId: input.userId,
      channel: 'task_route',
      event: input.event,
      status: 'pending',
      maxAttempts: this.maxDeliveryAttempts,
      idempotencyKey: input.idempotencyKey,
      payload: {
        kind: input.kind,
        event: `task.${input.event}`,
        taskId: input.taskId,
        runId: input.runId,
        target: input.target,
        title: input.message.title,
        text: input.message.text,
        ...(input.extra ?? {}),
      },
    });
    if (!created || !delivery) return null;

    if (input.dispatch === 'await') {
      await this.runDeliveryExclusive(delivery);
      return (await this.repo.getDelivery(delivery.id, input.userId)) ?? delivery;
    }
    setImmediate(() => {
      void this.runDeliveryExclusive(delivery).catch(() => {});
    });
    return delivery;
  }

  /** Runs one delivery attempt unless the same delivery is already in flight in this process. */
  private async runDeliveryExclusive(delivery: TaskNotificationDelivery): Promise<void> {
    if (this.inFlightDeliveries.has(delivery.id)) return;
    this.inFlightDeliveries.add(delivery.id);
    try {
      await this.executeDeliveryAttempt(delivery);
    } finally {
      this.inFlightDeliveries.delete(delivery.id);
    }
  }

  private async executeTaskRouteAttempt(
    delivery: TaskNotificationDelivery
  ): Promise<{ success: boolean; statusCode?: number; error?: string; responseTimeMs?: number }> {
    const payload = delivery.payload as Record<string, unknown>;
    const target = payload.target as TaskRouteTarget | undefined;
    const text = typeof payload.text === 'string' ? payload.text : '';
    const title = typeof payload.title === 'string' ? payload.title : undefined;
    const startTime = Date.now();

    if (!target || !text) {
      await this.repo.updateDeliveryStatus(delivery.id, {
        status: 'dead_letter',
        attempts: delivery.attempts + 1,
        lastError: 'INVALID_TASK_ROUTE_PAYLOAD',
      });
      return { success: false, error: 'INVALID_TASK_ROUTE_PAYLOAD' };
    }

    if (target.kind === 'in_app') {
      const written = this.writeInAppNotice(delivery, target.sessionId, text);
      await this.repo.updateDeliveryStatus(delivery.id, written
        ? { status: 'delivered', attempts: delivery.attempts + 1, responseStatus: 200, responseTimeMs: Date.now() - startTime, lastError: null }
        : { status: 'dead_letter', attempts: delivery.attempts + 1, lastError: 'NO_ROUTE_AVAILABLE', nextRetryAt: null });
      return written ? { success: true, statusCode: 200 } : { success: false, error: 'NO_ROUTE_AVAILABLE' };
    }

    let errStr: string | null = null;
    if (!this.taskRouteSender) {
      errStr = 'IM_SENDER_UNAVAILABLE';
    } else {
      try {
        const chatId = target.nativeContextId.includes(':')
          ? target.nativeContextId.split(':')[0]
          : target.nativeContextId;
        const result = await this.taskRouteSender({
          userId: delivery.userId,
          channel: target.channel,
          accountId: target.accountId,
          chatId,
          text,
          title,
          sessionId: target.sessionId ?? undefined,
          outboxId: `out_tfn_${delivery.id.replace(/[^a-zA-Z0-9_]/g, '')}`,
        });
        if (result && result.success === false) {
          errStr = result.error ? `IM_SEND_FAILED: ${result.error}` : 'IM_SEND_FAILED';
        }
      } catch (err: unknown) {
        errStr = `IM_SEND_FAILED: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const responseTimeMs = Date.now() - startTime;
    if (!errStr) {
      await this.repo.updateDeliveryStatus(delivery.id, {
        status: 'delivered',
        attempts: delivery.attempts + 1,
        responseStatus: 200,
        responseTimeMs,
        lastError: null,
      });
      return { success: true, statusCode: 200, responseTimeMs };
    }

    const truncated = errStr.length > 500 ? errStr.slice(0, 500) : errStr;
    await this.handleDeliveryFailure(delivery, truncated, undefined, responseTimeMs);
    if (delivery.attempts + 1 >= delivery.maxAttempts) {
      // IM route exhausted: leave the notice in the anchor session so it is not lost silently
      this.writeInAppNotice(delivery, target.sessionId, `${text}\n\n（飞书/微信推送多次失败，改为在此会话提醒：${truncated}）`);
    }
    return { success: false, error: truncated, responseTimeMs };
  }

  /** Writes the notice as an assistant message of the anchor web session (idempotent per delivery). */
  private writeInAppNotice(delivery: TaskNotificationDelivery, sessionId: string | null, text: string): boolean {
    if (!sessionId) return false;
    try {
      const route = this.db.prepare(
        'SELECT space_id FROM session_routes WHERE id = ? AND user_id = ? LIMIT 1'
      ).get(sessionId, delivery.userId) as { space_id?: string } | undefined;
      if (!route) return false;

      const messageId = `msg_tfn_${delivery.id.replace(/[^a-zA-Z0-9_]/g, '')}`;
      const exists = this.db.prepare('SELECT 1 AS present FROM web_messages WHERE id = ?').get(messageId);
      if (exists) return true;

      const nowIso = new Date().toISOString();
      const content = text.length > 4000 ? text.slice(0, 4000) : text;
      const routeKey = `${delivery.userId}:web:${route.space_id ?? ''}:${sessionId}`;
      this.db.prepare(`
        INSERT INTO web_messages (
          id, session_id, user_id, role, content, status, route_key, turn_id, created_at
        ) VALUES (?, ?, ?, 'assistant', ?, 'delivered', ?, NULL, ?)
      `).run(messageId, sessionId, delivery.userId, content, routeKey, nowIso);
      this.db.prepare(`
        INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
        VALUES (?, ?, ?, 'message', ?, ?)
      `).run(
        `evt_${randomUUID().replace(/-/g, '')}`,
        sessionId,
        delivery.userId,
        JSON.stringify({
          message: {
            id: messageId,
            sessionId,
            userId: delivery.userId,
            role: 'assistant',
            content,
            status: 'delivered',
            createdAt: nowIso,
          },
        }),
        nowIso
      );
      return true;
    } catch {
      return false;
    }
  }

  // --- Event Handling & Webhook Dispatch ---

  /**
   * Dispatches task lifecycle event to all subscribed channels for the given task.
   */
  async notifyTaskEvent(options: {
    taskId: string;
    userId: string;
    event: TaskNotificationEventType;
    task: {
      id: string;
      name?: string;
      status: string;
      scheduleType?: string;
      scheduledFor?: string | null;
      startedAt?: string | null;
      completedAt?: string | null;
    };
    run?: {
      id: string;
      attemptNumber?: number;
      status: string;
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      errorCode?: string | null;
      error?: string | null;
    } | null;
  }): Promise<TaskNotificationDelivery[]> {
    const deliveries: TaskNotificationDelivery[] = [];
    const subscriptions = (await this.repo.findSubscriptionsForEvent(options.taskId, options.event))
      .filter((sub) => sub.channel !== 'task_route');

    const eventId = `evt_${randomUUID().replace(/-/g, '')}`;
    const timestamp = new Date().toISOString();

    for (const sub of subscriptions) {
      // Build safe payload: zero model prompt / text content
      const safePayload: Record<string, unknown> = {
        id: eventId,
        event: `task.${options.event}`,
        timestamp,
        subscriptionId: sub.id,
        channel: sub.channel,
        task: {
          id: options.task.id,
          name: options.task.name || undefined,
          status: options.task.status,
          scheduleType: options.task.scheduleType || 'once',
          scheduledFor: options.task.scheduledFor || null,
          startedAt: options.task.startedAt || null,
          completedAt: options.task.completedAt || null,
        },
        run: options.run
          ? {
              id: options.run.id,
              attemptNumber: options.run.attemptNumber ?? 1,
              status: options.run.status,
              tokenUsage: {
                promptTokens: options.run.promptTokens ?? 0,
                completionTokens: options.run.completionTokens ?? 0,
                totalTokens: options.run.totalTokens ?? 0,
              },
              errorCode: options.run.errorCode ?? null,
              error: options.run.error ?? null,
            }
          : null,
      };

      const idempotencyKey = `del_${sub.id}_${options.task.id}_${options.run?.id || 'norun'}_${options.event}_${Date.now()}`;

      const delivery = await this.repo.createDelivery({
        subscriptionId: sub.id,
        taskId: options.taskId,
        runId: options.run?.id ?? null,
        userId: options.userId,
        channel: sub.channel,
        event: options.event,
        status: 'pending',
        maxAttempts: this.maxDeliveryAttempts,
        payload: safePayload,
        idempotencyKey,
      });

      deliveries.push(delivery);

      // Attempt immediate dispatch for webhook
      if (sub.channel === 'webhook' && sub.destination) {
        this.dispatchDeliveryAsync(delivery, sub);
      } else if (sub.channel === 'in_app') {
        // in_app delivery is immediately marked delivered
        await this.repo.updateDeliveryStatus(delivery.id, {
          status: 'delivered',
          responseStatus: 200,
          responseTimeMs: 0,
        });
      }
    }

    // task_route: failure notices are on by default (implicit subscription), one per run.
    // Appended after explicit subscriptions so existing callers keep their ordering.
    if ((options.event === 'failed' || options.event === 'timeout') && options.run?.id) {
      try {
        const routeDelivery = await this.notifyRunFailure(options.userId, options.run.id);
        if (routeDelivery) deliveries.push(routeDelivery);
      } catch {
        // The scheduler maintenance pass retries unnotified failures
      }
    }

    return deliveries;
  }

  /**
   * Executes a single delivery attempt for a webhook.
   */
  async executeDeliveryAttempt(
    delivery: TaskNotificationDelivery,
    subscription?: TaskNotificationSubscription | null
  ): Promise<{ success: boolean; statusCode?: number; error?: string; responseTimeMs?: number }> {
    if (delivery.channel === 'task_route') {
      return this.executeTaskRouteAttempt(delivery);
    }
    const sub = subscription || (await this.repo.getSubscription(delivery.subscriptionId, delivery.userId));
    if (!sub || !sub.destination) {
      const errStr = 'Subscription or destination URL not found';
      await this.repo.updateDeliveryStatus(delivery.id, {
        status: 'dead_letter',
        lastError: errStr,
      });
      return { success: false, error: errStr };
    }

    const payloadStr = JSON.stringify({
      ...delivery.payload,
      deliveryId: delivery.id,
    });

    const startTime = Date.now();
    try {
      // 1. Validate destination against SSRF
      const { url } = await validateWebhookUrl(sub.destination, this.securityOptions);

      // 2. Compute signature if secret is configured (decrypt just-in-time)
      const headers: Record<string, string> = {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'Enkeep-Webhook-Dispatcher/1.0',
        'X-Enkeep-Event': `task.${delivery.event}`,
        'X-Enkeep-Delivery': delivery.id,
        'X-Enkeep-Timestamp': new Date().toISOString(),
      };

      if (sub.secretConfigured) {
        const ciphertext = await this.repo.getSubscriptionCiphertext(sub.id);
        if (ciphertext && this.cipher) {
          try {
            const decryptedSecret = await this.cipher.decrypt(ciphertext);
            const sig = computeWebhookSignature(payloadStr, decryptedSecret);
            headers['X-Enkeep-Signature'] = `sha256=${sig}`;
            headers['X-Hub-Signature-256'] = `sha256=${sig}`;
          } catch (decErr) {
            const errStr = 'Failed to decrypt webhook signing secret: cipher key mismatch or corruption';
            await this.handleDeliveryFailure(delivery, errStr, undefined, Date.now() - startTime);
            return { success: false, error: errStr, responseTimeMs: Date.now() - startTime };
          }
        }
      }

      // 3. Send HTTP request with redirect tracking and timeout
      const result = await this.sendHttpRequestWithRedirects(url, payloadStr, headers, 3);
      const responseTimeMs = Date.now() - startTime;

      if (result.statusCode >= 200 && result.statusCode < 300) {
        await this.repo.updateDeliveryStatus(delivery.id, {
          status: 'delivered',
          attempts: delivery.attempts + 1,
          responseStatus: result.statusCode,
          responseTimeMs,
          lastError: null,
        });
        return { success: true, statusCode: result.statusCode, responseTimeMs };
      } else {
        const errStr = `HTTP_${result.statusCode}`;
        await this.handleDeliveryFailure(delivery, errStr, result.statusCode, responseTimeMs);
        return { success: false, statusCode: result.statusCode, error: errStr, responseTimeMs };
      }
    } catch (err: unknown) {
      const responseTimeMs = Date.now() - startTime;
      let errStr = 'DELIVERY_FAILED';
      if (err instanceof Error) {
        if (err.message.includes('SSRF') || err.message.includes('blocked') || err.message.includes('private')) {
          errStr = 'SSRF_BLOCKED';
        } else if (err.message.includes('timeout') || err.message.includes('TIMEDOUT')) {
          errStr = 'TIMEOUT';
        } else if (err.message.includes('redirect')) {
          errStr = 'TOO_MANY_REDIRECTS';
        } else if (err.message.includes('ECONNREFUSED') || err.message.includes('ENOTFOUND')) {
          errStr = 'NETWORK_ERROR';
        }
      }
      await this.handleDeliveryFailure(delivery, errStr, undefined, responseTimeMs);
      return { success: false, error: errStr, responseTimeMs };
    }
  }

  private async handleDeliveryFailure(
    delivery: TaskNotificationDelivery,
    errorMessage: string,
    statusCode?: number,
    responseTimeMs?: number
  ): Promise<void> {
    const nextAttempt = delivery.attempts + 1;
    if (nextAttempt >= delivery.maxAttempts) {
      await this.repo.updateDeliveryStatus(delivery.id, {
        status: 'dead_letter',
        attempts: nextAttempt,
        lastError: errorMessage,
        responseStatus: statusCode ?? null,
        responseTimeMs: responseTimeMs ?? null,
        nextRetryAt: null,
      });
    } else {
      const backoffMs = BACKOFF_INTERVALS_MS[nextAttempt - 1] ?? 10 * 60 * 1000;
      const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
      await this.repo.updateDeliveryStatus(delivery.id, {
        status: 'failed',
        attempts: nextAttempt,
        lastError: errorMessage,
        responseStatus: statusCode ?? null,
        responseTimeMs: responseTimeMs ?? null,
        nextRetryAt,
      });
    }
  }

  private dispatchDeliveryAsync(delivery: TaskNotificationDelivery, subscription: TaskNotificationSubscription): void {
    setImmediate(async () => {
      try {
        await this.executeDeliveryAttempt(delivery, subscription);
      } catch (_dispatchErr: unknown) {
        // executeDeliveryAttempt handles failure persistence internally; catch is for unhandled async rejections
      }
    });
  }

  private sendHttpRequestWithRedirects(
    targetUrl: URL,
    body: string,
    headers: Record<string, string>,
    maxRedirects = 3
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      if (maxRedirects < 0) {
        return reject(new Error('Too many redirects'));
      }

      const isHttps = targetUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const req = transport.request(
        targetUrl,
        {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Length': Buffer.byteLength(body, 'utf8'),
          },
          timeout: this.deliveryTimeoutMs,
        },
        (res) => {
          const statusCode = res.statusCode || 0;

          // Handle 3xx redirects
          if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
            const redirectUrl = new URL(res.headers.location, targetUrl);
            // Validate redirect URL against SSRF policy
            validateWebhookUrl(redirectUrl.toString(), this.securityOptions)
              .then(() => {
                this.sendHttpRequestWithRedirects(redirectUrl, body, headers, maxRedirects - 1)
                  .then(resolve)
                  .catch(reject);
              })
              .catch(reject);
            res.resume(); // Consume data to free memory
            return;
          }

          let responseBody = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            if (responseBody.length < 10000) {
              responseBody += chunk;
            }
          });
          res.on('end', () => {
            resolve({ statusCode, body: responseBody });
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error(`Webhook request timed out after ${this.deliveryTimeoutMs}ms`));
      });

      req.write(body, 'utf8');
      req.end();
    });
  }

  // --- Test Webhook API ---

  /**
   * Tests a webhook endpoint with a ping event.
   */
  async testWebhook(options: {
    userId: string;
    url: string;
    secret?: string | null;
  }): Promise<WebhookTestResult> {
    let url: URL;
    try {
      const validated = await validateWebhookUrl(options.url, this.securityOptions);
      url = validated.url;
    } catch (_valErr: unknown) {
      return {
        success: false,
        errorCode: 'WEBHOOK_POLICY_REJECTED',
      };
    }

    const testPayload = JSON.stringify({
      id: `evt_test_${randomUUID().replace(/-/g, '')}`,
      event: 'task.test_ping',
      timestamp: new Date().toISOString(),
      message: 'Enkeep Webhook Test Ping',
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      'User-Agent': 'Enkeep-Webhook-Dispatcher/1.0',
      'X-Enkeep-Event': 'task.test_ping',
      'X-Enkeep-Timestamp': new Date().toISOString(),
    };

    if (options.secret) {
      const sig = computeWebhookSignature(testPayload, options.secret);
      headers['X-Enkeep-Signature'] = `sha256=${sig}`;
      headers['X-Hub-Signature-256'] = `sha256=${sig}`;
    }

    const startTime = Date.now();
    try {
      const res = await this.sendHttpRequestWithRedirects(url, testPayload, headers, 3);
      const responseTimeMs = Date.now() - startTime;
      const success = res.statusCode >= 200 && res.statusCode < 300;
      if (success) {
        return {
          success: true,
          statusCode: res.statusCode,
          responseTimeMs,
        };
      }
      return {
        success: false,
        statusCode: res.statusCode,
        responseTimeMs,
        errorCode: 'WEBHOOK_HTTP_ERROR',
      };
    } catch (err: unknown) {
      const responseTimeMs = Date.now() - startTime;
      let errorCode: WebhookTestErrorCode = 'WEBHOOK_NETWORK_ERROR';
      if (err instanceof Error) {
        if (err.message.includes('timeout') || err.message.includes('timed out') || err.message.includes('TIMEDOUT')) {
          errorCode = 'WEBHOOK_TIMEOUT';
        } else if (
          err.message.includes('SSRF') ||
          err.message.includes('blocked') ||
          err.message.includes('private') ||
          err.message.includes('redirect')
        ) {
          errorCode = 'WEBHOOK_POLICY_REJECTED';
        }
      }
      return {
        success: false,
        responseTimeMs,
        errorCode,
      };
    }
  }

  // --- Delivery History & Manual Retry ---

  async listDeliveries(taskId: string, userId: string, limit = 50, offset = 0) {
    return this.repo.listDeliveries(taskId, userId, limit, offset);
  }

  async retryDelivery(deliveryId: string, userId: string): Promise<TaskNotificationDelivery | null> {
    const delivery = await this.repo.getDelivery(deliveryId, userId);
    if (!delivery) return null;

    // Reset status to pending and re-attempt
    await this.repo.updateDeliveryStatus(delivery.id, {
      status: 'pending',
      nextRetryAt: null,
    });

    const updated = await this.repo.getDelivery(deliveryId, userId);
    if (updated) {
      if (updated.channel === 'task_route') {
        setImmediate(() => {
          void this.runDeliveryExclusive(updated).catch(() => {});
        });
      } else {
        this.dispatchDeliveryAsync(updated, (await this.repo.getSubscription(updated.subscriptionId, userId))!);
      }
    }
    return updated;
  }

  // --- Background Retry Worker ---

  startRetryWorker(intervalMs = 10 * 1000): void {
    if (this.workerTimer) return;
    this.workerTimer = setInterval(async () => {
      if (this.isProcessing) return;
      this.isProcessing = true;
      try {
        await this.processPendingDeliveries();
      } catch (_workerErr: unknown) {
        // Handled: background retry worker loop error
      } finally {
        this.isProcessing = false;
      }
    }, intervalMs);
  }

  stopRetryWorker(): void {
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
    }
  }

  async processPendingDeliveries(channel?: TaskNotificationChannel): Promise<number> {
    const pending = (await this.repo.findPendingDeliveries(new Date().toISOString(), 20))
      .filter((item) => !channel || item.channel === channel);
    let processed = 0;

    for (const item of pending) {
      if (this.inFlightDeliveries.has(item.id)) continue;
      try {
        await this.runDeliveryExclusive(item);
        processed++;
      } catch (_itemErr: unknown) {
        // executeDeliveryAttempt handles delivery failure persistence
      }
    }

    return processed;
  }
}
