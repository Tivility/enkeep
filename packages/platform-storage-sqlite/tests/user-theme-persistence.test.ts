import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  SqliteUserRepository,
  SqliteMigrationRunner,
  parseUserRow,
  MIGRATION_001_SQL,
  MIGRATION_013_USER_LOCALE_PREFERENCES_SQL,
  MIGRATION_028_USER_THEME_PREFERENCES_SQL,
} from '../src/index.js';
import type { User, CreateUserInput } from '@enkeep/platform-core';

describe('SqliteUserRepository & Theme Persistence (Migration 28)', () => {
  it('creates and reads user with default theme "dark"', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(MIGRATION_001_SQL);
    db.exec(MIGRATION_013_USER_LOCALE_PREFERENCES_SQL);
    db.exec(MIGRATION_028_USER_THEME_PREFERENCES_SQL);

    const userRepo = new SqliteUserRepository(db);

    const user = await userRepo.create({
      username: 'alice',
      passwordHash: 'scrypt$dummy_hash',
      displayName: 'Alice',
    });

    expect(user.theme).toBe('dark');

    const fetched = await userRepo.findById(user.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.theme).toBe('dark');

    const fetchedByUsername = await userRepo.findByUsername('alice');
    expect(fetchedByUsername).not.toBeNull();
    expect(fetchedByUsername?.theme).toBe('dark');

    db.close();
  });

  it('creates and reads user with explicit theme "light" and "eye-care"', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(MIGRATION_001_SQL);
    db.exec(MIGRATION_013_USER_LOCALE_PREFERENCES_SQL);
    db.exec(MIGRATION_028_USER_THEME_PREFERENCES_SQL);

    const userRepo = new SqliteUserRepository(db);

    const userLight = await userRepo.create({
      username: 'bob',
      passwordHash: 'scrypt$dummy_hash',
      displayName: 'Bob',
      theme: 'light',
    });
    expect(userLight.theme).toBe('light');

    const userEyeCare = await userRepo.create({
      username: 'charlie',
      passwordHash: 'scrypt$dummy_hash',
      displayName: 'Charlie',
      theme: 'eye-care',
    });
    expect(userEyeCare.theme).toBe('eye-care');

    const fetchedBob = await userRepo.findById(userLight.id);
    expect(fetchedBob?.theme).toBe('light');

    const fetchedCharlie = await userRepo.findById(userEyeCare.id);
    expect(fetchedCharlie?.theme).toBe('eye-care');

    db.close();
  });

  it('updates user theme from "dark" to "light" and to "eye-care"', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(MIGRATION_001_SQL);
    db.exec(MIGRATION_013_USER_LOCALE_PREFERENCES_SQL);
    db.exec(MIGRATION_028_USER_THEME_PREFERENCES_SQL);

    const userRepo = new SqliteUserRepository(db);

    const user = await userRepo.create({
      username: 'david',
      passwordHash: 'scrypt$dummy_hash',
    });
    expect(user.theme).toBe('dark');

    const updated1 = await userRepo.update(user.id, { theme: 'light' });
    expect(updated1.theme).toBe('light');

    const fetched1 = await userRepo.findById(user.id);
    expect(fetched1?.theme).toBe('light');

    const updated2 = await userRepo.update(user.id, { theme: 'eye-care' });
    expect(updated2.theme).toBe('eye-care');

    const fetched2 = await userRepo.findById(user.id);
    expect(fetched2?.theme).toBe('eye-care');

    db.close();
  });

  it('enforces SQLite CHECK constraint rejecting invalid theme values directly at database level', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(MIGRATION_001_SQL);
    db.exec(MIGRATION_013_USER_LOCALE_PREFERENCES_SQL);
    db.exec(MIGRATION_028_USER_THEME_PREFERENCES_SQL);

    // Invalid theme value 'sepia'
    expect(() => {
      db.prepare(`
        INSERT INTO users (id, username, password_hash, role, status, locale, theme)
        VALUES ('u_bad1', 'bad1', 'hash', 'user', 'active', 'en', 'sepia')
      `).run();
    }).toThrow(/CHECK constraint failed/);

    // Invalid uppercase 'DARK'
    expect(() => {
      db.prepare(`
        INSERT INTO users (id, username, password_hash, role, status, locale, theme)
        VALUES ('u_bad2', 'bad2', 'hash', 'user', 'active', 'en', 'DARK')
      `).run();
    }).toThrow(/CHECK constraint failed/);

    // Invalid whitespace ' eye-care '
    expect(() => {
      db.prepare(`
        INSERT INTO users (id, username, password_hash, role, status, locale, theme)
        VALUES ('u_bad3', 'bad3', 'hash', 'user', 'active', 'en', ' eye-care ')
      `).run();
    }).toThrow(/CHECK constraint failed/);

    db.close();
  });

  it('fails closed with strict error in parseUserRow when theme row value is corrupted', () => {
    const corruptRow = {
      id: 'u_corrupt',
      username: 'corrupt_user',
      password_hash: 'hash',
      role: 'user',
      status: 'active',
      display_name: null,
      locale: 'en',
      theme: 'invalid_theme_solarized',
      created_at: '2025-01-01 00:00:00',
      updated_at: '2025-01-01 00:00:00',
    };

    expect(() => parseUserRow(corruptRow)).toThrow(
      /Corrupted user row: invalid or damaged theme 'invalid_theme_solarized'/
    );

    const nullThemeRow = {
      id: 'u_corrupt_null',
      username: 'corrupt_user_null',
      password_hash: 'hash',
      role: 'user',
      status: 'active',
      display_name: null,
      locale: 'en',
      theme: null,
      created_at: '2025-01-01 00:00:00',
      updated_at: '2025-01-01 00:00:00',
    };

    expect(() => parseUserRow(nullThemeRow)).toThrow(
      /Corrupted user row: invalid or damaged theme 'null'/
    );
  });
});
