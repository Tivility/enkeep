import type { DatabaseSync } from 'node:sqlite';
import { type PlatformStorage, type TurnRunStatus } from '@enkeep/platform-core';
import type {
  InboundEnvelope,
  InternalRuntimeDispatchResult,
  TurnExecutionStatus,
  PublicEventCode,
} from '@enkeep/web-channel';
import { SqliteWebMessageStore, type WebMessageRecord } from '../src/storage/web-messages.js';
import {
  DeliveryRuntimeGateway,
  type DrainableRuntimeGateway,
  type DeliveryTurnExecutor,
  type QuotaMode,
  type TenantQuotaProvider,
} from '../src/runtime/delivery-gateway.js';

export interface TestOnlyRuntimeGatewayOptions {
  storage: PlatformStorage;
  messageStore: SqliteWebMessageStore;
  database?: DatabaseSync;
  autoReply?: boolean;
  autoReplyDelayMs?: number;
  customRunner?: (envelope: InboundEnvelope, turnId: string, dshSessionId: string) => Promise<{ text: string; error?: string }>;
  quotaMode?: QuotaMode;
  quotaProvider?: TenantQuotaProvider;
  profileResolver?: any;
  fileProvider?: any;
  fileService?: any;
}

/**
 * TEST-ONLY Runtime Gateway wrapper for unit and integration testing.
 * Delegates to the production DeliveryRuntimeGateway with an automatic test executor.
 */
export class TestOnlyRuntimeGateway implements DrainableRuntimeGateway {
  private readonly gateway: DeliveryRuntimeGateway;

  constructor(options: TestOnlyRuntimeGatewayOptions) {
    const db = options.database ?? (options.messageStore as unknown as { db: DatabaseSync }).db;

    const executor: DeliveryTurnExecutor = {
      execute: async (request) => {
        if (options.autoReplyDelayMs && options.autoReplyDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.autoReplyDelayMs));
        }

        if (options.customRunner) {
          const res = await options.customRunner(request.envelope as any, request.turnId, request.dshSessionId);
          if (res.error) {
            throw new Error(res.error);
          }
          return {
            replyText: res.text,
            usage: { totalTokens: 25 },
          };
        }

        return {
          replyText: `Reply to: "${request.content.slice(0, 50)}"`,
          usage: { totalTokens: 25 },
        };
      },
      cancel: async (_userId: string, _turnId: string) => {
        return true;
      },
    };

    this.gateway = new DeliveryRuntimeGateway({
      storage: options.storage,
      messageStore: options.messageStore,
      database: db,
      executor,
      profileResolver: options.profileResolver ?? {
        resolve: async () => null,
      },
      quotaMode: options.quotaMode ?? (options.quotaProvider ? 'enforced' : 'disabled'),
      quotaProvider: options.quotaProvider,
      fileProvider: options.fileProvider,
      fileService: options.fileService,
    });
  }

  async dispatchInbound(envelope: InboundEnvelope): Promise<InternalRuntimeDispatchResult> {
    return this.gateway.dispatchInbound(envelope);
  }

  async getTurnStatus(userId: string, turnId: string): Promise<{
    status: TurnExecutionStatus;
    error?: string;
  }> {
    return this.gateway.getTurnStatus(userId, turnId);
  }

  async cancelTurn(userId: string, turnId: string): Promise<boolean> {
    return this.gateway.cancelTurn(userId, turnId);
  }

  async cancelCurrentTurn(userId: string, sessionId: string): Promise<boolean> {
    return this.gateway.cancelCurrentTurn(userId, sessionId);
  }

  async getCurrentTurnStatus(userId: string, sessionId: string): Promise<{
    status: TurnExecutionStatus;
    code?: PublicEventCode;
  } | null> {
    return this.gateway.getCurrentTurnStatus(userId, sessionId);
  }

  async drain(timeoutMs?: number): Promise<boolean> {
    return this.gateway.drain(timeoutMs);
  }

  async dispose(): Promise<void> {
    return this.gateway.dispose();
  }

  async redriveHeld(): Promise<number> {
    return this.gateway.redriveHeld();
  }

  clearPending(): void {
    // No-op for compatibility
  }
}
