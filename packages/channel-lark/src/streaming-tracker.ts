/**
 * Streaming Reply Tracker for Lark Interactive Cards.
 * Polls SQLite web_events for assistant_delta, assistant_stream_end, and turn_status,
 * pushing deltas to active LarkStreamingCardSession, and handling finalization.
 *
 * @module @enkeep/channel-lark/streaming-tracker
 */

import type {
  CardFinalMetadata,
  CardToolStatusEntry,
  LarkStreamingCardSession,
  LarkTransport,
  StreamEventSource,
} from './types.js';
import {
  formatToolStatusMarkdown,
  formatThinkingContent,
  stripThinkingTags,
  extractThinkingFromText,
} from './transport.js';

export const STREAMING_MAX_CONTENT_LENGTH = 3800;
export const STREAMING_MAX_LENGTH = STREAMING_MAX_CONTENT_LENGTH;
export const STREAMING_TRUNCATION_NOTICE = '... (内容超长，流式阶段仅展示最新部分，完整内容将在生成完毕后呈现)\n\n';

const envBudget =
  process.env.ENKEEP_EXECUTION_BUDGET_MS ||
  process.env.ENKEEP_INTERACTIVE_TURN_TIMEOUT_MS ||
  process.env.DSH_DEFAULT_EXECUTION_BUDGET_MS;
const parsedBudget = envBudget ? parseInt(envBudget, 10) : NaN;
export const DEFAULT_STREAMING_MAX_DURATION_MS =
  Number.isSafeInteger(parsedBudget) && parsedBudget > 0 ? parsedBudget : 3_600_000;

/**
 * Guard streaming text to safe maximum length (default 3800 characters) for Feishu CardKit.
 * When text exceeds maxLength, slides a window to display the latest content with a truncation notice,
 * preventing Lark error code 200570 while retaining full text for finalization.
 */
export function applyStreamingLengthGuard(
  text: string,
  maxLength: number = STREAMING_MAX_CONTENT_LENGTH,
  notice: string = STREAMING_TRUNCATION_NOTICE
): string {
  if (text.length <= maxLength) {
    return text;
  }
  if (notice.length >= maxLength) {
    return text.slice(text.length - maxLength);
  }
  const allowed = maxLength - notice.length;
  return notice + text.slice(text.length - allowed);
}

export interface StreamingReplyTrackerCardParams {
  chatId: string;
  replyToMessageId?: string;
  rootId?: string;
  threadId?: string;
  title?: string;
  withStatusPanel?: boolean;
  collapsibleToolStatus?: boolean;
  withThinkingPanel?: boolean;
  collapsibleThinking?: boolean;
  withStopButton?: boolean;
  turnId?: string;
  sessionId?: string;
  enableCot?: boolean;
  cotEnabled?: boolean;
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
  onFinalized?: (finalText: string, status: any, messageId?: string) => Promise<void> | void;
  turnId?: string;
  maxStreamingLength?: number;
  metadata?: CardFinalMetadata;
  withStatusPanel?: boolean;
  collapsibleToolStatus?: boolean;
  withThinkingPanel?: boolean;
  collapsibleThinking?: boolean;
  withStopButton?: boolean;
  senderId?: string;
  enableCot?: boolean;
  cotEnabled?: boolean;
  isCotEnabled?: (chatId?: string) => boolean;
}

/**
 * Extract turn execution metrics (duration, model, tokens, cost) from SQLite database.
 * Strictly avoids fabricated numbers: only returns fields that exist in authoritative records.
 */
