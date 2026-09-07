/**
 * Event Relay Service implementation.
 *
 * Listens to DSH session events, maintains per-session bounded buffers,
 * supports subscriber dispatch, per-session cursor acknowledgement,
 * and high-performance batched non-blocking streaming forwarding to platform.
 *
 * @module @enkeep/dsh-event-relay
 */

import { randomBytes } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type {
  ContainerStreamingEventFrame,
  EventRelayConfig,
  EventRelayDiagnostics,
  IEventRelayService,
  PollEventsOptions,
  PollEventsResult,
  RelayEnvelope,
  RelaySubscriber,
} from './types.js';
import type { IPlatformClientService } from './index.js';
import { BoundedEventBuffer, parseCursorSeq } from './bounded-buffer.js';
import { EventRelayValidationError } from './errors.js';

interface SessionStreamState {
  streamId: string;
  accumulatedLength: number;
  activeToolName?: string;
}

export class EventRelayService implements IEventRelayService {
  readonly consumer: string;
  readonly batchIntervalMs: number;
  readonly maxBatchSizeBytes: number;
  readonly maxPendingBytes: number;

  private readonly ctx: Context;
  private readonly buffer: BoundedEventBuffer;
  private readonly subscribers = new Set<RelaySubscriber>();

  // Streaming forwarding state
  private readonly sessionStreams = new Map<string, SessionStreamState>();
  private readonly sessionLastMappedSeq = new Map<string, number>();
  private pendingOutboundFrames: ContainerStreamingEventFrame[] = [];
  private pendingOutboundBytes = 0;
  private batchTimer: NodeJS.Timeout | null = null;
  private isFlushing = false;
  private isDisposed = false;

  // Diagnostics
  private flushCount = 0;
  private flushFailureCount = 0;
  private droppedDeltaCount = 0;
  private subscriberErrorCount = 0;
  private lastFlushErrorCode: string | null = null;
  private lastFlushErrorMessage: string | null = null;
  private readonly ingestedEventTypes: Record<string, number> = {};
  private readonly mappedFrameCounts: Record<string, number> = {};
  private readonly platformPostStatusCounts: Record<string, number> = {};
  private lastFrameTimeMs = 0;

  constructor(ctx: Context, config?: EventRelayConfig) {
    this.ctx = ctx;
    this.consumer = config?.consumer ?? 'default';
    this.buffer = new BoundedEventBuffer(config?.maxBufferSize ?? 1000);
    this.batchIntervalMs = Math.min(Math.max(config?.batchIntervalMs ?? 30, 20), 50);
    this.maxBatchSizeBytes = config?.maxBatchSizeBytes ?? 32768; // 32KB
    this.maxPendingBytes = config?.maxPendingBytes ?? 262144; // 256KB

    this.startBatchTimer();
  }

  get maxBufferSize(): number {
    return this.buffer.capacity;
  }

  private get receiptStore() {
    return this.ctx.get('receiptStore');
  }

  private get platformClient(): IPlatformClientService | undefined {
    return this.ctx.get('platformClient') ?? (this.ctx as unknown as { platformClient?: IPlatformClientService }).platformClient;
  }

  getBufferSize(sessionId?: string): number {
    return this.buffer.getBufferSize(sessionId);
  }

  getDiagnostics(): EventRelayDiagnostics {
    return {
      flushCount: this.flushCount,
      flushFailureCount: this.flushFailureCount,
      droppedDeltaCount: this.droppedDeltaCount,
      subscriberErrorCount: this.subscriberErrorCount,
      lastFlushErrorCode: this.lastFlushErrorCode,
      lastFlushErrorMessage: this.lastFlushErrorMessage,
      ingestedEventTypes: { ...this.ingestedEventTypes },
      mappedFrameCounts: { ...this.mappedFrameCounts },
      platformPostStatusCounts: { ...this.platformPostStatusCounts },
    };
  }

  private startBatchTimer(): void {
    if (this.batchTimer || this.isDisposed) return;
    this.batchTimer = setInterval(() => {
      if (this.pendingOutboundFrames.length > 0) {
        void this.flushOutbound().catch((flushErr: unknown) => {
          this.recordFlushFailure(flushErr);
        });
      }
    }, this.batchIntervalMs);
  }

  private stopBatchTimer(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
  }

