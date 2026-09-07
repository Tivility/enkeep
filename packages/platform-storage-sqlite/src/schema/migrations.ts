/**
 * Migration Definitions and SQLite Migration Runner for Platform Storage.
 *
 * Implements versioned sequential migrations (001 through 004 built-in, up to 028 for platform),
 * transaction-locked execution, checksum verification, and tampering detection.
 *
 * @module @enkeep/platform-storage-sqlite/schema/migrations
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  MigrationError,
  MigrationChecksumMismatchError,
  MigrationDowngradeError,
  type MigrationDefinition,
  type MigrationRecord,
  type MigrationRunner,
} from '@enkeep/platform-core';
import { parseMigrationRecordRow, queryAll } from '../utils/db.js';

export function computeChecksum(sql: string): string {
  return createHash('sha256').update(sql.trim(), 'utf8').digest('hex');
}

export const MIGRATION_001_SQL = `
CREATE TABLE IF NOT EXISTS _schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  last_seen_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  revoked_at TEXT,
  user_agent TEXT,
  ip_address TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token_hash ON user_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);

CREATE TABLE IF NOT EXISTS auth_audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  username TEXT,
  action TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_auth_audit_log_user_id ON auth_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_audit_log_action ON auth_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_auth_audit_log_created_at ON auth_audit_log(created_at);

CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  folder TEXT NOT NULL,
  execution_mode TEXT NOT NULL DEFAULT 'container',
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(user_id, folder)
);

CREATE INDEX IF NOT EXISTS idx_spaces_user_id ON spaces(user_id);

CREATE TABLE IF NOT EXISTS session_routes (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  dsh_session_id TEXT NOT NULL,
  execution_mode TEXT NOT NULL DEFAULT 'container',
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(user_id, channel, peer_id)
);

CREATE INDEX IF NOT EXISTS idx_session_routes_user_id ON session_routes(user_id);
CREATE INDEX IF NOT EXISTS idx_session_routes_space_id ON session_routes(space_id);
CREATE INDEX IF NOT EXISTS idx_session_routes_dsh_session_id ON session_routes(dsh_session_id);

CREATE TABLE IF NOT EXISTS session_sources (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(user_id, source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_session_sources_route_id ON session_sources(route_id);
CREATE INDEX IF NOT EXISTS idx_session_sources_user_id ON session_sources(user_id);

CREATE TABLE IF NOT EXISTS delivery_receipts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(user_id, delivery_id)
);

CREATE INDEX IF NOT EXISTS idx_delivery_receipts_user_id ON delivery_receipts(user_id);
CREATE INDEX IF NOT EXISTS idx_delivery_receipts_status ON delivery_receipts(status);
CREATE INDEX IF NOT EXISTS idx_delivery_receipts_route_id ON delivery_receipts(route_id);

CREATE TABLE IF NOT EXISTS event_cursors (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  cursor_value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(user_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_event_cursors_user_id ON event_cursors(user_id);

CREATE TABLE IF NOT EXISTS turn_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  route_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  execution_mode TEXT NOT NULL DEFAULT 'container',
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(user_id, route_id, turn_id)
);

CREATE INDEX IF NOT EXISTS idx_turn_runs_user_id ON turn_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_turn_runs_status ON turn_runs(status);
CREATE INDEX IF NOT EXISTS idx_turn_runs_route_id ON turn_runs(route_id);
`;

export const MIGRATION_002_SQL = `
-- Upgrade session_routes to include account_id and native_context_id with UNIQUE(user_id, channel, account_id, native_context_id)
CREATE TABLE IF NOT EXISTS session_routes_v2 (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT 'default',
  native_context_id TEXT NOT NULL DEFAULT '',
  peer_id TEXT NOT NULL DEFAULT '',
  dsh_session_id TEXT NOT NULL,
  execution_mode TEXT NOT NULL DEFAULT 'container',
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(user_id, channel, account_id, native_context_id)
);

INSERT INTO session_routes_v2 (id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, created_at, updated_at)
SELECT id, space_id, user_id, channel, 'default', peer_id, peer_id, dsh_session_id, execution_mode, created_at, updated_at
FROM session_routes;

DROP TABLE session_routes;
ALTER TABLE session_routes_v2 RENAME TO session_routes;

CREATE INDEX IF NOT EXISTS idx_session_routes_user_id ON session_routes(user_id);
CREATE INDEX IF NOT EXISTS idx_session_routes_space_id ON session_routes(space_id);
CREATE INDEX IF NOT EXISTS idx_session_routes_dsh_session_id ON session_routes(dsh_session_id);
CREATE INDEX IF NOT EXISTS idx_session_routes_identity ON session_routes(user_id, channel, account_id, native_context_id);

-- Upgrade event_cursors to route-scoped cursors with UNIQUE(user_id, route_id, consumer)
CREATE TABLE IF NOT EXISTS event_cursors_v2 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
  consumer TEXT NOT NULL DEFAULT 'default',
  cursor_value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(user_id, route_id, consumer)
);

DROP TABLE event_cursors;
ALTER TABLE event_cursors_v2 RENAME TO event_cursors;

CREATE INDEX IF NOT EXISTS idx_event_cursors_user_route ON event_cursors(user_id, route_id);
`;

export const MIGRATION_003_SQL = `
-- Create delivery_inbox with status in ('held', 'processing', 'delivered', 'duplicate', 'cancelled')
CREATE TABLE IF NOT EXISTS delivery_inbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'held' CHECK(status IN ('held', 'processing', 'delivered', 'duplicate', 'cancelled')),
  payload TEXT,
  error TEXT,
  received_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(user_id, delivery_id)
);

CREATE INDEX IF NOT EXISTS idx_delivery_inbox_user_id ON delivery_inbox(user_id);
CREATE INDEX IF NOT EXISTS idx_delivery_inbox_route_id ON delivery_inbox(route_id);
CREATE INDEX IF NOT EXISTS idx_delivery_inbox_status ON delivery_inbox(status);
`;

export const MIGRATION_004_SQL = `
-- Platform Operations: quota_limits, quota_usage, quota_reservations, platform_tasks, file_metadata
CREATE TABLE IF NOT EXISTS quota_limits (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource TEXT NOT NULL,
  limit_amount INTEGER NOT NULL,
  window_seconds INTEGER,
  reset_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  PRIMARY KEY (user_id, resource)
);

CREATE INDEX IF NOT EXISTS idx_quota_limits_user_id ON quota_limits(user_id);

CREATE TABLE IF NOT EXISTS quota_usage (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource TEXT NOT NULL,
  used_amount INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  PRIMARY KEY (user_id, resource)
);

CREATE INDEX IF NOT EXISTS idx_quota_usage_user_id ON quota_usage(user_id);

CREATE TABLE IF NOT EXISTS quota_reservations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved', 'committed', 'released', 'expired')),
  committed_amount INTEGER,
  expires_at TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  settled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_quota_reservations_user_resource_status ON quota_reservations(user_id, resource, status);
CREATE INDEX IF NOT EXISTS idx_quota_reservations_expires_at ON quota_reservations(expires_at);

CREATE TABLE IF NOT EXISTS platform_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT,
  title TEXT NOT NULL,
  description TEXT,
  assignee TEXT,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('urgent', 'high', 'medium', 'low')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'claimed', 'running', 'completed', 'failed', 'cancelled')),
  payload TEXT,
  result TEXT,
  error TEXT,
  claimant_id TEXT,
  lease_expires_at TEXT,
  lease_duration_ms INTEGER NOT NULL DEFAULT 60000,
  claim_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  due_date TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  completed_at TEXT,
  UNIQUE(user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_platform_tasks_user_status ON platform_tasks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_platform_tasks_claimant ON platform_tasks(user_id, claimant_id);
CREATE INDEX IF NOT EXISTS idx_platform_tasks_priority ON platform_tasks(user_id, priority, created_at);

CREATE TABLE IF NOT EXISTS file_metadata (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime_type TEXT,
  extension TEXT NOT NULL,
  checksum TEXT,
  recipient TEXT NOT NULL,
  description TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_file_metadata_user_filename ON file_metadata(user_id, filename);
CREATE INDEX IF NOT EXISTS idx_file_metadata_user_recipient ON file_metadata(user_id, recipient);
`;

export const MIGRATION_005_PLATFORM_SERVER_SQL = `
CREATE TABLE IF NOT EXISTS web_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'delivered',
  route_key TEXT NOT NULL,
  turn_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_web_messages_session_id ON web_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_web_messages_user_id ON web_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_web_messages_created_at ON web_messages(created_at);

CREATE TABLE IF NOT EXISTS web_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_web_events_session_id ON web_events(session_id);
CREATE INDEX IF NOT EXISTS idx_web_events_user_id ON web_events(user_id);
CREATE INDEX IF NOT EXISTS idx_web_events_created_at ON web_events(created_at);
`;

export const MIGRATION_006_DELIVERY_INBOX_AND_IDEMPOTENCY_SQL = `
ALTER TABLE delivery_inbox ADD COLUMN turn_id TEXT;
CREATE INDEX IF NOT EXISTS idx_delivery_inbox_turn_id ON delivery_inbox(user_id, turn_id);

CREATE TABLE IF NOT EXISTS idempotency_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'held' CHECK(state IN ('held', 'processing', 'completed', 'failed')),
  response_payload TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_user_key ON idempotency_records(user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_idempotency_turn_id ON idempotency_records(turn_id);
`;

export const MIGRATION_007_DELIVERY_INBOX_FAILED_STATUS_SQL = `
CREATE TABLE delivery_inbox_v7 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'held' CHECK(status IN ('held', 'processing', 'delivered', 'duplicate', 'cancelled', 'failed')),
  payload TEXT,
  error TEXT,
  received_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  turn_id TEXT,
  UNIQUE(user_id, delivery_id)
);

INSERT INTO delivery_inbox_v7 (
  id, user_id, route_id, message_id, delivery_id, status, payload, error, received_at, processed_at, created_at, updated_at, turn_id
)
SELECT id, user_id, route_id, message_id, delivery_id, status, payload, error, received_at, processed_at, created_at, updated_at, turn_id
FROM delivery_inbox;

DROP TABLE delivery_inbox;

ALTER TABLE delivery_inbox_v7 RENAME TO delivery_inbox;

CREATE INDEX IF NOT EXISTS idx_delivery_inbox_user_id ON delivery_inbox(user_id);
CREATE INDEX IF NOT EXISTS idx_delivery_inbox_route_id ON delivery_inbox(route_id);
CREATE INDEX IF NOT EXISTS idx_delivery_inbox_status ON delivery_inbox(status);
CREATE INDEX IF NOT EXISTS idx_delivery_inbox_turn_id ON delivery_inbox(user_id, turn_id);
`;

export const MIGRATION_008_FIXED_IMPORT_RECEIPTS_SQL = `
CREATE TABLE fixed_import_receipts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_fingerprint TEXT NOT NULL,
  importer_version TEXT NOT NULL,
  id_algorithm TEXT NOT NULL,
  target_dsh TEXT NOT NULL,
  session_format INTEGER NOT NULL,
  source_chats_count INTEGER NOT NULL,
  source_messages_count INTEGER NOT NULL,
  imported_messages_count INTEGER NOT NULL,
  dropped_messages_count INTEGER NOT NULL,
  attachments_count INTEGER NOT NULL,
  canonical_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  PRIMARY KEY (user_id, source_fingerprint)
);

CREATE INDEX idx_fixed_import_receipts_user ON fixed_import_receipts(user_id);

CREATE TABLE fixed_import_provenance (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_fingerprint TEXT NOT NULL,
  source_chat_jid TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  target_space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  target_route_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
  target_dsh_session_id TEXT NOT NULL,
  target_message_id TEXT NOT NULL REFERENCES web_messages(id) ON DELETE CASCADE,
  target_event_id TEXT NOT NULL REFERENCES web_events(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY (user_id, source_fingerprint) REFERENCES fixed_import_receipts(user_id, source_fingerprint) ON DELETE CASCADE
);

CREATE INDEX idx_fixed_import_prov_user_fp ON fixed_import_provenance(user_id, source_fingerprint);
CREATE INDEX idx_fixed_import_prov_route ON fixed_import_provenance(target_route_id);
CREATE INDEX idx_fixed_import_prov_src ON fixed_import_provenance(user_id, source_chat_jid, source_message_id);

PRAGMA foreign_key_check;
`;

export const MIGRATION_009_AGENT_PROFILES_LIFECYCLE_AND_GENERATIONS_SQL = `
-- 1. Create agent_profiles table
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

CREATE INDEX IF NOT EXISTS idx_agent_profiles_user_id ON agent_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_profiles_user_status ON agent_profiles(user_id, status);

-- 2. Create agent_profile_snapshots table (immutable versions, 4-section prompt, append-only mode)
CREATE TABLE IF NOT EXISTS agent_profile_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  prompt_mode TEXT NOT NULL DEFAULT 'append' CHECK(prompt_mode = 'append'),
  prompt_hash TEXT NOT NULL CHECK(length(prompt_hash) = 64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'),
  identity TEXT NOT NULL DEFAULT '',
  soul TEXT NOT NULL DEFAULT '',
  agents TEXT NOT NULL DEFAULT '',
  tools TEXT NOT NULL DEFAULT '',
  change_summary TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(profile_id, version)
);

CREATE INDEX IF NOT EXISTS idx_agent_profile_snapshots_profile_version ON agent_profile_snapshots(profile_id, version);
CREATE INDEX IF NOT EXISTS idx_agent_profile_snapshots_user ON agent_profile_snapshots(user_id);

-- 3. Create session_generations table for generative reset without JSONL truncation
CREATE TABLE IF NOT EXISTS session_generations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
  generation_number INTEGER NOT NULL DEFAULT 1,
  dsh_session_id TEXT NOT NULL,
  agent_profile_snapshot_id TEXT REFERENCES agent_profile_snapshots(id) ON DELETE RESTRICT,
  reset_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(route_id, generation_number)
);

CREATE INDEX IF NOT EXISTS idx_session_generations_user_route ON session_generations(user_id, route_id);
CREATE INDEX IF NOT EXISTS idx_session_generations_route_gen ON session_generations(route_id, generation_number);

-- 4. Extend spaces with lifecycle fields and default agent profile binding (soft deletion only)
ALTER TABLE spaces ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived', 'deleted'));
ALTER TABLE spaces ADD COLUMN agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT;
ALTER TABLE spaces ADD COLUMN agent_profile_snapshot_id TEXT REFERENCES agent_profile_snapshots(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_spaces_status ON spaces(status);
CREATE INDEX IF NOT EXISTS idx_spaces_user_status ON spaces(user_id, status);
CREATE INDEX IF NOT EXISTS idx_spaces_profile ON spaces(agent_profile_id);

-- 5. Extend session_routes with lifecycle fields, reset tracking, generation, and agent profile override
ALTER TABLE session_routes ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived', 'deleted'));
ALTER TABLE session_routes ADD COLUMN title TEXT;
ALTER TABLE session_routes ADD COLUMN last_reset_at TEXT;
ALTER TABLE session_routes ADD COLUMN reset_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_routes ADD COLUMN current_generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE session_routes ADD COLUMN agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT;
ALTER TABLE session_routes ADD COLUMN agent_profile_snapshot_id TEXT REFERENCES agent_profile_snapshots(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_session_routes_status ON session_routes(status);
CREATE INDEX IF NOT EXISTS idx_session_routes_user_status ON session_routes(user_id, status);
CREATE INDEX IF NOT EXISTS idx_session_routes_profile ON session_routes(agent_profile_id);

-- 6. Insert generation 1 row for EVERY existing session route
INSERT INTO session_generations (
  id,
  user_id,
  route_id,
  generation_number,
  dsh_session_id,
  agent_profile_snapshot_id,
  reset_reason,
  created_at
)
SELECT
  'gen_' || lower(hex(randomblob(16))),
  user_id,
  id,
  1,
  dsh_session_id,
  agent_profile_snapshot_id,
  'initial',
  created_at
FROM session_routes;

-- 7. Create operation_idempotency table for generic platform operation idempotency (e.g. resetSession)
CREATE TABLE IF NOT EXISTS operation_idempotency (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  target_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(user_id, scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_operation_idemp_user_scope_key ON operation_idempotency(user_id, scope, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_operation_idemp_target ON operation_idempotency(target_id);

PRAGMA foreign_key_check;
`;

export const MIGRATION_010_QUOTA_BUNDLES_LIFECYCLE_SQL = `
-- 1. Create quota_bundles table
CREATE TABLE IF NOT EXISTS quota_bundles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved', 'committed', 'released', 'expired')),
  turns_amount INTEGER NOT NULL DEFAULT 1,
  messages_amount INTEGER NOT NULL DEFAULT 1,
  tokens_amount INTEGER NOT NULL DEFAULT 0,
  is_estimate_tokens INTEGER NOT NULL DEFAULT 1,
  turns_committed INTEGER,
  messages_committed INTEGER,
  tokens_committed INTEGER,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  settled_at TEXT,
  metadata TEXT,
  UNIQUE(user_id, delivery_id)
);

CREATE INDEX IF NOT EXISTS idx_quota_bundles_user_status ON quota_bundles(user_id, status);
CREATE INDEX IF NOT EXISTS idx_quota_bundles_delivery ON quota_bundles(user_id, delivery_id);
CREATE INDEX IF NOT EXISTS idx_quota_bundles_expires_at ON quota_bundles(expires_at);

-- 2. Alter quota_reservations to add bundle_id and delivery_id columns + indexes
ALTER TABLE quota_reservations ADD COLUMN bundle_id TEXT REFERENCES quota_bundles(id) ON DELETE SET NULL;
ALTER TABLE quota_reservations ADD COLUMN delivery_id TEXT;

CREATE INDEX IF NOT EXISTS idx_quota_reservations_bundle_id ON quota_reservations(user_id, bundle_id);
CREATE INDEX IF NOT EXISTS idx_quota_reservations_delivery_id ON quota_reservations(user_id, delivery_id);

PRAGMA foreign_key_check;
`;

export const MIGRATION_011_MODEL_CONFIG_OVERRIDES_SQL = `
-- 1. Create model_config_overrides table for Enkeep platform-level model override
CREATE TABLE IF NOT EXISTS model_config_overrides (
  id TEXT PRIMARY KEY DEFAULT 'default',
  provider TEXT,
  model TEXT,
  reasoning_effort TEXT,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_model_config_overrides_updated_by ON model_config_overrides(updated_by);

PRAGMA foreign_key_check;
`;

export const MIGRATION_012_STORAGE_AND_QUOTA_RESET_AUDIT_SQL = `
-- 1. Extend quota_limits with reset_interval column ('none', 'daily', 'monthly')
ALTER TABLE quota_limits ADD COLUMN reset_interval TEXT DEFAULT 'none' CHECK(reset_interval IN ('none', 'daily', 'monthly') OR reset_interval IS NULL);

PRAGMA foreign_key_check;
`;

export const MIGRATION_013_USER_LOCALE_PREFERENCES_SQL = `
-- 1. Extend users table with locale column ('en', 'zh-CN')
ALTER TABLE users ADD COLUMN locale TEXT NOT NULL DEFAULT 'en' CHECK(locale IN ('en', 'zh-CN'));

PRAGMA foreign_key_check;
`;

export const MIGRATION_014_FILE_TRANSFER_JOURNAL_SQL = `
-- 1. Create file_transfer_journal table for durable crash recovery & ACID staging transitions
CREATE TABLE IF NOT EXISTS file_transfer_journal (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  stage_token TEXT,
  rollback_token TEXT,
  overwrite INTEGER NOT NULL DEFAULT 0,
  expected_etag TEXT,
  content_sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('staged', 'committed', 'finalized', 'cleanup_pending', 'aborted', 'rolled_back')),
  response_payload TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_file_journal_user_key ON file_transfer_journal(user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_file_journal_status ON file_transfer_journal(status);
CREATE INDEX IF NOT EXISTS idx_file_journal_space_path ON file_transfer_journal(space_id, relative_path);

PRAGMA foreign_key_check;
`;

export const MIGRATION_015_MESSAGE_ATTACHMENTS_SQL = `
-- 1. Create message_attachments table for durable, relational attachment tracking
CREATE TABLE IF NOT EXISTS message_attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES web_messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  snapshot_path TEXT NOT NULL,
  etag TEXT NOT NULL,
  size INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id ON message_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_message_attachments_user_id ON message_attachments(user_id);
CREATE INDEX IF NOT EXISTS idx_message_attachments_space_id ON message_attachments(space_id);
CREATE INDEX IF NOT EXISTS idx_message_attachments_snapshot_path ON message_attachments(space_id, snapshot_path);

PRAGMA foreign_key_check;
`;

export const MIGRATION_016_ATTACHMENT_SNAPSHOT_JOURNAL_SQL = `
-- 1. Create attachment_snapshot_journal table for crash recovery, two-phase staging and GC
CREATE TABLE IF NOT EXISTS attachment_snapshot_journal (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  source_path TEXT NOT NULL,
  snapshot_path TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('staging', 'copied', 'linked', 'cleanup_pending', 'cleaned', 'aborted')),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_att_journal_delivery ON attachment_snapshot_journal(delivery_id);
CREATE INDEX IF NOT EXISTS idx_att_journal_status ON attachment_snapshot_journal(status);
CREATE INDEX IF NOT EXISTS idx_att_journal_space_snapshot ON attachment_snapshot_journal(space_id, snapshot_path);

PRAGMA foreign_key_check;
`;

export const MIGRATION_017_USER_MUST_CHANGE_PASSWORD_SQL = `
-- 1. Extend users table with must_change_password column (0 or 1, default 0)
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0, 1));

PRAGMA foreign_key_check;
`;

export const MIGRATION_018_TASK_SCHEDULES_AND_RUNS_SQL = `
-- 1. Extend platform_tasks with schedule columns
ALTER TABLE platform_tasks ADD COLUMN schedule_type TEXT NOT NULL DEFAULT 'once' CHECK(schedule_type IN ('once', 'cron', 'interval'));
ALTER TABLE platform_tasks ADD COLUMN cron_expression TEXT;
ALTER TABLE platform_tasks ADD COLUMN interval_seconds INTEGER;
ALTER TABLE platform_tasks ADD COLUMN next_run_at TEXT;
ALTER TABLE platform_tasks ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';

-- 2. Create task_schedules table (1:1 with platform_tasks)
CREATE TABLE IF NOT EXISTS task_schedules (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES platform_tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  schedule_type TEXT NOT NULL DEFAULT 'once' CHECK(schedule_type IN ('once', 'cron', 'interval')),
  cron_expression TEXT,
  interval_seconds INTEGER,
  next_run_at TEXT,
  last_run_at TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  paused_at TEXT,
  misfire_policy TEXT NOT NULL DEFAULT 'coalesce' CHECK(misfire_policy IN ('coalesce', 'skip')),
  overlap_policy TEXT NOT NULL DEFAULT 'skip' CHECK(overlap_policy IN ('skip')),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_task_schedules_user_enabled ON task_schedules(user_id, enabled);
CREATE INDEX IF NOT EXISTS idx_task_schedules_next_run ON task_schedules(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_task_schedules_task_id ON task_schedules(task_id);

-- 3. Create task_runs table for execution history
CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES platform_tasks(id) ON DELETE CASCADE,
  schedule_id TEXT REFERENCES task_schedules(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'claimed', 'running', 'completed', 'failed', 'cancelled', 'timeout', 'aborted', 'lease_lost')),
  claimant_id TEXT,
  lease_expires_at TEXT,
  scheduled_for TEXT,
  started_at TEXT,
  completed_at TEXT,
  delivery_id TEXT,
  turn_id TEXT,
  session_id TEXT,
  error_code TEXT,
  error TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_task_runs_user_task ON task_runs(user_id, task_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_user_status ON task_runs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_task_runs_task_created ON task_runs(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_runs_turn_id ON task_runs(turn_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_delivery_id ON task_runs(delivery_id);

-- 4. Backfill task_schedules for all existing platform_tasks
INSERT INTO task_schedules (
  id, task_id, user_id, schedule_type, next_run_at, enabled, created_at, updated_at
)
SELECT
  'sched_' || lower(hex(randomblob(16))),
  id,
  user_id,
  'once',
  due_date,
  CASE WHEN status IN ('completed', 'failed', 'cancelled') THEN 0 ELSE 1 END,
  created_at,
  updated_at
FROM platform_tasks
WHERE id NOT IN (SELECT task_id FROM task_schedules);

-- 5. Backfill platform_tasks next_run_at from due_date
UPDATE platform_tasks
SET next_run_at = due_date
WHERE next_run_at IS NULL AND due_date IS NOT NULL;

PRAGMA foreign_key_check;
`;

export const MIGRATION_018_SQL = MIGRATION_018_TASK_SCHEDULES_AND_RUNS_SQL;

export const MIGRATION_019_FORK_RESERVED_SQL = `
-- 1. Create fork_operations table for durable crash recovery & dual-store fork sagas
CREATE TABLE IF NOT EXISTS fork_operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_session_id TEXT NOT NULL,
  target_space_id TEXT NOT NULL,
  forked_route_id TEXT NOT NULL,
  forked_dsh_session_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  idempotency_key TEXT,
  status TEXT NOT NULL CHECK(status IN ('prepared', 'seeded', 'attachments_copied', 'finalized', 'failed')),
  fork_plan_json TEXT NOT NULL,
  receipt_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_fork_ops_user_idemp ON fork_operations(user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_fork_ops_status ON fork_operations(status);
CREATE INDEX IF NOT EXISTS idx_fork_ops_source ON fork_operations(source_session_id);

PRAGMA foreign_key_check;
`;

export const MIGRATION_020_IMPORT_JOBS_SQL = `
-- 1. Create import_jobs table for durable background import tracking
CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  staged_id TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  idempotency_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancel_requested', 'cancelled', 'interrupted')),
  dry_run INTEGER NOT NULL DEFAULT 0,
  total_conversations INTEGER NOT NULL DEFAULT 0,
  completed_conversations INTEGER NOT NULL DEFAULT 0,
  progress_json TEXT,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_import_jobs_actor_created ON import_jobs(actor_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_import_jobs_target_status ON import_jobs(target_user_id, status);
CREATE INDEX IF NOT EXISTS idx_import_jobs_status_lease ON import_jobs(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_import_jobs_staged_id ON import_jobs(staged_id);
CREATE INDEX IF NOT EXISTS idx_import_jobs_idempotency ON import_jobs(actor_user_id, idempotency_key);

-- 2. Create import_job_conversations child table for granular tracking
CREATE TABLE IF NOT EXISTS import_job_conversations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'skipped')),
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_import_job_convs_job ON import_job_conversations(job_id, status);
CREATE INDEX IF NOT EXISTS idx_import_job_convs_source ON import_job_conversations(source_key);

PRAGMA foreign_key_check;
`;

export const MIGRATION_021_SKILL_PACKAGES_AND_BINDINGS_SQL = `
-- 1. Create skill_packages table
CREATE TABLE IF NOT EXISTS skill_packages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('space', 'global')),
  space_id TEXT REFERENCES spaces(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  source_type TEXT NOT NULL CHECK(source_type IN ('git', 'upload', 'bundled')),
  source_url TEXT,
  source_ref TEXT,
  commit_sha TEXT,
  subdirectory TEXT,
  content_hash TEXT NOT NULL,
  manifest_json TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'quarantined', 'archived', 'deleted')),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_skill_packages_user_scope ON skill_packages(user_id, scope);
CREATE INDEX IF NOT EXISTS idx_skill_packages_space_id ON skill_packages(space_id);
CREATE INDEX IF NOT EXISTS idx_skill_packages_user_name ON skill_packages(user_id, name);

-- 2. Create skill_package_versions table
CREATE TABLE IF NOT EXISTS skill_package_versions (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES skill_packages(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  commit_sha TEXT,
  content_hash TEXT NOT NULL,
  manifest_json TEXT,
  change_summary TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(package_id, version)
);

CREATE INDEX IF NOT EXISTS idx_skill_pkg_versions_pkg ON skill_package_versions(package_id);

-- 3. Create skill_bindings table
CREATE TABLE IF NOT EXISTS skill_bindings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  package_id TEXT REFERENCES skill_packages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(user_id, space_id, skill_name)
);

CREATE INDEX IF NOT EXISTS idx_skill_bindings_user_space ON skill_bindings(user_id, space_id);
CREATE INDEX IF NOT EXISTS idx_skill_bindings_space_skill ON skill_bindings(space_id, skill_name);

-- 4. Create skill_operations table
CREATE TABLE IF NOT EXISTS skill_operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_type TEXT NOT NULL CHECK(operation_type IN ('install', 'update', 'rollback', 'uninstall', 'enable', 'disable')),
  skill_name TEXT NOT NULL,
  target_scope TEXT NOT NULL CHECK(target_scope IN ('space', 'global')),
  target_space_id TEXT REFERENCES spaces(id) ON DELETE CASCADE,
  idempotency_key TEXT,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')),
  details_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_skill_ops_user_idemp ON skill_operations(user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_skill_ops_user_skill ON skill_operations(user_id, skill_name);
CREATE INDEX IF NOT EXISTS idx_skill_ops_status ON skill_operations(status);

PRAGMA foreign_key_check;
`;

export const MIGRATION_022_PERMISSION_PRESETS_SQL = `
-- Migration 22: Permission Presets per user/space/profile with optimistic revision
CREATE TABLE IF NOT EXISTS permission_presets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id TEXT REFERENCES spaces(id) ON DELETE CASCADE,
  profile_id TEXT REFERENCES agent_profiles(id) ON DELETE CASCADE,
  preset TEXT NOT NULL DEFAULT 'workspace-write' CHECK(preset IN ('read-only', 'workspace-write', 'danger-full-access', 'custom')),
  sandbox_mode TEXT NOT NULL DEFAULT 'workspace-write' CHECK(sandbox_mode IN ('read-only', 'workspace-write', 'danger-full-access')),
  approval_policy TEXT NOT NULL DEFAULT 'ask' CHECK(approval_policy IN ('ask', 'never')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_perm_presets_user ON permission_presets(user_id) WHERE space_id IS NULL AND profile_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_perm_presets_space ON permission_presets(user_id, space_id) WHERE space_id IS NOT NULL AND profile_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_perm_presets_profile ON permission_presets(user_id, profile_id) WHERE profile_id IS NOT NULL AND space_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_perm_presets_space_profile ON permission_presets(user_id, space_id, profile_id) WHERE space_id IS NOT NULL AND profile_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_perm_presets_user_id ON permission_presets(user_id);
CREATE INDEX IF NOT EXISTS idx_perm_presets_space_id ON permission_presets(space_id);
CREATE INDEX IF NOT EXISTS idx_perm_presets_profile_id ON permission_presets(profile_id);

PRAGMA foreign_key_check;
`;

export const MIGRATION_022_SQL = MIGRATION_022_PERMISSION_PRESETS_SQL;
export const MIGRATION_022_PERMISSIONS_RESERVED_SQL = MIGRATION_022_PERMISSION_PRESETS_SQL;

export const MIGRATION_023_MODEL_SELECTION_OVERRIDES_AND_HEALTH_SQL = `
-- 1. Create model_selection_overrides table supporting hierarchical overrides (session > space > user > platform)
CREATE TABLE IF NOT EXISTS model_selection_overrides (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  owner_type TEXT NOT NULL CHECK(owner_type IN ('session', 'space', 'user', 'platform')),
  owner_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning_effort TEXT,
  fallback_chain TEXT,
  revision TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(owner_type, owner_id)
);

CREATE INDEX IF NOT EXISTS idx_model_selection_overrides_owner ON model_selection_overrides(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_model_selection_overrides_user ON model_selection_overrides(user_id);
CREATE INDEX IF NOT EXISTS idx_model_selection_overrides_updated_by ON model_selection_overrides(updated_by);

-- 2. Create model_health table for rolling telemetry (latencies, error rates, circuit breaker states, api calls, tokens; no prompt content)
CREATE TABLE IF NOT EXISTS model_health (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  status_code INTEGER NOT NULL DEFAULT 200,
  success INTEGER NOT NULL DEFAULT 1 CHECK(success IN (0, 1)),
  error_type TEXT,
  circuit_state TEXT NOT NULL DEFAULT 'closed' CHECK(circuit_state IN ('closed', 'open', 'half-open')),
  api_calls INTEGER NOT NULL DEFAULT 1,
  tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_model_health_provider_model ON model_health(provider, model, created_at);
CREATE INDEX IF NOT EXISTS idx_model_health_circuit ON model_health(provider, model, circuit_state);

PRAGMA foreign_key_check;
`;

export const MIGRATION_024_MESSAGE_REFERENCES_SQL = `
-- Migration 24: message_references table for reply references & citation jumps
CREATE TABLE IF NOT EXISTS message_references (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES web_messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reply_to_message_id TEXT REFERENCES web_messages(id) ON DELETE SET NULL,
  quote_snippet TEXT NOT NULL,
  source_role TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_msg_refs_message_id ON message_references(message_id);
CREATE INDEX IF NOT EXISTS idx_msg_refs_user_id ON message_references(user_id);
CREATE INDEX IF NOT EXISTS idx_msg_refs_reply_to ON message_references(reply_to_message_id);

PRAGMA foreign_key_check;
`;

export const MIGRATION_024_RESERVED_SQL = MIGRATION_024_MESSAGE_REFERENCES_SQL;

export const MIGRATION_025_RUNTIME_DIAGNOSTICS_SQL = `
-- 1. Create runtime_diagnostics table for host-side structured diagnostics and telemetry samples
CREATE TABLE IF NOT EXISTS runtime_diagnostics (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  container_id TEXT,
  event_type TEXT NOT NULL CHECK(event_type IN ('lifecycle_start', 'lifecycle_stop', 'lifecycle_restart', 'health_check', 'tool_failure', 'resource_sample', 'error', 'system')),
  level TEXT NOT NULL CHECK(level IN ('debug', 'info', 'warn', 'error')),
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT,
  cpu_percent REAL,
  memory_usage_bytes INTEGER,
  memory_limit_bytes INTEGER,
  pids_count INTEGER,
  volume_bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_runtime_diag_user_created ON runtime_diagnostics(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runtime_diag_user_level ON runtime_diagnostics(user_id, level);
CREATE INDEX IF NOT EXISTS idx_runtime_diag_created ON runtime_diagnostics(created_at);

PRAGMA foreign_key_check;
`;

export const MIGRATION_026_TASK_NOTIFICATIONS_SQL = `
-- 1. Create task_notification_subscriptions table
CREATE TABLE IF NOT EXISTS task_notification_subscriptions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES platform_tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK(channel IN ('in_app', 'webhook')),
  destination TEXT,
  secret_hash TEXT,
  secret_ciphertext TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  events TEXT NOT NULL DEFAULT '["completed", "failed", "cancelled", "timeout"]',
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_task_notif_sub_task ON task_notification_subscriptions(task_id, enabled);
CREATE INDEX IF NOT EXISTS idx_task_notif_sub_user ON task_notification_subscriptions(user_id, channel);

-- 2. Create task_notification_deliveries table
CREATE TABLE IF NOT EXISTS task_notification_deliveries (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES task_notification_subscriptions(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES platform_tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK(channel IN ('in_app', 'webhook')),
  event TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'failed', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_retry_at TEXT,
  last_error TEXT,
  payload_json TEXT NOT NULL,
  response_status INTEGER,
  response_time_ms INTEGER,
  idempotency_key TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_task_notif_deliv_status_retry ON task_notification_deliveries(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_task_notif_deliv_task_created ON task_notification_deliveries(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_notif_deliv_user ON task_notification_deliveries(user_id, status);

PRAGMA foreign_key_check;
`;

export const MIGRATION_027_SESSION_EXECUTION_LEASES_SQL = `
-- 1. Create session_execution_leases table for durable per-session serialization
CREATE TABLE IF NOT EXISTS session_execution_leases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  phase TEXT NOT NULL DEFAULT 'claimed' CHECK(phase IN ('claimed', 'executing', 'result_observed')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'blocked', 'released')),
  blocked_code TEXT,
  worker_id TEXT NOT NULL,
  result_receipt TEXT,
  acquired_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  heartbeat_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  expires_at TEXT NOT NULL,
  released_at TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_leases_active_route 
  ON session_execution_leases(user_id, route_id) 
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_session_leases_user_route_status 
  ON session_execution_leases(user_id, route_id, status);

CREATE INDEX IF NOT EXISTS idx_session_leases_turn_id 
  ON session_execution_leases(turn_id);

-- 2. Create session_recovery_state table for graceful session pausing without hard status union breaks
CREATE TABLE IF NOT EXISTS session_recovery_state (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'recovery_required' CHECK(status IN ('recovery_required', 'recovering', 'resolved')),
  failure_code TEXT NOT NULL,
  failure_detail TEXT,
  raw_backup_path TEXT,
  raw_backup_checksum TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(user_id, route_id, generation)
);

CREATE INDEX IF NOT EXISTS idx_session_recovery_user_route 
  ON session_recovery_state(user_id, route_id, status);

-- 3. Partial unique index on turn_runs for strict single running turn per session
CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_runs_single_running 
  ON turn_runs(user_id, route_id) 
  WHERE status = 'running';

-- 4. Create turn_execution_queue table for authoritative queue position and material references
CREATE TABLE IF NOT EXISTS turn_execution_queue (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL UNIQUE,
  delivery_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  payload_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_turn_exec_queue_route 
  ON turn_execution_queue(user_id, route_id, position);

PRAGMA foreign_key_check;
`;

export const MIGRATION_027_SQL = MIGRATION_027_SESSION_EXECUTION_LEASES_SQL;

export const MIGRATION_028_USER_THEME_PREFERENCE_SQL = `
-- Migration 28: Extend users table with theme preference ('dark', 'light', 'eye-care')
ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'dark' CHECK(theme IN ('dark', 'light', 'eye-care'));

PRAGMA foreign_key_check;
`;

export const MIGRATION_028_USER_THEME_PREFERENCES_SQL = MIGRATION_028_USER_THEME_PREFERENCE_SQL;

export const MIGRATION_029_SPACE_MOUNTS_SQL = `
-- Migration 29: Space Mounts per space (RO/RW, encrypted host source path and fingerprint)
CREATE TABLE IF NOT EXISTS space_mounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source_path_encrypted TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'ro' CHECK(mode IN ('ro', 'rw')),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(space_id, name)
);

CREATE INDEX IF NOT EXISTS idx_space_mounts_user ON space_mounts(user_id);
CREATE INDEX IF NOT EXISTS idx_space_mounts_space ON space_mounts(space_id);
CREATE INDEX IF NOT EXISTS idx_space_mounts_user_space ON space_mounts(user_id, space_id);

PRAGMA foreign_key_check;
`;

export const MIGRATION_030_EXTENSIONS_CATALOG_AND_BINDINGS_SQL = `
-- Migration 30: Unified Extensions Catalog, Contributions, Bindings, Versions
-- 1. Create extension_packages table
CREATE TABLE IF NOT EXISTS extension_packages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('git', 'archive', 'builtin')),
  source_ref TEXT,
  installed_version INTEGER NOT NULL DEFAULT 1,
  active_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
  integrity_sha256 TEXT NOT NULL,
  provenance_json TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(user_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_ext_packages_user_slug ON extension_packages(user_id, slug);
CREATE INDEX IF NOT EXISTS idx_ext_packages_user_status ON extension_packages(user_id, status);

-- 2. Create extension_contributions table
CREATE TABLE IF NOT EXISTS extension_contributions (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES extension_packages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('skill', 'mcp', 'cli', 'dsh-plugin', 'browser')),
  contribution_key TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(package_id, kind, contribution_key)
);

CREATE INDEX IF NOT EXISTS idx_ext_contribs_pkg_kind ON extension_contributions(package_id, kind);
CREATE INDEX IF NOT EXISTS idx_ext_contribs_kind_key ON extension_contributions(kind, contribution_key);

-- 3. Create extension_bindings table
CREATE TABLE IF NOT EXISTS extension_bindings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  contribution_id TEXT NOT NULL REFERENCES extension_contributions(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(space_id, contribution_id)
);

CREATE INDEX IF NOT EXISTS idx_ext_bindings_user_space ON extension_bindings(user_id, space_id);
CREATE INDEX IF NOT EXISTS idx_ext_bindings_space_contrib ON extension_bindings(space_id, contribution_id);
CREATE INDEX IF NOT EXISTS idx_ext_bindings_contrib ON extension_bindings(contribution_id);

-- 4. Create extension_versions table
CREATE TABLE IF NOT EXISTS extension_versions (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES extension_packages(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('git', 'archive', 'builtin')),
  source_ref TEXT,
  commit_sha TEXT,
  integrity_sha256 TEXT NOT NULL,
  manifest_json TEXT,
  artifact_path TEXT,
  change_summary TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(package_id, version)
);

CREATE INDEX IF NOT EXISTS idx_ext_versions_pkg ON extension_versions(package_id);

-- 5. Migrate existing Skill data from M21 tables if they exist
-- 5.1 Copy skill_packages -> extension_packages
INSERT OR IGNORE INTO extension_packages (
  id, user_id, slug, name, description, source_kind, source_ref,
  installed_version, active_version, status, integrity_sha256,
  provenance_json, created_at, updated_at
)
SELECT
  sp.id,
  sp.user_id,
  sp.name AS slug,
  sp.name AS name,
  NULL AS description,
  CASE
    WHEN sp.source_type = 'git' THEN 'git'
    WHEN sp.source_type = 'upload' THEN 'archive'
    ELSE 'builtin'
  END AS source_kind,
  COALESCE(sp.source_ref, sp.source_url) AS source_ref,
  sp.version AS installed_version,
  sp.version AS active_version,
  CASE
    WHEN sp.status = 'active' THEN 'active'
    ELSE 'disabled'
  END AS status,
  sp.content_hash AS integrity_sha256,
  json_object(
    'sourceType', sp.source_type,
    'sourceUrl', sp.source_url,
    'sourceRef', sp.source_ref,
    'commitSha', sp.commit_sha,
    'subdirectory', sp.subdirectory,
    'scope', sp.scope,
    'spaceId', sp.space_id
  ) AS provenance_json,
  sp.created_at,
  sp.updated_at
FROM skill_packages sp
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'skill_packages');

-- 5.2 Copy skill_packages -> extension_contributions (kind = 'skill')
INSERT OR IGNORE INTO extension_contributions (
  id, package_id, kind, contribution_key, manifest_json, status, created_at, updated_at
)
SELECT
  'contrib_' || sp.id,
  sp.id AS package_id,
  'skill' AS kind,
  sp.name AS contribution_key,
  COALESCE(sp.manifest_json, '{}') AS manifest_json,
  CASE
    WHEN sp.status = 'active' THEN 'active'
    ELSE 'disabled'
  END AS status,
  sp.created_at,
  sp.updated_at
FROM skill_packages sp
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'skill_packages');

-- 5.3 Copy skill_package_versions -> extension_versions
INSERT OR IGNORE INTO extension_versions (
  id, package_id, version, source_kind, source_ref, commit_sha,
  integrity_sha256, manifest_json, artifact_path, change_summary, created_at
)
SELECT
  spv.id,
  spv.package_id,
  spv.version,
  CASE
    WHEN sp.source_type = 'git' THEN 'git'
    WHEN sp.source_type = 'upload' THEN 'archive'
    ELSE 'builtin'
  END AS source_kind,
  COALESCE(sp.source_ref, sp.source_url) AS source_ref,
  spv.commit_sha,
  spv.content_hash AS integrity_sha256,
  spv.manifest_json,
  NULL AS artifact_path,
  spv.change_summary,
  spv.created_at
FROM skill_package_versions spv
JOIN skill_packages sp ON sp.id = spv.package_id
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'skill_package_versions');

-- 5.4 Copy skill_bindings -> extension_bindings (only package-linked bindings)
INSERT OR IGNORE INTO extension_bindings (
  id, user_id, space_id, contribution_id, enabled, created_at, updated_at
)
SELECT
  sb.id,
  sb.user_id,
  sb.space_id,
  ec.id AS contribution_id,
  sb.enabled,
  sb.created_at,
  sb.updated_at
FROM skill_bindings sb
JOIN extension_contributions ec ON ec.package_id = sb.package_id AND ec.kind = 'skill'
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'skill_bindings')
  AND EXISTS (
    SELECT 1 FROM spaces s WHERE s.id = sb.space_id
  );

PRAGMA foreign_key_check;
`;

export const MIGRATION_031_GENERIC_CHANNELS_SQL = `
-- Migration 31: Minimal generic channel tables (channel_accounts, channel_bindings, channel_inbox, channel_outbox)
-- 1. Create channel_accounts table
CREATE TABLE IF NOT EXISTS channel_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled', 'unverified')),
  credential_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_channel_accounts_user ON channel_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_channel_accounts_user_type ON channel_accounts(user_id, type);

-- 2. Create channel_bindings table
CREATE TABLE IF NOT EXISTS channel_bindings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  native_context_id TEXT NOT NULL,
  activation_mode TEXT NOT NULL DEFAULT 'mention' CHECK(activation_mode IN ('mention', 'always')),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(account_id, native_context_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_bindings_user ON channel_bindings(user_id);
CREATE INDEX IF NOT EXISTS idx_channel_bindings_space ON channel_bindings(space_id);
CREATE INDEX IF NOT EXISTS idx_channel_bindings_account ON channel_bindings(account_id);
CREATE INDEX IF NOT EXISTS idx_channel_bindings_account_ctx ON channel_bindings(account_id, native_context_id);

-- 3. Create channel_inbox table (durable idempotent inbound events)
CREATE TABLE IF NOT EXISTS channel_inbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  native_event_id TEXT NOT NULL,
  native_context_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'held' CHECK(status IN ('held', 'processing', 'delivered', 'failed')),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(account_id, native_event_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_inbox_user ON channel_inbox(user_id);
CREATE INDEX IF NOT EXISTS idx_channel_inbox_account ON channel_inbox(account_id);
CREATE INDEX IF NOT EXISTS idx_channel_inbox_status ON channel_inbox(status);
CREATE INDEX IF NOT EXISTS idx_channel_inbox_account_event ON channel_inbox(account_id, native_event_id);

-- 4. Create channel_outbox table (durable outbound assistant replies)
CREATE TABLE IF NOT EXISTS channel_outbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
  native_context_id TEXT NOT NULL,
  reply_to_native_id TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_channel_outbox_user ON channel_outbox(user_id);
CREATE INDEX IF NOT EXISTS idx_channel_outbox_account ON channel_outbox(account_id);
CREATE INDEX IF NOT EXISTS idx_channel_outbox_session ON channel_outbox(session_id);
CREATE INDEX IF NOT EXISTS idx_channel_outbox_status ON channel_outbox(status);

PRAGMA foreign_key_check;
`;

export const MIGRATION_032_CHANNEL_ENCRYPTED_CREDENTIALS_SQL = `
-- Migration 32: Server-side encrypted credential store for channel accounts
CREATE TABLE IF NOT EXISTS channel_encrypted_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_ref TEXT NOT NULL UNIQUE,
  encrypted_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_channel_enc_creds_user ON channel_encrypted_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_channel_enc_creds_ref ON channel_encrypted_credentials(credential_ref);

PRAGMA foreign_key_check;
`;

export const MIGRATION_033_CHANNEL_ACCOUNT_DEFAULT_SPACE_SQL = `
-- Migration 33: Persisted default space for channel accounts
ALTER TABLE channel_accounts ADD COLUMN default_space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_channel_accounts_default_space ON channel_accounts(default_space_id);

PRAGMA foreign_key_check;
`;

export const MIGRATION_034_CHANNEL_ACCOUNT_GROUP_ACTIVATION_MODE_SQL = `
-- Migration 34: Per-account group trigger mode and binding chat type
ALTER TABLE channel_accounts ADD COLUMN group_activation_mode TEXT NOT NULL DEFAULT 'mention' CHECK(group_activation_mode IN ('mention', 'always'));
ALTER TABLE channel_bindings ADD COLUMN chat_type TEXT;

PRAGMA foreign_key_check;
`;

export const MIGRATION_035_QUOTA_DEFAULT_UNLIMITED_SQL = `
-- Migration 35: Set all existing quota limits to -1 (unlimited)
UPDATE quota_limits SET limit_amount = -1, updated_at = CURRENT_TIMESTAMP;

PRAGMA foreign_key_check;
`;

export const BUILTIN_MIGRATIONS: MigrationDefinition[] = [
  {
    version: 1,
    name: '001_initial_happyclaw_subset',
    upSql: MIGRATION_001_SQL,
    checksum: computeChecksum(MIGRATION_001_SQL),
  },
  {
    version: 2,
    name: '002_route_identity_and_scoped_cursors',
    upSql: MIGRATION_002_SQL,
    checksum: computeChecksum(MIGRATION_002_SQL),
  },
  {
    version: 3,
    name: '003_delivery_inbox',
    upSql: MIGRATION_003_SQL,
    checksum: computeChecksum(MIGRATION_003_SQL),
  },
  {
    version: 4,
    name: '004_platform_operations',
    upSql: MIGRATION_004_SQL,
    checksum: computeChecksum(MIGRATION_004_SQL),
  },
];

/**
 * Validates that migration manifest definitions have unique and sequential versions.
 */
