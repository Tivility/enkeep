/**
 * SQLite Stream Event Source.
 * Reads assistant_delta and assistant_stream_end events from web_events table
 * for active Lark streaming reply card delivery.
 *
 * @module @enkeep/platform-server/channels/sqlite-stream-event-source
 */

import type { DatabaseSync } from 'node:sqlite';
import type { StreamEventSource } from '@enkeep/channel-lark';

interface WebEventRow {
  rowid: number | bigint;
  type: string;
  payload: string;
}

export class SqliteStreamEventSource implements StreamEventSource {
  constructor(private readonly db: DatabaseSync) {}

  async getLatestRowId(sessionRouteId: string): Promise<number> {
    const row = this.db
      .prepare('SELECT MAX(rowid) as max_id FROM web_events WHERE session_id = ?')
      .get(sessionRouteId) as { max_id: number | bigint | null } | undefined;
    if (row && row.max_id != null) {
      return Number(row.max_id);
    }
    return 0;
  }

  async listAssistantEvents(
    sessionRouteId: string,
    afterRowId: number,
    limit = 100
  ): Promise<Array<{
    rowId: number;
    type: 'assistant_delta' | 'assistant_stream_end' | 'turn_status' | 'tool_status';
    delta?: string;
    streamId?: string;
    status?: string;
    toolName?: string;
  }>> {
    const stmt = this.db.prepare(
      `SELECT rowid, type, payload FROM web_events WHERE session_id = ? AND rowid > ? AND type IN ('assistant_delta', 'assistant_stream_end', 'turn_status', 'tool_status') ORDER BY rowid ASC LIMIT ?`
    );

    const rows = stmt.all(sessionRouteId, afterRowId, limit) as unknown as WebEventRow[];

    return rows.map((row) => {
      let delta: string | undefined;
      let streamId: string | undefined;
      let status: string | undefined;
      let toolName: string | undefined;

      try {
        const parsed = JSON.parse(row.payload);
        if (row.type === 'assistant_delta') {
          if (typeof parsed.delta === 'string') delta = parsed.delta;
          if (typeof parsed.streamId === 'string') streamId = parsed.streamId;
        } else if (row.type === 'assistant_stream_end') {
          if (typeof parsed.streamId === 'string') streamId = parsed.streamId;
        } else if (row.type === 'turn_status') {
          if (typeof parsed.status === 'string') status = parsed.status;
        } else if (row.type === 'tool_status') {
          if (typeof parsed.status === 'string') status = parsed.status;
          if (typeof parsed.toolName === 'string') toolName = parsed.toolName;
        }
      } catch {}

      return {
        rowId: Number(row.rowid),
        type: row.type as 'assistant_delta' | 'assistant_stream_end' | 'turn_status' | 'tool_status',
        delta,
        streamId,
        status,
        toolName,
      };
    });
  }

  async getPlatformTurnState(
    sessionRouteId: string,
    turnId: string
  ): Promise<'queued' | 'running' | 'completed' | 'failed' | 'unknown'> {
    const row = this.db
      .prepare('SELECT status FROM turn_runs WHERE route_id = ? AND turn_id = ? LIMIT 1')
      .get(sessionRouteId, turnId) as { status: string } | undefined;

    if (!row) {
      return 'unknown';
    }

    if (row.status === 'queued' || row.status === 'running' || row.status === 'completed') {
      return row.status;
    }
    if (row.status === 'failed' || row.status === 'cancelled' || row.status === 'interrupted') {
      return 'failed';
    }
    return 'unknown';
  }

  async hasPendingPlatformTurn(sessionRouteId: string): Promise<boolean> {
    const row = this.db
      .prepare("SELECT 1 FROM turn_runs WHERE route_id = ? AND status IN ('queued', 'running') LIMIT 1")
      .get(sessionRouteId);
    return !!row;
  }
}