  private recordFlushFailure(err: unknown): void {
    this.flushFailureCount++;
    if (err instanceof Error) {
      this.lastFlushErrorCode = 'FLUSH_ERROR';
      this.lastFlushErrorMessage = err.message;
    } else {
      this.lastFlushErrorCode = 'FLUSH_ERROR';
      this.lastFlushErrorMessage = String(err);
    }
  }

  private readonly attachedAgentScopes = new WeakSet<object>();

  attachAgent(agentCtx: Context): () => void {
    if (!agentCtx || typeof agentCtx.on !== 'function') {
      return () => {};
    }
    const scopeKey = agentCtx as unknown as object;
    if (this.attachedAgentScopes.has(scopeKey)) {
      return () => {};
    }
    this.attachedAgentScopes.add(scopeKey);

    const disposers: Array<() => void> = [];

    const unsubEvent = agentCtx.on('session/event', (s: Session, event: SessionEvent) => {
      this.ingest(s, event);
    });
    if (typeof unsubEvent === 'function') disposers.push(unsubEvent);

    const unsubFlush = agentCtx.on('session/flush', async (_s: Session) => {
      await this.flush();
    });
    if (typeof unsubFlush === 'function') disposers.push(unsubFlush);

    return () => {
      for (const d of disposers) {
        d();
      }
      this.attachedAgentScopes.delete(scopeKey);
    };
  }

  attachSession(session: Session, agentCtx?: Context): () => void {
    if (agentCtx && typeof agentCtx.on === 'function') {
      return this.attachAgent(agentCtx);
    }
    return () => {};
  }

  ingest(session: Session, event: SessionEvent): RelayEnvelope {
    const sessionId = session.id as string;
    const envelope = this.buffer.push(sessionId, event);

    // Record safe diagnostic count (event type only)
    this.ingestedEventTypes[event.type] = (this.ingestedEventTypes[event.type] || 0) + 1;

    // Notify real-time subscribers
    for (const subscriber of this.subscribers) {
      try {
        subscriber(envelope);
      } catch (_subErr: unknown) {
        this.subscriberErrorCount++;
      }
    }

    // Convert DSH session event into streaming event frames (at most once per event seq)
    const lastSeq = this.sessionLastMappedSeq.get(sessionId) ?? -1;
    if (typeof event.seq !== 'number' || event.seq > lastSeq) {
      if (typeof event.seq === 'number') {
        this.sessionLastMappedSeq.set(sessionId, event.seq);
      }
      try {
        this.mapAndQueueStreamingFrames(sessionId, event);
      } catch (mapErr: unknown) {
        this.recordFlushFailure(mapErr);
      }
    }

    return envelope;
  }

  private getOrCreateStreamState(sessionId: string): SessionStreamState {
    let state = this.sessionStreams.get(sessionId);
    if (!state) {
      state = {
        streamId: `msgstream_${randomBytes(16).toString('hex')}`,
        accumulatedLength: 0,
      };
      this.sessionStreams.set(sessionId, state);
    }
    return state;
  }

  private getMonotonicIsoTimestamp(): string {
    const now = Date.now();
    this.lastFrameTimeMs = Math.max(now, this.lastFrameTimeMs + 1);
    return new Date(this.lastFrameTimeMs).toISOString();
  }

