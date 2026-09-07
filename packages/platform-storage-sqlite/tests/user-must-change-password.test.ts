import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqliteUserRepository } from '../src/repos/user-repo.js';
import { BUILTIN_MIGRATIONS, MIGRATION_013_USER_LOCALE_PREFERENCES_SQL, MIGRATION_017_USER_MUST_CHANGE_PASSWORD_SQL } from '../src/schema/migrations.js';

describe('SqliteUserRepository mustChangePassword persistence & parsing', () => {
  it('creates and parses user with mustChangePassword = true / false', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(BUILTIN_MIGRATIONS[0].upSql);
    db.exec(MIGRATION_013_USER_LOCALE_PREFERENCES_SQL);
    db.exec(MIGRATION_017_USER_MUST_CHANGE_PASSWORD_SQL);

    const repo = new SqliteUserRepository(db);

    // Create user with mustChangePassword: true
    const user1 = await repo.create({
      username: 'alice_temp',
      passwordHash: 'hash1',
      mustChangePassword: true,
    });
    expect(user1.mustChangePassword).toBe(true);

    // Fetch from DB
    const fetched1 = await repo.findById(user1.id);
    expect(fetched1?.mustChangePassword).toBe(true);

    // Update mustChangePassword to false
    const updated1 = await repo.update(user1.id, { mustChangePassword: false });
    expect(updated1.mustChangePassword).toBe(false);

    // Create user without mustChangePassword (default: 0 -> false)
    const user2 = await repo.create({
      username: 'bob_normal',
      passwordHash: 'hash2',
    });
    expect(user2.mustChangePassword).toBe(false);

    const fetched2 = await repo.findById(user2.id);
    expect(fetched2?.mustChangePassword).toBe(false);

    db.close();
  });
});
