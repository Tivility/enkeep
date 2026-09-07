/**
 * Console Data Source
 *
 * Provides safe, zero-migration, aggregated, and tenant-isolated data access
 * for Platform Server management console APIs over existing SQLite tables (v1-v8).
 *
 * Guarantees:
 * - Passwords, token hashes, secrets, and raw inbound payloads are strictly excluded.
 * - Sensitive fields in audit metadata are recursively redacted.
 * - Last active admin demotion/disabling protection.
 * - Automatic session revocation on account disabling.
 * - Strict multi-tenant boundaries on user-facing endpoints.
 * - Strict type converters: no fabrication of 0, no default masking of corrupt rows.
 * - Database and schema errors propagate authoritatively.
 * - Safe error codes without raw stack trace, dynamic values, or file path leakage.
 *
 * @module @enkeep/platform-server/management/console-data-source
 */

import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  NotFoundError,
  ForbiddenError,
  ValidationError,
  PlatformError,
  type PlatformStorage,
  type UserRole,
  type UserStatus,
  type UserLocale,
  type UserTheme,
} from '@enkeep/platform-core';
import { hashPassword, verifyPassword } from '@enkeep/platform-auth';
import {
  ALL_PLATFORM_MIGRATIONS,
  computeChecksum,
} from '../storage/migrations.js';
import {
  ALLOWED_HOSTS,
} from '../safety/host-binding.js';
import {
  DEFAULT_SECURITY_HEADERS,
  DEFAULT_SERVER_LIMITS,
  type ServerLimitsOptions,
} from '../safety/limits.js';
import {
  loadDshSafeModelConfig,
  buildSafeModelProjection,
} from '../config/dsh-model-config.js';
import {
  type AdminDashboardCounts,
  type AdminDashboardKpis,
  type AdminDashboardContainerKpi,
  type SafeAuthUser,
  type SafeAdminUser,
  type AdminUsersListResult,
  type PatchUserBody,
  type RevokeSessionsResult,
  type SafeAdminSpace,
  type AdminSpacesListResult,
  type AdminTaskItem,
  type AdminTasksListResult,
  type AdminTaskRunsListResult,
  type SafeTaskRunItem,
  type AdminDeliveryItem,
  type AdminDeliveriesListResult,
  type SafeTurnRunItem,
  type AdminQuotaItem,
  type AdminQuotasListResult,
  type AdminAuditItem,
  type AdminAuditListResult,
  type AdminImportReceiptItem,
  type AdminImportsListResult,
  type AdminSecurityData,
  type UserOverviewData,
  type CreateUserBody,
  type CreateUserResult,
  type ResetPasswordResult,
  type ChangePasswordResult,
  type ModelConfigSafeProjection,
  type PatchModelConfigBody,
} from './types.js';

import {
  TenantProvisioningService,
  type TenantQuotaDefaultsConfig,
} from './tenant-provisioning-service.js';

import { ModelSelectionService } from '../models/model-selection-service.js';

export interface ConsoleDataSourceOptions {
  database: DatabaseSync;
  storage: PlatformStorage;
  quotaDefaults?: TenantQuotaDefaultsConfig;
  provisioningService?: TenantProvisioningService;
  modelSelectionService?: ModelSelectionService;
}

const SENSITIVE_KEY_PATTERN = /(?:password|token|secret|cookie|auth|credential|jwt|signature|private[-_]?key|idempotency[-_]?key|canonical[-_]?hash|fingerprint)/i;

const VALID_USER_ROLES = new Set<UserRole>(['admin', 'user']);
const VALID_USER_STATUSES = new Set<UserStatus>(['active', 'disabled']);
const VALID_LOCALES = new Set<UserLocale>(['en', 'zh-CN']);
const VALID_THEMES = new Set<UserTheme>(['dark', 'light', 'eye-care']);
const VALID_TASK_PRIORITIES = new Set<string>(['low', 'medium', 'high', 'urgent']);
const VALID_TASK_STATUSES = new Set<string>(['pending', 'claimed', 'running', 'completed', 'failed', 'cancelled']);
const VALID_DELIVERY_STATUSES = new Set<string>(['held', 'processing', 'delivered', 'duplicate', 'cancelled', 'failed']);
const VALID_TURN_STATUSES = new Set<string>(['queued', 'running', 'completed', 'failed', 'interrupted']);

/**
 * Strict converter requiring a valid ISO date string or SQLite UTC timestamp.
 * Throws PlatformError (500) with a fixed message if the value is missing, invalid, or cannot be parsed.
 */
function parseSqliteUtcIso(val: unknown, _fieldName?: string): string {
  if (typeof val !== 'string' || !val.trim()) {
    throw new PlatformError(
      'Database storage corruption: expected valid timestamp format',
      'INTERNAL_ERROR',
      500
    );
  }
  const trimmed = val.trim();
  let d: Date;
  if (trimmed.includes('T') || trimmed.endsWith('Z')) {
    d = new Date(trimmed);
  } else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(trimmed)) {
    d = new Date(trimmed.replace(' ', 'T') + 'Z');
  } else {
    d = new Date(trimmed);
  }

  if (Number.isNaN(d.getTime())) {
    throw new PlatformError(
      'Database storage corruption: invalid timestamp format',
      'INTERNAL_ERROR',
      500
    );
  }
  return d.toISOString();
}

/**
 * Strict converter requiring a valid ISO date string, SQLite UTC timestamp, or null/undefined.
 */
function parseSqliteNullableUtcIso(val: unknown, fieldName?: string): string | null {
  if (val === null || val === undefined) return null;
  return parseSqliteUtcIso(val, fieldName);
}

/**
 * Strict converter requiring a safe integer. Throws PlatformError (500) if invalid.
 */
function requireSafeInteger(val: unknown, _fieldName?: string): number {
  let num = val;
  if (typeof num === 'bigint') {
    num = Number(num);
  }
  if (typeof num !== 'number' || !Number.isSafeInteger(num)) {
    throw new PlatformError(
      'Database storage corruption: expected safe integer',
      'INTERNAL_ERROR',
      500
    );
  }
  return num as number;
}

/**
 * Strict converter requiring a non-negative safe integer (>= 0). Throws PlatformError (500) if invalid.
 */
function requireNonNegativeInteger(val: unknown, _fieldName?: string): number {
  const n = requireSafeInteger(val);
  if (n < 0) {
    throw new PlatformError(
      'Database storage corruption: expected non-negative integer',
      'INTERNAL_ERROR',
      500
    );
  }
  return n;
}

function requireQuotaLimitInteger(val: unknown, _fieldName?: string): number {
  const n = requireSafeInteger(val);
  if (n < 0 && n !== -1) {
    throw new PlatformError(
      'Database storage corruption: expected non-negative integer or -1 for quota limit',
      'INTERNAL_ERROR',
      500
    );
  }
  return n;
}

/**
 * Strict converter requiring a non-empty string. Throws PlatformError (500) if invalid.
 */
function requireNonEmptyString(val: unknown, _fieldName?: string): string {
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new PlatformError(
      'Database storage corruption: expected non-empty string',
      'INTERNAL_ERROR',
      500
    );
  }
  return val;
}

/**
 * Strict converter requiring a string or null. Throws PlatformError (500) if invalid.
 */
function requireNullableString(val: unknown, _fieldName?: string): string | null {
  if (val === null || val === undefined) return null;
  if (typeof val !== 'string') {
    throw new PlatformError(
      'Database storage corruption: expected string or null',
      'INTERNAL_ERROR',
      500
    );
  }
  return val;
}

/**
 * Strict converter requiring a known enum value. Throws PlatformError (500) if invalid.
 */
function requireEnum<T extends string>(val: unknown, allowed: Set<T> | readonly T[], _fieldName?: string): T {
  if (typeof val !== 'string' || (allowed instanceof Set ? !allowed.has(val as T) : !allowed.includes(val as T))) {
    throw new PlatformError(
      'Database storage corruption: invalid enum value',
      'INTERNAL_ERROR',
      500
    );
  }
  return val as T;
}

/**
 * Strict converter validating audit details metadata JSON.
 * - null or empty string => returns false (no metadata).
 * - non-empty string => JSON.parse must succeed and resolve to a non-null plain object (not array, not primitive scalar).
 * - malformed JSON or scalar/array => throws fixed PlatformError (500) storage corruption error.
 */
function parseAuditMetadataAvailable(details: unknown): boolean {
  if (details === null || details === undefined) {
    return false;
  }
  if (typeof details !== 'string') {
    throw new PlatformError(
      'Database storage corruption: malformed audit details metadata',
      'INTERNAL_ERROR',
      500
    );
  }
  const trimmed = details.trim();
  if (trimmed.length === 0) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new PlatformError(
      'Database storage corruption: malformed audit details metadata',
      'INTERNAL_ERROR',
      500
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PlatformError(
      'Database storage corruption: malformed audit details metadata',
      'INTERNAL_ERROR',
      500
    );
  }
  return true;
}

/**
 * Strict pagination limit option validator.
 */
function parsePaginationLimitOption(val: unknown, defaultVal = 20): number {
  if (val === undefined || val === null) return defaultVal;
  if (typeof val === 'number' && Number.isSafeInteger(val) && val >= 1 && val <= 100) {
    return val;
  }
  throw new PlatformError(
    'Invalid pagination limit option: expected integer between 1 and 100',
    'INTERNAL_ERROR',
    500
  );
}

/**
 * Strict pagination offset option validator.
 */
function parsePaginationOffsetOption(val: unknown, defaultVal = 0): number {
  if (val === undefined || val === null) return defaultVal;
  if (typeof val === 'number' && Number.isSafeInteger(val) && val >= 0) {
    return val;
  }
  throw new PlatformError(
    'Invalid pagination offset option: expected non-negative integer',
    'INTERNAL_ERROR',
    500
  );
}

/**
 * Checks whether a string contains sensitive patterns like absolute host paths (/Users/, /home/, /private/),
 * stack traces, secrets/tokens/credentials, or private keys.
 */
function isSensitiveString(val: string): boolean {
  if (
    val.includes('/Users/') ||
    val.includes('/home/') ||
    val.includes('/private/') ||
    val.includes('\\Users\\') ||
    val.includes('private_key') ||
    val.includes('PRIVATE KEY') ||
    val.includes('BEGIN RSA') ||
    val.includes('Bearer ') ||
    /at\s+[\w\d_$.<>]+\s+\(.*:\d+:\d+\)/.test(val) || // Stack trace pattern
    /(?:password|token|secret|credential|signature)=/i.test(val)
  ) {
    return true;
  }
  return false;
}

