import * as crypto from 'node:crypto';
import { Context, Service } from '@deepseek-ai/cordis';
import type {
  ApprovalOutcome,
  ApprovalRequest,
  ApprovalRiskLevel,
  PendingApproval,
  AskUserQuestionRequest,
  IExternalInteractionService,
  QuestionAnswerAttempt,
} from './types.js';

import {
  DEFAULT_INTERACTION_TIMEOUT_MS,
  classifyToolRiskAndSummary,
} from './approval-policy.js';
import {
  DEFAULT_QUESTION_TIMEOUT_MS,
  normalizeAskUserQuestionInput,
  validateQuestionAnswers,
  type PendingQuestion,
  type QuestionAnswer,
  type QuestionOutcome,
  type QuestionResolution,
  type QuestionSettlement,
  type UserQuestion,
} from './user-questions.js';

export { DEFAULT_INTERACTION_TIMEOUT_MS, classifyToolRiskAndSummary };

export interface ExternalInteractionConfig {
  defaultTimeoutMs?: number;
  /** Wait for an approval answer; defaults to `defaultTimeoutMs`. */
  approvalTimeoutMs?: number;
  /** Wait for a question answer; defaults to 10 min. */
  questionTimeoutMs?: number;
}

/** How many settled questions are remembered (to tell "expired" from "unknown" on late answers). */
export const SETTLED_QUESTION_RETENTION = 256;

/** Tool call ids usable as question ids as they are. */
const REUSABLE_QUESTION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Helper to inspect agent/session metadata and determine the session source.
 * Returns 'external', 'im', or 'web' (default).
 */
export function resolveSessionSource(agent?: any): 'external' | 'im' | 'web' | string {
  if (!agent) return 'web';
  const session = agent.session ?? agent;

  const candidate =
    session?.meta?.source ??
    session?.source ??
    session?.metadata?.source ??
    session?.meta?.channel ??
    session?.channel ??
    session?.header?.origin;

  if (typeof candidate === 'string') {
    const lower = candidate.toLowerCase();
    if (lower === 'external' || lower === 'im') {
      return lower;
    }
    if (lower === 'web' || lower === 'gui') {
      return 'web';
    }
    return candidate;
  }

  return 'web';
}

/**
 * Helper to extract tenant userId and spaceId from agent session.
 */
export function resolveTenantAndSpace(agent?: any): { userId?: string; spaceId?: string } {
  if (!agent) return {};
  const session = agent.session ?? agent;

  const userId =
    session?.meta?.userId ??
    session?.userId ??
    session?.metadata?.userId ??
    session?.header?.userId;

  const spaceId =
    session?.meta?.spaceId ??
    session?.spaceId ??
    session?.metadata?.spaceId ??
    session?.header?.spaceId ??
    session?.meta?.workspaceFolder ??
    session?.workspaceFolder;

  return {
    userId: typeof userId === 'string' ? userId : undefined,
    spaceId: typeof spaceId === 'string' ? spaceId : undefined,
  };
}

interface PendingApprovalInternal extends PendingApproval {
  resolve: (outcome: ApprovalOutcome) => void;
  reject: (err: unknown) => void;
  timer?: NodeJS.Timeout;
  signalListener?: () => void;
  signal?: AbortSignal;
}

interface PendingQuestionInternal {
  record: PendingQuestion;
  resolve: (resolution: QuestionResolution) => void;
  timer?: NodeJS.Timeout;
  signalListener?: () => void;
  signal?: AbortSignal;
}

function copyQuestion(record: PendingQuestion): PendingQuestion {
  return {
    ...record,
    // Questions are deep-frozen at normalization; answers are copied.
    ...(record.answers ? { answers: record.answers.map((a) => ({ ...a, selected: [...a.selected] })) } : {}),
  };
}

export class ExternalInteractionService extends Service implements IExternalInteractionService {
  private readonly approvals = new Map<string, PendingApprovalInternal>();
  private readonly settledApprovals = new Map<string, PendingApproval>();
  private readonly questions = new Map<string, PendingQuestionInternal>();
  private readonly settledQuestions = new Map<string, PendingQuestion>();

