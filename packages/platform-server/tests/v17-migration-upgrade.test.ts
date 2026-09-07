import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  MIGRATION_017_USER_MUST_CHANGE_PASSWORD_SQL,
} from '../src/storage/migrations.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';

describe('V17 Migration Upgrade & Fresh Database (must_change_password)', () => {
  it('fresh database applies all migrations 1 through 17 successfully', async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);

    const applied = await runner.migrate(ALL_PLATFORM_MIGRATIONS.slice(0, 17));
    expect(applied.length).toBe(17);
    expect(await runner.getCurrentVersion()).toBe(17);

    // Verify users table has must_change_password column
    const tableInfo = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string; type: string; notnull: number; dflt_value: string }>;
    const col = tableInfo.find((c) => c.name === 'must_change_password');
    expect(col).toBeDefined();
    expect(col?.type.toUpperCase()).toBe('INTEGER');
    expect(col?.notnull).toBe(1);
    expect(col?.dflt_value).toBe('0');

    db.close();
  });

  it('successfully upgrades an existing v16 database to v17, defaulting must_change_password to 0 (false) for existing users', async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);

    // Step 1: Migrate up to v16
    const manifestV16 = ALL_PLATFORM_MIGRATIONS.slice(0, 16);
    await runner.migrate(manifestV16);
    expect(await runner.getCurrentVersion()).toBe(16);

    // Insert legacy user before v17 migration (no must_change_password column)
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status, display_name, locale, created_at, updated_at)
      VALUES ('u_legacy_16', 'legacy_user_16', 'hash_123', 'user', 'active', 'Legacy User 16', 'en', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run();

    // Step 2: Apply v17 migration
    const newlyApplied = await runner.migrate(ALL_PLATFORM_MIGRATIONS.slice(0, 17));
    expect(newlyApplied.length).toBe(1);
    expect(newlyApplied[0].version).toBe(17);
    expect(newlyApplied[0].name).toBe('017_user_must_change_password');
    expect(await runner.getCurrentVersion()).toBe(17);

    // Step 3: Query legacy user via repository to verify mustChangePassword is false
    const storage = new SqlitePlatformStorage(db);
    const legacyUser = await storage.users.findById('u_legacy_16');
    expect(legacyUser).not.toBeNull();
    expect(legacyUser?.mustChangePassword).toBe(false);
    expect(legacyUser?.username).toBe('legacy_user_16');

    // Step 4: Verify user can be updated to mustChangePassword = true and back to false
    const updatedTrue = await storage.users.update('u_legacy_16', { mustChangePassword: true });
    expect(updatedTrue.mustChangePassword).toBe(true);

    const updatedFalse = await storage.users.update('u_legacy_16', { mustChangePassword: false });
    expect(updatedFalse.mustChangePassword).toBe(false);

    db.close();
  });

  it('enforces CHECK constraint on must_change_password (0 or 1 only)', async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);

    await runner.migrate(ALL_PLATFORM_MIGRATIONS.slice(0, 17));

    // Inserting 2 should fail CHECK constraint
    expect(() => {
      db.prepare(`
        INSERT INTO users (id, username, password_hash, role, status, display_name, locale, must_change_password, created_at, updated_at)
        VALUES ('u_bad', 'bad_user', 'hash_123', 'user', 'active', 'Bad User', 'en', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run();
    }).toThrow();

    // Inserting -1 should fail CHECK constraint
    expect(() => {
      db.prepare(`
        INSERT INTO users (id, username, password_hash, role, status, display_name, locale, must_change_password, created_at, updated_at)
        VALUES ('u_bad2', 'bad_user2', 'hash_123', 'user', 'active', 'Bad User 2', 'en', -1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run();
    }).toThrow();

    db.close();
  });

  it('migration 17 is idempotent and re-running migrate does not reapply or fail', async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);

    await runner.migrate(ALL_PLATFORM_MIGRATIONS.slice(0, 17));
    expect(await runner.getCurrentVersion()).toBe(17);

    // Re-run
    const reapply = await runner.migrate(ALL_PLATFORM_MIGRATIONS.slice(0, 17));
    expect(reapply.length).toBe(0);
    expect(await runner.getCurrentVersion()).toBe(17);

    db.close();
  });
});
