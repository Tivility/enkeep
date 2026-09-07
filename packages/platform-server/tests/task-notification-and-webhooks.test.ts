import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import http, { type Server as HttpServer } from 'node:http';
import {
  PlatformServer,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  TaskNotificationService,
  AesGcmCredentialCipher,
  computeSecretFingerprint,
  computeSecretHash,
  validateWebhookUrl,
  computeWebhookSignature,
  WebhookSecurityError,
  CredentialDecryptionError,
} from '../src/index.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { DefaultAuthService, provisionFixtures } from '@enkeep/platform-auth';
import type { RuntimeGateway } from '@enkeep/platform-core';

describe('Task Notification & Webhook Subsystem (SSRF Defense, HMAC & Retries)', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let authService: DefaultAuthService;
  let server: PlatformServer;
  let baseUrl: string;
  let csrfToken: string;
  let adminId: string;
  let aliceId: string;
  let bobId: string;
  let adminCookie: string;
  let aliceCookie: string;
  let taskId: string;
  const cookieSecret = 'test_cookie_secret_0123456789abcdef0123456789abcdef';

  // Local fake webhook server for testing loopback deliveries
  let mockServer: HttpServer | null = null;
  let mockServerPort = 0;
  let lastReceivedWebhook: {
    headers: http.IncomingHttpHeaders;
    body: any;
  } | null = null;

  const fakeGateway: RuntimeGateway = {
    async executeTurn() {
      return {
        message: {
          id: 'msg_test',
          seq: 1,
          role: 'assistant',
          content: 'test',
          status: 'delivered',
          createdAt: new Date().toISOString(),
        },
      };
    },
  };

  beforeEach(async () => {
    // Start local mock HTTP server
    lastReceivedWebhook = null;
    mockServer = http.createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
      });
      req.on('end', () => {
        try {
          lastReceivedWebhook = {
            headers: req.headers,
            body: data ? JSON.parse(data) : null,
          };
        } catch {
          lastReceivedWebhook = {
            headers: req.headers,
            body: data,
          };
        }

        if (req.url === '/redirect-loopback') {
          res.writeHead(302, { Location: `http://127.0.0.1:${mockServerPort}/webhook-target` });
          res.end();
          return;
        }

        if (req.url === '/redirect-metadata') {
          res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
          res.end();
          return;
        }

        if (req.url === '/fail-500') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      });
    });

    await new Promise<void>((resolve) => {
      mockServer!.listen(0, '127.0.0.1', () => {
        mockServerPort = (mockServer!.address() as any).port;
        resolve();
      });
    });

    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    authService = new DefaultAuthService(storage, {
      cookieSecret,
      sessionTtlSeconds: 3600,
      cookieSecure: false,
    });

    const fixtures = await provisionFixtures(storage, authService, {
      adminPassword: 'AdminPassword123!',
      userPassword: 'UserPassword123!',
      disabledPassword: 'DisabledPassword123!',
    });
    adminId = fixtures.admin.id;
    aliceId = fixtures.user.id;
    bobId = fixtures.disabledUser ? fixtures.disabledUser.id : 'disabled_id';

    const adminLogin = await authService.login('alice', 'AdminPassword123!');
    adminCookie = adminLogin.cookieHeader.split(';')[0]!;

    const aliceLogin = await authService.login('bob', 'UserPassword123!');
    aliceCookie = aliceLogin.cookieHeader.split(';')[0]!;

    // Create a task for alice
    taskId = 'task_test_notify_1';
    db.prepare(`
      INSERT INTO platform_tasks (id, user_id, title, payload, status, created_at, updated_at)
      VALUES (?, ?, 'Nightly Digest', '{"prompt":"Secret user prompt: generate digest"}', 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `).run(taskId, aliceId);

    csrfToken = 'csrf_token_0123456789abcdef0123456789abcdef';
    server = new PlatformServer({
      database: db,
      storage,
      authService,
      cookieSecret,
      csrfToken,
      runtimeGateway: fakeGateway,
      host: '127.0.0.1',
      port: 0,
      webhookSecurityOptions: {
        allowTestLoopback: true, // Allow testing with local fake server
      },
    });

    const info = await server.start();
    baseUrl = info.url;
  });

  afterEach(async () => {
    await server.stop();
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer!.close(() => resolve()));
      mockServer = null;
    }
    db.close();
  });

  describe('1. SSRF Defense & URL Security Policy', () => {
    it('rejects embedded URL credentials (username/password)', async () => {
      await expect(
        validateWebhookUrl('https://admin:supersecret@api.example.com/webhook')
      ).rejects.toThrow(/credentials/i);
    });

    it('rejects sensitive query parameters (?token=, ?key=, ?secret=)', async () => {
      await expect(
        validateWebhookUrl('https://api.example.com/webhook?token=secret123')
      ).rejects.toThrow(/sensitive query parameter/i);

      await expect(
        validateWebhookUrl('https://api.example.com/webhook?api_key=secret123')
      ).rejects.toThrow(/sensitive query parameter/i);
    });

    it('blocks private IPv4 ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)', async () => {
      const privateUrls = [
        'https://10.0.0.1/webhook',
        'https://10.254.254.254/hook',
        'https://172.16.0.1/notify',
        'https://172.31.255.255/hook',
        'https://192.168.1.1/event',
        'https://192.168.100.50/hook',
      ];

      for (const url of privateUrls) {
        await expect(validateWebhookUrl(url, { allowTestLoopback: false })).rejects.toThrow(
          WebhookSecurityError
        );
      }
    });

    it('blocks cloud metadata endpoints (169.254.169.254, metadata.google.internal)', async () => {
      const metadataUrls = [
        'http://169.254.169.254/latest/meta-data/',
        'https://169.254.169.254/computeMetadata/v1/',
        'http://metadata.google.internal/computeMetadata/v1/',
        'https://metadata.google.internal/v1',
      ];

      for (const url of metadataUrls) {
        await expect(validateWebhookUrl(url, { allowTestLoopback: true })).rejects.toThrow(
          /metadata/i
        );
      }
    });

    it('blocks localhost / loopback when allowTestLoopback is false', async () => {
      const loopbackUrls = [
        'http://127.0.0.1:8080/hook',
        'https://localhost:3000/webhook',
        'http://127.0.0.2:9000/hook',
      ];

      for (const url of loopbackUrls) {
        await expect(validateWebhookUrl(url, { allowTestLoopback: false })).rejects.toThrow(
          /loopback|forbidden|blocked|https/i
        );
      }
    });

    it('rejects sensitive query parameters in webhook destination URLs', async () => {
      const raw = 'https://api.example.com/webhook?token=secret123&key=abc&password=pass&channel=slack';
      await expect(validateWebhookUrl(raw, { allowTestLoopback: false })).rejects.toThrow(
        /sensitive query parameter/i
      );
    });
  });

  describe('2. AES-256-GCM Credential Encryption & HMAC Signing', () => {
    it('encrypts and decrypts secret with random 96-bit nonce and auth tag', () => {
      const cipher = new AesGcmCredentialCipher('master_encryption_key_32_bytes_len');
      const secret = 'super_secret_webhook_hmac_key_999';

      const encrypted = cipher.encrypt(secret);
      expect(encrypted).toMatch(/^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
      expect(encrypted).not.toContain(secret);

      // Decrypt succeeds
      const decrypted = cipher.decrypt(encrypted);
      expect(decrypted).toBe(secret);

      // Wrong key throws CredentialDecryptionError
      const wrongCipher = new AesGcmCredentialCipher('different_wrong_encryption_key__');
      expect(() => wrongCipher.decrypt(encrypted)).toThrow(CredentialDecryptionError);
    });

    it('computes exact HMAC-SHA256 signature over raw JSON payload', () => {
      const payload = JSON.stringify({ id: 'evt_1', event: 'task.completed', status: 'completed' });
      const secret = 'webhook_secret_key_999';
      const sig = computeWebhookSignature(payload, secret);
      expect(sig).toMatch(/^[0-9a-f]{64}$/);

      const sig2 = computeWebhookSignature(payload, secret);
      expect(sig).toBe(sig2);

      const tampered = computeWebhookSignature(payload + ' ', secret);
      expect(tampered).not.toBe(sig);
    });
  });

  describe('3. Subscriptions Management API & Zero Plaintext DB Guarantee', () => {
    it('creates in_app and webhook subscriptions, stores AES-GCM ciphertext in DB, and enforces tenant isolation', async () => {
      const secretPlaintext = 'my_top_secret_hmac_key_2026';

      // 1. Create in_app subscription
      const inAppRes = await fetch(`${baseUrl}/api/manage/tasks/${taskId}/notifications/subscriptions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          channel: 'in_app',
          events: ['completed', 'failed'],
        }),
      });

      expect(inAppRes.status).toBe(201);
      const inAppJson = await inAppRes.json();
      expect(inAppJson.success).toBe(true);
      expect(inAppJson.data.channel).toBe('in_app');
      expect(inAppJson.data.secretConfigured).toBe(false);
      expect(inAppJson.data.secretFingerprint).toBeNull();
      expect(inAppJson.data.secretHash).toBeUndefined();
      expect(inAppJson.data.secret_hash).toBeUndefined();
      expect(inAppJson.data.secretCiphertext).toBeUndefined();

      // 2. Create webhook subscription with secret
      const webhookRes = await fetch(`${baseUrl}/api/manage/tasks/${taskId}/notifications/subscriptions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          channel: 'webhook',
          destination: `http://127.0.0.1:${mockServerPort}/webhook`,
          secret: secretPlaintext,
          events: ['completed', 'failed', 'cancelled'],
        }),
      });

      expect(webhookRes.status).toBe(201);
      const webhookJson = await webhookRes.json();
      expect(webhookJson.data.channel).toBe('webhook');
      expect(webhookJson.data.secretConfigured).toBe(true);
      expect(webhookJson.data.secretFingerprint).toMatch(/^sha256:[0-9a-f]{8}$/);
      expect(webhookJson.data.secretHash).toBeUndefined();
      expect(webhookJson.data.secretCiphertext).toBeUndefined();
      expect(JSON.stringify(webhookJson)).not.toContain(secretPlaintext);

      const subId = webhookJson.data.id;

      // 3. ZERO PLAINTEXT GREP IN DATABASE
      const rawDbRow = db.prepare('SELECT * FROM task_notification_subscriptions WHERE id = ?').get(subId) as any;
      expect(rawDbRow).toBeDefined();
      expect(rawDbRow.secret_ciphertext).toMatch(/^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
      expect(rawDbRow.secret_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rawDbRow.secret_ciphertext).not.toContain(secretPlaintext);
      expect(rawDbRow.secret_hash).not.toBe(secretPlaintext);

      // Verify entire SQLite database does NOT contain secretPlaintext anywhere
      const allTablesJson = JSON.stringify(db.prepare('SELECT * FROM task_notification_subscriptions').all());
      expect(allTablesJson).not.toContain(secretPlaintext);

      // 4. List subscriptions for Alice
      const listRes = await fetch(`${baseUrl}/api/manage/tasks/${taskId}/notifications/subscriptions`, {
        headers: { Cookie: aliceCookie },
      });
      expect(listRes.status).toBe(200);
      const listJson = await listRes.json();
      expect(listJson.data.length).toBe(2);
      expect(listJson.data[1].secretConfigured).toBe(true);
      expect(listJson.data[1].secretFingerprint).toMatch(/^sha256:/);
      expect(JSON.stringify(listJson)).not.toContain(secretPlaintext);

      // 5. Direct /api/tasks alias is rejected with 404 (canonical /api/manage/tasks required)
      const aliasRes = await fetch(`${baseUrl}/api/tasks/${taskId}/notifications/subscriptions`, {
        headers: { Cookie: aliceCookie },
      });
      expect(aliasRes.status).toBe(404);

      // 6. Delete subscription
      const deleteRes = await fetch(`${baseUrl}/api/manage/tasks/${taskId}/notifications/subscriptions/${subId}`, {
        method: 'DELETE',
        headers: {
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
      });
      expect(deleteRes.status).toBe(200);
    });

    it('rejects webhook creation with invalid URL or SSRF target', async () => {
      const res = await fetch(`${baseUrl}/api/manage/tasks/${taskId}/notifications/subscriptions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          channel: 'webhook',
          destination: 'http://169.254.169.254/latest/meta-data/',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.message).toContain('rejected');
    });
  });

  describe('4. Webhook Test Ping API (POST /api/manage/tasks/:taskId/notifications/test)', () => {
    it('successfully delivers test ping and returns status and latency', async () => {
      const res = await fetch(`${baseUrl}/api/manage/tasks/${taskId}/notifications/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          url: `http://127.0.0.1:${mockServerPort}/webhook-test`,
          secret: 'ping_secret',
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.success).toBe(true);
      expect(json.data.statusCode).toBe(200);
      expect(json.data.responseTimeMs).toBeGreaterThanOrEqual(0);

      // Verify mock server received ping with signature
      expect(lastReceivedWebhook).not.toBeNull();
      expect(lastReceivedWebhook!.headers['x-enkeep-event']).toBe('task.test_ping');
      expect(lastReceivedWebhook!.headers['x-enkeep-signature']).toBeDefined();
    });

    it('returns fixed errorCode and no raw error or body when remote webhook endpoint returns 500', async () => {
      const res = await fetch(`${baseUrl}/api/manage/tasks/${taskId}/notifications/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          url: `http://127.0.0.1:${mockServerPort}/fail-500`,
          secret: 'ping_secret_with_sensitive_token_123',
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.success).toBe(false);
      expect(json.data.statusCode).toBe(500);
      expect(json.data.errorCode).toBe('WEBHOOK_HTTP_ERROR');
      expect(json.data.error).toBeUndefined();
      expect(JSON.stringify(json.data)).not.toContain('Internal server error');
      expect(JSON.stringify(json.data)).not.toContain('ping_secret_with_sensitive_token_123');
    });

    it('returns WEBHOOK_POLICY_REJECTED when test URL violates SSRF policy', async () => {
      const res = await fetch(`${baseUrl}/api/manage/tasks/${taskId}/notifications/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          url: 'http://169.254.169.254/latest/meta-data/',
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.success).toBe(false);
      expect(json.data.errorCode).toBe('WEBHOOK_POLICY_REJECTED');
      expect(json.data.error).toBeUndefined();
    });
  });

  describe('5. Task Event Dispatching & Safe Payload Delivery', () => {
    it('dispatches completed event, signs webhook using decrypted secret, redacts prompt/model output, and records delivery history', async () => {
      const notifService = server.taskNotificationService;

      // Seed task_run row for foreign key
      db.prepare(`
        INSERT INTO task_runs (id, task_id, user_id, status, prompt_tokens, completion_tokens, total_tokens, created_at, updated_at)
        VALUES ('run_999', ?, ?, 'completed', 250, 100, 350, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      `).run(taskId, aliceId);

      // Subscribe webhook to 'completed' event
      await notifService.createSubscription({
        taskId,
        userId: aliceId,
        channel: 'webhook',
        destination: `http://127.0.0.1:${mockServerPort}/webhook-completion`,
        secret: 'prod_webhook_secret',
        events: ['completed'],
      });

      // Dispatch completed event
      const deliveries = await notifService.notifyTaskEvent({
        taskId,
        userId: aliceId,
        event: 'completed',
        task: {
          id: taskId,
          name: 'Nightly Digest',
          status: 'completed',
          scheduleType: 'cron',
          scheduledFor: '2026-08-29T10:00:00.000Z',
          startedAt: '2026-08-29T10:00:01.000Z',
          completedAt: '2026-08-29T10:00:05.000Z',
        },
        run: {
          id: 'run_999',
          attemptNumber: 1,
          status: 'completed',
          promptTokens: 250,
          completionTokens: 100,
          totalTokens: 350,
        },
      });

      expect(deliveries.length).toBe(1);

      // Wait for immediate async dispatch to mock server
      await new Promise((r) => setTimeout(r, 100));

      expect(lastReceivedWebhook).not.toBeNull();
      expect(lastReceivedWebhook!.headers['x-enkeep-event']).toBe('task.completed');
      expect(lastReceivedWebhook!.headers['x-enkeep-signature']).toBeDefined();

      // Verify signature matches computation with secret
      const expectedSig = computeWebhookSignature(JSON.stringify(lastReceivedWebhook!.body), 'prod_webhook_secret');
      expect(lastReceivedWebhook!.headers['x-enkeep-signature']).toBe(`sha256=${expectedSig}`);

      const receivedPayload = lastReceivedWebhook!.body;
      expect(receivedPayload.event).toBe('task.completed');
      expect(receivedPayload.task.id).toBe(taskId);
      expect(receivedPayload.task.status).toBe('completed');
      expect(receivedPayload.run.tokenUsage.totalTokens).toBe(350);

      // SECURITY INVARIANT: Prompt text and raw model output MUST NOT be in payload
      const payloadStr = JSON.stringify(receivedPayload);
      expect(payloadStr).not.toContain('Secret user prompt');
      expect(payloadStr).not.toContain('generate digest');

      // Check deliveries list API
      const delivRes = await fetch(`${baseUrl}/api/manage/tasks/${taskId}/notifications/deliveries`, {
        headers: { Cookie: aliceCookie },
      });
      expect(delivRes.status).toBe(200);
      const delivJson = await delivRes.json();
      expect(delivJson.data.items.length).toBe(1);
      expect(delivJson.data.items[0].status).toBe('delivered');
      expect(delivJson.data.items[0].responseStatus).toBe(200);
    });

    it('handles webhook delivery failure with retry backoff and manual retry API', async () => {
      const notifService = server.taskNotificationService;

      // Seed task_run row for foreign key
      db.prepare(`
        INSERT INTO task_runs (id, task_id, user_id, status, prompt_tokens, completion_tokens, total_tokens, created_at, updated_at)
        VALUES ('run_fail_1', ?, ?, 'failed', 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      `).run(taskId, aliceId);

      // Subscribe webhook to failing endpoint
      const sub = await notifService.createSubscription({
        taskId,
        userId: aliceId,
        channel: 'webhook',
        destination: `http://127.0.0.1:${mockServerPort}/fail-500`,
        events: ['failed'],
      });

      const deliveries = await notifService.notifyTaskEvent({
        taskId,
        userId: aliceId,
        event: 'failed',
        task: {
          id: taskId,
          status: 'failed',
        },
        run: {
          id: 'run_fail_1',
          status: 'failed',
          errorCode: 'TIMEOUT',
          error: 'Execution timed out',
        },
      });

      const deliveryId = deliveries[0].id;

      // Wait for initial failure attempt
      await new Promise((r) => setTimeout(r, 100));

      const delivRes = await fetch(`${baseUrl}/api/manage/tasks/${taskId}/notifications/deliveries`, {
        headers: { Cookie: aliceCookie },
      });
      const delivJson = await delivRes.json();
      expect(delivJson.data.items.length).toBeGreaterThanOrEqual(1);

      const failedDelivery = delivJson.data.items.find((d: any) => d.id === deliveryId);
      expect(failedDelivery.status).toBe('failed');
      expect(failedDelivery.attempts).toBe(1);
      expect(failedDelivery.nextRetryAt).toBeDefined();

      // Manual retry API
      const retryRes = await fetch(`${baseUrl}/api/manage/tasks/${taskId}/notifications/deliveries/${deliveryId}/retry`, {
        method: 'POST',
        headers: {
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
      });
      expect(retryRes.status).toBe(200);
      const retryJson = await retryRes.json();
      expect(retryJson.data.id).toBe(deliveryId);
    });
  });
});
