/**
 * Contract Test-Only Driver / Fake RuntimeGateway for Contract E2E testing.
 *
 * Requirements:
 * - MUST be named with "TestOnly"
 * - In-process definition within web-e2e test package
 * - Generates deterministic mock replies and updates turn state / web message store
 * - Adheres strictly to RuntimeGateway contract and SqliteWebMessageStore event persistence
 * - Strictly for testing, not for production
 */

import { randomUUID } from 'node:crypto';
import { ValidationError, type PlatformStorage } from '@enkeep/platform-core';
import type {
  RuntimeGateway,
  InboundEnvelope,
  PublicMessage,
  TurnExecutionStatus,
  InternalRuntimeDispatchResult,
  PublicEventCode,
} from '@enkeep/web-channel';
import type { SqliteWebMessageStore, TenantRuntimeFileProvider } from '@enkeep/platform-server';
import type { PublicMessageAttachment } from '@enkeep/protocol';

export interface TestOnlyContractRuntimeGatewayOptions {
  storage: PlatformStorage;
  messageStore: SqliteWebMessageStore;
  fileProvider?: TenantRuntimeFileProvider;
  autoReply?: boolean;
  autoReplyDelayMs?: number;
  customResponder?: (envelope: InboundEnvelope, turnId: string) => Promise<{ content: string; error?: string }>;
}

interface TestOnlyTurnRecord {
  readonly turnId: string;
  readonly sessionId: string;
  readonly spaceId: string;
  readonly userId: string;
  readonly envelope: InboundEnvelope;
  status: TurnExecutionStatus;
  timer?: NodeJS.Timeout;
  error?: string;
  result?: unknown;
}

export class TestOnlyContractRuntimeGateway implements RuntimeGateway {
  private readonly storage: PlatformStorage;
  private readonly messageStore: SqliteWebMessageStore;
  private readonly fileProvider?: TenantRuntimeFileProvider;
  private readonly autoReply: boolean;
  private readonly autoReplyDelayMs: number;
  private readonly customResponder?: (envelope: InboundEnvelope, turnId: string) => Promise<{ content: string; error?: string }>;
  private readonly pendingTimeouts = new Set<NodeJS.Timeout>();
  private readonly turns = new Map<string, TestOnlyTurnRecord>();

  public readonly dispatchedEnvelopes: InboundEnvelope[] = [];

  constructor(options: TestOnlyContractRuntimeGatewayOptions) {
    this.storage = options.storage;
    this.messageStore = options.messageStore;
    this.fileProvider = options.fileProvider;
    this.autoReply = options.autoReply ?? true;
    this.autoReplyDelayMs = options.autoReplyDelayMs ?? 15;
    this.customResponder = options.customResponder;
  }