export function extractTurnMetricsFromDb(
  db: any,
  sessionRouteId: string,
  turnId: string
): CardFinalMetadata | null {
  if (!db || typeof db.prepare !== 'function' || !turnId) {
    return null;
  }

  try {
    let turnRow: any;
    try {
      turnRow = db
        .prepare('SELECT * FROM turn_runs WHERE (turn_id = ? OR id = ?) AND route_id = ? LIMIT 1')
        .get(turnId, turnId, sessionRouteId);
      if (!turnRow) {
        turnRow = db
          .prepare('SELECT * FROM turn_runs WHERE turn_id = ? OR id = ? LIMIT 1')
          .get(turnId, turnId);
      }
    } catch {}

    let durationSeconds: number | undefined;
    if (turnRow?.started_at && turnRow?.finished_at) {
      const s = new Date(turnRow.started_at).getTime();
      const f = new Date(turnRow.finished_at).getTime();
      if (!isNaN(s) && !isNaN(f) && f >= s) {
        durationSeconds = (f - s) / 1000;
      }
    } else if (turnRow?.created_at && turnRow?.finished_at) {
      const s = new Date(turnRow.created_at).getTime();
      const f = new Date(turnRow.finished_at).getTime();
      if (!isNaN(s) && !isNaN(f) && f >= s) {
        durationSeconds = (f - s) / 1000;
      }
    }

    let model: string | undefined =
      typeof turnRow?.model === 'string' && turnRow.model.trim().length > 0
        ? turnRow.model.trim()
        : undefined;
    let promptTokens: number | undefined =
      typeof turnRow?.prompt_tokens === 'number'
        ? turnRow.prompt_tokens
        : typeof turnRow?.promptTokens === 'number'
          ? turnRow.promptTokens
          : undefined;
    let completionTokens: number | undefined =
      typeof turnRow?.completion_tokens === 'number'
        ? turnRow.completion_tokens
        : typeof turnRow?.completionTokens === 'number'
          ? turnRow.completionTokens
          : undefined;
    let totalTokens: number | undefined =
      typeof turnRow?.total_tokens === 'number'
        ? turnRow.total_tokens
        : typeof turnRow?.totalTokens === 'number'
          ? turnRow.totalTokens
          : undefined;
    let cost: number | undefined =
      typeof turnRow?.cost === 'number' ? turnRow.cost : undefined;

    // Check model overrides if model is not in turn_runs
    if (!model) {
      try {
        const spaceId = turnRow?.space_id ?? '';
        const userId = turnRow?.user_id ?? '';
        const overrideRow = db
          .prepare(
            `SELECT model FROM model_selection_overrides
             WHERE (owner_type = 'session' AND owner_id = ?)
                OR (owner_type = 'space' AND owner_id = ?)
                OR (owner_type = 'user' AND owner_id = ?)
                OR (owner_type = 'platform' AND owner_id = 'default')
             ORDER BY CASE owner_type
               WHEN 'session' THEN 1
               WHEN 'space' THEN 2
               WHEN 'user' THEN 3
               WHEN 'platform' THEN 4
             END LIMIT 1`
          )
          .get(sessionRouteId, spaceId, userId) as { model?: string } | undefined;
        if (overrideRow?.model && overrideRow.model.trim().length > 0) {
          model = overrideRow.model.trim();
        }
      } catch {}
    }

    if (!model) {
      try {
        const cfgRow = db
          .prepare(
            `SELECT model FROM model_config_overrides
             WHERE user_id = ? OR user_id IS NULL
             ORDER BY user_id DESC LIMIT 1`
          )
          .get(turnRow?.user_id ?? '') as { model?: string } | undefined;
        if (cfgRow?.model && cfgRow.model.trim().length > 0) {
          model = cfgRow.model.trim();
        }
      } catch {}
    }

    // Check task_runs if tokens missing
    if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
      try {
        const taskRow = db
          .prepare(
            `SELECT prompt_tokens, completion_tokens, total_tokens
             FROM task_runs
             WHERE id = ? OR task_id = ?
             LIMIT 1`
          )
          .get(turnId, turnId) as
          | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
          | undefined;
        if (taskRow) {
          if (typeof taskRow.prompt_tokens === 'number' && taskRow.prompt_tokens >= 0) {
            promptTokens = taskRow.prompt_tokens;
          }
          if (typeof taskRow.completion_tokens === 'number' && taskRow.completion_tokens >= 0) {
            completionTokens = taskRow.completion_tokens;
          }
          if (typeof taskRow.total_tokens === 'number' && taskRow.total_tokens >= 0) {
            totalTokens = taskRow.total_tokens;
          }
        }
      } catch {}
    }

    // Check quota_bundles for committed tokens
    if (totalTokens === undefined) {
      try {
        const bundleRow = db
          .prepare(
            `SELECT qb.tokens_committed
             FROM quota_bundles qb
             INNER JOIN delivery_inbox di ON di.delivery_id = qb.delivery_id
             WHERE di.turn_id = ? AND qb.status = 'committed'
             LIMIT 1`
          )
          .get(turnId) as { tokens_committed?: number } | undefined;
        if (bundleRow && typeof bundleRow.tokens_committed === 'number' && bundleRow.tokens_committed >= 0) {
          totalTokens = bundleRow.tokens_committed;
        }
      } catch {}
    }

    // Check assistant web_messages metadata
    try {
      const msgRow = db
        .prepare(
          `SELECT metadata FROM web_messages
           WHERE turn_id = ? AND role = 'assistant' AND metadata IS NOT NULL
           LIMIT 1`
        )
        .get(turnId) as { metadata?: string } | undefined;
      if (msgRow?.metadata) {
        const metaObj = JSON.parse(msgRow.metadata);
        if (!model && typeof metaObj.model === 'string' && metaObj.model.trim().length > 0) {
          model = metaObj.model.trim();
        }
        if (metaObj.usage && typeof metaObj.usage === 'object') {
          if (promptTokens === undefined && typeof metaObj.usage.promptTokens === 'number') {
            promptTokens = metaObj.usage.promptTokens;
          }
          if (completionTokens === undefined && typeof metaObj.usage.completionTokens === 'number') {
            completionTokens = metaObj.usage.completionTokens;
          }
          if (totalTokens === undefined && typeof metaObj.usage.totalTokens === 'number') {
            totalTokens = metaObj.usage.totalTokens;
          }
        }
        if (cost === undefined && typeof metaObj.cost === 'number') {
          cost = metaObj.cost;
        }
      }
    } catch {}

    const result: CardFinalMetadata = {
      model,
      durationSeconds,
      promptTokens,
      completionTokens,
      totalTokens,
      cost,
    };

    const hasAny = Object.values(result).some((v) => v !== undefined);
    return hasAny ? result : null;
  } catch {
    return null;
  }
}

