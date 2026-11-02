import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import type {
  PendingQuestion,
  QuestionAnswer,
  QuestionSettlement,
  UserQuestion,
} from './user-questions.js';

export type { ApprovalOutcome };
export type {
  PendingQuestion,
  QuestionAnswer,
  QuestionOption,
  QuestionOutcome,
  QuestionResolution,
  QuestionSettlement,
  QuestionStatus,
  UserQuestion,
} from './user-questions.js';

export type ApprovalRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ApprovalRequest {
  agent?: Agent;
  toolName: string;
  callId?: ToolCallId | string;
  reason?: string;
  signal?: AbortSignal;
}

export interface PendingApproval {
  id: string;
  sessionId: string;
  userId?: string;
  spaceId?: string;
  sessionSource: 'external' | 'im' | 'web' | string;
  toolName: string;
  callId?: string;
  reason?: string;
  risk: ApprovalRiskLevel;
  safeSummary: string;
  preview?: Record<string, unknown>;
  createdAt: string;
  timeoutMs: number;
  status: 'pending' | 'allowed-once' | 'rejected' | 'cancelled' | 'expired';
  decidedAt?: string;
  decisionOutcome?: ApprovalOutcome;
}

/** An option as the `ask_user_question` tool input spells it. */
export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

/** A question as the `ask_user_question` tool input spells it (`multi_select`, snake case). */
export interface AskUserQuestionItem {
  id: string;
  question: string;
  header?: string;
  options?: readonly AskUserQuestionOption[];
  multi_select?: boolean;
  [key: string]: unknown;
}

/** A question request handed to the interaction service (by the `userQuestions` provider). */
export interface AskUserQuestionRequest {
  /** Normalized questions, or tool-input items (normalized on entry). */
  questions: readonly (UserQuestion | AskUserQuestionItem)[];
  agent?: Agent;
  /** The tool call id; reused as the question id when it is usable. */
  callId?: ToolCallId | string;
  signal?: AbortSignal;
}

/** An answer item: selected option labels and/or the user's own words. */
export type AskUserQuestionAnswerItem = QuestionAnswer;

export interface AskUserQuestionAnswer {
  answers: QuestionAnswer[];
}

/** Result of {@link IExternalInteractionService.tryAnswerQuestion}. */
export type QuestionAnswerAttempt =
  | { ok: true; question: PendingQuestion; answers: QuestionAnswer[] }
  | {
      ok: false;
      /**
       * `not-found`: no such question (or forgotten); `expired`: it timed out before this answer
       * (`question` is the expired record, so the answer can be delivered as a message instead);
       * `already-settled`: answered or cancelled before; `invalid-answers`: see `message`.
       */
      code: 'not-found' | 'expired' | 'already-settled' | 'invalid-answers';
      message: string;
      question?: PendingQuestion;
    };

export interface IExternalInteractionService {
  // Approvals
  listPendingApprovals(filter?: { userId?: string; sessionId?: string }): readonly PendingApproval[];
  getPendingApproval(id: string): PendingApproval | undefined;
  answerApproval(id: string, outcome: 'allowed-once' | 'rejected'): boolean;
  cancelApproval(id: string, reason?: string): boolean;
  expireStaleApprovals(): number;

  // Questions
  listPendingQuestions(filter?: { userId?: string; sessionId?: string }): readonly PendingQuestion[];
  getPendingQuestion(id: string): PendingQuestion | undefined;
  /** Answers a pending question (`{ id, selected, custom? }` items); false when not pending or invalid. */
  answerQuestion(id: string, answers: readonly QuestionAnswer[]): boolean;
  cancelQuestion(id: string, reason?: string): boolean;
  /** Like `answerQuestion`, with the reason when the answer is not accepted. */
  tryAnswerQuestion?(id: string, answers: unknown): QuestionAnswerAttempt;

  // Event callbacks for programmatic adapters (no HTTP server)
  onApprovalAsked(handler: (pending: PendingApproval) => void): () => void;
  onQuestionAsked(handler: (pending: PendingQuestion) => void): () => void;
  onQuestionSettled?(handler: (settlement: QuestionSettlement) => void): () => void;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    externalInteraction?: IExternalInteractionService;
  }

  interface Events {
    'approval/request'(
      req: ApprovalRequest,
      next: () => Promise<ApprovalOutcome>
    ): Promise<ApprovalOutcome>;
  }
}