  private readonly approvalListeners = new Set<(pending: PendingApproval) => void>();
  private readonly questionListeners = new Set<(pending: PendingQuestion) => void>();
  private readonly questionSettledListeners = new Set<(settlement: QuestionSettlement) => void>();

  constructor(ctx: Context, private readonly interactionConfig: ExternalInteractionConfig = {}) {
    super(ctx, 'externalInteraction');
  }

  get timeoutMs(): number {
    return this.interactionConfig.defaultTimeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;
  }

  /** Effective wait for an approval answer before it resolves `unavailable` (expired). */
  get approvalTimeoutMs(): number {
    return this.interactionConfig.approvalTimeoutMs ?? this.timeoutMs;
  }

  /** Effective wait for a question answer before it settles `expired`. */
  get questionTimeoutMs(): number {
    return this.interactionConfig.questionTimeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS;
  }

  listPendingApprovals(filter?: { userId?: string; sessionId?: string }): readonly PendingApproval[] {
    const list = Array.from(this.approvals.values()).map(
      ({
        id,
        sessionId,
        userId,
        spaceId,
        sessionSource,
        toolName,
        callId,
        reason,
        risk,
        safeSummary,
        preview,
        createdAt,
        timeoutMs,
        status,
      }) => ({
        id,
        sessionId,
        userId,
        spaceId,
        sessionSource,
        toolName,
        callId,
        reason,
        risk,
        safeSummary,
        preview,
        createdAt,
        timeoutMs,
        status,
      })
    );

    if (!filter) return list;
    return list.filter((item) => {
      if (filter.userId && item.userId && item.userId !== filter.userId) return false;
      if (filter.sessionId && item.sessionId !== filter.sessionId) return false;
      return true;
    });
  }

  getPendingApproval(id: string): PendingApproval | undefined {
    const entry = this.approvals.get(id);
    if (entry) {
      const {
        sessionId,
        userId,
        spaceId,
        sessionSource,
        toolName,
        callId,
        reason,
        risk,
        safeSummary,
        preview,
        createdAt,
        timeoutMs,
        status,
      } = entry;
      return {
        id,
        sessionId,
        userId,
        spaceId,
        sessionSource,
        toolName,
        callId,
        reason,
        risk,
        safeSummary,
        preview,
        createdAt,
        timeoutMs,
        status,
      };
    }
    return this.settledApprovals.get(id);
  }

  answerApproval(id: string, outcome: 'allowed-once' | 'rejected'): boolean {
    const entry = this.approvals.get(id);
    if (!entry) {
      // Idempotent check: if already settled with the same outcome, return true
      const settled = this.settledApprovals.get(id);
      if (settled && settled.decisionOutcome === outcome) {
        return true;
      }
      return false;
    }

    const settledCopy: PendingApproval = {
      ...entry,
      status: outcome,
      decisionOutcome: outcome,
      decidedAt: new Date().toISOString(),
    };
    this.settledApprovals.set(id, settledCopy);
    this.cleanupApproval(id);
    entry.resolve(outcome);
    return true;
  }

  cancelApproval(id: string, _reason?: string): boolean {
    const entry = this.approvals.get(id);
    if (!entry) {
      const settled = this.settledApprovals.get(id);
      if (settled && settled.decisionOutcome === 'cancelled') {
        return true;
      }
      return false;
    }

    const settledCopy: PendingApproval = {
      ...entry,
      status: 'cancelled',
      decisionOutcome: 'cancelled',
      decidedAt: new Date().toISOString(),
    };
    this.settledApprovals.set(id, settledCopy);
    this.cleanupApproval(id);
    entry.resolve('cancelled');
    return true;
  }

  expireStaleApprovals(): number {
    const now = Date.now();
    let expiredCount = 0;
    for (const [id, entry] of this.approvals) {
      const createdTime = new Date(entry.createdAt).getTime();
      if (now - createdTime >= entry.timeoutMs) {
        const settledCopy: PendingApproval = {
          ...entry,
          status: 'expired',
          decisionOutcome: 'unavailable',
          decidedAt: new Date().toISOString(),
        };
        this.settledApprovals.set(id, settledCopy);
        this.cleanupApproval(id);
        entry.resolve('unavailable');
        expiredCount++;
      }
    }
    return expiredCount;
  }

