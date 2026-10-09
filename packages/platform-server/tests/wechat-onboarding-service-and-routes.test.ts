/**
 * WeChat Onboarding Service & Routes Integration Tests (F-02, F-03).
 *
 * Tests with synthetic data and mock HTTP:
 * 1. Normal scan-to-confirmed flow:
 *    - QR code initialization
 *    - Polling returns confirmed
 *    - AES-256-GCM encrypted credentials stored in channel_encrypted_credentials
 *    - channel_accounts created with type: 'wechat', defaultSpaceId bound
 *    - RuntimeManager.syncAccount invoked and poller started -> ready
 * 2. Two-factor verification code flow:
 *    - need_verifycode status transition
 *    - Submit verification code via POST /api/manage/channels/onboarding/jobs/:id/verify
 *    - Poller receives verify_code and completes to confirmed
 * 3. Security checks:
 *    - Reject non-qq.com redirect host (SSRF protection) -> failed
 *    - Zero plain botToken leakage in summary or logs
 * 4. Expiration & auto-refresh:
 *    - Returns expired -> auto refreshed up to 3 times -> terminal expired
 * 5. Update existing account:
 *    - Same bot existing updates credentials rather than creating duplicate account
 * 6. ChannelRoutes integration:
 *    - channel: 'wechat' dispatch
 *    - CSRF protection
 *    - Submit verify code endpoint
 *
 * @module @enkeep/platform-server/tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import {
  SqlitePlatformStorage,
} from '@enkeep/platform-storage-sqlite';
import {
  ChannelManagementService,
  ChannelRoutes,
} from '../src/channels/channel-routes.js';
import {
  WeChatOnboardingService,
} from '../src/channels/wechat-onboarding-service.js';
import {
  WeChatRuntimeManager,
} from '../src/channels/wechat-runtime.js';
import type { User } from '@enkeep/platform-core';

describe('WeChat Onboarding Service & Routes (F-02, F-03)', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let channelService: ChannelManagementService;
  let wechatOnboardingService: WeChatOnboardingService;
  let mockRuntimeManager: WeChatRuntimeManager;
  let mockActiveGateways: Map<string, any>;
  const masterKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  const userAlice: User = {
    id: 'user-synth-alice',
    username: 'alice',
    displayName: 'Alice',
    role: 'user',
    status: 'active',
    passwordHash: 'hash_alice',
  };

  const testSpaceId = 'spc_00000000000000000000000000000001';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);
    storage = new SqlitePlatformStorage(db);

    await storage.users.create(userAlice);
    await storage.forTenant(userAlice.id).spaces.create({
      id: testSpaceId,
      name: 'Test Space Alice',
      folder: 'space_alice',
      executionMode: 'container',
      status: 'active',
    });

    mockActiveGateways = new Map();
    mockRuntimeManager = {
      syncAccount: vi.fn(async (userId: string, accountId: string) => {
        mockActiveGateways.set(`${userId}:${accountId}`, {
          transport: { connected: true },
        });
        return mockActiveGateways.get(`${userId}:${accountId}`);
      }),
      getActiveGateway: vi.fn((userId: string, accountId: string) => {
        return mockActiveGateways.get(`${userId}:${accountId}`);
      }),
    } as unknown as WeChatRuntimeManager;

    channelService = new ChannelManagementService(storage, undefined, mockRuntimeManager);
    wechatOnboardingService = new WeChatOnboardingService({
      storage,
      db,
      runtimeManager: mockRuntimeManager,
      masterKey,
    });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  it('1. Normal flow: QR start -> confirmed -> creates account, encrypts credentials, binds space, starts runtime', async () => {
    let pollCount = 0;
    const mockFetch: typeof fetch = vi.fn(async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes('/ilink/bot/get_bot_qrcode')) {
        return new Response(
          JSON.stringify({
            qrcode: 'synth_qrcode_1',
            qrcode_img_content: 'weixin://qr/synth_1',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.includes('/ilink/bot/get_qrcode_status')) {
        pollCount++;
        if (pollCount === 1) {
          return new Response(JSON.stringify({ status: 'wait' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            status: 'confirmed',
            bot_token: 'synth_secret_bot_token_123',
            ilink_bot_id: 'synth_bot_alice@im.wechat',
            baseurl: 'https://ilinkai.weixin.qq.com',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    }) as any;

    const job = await wechatOnboardingService.createJob({
      userId: userAlice.id,
      spaceId: testSpaceId,
      action: 'create_new',
      fetchImpl: mockFetch,
    });

    expect(job.status).toBe('waiting_for_scan');
    expect(job.qrSvg).toBeDefined();
    expect(job.qrDataUrl).toBeDefined();
    // Zero secret leakage
    expect(JSON.stringify(job)).not.toContain('synth_secret_bot_token_123');

    // First poll -> wait
    const poll1 = await wechatOnboardingService.getJobStatus(userAlice.id, job.id);
    expect(poll1.status).toBe('waiting_for_scan');

    // Second poll -> confirmed -> provisioning & runtime sync
    const poll2 = await wechatOnboardingService.getJobStatus(userAlice.id, job.id);
    expect(['configuring', 'verifying', 'ready']).toContain(poll2.status);

    // Wait a brief tick for configuration promise if needed
    let finalStatus = poll2;
    for (let i = 0; i < 10; i++) {
      if (finalStatus.status === 'ready') break;
      await new Promise((r) => setTimeout(r, 20));
      finalStatus = await wechatOnboardingService.getJobStatus(userAlice.id, job.id);
    }

    expect(finalStatus.status).toBe('ready');
    expect(finalStatus.accountId).toBeDefined();

    // Verify channel_accounts in database
    const account = await storage.forTenant(userAlice.id).channels.findAccountById(finalStatus.accountId!);
    expect(account).toBeDefined();
    expect(account!.type).toBe('wechat');
    expect(account!.status).toBe('active');
    expect(account!.defaultSpaceId).toBe(testSpaceId);

    // Verify channel_encrypted_credentials in database
    const credRow = db
      .prepare('SELECT encrypted_payload FROM channel_encrypted_credentials WHERE credential_ref = ?')
      .get(account!.credentialRef!) as { encrypted_payload: string };
    expect(credRow).toBeDefined();
    expect(credRow.encrypted_payload.startsWith('v1:')).toBe(true);
    expect(credRow.encrypted_payload).not.toContain('synth_secret_bot_token_123');

    // Verify syncAccount was called
    expect(mockRuntimeManager.syncAccount).toHaveBeenCalledWith(userAlice.id, account!.id);
  });

  it('2. Verify code flow: need_verifycode -> submit code -> confirmed', async () => {
    let pollCount = 0;
    let receivedVerifyCode: string | null = null;

    const mockFetch: typeof fetch = vi.fn(async (input) => {
      const urlStr = String(input);
      if (urlStr.includes('/ilink/bot/get_bot_qrcode')) {
        return new Response(
          JSON.stringify({
            qrcode: 'synth_qrcode_verify_test',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.includes('/ilink/bot/get_qrcode_status')) {
        pollCount++;
        const parsedUrl = new URL(urlStr);
        receivedVerifyCode = parsedUrl.searchParams.get('verify_code');

        if (!receivedVerifyCode) {
          return new Response(JSON.stringify({ status: 'need_verifycode' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(
          JSON.stringify({
            status: 'confirmed',
            bot_token: 'synth_token_after_code_555',
            ilink_bot_id: 'synth_bot_verify',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    }) as any;

    const job = await wechatOnboardingService.createJob({
      userId: userAlice.id,
      spaceId: testSpaceId,
      action: 'create_new',
      fetchImpl: mockFetch,
    });

    // Poll 1 -> need_verifycode
    const status1 = await wechatOnboardingService.getJobStatus(userAlice.id, job.id);
    expect(status1.status).toBe('need_verifycode');

    // Submit verify code
    const submitResult = await wechatOnboardingService.submitVerifyCode(userAlice.id, job.id, '654321');
    expect(receivedVerifyCode).toBe('654321');
    expect(['configuring', 'verifying', 'ready']).toContain(submitResult.status);

    // Wait until ready
    let finalStatus = submitResult;
    for (let i = 0; i < 10; i++) {
      if (finalStatus.status === 'ready') break;
      await new Promise((r) => setTimeout(r, 20));
      finalStatus = await wechatOnboardingService.getJobStatus(userAlice.id, job.id);
    }
    expect(finalStatus.status).toBe('ready');
  });

  it('3. Security: non-qq.com redirect host rejected with failed status', async () => {
    const mockFetch: typeof fetch = vi.fn(async (input) => {
      const urlStr = String(input);
      if (urlStr.includes('/ilink/bot/get_bot_qrcode')) {
        return new Response(
          JSON.stringify({ qrcode: 'synth_qr_evil' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.includes('/ilink/bot/get_qrcode_status')) {
        return new Response(
          JSON.stringify({
            status: 'scaned_but_redirect',
            redirect_host: 'attacker.evil.com',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    }) as any;

    const job = await wechatOnboardingService.createJob({
      userId: userAlice.id,
      spaceId: testSpaceId,
      action: 'create_new',
      fetchImpl: mockFetch,
    });

    const pollRes = await wechatOnboardingService.getJobStatus(userAlice.id, job.id);
    expect(pollRes.status).toBe('failed');
    expect(pollRes.error).toContain('Invalid redirect host');
  });

  it('4. Expiration and auto-refresh up to 3 times', async () => {
    let qrCount = 0;
    const mockFetch: typeof fetch = vi.fn(async (input) => {
      const urlStr = String(input);
      if (urlStr.includes('/ilink/bot/get_bot_qrcode')) {
        qrCount++;
        return new Response(
          JSON.stringify({ qrcode: `synth_qr_refresh_${qrCount}` }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.includes('/ilink/bot/get_qrcode_status')) {
        return new Response(
          JSON.stringify({ status: 'expired' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    }) as any;

    const job = await wechatOnboardingService.createJob({
      userId: userAlice.id,
      spaceId: testSpaceId,
      action: 'create_new',
      fetchImpl: mockFetch,
    });

    // Initial QR is #1
    expect(qrCount).toBe(1);

    // Poll 1 -> expired -> refreshed to #2
    const poll1 = await wechatOnboardingService.getJobStatus(userAlice.id, job.id);
    expect(poll1.status).toBe('waiting_for_scan');
    expect(qrCount).toBe(2);

    // Poll 2 -> expired -> refreshed to #3
    const poll2 = await wechatOnboardingService.getJobStatus(userAlice.id, job.id);
    expect(poll2.status).toBe('waiting_for_scan');
    expect(qrCount).toBe(3);

    // Poll 3 -> expired -> refreshed to #4 (refreshCount reached 3)
    const poll3 = await wechatOnboardingService.getJobStatus(userAlice.id, job.id);
    expect(poll3.status).toBe('waiting_for_scan');
    expect(qrCount).toBe(4);

    // Poll 4 -> expired -> terminal expired
    const poll4 = await wechatOnboardingService.getJobStatus(userAlice.id, job.id);
    expect(poll4.status).toBe('expired');
  });

  it('5. Updating existing bot does not create duplicate channel account', async () => {
    // Seed existing account for same bot
    const existingAccount = await storage.forTenant(userAlice.id).channels.createAccount({
      id: 'acc_wechat_existing_1',
      type: 'wechat',
      status: 'active',
      credentialRef: 'cred_wechat_existing_1',
      defaultSpaceId: testSpaceId,
    });

    // Store encrypted credentials for this bot
    const mockFetch: typeof fetch = vi.fn(async (input) => {
      const urlStr = String(input);
      if (urlStr.includes('/ilink/bot/get_bot_qrcode')) {
        return new Response(
          JSON.stringify({ qrcode: 'synth_qr_existing' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.includes('/ilink/bot/get_qrcode_status')) {
        return new Response(
          JSON.stringify({
            status: 'confirmed',
            bot_token: 'synth_token_updated_888',
            ilink_bot_id: 'bot_same_id@im.wechat',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    }) as any;

    const job = await wechatOnboardingService.createJob({
      userId: userAlice.id,
      spaceId: testSpaceId,
      action: 'configure_existing',
      accountId: existingAccount.id,
      fetchImpl: mockFetch,
    });

    const pollRes = await wechatOnboardingService.getJobStatus(userAlice.id, job.id);
    let finalStatus = pollRes;
    for (let i = 0; i < 10; i++) {
      if (finalStatus.status === 'ready') break;
      await new Promise((r) => setTimeout(r, 20));
      finalStatus = await wechatOnboardingService.getJobStatus(userAlice.id, job.id);
    }

    expect(finalStatus.status).toBe('ready');
    expect(finalStatus.accountId).toBe(existingAccount.id);

    // Total wechat accounts count should remain 1
    const allAccounts = await storage.forTenant(userAlice.id).channels.listAccounts('wechat');
    expect(allAccounts.length).toBe(1);
    expect(allAccounts[0].id).toBe(existingAccount.id);
  });

  describe('6. ChannelRoutes HTTP dispatch for wechat & verify (F-03)', () => {
    let routes: ChannelRoutes;
    const csrfToken = 'test-csrf-token-1234567890abcdef1234567890';

    beforeEach(() => {
      routes = new ChannelRoutes(channelService, csrfToken, undefined, wechatOnboardingService);
    });

    function createMockReqRes(options: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      body?: any;
    }): { req: IncomingMessage; res: ServerResponse; getOutput: () => { status: number; body: any } } {
      let responseBody = '';
      let statusCode = 200;
      const bodyStr = options.body !== undefined
        ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
        : '';

      const listeners: Record<string, ((...args: any[]) => void)[]> = {};
      const req = {
        method: options.method,
        url: options.url,
        headers: {
          'content-type': 'application/json',
          host: '127.0.0.1:3000',
          origin: 'http://127.0.0.1:3000',
          'x-enkeep-csrf': csrfToken,
          ...options.headers,
        },
        socket: {
          remoteAddress: '127.0.0.1',
          localAddress: '127.0.0.1',
          localPort: 3000,
        },
        on: (event: string, fn: (...args: any[]) => void) => {
          if (!listeners[event]) listeners[event] = [];
          listeners[event].push(fn);
          if (event === 'data') {
            queueMicrotask(() => {
              if (bodyStr) {
                fn(Buffer.from(bodyStr));
              }
              listeners['end']?.forEach((endFn) => endFn());
            });
          } else if (event === 'end' && !bodyStr) {
            queueMicrotask(() => {
              fn();
            });
          }
          return req;
        },
        once: function (event: string, fn: (...args: any[]) => void) {
          return (this as any).on(event, fn);
        },
        removeListener: function () {
          return this;
        },
      } as unknown as IncomingMessage;

      const res = {
        writeHead: vi.fn((code: number) => {
          statusCode = code;
          return res;
        }),
        setHeader: vi.fn(),
        end: vi.fn((data?: any) => {
          if (data) responseBody += data.toString();
        }),
      } as unknown as ServerResponse;

      return {
        req,
        res,
        getOutput: () => ({
          status: statusCode,
          body: responseBody ? JSON.parse(responseBody) : undefined,
        }),
      };
    }

    it('creates wechat onboarding job via POST /api/manage/channels/onboarding/jobs', async () => {
      // Mock global fetch for route test
      const originalFetch = global.fetch;
      global.fetch = vi.fn(async (input) => {
        const urlStr = String(input);
        if (urlStr.includes('/ilink/bot/get_bot_qrcode')) {
          return new Response(
            JSON.stringify({ qrcode: 'synth_route_qr' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response('{}', { status: 200 });
      }) as any;

      try {
        const { req, res, getOutput } = createMockReqRes({
          method: 'POST',
          url: '/api/manage/channels/onboarding/jobs',
          body: {
            channel: 'wechat',
            action: 'create_new',
            spaceId: testSpaceId,
          },
        });

        const handled = await routes.handle(req, res, '/api/manage/channels/onboarding/jobs', userAlice);
        expect(handled).toBe(true);

        const out = getOutput();
        expect(out.status).toBe(201);
        expect(out.body.data.status).toBe('waiting_for_scan');
        expect(out.body.data.qrSvg).toBeDefined();
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('submits verify code via POST /api/manage/channels/onboarding/jobs/:id/verify', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn(async (input) => {
        const urlStr = String(input);
        if (urlStr.includes('/ilink/bot/get_bot_qrcode')) {
          return new Response(
            JSON.stringify({ qrcode: 'synth_route_verify_qr' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (urlStr.includes('/ilink/bot/get_qrcode_status')) {
          const url = new URL(urlStr);
          if (url.searchParams.get('verify_code') === '123456') {
            return new Response(
              JSON.stringify({
                status: 'confirmed',
                bot_token: 'synth_tok_route_verify',
                ilink_bot_id: 'bot_verify_route',
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return new Response(
            JSON.stringify({ status: 'need_verifycode' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response('{}', { status: 200 });
      }) as any;

      try {
        const job = await wechatOnboardingService.createJob({
          userId: userAlice.id,
          spaceId: testSpaceId,
          action: 'create_new',
        });

        // Trigger need_verifycode
        await wechatOnboardingService.getJobStatus(userAlice.id, job.id);

        const { req, res, getOutput } = createMockReqRes({
          method: 'POST',
          url: `/api/manage/channels/onboarding/jobs/${job.id}/verify`,
          body: {
            verifyCode: '123456',
          },
        });

        const handled = await routes.handle(
          req,
          res,
          `/api/manage/channels/onboarding/jobs/${job.id}/verify`,
          userAlice
        );
        expect(handled).toBe(true);

        const out = getOutput();
        expect(out.status).toBe(200);
        expect(['configuring', 'verifying', 'ready']).toContain(out.body.data.status);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('validates CSRF token on POST /verify', async () => {
      const { req, res } = createMockReqRes({
        method: 'POST',
        url: '/api/manage/channels/onboarding/jobs/job_123/verify',
        headers: {
          'x-enkeep-csrf': 'wrong-token-wrong-token-wrong-token-1234',
        },
        body: {
          verifyCode: '123456',
        },
      });

      await expect(
        routes.handle(req, res, '/api/manage/channels/onboarding/jobs/job_123/verify', userAlice)
      ).rejects.toThrow();
    });
  });
});
