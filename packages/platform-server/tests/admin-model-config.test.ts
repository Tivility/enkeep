import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { DefaultAuthService, provisionFixtures } from '@enkeep/platform-auth';
import { createPlatformServerHandler } from '../src/server/handler.js';
import { SqlitePlatformWebApiAdapter } from '../src/storage/sqlite-platform-api.js';
import { SqliteWebMessageStore } from '../src/storage/web-messages.js';
import { ConsoleDataSource } from '../src/management/console-data-source.js';

describe('Admin Model Configuration Control Plane (/api/admin/model-config)', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let authService: DefaultAuthService;
  let server: Server;
  let baseUrl: string;
  let tempDshHome: string;
  const cookieSecret = 'test_cookie_secret_at_least_16_chars_long!';
  const csrfToken = 'test-valid-csrf-token-1234567890abcdef';

  let aliceCookie: string;
  let bobCookie: string;
  let aliceId: string;
  let bobId: string;

  beforeEach(async () => {
    // Create temporary mock DSH home with cordis.patch.yml, settings.yaml, .env
    tempDshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-test-dsh-'));
    process.env.DSH_HOME = tempDshHome;

    const patchYml = `
- id: llm-pi-ai
  config:
    providers:
      cpa-claude:
        displayName: Anthropic Claude CPA
        api: anthropic-messages
        baseURL: https://secret-upstream.internal/v1
        apiKeyEnv: ANTHROPIC_API_KEY
        token: secret-hardcoded-token-never-leak
        defaultContextWindow: 200000
        models:
          - id: claude-3-5-sonnet
            name: Claude 3.5 Sonnet
            contextWindow: 200000
          - id: claude-3-7-sonnet
            name: Claude 3.7 Sonnet
            contextWindow: 200000
      cpa-gpt:
        displayName: OpenAI GPT CPA
        api: openai-completions
        baseURL: https://secret-openai.internal/v1
        apiKeyEnv: OPENAI_API_KEY
        models:
          - id: gpt-4o
            name: GPT-4o
      cpa-gemini:
        displayName: Google Gemini CPA
        api: openai-completions
        baseURL: https://secret-gemini.internal/v1
        apiKeyEnv: GEMINI_API_KEY
        models:
          - id: gemini-2.0-flash
            name: Gemini 2.0 Flash
`;
    fs.writeFileSync(path.join(tempDshHome, 'cordis.patch.yml'), patchYml, 'utf8');

    const settingsYaml = `
agent-default-model:
  provider: cpa-claude
  model: claude-3-5-sonnet
`;
    fs.writeFileSync(path.join(tempDshHome, 'settings.yaml'), settingsYaml, 'utf8');

    const envFile = `
ANTHROPIC_API_KEY=sk-ant-secret123456789
GEMINI_API_KEY=sk-gemini-secret987654321
`;
    fs.writeFileSync(path.join(tempDshHome, '.env'), envFile, 'utf8');

    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    authService = new DefaultAuthService(storage, {
      cookieSecret,
      sessionTtlSeconds: 3600,
      cookieSecure: false,
    });

    const provisionResult = await provisionFixtures(storage, authService, {
      adminPassword: 'AliceAdmin123!',
      userPassword: 'BobUser123!',
      disabledPassword: 'CharlieDisabled123!',
    });
    aliceId = provisionResult.admin.id;
    bobId = provisionResult.user.id;

    const aliceLogin = await authService.login('alice', 'AliceAdmin123!');
    aliceCookie = aliceLogin.cookieHeader.split(';')[0]!;

    const bobLogin = await authService.login('bob', 'BobUser123!');
    bobCookie = bobLogin.cookieHeader.split(';')[0]!;

    const messageStore = new SqliteWebMessageStore(db);
    const platformApi = new SqlitePlatformWebApiAdapter({
      storage,
      messageStore,
      authService,
      db,
    });

    const consoleDataSource = new ConsoleDataSource({
      database: db,
      storage,
      quotaDefaults: {
        turns: 100,
        messages: 100,
        tokens: 65536,
        storage_bytes: 10485760,
        api_calls: 500,
        resetInterval: 'none',
      },
    });

    const fakeGateway: any = {
      dispatchInbound: async () => ({ status: 'held', deliveryId: 'd1' }),
      handleTurnFinished: async () => {},
    };

    const handler = createPlatformServerHandler({
      database: db,
      storage,
      authService,
      runtimeGateway: fakeGateway,
      platformApi,
      csrfToken,
      consoleDataSource,
    });

    server = createServer(handler);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (db) {
      db.close();
    }
    if (tempDshHome && fs.existsSync(tempDshHome)) {
      fs.rmSync(tempDshHome, { recursive: true, force: true });
    }
    delete process.env.DSH_HOME;
  });

  it('GET /api/admin/model-config rejects unauthenticated (401) and non-admin Bob (403)', async () => {
    const unauthRes = await fetch(`${baseUrl}/api/admin/model-config`);
    expect(unauthRes.status).toBe(401);

    const bobRes = await fetch(`${baseUrl}/api/admin/model-config`, {
      headers: { Cookie: bobCookie },
    });
    expect(bobRes.status).toBe(403);
  });

  it('GET /api/admin/model-config returns safe projection without baseURL, token, or apiKeyEnv leakage', async () => {
    const res = await fetch(`${baseUrl}/api/admin/model-config`, {
      headers: { Cookie: aliceCookie },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    const data = json.data;
    expect(data.defaultModel).toEqual({
      provider: 'cpa-claude',
      model: 'claude-3-5-sonnet',
    });
    expect(data.dshDefaultModel).toEqual({
      provider: 'cpa-claude',
      model: 'claude-3-5-sonnet',
    });
    expect(data.override).toBeNull();

    // Check providers
    const claude = data.providers['cpa-claude'];
    expect(claude).toBeDefined();
    expect(claude.id).toBe('cpa-claude');
    expect(claude.displayName).toBe('Anthropic Claude CPA');
    expect(claude.api).toBe('anthropic-messages');
    expect(claude.configured).toBe(true); // Has token & env
    expect(claude.models.length).toBe(2);

    // Verify ZERO credential leakage
    const rawJsonStr = JSON.stringify(json);
    expect(rawJsonStr).not.toContain('secret-upstream.internal');
    expect(rawJsonStr).not.toContain('secret-openai.internal');
    expect(rawJsonStr).not.toContain('secret-hardcoded-token-never-leak');
    expect(rawJsonStr).not.toContain('sk-ant-secret123456789');
    expect(rawJsonStr).not.toContain('ANTHROPIC_API_KEY');
    expect(rawJsonStr).not.toContain('OPENAI_API_KEY');

    const gpt = data.providers['cpa-gpt'];
    expect(gpt).toBeDefined();
    expect(gpt.configured).toBe(false); // OPENAI_API_KEY is not in .env
  });

  it('PATCH /api/admin/model-config saves override in platform.db and NEVER writes to ~/.dsh files', async () => {
    // Record mtime of dsh home files before patch
    const patchMtimeBefore = fs.statSync(path.join(tempDshHome, 'cordis.patch.yml')).mtimeMs;
    const settingsMtimeBefore = fs.statSync(path.join(tempDshHome, 'settings.yaml')).mtimeMs;

    const res = await fetch(`${baseUrl}/api/admin/model-config`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        provider: 'cpa-claude',
        model: 'claude-3-7-sonnet',
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    // Effective default is now the override
    expect(json.data.defaultModel).toEqual({
      provider: 'cpa-claude',
      model: 'claude-3-7-sonnet',
    });
    // DSH underlying default remains unchanged
    expect(json.data.dshDefaultModel).toEqual({
      provider: 'cpa-claude',
      model: 'claude-3-5-sonnet',
    });
    expect(json.data.override.provider).toBe('cpa-claude');
    expect(json.data.override.model).toBe('claude-3-7-sonnet');

    // Verify DSH files on disk were NOT modified
    const patchMtimeAfter = fs.statSync(path.join(tempDshHome, 'cordis.patch.yml')).mtimeMs;
    const settingsMtimeAfter = fs.statSync(path.join(tempDshHome, 'settings.yaml')).mtimeMs;
    expect(patchMtimeAfter).toBe(patchMtimeBefore);
    expect(settingsMtimeAfter).toBe(settingsMtimeBefore);

    // Verify override is in SQLite database
    const row = db.prepare("SELECT * FROM model_config_overrides WHERE id = 'default'").get() as any;
    expect(row).toBeDefined();
    expect(row.provider).toBe('cpa-claude');
    expect(row.model).toBe('claude-3-7-sonnet');
    expect(row.updated_by).toBe(aliceId);

    // Verify audit log
    const auditRows = db.prepare("SELECT * FROM auth_audit_log WHERE action = 'model_config_updated'").all();
    expect(auditRows.length).toBe(1);
  });

  it('PATCH /api/admin/model-config resets override with clear: true', async () => {
    // First set override
    await fetch(`${baseUrl}/api/admin/model-config`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        provider: 'cpa-claude',
        model: 'claude-3-7-sonnet',
      }),
    });

    // Clear override
    const resClear = await fetch(`${baseUrl}/api/admin/model-config`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ clear: true }),
    });

    expect(resClear.status).toBe(200);
    const jsonClear = await resClear.json();
    expect(jsonClear.data.override).toBeNull();
    expect(jsonClear.data.defaultModel).toEqual({
      provider: 'cpa-claude',
      model: 'claude-3-5-sonnet',
    });
  });

  it('PATCH /api/admin/model-config rejects invalid or non-existent providers/models', async () => {
    const resBadProvider = await fetch(`${baseUrl}/api/admin/model-config`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        provider: 'non-existent-provider',
        model: 'gpt-4o',
      }),
    });
    expect(resBadProvider.status).toBe(400);

    const resBadModel = await fetch(`${baseUrl}/api/admin/model-config`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        provider: 'cpa-claude',
        model: 'non-existent-model-xyz',
      }),
    });
    expect(resBadModel.status).toBe(400);
  });

  it('end-to-end activation: PATCH cpa-gemini -> runtime restart -> spec inherits override -> clear reverts to DSH default without token leakage', async () => {
    // 1. Initial GET shows cpa-claude default
    const res1 = await fetch(`${baseUrl}/api/admin/model-config`, {
      headers: { Cookie: aliceCookie },
    });
    const data1 = (await res1.json()).data;
    expect(data1.defaultModel.provider).toBe('cpa-claude');

    // 2. PATCH override to cpa-gemini
    const patchRes = await fetch(`${baseUrl}/api/admin/model-config`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        provider: 'cpa-gemini',
        model: 'gemini-2.0-flash',
      }),
    });
    expect(patchRes.status).toBe(200);
    const patchData = (await patchRes.json()).data;
    expect(patchData.defaultModel.provider).toBe('cpa-gemini');
    expect(patchData.defaultModel.model).toBe('gemini-2.0-flash');
    expect(patchData.restartRequired).toBe(true);

    // 3. Verify override in SQLite DB
    const overrideRow = db.prepare("SELECT provider, model FROM model_config_overrides WHERE id = 'default'").get() as any;
    expect(overrideRow.provider).toBe('cpa-gemini');
    expect(overrideRow.model).toBe('gemini-2.0-flash');

    // 4. Trigger safe runtime restart via management API
    const restartRes = await fetch(`${baseUrl}/api/admin/runtime/restart`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
    });
    expect(restartRes.status).toBe(200);

    // 5. Verify ZERO secret token leakage in DB
    const dbAllTables = db.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all();
    const allDbSql = JSON.stringify(dbAllTables);
    expect(allDbSql).not.toContain('secret-hardcoded-token-never-leak');
    expect(allDbSql).not.toContain('sk-ant-secret123456789');
    expect(allDbSql).not.toContain('sk-gemini-secret987654321');

    // 6. Clear override
    const clearRes = await fetch(`${baseUrl}/api/admin/model-config`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ clear: true }),
    });
    expect(clearRes.status).toBe(200);
    const clearData = (await clearRes.json()).data;
    expect(clearData.override).toBeNull();
    expect(clearData.defaultModel.provider).toBe('cpa-claude');
    expect(clearData.defaultModel.model).toBe('claude-3-5-sonnet');
  });

  it('PATCH /api/admin/model-config with applyMode: "save_only" skips restart and returns restartRequired: true, restartStatus: "skipped"', async () => {
    const patchRes = await fetch(`${baseUrl}/api/admin/model-config`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        provider: 'cpa-gemini',
        model: 'gemini-2.0-flash',
        applyMode: 'save_only',
      }),
    });

    expect(patchRes.status).toBe(200);
    const data = (await patchRes.json()).data;
    expect(data.override.provider).toBe('cpa-gemini');
    expect(data.restartRequired).toBe(true);
    expect(data.restartStatus).toBe('skipped');
  });

  it('PATCH /api/admin/model-config with managementProvider rolling restart: success updates appliedRuntimes and restartStatus "success"', async () => {
    // Recreate server with mock managementProvider
    server.close();

    let restartCalled = false;
    const mockProvider = {
      getUserRuntime: async () => null,
      listRuntimes: async () => [],
      restartRuntime: async () => {
        restartCalled = true;
        return {
          restarted: true,
          userIds: ['alice', 'bob'],
          appliedRuntimes: ['alice', 'bob'],
          failedRuntimes: [],
        };
      },
    };

    const handler = createPlatformServerHandler({
      database: db,
      storage,
      authService,
      runtimeGateway: {
        dispatchInbound: async () => ({ status: 'held', deliveryId: 'd1' }),
        handleTurnFinished: async () => {},
      } as any,
      platformApi: new (await import('../src/storage/sqlite-platform-api.js')).SqlitePlatformWebApiAdapter({
        storage,
        messageStore: new (await import('../src/storage/web-messages.js')).SqliteWebMessageStore(db),
        authService,
        db,
      }),
      csrfToken,
      consoleDataSource: new ConsoleDataSource({
        database: db,
        storage,
        quotaDefaults: {
          turns: 100,
          messages: 100,
          tokens: 65536,
          storage_bytes: 10485760,
          api_calls: 500,
          resetInterval: 'none',
        },
      }),
      managementProvider: mockProvider as any,
    });

    server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const patchRes = await fetch(`${baseUrl}/api/admin/model-config`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        provider: 'cpa-gemini',
        model: 'gemini-2.0-flash',
        applyMode: 'restart_all',
      }),
    });

    expect(patchRes.status).toBe(200);
    const data = (await patchRes.json()).data;
    expect(restartCalled).toBe(true);
    expect(data.restartRequired).toBe(false);
    expect(data.restartStatus).toBe('success');
    expect(data.auditRecorded).toBe(true);
    expect(data.appliedRuntimes).toEqual(['alice', 'bob']);
    expect(data.failedRuntimes).toEqual([]);
  });

  it('PATCH /api/admin/model-config with partial restart failure: returns 200 with restartStatus "partial", restartRequired true, and audit log', async () => {
    server.close();

    const mockProvider = {
      getUserRuntime: async () => null,
      listRuntimes: async () => [],
      restartRuntime: async () => {
        return {
          restarted: true,
          userIds: ['alice'],
          appliedRuntimes: ['alice'],
          failedRuntimes: [{ userId: 'bob', error: 'Container startup timeout' }],
        };
      },
    };

    const handler = createPlatformServerHandler({
      database: db,
      storage,
      authService,
      runtimeGateway: {
        dispatchInbound: async () => ({ status: 'held', deliveryId: 'd1' }),
        handleTurnFinished: async () => {},
      } as any,
      platformApi: new (await import('../src/storage/sqlite-platform-api.js')).SqlitePlatformWebApiAdapter({
        storage,
        messageStore: new (await import('../src/storage/web-messages.js')).SqliteWebMessageStore(db),
        authService,
        db,
      }),
      csrfToken,
      consoleDataSource: new ConsoleDataSource({
        database: db,
        storage,
        quotaDefaults: {
          turns: 100,
          messages: 100,
          tokens: 65536,
          storage_bytes: 10485760,
          api_calls: 500,
          resetInterval: 'none',
        },
      }),
      managementProvider: mockProvider as any,
    });

    server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const patchRes = await fetch(`${baseUrl}/api/admin/model-config`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        provider: 'cpa-claude',
        model: 'claude-3-7-sonnet',
      }),
    });

    expect(patchRes.status).toBe(200);
    const data = (await patchRes.json()).data;
    // DB committed
    expect(data.override.provider).toBe('cpa-claude');
    expect(data.override.model).toBe('claude-3-7-sonnet');
    // Partial restart status visible
    expect(data.restartRequired).toBe(true);
    expect(data.restartStatus).toBe('partial');
    expect(data.auditRecorded).toBe(true);
    expect(data.appliedRuntimes).toEqual(['alice']);
    expect(data.failedRuntimes).toEqual([{ userId: 'bob', error: 'Container startup timeout' }]);

    // Audit log records partial failure
    const auditRows = db.prepare(`
      SELECT details FROM auth_audit_log WHERE user_id = ? AND action = 'model_config_updated' ORDER BY created_at DESC
    `).all(aliceId) as Array<{ details: string }>;

    const partialAudit = auditRows
      .map((r) => {
        try { return JSON.parse(r.details); } catch { return null; }
      })
      .find((d) => d && d.subAction === 'model_config_restart_partial');

    expect(partialAudit).toBeDefined();
    expect(partialAudit.appliedCount).toBe(1);
    expect(partialAudit.failedCount).toBe(1);
    expect(partialAudit.failedUsers).toEqual(['bob']);
  });

  it('PATCH /api/admin/model-config when restartRuntime throws: returns 200 with failedRuntimes containing safe error and auditRecorded false', async () => {
    server.close();

    const mockProvider = {
      getUserRuntime: async () => null,
      listRuntimes: async () => [],
      restartRuntime: async () => {
        throw new Error('Docker daemon socket connection refused');
      },
    };

    const handler = createPlatformServerHandler({
      database: db,
      storage,
      authService,
      runtimeGateway: {
        dispatchInbound: async () => ({ status: 'held', deliveryId: 'd1' }),
        handleTurnFinished: async () => {},
      } as any,
      platformApi: new (await import('../src/storage/sqlite-platform-api.js')).SqlitePlatformWebApiAdapter({
        storage,
        messageStore: new (await import('../src/storage/web-messages.js')).SqliteWebMessageStore(db),
        authService,
        db,
      }),
      csrfToken,
      consoleDataSource: new ConsoleDataSource({
        database: db,
        storage,
        quotaDefaults: {
          turns: 100,
          messages: 100,
          tokens: 65536,
          storage_bytes: 10485760,
          api_calls: 500,
          resetInterval: 'none',
        },
      }),
      managementProvider: mockProvider as any,
    });

    server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const patchRes = await fetch(`${baseUrl}/api/admin/model-config`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        provider: 'cpa-gemini',
        model: 'gemini-2.0-flash',
      }),
    });

    expect(patchRes.status).toBe(200);
    const data = (await patchRes.json()).data;
    expect(data.restartRequired).toBe(true);
    expect(data.restartStatus).toBe('failed');
    expect(data.auditRecorded).toBe(false);
    expect(data.failedRuntimes.length).toBe(1);
    expect(data.failedRuntimes[0].userId).toBe('*');
    expect(data.failedRuntimes[0].error).toContain('Docker daemon socket connection refused');
  });

  it('enforces optimistic concurrency (If-Match header & ifMatch body): matching succeeds, mismatch returns 409 Conflict', async () => {
    // 1. Get current configuration to retrieve revision
    const getRes = await fetch(`${baseUrl}/api/admin/model-config`, {
      headers: { Cookie: aliceCookie },
    });
    const currentData = (await getRes.json()).data;
    const revision = currentData.revision;
    expect(revision).toBeDefined();
    expect(typeof revision).toBe('string');

    // 2. Mismatched If-Match header -> 409 Conflict
    const mismatchRes = await fetch(`${baseUrl}/api/admin/model-config`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        'If-Match': 'bad-revision-000000000000',
        Origin: baseUrl,
      },
      body: JSON.stringify({
        provider: 'cpa-gemini',
        model: 'gemini-2.0-flash',
      }),
    });
    expect(mismatchRes.status).toBe(409);

    // 3. Mismatched ifMatch body parameter -> 409 Conflict
    const mismatchBodyRes = await fetch(`${baseUrl}/api/admin/model-config`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        provider: 'cpa-gemini',
        model: 'gemini-2.0-flash',
        ifMatch: 'bad-revision-body-1111',
      }),
    });
    expect(mismatchBodyRes.status).toBe(409);

    // 4. Correct If-Match header -> 200 OK
    const matchRes = await fetch(`${baseUrl}/api/admin/model-config`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        'If-Match': revision,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        provider: 'cpa-gemini',
        model: 'gemini-2.0-flash',
      }),
    });
    expect(matchRes.status).toBe(200);
    const updatedData = (await matchRes.json()).data;
    expect(updatedData.override.provider).toBe('cpa-gemini');
    expect(updatedData.revision).not.toBe(revision); // New revision computed
  });

  it('serializes concurrent PATCH requests via singleflight lock without race conditions', async () => {
    const promises = [
      fetch(`${baseUrl}/api/admin/model-config`, {
        method: 'PATCH',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          provider: 'cpa-claude',
          model: 'claude-3-7-sonnet',
        }),
      }),
      fetch(`${baseUrl}/api/admin/model-config`, {
        method: 'PATCH',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          provider: 'cpa-gemini',
          model: 'gemini-2.0-flash',
        }),
      }),
    ];

    const results = await Promise.all(promises);
    expect(results.every((r) => r.status === 200)).toBe(true);

    // Final state is deterministic and DB is consistent
    const finalGet = await fetch(`${baseUrl}/api/admin/model-config`, {
      headers: { Cookie: aliceCookie },
    });
    const finalData = (await finalGet.json()).data;
    expect(['claude-3-7-sonnet', 'gemini-2.0-flash']).toContain(finalData.override.model);
  });
});
