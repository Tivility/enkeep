import type { StatementSync, DatabaseSync } from 'node:sqlite';
import type {
  User,
  UserLocale,
  UserTheme,
  UserSession,
  AuthAuditLog,
  Space,
  ExecutionMode,
  SessionRoute,
  SessionSource,
  DeliveryReceipt,
  DeliveryInboxEntry,
  EventCursor,
  TurnRun,
  MigrationRecord,
  AgentProfile,
  AgentProfileSnapshot,
  SessionGeneration,
  LifecycleStatus,
  ChannelAccount,
  ChannelBinding,
  ChannelInboxItem,
  ChannelOutboxItem,
} from '@enkeep/platform-core';
import type {
  FileMetadata,
  Task,
  TaskPriority,
  TaskStatus,
  AgentPromptTaskPayload,
  AgentPromptDispatchResult,
  TenantQuotaLimit,
  QuotaReservation,
  QuotaReservationStatus,
  QuotaMetric,
  QuotaBundle,
  TaskSchedule,
  TaskRun,
  TaskScheduleType,
  TaskScheduleMisfirePolicy,
  TaskScheduleOverlapPolicy,
  TaskRunStatus,
} from '@enkeep/platform-operations';
import {
  validateScheduleType,
  validateMisfirePolicy,
  validateOverlapPolicy,
} from '@enkeep/platform-operations';

/**
 * Strict database input parameter type. Subtype of SQLInputValue in node:sqlite.
 */
export type DbParam = string | number | bigint | Uint8Array | null;

/**
 * Strict database row representation. Subtype of Record<string, SQLOutputValue>.
 */
export type DbRow = Record<string, string | number | bigint | Uint8Array | null>;

export function getString(row: DbRow, col: string): string {
  const val = row[col];
  if (typeof val === 'string') return val;
  if (val === null || val === undefined) {
    throw new Error(`Expected non-null string for column '${col}', got ${String(val)}`);
  }
  return String(val);
}

export function getNullableString(row: DbRow, col: string): string | null {
  const val = row[col];
  if (val === null || val === undefined) return null;
  return typeof val === 'string' ? val : String(val);
}

export function getNumber(row: DbRow, col: string): number {
  const val = row[col];
  if (typeof val === 'number') return val;
  if (typeof val === 'bigint') return Number(val);
  if (typeof val === 'string') {
    const num = Number(val);
    if (!Number.isNaN(num)) return num;
  }
  throw new Error(`Expected number for column '${col}', got ${String(val)}`);
}

export function getNullableNumber(row: DbRow, col: string): number | null {
  const val = row[col];
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return val;
  if (typeof val === 'bigint') return Number(val);
  const num = Number(val);
  return Number.isNaN(num) ? null : num;
}

export function getJson<T = Record<string, unknown>>(row: DbRow, col: string): T | null {
  const val = row[col];
  if (!val || typeof val !== 'string') return null;
  try {
    return JSON.parse(val) as T;
  } catch {
    return null;
  }
}

export function parseUserRow(row: DbRow): User {
  let locale: UserLocale = 'en';
  if ('locale' in row) {
    const rawLocale = row['locale'];
    if (rawLocale === null || rawLocale === undefined || (rawLocale !== 'en' && rawLocale !== 'zh-CN')) {
      throw new Error(`Corrupted user row: invalid or damaged locale '${String(rawLocale)}' for user id '${getString(row, 'id')}'`);
    }
    locale = rawLocale as UserLocale;
  }
  let theme: UserTheme = 'dark';
  if ('theme' in row) {
    const rawTheme = row['theme'];
    if (rawTheme === null || rawTheme === undefined || (rawTheme !== 'dark' && rawTheme !== 'light' && rawTheme !== 'eye-care')) {
      throw new Error(`Corrupted user row: invalid or damaged theme '${String(rawTheme)}' for user id '${getString(row, 'id')}'`);
    }
    theme = rawTheme as UserTheme;
  }
  let mustChangePassword = false;
  if ('must_change_password' in row) {
    const rawMustChange = row['must_change_password'];
    if (rawMustChange !== 0 && rawMustChange !== 1 && rawMustChange !== '0' && rawMustChange !== '1' && rawMustChange !== 0n && rawMustChange !== 1n) {
      throw new Error(`Corrupted user row: invalid or damaged must_change_password '${String(rawMustChange)}' for user id '${getString(row, 'id')}'`);
    }
    mustChangePassword = rawMustChange === 1 || rawMustChange === '1' || rawMustChange === 1n;
  }
  return {
    id: getString(row, 'id'),
    username: getString(row, 'username'),
    passwordHash: getString(row, 'password_hash'),
    role: getString(row, 'role') as User['role'],
    status: getString(row, 'status') as User['status'],
    displayName: getNullableString(row, 'display_name'),
    locale,
    theme,
    mustChangePassword,
    createdAt: getString(row, 'created_at'),
    updatedAt: getString(row, 'updated_at'),
  };
}

