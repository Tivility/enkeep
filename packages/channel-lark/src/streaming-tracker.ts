/**
 * Streaming Reply Tracker for Lark Interactive Cards.
 * Polls SQLite web_events for assistant_delta, assistant_stream_end, and turn_status,
 * pushing deltas to active LarkStreamingCardSession, and handling finalization.
 *
 * @module @enkeep/channel-lark/streaming-tracker
 */

import type {
  LarkStreamingCardSession,
  LarkTransport,
  StreamEventSource,
} from './types.js';

export interface StreamingReplyTrackerCardParams {
  chatId: string;
  replyToMessageId?: string;
  rootId?: string;
  threadId?: string;
  title?: string;
}

export interface StreamingReplyTrackerOptions {
  transport: LarkTransport;
  streamEventSource: StreamEventSource;
  sessionRouteId: string;
  cardParams: StreamingReplyTrackerCardParams;
  pollIntervalMs?: number;
  maxDurationMs?: number;
  initialCursor?: number;
  detached?: boolean;
  onFinalized?: (finalText: string, status: 'completed' | 'failed', messageId?: string) => Promise<void> | void;
  turnId?: string;
}

export class StreamingReplyTracker {
  private readonly transport: LarkTransport;
  private readonly streamEventSource: StreamEventSource;
  private readonly sessionRouteId: string;
  private readonly cardParams: StreamingReplyTrackerCardParams;
  private readonly pollIntervalMs: number;
  private readonly maxDurationMs: number;
  private readonly detached: boolean;
  private readonly onFinalized?: (finalText: string, status: 'completed' | 'failed', messageId?: string) => Promise<void> | void;
  private readonly turnId?: string;
  private isWaiting = false;

  private cardSessionPromise: Promise<LarkStreamingCardSession | null> | null = null;
  private cardSession: LarkStreamingCardSession | null = null;
  private timer: NodeJS.Timeout | null = null;
  private isStopped = false;
  private terminalReached = false;
  private cursorInitialized = false;
  private cursor = 0;
  private accumulatedText = '';
  private lastPushedText = '';
  private readonly runningTools = new Map<string, number>();
  private currentStreamId: string | null = null;
  private streamEnded = false;
  private startTime = 0;
  private inFlightTick: Promise<void> | null = null;
  private finalizedResult: { handled: boolean; messageId?: string; degraded?: boolean } | null = null;
  private seenOwnRunning = false;

  constructor(options: StreamingReplyTrackerOptions) {
    this.transport = options.transport;
    this.streamEventSource = options.streamEventSource;
    this.sessionRouteId = options.sessionRouteId;
    this.cardParams = options.cardParams;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.maxDurationMs = options.maxDurationMs ?? 600_000;
    this.detached = options.detached ?? false;
    this.onFinalized = options.onFinalized;
    this.turnId = options.turnId;
    this.isWaiting = !this.detached && Boolean(this.turnId && typeof this.streamEventSource.getPlatformTurnState === 'function');
    if (this.isWaiting) {
      this.cursor = 0;
      this.cursorInitialized = false;
    } else {
      this.cursor = options.initialCursor ?? 0;
      this.cursorInitialized = options.initialCursor !== undefined;
    }
  }

  getCursor(): number {
    return this.cursor;
  }

  getAccumulatedText(): string {
    return this.accumulatedText;
  }

  getRouteId(): string {
    return this.sessionRouteId;
  }

  isActive(): boolean {
    return !this.isStopped && !this.terminalReached;
  }

  isSettled(): boolean {
    return this.finalizedResult !== null || (this.isStopped && !this.inFlightTick);
  }

  private initStreamingCard(): void {
    if (this.cardSessionPromise) return;
    if (this.transport.createStreamingCard) {
      this.cardSessionPromise = this.transport.createStreamingCard(this.cardParams).then(
        (session) => {
          this.cardSession = session;
          return session;
        },
        () => {
          console.info('[lark-cont] createStreamingCard returned null');
          this.cardSession = null;
          return null;
        }
      );
    } else {
      console.info('[lark-cont] createStreamingCard returned null');
      this.cardSessionPromise = Promise.resolve(null);
    }
  }

  start(): void {
    if (this.isStopped) return;
    this.startTime = Date.now();

    if (!this.isWaiting) {
      this.initStreamingCard();
    }

    const interval = setInterval(() => {
      void this.pollTick();
    }, this.pollIntervalMs);

    if (typeof interval.unref === 'function') {
      interval.unref();
    }
    this.timer = interval;

    // Trigger an immediate initial tick
    void this.pollTick();
  }

