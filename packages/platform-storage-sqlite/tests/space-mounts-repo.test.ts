import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSqliteStorage, SqlitePlatformStorage, MIGRATION_029_SPACE_MOUNTS_SQL } from '../src/index.js';
import { TEST_V9_FULL_MIGRATIONS } from './v9-agent-profiles-repo.test.js';
import { ConflictError, type MigrationDefinition } from '@enkeep/platform-core';

const TEST_MIGRATIONS_WITH_MOUNTS: MigrationDefinition[] = [
  ...TEST_V9_FULL_MIGRATIONS,
  ...Array.from({ length: 18 }, (_, i) => ({
    version: 11 + i,
    name: `0${11 + i}_dummy`,
    upSql: 'SELECT 1;',
  })),
  {
    version: 29,
    name: '029_space_mounts',
    upSql: MIGRATION_029_SPACE_MOUNTS_SQL,
  },
];

describe('SqliteTenantScopedSpaceMountRepository', () => {
  let storage: SqlitePlatformStorage;
  let userId1: string;
  let userId2: string;
  let spaceId1: string;
  let spaceId2: string;

  beforeEach(async () => {
    storage = await createSqliteStorage({ dbPath: ':memory:', migrations: TEST_MIGRATIONS_WITH_MOUNTS });

    const u1 = await storage.users.create({
      username: 'user1',
      displayName: 'User 1',
      passwordHash: 'hash1',
    });
    userId1 = u1.id;

    const u2 = await storage.users.create({
      username: 'user2',
      displayName: 'User 2',
      passwordHash: 'hash2',
    });
    userId2 = u2.id;

    const s1 = await storage.forTenant(userId1).spaces.create({
      name: 'Space 1',
      folder: 'space-1',
    });
    spaceId1 = s1.id;

    const s2 = await storage.forTenant(userId2).spaces.create({
      name: 'Space 2',
      folder: 'space-2',
    });
    spaceId2 = s2.id;
  });

  afterEach(async () => {
    if (storage) {
      await storage.close();
    }
  });

  it('creates and retrieves space mounts with encrypted fields', async () => {
    const repo = storage.forTenant(userId1).spaceMounts;

    const created = await repo.create({
      spaceId: spaceId1,
      name: 'my_data',
      sourcePathEncrypted: 'enc:v1:aes-gcm:sample-ciphertext',
      sourceFingerprint: 'hmac-sha256:abcd1234efgh5678',
      mode: 'ro',
    });

    expect(created.id).toMatch(/^mnt_/);
    expect(created.userId).toBe(userId1);
    expect(created.spaceId).toBe(spaceId1);
    expect(created.name).toBe('my_data');
    expect(created.sourcePathEncrypted).toBe('enc:v1:aes-gcm:sample-ciphertext');
    expect(created.sourceFingerprint).toBe('hmac-sha256:abcd1234efgh5678');
    expect(created.mode).toBe('ro');

    const byId = await repo.findById(created.id);
    expect(byId).toEqual(created);

    const byName = await repo.findByName(spaceId1, 'my_data');
    expect(byName).toEqual(created);

    const list = await repo.listBySpace(spaceId1);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(created);

    const all = await repo.listAllForUser();
    expect(all).toHaveLength(1);
  });

  it('enforces tenant isolation between users', async () => {
    const repo1 = storage.forTenant(userId1).spaceMounts;
    const repo2 = storage.forTenant(userId2).spaceMounts;

    const mount1 = await repo1.create({
      spaceId: spaceId1,
      name: 'mount_u1',
      sourcePathEncrypted: 'enc:u1',
      sourceFingerprint: 'hmac-sha256:u1',
      mode: 'rw',
    });

    // User 2 cannot find user 1's mount by ID or name
    expect(await repo2.findById(mount1.id)).toBeNull();
    expect(await repo2.findByName(spaceId1, 'mount_u1')).toBeNull();
    expect(await repo2.listBySpace(spaceId1)).toHaveLength(0);
    expect(await repo2.listAllForUser()).toHaveLength(0);

    // User 2 cannot delete user 1's mount
    const deleted = await repo2.delete(mount1.id);
    expect(deleted).toBe(false);
    expect(await repo1.findById(mount1.id)).not.toBeNull();
  });

  it('rejects duplicate mount names in same space', async () => {
    const repo = storage.forTenant(userId1).spaceMounts;

    await repo.create({
      spaceId: spaceId1,
      name: 'duplicate_name',
      sourcePathEncrypted: 'enc:1',
      sourceFingerprint: 'hmac:1',
      mode: 'ro',
    });

    await expect(
      repo.create({
        spaceId: spaceId1,
        name: 'duplicate_name',
        sourcePathEncrypted: 'enc:2',
        sourceFingerprint: 'hmac:2',
        mode: 'rw',
      })
    ).rejects.toThrow(ConflictError);
  });

  it('restores mount row and supports deletion', async () => {
    const repo = storage.forTenant(userId1).spaceMounts;

    const mount = await repo.create({
      spaceId: spaceId1,
      name: 'to_delete',
      sourcePathEncrypted: 'enc:del',
      sourceFingerprint: 'hmac:del',
      mode: 'ro',
    });

    const deleted = await repo.delete(mount.id);
    expect(deleted).toBe(true);
    expect(await repo.findById(mount.id)).toBeNull();

    // Restore
    const restored = await repo.restore(mount);
    expect(restored.id).toBe(mount.id);
    expect(await repo.findById(mount.id)).not.toBeNull();

    // Delete by space
    const count = await repo.deleteBySpace(spaceId1);
    expect(count).toBe(1);
    expect(await repo.findById(mount.id)).toBeNull();
  });
});
