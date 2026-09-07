import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  ValidationError,
  NotFoundError,
  PlatformError,
  type PlatformStorage,
  type Space,
  type SessionRoute,
} from '@enkeep/platform-core';
import { type InboundEnvelope, buildRouteKey } from '@enkeep/web-channel';
import {
  validateAgentPromptPayload,
  type AgentPromptDispatchContext,
  type AgentPromptDispatchResult,
  type AgentPromptDispatcher,
  type AgentPromptTaskPayload,
} from '@enkeep/platform-operations';
import {
  DeliveryRuntimeGateway,
} from '../runtime/delivery-gateway.js';

export interface AgentPromptCompletedResult {
  readonly status: 'completed';
  readonly completedAt: string;
}

export interface AgentPromptDeliveryDispatcherOptions {
  gateway: DeliveryRuntimeGateway;
  storage: PlatformStorage;
  database: DatabaseSync;
  maxWaitMs?: number;
  pollIntervalMs?: number;
}

interface AuthoritativeTurnRunRow {
  id: string;
  user_id: string;
  space_id: string;
  route_id: string;
  turn_id: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

interface AuthoritativeAssistantMessageRow {
  id: string;
  session_id: string;
  user_id: string;
  role: string;
  content: string;
  status: string;
  route_key: string;
  turn_id: string | null;
  created_at: string;
}

const CANONICAL_TASK_ID_PATTERN = /^task_[0-9a-f]{32}$/;
const VALID_SESSION_ID_PATTERN = /^(?:ses_[0-9a-f]{32}|import-[0-9a-f]{32})$/;
const VALID_SPACE_ID_PATTERN = /^(?:spc_[0-9a-f]{32}|impsp_[0-9a-f]{64})$/;

/**
 * Exact parser for SQLite turn_runs row (no unsafe casts or fabricated defaults).
 */
function parseTurnRunRow(raw: unknown): AuthoritativeTurnRunRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== 'string' ||
    typeof r.user_id !== 'string' ||
    typeof r.space_id !== 'string' ||
    typeof r.route_id !== 'string' ||
    typeof r.turn_id !== 'string' ||
    typeof r.status !== 'string'
  ) {
    return null;
  }
  return {
    id: r.id,
    user_id: r.user_id,
    space_id: r.space_id,
    route_id: r.route_id,
    turn_id: r.turn_id,
    status: r.status,
    started_at: typeof r.started_at === 'string' ? r.started_at : null,
    finished_at: typeof r.finished_at === 'string' ? r.finished_at : null,
    error: typeof r.error === 'string' ? r.error : null,
  };
}

/**
 * Exact parser for SQLite web_messages row (no unsafe casts or fabricated defaults, no metadata).
 */
function parseAssistantMessageRow(raw: unknown): AuthoritativeAssistantMessageRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== 'string' ||
    typeof r.session_id !== 'string' ||
    typeof r.user_id !== 'string' ||
    typeof r.role !== 'string' ||
    typeof r.content !== 'string' ||
    typeof r.status !== 'string' ||
    typeof r.route_key !== 'string' ||
    typeof r.created_at !== 'string'
  ) {
    return null;
  }
  return {
    id: r.id,
    session_id: r.session_id,
    user_id: r.user_id,
    role: r.role,
    content: r.content,
    status: r.status,
    route_key: r.route_key,
    turn_id: typeof r.turn_id === 'string' ? r.turn_id : null,
    created_at: r.created_at,
  };
}

/**
 * Canonical ISO 8601 date validator: ensures exact round-trip toISOString() match.
 */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  try {
    const d = new Date(value);
    return !Number.isNaN(d.getTime()) && d.toISOString() === value;
  } catch {
    return false;
  }
}

export class AgentPromptDeliveryDispatcher implements AgentPromptDispatcher {
  private readonly gateway: DeliveryRuntimeGateway;
  private readonly storage: PlatformStorage;
  private readonly db: DatabaseSync;
  private readonly maxWaitMs: number;
  private readonly pollIntervalMs: number;

  constructor(options: AgentPromptDeliveryDispatcherOptions) {
    this.gateway = options.gateway;
    this.storage = options.storage;
    this.db = options.database;
    const maxWait = options.maxWaitMs ?? 300_000;
    this.maxWaitMs = Number.isSafeInteger(maxWait) && maxWait > 0 ? maxWait : 300_000;
    const pollInterval = options.pollIntervalMs ?? 50;
    this.pollIntervalMs = Number.isSafeInteger(pollInterval) && pollInterval > 0 ? pollInterval : 50;
  }

