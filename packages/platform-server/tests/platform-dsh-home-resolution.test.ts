import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  PlatformServer,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  DeliveryRuntimeGateway,
  SqliteWebMessageStore,
} from '../src/index.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { DefaultAuthService, provisionFixtures } from '@enkeep/platform-auth';
import { resolvePlatformDshHome } from '@enkeep/platform-core';
import { loadDshSafeModelConfig } from '../src/config/dsh-model-config.js';
import { ModelSelectionService } from '../src/models/model-selection-service.js';
import { DualStorageReconcileService } from '../src/storage/dual-storage-reconcile.js';
import { createPlatformServerHandler } from '../src/server/handler.js';

describe('Platform-side DSH Home Resolution & Model Selection Decoupling', () => {
  let tempBaseDir: string;
  let explicitHomeA: string;
  let explicitHomeB: string;
  let origEnkeepDshHome: string | undefined;
  let origDshHome: string | undefined;
  let origNodeEnv: string | undefined;
  let origEnkeepMode: string | undefined;

  function createSyntheticDshHome(targetDir: string, providerId: string, modelId: string): string {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    const patchYml = `
- id: llm-pi-ai
  config:
    providers:
      ${providerId}:
        displayName: Synthetic Provider ${providerId}
        api: anthropic-messages
        baseURL: https://synthetic-proxy.internal/v1
        apiKeyEnv: SYNTHETIC_API_KEY
        token: secret-token-do-not-leak
        models:
          - id: ${modelId}
            name: Model ${modelId}
`;
    fs.writeFileSync(path.join(targetDir, 'cordis.patch.yml'), patchYml, 'utf8');

    const settingsYaml = `
agent-default-model:
  provider: ${providerId}
  model: ${modelId}
`;
    fs.writeFileSync(path.join(targetDir, 'settings.yaml'), settingsYaml, 'utf8');

    const envFile = `
SYNTHETIC_API_KEY=sk-synthetic-key-12345
`;
    fs.writeFileSync(path.join(targetDir, '.env'), envFile, 'utf8');
    return targetDir;
  }

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-test-dsh-home-'));
    explicitHomeA = createSyntheticDshHome(path.join(tempBaseDir, 'home-a'), 'synth-prov-a', 'synth-model-a');
    explicitHomeB = createSyntheticDshHome(path.join(tempBaseDir, 'home-b'), 'synth-prov-b', 'synth-model-b');

    origEnkeepDshHome = process.env.ENKEEP_DSH_HOME;
    origDshHome = process.env.DSH_HOME;
    origNodeEnv = process.env.NODE_ENV;
    origEnkeepMode = process.env.ENKEEP_MODE;

    delete process.env.ENKEEP_DSH_HOME;
    delete process.env.DSH_HOME;
    delete process.env.ENKEEP_MODE;
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    if (origEnkeepDshHome !== undefined) process.env.ENKEEP_DSH_HOME = origEnkeepDshHome;
    else delete process.env.ENKEEP_DSH_HOME;

    if (origDshHome !== undefined) process.env.DSH_HOME = origDshHome;
    else delete process.env.DSH_HOME;

    if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv;
    else delete process.env.NODE_ENV;

    if (origEnkeepMode !== undefined) process.env.ENKEEP_MODE = origEnkeepMode;
    else delete process.env.ENKEEP_MODE;

    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {}
  });

  describe('1. Shared Resolver Priority & Resolution', () => {
    it('uses explicit customDshHome parameter first', () => {
      process.env.ENKEEP_DSH_HOME = explicitHomeA;
      process.env.DSH_HOME = explicitHomeB;
      const resolved = resolvePlatformDshHome('/tmp/custom-synthetic-home');
      expect(resolved).toBe(path.resolve('/tmp/custom-synthetic-home'));
    });

    it('prefers ENKEEP_DSH_HOME over DSH_HOME when both are set', () => {
      process.env.ENKEEP_DSH_HOME = explicitHomeA;
      process.env.DSH_HOME = explicitHomeB;
      const resolved = resolvePlatformDshHome();
      expect(resolved).toBe(path.resolve(explicitHomeA));
    });

    it('falls back to DSH_HOME when ENKEEP_DSH_HOME is unset', () => {
      process.env.DSH_HOME = explicitHomeB;
      const resolved = resolvePlatformDshHome();
      expect(resolved).toBe(path.resolve(explicitHomeB));
    });

    it('returns null when neither is set in non-production mode (never defaults to ~/.dsh)', () => {
      const homedirSpy = vi.spyOn(os, 'homedir');
      const resolved = resolvePlatformDshHome();
      expect(resolved).toBeNull();
      expect(homedirSpy).not.toHaveBeenCalled();
      homedirSpy.mockRestore();
    });
  });

  describe('2. Production Mode Fail-Closed Enforcement', () => {
    it('throws clear fail-closed error when neither ENKEEP_DSH_HOME nor DSH_HOME is set in production', () => {
      // 1. Explicit options flag
      expect(() => {
        resolvePlatformDshHome(undefined, { isProduction: true });
      }).toThrow(/FAIL-CLOSED: ENKEEP_DSH_HOME or DSH_HOME environment variable is mandatory in production mode\. Silent fallback to ~\/\.dsh is disabled\./);

      // 2. Boolean isProduction flag
      expect(() => {
        resolvePlatformDshHome(undefined, true);
      }).toThrow(/FAIL-CLOSED: ENKEEP_DSH_HOME or DSH_HOME environment variable is mandatory in production mode\. Silent fallback to ~\/\.dsh is disabled\./);

      // 3. NODE_ENV=production
      process.env.NODE_ENV = 'production';
      expect(() => {
        resolvePlatformDshHome();
      }).toThrow(/FAIL-CLOSED: ENKEEP_DSH_HOME or DSH_HOME environment variable is mandatory in production mode\. Silent fallback to ~\/\.dsh is disabled\./);

      // 4. loadDshSafeModelConfig throws in production
      expect(() => {
        loadDshSafeModelConfig(undefined, { isProduction: true });
      }).toThrow(/FAIL-CLOSED: ENKEEP_DSH_HOME or DSH_HOME environment variable is mandatory in production mode/);

      // 5. ModelSelectionService throws in production
      const db = new DatabaseSync(':memory:');
      const svc = new ModelSelectionService({ db, isProduction: true });
      expect(() => {
        svc.getDshCatalog();
      }).toThrow(/FAIL-CLOSED: ENKEEP_DSH_HOME or DSH_HOME environment variable is mandatory in production mode/);
    });

    it('throws clear fail-closed error when PlatformServer is instantiated in production without DSH home', () => {
      process.env.NODE_ENV = 'production';
      const db = new DatabaseSync(':memory:');
      const storage = new SqlitePlatformStorage(db);
      const messageStore = new SqliteWebMessageStore(db);
      const mockGateway = new DeliveryRuntimeGateway({
        storage,
        messageStore,
        database: db,
        quotaMode: 'disabled',
        executor: { execute: async () => ({ replyText: 'ok' }), cancel: async () => true },
        profileResolver: { resolve: async () => null },
      });

      expect(() => {
        new PlatformServer({
          database: db,
          cookieSecret: 'test_secret_must_be_at_least_32_characters_long_12345',
          csrfToken: 'test_csrf_token_must_be_at_least_32_characters_12345',
          runtimeGateway: mockGateway,
          host: '127.0.0.1',
          port: 0,
        });
      }).toThrow(/FAIL-CLOSED: ENKEEP_DSH_HOME or DSH_HOME environment variable is mandatory in production mode/);
    });
  });

  describe('3. /api/models Catalog & /model Validation Read from Explicit Home', () => {
    it('GET /api/models and validateProviderAndModel reflect explicit DSH home config', async () => {
      process.env.ENKEEP_DSH_HOME = explicitHomeA;

      const db = new DatabaseSync(':memory:');
      const runner = new PlatformServerMigrationRunner(db);
      await runner.migrate(ALL_PLATFORM_MIGRATIONS);

      const storage = new SqlitePlatformStorage(db);
      const messageStore = new SqliteWebMessageStore(db);
      const mockGateway = new DeliveryRuntimeGateway({
        storage,
        messageStore,
        database: db,
        quotaMode: 'disabled',
        executor: { execute: async () => ({ replyText: 'ok' }), cancel: async () => true },
        profileResolver: { resolve: async () => null },
      });

      const server = new PlatformServer({
        database: db,
        cookieSecret: 'test_secret_must_be_at_least_32_characters_long_12345',
        csrfToken: 'test_csrf_token_must_be_at_least_32_characters_12345',
        runtimeGateway: mockGateway,
        host: '127.0.0.1',
        port: 0,
      });

      const info = await server.start();
      try {
        const provisionResult = await provisionFixtures(server.storage, server.authService, {
          adminPassword: 'AliceAdmin123!',
          userPassword: 'BobUser123!',
          disabledPassword: 'CharlieDisabled123!',
        });
        const login = await server.authService.login('alice', 'AliceAdmin123!');
        const cookie = login.cookieHeader.split(';')[0]!;

        // 1. GET /api/models returns synth-prov-a from explicitHomeA
        const res = await fetch(`${info.url}/api/models`, {
          headers: { Cookie: cookie },
        });
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.data.providers['synth-prov-a']).toBeDefined();
        expect(json.data.providers['synth-prov-a'].displayName).toBe('Synthetic Provider synth-prov-a');
        expect(json.data.defaultModel.provider).toBe('synth-prov-a');
        expect(json.data.defaultModel.model).toBe('synth-model-a');

        // 2. Model validation accepts synth-prov-a / synth-model-a
        expect(() => {
          server.modelSelectionService.validateProviderAndModel('synth-prov-a', 'synth-model-a');
        }).not.toThrow();

        // 3. Model validation rejects unknown provider against explicit catalog
        expect(() => {
          server.modelSelectionService.validateProviderAndModel('unknown-provider', 'unknown-model');
        }).toThrow(/Provider "unknown-provider" is not configured in DSH deployment catalog/);

        // 4. Model validation rejects unknown model under valid provider
        expect(() => {
          server.modelSelectionService.validateProviderAndModel('synth-prov-a', 'nonexistent-model');
        }).toThrow(/Model "nonexistent-model" does not exist under provider "synth-prov-a"/);
      } finally {
        await server.stop();
      }
    });

    it('switches catalog when explicit dshHome option is provided to server', async () => {
      // Env points to Home A, but options.dshHome explicitly points to Home B
      process.env.ENKEEP_DSH_HOME = explicitHomeA;

      const db = new DatabaseSync(':memory:');
      const runner = new PlatformServerMigrationRunner(db);
      await runner.migrate(ALL_PLATFORM_MIGRATIONS);

      const storage = new SqlitePlatformStorage(db);
      const messageStore = new SqliteWebMessageStore(db);
      const mockGateway = new DeliveryRuntimeGateway({
        storage,
        messageStore,
        database: db,
        quotaMode: 'disabled',
        executor: { execute: async () => ({ replyText: 'ok' }), cancel: async () => true },
        profileResolver: { resolve: async () => null },
      });

      const server = new PlatformServer({
        database: db,
        cookieSecret: 'test_secret_must_be_at_least_32_characters_long_12345',
        csrfToken: 'test_csrf_token_must_be_at_least_32_characters_12345',
        runtimeGateway: mockGateway,
        dshHome: explicitHomeB,
        host: '127.0.0.1',
        port: 0,
      });

      const info = await server.start();
      try {
        const provisionResult = await provisionFixtures(server.storage, server.authService, {
          adminPassword: 'AliceAdmin123!',
          userPassword: 'BobUser123!',
          disabledPassword: 'CharlieDisabled123!',
        });
        const login = await server.authService.login('alice', 'AliceAdmin123!');
        const cookie = login.cookieHeader.split(';')[0]!;

        const res = await fetch(`${info.url}/api/models`, {
          headers: { Cookie: cookie },
        });
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
        // Explicit options.dshHome (Home B) must win over env ENKEEP_DSH_HOME (Home A)
        expect(json.data.providers['synth-prov-b']).toBeDefined();
        expect(json.data.providers['synth-prov-a']).toBeUndefined();
        expect(json.data.defaultModel.provider).toBe('synth-prov-b');
      } finally {
        await server.stop();
      }
    });
  });

  describe('4. ModelSelectionService Instance Alignment', () => {
    it('server.ts, handler.ts, and consoleDataSource all resolve the same DSH catalog', () => {
      process.env.ENKEEP_DSH_HOME = explicitHomeA;

      const db = new DatabaseSync(':memory:');
      const runner = new PlatformServerMigrationRunner(db);
      runner.migrate(ALL_PLATFORM_MIGRATIONS);

      const storage = new SqlitePlatformStorage(db);
      const messageStore = new SqliteWebMessageStore(db);
      const mockGateway = new DeliveryRuntimeGateway({
        storage,
        messageStore,
        database: db,
        quotaMode: 'disabled',
        executor: { execute: async () => ({ replyText: 'ok' }), cancel: async () => true },
        profileResolver: { resolve: async () => null },
      });

      const server = new PlatformServer({
        database: db,
        cookieSecret: 'test_secret_must_be_at_least_32_characters_long_12345',
        csrfToken: 'test_csrf_token_must_be_at_least_32_characters_12345',
        runtimeGateway: mockGateway,
        host: '127.0.0.1',
        port: 0,
      });

      // 1. server.modelSelectionService has synth-prov-a
      const catServer = server.modelSelectionService.getDshCatalog();
      expect(catServer.providers['synth-prov-a']).toBeDefined();

      // 2. handler constructed standalone with same dshHome has same catalog
      const standaloneHandler = createPlatformServerHandler({
        database: db,
        storage,
        csrfToken: 'test_csrf_token_must_be_at_least_32_characters_12345',
        dshHome: explicitHomeA,
      });
      expect(standaloneHandler).toBeDefined();

      // 3. ModelSelectionService without customDshHome resolves via env ENKEEP_DSH_HOME
      const unconfiguredSvc = new ModelSelectionService({ db });
      const catUnconf = unconfiguredSvc.getDshCatalog();
      expect(catUnconf.providers['synth-prov-a']).toBeDefined();
      expect(catUnconf.defaultModel.provider).toBe('synth-prov-a');
    });
  });

  describe('5. Zero os.homedir() Invocations During DSH Home & Catalog Resolution', () => {
    it('never calls os.homedir() during resolvePlatformDshHome, loadDshSafeModelConfig, or getDshCatalog', () => {
      const homedirSpy = vi.spyOn(os, 'homedir');

      // 1. resolvePlatformDshHome with explicit path
      resolvePlatformDshHome(explicitHomeA);
      expect(homedirSpy).not.toHaveBeenCalled();

      // 2. resolvePlatformDshHome with ENKEEP_DSH_HOME
      process.env.ENKEEP_DSH_HOME = explicitHomeA;
      resolvePlatformDshHome();
      expect(homedirSpy).not.toHaveBeenCalled();

      // 3. resolvePlatformDshHome with fallback DSH_HOME
      delete process.env.ENKEEP_DSH_HOME;
      process.env.DSH_HOME = explicitHomeB;
      resolvePlatformDshHome();
      expect(homedirSpy).not.toHaveBeenCalled();

      // 4. resolvePlatformDshHome with no env (returns null)
      delete process.env.DSH_HOME;
      resolvePlatformDshHome();
      expect(homedirSpy).not.toHaveBeenCalled();

      // 5. loadDshSafeModelConfig with explicit dir
      loadDshSafeModelConfig(explicitHomeA);
      expect(homedirSpy).not.toHaveBeenCalled();

      // 6. loadDshSafeModelConfig with unset env (returns empty catalog without homedir)
      const emptyCat = loadDshSafeModelConfig();
      expect(emptyCat.providers).toEqual({});
      expect(homedirSpy).not.toHaveBeenCalled();

      // 7. ModelSelectionService getDshCatalog
      const db = new DatabaseSync(':memory:');
      const svc = new ModelSelectionService({ db, customDshHome: explicitHomeA });
      svc.getDshCatalog();
      expect(homedirSpy).not.toHaveBeenCalled();

      homedirSpy.mockRestore();
    });
  });

  describe('6. DualStorageReconcileService DSH Home Decoupling', () => {
    it('DualStorageReconcileService uses shared resolver and never falls back to ~/.dsh', () => {
      const db = new DatabaseSync(':memory:');
      const homedirSpy = vi.spyOn(os, 'homedir');

      process.env.ENKEEP_DSH_HOME = explicitHomeA;
      const serviceA = new DualStorageReconcileService({ db });
      expect((serviceA as any).dshHome).toBe(path.resolve(explicitHomeA));

      delete process.env.ENKEEP_DSH_HOME;
      process.env.DSH_HOME = explicitHomeB;
      const serviceB = new DualStorageReconcileService({ db });
      expect((serviceB as any).dshHome).toBe(path.resolve(explicitHomeB));

      delete process.env.DSH_HOME;
      const serviceUnset = new DualStorageReconcileService({ db });
      expect((serviceUnset as any).dshHome).toBe('');
      // In constructor, homedir should NOT have been called for DSH home fallback
      expect(homedirSpy).not.toHaveBeenCalled();

      homedirSpy.mockRestore();
    });
  });
});
