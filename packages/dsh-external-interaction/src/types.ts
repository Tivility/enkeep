import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';

export type { ApprovalOutcome };

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

export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionItem {
  id: string;
  question: string;
  header?: string;
  options?: readonly AskUserQuestionOption[];
  multi_select?: boolean;
  [key: string]: unknown;
}

export interface AskUserQuestionRequest {
  questions: readonly AskUserQuestionItem[];
  agent?: Agent;
  signal?: AbortSignal;
}

export interface AskUserQuestionAnswerItem {
  id: string;
  answer: string | string[];
}

export interface AskUserQuestionAnswer {
  answers: AskUserQuestionAnswerItem[];
}

export interface PendingQuestion {
  id: string;
  sessionId: string;
  userId?: string;
  spaceId?: string;
  sessionSource: 'external' | 'im' | 'web' | string;
  questions: readonly AskUserQuestionItem[];
  createdAt: string;
  timeoutMs: number;
  status?: 'pending' | 'answered' | 'cancelled' | 'expired';
}

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
  answerQuestion(id: string, answers: Record<string, string | string[]> | AskUserQuestionAnswerItem[]): boolean;
  cancelQuestion(id: string, reason?: string): boolean;

  // Event callbacks for programmatic adapters (no HTTP server)
  onApprovalAsked(handler: (pending: PendingApproval) => void): () => void;
  onQuestionAsked(handler: (pending: PendingQuestion) => void): () => void;
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
