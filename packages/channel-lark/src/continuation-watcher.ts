/**
 * Continuation Watcher for autonomous background/follow-up turns.
 * Polls StreamEventSource after turn completion for up to 15 minutes of inactivity.
 * When turn_status running is observed with no active inbound tracker, opens a new streaming card
 * and streams deltas to Feishu, finalizing with status and recording a delivered outbox item.
 *
 * @module @enkeep/channel-lark/continuation-watcher
 */

import { randomUUID, createHash } from 'node:crypto';
import type { TenantScopedChannelRepository } from '@enkeep/platform-core';
import type { LarkTransport, OutboundReplyPayload, StreamEventSource } from './types.js';
import { StreamingReplyTracker } from './streaming-tracker.js';

export interface ContinuationTarget {
  chatId: string;
  replyToMessageId?: string;
  rootId?: string;
  threadId?: string;
  nativeContextId?: string;
}

export interface ContinuationWatcherOptions {
  sessionRouteId: string;
  accountId: string;
  userId: string;
  nativeContextId: string;
  streamEventSource: StreamEventSource;
  transport: LarkTransport;
  channelRepo: TenantScopedChannelRepository;
  replyTarget: ContinuationTarget;
  initialCursor?: number;
  hasActiveInboundTracker: (routeId: string) => boolean;
  deriveOutboxId?: (turnId: string) => string;
  pollIntervalMs?: number;
  inactivityTimeoutMs?: number;
  onStopped?: () => void;
}

export class ContinuationWatcher {
  private readonly sessionRouteId: string;
  private readonly accountId: string;
  private readonly userId: string;
  private readonly nativeContextId: string;
  private readonly streamEventSource: StreamEventSource;
  private readonly transport: LarkTransport;
  private readonly channelRepo: TenantScopedChannelRepository;
  private replyTarget: ContinuationTarget;
  private readonly hasActiveInboundTracker: (routeId: string) => boolean;
  private readonly deriveOutboxId?: (turnId: string) => string;
  private readonly pollIntervalMs: number;
  private readonly inactivityTimeoutMs: number;
  private readonly onStopped?: () => void;

  private cursor = 0;
  private cursorInitialized = false;
  private timer: NodeJS.Timeout | null = null;
  private isStopped = false;
  private lastActivityTime = 0;
  private isTicking = false;
  private activeTracker: StreamingReplyTracker | null = null;

  constructor(options: ContinuationWatcherOptions) {
    this.sessionRouteId = options.sessionRouteId;
    this.accountId = options.accountId;
    this.userId = options.userId;
    this.nativeContextId = options.nativeContextId;
    this.streamEventSource = options.streamEventSource;
    this.transport = options.transport;
    this.channelRepo = options.channelRepo;
    this.replyTarget = options.replyTarget;
    this.hasActiveInboundTracker = options.hasActiveInboundTracker;
    this.deriveOutboxId = options.deriveOutboxId;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? 15 * 60 * 1000;
    this.onStopped = options.onStopped;

    if (options.initialCursor !== undefined) {
      this.cursor = options.initialCursor;
      this.cursorInitialized = true;
      console.info('[lark-cont] cursor snapshotted', { routeId: this.sessionRouteId, cursor: this.cursor });
    }
  }

  getCursor(): number {
    return this.cursor;
  }

  isActive(): boolean {
    return !this.isStopped;
  }

  getActiveTracker(): StreamingReplyTracker | null {
    return this.activeTracker;
  }

  start(): void {
    if (this.isStopped) return;
    this.lastActivityTime = Date.now();

    const interval = setInterval(() => {
      void this.pollTick();
    }, this.pollIntervalMs);

    if (typeof interval.unref === 'function') {
      interval.unref();
    }
    this.timer = interval;

    void this.pollTick();
  }

  extend(newCursor?: number, newReplyTarget?: ContinuationTarget): void {
    if (this.isStopped) return;
    this.lastActivityTime = Date.now();
    if (newCursor !== undefined) {
      this.cursorInitialized = true;
      if (newCursor > this.cursor) {
        this.cursor = newCursor;
      }
    }
    if (newReplyTarget) {
      this.replyTarget = newReplyTarget;
    }
  }

