/**
 * Runtime Diagnostics & Telemetry Service
 *
 * Implements:
 * 1. Host-side structured diagnostics in-memory ring buffer (per user).
 * 2. SQLite persistence via SqliteRuntimeDiagnosticsRepository (Migration 25).
 * 3. Strict redaction: NEVER exposes Docker raw logs, secrets, prompts, message content, tool arguments, model deltas, or env vars.
 * 4. Docker telemetry collector (CPU, memory, PIDs, volume bytes) via docker stats/inspect with bounded timeout.
 * 5. Automatic cleanup worker for TTL and max rows per user.
 *
 * @module @enkeep/platform-server/diagnostics
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import {
  type RuntimeDiagnosticRecord,
  type RuntimeDiagnosticsQueryOptions,
  type RuntimeDiagnosticsQueryResult,
  type DiagnosticEventType,
  type DiagnosticLogLevel,
  type RuntimeTelemetryStats,
} from '@enkeep/platform-core';
import {
  SqliteRuntimeDiagnosticsRepository,
  type CreateDiagnosticInput,
} from '@enkeep/platform-storage-sqlite';

const execFileAsync = promisify(execFile);

const SENSITIVE_KEY_PATTERN = /(?:password|secret|token|prompt|message|delta|args|arguments|env|authorization|cookie|key|credential|private)/i;

/**
 * Recursively sanitizes diagnostic details metadata, stripping sensitive keys and prompt/credential content.
 */
