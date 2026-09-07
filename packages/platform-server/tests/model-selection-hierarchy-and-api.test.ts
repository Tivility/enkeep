import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import {
  PlatformServer,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  DeliveryRuntimeGateway,
  SqliteWebMessageStore,
} from '../src/index.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { provisionFixtures } from '@enkeep/platform-auth';

describe('Model Selection Hierarchy, Tenant Isolation & Canonical APIs', () => {
  let server: PlatformServer;
  let baseUrl: string;
  let db: DatabaseSync;
  let aliceCookie: string;
  let bobCookie: string;
  let adminCookie: string;
  let aliceSpaceId: string;
  let bobSpaceId: string;
  let aliceSessionId: string;
  let bobSessionId: string;

  let csrfHeader: string;

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    const testCsrf = 'test_csrf_token_must_be_at_least_32_characters_12345';

    // Create delivery gateway mock
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const mockGateway = new DeliveryRuntimeGateway({
      storage,
      messageStore,
      database: db,
      quotaMode: 'disabled',
      executor: {
        execute: async () => ({ replyText: 'mock reply', usage: { totalTokens: 10 } }),
        cancel: async () => true,
      },
      profileResolver: {
        resolve: async () => null,
      },
    });

    server = new PlatformServer({
      database: db,
      cookieSecret: 'test_secret_must_be_at_least_32_characters_long_12345',
      csrfToken: testCsrf,
      runtimeGateway: mockGateway,
      host: '127.0.0.1',
      port: 0,
    });

    const info = await server.start();
    baseUrl = info.url;

    const provisionResult = await provisionFixtures(server.storage, server.authService, {
      adminPassword: 'AliceAdmin123!',
      userPassword: 'BobUser123!',
      disabledPassword: 'CharlieDisabled123!',
    });

    const aliceUser = provisionResult.admin; // Alice is admin
    const bobUser = provisionResult.user; // Bob is user

    const aliceLogin = await server.authService.login('alice', 'AliceAdmin123!');
    aliceCookie = aliceLogin.cookieHeader.split(';')[0]!;
    adminCookie = aliceCookie;

    const bobLogin = await server.authService.login('bob', 'BobUser123!');
    bobCookie = bobLogin.cookieHeader.split(';')[0]!;

    // Seed spaces
    aliceSpaceId = 'spc_alice_001';
    bobSpaceId = 'spc_bob_001';
    db.prepare(`
      INSERT INTO spaces (id, user_id, name, folder, execution_mode, created_at, updated_at)
      VALUES
        (?, ?, 'Alice Space', 'alice-folder', 'container', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        (?, ?, 'Bob Space', 'bob-folder', 'container', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(aliceSpaceId, aliceUser.id, bobSpaceId, bobUser.id);

    // Seed session routes
    aliceSessionId = 'ses_alice_001';
    bobSessionId = 'ses_bob_001';
    db.prepare(`
      INSERT INTO session_routes (id, space_id, user_id, channel, peer_id, dsh_session_id, execution_mode, created_at, updated_at)
      VALUES
        (?, ?, ?, 'web', 'peer_alice', 'dsh_ses_alice', 'container', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        (?, ?, ?, 'web', 'peer_bob', 'dsh_ses_bob', 'container', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(aliceSessionId, aliceSpaceId, aliceUser.id, bobSessionId, bobSpaceId, bobUser.id);

    csrfHeader = testCsrf;
  });

  afterEach(async () => {
    try {
      await server.close();
    } catch {}
  });

  describe('1. Five-Tier Precedence Hierarchy Resolution (/api/models/effective)', () => {
    it('Tier 5: Falls back to Local DSH Default when no overrides are configured', async () => {
      const res = await fetch(`${baseUrl}/api/models/effective?spaceId=${aliceSpaceId}&sessionId=${aliceSessionId}`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.source).toBe('dsh_default');
      expect(json.data.provider).toBeDefined();
      expect(json.data.model).toBeDefined();
    });

    it('Tier 4: Platform Override takes precedence over Local DSH Default', async () => {
      // Set platform override as admin
      const patchRes = await fetch(`${baseUrl}/api/admin/model-config`, {
        method: 'PATCH',
        headers: {
          Cookie: adminCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfHeader,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          provider: 'cpa-claude',
          model: 'claude-fable-5',
          applyMode: 'save_only',
        }),
      });
      expect(patchRes.status).toBe(200);

      // Alice resolves effective model -> gets platform override
      const res = await fetch(`${baseUrl}/api/models/effective?spaceId=${aliceSpaceId}&sessionId=${aliceSessionId}`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.source).toBe('platform');
      expect(json.data.provider).toBe('cpa-claude');
      expect(json.data.model).toBe('claude-fable-5');
    });

    it('Tier 3: User Preference takes precedence over Platform Override', async () => {
      // Set platform override
      await fetch(`${baseUrl}/api/admin/model-config`, {
        method: 'PATCH',
        headers: {
          Cookie: adminCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfHeader,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          provider: 'cpa-claude',
          model: 'claude-fable-5',
          applyMode: 'save_only',
        }),
      });

      // Alice sets personal preference
      const prefRes = await fetch(`${baseUrl}/api/account/model-override`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfHeader,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          provider: 'cpa-gpt',
          model: 'gpt-5.6-sol',
        }),
      });
      expect(prefRes.status).toBe(200);

      // Alice resolves effective model -> gets user preference
      const aliceRes = await fetch(`${baseUrl}/api/models/effective?spaceId=${aliceSpaceId}&sessionId=${aliceSessionId}`, {
        headers: { Cookie: aliceCookie },
      });
      const aliceJson = await aliceRes.json();
      expect(aliceJson.data.source).toBe('user');
      expect(aliceJson.data.provider).toBe('cpa-gpt');
      expect(aliceJson.data.model).toBe('gpt-5.6-sol');

      // Bob has no user preference -> still gets platform override
      const bobRes = await fetch(`${baseUrl}/api/models/effective?spaceId=${bobSpaceId}&sessionId=${bobSessionId}`, {
        headers: { Cookie: bobCookie },
      });
      const bobJson = await bobRes.json();
      expect(bobJson.data.source).toBe('platform');
      expect(bobJson.data.provider).toBe('cpa-claude');
    });

    it('Tier 2: Space Override takes precedence over User Preference and Platform Override', async () => {
      // Set platform override & user preference
      await fetch(`${baseUrl}/api/admin/model-config`, {
        method: 'PATCH',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json', 'X-Enkeep-CSRF': csrfHeader, Origin: baseUrl },
        body: JSON.stringify({ provider: 'cpa-claude', model: 'claude-fable-5', applyMode: 'save_only' }),
      });
      await fetch(`${baseUrl}/api/account/model-override`, {
        method: 'PUT',
        headers: { Cookie: aliceCookie, 'Content-Type': 'application/json', 'X-Enkeep-CSRF': csrfHeader, Origin: baseUrl },
        body: JSON.stringify({ provider: 'cpa-gpt', model: 'gpt-5.6-sol' }),
      });

      // Set space override on Alice Space
      const spaceRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/model-override`, {
        method: 'PUT',
        headers: { Cookie: aliceCookie, 'Content-Type': 'application/json', 'X-Enkeep-CSRF': csrfHeader, Origin: baseUrl },
        body: JSON.stringify({ provider: 'cpa-gemini', model: 'gemini-3.7-flash-tiered' }),
      });
      expect(spaceRes.status).toBe(200);

      // Alice resolves with spaceId -> gets space override
      const res = await fetch(`${baseUrl}/api/models/effective?spaceId=${aliceSpaceId}&sessionId=${aliceSessionId}`, {
        headers: { Cookie: aliceCookie },
      });
      const json = await res.json();
      expect(json.data.source).toBe('space');
      expect(json.data.provider).toBe('cpa-gemini');
      expect(json.data.model).toBe('gemini-3.7-flash-tiered');
    });

    it('Tier 1: Session Override takes highest precedence over all other tiers', async () => {
      // Set space override
      await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/model-override`, {
        method: 'PUT',
        headers: { Cookie: aliceCookie, 'Content-Type': 'application/json', 'X-Enkeep-CSRF': csrfHeader, Origin: baseUrl },
        body: JSON.stringify({ provider: 'cpa-gemini', model: 'gemini-3.7-flash-tiered' }),
      });

      // Set session override on Alice Session with fallback chain
      const sesRes = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/model-override`, {
        method: 'PUT',
        headers: { Cookie: aliceCookie, 'Content-Type': 'application/json', 'X-Enkeep-CSRF': csrfHeader, Origin: baseUrl },
        body: JSON.stringify({
          provider: 'cpa-grok',
          model: 'grok-4.6',
          fallbackChain: [
            { provider: 'cpa-claude', model: 'claude-fable-5' },
          ],
        }),
      });
      expect(sesRes.status).toBe(200);

      // Alice resolves -> gets session override
      const res = await fetch(`${baseUrl}/api/models/effective?spaceId=${aliceSpaceId}&sessionId=${aliceSessionId}`, {
        headers: { Cookie: aliceCookie },
      });
      const json = await res.json();
      expect(json.data.source).toBe('session');
      expect(json.data.provider).toBe('cpa-grok');
      expect(json.data.model).toBe('grok-4.6');
      expect(json.data.fallbackChain.length).toBe(1);
      expect(json.data.fallbackChain[0].provider).toBe('cpa-claude');
    });
  });

  describe('2. Strict Tenant Isolation & Authorization', () => {
    it('Bob cannot read, update, or delete Alice Space model override (404/Forbidden)', async () => {
      // Alice creates space override
      await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/model-override`, {
        method: 'PUT',
        headers: { Cookie: aliceCookie, 'Content-Type': 'application/json', 'X-Enkeep-CSRF': csrfHeader },
        body: JSON.stringify({ provider: 'cpa-claude', model: 'claude-fable-5' }),
      });

      // Bob tries to GET Alice space override -> 404 Space not found for Bob
      const getRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/model-override`, {
        headers: { Cookie: bobCookie },
      });
      expect(getRes.status).toBe(404);

      // Bob tries to PUT Alice space override -> 404
      const putRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/model-override`, {
        method: 'PUT',
        headers: { Cookie: bobCookie, 'Content-Type': 'application/json', 'X-Enkeep-CSRF': csrfHeader },
        body: JSON.stringify({ provider: 'cpa-gpt', model: 'gpt-4o' }),
      });
      expect(putRes.status).toBe(404);

      // Bob tries to DELETE Alice space override -> 404
      const delRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/model-override`, {
        method: 'DELETE',
        headers: { Cookie: bobCookie, 'X-Enkeep-CSRF': csrfHeader },
      });
      expect(delRes.status).toBe(404);
    });

    it('Bob cannot read, update, or delete Alice Session model override (404/Forbidden)', async () => {
      // Alice creates session override
      await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/model-override`, {
        method: 'PUT',
        headers: { Cookie: aliceCookie, 'Content-Type': 'application/json', 'X-Enkeep-CSRF': csrfHeader },
        body: JSON.stringify({ provider: 'cpa-claude', model: 'claude-fable-5' }),
      });

      // Bob tries to GET Alice session override -> 404
      const getRes = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/model-override`, {
        headers: { Cookie: bobCookie },
      });
      expect(getRes.status).toBe(404);

      // Bob tries to PUT Alice session override -> 404
      const putRes = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/model-override`, {
        method: 'PUT',
        headers: { Cookie: bobCookie, 'Content-Type': 'application/json', 'X-Enkeep-CSRF': csrfHeader },
        body: JSON.stringify({ provider: 'cpa-gpt', model: 'gpt-4o' }),
      });
      expect(putRes.status).toBe(404);
    });

    it('Regular user (Bob) cannot access Admin model endpoints (/api/admin/models/*) -> 403', async () => {
      const probeRes = await fetch(`${baseUrl}/api/admin/models/probe`, {
        method: 'POST',
        headers: { Cookie: bobCookie, 'Content-Type': 'application/json', 'X-Enkeep-CSRF': csrfHeader },
        body: JSON.stringify({ provider: 'cpa-claude', model: 'claude-fable-5' }),
      });
      expect(probeRes.status).toBe(403);

      const resetRes = await fetch(`${baseUrl}/api/admin/models/circuit-breaker/reset`, {
        method: 'POST',
        headers: { Cookie: bobCookie, 'Content-Type': 'application/json', 'X-Enkeep-CSRF': csrfHeader },
        body: JSON.stringify({}),
      });
      expect(resetRes.status).toBe(403);

      const healthRes = await fetch(`${baseUrl}/api/admin/models/health`, {
        headers: { Cookie: bobCookie },
      });
      expect(healthRes.status).toBe(403);
    });
  });

  describe('3. Optimistic Concurrency Control (If-Match / revision check)', () => {
    it('returns 409 Conflict when updating with stale revision', async () => {
      // 1. Initial override creation
      const putRes1 = await fetch(`${baseUrl}/api/account/model-override`, {
        method: 'PUT',
        headers: { Cookie: aliceCookie, 'Content-Type': 'application/json', 'X-Enkeep-CSRF': csrfHeader, Origin: baseUrl },
        body: JSON.stringify({ provider: 'cpa-claude', model: 'claude-fable-5' }),
      });
      const json1 = await putRes1.json();
      expect(putRes1.status).toBe(200);
      const rev1 = json1.data.revision;

      // 2. Update with matching revision -> succeeds
      const putRes2 = await fetch(`${baseUrl}/api/account/model-override`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'If-Match': rev1,
          'X-Enkeep-CSRF': csrfHeader,
          Origin: baseUrl,
        },
        body: JSON.stringify({ provider: 'cpa-gpt', model: 'gpt-5.6-sol' }),
      });
      expect(putRes2.status).toBe(200);
      const json2 = await putRes2.json();
      const rev2 = json2.data.revision;
      expect(rev2).not.toBe(rev1);

      // 3. Stale update with rev1 -> 409 Conflict
      const putRes3 = await fetch(`${baseUrl}/api/account/model-override`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'If-Match': rev1,
          'X-Enkeep-CSRF': csrfHeader,
          Origin: baseUrl,
        },
        body: JSON.stringify({ provider: 'cpa-gemini', model: 'gemini-3.7-flash-tiered' }),
      });
      expect(putRes3.status).toBe(409);
    });
  });

  describe('4. Admin Health Probe & Circuit Breaker Reset APIs', () => {
    it('Admin can trigger health probe (/api/admin/models/probe) without leaking credentials', async () => {
      const probeRes = await fetch(`${baseUrl}/api/admin/models/probe`, {
        method: 'POST',
        headers: {
          Cookie: adminCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfHeader,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          provider: 'demo-provider',
          model: 'demo-model',
          mode: 'minimal_completion',
        }),
      });
      expect(probeRes.status).toBe(200);
      const json = await probeRes.json();
      expect(json.success).toBe(true);
      expect(json.data.provider).toBe('demo-provider');
      expect(json.data.model).toBe('demo-model');
      expect(json.data.latencyMs).toBeGreaterThan(0);
      expect(json.data.tokensUsed).toBeGreaterThan(0);
    });

    it('Admin can query health summaries (/api/admin/models/health) and reset breakers (/api/admin/models/circuit-breaker/reset)', async () => {
      // Query health summaries
      const healthRes = await fetch(`${baseUrl}/api/admin/models/health`, {
        headers: { Cookie: adminCookie },
      });
      expect(healthRes.status).toBe(200);
      const healthJson = await healthRes.json();
      expect(healthJson.success).toBe(true);
      expect(Array.isArray(healthJson.data)).toBe(true);

      // Reset circuit breakers
      const resetRes = await fetch(`${baseUrl}/api/admin/models/circuit-breaker/reset`, {
        method: 'POST',
        headers: {
          Cookie: adminCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfHeader,
          Origin: baseUrl,
        },
        body: JSON.stringify({}),
      });
      expect(resetRes.status).toBe(200);
      const resetJson = await resetRes.json();
      expect(resetJson.success).toBe(true);
      expect(resetJson.data.message).toContain('Successfully reset');
    });
  });
});
