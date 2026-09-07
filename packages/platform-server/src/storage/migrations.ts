import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MigrationDefinition, MigrationRecord, MigrationRunner } from '@enkeep/platform-core';
import { MigrationDowngradeError, MigrationChecksumMismatchError, MigrationError } from '@enkeep/platform-core';
import {
  BUILTIN_MIGRATIONS,
  SqliteMigrationRunner,
  computeChecksum,
  validateMigrationManifest,
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
  MIGRATION_018_SQL,
  MIGRATION_019_FORK_RESERVED_SQL,
  MIGRATION_020_IMPORT_JOBS_SQL,
  MIGRATION_021_SKILL_PACKAGES_AND_BINDINGS_SQL,
  MIGRATION_022_PERMISSION_PRESETS_SQL,
  MIGRATION_022_SQL,
  MIGRATION_022_PERMISSIONS_RESERVED_SQL,
  MIGRATION_023_MODEL_SELECTION_OVERRIDES_AND_HEALTH_SQL,
  MIGRATION_024_MESSAGE_REFERENCES_SQL,
  MIGRATION_024_RESERVED_SQL,
  MIGRATION_025_RUNTIME_DIAGNOSTICS_SQL,
  MIGRATION_026_TASK_NOTIFICATIONS_SQL,
  MIGRATION_027_SESSION_EXECUTION_LEASES_SQL,
  MIGRATION_027_SQL,
  MIGRATION_028_USER_THEME_PREFERENCE_SQL,
  MIGRATION_028_USER_THEME_PREFERENCES_SQL,
  MIGRATION_029_SPACE_MOUNTS_SQL,
  MIGRATION_030_EXTENSIONS_CATALOG_AND_BINDINGS_SQL,
  MIGRATION_031_GENERIC_CHANNELS_SQL,
  MIGRATION_032_CHANNEL_ENCRYPTED_CREDENTIALS_SQL,
  MIGRATION_033_CHANNEL_ACCOUNT_DEFAULT_SPACE_SQL,
  MIGRATION_034_CHANNEL_ACCOUNT_GROUP_ACTIVATION_MODE_SQL,
  MIGRATION_035_QUOTA_DEFAULT_UNLIMITED_SQL,
} from '@enkeep/platform-storage-sqlite';

export {
  computeChecksum,
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
  MIGRATION_018_SQL,
  MIGRATION_019_FORK_RESERVED_SQL,
  MIGRATION_020_IMPORT_JOBS_SQL,
  MIGRATION_021_SKILL_PACKAGES_AND_BINDINGS_SQL,
  MIGRATION_022_PERMISSION_PRESETS_SQL,
  MIGRATION_022_SQL,
  MIGRATION_022_PERMISSIONS_RESERVED_SQL,
  MIGRATION_023_MODEL_SELECTION_OVERRIDES_AND_HEALTH_SQL,
  MIGRATION_024_MESSAGE_REFERENCES_SQL,
  MIGRATION_024_RESERVED_SQL,
  MIGRATION_025_RUNTIME_DIAGNOSTICS_SQL,
  MIGRATION_026_TASK_NOTIFICATIONS_SQL,
  MIGRATION_027_SESSION_EXECUTION_LEASES_SQL,
  MIGRATION_027_SQL,
  MIGRATION_028_USER_THEME_PREFERENCE_SQL,
  MIGRATION_028_USER_THEME_PREFERENCES_SQL,
  MIGRATION_029_SPACE_MOUNTS_SQL,
  MIGRATION_030_EXTENSIONS_CATALOG_AND_BINDINGS_SQL,
  MIGRATION_031_GENERIC_CHANNELS_SQL,
  MIGRATION_032_CHANNEL_ENCRYPTED_CREDENTIALS_SQL,
  MIGRATION_033_CHANNEL_ACCOUNT_DEFAULT_SPACE_SQL,
  MIGRATION_034_CHANNEL_ACCOUNT_GROUP_ACTIVATION_MODE_SQL,
  MIGRATION_035_QUOTA_DEFAULT_UNLIMITED_SQL,
};

function isSqliteBusyOrLocked(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; errcode?: unknown };
  if (e.code === 'SQLITE_BUSY' || e.code === 'SQLITE_LOCKED') return true;
  if (e.errcode === 5 || e.errcode === 6) return true;
  if (e.code === 'ERR_SQLITE_ERROR' && (e.errcode === 5 || e.errcode === 6)) return true;
  return false;
}

/**
 * All platform migrations combining platform-storage-sqlite migrations + platform-server migrations (1 through 28).
 */