export class StreamingReplyTracker {
  private readonly transport: LarkTransport;
  private readonly streamEventSource: StreamEventSource;
  private readonly sessionRouteId: string;
  private readonly cardParams: StreamingReplyTrackerCardParams;
  private readonly pollIntervalMs: number;
  private readonly maxDurationMs: number;
  private readonly detached: boolean;
  private readonly onFinalized?: (finalText: string, status: any, messageId?: string) => Promise<void> | void;
  private readonly turnId?: string;
  private readonly maxStreamingLength: number;
  private readonly initialMetadata?: CardFinalMetadata;
  private readonly withStopButton?: boolean;
  private readonly senderId?: string;
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
  private accumulatedThinking = '';
  private lastPushedThinking = '';
  private readonly runningTools = new Map<string, number>();
  private readonly withStatusPanel: boolean;
  private readonly withThinkingPanel: boolean;
  private readonly isCotActive: boolean;
  private readonly toolStatusEntries: CardToolStatusEntry[] = [];
  private lastPushedToolStatus = '';
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
    this.maxDurationMs = options.maxDurationMs ?? DEFAULT_STREAMING_MAX_DURATION_MS;
    this.detached = options.detached ?? false;
    this.onFinalized = options.onFinalized;
    this.turnId = options.turnId;
    this.maxStreamingLength = options.maxStreamingLength ?? STREAMING_MAX_CONTENT_LENGTH;
    this.initialMetadata = options.metadata;
    this.withStopButton = options.withStopButton ?? options.cardParams?.withStopButton;
    this.senderId = options.senderId;