/**
 * Recursively redacts sensitive keys and values from any object/array before returning over management APIs.
 * Guarantees strings containing /Users/, /home/, /private/, stack traces, secrets/tokens/credentials do not escape.
 */
export function redactSensitiveObject<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    if (isSensitiveString(obj)) {
      return '[REDACTED]' as unknown as T;
    }
    return obj;
  }
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveObject(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'string' && isSensitiveString(value)) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      result[key] = redactSensitiveObject(value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

export const ALLOWED_TASK_ERROR_CODES = new Set<string>([
  'TASK_ABORTED',
  'TASK_CANCELLED',
  'TASK_PAYLOAD_INVALID',
  'TASK_RESULT_INVALID',
  'TASK_EXECUTION_FAILED',
  'TASK_LEASE_EXPIRED',
  'TASK_SETTLEMENT_FAILED',
  'TASK_RECOVERY_FAILED',
  'TASK_TENANT_ENUMERATION_FAILED',
  'TASK_TENANT_ACCESS_FAILED',
  'TASK_CLAIM_FAILED',
  'TASK_CALLBACK_FAILED',
  'TASK_UNKNOWN_ERROR',
  'TASK_INTERNAL_ERROR',
  'TASK_CONFLICT',
  'TASK_NOT_FOUND',
  'TASK_FAILED',
  'LEASE_LOST',
  'QUOTA_EXCEEDED',
  'DISPATCH_FAILED',
  'PROTOCOL_VIOLATION',
  'TENANT_ACCESS_FAILED',
  'TENANT_ENUMERATION_FAILED',
  'RECOVERY_FAILED',
  'CLAIM_FAILED',
  'CALLBACK_FAILED',
  'UNKNOWN_ERROR',
]);

/**
 * Extracts a safe, generic error code or status from a raw error string without leaking
 * arbitrary tokens, message details, filesystem paths, or stack traces.
 * Only exact allowlisted codes are returned; unknown codes return null.
 * Unbracketed raw errors return null (no fabricated codes or raw error leakage).
 */
export function extractSafeErrorCode(rawError: string | null | undefined): string | null {
  if (!rawError || typeof rawError !== 'string' || rawError.trim().length === 0) {
    return null;
  }
  const trimmed = rawError.trim();
  const codeMatch = trimmed.match(/^\[([A-Z0-9_]+)\]/);
  if (codeMatch && codeMatch[1]) {
    const extracted = codeMatch[1];
    if (ALLOWED_TASK_ERROR_CODES.has(extracted)) {
      return extracted;
    }
    return null;
  }
  if (ALLOWED_TASK_ERROR_CODES.has(trimmed)) {
    return trimmed;
  }
  return null;
}

/**
 * Safe serializer for authenticated user payloads (/auth/login, /auth/me, /manage/overview).
 * Retains opaque user id, username, role, status, displayName, and createdAt.
 * Excludes sensitive credentials (passwordHash), session entities, and prevents fabricated displayNames.
 */
export function safeSerializeAuthUser(user: unknown): SafeAuthUser {
  if (!user || typeof user !== 'object') {
    throw new PlatformError('Invalid user object for serialization', 'INTERNAL_ERROR', 500);
  }
  const u = user as Record<string, unknown>;
  const id = requireNonEmptyString(u.id, 'user.id');
  const username = requireNonEmptyString(u.username, 'user.username');
  const role = requireEnum(u.role, VALID_USER_ROLES, 'user.role');
  const status = requireEnum(u.status, VALID_USER_STATUSES, 'user.status');
  const createdAt = parseSqliteUtcIso(u.createdAt ?? u.created_at, 'user.createdAt');

  let displayName: string | null = null;
  const rawDisplayName = u.displayName !== undefined ? u.displayName : u.display_name;
  if (rawDisplayName !== undefined && rawDisplayName !== null) {
    if (typeof rawDisplayName === 'string' && rawDisplayName.trim().length > 0) {
      displayName = rawDisplayName.trim();
    }
  }

  return {
    id,
    username,
    displayName,
    role,
    status,
    createdAt,
  };
}

export class ConsoleDataSource {
  private readonly db: DatabaseSync;
  private readonly storage: PlatformStorage;
  private readonly provisioningService: TenantProvisioningService;
  readonly modelSelectionService: ModelSelectionService;
  private patchModelConfigLock: Promise<void> = Promise.resolve();

  constructor(options: ConsoleDataSourceOptions) {
    if (!options || !options.database) {
      throw new ValidationError('ConsoleDataSource requires a valid database instance');
    }
    this.db = options.database;
    this.storage = options.storage;
    this.modelSelectionService = options.modelSelectionService || new ModelSelectionService({ db: this.db });
    if (options.provisioningService) {
      this.provisioningService = options.provisioningService;
    } else if (options.quotaDefaults) {
      this.provisioningService = new TenantProvisioningService({
        database: this.db,
        quotaDefaults: options.quotaDefaults,
      });
    } else {
      throw new ValidationError('ConsoleDataSource requires explicit validated quotaDefaults or provisioningService');
    }
  }

  /**
   * Aggregates platform-wide dashboard counts across all domains safely.
   * SQLite aggregate SELECTs always return rows, but errors propagate strictly.
   */
  async getDashboardCounts(): Promise<AdminDashboardCounts> {
    // 1. Users count breakdown
    const userRow = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) as active,
        COALESCE(SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END), 0) as disabled,
        COALESCE(SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END), 0) as admin,
        COALESCE(SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END), 0) as [user]
      FROM users
    `).get() as Record<string, unknown> | undefined;

    if (!userRow) {
      throw new PlatformError('Database query failed for users count', 'INTERNAL_ERROR', 500);
    }

    // 2. Spaces & Sessions & Messages
    const spaceRow = this.db.prepare('SELECT COUNT(*) as total FROM spaces').get() as { total: unknown } | undefined;
    if (!spaceRow) {
      throw new PlatformError('Database query failed for spaces count', 'INTERNAL_ERROR', 500);
    }

    const sessionRow = this.db.prepare('SELECT COUNT(*) as total FROM session_routes').get() as { total: unknown } | undefined;
    if (!sessionRow) {
      throw new PlatformError('Database query failed for sessions count', 'INTERNAL_ERROR', 500);
    }

    const msgRow = this.db.prepare('SELECT COUNT(*) as total FROM web_messages').get() as { total: unknown } | undefined;
    if (!msgRow) {
      throw new PlatformError('Database query failed for web_messages count', 'INTERNAL_ERROR', 500);
    }

    // 3. Tasks breakdown
    const taskRow = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
        COALESCE(SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END), 0) as claimed,
        COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) as running,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
        COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) as cancelled
      FROM platform_tasks
    `).get() as Record<string, unknown> | undefined;

    if (!taskRow) {
      throw new PlatformError('Database query failed for tasks count', 'INTERNAL_ERROR', 500);
    }

    // 4. Deliveries breakdown
    const delivRow = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'held' THEN 1 ELSE 0 END), 0) as held,
        COALESCE(SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END), 0) as processing,
        COALESCE(SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END), 0) as delivered,
        COALESCE(SUM(CASE WHEN status = 'duplicate' THEN 1 ELSE 0 END), 0) as duplicate,
        COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) as cancelled,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed
      FROM delivery_inbox
    `).get() as Record<string, unknown> | undefined;

    if (!delivRow) {
      throw new PlatformError('Database query failed for delivery_inbox count', 'INTERNAL_ERROR', 500);
    }

    // 5. Imports summary
    const importRow = this.db.prepare(`
      SELECT
        COUNT(*) as total_receipts,
        COALESCE(SUM(imported_messages_count), 0) as total_imported_messages
      FROM fixed_import_receipts
    `).get() as { total_receipts: unknown; total_imported_messages: unknown } | undefined;

    if (!importRow) {
      throw new PlatformError('Database query failed for fixed_import_receipts count', 'INTERNAL_ERROR', 500);
    }

    // 6. Recent login failures (past 24h, SQLite UTC time semantics)
    const loginFailRow = this.db.prepare(`
      SELECT COUNT(*) as recent_failures
      FROM auth_audit_log
      WHERE action IN ('login_failure', 'login_failed')
        AND datetime(created_at) >= datetime('now', '-24 hours')
    `).get() as { recent_failures: unknown } | undefined;

    if (!loginFailRow) {
      throw new PlatformError('Database query failed for auth_audit_log failure count', 'INTERNAL_ERROR', 500);
    }

    // 7. Schema current version from migration table mandatory after startup (no catch=>0, no COALESCE 0)
    const schemaRow = this.db.prepare(`
      SELECT MAX(version) as current_version
      FROM _schema_migrations
    `).get() as { current_version: unknown } | undefined;

    if (!schemaRow || schemaRow.current_version === null || schemaRow.current_version === undefined) {
      throw new PlatformError('Database schema migrations table is empty or uninitialized', 'INTERNAL_ERROR', 500);
    }
    const currentSchemaVersion = requireNonNegativeInteger(schemaRow.current_version, 'currentSchemaVersion');

    const claimedTasks = requireNonNegativeInteger(taskRow.claimed, 'tasks.claimed');
    const runningTasks = requireNonNegativeInteger(taskRow.running, 'tasks.running');
    const processingTasks = requireNonNegativeInteger(claimedTasks + runningTasks, 'tasks.processing');

    return {
      users: {
        total: requireNonNegativeInteger(userRow.total, 'users.total'),
        active: requireNonNegativeInteger(userRow.active, 'users.active'),
        disabled: requireNonNegativeInteger(userRow.disabled, 'users.disabled'),
        admin: requireNonNegativeInteger(userRow.admin, 'users.admin'),
        user: requireNonNegativeInteger(userRow.user, 'users.user'),
      },
      spaces: {
        total: requireNonNegativeInteger(spaceRow.total, 'spaces.total'),
      },
      sessions: {
        total: requireNonNegativeInteger(sessionRow.total, 'sessions.total'),
      },
      messages: {
        total: requireNonNegativeInteger(msgRow.total, 'messages.total'),
      },
      tasks: {
        total: requireNonNegativeInteger(taskRow.total, 'tasks.total'),
        pending: requireNonNegativeInteger(taskRow.pending, 'tasks.pending'),
        claimed: claimedTasks,
        running: runningTasks,
        processing: processingTasks,
        completed: requireNonNegativeInteger(taskRow.completed, 'tasks.completed'),
        failed: requireNonNegativeInteger(taskRow.failed, 'tasks.failed'),
        cancelled: requireNonNegativeInteger(taskRow.cancelled, 'tasks.cancelled'),
      },
      deliveries: {
        total: requireNonNegativeInteger(delivRow.total, 'deliveries.total'),
        held: requireNonNegativeInteger(delivRow.held, 'deliveries.held'),
        processing: requireNonNegativeInteger(delivRow.processing, 'deliveries.processing'),
        delivered: requireNonNegativeInteger(delivRow.delivered, 'deliveries.delivered'),
        duplicate: requireNonNegativeInteger(delivRow.duplicate, 'deliveries.duplicate'),
        cancelled: requireNonNegativeInteger(delivRow.cancelled, 'deliveries.cancelled'),
        failed: requireNonNegativeInteger(delivRow.failed, 'deliveries.failed'),
      },
      imports: {
        totalReceipts: requireNonNegativeInteger(importRow.total_receipts, 'imports.totalReceipts'),
        totalImportedMessages: requireNonNegativeInteger(importRow.total_imported_messages, 'imports.totalImportedMessages'),
      },
      auth: {
        recentLoginFailures24h: requireNonNegativeInteger(loginFailRow.recent_failures, 'auth.recentLoginFailures24h'),
      },
      schema: {
        currentVersion: currentSchemaVersion,
      },
    };
  }

  /**
   * Builds the real KPI contract metrics with exact factual counts.
   */
  async getDashboardKpis(containerKpi?: AdminDashboardContainerKpi): Promise<AdminDashboardKpis> {
    const counts = await this.getDashboardCounts();
    const processingTasks = requireNonNegativeInteger(
      counts.tasks.claimed + counts.tasks.running,
      'processingTasks'
    );
    const recentLoginFailures24h = requireNonNegativeInteger(
      counts.auth.recentLoginFailures24h,
      'recentLoginFailures24h'
    );
    const currentSchemaVersion = requireNonNegativeInteger(
      counts.schema.currentVersion,
      'currentSchemaVersion'
    );

    return {
      users: {
        total: counts.users.total,
        active: counts.users.active,
        disabled: counts.users.disabled,
        admin: counts.users.admin,
        user: counts.users.user,
      },
      spaces: counts.spaces.total,
      sessions: counts.sessions.total,
      containers: containerKpi ?? {
        available: false,
        active: null,
        healthy: null,
        total: null,
        status: 'unavailable',
      },
      heldDeliveries: counts.deliveries.held,
      processingTasks,
      runningTasks: counts.tasks.running,
      recentLoginFailures24h,
      currentSchemaVersion,
    };
  }

  private hasColumn(table: string, column: string): boolean {
    try {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return cols.some((c) => c.name === column);
    } catch {
      return false;
    }
  }

  /**
   * Lists users for admin console with pagination, search, and aggregate session/space counts.
   * Strips password_hash completely.
   */
  async listUsers(options: {
    role?: string;
    status?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<AdminUsersListResult> {
    const limit = parsePaginationLimitOption(options.limit);
    const offset = parsePaginationOffsetOption(options.offset);

    const whereClauses: string[] = [];
    const params: (string | number)[] = [];

    if (options.role) {
      whereClauses.push('u.role = ?');
      params.push(options.role);
    }
    if (options.status) {
      whereClauses.push('u.status = ?');
      params.push(options.status);
    }
    if (options.search && options.search.trim().length > 0) {
      whereClauses.push('(u.username LIKE ? OR u.display_name LIKE ?)');
      const s = `%${options.search.trim()}%`;
      params.push(s, s);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countRow = this.db.prepare(`SELECT COUNT(*) as total FROM users u ${whereSql}`).get(...params) as { total: unknown } | undefined;
    if (!countRow) {
      throw new PlatformError('Database query failed for users list count', 'INTERNAL_ERROR', 500);
    }
    const total = requireNonNegativeInteger(countRow.total, 'users.listTotal');

    const hasTheme = this.hasColumn('users', 'theme');
    const themeCol = hasTheme ? 'u.theme' : "'dark' AS theme";

    const listSql = `
      SELECT
        u.id,
        u.username,
        u.role,
        u.status,
        u.display_name,
        u.locale,
        ${themeCol},
        u.must_change_password,
        u.created_at,
        u.updated_at,
        (SELECT COUNT(*) FROM user_sessions s WHERE s.user_id = u.id) AS session_count,
        (SELECT COUNT(*) FROM user_sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND datetime(s.expires_at)>CURRENT_TIMESTAMP) AS active_session_count,
        (SELECT COUNT(*) FROM spaces sp WHERE sp.user_id = u.id) AS space_count
      FROM users u
      ${whereSql}
      ORDER BY u.created_at ASC
      LIMIT ? OFFSET ?
    `;

    const rows = this.db.prepare(listSql).all(...params, limit, offset) as unknown as Array<{
      id: unknown;
      username: unknown;
      role: unknown;
      status: unknown;
      display_name: unknown;
      locale: unknown;
      theme: unknown;
      must_change_password: unknown;
      created_at: unknown;
      updated_at: unknown;
      session_count: unknown;
      active_session_count: unknown;
      space_count: unknown;
    }>;

    const items: SafeAdminUser[] = rows.map((r) => ({
      id: requireNonEmptyString(r.id, 'userId'),
      username: requireNonEmptyString(r.username, 'username'),
      role: requireEnum(r.role, VALID_USER_ROLES, 'role'),
      status: requireEnum(r.status, VALID_USER_STATUSES, 'status'),
      displayName: requireNullableString(r.display_name, 'displayName'),
      locale: requireEnum(r.locale, VALID_LOCALES, 'locale'),
      theme: requireEnum(r.theme ?? 'dark', VALID_THEMES, 'theme'),
      mustChangePassword: Boolean(r.must_change_password === 1 || r.must_change_password === '1' || r.must_change_password === 1n),
      createdAt: parseSqliteUtcIso(r.created_at, 'createdAt'),
      updatedAt: parseSqliteUtcIso(r.updated_at, 'updatedAt'),
      sessionCount: requireNonNegativeInteger(r.session_count, 'sessionCount'),
      activeSessionCount: requireNonNegativeInteger(r.active_session_count, 'activeSessionCount'),
      spaceCount: requireNonNegativeInteger(r.space_count, 'spaceCount'),
    }));

    return {
      items,
      total,
      limit,
      offset,
    };
  }

  /**
   * Updates user role, status, or displayName with strict last-active-admin protection
   * and automatic session revocation on disabling.
   *
   * Transaction guarantees:
   * - Response DTO is built and validated strictly BEFORE COMMIT.
   * - If validation fails, transaction rolls back immediately.
   * - Rollback failure in catch blocks throws AggregateError with a fixed message and no raw IDs.
   * - No validation occurs after COMMIT.
   */
  async patchUser(targetUserId: string, input: PatchUserBody, _currentUserId?: string): Promise<SafeAdminUser> {
    this.db.exec('BEGIN IMMEDIATE');
    let rolledBack = false;

    const hasTheme = this.hasColumn('users', 'theme');
    const themeSelect = hasTheme ? ', theme' : ", 'dark' as theme";
    const themeCol = hasTheme ? 'u.theme' : "'dark' AS theme";

    try {
      const row = this.db.prepare(`
        SELECT id, username, role, status, display_name, locale ${themeSelect}, created_at, updated_at
        FROM users
        WHERE id = ?
      `).get(targetUserId) as {
        id: unknown;
        username: unknown;
        role: unknown;
        status: unknown;
        display_name: unknown;
        locale: unknown;
        theme: unknown;
        created_at: unknown;
        updated_at: unknown;
      } | undefined;

      if (!row) {
        throw new NotFoundError('User not found');
      }

      const existingRole = requireEnum(row.role, VALID_USER_ROLES, 'role');
      const existingStatus = requireEnum(row.status, VALID_USER_STATUSES, 'status');
      const existingDisplayName = requireNullableString(row.display_name, 'displayName');
      const existingLocale = requireEnum(row.locale, VALID_LOCALES, 'locale');
      const existingTheme = requireEnum(row.theme ?? 'dark', VALID_THEMES, 'theme');

      const newRole = input.role !== undefined ? input.role : existingRole;
      const newStatus = input.status !== undefined ? input.status : existingStatus;
      const safeDisplayName: string | null = (input.displayName !== undefined ? input.displayName : existingDisplayName) ?? null;
      const newLocale = input.locale !== undefined ? input.locale : existingLocale;
      const newTheme = input.theme !== undefined ? input.theme : existingTheme;

      if (!VALID_LOCALES.has(newLocale)) {
        throw new ValidationError("Invalid locale value: must be 'en' or 'zh-CN'");
      }
      if (!VALID_THEMES.has(newTheme)) {
        throw new ValidationError("Invalid theme value: must be 'dark', 'light', or 'eye-care'");
      }

      // Last Active Admin Protection
      if (existingRole === 'admin' && existingStatus === 'active') {
        const isDemotingOrDisabling = (newRole !== 'admin' || newStatus !== 'active');
        if (isDemotingOrDisabling) {
          const otherAdminsRow = this.db.prepare(`
            SELECT COUNT(*) as count
            FROM users
            WHERE role = 'admin' AND status = 'active' AND id != ?
          `).get(targetUserId) as { count: unknown } | undefined;

          if (!otherAdminsRow) {
            throw new PlatformError('Database query failed for active admin verification', 'INTERNAL_ERROR', 500);
          }

          const otherActiveAdminCount = requireNonNegativeInteger(otherAdminsRow.count, 'activeAdminsCount');
          if (otherActiveAdminCount === 0) {
            throw new ForbiddenError('Cannot demote or disable the last active administrator');
          }
        }
      }

      // Execute update
      if (hasTheme) {
        this.db.prepare(`
          UPDATE users
          SET role = ?, status = ?, display_name = ?, locale = ?, theme = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(newRole, newStatus, safeDisplayName, newLocale, newTheme, targetUserId);
      } else {
        this.db.prepare(`
          UPDATE users
          SET role = ?, status = ?, display_name = ?, locale = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(newRole, newStatus, safeDisplayName, newLocale, targetUserId);
      }

      // If user account is disabled, immediately revoke all active sessions for that user
      if (newStatus === 'disabled') {
        this.db.prepare(`
          UPDATE user_sessions
          SET revoked_at = CURRENT_TIMESTAMP
          WHERE user_id = ? AND revoked_at IS NULL
        `).run(targetUserId);
      }

      // Exact postselect by ID with aggregate counts
      const updatedRow = this.db.prepare(`
        SELECT
          u.id,
          u.username,
          u.role,
          u.status,
          u.display_name,
          u.locale,
          ${themeCol},
          u.must_change_password,
          u.created_at,
          u.updated_at,
          (SELECT COUNT(*) FROM user_sessions s WHERE s.user_id = u.id) AS session_count,
          (SELECT COUNT(*) FROM user_sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND datetime(s.expires_at)>CURRENT_TIMESTAMP) AS active_session_count,
          (SELECT COUNT(*) FROM spaces sp WHERE sp.user_id = u.id) AS space_count
        FROM users u
        WHERE u.id = ?
      `).get(targetUserId) as {
        id: unknown;
        username: unknown;
        role: unknown;
        status: unknown;
        display_name: unknown;
        locale: unknown;
        theme: unknown;
        must_change_password: unknown;
        created_at: unknown;
        updated_at: unknown;
        session_count: unknown;
        active_session_count: unknown;
        space_count: unknown;
      } | undefined;

      if (!updatedRow) {
        throw new NotFoundError('User not found after update');
      }

      // Build & validate safe response BEFORE COMMIT
      const result: SafeAdminUser = {
        id: requireNonEmptyString(updatedRow.id, 'userId'),
        username: requireNonEmptyString(updatedRow.username, 'username'),
        role: requireEnum(updatedRow.role, VALID_USER_ROLES, 'role'),
        status: requireEnum(updatedRow.status, VALID_USER_STATUSES, 'status'),
        displayName: requireNullableString(updatedRow.display_name, 'displayName'),
        locale: requireEnum(updatedRow.locale, VALID_LOCALES, 'locale'),
        theme: requireEnum(updatedRow.theme ?? 'dark', VALID_THEMES, 'theme'),
        mustChangePassword: Boolean(updatedRow.must_change_password === 1 || updatedRow.must_change_password === '1' || updatedRow.must_change_password === 1n),
        createdAt: parseSqliteUtcIso(updatedRow.created_at, 'createdAt'),
        updatedAt: parseSqliteUtcIso(updatedRow.updated_at, 'updatedAt'),
        sessionCount: requireNonNegativeInteger(updatedRow.session_count, 'sessionCount'),
        activeSessionCount: requireNonNegativeInteger(updatedRow.active_session_count, 'activeSessionCount'),
        spaceCount: requireNonNegativeInteger(updatedRow.space_count, 'spaceCount'),
      };

      // Commit only after safe response is completely built and validated
      this.db.exec('COMMIT');

      return result;
    } catch (err) {
      if (!rolledBack) {
        rolledBack = true;
        try {
          this.db.exec('ROLLBACK');
        } catch (rollbackErr) {
          throw new AggregateError([err, rollbackErr], 'Database transaction rollback failed');
        }
      }
      throw err;
    }
  }

  /**
   * Revokes all active sessions for target user.
   * If target user is the current caller, flags forceLogout: true.
   */
  async revokeUserSessions(targetUserId: string, currentUserId: string): Promise<RevokeSessionsResult> {
    const existing = await this.storage.users.findById(targetUserId);
    if (!existing) {
      throw new NotFoundError('User not found');
    }

    const result = this.db.prepare(`
      UPDATE user_sessions
      SET revoked_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND revoked_at IS NULL
    `).run(targetUserId);

    const revokedCount = requireNonNegativeInteger(result.changes, 'revokedChanges');
    const forceLogout = targetUserId === currentUserId;

    // Record audit log for session revocation
    this.db.prepare(`
      INSERT INTO auth_audit_log (id, user_id, username, action, details, created_at)
      VALUES (?, ?, ?, 'session_revoked', ?, CURRENT_TIMESTAMP)
    `).run(
      randomUUID(),
      targetUserId,
      existing.username,
      JSON.stringify({ revokedCount, actorUserId: currentUserId, forceLogout })
    );

    return {
      revokedCount,
      targetUserId,
      forceLogout,
    };
  }

  /**
   * Creates a new user with secure password hashing and one-time temporary password return.
   * Delegates to TenantProvisioningService for atomic creation of User + 5 quota_limits + default space.
   * Never leaks or stores plaintext passwords or hashes in the audit log.
   */
  async createUser(input: CreateUserBody, actorUserId?: string): Promise<CreateUserResult> {
    return this.provisioningService.provisionTenant(input, actorUserId);
  }

  /**
   * Resets a user's password to a newly generated secure temporary password.
   * Immediately revokes all active sessions for that user and records an audit log.
   * One-time temporary password is returned in the response.
   */
  async resetUserPassword(
    targetUserId: string,
    actorUserId?: string,
    customTempPassword?: string
  ): Promise<ResetPasswordResult> {
    const existing = await this.storage.users.findById(targetUserId);
    if (!existing) {
      throw new NotFoundError('User not found');
    }

    let tempPassword = customTempPassword ? customTempPassword.trim() : '';
    if (!tempPassword) {
      tempPassword = randomBytes(12).toString('base64url');
    }

    if (tempPassword.length < 8 || tempPassword.length > 256) {
      throw new ValidationError('Temporary password must be between 8 and 256 characters');
    }

    const passwordHash = await hashPassword(tempPassword);

    this.db.exec('BEGIN IMMEDIATE');
    let rolledBack = false;

    try {
      // Update user password hash
      this.db.prepare(`
        UPDATE users
        SET password_hash = ?, must_change_password = 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(passwordHash, targetUserId);

      // Revoke all active sessions immediately
      this.db.prepare(`
        UPDATE user_sessions
        SET revoked_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND revoked_at IS NULL
      `).run(targetUserId);

      // Audit log entry
      this.db.prepare(`
        INSERT INTO auth_audit_log (id, user_id, username, action, details, created_at)
        VALUES (?, ?, ?, 'password_reset', ?, CURRENT_TIMESTAMP)
      `).run(
        randomUUID(),
        targetUserId,
        existing.username,
        JSON.stringify({ actorUserId: actorUserId || null, reason: 'admin_reset' })
      );

      this.db.exec('COMMIT');

      return {
        targetUserId,
        username: existing.username,
        tempPassword,
        message: 'Password reset successfully. All active sessions have been revoked.',
      };
    } catch (err) {
      if (!rolledBack) {
        rolledBack = true;
        try {
          this.db.exec('ROLLBACK');
        } catch (rollbackErr) {
          throw new AggregateError([err, rollbackErr], 'Database transaction rollback failed during resetUserPassword');
        }
      }
      throw err;
    }
  }

  /**
   * Allows an authenticated user to change their own password by verifying their old password.
   * SQLite transaction + audit log ('password_changed').
   */
  async changeUserPassword(
    userId: string,
    oldPassword: unknown,
    newPassword: unknown
  ): Promise<ChangePasswordResult> {
    if (typeof oldPassword !== 'string' || !oldPassword) {
      throw new ValidationError('Current password is required');
    }
    if (typeof newPassword !== 'string' || !newPassword) {
      throw new ValidationError('New password is required');
    }
    if (newPassword.length < 8 || newPassword.length > 256) {
      throw new ValidationError('New password must be between 8 and 256 characters');
    }

    const user = await this.storage.users.findById(userId);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    const isValid = await verifyPassword(oldPassword, user.passwordHash);
    if (!isValid) {
      throw new ValidationError('Current password does not match');
    }

    const newHash = await hashPassword(newPassword);

    this.db.exec('BEGIN IMMEDIATE');
    let rolledBack = false;

    try {
      this.db.prepare(`
        UPDATE users
        SET password_hash = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(newHash, userId);

      this.db.prepare(`
        INSERT INTO auth_audit_log (id, user_id, username, action, details, created_at)
        VALUES (?, ?, ?, 'password_changed', ?, CURRENT_TIMESTAMP)
      `).run(
        randomUUID(),
        userId,
        user.username,
        JSON.stringify({ actorUserId: userId })
      );

      this.db.exec('COMMIT');

      return {
        success: true,
        message: 'Password updated successfully.',
      };
    } catch (err) {
      if (!rolledBack) {
        rolledBack = true;
        try {
          this.db.exec('ROLLBACK');
        } catch (rollbackErr) {
          throw new AggregateError([err, rollbackErr], 'Database transaction rollback failed during changeUserPassword');
        }
      }
      throw err;
    }
  }

  /**
   * Retrieves user preferences (e.g. locale, theme).
   * Fail-closed on damaged or corrupted database values.
   */
  async getUserPreferences(userId: string): Promise<{ locale: UserLocale; theme: UserTheme }> {
    const row = this.db.prepare('SELECT id, locale, theme FROM users WHERE id = ?').get(userId) as {
      id: unknown;
      locale: unknown;
      theme: unknown;
    } | undefined;

    if (!row) {
      throw new NotFoundError('User not found');
    }

    const rawLocale = row.locale ?? 'en';
    if (rawLocale !== 'en' && rawLocale !== 'zh-CN') {
      throw new PlatformError(`Corrupted user locale in database: '${String(rawLocale)}'`, 'DATABASE_CORRUPTED', 500);
    }

    const rawTheme = row.theme ?? 'dark';
    if (rawTheme !== 'dark' && rawTheme !== 'light' && rawTheme !== 'eye-care') {
      throw new PlatformError(`Corrupted user theme in database: '${String(rawTheme)}'`, 'DATABASE_CORRUPTED', 500);
    }

    return {
      locale: rawLocale as UserLocale,
      theme: rawTheme as UserTheme,
    };
  }

  /**
   * Retrieves user theme preference directly.
   */
  async getUserTheme(userId: string): Promise<{ theme: UserTheme }> {
    const prefs = await this.getUserPreferences(userId);
    return { theme: prefs.theme };
  }

  /**
   * Transactionally updates user preferences with audit logging and idempotency support.
   * Supports partial updates: { locale?, theme? } or legacy string locale parameter.
   */
  async updateUserPreferences(
    userId: string,
    preferencesOrLocale: { locale?: UserLocale; theme?: UserTheme } | UserLocale,
    context?: {
      ipAddress?: string | null;
      userAgent?: string | null;
      idempotencyKey?: string;
    }
  ): Promise<{ locale: UserLocale; theme: UserTheme }> {
    const prefsInput =
      typeof preferencesOrLocale === 'string'
        ? { locale: preferencesOrLocale as UserLocale }
        : preferencesOrLocale;

    if (!prefsInput || (prefsInput.locale === undefined && prefsInput.theme === undefined)) {
      throw new ValidationError('At least one preference field (locale or theme) must be provided');
    }

    if (prefsInput.locale !== undefined && prefsInput.locale !== 'en' && prefsInput.locale !== 'zh-CN') {
      throw new ValidationError("Invalid locale value: must be 'en' or 'zh-CN'");
    }

    if (prefsInput.theme !== undefined && prefsInput.theme !== 'dark' && prefsInput.theme !== 'light' && prefsInput.theme !== 'eye-care') {
      throw new ValidationError("Invalid theme value: must be 'dark', 'light', or 'eye-care'");
    }

    const idempotencyKey = context?.idempotencyKey;
    const scope = 'account.preferences';
    const requestHash = createHash('sha256').update(JSON.stringify(prefsInput)).digest('hex');

    // 1. Check idempotency record if idempotencyKey provided
    if (idempotencyKey) {
      const existingIdem = this.db.prepare(`
        SELECT request_hash, response_payload
        FROM operation_idempotency
        WHERE user_id = ? AND scope = ? AND idempotency_key = ?
        LIMIT 1
      `).get(userId, scope, idempotencyKey) as { request_hash: string; response_payload: string } | undefined;

      if (existingIdem) {
        if (existingIdem.request_hash === requestHash) {
          try {
            const parsed = JSON.parse(existingIdem.response_payload);
            if (parsed && typeof parsed === 'object') {
              return {
                locale: parsed.locale ?? 'en',
                theme: parsed.theme ?? 'dark',
              };
            }
          } catch {
            throw new PlatformError('Corrupted idempotency receipt payload', 'DATABASE_CORRUPTED', 500);
          }
        }
        throw new PlatformError('Idempotency key was already used with different request parameters', 'CONFLICT', 409);
      }
    }

    // 2. Transactional update + audit log + idempotency recording
    this.db.exec('BEGIN IMMEDIATE');
    let rolledBack = false;

    try {
      const userRow = this.db.prepare('SELECT id, username, locale, theme FROM users WHERE id = ?').get(userId) as {
        id: unknown;
        username: unknown;
        locale: unknown;
        theme: unknown;
      } | undefined;

      if (!userRow) {
        throw new NotFoundError('User not found');
      }

      const username = requireNonEmptyString(userRow.username, 'username');
      const oldLocaleRaw = userRow.locale ?? 'en';
      const oldLocale = (oldLocaleRaw === 'en' || oldLocaleRaw === 'zh-CN') ? oldLocaleRaw : 'en';

      const oldThemeRaw = userRow.theme ?? 'dark';
      const oldTheme = (oldThemeRaw === 'dark' || oldThemeRaw === 'light' || oldThemeRaw === 'eye-care') ? oldThemeRaw : 'dark';

      const targetLocale = prefsInput.locale !== undefined ? prefsInput.locale : (oldLocale as UserLocale);
      const targetTheme = prefsInput.theme !== undefined ? prefsInput.theme : (oldTheme as UserTheme);

      const updates: string[] = ['updated_at = CURRENT_TIMESTAMP'];
      const params: (string | number | null)[] = [];

      if (prefsInput.locale !== undefined) {
        updates.push('locale = ?');
        params.push(prefsInput.locale);
      }
      if (prefsInput.theme !== undefined) {
        updates.push('theme = ?');
        params.push(prefsInput.theme);
      }

      params.push(userId);
      this.db.prepare(`
        UPDATE users
        SET ${updates.join(', ')}
        WHERE id = ?
      `).run(...(params as any));

      // Audit logs
      if (prefsInput.locale !== undefined && prefsInput.locale !== oldLocale) {
        const auditDetails = JSON.stringify({
          oldLocale,
          newLocale: prefsInput.locale,
        });

        this.db.prepare(`
          INSERT INTO auth_audit_log (id, user_id, username, action, ip_address, user_agent, details, created_at)
          VALUES (?, ?, ?, 'locale_changed', ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(
          randomUUID(),
          userId,
          username,
          context?.ipAddress ?? null,
          context?.userAgent ?? null,
          auditDetails
        );
      }

      if (prefsInput.theme !== undefined && prefsInput.theme !== oldTheme) {
        const auditDetails = JSON.stringify({
          oldTheme,
          newTheme: prefsInput.theme,
        });

        this.db.prepare(`
          INSERT INTO auth_audit_log (id, user_id, username, action, ip_address, user_agent, details, created_at)
          VALUES (?, ?, ?, 'theme_changed', ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(
          randomUUID(),
          userId,
          username,
          context?.ipAddress ?? null,
          context?.userAgent ?? null,
          auditDetails
        );
      }

      const responseData = {
        locale: targetLocale,
        theme: targetTheme,
      };
      const responsePayload = JSON.stringify(responseData);

      // If idempotencyKey provided, record in operation_idempotency table
      if (idempotencyKey) {
        const receiptId = `idemp_${randomUUID().replace(/-/g, '')}`;
        this.db.prepare(`
          INSERT INTO operation_idempotency (
            id, user_id, scope, idempotency_key, target_id, request_hash, response_payload, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(user_id, scope, idempotency_key) DO NOTHING
        `).run(receiptId, userId, scope, idempotencyKey, userId, requestHash, responsePayload);
      }

      this.db.exec('COMMIT');
      return responseData;
    } catch (err) {
      if (!rolledBack) {
        rolledBack = true;
        try {
          this.db.exec('ROLLBACK');
        } catch (rollbackErr) {
          throw new AggregateError([err, rollbackErr], 'Database transaction rollback failed during updateUserPreferences');
        }
      }
      throw err;
    }
  }

  /**
   * Transactionally updates user theme with audit logging and idempotency support.
   */
  async updateUserTheme(
    userId: string,
    theme: UserTheme,
    context?: {
      ipAddress?: string | null;
      userAgent?: string | null;
      idempotencyKey?: string;
    }
  ): Promise<{ theme: UserTheme }> {
    const res = await this.updateUserPreferences(userId, { theme }, context);
    return { theme: res.theme };
  }

  /**
   * Retrieves safe model configuration projection from DSH config + platform.db overrides.
   * Guarantees zero credential leakage.
   */
  async getModelConfig(customDshHome?: string): Promise<ModelConfigSafeProjection> {
    const rawDsh = loadDshSafeModelConfig(customDshHome);

    const overrideRow = this.db.prepare(`
      SELECT provider, model, reasoning_effort, fallback_chain, updated_by, updated_at
      FROM model_selection_overrides
      WHERE owner_type = 'platform' AND owner_id = 'default'
    `).get() as {
      provider: string | null;
      model: string | null;
      reasoning_effort: string | null;
      fallback_chain?: string | null;
      updated_by: string | null;
      updated_at: string | null;
    } | undefined;

    let effRow = overrideRow;
    if (!effRow) {
      effRow = this.db.prepare(`
        SELECT provider, model, reasoning_effort, updated_by, updated_at
        FROM model_config_overrides
        WHERE id = 'default'
      `).get() as any;
    }

    let summaries: any[] = [];
    if (this.modelSelectionService) {
      try {
        summaries = await this.modelSelectionService.getHealthSummaries();
      } catch {}
    }

    return buildSafeModelProjection(rawDsh, effRow, false, summaries);
  }

  /**
   * Updates default model/provider override in Enkeep's platform.db.
   * Strictly avoids writing to ~/.dsh files.
   * Records audit log ('model_config_updated').
   */
  async patchModelConfig(
    input: PatchModelConfigBody,
    actorUserId?: string,
    customDshHome?: string
  ): Promise<ModelConfigSafeProjection> {
    // Singleflight / mutex serialization for concurrent PATCH calls
    const unlock = this.patchModelConfigLock;
    let nextResolve: () => void;
    this.patchModelConfigLock = new Promise<void>((resolve) => {
      nextResolve = resolve;
    });

    try {
      await unlock;
      return await this.executePatchModelConfig(input, actorUserId, customDshHome);
    } finally {
      nextResolve!();
    }
  }

  private async executePatchModelConfig(
    input: PatchModelConfigBody,
    actorUserId?: string,
    customDshHome?: string
  ): Promise<ModelConfigSafeProjection> {
    const rawDsh = loadDshSafeModelConfig(customDshHome);

    const currentOverrideRow = this.db.prepare(`
      SELECT provider, model, reasoning_effort, fallback_chain, updated_by, updated_at
      FROM model_selection_overrides
      WHERE owner_type = 'platform' AND owner_id = 'default'
    `).get() as {
      provider: string | null;
      model: string | null;
      reasoning_effort: string | null;
      fallback_chain?: string | null;
      updated_by: string | null;
      updated_at: string | null;
    } | undefined;

    let effCurrentRow = currentOverrideRow;
    if (!effCurrentRow) {
      effCurrentRow = this.db.prepare(`
        SELECT provider, model, reasoning_effort, updated_by, updated_at
        FROM model_config_overrides
        WHERE id = 'default'
      `).get() as any;
    }

    const currentProjection = buildSafeModelProjection(rawDsh, effCurrentRow);

    if (input.ifMatch !== undefined && input.ifMatch !== null && input.ifMatch.trim() !== '') {
      const matchCandidate = input.ifMatch.trim().replace(/^"|"$/g, '');
      const currentRevision = currentProjection.revision;
      const currentUpdatedAt = effCurrentRow?.updated_at;

      const matchesRevision = currentRevision && matchCandidate === currentRevision;
      const matchesUpdatedAt = currentUpdatedAt && matchCandidate === currentUpdatedAt;

      if (!matchesRevision && !matchesUpdatedAt) {
        throw new PlatformError(
          'Model configuration revision mismatch (optimistic concurrency conflict).',
          'CONFLICT',
          409
        );
      }
    }

    if (input.clear) {
      this.db.exec('BEGIN IMMEDIATE');
      let rolledBack = false;
      try {
        this.db.prepare(`
          DELETE FROM model_config_overrides WHERE id = 'default'
        `).run();

        this.db.prepare(`
          DELETE FROM model_selection_overrides WHERE owner_type = 'platform' AND owner_id = 'default'
        `).run();

        this.db.prepare(`
          INSERT INTO auth_audit_log (id, user_id, username, action, details, created_at)
          VALUES (?, ?, NULL, 'model_config_updated', ?, CURRENT_TIMESTAMP)
        `).run(
          randomUUID(),
          actorUserId || null,
          JSON.stringify({ action: 'cleared_override', actorUserId: actorUserId || null })
        );

        this.db.exec('COMMIT');
      } catch (err) {
        if (!rolledBack) {
          rolledBack = true;
          try {
            this.db.exec('ROLLBACK');
          } catch (rollbackErr) {
            throw new AggregateError([err, rollbackErr], 'Rollback failed during clear model override');
          }
        }
        throw err;
      }
      return buildSafeModelProjection(rawDsh, null, true);
    }

    const targetProvider = input.provider ? input.provider.trim() : undefined;
    const targetModel = input.model ? input.model.trim() : undefined;
    const targetReasoningEffort = input.reasoningEffort !== undefined ? (input.reasoningEffort ? input.reasoningEffort.trim() : null) : null;

    if (!targetProvider || !targetModel) {
      throw new ValidationError('Both "provider" and "model" must be specified to set a model override');
    }

    // Validate provider and model existence in DSH configuration if providers are configured
    const dshProviders = rawDsh.providers;
    if (Object.keys(dshProviders).length > 0) {
      const p = dshProviders[targetProvider];
      if (!p) {
        throw new ValidationError(`Provider "${targetProvider}" does not exist in DSH configuration`);
      }
      const modelExists = p.models.some((m) => m.id === targetModel);
      if (!modelExists && p.models.length > 0) {
        throw new ValidationError(`Model "${targetModel}" is not registered under provider "${targetProvider}"`);
      }
    }

    const fallbackChain = input.fallbackChain && Array.isArray(input.fallbackChain) ? input.fallbackChain : [];
    const fallbackChainJson = fallbackChain.length > 0 ? JSON.stringify(fallbackChain) : null;

    this.db.exec('BEGIN IMMEDIATE');
    let rolledBack = false;
    try {
      this.db.prepare(`
        INSERT INTO model_config_overrides (id, provider, model, reasoning_effort, updated_by, updated_at)
        VALUES ('default', ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          provider = excluded.provider,
          model = excluded.model,
          reasoning_effort = excluded.reasoning_effort,
          updated_by = excluded.updated_by,
          updated_at = CURRENT_TIMESTAMP
      `).run(targetProvider, targetModel, targetReasoningEffort, actorUserId || null);

      const msoRevision = createHash('sha256').update(JSON.stringify({
        ownerType: 'platform',
        ownerId: 'default',
        provider: targetProvider,
        model: targetModel,
        reasoningEffort: targetReasoningEffort,
        fallbackChain: fallbackChainJson,
      })).digest('hex');

      this.db.prepare(`
        INSERT INTO model_selection_overrides (
          id, user_id, owner_type, owner_id, provider, model, reasoning_effort, fallback_chain, revision, updated_by, created_at, updated_at
        ) VALUES ('mso_platform_default', NULL, 'platform', 'default', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(owner_type, owner_id) DO UPDATE SET
          provider = excluded.provider,
          model = excluded.model,
          reasoning_effort = excluded.reasoning_effort,
          fallback_chain = excluded.fallback_chain,
          revision = excluded.revision,
          updated_by = excluded.updated_by,
          updated_at = CURRENT_TIMESTAMP
      `).run(targetProvider, targetModel, targetReasoningEffort, fallbackChainJson, msoRevision, actorUserId || null);

      this.db.prepare(`
        INSERT INTO auth_audit_log (id, user_id, username, action, details, created_at)
        VALUES (?, ?, NULL, 'model_config_updated', ?, CURRENT_TIMESTAMP)
      `).run(
        randomUUID(),
        actorUserId || null,
        JSON.stringify({
          provider: targetProvider,
          model: targetModel,
          reasoningEffort: targetReasoningEffort,
          fallbackChain,
          actorUserId: actorUserId || null,
        })
      );

      this.db.exec('COMMIT');
    } catch (err) {
      if (!rolledBack) {
        rolledBack = true;
        try {
          this.db.exec('ROLLBACK');
        } catch (rollbackErr) {
          throw new AggregateError([err, rollbackErr], 'Rollback failed during patch model override');
        }
      }
      throw err;
    }

    const overrideRow = this.db.prepare(`
      SELECT provider, model, reasoning_effort, fallback_chain, updated_by, updated_at
      FROM model_selection_overrides
      WHERE owner_type = 'platform' AND owner_id = 'default'
    `).get() as {
      provider: string | null;
      model: string | null;
      reasoning_effort: string | null;
      fallback_chain?: string | null;
      updated_by: string | null;
      updated_at: string | null;
    } | undefined;

    return buildSafeModelProjection(rawDsh, overrideRow, true);
  }

  /**
   * Lists spaces cross-tenant for admin console with owner username and session count.
   * Safe fields only: id, userId, username, name, createdAt, updatedAt, sessionCount.
   * Excludes folderAvailable, folder, and executionMode.
   */
  async listSpaces(options: {
    userId?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<AdminSpacesListResult> {
    const limit = parsePaginationLimitOption(options.limit);
    const offset = parsePaginationOffsetOption(options.offset);

    const whereClauses: string[] = [];
    const params: (string | number)[] = [];

    if (options.userId) {
      whereClauses.push('s.user_id = ?');
      params.push(options.userId);
    }
    if (options.search && options.search.trim().length > 0) {
      whereClauses.push('(s.name LIKE ? OR u.username LIKE ?)');
      const str = `%${options.search.trim()}%`;
      params.push(str, str);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countRow = this.db.prepare(`
      SELECT COUNT(*) as total
      FROM spaces s
      JOIN users u ON s.user_id = u.id
      ${whereSql}
    `).get(...params) as { total: unknown } | undefined;

    if (!countRow) {
      throw new PlatformError('Database query failed for spaces list count', 'INTERNAL_ERROR', 500);
    }
    const total = requireNonNegativeInteger(countRow.total, 'spaces.listTotal');

    const listSql = `
      SELECT
        s.id,
        s.user_id,
        u.username,
        s.name,
        s.created_at,
        s.updated_at,
        (SELECT COUNT(*) FROM session_routes sr WHERE sr.space_id = s.id) AS session_count
      FROM spaces s
      JOIN users u ON s.user_id = u.id
      ${whereSql}
      ORDER BY s.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const rows = this.db.prepare(listSql).all(...params, limit, offset) as unknown as Array<{
      id: unknown;
      user_id: unknown;
      username: unknown;
      name: unknown;
      created_at: unknown;
      updated_at: unknown;
      session_count: unknown;
    }>;

    const items: SafeAdminSpace[] = rows.map((r) => ({
      id: requireNonEmptyString(r.id, 'spaceId'),
      userId: requireNonEmptyString(r.user_id, 'userId'),
      username: requireNonEmptyString(r.username, 'username'),
      name: requireNonEmptyString(r.name, 'name'),
      createdAt: parseSqliteUtcIso(r.created_at, 'createdAt'),
      updatedAt: parseSqliteUtcIso(r.updated_at, 'updatedAt'),
      sessionCount: requireNonNegativeInteger(r.session_count, 'sessionCount'),
    }));

    return {
      items,
      total,
      limit,
      offset,
    };
  }

  /**
   * Lists tasks cross-tenant (admin) or tenant-scoped (manage) safely without exposing binary blobs.
   * Strips raw claimant, lease internals, assignee, idempotency keys, and raw payloads.
   */
  async listTasks(options: {
    userId?: string;
    status?: string;
    priority?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<AdminTasksListResult> {
    const limit = parsePaginationLimitOption(options.limit);
    const offset = parsePaginationOffsetOption(options.offset);

    const whereClauses: string[] = [];
    const params: (string | number)[] = [];

    if (options.userId) {
      whereClauses.push('t.user_id = ?');
      params.push(options.userId);
    }
    if (options.status) {
      whereClauses.push('t.status = ?');
      params.push(options.status);
    }
    if (options.priority) {
      whereClauses.push('t.priority = ?');
      params.push(options.priority);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countRow = this.db.prepare(`
      SELECT COUNT(*) as total
      FROM platform_tasks t
      JOIN users u ON t.user_id = u.id
      ${whereSql}
    `).get(...params) as { total: unknown } | undefined;

    if (!countRow) {
      throw new PlatformError('Database query failed for tasks list count', 'INTERNAL_ERROR', 500);
    }
    const total = requireNonNegativeInteger(countRow.total, 'tasks.listTotal');

    const listSql = `
      SELECT
        t.id,
        t.user_id,
        u.username,
        t.title,
        t.priority,
        t.status,
        t.due_date,
        t.schedule_type,
        t.cron_expression,
        t.interval_seconds,
        t.next_run_at,
        s.enabled as schedule_enabled,
        s.paused_at as schedule_paused_at,
        t.created_at,
        t.updated_at,
        t.completed_at,
        t.error
      FROM platform_tasks t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN task_schedules s ON t.id = s.task_id
      ${whereSql}
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const rows = this.db.prepare(listSql).all(...params, limit, offset) as unknown as Array<{
      id: unknown;
      user_id: unknown;
      username: unknown;
      title: unknown;
      priority: unknown;
      status: unknown;
      due_date: unknown;
      schedule_type: unknown;
      cron_expression: unknown;
      interval_seconds: unknown;
      next_run_at: unknown;
      schedule_enabled: unknown;
      schedule_paused_at: unknown;
      created_at: unknown;
      updated_at: unknown;
      completed_at: unknown;
      error: unknown;
    }>;

    const items: AdminTaskItem[] = rows.map((r) => {
      const hasError = Boolean(r.error && String(r.error).trim().length > 0);
      const isPaused = r.schedule_enabled === 0 || Boolean(r.schedule_paused_at);
      return {
        id: requireNonEmptyString(r.id, 'taskId'),
        userId: requireNonEmptyString(r.user_id, 'userId'),
        username: requireNonEmptyString(r.username, 'username'),
        title: requireNonEmptyString(r.title, 'title'),
        priority: requireEnum(r.priority, VALID_TASK_PRIORITIES, 'priority'),
        status: requireEnum(r.status, VALID_TASK_STATUSES, 'status'),
        dueDate: parseSqliteNullableUtcIso(r.due_date, 'dueDate'),
        scheduleType: typeof r.schedule_type === 'string' ? r.schedule_type : 'once',
        cronExpression: typeof r.cron_expression === 'string' ? r.cron_expression : null,
        intervalSeconds: typeof r.interval_seconds === 'number' ? r.interval_seconds : (r.interval_seconds !== null && r.interval_seconds !== undefined ? Number(r.interval_seconds) : null),
        nextRunAt: parseSqliteNullableUtcIso(r.next_run_at, 'nextRunAt'),
        isPaused,
        pausedAt: parseSqliteNullableUtcIso(r.schedule_paused_at, 'pausedAt'),
        createdAt: parseSqliteUtcIso(r.created_at, 'createdAt'),
        updatedAt: parseSqliteUtcIso(r.updated_at, 'updatedAt'),
        completedAt: parseSqliteNullableUtcIso(r.completed_at, 'completedAt'),
        errorPresent: hasError,
        errorCode: hasError ? extractSafeErrorCode(typeof r.error === 'string' ? r.error : null) : null,
      };
    });

    return {
      items,
      total,
      limit,
      offset,
    };
  }

  /**
   * Lists task execution runs safely with pagination.
   * Safe fields only: no internal payload or raw exceptions.
   */
  async listTaskRuns(options: {
    taskId: string;
    userId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<AdminTaskRunsListResult> {
    const limit = parsePaginationLimitOption(options.limit);
    const offset = parsePaginationOffsetOption(options.offset);

    const whereClauses: string[] = ['r.task_id = ?'];
    const params: (string | number)[] = [options.taskId];

    if (options.userId) {
      whereClauses.push('r.user_id = ?');
      params.push(options.userId);
    }
    if (options.status) {
      whereClauses.push('r.status = ?');
      params.push(options.status);
    }

    const whereSql = `WHERE ${whereClauses.join(' AND ')}`;

    const countRow = this.db.prepare(`
      SELECT COUNT(*) as total
      FROM task_runs r
      ${whereSql}
    `).get(...params) as { total: unknown } | undefined;

    const total = countRow ? requireNonNegativeInteger(countRow.total, 'taskRuns.total') : 0;

    const listSql = `
      SELECT
        r.id,
        r.task_id,
        r.attempt_number,
        r.status,
        r.scheduled_for,
        r.started_at,
        r.completed_at,
        r.turn_id,
        r.delivery_id,
        r.error_code,
        r.error,
        r.prompt_tokens,
        r.completion_tokens,
        r.total_tokens,
        r.created_at
      FROM task_runs r
      ${whereSql}
      ORDER BY r.attempt_number DESC, r.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const rows = this.db.prepare(listSql).all(...params, limit, offset) as unknown as Array<{
      id: unknown;
      task_id: unknown;
      attempt_number: unknown;
      status: unknown;
      scheduled_for: unknown;
      started_at: unknown;
      completed_at: unknown;
      turn_id: unknown;
      delivery_id: unknown;
      error_code: unknown;
      error: unknown;
      prompt_tokens: unknown;
      completion_tokens: unknown;
      total_tokens: unknown;
      created_at: unknown;
    }>;

    const items: SafeTaskRunItem[] = rows.map((r) => {
      let safeErrCode: string | null = null;
      if (typeof r.error_code === 'string' && r.error_code.trim()) {
        safeErrCode = r.error_code.trim();
      } else if (typeof r.error === 'string' && r.error.trim()) {
        safeErrCode = extractSafeErrorCode(r.error);
      }

      return {
        id: requireNonEmptyString(r.id, 'runId'),
        taskId: requireNonEmptyString(r.task_id, 'taskId'),
        attemptNumber: typeof r.attempt_number === 'number' ? r.attempt_number : Number(r.attempt_number || 1),
        status: typeof r.status === 'string' ? r.status : 'pending',
        scheduledFor: parseSqliteNullableUtcIso(r.scheduled_for, 'scheduledFor'),
        startedAt: parseSqliteNullableUtcIso(r.started_at, 'startedAt'),
        completedAt: parseSqliteNullableUtcIso(r.completed_at, 'completedAt'),
        turnId: typeof r.turn_id === 'string' && r.turn_id.trim() ? r.turn_id.trim() : null,
        deliveryId: typeof r.delivery_id === 'string' && r.delivery_id.trim() ? r.delivery_id.trim() : null,
        errorCode: safeErrCode,
        promptTokens: typeof r.prompt_tokens === 'number' ? r.prompt_tokens : 0,
        completionTokens: typeof r.completion_tokens === 'number' ? r.completion_tokens : 0,
        totalTokens: typeof r.total_tokens === 'number' ? r.total_tokens : 0,
        createdAt: parseSqliteUtcIso(r.created_at, 'createdAt'),
      };
    });

    return {
      items,
      total,
      limit,
      offset,
    };
  }

  /**
   * Lists deliveries cross-tenant (admin) or tenant-scoped (manage) safely.
   * Internal delivery/inbox/turn/route IDs and inbound payloads are strictly excluded.
   * Returns safe { status, createdAt, updatedAt } with pagination.
   */
  async listDeliveries(options: {
    userId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<AdminDeliveriesListResult> {
    const limit = parsePaginationLimitOption(options.limit);
    const offset = parsePaginationOffsetOption(options.offset);

    const whereClauses: string[] = [];
    const params: (string | number)[] = [];

    if (options.userId) {
      whereClauses.push('d.user_id = ?');
      params.push(options.userId);
    }
    if (options.status) {
      whereClauses.push('d.status = ?');
      params.push(options.status);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countRow = this.db.prepare(`
      SELECT COUNT(*) as total
      FROM delivery_inbox d
      JOIN users u ON d.user_id = u.id
      ${whereSql}
    `).get(...params) as { total: unknown } | undefined;

    if (!countRow) {
      throw new PlatformError('Database query failed for deliveries list count', 'INTERNAL_ERROR', 500);
    }
    const total = requireNonNegativeInteger(countRow.total, 'deliveries.listTotal');

    const listSql = `
      SELECT
        d.status,
        d.created_at,
        d.updated_at
      FROM delivery_inbox d
      JOIN users u ON d.user_id = u.id
      ${whereSql}
      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const rows = this.db.prepare(listSql).all(...params, limit, offset) as unknown as Array<{
      status: unknown;
      created_at: unknown;
      updated_at: unknown;
    }>;

    const items: AdminDeliveryItem[] = rows.map((r) => ({
      status: requireEnum(r.status, VALID_DELIVERY_STATUSES, 'status'),
      createdAt: parseSqliteUtcIso(r.created_at, 'createdAt'),
      updatedAt: parseSqliteUtcIso(r.updated_at, 'updatedAt'),
    }));

    return {
      items,
      total,
      limit,
      offset,
    };
  }

  /**
   * Aggregates quota limits, usages, and active reservations per user.
   * Raw reservation IDs and bundle IDs are excluded; provides safe resource/status/count/amount aggregates.
   */
  async listQuotas(options: {
    userId?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<AdminQuotasListResult> {
    const limit = parsePaginationLimitOption(options.limit);
    const offset = parsePaginationOffsetOption(options.offset);

    const whereClauses: string[] = [];
    const params: (string | number)[] = [];

    if (options.userId) {
      whereClauses.push('u.id = ?');
      params.push(options.userId);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countRow = this.db.prepare(`SELECT COUNT(*) as total FROM users u ${whereSql}`).get(...params) as { total: unknown } | undefined;
    if (!countRow) {
      throw new PlatformError('Database query failed for quotas user count', 'INTERNAL_ERROR', 500);
    }
    const total = requireNonNegativeInteger(countRow.total, 'quotas.listTotal');

    const users = this.db.prepare(`
      SELECT u.id, u.username
      FROM users u
      ${whereSql}
      ORDER BY u.created_at ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as unknown as Array<{ id: unknown; username: unknown }>;

    const items: AdminQuotaItem[] = [];

    for (const u of users) {
      const uId = requireNonEmptyString(u.id, 'userId');
      const uUsername = requireNonEmptyString(u.username, 'username');

      const limits = this.db.prepare(`
        SELECT resource, limit_amount, window_seconds, reset_at, updated_at
        FROM quota_limits
        WHERE user_id = ?
        ORDER BY resource ASC
      `).all(uId) as unknown as Array<{
        resource: unknown;
        limit_amount: unknown;
        window_seconds: unknown;
        reset_at: unknown;
        updated_at: unknown;
      }>;

      const usages = this.db.prepare(`
        SELECT resource, used_amount, updated_at
        FROM quota_usage
        WHERE user_id = ?
        ORDER BY resource ASC
      `).all(uId) as unknown as Array<{
        resource: unknown;
        used_amount: unknown;
        updated_at: unknown;
      }>;

      const reservations = this.db.prepare(`
        SELECT
          resource,
          status,
          COUNT(*) as count,
          COALESCE(SUM(amount), 0) as amount
        FROM quota_reservations
        WHERE user_id = ? AND status = 'reserved'
        GROUP BY resource, status
        ORDER BY resource ASC
      `).all(uId) as unknown as Array<{
        resource: unknown;
        status: unknown;
        count: unknown;
        amount: unknown;
      }>;

      items.push({
        userId: uId,
        username: uUsername,
        limits: limits.map((l: any) => ({
          resource: requireNonEmptyString(l.resource, 'quotaLimit.resource'),
          limit: requireQuotaLimitInteger(l.limit_amount, 'quotaLimit.limitAmount'),
          windowSeconds: l.window_seconds !== null && l.window_seconds !== undefined
            ? requireNonNegativeInteger(l.window_seconds, 'quotaLimit.windowSeconds')
            : undefined,
          resetAt: l.reset_at ? parseSqliteUtcIso(l.reset_at, 'quotaLimit.resetAt') : null,
          resetInterval: l.reset_interval ?? undefined,
          updatedAt: parseSqliteUtcIso(l.updated_at, 'quotaLimit.updatedAt'),
        })),
        usage: usages.map((us) => ({
          resource: requireNonEmptyString(us.resource, 'quotaUsage.resource'),
          usedAmount: requireNonNegativeInteger(us.used_amount, 'quotaUsage.usedAmount'),
          updatedAt: parseSqliteUtcIso(us.updated_at, 'quotaUsage.updatedAt'),
        })),
        activeReservations: reservations.map((r) => ({
          resource: requireNonEmptyString(r.resource, 'quotaReservation.resource'),
          status: requireNonEmptyString(r.status, 'quotaReservation.status'),
          count: requireNonNegativeInteger(r.count, 'quotaReservation.count'),
          amount: requireNonNegativeInteger(r.amount, 'quotaReservation.amount'),
        })),
      });
    }

    return {
      items,
      total,
      limit,
      offset,
    };
  }

  /**
   * Lists audit logs safely.
   * Metadata is indicated via metadataAvailable boolean validated strictly against plain object JSON.
   * Never exposes raw details. Throws fixed 500 PlatformError on malformed/scalar details.
   */
  async listAuditLogs(options: {
    userId?: string;
    action?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<AdminAuditListResult> {
    const limit = parsePaginationLimitOption(options.limit);
    const offset = parsePaginationOffsetOption(options.offset);

    const whereClauses: string[] = [];
    const params: (string | number)[] = [];

    if (options.userId) {
      whereClauses.push('user_id = ?');
      params.push(options.userId);
    }
    if (options.action) {
      whereClauses.push('action = ?');
      params.push(options.action);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countRow = this.db.prepare(`SELECT COUNT(*) as total FROM auth_audit_log ${whereSql}`).get(...params) as { total: unknown } | undefined;
    if (!countRow) {
      throw new PlatformError('Database query failed for audit logs count', 'INTERNAL_ERROR', 500);
    }
    const total = requireNonNegativeInteger(countRow.total, 'audit.listTotal');

    const listSql = `
      SELECT
        id,
        user_id,
        username,
        action,
        ip_address,
        user_agent,
        details,
        created_at
      FROM auth_audit_log
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;

    const rows = this.db.prepare(listSql).all(...params, limit, offset) as unknown as Array<{
      id: unknown;
      user_id: unknown;
      username: unknown;
      action: unknown;
      ip_address: unknown;
      user_agent: unknown;
      details: unknown;
      created_at: unknown;
    }>;

    const items: AdminAuditItem[] = rows.map((r) => ({
      id: requireNonEmptyString(r.id, 'auditId'),
      userId: requireNullableString(r.user_id, 'userId'),
      username: requireNonEmptyString(r.username, 'username'),
      action: requireNonEmptyString(r.action, 'action'),
      ipAddress: requireNullableString(r.ip_address, 'ipAddress'),
      userAgent: requireNullableString(r.user_agent, 'userAgent'),
      metadataAvailable: parseAuditMetadataAvailable(r.details),
      createdAt: parseSqliteUtcIso(r.created_at, 'createdAt'),
    }));

    return {
      items,
      total,
      limit,
      offset,
    };
  }

  /**
   * Lists fixed import receipt summaries.
   * Prohibits raw hash, source fingerprint, target DSH, and fabricated IDs.
   * Returns exact fixture truths: counts, importer version, status, and timestamp.
   */
  async listImports(options: {
    userId?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<AdminImportsListResult> {
    const limit = parsePaginationLimitOption(options.limit);
    const offset = parsePaginationOffsetOption(options.offset);

    const whereClauses: string[] = [];
    const params: (string | number)[] = [];

    if (options.userId) {
      whereClauses.push('r.user_id = ?');
      params.push(options.userId);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countRow = this.db.prepare(`
      SELECT COUNT(*) as total
      FROM fixed_import_receipts r
      JOIN users u ON r.user_id = u.id
      ${whereSql}
    `).get(...params) as { total: unknown } | undefined;

    if (!countRow) {
      throw new PlatformError('Database query failed for imports count', 'INTERNAL_ERROR', 500);
    }
    const total = requireNonNegativeInteger(countRow.total, 'imports.listTotal');

    const listSql = `
      SELECT
        r.user_id,
        u.username,
        r.importer_version,
        r.session_format,
        r.source_chats_count,
        r.source_messages_count,
        r.imported_messages_count,
        r.dropped_messages_count,
        r.attachments_count,
        r.created_at
      FROM fixed_import_receipts r
      JOIN users u ON r.user_id = u.id
      ${whereSql}
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const rows = this.db.prepare(listSql).all(...params, limit, offset) as unknown as Array<{
      user_id: unknown;
      username: unknown;
      importer_version: unknown;
      session_format: unknown;
      source_chats_count: unknown;
      source_messages_count: unknown;
      imported_messages_count: unknown;
      dropped_messages_count: unknown;
      attachments_count: unknown;
      created_at: unknown;
    }>;

    const items: AdminImportReceiptItem[] = rows.map((r) => ({
      userId: requireNonEmptyString(r.user_id, 'userId'),
      username: requireNonEmptyString(r.username, 'username'),
      importerVersion: requireNonEmptyString(r.importer_version, 'importerVersion'),
      sessionFormat: requireNonNegativeInteger(r.session_format, 'sessionFormat'),
      sourceChatsCount: requireNonNegativeInteger(r.source_chats_count, 'sourceChatsCount'),
      sourceMessagesCount: requireNonNegativeInteger(r.source_messages_count, 'sourceMessagesCount'),
      importedMessagesCount: requireNonNegativeInteger(r.imported_messages_count, 'importedMessagesCount'),
      droppedMessagesCount: requireNonNegativeInteger(r.dropped_messages_count, 'droppedMessagesCount'),
      attachmentsCount: requireNonNegativeInteger(r.attachments_count, 'attachmentsCount'),
      status: 'completed',
      createdAt: parseSqliteUtcIso(r.created_at, 'createdAt'),
    }));

    return {
      items,
      total,
      limit,
      offset,
    };
  }

  /**
   * Retrieves current migration version, checksum status, and security policy constants.
   * Strictly avoids port probing or leaking credentials/secrets.
   */
  async getSecurityData(limits: ServerLimitsOptions = {}): Promise<AdminSecurityData> {
    const appliedRows = this.db.prepare(`
      SELECT version, name, checksum, applied_at
      FROM _schema_migrations
      ORDER BY version ASC
    `).all() as unknown as Array<{
      version: unknown;
      name: unknown;
      checksum: unknown;
      applied_at: unknown;
    }>;

    const rawApplied = appliedRows.map((r) => ({
      version: requireSafeInteger(r.version, 'migration.version'),
      name: requireNonEmptyString(r.name, 'migration.name'),
      checksum: requireNonEmptyString(r.checksum, 'migration.checksum'),
      appliedAt: parseSqliteUtcIso(r.applied_at, 'migration.appliedAt'),
    }));

    const currentVersion = rawApplied.length > 0 ? rawApplied[rawApplied.length - 1].version : 0;
    const expectedVersion = ALL_PLATFORM_MIGRATIONS.length > 0
      ? ALL_PLATFORM_MIGRATIONS[ALL_PLATFORM_MIGRATIONS.length - 1].version
      : 0;

    const appliedMap = new Map(rawApplied.map((a) => [a.version, a.checksum]));
    let checksumsMatch = true;

    for (const def of ALL_PLATFORM_MIGRATIONS) {
      const storedChecksum = appliedMap.get(def.version);
      if (storedChecksum) {
        const expectedChecksum = def.checksum ?? computeChecksum(def.upSql);
        if (storedChecksum !== expectedChecksum) {
          checksumsMatch = false;
          break;
        }
      }
    }

    // Strip internal checksum hashes from public DTO to avoid leaking internal hashes
    const applied = rawApplied.map(({ version, name, appliedAt }) => ({
      version,
      name,
      appliedAt,
    }));

    return {
      migrations: {
        currentVersion,
        expectedVersion,
        checksumsMatch,
        applied,
      },
      securityPolicy: {
        hostBinding: '127.0.0.1 (Loopback Only)',
        allowedHosts: ALLOWED_HOSTS,
        securityHeaders: DEFAULT_SECURITY_HEADERS,
        csrfRequired: true,
        csrfHeader: 'X-Enkeep-CSRF',
        limits: {
          maxBodySizeBytes: limits.maxBodySizeBytes ?? DEFAULT_SERVER_LIMITS.maxBodySizeBytes,
          requestTimeoutMs: limits.requestTimeoutMs ?? DEFAULT_SERVER_LIMITS.requestTimeoutMs,
          maxCookieSizeBytes: limits.maxCookieSizeBytes ?? DEFAULT_SERVER_LIMITS.maxCookieSizeBytes,
          maxFailedLogins: limits.maxFailedLogins ?? DEFAULT_SERVER_LIMITS.maxFailedLogins,
          failedLoginWindowSeconds: limits.failedLoginWindowSeconds ?? DEFAULT_SERVER_LIMITS.failedLoginWindowSeconds,
        },
      },
    };
  }

  /**
   * Retrieves self-service overview for a regular user (counts of spaces, sessions, messages, tasks, deliveries, imports).
   */
  async getUserOverview(userId: string): Promise<UserOverviewData['counts']> {
    const spaceRow = this.db.prepare('SELECT COUNT(*) as cnt FROM spaces WHERE user_id = ?').get(userId) as { cnt: unknown } | undefined;
    const sessRow = this.db.prepare('SELECT COUNT(*) as cnt FROM session_routes WHERE user_id = ?').get(userId) as { cnt: unknown } | undefined;
    const msgRow = this.db.prepare('SELECT COUNT(*) as cnt FROM web_messages WHERE user_id = ?').get(userId) as { cnt: unknown } | undefined;

    const taskRow = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
        COALESCE(SUM(CASE WHEN status = 'running' OR status = 'claimed' THEN 1 ELSE 0 END), 0) as running,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed
      FROM platform_tasks
      WHERE user_id = ?
    `).get(userId) as Record<string, unknown> | undefined;

    const delivRow = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'held' THEN 1 ELSE 0 END), 0) as held,
        COALESCE(SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END), 0) as delivered,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed
      FROM delivery_inbox
      WHERE user_id = ?
    `).get(userId) as Record<string, unknown> | undefined;

    const importRow = this.db.prepare('SELECT COUNT(*) as cnt FROM fixed_import_receipts WHERE user_id = ?').get(userId) as { cnt: unknown } | undefined;

    if (!spaceRow || !sessRow || !msgRow || !taskRow || !delivRow || !importRow) {
      throw new PlatformError('Database query failed for user overview counts', 'INTERNAL_ERROR', 500);
    }

    return {
      spaces: requireNonNegativeInteger(spaceRow.cnt, 'spaces.count'),
      sessions: requireNonNegativeInteger(sessRow.cnt, 'sessions.count'),
      messages: requireNonNegativeInteger(msgRow.cnt, 'messages.count'),
      tasks: {
        total: requireNonNegativeInteger(taskRow.total, 'tasks.total'),
        pending: requireNonNegativeInteger(taskRow.pending, 'tasks.pending'),
        running: requireNonNegativeInteger(taskRow.running, 'tasks.running'),
        completed: requireNonNegativeInteger(taskRow.completed, 'tasks.completed'),
        failed: requireNonNegativeInteger(taskRow.failed, 'tasks.failed'),
      },
      deliveries: {
        total: requireNonNegativeInteger(delivRow.total, 'deliveries.total'),
        held: requireNonNegativeInteger(delivRow.held, 'deliveries.held'),
        delivered: requireNonNegativeInteger(delivRow.delivered, 'deliveries.delivered'),
        failed: requireNonNegativeInteger(delivRow.failed, 'deliveries.failed'),
      },
      imports: requireNonNegativeInteger(importRow.cnt, 'imports.count'),
    };
  }

  /**
   * Retrieves turns for a specific session route strictly scoped to the tenant.
   * Safe fields only: status, startedAt, finishedAt.
   * TurnId, delivery, route, userId, executionMode, spaceId, and internal IDs are completely excluded.
   */
  async listSessionTurns(userId: string, sessionId: string): Promise<SafeTurnRunItem[]> {
    // 1. Verify session route exists and belongs to this user
    const route = await this.storage.forTenant(userId).sessionRoutes.findById(sessionId);
    if (!route) {
      throw new NotFoundError('Session not found');
    }

    const rows = this.db.prepare(`
      SELECT
        status,
        started_at,
        finished_at
      FROM turn_runs
      WHERE user_id = ? AND route_id = ?
      ORDER BY created_at ASC
    `).all(userId, sessionId) as unknown as Array<{
      status: unknown;
      started_at: unknown;
      finished_at: unknown;
    }>;

    return rows.map((r) => ({
      status: requireEnum(r.status, VALID_TURN_STATUSES, 'turnRun.status'),
      startedAt: parseSqliteNullableUtcIso(r.started_at, 'turnRun.startedAt'),
      finishedAt: parseSqliteNullableUtcIso(r.finished_at, 'turnRun.finishedAt'),
    }));
  }
}
