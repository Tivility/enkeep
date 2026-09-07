/**
 * Platform Server Extension Center & Trusted DSH Plugin Catalog Tests
 *
 * Verifies:
 * 1. Platform bootstrap syncs trusted plugins into DB idempotently.
 * 2. Manifest validator strictly rejects user-uploaded dsh-plugin archive/git packages.
 * 3. Space resolution: resolveForSpace produces ExtensionDshPluginContributionActivation.
 * 4. RBAC: Admin can enable/disable plugin bindings, non-admin is rejected with 403 Forbidden.
 * 5. Immutability: update, rollback, and uninstall are rejected for built-in trusted plugins.
 *
 * @module @enkeep/platform-server/tests/extension-trusted-plugins.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SqlitePlatformStorage,
  SqlitePlatformOperationsStorage,
} from '@enkeep/platform-storage-sqlite';
import {
  DefaultAuthService,
  provisionFixtures,
} from '@enkeep/platform-auth';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import { ExtensionCatalogService } from '../src/extensions/extension-catalog-service.js';
import { validateExtensionJson } from '../src/extensions/extension-manifest-validator.js';
import { TRUSTED_ECHO_PLUGIN } from '@enkeep/dsh-enkeep-bundle';
import { validateExtensionActivationPlan } from '@enkeep/protocol';

describe('Platform Extension Catalog: Trusted DSH Plugins', () => {
  let tempDir: string;
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let extService: ExtensionCatalogService;
  let aliceId: string;
  let bobId: string;
  let aliceSpaceId: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-plugin-catalog-test-'));
    const dbPath = path.join(tempDir, 'platform.db');
    db = new DatabaseSync(dbPath);
    const migrationRunner = new PlatformServerMigrationRunner(db);
    await migrationRunner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    const authService = new DefaultAuthService(storage, {
      cookieSecret: 'test_cookie_secret_at_least_32_chars_long_12345',
    });
    const fixtures = await provisionFixtures(storage, authService, {
      adminPassword: 'AlicePassword123!',
      userPassword: 'BobPassword123!',
      disabledPassword: 'CharliePassword123!',
    });

    aliceId = fixtures.admin.id;
    bobId = fixtures.user.id;

    const spaces = await storage.forTenant(aliceId).spaces.list();
    aliceSpaceId = spaces[0].id;

    extService = new ExtensionCatalogService(storage, {
      dshHome: path.join(tempDir, 'dsh-home'),
      spacesDir: path.join(tempDir, 'spaces'),
    });
  });

  afterEach(() => {
    try {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe('1. Platform Bootstrap Idempotent Sync', () => {
    it('synchronizes trusted echo plugin package and contribution rows into SQLite idempotently', async () => {
      // First sync
      await extService.syncTenantTrustedPlugins(aliceId);

      const pkg = await storage.forTenant(aliceId).extensionPackages.findBySlug('trusted-echo');
      expect(pkg).toBeDefined();
      expect(pkg?.sourceKind).toBe('builtin');
      expect(pkg?.sourceRef).toBe('enkeep.echo');
      expect(pkg?.installedVersion).toBe(1);
      expect(pkg?.integritySha256).toBe(TRUSTED_ECHO_PLUGIN.integritySha256);

      const contribs = await storage.forTenant(aliceId).extensionPackages.listContributions(pkg!.id);
      expect(contribs).toHaveLength(1);
      expect(contribs[0].kind).toBe('dsh-plugin');
      expect(contribs[0].contributionKey).toBe('trusted-echo');

      // Second sync (idempotent)
      await extService.syncTenantTrustedPlugins(aliceId);
      const pkgsAfter = await storage.forTenant(aliceId).extensionPackages.list();
      const echoPkgs = pkgsAfter.filter((p) => p.slug === 'trusted-echo');
      expect(echoPkgs).toHaveLength(1);
    });
  });

  describe('2. Manifest Validator Rejecting User-Uploaded Plugins', () => {
    it('fails closed when an archive or git extension.json contains kind dsh-plugin', () => {
      expect(() => {
        validateExtensionJson({
          schemaVersion: 1,
          slug: 'malicious-plugin',
          name: 'Malicious Plugin',
          contributions: [
            {
              kind: 'dsh-plugin',
              key: 'custom-plugin',
              manifest: { name: 'Fake Plugin' },
            },
          ],
        });
      }).toThrow(/FAIL-CLOSED: Contribution kind "dsh-plugin" at index 0 is strictly forbidden in user uploaded packages/);
    });
  });

  describe('3. Admin RBAC for Enabling and Disabling Plugins', () => {
    it('allows admin (Alice) to enable and disable trusted plugin in a space, and resolves ExtensionActivationPlan', async () => {
      await extService.syncTenantTrustedPlugins(aliceId);
      const alice = await storage.users.findById(aliceId);
      expect(alice?.role).toBe('admin');

      // Space resolution before enabling: no plugin in plan
      const planBefore = await extService.resolveForSpace(aliceId, aliceSpaceId);
      expect(planBefore.plugins ?? []).toHaveLength(0);

      // Alice enables trusted-echo in space
      const binding = await extService.enable(alice!, aliceSpaceId, 'trusted-echo');
      expect(binding.enabled).toBe(true);
      expect(binding.kind).toBe('dsh-plugin');

      // Space resolution after enabling: plugin present in plan
      const planAfter = await extService.resolveForSpace(aliceId, aliceSpaceId);
      expect(planAfter.plugins).toHaveLength(1);
      expect(planAfter.plugins![0].trustedPluginId).toBe('enkeep.echo');
      expect(planAfter.plugins![0].integrity).toBe(TRUSTED_ECHO_PLUGIN.integritySha256);
      expect(planAfter.plugins![0].enabled).toBe(true);

      // Validate under wire plan validator
      const validatedPlan = validateExtensionActivationPlan(planAfter);
      expect(validatedPlan.plugins).toHaveLength(1);

      // Alice disables trusted-echo in space
      const disableBinding = await extService.disable(alice!, aliceSpaceId, 'trusted-echo');
      expect(disableBinding.enabled).toBe(false);

      // Space resolution after disabling: plugin removed from plan
      const planDisabled = await extService.resolveForSpace(aliceId, aliceSpaceId);
      expect(planDisabled.plugins ?? []).toHaveLength(0);
    });

    it('rejects non-admin (Bob) attempting to enable or disable trusted plugin with 403 Forbidden', async () => {
      await extService.syncTenantTrustedPlugins(bobId);
      const bob = await storage.users.findById(bobId);
      expect(bob?.role).toBe('user');

      const bobSpaces = await storage.forTenant(bobId).spaces.list();
      const bobSpaceId = bobSpaces[0].id;

      // Bob cannot enable
      await expect(extService.enable(bob!, bobSpaceId, 'trusted-echo')).rejects.toThrow(
        /Only administrators can enable DSH plugin extensions/
      );

      // Bob cannot disable
      await expect(extService.disable(bob!, bobSpaceId, 'trusted-echo')).rejects.toThrow(
        /Only administrators can disable DSH plugin extensions/
      );
    });
  });

  describe('4. Built-in Extension Immutability', () => {
    it('rejects update, rollback, and uninstall on built-in trusted plugin', async () => {
      await extService.syncTenantTrustedPlugins(aliceId);
      const alice = await storage.users.findById(aliceId);

      // Update rejected
      await expect(
        extService.update({
          userId: aliceId,
          slug: 'trusted-echo',
        })
      ).rejects.toThrow(/Built-in extensions cannot be updated/);

      // Rollback rejected
      await expect(
        extService.rollback({
          userId: aliceId,
          slug: 'trusted-echo',
          targetVersion: 1,
        })
      ).rejects.toThrow(/Built-in extensions cannot be rolled back/);

      // Uninstall rejected
      await expect(extService.uninstall(alice!, 'trusted-echo')).rejects.toThrow(
        /Built-in extensions cannot be uninstalled/
      );
    });
  });
});
