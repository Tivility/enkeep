import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SqliteMigrationRunner,
  createSqliteStorage,
  computeChecksum,
  BUILTIN_MIGRATIONS,
  MIGRATION_001_SQL,
  MIGRATION_002_SQL,
  MIGRATION_003_SQL,
  MIGRATION_004_SQL,
  MIGRATION_005_PLATFORM_SERVER_SQL,
  MIGRATION_006_DELIVERY_INBOX_AND_IDEMPOTENCY_SQL,
  MIGRATION_007_DELIVERY_INBOX_FAILED_STATUS_SQL,
  MIGRATION_008_FIXED_IMPORT_RECEIPTS_SQL,
  MIGRATION_009_AGENT_PROFILES_LIFECYCLE_AND_GENERATIONS_SQL,
  MIGRATION_010_QUOTA_BUNDLES_LIFECYCLE_SQL,
  MIGRATION_011_MODEL_CONFIG_OVERRIDES_SQL,
  MIGRATION_012_STORAGE_AND_QUOTA_RESET_AUDIT_SQL,
  MIGRATION_013_USER_LOCALE_PREFERENCES_SQL,
  MIGRATION_014_FILE_TRANSFER_JOURNAL_SQL,
  MIGRATION_015_MESSAGE_ATTACHMENTS_SQL,
  MIGRATION_016_ATTACHMENT_SNAPSHOT_JOURNAL_SQL,
  MIGRATION_017_USER_MUST_CHANGE_PASSWORD_SQL,
  MIGRATION_018_TASK_SCHEDULES_AND_RUNS_SQL,
  MIGRATION_019_FORK_RESERVED_SQL,
  MIGRATION_020_IMPORT_JOBS_SQL,
  MIGRATION_021_SKILL_PACKAGES_AND_BINDINGS_SQL,
  MIGRATION_022_PERMISSION_PRESETS_SQL,
  MIGRATION_023_MODEL_SELECTION_OVERRIDES_AND_HEALTH_SQL,
  MIGRATION_024_MESSAGE_REFERENCES_SQL,
  MIGRATION_025_RUNTIME_DIAGNOSTICS_SQL,
  MIGRATION_026_TASK_NOTIFICATIONS_SQL,
  MIGRATION_027_SESSION_EXECUTION_LEASES_SQL,
  MIGRATION_028_USER_THEME_PREFERENCE_SQL,
  MIGRATION_029_SPACE_MOUNTS_SQL,
  MIGRATION_030_EXTENSIONS_CATALOG_AND_BINDINGS_SQL,
  MIGRATION_031_GENERIC_CHANNELS_SQL,
} from '../src/index.js';
import {
  MigrationDowngradeError,
  MigrationChecksumMismatchError,
  MigrationError,
} from '@enkeep/platform-core';