export function sanitizeDiagnosticDetails(data: unknown, depth = 0): Record<string, unknown> | null {
  if (!data || typeof data !== 'object' || depth > 5) {
    return null;
  }
  if (Array.isArray(data)) {
    return null; // Details must be a dictionary
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      continue; // Drop sensitive fields completely
    }

    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      result[key] = value;
    } else if (typeof value === 'string') {
      // Redact potential inline tokens/keys
      if (value.length > 500) {
        result[key] = `${value.slice(0, 500)}...[truncated]`;
      } else if (/bearer\s+[a-zA-Z0-9._~+/-]+=*/i.test(value)) {
        result[key] = '[REDACTED_AUTH]';
      } else {
        result[key] = value;
      }
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      const nested = sanitizeDiagnosticDetails(value, depth + 1);
      if (nested && Object.keys(nested).length > 0) {
        result[key] = nested;
      }
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

export const DIAGNOSTIC_CODE_CATALOG: Record<string, string> = {
  CONTAINER_START_SUCCESS: 'Container started successfully',
  CONTAINER_START_FAILED: 'Container startup failed',
  CONTAINER_STOP_OK: 'Container stopped cleanly',
  CONTAINER_STOP_FAILED: 'Container stop failed',
  CONTAINER_RESTART_START: 'Container restart initiated',
  CONTAINER_RESTART_SUCCESS: 'Container restarted successfully',
  CONTAINER_RESTART_FAILED: 'Container restart failed',
  HEALTH_CHECK_PASS: 'Container health check passed',
  HEALTH_CHECK_FAIL: 'Container health check failed',
  TOOL_EXECUTION_FAILED: 'Tool execution failed',
  TOOL_EXECUTION_TIMEOUT: 'Tool execution timed out',
  RESOURCE_USAGE_SAMPLE: 'Resource telemetry sample recorded',
  RESOURCE_MEMORY_HIGH: 'Container memory usage near limit',
  RESOURCE_CPU_HIGH: 'Container CPU utilization high',
  SYSTEM_RECOVERY_START: 'Runtime recovery initiated',
  SYSTEM_RECOVERY_SUCCESS: 'Runtime recovery completed',
  SYSTEM_RECOVERY_FAILED: 'Runtime recovery failed',
};

export const DEFAULT_DIAGNOSTIC_MESSAGE = 'Runtime diagnostic event';

export interface DiagnosticsServiceOptions {
  db: DatabaseSync;
  dockerBin?: string;
  ringBufferSizePerUser?: number;
  telemetryTimeoutMs?: number;
}

export class RuntimeDiagnosticsService {
  private readonly db: DatabaseSync;
  private readonly repo: SqliteRuntimeDiagnosticsRepository;
  private readonly dockerBin: string;
  private readonly ringBufferSizePerUser: number;
  private readonly telemetryTimeoutMs: number;
  private readonly ringBuffers = new Map<string, RuntimeDiagnosticRecord[]>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(options: DiagnosticsServiceOptions) {
    this.db = options.db;
    this.repo = new SqliteRuntimeDiagnosticsRepository(options.db);
    this.dockerBin = options.dockerBin || 'docker';
    this.ringBufferSizePerUser = options.ringBufferSizePerUser ?? 500;
    this.telemetryTimeoutMs = options.telemetryTimeoutMs ?? 2500;
  }

  /**
   * Records a structured diagnostic event.
   * Enforces strict redaction, derives canonical safe message from code catalog, updates ring buffer, and persists to SQLite.
   */
  async recordDiagnostic(input: {
    userId: string;
    containerId?: string | null;
    eventType: DiagnosticEventType;
    level: DiagnosticLogLevel;
    code: string;
    message?: string;
    details?: Record<string, unknown> | null;
    stats?: RuntimeTelemetryStats | null;
  }): Promise<RuntimeDiagnosticRecord> {
    const safeDetails = input.details ? sanitizeDiagnosticDetails(input.details) : null;
    const safeCode = input.code.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 64);
    // Derive message strictly from fixed code catalog to prevent freeform prompt/token injection in message column
    const safeMessage = DIAGNOSTIC_CODE_CATALOG[safeCode] || DEFAULT_DIAGNOSTIC_MESSAGE;

    const record = await this.repo.create({
      userId: input.userId,
      containerId: input.containerId ?? null,
      eventType: input.eventType,
      level: input.level,
      code: safeCode,
      message: safeMessage,
      details: safeDetails,
      stats: input.stats ?? null,
    });

    // Update in-memory ring buffer
    let ring = this.ringBuffers.get(input.userId);
    if (!ring) {
      ring = [];
      this.ringBuffers.set(input.userId, ring);
    }
    ring.unshift(record);
    if (ring.length > this.ringBufferSizePerUser) {
      ring.length = this.ringBufferSizePerUser;
    }

    return record;
  }

  /**
   * Retrieves recent diagnostic entries from the in-memory ring buffer (fast path).
   */
  getRecentFromRingBuffer(userId: string, limit = 50): RuntimeDiagnosticRecord[] {
    const ring = this.ringBuffers.get(userId) || [];
    return ring.slice(0, limit);
  }

  /**
   * Queries paginated diagnostics from SQLite.
   */
  async queryDiagnostics(options: RuntimeDiagnosticsQueryOptions): Promise<RuntimeDiagnosticsQueryResult> {
    return this.repo.query(options);
  }

  /**
   * Collects one-shot bounded container telemetry via Docker inspect / stats.
   */
  async collectContainerTelemetry(containerId: string): Promise<RuntimeTelemetryStats | null> {
    if (!containerId || typeof containerId !== 'string' || containerId.length < 12) {
      return null;
    }

    try {
      const statsPromise = execFileAsync(
        this.dockerBin,
        ['stats', '--no-stream', '--format', '{{json .}}', containerId],
        { timeout: this.telemetryTimeoutMs }
      );

      const { stdout } = await statsPromise;
      if (!stdout || !stdout.trim()) {
        return null;
      }

      const parsed = JSON.parse(stdout.trim());
      const cpuStr = String(parsed.CPUPerc || '0%').replace('%', '').trim();
      const cpuPercent = parseFloat(cpuStr) || 0;

      // Parse memory usage (e.g. "12.5MiB / 512MiB")
      let memoryUsageBytes: number | undefined;
      let memoryLimitBytes: number | undefined;
      const memStr = String(parsed.MemUsage || '');
      const parts = memStr.split('/');
      if (parts.length === 2) {
        memoryUsageBytes = this.parseByteUnits(parts[0].trim());
        memoryLimitBytes = this.parseByteUnits(parts[1].trim());
      }

      const pidsCount = parseInt(String(parsed.PIDs || '0'), 10) || undefined;

      return {
        cpuPercent,
        memoryUsageBytes,
        memoryLimitBytes,
        pidsCount,
      };
    } catch {
      // Gracefully return null on container offline / inspect failure
      return null;
    }
  }

  private parseByteUnits(str: string): number | undefined {
    const match = /^([0-9.]+)\s*([A-Za-z]+)?$/i.exec(str);
    if (!match) return undefined;
    const num = parseFloat(match[1]);
    const unit = (match[2] || 'B').toUpperCase();

    switch (unit) {
      case 'B': return Math.round(num);
      case 'KB':
      case 'KIB': return Math.round(num * 1024);
      case 'MB':
      case 'MIB': return Math.round(num * 1024 * 1024);
      case 'GB':
      case 'GIB': return Math.round(num * 1024 * 1024 * 1024);
      default: return Math.round(num);
    }
  }

  /**
   * Starts background cleanup worker for TTL and max rows per user.
   */
  startCleanupWorker(intervalMs = 60 * 60 * 1000, ttlDays = 7, maxRowsPerUser = 1000): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(async () => {
      try {
        await this.repo.cleanup({ ttlDays, maxRowsPerUser });
      } catch {
        // Ignore cleanup failure in background
      }
    }, intervalMs);
  }

  stopCleanupWorker(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  async runCleanup(options?: { ttlDays?: number; maxRowsPerUser?: number }): Promise<{ deletedCount: number }> {
    return this.repo.cleanup(options);
  }
}