export function validateMigrationManifest(migrations: MigrationDefinition[]): MigrationDefinition[] {
  if (!migrations || migrations.length === 0) {
    return [];
  }

  const seenVersions = new Set<number>();
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version <= 0) {
      throw new MigrationError(`Invalid migration version: ${String(m.version)}. Version must be a positive integer.`);
    }
    if (!m.name || typeof m.name !== 'string') {
      throw new MigrationError(`Invalid migration name for version ${m.version}. Name must be a non-empty string.`);
    }
    if (!m.upSql || typeof m.upSql !== 'string') {
      throw new MigrationError(`Invalid migration upSql for version ${m.version}. upSql must be a non-empty string.`);
    }
    if (seenVersions.has(m.version)) {
      throw new MigrationError(`Duplicate migration version in manifest: version ${m.version} appears multiple times.`);
    }
    seenVersions.add(m.version);
  }

  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  // Check sequential continuity in manifest (starting at 1)
  if (sorted[0].version !== 1) {
    throw new MigrationError(`Migration manifest must start at version 1 (found start version: ${sorted[0].version}).`);
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].version !== sorted[i - 1].version + 1) {
      throw new MigrationError(
        `Non-sequential migration versions in manifest: version ${sorted[i - 1].version} followed by ${sorted[i].version}. Manifest must be strictly sequential (1, 2, 3...).`
      );
    }
  }

  return sorted;
}