    const chatId = options.cardParams?.chatId;
    const cotOption =
      options.enableCot ??
      options.cotEnabled ??
      options.cardParams?.enableCot ??
      options.cardParams?.cotEnabled;
    const cotChatCheck =
      typeof options.isCotEnabled === 'function'
        ? options.isCotEnabled(chatId)
        : typeof (options.transport as any)?.isCotEnabledForChat === 'function'
          ? (options.transport as any).isCotEnabledForChat(chatId)
          : typeof (options.transport as any)?.cotManager?.isCotEnabledForChat === 'function'
            ? (options.transport as any).cotManager.isCotEnabledForChat(chatId)
            : undefined;

    this.isCotActive = Boolean(cotOption ?? cotChatCheck ?? false);

    this.withThinkingPanel = Boolean(
      !this.isCotActive &&
      (options.withThinkingPanel ??
        options.collapsibleThinking ??
        options.cardParams?.withThinkingPanel ??
        options.cardParams?.collapsibleThinking ??
        true)
    );

    this.withStatusPanel = Boolean(
      options.withStatusPanel ??
      options.collapsibleToolStatus ??
      options.cardParams?.withStatusPanel ??
      options.cardParams?.collapsibleToolStatus
    );
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

  getAccumulatedThinking(): string {
    return this.accumulatedThinking;
  }

  isCotActiveForTurn(): boolean {
    return this.isCotActive;
  }

  getToolStatusEntries(): readonly CardToolStatusEntry[] {
    return [...this.toolStatusEntries];
  }

  getRouteId(): string {
    return this.sessionRouteId;
  }

  getTurnId(): string | undefined {
    return this.turnId;
  }

  getSenderId(): string | undefined {
    return this.senderId;
  }

  getMessageId(): string | undefined {
    return this.cardSession?.messageId;
  }