  private processEvents(
    events: Array<{
      rowId: number;
      type: 'assistant_delta' | 'assistant_stream_end' | 'turn_status' | 'tool_status';
      delta?: string;
      streamId?: string;
      status?: string;
      toolName?: string;
    }>
  ): { terminalStatus?: 'completed' | 'failed' } {
    let terminalStatus: 'completed' | 'failed' | undefined;

    for (const evt of events) {
      if (evt.type === 'turn_status' && evt.status === 'running') {
        if (this.seenOwnRunning) {
          // Do not consume or advance cursor past a subsequent turn's running event
          break;
        }
        this.seenOwnRunning = true;
      }

      if (evt.rowId > this.cursor) {
        this.cursor = evt.rowId;
      }

      if (evt.type === 'assistant_delta' && typeof evt.delta === 'string') {
        const streamId = evt.streamId;
        // When a new streamId starts after a stream_end, append paragraph break (\n\n) between segments
        if (
          this.streamEnded &&
          streamId &&
          this.currentStreamId &&
          streamId !== this.currentStreamId &&
          this.accumulatedText.length > 0
        ) {
          this.accumulatedText += '\n\n';
        }
        if (streamId) {
          this.currentStreamId = streamId;
        }
        this.streamEnded = false;
        this.accumulatedText += evt.delta;
      } else if (evt.type === 'assistant_stream_end') {
        this.streamEnded = true;
        if (evt.streamId) {
          this.currentStreamId = evt.streamId;
        }
      } else if (evt.type === 'tool_status') {
        const name = evt.toolName || 'subagent';
        const current = this.runningTools.get(name) ?? 0;
        if (evt.status === 'started') {
          this.runningTools.set(name, current + 1);
        } else if (evt.status === 'completed' || evt.status === 'failed') {
          this.runningTools.set(name, Math.max(0, current - 1));
        }
      } else if (evt.type === 'turn_status') {
        if (evt.status === 'completed' || evt.status === 'failed') {
          terminalStatus = evt.status;
          break;
        }
      }
    }

    return { terminalStatus };
  }

