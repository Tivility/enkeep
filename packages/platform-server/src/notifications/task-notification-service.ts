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

export interface TaskNotificationServiceOptions {
  db: DatabaseSync;
  securityOptions?: WebhookSecurityOptions;
  maxDeliveryAttempts?: number;
  deliveryTimeoutMs?: number;
  cipher?: CredentialCipherPort;
  cipherKey?: string | Buffer;
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

  constructor(options: TaskNotificationServiceOptions) {
    this.db = options.db;
    this.repo = new SqliteTaskNotificationRepository(options.db);
    this.securityOptions = options.securityOptions ?? {};
    this.maxDeliveryAttempts = options.maxDeliveryAttempts ?? 5;
    this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? 5000;

    if (options.cipher) {
      this.cipher = options.cipher;
    } else if (options.cipherKey) {
      this.cipher = new AesGcmCredentialCipher(options.cipherKey);
    } else {
      this.cipher = null;
    }
  }

  // --- Subscription Management ---

  async createSubscription(input: CreateTaskNotificationSubscriptionInput): Promise<TaskNotificationSubscription> {
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
    return this.repo.deleteSubscription(id, userId);
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
    const subscriptions = await this.repo.findSubscriptionsForEvent(options.taskId, options.event);
    if (subscriptions.length === 0) {
      return [];
    }

    const deliveries: TaskNotificationDelivery[] = [];
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

    return deliveries;
  }

  /**
   * Executes a single delivery attempt for a webhook.
   */
  async executeDeliveryAttempt(
    delivery: TaskNotificationDelivery,
    subscription?: TaskNotificationSubscription | null
  ): Promise<{ success: boolean; statusCode?: number; error?: string; responseTimeMs?: number }> {
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
      this.dispatchDeliveryAsync(updated, (await this.repo.getSubscription(updated.subscriptionId, userId))!);
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

  async processPendingDeliveries(): Promise<number> {
    const pending = await this.repo.findPendingDeliveries(new Date().toISOString(), 20);
    let processed = 0;

    for (const item of pending) {
      try {
        await this.executeDeliveryAttempt(item);
        processed++;
      } catch (_itemErr: unknown) {
        // executeDeliveryAttempt handles delivery failure persistence
      }
    }

    return processed;
  }
}
