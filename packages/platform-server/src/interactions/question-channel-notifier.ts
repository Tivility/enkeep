/**
 * Delivers `ask_user_question` questions to the IM channel the asking turn came from.
 *
 * The QuestionBridge (host side of runtime questions) only feeds the Web UI and Jarvis. This
 * notifier subscribes to its `asked` / `settled` events and, per question:
 * - Lark: replies in the asking turn's thread with a question card (buttons or a form); falls
 *   back to a plain text question when the card cannot be sent;
 * - WeChat: sends the question as text;
 * - Web / Jarvis: nothing (they have their own question UI);
 * - no channel that can show it (another channel, a scheduled task's turn, a question without a
 *   session route, or every delivery failed): answers at once on the user's behalf so the agent
 *   continues with its own judgement instead of waiting for the timeout.
 *
 * Typed replies are turned into answers by the delivery gateway (`tryAnswerPendingQuestion`);
 * Lark card clicks by the Lark gateway. When a question settles, its Lark card is replaced by
 * the settled state.
 *
 * Each delivered question is recorded as one `channel_outbox` row (`q_<hash>`), which makes the
 * delivery idempotent across bridge reconciles and platform restarts.
 *
 * @module @enkeep/platform-server/interactions/question-channel-notifier
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { QuestionAnswer } from '@enkeep/dsh-external-interaction/user-questions';
import type {
  BridgedQuestion,
  QuestionAnswerResult,
  QuestionAskedEvent,
  QuestionSettledEvent,
} from './question-bridge.js';
import { renderQuestionText } from './question-text.js';

/** decidedBy of the automatic answer given when no channel can show a question. */
export const QUESTION_FALLBACK_DECIDED_BY = 'system-fallback';

/** The automatic answer's text. */
export const QUESTION_FALLBACK_TEXT =
  '（系统）当前会话无法向用户提问。请按最佳判断继续，并在回复中说明你的假设。';

/** The QuestionBridge subset this notifier uses. */
export interface QuestionNotifierBridge {
  onAsked(listener: (event: QuestionAskedEvent) => void): () => void;
  onSettled(listener: (event: QuestionSettledEvent) => void): () => void;
  listPending(filter?: { userId?: string; sessionId?: string }): BridgedQuestion[];
  answer(id: string, answers: unknown, options?: { userId?: string; decidedBy?: string }): Promise<QuestionAnswerResult>;
}

/** A Lark card / text question target (the asking turn's thread). */
export interface QuestionLarkTarget {
  userId: string;
  accountId: string;
  chatId: string;
  rootId?: string;
  threadId?: string;
  replyToMessageId?: string;
}

/** Lark side (ChannelRuntimeManager). */
export interface QuestionLarkSender {
  sendQuestionCard(
    params: QuestionLarkTarget & { question: BridgedQuestionCardView; senderId?: string; uuid?: string }
  ): Promise<{ success: boolean; messageId?: string; error?: string }>;
  updateQuestionCard(params: {
    userId: string;
    accountId: string;
    messageId: string;
    question: BridgedQuestionCardView;
    state:
      | { kind: 'answered'; answers: readonly QuestionAnswer[]; via?: string }
      | { kind: 'expired' }
      | { kind: 'cancelled' }
      | { kind: 'unavailable' };
  }): Promise<{ success: boolean; error?: string }>;
  sendThreadText(
    params: QuestionLarkTarget & { text: string; uuid?: string }
  ): Promise<{ success: boolean; messageId?: string; error?: string }>;
}

/** WeChat side (WeChatRuntimeManager). */
export interface QuestionWeChatSender {
  sendProactiveMessage(params: {
    userId: string;
    accountId: string;
    chatId: string;
    text: string;
    sessionId?: string;
    outboxId?: string;
  }): Promise<{ success: boolean; messageId?: string; error?: string }>;
}

/** What a Lark card needs of a question. */
export interface BridgedQuestionCardView {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly questions: BridgedQuestion['questions'];
  readonly timeoutMs: number;
}