  async dispatch(context: AgentPromptDispatchContext): Promise<AgentPromptDispatchResult> {
    return await this.doDispatch(context);
  }

  private async doDispatch(context: AgentPromptDispatchContext): Promise<AgentPromptDispatchResult> {
    const { task, signal, tenantId } = context;

    // Check early abort before any operation / dispatch
    if (signal.aborted) {
      throw new Error('[TASK_ABORTED] Task execution was aborted');
    }

    if (
      !task.id ||
      typeof task.id !== 'string' ||
      task.id !== task.id.trim() ||
      !CANONICAL_TASK_ID_PATTERN.test(task.id)
    ) {
      throw new ValidationError('[INVALID_TASK] Task id is required and must match canonical task format');
    }

    // 1. Validate exact AgentPromptTaskPayload contract (context.payload strictly required, no task.payload fallback)
    const payload: AgentPromptTaskPayload = validateAgentPromptPayload(context.payload);

    if (
      !payload.sessionId ||
      typeof payload.sessionId !== 'string' ||
      payload.sessionId !== payload.sessionId.trim() ||
      !VALID_SESSION_ID_PATTERN.test(payload.sessionId)
    ) {
      throw new ValidationError('[INVALID_PAYLOAD] Task payload sessionId format is invalid');
    }

    if (payload.sessionPolicy !== 'existing_session') {
      throw new ValidationError('[INVALID_PAYLOAD] Task payload sessionPolicy must be existing_session');
    }

    // Validate optional payload.spaceId format when provided
    if (payload.spaceId !== undefined) {
      if (
        typeof payload.spaceId !== 'string' ||
        payload.spaceId !== payload.spaceId.trim() ||
        !VALID_SPACE_ID_PATTERN.test(payload.spaceId)
      ) {
        throw new ValidationError('[INVALID_PAYLOAD] Task payload spaceId format is invalid');
      }
    }

    const tenantStorage = this.storage.forTenant(tenantId);

    // 2. Validate Session Route ownership and active status (strictly existing session by exact ID)
    const targetRoute: SessionRoute | null = await tenantStorage.sessionRoutes.findById(payload.sessionId);

    if (!targetRoute || targetRoute.userId !== tenantId) {
      throw new NotFoundError('[SESSION_NOT_FOUND] Session route not found for tenant');
    }
    if (targetRoute.status !== 'active') {
      throw new ValidationError('[INVALID_SESSION_ROUTE] Session route is not active');
    }

    if (targetRoute.channel !== 'web') {
      throw new ValidationError('[INVALID_SESSION_ROUTE] Session route channel must be web');
    }
    if (targetRoute.accountId !== 'web-demo') {
      throw new ValidationError('[INVALID_SESSION_ROUTE] Session route accountId must be web-demo');
    }
    if (
      !targetRoute.nativeContextId ||
      typeof targetRoute.nativeContextId !== 'string' ||
      !targetRoute.nativeContextId.trim()
    ) {
      throw new ValidationError('[INVALID_SESSION_ROUTE] Session route nativeContextId is missing or empty');
    }
    if (targetRoute.nativeContextId !== targetRoute.id) {
      throw new ValidationError('[INVALID_SESSION_ROUTE] Session route nativeContextId must match route id');
    }
    if (
      typeof targetRoute.peerId !== 'string' ||
      targetRoute.peerId.length === 0 ||
      Buffer.byteLength(targetRoute.peerId, 'utf8') > 256 ||
      targetRoute.peerId !== targetRoute.peerId.normalize('NFC') ||
      /[\p{Cc}\p{Cf}]/u.test(targetRoute.peerId)
    ) {
      throw new ValidationError('[INVALID_SESSION_ROUTE] Session route peerId is invalid');
    }

    if (
      typeof targetRoute.spaceId !== 'string' ||
      !VALID_SPACE_ID_PATTERN.test(targetRoute.spaceId)
    ) {
      throw new ValidationError('[INVALID_SESSION_ROUTE] Session route spaceId format is invalid');
    }

    // Validate Space ownership and active container status
    const targetSpace: Space | null = await tenantStorage.spaces.findById(targetRoute.spaceId);
    if (!targetSpace || targetSpace.userId !== tenantId) {
      throw new NotFoundError('[SPACE_NOT_FOUND] Space not found for tenant');
    }
    if (targetSpace.status !== 'active') {
      throw new ValidationError('[INVALID_SPACE] Space is not active');
    }
    if (targetSpace.executionMode !== 'container') {
      throw new ValidationError('[INVALID_SPACE] Space execution mode must be container');
    }

    // Validate optional payload.spaceId matches route.spaceId exactly
    if (payload.spaceId !== undefined && payload.spaceId !== targetRoute.spaceId) {
      throw new ValidationError('[SPACE_MISMATCH] Task payload spaceId does not match session route spaceId');
    }

    // 3. Construct InboundEnvelope strictly authoritative from route
    // Canonical delivery ID format: deliv_ + 32 lowercase hex UUID
    const deliveryId = `deliv_${randomUUID().replace(/-/g, '')}`;
    const nowIso = new Date().toISOString();
    const platformSessionId = targetRoute.id;

    // Simplified InboundEnvelope: id, userId, sessionId, content, timestamp
    const envelope: InboundEnvelope = {
      id: deliveryId,
      userId: tenantId,
      sessionId: platformSessionId,
      content: payload.prompt,
      timestamp: nowIso,
    };

    // Check abort again immediately before dispatch
    if (signal.aborted) {
      throw new Error('[TASK_ABORTED] Task execution was aborted');
    }

    // 4. Dispatch through DeliveryRuntimeGateway
    // Note: If dispatch fails before turnId is produced, no cancel is called.
    const dispatchRes = await this.gateway.dispatchInbound(envelope);
    if (!dispatchRes.accepted || !dispatchRes.turnId) {
      if (dispatchRes.isDuplicate) {
        throw new PlatformError(
          '[GATEWAY_DISPATCH_DUPLICATE] Inbound delivery rejected as duplicate',
          'DUPLICATE_DELIVERY',
          409
        );
      }
      throw new PlatformError(
        '[GATEWAY_DISPATCH_REJECTED] Runtime gateway rejected inbound dispatch',
        'GATEWAY_DISPATCH_REJECTED',
        502
      );
    }
    const turnId = dispatchRes.turnId;

    // 5. Execution / Polling Promise race with one awaited cancellation routine
    return await this.pollTurnExecution({
      tenantId,
      turnId,
      routeId: targetRoute.id,
      sessionId: platformSessionId,
      signal,
    });
  }