  private mapAndQueueStreamingFrames(sessionId: string, event: SessionEvent): void {
    const frames: ContainerStreamingEventFrame[] = [];

    switch (event.type) {
      case 'turn/start': {
        const streamState = {
          streamId: `msgstream_${randomBytes(16).toString('hex')}`,
          accumulatedLength: 0,
        };
        this.sessionStreams.set(sessionId, streamState);
        frames.push({
          sessionId,
          type: 'turn_started',
          payload: { status: 'running' },
          createdAt: this.getMonotonicIsoTimestamp(),
        });
        break;
      }

      case 'assistant/chunk': {
        const chunk = event.data.chunk;
        if (!chunk) break;

        const streamState = this.getOrCreateStreamState(sessionId);

        if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
          streamState.accumulatedLength += chunk.text.length;
          frames.push({
            sessionId,
            type: 'assistant_delta',
            payload: {
              streamId: streamState.streamId,
              delta: chunk.text,
              accumulatedLength: streamState.accumulatedLength,
            },
            createdAt: this.getMonotonicIsoTimestamp(),
          });
        } else if (chunk.type === 'reasoning-delta') {
          frames.push({
            sessionId,
            type: 'thinking_delta',
            payload: {
              streamId: streamState.streamId,
              status: 'thinking',
            },
            createdAt: this.getMonotonicIsoTimestamp(),
          });
        }
        break;
      }

      case 'tool/call': {
        const streamState = this.getOrCreateStreamState(sessionId);
        const toolName = typeof event.data.name === 'string' ? event.data.name : 'tool';
        streamState.activeToolName = toolName;
        frames.push({
          sessionId,
          type: 'tool_started',
          payload: {
            toolName,
            status: 'started',
          },
          createdAt: this.getMonotonicIsoTimestamp(),
        });
        break;
      }

      case 'tool/result': {
        const streamState = this.getOrCreateStreamState(sessionId);
        const toolName = streamState.activeToolName || 'tool';
        const hasError = Boolean(event.data.error);
        frames.push({
          sessionId,
          type: 'tool_completed',
          payload: {
            toolName,
            status: hasError ? 'failed' : 'completed',
          },
          createdAt: this.getMonotonicIsoTimestamp(),
        });
        streamState.activeToolName = undefined;
        break;
      }

      case 'assistant/message': {
        const streamState = this.getOrCreateStreamState(sessionId);
        frames.push({
          sessionId,
          type: 'assistant_stream_end',
          payload: {
            streamId: streamState.streamId,
          },
          createdAt: this.getMonotonicIsoTimestamp(),
        });
        break;
      }

      case 'turn/end': {
        const reasonKind = event.data.reason?.kind;
        const streamState = this.sessionStreams.get(sessionId);

        if (streamState) {
          frames.push({
            sessionId,
            type: 'assistant_stream_end',
            payload: {
              streamId: streamState.streamId,
            },
            createdAt: this.getMonotonicIsoTimestamp(),
          });
        }

        if (reasonKind === 'aborted' || reasonKind === 'interrupted') {
          frames.push({
            sessionId,
            type: 'turn_cancelled',
            payload: {
              status: 'interrupted',
              code: 'TURN_CANCELLED',
            },
            createdAt: this.getMonotonicIsoTimestamp(),
          });
        } else if (reasonKind === 'error' || reasonKind === 'blocked') {
          frames.push({
            sessionId,
            type: 'turn_failed',
            payload: {
              status: 'failed',
              code: 'TURN_FAILED',
            },
            createdAt: this.getMonotonicIsoTimestamp(),
          });
        } else {
          frames.push({
            sessionId,
            type: 'turn_completed',
            payload: {
              status: 'completed',
            },
            createdAt: this.getMonotonicIsoTimestamp(),
          });
        }

        this.sessionStreams.delete(sessionId);
        break;
      }
    }

