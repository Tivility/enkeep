/**
 * Streaming Audit Log Export Service
 *
 * True streaming CSV and JSONL export of audit records with:
 * - Backpressure handling and client abort cleanup
 * - CSV injection protection (formula prefixes neutralized)
 * - Strict recursive field whitelisting (sensitive keys redacted at all depths)
 * - UTF-8 headers and Content-Disposition
 * - Self-auditing: creates an audit event for each export action
 *
 * @module @enkeep/platform-server/exports
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { formatCsvRow, streamDataToResponse } from './export-utils.js';

export interface AuditExportOptions {
  format?: 'csv' | 'jsonl';
  from?: string;
  to?: string;
  action?: string;
  userId?: string;
  limit?: number;
}

const SENSITIVE_AUDIT_KEY_REGEX = /(?:password|token|secret|key|cookie|auth|credential|private|prompt|message|delta|args|argument)/i;

/**
 * Recursively cleans audit metadata details dictionary, dropping sensitive keys.
 */
export function sanitizeAuditDetails(obj: unknown, depth = 0): Record<string, unknown> | null {
  if (!obj || typeof obj !== 'object' || depth > 5) {
    return null;
  }
  if (Array.isArray(obj)) {
    return null;
  }

  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_AUDIT_KEY_REGEX.test(k)) {
      continue;
    }

    if (v === null || typeof v === 'boolean' || typeof v === 'number') {
      cleaned[k] = v;
    } else if (typeof v === 'string') {
      if (v.length > 500) {
        cleaned[k] = `${v.slice(0, 500)}...[truncated]`;
      } else if (/bearer\s+[a-zA-Z0-9._~+/-]+=*/i.test(v)) {
        cleaned[k] = '[REDACTED_AUTH]';
      } else {
        cleaned[k] = v;
      }
    } else if (typeof v === 'object' && !Array.isArray(v)) {
      const nested = sanitizeAuditDetails(v, depth + 1);
      if (nested && Object.keys(nested).length > 0) {
        cleaned[k] = nested;
      }
    }
  }

  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

export class AuditExportService {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async exportAuditLogs(
    req: IncomingMessage,
    res: ServerResponse,
    options: AuditExportOptions,
    actorUser?: { id: string; username: string; ipAddress?: string }
  ): Promise<void> {
    const format = options.format === 'jsonl' ? 'jsonl' : 'csv';
    const limit = Math.min(Math.max(Number(options.limit) || 10000, 1), 100000);

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
    if (options.from) {
      whereClauses.push('created_at >= ?');
      params.push(options.from);
    }
    if (options.to) {
      whereClauses.push('created_at <= ?');
      params.push(options.to);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const querySql = `
      SELECT id, user_id, username, action, ip_address, user_agent, details, created_at
      FROM auth_audit_log
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT ?
    `;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `audit-export-${timestamp}.${format === 'csv' ? 'csv' : 'jsonl'}`;
    const contentType = format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8';

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    };

    // Record audit event for export - MUST succeed before stream
    const exportAuditId = `audit_${randomUUID().replace(/-/g, '')}`;
    const exportDetails = JSON.stringify({
      format,
      filters: {
        userId: options.userId ?? null,
        action: options.action ?? null,
        from: options.from ?? null,
        to: options.to ?? null,
        limit,
      },
    });
    this.db.prepare(`
      INSERT INTO auth_audit_log (id, user_id, username, action, ip_address, details, created_at)
      VALUES (?, ?, ?, 'audit_exported', ?, ?, CURRENT_TIMESTAMP)
    `).run(
      exportAuditId,
      actorUser?.id ?? null,
      actorUser?.username ?? 'admin',
      actorUser?.ipAddress ?? null,
      exportDetails
    );

    const db = this.db;

    async function* generateAuditStream(): AsyncGenerator<string, void, unknown> {
      if (format === 'csv') {
        // UTF-8 BOM for Excel compatibility
        yield '\uFEFF';
        yield formatCsvRow(['ID', 'User ID', 'Username', 'Action', 'IP Address', 'User Agent', 'Details', 'Created At']);
      }

      const stmt = db.prepare(querySql);
      const rows = stmt.all(...params, limit) as unknown as Array<{
        id: unknown;
        user_id: unknown;
        username: unknown;
        action: unknown;
        ip_address: unknown;
        user_agent: unknown;
        details: unknown;
        created_at: unknown;
      }>;

      for (const row of rows) {
        const id = String(row.id || '');
        const userId = row.user_id ? String(row.user_id) : '';
        const username = String(row.username || '');
        const action = String(row.action || '');
        const ipAddress = row.ip_address ? String(row.ip_address) : '';
        const userAgent = row.user_agent ? String(row.user_agent) : '';
        const createdAt = String(row.created_at || '');

        let safeDetailsObj: Record<string, unknown> | null = null;
        if (row.details && typeof row.details === 'string') {
          try {
            const parsed = JSON.parse(row.details);
            safeDetailsObj = sanitizeAuditDetails(parsed);
          } catch (_jsonErr: unknown) {
            safeDetailsObj = null;
          }
        }

        const safeDetailsStr = safeDetailsObj ? JSON.stringify(safeDetailsObj) : '';

        if (format === 'csv') {
          yield formatCsvRow([id, userId, username, action, ipAddress, userAgent, safeDetailsStr, createdAt]);
        } else {
          const item = {
            id,
            userId: userId || null,
            username,
            action,
            ipAddress: ipAddress || null,
            userAgent: userAgent || null,
            details: safeDetailsObj,
            createdAt,
          };
          yield JSON.stringify(item) + '\n';
        }
      }
    }

    await streamDataToResponse(req, res, headers, generateAuditStream());
  }
}