describe('Sqlite migrations', () => {
  it('runs initial migrations through v4 and creates all required tables', async () => {
    const storage = await createSqliteStorage({ dbPath: ':memory:' });
    const applied = await storage.migrations.getAppliedMigrations();

    expect(applied.length).toBe(4);
    expect(applied[0].version).toBe(1);
    expect(applied[0].name).toBe('001_initial_happyclaw_subset');
    expect(applied[1].version).toBe(2);
    expect(applied[1].name).toBe('002_route_identity_and_scoped_cursors');
    expect(applied[2].version).toBe(3);
    expect(applied[2].name).toBe('003_delivery_inbox');
    expect(applied[3].version).toBe(4);
    expect(applied[3].name).toBe('004_platform_operations');

    const version = await storage.migrations.getCurrentVersion();
    expect(version).toBe(4);

    // Verify all HappyClaw minimal subset tables, delivery inbox, and platform operations tables exist
    const tables = storage.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('_schema_migrations');
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('user_sessions');
    expect(tableNames).toContain('auth_audit_log');
    expect(tableNames).toContain('spaces');
    expect(tableNames).toContain('session_routes');
    expect(tableNames).toContain('session_sources');
    expect(tableNames).toContain('delivery_receipts');
    expect(tableNames).toContain('delivery_inbox');
    expect(tableNames).toContain('event_cursors');
    expect(tableNames).toContain('turn_runs');
    expect(tableNames).toContain('quota_limits');
    expect(tableNames).toContain('quota_usage');
    expect(tableNames).toContain('quota_reservations');
    expect(tableNames).toContain('platform_tasks');
    expect(tableNames).toContain('file_metadata');

    await storage.close();
  });

  it('successfully upgrades a database incrementally through v1 -> v2 -> v3 -> v4', async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new SqliteMigrationRunner(db);

    // Step 1: Apply only v1
    const v1Applied = await runner.migrate([BUILTIN_MIGRATIONS[0]]);
    expect(v1Applied.length).toBe(1);
    expect(await runner.getCurrentVersion()).toBe(1);

    // Seed v1 data
    db.exec(`
      INSERT INTO users (id, username, password_hash) VALUES ('u1', 'test_user', 'hash');
      INSERT INTO spaces (id, user_id, name, folder) VALUES ('sp1', 'u1', 'Space 1', 'fld1');
      INSERT INTO session_routes (id, space_id, user_id, channel, peer_id, dsh_session_id)
      VALUES ('rt1', 'sp1', 'u1', 'web', 'ctx-123', 'dsh-sess-1');
    `);

    // Step 2: Apply v1 and v2
    const v2Applied = await runner.migrate([BUILTIN_MIGRATIONS[0], BUILTIN_MIGRATIONS[1]]);
    expect(v2Applied.length).toBe(1);
    expect(v2Applied[0].version).toBe(2);
    expect(await runner.getCurrentVersion()).toBe(2);

    // Verify upgraded session_routes has account_id and native_context_id populated from peer_id
    const routeRow = db.prepare('SELECT * FROM session_routes WHERE id = ?').get('rt1') as {
      id: string;
      account_id: string;
      native_context_id: string;
      peer_id: string;
      channel: string;
    };
    expect(routeRow).toBeDefined();
    expect(routeRow.account_id).toBe('default');
    expect(routeRow.native_context_id).toBe('ctx-123');

    // Step 3: Apply v3 (delivery_inbox)
    const v3Applied = await runner.migrate([BUILTIN_MIGRATIONS[0], BUILTIN_MIGRATIONS[1], BUILTIN_MIGRATIONS[2]]);
    expect(v3Applied.length).toBe(1);
    expect(v3Applied[0].version).toBe(3);
    expect(await runner.getCurrentVersion()).toBe(3);

    // Verify delivery_inbox table exists and is operational
    db.exec(`
      INSERT INTO delivery_inbox (id, user_id, route_id, message_id, delivery_id, status)
      VALUES ('inbox1', 'u1', 'rt1', 'msg1', 'del1', 'held');
    `);
    const inboxRow = db.prepare('SELECT * FROM delivery_inbox WHERE id = ?').get('inbox1') as {
      id: string;
      status: string;
    };
    expect(inboxRow.status).toBe('held');

    // Step 4: Apply v4 (platform_operations)
    const v4Applied = await runner.migrate(BUILTIN_MIGRATIONS);
    expect(v4Applied.length).toBe(1);
    expect(v4Applied[0].version).toBe(4);
    expect(await runner.getCurrentVersion()).toBe(4);

    // Verify platform_tasks table exists and is operational
    db.exec(`
      INSERT INTO platform_tasks (id, user_id, title, priority, status)
      VALUES ('task1', 'u1', 'Test Task', 'high', 'pending');
    `);
    const taskRow = db.prepare('SELECT * FROM platform_tasks WHERE id = ?').get('task1') as {
      id: string;
      title: string;
      priority: string;
    };
    expect(taskRow.title).toBe('Test Task');
    expect(taskRow.priority).toBe('high');

    db.close();
  });

  it('validates manifest for duplicate or non-sequential versions before BEGIN', async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new SqliteMigrationRunner(db);

    // Duplicate versions in manifest
    const duplicateManifest = [
      { version: 1, name: '001_v1', upSql: 'CREATE TABLE t1 (id TEXT);' },
      { version: 1, name: '001_v1_dupe', upSql: 'CREATE TABLE t2 (id TEXT);' },
    ];
    await expect(runner.migrate(duplicateManifest)).rejects.toThrow(MigrationError);

    // Non-sequential gap in manifest (1 then 3)
    const gapManifest = [
      { version: 1, name: '001_v1', upSql: 'CREATE TABLE t1 (id TEXT);' },
      { version: 3, name: '003_v3', upSql: 'CREATE TABLE t3 (id TEXT);' },
    ];
    await expect(runner.migrate(gapManifest)).rejects.toThrow(MigrationError);

    // Manifest not starting at version 1
    const invalidStartManifest = [
      { version: 2, name: '002_v2', upSql: 'CREATE TABLE t2 (id TEXT);' },
    ];
    await expect(runner.migrate(invalidStartManifest)).rejects.toThrow(MigrationError);

    db.close();
  });

  it('proves concurrent migrations across 2 independent DB connections execute idempotently', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'enkeep-migration-2conn-'));
    const dbPath = join(tempDir, 'migration_test.db');

    try {
      // Setup Connection 1 and Connection 2
      const db1 = new DatabaseSync(dbPath);
      db1.exec('PRAGMA foreign_keys = ON;');
      db1.exec('PRAGMA busy_timeout = 200;');
      db1.exec('PRAGMA journal_mode = WAL;');

      const db2 = new DatabaseSync(dbPath);
      db2.exec('PRAGMA foreign_keys = ON;');
      db2.exec('PRAGMA busy_timeout = 200;');
      db2.exec('PRAGMA journal_mode = WAL;');

      const runner1 = new SqliteMigrationRunner(db1);
      const runner2 = new SqliteMigrationRunner(db2);

      // Concurrently run migrate on both connections
      const [res1, res2] = await Promise.all([
        runner1.migrate(BUILTIN_MIGRATIONS),
        runner2.migrate(BUILTIN_MIGRATIONS),
      ]);

      // Exactly 4 migrations applied in total across the two runners
      const totalApplied = res1.length + res2.length;
      expect(totalApplied).toBe(4);

      // Both runners observe version 4
      expect(await runner1.getCurrentVersion()).toBe(4);
      expect(await runner2.getCurrentVersion()).toBe(4);

      const applied1 = await runner1.getAppliedMigrations();
      const applied2 = await runner2.getAppliedMigrations();
      expect(applied1.length).toBe(4);
      expect(applied2.length).toBe(4);
      expect(applied1.map((m) => m.version)).toEqual([1, 2, 3, 4]);

      db1.close();
      db2.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects downgrade when database schema is newer than code version', async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new SqliteMigrationRunner(db);

    await runner.migrate(BUILTIN_MIGRATIONS);

    // Manually insert a higher migration version into _schema_migrations
    db.prepare(`
      INSERT INTO _schema_migrations (version, name, checksum, applied_at)
      VALUES (999, '999_future_migration', 'future-checksum', CURRENT_TIMESTAMP)
    `).run();

    await expect(runner.migrate(BUILTIN_MIGRATIONS)).rejects.toThrow(MigrationDowngradeError);

    try {
      await runner.migrate(BUILTIN_MIGRATIONS);
    } catch (err) {
      expect(err).toBeInstanceOf(MigrationDowngradeError);
      const downgradeErr = err as MigrationDowngradeError;
      expect(downgradeErr.databaseVersion).toBe(999);
      expect(downgradeErr.targetVersion).toBe(4);
      expect(downgradeErr.code).toBe('MIGRATION_DOWNGRADE_REJECTED');
    }

    db.close();
  });

  it('rejects execution when applied migration checksum mismatches code migration', async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new SqliteMigrationRunner(db);

    await runner.migrate(BUILTIN_MIGRATIONS);

    // Tamper with the checksum of migration 1 in _schema_migrations
    db.prepare(`
      UPDATE _schema_migrations SET checksum = 'tampered-checksum' WHERE version = 1
    `).run();

    await expect(runner.migrate(BUILTIN_MIGRATIONS)).rejects.toThrow(MigrationChecksumMismatchError);

    try {
      await runner.verifyChecksums(BUILTIN_MIGRATIONS);
    } catch (err) {
      expect(err).toBeInstanceOf(MigrationChecksumMismatchError);
      const mismatchErr = err as MigrationChecksumMismatchError;
      expect(mismatchErr.version).toBe(1);
      expect(mismatchErr.expectedChecksum).toBe('tampered-checksum');
      expect(mismatchErr.actualChecksum).toBe(BUILTIN_MIGRATIONS[0].checksum);
    }

    db.close();
  });

  it('computes consistent deterministic sha256 checksums', () => {
    const sql = 'CREATE TABLE test (id TEXT);';
    const sum1 = computeChecksum(sql);
    const sum2 = computeChecksum(`  ${sql}  \n`);
    expect(sum1).toBe(sum2);
    expect(sum1.length).toBe(64);
  });

  it('guarantees immutable published checksums for BUILTIN_MIGRATIONS v1 to v4 including v1 dad9c52', () => {
    const expectedChecksums: Record<number, string> = {
      1: 'dad9c52bb64d8435f055bd7305c55689061ea2a0d564123c7d39d12f390804d2',
      2: 'f6ce27c7e6946fdc5a31001e994cbca80fd78fe8cdd297f601d52335e60aaac2',
      3: 'baf34039177bb204c7a07cebc1e649725edd02329e01887ec67d126ed46a9407',
      4: '4ee967c4fbdf3b2cb15378d32e2d0668b793fbf8b9882e723626329f63808e42',
    };

    expect(BUILTIN_MIGRATIONS.length).toBe(4);
    for (const m of BUILTIN_MIGRATIONS) {
      expect(expectedChecksums[m.version]).toBeDefined();
      expect(m.checksum).toBe(expectedChecksums[m.version]);
      expect(computeChecksum(m.upSql)).toBe(expectedChecksums[m.version]);
    }
  });

  it('guarantees immutable published checksums for all platform migrations v1 through v30 against authoritative manifest', () => {
    const EXPECTED_IMMUTABLE_CHECKSUMS: Record<number, { name: string; sql: string; checksum: string }> = {
      1: { name: '001_initial_happyclaw_subset', sql: MIGRATION_001_SQL, checksum: 'dad9c52bb64d8435f055bd7305c55689061ea2a0d564123c7d39d12f390804d2' },
      2: { name: '002_route_identity_and_scoped_cursors', sql: MIGRATION_002_SQL, checksum: 'f6ce27c7e6946fdc5a31001e994cbca80fd78fe8cdd297f601d52335e60aaac2' },
      3: { name: '003_delivery_inbox', sql: MIGRATION_003_SQL, checksum: 'baf34039177bb204c7a07cebc1e649725edd02329e01887ec67d126ed46a9407' },
      4: { name: '004_platform_operations', sql: MIGRATION_004_SQL, checksum: '4ee967c4fbdf3b2cb15378d32e2d0668b793fbf8b9882e723626329f63808e42' },
      5: { name: '005_web_messages_and_events', sql: MIGRATION_005_PLATFORM_SERVER_SQL, checksum: '8c4ace0600a82c88dd86991e87133751f26c080e06d27a3b70d9a2a7331577e4' },
      6: { name: '006_delivery_inbox_and_idempotency', sql: MIGRATION_006_DELIVERY_INBOX_AND_IDEMPOTENCY_SQL, checksum: '0ec50830b665ac996e02ac6fa6a56646275b308ca1de2bc6bc379f5e7829e6d9' },
      7: { name: '007_delivery_inbox_failed_status', sql: MIGRATION_007_DELIVERY_INBOX_FAILED_STATUS_SQL, checksum: '53fc0e118aaf108765d50ffa8f8907e08a971178c3c0c2d5653192f19021bf54' },
      8: { name: '008_fixed_import_receipts_and_provenance', sql: MIGRATION_008_FIXED_IMPORT_RECEIPTS_SQL, checksum: 'f888e8016b93f3360a28cb8f929576dbd84fc29c2af1948b62fdcf2e91033229' },
      9: { name: '009_agent_profiles_lifecycle_and_generations', sql: MIGRATION_009_AGENT_PROFILES_LIFECYCLE_AND_GENERATIONS_SQL, checksum: '4d749a483ad94df1818ed2fe094f48fe690d6fded34ffb574521d2405ef1c87a' },
      10: { name: '010_quota_bundles_lifecycle', sql: MIGRATION_010_QUOTA_BUNDLES_LIFECYCLE_SQL, checksum: 'b7250bf990119e44f8325bc790e0a410a353ff13bbaa408a1d86780e2046ee4d' },
      11: { name: '011_model_config_overrides', sql: MIGRATION_011_MODEL_CONFIG_OVERRIDES_SQL, checksum: 'c0318242a6acc2eb07c61cc6f9f135a7f5f22728326f2173b4813c1a0c569545' },
      12: { name: '012_storage_and_quota_reset_audit', sql: MIGRATION_012_STORAGE_AND_QUOTA_RESET_AUDIT_SQL, checksum: 'e1a662f85510acd4c12c29ee6a73f5eafebf319f8acad090d14b2f189314216c' },
      13: { name: '013_user_locale_preferences', sql: MIGRATION_013_USER_LOCALE_PREFERENCES_SQL, checksum: '36f643e788e15df5b3173f5eb74a603f5755c52207d98a001e3c2def589ef310' },
      14: { name: '014_file_transfer_journal', sql: MIGRATION_014_FILE_TRANSFER_JOURNAL_SQL, checksum: '78e2f7f58c097d0f6689fccdde0530b97152ab1e12b896313337c13eff0bb665' },
      15: { name: '015_message_attachments', sql: MIGRATION_015_MESSAGE_ATTACHMENTS_SQL, checksum: '3ec08a6a2088a949cea4f6993573df9326354f5ee6199fafb412d823bd7dd4c5' },
      16: { name: '016_attachment_snapshot_journal', sql: MIGRATION_016_ATTACHMENT_SNAPSHOT_JOURNAL_SQL, checksum: '98b94908296e5ca08ded09522a4ed611b6dc282a71ff5f1bc5a71a72d239bf44' },
      17: { name: '017_user_must_change_password', sql: MIGRATION_017_USER_MUST_CHANGE_PASSWORD_SQL, checksum: '1a9a9b213c3bcdb8cd4478b8ac1eaa593dad81deccf2fabc35c43e79ee7ccb64' },
      18: { name: '018_task_schedules_and_runs', sql: MIGRATION_018_TASK_SCHEDULES_AND_RUNS_SQL, checksum: '7342b6075775bf1e15cedd2c732934f8becf7607b9b15401069860beff313fb6' },
      19: { name: '019_fork_reserved', sql: MIGRATION_019_FORK_RESERVED_SQL, checksum: '00040d6170a26ab74e6a4746c179719913ff63af66950c1c50e2d17a06d19fc7' },
      20: { name: '020_import_jobs', sql: MIGRATION_020_IMPORT_JOBS_SQL, checksum: '896b1a1012980a549c29937124569db23ceb9bc086b96ad6e43b51569df85908' },
      21: { name: '021_skill_packages_and_bindings', sql: MIGRATION_021_SKILL_PACKAGES_AND_BINDINGS_SQL, checksum: '6d685cd06fa622b8e664ed7bc3ecf0b47169b51adca574dfbafe26755800822d' },
      22: { name: '022_permission_presets', sql: MIGRATION_022_PERMISSION_PRESETS_SQL, checksum: 'acff7f4dcb4f67b81e48d820a2ae2fdb0930d3d75afe8b475cdae4ecb957efd9' },
      23: { name: '023_model_selection_overrides_and_health', sql: MIGRATION_023_MODEL_SELECTION_OVERRIDES_AND_HEALTH_SQL, checksum: 'a4ec67ffce69a1878bac9ca4d11ef8277f91733870e40a9c41fe81bb6f67e45a' },
      24: { name: '024_message_references', sql: MIGRATION_024_MESSAGE_REFERENCES_SQL, checksum: 'ca680041da07cfb59eff0bf622e1438b72c7b08f61f3012554f0a540f76b1025' },
      25: { name: '025_runtime_diagnostics', sql: MIGRATION_025_RUNTIME_DIAGNOSTICS_SQL, checksum: 'f76f8a45115f2df869cf51a133477238dea756a5b2eecb6660392c5b995f59fd' },
      26: { name: '026_task_notifications', sql: MIGRATION_026_TASK_NOTIFICATIONS_SQL, checksum: '00ab3af267f440fd7dcfd14200e837b7f9a4b875033265070b004843a10b80c3' },
      27: { name: '027_session_execution_leases', sql: MIGRATION_027_SESSION_EXECUTION_LEASES_SQL, checksum: 'bcde3379ca17f54b1c505cc41f3c80c3502cc88988facd503fe5345778ff0e8c' },
      28: { name: '028_user_theme_preference', sql: MIGRATION_028_USER_THEME_PREFERENCE_SQL, checksum: 'a645934a3ff086fda7776da11020352b40659ee0d914b02f3cb764e0320deaf2' },
      29: { name: '029_space_mounts', sql: MIGRATION_029_SPACE_MOUNTS_SQL, checksum: '3a0cfbf18c617310ead07ee98ebb41d2aabbdeab5d0e210a43ec8afd85ca9ff8' },
      30: { name: '030_unified_extension_catalog', sql: MIGRATION_030_EXTENSIONS_CATALOG_AND_BINDINGS_SQL, checksum: '606421e52d37ec8f010a6b1e45ad2766a198ddb8295c51b2a0c1f11b422420e4' },
      31: { name: '031_generic_channel_tables', sql: MIGRATION_031_GENERIC_CHANNELS_SQL, checksum: '3ae9433678068bab97db4c7e6a5dd7a0e984fb5391b7ea06be97438fb91e09cf' },
    };

    expect(Object.keys(EXPECTED_IMMUTABLE_CHECKSUMS).length).toBe(31);
    for (let v = 1; v <= 31; v++) {
      const exp = EXPECTED_IMMUTABLE_CHECKSUMS[v];
      expect(exp).toBeDefined();
      expect(computeChecksum(exp.sql)).toBe(exp.checksum);
    }
  });
});
