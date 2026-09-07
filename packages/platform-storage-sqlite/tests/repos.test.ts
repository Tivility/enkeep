import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSqliteStorage, SqlitePlatformStorage } from '../src/index.js';
import { NotFoundError } from '@enkeep/platform-core';
import { TEST_FULL_MIGRATIONS } from './v9-agent-profiles-repo.test.js';

describe('Sqlite Core Repositories', () => {
  let storage: SqlitePlatformStorage;

  beforeEach(async () => {
    storage = await createSqliteStorage({ dbPath: ':memory:', migrations: TEST_FULL_MIGRATIONS });
  });

  afterEach(async () => {
    await storage.close();
  });

  it('performs CRUD and filtering on users', async () => {
    const user1 = await storage.users.create({
      username: 'alice',
      passwordHash: 'hash1',
      role: 'admin',
      displayName: 'Alice Admin',
    });

    const user2 = await storage.users.create({
      username: 'bob',
      passwordHash: 'hash2',
      role: 'user',
      status: 'disabled',
    });

    expect(await storage.users.count()).toBe(2);

    const foundByUsername = await storage.users.findByUsername('alice');
    expect(foundByUsername?.id).toBe(user1.id);
    expect(foundByUsername?.displayName).toBe('Alice Admin');

    const updated = await storage.users.update(user1.id, {
      displayName: 'Alice Super Admin',
      status: 'active',
    });
    expect(updated.displayName).toBe('Alice Super Admin');

    const admins = await storage.users.list({ role: 'admin' });
    expect(admins.length).toBe(1);
    expect(admins[0].id).toBe(user1.id);

    const disabledUsers = await storage.users.list({ status: 'disabled' });
    expect(disabledUsers.length).toBe(1);
    expect(disabledUsers[0].id).toBe(user2.id);

    await expect(storage.users.update('non-existent', { displayName: 'Ghost' })).rejects.toThrow(
      NotFoundError
    );
  });

  it('manages user sessions, revocation and expiration', async () => {
    const user = await storage.users.create({
      username: 'session_user',
      passwordHash: 'hash',
    });

    const session1 = await storage.sessions.create({
      userId: user.id,
      tokenHash: 'token_hash_1',
      expiresAt: new Date(Date.now() + 100000).toISOString(),
    });

    const session2 = await storage.sessions.create({
      userId: user.id,
      tokenHash: 'token_hash_2',
      expiresAt: new Date(Date.now() - 10000).toISOString(), // expired
    });

    const found = await storage.sessions.findByTokenHash('token_hash_1');
    expect(found?.id).toBe(session1.id);

    // Revoke session1
    await storage.sessions.revoke(session1.id);
    const revoked = await storage.sessions.findById(session1.id);
    expect(revoked?.revokedAt).not.toBeNull();

    // Revoke all
    const revokedCount = await storage.sessions.revokeAllForUser(user.id);
    expect(revokedCount).toBe(1); // session2

    // Cleanup expired and revoked
    const deletedCount = await storage.sessions.deleteExpired();
    expect(deletedCount).toBe(2);
  });

  it('records and queries auth audit logs', async () => {
    const user = await storage.users.create({
      username: 'audit_user',
      passwordHash: 'hash',
    });

    const log1 = await storage.auditLogs.create({
      userId: user.id,
      username: 'audit_user',
      action: 'login_success',
      ipAddress: '127.0.0.1',
      userAgent: 'Vitest/Agent',
      details: { method: 'password' },
    });

    const log2 = await storage.auditLogs.create({
      username: 'audit_user',
      action: 'login_failure',
      details: { reason: 'bad_pwd' },
    });

    expect(log1.id).toBeDefined();
    expect(log1.details).toEqual({ method: 'password' });

    const userLogs = await storage.auditLogs.listByUserId(user.id);
    expect(userLogs.length).toBe(1);
    expect(userLogs[0].action).toBe('login_success');

    const failureLogs = await storage.auditLogs.listRecent({ action: 'login_failure' });
    expect(failureLogs.length).toBe(1);
    expect(failureLogs[0].action).toBe('login_failure');

    // Test countRecentFailures
    if (storage.auditLogs.countRecentFailures) {
      const recentFailures = await storage.auditLogs.countRecentFailures({
        username: 'audit_user',
        windowSeconds: 3600,
      });
      expect(recentFailures).toBe(1);

      const otherUserFailures = await storage.auditLogs.countRecentFailures({
        username: 'other_user',
        windowSeconds: 3600,
      });
      expect(otherUserFailures).toBe(0);
    }
  });
});