export class SqliteMigrationRunner implements MigrationRunner {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private initMigrationsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
    `);
  }

  private getAppliedMigrationsSync(): MigrationRecord[] {
    this.initMigrationsTable();
    const stmt = this.db.prepare(
      'SELECT version, name, checksum, applied_at FROM _schema_migrations ORDER BY version ASC'
    );
    return queryAll(stmt, parseMigrationRecordRow);
  }

  async getAppliedMigrations(): Promise<MigrationRecord[]> {
    return this.getAppliedMigrationsSync();
  }

  async getCurrentVersion(): Promise<number> {
    const applied = this.getAppliedMigrationsSync();
    if (applied.length === 0) return 0;
    return applied[applied.length - 1].version;
  }

  private verifyChecksumsSync(migrations: MigrationDefinition[]): void {
    const applied = this.getAppliedMigrationsSync();
    const migrationMap = new Map<number, MigrationDefinition>();
    for (const m of migrations) {
      migrationMap.set(m.version, {
        ...m,
        checksum: m.checksum ?? computeChecksum(m.upSql),
      });
    }

    const latestCodeVersion = migrations.reduce((max, m) => Math.max(max, m.version), 0);

    for (const record of applied) {
      if (record.version > latestCodeVersion) {
        throw new MigrationDowngradeError(record.version, latestCodeVersion);
      }

      const defined = migrationMap.get(record.version);
      if (!defined) {
        throw new MigrationError(
          `Unknown migration version ${record.version} found in database. Codebase is missing this migration.`
        );
      }

      const expectedChecksum = defined.checksum ?? computeChecksum(defined.upSql);
      if (record.checksum !== expectedChecksum) {
        throw new MigrationChecksumMismatchError(record.version, record.checksum, expectedChecksum);
      }
    }
  }

  async verifyChecksums(migrations: MigrationDefinition[] = BUILTIN_MIGRATIONS): Promise<void> {
    this.verifyChecksumsSync(migrations);
  }

  async migrate(migrations: MigrationDefinition[] = BUILTIN_MIGRATIONS): Promise<MigrationRecord[]> {
    // 1. Validate manifest sequentiality and deduplication before acquiring transaction lock
    const sortedManifest = validateMigrationManifest(migrations);
    if (sortedManifest.length === 0) {
      return [];
    }

    // 2. Acquire write lock before checking applied migrations and verifying checksums
    const maxRetries = 50;
    let inTransaction = false;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        this.db.exec('BEGIN IMMEDIATE;');
        inTransaction = true;
        break;
      } catch (err: any) {
        const errMsg = String(err?.message || err || '').toLowerCase();
        if ((errMsg.includes('locked') || errMsg.includes('busy')) && attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    try {
      this.initMigrationsTable();

      // Re-verify existing applied migrations inside lock synchronously (detect downgrade & tampering)
      this.verifyChecksumsSync(sortedManifest);

      const applied = this.getAppliedMigrationsSync();

      // Check that existing applied migrations in database are contiguous (1, 2, ... N)
      if (applied.length > 0) {
        if (applied[0].version !== 1) {
          throw new MigrationError(
            `Database contains non-contiguous applied migrations: first applied version is ${applied[0].version}, expected 1.`
          );
        }
        for (let i = 1; i < applied.length; i++) {
          if (applied[i].version !== applied[i - 1].version + 1) {
            throw new MigrationError(
              `Database contains non-contiguous applied migrations: version ${applied[i - 1].version} followed by ${applied[i].version}.`
            );
          }
        }
      }

      const appliedVersions = new Set(applied.map((r) => r.version));
      let currentVersion = applied.length > 0 ? applied[applied.length - 1].version : 0;
      const newlyApplied: MigrationRecord[] = [];

      for (const migration of sortedManifest) {
        if (appliedVersions.has(migration.version)) {
          continue;
        }

        if (migration.version !== currentVersion + 1) {
          throw new MigrationError(
            `Database contains non-contiguous applied migrations: expected version ${currentVersion + 1}, got ${migration.version}.`
          );
        }

        const checksum = migration.checksum ?? computeChecksum(migration.upSql);

        this.db.exec(migration.upSql);

        this.db.prepare(`
          INSERT INTO _schema_migrations (version, name, checksum, applied_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        `).run(migration.version, migration.name, checksum);

        const recordRow = this.db.prepare(
          'SELECT version, name, checksum, applied_at FROM _schema_migrations WHERE version = ?'
        ).get(migration.version) as { version: number; name: string; checksum: string; applied_at: string };

        const record: MigrationRecord = {
          version: recordRow.version,
          name: recordRow.name,
          checksum: recordRow.checksum,
          appliedAt: recordRow.applied_at,
        };

        newlyApplied.push(record);
        currentVersion = migration.version;
      }

      this.db.exec('COMMIT;');
      inTransaction = false;
      return newlyApplied;
    } catch (err) {
      if (inTransaction) {
        try {
          this.db.exec('ROLLBACK;');
        } catch {
          // ignore rollback error
        }
      }
      throw err;
    }
  }
}