export interface QuestionChannelNotifierOptions {
  readonly db: DatabaseSync;
  readonly bridge: QuestionNotifierBridge;
  readonly lark?: () => QuestionLarkSender | undefined;
  readonly wechat?: () => QuestionWeChatSender | undefined;
  readonly logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

interface TurnOriginRow {
  account_id: string;
  channel: string;
  chat_id: string;
  native_context_id: string;
  reply_to_message_id: string | null;
  root_id: string | null;
  thread_id: string | null;
}

/** How the notifier decided to handle a question (exposed for tests). */
export type QuestionDeliveryDecision =
  | { kind: 'lark'; origin: TurnOriginRow }
  | { kind: 'wechat'; origin: TurnOriginRow }
  | { kind: 'skip'; reason: 'web' | 'jarvis' }
  | { kind: 'fallback'; reason: string };

/** Stable outbox row id of a question delivery. */
export function questionOutboxId(userId: string, questionId: string): string {
  return `q_${createHash('sha256').update(`${userId}:${questionId}`).digest('hex').slice(0, 24)}`;
}

function cardView(question: BridgedQuestion): BridgedQuestionCardView {
  return {
    id: question.id,
    sessionId: question.sessionId,
    ...(question.turnId ? { turnId: question.turnId } : {}),
    questions: question.questions,
    timeoutMs: question.timeoutMs,
  };
}

export class QuestionChannelNotifier {
  private readonly db: DatabaseSync;
  private readonly bridge: QuestionNotifierBridge;
  private readonly larkSender: () => QuestionLarkSender | undefined;
  private readonly wechatSender: () => QuestionWeChatSender | undefined;
  private readonly logger: { warn(message: string, meta?: Record<string, unknown>): void };
  private readonly inFlight = new Map<string, Promise<void>>();
  private unsubscribers: Array<() => void> = [];
  private started = false;

  constructor(options: QuestionChannelNotifierOptions) {
    this.db = options.db;
    this.bridge = options.bridge;
    this.larkSender = options.lark ?? (() => undefined);
    this.wechatSender = options.wechat ?? (() => undefined);
    this.logger = options.logger ?? {
      warn: (message, meta) => console.warn(`[question-notifier] ${message}`, meta ?? {}),
    };
  }

  /** Subscribes to the bridge and delivers questions already pending. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribers.push(this.bridge.onAsked((e) => void this.handleAsked(e.question)));
    this.unsubscribers.push(this.bridge.onSettled((e) => void this.handleSettled(e)));
    try {
      for (const question of this.bridge.listPending()) void this.handleAsked(question);
    } catch {}
  }

  stop(): void {
    this.started = false;
    for (const off of this.unsubscribers.splice(0)) {
      try {
        off();
      } catch {}
    }
  }

  /** Resolves when the deliveries started so far have finished (tests). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled(Array.from(this.inFlight.values()));
    }
  }

  /** Where a question goes (no side effects). */
  decide(question: BridgedQuestion): QuestionDeliveryDecision {
    if (!question.routeResolved) return { kind: 'fallback', reason: 'no_route' };
    if (question.turnId && this.isTaskTurn(question.userId, question.turnId)) {
      return { kind: 'fallback', reason: 'task_turn' };
    }
    const route = this.db
      .prepare('SELECT channel FROM session_routes WHERE id = ? AND user_id = ? LIMIT 1')
      .get(question.sessionId, question.userId) as { channel?: string } | undefined;
    const origin = this.originOf(question);
    const channel = origin?.channel ?? route?.channel;
    switch (channel) {
      case 'lark':
        return origin ? { kind: 'lark', origin } : { kind: 'fallback', reason: 'no_origin' };
      case 'wechat':
        return origin ? { kind: 'wechat', origin } : { kind: 'fallback', reason: 'no_origin' };
      case 'web':
      case undefined:
        return route ? { kind: 'skip', reason: 'web' } : { kind: 'fallback', reason: 'no_route' };
      case 'jarvis':
        return { kind: 'skip', reason: 'jarvis' };
      default:
        return { kind: 'fallback', reason: `channel_${channel}` };
    }
  }

