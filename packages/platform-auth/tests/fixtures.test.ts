import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSqliteStorage, SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  DefaultAuthService,
  provisionFixtures,
} from '../src/index.js';
import { UnauthorizedError } from '@enkeep/platform-core';

describe('Alice/Bob Fixture Provisioning API', () => {
  let storage: SqlitePlatformStorage;
  let authService: DefaultAuthService;
  const cookieSecret = 'test-secret-key-that-is-at-least-32-chars-long';

  beforeEach(async () => {
    storage = await createSqliteStorage({ dbPath: ':memory:' });
    // Execute test-local migration 009 schema additions on spaces so test DB matches fully-migrated platform
    storage.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_profiles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived', 'deleted')),
        active_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        UNIQUE(user_id, name)
      );

      CREATE TABLE IF NOT EXISTS agent_profile_snapshots (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
        version INTEGER NOT NULL,
        prompt_mode TEXT NOT NULL DEFAULT 'append' CHECK(prompt_mode = 'append'),
        prompt_hash TEXT NOT NULL,
        identity TEXT NOT NULL DEFAULT '',
        soul TEXT NOT NULL DEFAULT '',
        agents TEXT NOT NULL DEFAULT '',
        tools TEXT NOT NULL DEFAULT '',
        change_summary TEXT,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        UNIQUE(profile_id, version)
      );

      ALTER TABLE spaces ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived', 'deleted'));
      ALTER TABLE spaces ADD COLUMN agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT;
      ALTER TABLE spaces ADD COLUMN agent_profile_snapshot_id TEXT REFERENCES agent_profile_snapshots(id) ON DELETE RESTRICT;
    `);

    authService = new DefaultAuthService(storage, {
      cookieSecret,
      sessionTtlSeconds: 3600,
      cookieSecure: false,
    });
  });

  afterEach(async () => {
    await storage.close();
  });

  it('provisions Alice, Bob and disabled Charlie with secure scrypt hashes and spaces', async () => {
    const fixtures = await provisionFixtures(storage, authService, {
      adminUsername: 'alice',
      adminPassword: 'AliceCustomPassword123!',
      userUsername: 'bob',
      userPassword: 'BobCustomPassword123!',
      disabledUsername: 'charlie_disabled',
      disabledPassword: 'CharlieDisabledPass123!',
    });

    // Verify Alice (Admin)
    expect(fixtures.admin.username).toBe('alice');
    expect(fixtures.admin.role).toBe('admin');
    expect(fixtures.admin.status).toBe('active');
    expect(fixtures.admin.passwordHash.startsWith('scrypt$')).toBe(true);
    expect(fixtures.adminContainerSpace.executionMode).toBe('container');
    expect((fixtures as Record<string, unknown>).adminHostSpace).toBeUndefined();

    // Verify Alice has only 1 provisioned space (container)
    const aliceTenant = storage.forTenant(fixtures.admin.id);
    const aliceSpaces = await aliceTenant.spaces.list();
    expect(aliceSpaces).toHaveLength(1);
    expect(aliceSpaces[0].folder).toBe('space-00000000000000000000000000000001');
    expect(aliceSpaces[0].executionMode).toBe('container');

    // Verify Bob (User)
    expect(fixtures.user.username).toBe('bob');
    expect(fixtures.user.role).toBe('user');
    expect(fixtures.user.status).toBe('active');
    expect(fixtures.user.passwordHash.startsWith('scrypt$')).toBe(true);
    expect(fixtures.userContainerSpace.executionMode).toBe('container');

    // Verify Charlie (Disabled)
    expect(fixtures.disabledUser.username).toBe('charlie_disabled');
    expect(fixtures.disabledUser.status).toBe('disabled');

    // Test Alice can login
    const aliceLogin = await authService.login('alice', 'AliceCustomPassword123!');
    expect(aliceLogin.user.id).toBe(fixtures.admin.id);

    // Test Bob can login
    const bobLogin = await authService.login('bob', 'BobCustomPassword123!');
    expect(bobLogin.user.id).toBe(fixtures.user.id);

    // Test Charlie is rejected on login with unified 401 Unauthorized
    await expect(authService.login('charlie_disabled', 'CharlieDisabledPass123!')).rejects.toThrow(
      UnauthorizedError
    );

    // Test Idempotency: running provisionFixtures again on existing DB does not fail
    const reFixtures = await provisionFixtures(storage, authService, {
      adminPassword: 'AliceCustomPassword123!',
      userPassword: 'BobCustomPassword123!',
      disabledPassword: 'CharlieDisabledPass123!',
    });
    expect(reFixtures.admin.id).toBe(fixtures.admin.id);
    expect(reFixtures.user.id).toBe(fixtures.user.id);
  });

  it('rejects provisioning when any required password is missing or empty', async () => {
    // @ts-expect-error test missing options
    await expect(provisionFixtures(storage, authService, undefined)).rejects.toThrow(
      /provisionFixtures requires explicit non-empty adminPassword, userPassword, and disabledPassword/
    );

    // @ts-expect-error test empty options object
    await expect(provisionFixtures(storage, authService, {})).rejects.toThrow(
      /provisionFixtures requires explicit non-empty adminPassword, userPassword, and disabledPassword/
    );

    await expect(
      provisionFixtures(storage, authService, {
        adminPassword: '',
        userPassword: 'user-pass',
        disabledPassword: 'disabled-pass',
      })
    ).rejects.toThrow(/provisionFixtures requires explicit non-empty adminPassword, userPassword, and disabledPassword/);

    await expect(
      provisionFixtures(storage, authService, {
        adminPassword: 'admin-pass',
        userPassword: '',
        disabledPassword: 'disabled-pass',
      })
    ).rejects.toThrow(/provisionFixtures requires explicit non-empty adminPassword, userPassword, and disabledPassword/);

    await expect(
      provisionFixtures(storage, authService, {
        adminPassword: 'admin-pass',
        userPassword: 'user-pass',
        disabledPassword: '',
      })
    ).rejects.toThrow(/provisionFixtures requires explicit non-empty adminPassword, userPassword, and disabledPassword/);
  });
});
