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
import { type InboundEnvelope, buildRouteKey, DEFAULT_INTERACTIVE_TURN_TIMEOUT_MS } from '@enkeep/web-channel';
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
import { SPACE_ID_REGEX } from '../files/runtime-file-api.js';

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

const CANONICAL_TASK_ID_PATTERN = /^(?:task_[0-9a-f]{32}|task_hpc_[0-9a-f]{24})$/;
const VALID_SESSION_ID_PATTERN = /^(?:ses_[0-9a-f]{32}|import-[0-9a-f]{32})$/;
const VALID_SPACE_ID_PATTERN = SPACE_ID_REGEX;

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
    const maxWait = options.maxWaitMs ?? DEFAULT_INTERACTIVE_TURN_TIMEOUT_MS;
    this.maxWaitMs = Number.isSafeInteger(maxWait) && maxWait > 0 ? maxWait : DEFAULT_INTERACTIVE_TURN_TIMEOUT_MS;
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

    // Execution budget validation (strictly server-owned, optional)
    let effectiveMaxWaitMs = this.maxWaitMs;
    if (context.executionBudget !== undefined) {
      if (
        !context.executionBudget ||
        typeof context.executionBudget !== 'object' ||
        Array.isArray(context.executionBudget)
      ) {
        throw new ValidationError('[INVALID_EXECUTION_BUDGET] Execution budget must be a plain object');
      }
      for (const key of Object.keys(context.executionBudget)) {
        if (key !== 'maxWaitMs') {
          throw new ValidationError('[INVALID_EXECUTION_BUDGET] Execution budget contains unrecognized field');
        }
      }
      if (context.executionBudget.maxWaitMs !== undefined) {
        const wait = context.executionBudget.maxWaitMs;
        if (typeof wait !== 'number' || !Number.isSafeInteger(wait) || wait <= 0 || wait > DEFAULT_INTERACTIVE_TURN_TIMEOUT_MS) {
          throw new ValidationError(
            `[INVALID_EXECUTION_BUDGET] Execution budget maxWaitMs must be a finite integer between 1 and ${DEFAULT_INTERACTIVE_TURN_TIMEOUT_MS}`
          );
        }
        effectiveMaxWaitMs = wait;
      }
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

    if (payload.sessionPolicy !== 'existing_session' && payload.sessionPolicy !== 'isolated') {
      throw new ValidationError('[INVALID_PAYLOAD] Task payload sessionPolicy must be existing_session or isolated');
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

    if (
      typeof targetRoute.channel !== 'string' ||
      !targetRoute.channel.trim() ||
      targetRoute.channel.length > 64
    ) {
      throw new ValidationError('[INVALID_SESSION_ROUTE] Session route channel is missing or invalid');
    }
    if (
      typeof targetRoute.accountId !== 'string' ||
      !targetRoute.accountId.trim() ||
      targetRoute.accountId.length > 128
    ) {
      throw new ValidationError('[INVALID_SESSION_ROUTE] Session route accountId is missing or invalid');
    }
    if (
      !targetRoute.nativeContextId ||
      typeof targetRoute.nativeContextId !== 'string' ||
      !targetRoute.nativeContextId.trim() ||
      targetRoute.nativeContextId.length > 256
    ) {
      throw new ValidationError('[INVALID_SESSION_ROUTE] Session route nativeContextId is missing or invalid');
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

    // Validate Space ownership and active status
    const targetSpace: Space | null = await tenantStorage.spaces.findById(targetRoute.spaceId);
    if (!targetSpace || targetSpace.userId !== tenantId) {
      throw new NotFoundError('[SPACE_NOT_FOUND] Space not found for tenant');
    }
    if (targetSpace.status !== 'active') {
      throw new ValidationError('[INVALID_SPACE] Space is not active');
    }
    // Authoritative executionMode derived from space: must be 'container' or 'host'
    if (targetSpace.executionMode !== 'container' && targetSpace.executionMode !== 'host') {
      throw new ValidationError('[INVALID_SPACE] Space execution mode must be container or host');
    }

    // Validate optional payload.spaceId matches route.spaceId exactly
    if (payload.spaceId !== undefined && payload.spaceId !== targetRoute.spaceId) {
      throw new ValidationError('[SPACE_MISMATCH] Task payload spaceId does not match session route spaceId');
    }

    // Validate optional payload.spaceFolder matches space.folder exactly
    if (payload.spaceFolder !== undefined && payload.spaceFolder !== targetSpace.folder) {
      throw new ValidationError('[SPACE_FOLDER_MISMATCH] Task payload spaceFolder does not match target space folder');
    }

    let ephemeralRoute: SessionRoute | null = null;

    if (payload.sessionPolicy === 'existing_session') {
      // Authoritative canonical session validation
      const spaceRow = this.db
        .prepare('SELECT canonical_session_id FROM spaces WHERE id = ? AND user_id = ? LIMIT 1')
        .get(targetSpace.id, tenantId) as { canonical_session_id: string | null } | undefined;

      const currentCanonicalId = spaceRow?.canonical_session_id ?? null;
      if (currentCanonicalId && currentCanonicalId !== targetRoute.id) {
        const canonRoute = this.db
          .prepare('SELECT id, status FROM session_routes WHERE id = ? AND space_id = ? AND user_id = ? LIMIT 1')
          .get(currentCanonicalId, targetSpace.id, tenantId) as { id: string; status: string } | undefined;

        if (canonRoute && canonRoute.status === 'active') {
          throw new ValidationError('[NON_CANONICAL_SESSION] Specified session is not the canonical session for space');
        }
        // Stale or archived canonical session: rebind space canonical_session_id to active targetRoute
        this.db
          .prepare('UPDATE spaces SET canonical_session_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
          .run(targetRoute.id, targetSpace.id, tenantId);
      } else if (!currentCanonicalId) {
        // First active session: set as canonical_session_id to preserve onecanonical invariant
        this.db
          .prepare('UPDATE spaces SET canonical_session_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
          .run(targetRoute.id, targetSpace.id, tenantId);
      }

      // Sync session_routes executionMode with authoritative space executionMode if divergent
      if (targetRoute.executionMode !== targetSpace.executionMode) {
        this.db
          .prepare('UPDATE session_routes SET execution_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
          .run(targetSpace.executionMode, targetRoute.id, tenantId);
      }
    } else {
      // payload.sessionPolicy === 'isolated'
      // Create fresh ephemeral session in the same space without mutating canonical_session_id
      const ephemeralSessionId = `ses_${randomUUID().replace(/-/g, '').toLowerCase()}`;
      const ephemeralDshSessionId = `ses_${randomUUID().replace(/-/g, '').toLowerCase()}`;
      const title = `[Task] ${task.title}`;

      ephemeralRoute = await tenantStorage.sessionRoutes.create({
        id: ephemeralSessionId,
        spaceId: targetSpace.id,
        channel: 'web',
        accountId: 'default',
        nativeContextId: ephemeralSessionId,
        peerId: `web:${ephemeralSessionId}`,
        dshSessionId: ephemeralDshSessionId,
        executionMode: targetSpace.executionMode,
        title,
        agentProfileId: targetRoute.agentProfileId ?? null,
        agentProfileSnapshotId: targetRoute.agentProfileSnapshotId ?? null,
      });
    }

    const dispatchRoute = ephemeralRoute ?? targetRoute;

    // 3. Construct InboundEnvelope strictly authoritative from route
    // Canonical delivery ID format: deliv_ + 32 lowercase hex UUID
    const deliveryId = `deliv_${randomUUID().replace(/-/g, '')}`;
    const nowIso = new Date().toISOString();
    const platformSessionId = dispatchRoute.id;

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
      if (ephemeralRoute) {
        await tenantStorage.sessionRoutes.archive(ephemeralRoute.id).catch(() => {});
      }
      throw new Error('[TASK_ABORTED] Task execution was aborted');
    }

    // 4. Dispatch through DeliveryRuntimeGateway with server-owned execution budget option
    const dispatchOptions = context.executionBudget?.maxWaitMs !== undefined
      ? { timeoutMs: effectiveMaxWaitMs }
      : undefined;

    let dispatchRes;
    try {
      dispatchRes = await this.gateway.dispatchInbound(envelope, dispatchOptions);
    } catch (dispatchErr) {
      if (ephemeralRoute) {
        await tenantStorage.sessionRoutes.archive(ephemeralRoute.id).catch(() => {});
      }
      throw dispatchErr;
    }

    if (!dispatchRes.accepted || !dispatchRes.turnId) {
      if (ephemeralRoute) {
        await tenantStorage.sessionRoutes.archive(ephemeralRoute.id).catch(() => {});
      }
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

    // Record session_id and turn_id in task_runs if task run record exists
    try {
      if (task.currentRun?.id) {
        this.db
          .prepare('UPDATE task_runs SET session_id = ?, turn_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
          .run(dispatchRoute.id, turnId, task.currentRun.id, tenantId);
      } else if (task.id) {
        this.db
          .prepare("UPDATE task_runs SET session_id = ?, turn_id = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND user_id = ? AND status IN ('claimed', 'running')")
          .run(dispatchRoute.id, turnId, task.id, tenantId);
      }
    } catch {
      // Best-effort update if task_runs table exists
    }

    // 5. Execution / Polling Promise race with one awaited cancellation routine
    let dispatchResult: AgentPromptDispatchResult | undefined;
    let dispatchError: unknown;
    try {
      dispatchResult = await this.pollTurnExecution({
        tenantId,
        turnId,
        routeId: dispatchRoute.id,
        sessionId: platformSessionId,
        signal,
        maxWaitMs: effectiveMaxWaitMs,
      });
      return dispatchResult;
    } catch (err: unknown) {
      dispatchError = err;
      throw err;
    } finally {
      if (ephemeralRoute) {
        try {
          await this.notifySourceSessionOnIsolatedCompletion({
            tenantId,
            sourceSessionId: payload.sessionId,
            ephemeralRouteId: ephemeralRoute.id,
            turnId,
            task,
            dispatchError,
          });
        } catch {
          // Failure to notify should not mask original outcome
        }

        try {
          await tenantStorage.sessionRoutes.archive(ephemeralRoute.id);
        } catch {
          // Preserve debuggable outcome without masking original error
        }
      }
    }
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
    maxWaitMs: number;
  }): Promise<AgentPromptDispatchResult> {
    const { tenantId, turnId, routeId, sessionId, signal, maxWaitMs } = params;

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
      }, maxWaitMs);
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

  /**
   * Notifies the source session when an isolated session (/sw background task) completes or fails.
   * Inserts into web_messages and web_events for the source session if active.
   * Strictly truncates notification card to <= 2000 characters.
   */
  private async notifySourceSessionOnIsolatedCompletion(params: {
    tenantId: string;
    sourceSessionId: string;
    ephemeralRouteId: string;
    turnId: string;
    task: { id: string; title: string };
    dispatchError?: unknown;
  }): Promise<void> {
    const { tenantId, sourceSessionId, ephemeralRouteId, turnId, task, dispatchError } = params;

    const tenantStorage = this.storage.forTenant(tenantId);
    const targetRoute = await tenantStorage.sessionRoutes.findById(sourceSessionId);
    if (!targetRoute || targetRoute.status !== 'active') {
      return;
    }

    const shortId = task.id.startsWith('task_') ? task.id.slice(5, 9) : task.id.slice(0, 4);
    const displayTitle = task.title ? task.title.replace(/^⚡\s*/, '') : '';

    let notifyContent: string;
    if (!dispatchError) {
      const assistantMsg = this.queryAuthoritativeAssistantMessage(tenantId, ephemeralRouteId, turnId);
      const rawContent = assistantMsg?.content ?? '';
      const header = `⚡ 并行任务已完成 [${shortId}] ${displayTitle}\n\n`;
      const maxSummaryLen = Math.max(0, 2000 - header.length);
      const summary = rawContent.length > maxSummaryLen ? rawContent.slice(0, maxSummaryLen) : rawContent;
      notifyContent = `${header}${summary}`;
    } else {
      const errMsg = dispatchError instanceof Error ? dispatchError.message : String(dispatchError);
      const header = `⚡ 并行任务失败 [${shortId}] ${displayTitle}\n\n`;
      const maxErrLen = Math.max(0, 2000 - header.length);
      const errSummary = errMsg.length > maxErrLen ? errMsg.slice(0, maxErrLen) : errMsg;
      notifyContent = `${header}${errSummary}`;
    }

    if (notifyContent.length > 2000) {
      notifyContent = notifyContent.slice(0, 2000);
    }

    const nowIso = new Date().toISOString();
    const messageId = `msg_${randomUUID().replace(/-/g, '').toLowerCase()}`;
    const eventId = `evt_${randomUUID().replace(/-/g, '').toLowerCase()}`;
    const routeKey = `${tenantId}:web:${targetRoute.spaceId}:${sourceSessionId}`;

    const messageRecord = {
      id: messageId,
      sessionId: sourceSessionId,
      userId: tenantId,
      role: 'assistant',
      content: notifyContent,
      status: 'delivered',
      createdAt: nowIso,
    };

    try {
      this.db.prepare(`
        INSERT INTO web_messages (
          id, session_id, user_id, role, content, status, route_key, turn_id, created_at
        ) VALUES (?, ?, ?, 'assistant', ?, 'delivered', ?, NULL, ?)
      `).run(
        messageId,
        sourceSessionId,
        tenantId,
        notifyContent,
        routeKey,
        nowIso
      );

      this.db.prepare(`
        INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
        VALUES (?, ?, ?, 'message', ?, ?)
      `).run(
        eventId,
        sourceSessionId,
        tenantId,
        JSON.stringify({ message: messageRecord }),
        nowIso
      );
    } catch {
      // Notification insertion error should not break dispatcher
    }
  }
}

export function createAgentPromptDeliveryDispatcher(
  options: AgentPromptDeliveryDispatcherOptions
): AgentPromptDeliveryDispatcher {
  return new AgentPromptDeliveryDispatcher(options);
}
