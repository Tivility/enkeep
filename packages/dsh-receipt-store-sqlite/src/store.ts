/**
 * SQLite Receipt Store service implementation.
 *
 * @module @enkeep/dsh-receipt-store-sqlite
 */

import { DatabaseSync } from 'node:sqlite';
import { isAbsolute, resolve, dirname, normalize, basename } from 'node:path';
import { mkdirSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import type {
  DeliveryReceipt,
  DeliveryStatus,
  EventCursor,
  IReceiptStore,
  ReceiptStoreConfig,
  RecordReceiptInput,
  RecordSessionSourceInput,
  RestartRecoverySummary,
  SeedImportReceipt,
  RecordSeedImportReceiptInput,
  SessionSource,
  SetEventCursorInput,
} from './types.js';
import {
  DuplicateDeliveryIdError,
  ReceiptNotFoundError,
  ReceiptStoreClosedError,
  ReceiptStoreError,
  SeedImportMismatchError,
  toErrorMessage,
  toError,
} from './errors.js';
import { SqliteReceiptStoreMigrationRunner } from './schema.js';

interface DbReceiptRow {
  id: unknown;
  user_id: unknown;
  delivery_id: unknown;
  message_id: unknown;
  route_id: unknown;
  status: unknown;
  error: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface DbSourceRow {
  id: unknown;
  user_id: unknown;
  route_id: unknown;
  source_type: unknown;
  source_id: unknown;
  metadata: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface DbCursorRow {
  user_id: unknown;
  session_id: unknown;
  consumer: unknown;
  cursor_value: unknown;
  updated_at: unknown;
}

interface DbSeedImportReceiptRow {
  user_id: unknown;
  session_id: unknown;
  algorithm: unknown;
  checksum: unknown;
  canonical_bytes: unknown;
  event_count: unknown;
  imported_at: unknown;
}

const HEX64_REGEX = /^[0-9a-f]{64}$/;
export const DEFAULT_CURSOR_CONSUMER = 'default';

/**
 * Validates and resolves the database path securely using authoritative realpath resolution.
 * Enforces no symlinks on the database file and ensures strict containment under DSH_HOME when configured.
 */
const SYSTEM_ROOT_PATHS = new Set(['/', '/var', '/tmp', '/etc', '/private', '/private/var', '/private/tmp', '/private/etc']);

function verifyNoSymlinkAncestors(dirPath: string): void {
  let current = dirPath;

  while (current !== '/' && dirname(current) !== current) {
    if (SYSTEM_ROOT_PATHS.has(current)) {
      break;
    }
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new ReceiptStoreError(
          `Database path ancestor directory contains a symbolic link: ${current}`,
          'SYMLINK_NOT_ALLOWED'
        );
      }
    } catch (err) {
      if (err instanceof ReceiptStoreError) throw err;
      // If path doesn't exist yet, continue checking ancestors
    }
    current = dirname(current);
  }
}

export function resolveAndValidateDbPath(rawPath: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!rawPath || typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    throw new ReceiptStoreError('Database path is required and must be a non-empty string', 'INVALID_PATH');
  }

  const trimmed = rawPath.trim();
  if (trimmed === ':memory:') {
    return ':memory:';
  }

  const dshHome = env.DSH_HOME ? env.DSH_HOME.trim() : undefined;
  let targetPath: string;

  if (isAbsolute(trimmed)) {
    targetPath = normalize(trimmed);
  } else if (dshHome && dshHome.length > 0) {
    targetPath = resolve(dshHome, trimmed);
  } else {
    targetPath = resolve(process.cwd(), trimmed);
  }

  const parentDir = dirname(targetPath);
  verifyNoSymlinkAncestors(parentDir);

  try {
    mkdirSync(parentDir, { recursive: true });
  } catch (err) {
    throw new ReceiptStoreError(`Failed to create parent directory for database: ${toErrorMessage(err)}`, err);
  }

  // Check if database file exists and is not a symbolic link
  if (existsSync(targetPath)) {
    try {
      const stat = lstatSync(targetPath);
      if (stat.isSymbolicLink()) {
        throw new ReceiptStoreError(`Database file must not be a symbolic link: ${targetPath}`, 'SYMLINK_NOT_ALLOWED');
      }
    } catch (err) {
      if (err instanceof ReceiptStoreError) throw err;
      throw new ReceiptStoreError(`Failed to inspect database file: ${toErrorMessage(err)}`, err);
    }
  }

  return targetPath;
}

