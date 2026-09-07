import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  SqliteUserRepository,
  SqliteMigrationRunner,
  parseUserRow,
  MIGRATION_001_SQL,
  MIGRATION_013_USER_LOCALE_PREFERENCES_SQL,
  computeChecksum,
} from '../src/index.js';
import type { User, CreateUserInput } from '@enkeep/platform-core';

describe('SqliteUserRepository & Locale Persistence', () => {
  it('creates and reads user with default locale "en"', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(MIGRATION_001_SQL);
    db.exec(MIGRATION_013_USER_LOCALE_PREFERENCES_SQL);

    const userRepo = new SqliteUserRepository(db);

    const user = await userRepo.create({
      username: 'alice',
      passwordHash: 'scrypt$dummy_hash',
      displayName: 'Alice',
    });

    expect(user.locale).toBe('en');

    const fetched = await userRepo.findById(user.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.locale).toBe('en');

    const fetchedByUsername = await userRepo.findByUsername('alice');
    expect(fetchedByUsername).not.toBeNull();
    expect(fetchedByUsername?.locale).toBe('en');

    db.close();
  });

  it('creates and reads user with explicit locale "zh-CN"', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(MIGRATION_001_SQL);
    db.exec(MIGRATION_013_USER_LOCALE_PREFERENCES_SQL);

    const userRepo = new SqliteUserRepository(db);

    const user = await userRepo.create({
      username: 'bob',
      passwordHash: 'scrypt$dummy_hash',
      displayName: 'Bob',
      locale: 'zh-CN',
    });

    expect(user.locale).toBe('zh-CN');

    const fetched = await userRepo.findById(user.id);
    expect(fetched?.locale).toBe('zh-CN');

    db.close();
  });

  it('updates user locale from "en" to "zh-CN" and back to "en"', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(MIGRATION_001_SQL);
    db.exec(MIGRATION_013_USER_LOCALE_PREFERENCES_SQL);

    const userRepo = new SqliteUserRepository(db);

    const user = await userRepo.create({
      username: 'charlie',
      passwordHash: 'scrypt$dummy_hash',
    });
    expect(user.locale).toBe('en');

    const updated1 = await userRepo.update(user.id, { locale: 'zh-CN' });
    expect(updated1.locale).toBe('zh-CN');

    const fetched1 = await userRepo.findById(user.id);
    expect(fetched1?.locale).toBe('zh-CN');

    const updated2 = await userRepo.update(user.id, { locale: 'en' });
    expect(updated2.locale).toBe('en');

    const fetched2 = await userRepo.findById(user.id);
    expect(fetched2?.locale).toBe('en');

    db.close();
  });

  it('enforces SQLite CHECK constraint rejecting invalid locale values directly at database level', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(MIGRATION_001_SQL);
    db.exec(MIGRATION_013_USER_LOCALE_PREFERENCES_SQL);

    // Invalid lowercase zh-cn
    expect(() => {
      db.prepare(`
        INSERT INTO users (id, username, password_hash, role, status, locale)
        VALUES ('u_bad1', 'bad1', 'hash', 'user', 'active', 'zh-cn')
      `).run();
    }).toThrow(/CHECK constraint failed/);

    // Invalid whitespace
    expect(() => {
      db.prepare(`
        INSERT INTO users (id, username, password_hash, role, status, locale)
        VALUES ('u_bad2', 'bad2', 'hash', 'user', 'active', ' en ')
      `).run();
    }).toThrow(/CHECK constraint failed/);

    // Invalid language code
    expect(() => {
      db.prepare(`
        INSERT INTO users (id, username, password_hash, role, status, locale)
        VALUES ('u_bad3', 'bad3', 'hash', 'user', 'active', 'fr')
      `).run();
    }).toThrow(/CHECK constraint failed/);

    db.close();
  });

  it('fails closed with strict error in parseUserRow when locale row value is corrupted', () => {
    // Simulate corrupted database row
    const corruptRow = {
      id: 'u_corrupt',
      username: 'corrupt_user',
      password_hash: 'hash',
      role: 'user',
      status: 'active',
      display_name: null,
      locale: 'invalid_locale_corrupted',
      created_at: '2025-01-01 00:00:00',
      updated_at: '2025-01-01 00:00:00',
    };

    expect(() => parseUserRow(corruptRow)).toThrow(
      /Corrupted user row: invalid or damaged locale 'invalid_locale_corrupted'/
    );

    const nullLocaleRow = {
      id: 'u_corrupt_null',
      username: 'corrupt_user_null',
      password_hash: 'hash',
      role: 'user',
      status: 'active',
      display_name: null,
      locale: null,
      created_at: '2025-01-01 00:00:00',
      updated_at: '2025-01-01 00:00:00',
    };

    expect(() => parseUserRow(nullLocaleRow)).toThrow(
      /Corrupted user row: invalid or damaged locale 'null'/
    );
  });

  it('lists users and respects locale across multiple users', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(MIGRATION_001_SQL);
    db.exec(MIGRATION_013_USER_LOCALE_PREFERENCES_SQL);

    const userRepo = new SqliteUserRepository(db);

    await userRepo.create({ username: 'u_en', passwordHash: 'h', locale: 'en' });
    await userRepo.create({ username: 'u_zh', passwordHash: 'h', locale: 'zh-CN' });

    const all = await userRepo.list();
    expect(all.length).toBe(2);
    expect(all.find((u) => u.username === 'u_en')?.locale).toBe('en');
    expect(all.find((u) => u.username === 'u_zh')?.locale).toBe('zh-CN');

    db.close();
  });
});