  /**
   * Polls DB turn_runs and handles AbortSignal and timeout cancellation with exact-once semantics.
   */
  private async pollTurnExecution(params: {
    tenantId: string;
    turnId: string;
    routeId: string;
    sessionId: string;
    signal: AbortSignal;
  }): Promise<AgentPromptDispatchResult> {
    const { tenantId, turnId, routeId, sessionId, signal } = params;

    let cancelPromise: Promise<boolean> | null = null;

    // Cancellation routine called and awaited exactly once
    const performCancellation = (): Promise<boolean> => {
      if (!cancelPromise) {
        cancelPromise = this.gateway.cancelTurnInternal(tenantId, turnId);
      }
      return cancelPromise;
    };

    const handleCancellation = async (reason: 'abort' | 'timeout'): Promise<AgentPromptDispatchResult> => {
      let wasCancelled = false;
      try {
        wasCancelled = await performCancellation();
      } catch {
        throw new Error('[CANCELLATION_FAILED] Turn cancellation failed');
      }

      // If wasCancelled is false, turn was already terminal before cancel was processed.
      // Accept terminal completed if authoritative completion won before cancel.
      if (!wasCancelled) {
        const terminalRun = this.queryAuthoritativeTurnRun(tenantId, routeId, turnId);
        if (terminalRun && terminalRun.status === 'completed') {
          const completedResult = this.resolveAuthoritativeCompletion({
            tenantId,
            sessionId,
            turnId,
            turnRun: terminalRun,
          });
          if (completedResult) {
            return completedResult;
          }
        }
      }

      if (reason === 'abort') {
        throw new Error('[TASK_ABORTED] Task execution was aborted');
      } else {
        throw new Error('[TURN_TIMEOUT] Turn execution timed out');
      }
    };

    // If signal is already aborted right after dispatch returned turnId
    if (signal.aborted) {
      return await handleCancellation('abort');
    }

    let onAbortListener: (() => void) | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let pollingActive = true;

    const abortPromise = new Promise<{ type: 'abort' }>((resolve) => {
      onAbortListener = () => {
        resolve({ type: 'abort' });
      };
      signal.addEventListener('abort', onAbortListener, { once: true });
    });

    const timeoutPromise = new Promise<{ type: 'timeout' }>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve({ type: 'timeout' });
      }, this.maxWaitMs);
    });

    const pollingPromise = (async (): Promise<{ type: 'completed'; result: AgentPromptDispatchResult }> => {
      while (pollingActive) {
        const turnRun = this.queryAuthoritativeTurnRun(tenantId, routeId, turnId);

        if (turnRun) {
          if (turnRun.status === 'completed') {
            const result = this.resolveAuthoritativeCompletion({
              tenantId,
              sessionId,
              turnId,
              turnRun,
            });
            return { type: 'completed', result };
          }

          if (turnRun.status === 'failed') {
            throw new Error('[TURN_EXECUTION_FAILED] Turn execution failed');
          }

          if (turnRun.status === 'interrupted') {
            throw new Error('[TURN_INTERRUPTED] Turn execution was interrupted');
          }
        }

        // Wait before next poll tick
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      }

      // If polling loop deactivated, wait indefinitely for race to settle
      return new Promise<{ type: 'completed'; result: AgentPromptDispatchResult }>(() => {});
    })();

    try {
      const winner = await Promise.race([pollingPromise, abortPromise, timeoutPromise]);

      if (winner.type === 'completed') {
        return winner.result;
      }
      if (winner.type === 'abort') {
        return await handleCancellation('abort');
      }
      if (winner.type === 'timeout') {
        return await handleCancellation('timeout');
      }

      throw new Error('[INTERNAL_ERROR] Unexpected dispatcher resolution');
    } finally {
      pollingActive = false;
      if (onAbortListener) {
        signal.removeEventListener('abort', onAbortListener);
      }
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Queries authoritative turn_runs record by tenantId, routeId, and turnId.
   */
  private queryAuthoritativeTurnRun(
    tenantId: string,
    routeId: string,
    turnId: string
  ): AuthoritativeTurnRunRow | null {
    const stmt = this.db.prepare(`
      SELECT id, user_id, space_id, route_id, turn_id, status, started_at, finished_at, error
      FROM turn_runs
      WHERE user_id = ? AND route_id = ? AND turn_id = ?
      LIMIT 1
    `);
    const raw = stmt.get(tenantId, routeId, turnId);
    return parseTurnRunRow(raw);
  }

  /**
   * Queries authoritative assistant message in web_messages by tenantId, sessionId, and turnId.
   * Note: No metadata column selected.
   */
  private queryAuthoritativeAssistantMessage(
    tenantId: string,
    sessionId: string,
    turnId: string
  ): AuthoritativeAssistantMessageRow | null {
    const stmt = this.db.prepare(`
      SELECT id, session_id, user_id, role, content, status, route_key, turn_id, created_at
      FROM web_messages
      WHERE user_id = ? AND session_id = ? AND turn_id = ? AND role = 'assistant'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `);
    const raw = stmt.get(tenantId, sessionId, turnId);
    return parseAssistantMessageRow(raw);
  }

  /**
   * Resolves authoritative completion output strictly from SQLite records.
   * Fails protocol if finished_at is missing/invalid ISO, assistant message is missing,
   * status is not delivered, or content is empty.
   * Returns exact typed literal without leaking turnId, sessionId, spaceId, messageId, or raw replyText.
   */
  private resolveAuthoritativeCompletion(params: {
    tenantId: string;
    sessionId: string;
    turnId: string;
    turnRun: AuthoritativeTurnRunRow;
  }): AgentPromptDispatchResult {
    const { tenantId, sessionId, turnId, turnRun } = params;

    // 1. Authoritative finished_at canonical ISO verification
    if (!isValidIsoDate(turnRun.finished_at)) {
      throw new ValidationError(
        '[PROTOCOL_VIOLATION] Completed turn missing canonical finished_at ISO timestamp'
      );
    }

    // 2. Authoritative assistant message verification in web_messages
    const assistantMsg = this.queryAuthoritativeAssistantMessage(tenantId, sessionId, turnId);
    if (!assistantMsg) {
      throw new ValidationError(
        '[PROTOCOL_VIOLATION] Missing authentic assistant message for completed turn'
      );
    }

    // Require exact delivered status
    if (assistantMsg.status !== 'delivered') {
      throw new ValidationError(
        '[PROTOCOL_VIOLATION] Assistant message status must be delivered'
      );
    }

    // Require authentic non-empty content
    if (typeof assistantMsg.content !== 'string' || assistantMsg.content.trim().length === 0) {
      throw new ValidationError(
        '[PROTOCOL_VIOLATION] Assistant message has empty or invalid content'
      );
    }

    const result: AgentPromptDispatchResult = {
      status: 'completed',
      completedAt: turnRun.finished_at,
    };

    return result;
  }
}

export function createAgentPromptDeliveryDispatcher(
  options: AgentPromptDeliveryDispatcherOptions
): AgentPromptDeliveryDispatcher {
  return new AgentPromptDeliveryDispatcher(options);
}