  private async pollTick(): Promise<void> {
    if (this.isStopped || this.inFlightTick || this.terminalReached) return;

    if (Date.now() - this.startTime > this.maxDurationMs) {
      this.stop();
      return;
    }

    this.inFlightTick = (async () => {
      try {
        if (this.isWaiting) {
          const state = await this.streamEventSource.getPlatformTurnState!(
            this.sessionRouteId,
            this.turnId!
          );

          if (this.isStopped) return;

          if (state === 'queued') {
            return;
          }

          if (state === 'unknown') {
            if (Date.now() - this.startTime <= 10_000) {
              return;
            }
            this.stop();
            return;
          }

          if (state === 'running') {
            this.isWaiting = false;
            if (typeof this.streamEventSource.getLatestRowId === 'function') {
              try {
                this.cursor = await this.streamEventSource.getLatestRowId(this.sessionRouteId);
              } catch {}
            }
            this.cursorInitialized = true;
            this.initStreamingCard();
          } else {
            this.stop();
            return;
          }
        }

        if (!this.cursorInitialized) {
          this.cursorInitialized = true;
          if (typeof this.streamEventSource.getLatestRowId === 'function') {
            try {
              const latest = await this.streamEventSource.getLatestRowId(this.sessionRouteId);
              if (latest > this.cursor) {
                this.cursor = latest;
              }
            } catch {}
          }
        }

        const events = await this.streamEventSource.listAssistantEvents(
          this.sessionRouteId,
          this.cursor
        );

        if (this.isStopped) return;

        const { terminalStatus } = this.processEvents(events);

        if (terminalStatus) {
          this.terminalReached = true;
          if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
          }
        }

        // Wait for card session to be available if still pending
        const session = this.cardSession ?? (await this.cardSessionPromise);
        if (session && !this.isStopped) {
          const subagentCount = this.runningTools.get('subagent') ?? 0;
          const textToPush =
            subagentCount > 0
              ? `${this.accumulatedText}\n\n---\n⏳ 后台任务运行中：subagent ×${subagentCount}`
              : this.accumulatedText;
          if (textToPush && textToPush.trim().length > 0 && textToPush !== this.lastPushedText) {
            this.lastPushedText = textToPush;
            await session.pushText(textToPush);
          }
        }

        // In detached mode, terminal turn_status triggers finalization
        if (this.detached && terminalStatus && !this.isStopped) {
          const finalText = this.accumulatedText || (terminalStatus === 'failed' ? 'Execution failed' : '');
          await this.doFinalize(finalText, terminalStatus);
        }
      } catch (err) {
        console.warn('[lark-stream] tracker pollTick error', {
          code: (err as any)?.code,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.inFlightTick = null;
      }
    })();

    await this.inFlightTick;
  }

  stop(): void {
    this.isStopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async doFinalize(
    finalText: string,
    status: 'completed' | 'failed'
  ): Promise<{ handled: boolean; messageId?: string; degraded?: boolean }> {
    if (this.finalizedResult) {
      return this.finalizedResult;
    }
    this.stop();

    if (this.detached) {
      console.info('[lark-cont] detached finalize entry', {
        routeId: this.sessionRouteId,
        status,
        textLength: finalText.length,
      });
    }

    if (this.isWaiting || !this.cardSessionPromise) {
      console.info('[lark-cont] createStreamingCard returned null');
      this.finalizedResult = { handled: false };
      return this.finalizedResult;
    }

    let session: LarkStreamingCardSession | null = null;
    try {
      session = await this.cardSessionPromise;
    } catch {
      console.info('[lark-cont] createStreamingCard returned null');
      this.finalizedResult = { handled: false };
      return this.finalizedResult;
    }

    if (!session) {
      console.info('[lark-cont] createStreamingCard returned null');
      this.finalizedResult = { handled: false };
      return this.finalizedResult;
    }

    // Flush any pending deltas before finalizing, only if terminal was not already reached
    if (!this.terminalReached) {
      try {
        const events = await this.streamEventSource.listAssistantEvents(
          this.sessionRouteId,
          this.cursor
        );
        const { terminalStatus } = this.processEvents(events);
        if (terminalStatus) {
          this.terminalReached = true;
        }
        const subagentCount = this.runningTools.get('subagent') ?? 0;
        const textToPush =
          subagentCount > 0
            ? `${this.accumulatedText}\n\n---\n⏳ 后台任务运行中：subagent ×${subagentCount}`
            : this.accumulatedText;
        if (textToPush && textToPush.trim().length > 0 && textToPush !== this.lastPushedText) {
          this.lastPushedText = textToPush;
          await session.pushText(textToPush);
        }
      } catch {}
    }

    const textToFinalize = finalText || this.accumulatedText || (status === 'failed' ? 'Execution failed' : '');

    try {
      await session.finalize(textToFinalize, status);
      const res = { handled: true, messageId: session.messageId };
      this.finalizedResult = res;
      if (this.detached) {
        console.info('[lark-cont] detached finalize exit', {
          routeId: this.sessionRouteId,
          handled: true,
          degraded: false,
          messageId: session.messageId,
        });
      }
      if (this.onFinalized) {
        try {
          await this.onFinalized(textToFinalize, status, session.messageId);
        } catch {}
      }
      return res;
    } catch (finalizeErr) {
      console.warn('[lark-stream] session.finalize error, falling back to pushText', {
        code: (finalizeErr as any)?.code,
        message: finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr),
      });
      if (textToFinalize && textToFinalize.trim().length > 0) {
        try {
          await session.pushText(textToFinalize);
        } catch (pushErr) {
          console.warn('[lark-stream] pushText fallback error', {
            code: (pushErr as any)?.code,
            message: pushErr instanceof Error ? pushErr.message : String(pushErr),
          });
        }
      }
      const res = { handled: true, messageId: session.messageId, degraded: true };
      this.finalizedResult = res;
      if (this.detached) {
        console.info('[lark-cont] detached finalize exit', {
          routeId: this.sessionRouteId,
          handled: true,
          degraded: true,
          messageId: session.messageId,
        });
      }
      if (this.onFinalized) {
        try {
          await this.onFinalized(textToFinalize, status, session.messageId);
        } catch {}
      }
      return res;
    }
  }

  async finalize(
    finalText: string,
    status: 'completed' | 'failed'
  ): Promise<{ handled: boolean; messageId?: string; degraded?: boolean }> {
    if (this.finalizedResult) {
      return this.finalizedResult;
    }
    this.stop();

    if (this.inFlightTick) {
      try {
        await this.inFlightTick;
      } catch {}
    }

    return this.doFinalize(finalText, status);
  }
}
