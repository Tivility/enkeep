/**
 * Factual Quota Usage Snapshot Export Service
 *
 * True streaming CSV and JSONL export of authoritative tenant quota usage:
 * - Direct snapshot from quota_limits and quota_usage
 * - Guarantees full 5-resource metrics for all active users even with zero usage
 * - Backpressure handling and client abort cleanup
 * - CSV injection protection
 * - UTF-8 headers and Content-Disposition
 * - Self-auditing: creates an audit event for export
 *
 * @module @enkeep/platform-server/exports
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ValidationError } from '@enkeep/platform-core';
import { formatCsvRow, streamDataToResponse } from './export-utils.js';

export interface UsageExportOptions {
  format?: 'csv' | 'jsonl';
  from?: string;
  to?: string;
  userId?: string;
  model?: string;
  limit?: number;
}

const CORE_RESOURCES = ['tokens', 'messages', 'turns', 'storage_bytes', 'api_calls'] as const;
const DEFAULT_LIMIT_AMOUNTS: Record<string, number> = {
  tokens: -1,
  messages: -1,
  turns: -1,
  storage_bytes: -1,
  api_calls: -1,
};

interface DbUserRow {
  id: string;
  username: string;
  status: string;
}

interface DbLimitRow {
  user_id: string;
  resource: string;
  limit_amount: number;
  reset_interval: string | null;
  reset_at: string | null;
}

interface DbUsageRow {
  user_id: string;
  resource: string;
  used_amount: number;
}

export class UsageExportService {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async exportUsage(
    req: IncomingMessage,
    res: ServerResponse,
    options: UsageExportOptions,
    actorUser?: { id: string; username: string; ipAddress?: string }
  ): Promise<void> {
    if (options.from || options.to || options.model) {
      throw new ValidationError(
        'Date and model filters are not supported for factual quota snapshot usage export. Use userId filter or omit date/model parameters.'
      );
    }

    const format = options.format === 'jsonl' ? 'jsonl' : 'csv';
    const limit = Math.min(Math.max(Number(options.limit) || 10000, 1), 100000);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `usage-snapshot-${timestamp}.${format === 'csv' ? 'csv' : 'jsonl'}`;
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
        limit,
      },
    });
    this.db.prepare(`
      INSERT INTO auth_audit_log (id, user_id, username, action, ip_address, details, created_at)
      VALUES (?, ?, ?, 'usage_exported', ?, ?, CURRENT_TIMESTAMP)
    `).run(
      exportAuditId,
      actorUser?.id ?? null,
      actorUser?.username ?? 'admin',
      actorUser?.ipAddress ?? null,
      exportDetails
    );

    const whereClauses: string[] = [];
    const params: (string | number)[] = [];

    if (options.userId) {
      whereClauses.push('id = ?');
      params.push(options.userId);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const usersSql = `
      SELECT id, username, status
      FROM users
      ${whereSql}
      ORDER BY username ASC
      LIMIT ?
    `;

    const db = this.db;
    const asOf = new Date().toISOString();

    async function* generateUsageStream(): AsyncGenerator<string, void, unknown> {
      if (format === 'csv') {
        yield '\uFEFF';
        yield formatCsvRow([
          'User ID',
          'Username',
          'As Of',
          'Resource',
          'Used Amount',
          'Limit Amount',
          'Remaining Amount',
          'Reset Interval',
          'Reset At',
        ]);
      }

      const usersStmt = db.prepare(usersSql);
      const userRows = usersStmt.all(...params, limit) as unknown as DbUserRow[];

      for (const user of userRows) {
        const limitsRows = db.prepare(`
          SELECT user_id, resource, limit_amount, reset_interval, reset_at
          FROM quota_limits
          WHERE user_id = ?
        `).all(user.id) as unknown as DbLimitRow[];

        const usageRows = db.prepare(`
          SELECT user_id, resource, used_amount
          FROM quota_usage
          WHERE user_id = ?
        `).all(user.id) as unknown as DbUsageRow[];

        const limitMap = new Map<string, DbLimitRow>();
        for (const l of limitsRows) {
          limitMap.set(l.resource, l);
        }

        const usageMap = new Map<string, number>();
        for (const u of usageRows) {
          usageMap.set(u.resource, Number(u.used_amount || 0));
        }

        const userQuotas = CORE_RESOURCES.map((resource) => {
          const limitRow = limitMap.get(resource);
          const limitAmount = limitRow?.limit_amount !== undefined ? Number(limitRow.limit_amount) : DEFAULT_LIMIT_AMOUNTS[resource];
          const usedAmount = usageMap.get(resource) ?? 0;
          const remainingAmount = limitAmount < 0 ? -1 : Math.max(0, limitAmount - usedAmount);
          const resetInterval = limitRow?.reset_interval || 'none';
          const resetAt = limitRow?.reset_at || null;

          return {
            resource,
            usedAmount,
            limitAmount,
            remainingAmount,
            resetInterval,
            resetAt,
          };
        });

        if (format === 'csv') {
          for (const q of userQuotas) {
            yield formatCsvRow([
              user.id,
              user.username,
              asOf,
              q.resource,
              q.usedAmount,
              q.limitAmount,
              q.remainingAmount,
              q.resetInterval,
              q.resetAt || '',
            ]);
          }
        } else {
          const jsonItem = {
            userId: user.id,
            username: user.username,
            asOf,
            quotas: userQuotas,
          };
          yield JSON.stringify(jsonItem) + '\n';
        }
      }
    }

    await streamDataToResponse(req, res, headers, generateUsageStream());
  }
}