  private track(key: string, work: () => Promise<void>): Promise<void> {
    const previous = this.inFlight.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(work)
      .catch((err) => {
        this.logger.warn('question delivery failed', { error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        if (this.inFlight.get(key) === next) this.inFlight.delete(key);
      });
    this.inFlight.set(key, next);
    return next;
  }

  private handleAsked(question: BridgedQuestion): Promise<void> {
    return this.track(`${question.userId}:${question.id}`, () => this.deliver(question));
  }

  private async deliver(question: BridgedQuestion): Promise<void> {
    if (!this.started) return;
    const stillPending = this.bridge.listPending({ userId: question.userId }).some((q) => q.id === question.id);
    if (!stillPending) return; // settled before we got to it (answered elsewhere, expired)
    const outboxId = questionOutboxId(question.userId, question.id);
    if (this.outboxRow(outboxId)) return; // already delivered (reconcile / restart)

    const decision = this.decide(question);
    if (decision.kind === 'skip') return;
    if (decision.kind === 'fallback') {
      await this.fallback(question, decision.reason);
      return;
    }

    const { origin } = decision;
    const delivered =
      decision.kind === 'lark'
        ? await this.deliverLark(question, origin, outboxId)
        : await this.deliverWeChat(question, origin, outboxId);
    if (!delivered) await this.fallback(question, `${decision.kind}_delivery_failed`);
  }

  private async deliverLark(question: BridgedQuestion, origin: TurnOriginRow, outboxId: string): Promise<boolean> {
    const lark = this.larkSender();
    if (!lark) return false;
    const target: QuestionLarkTarget = {
      userId: question.userId,
      accountId: origin.account_id,
      chatId: origin.chat_id,
      ...(origin.root_id ? { rootId: origin.root_id } : {}),
      ...(origin.thread_id ? { threadId: origin.thread_id } : {}),
      ...(origin.reply_to_message_id ? { replyToMessageId: origin.reply_to_message_id } : {}),
    };
    const senderId = question.turnId ? this.senderOfTurn(question.userId, question.turnId) : undefined;
    let mode: 'card' | 'text' = 'card';
    let result: { success: boolean; messageId?: string; error?: string };
    try {
      result = await lark.sendQuestionCard({ ...target, question: cardView(question), senderId, uuid: outboxId });
    } catch (err) {
      result = { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!result.success) {
      this.logger.warn('question card send failed, falling back to text', { error: result.error });
      mode = 'text';
      try {
        result = await lark.sendThreadText({
          ...target,
          text: renderQuestionText(question.questions, question.timeoutMs),
          uuid: `${outboxId}_t`,
        });
      } catch (err) {
        result = { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    if (!result.success) return false;
    this.recordOutbox(outboxId, question, origin, {
      kind: 'ask_user_question',
      mode,
      questionId: question.id,
      ...(result.messageId ? { messageId: result.messageId } : {}),
      chatId: origin.chat_id,
    });
    return true;
  }

  private async deliverWeChat(question: BridgedQuestion, origin: TurnOriginRow, outboxId: string): Promise<boolean> {
    const wechat = this.wechatSender();
    if (!wechat) return false;
    try {
      // The WeChat runtime records the outbox row (pending → delivered / failed) under outboxId.
      const result = await wechat.sendProactiveMessage({
        userId: question.userId,
        accountId: origin.account_id,
        chatId: origin.native_context_id || origin.chat_id,
        text: renderQuestionText(question.questions, question.timeoutMs),
        sessionId: question.sessionId,
        outboxId,
      });
      return result.success;
    } catch (err) {
      this.logger.warn('question text send failed (wechat)', { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /** Answers at once for the user: the agent continues with its own judgement. */
  private async fallback(question: BridgedQuestion, reason: string): Promise<void> {
    const answers: QuestionAnswer[] = question.questions.map((q) => ({ id: q.id, selected: [], custom: QUESTION_FALLBACK_TEXT }));
    const result = await this.bridge.answer(question.id, answers, {
      userId: question.userId,
      decidedBy: QUESTION_FALLBACK_DECIDED_BY,
    });
    if (!result.ok) {
      this.logger.warn('question fallback answer not taken', { reason, status: result.status });
    }
  }

  private handleSettled(event: QuestionSettledEvent): Promise<void> {
    const question = event.question;
    return this.track(`${question.userId}:${question.id}`, async () => {
      const outboxId = questionOutboxId(question.userId, question.id);
      const row = this.outboxRow(outboxId);
      if (!row) return;
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      } catch {}
      if (payload.kind !== 'ask_user_question') {
        // WeChat delivery row (written by the WeChat runtime): stop redriving a stale question.
        this.db
          .prepare("UPDATE channel_outbox SET attempts = MAX(attempts, 3), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('pending', 'failed')")
          .run(outboxId);
        return;
      }
      if (payload.mode !== 'card' || typeof payload.messageId !== 'string') return;
      const lark = this.larkSender();
      if (!lark) return;
      const state =
        event.outcome === 'answered'
          ? { kind: 'answered' as const, answers: event.answers ?? [], ...(event.decidedBy ? { via: event.decidedBy } : {}) }
          : event.outcome === 'expired'
            ? { kind: 'expired' as const }
            : event.outcome === 'cancelled'
              ? { kind: 'cancelled' as const }
              : { kind: 'unavailable' as const };
      const result = await lark.updateQuestionCard({
        userId: question.userId,
        accountId: row.account_id,
        messageId: payload.messageId,
        question: cardView(question),
        state,
      });
      if (!result.success) this.logger.warn('question card update failed', { error: result.error });
    });
  }

  // ──────────────────────────── DB helpers ────────────────────────────

  private isTaskTurn(userId: string, turnId: string): boolean {
    try {
      return Boolean(
        this.db.prepare('SELECT 1 AS ok FROM task_runs WHERE user_id = ? AND turn_id = ? LIMIT 1').get(userId, turnId)
      );
    } catch {
      return false;
    }
  }

  /** The asking turn's channel origin; else the session's latest origin. */
  private originOf(question: BridgedQuestion): TurnOriginRow | undefined {
    const columns = 'account_id, channel, chat_id, native_context_id, reply_to_message_id, root_id, thread_id';
    if (question.turnId) {
      const row = this.db
        .prepare(`SELECT ${columns} FROM channel_turn_origins WHERE turn_id = ? AND user_id = ? LIMIT 1`)
        .get(question.turnId, question.userId) as TurnOriginRow | undefined;
      if (row) return row;
    }
    return this.db
      .prepare(`SELECT ${columns} FROM channel_turn_origins WHERE session_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(question.sessionId, question.userId) as TurnOriginRow | undefined;
  }

  private senderOfTurn(userId: string, turnId: string): string | undefined {
    try {
      const row = this.db
        .prepare('SELECT payload FROM delivery_inbox WHERE user_id = ? AND turn_id = ? LIMIT 1')
        .get(userId, turnId) as { payload?: string | null } | undefined;
      if (!row?.payload) return undefined;
      const sender = JSON.parse(row.payload)?.channelContext?.senderId;
      return typeof sender === 'string' && sender ? sender : undefined;
    } catch {
      return undefined;
    }
  }

  private outboxRow(id: string): { account_id: string; payload_json: string } | undefined {
    return this.db.prepare('SELECT account_id, payload_json FROM channel_outbox WHERE id = ? LIMIT 1').get(id) as
      | { account_id: string; payload_json: string }
      | undefined;
  }

  private recordOutbox(id: string, question: BridgedQuestion, origin: TurnOriginRow, payload: Record<string, unknown>): void {
    try {
      this.db
        .prepare(`
          INSERT OR IGNORE INTO channel_outbox (
            id, user_id, account_id, session_id, native_context_id, reply_to_native_id, payload_json, status, attempts, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'delivered', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `)
        .run(
          id,
          question.userId,
          origin.account_id,
          question.sessionId,
          origin.native_context_id,
          origin.reply_to_message_id,
          JSON.stringify(payload)
        );
    } catch (err) {
      this.logger.warn('question outbox record failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
