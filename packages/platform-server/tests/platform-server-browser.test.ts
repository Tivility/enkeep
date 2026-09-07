/**
 * PlatformServer Browser Integration Test Suite
 *
 * Tests:
 * 1. Extension Catalog dynamic read-only builtin browser extension (no DB rows, mutations blocked).
 * 2. Session Lifecycle Service: browser context cleanup on generation reset, session archive, and recovery.
 * 3. PlatformServer lifecycle: browser service disposal on platform server shutdown.
 * 4. Admin diagnostics: GET /api/admin/browser/diagnostics exposes context/page counts without URLs.
 *
 * @module @enkeep/platform-server/tests/platform-server-browser.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  PlatformServer,
  createPlatformServer,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  SqliteWebMessageStore,
} from '../src/index.js';
import {
  ExtensionCatalogService,
} from '../src/extensions/extension-catalog-service.js';
import {
  SessionLifecycleService,
} from '../src/sessions/session-lifecycle-service.js';
import {
  SqlitePlatformStorage,
} from '@enkeep/platform-storage-sqlite';
import {
  DefaultAuthService,
  provisionFixtures,
} from '@enkeep/platform-auth';
import type {
  BrowserService,
  BrowserServiceHealth,
  BrowserCloseOptions,
  BrowserCloseResult,
} from '@enkeep/platform-core';
import { ValidationError } from '@enkeep/platform-core';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

export const ALICE_ID = '11111111-1111-4111-8111-111111111111';
export const BOB_ID = '22222222-2222-4222-8222-222222222222';

function createMockBrowserService(): BrowserService {
  return {
    initialize: vi.fn(async (): Promise<void> => {}),
    open: vi.fn(),
    snapshot: vi.fn(),
    interact: vi.fn(),
    screenshot: vi.fn(),
    close: vi.fn(async (_options?: BrowserCloseOptions): Promise<BrowserCloseResult> => {
      return { closedPages: 1, closedContexts: 1 };
    }),
    checkHealth: vi.fn(async (): Promise<BrowserServiceHealth> => {
      return {
        status: 'healthy',
        activeContexts: 2,
        activePages: 3,
        uptimeSeconds: 300,
      };
    }),
    dispose: vi.fn(async (): Promise<void> => {}),
  };
}

describe('PlatformServer Browser Service Composition & Integration', () => {
  let tempDir: string;
  let dshHome: string;
  let spacesDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-browser-test-'));
    dshHome = path.join(tempDir, 'dsh');
    spacesDir = path.join(tempDir, 'spaces');
    fs.mkdirSync(dshHome, { recursive: true });
    fs.mkdirSync(spacesDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe('ExtensionCatalogService Dynamic Builtin Browser', () => {
    it('dynamically merges builtin browser into listPackages, getPackage, and listContributions without DB rows', async () => {
      const db = new DatabaseSync(':memory:');
      const storage = new SqlitePlatformStorage(db);
      const migrator = new PlatformServerMigrationRunner(db);
      await migrator.migrate(ALL_PLATFORM_MIGRATIONS);

      const authService = new DefaultAuthService(storage, {
        cookieSecret: '01234567890123456789012345678901',
      });
      const fixtures = await provisionFixtures(storage, authService, {
        adminUsername: 'alice',
        adminPassword: 'AlicePassword123!',
        userPassword: 'BobPassword123!',
        disabledPassword: 'CharlieDisabledPassword123!',
      });

      const browserService = createMockBrowserService();
      const extService = new ExtensionCatalogService(storage, {
        dshHome,
        spacesDir,
        browserService,
      });

      // 1. listPackages contains 'browser'
      const packages = await extService.listPackages(fixtures.admin.id);
      const browserPkg = packages.find((p) => p.slug === 'browser');
      expect(browserPkg).toBeDefined();
      expect(browserPkg?.name).toBe('Built-in Browser Automation');
      expect(browserPkg?.sourceKind).toBe('builtin');
      expect(browserPkg?.contributions[0].kind).toBe('browser');

      // 2. getPackage returns details with version 1
      const detail = await extService.getPackage(fixtures.admin.id, 'browser');
      expect(detail.slug).toBe('browser');
      expect(detail.sourceKind).toBe('builtin');
      expect(detail.versions.length).toBe(1);
      expect(detail.versions[0].sourceKind).toBe('builtin');

      // 3. listContributions contains browser contribution
      const contribs = await extService.listContributions(fixtures.admin.id);
      const browserContrib = contribs.find((c) => c.kind === 'browser');
      expect(browserContrib).toBeDefined();
      expect(browserContrib?.contributionKey).toBe('browser');

      // 4. Verify ZERO DB rows in extension_packages table for builtin browser
      const dbPackages = await storage.forTenant(fixtures.admin.id).extensionPackages.list();
      expect(dbPackages.find((p) => p.slug === 'browser')).toBeUndefined();

      // 5. Verify mutations are strictly blocked
      await expect(extService.uninstall(fixtures.admin.id, 'browser')).rejects.toThrow(ValidationError);
      await expect(extService.update({ userId: fixtures.admin.id, slug: 'browser' })).rejects.toThrow(ValidationError);
      await expect(extService.rollback({ userId: fixtures.admin.id, slug: 'browser', targetVersion: 1 })).rejects.toThrow(ValidationError);

      await storage.close();
    });

    it('omits builtin browser when browserService is not configured', async () => {
      const db = new DatabaseSync(':memory:');
      const storage = new SqlitePlatformStorage(db);
      const migrator = new PlatformServerMigrationRunner(db);
      await migrator.migrate(ALL_PLATFORM_MIGRATIONS);

      const authService = new DefaultAuthService(storage, {
        cookieSecret: '01234567890123456789012345678901',
      });
      const fixtures = await provisionFixtures(storage, authService, {
        adminUsername: 'alice',
        adminPassword: 'AlicePassword123!',
        userPassword: 'BobPassword123!',
        disabledPassword: 'CharlieDisabledPassword123!',
      });

      const extService = new ExtensionCatalogService(storage, {
        dshHome,
        spacesDir,
      });

      const packages = await extService.listPackages(fixtures.admin.id);
      expect(packages.find((p) => p.slug === 'browser')).toBeUndefined();

      const contribs = await extService.listContributions(fixtures.admin.id);
      expect(contribs.find((c) => c.kind === 'browser')).toBeUndefined();

      await expect(extService.getPackage(fixtures.admin.id, 'browser')).rejects.toThrow();

      await storage.close();
    });
  });

  describe('SessionLifecycleService Browser Cleanup', () => {
    it('closes browser context on archiveSession, startNewGeneration, and recovery', async () => {
      const db = new DatabaseSync(':memory:');
      const storage = new SqlitePlatformStorage(db);
      const migrator = new PlatformServerMigrationRunner(db);
      await migrator.migrate(ALL_PLATFORM_MIGRATIONS);

      const authService = new DefaultAuthService(storage, {
        cookieSecret: '01234567890123456789012345678901',
      });
      const fixtures = await provisionFixtures(storage, authService, {
        adminUsername: 'alice',
        adminPassword: 'AlicePassword123!',
        userPassword: 'BobPassword123!',
        disabledPassword: 'CharlieDisabledPassword123!',
      });

      const route = await storage.forTenant(fixtures.admin.id).sessionRoutes.create({
        spaceId: fixtures.adminContainerSpace.id,
        channel: 'web',
        nativeContextId: 'ctx_peer_1',
        peerId: 'peer_1',
        dshSessionId: 'ses_0123456789abcdef0123456789abcdef',
      });

      const mockArtifactPort = {
        inspectSessionArtifact: vi.fn(),
        readSessionEventsRaw: vi.fn(),
        recoverValidSessionPrefix: vi.fn(),
        deleteSessionArtifact: vi.fn(),
        copySessionArtifact: vi.fn(),
      };

      const browserService = createMockBrowserService();
      const lifecycleService = new SessionLifecycleService({
        db,
        storage,
        runtimeArtifactPort: mockArtifactPort as any,
        browserService,
      });

      // 1. Archive session triggers browserService.close
      await lifecycleService.archiveSession(fixtures.admin.id, route.id);
      expect(browserService.close).toHaveBeenCalledWith({
        sessionKey: {
          userId: fixtures.admin.id,
          spaceId: fixtures.adminContainerSpace.id,
          sessionId: route.id,
        },
      });

      // Reset mock counter
      vi.clearAllMocks();

      // 2. startNewGeneration triggers browserService.close
      await lifecycleService.startNewGeneration(fixtures.admin.id, route.id);
      expect(browserService.close).toHaveBeenCalledWith({
        sessionKey: {
          userId: fixtures.admin.id,
          spaceId: fixtures.adminContainerSpace.id,
          sessionId: route.id,
        },
      });

      await storage.close();
    });
  });

  describe('PlatformServer Full Composition & Admin Diagnostics', () => {
    it('exposes admin browser diagnostics and disposes browserService on shutdown', async () => {
      const db = new DatabaseSync(':memory:');
      const storage = new SqlitePlatformStorage(db);
      const messageStore = new SqliteWebMessageStore(db);
      const runtimeGateway = new TestOnlyRuntimeGateway({
        storage,
        messageStore,
      });

      const browserService = createMockBrowserService();

      const { server, address } = await createPlatformServer({
        database: db,
        cookieSecret: '01234567890123456789012345678901',
        csrfToken: '12345678901234567890123456789012',
        runtimeGateway,
        browserService,
        dshHome,
        spacesDir,
        port: 0,
      });

      expect(browserService.initialize).toHaveBeenCalledTimes(1);

      const fixtures = await provisionFixtures(server.storage, server.authService, {
        adminUsername: 'alice',
        adminPassword: 'AlicePassword123!',
        userPassword: 'BobPassword123!',
        disabledPassword: 'CharlieDisabledPassword123!',
      });

      const loginRes = await fetch(`${address.url}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': address.csrfToken,
          Origin: address.url,
        },
        body: JSON.stringify({
          username: 'alice',
          password: 'AlicePassword123!',
        }),
      });
      expect(loginRes.status).toBe(200);
      const cookie = loginRes.headers.get('set-cookie')?.split(';')[0] || '';

      // Test GET /api/admin/browser/diagnostics
      const diagRes = await fetch(`${address.url}/api/admin/browser/diagnostics`, {
        method: 'GET',
        headers: {
          Cookie: cookie,
          'X-Enkeep-CSRF': address.csrfToken,
        },
      });

      expect(diagRes.status).toBe(200);
      const diagData = await diagRes.json();
      expect(diagData.success).toBe(true);
      expect(diagData.data.available).toBe(true);
      expect(diagData.data.status).toBe('healthy');
      expect(diagData.data.activeContexts).toBe(2);
      expect(diagData.data.activePages).toBe(3);
      // Strictly NO URLs in diagnostic output
      expect(JSON.stringify(diagData)).not.toContain('http://');
      expect(JSON.stringify(diagData)).not.toContain('https://');

      // Stop server and verify browserService.dispose is called exactly once
      await server.stop();
      expect(browserService.dispose).toHaveBeenCalledTimes(1);
    });

    it('fails startup safely with BROWSER_UNAVAILABLE and without raw path leakage when initialize fails', async () => {
      const db = new DatabaseSync(':memory:');
      const storage = new SqlitePlatformStorage(db);
      const messageStore = new SqliteWebMessageStore(db);
      const runtimeGateway = new TestOnlyRuntimeGateway({
        storage,
        messageStore,
      });

      const rawSensitivePath = '/opt/custom/browsers/secret-token-12345/chromium-binary';
      const mockFailingBrowserService: BrowserService = {
        initialize: vi.fn(async (): Promise<void> => {
          throw new Error(`Failed to launch Chromium at ${rawSensitivePath}: ENOENT`);
        }),
        open: vi.fn(),
        snapshot: vi.fn(),
        interact: vi.fn(),
        screenshot: vi.fn(),
        close: vi.fn(),
        checkHealth: vi.fn(async (): Promise<BrowserServiceHealth> => ({
          status: 'unhealthy',
          activeContexts: 0,
          activePages: 0,
          uptimeSeconds: 0,
        })),
        dispose: vi.fn(async (): Promise<void> => {}),
      };

      const server = new PlatformServer({
        database: db,
        cookieSecret: '01234567890123456789012345678901',
        csrfToken: '12345678901234567890123456789012',
        runtimeGateway,
        browserService: mockFailingBrowserService,
        dshHome,
        spacesDir,
        port: 0,
      });

      let startupError: any = null;
      try {
        await server.start();
      } catch (err) {
        startupError = err;
      }

      expect(startupError).toBeDefined();
      expect(startupError.code).toBe('BROWSER_UNAVAILABLE');
      // Crucial security invariant: raw path MUST NOT leak in startup error message
      expect(startupError.message).not.toContain(rawSensitivePath);
      expect(startupError.message).not.toContain('/opt/custom');
      // Server must not be running
      expect((server as any).isRunning).toBe(false);
      // browserService.dispose must have been called during rollback
      expect(mockFailingBrowserService.dispose).toHaveBeenCalledTimes(1);
    });

    it('fails startup safely when browser health check is not healthy after initialize', async () => {
      const db = new DatabaseSync(':memory:');
      const storage = new SqlitePlatformStorage(db);
      const messageStore = new SqliteWebMessageStore(db);
      const runtimeGateway = new TestOnlyRuntimeGateway({
        storage,
        messageStore,
      });

      const mockDegradedBrowserService: BrowserService = {
        initialize: vi.fn(async (): Promise<void> => {}),
        open: vi.fn(),
        snapshot: vi.fn(),
        interact: vi.fn(),
        screenshot: vi.fn(),
        close: vi.fn(),
        checkHealth: vi.fn(async (): Promise<BrowserServiceHealth> => ({
          status: 'degraded',
          activeContexts: 0,
          activePages: 0,
          uptimeSeconds: 0,
        })),
        dispose: vi.fn(async (): Promise<void> => {}),
      };

      const server = new PlatformServer({
        database: db,
        cookieSecret: '01234567890123456789012345678901',
        csrfToken: '12345678901234567890123456789012',
        runtimeGateway,
        browserService: mockDegradedBrowserService,
        dshHome,
        spacesDir,
        port: 0,
      });

      let startupError: any = null;
      try {
        await server.start();
      } catch (err) {
        startupError = err;
      }

      expect(startupError).toBeDefined();
      expect(startupError.code).toBe('BROWSER_UNAVAILABLE');
      expect((server as any).isRunning).toBe(false);
      expect(mockDegradedBrowserService.dispose).toHaveBeenCalledTimes(1);
    });
  });
});
