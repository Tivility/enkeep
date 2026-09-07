import { randomUUID } from 'node:crypto';
import { PlatformError } from '@enkeep/platform-core';
import type {
  InboundEnvelope,
  RuntimeGateway,
  InternalRuntimeDispatchResult,
  TurnExecutionStatus,
  PublicEventCode,
  PublicMessage,
} from '../src/types.js';
import type { InMemoryPlatformWebApi } from './test-platform-api.js';

export interface TurnState {
  turnId: string;
  envelope: InboundEnvelope;
  status: TurnExecutionStatus;
  createdAt: string;
  finishedAt?: string;
  code?: PublicEventCode;
  assistantResponse?: string;
}

export class InMemoryRuntimeGateway implements RuntimeGateway {
  private readonly turns = new Map<string, TurnState>();
  private readonly sessionTurns = new Map<string, string[]>();
  private autoReplyEnabled: boolean;
  private autoReplyDelayMs: number;
  private platformApi?: InMemoryPlatformWebApi;

  constructor(options: { autoReply?: boolean; autoReplyDelayMs?: number; platformApi?: InMemoryPlatformWebApi } = {}) {
    this.autoReplyEnabled = options.autoReply ?? true;
    this.autoReplyDelayMs = options.autoReplyDelayMs ?? 50;
    this.platformApi = options.platformApi;
  }

  async dispatchInbound(envelope: InboundEnvelope): Promise<InternalRuntimeDispatchResult> {
    if (!envelope.id || !/^deliv_[0-9a-f]{32}$/.test(envelope.id)) {
      throw new PlatformError('Invalid delivery ID format', 'BAD_REQUEST', 400);
    }
    const turnId = `turn_${randomUUID().replace(/-/g, '')}`;
    const sessionId = envelope.sessionId;

    const turn: TurnState = {
      turnId,
      envelope,
      status: 'queued',
      createdAt: new Date().toISOString(),
    };

    this.turns.set(turnId, turn);
    const existingList = this.sessionTurns.get(sessionId) || [];
    existingList.push(turnId);
    this.sessionTurns.set(sessionId, existingList);

    const message: PublicMessage = this.platformApi
      ? this.platformApi.seedMessage(
          envelope.userId,
          sessionId,
          envelope.content
        )
      : {
          id: envelope.id,
          role: 'user',
          content: envelope.content,
          status: 'delivered',
          createdAt: envelope.timestamp,
        };

    if (this.autoReplyEnabled) {
      setTimeout(() => {
        const t = this.turns.get(turnId);
        if (t && t.status === 'queued') {
          t.status = 'running';
          setTimeout(() => {
            if (t.status === 'running') {
              t.status = 'completed';
              t.finishedAt = new Date().toISOString();
              t.assistantResponse = `Assistant response to: "${envelope.content}"`;
            }
          }, this.autoReplyDelayMs);
        }
      }, 10);
    }

    return {
      accepted: true,
      turnId,
      message,
      isDuplicate: false,
    };
  }

  async getCurrentTurnStatus(
    userId: string,
    sessionId: string
  ): Promise<{ status: TurnExecutionStatus; code?: PublicEventCode } | null> {
    const turnIds = this.sessionTurns.get(sessionId) || [];
    for (let i = turnIds.length - 1; i >= 0; i--) {
      const t = this.turns.get(turnIds[i]);
      if (t && t.envelope.userId === userId) {
        return {
          status: t.status,
          ...(t.code ? { code: t.code } : {}),
        };
      }
    }
    return null;
  }

  async cancelCurrentTurn(userId: string, sessionId: string): Promise<boolean> {
    const turnIds = this.sessionTurns.get(sessionId) || [];
    for (let i = turnIds.length - 1; i >= 0; i--) {
      const t = this.turns.get(turnIds[i]);
      if (t && t.envelope.userId === userId) {
        if (t.status === 'queued' || t.status === 'running') {
          t.status = 'interrupted';
          t.finishedAt = new Date().toISOString();
          t.code = 'INTERRUPTED';
          return true;
        }
      }
    }
    return false;
  }
}
