import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  MIGRATION_013_USER_LOCALE_PREFERENCES_SQL,
} from '../src/storage/migrations.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';

describe('V13 Migration Upgrade & Fresh Database', () => {
  it('fresh database applies all migrations 1 through 13 successfully', async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);

    const applied = await runner.migrate(ALL_PLATFORM_MIGRATIONS.slice(0, 13));
    expect(applied.length).toBe(13);
    expect(await runner.getCurrentVersion()).toBe(13);

    // Verify users table has locale column
    const tableInfo = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string; type: string; notnull: number; dflt_value: string }>;
    const localeCol = tableInfo.find((c) => c.name === 'locale');
    expect(localeCol).toBeDefined();
    expect(localeCol?.type.toUpperCase()).toBe('TEXT');
    expect(localeCol?.notnull).toBe(1);

    db.close();
  });

  it('successfully upgrades an existing v12 database to v13, populating default locale "en" for existing users', async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);

    // Step 1: Migrate up to v12
    const manifestV12 = ALL_PLATFORM_MIGRATIONS.slice(0, 12);
    await runner.migrate(manifestV12);
    expect(await runner.getCurrentVersion()).toBe(12);

    // Insert legacy user before v13 migration (no locale column)
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status, display_name, created_at, updated_at)
      VALUES ('u_legacy', 'legacy_user', 'hash_123', 'user', 'active', 'Legacy User', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run();

    // Step 2: Apply v13 migration
    const newlyApplied = await runner.migrate(ALL_PLATFORM_MIGRATIONS.slice(0, 13));
    expect(newlyApplied.length).toBe(1);
    expect(newlyApplied[0].version).toBe(13);
    expect(newlyApplied[0].name).toBe('013_user_locale_preferences');
    expect(await runner.getCurrentVersion()).toBe(13);

    // Step 3: Query legacy user via repository to verify locale is 'en'
    const storage = new SqlitePlatformStorage(db);
    const legacyUser = await storage.users.findById('u_legacy');
    expect(legacyUser).not.toBeNull();
    expect(legacyUser?.locale).toBe('en');
    expect(legacyUser?.username).toBe('legacy_user');

    // Step 4: Verify legacy user can be updated to 'zh-CN'
    const updated = await storage.users.update('u_legacy', { locale: 'zh-CN' });
    expect(updated.locale).toBe('zh-CN');

    db.close();
  });

  it('migration 13 is idempotent and re-running migrate does not reapply or fail', async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);

    await runner.migrate(ALL_PLATFORM_MIGRATIONS.slice(0, 13));
    expect(await runner.getCurrentVersion()).toBe(13);

    // Re-run
    const reapply = await runner.migrate(ALL_PLATFORM_MIGRATIONS.slice(0, 13));
    expect(reapply.length).toBe(0);
    expect(await runner.getCurrentVersion()).toBe(13);

    db.close();
  });
});