export const ALL_PLATFORM_MIGRATIONS: MigrationDefinition[] = [
  ...BUILTIN_MIGRATIONS,
  {
    version: 5,
    name: '005_web_messages_and_events',
    upSql: MIGRATION_005_PLATFORM_SERVER_SQL,
    checksum: computeChecksum(MIGRATION_005_PLATFORM_SERVER_SQL),
  },
  {
    version: 6,
    name: '006_delivery_inbox_and_idempotency',
    upSql: MIGRATION_006_DELIVERY_INBOX_AND_IDEMPOTENCY_SQL,
    checksum: computeChecksum(MIGRATION_006_DELIVERY_INBOX_AND_IDEMPOTENCY_SQL),
  },
  {
    version: 7,
    name: '007_delivery_inbox_failed_status',
    upSql: MIGRATION_007_DELIVERY_INBOX_FAILED_STATUS_SQL,
    checksum: computeChecksum(MIGRATION_007_DELIVERY_INBOX_FAILED_STATUS_SQL),
  },
  {
    version: 8,
    name: '008_fixed_import_receipts_and_provenance',
    upSql: MIGRATION_008_FIXED_IMPORT_RECEIPTS_SQL,
    checksum: computeChecksum(MIGRATION_008_FIXED_IMPORT_RECEIPTS_SQL),
  },
  {
    version: 9,
    name: '009_agent_profiles_lifecycle_and_generations',
    upSql: MIGRATION_009_AGENT_PROFILES_LIFECYCLE_AND_GENERATIONS_SQL,
    checksum: computeChecksum(MIGRATION_009_AGENT_PROFILES_LIFECYCLE_AND_GENERATIONS_SQL),
  },
  {
    version: 10,
    name: '010_quota_bundles_lifecycle',
    upSql: MIGRATION_010_QUOTA_BUNDLES_LIFECYCLE_SQL,
    checksum: computeChecksum(MIGRATION_010_QUOTA_BUNDLES_LIFECYCLE_SQL),
  },
  {
    version: 11,
    name: '011_model_config_overrides',
    upSql: MIGRATION_011_MODEL_CONFIG_OVERRIDES_SQL,
    checksum: computeChecksum(MIGRATION_011_MODEL_CONFIG_OVERRIDES_SQL),
  },
  {
    version: 12,
    name: '012_storage_and_quota_reset_audit',
    upSql: MIGRATION_012_STORAGE_AND_QUOTA_RESET_AUDIT_SQL,
    checksum: computeChecksum(MIGRATION_012_STORAGE_AND_QUOTA_RESET_AUDIT_SQL),
  },
  {
    version: 13,
    name: '013_user_locale_preferences',
    upSql: MIGRATION_013_USER_LOCALE_PREFERENCES_SQL,
    checksum: computeChecksum(MIGRATION_013_USER_LOCALE_PREFERENCES_SQL),
  },
  {
    version: 14,
    name: '014_file_transfer_journal',
    upSql: MIGRATION_014_FILE_TRANSFER_JOURNAL_SQL,
    checksum: computeChecksum(MIGRATION_014_FILE_TRANSFER_JOURNAL_SQL),
  },
  {
    version: 15,
    name: '015_message_attachments',
    upSql: MIGRATION_015_MESSAGE_ATTACHMENTS_SQL,
    checksum: computeChecksum(MIGRATION_015_MESSAGE_ATTACHMENTS_SQL),
  },
  {
    version: 16,
    name: '016_attachment_snapshot_journal',
    upSql: MIGRATION_016_ATTACHMENT_SNAPSHOT_JOURNAL_SQL,
    checksum: computeChecksum(MIGRATION_016_ATTACHMENT_SNAPSHOT_JOURNAL_SQL),
  },
  {
    version: 17,
    name: '017_user_must_change_password',
    upSql: MIGRATION_017_USER_MUST_CHANGE_PASSWORD_SQL,
    checksum: computeChecksum(MIGRATION_017_USER_MUST_CHANGE_PASSWORD_SQL),
  },
  {
    version: 18,
    name: '018_task_schedules_and_runs',
    upSql: MIGRATION_018_TASK_SCHEDULES_AND_RUNS_SQL,
    checksum: computeChecksum(MIGRATION_018_TASK_SCHEDULES_AND_RUNS_SQL),
  },
  {
    version: 19,
    name: '019_fork_reserved',
    upSql: MIGRATION_019_FORK_RESERVED_SQL,
    checksum: computeChecksum(MIGRATION_019_FORK_RESERVED_SQL),
  },
  {
    version: 20,
    name: '020_import_jobs',
    upSql: MIGRATION_020_IMPORT_JOBS_SQL,
    checksum: computeChecksum(MIGRATION_020_IMPORT_JOBS_SQL),
  },
  {
    version: 21,
    name: '021_skill_packages_and_bindings',
    upSql: MIGRATION_021_SKILL_PACKAGES_AND_BINDINGS_SQL,
    checksum: computeChecksum(MIGRATION_021_SKILL_PACKAGES_AND_BINDINGS_SQL),
  },
  {
    version: 22,
    name: '022_permission_presets',
    upSql: MIGRATION_022_PERMISSION_PRESETS_SQL,
    checksum: computeChecksum(MIGRATION_022_PERMISSION_PRESETS_SQL),
  },
  {
    version: 23,
    name: '023_model_selection_overrides_and_health',
    upSql: MIGRATION_023_MODEL_SELECTION_OVERRIDES_AND_HEALTH_SQL,
    checksum: computeChecksum(MIGRATION_023_MODEL_SELECTION_OVERRIDES_AND_HEALTH_SQL),
  },
  {
    version: 24,
    name: '024_message_references',
    upSql: MIGRATION_024_MESSAGE_REFERENCES_SQL,
    checksum: computeChecksum(MIGRATION_024_MESSAGE_REFERENCES_SQL),
  },
  {
    version: 25,
    name: '025_runtime_diagnostics',
    upSql: MIGRATION_025_RUNTIME_DIAGNOSTICS_SQL,
    checksum: computeChecksum(MIGRATION_025_RUNTIME_DIAGNOSTICS_SQL),
  },
  {
    version: 26,
    name: '026_task_notifications',
    upSql: MIGRATION_026_TASK_NOTIFICATIONS_SQL,
    checksum: computeChecksum(MIGRATION_026_TASK_NOTIFICATIONS_SQL),
  },
  {
    version: 27,
    name: '027_session_execution_leases',
    upSql: MIGRATION_027_SESSION_EXECUTION_LEASES_SQL,
    checksum: computeChecksum(MIGRATION_027_SESSION_EXECUTION_LEASES_SQL),
  },
  {
    version: 28,
    name: '028_user_theme_preference',
    upSql: MIGRATION_028_USER_THEME_PREFERENCE_SQL,
    checksum: computeChecksum(MIGRATION_028_USER_THEME_PREFERENCE_SQL),
  },
  {
    version: 29,
    name: '029_space_mounts',
    upSql: MIGRATION_029_SPACE_MOUNTS_SQL,
    checksum: computeChecksum(MIGRATION_029_SPACE_MOUNTS_SQL),
  },
  {
    version: 30,
    name: '030_unified_extension_catalog',
    upSql: MIGRATION_030_EXTENSIONS_CATALOG_AND_BINDINGS_SQL,
    checksum: computeChecksum(MIGRATION_030_EXTENSIONS_CATALOG_AND_BINDINGS_SQL),
  },
  {
    version: 31,
    name: '031_generic_channel_tables',
    upSql: MIGRATION_031_GENERIC_CHANNELS_SQL,
    checksum: computeChecksum(MIGRATION_031_GENERIC_CHANNELS_SQL),
  },
  {
    version: 32,
    name: '032_channel_encrypted_credentials',
    upSql: MIGRATION_032_CHANNEL_ENCRYPTED_CREDENTIALS_SQL,
    checksum: computeChecksum(MIGRATION_032_CHANNEL_ENCRYPTED_CREDENTIALS_SQL),
  },
  {
    version: 33,
    name: '033_channel_account_default_space',
    upSql: MIGRATION_033_CHANNEL_ACCOUNT_DEFAULT_SPACE_SQL,
    checksum: computeChecksum(MIGRATION_033_CHANNEL_ACCOUNT_DEFAULT_SPACE_SQL),
  },
  {
    version: 34,
    name: '034_channel_account_group_activation_mode',
    upSql: MIGRATION_034_CHANNEL_ACCOUNT_GROUP_ACTIVATION_MODE_SQL,
    checksum: computeChecksum(MIGRATION_034_CHANNEL_ACCOUNT_GROUP_ACTIVATION_MODE_SQL),
  },
  {
    version: 35,
    name: '035_quota_default_unlimited',
    upSql: MIGRATION_035_QUOTA_DEFAULT_UNLIMITED_SQL,
    checksum: computeChecksum(MIGRATION_035_QUOTA_DEFAULT_UNLIMITED_SQL),
  },
];

/**
 * Versioned SQLite migration runner for Platform Server.
 * Enforces transaction isolation, eliminates stale pending flaws by querying state strictly after acquiring write lock,
 * guarantees checksum integrity, sequential version tracking, and downgrade prevention.
 */
export class PlatformServerMigrationRunner implements MigrationRunner {
  private readonly runner: SqliteMigrationRunner;

  constructor(db: DatabaseSync) {
    this.runner = new SqliteMigrationRunner(db);
  }

  async getCurrentVersion(): Promise<number> {
    return this.runner.getCurrentVersion();
  }

  async getAppliedMigrations(): Promise<MigrationRecord[]> {
    return this.runner.getAppliedMigrations();
  }

  async verifyChecksums(manifest: MigrationDefinition[]): Promise<void> {
    return this.runner.verifyChecksums(manifest);
  }

  async validateAppliedMigrations(manifest: MigrationDefinition[]): Promise<void> {
    return this.runner.verifyChecksums(manifest);
  }

  async migrate(manifest: MigrationDefinition[] = ALL_PLATFORM_MIGRATIONS): Promise<MigrationRecord[]> {
    return this.runner.migrate(manifest);
  }
}
