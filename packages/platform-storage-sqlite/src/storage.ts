import { DatabaseSync } from 'node:sqlite';
import type {
  PlatformStorage,
  UserRepository,
  UserSessionRepository,
  AuthAuditLogRepository,
  TenantScopedSpaceRepository,
  TenantScopedSessionRouteRepository,
  TenantScopedSessionSourceRepository,
  TenantScopedDeliveryReceiptRepository,
  TenantScopedDeliveryInboxRepository,
  TenantScopedEventCursorRepository,
  TenantScopedTurnRunRepository,
  TenantScopedAgentProfileRepository,
  TenantScopedSessionGenerationRepository,
  TenantScopedExtensionPackageRepository,
  TenantScopedExtensionBindingRepository,
  TenantScopedSkillPackageRepository,
  TenantScopedSkillBindingRepository,
  TenantScopedSkillOperationRepository,
  TenantScopedSpaceMountRepository,
  DeliveryInboxEntry,
  MigrationRunner,
  MigrationDefinition,
} from '@enkeep/platform-core';
import { SqliteMigrationRunner, BUILTIN_MIGRATIONS } from './schema/migrations.js';
import { SqliteUserRepository } from './repos/user-repo.js';
import { SqliteUserSessionRepository } from './repos/session-repo.js';
import { SqliteAuthAuditLogRepository } from './repos/audit-repo.js';
import { SqliteTenantScopedSpaceRepository } from './repos/space-repo.js';
import { SqliteTenantScopedSessionRouteRepository } from './repos/session-route-repo.js';
import { SqliteTenantScopedSessionSourceRepository } from './repos/session-source-repo.js';
import { SqliteTenantScopedDeliveryReceiptRepository } from './repos/delivery-receipt-repo.js';
import { SqliteTenantScopedDeliveryInboxRepository } from './repos/delivery-inbox-repo.js';
import { SqliteTenantScopedEventCursorRepository } from './repos/event-cursor-repo.js';
import { SqliteTenantScopedTurnRunRepository } from './repos/turn-run-repo.js';
import { SqliteTenantScopedAgentProfileRepository } from './repos/agent-profile-repo.js';
import { SqliteTenantScopedSessionGenerationRepository } from './repos/session-generation-repo.js';
import {
  SqliteTenantScopedSkillPackageRepository,
  SqliteTenantScopedSkillBindingRepository,
  SqliteTenantScopedSkillOperationRepository,
} from './repos/skill-repo.js';
import {
  SqliteTenantScopedExtensionPackageRepository,
  SqliteTenantScopedExtensionBindingRepository,
} from './repos/extension-repo.js';
import { PermissionPresetRepo } from './repos/permission-preset-repo.js';
import { SqliteTenantScopedSpaceMountRepository } from './repos/space-mount-repo.js';
import { SqliteTenantScopedChannelRepository } from './repos/channel-repo.js';
import {
  type DbParam,
  parseDeliveryInboxRow,
  queryAll,
  withImmediateTransactionSync,
} from './utils/db.js';

export interface SqliteStorageOptions {
  dbPath?: string;
  database?: DatabaseSync;
  autoMigrate?: boolean;
  migrations?: MigrationDefinition[];
}

export class SqlitePlatformStorage implements PlatformStorage {
  readonly db: DatabaseSync;
  readonly users: UserRepository;
  readonly sessions: UserSessionRepository;
  readonly auditLogs: AuthAuditLogRepository;
  readonly migrations: MigrationRunner;

  constructor(options: SqliteStorageOptions | DatabaseSync = {}) {
    if (options && typeof (options as DatabaseSync).prepare === 'function') {
      this.db = options as DatabaseSync;
    } else if ((options as SqliteStorageOptions).database) {
      this.db = (options as SqliteStorageOptions).database!;
    } else if ((options as SqliteStorageOptions).dbPath) {
      this.db = new DatabaseSync((options as SqliteStorageOptions).dbPath!);
    } else {
      this.db = new DatabaseSync(':memory:');
    }

    // 1. Enforce strict foreign keys immediately upon acquisition
    this.db.exec('PRAGMA foreign_keys = ON;');

    // 2. Verify foreign_keys is strictly enabled
    const fkRow = this.db.prepare('PRAGMA foreign_keys;').get() as Record<string, unknown> | undefined;
    const fkVal = fkRow ? Number(Object.values(fkRow)[0]) : 0;
    if (fkVal !== 1) {
      throw new Error(`Failed to enable PRAGMA foreign_keys = ON (readback value: ${fkVal})`);
    }

    // 3. Inspect database_list for main database file path
    const dbList = this.db.prepare('PRAGMA database_list;').all() as { seq: number; name: string; file: string }[];
    const mainDb = dbList.find((d) => d.name === 'main');
    const isFileDb = Boolean(mainDb && mainDb.file && mainDb.file.trim() !== '' && mainDb.file !== ':memory:');

    if (isFileDb) {
      this.db.exec('PRAGMA journal_mode = WAL;');
      const jmRow = this.db.prepare('PRAGMA journal_mode;').get() as Record<string, unknown> | undefined;
      const jmVal = jmRow ? String(Object.values(jmRow)[0]).toLowerCase() : '';
      if (jmVal !== 'wal') {
        throw new Error(`Failed to set PRAGMA journal_mode = WAL for file database (readback value: '${jmVal}')`);
      }
    } else {
      this.db.exec('PRAGMA journal_mode = MEMORY;');
      const jmRow = this.db.prepare('PRAGMA journal_mode;').get() as Record<string, unknown> | undefined;
      const jmVal = jmRow ? String(Object.values(jmRow)[0]).toLowerCase() : '';
      if (jmVal !== 'memory' && jmVal !== 'wal') {
        throw new Error(`Failed to configure PRAGMA journal_mode for in-memory database (readback value: '${jmVal}')`);
      }
    }

    this.users = new SqliteUserRepository(this.db);
    this.sessions = new SqliteUserSessionRepository(this.db);
    this.auditLogs = new SqliteAuthAuditLogRepository(this.db);
    this.migrations = new SqliteMigrationRunner(this.db);
  }

