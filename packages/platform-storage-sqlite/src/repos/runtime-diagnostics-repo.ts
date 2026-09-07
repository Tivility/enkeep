import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  RuntimeDiagnosticRecord,
  RuntimeDiagnosticsQueryOptions,
  RuntimeDiagnosticsQueryResult,
  DiagnosticEventType,
  DiagnosticLogLevel,
  RuntimeTelemetryStats,
} from '@enkeep/platform-core';

interface DbDiagnosticRow {
  id: unknown;
  user_id: unknown;
  container_id: unknown;
  event_type: unknown;
  level: unknown;
  code: unknown;
  message: unknown;
  details_json: unknown;
  cpu_percent: unknown;
  memory_usage_bytes: unknown;
  memory_limit_bytes: unknown;
  pids_count: unknown;
  volume_bytes: unknown;
  created_at: unknown;
}

function parseDiagnosticRow(row: DbDiagnosticRow): RuntimeDiagnosticRecord {
  let details: Record<string, unknown> | null = null;
  if (row.details_json && typeof row.details_json === 'string') {
    try {
      details = JSON.parse(row.details_json);
    } catch {
      details = null;
    }
  }

  let stats: RuntimeTelemetryStats | null = null;
  if (
    row.cpu_percent !== null ||
    row.memory_usage_bytes !== null ||
    row.memory_limit_bytes !== null ||
    row.pids_count !== null ||
    row.volume_bytes !== null
  ) {
    stats = {
      cpuPercent: row.cpu_percent !== null && row.cpu_percent !== undefined ? Number(row.cpu_percent) : undefined,
      memoryUsageBytes: row.memory_usage_bytes !== null && row.memory_usage_bytes !== undefined ? Number(row.memory_usage_bytes) : undefined,
      memoryLimitBytes: row.memory_limit_bytes !== null && row.memory_limit_bytes !== undefined ? Number(row.memory_limit_bytes) : undefined,
      pidsCount: row.pids_count !== null && row.pids_count !== undefined ? Number(row.pids_count) : undefined,
      volumeBytes: row.volume_bytes !== null && row.volume_bytes !== undefined ? Number(row.volume_bytes) : undefined,
    };
  }

  return {
    id: String(row.id),
    userId: String(row.user_id),
    containerId: row.container_id ? String(row.container_id) : null,
    eventType: String(row.event_type) as DiagnosticEventType,
    level: String(row.level) as DiagnosticLogLevel,
    code: String(row.code),
    message: String(row.message),
    details,
    stats,
    createdAt: String(row.created_at),
  };
}

export interface CreateDiagnosticInput {
  id?: string;
  userId: string;
  containerId?: string | null;
  eventType: DiagnosticEventType;
  level: DiagnosticLogLevel;
  code: string;
  message: string;
  details?: Record<string, unknown> | null;
  stats?: RuntimeTelemetryStats | null;
  createdAt?: string;
}

export class SqliteRuntimeDiagnosticsRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async create(input: CreateDiagnosticInput): Promise<RuntimeDiagnosticRecord> {
    const id = input.id || `diag_${randomUUID().replace(/-/g, '')}`;
    const createdAt = input.createdAt || new Date().toISOString();
    const detailsJson = input.details ? JSON.stringify(input.details) : null;
    const cpuPercent = input.stats?.cpuPercent ?? null;
    const memoryUsageBytes = input.stats?.memoryUsageBytes ?? null;
    const memoryLimitBytes = input.stats?.memoryLimitBytes ?? null;
    const pidsCount = input.stats?.pidsCount ?? null;
    const volumeBytes = input.stats?.volumeBytes ?? null;

    this.db.prepare(`
      INSERT INTO runtime_diagnostics (
        id, user_id, container_id, event_type, level, code, message, details_json,
        cpu_percent, memory_usage_bytes, memory_limit_bytes, pids_count, volume_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.userId,
      input.containerId ?? null,
      input.eventType,
      input.level,
      input.code,
      input.message,
      detailsJson,
      cpuPercent,
      memoryUsageBytes,
      memoryLimitBytes,
      pidsCount,
      volumeBytes,
      createdAt
    );

    return {
      id,
      userId: input.userId,
      containerId: input.containerId ?? null,
      eventType: input.eventType,
      level: input.level,
      code: input.code,
      message: input.message,
      details: input.details ?? null,
      stats: input.stats ?? null,
      createdAt,
    };
  }

  async query(options: RuntimeDiagnosticsQueryOptions): Promise<RuntimeDiagnosticsQueryResult> {
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const whereClauses: string[] = ['user_id = ?'];
    const params: (string | number)[] = [options.userId];

    if (options.level) {
      whereClauses.push('level = ?');
      params.push(options.level);
    }

    if (options.before) {
      whereClauses.push('created_at < ?');
      params.push(options.before);
    }

    const whereSql = `WHERE ${whereClauses.join(' AND ')}`;

    const countRow = this.db.prepare(`SELECT COUNT(*) as total FROM runtime_diagnostics ${whereSql}`).get(...params) as { total: unknown } | undefined;
    const total = Number(countRow?.total ?? 0);

    const rows = this.db.prepare(`
      SELECT * FROM runtime_diagnostics
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params, limit + 1) as unknown as DbDiagnosticRow[];

    const hasMore = rows.length > limit;
    const itemRows = hasMore ? rows.slice(0, limit) : rows;
    const items = itemRows.map(parseDiagnosticRow);

    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].createdAt : null;

    return {
      items,
      nextCursor,
      total,
      limit,
    };
  }

  async cleanup(options: { ttlDays?: number; maxRowsPerUser?: number } = {}): Promise<{ deletedCount: number }> {
    const ttlDays = options.ttlDays ?? 7;
    const maxRowsPerUser = options.maxRowsPerUser ?? 1000;
    let deletedCount = 0;

    // 1. Delete rows older than TTL
    const cutoffDate = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString();
    const ttlRes = this.db.prepare(`
      DELETE FROM runtime_diagnostics WHERE created_at < ?
    `).run(cutoffDate);
    deletedCount += Number((ttlRes as any)?.changes ?? 0);

    // 2. Trim excess rows per user exceeding maxRowsPerUser
    const users = this.db.prepare(`SELECT DISTINCT user_id FROM runtime_diagnostics`).all() as Array<{ user_id: string }>;
    for (const u of users) {
      const trimRes = this.db.prepare(`
        DELETE FROM runtime_diagnostics
        WHERE user_id = ?
          AND id NOT IN (
            SELECT id FROM runtime_diagnostics
            WHERE user_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
          )
      `).run(u.user_id, u.user_id, maxRowsPerUser);
      deletedCount += Number((trimRes as any)?.changes ?? 0);
    }

    return { deletedCount };
  }
}