  listPendingQuestions(filter?: { userId?: string; sessionId?: string }): readonly PendingQuestion[] {
    const list = Array.from(this.questions.values()).map((entry) => copyQuestion(entry.record));
    if (!filter) return list;
    return list.filter((item) => {
      if (filter.userId && item.userId && item.userId !== filter.userId) return false;
      if (filter.sessionId && item.sessionId !== filter.sessionId) return false;
      return true;
    });
  }

  /** A pending question by id (undefined once settled). */
  getPendingQuestion(id: string): PendingQuestion | undefined {
    const entry = this.questions.get(id);
    return entry ? copyQuestion(entry.record) : undefined;
  }

  /** A pending question, or a recently settled one (with its final `status`). */
  getQuestion(id: string): PendingQuestion | undefined {
    const entry = this.questions.get(id);
    if (entry) return copyQuestion(entry.record);
    const settled = this.settledQuestions.get(id);
    return settled ? copyQuestion(settled) : undefined;
  }

  answerQuestion(id: string, answers: readonly QuestionAnswer[]): boolean {
    return this.tryAnswerQuestion(id, answers).ok;
  }

  /**
   * Answers a pending question with `{ id, selected, custom? }` items (validated against the
   * questions asked). The first accepted answer wins; see {@link QuestionAnswerAttempt} for why
   * an answer is refused.
   */
  tryAnswerQuestion(id: string, answers: unknown): QuestionAnswerAttempt {
    const entry = this.questions.get(id);
    if (!entry) {
      const settled = this.settledQuestions.get(id);
      if (!settled) {
        return { ok: false, code: 'not-found', message: `No question with id "${id}"` };
      }
      if (settled.status === 'expired') {
        return {
          ok: false,
          code: 'expired',
          message: `Question "${id}" expired before it was answered`,
          question: copyQuestion(settled),
        };
      }
      return {
        ok: false,
        code: 'already-settled',
        message: `Question "${id}" is already ${settled.status}`,
        question: copyQuestion(settled),
      };
    }
    const validated = validateQuestionAnswers(entry.record.questions, answers);
    if (!validated.ok) {
      return { ok: false, code: 'invalid-answers', message: validated.error };
    }
    const record = this.settleQuestion(id, 'answered', { answers: validated.value });
    return { ok: true, question: record!, answers: validated.value.map((a) => ({ ...a, selected: [...a.selected] })) };
  }

  cancelQuestion(id: string, reason = 'Question cancelled'): boolean {
    return this.settleQuestion(id, 'cancelled', { reason }) !== undefined;
  }

  onApprovalAsked(handler: (pending: PendingApproval) => void): () => void {
    this.approvalListeners.add(handler);
    return () => this.approvalListeners.delete(handler);
  }

  onQuestionAsked(handler: (pending: PendingQuestion) => void): () => void {
    this.questionListeners.add(handler);
    return () => this.questionListeners.delete(handler);
  }

  /** Every settlement of a question (answered, expired, cancelled), exactly once per question. */
  onQuestionSettled(handler: (settlement: QuestionSettlement) => void): () => void {
    this.questionSettledListeners.add(handler);
    return () => this.questionSettledListeners.delete(handler);
  }

  /**
   * Suspend an approval request until answered, timed out, or cancelled.
   */
  async suspendApproval(req: ApprovalRequest, sessionSource: string): Promise<ApprovalOutcome> {
    const session = req.agent?.session;
    let askedId: string | undefined;
    if (session) {
      const events = session.snapshotEvents();
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (ev && ev.type === 'approval/asked' && ev.data && 'id' in ev.data) {
          askedId = String(ev.data.id);
          break;
        }
      }
    }
    const id = askedId || crypto.randomUUID();
    const sessionId = session?.id ?? 'unknown-session';
    const { userId, spaceId } = resolveTenantAndSpace(req.agent);
    const timeout = this.approvalTimeoutMs;
    const createdAt = new Date().toISOString();
    const { risk, safeSummary } = classifyToolRiskAndSummary(req.toolName, req.reason);

