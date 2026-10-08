/**
 * SQLite Stream Event Source.
 * Reads assistant_delta and assistant_stream_end events from web_events table
 * for active Lark streaming reply card delivery.
 *
 * @module @enkeep/platform-server/channels/sqlite-stream-event-source
 */

import type { DatabaseSync } from 'node:sqlite';
import type { StreamEventSource, StreamAssistantEvent } from '@enkeep/channel-lark';
import type { ChannelTurnOrigin } from '@enkeep/platform-core';

declare module '@enkeep/channel-lark' {
  interface StreamAssistantEvent {
    causeChildId?: string;
  }
}

export interface AutonomousTurnCompletedPayload {
  sessionRouteId: string;
  turnId: string;
  originTurnId: string;
  causeChildId?: string;
}

export type AutonomousTurnCompletedCallback = (
  payload: AutonomousTurnCompletedPayload
) => void | Promise<void>;

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
  ): Promise<StreamAssistantEvent[]> {
    const stmt = this.db.prepare(
      `SELECT rowid, type, payload FROM web_events WHERE session_id = ? AND rowid > ? AND type IN ('assistant_delta', 'assistant_stream_end', 'turn_status', 'tool_status', 'reasoning_delta', 'thinking') ORDER BY rowid ASC LIMIT ?`
    );

    const rows = stmt.all(sessionRouteId, afterRowId, limit) as unknown as WebEventRow[];

    return rows.map((row) => {
      let delta: string | undefined;
      let streamId: string | undefined;
      let status: string | undefined;
      let toolName: string | undefined;
      let turnId: string | undefined;
      let originTurnId: string | undefined;
      let causeChildId: string | undefined;

      try {
        const parsed = JSON.parse(row.payload);
        if (typeof parsed.turnId === 'string' && parsed.turnId.trim().length > 0) {
          turnId = parsed.turnId.trim();
        }
        if (typeof parsed.originTurnId === 'string' && parsed.originTurnId.trim().length > 0) {
          originTurnId = parsed.originTurnId.trim();
        }
        const rawCauseChildId = parsed.causeChildId ?? parsed.cause_child_id ?? parsed.metadata?.causeChildId ?? parsed.metadata?.cause_child_id;
        if (typeof rawCauseChildId === 'string' && rawCauseChildId.trim().length > 0) {
          causeChildId = rawCauseChildId.trim();
        }

        if (row.type === 'assistant_delta') {
          if (typeof parsed.delta === 'string') delta = parsed.delta;
          if (typeof parsed.streamId === 'string') streamId = parsed.streamId;
        } else if (row.type === 'reasoning_delta') {
          if (typeof parsed.delta === 'string') delta = parsed.delta;
          else if (typeof parsed.text === 'string') delta = parsed.text;
          if (typeof parsed.streamId === 'string') streamId = parsed.streamId;
          status = typeof parsed.status === 'string' ? parsed.status : 'thinking';
        } else if (row.type === 'thinking') {
          if (typeof parsed.status === 'string') status = parsed.status;
          if (typeof parsed.streamId === 'string') streamId = parsed.streamId;
          if (typeof parsed.delta === 'string') delta = parsed.delta;
          else if (typeof parsed.text === 'string') delta = parsed.text;
        } else if (row.type === 'assistant_stream_end') {
          if (typeof parsed.streamId === 'string') streamId = parsed.streamId;
        } else if (row.type === 'turn_status') {
          if (typeof parsed.status === 'string') status = parsed.status;
        } else if (row.type === 'tool_status') {
          if (typeof parsed.status === 'string') status = parsed.status;
          if (typeof parsed.toolName === 'string') toolName = parsed.toolName;
        }
      } catch {}

      const eventType = row.type === 'thinking' ? 'reasoning_delta' : row.type;

      return {
        rowId: Number(row.rowid),
        type: eventType as any,
        delta,
        streamId,
        status,
        toolName,
        turnId,
        originTurnId,
        causeChildId,
      };
    }) as unknown as StreamAssistantEvent[];
  }

  async resolveTurnOrigin(
    turnId: string,
    sessionRouteId?: string
  ): Promise<ChannelTurnOrigin | null> {
    const result = this.resolveTurnOriginRecursive(turnId, sessionRouteId, new Set<string>(), 0);
    if (result.status === 'resolved') {
      return result.origin;
    }
    if (result.status === 'aborted') {
      return null;
    }
    return this.resolveTurnOriginFallback(turnId, sessionRouteId);
  }

  private resolveTurnOriginFallback(
    turnId: string,
    sessionRouteId: string | undefined
  ): ChannelTurnOrigin | null {
    let effectiveSessionId = sessionRouteId;
    if (!effectiveSessionId && turnId) {
      const trimmed = turnId.trim();
      const row = this.db
        .prepare(
          `SELECT session_id FROM web_events
           WHERE json_valid(payload) = 1
             AND (
               json_extract(payload, '$.turnId') = ?
               OR json_extract(payload, '$.turn_id') = ?
             )
             AND session_id IS NOT NULL AND session_id != ''
           ORDER BY rowid DESC
           LIMIT 1`
        )
        .get(trimmed, trimmed) as { session_id?: string } | undefined;
      if (row?.session_id) {
        effectiveSessionId = row.session_id;
      }
    }

    if (!effectiveSessionId) {
      return null;
    }

    const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM channel_turn_origins
         WHERE session_id = ?
           AND (
             datetime(created_at) >= datetime('now', '-24 hours')
             OR created_at >= ?
           )
         ORDER BY created_at DESC, rowid DESC`
      )
      .all(effectiveSessionId, cutoffIso) as any[];

    if (!rows || rows.length === 0) {
      return null;
    }

    const first = rows[0];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const sameContext =
        r.channel === first.channel &&
        r.account_id === first.account_id &&
        r.chat_id === first.chat_id &&
        (r.thread_id ?? null) === (first.thread_id ?? null) &&
        (r.root_id ?? null) === (first.root_id ?? null) &&
        (r.native_context_id ?? null) === (first.native_context_id ?? null);
      if (!sameContext) {
        return null;
      }
    }

    return {
      turnId: first.turn_id,
      userId: first.user_id,
      sessionId: first.session_id,
      accountId: first.account_id,
      channel: first.channel,
      chatId: first.chat_id,
      nativeContextId: first.native_context_id,
      nativeEventId: first.native_event_id ?? null,
      replyToMessageId: first.reply_to_message_id ?? null,
      rootId: first.root_id ?? null,
      threadId: first.thread_id ?? null,
      originTurnId: first.origin_turn_id ?? null,
      createdAt: first.created_at,
    };
  }

  private resolveTurnOriginRecursive(
    turnId: string,
    sessionRouteId: string | undefined,
    visited: Set<string>,
    depth: number
  ): { status: 'resolved'; origin: ChannelTurnOrigin } | { status: 'aborted' } | { status: 'not_found' } {
    if (!turnId || typeof turnId !== 'string') return { status: 'not_found' };
    const trimmedTurnId = turnId.trim();
    if (!trimmedTurnId) return { status: 'not_found' };

    if (depth >= 8) return { status: 'aborted' };
    if (visited.has(trimmedTurnId)) return { status: 'aborted' };
    visited.add(trimmedTurnId);

    const row = this.db
      .prepare('SELECT * FROM channel_turn_origins WHERE turn_id = ? LIMIT 1')
      .get(trimmedTurnId) as any;
    if (row) {
      if (sessionRouteId && row.session_id !== sessionRouteId) {
        return { status: 'not_found' };
      }
      return {
        status: 'resolved',
        origin: {
          turnId: row.turn_id,
          userId: row.user_id,
          sessionId: row.session_id,
          accountId: row.account_id,
          channel: row.channel,
          chatId: row.chat_id,
          nativeContextId: row.native_context_id,
          nativeEventId: row.native_event_id ?? null,
          replyToMessageId: row.reply_to_message_id ?? null,
          rootId: row.root_id ?? null,
          threadId: row.thread_id ?? null,
          originTurnId: row.origin_turn_id ?? null,
          createdAt: row.created_at,
        },
      };
    }

    const eventRow = (
      sessionRouteId
        ? this.db
            .prepare(
              `SELECT session_id,
                      COALESCE(
                        json_extract(payload, '$.originTurnId'),
                        json_extract(payload, '$.origin_turn_id')
                      ) AS origin_turn_id
               FROM web_events
               WHERE session_id = ?
                 AND json_valid(payload) = 1
                 AND (
                   json_extract(payload, '$.turnId') = ?
                   OR json_extract(payload, '$.turn_id') = ?
                 )
                 AND (
                   (json_extract(payload, '$.originTurnId') IS NOT NULL AND json_extract(payload, '$.originTurnId') != '')
                   OR (json_extract(payload, '$.origin_turn_id') IS NOT NULL AND json_extract(payload, '$.origin_turn_id') != '')
                 )
               ORDER BY rowid DESC
               LIMIT 1`
            )
            .get(sessionRouteId, trimmedTurnId, trimmedTurnId)
        : this.db
            .prepare(
              `SELECT session_id,
                      COALESCE(
                        json_extract(payload, '$.originTurnId'),
                        json_extract(payload, '$.origin_turn_id')
                      ) AS origin_turn_id
               FROM web_events
               WHERE json_valid(payload) = 1
                 AND (
                   json_extract(payload, '$.turnId') = ?
                   OR json_extract(payload, '$.turn_id') = ?
                 )
                 AND (
                   (json_extract(payload, '$.originTurnId') IS NOT NULL AND json_extract(payload, '$.originTurnId') != '')
                   OR (json_extract(payload, '$.origin_turn_id') IS NOT NULL AND json_extract(payload, '$.origin_turn_id') != '')
                 )
               ORDER BY rowid DESC
               LIMIT 1`
            )
            .get(trimmedTurnId, trimmedTurnId)
    ) as { session_id?: string; origin_turn_id?: string } | undefined;

    if (!eventRow || typeof eventRow.origin_turn_id !== 'string') {
      return { status: 'not_found' };
    }

    const nextOriginTurnId = eventRow.origin_turn_id.trim();
    if (!nextOriginTurnId) return { status: 'not_found' };

    const effectiveSessionId = sessionRouteId ?? eventRow.session_id;
    return this.resolveTurnOriginRecursive(nextOriginTurnId, effectiveSessionId, visited, depth + 1);
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
