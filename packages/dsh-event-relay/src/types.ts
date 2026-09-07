/**
 * Types for DSH Event Relay Plugin.
 *
 * @module @enkeep/dsh-event-relay
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';

export interface RelayEnvelope {
  /**
   * Deterministic per-session cursor string: `${sessionId}:${seq}`.
   */
  readonly cursor: string;

  /**
   * Monotonic sequence number within the session.
   */
  readonly seq: number;

  /**
   * Session ID where the event occurred.
   */
  readonly sessionId: string;

  /**
   * Session event payload.
   */
  readonly event: SessionEvent;

  /**
   * Timestamp in ms when the event was relayed.
   */
  readonly timestamp: number;
}

export interface EventRelayConfig {
  /**
   * Maximum number of envelopes to retain in bounded buffer per session (default: 1000).
   */
  readonly maxBufferSize?: number;

  /**
   * Default consumer name for cursor tracking with receipt store (default: 'default').
   */
  readonly consumer?: string;

  /**
   * Interval in ms to flush batched streaming events to platform (default: 30ms, range 20-50ms).
   */
  readonly batchIntervalMs?: number;

  /**
   * Maximum batch payload bytes before forcing immediate flush (default: 32768, 32KB).
   */
  readonly maxBatchSizeBytes?: number;

  /**
   * Maximum pending bytes before dropping intermediate deltas (default: 262144, 256KB).
   */
  readonly maxPendingBytes?: number;
}

/**
 * Streaming event frame dispatched from container to platform.
 */
export interface ContainerStreamingEventFrame {
  readonly id?: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly type:
    | 'turn_started'
    | 'assistant_delta'
    | 'assistant_stream_end'
    | 'thinking_delta'
    | 'tool_started'
    | 'tool_completed'
    | 'turn_completed'
    | 'turn_failed'
    | 'turn_cancelled';
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export interface PollEventsOptions {
  /**
   * Session ID to poll events from.
   */
  readonly sessionId: string;

  /**
   * Read events starting strictly after this cursor string (or sequence number).
   */
  readonly afterCursor?: string;

  /**
   * Maximum number of envelopes to return.
   */
  readonly limit?: number;
}

export interface PollEventsResult {
  readonly sessionId: string;
  readonly envelopes: readonly RelayEnvelope[];
  readonly latestCursor: string | null;
  readonly oldestCursor: string | null;
  readonly acknowledgedCursor: string | null;
  readonly remainingCount: number;
}

export type RelaySubscriber = (envelope: RelayEnvelope) => void;

export interface EventRelayDiagnostics {
  readonly flushCount: number;
  readonly flushFailureCount: number;
  readonly droppedDeltaCount: number;
  readonly subscriberErrorCount: number;
  readonly lastFlushErrorCode: string | null;
  readonly lastFlushErrorMessage: string | null;
  readonly ingestedEventTypes: Record<string, number>;
  readonly mappedFrameCounts: Record<string, number>;
  readonly platformPostStatusCounts: Record<string, number>;
}

export interface IEventRelayService {
  readonly consumer: string;
  readonly maxBufferSize: number;

  /**
   * Ingest a session event into the bounded buffer and notify subscribers.
   */
  ingest(session: Session, event: SessionEvent): RelayEnvelope;

  /**
   * Attach and subscribe to live agent-scoped context.
   */
  attachAgent(agentCtx: Context): () => void;

  /**
   * Attach and subscribe to live agent-scoped session event stream.
   */
  attachSession(session: Session, agentCtx?: Context): () => void;

  /**
   * Feed historical events (e.g. on restart recovery from session JSONL).
   */
  feedHistoricalEvents(session: Session, events: readonly SessionEvent[]): number;

  /**
   * Poll events for a specific session.
   */
  poll(options: PollEventsOptions): Promise<PollEventsResult>;

  /**
   * Acknowledge event consumption for a session up to cursor.
   * Persists cursor to receipt store and trims acknowledged events.
   */
  ack(sessionId: string, cursor: string, consumer?: string): Promise<void>;

  /**
   * Get the acknowledged cursor for a session.
   */
  getAcknowledgedCursor(sessionId: string, consumer?: string): Promise<string | null>;

  /**
   * Subscribe to real-time relayed events.
   */
  subscribe(listener: RelaySubscriber): () => void;

  /**
   * Get current buffer size for a session or total.
   */
  getBufferSize(sessionId?: string): number;

  /**
   * Get current operational streaming diagnostics.
   */
  getDiagnostics(): EventRelayDiagnostics;

  /**
   * Flush all buffered streaming event frames to platform immediately.
   */
  flush(): Promise<void>;

  /**
   * Clear all buffers and subscribers.
   */
  clear(): void;
}
