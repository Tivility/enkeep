import * as crypto from 'node:crypto';
import { Context, Service } from '@deepseek-ai/cordis';
import type {
  ApprovalOutcome,
  ApprovalRequest,
  ApprovalRiskLevel,
  PendingApproval,
  AskUserQuestionRequest,
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  PendingQuestion,
  IExternalInteractionService,
} from './types.js';

export interface ExternalInteractionConfig {
  defaultTimeoutMs?: number;
}

export const DEFAULT_INTERACTION_TIMEOUT_MS = 60_000; // 60 seconds

/**
 * Classifies tool execution risk level and produces a safe human-readable summary
 * without leaking raw command arguments, secrets, or internal paths.
 */
export function classifyToolRiskAndSummary(
  toolName: string,
  reason?: string
): { risk: ApprovalRiskLevel; safeSummary: string } {
  switch (toolName) {
    case 'bash':
      return {
        risk: 'high',
        safeSummary: reason ?? 'Execute shell command in space workspace',
      };
    case 'write':
      return {
        risk: 'medium',
        safeSummary: reason ?? 'Write or replace file in space workspace',
      };
    case 'edit':
      return {
        risk: 'medium',
        safeSummary: reason ?? 'Edit file content in space workspace',
      };
    case 'subagent':
    case 'subagent_fork':
      return {
        risk: 'medium',
        safeSummary: reason ?? `Spawn subagent (${toolName})`,
      };
    case 'interrupt_agent':
      return {
        risk: 'low',
        safeSummary: reason ?? 'Interrupt subagent execution',
      };
    case 'send_platform_message':
    case 'send_message':
      return {
        risk: 'low',
        safeSummary: reason ?? 'Send outbound message notification',
      };
    case 'create_task':
      return {
        risk: 'low',
        safeSummary: reason ?? 'Create platform task',
      };
    default:
      return {
        risk: 'medium',
        safeSummary: reason ?? `Execute tool "${toolName}"`,
      };
  }
}

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

interface PendingQuestionInternal extends PendingQuestion {
  resolve: (answer: AskUserQuestionAnswer) => void;
  reject: (err: unknown) => void;
  timer?: NodeJS.Timeout;
  signalListener?: () => void;
  signal?: AbortSignal;
}

export class ExternalInteractionService extends Service implements IExternalInteractionService {
  private readonly approvals = new Map<string, PendingApprovalInternal>();
  private readonly settledApprovals = new Map<string, PendingApproval>();
  private readonly questions = new Map<string, PendingQuestionInternal>();

  private readonly approvalListeners = new Set<(pending: PendingApproval) => void>();
  private readonly questionListeners = new Set<(pending: PendingQuestion) => void>();

  constructor(ctx: Context, private readonly interactionConfig: ExternalInteractionConfig = {}) {
    super(ctx, 'externalInteraction');
  }

  get timeoutMs(): number {
    return this.interactionConfig.defaultTimeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;
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
    const list = Array.from(this.questions.values()).map(
      ({ id, sessionId, userId, spaceId, sessionSource, questions, createdAt, timeoutMs, status }) => ({
        id,
        sessionId,
        userId,
        spaceId,
        sessionSource,
        questions,
        createdAt,
        timeoutMs,
        status: status ?? 'pending',
      })
    );

    if (!filter) return list;
    return list.filter((item) => {
      if (filter.userId && item.userId && item.userId !== filter.userId) return false;
      if (filter.sessionId && item.sessionId !== filter.sessionId) return false;
      return true;
    });
  }

  getPendingQuestion(id: string): PendingQuestion | undefined {
    const entry = this.questions.get(id);
    if (!entry) return undefined;
    const { sessionId, userId, spaceId, sessionSource, questions, createdAt, timeoutMs, status } = entry;
    return { id, sessionId, userId, spaceId, sessionSource, questions, createdAt, timeoutMs, status: status ?? 'pending' };
  }

  answerQuestion(
    id: string,
    answers: Record<string, string | string[]> | AskUserQuestionAnswerItem[]
  ): boolean {
    const entry = this.questions.get(id);
    if (!entry) return false;

    this.cleanupQuestion(id);

    let answerItems: AskUserQuestionAnswerItem[];
    if (Array.isArray(answers)) {
      answerItems = answers;
    } else {
      answerItems = Object.entries(answers).map(([qId, val]) => ({
        id: qId,
        answer: val,
      }));
    }

    entry.resolve({ answers: answerItems });
    return true;
  }

  cancelQuestion(id: string, reason = 'Question cancelled'): boolean {
    const entry = this.questions.get(id);
    if (!entry) return false;

    this.cleanupQuestion(id);
    const err = new Error(reason);
    (err as any).code = 'ASK_CANCELLED';
    entry.reject(err);
    return true;
  }

  onApprovalAsked(handler: (pending: PendingApproval) => void): () => void {
    this.approvalListeners.add(handler);
    return () => this.approvalListeners.delete(handler);
  }

  onQuestionAsked(handler: (pending: PendingQuestion) => void): () => void {
    this.questionListeners.add(handler);
    return () => this.questionListeners.delete(handler);
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
    const timeout = this.timeoutMs;
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
   * Suspend a question request until answered, timed out, or cancelled.
   */
  async suspendQuestion(
    req: AskUserQuestionRequest,
    sessionSource: string
  ): Promise<AskUserQuestionAnswer> {
    const id = crypto.randomUUID();
    const sessionId = req.agent?.session?.id ?? 'unknown-session';
    const { userId, spaceId } = resolveTenantAndSpace(req.agent);
    const timeout = this.timeoutMs;
    const createdAt = new Date().toISOString();

    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const entry: PendingQuestionInternal = {
        id,
        sessionId: String(sessionId),
        userId,
        spaceId,
        sessionSource,
        questions: req.questions,
        createdAt,
        timeoutMs: timeout,
        status: 'pending',
        resolve,
        reject,
        signal: req.signal,
      };

      if (req.signal?.aborted) {
        const err = new Error('ask_user_question was aborted before answering');
        (err as any).code = 'ASK_ABORTED';
        reject(err);
        return;
      }

      if (req.signal) {
        const onAbort = () => {
          this.cleanupQuestion(id);
          const err = new Error('ask_user_question was aborted before answering');
          (err as any).code = 'ASK_ABORTED';
          reject(err);
        };
        req.signal.addEventListener('abort', onAbort, { once: true });
        entry.signalListener = onAbort;
      }

      entry.timer = setTimeout(() => {
        this.cleanupQuestion(id);
        const err = new Error('ask_user_question timed out');
        (err as any).code = 'TIMEOUT';
        reject(err);
      }, timeout);

      this.questions.set(id, entry);

      // Notify listeners
      for (const listener of this.questionListeners) {
        try {
          listener({
            id,
            sessionId: String(sessionId),
            userId,
            spaceId,
            sessionSource,
            questions: req.questions,
            createdAt,
            timeoutMs: timeout,
            status: 'pending',
          });
        } catch {
          // Ignore listener error
        }
      }
    });
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

    for (const [id, entry] of this.questions) {
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.signal && entry.signalListener) {
        entry.signal.removeEventListener('abort', entry.signalListener);
      }
      const err = new Error('External interaction plugin unloaded');
      (err as any).code = 'DISPOSED';
      entry.reject(err);
    }
    this.questions.clear();
    this.approvalListeners.clear();
    this.questionListeners.clear();
  }
}