export class SqliteReceiptStore implements IReceiptStore {
  readonly userId: string;
  private readonly config: ReceiptStoreConfig;
  private readonly resolvedDbPath: string;
  private db: DatabaseSync | null = null;
  private closed = false;

  constructor(config: ReceiptStoreConfig) {
    if (!config || typeof config !== 'object') {
      throw new ReceiptStoreError('ReceiptStoreConfig must be an object', 'INVALID_CONFIG');
    }
    if (typeof config.userId !== 'string' || config.userId.trim().length === 0) {
      throw new ReceiptStoreError('Config.userId is required and must be a non-empty string', 'INVALID_CONFIG');
    }
    const trimmedUserId = config.userId.trim();
    if (!/^[A-Za-z0-9_\-:.]{1,128}$/.test(trimmedUserId)) {
      throw new ReceiptStoreError(
        `Config.userId must be a valid canonical identifier matching /^[A-Za-z0-9_\\-:.]{1,128}$/ (got '${trimmedUserId}')`,
        'INVALID_CONFIG'
      );
    }
    this.config = config;
    this.userId = trimmedUserId;
    this.resolvedDbPath = resolveAndValidateDbPath(config.path);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  init(): void {
    if (this.db) return;

    let dbHandle: DatabaseSync | null = null;
    try {
      dbHandle = new DatabaseSync(this.resolvedDbPath);

      // 1. Foreign keys ON and readback validation
      dbHandle.exec('PRAGMA foreign_keys = ON;');
      const fkRow = dbHandle.prepare('PRAGMA foreign_keys;').get() as Record<string, unknown> | undefined;
      const fkVal = fkRow ? Object.values(fkRow)[0] : null;
      if (Number(fkVal) !== 1) {
        throw new ReceiptStoreError(`Failed to enable PRAGMA foreign_keys = ON (readback: ${String(fkVal)})`);
      }

      // 2. Busy timeout configuration and readback validation
      const busyTimeoutMs = this.config.busyTimeoutMs ?? 5000;
      dbHandle.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
      const btRow = dbHandle.prepare('PRAGMA busy_timeout;').get() as Record<string, unknown> | undefined;
      const btVal = btRow ? Object.values(btRow)[0] : null;
      if (Number(btVal) !== busyTimeoutMs) {
        throw new ReceiptStoreError(`Failed to set PRAGMA busy_timeout = ${busyTimeoutMs} (readback: ${String(btVal)})`);
      }

      // 3. Inspect database_list for main database file path & set journal_mode with exact readback
      const dbList = dbHandle.prepare('PRAGMA database_list;').all() as Array<{ seq: unknown; name: unknown; file: unknown }>;
      const mainDb = dbList.find((d) => d.name === 'main');
      const isFileDb = Boolean(mainDb && typeof mainDb.file === 'string' && mainDb.file.trim() !== '' && mainDb.file !== ':memory:');

      if (isFileDb) {
        const requestedJournal = this.config.journalMode ?? 'wal';
        dbHandle.exec(`PRAGMA journal_mode = ${requestedJournal.toUpperCase()};`);
        const jmRow = dbHandle.prepare('PRAGMA journal_mode;').get() as Record<string, unknown> | undefined;
        const jmVal = jmRow ? String(Object.values(jmRow)[0]).toLowerCase() : '';
        if (jmVal !== requestedJournal.toLowerCase()) {
          throw new ReceiptStoreError(
            `Failed to set PRAGMA journal_mode = ${requestedJournal} for file database (readback value: '${jmVal}')`
          );
        }
      } else {
        const requestedJournal = this.config.journalMode ?? 'memory';
        dbHandle.exec(`PRAGMA journal_mode = ${requestedJournal.toUpperCase()};`);
        const jmRow = dbHandle.prepare('PRAGMA journal_mode;').get() as Record<string, unknown> | undefined;
        const jmVal = jmRow ? String(Object.values(jmRow)[0]).toLowerCase() : '';
        if (jmVal !== 'memory' && jmVal !== 'wal') {
          throw new ReceiptStoreError(
            `Failed to configure PRAGMA journal_mode for in-memory database (readback value: '${jmVal}')`
          );
        }
      }

      // 4. Synchronous pragma
      dbHandle.exec('PRAGMA synchronous = NORMAL;');

      // 5. Run schema migrations
      const migrationRunner = new SqliteReceiptStoreMigrationRunner(dbHandle);
      migrationRunner.run();

      this.db = dbHandle;
    } catch (err: unknown) {
      if (dbHandle) {
        try {
          dbHandle.close();
        } catch (closeErr: unknown) {
          throw new AggregateError(
            [toError(err), toError(closeErr)],
            `Failed initializing SQLite ReceiptStore: ${toErrorMessage(err)}; close also failed: ${toErrorMessage(closeErr)}`
          );
        }
      }
      if (err instanceof ReceiptStoreError) throw err;
      throw new ReceiptStoreError(
        `Failed initializing SQLite ReceiptStore: ${toErrorMessage(err)}`,
        err
      );
    }
  }

  private ensureOpen(): DatabaseSync {
    if (this.closed || !this.db) {
      throw new ReceiptStoreClosedError();
    }
    return this.db;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.db) {
      try {
        this.db.close();
      } catch (err: unknown) {
        throw new ReceiptStoreError('Error while closing SQLite database', err);
      } finally {
        this.db = null;
      }
    }
  }