export function parseUserSessionRow(row: DbRow): UserSession {
  return {
    id: getString(row, 'id'),
    userId: getString(row, 'user_id'),
    tokenHash: getString(row, 'token_hash'),
    expiresAt: getString(row, 'expires_at'),
    createdAt: getString(row, 'created_at'),
    lastSeenAt: getString(row, 'last_seen_at'),
    revokedAt: getNullableString(row, 'revoked_at'),
    userAgent: getNullableString(row, 'user_agent'),
    ipAddress: getNullableString(row, 'ip_address'),
  };
}

export function parseAuthAuditLogRow(row: DbRow): AuthAuditLog {
  return {
    id: getString(row, 'id'),
    userId: getNullableString(row, 'user_id'),
    username: getNullableString(row, 'username'),
    action: getString(row, 'action') as AuthAuditLog['action'],
    ipAddress: getNullableString(row, 'ip_address'),
    userAgent: getNullableString(row, 'user_agent'),
    details: getJson<Record<string, unknown>>(row, 'details'),
    createdAt: getString(row, 'created_at'),
  };
}

export function parseSpaceRow(row: DbRow): Space {
  const statusStr = getNullableString(row, 'status');
  const status: LifecycleStatus =
    statusStr === 'archived' || statusStr === 'deleted' ? statusStr : 'active';
  const executionMode = (getNullableString(row, 'execution_mode') ?? 'container') as ExecutionMode;

  return {
    id: getString(row, 'id'),
    userId: getString(row, 'user_id'),
    name: getString(row, 'name'),
    folder: getString(row, 'folder'),
    executionMode,
    status,
    agentProfileId: getNullableString(row, 'agent_profile_id'),
    agentProfileSnapshotId: getNullableString(row, 'agent_profile_snapshot_id'),
    createdAt: getString(row, 'created_at'),
    updatedAt: getString(row, 'updated_at'),
  };
}

export function parseSessionRouteRow(row: DbRow): SessionRoute {
  const peerId = getNullableString(row, 'peer_id') ?? '';
  const nativeContextId = getNullableString(row, 'native_context_id') ?? peerId;
  const accountId = getNullableString(row, 'account_id') ?? 'default';
  const statusStr = getNullableString(row, 'status');
  const status: LifecycleStatus =
    statusStr === 'archived' || statusStr === 'deleted' ? statusStr : 'active';

  return {
    id: getString(row, 'id'),
    spaceId: getString(row, 'space_id'),
    userId: getString(row, 'user_id'),
    channel: getString(row, 'channel'),
    accountId,
    nativeContextId,
    peerId: peerId || nativeContextId,
    dshSessionId: getString(row, 'dsh_session_id'),
    executionMode: (getNullableString(row, 'execution_mode') ?? 'container') as ExecutionMode,
    status,
    title: getNullableString(row, 'title'),
    lastResetAt: getNullableString(row, 'last_reset_at'),
    resetCount: getNullableNumber(row, 'reset_count') ?? 0,
    currentGeneration: getNullableNumber(row, 'current_generation') ?? 1,
    agentProfileId: getNullableString(row, 'agent_profile_id'),
    agentProfileSnapshotId: getNullableString(row, 'agent_profile_snapshot_id'),
    createdAt: getString(row, 'created_at'),
    updatedAt: getString(row, 'updated_at'),
  };
}

export function parseSessionSourceRow(row: DbRow): SessionSource {
  return {
    id: getString(row, 'id'),
    routeId: getString(row, 'route_id'),
    sourceType: getString(row, 'source_type'),
    sourceId: getString(row, 'source_id'),
    userId: getString(row, 'user_id'),
    metadata: getJson<Record<string, unknown>>(row, 'metadata'),
    createdAt: getString(row, 'created_at'),
  };
}

