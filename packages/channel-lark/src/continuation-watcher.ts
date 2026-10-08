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
import type { LarkBackgroundPanelManager } from './background-panel.js';
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
  backgroundPanelManager?: LarkBackgroundPanelManager;
}

const envBudget =
  process.env.ENKEEP_EXECUTION_BUDGET_MS ||
  process.env.ENKEEP_INTERACTIVE_TURN_TIMEOUT_MS ||
  process.env.DSH_DEFAULT_EXECUTION_BUDGET_MS;
const parsedBudget = envBudget ? parseInt(envBudget, 10) : NaN;
export const DEFAULT_CONTINUATION_INACTIVITY_TIMEOUT_MS =
  Number.isSafeInteger(parsedBudget) && parsedBudget > 0 ? parsedBudget : 3_600_000;

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
  private readonly backgroundPanelManager?: LarkBackgroundPanelManager;

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
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_CONTINUATION_INACTIVITY_TIMEOUT_MS;
    this.onStopped = options.onStopped;
    this.backgroundPanelManager = options.backgroundPanelManager;
    this.lastActivityTime = Date.now();

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
    if (newCursor !== undefined && newCursor > 0) {
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

      // Guard against double delivery: if an inbound tracker is currently handling this route,
      // do not open a continuation card. Advance cursor past events to avoid double-processing.
      if (this.hasActiveInboundTracker(this.sessionRouteId)) {
        this.cursor = events[events.length - 1].rowId;
        return;
      }

      const runningEvt = events.find((e) => e.type === 'turn_status' && e.status === 'running');
      if (runningEvt) {
        // 1. Turn ownership verification: if turnId belongs to a known platform turn (running, queued, or completed),
        // it must NOT be replayed as an autonomous continuation.
        if (runningEvt.turnId && typeof this.streamEventSource.getPlatformTurnState === 'function') {
          let platformState: string | undefined;
          try {
            platformState = await this.streamEventSource.getPlatformTurnState(this.sessionRouteId, runningEvt.turnId);
          } catch {}
          if (this.isStopped) return;
          if (platformState === 'running' || platformState === 'queued' || platformState === 'completed') {
            console.info('[lark-cont] turn belongs to platform turn ownership, skipping continuation replay', {
              turnId: runningEvt.turnId,
              platformState,
            });
            // Advance cursor past this turn's terminal event if completed to prevent leftover deltas
            const turnTerminal = events.find(
              (e) => e.turnId === runningEvt.turnId && e.type === 'turn_status' && (e.status === 'completed' || e.status === 'failed')
            );
            const skipToRowId = turnTerminal ? turnTerminal.rowId : runningEvt.rowId;
            if (skipToRowId > this.cursor) {
              this.cursor = skipToRowId;
            }
            return;
          }
        }

        // Fallback platform turn check if turnId was not stamped on event
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

        // 2. Causal origin resolution: autonomous turns must route only to their causal initiating turn
        let targetCardParams = {
          chatId: this.replyTarget.chatId,
          replyToMessageId: this.replyTarget.replyToMessageId,
          rootId: this.replyTarget.rootId,
          threadId: this.replyTarget.threadId,
        };

        if (runningEvt.originTurnId) {
          if (typeof this.streamEventSource.resolveTurnOrigin === 'function') {
            const origin = await this.streamEventSource.resolveTurnOrigin(runningEvt.originTurnId, this.sessionRouteId);
            if (!origin) {
              console.warn('[lark-cont] unknown causal origin for autonomous turn, aborting delivery to prevent wrong target send', {
                originTurnId: runningEvt.originTurnId,
                routeId: this.sessionRouteId,
              });
              if (runningEvt.rowId > this.cursor) {
                this.cursor = runningEvt.rowId;
              }
              return;
            }
            targetCardParams = {
              chatId: origin.chatId,
              replyToMessageId: origin.replyToMessageId || undefined,
              rootId: origin.rootId || undefined,
              threadId: origin.threadId || undefined,
            };
          }
        } else if (runningEvt.turnId) {
          let origin: any = null;
          if (typeof this.streamEventSource.resolveTurnOrigin === 'function') {
            origin = await this.streamEventSource.resolveTurnOrigin(runningEvt.turnId, this.sessionRouteId);
          }
          if (origin) {
            targetCardParams = {
              chatId: origin.chatId,
              replyToMessageId: origin.replyToMessageId || undefined,
              rootId: origin.rootId || undefined,
              threadId: origin.threadId || undefined,
            };
          } else {
            // Autonomous turn detected without causal origin metadata: fail explicitly, do not send to wrong target
            console.warn('[lark-cont] autonomous turn missing originTurnId causal metadata, aborting delivery to prevent wrong target send', {
              turnId: runningEvt.turnId,
              routeId: this.sessionRouteId,
            });
            if (runningEvt.rowId > this.cursor) {
              this.cursor = runningEvt.rowId;
            }
            return;
          }
        }

        const causeChildId = (runningEvt as any).causeChildId;
        const outboxId = runningEvt.originTurnId
          ? `cont_${runningEvt.originTurnId}_${causeChildId || runningEvt.turnId}`
          : (this.deriveOutboxId?.(`cont_row_${runningEvt.rowId}`) ?? `cont_${runningEvt.turnId || `row_${runningEvt.rowId}`}`);

        if (typeof this.channelRepo.findOutboxById === 'function') {
          const existing = await this.channelRepo.findOutboxById(outboxId).catch(() => null);
          if (this.isStopped) return;
          if (existing) {
            console.info('[lark-cont] duplicate continuation skipped', { outboxId, routeId: this.sessionRouteId });
            const term = events.find((e) => (runningEvt.turnId ? e.turnId === runningEvt.turnId : e.rowId >= runningEvt.rowId) &&
              e.type === 'turn_status' && (e.status === 'completed' || e.status === 'failed'));
            const skipTo = term ? term.rowId : runningEvt.rowId;
            if (skipTo > this.cursor) this.cursor = skipTo;
            return;
          }
        }

        console.info('[lark-cont] running detected -> tracker created', {
          routeId: this.sessionRouteId,
          rowId: runningEvt.rowId,
          originTurnId: runningEvt.originTurnId,
        });
        const tracker = new StreamingReplyTracker({
          transport: this.transport,
          streamEventSource: this.streamEventSource,
          sessionRouteId: this.sessionRouteId,
          cardParams: targetCardParams,
          initialCursor: this.cursor,
          pollIntervalMs: this.pollIntervalMs,
          detached: true,
          turnId: runningEvt.turnId,
          backgroundPanelManager: this.backgroundPanelManager,
          onFinalized: async (finalText: string, status: 'completed' | 'failed', messageId?: string) => {
            console.info('[lark-cont] tracker finalize result', {
              routeId: this.sessionRouteId,
              status,
              messageId,
            });
            await this.recordOutboxDelivery(finalText, status, messageId, outboxId, targetCardParams);
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
    messageId: string | undefined,
    outboxId: string,
    targetOverride?: ContinuationTarget
  ): Promise<void> {
    try {
      const target = targetOverride ?? this.replyTarget;
      const payload: OutboundReplyPayload = {
        text: finalText,
        format: 'markdown',
        chatId: target.chatId,
        rootId: target.rootId,
        threadId: target.threadId,
        replyToMessageId: target.replyToMessageId,
        turnId: outboxId,
        messageId,
      };

      await this.channelRepo.createOutboxItem({
        id: outboxId,
        accountId: this.accountId,
        sessionId: this.sessionRouteId,
        nativeContextId: target.nativeContextId || target.chatId,
        replyToNativeId: target.replyToMessageId ?? null,
        payloadJson: JSON.stringify(payload),
        status: 'delivered',
      });
    } catch {
      // Best-effort outbox recording
    }
  }
}