  getCardId(): string | undefined {
    return this.cardSession?.cardId;
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
      const cardParams = {
        ...this.cardParams,
        ...(this.withStatusPanel ? { withStatusPanel: true } : {}),
        ...(this.withThinkingPanel ? { withThinkingPanel: true } : {}),
        withStopButton: this.withStopButton ?? this.cardParams?.withStopButton,
        turnId: this.turnId ?? this.cardParams?.turnId,
        sessionId: this.sessionRouteId ?? this.cardParams?.sessionId,
      };
      this.cardSessionPromise = this.transport.createStreamingCard(cardParams).then(
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
      type: 'assistant_delta' | 'assistant_stream_end' | 'turn_status' | 'tool_status' | 'reasoning_delta' | 'thinking';
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

      if ((evt.type === 'reasoning_delta' || (evt as any).type === 'thinking') && typeof evt.delta === 'string') {
        this.accumulatedThinking += evt.delta;
      } else if (evt.type === 'assistant_delta' && typeof evt.delta === 'string') {
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
          this.toolStatusEntries.push({
            toolName: name,
            status: 'running',
            timestamp: new Date().toISOString(),
          });
        } else if (evt.status === 'completed' || evt.status === 'failed') {
          this.runningTools.set(name, Math.max(0, current - 1));
          const runningIdx = [...this.toolStatusEntries]
            .reverse()
            .findIndex((e) => e.toolName === name && (e.status === 'running' || e.status === 'started'));
          if (runningIdx !== -1) {
            const actualIdx = this.toolStatusEntries.length - 1 - runningIdx;
            this.toolStatusEntries[actualIdx] = {
              ...this.toolStatusEntries[actualIdx],
              status: evt.status as 'completed' | 'failed',
            };
          } else {
            this.toolStatusEntries.push({
              toolName: name,
              status: evt.status as 'completed' | 'failed',
              timestamp: new Date().toISOString(),
            });
          }
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
          let thinkingToPush: string | undefined;
          if (!this.isCotActive && this.accumulatedThinking.trim().length > 0) {
            const formattedThinking = formatThinkingContent(this.accumulatedThinking);
            if (formattedThinking !== this.lastPushedThinking) {
              this.lastPushedThinking = formattedThinking;
              thinkingToPush = formattedThinking;
              if (this.withThinkingPanel && typeof session.pushThinking === 'function') {
                await session.pushThinking(formattedThinking);
              }
            }
          }

          if (this.withStatusPanel) {
            const statusMarkdown = formatToolStatusMarkdown(this.toolStatusEntries);
            if (statusMarkdown && statusMarkdown !== this.lastPushedToolStatus) {
              this.lastPushedToolStatus = statusMarkdown;
              if (typeof session.pushToolStatus === 'function') {
                await session.pushToolStatus(statusMarkdown);
              }
            }

            const cleanText = stripThinkingTags(this.accumulatedText);
            const textToPush = applyStreamingLengthGuard(cleanText, this.maxStreamingLength);
            if (textToPush && textToPush.trim().length > 0 && textToPush !== this.lastPushedText) {
              this.lastPushedText = textToPush;
              await session.pushText(textToPush, statusMarkdown ?? undefined, thinkingToPush);
            }
          } else {
            const subagentCount = this.runningTools.get('subagent') ?? 0;
            const cleanText = stripThinkingTags(this.accumulatedText);
            const rawTextToPush =
              subagentCount > 0
                ? `${cleanText}\n\n---\n⏳ 后台任务运行中：subagent ×${subagentCount}`
                : cleanText;
            const textToPush = applyStreamingLengthGuard(rawTextToPush, this.maxStreamingLength);
            if (textToPush && textToPush.trim().length > 0 && textToPush !== this.lastPushedText) {
              this.lastPushedText = textToPush;
              await session.pushText(textToPush, undefined, thinkingToPush);
            }
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

  private async resolveMetadata(explicitMetadata?: CardFinalMetadata): Promise<CardFinalMetadata | undefined> {
    let queried: CardFinalMetadata | undefined;

    // 1. Check if streamEventSource provides getTurnMetrics
    if (this.turnId && typeof this.streamEventSource.getTurnMetrics === 'function') {
      try {
        const res = await this.streamEventSource.getTurnMetrics(this.sessionRouteId, this.turnId);
        if (res) queried = res;
      } catch {}
    }

    // 2. Query SQLite DB if available on streamEventSource
    if (this.turnId && (this.streamEventSource as any)?.db) {
      try {
        const fromDb = extractTurnMetricsFromDb(
          (this.streamEventSource as any).db,
          this.sessionRouteId,
          this.turnId
        );
        if (fromDb) {
          queried = { ...fromDb, ...queried };
        }
      } catch {}
    }

    // 3. Merge initial tracker metadata if provided
    let combined: CardFinalMetadata | undefined = queried;
    if (this.initialMetadata) {
      combined = { ...combined, ...this.initialMetadata };
    }
    if (explicitMetadata) {
      combined = { ...combined, ...explicitMetadata };
    }

    // 4. Elapsed time calculation fallback: if neither durationSeconds nor durationMs is set
    if (combined?.durationSeconds === undefined && combined?.durationMs === undefined && this.startTime > 0) {
      const durationSeconds = Math.max(0, (Date.now() - this.startTime) / 1000);
      combined = { ...combined, durationSeconds };
    }

    return combined;
  }

  private async doFinalize(
    finalText: string,
    status: 'completed' | 'failed' | 'stopped',
    metadata?: CardFinalMetadata,
    toolStatus?: string | readonly CardToolStatusEntry[],
    thinkingText?: string
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

        let thinkingToPush: string | undefined;
        if (!this.isCotActive && this.accumulatedThinking.trim().length > 0) {
          const formattedThinking = formatThinkingContent(this.accumulatedThinking);
          if (formattedThinking !== this.lastPushedThinking) {
            this.lastPushedThinking = formattedThinking;
            thinkingToPush = formattedThinking;
            if (this.withThinkingPanel && typeof session.pushThinking === 'function') {
              await session.pushThinking(formattedThinking);
            }
          }
        }

        if (this.withStatusPanel) {
          const statusMarkdown = formatToolStatusMarkdown(this.toolStatusEntries);
          if (statusMarkdown && statusMarkdown !== this.lastPushedToolStatus) {
            this.lastPushedToolStatus = statusMarkdown;
            if (typeof session.pushToolStatus === 'function') {
              await session.pushToolStatus(statusMarkdown);
            }
          }
          const cleanText = stripThinkingTags(this.accumulatedText);
          const textToPush = applyStreamingLengthGuard(cleanText, this.maxStreamingLength);
          if (textToPush && textToPush.trim().length > 0 && textToPush !== this.lastPushedText) {
            this.lastPushedText = textToPush;
            await session.pushText(textToPush, statusMarkdown ?? undefined, thinkingToPush);
          }
        } else {
          const subagentCount = this.runningTools.get('subagent') ?? 0;
          const cleanText = stripThinkingTags(this.accumulatedText);
          const rawTextToPush =
            subagentCount > 0
              ? `${cleanText}\n\n---\n⏳ 后台任务运行中：subagent ×${subagentCount}`
              : cleanText;
          const textToPush = applyStreamingLengthGuard(rawTextToPush, this.maxStreamingLength);
          if (textToPush && textToPush.trim().length > 0 && textToPush !== this.lastPushedText) {
            this.lastPushedText = textToPush;
            await session.pushText(textToPush, undefined, thinkingToPush);
          }
        }
      } catch {}
    }

    let textToFinalize =
      finalText ||
      this.accumulatedText ||
      (status === 'failed' ? 'Execution failed' : status === 'stopped' ? '(已停止回复)' : '');
    const finalMetadata = await this.resolveMetadata(metadata);

    let finalThinking: string | undefined;
    if (!this.isCotActive) {
      finalThinking =
        thinkingText !== undefined
          ? thinkingText
          : this.accumulatedThinking.trim().length > 0
            ? this.accumulatedThinking
            : undefined;
    }

    const extracted = extractThinkingFromText(textToFinalize);
    textToFinalize = extracted.text;
    if (!this.isCotActive && !finalThinking && extracted.thinking) {
      finalThinking = extracted.thinking;
    }

    // If turn completed or stopped, settle any remaining running tool entries
    if (status === 'completed' || status === 'stopped') {
      for (let i = 0; i < this.toolStatusEntries.length; i++) {
        if (this.toolStatusEntries[i].status === 'running' || this.toolStatusEntries[i].status === 'started') {
          this.toolStatusEntries[i] = {
            ...this.toolStatusEntries[i],
            status: status === 'stopped' ? 'failed' : 'completed',
          };
        }
      }
    }

    const finalToolStatus =
      toolStatus !== undefined
        ? toolStatus
        : this.toolStatusEntries.length > 0
          ? this.toolStatusEntries
          : undefined;

    try {
      await session.finalize(textToFinalize, status, finalMetadata, finalToolStatus, finalThinking);
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
          const guardedText = applyStreamingLengthGuard(textToFinalize, this.maxStreamingLength);
          await session.pushText(guardedText);
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
    status: 'completed' | 'failed' | 'stopped',
    metadata?: CardFinalMetadata,
    toolStatus?: string | readonly CardToolStatusEntry[],
    thinkingText?: string
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

    return this.doFinalize(finalText, status, metadata, toolStatus, thinkingText);
  }
}