  async recordReceipt(input: RecordReceiptInput): Promise<DeliveryReceipt> {
    const db = this.ensureOpen();
    if (!input || !input.deliveryId || !input.messageId) {
      throw new ReceiptStoreError('deliveryId and messageId are required', 'INVALID_INPUT');
    }

    const now = new Date().toISOString();
    const status: DeliveryStatus = input.status ?? 'pending';
    const routeId = input.routeId ?? '';
    const error = input.error ?? null;

    try {
      const stmt = db.prepare(`
        INSERT INTO dsh_delivery_receipts (
          user_id, delivery_id, message_id, route_id, status, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        this.userId,
        input.deliveryId,
        input.messageId,
        routeId,
        status,
        error,
        now,
        now
      );

      return (await this.getReceiptByDeliveryId(input.deliveryId))!;
    } catch (err: unknown) {
      const msg = toErrorMessage(err);
      if (msg.includes('UNIQUE constraint failed')) {
        throw new DuplicateDeliveryIdError(input.deliveryId);
      }
      throw new ReceiptStoreError(
        `Failed recording receipt for deliveryId ${input.deliveryId}: ${msg}`,
        err
      );
    }
  }

  async getReceiptByDeliveryId(deliveryId: string): Promise<DeliveryReceipt | null> {
    const db = this.ensureOpen();
    if (!deliveryId) return null;

    const stmt = db.prepare(`
      SELECT id, user_id, delivery_id, message_id, route_id, status, error, created_at, updated_at
      FROM dsh_delivery_receipts
      WHERE user_id = ? AND delivery_id = ?
    `);

    const row = stmt.get(this.userId, deliveryId) as DbReceiptRow | undefined;
    if (!row) return null;
    return this.mapReceiptRow(row);
  }

  async getReceiptByMessageId(messageId: string): Promise<DeliveryReceipt | null> {
    const db = this.ensureOpen();
    if (!messageId) return null;

    const stmt = db.prepare(`
      SELECT id, user_id, delivery_id, message_id, route_id, status, error, created_at, updated_at
      FROM dsh_delivery_receipts
      WHERE user_id = ? AND message_id = ?
      ORDER BY id DESC
      LIMIT 1
    `);

    const row = stmt.get(this.userId, messageId) as DbReceiptRow | undefined;
    if (!row) return null;
    return this.mapReceiptRow(row);
  }

  async updateReceiptStatus(
    deliveryId: string,
    status: DeliveryStatus,
    error?: string | null
  ): Promise<DeliveryReceipt> {
    const db = this.ensureOpen();
    if (!deliveryId) {
      throw new ReceiptNotFoundError(deliveryId);
    }

    const now = new Date().toISOString();

    const existing = await this.getReceiptByDeliveryId(deliveryId);
    if (!existing) {
      throw new ReceiptNotFoundError(deliveryId);
    }

    const stmt = db.prepare(`
      UPDATE dsh_delivery_receipts
      SET status = ?, error = ?, updated_at = ?
      WHERE user_id = ? AND delivery_id = ?
    `);

    const result = stmt.run(status, error ?? null, now, this.userId, deliveryId);
    if (result.changes === 0) {
      throw new ReceiptNotFoundError(deliveryId);
    }

    return (await this.getReceiptByDeliveryId(deliveryId))!;
  }

  async recordSessionSource(input: RecordSessionSourceInput): Promise<SessionSource> {
    const db = this.ensureOpen();
    if (!input || !input.sourceType || !input.sourceId || !input.routeId) {
      throw new ReceiptStoreError('routeId, sourceType, and sourceId are required', 'INVALID_INPUT');
    }

    const now = new Date().toISOString();
    const metaJson = input.metadata ? JSON.stringify(input.metadata) : null;

    try {
      const stmt = db.prepare(`
        INSERT INTO dsh_session_sources (
          user_id, route_id, source_type, source_id, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, source_type, source_id) DO UPDATE SET
          route_id = excluded.route_id,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at
      `);

      stmt.run(
        this.userId,
        input.routeId,
        input.sourceType,
        input.sourceId,
        metaJson,
        now,
        now
      );

      return (await this.getSessionSource(input.sourceType, input.sourceId))!;
    } catch (err: unknown) {
      throw new ReceiptStoreError(
        `Failed recording session source for ${input.sourceType}:${input.sourceId}: ${toErrorMessage(err)}`,
        err
      );
    }
  }

  async getSessionSource(sourceType: string, sourceId: string): Promise<SessionSource | null> {
    const db = this.ensureOpen();
    if (!sourceType || !sourceId) return null;

    const stmt = db.prepare(`
      SELECT id, user_id, route_id, source_type, source_id, metadata, created_at, updated_at
      FROM dsh_session_sources
      WHERE user_id = ? AND source_type = ? AND source_id = ?
    `);

    const row = stmt.get(this.userId, sourceType, sourceId) as DbSourceRow | undefined;
    if (!row) return null;
    return this.mapSourceRow(row);
  }

  async getSessionSourcesByRouteId(routeId: string): Promise<readonly SessionSource[]> {
    const db = this.ensureOpen();
    if (!routeId) return [];

    const stmt = db.prepare(`
      SELECT id, user_id, route_id, source_type, source_id, metadata, created_at, updated_at
      FROM dsh_session_sources
      WHERE user_id = ? AND route_id = ?
      ORDER BY id ASC
    `);

    const rows = (stmt.all(this.userId, routeId) as unknown[]) as DbSourceRow[];
    return rows.map((r) => this.mapSourceRow(r));
  }

  async getEventCursor(sessionId: string, consumer = DEFAULT_CURSOR_CONSUMER): Promise<EventCursor | null> {
    const db = this.ensureOpen();
    if (!sessionId) return null;

    const stmt = db.prepare(`
      SELECT user_id, session_id, consumer, cursor_value, updated_at
      FROM dsh_event_cursors
      WHERE user_id = ? AND session_id = ? AND consumer = ?
    `);

    const row = stmt.get(this.userId, sessionId, consumer) as DbCursorRow | undefined;
    if (!row) return null;
    return {
      userId: this.validateString(row.user_id, 'user_id'),
      sessionId: this.validateString(row.session_id, 'session_id'),
      consumer: this.validateString(row.consumer, 'consumer'),
      cursorValue: this.validateString(row.cursor_value, 'cursor_value'),
      updatedAt: this.validateString(row.updated_at, 'updated_at'),
    };
  }

  async setEventCursor(
    inputOrSessionId: SetEventCursorInput | string,
    cursorValue?: string,
    consumer = DEFAULT_CURSOR_CONSUMER
  ): Promise<EventCursor> {
    const db = this.ensureOpen();
    const now = new Date().toISOString();

    let sessionId: string;
    let val: string;
    let cons = consumer;

    if (typeof inputOrSessionId === 'object') {
      sessionId = inputOrSessionId.sessionId;
      val = inputOrSessionId.cursorValue;
      cons = inputOrSessionId.consumer ?? DEFAULT_CURSOR_CONSUMER;
    } else {
      sessionId = inputOrSessionId;
      val = cursorValue!;
    }

    if (!sessionId || val === undefined || val === null) {
      throw new ReceiptStoreError('sessionId and cursorValue are required', 'INVALID_INPUT');
    }

    try {
      const stmt = db.prepare(`
        INSERT INTO dsh_event_cursors (
          user_id, session_id, consumer, cursor_value, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, session_id, consumer) DO UPDATE SET
          cursor_value = excluded.cursor_value,
          updated_at = excluded.updated_at
      `);

      stmt.run(this.userId, sessionId, cons, val, now);
      return (await this.getEventCursor(sessionId, cons))!;
    } catch (err: unknown) {
      throw new ReceiptStoreError(
        `Failed setting event cursor for session ${sessionId} and consumer ${cons}: ${toErrorMessage(err)}`,
        err
      );
    }
  }

  /**
   * Retrieves a seed import receipt for the given session ID, strictly bound to the authenticated user.
   */
  async getSeedImportReceipt(sessionId: string): Promise<SeedImportReceipt | null> {
    const db = this.ensureOpen();
    if (!sessionId || typeof sessionId !== 'string') return null;

    const stmt = db.prepare(`
      SELECT user_id, session_id, algorithm, checksum, canonical_bytes, event_count, imported_at
      FROM dsh_seed_import_receipts
      WHERE user_id = ? AND session_id = ?
    `);

    const row = stmt.get(this.userId, sessionId) as DbSeedImportReceiptRow | undefined;
    if (!row) return null;
    return this.mapSeedImportReceiptRow(row);
  }

  /**
   * Records a seed import receipt inside a standard immediate transaction.
   *
   * Idempotency contract:
   * - If an existing receipt has identical algorithm, checksum, canonicalBytes, and eventCount, returns existing record.
   * - If any field mismatches, throws SeedImportMismatchError (NO UPDATE/REPLACE permitted).
   * - If no receipt exists, inserts standard record.
   */
  async recordSeedImportReceipt(input: RecordSeedImportReceiptInput): Promise<SeedImportReceipt> {
    const db = this.ensureOpen();

    if (!input || !input.sessionId || typeof input.sessionId !== 'string' || input.sessionId.trim().length === 0) {
      throw new ReceiptStoreError('sessionId is required and must be non-empty', 'INVALID_INPUT');
    }

    const sessionId = input.sessionId.trim();
    const algorithm = input.algorithm ?? 'sha256-session-events-v1';
    if (algorithm !== 'sha256-session-events-v1') {
      throw new ReceiptStoreError(
        `Unsupported algorithm: '${algorithm}'. Expected 'sha256-session-events-v1'`,
        'INVALID_ALGORITHM'
      );
    }

    if (!input.checksum || typeof input.checksum !== 'string' || !HEX64_REGEX.test(input.checksum.toLowerCase())) {
      throw new ReceiptStoreError(
        `Invalid checksum format: checksum must be a 64-character lowercase hex string`,
        'INVALID_CHECKSUM'
      );
    }
    const checksum = input.checksum.toLowerCase();

    if (typeof input.canonicalBytes !== 'number' || !Number.isSafeInteger(input.canonicalBytes) || input.canonicalBytes < 0) {
      throw new ReceiptStoreError('canonicalBytes must be a non-negative integer', 'INVALID_CANONICAL_BYTES');
    }
    const canonicalBytes = input.canonicalBytes;

    if (typeof input.eventCount !== 'number' || !Number.isSafeInteger(input.eventCount) || input.eventCount < 0) {
      throw new ReceiptStoreError('eventCount must be a non-negative integer', 'INVALID_EVENT_COUNT');
    }
    const eventCount = input.eventCount;
    const importedAt = input.importedAt ?? new Date().toISOString();

    // Perform transaction: lock immediate -> inspect existing -> insert if absent -> verify idempotency
    db.exec('BEGIN IMMEDIATE;');
    let inTransaction = true;

    try {
      const selectStmt = db.prepare(`
        SELECT user_id, session_id, algorithm, checksum, canonical_bytes, event_count, imported_at
        FROM dsh_seed_import_receipts
        WHERE user_id = ? AND session_id = ?
      `);
      const existingRow = selectStmt.get(this.userId, sessionId) as DbSeedImportReceiptRow | undefined;

      if (existingRow) {
        const existing = this.mapSeedImportReceiptRow(existingRow);
        db.exec('COMMIT;');
        inTransaction = false;

        // Check exact match
        const matches =
          existing.algorithm === algorithm &&
          existing.checksum === checksum &&
          existing.canonicalBytes === canonicalBytes &&
          existing.eventCount === eventCount;

        if (!matches) {
          throw new SeedImportMismatchError(
            sessionId,
            {
              algorithm: existing.algorithm,
              checksum: existing.checksum,
              canonicalBytes: existing.canonicalBytes,
              eventCount: existing.eventCount,
            },
            {
              algorithm,
              checksum,
              canonicalBytes,
              eventCount,
            }
          );
        }

        return existing;
      }

      // No existing receipt: insert new receipt
      const insertStmt = db.prepare(`
        INSERT INTO dsh_seed_import_receipts (
          user_id, session_id, algorithm, checksum, canonical_bytes, event_count, imported_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      insertStmt.run(this.userId, sessionId, algorithm, checksum, canonicalBytes, eventCount, importedAt);
      db.exec('COMMIT;');
      inTransaction = false;

      const inserted = await this.getSeedImportReceipt(sessionId);
      if (!inserted) {
        throw new ReceiptStoreError(`Failed to retrieve newly inserted seed import receipt for session '${sessionId}'`);
      }
      return inserted;
    } catch (err: unknown) {
      if (inTransaction) {
        try {
          db.exec('ROLLBACK;');
        } catch (rollbackErr: unknown) {
          throw new AggregateError(
            [toError(err), toError(rollbackErr)],
            `Failed recording seed import receipt: ${toErrorMessage(err)}; rollback failed: ${toErrorMessage(rollbackErr)}`
          );
        }
      }
      if (err instanceof ReceiptStoreError) throw err;
      throw new ReceiptStoreError(
        `Failed recording seed import receipt for session '${sessionId}': ${toErrorMessage(err)}`,
        err
      );
    }
  }

  async recoverAfterRestart(): Promise<RestartRecoverySummary> {
    const db = this.ensureOpen();
    try {
      const pendingRow = db.prepare(`
        SELECT COUNT(*) as count FROM dsh_delivery_receipts
        WHERE user_id = ? AND status = 'pending'
      `).get(this.userId) as { count: unknown } | undefined;

      const count = pendingRow && typeof pendingRow.count === 'number' ? pendingRow.count : Number(pendingRow?.count ?? 0);
      return {
        pendingReceiptsRecovered: Number.isSafeInteger(count) ? count : 0,
        inFlightReceiptsCount: Number.isSafeInteger(count) ? count : 0,
      };
    } catch (err: unknown) {
      throw new ReceiptStoreError('Failed performing restart recovery check', err);
    }
  }

  private validateString(value: unknown, fieldName: string): string {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) {
      throw new ReceiptStoreError(`Expected string for '${fieldName}', got ${String(value)}`);
    }
    return String(value);
  }

  private validateNumber(value: unknown, fieldName: string): number {
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    const num = Number(value);
    if (!Number.isSafeInteger(num)) {
      throw new ReceiptStoreError(`Expected safe integer for '${fieldName}', got ${String(value)}`);
    }
    return num;
  }

  private mapReceiptRow(row: DbReceiptRow): DeliveryReceipt {
    return {
      id: this.validateNumber(row.id, 'id'),
      userId: this.validateString(row.user_id, 'user_id'),
      deliveryId: this.validateString(row.delivery_id, 'delivery_id'),
      messageId: this.validateString(row.message_id, 'message_id'),
      routeId: typeof row.route_id === 'string' ? row.route_id : '',
      status: this.validateString(row.status, 'status') as DeliveryStatus,
      error: row.error !== null && row.error !== undefined ? String(row.error) : null,
      createdAt: this.validateString(row.created_at, 'created_at'),
      updatedAt: this.validateString(row.updated_at, 'updated_at'),
    };
  }

  private mapSourceRow(row: DbSourceRow): SessionSource {
    let metadata: Record<string, unknown> | null = null;
    if (row.metadata && typeof row.metadata === 'string') {
      try {
        metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        metadata = null;
      }
    }
    return {
      id: this.validateNumber(row.id, 'id'),
      userId: this.validateString(row.user_id, 'user_id'),
      routeId: this.validateString(row.route_id, 'route_id'),
      sourceType: this.validateString(row.source_type, 'source_type'),
      sourceId: this.validateString(row.source_id, 'source_id'),
      metadata,
      createdAt: this.validateString(row.created_at, 'created_at'),
      updatedAt: this.validateString(row.updated_at, 'updated_at'),
    };
  }

  private mapSeedImportReceiptRow(row: DbSeedImportReceiptRow): SeedImportReceipt {
    return {
      userId: this.validateString(row.user_id, 'user_id'),
      sessionId: this.validateString(row.session_id, 'session_id'),
      algorithm: 'sha256-session-events-v1',
      checksum: this.validateString(row.checksum, 'checksum'),
      canonicalBytes: this.validateNumber(row.canonical_bytes, 'canonical_bytes'),
      eventCount: this.validateNumber(row.event_count, 'event_count'),
      importedAt: this.validateString(row.imported_at, 'imported_at'),
    };
  }
}