  async dispatchInbound(envelope: InboundEnvelope): Promise<InternalRuntimeDispatchResult> {
    if (!envelope.id || !/^deliv_[0-9a-f]{32}$/.test(envelope.id)) {
      throw new ValidationError('Invalid delivery ID format');
    }
    const turnId = `turn_test_${randomUUID().replace(/-/g, '')}`;
    const sessionId = envelope.sessionId ?? '';
    let spaceId = '';
    const userId = envelope.userId;
    const dshSessionId = `dsh_sess_${sessionId}`;

    const tenant = this.storage.forTenant(userId);
    if (sessionId) {
      try {
        const route = await tenant.sessionRoutes.findById(sessionId);
        if (route) {
          spaceId = route.spaceId;
        }
      } catch {
        // Ignored
      }
    }

    const turnRecord: TestOnlyTurnRecord = {
      turnId,
      sessionId,
      spaceId,
      userId,
      envelope,
      status: 'queued',
    };

    this.dispatchedEnvelopes.push(envelope);
    this.turns.set(turnId, turnRecord);

    // Record turn in SQLite persistence
    try {
      await tenant.turnRuns.create({
        spaceId: spaceId || 'spc_default',
        routeId: sessionId,
        turnId,
        status: 'queued',
      });
    } catch {
      // Non-fatal if turnRun already exists
    }

    // Record inbound user message in SQLite persistence FIRST so foreign keys succeed
    try {
      await this.messageStore.insertMessage({
        id: envelope.id,
        sessionId,
        userId,
        role: 'user',
        content: typeof envelope.content === 'string' ? envelope.content : JSON.stringify(envelope.content),
        status: 'delivered',
        routeKey: `${userId}:web:default:${sessionId}`,
        turnId,
        createdAt: envelope.timestamp,
      });
    } catch {
      // Non-fatal if already inserted
    }

    // Process attachments snapshot copy and DTO generation
    let publicAttachments: PublicMessageAttachment[] | undefined;
    if (envelope.attachments && envelope.attachments.length > 0) {
      publicAttachments = [];
      const db = (this.messageStore as any).db;
      const attInsertStmt = db ? db.prepare(`
        INSERT OR REPLACE INTO message_attachments (
          id, message_id, user_id, space_id, relative_path, snapshot_path, etag, size, media_type, display_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `) : null;

      for (const att of envelope.attachments) {
        const attId = (att as any).id || randomUUID().replace(/-/g, '');
        const relPath = (att as any).relativePath || (att as any).path;
        const cleanEtag = String((att as any).etag || '').replace(/"/g, '');
        const filename = relPath.split('/').pop() || 'file';
        const snapshotPath = `.attachments/${cleanEtag}/${filename}`;

        let statSize = (att as any).size || 0;
        const pLower = relPath.toLowerCase();
        let inferredMediaType = (att as any).mediaType || (pLower.endsWith('.png') ? 'image/png' : (pLower.endsWith('.pdf') ? 'application/pdf' : 'text/plain'));

        if (this.fileProvider) {
          try {
            const statRes = await this.fileProvider.execute(userId, spaceId, { op: 'stat', path: relPath });
            if (statRes && typeof (statRes as any).size === 'number') {
              statSize = (statRes as any).size;
            }
          } catch {}
          try {
            await this.fileProvider.execute(userId, spaceId, {
              op: 'copy',
              path: relPath,
              targetPath: snapshotPath,
              requireAbsent: false,
            });
          } catch {}
        }

        const pubAtt: PublicMessageAttachment = {
          id: attId,
          relativePath: relPath,
          etag: (att as any).etag,
          size: statSize,
          mediaType: inferredMediaType,
          displayName: (att as any).displayName || filename,
          downloadUrl: `/api/spaces/${encodeURIComponent(spaceId)}/files/download?path=${encodeURIComponent(snapshotPath)}`,
        };
        publicAttachments.push(pubAtt);

        if (attInsertStmt) {
          try {
            attInsertStmt.run(
              attId,
              envelope.id,
              userId,
              spaceId,
              relPath,
              snapshotPath,
              (att as any).etag,
              statSize,
              inferredMediaType,
              (att as any).displayName || null,
              envelope.timestamp
            );
          } catch {}
        }
      }
    }

    const userMessage: PublicMessage = {
      id: envelope.id,
      role: 'user',
      content: typeof envelope.content === 'string' ? envelope.content : JSON.stringify(envelope.content),
      status: 'delivered',
      createdAt: envelope.timestamp,
      ...(publicAttachments && publicAttachments.length > 0 ? { attachments: publicAttachments } : {}),
    };

    if (this.autoReply || this.customResponder) {
      const timer = setTimeout(async () => {
        this.pendingTimeouts.delete(timer);
        await this.executeTurn(turnId);
      }, this.autoReplyDelayMs);
      this.pendingTimeouts.add(timer);
      turnRecord.timer = timer;
    }

    return {
      accepted: true,
      turnId,
      message: userMessage,
      isDuplicate: false,
    };
  }

  private async executeTurn(turnId: string): Promise<void> {
    const turn = this.turns.get(turnId);
    if (!turn || turn.status === 'interrupted') {
      return;
    }

    const { envelope, sessionId, spaceId, userId } = turn;
    const tenant = this.storage.forTenant(userId);
    turn.status = 'running';

    try {
      await tenant.turnRuns.updateStatus(turnId, {
        status: 'running',
        startedAt: new Date().toISOString(),
      });
    } catch {
      // Ignored
    }

    let replyContent = `[Contract-Driver-Reply] Echo: "${envelope.content}"`;
    let shouldFail = false;

    if (this.customResponder) {
      try {
        const customRes = await this.customResponder(envelope, turnId);
        replyContent = customRes.content;
      } catch (err: unknown) {
        shouldFail = true;
        turn.status = 'failed';
        const errorMsg = err instanceof Error ? err.message : String(err);
        turn.error = errorMsg || 'Execution error';
        try {
          await tenant.turnRuns.updateStatus(turnId, {
            status: 'failed',
            error: turn.error,
            finishedAt: new Date().toISOString(),
          });
        } catch {}
        return;
      }
    }

    if (!shouldFail) {
      if ((turn.status as TurnExecutionStatus) === 'interrupted') {
        return;
      }

      const timestamp = new Date().toISOString();
      const messageId = `msg_asst_${randomUUID().replace(/-/g, '')}`;
      const eventId = `evt_${randomUUID().replace(/-/g, '')}`;

      // 1. Record outbound assistant message in web_messages
      await this.messageStore.insertMessage({
        id: messageId,
        sessionId,
        userId,
        role: 'assistant',
        content: replyContent,
        status: 'delivered',
        routeKey: (envelope as unknown as { routeKey?: string }).routeKey || `${userId}:web:${spaceId}:${sessionId}`,
        turnId,
        createdAt: timestamp,
      });

      // 2. Emit WebChannelEvent matching SqlitePlatformWebApiAdapter.pollEvents payload structure
      const webMessage: PublicMessage = {
        id: messageId,
        role: 'assistant',
        content: replyContent,
        status: 'delivered',
        createdAt: timestamp,
      };

      await this.messageStore.insertEvent({
        id: eventId,
        sessionId,
        userId,
        type: 'message',
        payload: {
          message: webMessage,
        },
        createdAt: timestamp,
      });

      turn.status = 'completed';
      turn.result = { content: replyContent };
      try {
        await tenant.turnRuns.updateStatus(turnId, {
          status: 'completed',
          finishedAt: timestamp,
        });
      } catch {}
    }
  }

  async getCurrentTurnStatus(userId: string, sessionId: string): Promise<{
    readonly status: TurnExecutionStatus;
    readonly code?: PublicEventCode;
  } | null> {
    let latestActive: TestOnlyTurnRecord | null = null;
    for (const turn of this.turns.values()) {
      if (turn.userId === userId && turn.sessionId === sessionId) {
        if (turn.status === 'queued' || turn.status === 'running') {
          latestActive = turn;
        }
      }
    }

    if (!latestActive) {
      return null;
    }

    return {
      status: latestActive.status,
    };
  }

  async cancelCurrentTurn(userId: string, sessionId: string): Promise<boolean> {
    let latestActive: TestOnlyTurnRecord | null = null;
    for (const turn of this.turns.values()) {
      if (turn.userId === userId && turn.sessionId === sessionId) {
        if (turn.status === 'queued' || turn.status === 'running') {
          latestActive = turn;
        }
      }
    }

    if (!latestActive) {
      return false;
    }

    return this.cancelTurn(userId, latestActive.turnId);
  }

  async getTurnStatus(userId: string, turnId: string): Promise<{
    readonly status: TurnExecutionStatus;
    readonly error?: string;
    readonly result?: unknown;
  }> {
    const turn = this.turns.get(turnId);
    if (!turn || turn.userId !== userId) {
      return {
        status: 'failed',
        error: `Turn "${turnId}" not found or access denied`,
      };
    }

    return {
      status: turn.status,
      error: turn.error,
      result: turn.result,
    };
  }

  async cancelTurn(userId: string, turnId: string): Promise<boolean> {
    const turn = this.turns.get(turnId);
    if (!turn || turn.userId !== userId) {
      return false;
    }

    if (turn.status === 'completed' || turn.status === 'failed' || turn.status === 'interrupted') {
      return false;
    }

    if (turn.timer) {
      clearTimeout(turn.timer);
      this.pendingTimeouts.delete(turn.timer);
    }

    turn.status = 'interrupted';
    turn.error = 'Cancelled by user request';

    const tenant = this.storage.forTenant(userId);
    try {
      await tenant.turnRuns.updateStatus(turnId, {
        status: 'interrupted',
        finishedAt: new Date().toISOString(),
      });
    } catch {}

    return true;
  }

  clearPending(): void {
    for (const timer of this.pendingTimeouts) {
      clearTimeout(timer);
    }
    this.pendingTimeouts.clear();
  }
}

// Named aliases explicitly conforming to TestOnly naming requirement and Contract Driver naming
export {
  TestOnlyContractRuntimeGateway as TestOnlyFakeRuntimeGateway,
  TestOnlyContractRuntimeGateway as TestOnlyContractDriver,
};
