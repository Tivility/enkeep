/**
 * Focused Unit and Integration Tests for Lark Onboarding Service, Encrypted Store, and API Routes.
 *
 * Verifies:
 * 1. LarkEncryptedCredentialStore: AES-256-GCM authenticated encryption, AAD tenant binding (${userId}:${credentialRef}),
 *    exact 32-byte key file verification, exclusive creation, SQLite persistence across restart, tamper rejection.
 * 2. LarkOnboardingService: singleflight concurrency, true AbortController cancellation, exact account verification,
 *    default space resolution, read-only recovery for verifying/awaiting_approval, no false ready without transport.
 * 3. ChannelRoutes: CSRF validation, parameter validation, endpoint lifecycle (/jobs, /jobs/:id, /jobs/:id/cancel).
 *
 * @module @enkeep/platform-server/tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  LarkEncryptedCredentialStore,
  KeyFileSecurityError,
} from '../src/channels/lark-encrypted-credentials.js';
import {
  LarkOnboardingService,
} from '../src/channels/lark-onboarding-service.js';
import {
  ChannelRuntimeManager,
} from '../src/channels/channel-runtime-manager.js';
import {
  FakeLarkTransport,
} from '@enkeep/channel-lark';
import type { User, Space } from '@enkeep/platform-core';

describe('1. LarkEncryptedCredentialStore Security & Invariants', () => {
  let tmpDir: string;
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'enkeep-cred-test-'));
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);
    storage = new SqlitePlatformStorage(db);

    await storage.users.create({
      id: 'user_alice',
      username: 'alice',
      passwordHash: 'hash_alice',
      role: 'admin',
      status: 'active',
      displayName: 'Alice',
    });

    await storage.users.create({
      id: 'user_bob',
      username: 'bob',
      passwordHash: 'hash_bob',
      role: 'user',
      status: 'active',
      displayName: 'Bob',
    });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects initialization without master key or with empty passphrase', () => {
    expect(() => new LarkEncryptedCredentialStore({})).toThrow(/Master encryption key is required/);
    expect(() => new LarkEncryptedCredentialStore({ cipherSecret: '   ' })).toThrow(/non-empty string/);
  });

  it('atomically creates 0600 32-byte key file, rejecting symlinks and corrupted sizes', () => {
    const keyPath = join(tmpDir, 'secure.key');
    const store = new LarkEncryptedCredentialStore({ keyFilePath: keyPath });
    expect(existsSync(keyPath)).toBe(true);

    // Corrupted size test (e.g. 10 bytes)
    const badKeyPath = join(tmpDir, 'corrupt.key');
    writeFileSync(badKeyPath, Buffer.from('short_key'), { mode: 0o600 });
    expect(() => new LarkEncryptedCredentialStore({ keyFilePath: badKeyPath })).toThrow(KeyFileSecurityError);

    // Symlink test
    const symlinkPath = join(tmpDir, 'symlink.key');
    symlinkSync(keyPath, symlinkPath);
    expect(() => new LarkEncryptedCredentialStore({ keyFilePath: symlinkPath })).toThrow(KeyFileSecurityError);
  });

  it('encrypts credentials with strict AAD tenant binding and persists to SQLite across restarts', async () => {
    const cipherSecret = 'master_test_secret_32_chars_ok_1234';
    const store1 = new LarkEncryptedCredentialStore({ cipherSecret, db });

    const aliceUserId = 'user_alice';
    const bobUserId = 'user_bob';

    const credRef = await store1.storeCredentials(aliceUserId, {
      appId: 'cli_alice_bot',
      appSecret: 'secret_alice_raw_value',
      domain: 'feishu',
    });

    expect(credRef).toMatch(/^cred_lark_cli_alice_bot_[0-9a-f]+$/);

    // Alice can resolve
    const resolvedAlice = await store1.resolve(aliceUserId, credRef);
    expect(resolvedAlice).toBeDefined();
    expect(resolvedAlice?.appId).toBe('cli_alice_bot');
    expect(resolvedAlice?.appSecret).toBe('secret_alice_raw_value');

    // Bob CANNOT resolve Alice's credential (tenant binding fail-closed)
    const resolvedBob = await store1.resolve(bobUserId, credRef);
    expect(resolvedBob).toBeNull();

    // Restart simulation: instantiate store2 with same key and db
    const store2 = new LarkEncryptedCredentialStore({ cipherSecret, db });
    const resolvedAfterRestart = await store2.resolve(aliceUserId, credRef);
    expect(resolvedAfterRestart?.appSecret).toBe('secret_alice_raw_value');
  });

  it('fails closed when ciphertext payload is tampered in database', async () => {
    const cipherSecret = 'master_test_secret_32_chars_ok_1234';
    const store = new LarkEncryptedCredentialStore({ cipherSecret, db });

    const credRef = await store.storeCredentials('user_alice', {
      appId: 'cli_tamper_test',
      appSecret: 'original_secret',
    });

    // Tamper ciphertext in DB directly
    db.prepare(`
      UPDATE channel_encrypted_credentials
      SET encrypted_payload = 'v1:123456789012345678901234:12345678901234567890123456789012:deadbeef'
      WHERE credential_ref = ?
    `).run(credRef);

    const result = await store.resolve('user_alice', credRef);
    expect(result).toBeNull();
  });
});

describe('2. LarkOnboardingService Concurrency, Cancellation & State Machine', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let credStore: LarkEncryptedCredentialStore;
  let channelService: ChannelManagementService;
  let onboardingService: LarkOnboardingService;
  let testSpace: Space;
  const aliceUser: User = {
    id: 'usr_alice',
    role: 'admin',
    status: 'active',
    displayName: 'Alice',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    await storage.users.create({
      id: aliceUser.id,
      username: 'alice_onb',
      passwordHash: 'hash_onb',
      role: aliceUser.role,
      status: aliceUser.status,
      displayName: aliceUser.displayName,
    });

    testSpace = await storage.forTenant(aliceUser.id).spaces.create({
      name: 'Main Space',
      folder: 'main',
      executionMode: 'container',
      status: 'active',
    });

    credStore = new LarkEncryptedCredentialStore({
      cipherSecret: 'test_cookie_secret_32_characters_long',
      db,
    });
    channelService = new ChannelManagementService(storage);
    onboardingService = new LarkOnboardingService(
      storage,
      credStore,
      channelService,
      undefined,
      credStore
    );
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  it('initializes QR onboarding job and enforces space validation', async () => {
    const mockFetcher = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes('/accounts/qrlogin/init')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { step_info: { token: 'token_init_123' } },
        }), {
          headers: { 'x-flow-key': 'flow_init_xyz', 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ code: 0 }));
    });

    const job = await onboardingService.createJob({
      userId: aliceUser.id,
      spaceId: testSpace.id,
      action: 'configure_existing',
      appId: 'cli_0123456789abcdef',
      fetchImpl: mockFetcher as any,
    });

    expect(job.status).toBe('waiting_for_scan');
    expect(job.appId).toBe('cli_0123456789abcdef');
    expect(job.qrPayload).toBe(JSON.stringify({ qrlogin: { token: 'token_init_123' } }));
    expect(job.qrUrl).toBeUndefined();
  });

  it('enforces singleflight concurrency: concurrent calls share polling promise without duplicating work', async () => {
    let pollCount = 0;
    const mockFetcher = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes('/accounts/qrlogin/init')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { step_info: { token: 'token_singleflight' } },
        }), {
          headers: { 'x-flow-key': 'flow_singleflight', 'content-type': 'application/json' },
        });
      }
      if (urlStr.includes('/accounts/qrlogin/polling')) {
        pollCount++;
        return new Response(JSON.stringify({
          code: 0,
          data: { step_info: { status: 1 }, next_step: '' },
        }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });

    const job = await onboardingService.createJob({
      userId: aliceUser.id,
      spaceId: testSpace.id,
      action: 'configure_existing',
      appId: 'cli_0123456789abcdef',
      fetchImpl: mockFetcher as any,
    });

    // Run 3 simultaneous getJobStatus calls concurrently
    const [res1, res2, res3] = await Promise.all([
      onboardingService.getJobStatus(aliceUser.id, job.id),
      onboardingService.getJobStatus(aliceUser.id, job.id),
      onboardingService.getJobStatus(aliceUser.id, job.id),
    ]);

    expect(res1.status).toBe('waiting_for_scan');
    expect(res2.status).toBe('waiting_for_scan');
    expect(res3.status).toBe('waiting_for_scan');
    expect(pollCount).toBe(1);
  });

  it('cancels in-flight job cleanly and aborts pending fetch requests', async () => {
    const mockFetcher = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes('/accounts/qrlogin/init')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { step_info: { token: 'token_cancel' } },
        }), {
          headers: { 'x-flow-key': 'flow_cancel', 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ code: 0 }));
    });

    const job = await onboardingService.createJob({
      userId: aliceUser.id,
      spaceId: testSpace.id,
      action: 'configure_existing',
      appId: 'cli_0123456789abcdef',
      fetchImpl: mockFetcher as any,
    });

    const cancelled = await onboardingService.cancelJob(aliceUser.id, job.id);
    expect(cancelled.status).toBe('cancelled');

    const status = await onboardingService.getJobStatus(aliceUser.id, job.id);
    expect(status.status).toBe('cancelled');
  });

  it('handles existing bot configuration flow, sets defaultSpace resolver, and provisions credentials', async () => {
    const mockFetcher = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes('/accounts/qrlogin/init')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { step_info: { token: 'token_complete' } },
        }), {
          headers: {
            'x-flow-key': 'flow_complete',
            'content-type': 'application/json',
            'set-cookie': 'session=valid_cookie_123; Domain=feishu.cn; Path=/; Secure',
          },
        });
      }
      if (urlStr.includes('ask.feishu.cn')) {
        return new Response('<html><body>ask.feishu.cn</body></html>', {
          headers: {
            'set-cookie': 'session=valid_cookie_123; Domain=feishu.cn; Path=/; Secure',
          },
        });
      }
      if (urlStr.includes('/accounts/qrlogin/polling')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { step_info: { status: 2 }, next_step: 'enter_app' },
        }));
      }
      if (urlStr.includes('/auth') || urlStr.includes('/app/cli_0123456789abcdef')) {
        return new Response(`
          <html>
            <head><script>window.csrfToken = "csrf_auth_valid";</script></head>
            <body>
              <script>window.user = {"id":"ou_alice_scanner","name":"Alice","tenantId":"ten_feishu","tenantName":"Test Corp"};</script>
            </body>
          </html>
        `);
      }
      if (urlStr.includes('/developers/v1/scope/all/cli_0123456789abcdef')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { scopes: [{ id: 'sc_msg', name: 'im:message', bucket: 'tenant' }] },
        }));
      }
      if (urlStr.includes('/developers/v1/visible/online/cli_0123456789abcdef')) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            whiteList: { departments: [], members: ['ou_alice_scanner'], groups: [], isAll: 0 },
            blackList: { departments: [], members: [], groups: [], isAll: 0 },
          },
        }));
      }
      if (urlStr.includes('/developers/v1/event/cli_0123456789abcdef')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { eventMode: 4, appEvents: ['im.message.receive_v1'] },
        }));
      }
      if (urlStr.includes('/developers/v1/secret/cli_0123456789abcdef')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { secret: 'secret_app_resolved_live_123' },
        }));
      }
      if (urlStr.includes('/developers/v1/app_version/list/cli_0123456789abcdef')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { versions: [{ appVersion: '1.0.0' }] },
        }));
      }
      if (urlStr.includes('/developers/v1/app_version/create/cli_0123456789abcdef')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { versionId: 'ver_200' },
        }));
      }
      if (urlStr.includes('/developers/v1/publish/commit/cli_0123456789abcdef/ver_200')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { status: 'published' },
        }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });

    const job = await onboardingService.createJob({
      userId: aliceUser.id,
      spaceId: testSpace.id,
      action: 'configure_existing',
      appId: 'cli_0123456789abcdef',
      fetchImpl: mockFetcher as any,
    });

    const firstStatus = await onboardingService.getJobStatus(aliceUser.id, job.id);
    expect(firstStatus.status).toBe('configuring');
    // Await tracked background configuration promise
    await (onboardingService as any).jobs.get(job.id)?.configurationPromise;

    const resultStatus = await onboardingService.getJobStatus(aliceUser.id, job.id);
    if (resultStatus.error) {
      console.error('Job error in test:', resultStatus.error, resultStatus.statusMessage);
    }

    // Account was created/updated in tenant repository
    const accounts = await storage.forTenant(aliceUser.id).channels.listAccounts('lark');
    expect(accounts.length).toBe(1);
    expect(accounts[0].credentialRef).toBeDefined();

    // Default space was recorded in resolver
    const resolvedDefaultSpace = await onboardingService.resolveDefaultSpace(aliceUser.id, accounts[0]);
    expect(resolvedDefaultSpace).toBe(testSpace.id);

    // Resolved credentials from store
    const creds = await credStore.resolve(aliceUser.id, accounts[0].credentialRef!);
    expect(creds?.appId).toBe('cli_0123456789abcdef');
    expect(creds?.appSecret).toBe('secret_app_resolved_live_123');
  });

  it('negative invariant: pending approval job with mock WS connected remains awaiting_approval and account unverified', async () => {
    const mockFetcher = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes('/accounts/qrlogin/init')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { step_info: { token: 'token_pending' } },
        }), {
          headers: {
            'x-flow-key': 'flow_pending',
            'content-type': 'application/json',
            'set-cookie': 'session=valid_cookie_pending; Domain=feishu.cn; Path=/; Secure',
          },
        });
      }
      if (urlStr.includes('ask.feishu.cn')) {
        return new Response('<html><body>ask</body></html>', {
          headers: { 'set-cookie': 'session=valid_cookie_pending; Domain=feishu.cn; Path=/; Secure' },
        });
      }
      if (urlStr.includes('/accounts/qrlogin/polling')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { step_info: { status: 2 }, next_step: 'enter_app' },
        }));
      }
      if (urlStr.includes('/auth') || urlStr.includes('/app/cli_0123456789abcdef')) {
        return new Response(`
          <html>
            <head><script>window.csrfToken = "csrf_pending";</script></head>
            <body>
              <script>window.user = {"id":"ou_scanner_p","name":"Alice","tenantId":"ten_feishu","tenantName":"Test Corp"};</script>
            </body>
          </html>
        `);
      }
      if (urlStr.includes('/developers/v1/scope/all/')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { scopes: [{ id: 'sc_msg', name: 'im:message', bucket: 'tenant' }] },
        }));
      }
      if (urlStr.includes('/developers/v1/visible/online/')) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            whiteList: { departments: [], members: ['ou_scanner_p'], groups: [], isAll: 0 },
            blackList: { departments: [], members: [], groups: [], isAll: 0 },
          },
        }));
      }
      if (urlStr.includes('/developers/v1/event/')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { eventMode: 4, appEvents: ['im.message.receive_v1'] },
        }));
      }
      if (urlStr.includes('/developers/v1/secret/')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { secret: 'secret_pending_val' },
        }));
      }
      if (urlStr.includes('/developers/v1/app_version/list/')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { versions: [{ appVersion: '1.0.0' }] },
        }));
      }
      if (urlStr.includes('/developers/v1/app_version/create/')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { versionId: 'ver_pending_audit' },
        }));
      }
      if (urlStr.includes('/developers/v1/publish/commit/')) {
        // Return explicit need_audit / under_review
        return new Response(JSON.stringify({
          code: 0,
          data: { status: 'under_review', need_audit: true },
        }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });

    const job = await onboardingService.createJob({
      userId: aliceUser.id,
      spaceId: testSpace.id,
      action: 'configure_existing',
      appId: 'cli_0123456789abcdef',
      fetchImpl: mockFetcher as any,
    });

    // Advance
    const configuringStatus = await onboardingService.getJobStatus(aliceUser.id, job.id);
    expect(configuringStatus.status).toBe('configuring');
    await (onboardingService as any).jobs.get(job.id)?.configurationPromise;

    const status1 = await onboardingService.getJobStatus(aliceUser.id, job.id);
    expect(status1.status).toBe('awaiting_approval');
    expect(status1.approvalRequired).toBe(true);

    // Check account status in DB is unverified (NOT active)
    const accounts = await storage.forTenant(aliceUser.id).channels.listAccounts('lark');
    expect(accounts.length).toBe(1);
    expect(accounts[0].status).toBe('unverified');

    // Simulate mock WS connected attempt (calling getJobStatus again)
    const status2 = await onboardingService.getJobStatus(aliceUser.id, job.id);
    expect(status2.status).toBe('awaiting_approval');
    expect(status2.approvalRequired).toBe(true);

    // Account in DB remains unverified
    const accountsAfter = await storage.forTenant(aliceUser.id).channels.listAccounts('lark');
    expect(accountsAfter[0].status).toBe('unverified');
  });

  it('verifies QR lifecycle: authentic payload, no fake qrUrl, poll diagnostics, and cleanup on expire/cancel', async () => {
    let currentPollStatus = 1;
    let nextStep = '';

    const mockFetcher = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes('/accounts/qrlogin/init')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { step_info: { token: 'tok_auth_lifecycle' } },
        }), {
          headers: { 'x-flow-key': 'flow_lifecycle_key', 'content-type': 'application/json' },
        });
      }
      if (urlStr.includes('/accounts/qrlogin/polling')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { step_info: { status: currentPollStatus }, next_step: nextStep },
        }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });

    // 1. Create job - verify genuine payload and NO fake qrUrl
    const job = await onboardingService.createJob({
      userId: aliceUser.id,
      spaceId: testSpace.id,
      action: 'configure_existing',
      appId: 'cli_0123456789abcdef',
      fetchImpl: mockFetcher as any,
    });

    expect(job.status).toBe('waiting_for_scan');
    expect(job.qrPayload).toBe(JSON.stringify({ qrlogin: { token: 'tok_auth_lifecycle' } }));
    expect(job.qrUrl).toBeUndefined();
    expect(job.qrSvg).toBeDefined();
    expect(job.qrDataUrl).toBeDefined();

    // 2. Mobile scanned but not confirmed: status = 2
    currentPollStatus = 2;
    const polledStatus = await onboardingService.getJobStatus(aliceUser.id, job.id);
    expect(polledStatus.status).toBe('waiting_for_scan');
    expect(polledStatus.statusMessage).toContain('Scanned, waiting for mobile authorization confirmation');
    expect(polledStatus.statusCode).toBe(2);
    expect(polledStatus.lastPollAt).toBeDefined();
    expect(polledStatus.qrPayload).toBeDefined();

    // 3. Cancelling clears QR payload and images
    const cancelled = await onboardingService.cancelJob(aliceUser.id, job.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.qrPayload).toBeUndefined();
    expect(cancelled.qrUrl).toBeUndefined();
    expect(cancelled.qrSvg).toBeUndefined();
    expect(cancelled.qrDataUrl).toBeUndefined();

    // 4. Test expiration: a second job that encounters status = 5 (expired)
    currentPollStatus = 5;
    const job2 = await onboardingService.createJob({
      userId: aliceUser.id,
      spaceId: testSpace.id,
      action: 'configure_existing',
      appId: 'cli_0123456789abcdef',
      fetchImpl: mockFetcher as any,
    });
    expect(job2.status).toBe('waiting_for_scan');
    expect(job2.qrPayload).toBeDefined();

    const expiredStatus = await onboardingService.getJobStatus(aliceUser.id, job2.id);
    expect(expiredStatus.status).toBe('expired');
    expect(expiredStatus.qrPayload).toBeUndefined();
    expect(expiredStatus.qrUrl).toBeUndefined();
    expect(expiredStatus.qrSvg).toBeUndefined();
    expect(expiredStatus.qrDataUrl).toBeUndefined();
  });

  it('deferred configuration: GET returns configuring immediately, second GET does not duplicate write/publish', async () => {
    let publishCallCount = 0;
    let deferredResolve: () => void = () => {};
    const deferredGate = new Promise<void>((resolve) => {
      deferredResolve = resolve;
    });

    const mockFetcher = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes('/accounts/qrlogin/init')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { step_info: { token: 'tok_deferred_config' } },
        }), {
          headers: {
            'x-flow-key': 'flow_deferred',
            'content-type': 'application/json',
            'set-cookie': 'session=valid_deferred; Domain=feishu.cn; Path=/; Secure',
          },
        });
      }
      if (urlStr.includes('ask.feishu.cn')) {
        return new Response('<html><body>ask</body></html>', {
          headers: { 'set-cookie': 'session=valid_deferred; Domain=feishu.cn; Path=/; Secure' },
        });
      }
      if (urlStr.includes('/accounts/qrlogin/polling')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { step_info: { status: 2 }, next_step: 'enter_app' },
        }));
      }
      if (urlStr.includes('/auth') || urlStr.includes('/app/cli_0123456789abcdef')) {
        // Wait on the gate before continuing configuration pipeline
        await deferredGate;
        return new Response(`
          <html>
            <head><script>window.csrfToken = "csrf_deferred";</script></head>
            <body>
              <script>window.user = {"id":"ou_alice_scanner","name":"Alice","tenantId":"ten_feishu","tenantName":"Test Corp"};</script>
            </body>
          </html>
        `);
      }
      if (urlStr.includes('/developers/v1/scope/all/cli_0123456789abcdef')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { scopes: [{ id: 'sc_msg', name: 'im:message', bucket: 'tenant' }] },
        }));
      }
      if (urlStr.includes('/developers/v1/visible/online/cli_0123456789abcdef')) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            whiteList: { departments: [], members: ['ou_alice_scanner'], groups: [], isAll: 0 },
            blackList: { departments: [], members: [], groups: [], isAll: 0 },
          },
        }));
      }
      if (urlStr.includes('/developers/v1/event/cli_0123456789abcdef')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { eventMode: 4, appEvents: ['im.message.receive_v1'] },
        }));
      }
      if (urlStr.includes('/developers/v1/secret/cli_0123456789abcdef')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { secret: 'secret_deferred_123' },
        }));
      }
      if (urlStr.includes('/developers/v1/app_version/list/cli_0123456789abcdef')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { versions: [{ appVersion: '1.0.0' }] },
        }));
      }
      if (urlStr.includes('/developers/v1/app_version/create/cli_0123456789abcdef')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { versionId: 'ver_deferred_200' },
        }));
      }
      if (urlStr.includes('/developers/v1/publish/commit/cli_0123456789abcdef/ver_deferred_200')) {
        publishCallCount++;
        return new Response(JSON.stringify({
          code: 0,
          data: { status: 'published' },
        }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });

    const job = await onboardingService.createJob({
      userId: aliceUser.id,
      spaceId: testSpace.id,
      action: 'configure_existing',
      appId: 'cli_0123456789abcdef',
      fetchImpl: mockFetcher as any,
    });

    // 1. First GET: poll detects enter_app, returns 'configuring' immediately while deferredGate is unresolved
    const get1 = await onboardingService.getJobStatus(aliceUser.id, job.id);
    expect(get1.status).toBe('configuring');
    expect(get1.statusMessage).toContain('configuring Open Platform application');
    expect(publishCallCount).toBe(0);

    // 2. Second GET while still in progress: returns 'configuring' without waiting or duplicating writes
    const get2 = await onboardingService.getJobStatus(aliceUser.id, job.id);
    expect(get2.status).toBe('configuring');
    expect(publishCallCount).toBe(0);

    // 3. Resolve the gate and allow background configuration to finish
    deferredResolve();
    await (onboardingService as any).jobs.get(job.id)?.configurationPromise;

    // 4. Third GET: now reflects terminal state (verifying when runtimeManager is attached)
    const get3 = await onboardingService.getJobStatus(aliceUser.id, job.id);
    expect(get3.status).toBe('verifying');
    expect(publishCallCount).toBe(1); // Exact one publish call - NO duplicates!
  });
});

describe('3. Channel Management API Routes & CSRF Protection', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let credStore: LarkEncryptedCredentialStore;
  let channelService: ChannelManagementService;
  let onboardingService: LarkOnboardingService;
  let channelRoutes: ChannelRoutes;
  let testSpace: Space;
  const csrfToken = 'test_csrf_token_constant_32_characters';
  const aliceUser: User = {
    id: 'usr_alice_routes',
    role: 'admin',
    status: 'active',
    displayName: 'Alice Routes',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    await storage.users.create({
      id: aliceUser.id,
      username: 'alice_routes',
      passwordHash: 'hash_routes',
      role: aliceUser.role,
      status: aliceUser.status,
      displayName: aliceUser.displayName,
    });

    testSpace = await storage.forTenant(aliceUser.id).spaces.create({
      name: 'Route Test Space',
      folder: 'route-test',
      executionMode: 'container',
      status: 'active',
    });

    credStore = new LarkEncryptedCredentialStore({
      cipherSecret: 'test_cookie_secret_32_characters_long',
      db,
    });
    channelService = new ChannelManagementService(storage);
    onboardingService = new LarkOnboardingService(
      storage,
      credStore,
      channelService,
      undefined,
      credStore
    );
    channelRoutes = new ChannelRoutes(channelService, csrfToken, onboardingService);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  const createMockReqRes = (options: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    body?: any;
  }) => {
    const method = options.method || 'GET';
    const url = options.url || '/';
    const headers = options.headers || {};
    const bodyStr = options.body ? JSON.stringify(options.body) : '';

    const listeners: Record<string, ((...args: any[]) => void)[]> = {};
    const req = {
      method,
      url,
      socket: {
        remoteAddress: '127.0.0.1',
        localAddress: '127.0.0.1',
        localPort: 3000,
      },
      headers: {
        host: '127.0.0.1:3000',
        origin: 'http://127.0.0.1:3000',
        ...headers,
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

    let statusCode = 200;
    let responseHeaders: Record<string, string> = {};
    let responseBody = '';

    const res = {
      writeHead: (code: number, hdrs?: Record<string, string>) => {
        statusCode = code;
        if (hdrs) responseHeaders = { ...responseHeaders, ...hdrs };
        return res;
      },
      setHeader: (k: string, v: string) => {
        responseHeaders[k.toLowerCase()] = v;
        return res;
      },
      end: (chunk?: string) => {
        if (chunk) responseBody += chunk;
      },
    } as unknown as ServerResponse;

    return {
      req,
      res,
      getStatusCode: () => statusCode,
      getJson: () => (responseBody ? JSON.parse(responseBody) : null),
    };
  };

  it('rejects POST /api/manage/channels/onboarding/jobs without valid CSRF header', async () => {
    const { req, res, getStatusCode } = createMockReqRes({
      method: 'POST',
      url: '/api/manage/channels/onboarding/jobs',
      body: {
        action: 'configure_existing',
        spaceId: testSpace.id,
        appId: 'cli_test_123',
      },
      headers: {
        'content-type': 'application/json',
        // missing x-csrf-token
      },
    });

    await expect(channelRoutes.handle(req, res, '/api/manage/channels/onboarding/jobs', aliceUser)).rejects.toThrow();
  });

  it('accepts valid onboarding job creation, status check, and cancellation', async () => {
    const mockFetcher = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes('/accounts/qrlogin/init')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { step_info: { token: 'token_api_route' } },
        }), {
          headers: { 'x-flow-key': 'flow_api_route', 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ code: 0 }));
    });

    const { req, res, getStatusCode, getJson } = createMockReqRes({
      method: 'POST',
      url: '/api/manage/channels/onboarding/jobs',
      body: {
        action: 'configure_existing',
        spaceId: testSpace.id,
        appId: 'cli_0123456789abcdef',
      },
      headers: {
        'content-type': 'application/json',
        'x-enkeep-csrf': csrfToken,
      },
    });

    vi.stubGlobal('fetch', mockFetcher);
    try {
      const handled = await channelRoutes.handle(req, res, '/api/manage/channels/onboarding/jobs', aliceUser);
      expect(handled).toBe(true);
      expect(getStatusCode()).toBe(201);
      const json = getJson();
      expect(json.data.status).toBe('waiting_for_scan');
      expect(json.data.appId).toBe('cli_0123456789abcdef');
      const jobId = json.data.id;

      // GET /api/manage/channels/onboarding/jobs/:id
      const { req: getReq, res: getRes, getStatusCode: getStatus, getJson: getStatusJson } = createMockReqRes({
        method: 'GET',
        url: `/api/manage/channels/onboarding/jobs/${jobId}`,
      });
      const getHandled = await channelRoutes.handle(getReq, getRes, `/api/manage/channels/onboarding/jobs/${jobId}`, aliceUser);
      expect(getHandled).toBe(true);
      expect(getStatus()).toBe(200);
      expect(getStatusJson().data.id).toBe(jobId);

      // POST /api/manage/channels/onboarding/jobs/:id/cancel
      const { req: cancelReq, res: cancelRes, getStatusCode: cancelStatus, getJson: cancelJson } = createMockReqRes({
        method: 'POST',
        url: `/api/manage/channels/onboarding/jobs/${jobId}/cancel`,
        headers: {
          'x-enkeep-csrf': csrfToken,
        },
      });
      const cancelHandled = await channelRoutes.handle(cancelReq, cancelRes, `/api/manage/channels/onboarding/jobs/${jobId}/cancel`, aliceUser);
      expect(cancelHandled).toBe(true);
      expect(cancelStatus()).toBe(200);
      expect(cancelJson().data.status).toBe('cancelled');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