  stop(reason = 'manual'): void {
    if (this.isStopped) return;
    this.isStopped = true;
    console.info('[lark-cont] watcher stopped', { routeId: this.sessionRouteId, reason });
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.activeTracker) {
      this.activeTracker.stop();
      this.activeTracker = null;
    }
    if (this.onStopped) {
      try {
        this.onStopped();
      } catch {}
    }
  }

  private async pollTick(): Promise<void> {
    if (this.isStopped || this.isTicking) {
      return;
    }

    if (Date.now() - this.lastActivityTime > this.inactivityTimeoutMs) {
      this.stop('inactivity_timeout');
      return;
    }

    this.isTicking = true;
    try {
      if (!this.cursorInitialized) {
        this.cursorInitialized = true;
        if (typeof this.streamEventSource.getLatestRowId === 'function') {
          try {
            const latest = await this.streamEventSource.getLatestRowId(this.sessionRouteId);
            this.cursor = latest;
          } catch {}
        }
        console.info('[lark-cont] cursor initialized', { routeId: this.sessionRouteId, cursor: this.cursor });
      }

      // If an active continuation tracker is running:
      if (this.activeTracker) {
        if (!this.activeTracker.isSettled()) {
          this.lastActivityTime = Date.now();
          return;
        }
        this.cursor = Math.max(this.cursor, this.activeTracker.getCursor());
        this.activeTracker = null;
        this.lastActivityTime = Date.now();
      }

      // Guard against double delivery: if an inbound tracker is currently handling this route,
      // do not open a continuation card. Advance cursor past any events and return.
      if (this.hasActiveInboundTracker(this.sessionRouteId)) {
        const events = await this.streamEventSource.listAssistantEvents(
          this.sessionRouteId,
          this.cursor
        );
        if (events.length > 0) {
          for (const evt of events) {
            if (evt.rowId > this.cursor) {
              this.cursor = evt.rowId;
            }
          }
          this.lastActivityTime = Date.now();
        }
        return;
      }

      const events = await this.streamEventSource.listAssistantEvents(
        this.sessionRouteId,
        this.cursor
      );

      if (this.isStopped) return;

      if (events.length === 0) {
        return;
      }

      console.info('[lark-cont] events fetched', {
        routeId: this.sessionRouteId,
        count: events.length,
        firstRowId: events[0].rowId,
        lastRowId: events[events.length - 1].rowId,
      });

      this.lastActivityTime = Date.now();

      const runningEvt = events.find((e) => e.type === 'turn_status' && e.status === 'running');
      if (runningEvt) {
        if (typeof this.streamEventSource.hasPendingPlatformTurn === 'function') {
          let hasPending = false;
          try {
            hasPending = await this.streamEventSource.hasPendingPlatformTurn(this.sessionRouteId);
          } catch {}
          if (this.isStopped) return;
          if (hasPending) {
            console.info('[lark-cont] running belongs to platform turn, skipped');
            if (runningEvt.rowId > this.cursor) {
              this.cursor = runningEvt.rowId;
            }
            return;
          }
        }

        console.info('[lark-cont] running detected -> tracker created', {
          routeId: this.sessionRouteId,
          rowId: runningEvt.rowId,
        });
        const tracker = new StreamingReplyTracker({
          transport: this.transport,
          streamEventSource: this.streamEventSource,
          sessionRouteId: this.sessionRouteId,
          cardParams: {
            chatId: this.replyTarget.chatId,
            replyToMessageId: this.replyTarget.replyToMessageId,
            rootId: this.replyTarget.rootId,
            threadId: this.replyTarget.threadId,
          },
          initialCursor: this.cursor,
          pollIntervalMs: this.pollIntervalMs,
          detached: true,
          onFinalized: async (finalText: string, status: 'completed' | 'failed', messageId?: string) => {
            console.info('[lark-cont] tracker finalize result', {
              routeId: this.sessionRouteId,
              status,
              messageId,
            });
            await this.recordOutboxDelivery(finalText, status, messageId);
            if (!this.isStopped) {
              void this.pollTick();
            }
          },
        });

        this.activeTracker = tracker;
        tracker.start();
      } else {
        for (const evt of events) {
          if (evt.rowId > this.cursor) {
            this.cursor = evt.rowId;
          }
        }
      }
    } catch (err) {
      console.warn('[lark-stream] watcher pollTick error', {
        code: (err as any)?.code,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.isTicking = false;
    }
  }

  private async recordOutboxDelivery(
    finalText: string,
    status: 'completed' | 'failed',
    messageId?: string
  ): Promise<void> {
    try {
      const turnKey = `cont_${messageId || randomUUID().replace(/-/g, '').slice(0, 16)}`;
      let outboxId: string;
      if (this.deriveOutboxId) {
        outboxId = this.deriveOutboxId(turnKey);
      } else {
        const hash = createHash('sha256')
          .update(`${this.userId}:${this.accountId}:${turnKey}`)
          .digest('hex')
          .slice(0, 24);
        outboxId = `out_${hash}`;
      }

      const payload: OutboundReplyPayload = {
        text: finalText,
        format: 'markdown',
        chatId: this.replyTarget.chatId,
        rootId: this.replyTarget.rootId,
        threadId: this.replyTarget.threadId,
        replyToMessageId: this.replyTarget.replyToMessageId,
        turnId: turnKey,
        messageId,
      };

      await this.channelRepo.createOutboxItem({
        id: outboxId,
        accountId: this.accountId,
        sessionId: this.sessionRouteId,
        nativeContextId: this.replyTarget.nativeContextId || this.nativeContextId,
        replyToNativeId: this.replyTarget.replyToMessageId ?? null,
        payloadJson: JSON.stringify(payload),
        status: 'delivered',
      });
    } catch {
      // Best-effort outbox recording
    }
  }
}
