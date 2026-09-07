import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  computeChecksum,
} from '../src/storage/migrations.js';
import {
  MigrationDowngradeError,
  MigrationChecksumMismatchError,
  MigrationError,
} from '@enkeep/platform-core';

describe('Platform Server Migration v9: Real Data Upgrade & Hardening', () => {
  let db: DatabaseSync;
  let runner: PlatformServerMigrationRunner;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runner = new PlatformServerMigrationRunner(db);
  });

  afterEach(() => {
    db.close();
  });

  it('proves v1-v8 to v9 upgrade with real pre-existing data, validating foreign keys and default values', async () => {
    // 1. Migrate to version 8
    const manifest1to8 = ALL_PLATFORM_MIGRATIONS.slice(0, 8);
    const applied8 = await runner.migrate(manifest1to8);
    expect(applied8.length).toBe(8);
    expect(await runner.getCurrentVersion()).toBe(8);

    // 2. Seed pre-existing v8 data
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status, display_name)
      VALUES ('u_alice', 'alice', 'hash_alice', 'admin', 'active', 'Alice Admin'),
             ('u_bob', 'bob', 'hash_bob', 'user', 'active', 'Bob User');
    `).run();

    db.prepare(`
      INSERT INTO spaces (id, user_id, name, folder, execution_mode)
      VALUES ('sp_alice_1', 'u_alice', 'Alice Project', 'alice-folder', 'container'),
             ('sp_bob_1', 'u_bob', 'Bob Project', 'bob-folder', 'container');
    `).run();

    db.prepare(`
      INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode)
      VALUES ('sr_alice_1', 'sp_alice_1', 'u_alice', 'web', 'default', 'ctx_a1', 'peer_a1', 'dsh_sess_alice_1', 'container'),
             ('sr_bob_1', 'sp_bob_1', 'u_bob', 'web', 'default', 'ctx_b1', 'peer_b1', 'dsh_sess_bob_1', 'container');
    `).run();

    db.prepare(`
      INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key)
      VALUES ('msg_1', 'sr_alice_1', 'u_alice', 'user', 'Initial prompt', 'delivered', 'web:u_alice:ctx_a1'),
             ('msg_2', 'sr_alice_1', 'u_alice', 'assistant', 'Response message', 'delivered', 'web:u_alice:ctx_a1');
    `).run();

    db.prepare(`
      INSERT INTO fixed_import_receipts (
        user_id, source_fingerprint, importer_version, id_algorithm, target_dsh, session_format,
        source_chats_count, source_messages_count, imported_messages_count, dropped_messages_count,
        attachments_count, canonical_hash
      ) VALUES (
        'u_alice', 'fp_alice_001', '1.0.0', 'sha256', '0.1.1', 1,
        1, 2, 2, 0, 0, 'hash_canonical_001'
      );
    `).run();

    // 3. Migrate to v9 using manifest up to v9
    const manifest1to9 = ALL_PLATFORM_MIGRATIONS.slice(0, 9);
    const applied9 = await runner.migrate(manifest1to9);
    expect(applied9.length).toBe(1);
    expect(applied9[0].version).toBe(9);
    expect(applied9[0].name).toBe('009_agent_profiles_lifecycle_and_generations');
    expect(await runner.getCurrentVersion()).toBe(9);

    // 4. Foreign Key Integrity Check
    const fkViolations = db.prepare('PRAGMA foreign_key_check;').all();
    expect(fkViolations).toEqual([]);

    // 5. Verify upgraded spaces table schema & values
    const spaceRow = db.prepare('SELECT * FROM spaces WHERE id = ?').get('sp_alice_1') as Record<string, unknown>;
    expect(spaceRow['status']).toBe('active');
    expect(spaceRow['agent_profile_id']).toBeNull();
    expect(spaceRow['agent_profile_snapshot_id']).toBeNull();

    // 6. Verify upgraded session_routes table schema & values
    const routeRow = db.prepare('SELECT * FROM session_routes WHERE id = ?').get('sr_alice_1') as Record<string, unknown>;
    expect(routeRow['status']).toBe('active');
    expect(routeRow['title']).toBeNull();
    expect(routeRow['last_reset_at']).toBeNull();
    expect(Number(routeRow['reset_count'])).toBe(0);
    expect(Number(routeRow['current_generation'])).toBe(1);
    expect(routeRow['agent_profile_id']).toBeNull();
    expect(routeRow['agent_profile_snapshot_id']).toBeNull();

    // 7. Verify generation 1 backfilled for EVERY session route
    const gensAlice = db.prepare('SELECT * FROM session_generations WHERE route_id = ?').all('sr_alice_1') as Array<Record<string, unknown>>;
    expect(gensAlice.length).toBe(1);
    expect(gensAlice[0].user_id).toBe('u_alice');
    expect(gensAlice[0].route_id).toBe('sr_alice_1');
    expect(Number(gensAlice[0].generation_number)).toBe(1);
    expect(gensAlice[0].dsh_session_id).toBe('dsh_sess_alice_1');
    expect(gensAlice[0].agent_profile_snapshot_id).toBeNull();
    expect(gensAlice[0].reset_reason).toBe('initial');

    const gensBob = db.prepare('SELECT * FROM session_generations WHERE route_id = ?').all('sr_bob_1') as Array<Record<string, unknown>>;
    expect(gensBob.length).toBe(1);
    expect(gensBob[0].user_id).toBe('u_bob');
    expect(gensBob[0].route_id).toBe('sr_bob_1');
    expect(Number(gensBob[0].generation_number)).toBe(1);
    expect(gensBob[0].dsh_session_id).toBe('dsh_sess_bob_1');
    expect(gensBob[0].agent_profile_snapshot_id).toBeNull();
    expect(gensBob[0].reset_reason).toBe('initial');

    // 8. Verify pre-existing data is completely untouched
    const userRow = db.prepare('SELECT username FROM users WHERE id = ?').get('u_alice') as { username: string };
    expect(userRow.username).toBe('alice');

    const msgCount = db.prepare('SELECT count(*) as c FROM web_messages WHERE session_id = ?').get('sr_alice_1') as { c: number };
    expect(Number(msgCount.c)).toBe(2);

    const receipt = db.prepare('SELECT source_fingerprint FROM fixed_import_receipts WHERE user_id = ?').get('u_alice') as { source_fingerprint: string };
    expect(receipt.source_fingerprint).toBe('fp_alice_001');

    // 9. Re-running migration is idempotent
    const reapply = await runner.migrate(manifest1to9);
    expect(reapply.length).toBe(0);
    expect(await runner.getCurrentVersion()).toBe(9);
  });

  it('verifies v8 to v10 upgrade, generation 1 per route backfill, FK checks, and ON DELETE RESTRICT enforcement', async () => {
    // 1. Migrate to version 8
    const manifest1to8 = ALL_PLATFORM_MIGRATIONS.slice(0, 8);
    await runner.migrate(manifest1to8);
    expect(await runner.getCurrentVersion()).toBe(8);

    // 2. Seed v8 data with multiple routes
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status)
      VALUES ('u_t1', 'tenant1', 'hash_t1', 'user', 'active'),
             ('u_t2', 'tenant2', 'hash_t2', 'user', 'active');
    `).run();

    db.prepare(`
      INSERT INTO spaces (id, user_id, name, folder, execution_mode)
      VALUES ('sp_t1_a', 'u_t1', 'Space T1 A', 't1-a', 'container'),
             ('sp_t2_a', 'u_t2', 'Space T2 A', 't2-a', 'container');
    `).run();

    db.prepare(`
      INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode)
      VALUES ('sr_t1_1', 'sp_t1_a', 'u_t1', 'web', 'default', 'ctx_t1_1', 'peer_1', 'dsh_t1_1', 'container'),
             ('sr_t1_2', 'sp_t1_a', 'u_t1', 'web', 'default', 'ctx_t1_2', 'peer_2', 'dsh_t1_2', 'container'),
             ('sr_t2_1', 'sp_t2_a', 'u_t2', 'web', 'default', 'ctx_t2_1', 'peer_3', 'dsh_t2_1', 'container');
    `).run();

    // 3. Migrate all the way to v10
    const upgraded = await runner.migrate(ALL_PLATFORM_MIGRATIONS.slice(0, 10));
    expect(upgraded.length).toBe(2); // v9 and v10
    expect(await runner.getCurrentVersion()).toBe(10);

    // 4. FK check passes
    const fkCheck = db.prepare('PRAGMA foreign_key_check;').all();
    expect(fkCheck).toEqual([]);

    // 5. Verify every route has exactly one generation 1 record backfilled
    const allGens = db.prepare('SELECT * FROM session_generations ORDER BY route_id').all() as Array<Record<string, unknown>>;
    expect(allGens.length).toBe(3);

    const genT1_1 = allGens.find((g) => g.route_id === 'sr_t1_1');
    expect(genT1_1).toBeDefined();
    expect(genT1_1?.user_id).toBe('u_t1');
    expect(Number(genT1_1?.generation_number)).toBe(1);
    expect(genT1_1?.dsh_session_id).toBe('dsh_t1_1');
    expect(genT1_1?.reset_reason).toBe('initial');

    const genT1_2 = allGens.find((g) => g.route_id === 'sr_t1_2');
    expect(genT1_2).toBeDefined();
    expect(genT1_2?.user_id).toBe('u_t1');
    expect(Number(genT1_2?.generation_number)).toBe(1);
    expect(genT1_2?.dsh_session_id).toBe('dsh_t1_2');
    expect(genT1_2?.reset_reason).toBe('initial');

    const genT2_1 = allGens.find((g) => g.route_id === 'sr_t2_1');
    expect(genT2_1).toBeDefined();
    expect(genT2_1?.user_id).toBe('u_t2');
    expect(Number(genT2_1?.generation_number)).toBe(1);
    expect(genT2_1?.dsh_session_id).toBe('dsh_t2_1');
    expect(genT2_1?.reset_reason).toBe('initial');

    // 6. Test prompt_hash CHECK constraint (exactly 64 lowercase hex characters)
    const validHash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0';
    db.prepare(`
      INSERT INTO agent_profiles (id, user_id, name, status, active_version)
      VALUES ('prof_1', 'u_t1', 'Engineer Profile', 'active', 1)
    `).run();

    db.prepare(`
      INSERT INTO agent_profile_snapshots (id, user_id, profile_id, version, prompt_mode, prompt_hash, identity, soul, agents, tools)
      VALUES ('snap_1', 'u_t1', 'prof_1', 1, 'append', ?, 'id', 'soul', 'agents', 'tools')
    `).run(validHash);

    // Uppercase hex must fail
    const upperHash = 'A1B2C3D4E5F60718293A4B5C6D7E8F90123456789ABCDEF0123456789ABCDEF0';
    expect(() => {
      db.prepare(`
        INSERT INTO agent_profile_snapshots (id, user_id, profile_id, version, prompt_mode, prompt_hash, identity, soul, agents, tools)
        VALUES ('snap_bad_upper', 'u_t1', 'prof_1', 2, 'append', ?, 'id', 'soul', 'agents', 'tools')
      `).run(upperHash);
    }).toThrow();

    // Wrong length must fail
    expect(() => {
      db.prepare(`
        INSERT INTO agent_profile_snapshots (id, user_id, profile_id, version, prompt_mode, prompt_hash, identity, soul, agents, tools)
        VALUES ('snap_bad_len', 'u_t1', 'prof_1', 3, 'append', 'abcdef', 'id', 'soul', 'agents', 'tools')
      `).run();
    }).toThrow();

    // 7. Verify ON DELETE RESTRICT on agent_profiles and agent_profile_snapshots
    // Bind snapshot to space
    db.prepare(`UPDATE spaces SET agent_profile_id = 'prof_1', agent_profile_snapshot_id = 'snap_1' WHERE id = 'sp_t1_a'`).run();

    // Enable foreign keys explicitly in SQLite connection
    db.exec('PRAGMA foreign_keys = ON;');

    // Attempting to delete snap_1 or prof_1 when referenced by spaces must fail with RESTRICT
    expect(() => {
      db.prepare('DELETE FROM agent_profile_snapshots WHERE id = ?').run('snap_1');
    }).toThrow(/FOREIGN KEY constraint failed/);

    expect(() => {
      db.prepare('DELETE FROM agent_profiles WHERE id = ?').run('prof_1');
    }).toThrow(/FOREIGN KEY constraint failed/);

    // Bind snapshot to session_routes
    db.prepare(`UPDATE session_routes SET agent_profile_id = 'prof_1', agent_profile_snapshot_id = 'snap_1' WHERE id = 'sr_t1_1'`).run();

    expect(() => {
      db.prepare('DELETE FROM agent_profile_snapshots WHERE id = ?').run('snap_1');
    }).toThrow(/FOREIGN KEY constraint failed/);

    // Bind snapshot to session_generations
    db.prepare(`UPDATE session_generations SET agent_profile_snapshot_id = 'snap_1' WHERE route_id = 'sr_t1_1'`).run();

    expect(() => {
      db.prepare('DELETE FROM agent_profile_snapshots WHERE id = ?').run('snap_1');
    }).toThrow(/FOREIGN KEY constraint failed/);

    // 8. Verify deleting tenant cascades and cleans up user's profiles, snapshots, routes, and generations
    db.prepare('DELETE FROM users WHERE id = ?').run('u_t2');
    const remainingRoutesT2 = db.prepare('SELECT count(*) as c FROM session_routes WHERE user_id = ?').get('u_t2') as { c: number };
    expect(remainingRoutesT2.c).toBe(0);
    const remainingGensT2 = db.prepare('SELECT count(*) as c FROM session_generations WHERE user_id = ?').get('u_t2') as { c: number };
    expect(remainingGensT2.c).toBe(0);
  });

  it('validates published checksums across all migrations v1-v9', async () => {
    const manifest1to9 = ALL_PLATFORM_MIGRATIONS.slice(0, 9);
    await runner.migrate(manifest1to9);
    await expect(runner.verifyChecksums(manifest1to9)).resolves.not.toThrow();

    const applied = await runner.getAppliedMigrations();
    expect(applied.length).toBe(9);
    for (const def of manifest1to9) {
      const rec = applied.find((r) => r.version === def.version);
      expect(rec).toBeDefined();
      expect(rec?.checksum).toBe(def.checksum);
    }
  });

  it('detects tampering and checksum mismatch on migration v9', async () => {
    const manifest1to9 = ALL_PLATFORM_MIGRATIONS.slice(0, 9);
    await runner.migrate(manifest1to9);
    db.prepare(`UPDATE _schema_migrations SET checksum = 'tampered_checksum_9' WHERE version = 9`).run();

    await expect(runner.verifyChecksums(manifest1to9)).rejects.toThrow(MigrationChecksumMismatchError);
    await expect(runner.migrate(manifest1to9)).rejects.toThrow(MigrationChecksumMismatchError);
  });

  it('strictly prevents downgrade if database is at v9 and code manifest is at v8', async () => {
    const manifest1to9 = ALL_PLATFORM_MIGRATIONS.slice(0, 9);
    await runner.migrate(manifest1to9);
    expect(await runner.getCurrentVersion()).toBe(9);

    const manifestV8 = ALL_PLATFORM_MIGRATIONS.slice(0, 8);
    await expect(runner.migrate(manifestV8)).rejects.toThrow(MigrationDowngradeError);
  });

  it('proves concurrent migration to v9 over two independent WAL connections', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'enkeep-srv-concurrency-'));
    const dbPath = join(tempDir, 'concurrent-v9-server.db');
    const manifest1to9 = ALL_PLATFORM_MIGRATIONS.slice(0, 9);

    try {
      const conn1 = new DatabaseSync(dbPath);
      const conn2 = new DatabaseSync(dbPath);
      conn1.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;');
      conn2.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;');

      const runner1 = new PlatformServerMigrationRunner(conn1);
      const runner2 = new PlatformServerMigrationRunner(conn2);

      // Concurrently run migrations on both connections
      const [res1, res2] = await Promise.all([
        runner1.migrate(manifest1to9),
        runner2.migrate(manifest1to9),
      ]);

      const totalNewlyApplied = res1.length + res2.length;
      expect(totalNewlyApplied).toBe(9);
      expect(await runner1.getCurrentVersion()).toBe(9);
      expect(await runner2.getCurrentVersion()).toBe(9);

      conn1.close();
      conn2.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