export function parseDeliveryReceiptRow(row: DbRow): DeliveryReceipt {
  return {
    id: getString(row, 'id'),
    userId: getString(row, 'user_id'),
    routeId: getString(row, 'route_id'),
    messageId: getString(row, 'message_id'),
    deliveryId: getString(row, 'delivery_id'),
    status: getString(row, 'status') as DeliveryReceipt['status'],
    error: getNullableString(row, 'error'),
    createdAt: getString(row, 'created_at'),
    updatedAt: getString(row, 'updated_at'),
  };
}

export function parseDeliveryInboxRow(row: DbRow): DeliveryInboxEntry {
  return {
    id: getString(row, 'id'),
    userId: getString(row, 'user_id'),
    routeId: getString(row, 'route_id'),
    messageId: getString(row, 'message_id'),
    deliveryId: getString(row, 'delivery_id'),
    status: getString(row, 'status') as DeliveryInboxEntry['status'],
    payload: getJson<Record<string, unknown>>(row, 'payload'),
    error: getNullableString(row, 'error'),
    receivedAt: getString(row, 'received_at'),
    processedAt: getNullableString(row, 'processed_at'),
    createdAt: getString(row, 'created_at'),
    updatedAt: getString(row, 'updated_at'),
  };
}

export function parseEventCursorRow(row: DbRow): EventCursor {
  return {
    id: getString(row, 'id'),
    userId: getString(row, 'user_id'),
    routeId: getString(row, 'route_id'),
    consumer: getNullableString(row, 'consumer') ?? 'default',
    cursorValue: getString(row, 'cursor_value'),
    updatedAt: getString(row, 'updated_at'),
  };
}

export function parseTurnRunRow(row: DbRow): TurnRun {
  return {
    id: getString(row, 'id'),
    userId: getString(row, 'user_id'),
    spaceId: getString(row, 'space_id'),
    routeId: getString(row, 'route_id'),
    turnId: getString(row, 'turn_id'),
    status: getString(row, 'status') as TurnRun['status'],
    startedAt: getNullableString(row, 'started_at'),
    finishedAt: getNullableString(row, 'finished_at'),
    error: getNullableString(row, 'error'),
    executionMode: (getNullableString(row, 'execution_mode') ?? 'container') as ExecutionMode,
    createdAt: getString(row, 'created_at'),
    updatedAt: getString(row, 'updated_at'),
  };
}

export function parseMigrationRecordRow(row: DbRow): MigrationRecord {
  return {
    version: getNumber(row, 'version'),
    name: getString(row, 'name'),
    checksum: getString(row, 'checksum'),
    appliedAt: getString(row, 'applied_at'),
  };
}

export function parseAgentProfileRow(row: DbRow): AgentProfile {
  const statusStr = getNullableString(row, 'status');
  const status: LifecycleStatus =
    statusStr === 'archived' || statusStr === 'deleted' ? statusStr : 'active';

  return {
    id: getString(row, 'id'),
    userId: getString(row, 'user_id'),
    name: getString(row, 'name'),
    description: getNullableString(row, 'description'),
    status,
    activeVersion: getNumber(row, 'active_version'),
    createdAt: getString(row, 'created_at'),
    updatedAt: getString(row, 'updated_at'),
  };
}

export function parseAgentProfileSnapshotRow(row: DbRow): AgentProfileSnapshot {
  return {
    id: getString(row, 'id'),
    userId: getString(row, 'user_id'),
    profileId: getString(row, 'profile_id'),
    version: getNumber(row, 'version'),
    promptMode: 'append',
    promptHash: getString(row, 'prompt_hash'),
    identity: getNullableString(row, 'identity') ?? '',
    soul: getNullableString(row, 'soul') ?? '',
    agents: getNullableString(row, 'agents') ?? '',
    tools: getNullableString(row, 'tools') ?? '',
    changeSummary: getNullableString(row, 'change_summary'),
    createdAt: getString(row, 'created_at'),
  };
}