    return new Promise<ApprovalOutcome>((resolve, reject) => {
      const entry: PendingApprovalInternal = {
        id,
        sessionId: String(sessionId),
        userId,
        spaceId,
        sessionSource,
        toolName: req.toolName,
        callId: req.callId,
        reason: req.reason,
        risk,
        safeSummary,
        preview: {
          toolName: req.toolName,
          ...(req.callId ? { callId: req.callId } : {}),
          ...(spaceId ? { spaceId } : {}),
        },
        createdAt,
        timeoutMs: timeout,
        status: 'pending',
        resolve,
        reject,
        signal: req.signal,
      };

      if (req.signal?.aborted) {
        resolve('cancelled');
        return;
      }

      if (req.signal) {
        const onAbort = () => {
          this.cleanupApproval(id);
          const settledCopy: PendingApproval = {
            ...entry,
            status: 'cancelled',
            decisionOutcome: 'cancelled',
            decidedAt: new Date().toISOString(),
          };
          this.settledApprovals.set(id, settledCopy);
          resolve('cancelled');
        };
        req.signal.addEventListener('abort', onAbort, { once: true });
        entry.signalListener = onAbort;
      }

      entry.timer = setTimeout(() => {
        this.cleanupApproval(id);
        const settledCopy: PendingApproval = {
          ...entry,
          status: 'expired',
          decisionOutcome: 'unavailable',
          decidedAt: new Date().toISOString(),
        };
        this.settledApprovals.set(id, settledCopy);
        resolve('unavailable');
      }, timeout);

      this.approvals.set(id, entry);

      // Notify listeners
      const snapshot: PendingApproval = {
        id,
        sessionId: String(sessionId),
        userId,
        spaceId,
        sessionSource,
        toolName: req.toolName,
        callId: req.callId,
        reason: req.reason,
        risk,
        safeSummary,
        preview: entry.preview,
        createdAt,
        timeoutMs: timeout,
        status: 'pending',
      };

      for (const listener of this.approvalListeners) {
        try {
          listener(snapshot);
        } catch {
          // Ignore listener error
        }
      }
    });
  }

  /**
   * Holds a question until the user answers, it expires (`questionTimeoutMs`), or the request's
   * signal aborts. Never rejects for those outcomes: it resolves with the {@link QuestionResolution}.
   * Throws a TypeError when the questions are invalid.
   */
  async suspendQuestion(req: AskUserQuestionRequest, sessionSource: string): Promise<QuestionResolution> {
    const normalized = normalizeAskUserQuestionInput({ questions: req.questions });
    if (!normalized.ok) {
      throw new TypeError(`Invalid questions: ${normalized.error}`);
    }
    const questions: UserQuestion[] = normalized.value;
    const callId = typeof req.callId === 'string' && req.callId ? String(req.callId) : undefined;
    const id = this.newQuestionId(callId);
    if (req.signal?.aborted) {
      return { outcome: 'cancelled', questionId: id, reason: 'aborted before asking' };
    }

    const sessionId = String(req.agent?.session?.id ?? 'unknown-session');
    const { userId, spaceId } = resolveTenantAndSpace(req.agent);
    const timeoutMs = this.questionTimeoutMs;
    const createdAtMs = Date.now();
    const record: PendingQuestion = {
      id,
      sessionId,
      ...(callId ? { callId } : {}),
      ...(userId ? { userId } : {}),
      ...(spaceId ? { spaceId } : {}),
      sessionSource,
      questions,
      createdAt: new Date(createdAtMs).toISOString(),
      timeoutMs,
      expiresAt: new Date(createdAtMs + timeoutMs).toISOString(),
      status: 'pending',
    };

    return new Promise<QuestionResolution>((resolve) => {
      const entry: PendingQuestionInternal = { record, resolve, signal: req.signal };
      if (req.signal) {
        const onAbort = () => {
          this.settleQuestion(id, 'cancelled', { reason: 'the tool call was aborted' });
        };
        req.signal.addEventListener('abort', onAbort, { once: true });
        entry.signalListener = onAbort;
      }
      entry.timer = setTimeout(() => {
        this.settleQuestion(id, 'expired');
      }, timeoutMs);
      this.questions.set(id, entry);

      for (const listener of this.questionListeners) {
        try {
          listener(copyQuestion(record));
        } catch {
          // Ignore listener error
        }
      }
    });
  }

  /** The tool call id when it is usable and free, else a fresh `q_<uuid>`. */
  private newQuestionId(callId: string | undefined): string {
    if (
      callId &&
      REUSABLE_QUESTION_ID.test(callId) &&
      !this.questions.has(callId) &&
      !this.settledQuestions.has(callId)
    ) {
      return callId;
    }
    return `q_${crypto.randomUUID().replace(/-/g, '')}`;
  }

  /** Settles a pending question once: records it, notifies listeners, resolves the asker. */
  private settleQuestion(
    id: string,
    outcome: QuestionOutcome,
    detail: { answers?: QuestionAnswer[]; reason?: string } = {}
  ): PendingQuestion | undefined {
    const entry = this.questions.get(id);
    if (!entry) return undefined;
    this.cleanupQuestion(id);

    const settledAt = new Date().toISOString();
    const settled: PendingQuestion = {
      ...entry.record,
      status: outcome,
      settledAt,
      ...(outcome === 'answered' ? { answers: detail.answers ?? [] } : {}),
    };
    this.settledQuestions.set(id, settled);
    while (this.settledQuestions.size > SETTLED_QUESTION_RETENTION) {
      const oldest = this.settledQuestions.keys().next().value;
      if (oldest === undefined) break;
      this.settledQuestions.delete(oldest);
    }

    const settlement: QuestionSettlement = {
      id,
      sessionId: settled.sessionId,
      ...(settled.callId ? { callId: settled.callId } : {}),
      outcome,
      ...(outcome === 'answered' ? { answers: (detail.answers ?? []).map((a) => ({ ...a, selected: [...a.selected] })) } : {}),
      settledAt,
      ...(outcome === 'cancelled' && detail.reason ? { reason: detail.reason } : {}),
    };
    for (const listener of this.questionSettledListeners) {
      try {
        listener(settlement);
      } catch {
        // Ignore listener error
      }
    }

    switch (outcome) {
      case 'answered':
        entry.resolve({ outcome, questionId: id, answers: detail.answers ?? [] });
        break;
      case 'expired':
        entry.resolve({ outcome, questionId: id, timeoutMs: entry.record.timeoutMs });
        break;
      default:
        entry.resolve({ outcome: 'cancelled', questionId: id, ...(detail.reason ? { reason: detail.reason } : {}) });
    }
    return copyQuestion(settled);
  }

  private cleanupApproval(id: string): void {
    const entry = this.approvals.get(id);
    if (!entry) return;

    if (entry.timer) clearTimeout(entry.timer);
    if (entry.signal && entry.signalListener) {
      entry.signal.removeEventListener('abort', entry.signalListener);
    }
    this.approvals.delete(id);
  }

  private cleanupQuestion(id: string): void {
    const entry = this.questions.get(id);
    if (!entry) return;

    if (entry.timer) clearTimeout(entry.timer);
    if (entry.signal && entry.signalListener) {
      entry.signal.removeEventListener('abort', entry.signalListener);
    }
    this.questions.delete(id);
  }

  /**
   * Cancel and clear all pending approvals and questions (used during dispose/teardown).
   */
  disposeAll(): void {
    for (const [id, entry] of this.approvals) {
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.signal && entry.signalListener) {
        entry.signal.removeEventListener('abort', entry.signalListener);
      }
      entry.resolve('cancelled');
    }
    this.approvals.clear();
    this.settledApprovals.clear();

    for (const id of Array.from(this.questions.keys())) {
      this.settleQuestion(id, 'cancelled', { reason: 'the runtime is shutting down' });
    }
    this.questions.clear();
    this.settledQuestions.clear();
    this.approvalListeners.clear();
    this.questionListeners.clear();
    this.questionSettledListeners.clear();
  }
}