  forTenant(userId: string): {
    readonly spaces: TenantScopedSpaceRepository;
    readonly sessionRoutes: TenantScopedSessionRouteRepository;
    readonly sessionSources: TenantScopedSessionSourceRepository;
    readonly deliveryReceipts: TenantScopedDeliveryReceiptRepository;
    readonly deliveryInbox: TenantScopedDeliveryInboxRepository;
    readonly eventCursors: TenantScopedEventCursorRepository;
    readonly turnRuns: TenantScopedTurnRunRepository;
    readonly agentProfiles: TenantScopedAgentProfileRepository;
    readonly sessionGenerations: TenantScopedSessionGenerationRepository;
    readonly skillPackages: TenantScopedSkillPackageRepository;
    readonly skillBindings: TenantScopedSkillBindingRepository;
    readonly skillOperations: TenantScopedSkillOperationRepository;
    readonly extensionPackages: TenantScopedExtensionPackageRepository;
    readonly extensionBindings: TenantScopedExtensionBindingRepository;
    readonly permissionPresets: PermissionPresetRepo;
    readonly spaceMounts: TenantScopedSpaceMountRepository;
    readonly channels: SqliteTenantScopedChannelRepository;
  } {
    if (!userId || typeof userId !== 'string' || userId.trim() === '' || userId !== userId.trim()) {
      throw new Error('Tenant user ID must be a non-empty string without leading or trailing whitespace');
    }

    return {
      spaces: new SqliteTenantScopedSpaceRepository(this.db, userId),
      sessionRoutes: new SqliteTenantScopedSessionRouteRepository(this.db, userId),
      sessionSources: new SqliteTenantScopedSessionSourceRepository(this.db, userId),
      deliveryReceipts: new SqliteTenantScopedDeliveryReceiptRepository(this.db, userId),
      deliveryInbox: new SqliteTenantScopedDeliveryInboxRepository(this.db, userId),
      eventCursors: new SqliteTenantScopedEventCursorRepository(this.db, userId),
      turnRuns: new SqliteTenantScopedTurnRunRepository(this.db, userId),
      agentProfiles: new SqliteTenantScopedAgentProfileRepository(this.db, userId),
      sessionGenerations: new SqliteTenantScopedSessionGenerationRepository(this.db, userId),
      skillPackages: new SqliteTenantScopedSkillPackageRepository(this.db, userId),
      skillBindings: new SqliteTenantScopedSkillBindingRepository(this.db, userId),
      skillOperations: new SqliteTenantScopedSkillOperationRepository(this.db, userId),
      extensionPackages: new SqliteTenantScopedExtensionPackageRepository(this.db, userId),
      extensionBindings: new SqliteTenantScopedExtensionBindingRepository(this.db, userId),
      permissionPresets: new PermissionPresetRepo(this.db, userId),
      spaceMounts: new SqliteTenantScopedSpaceMountRepository(this.db, userId),
      channels: new SqliteTenantScopedChannelRepository(this.db, userId),
    };
  }

  async listAllHeldDeliveries(options?: { limit?: number }): Promise<DeliveryInboxEntry[]> {
    let sql = "SELECT * FROM delivery_inbox WHERE status = 'held' ORDER BY received_at ASC";
    const params: DbParam[] = [];

    if (options?.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    const stmt = this.db.prepare(sql);
    return queryAll(stmt, parseDeliveryInboxRow, ...params);
  }

  async recoverAfterRestart(options?: { interruptedReason?: string }): Promise<{
    interruptedTurnRuns: number;
    heldDeliveries: DeliveryInboxEntry[];
  }> {
    const reason = options?.interruptedReason ?? 'interrupted by system restart';
    const now = new Date().toISOString();

    const interruptedCount = withImmediateTransactionSync(this.db, () => {
      // 1. Redrive in-flight 'processing' deliveries back to 'held' for restart redelivery
      this.db.prepare(`
        UPDATE delivery_inbox
        SET status = 'held',
            error = ?,
            updated_at = ?
        WHERE status = 'processing'
      `).run(reason, now);

      // 2. Mark in-flight 'running' / 'queued' turn runs as 'interrupted'
      const turnRunRes = this.db.prepare(`
        UPDATE turn_runs
        SET status = 'interrupted',
            error = ?,
            finished_at = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE status = 'running' OR status = 'queued'
      `).run(reason, now);

      return Number(turnRunRes.changes);
    });

    const heldDeliveries = await this.listAllHeldDeliveries();

    return {
      interruptedTurnRuns: interruptedCount,
      heldDeliveries,
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export async function createSqliteStorage(options: SqliteStorageOptions = {}): Promise<SqlitePlatformStorage> {
  const storage = new SqlitePlatformStorage(options);
  if (options.autoMigrate !== false) {
    const migrations = options.migrations ?? BUILTIN_MIGRATIONS;
    await storage.migrations.migrate(migrations);
  }
  return storage;
}