export function parseSessionGenerationRow(row: DbRow): SessionGeneration {
  return {
    id: getString(row, 'id'),
    userId: getString(row, 'user_id'),
    routeId: getString(row, 'route_id'),
    generationNumber: getNumber(row, 'generation_number'),
    dshSessionId: getString(row, 'dsh_session_id'),
    agentProfileSnapshotId: getNullableString(row, 'agent_profile_snapshot_id'),
    resetReason: getNullableString(row, 'reset_reason'),
    createdAt: getString(row, 'created_at'),
  };
}

export function parseFileMetadataRow(row: DbRow): FileMetadata {
  return {
    id: getString(row, 'id'),
    userId: getString(row, 'user_id'),
    filename: getString(row, 'filename'),
    relativePath: getString(row, 'relative_path'),
    size: getNumber(row, 'size'),
    mimeType: getNullableString(row, 'mime_type') ?? undefined,
    extension: getString(row, 'extension'),
    checksum: getNullableString(row, 'checksum') ?? undefined,
    recipient: getString(row, 'recipient'),
    description: getNullableString(row, 'description') ?? undefined,
    metadata: getJson<Record<string, unknown>>(row, 'metadata') ?? undefined,
    createdAt: getString(row, 'created_at'),
  };
}

export function parsePlatformTaskRow(row: DbRow): Task {
  const payload = getJson<AgentPromptTaskPayload>(row, 'payload');
  if (!payload || typeof payload !== 'object' || payload.type !== 'agent_prompt') {
    throw new Error(`Corrupted task row: missing or invalid agent_prompt payload for task '${getString(row, 'id')}'`);
  }
  const rawScheduleType = getNullableString(row, 'schedule_type');
  return {
    id: getString(row, 'id'),
    userId: getString(row, 'user_id'),
    idempotencyKey: getNullableString(row, 'idempotency_key'),
    title: getString(row, 'title'),
    description: getNullableString(row, 'description'),
    assignee: getNullableString(row, 'assignee'),
    priority: getString(row, 'priority') as TaskPriority,
    status: getString(row, 'status') as TaskStatus,
    payload,
    result: getJson<AgentPromptDispatchResult>(row, 'result'),
    error: getNullableString(row, 'error'),
    claimantId: getNullableString(row, 'claimant_id'),
    leaseExpiresAt: getNullableString(row, 'lease_expires_at'),
    leaseDurationMs: getNumber(row, 'lease_duration_ms'),
    claimCount: getNumber(row, 'claim_count'),
    maxRetries: getNumber(row, 'max_retries'),
    dueDate: getNullableString(row, 'due_date'),
    scheduleType: rawScheduleType ? validateScheduleType(rawScheduleType) : 'once',
    cronExpression: getNullableString(row, 'cron_expression'),
    intervalSeconds: getNullableNumber(row, 'interval_seconds'),
    nextRunAt: getNullableString(row, 'next_run_at'),
    timezone: getNullableString(row, 'timezone') ?? 'UTC',
    createdAt: getString(row, 'created_at'),
    updatedAt: getString(row, 'updated_at'),
    completedAt: getNullableString(row, 'completed_at'),
  };
}

export function parseTaskScheduleRow(row: DbRow): TaskSchedule {
  const rawMisfire = getNullableString(row, 'misfire_policy');
  const rawOverlap = getNullableString(row, 'overlap_policy');
  const rawSchedType = getString(row, 'schedule_type');

  return {
    id: getString(row, 'id'),
    taskId: getString(row, 'task_id'),
    userId: getString(row, 'user_id'),
    scheduleType: validateScheduleType(rawSchedType),
    cronExpression: getNullableString(row, 'cron_expression'),
    intervalSeconds: getNullableNumber(row, 'interval_seconds'),
    nextRunAt: getNullableString(row, 'next_run_at'),
    lastRunAt: getNullableString(row, 'last_run_at'),
    timezone: getString(row, 'timezone') ?? 'UTC',
    enabled: getNumber(row, 'enabled') === 1,
    pausedAt: getNullableString(row, 'paused_at'),
    misfirePolicy: validateMisfirePolicy(rawMisfire ?? 'coalesce'),
    overlapPolicy: validateOverlapPolicy(rawOverlap ?? 'skip'),
    createdAt: getString(row, 'created_at'),
    updatedAt: getString(row, 'updated_at'),
  };
}