    if (frames.length > 0) {
      for (const f of frames) {
        this.mappedFrameCounts[f.type] = (this.mappedFrameCounts[f.type] || 0) + 1;
      }
      this.enqueueOutboundFrames(frames);
    }
  }

  private enqueueOutboundFrames(frames: ContainerStreamingEventFrame[]): void {
    for (const frame of frames) {
      const estimatedBytes = JSON.stringify(frame).length;

      // Backpressure check: if pending bytes exceed maxPendingBytes (256KB),
      // drop intermediate assistant_delta frames to avoid memory exhaustion
      if (this.pendingOutboundBytes + estimatedBytes > this.maxPendingBytes) {
        if (frame.type === 'assistant_delta') {
          this.droppedDeltaCount++;
          continue;
        } else {
          // For non-delta control frames, drop oldest assistant_delta from buffer if needed
          while (
            this.pendingOutboundBytes + estimatedBytes > this.maxPendingBytes &&
            this.pendingOutboundFrames.length > 0
          ) {
            const deltaIdx = this.pendingOutboundFrames.findIndex((f) => f.type === 'assistant_delta');
            if (deltaIdx >= 0) {
              const dropped = this.pendingOutboundFrames.splice(deltaIdx, 1)[0];
              this.pendingOutboundBytes -= JSON.stringify(dropped).length;
              this.droppedDeltaCount++;
            } else {
              break;
            }
          }
        }
      }

      this.pendingOutboundFrames.push(frame);
      this.pendingOutboundBytes += estimatedBytes;
    }

    // Trigger immediate flush if batch size threshold reached
    if (this.pendingOutboundBytes >= this.maxBatchSizeBytes) {
      void this.flushOutbound().catch((flushErr: unknown) => {
        this.recordFlushFailure(flushErr);
      });
    }
  }

  private async flushOutbound(): Promise<void> {
    if (this.isFlushing || this.pendingOutboundFrames.length === 0) {
      return;
    }
    this.isFlushing = true;

    try {
      while (this.pendingOutboundFrames.length > 0) {
        const batch = this.pendingOutboundFrames.splice(0, 100);
        let batchBytes = 0;
        for (const f of batch) {
          batchBytes += JSON.stringify(f).length;
        }
        this.pendingOutboundBytes = Math.max(0, this.pendingOutboundBytes - batchBytes);

        const client = this.platformClient;
        if (client && typeof client.request === 'function') {
          try {
            const res = await client.request('/api/events', {
              method: 'POST',
              body: { events: batch },
            });
            const statusKey = String((res && typeof res === 'object' && 'status' in res) ? res.status : 200);
            this.platformPostStatusCounts[statusKey] = (this.platformPostStatusCounts[statusKey] || 0) + 1;
            this.flushCount++;
          } catch (reqErr: unknown) {
            this.platformPostStatusCounts['network_error'] = (this.platformPostStatusCounts['network_error'] || 0) + 1;
            this.recordFlushFailure(reqErr);
          }
        }
      }
    } finally {
      this.isFlushing = false;
    }
  }

  async flush(): Promise<void> {
    await this.flushOutbound();
  }

  feedHistoricalEvents(session: Session, events: readonly SessionEvent[]): number {
    const sessionId = session.id as string;
    return this.buffer.feedHistoricalEvents(sessionId, events);
  }

  async poll(options: PollEventsOptions): Promise<PollEventsResult> {
    if (!options.sessionId || options.sessionId.trim().length === 0) {
      throw new EventRelayValidationError('sessionId is required for poll()');
    }

    const sessionId = options.sessionId.trim();

    // Query receiptStore for acknowledged cursor if not known
    let ackedCursor: string | null = null;
    const store = this.receiptStore;
    if (store) {
      const stored = await store.getEventCursor(sessionId, this.consumer);
      if (stored) {
        ackedCursor = stored.cursorValue;
        this.buffer.setAcknowledgedSeq(sessionId, parseCursorSeq(stored.cursorValue));
      }
    }

    const effectiveAfterCursor = options.afterCursor ?? (ackedCursor ?? undefined);

    const result = this.buffer.poll({
      sessionId,
      afterCursor: effectiveAfterCursor,
      limit: options.limit,
    });

    return {
      ...result,
      acknowledgedCursor: ackedCursor ?? result.acknowledgedCursor,
    };
  }

  async ack(sessionId: string, cursor: string, consumer?: string): Promise<void> {
    if (!sessionId || sessionId.trim().length === 0) {
      throw new EventRelayValidationError('sessionId is required for ack()');
    }
    if (!cursor || cursor.trim().length === 0) {
      throw new EventRelayValidationError('cursor is required for ack()');
    }

    const targetSessionId = sessionId.trim();
    const targetConsumer = consumer ?? this.consumer;

    // 1. Persist to receiptStore first (FAIL LOUD - do not catch/swallow).
    // If persistence throws, execution stops immediately and buffer is NOT trimmed.
    const store = this.receiptStore;
    if (store) {
      await store.setEventCursor({
        sessionId: targetSessionId,
        consumer: targetConsumer,
        cursorValue: cursor,
      });
    }

    // 2. Trim in-memory buffer ONLY after persistent store successfully records cursor
    this.buffer.ack(targetSessionId, cursor);
  }

  async getAcknowledgedCursor(sessionId: string, consumer?: string): Promise<string | null> {
    if (!sessionId || sessionId.trim().length === 0) {
      throw new EventRelayValidationError('sessionId is required');
    }

    const targetSessionId = sessionId.trim();
    const targetConsumer = consumer ?? this.consumer;

    const store = this.receiptStore;
    if (store) {
      const stored = await store.getEventCursor(targetSessionId, targetConsumer);
      if (stored) {
        return stored.cursorValue;
      }
    }

    const inMemSeq = this.buffer.getAcknowledgedSeq(targetSessionId);
    return inMemSeq > 0 ? `${targetSessionId}:${inMemSeq}` : null;
  }

  subscribe(listener: RelaySubscriber): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  clear(): void {
    this.isDisposed = true;
    this.stopBatchTimer();
    this.pendingOutboundFrames = [];
    this.pendingOutboundBytes = 0;
    this.sessionStreams.clear();
    this.buffer.clear();
    this.subscribers.clear();
  }
}