export function parseTaskRunRow(row: DbRow): TaskRun {
  return {
    id: getString(row, 'id'),
    taskId: getString(row, 'task_id'),
    scheduleId: getNullableString(row, 'schedule_id'),
    userId: getString(row, 'user_id'),
    attemptNumber: getNumber(row, 'attempt_number'),
    status: getString(row, 'status') as TaskRunStatus,
    claimantId: getNullableString(row, 'claimant_id'),
    leaseExpiresAt: getNullableString(row, 'lease_expires_at'),
    scheduledFor: getNullableString(row, 'scheduled_for'),
    startedAt: getNullableString(row, 'started_at'),
    completedAt: getNullableString(row, 'completed_at'),
    deliveryId: getNullableString(row, 'delivery_id'),
    turnId: getNullableString(row, 'turn_id'),
    sessionId: getNullableString(row, 'session_id'),
    errorCode: getNullableString(row, 'error_code'),
    error: getNullableString(row, 'error'),
    promptTokens: getNullableNumber(row, 'prompt_tokens') ?? 0,
    completionTokens: getNullableNumber(row, 'completion_tokens') ?? 0,
    totalTokens: getNullableNumber(row, 'total_tokens') ?? 0,
    createdAt: getString(row, 'created_at'),
    updatedAt: getString(row, 'updated_at'),
  };
}

export function parseQuotaLimitRow(row: DbRow): TenantQuotaLimit {
  const rawUpdated = getString(row, 'updated_at');
  let updatedAt = rawUpdated;
  try {
    const d = new Date(rawUpdated);
    if (!Number.isNaN(d.getTime())) {
      updatedAt = d.toISOString();
    }
  } catch {}

  const rawReset = getNullableString(row, 'reset_at');
  let resetAt = rawReset;
  if (rawReset) {
    try {
      const d = new Date(rawReset);
      if (!Number.isNaN(d.getTime())) {
        resetAt = d.toISOString();
      }
    } catch {}
  }

  return {
    userId: getString(row, 'user_id'),
    resource: getString(row, 'resource') as QuotaMetric,
    limit: getNumber(row, 'limit_amount'),
    windowSeconds: getNullableNumber(row, 'window_seconds') ?? undefined,
    resetAt,
    resetInterval: getNullableString(row, 'reset_interval') ?? undefined,
    updatedAt,
  };
}

export function parseQuotaReservationRow(row: DbRow): QuotaReservation {
  return {
    id: getString(row, 'id'),
    userId: getString(row, 'user_id'),
    bundleId: getNullableString(row, 'bundle_id'),
    deliveryId: getNullableString(row, 'delivery_id'),
    resource: getString(row, 'resource') as QuotaMetric,
    amount: getNumber(row, 'amount'),
    status: getString(row, 'status') as QuotaReservationStatus,
    committedAmount: getNullableNumber(row, 'committed_amount'),
    expiresAt: getString(row, 'expires_at'),
    createdAt: getString(row, 'created_at'),
    settledAt: getNullableString(row, 'settled_at'),
  };
}

export function parseQuotaBundleRow(row: DbRow): QuotaBundle {
  return {
    id: getString(row, 'id'),
    userId: getString(row, 'user_id'),
    deliveryId: getString(row, 'delivery_id'),
    sessionId: getString(row, 'session_id'),
    requestHash: getString(row, 'request_hash'),
    status: getString(row, 'status') as QuotaReservationStatus,
    turns: getNumber(row, 'turns_amount'),
    messages: getNumber(row, 'messages_amount'),
    tokens: getNumber(row, 'tokens_amount'),
    isEstimateTokens: getNumber(row, 'is_estimate_tokens') === 1,
    turnsCommitted: getNullableNumber(row, 'turns_committed'),
    messagesCommitted: getNullableNumber(row, 'messages_committed'),
    tokensCommitted: getNullableNumber(row, 'tokens_committed'),
    expiresAt: getString(row, 'expires_at'),
    createdAt: getString(row, 'created_at'),
    settledAt: getNullableString(row, 'settled_at'),
  };
}

export function parseChannelAccountRow(row: DbRow): ChannelAccount {
  return {
    id: getString(row, 'id'),
    userId: getString(row, 'user_id'),
    type: getString(row, 'type'),
    status: getString(row, 'status') as ChannelAccount['status'],
    credentialRef: getNullableString(row, 'credential_ref'),
    defaultSpaceId: getNullableString(row, 'default_space_id'),
    groupActivationMode: (getNullableString(row, 'group_activation_mode') ?? 'mention') as ChannelAccount['groupActivationMode'],
    createdAt: getString(row, 'created_at'),
    updatedAt: getString(row, 'updated_at'),
  };
}

export function parseChannelBindingRow(row: DbRow): ChannelBinding {
  return {
    id: getString(row, 'id'),
    userId: getString(row, 'user_id'),
    accountId: getString(row, 'account_id'),
    spaceId: getString(row, 'space_id'),
    nativeContextId: getString(row, 'native_context_id'),
    activationMode: getString(row, 'activation_mode') as ChannelBinding['activationMode'],
    chatType: getNullableString(row, 'chat_type'),
    createdAt: getString(row, 'created_at'),
    updatedAt: getString(row, 'updated_at'),
  };
}

export function parseChannelInboxRow(row: DbRow): ChannelInboxItem {
  return {
    id: getString(row, 'id'),
    userId: getString(row, 'user_id'),
    accountId: getString(row, 'account_id'),
    nativeEventId: getString(row, 'native_event_id'),
    nativeContextId: getString(row, 'native_context_id'),
    payloadJson: getString(row, 'payload_json'),
    status: getString(row, 'status') as ChannelInboxItem['status'],
    createdAt: getString(row, 'created_at'),
    updatedAt: getString(row, 'updated_at'),
  };
}

export function parseChannelOutboxRow(row: DbRow): ChannelOutboxItem {
  return {
    id: getString(row, 'id'),
    userId: getString(row, 'user_id'),
    accountId: getString(row, 'account_id'),
    sessionId: getString(row, 'session_id'),
    nativeContextId: getString(row, 'native_context_id'),
    replyToNativeId: getNullableString(row, 'reply_to_native_id'),
    payloadJson: getString(row, 'payload_json'),
    status: getString(row, 'status') as ChannelOutboxItem['status'],
    attempts: getNumber(row, 'attempts'),
    createdAt: getString(row, 'created_at'),
    updatedAt: getString(row, 'updated_at'),
  };
}

/**
 * Execute a query expecting multiple mapped rows.
 */
export function queryAll<T>(
  stmt: StatementSync,
  mapper: (row: DbRow) => T,
  ...params: DbParam[]
): T[] {
  const rawRows = stmt.all(...params) as DbRow[];
  return rawRows.map(mapper);
}

/**
 * Execute a query expecting zero or one mapped row.
 */
export function queryOne<T>(
  stmt: StatementSync,
  mapper: (row: DbRow) => T,
  ...params: DbParam[]
): T | null {
  const rawRow = stmt.get(...params) as DbRow | undefined;
  if (!rawRow) return null;
  return mapper(rawRow);
}

/**
 * Execute an action inside an immediate transaction (`BEGIN IMMEDIATE;`).
 * If an error occurs and ROLLBACK also throws, aggregates both errors with `AggregateError`.
 */
export async function withImmediateTransaction<T>(
  db: DatabaseSync,
  action: () => T | Promise<T>
): Promise<T> {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = await action();
    db.exec('COMMIT;');
    return result;
  } catch (primaryErr) {
    try {
      db.exec('ROLLBACK;');
    } catch (rollbackErr) {
      throw new AggregateError(
        [primaryErr, rollbackErr],
        `Transaction failed with error: ${primaryErr instanceof Error ? primaryErr.message : String(primaryErr)}, and rollback also failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`
      );
    }
    throw primaryErr;
  }
}

/**
 * Execute an action synchronously inside an immediate transaction (`BEGIN IMMEDIATE;`).
 */
export function withImmediateTransactionSync<T>(
  db: DatabaseSync,
  action: () => T
): T {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = action();
    db.exec('COMMIT;');
    return result;
  } catch (primaryErr) {
    try {
      db.exec('ROLLBACK;');
    } catch (rollbackErr) {
      throw new AggregateError(
        [primaryErr, rollbackErr],
        `Transaction failed with error: ${primaryErr instanceof Error ? primaryErr.message : String(primaryErr)}, and rollback also failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`
      );
    }
    throw primaryErr;
  }
}

