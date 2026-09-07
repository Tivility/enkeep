import { randomBytes, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  PlatformError,
  NotFoundError,
  ValidationError,
  type PlatformStorage,
  type EffectiveModelSelection,
  type ExecutionMode,
  type RuntimeMountSpec,
  type RuntimeMountResolver,
  type ExtensionActivationPlan,
  type ExtensionPlanResolver,
} from '@enkeep/platform-core';
import type {
  InboundEnvelope,
  RuntimeGateway,
  InternalRuntimeDispatchResult,
  TurnExecutionStatus,
  PublicEventCode,
} from '@enkeep/web-channel';
import {
  SqliteWebMessageStore,
  computeCanonicalRequestHash,
  type WebMessageRecord,
  type IngestWebDeliveryResult,
} from '../storage/web-messages.js';
import type { RuntimeAgentProfileSnapshot } from '../profiles/profile-service.js';
import type { RuntimeFileApiService, TenantRuntimeFileProvider } from '../files/runtime-file-api.js';
import { sniffMimeType } from '../files/file-transport-utils.js';
import type { CanonicalAttachment, PublicMessageAttachment } from '@enkeep/protocol';
import type { ModelSelectionService } from '../models/model-selection-service.js';
import { DELIVERY_ID_REGEX } from '@enkeep/platform-operations';

export interface TurnExecutionResult {
  replyText: string;
  usage?: {
    totalTokens: number;
  };
}

export interface SessionProfileResolver {
  resolve(
    userId: string,
    sessionRouteId: string,
    generation: number
  ): Promise<RuntimeAgentProfileSnapshot | null>;
}

export interface ResolvedDeliveryTurnEnvelope {
  readonly id: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly spaceId: string;
  readonly content: string;
  readonly attachments?: readonly CanonicalAttachment[];
  readonly timestamp: string;
}

export interface DeliveryExecutionRequest {
  readonly userId: string;
  readonly platformSpaceId: string;
  readonly workspaceFolder: string;
  readonly dshSessionId: string;
  readonly turnId: string;
  readonly content: string;
  readonly attachments?: readonly CanonicalAttachment[];
  readonly profile: RuntimeAgentProfileSnapshot | null;
  readonly modelSelection?: EffectiveModelSelection | null;
  readonly envelope: ResolvedDeliveryTurnEnvelope;
  readonly executionMode?: ExecutionMode;
  readonly mounts?: readonly RuntimeMountSpec[];
  readonly extensionPlan?: ExtensionActivationPlan | null;
}

export type InspectedTurnErrorCode =
  | 'EXECUTION_FAILED'
  | 'TURN_TIMEOUT'
  | 'TURN_CANCELLED'
  | 'QUOTA_EXCEEDED'
  | 'INTERRUPTED'
  | 'SESSION_CORRUPTED';

export interface InspectedTurnResult {
  readonly status: 'absent' | 'running' | 'completed' | 'failed';
  readonly result?: TurnExecutionResult;
  readonly errorCode?: InspectedTurnErrorCode;
}

export interface DeliveryTurnExecutor {
  execute(
    request: DeliveryExecutionRequest
  ): Promise<TurnExecutionResult>;
  cancel(userId: string, turnId: string): Promise<boolean>;
  inspectTurnResult?(query: {
    userId: string;
    turnId: string;
    dshSessionId: string;
  }): Promise<InspectedTurnResult>;
}

export type RuntimeTurnExecutor = DeliveryTurnExecutor;

export interface DrainableRuntimeGateway extends RuntimeGateway {
  drain(timeoutMs?: number): Promise<boolean>;
  redriveHeld(): Promise<number>;
  recoverQueuedTurns?(): Promise<number>;
  getCurrentTurnStatus(userId: string, sessionId: string): Promise<{ status: TurnExecutionStatus; code?: PublicEventCode; queuePosition?: number } | null>;
  cancelCurrentTurn(userId: string, sessionId: string): Promise<boolean>;
}

export function isDrainableRuntimeGateway(gateway: unknown): gateway is DrainableRuntimeGateway {
  return (
    typeof gateway === 'object' &&
    gateway !== null &&
    typeof (gateway as DrainableRuntimeGateway).drain === 'function' &&
    typeof (gateway as DrainableRuntimeGateway).redriveHeld === 'function'
  );
}

export type QuotaMode = 'disabled' | 'enforced';

export interface QuotaReservationBundle {
  readonly reservationId: string;
  readonly userId: string;
  readonly turns: number;
  readonly messages: number;
  readonly tokens: number;
  readonly isEstimateTokens: boolean;
  commit(actualUsage: { turns: number; messages: number; tokens: number }): Promise<void>;
  release(): Promise<void>;
  renew(extendSeconds: number): Promise<void>;
  commitInTransaction(db: DatabaseSync, actualUsage: { turns: number; messages: number; tokens: number }): void;
  releaseInTransaction(db: DatabaseSync): void;
}

export interface QuotaReservationRequest {
  userId: string;
  sessionId: string;
  deliveryId: string;
  turns: number;
  messages: number;
  tokens: number;
  isEstimateTokens: boolean;
  ttlSeconds?: number;
}

export interface TenantQuotaProvider {
  reserve(request: QuotaReservationRequest): Promise<QuotaReservationBundle>;
  recoverReservation?(deliveryId: string, userId?: string): Promise<QuotaReservationBundle | null>;
  getLastCommittedTokens?(userId: string, sessionId: string): Promise<number>;
}

export class QuotaExceededError extends PlatformError {
  constructor(message = 'Quota exceeded', resource?: string, requested?: number, available?: number, limit?: number) {
    super(message, 'QUOTA_EXCEEDED', 429);
    (this as any).resource = resource;
    (this as any).requested = requested;
    (this as any).available = available;
    (this as any).limit = limit;
  }
}

export function generate32HexId(prefix: 'deliv' | 'turn' | 'msg' | 'run' | 'evt' | 'idem' | 'inbox' | 'att' | 'attc' | 'lease' | 'rec'): string {
  return `${prefix}_${randomBytes(16).toString('hex').toLowerCase()}`;
}

export function estimateInboundTokens(content: string): { estimatedTokens: number; isEstimateTokens: true } {
  if (typeof content !== 'string' || content.length === 0) {
    throw new ValidationError('Inbound envelope content must be a non-empty string');
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  const estimatedTokens = Math.ceil(bytes / 4);
  return { estimatedTokens, isEstimateTokens: true };
}

export function computeTurnReservationTokens(params: {
  inboundTokens: number;
  lastCommittedTokens?: number;
  floor?: number;
  growthFactor?: number;
  ceiling?: number;
}): number {
  const inbound = Math.max(1, Number.isSafeInteger(params.inboundTokens) && params.inboundTokens > 0 ? params.inboundTokens : 1);
  const floor = params.floor !== undefined && Number.isSafeInteger(params.floor) && params.floor >= 0 ? params.floor : 4096;
  const lastActual = params.lastCommittedTokens !== undefined && Number.isSafeInteger(params.lastCommittedTokens) && params.lastCommittedTokens > 0 ? params.lastCommittedTokens : 0;
  const growth = params.growthFactor !== undefined && Number.isFinite(params.growthFactor) && params.growthFactor >= 1.0 ? params.growthFactor : 1.25;
  const ceiling = params.ceiling !== undefined && Number.isSafeInteger(params.ceiling) && params.ceiling > 0 ? params.ceiling : 128000;

  const base = Math.max(inbound, floor, lastActual);
  const rawEstimate = Math.ceil(base * growth);
  return Math.min(ceiling, Math.max(1, rawEstimate));
}

export function isCorruptedSessionError(err: unknown): boolean {
  if (!err) return false;
  const msg = String((err as any)?.message || err).toLowerCase();
  const name = String((err as any)?.name || '').toLowerCase();
  const code = String((err as any)?.code || '').toLowerCase();
  return (
    msg.includes('persisted_session_resume_failed') ||
    msg.includes('seq gap') ||
    msg.includes('sequence break') ||
    msg.includes('corrupted or unreadable persisted session data') ||
    msg.includes('recovery_required') ||
    msg.includes('session_corrupted') ||
    code.includes('persisted_session_resume_failed') ||
    code.includes('session_corrupted') ||
    code.includes('recovery_required')
  );
}

export function extractActualUsage(
  usage: unknown,
  _reservedEstimateTokens?: number
): { tokens: number } {
  if (usage === undefined || usage === null) {
    throw new ValidationError('Missing required usage: executor must report actual totalTokens');
  }
  if (typeof usage !== 'object' || Array.isArray(usage)) {
    throw new ValidationError('Malformed usage: must be an object');
  }
  const usageObj = usage as Record<string, unknown>;
  const keys = Object.keys(usageObj);
  for (const k of keys) {
    if (k !== 'totalTokens') {
      throw new ValidationError('Unknown key in usage: only totalTokens is supported');
    }
  }
  if (!('totalTokens' in usageObj)) {
    throw new ValidationError('Missing required "totalTokens" in usage');
  }
  const totalTokens = usageObj.totalTokens;
  if (
    typeof totalTokens !== 'number' ||
    !Number.isSafeInteger(totalTokens) ||
    totalTokens < 0
  ) {
    throw new ValidationError('Malformed totalTokens: must be a non-negative safe integer');
  }
  return { tokens: totalTokens };
}

type ReservationState = 'pending' | 'committing' | 'committed' | 'releasing' | 'released';

export class ManagedReservationBundle implements QuotaReservationBundle {
  private state: ReservationState = 'pending';
  private inFlightCommit?: Promise<void>;
  private inFlightRelease?: Promise<void>;

  readonly reservationId: string;
  readonly userId: string;
  readonly turns: number;
  readonly messages: number;
  readonly tokens: number;
  readonly isEstimateTokens: boolean;

  constructor(
    private readonly rawBundle: QuotaReservationBundle,
    private readonly expectedRequest: QuotaReservationRequest
  ) {
    if (!rawBundle || typeof rawBundle !== 'object') {
      throw new PlatformError(
        'Tenant Quota Provider returned an invalid bundle (null or non-object).',
        'INVALID_QUOTA_PROVIDER_RESPONSE',
        500
      );
    }

    if (
      !rawBundle.reservationId ||
      typeof rawBundle.reservationId !== 'string' ||
      rawBundle.reservationId.trim() === ''
    ) {
      throw new PlatformError(
        'Tenant Quota Provider must return an authoritative bundle with a non-empty reservationId (no fabricated IDs permitted).',
        'INVALID_QUOTA_PROVIDER_RESPONSE',
        500
      );
    }

    if (rawBundle.userId !== expectedRequest.userId) {
      throw new PlatformError(
        'Quota reservation userId does not match requested userId.',
        'INVALID_QUOTA_PROVIDER_RESPONSE',
        500
      );
    }

    if (
      typeof rawBundle.turns !== 'number' ||
      !Number.isSafeInteger(rawBundle.turns) ||
      rawBundle.turns <= 0 ||
      rawBundle.turns !== expectedRequest.turns
    ) {
      throw new PlatformError(
        'Tenant Quota Provider must return valid safe positive turns matching expected turns.',
        'INVALID_QUOTA_PROVIDER_RESPONSE',
        500
      );
    }

    if (
      typeof rawBundle.messages !== 'number' ||
      !Number.isSafeInteger(rawBundle.messages) ||
      rawBundle.messages <= 0 ||
      rawBundle.messages !== expectedRequest.messages
    ) {
      throw new PlatformError(
        'Tenant Quota Provider must return valid safe positive messages matching expected messages.',
        'INVALID_QUOTA_PROVIDER_RESPONSE',
        500
      );
    }

    if (
      typeof rawBundle.tokens !== 'number' ||
      !Number.isSafeInteger(rawBundle.tokens) ||
      rawBundle.tokens < 0 ||
      rawBundle.tokens !== expectedRequest.tokens
    ) {
      throw new PlatformError(
        'Tenant Quota Provider returned tokens which do not match requested tokens.',
        'INVALID_QUOTA_PROVIDER_RESPONSE',
        500
      );
    }

    if (
      typeof rawBundle.commit !== 'function' ||
      typeof rawBundle.release !== 'function' ||
      typeof rawBundle.commitInTransaction !== 'function' ||
      typeof rawBundle.releaseInTransaction !== 'function'
    ) {
      throw new PlatformError(
        'Quota reservation bundle must implement commit(), release(), commitInTransaction(), and releaseInTransaction() methods.',
        'INVALID_QUOTA_PROVIDER_RESPONSE',
        500
      );
    }

    this.reservationId = rawBundle.reservationId;
    this.userId = rawBundle.userId;
    this.turns = rawBundle.turns;
    this.messages = rawBundle.messages;
    this.tokens = rawBundle.tokens;
    this.isEstimateTokens = !!rawBundle.isEstimateTokens;
  }

  async commit(actualUsage: { turns: number; messages: number; tokens: number }): Promise<void> {
    if (this.state === 'committed') return;
    if (this.state === 'released') {
      throw new PlatformError('Cannot commit already released quota reservation bundle', 'ILLEGAL_STATE', 409);
    }
    if (this.state === 'committing' && this.inFlightCommit) {
      return this.inFlightCommit;
    }

    this.state = 'committing';
    this.inFlightCommit = (async () => {
      try {
        await this.rawBundle.commit(actualUsage);
        this.state = 'committed';
      } catch (err) {
        this.state = 'pending';
        throw err;
      } finally {
        this.inFlightCommit = undefined;
      }
    })();
    return this.inFlightCommit;
  }

  async release(): Promise<void> {
    if (this.state === 'released') return;
    if (this.state === 'committed') return;
    if (this.state === 'releasing' && this.inFlightRelease) {
      return this.inFlightRelease;
    }

    this.state = 'releasing';
    this.inFlightRelease = (async () => {
      try {
        await this.rawBundle.release();
        this.state = 'released';
      } catch (err) {
        this.state = 'pending';
        throw err;
      } finally {
        this.inFlightRelease = undefined;
      }
    })();
    return this.inFlightRelease;
  }

  async renew(extendSeconds: number): Promise<void> {
    if (this.state === 'committed' || this.state === 'released') return;
    await this.rawBundle.renew(extendSeconds);
  }

  commitInTransaction(db: DatabaseSync, actualUsage: { turns: number; messages: number; tokens: number }): void {
    if (this.state === 'committed') return;
    if (this.state === 'released') {
      throw new PlatformError('Cannot commit already released quota reservation bundle', 'ILLEGAL_STATE', 409);
    }
    try {
      this.rawBundle.commitInTransaction(db, actualUsage);
      this.state = 'committed';
    } catch (err) {
      this.state = 'pending';
      throw err;
    }
  }

  releaseInTransaction(db: DatabaseSync): void {
    if (this.state === 'released') return;
    if (this.state === 'committed') return;
    this.rawBundle.releaseInTransaction(db);
    this.state = 'released';
  }
}

export interface DeliveryRuntimeGatewayOptions {
  storage: PlatformStorage;
  messageStore: SqliteWebMessageStore;
  database?: DatabaseSync;
  executor: DeliveryTurnExecutor;
  quotaMode: QuotaMode;
  quotaProvider?: TenantQuotaProvider;
  profileResolver: SessionProfileResolver;
  fileService?: RuntimeFileApiService;
  fileProvider?: TenantRuntimeFileProvider;
  modelSelectionService?: ModelSelectionService;
  externalInteractionService?: {
    listPendingApprovals?: (opts?: { userId?: string; sessionId?: string; status?: string }) => Array<{ id: string; status: string; sessionId?: string; userId?: string }>;
  };
  mountResolver?: RuntimeMountResolver;
  extensionResolver?: ExtensionPlanResolver;
  quotaTokenFloor?: number;
  quotaTokenGrowthFactor?: number;
  quotaTokenCeiling?: number;
}

function safeChangesCount(changes: number | bigint | undefined): number {
  if (typeof changes === 'bigint') return Number(changes);
  if (typeof changes === 'number') return changes;
  return 0;
}

interface ActiveTurnTask {
  turnId: string;
  userId: string;
  sessionId: string;
  spaceId: string;
  leaseId: string;
  workerId: string;
  reservationBundle?: ManagedReservationBundle;
  heartbeatTimer?: NodeJS.Timeout;
  promise: Promise<void>;
  cancelRequested?: boolean;
  leaseLost?: boolean;
}

interface SessionRouteRow {
  id: string;
  user_id: string;
  space_id: string;
  channel: 'web';
  account_id: string;
  native_context_id: string;
  peer_id: string;
  dsh_session_id: string;
  execution_mode: string;
  status: string;
  current_generation?: number;
}

interface SpaceRow {
  id: string;
  user_id: string;
  status: string;
}

export class DeliveryRuntimeGateway implements DrainableRuntimeGateway {
  private readonly storage: PlatformStorage;
  private readonly messageStore: SqliteWebMessageStore;
  private readonly db: DatabaseSync;
  private readonly executor: DeliveryTurnExecutor;
  private readonly quotaMode: QuotaMode;
  private readonly quotaProvider?: TenantQuotaProvider;
  private readonly profileResolver: SessionProfileResolver;
  private readonly fileService?: RuntimeFileApiService;
  private readonly fileProvider?: TenantRuntimeFileProvider;
  private readonly modelSelectionService?: ModelSelectionService;
  private readonly externalInteractionService?: {
    listPendingApprovals?: (opts?: { userId?: string; sessionId?: string; status?: string }) => Array<{ id: string; status: string; sessionId?: string; userId?: string }>;
  };
  private mountResolver?: RuntimeMountResolver;
  private extensionResolver?: ExtensionPlanResolver;
  private readonly quotaTokenFloor: number;
  private readonly quotaTokenGrowthFactor: number;
  private readonly quotaTokenCeiling: number;

  private readonly workerBootId: string;
  private readonly activeTasks = new Map<string, ActiveTurnTask>();
  private readonly settledErrors: Error[] = [];
  private readonly turnCompletedListeners = new Set<(event: {
    userId: string;
    sessionId: string;
    spaceId: string;
    turnId: string;
    deliveryId: string;
    idempotencyKey: string;
    executionResult: TurnExecutionResult;
    tokenUsage: { tokens: number };
  }) => Promise<void> | void>();
  private readonly turnFailedListeners = new Set<(event: {
    userId: string;
    sessionId: string;
    spaceId?: string;
    turnId: string;
    deliveryId: string;
    idempotencyKey: string;
    code: PublicEventCode;
    reason: string;
  }) => Promise<void> | void>();
  private isDisposing = false;
  private isScheduling = false;
  private schedulerTriggerPending = false;
  private schedulerLoopTimer?: NodeJS.Timeout;

  constructor(options: DeliveryRuntimeGatewayOptions) {
    if (
      !options ||
      !options.executor ||
      typeof options.executor.execute !== 'function' ||
      typeof options.executor.cancel !== 'function'
    ) {
      throw new PlatformError(
        'DeliveryRuntimeGateway requires an explicit "executor" with execute() and cancel() implementations.',
        'CONFIGURATION_ERROR',
        500
      );
    }

    if (!options || !options.quotaMode || (options.quotaMode !== 'disabled' && options.quotaMode !== 'enforced')) {
      throw new PlatformError(
        'DeliveryRuntimeGateway requires an explicit "quotaMode" ("disabled" or "enforced"). Implicit default quotaMode is forbidden.',
        'CONFIGURATION_ERROR',
        500
      );
    }

    if (options.quotaMode === 'enforced') {
      if (
        !options.quotaProvider ||
        typeof options.quotaProvider.reserve !== 'function'
      ) {
        throw new PlatformError(
          'DeliveryRuntimeGateway quotaMode is "enforced" but quotaProvider is missing or lacks mandatory reserve() implementation.',
          'CONFIGURATION_ERROR',
          500
        );
      }
    }

    if (
      !options ||
      !options.profileResolver ||
      typeof options.profileResolver.resolve !== 'function'
    ) {
      throw new PlatformError(
        'DeliveryRuntimeGateway requires an explicit "profileResolver" with a resolve() implementation.',
        'CONFIGURATION_ERROR',
        500
      );
    }

    this.storage = options.storage;
    this.messageStore = options.messageStore;
    this.db = options.database ?? (options.messageStore as unknown as { db: DatabaseSync }).db;
    this.executor = options.executor;
    this.quotaMode = options.quotaMode;
    this.quotaProvider = options.quotaProvider;
    this.profileResolver = options.profileResolver;
    this.fileService = options.fileService;
    this.fileProvider = options.fileProvider;
    this.modelSelectionService = options.modelSelectionService;
    this.externalInteractionService = options.externalInteractionService;
    this.mountResolver = options.mountResolver;

    // Initialize turn quota reservation tuning parameters with defaults and environment overrides
    const envFloor = process.env.ENKEEP_QUOTA_TOKEN_FLOOR || process.env.ENKEEP_TURN_TOKEN_RESERVATION;
    this.quotaTokenFloor = options.quotaTokenFloor !== undefined
      ? options.quotaTokenFloor
      : (envFloor && Number.isSafeInteger(parseInt(envFloor, 10)) && parseInt(envFloor, 10) >= 0 ? parseInt(envFloor, 10) : 4096);

    const envGrowth = process.env.ENKEEP_QUOTA_TOKEN_GROWTH_FACTOR;
    this.quotaTokenGrowthFactor = options.quotaTokenGrowthFactor !== undefined
      ? options.quotaTokenGrowthFactor
      : (envGrowth && !isNaN(parseFloat(envGrowth)) && parseFloat(envGrowth) >= 1.0 ? parseFloat(envGrowth) : 1.25);

    const envCeiling = process.env.ENKEEP_QUOTA_TOKEN_CEILING;
    this.quotaTokenCeiling = options.quotaTokenCeiling !== undefined
      ? options.quotaTokenCeiling
      : (envCeiling && Number.isSafeInteger(parseInt(envCeiling, 10)) && parseInt(envCeiling, 10) > 0 ? parseInt(envCeiling, 10) : 128000);

    this.workerBootId = `worker_${process.pid}_${randomBytes(8).toString('hex')}`;

    // Ensure lease table exists for unit/integration tests running on raw databases
    this.initLeaseTables();

    // Launch background scheduler loop
    this.startScheduler();
  }

  public getMountResolver(): RuntimeMountResolver | undefined {
    return this.mountResolver;
  }

  public setMountResolver(resolver: RuntimeMountResolver): void {
    this.mountResolver = resolver;
  }

  public getExtensionResolver(): ExtensionPlanResolver | undefined {
    return this.extensionResolver;
  }

  public setExtensionResolver(resolver: ExtensionPlanResolver): void {
    this.extensionResolver = resolver;
  }

  private initLeaseTables(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS session_execution_leases (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          route_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          generation INTEGER NOT NULL DEFAULT 1,
          phase TEXT NOT NULL DEFAULT 'claimed' CHECK(phase IN ('claimed', 'executing', 'result_observed')),
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'blocked', 'released')),
          blocked_code TEXT,
          worker_id TEXT NOT NULL,
          result_receipt TEXT,
          acquired_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          heartbeat_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          expires_at TEXT NOT NULL,
          released_at TEXT,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_session_leases_active_route 
          ON session_execution_leases(user_id, route_id) 
          WHERE status = 'active';

        CREATE TABLE IF NOT EXISTS session_recovery_state (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          route_id TEXT NOT NULL,
          generation INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'recovery_required' CHECK(status IN ('recovery_required', 'recovering', 'resolved')),
          failure_code TEXT NOT NULL,
          failure_detail TEXT,
          raw_backup_path TEXT,
          raw_backup_checksum TEXT,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          UNIQUE(user_id, route_id, generation)
        );
      `);
    } catch {}
  }

  private startScheduler(): void {
    this.schedulerLoopTimer = setInterval(() => {
      if (!this.isDisposing) {
        this.scheduleNextClaims();
      }
    }, 1000);
    // Unref so scheduler timer doesn't prevent clean test process exit
    if (this.schedulerLoopTimer && typeof this.schedulerLoopTimer.unref === 'function') {
      this.schedulerLoopTimer.unref();
    }
  }

  private notifyScheduler(): void {
    if (this.isDisposing) return;
    this.schedulerTriggerPending = true;
    setImmediate(() => {
      if (this.schedulerTriggerPending) {
        this.schedulerTriggerPending = false;
        this.scheduleNextClaims();
      }
    });
  }

  getQuotaMode(): QuotaMode {
    return this.quotaMode;
  }

  getQuotaProvider(): TenantQuotaProvider | undefined {
    return this.quotaProvider;
  }

  onTurnCompleted(
    listener: (event: {
      userId: string;
      sessionId: string;
      spaceId: string;
      turnId: string;
      deliveryId: string;
      idempotencyKey: string;
      executionResult: TurnExecutionResult;
      tokenUsage: { tokens: number };
    }) => Promise<void> | void
  ): void {
    this.turnCompletedListeners.add(listener);
  }

  removeTurnCompletedListener(
    listener: (event: {
      userId: string;
      sessionId: string;
      spaceId: string;
      turnId: string;
      deliveryId: string;
      idempotencyKey: string;
      executionResult: TurnExecutionResult;
      tokenUsage: { tokens: number };
    }) => Promise<void> | void
  ): void {
    this.turnCompletedListeners.delete(listener);
  }

  onTurnFailed(
    listener: (event: {
      userId: string;
      sessionId: string;
      spaceId?: string;
      turnId: string;
      deliveryId: string;
      idempotencyKey: string;
      code: PublicEventCode;
      reason: string;
    }) => Promise<void> | void
  ): void {
    this.turnFailedListeners.add(listener);
  }

  removeTurnFailedListener(
    listener: (event: {
      userId: string;
      sessionId: string;
      spaceId?: string;
      turnId: string;
      deliveryId: string;
      idempotencyKey: string;
      code: PublicEventCode;
      reason: string;
    }) => Promise<void> | void
  ): void {
    this.turnFailedListeners.delete(listener);
  }

  private recordSettledError(err: unknown): void {
    if (err instanceof Error) {
      this.settledErrors.push(err);
    } else {
      this.settledErrors.push(new Error('Internal delivery gateway execution error'));
    }
  }

  async dispatchInbound(envelope: InboundEnvelope): Promise<InternalRuntimeDispatchResult> {
    if (this.isDisposing) {
      throw new PlatformError(
        'Gateway is shutting down and cannot accept new turns.',
        'SHUTDOWN_IN_PROGRESS',
        503
      );
    }

    if (!envelope || typeof envelope !== 'object') {
      throw new ValidationError('Invalid envelope: must be a non-null object');
    }

    if (
      typeof envelope.content !== 'string' ||
      envelope.content.length === 0
    ) {
      throw new ValidationError('Inbound envelope content must be a non-empty string');
    }

    if (Buffer.byteLength(envelope.content, 'utf8') > 65536) {
      throw new ValidationError('Inbound envelope content exceeds maximum allowed size (64 KiB)');
    }

    const userId = (typeof envelope.userId === 'string' && envelope.userId.trim()) ? envelope.userId : '';
    if (!userId) {
      throw new ValidationError('Inbound envelope userId is required');
    }

    const sessionId = (typeof envelope.sessionId === 'string' && envelope.sessionId.trim()) ? envelope.sessionId : '';
    if (!sessionId) {
      throw new ValidationError('Inbound envelope sessionId is required');
    }

    const idempotencyKey = envelope.id;
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      throw new ValidationError('Inbound envelope id (idempotency key) is required');
    }

    const timestamp = envelope.timestamp || new Date().toISOString();

    // 0. Query session route directly from database
    const routeStmt = this.db.prepare(`
      SELECT id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, status, current_generation
      FROM session_routes
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `);
    const route = routeStmt.get(sessionId, userId) as SessionRouteRow | undefined;

    if (!route) {
      throw new NotFoundError('Session route not found for user');
    }

    if (!route.dsh_session_id || typeof route.dsh_session_id !== 'string' || route.dsh_session_id.trim() === '') {
      throw new ValidationError('Session route is corrupted: missing or empty dshSessionId');
    }

    if (route.status && route.status !== 'active') {
      throw new PlatformError(
        'Session is not active and cannot accept new turns',
        'SESSION_ARCHIVED',
        409
      );
    }

    // 0b. Query parent space directly from database
    const spaceStmt = this.db.prepare(`
      SELECT id, user_id, status
      FROM spaces
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `);
    const space = spaceStmt.get(route.space_id, userId) as SpaceRow | undefined;

    if (!space) {
      throw new PlatformError(
        'Space is not active and cannot accept new turns',
        'SPACE_ARCHIVED',
        409
      );
    }

    if (space.status && space.status !== 'active') {
      throw new PlatformError(
        'Space is not active and cannot accept new turns',
        'SPACE_ARCHIVED',
        409
      );
    }

    const dshSessionId = route.dsh_session_id;
    const authoritativeSpaceId = route.space_id;
    const currentGen = typeof route.current_generation === 'number' ? route.current_generation : 1;

    // Profile resolution pre-check: fail closed if profile snapshot is tampered/corrupted
    await this.profileResolver.resolve(userId, sessionId, currentGen);

    // 0a. Process and validate attachments
    const canonicalAttachments = await this.processInboundAttachments(
      userId,
      authoritativeSpaceId,
      envelope.id,
      envelope.attachments
    );

    // 0c. Preflight Idempotency Check:
    const existingIdemRow = this.db.prepare(`
      SELECT session_id, request_hash, turn_id
      FROM idempotency_records
      WHERE user_id = ? AND idempotency_key = ?
      LIMIT 1
    `).get(userId, idempotencyKey) as {
      session_id: string;
      request_hash: string;
      turn_id: string;
    } | undefined;

    if (existingIdemRow) {
      if (existingIdemRow.session_id !== sessionId) {
        throw new PlatformError(
          'Idempotency-Key was already used with different request parameters or session.',
          'IDEMPOTENCY_CONFLICT',
          409
        );
      }
      const incomingHash = computeCanonicalRequestHash(sessionId, envelope.content, canonicalAttachments, envelope.replyToMessageId);
      if (existingIdemRow.request_hash !== incomingHash) {
        throw new PlatformError(
          'Idempotency-Key was already used with different request parameters or session.',
          'IDEMPOTENCY_CONFLICT',
          409
        );
      }

      // Fetch user message
      const msgRow = this.db.prepare(`
        SELECT id, role, content, status, created_at
        FROM web_messages
        WHERE user_id = ? AND turn_id = ? AND role = 'user'
        LIMIT 1
      `).get(userId, existingIdemRow.turn_id) as {
        id: string;
        role: string;
        content: string;
        status: string;
        created_at: string;
      } | undefined;

      if (!msgRow || typeof msgRow.id !== 'string' || typeof msgRow.content !== 'string' || typeof msgRow.created_at !== 'string') {
        throw new PlatformError(
          'Database invariant violation: idempotency record exists without matching user message',
          'INVARIANT_VIOLATION',
          500
        );
      }

      const role = msgRow.role === 'user' ? 'user' : (msgRow.role === 'assistant' ? 'assistant' : 'system');
      const status = msgRow.status === 'delivered' ? 'delivered' : (msgRow.status === 'pending' ? 'pending' : 'failed');
      const existingAttachments = this.queryAttachmentsByMessageId(msgRow.id, authoritativeSpaceId);

      let existingReplyRef: { messageId: string; role?: string; snippet: string } | undefined;
      const refRow = this.db.prepare(`
        SELECT reply_to_message_id, quote_snippet, source_role
        FROM message_references
        WHERE message_id = ?
        LIMIT 1
      `).get(msgRow.id) as { reply_to_message_id: string | null; quote_snippet: string; source_role: string | null } | undefined;
      if (refRow && refRow.reply_to_message_id) {
        existingReplyRef = {
          messageId: refRow.reply_to_message_id,
          role: refRow.source_role || undefined,
          snippet: refRow.quote_snippet || '',
        };
      }

      const userMessage: WebMessageRecord = {
        id: msgRow.id,
        role,
        content: msgRow.content,
        status,
        createdAt: msgRow.created_at,
        ...(existingAttachments.length > 0
          ? {
              attachments: existingAttachments.map((a) => ({
                id: a.id,
                relativePath: a.relativePath,
                etag: a.etag,
                size: a.size,
                mediaType: a.mediaType,
                displayName: a.displayName,
                downloadUrl: a.downloadReference,
              })),
            }
          : {}),
        ...(existingReplyRef ? { replyReference: existingReplyRef } : {}),
      };

      return {
        accepted: true,
        turnId: existingIdemRow.turn_id,
        message: userMessage,
        isDuplicate: true,
      };
    }

    const proposedDeliveryId =
      envelope.id && DELIVERY_ID_REGEX.test(envelope.id)
        ? envelope.id
        : generate32HexId('deliv');

    // 1. Transaction-level atomic ingestion in SQLite (without pre-reservation)
    const ingestResult = await this.messageStore.ingestWebDelivery({
      userId,
      sessionId,
      spaceId: authoritativeSpaceId,
      dshSessionId,
      idempotencyKey,
      deliveryId: proposedDeliveryId,
      content: envelope.content,
      timestamp,
      attachments: canonicalAttachments,
      replyToMessageId: envelope.replyToMessageId,
    });

    const turnId = ingestResult.turnId;

    // 2. Duplicate Replay Handling (Concurrent race loser)
    if (!ingestResult.isClaimant) {
      return {
        accepted: true,
        turnId,
        message: ingestResult.message,
        isDuplicate: true,
      };
    }

    // Compute queue position for this route in SQLite
    const posRow = this.db.prepare(`
      SELECT COUNT(*) as pos
      FROM turn_runs
      WHERE user_id = ? AND route_id = ? AND status IN ('queued', 'running')
        AND created_at <= (SELECT created_at FROM turn_runs WHERE turn_id = ? LIMIT 1)
    `).get(userId, sessionId, turnId) as { pos?: number } | undefined;

    const queuePosition = posRow?.pos ?? 1;

    // Wake up scheduler to claim and execute asynchronously
    this.notifyScheduler();

    return {
      accepted: true,
      turnId,
      message: ingestResult.message,
      isDuplicate: false,
      queuePosition,
    };
  }

  private hasLeasesTable(): boolean {
    try {
      const row = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_execution_leases'").get();
      return Boolean(row);
    } catch {
      return false;
    }
  }

  private hasRecoveryTable(): boolean {
    try {
      const row = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_recovery_state'").get();
      return Boolean(row);
    } catch {
      return false;
    }
  }

  private hasSpaceMountsTable(): boolean {
    try {
      const row = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='space_mounts'").get();
      return Boolean(row);
    } catch {
      return false;
    }
  }

  /**
   * Main scheduler loop: claims candidate turns from SQLite authoritative queue under BEGIN IMMEDIATE.
   */
  private async scheduleNextClaims(): Promise<void> {
    if (this.isScheduling || this.isDisposing) return;
    this.isScheduling = true;

    try {
      const maxGlobalConcurrency = 10;
      while (!this.isDisposing && this.activeTasks.size < maxGlobalConcurrency) {
        let claimed: ReturnType<DeliveryRuntimeGateway['claimOneQueuedTurn']>;
        try {
          claimed = this.claimOneQueuedTurn();
        } catch (claimErr) {
          const errMsg = String((claimErr as { message?: string })?.message || '');
          if (errMsg.includes('database is not open') || (claimErr as { code?: string })?.code === 'ERR_INVALID_STATE') {
            break;
          }
          this.recordSettledError(claimErr);
          break;
        }
        if (!claimed) {
          break;
        }
        // Launch turn execution in background
        this.runClaimedTurn(claimed);
      }
    } finally {
      this.isScheduling = false;
    }
  }

  /**
   * Atomically claims the oldest queued turn across all sessions under BEGIN IMMEDIATE.
   */
  private claimOneQueuedTurn(): {
    turnId: string;
    userId: string;
    sessionId: string;
    spaceId: string;
    dshSessionId: string;
    currentGeneration: number;
    deliveryId: string;
    userMessageId: string;
    idempotencyKey: string;
    content: string;
    timestamp: string;
    leaseId: string;
    workerId: string;
  } | null {
    let inTx = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      inTx = true;

      // 1. Clean up expired active leases
      const nowIso = new Date().toISOString();
      if (this.hasLeasesTable()) {
        this.db.prepare(`
          UPDATE session_execution_leases
          SET status = 'released', released_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE status = 'active' AND expires_at < ?
        `).run(nowIso, nowIso);
      }

      // 2. Query oldest queued turn candidates for sessions not currently running or locked by active lease or recovery_required
      const candidateQuery = `
        SELECT 
          tr.turn_id,
          tr.user_id,
          tr.route_id as session_id,
          tr.space_id,
          sr.dsh_session_id,
          COALESCE(sr.current_generation, 1) as current_generation,
          di.id as inbox_pk,
          di.delivery_id,
          di.message_id as user_message_id,
          di.payload as inbox_payload,
          di.created_at as inbox_timestamp,
          idem.idempotency_key
        FROM turn_runs tr
        JOIN session_routes sr ON tr.route_id = sr.id AND tr.user_id = sr.user_id
        LEFT JOIN spaces s ON tr.space_id = s.id AND tr.user_id = s.user_id
        LEFT JOIN delivery_inbox di ON tr.turn_id = di.turn_id AND tr.user_id = di.user_id
        LEFT JOIN idempotency_records idem ON tr.turn_id = idem.turn_id AND tr.user_id = idem.user_id
        WHERE tr.status = 'queued'
          AND (di.status = 'held' OR di.status IS NULL)
          AND (sr.status = 'active' OR sr.status IS NULL)
          AND (s.status = 'active' OR s.status IS NULL)
          AND tr.route_id NOT IN (
            SELECT route_id FROM turn_runs WHERE user_id = tr.user_id AND status = 'running'
          )
          AND (
            NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_execution_leases')
            OR tr.route_id NOT IN (
              SELECT route_id FROM session_execution_leases WHERE user_id = tr.user_id AND status = 'active'
            )
          )
          AND (
            NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_recovery_state')
            OR tr.route_id NOT IN (
              SELECT route_id FROM session_recovery_state WHERE user_id = tr.user_id AND status = 'recovery_required' AND generation = COALESCE(sr.current_generation, 1)
            )
          )
        ORDER BY tr.rowid ASC
        LIMIT 10
      `;

      const candidates = this.db.prepare(candidateQuery).all() as unknown as Array<{
        turn_id: string;
        user_id: string;
        session_id: string;
        space_id: string;
        dsh_session_id: string;
        current_generation: number;
        inbox_pk: string | null;
        delivery_id: string | null;
        user_message_id: string | null;
        inbox_payload: string | null;
        inbox_timestamp: string | null;
        idempotency_key: string | null;
      }>;

      if (!candidates || candidates.length === 0) {
        this.db.exec('COMMIT');
        inTx = false;
        return null;
      }

      // Filter candidate by in-memory active tasks count per user (< 2)
      let selectedCandidate: (typeof candidates)[0] | undefined;
      for (const cand of candidates) {
        let userActiveCount = 0;
        for (const task of this.activeTasks.values()) {
          if (task.userId === cand.user_id) {
            userActiveCount++;
          }
        }
        if (userActiveCount < 10) {
          selectedCandidate = cand;
          break;
        }
      }

      if (!selectedCandidate) {
        this.db.exec('COMMIT');
        inTx = false;
        return null;
      }

      const candidate = selectedCandidate;
      const turnId = candidate.turn_id;
      const userId = candidate.user_id;
      const sessionId = candidate.session_id;
      const spaceId = candidate.space_id;
      const dshSessionId = candidate.dsh_session_id;
      const currentGeneration = candidate.current_generation;
      const deliveryId = candidate.delivery_id || turnId;
      const userMessageId = candidate.user_message_id || '';
      const idempotencyKey = candidate.idempotency_key || deliveryId;

      let content = '';
      let timestamp = candidate.inbox_timestamp || nowIso;
      let payloadCorrupted = false;

      if (candidate.inbox_payload) {
        try {
          const parsed = JSON.parse(candidate.inbox_payload);
          if (parsed && typeof parsed === 'object') {
            content = typeof parsed.content === 'string' ? parsed.content : '';
            if (typeof parsed.timestamp === 'string') timestamp = parsed.timestamp;
          } else {
            payloadCorrupted = true;
          }
        } catch {
          payloadCorrupted = true;
        }
      }

      if (payloadCorrupted) {
        // Quarantine corrupt row without stopping the scheduler
        const safeError = 'CORRUPTED_DELIVERY_PAYLOAD';
        this.db.prepare(`
          UPDATE turn_runs
          SET status = 'failed', error = ?, finished_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE turn_id = ? AND user_id = ?
        `).run(safeError, nowIso, turnId, userId);

        this.db.prepare(`
          UPDATE delivery_inbox
          SET status = 'failed', error = ?, processed_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE turn_id = ? AND user_id = ?
        `).run(safeError, nowIso, turnId, userId);

        this.db.prepare(`
          UPDATE idempotency_records
          SET state = 'failed', updated_at = CURRENT_TIMESTAMP
          WHERE turn_id = ? AND user_id = ?
        `).run(turnId, userId);

        this.db.prepare(`
          UPDATE web_messages
          SET status = 'failed'
          WHERE session_id = ? AND user_id = ? AND turn_id = ? AND role = 'user'
        `).run(sessionId, userId, turnId);

        this.db.prepare(`
          INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
          VALUES (?, ?, ?, 'turn_failed', ?, ?)
        `).run(
          generate32HexId('evt'),
          sessionId,
          userId,
          JSON.stringify({ code: 'CORRUPTED_DELIVERY_PAYLOAD' }),
          nowIso
        );

        this.db.exec('COMMIT');
        inTx = false;
        return null;
      }

      if (!content && userMessageId) {
        const msgRow = this.db.prepare('SELECT content FROM web_messages WHERE id = ?').get(userMessageId) as { content?: string } | undefined;
        if (msgRow?.content) content = msgRow.content;
      }

      // 3. Acquire active lease in session_execution_leases (phase = 'claimed')
      const leaseId = generate32HexId('lease');
      const workerId = this.workerBootId;
      const expiresAt = new Date(Date.now() + 120_000).toISOString(); // 2 minute expiry

      if (this.hasLeasesTable()) {
        this.db.prepare(`
          INSERT INTO session_execution_leases (
            id, user_id, route_id, turn_id, generation, phase, status, worker_id, acquired_at, heartbeat_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, 'claimed', 'active', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
        `).run(leaseId, userId, sessionId, turnId, currentGeneration, workerId, expiresAt);
      }

      // 4. Atomic CAS on turn_runs: queued -> running
      const turnRes = this.db.prepare(`
        UPDATE turn_runs
        SET status = 'running', started_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE turn_id = ? AND user_id = ? AND status = 'queued'
      `).run(nowIso, turnId, userId);

      if (safeChangesCount(turnRes.changes) === 0) {
        this.db.exec('ROLLBACK');
        inTx = false;
        return null;
      }

      // 5. CAS on delivery_inbox: held -> processing
      this.db.prepare(`
        UPDATE delivery_inbox
        SET status = 'processing', updated_at = CURRENT_TIMESTAMP
        WHERE turn_id = ? AND user_id = ? AND status = 'held'
      `).run(turnId, userId);

      // 6. Update idempotency_records: held -> processing
      this.db.prepare(`
        UPDATE idempotency_records
        SET state = 'processing', updated_at = CURRENT_TIMESTAMP
        WHERE turn_id = ? AND user_id = ? AND state = 'held'
      `).run(turnId, userId);

      this.db.exec('COMMIT');
      inTx = false;

      return {
        turnId,
        userId,
        sessionId,
        spaceId,
        dshSessionId,
        currentGeneration,
        deliveryId,
        userMessageId,
        idempotencyKey,
        content,
        timestamp,
        leaseId,
        workerId,
      };
    } catch (err) {
      if (inTx) {
        try {
          this.db.exec('ROLLBACK');
        } catch {}
      }
      // Benign contention on unique active lease / running constraints across concurrent gateways
      const isConstraintContention =
        (err as { code?: string })?.code === 'SQLITE_CONSTRAINT' ||
        (err as { errcode?: number })?.errcode === 19 ||
        String((err as { message?: string })?.message || '').includes('UNIQUE constraint failed');
      if (isConstraintContention) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Executes a claimed turn through executor, manages heartbeats, commits results or records failure.
   */
  private runClaimedTurn(claim: {
    turnId: string;
    userId: string;
    sessionId: string;
    spaceId: string;
    dshSessionId: string;
    currentGeneration: number;
    deliveryId: string;
    userMessageId: string;
    idempotencyKey: string;
    content: string;
    timestamp: string;
    leaseId: string;
    workerId: string;
  }): void {
    const {
      turnId,
      userId,
      sessionId,
      spaceId,
      dshSessionId,
      currentGeneration,
      deliveryId,
      userMessageId,
      idempotencyKey,
      content,
      timestamp,
      leaseId,
      workerId,
    } = claim;

    let heartbeatTimer: NodeJS.Timeout | undefined;
    let reservationBundle: ManagedReservationBundle | undefined;

    const taskPromise = (async () => {
      try {
        // 1. Authoritative Quota Reservation ONLY after DB claim
        // 1. Authoritative Quota Reservation ONLY after DB claim
        if (this.quotaMode === 'enforced' && this.quotaProvider) {
          const tokenEst = estimateInboundTokens(content || 'inbound turn');

          // Query last factual committed token usage for this session to capture historical context & prompt growth
          let lastCommittedTokens = 0;
          if (typeof this.quotaProvider.getLastCommittedTokens === 'function') {
            try {
              lastCommittedTokens = await this.quotaProvider.getLastCommittedTokens(userId, sessionId);
            } catch {
              lastCommittedTokens = 0;
            }
          } else {
            try {
              const lastBundleRow = this.db.prepare(`
                SELECT tokens_committed
                FROM quota_bundles
                WHERE user_id = ? AND session_id = ? AND status = 'committed' AND tokens_committed > 0
                ORDER BY COALESCE(settled_at, created_at) DESC, created_at DESC
                LIMIT 1
              `).get(userId, sessionId) as { tokens_committed?: number } | undefined;
              if (lastBundleRow && typeof lastBundleRow.tokens_committed === 'number') {
                lastCommittedTokens = lastBundleRow.tokens_committed;
              }
            } catch {
              lastCommittedTokens = 0;
            }
          }

          const reservationTokens = computeTurnReservationTokens({
            inboundTokens: tokenEst.estimatedTokens,
            lastCommittedTokens,
            floor: this.quotaTokenFloor,
            growthFactor: this.quotaTokenGrowthFactor,
            ceiling: this.quotaTokenCeiling,
          });

          const quotaRequest: QuotaReservationRequest = {
            userId,
            sessionId,
            deliveryId,
            turns: 1,
            messages: 1,
            tokens: reservationTokens,
            isEstimateTokens: true,
          };

          try {
            const rawBundle = await this.quotaProvider.reserve(quotaRequest);
            if (!rawBundle) {
              await this.persistExecutionFailure({
                userId,
                sessionId,
                spaceId,
                deliveryId,
                idempotencyKey,
                turnId,
                leaseId,
                error: new QuotaExceededError(),
              });
              return;
            }

            reservationBundle = new ManagedReservationBundle(rawBundle, quotaRequest);
          } catch (reserveErr) {
            await this.persistExecutionFailure({
              userId,
              sessionId,
              spaceId,
              deliveryId,
              idempotencyKey,
              turnId,
              leaseId,
              error: reserveErr,
            });
            return;
          }

          const task = this.activeTasks.get(turnId);
          if (task) {
            task.reservationBundle = reservationBundle;
          }
        }

        // 2. Before executor call: transition lease phase to 'executing' and heartbeat
        try {
          this.db.prepare(`
            UPDATE session_execution_leases
            SET phase = 'executing', heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND worker_id = ? AND status = 'active'
          `).run(leaseId, workerId);
        } catch (phaseErr) {
          await this.persistExecutionFailure({
            userId,
            sessionId,
            spaceId,
            deliveryId,
            idempotencyKey,
            turnId,
            leaseId,
            reservationBundle,
            error: phaseErr,
          });
          return;
        }

        // 3. Start Heartbeat Timer (15s interval, updates expires_at to now + 2min)
        heartbeatTimer = setInterval(() => {
          try {
            const nextExpires = new Date(Date.now() + 120_000).toISOString();
            const res = this.db.prepare(`
              UPDATE session_execution_leases
              SET heartbeat_at = CURRENT_TIMESTAMP, expires_at = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND worker_id = ? AND status = 'active'
            `).run(nextExpires, leaseId, workerId);
            if (safeChangesCount(res.changes) === 0) {
              const task = this.activeTasks.get(turnId);
              if (task) {
                task.leaseLost = true;
              }
              if (heartbeatTimer) clearInterval(heartbeatTimer);
              this.executor.cancel(userId, turnId).catch((err) => {
                this.recordSettledError(err);
              });
            }
          } catch (hbErr) {
            const task = this.activeTasks.get(turnId);
            if (task) {
              task.leaseLost = true;
            }
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            this.recordSettledError(hbErr);
            this.executor.cancel(userId, turnId).catch((err) => {
              this.recordSettledError(err);
            });
          }
        }, 15_000);
        if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') {
          heartbeatTimer.unref();
        }
        const activeTaskRef = this.activeTasks.get(turnId);
        if (activeTaskRef) {
          activeTaskRef.heartbeatTimer = heartbeatTimer;
        }

        // 4. Authoritative Profile & Model Resolution at claim time
        let profileSnapshot: RuntimeAgentProfileSnapshot | null = null;
        try {
          profileSnapshot = await this.profileResolver.resolve(userId, sessionId, currentGeneration);
        } catch (profErr) {
          await this.persistExecutionFailure({
            userId,
            sessionId,
            spaceId,
            deliveryId,
            idempotencyKey,
            turnId,
            leaseId,
            reservationBundle,
            error: profErr,
          });
          return;
        }

        let effectiveModel: EffectiveModelSelection | null = null;
        if (this.modelSelectionService) {
          try {
            effectiveModel = await this.modelSelectionService.resolveEffectiveModel({
              sessionId,
              spaceId,
              userId,
            });
          } catch (modelErr) {
            await this.persistExecutionFailure({
              userId,
              sessionId,
              spaceId,
              deliveryId,
              idempotencyKey,
              turnId,
              leaseId,
              reservationBundle,
              error: modelErr,
            });
            return;
          }
        }

        // 5. Resolve canonical attachments and space folder
        const canonicalAttachments = userMessageId ? this.queryAttachmentsByMessageId(userMessageId, spaceId) : [];
        const resolvedEnvelope: ResolvedDeliveryTurnEnvelope = {
          id: idempotencyKey,
          userId,
          sessionId,
          spaceId,
          content,
          attachments: canonicalAttachments,
          timestamp,
        };

        const spaceRow = this.db
          .prepare('SELECT folder, status, execution_mode FROM spaces WHERE id = ? AND user_id = ?')
          .get(spaceId, userId) as { folder: string; status: string; execution_mode?: string } | undefined;
        if (!spaceRow) {
          throw new PlatformError(`Space "${spaceId}" not found for user "${userId}"`, 'SPACE_NOT_FOUND', 404);
        }
        if (spaceRow.status && spaceRow.status !== 'active') {
          throw new PlatformError(`Space "${spaceId}" is not active (status: ${spaceRow.status})`, 'SPACE_INACTIVE', 400);
        }
        let workspaceFolder = spaceRow.folder;
        if (!workspaceFolder || typeof workspaceFolder !== 'string' || workspaceFolder.trim().length === 0) {
          const nameRow = this.db.prepare('SELECT name FROM spaces WHERE id = ?').get(spaceId) as { name?: string } | undefined;
          workspaceFolder = nameRow?.name || 'space-a';
        }
        const spaceExecutionMode = (spaceRow.execution_mode ?? 'container') as ExecutionMode;

        // 6. Execute turn via executor (exactly once)
        let executionResult: TurnExecutionResult;
        try {
          // Resolve runtime mounts for target space
          let spaceMounts: readonly RuntimeMountSpec[] = [];
          if (this.mountResolver) {
            spaceMounts = await this.mountResolver.resolveForSpace(userId, spaceId);
          } else {
            // Check if space has active mounts in DB when mountResolver is absent
            const mountCount = this.db && this.hasSpaceMountsTable()
              ? ((this.db.prepare('SELECT COUNT(*) as count FROM space_mounts WHERE user_id = ? AND space_id = ?').get(userId, spaceId) as { count: number } | undefined)?.count ?? 0)
              : 0;
            if (mountCount > 0) {
              throw new PlatformError(
                `FAIL-CLOSED: Space "${spaceId}" has ${mountCount} active mount(s) but no RuntimeMountResolver is configured.`,
                'CONFIGURATION_ERROR',
                500
              );
            }
            spaceMounts = [];
          }

          // Resolve extension activation plan for target space
          let spaceExtensionPlan: ExtensionActivationPlan | null = null;
          if (this.extensionResolver) {
            try {
              spaceExtensionPlan = await this.extensionResolver.resolveForSpace(userId, spaceId);
            } catch (extErr: unknown) {
              if (extErr instanceof PlatformError && (extErr.code === 'UNSUPPORTED_CONTRIBUTION_KIND' || extErr.message.includes('FAIL-CLOSED'))) {
                throw extErr;
              }
              // Re-throw fail-closed errors
              throw extErr;
            }
          }

          const executionRequest: DeliveryExecutionRequest = {
            userId,
            platformSpaceId: spaceId,
            workspaceFolder,
            dshSessionId,
            turnId,
            content,
            attachments: canonicalAttachments,
            profile: profileSnapshot,
            modelSelection: effectiveModel,
            envelope: resolvedEnvelope,
            executionMode: spaceExecutionMode,
            mounts: spaceMounts,
            extensionPlan: spaceExtensionPlan,
          };

          executionResult = await this.executor.execute(executionRequest);

          if (!executionResult || typeof executionResult !== 'object') {
            throw new ValidationError('Executor returned invalid result');
          }
          if (
            typeof executionResult.replyText !== 'string' ||
            executionResult.replyText.trim().length === 0
          ) {
            throw new ValidationError('Assistant replyText must be a non-empty string');
          }
          if (Buffer.byteLength(executionResult.replyText, 'utf8') > 65536) {
            throw new ValidationError('Assistant replyText exceeds maximum allowed size (64 KiB)');
          }
        } catch (execErr) {
          await this.persistExecutionFailure({
            userId,
            sessionId,
            spaceId,
            deliveryId,
            idempotencyKey,
            turnId,
            leaseId,
            reservationBundle,
            error: execErr,
          });
          return;
        }

        // 7. Check if lease was lost during execution
        const currentTask = this.activeTasks.get(turnId);
        if (currentTask?.leaseLost) {
          await this.persistExecutionFailure({
            userId,
            sessionId,
            spaceId,
            deliveryId,
            idempotencyKey,
            turnId,
            leaseId,
            reservationBundle,
            error: new PlatformError('Lease was lost during execution', 'LEASE_LOST', 409),
          });
          return;
        }

        // 8. Update lease phase to 'result_observed'
        try {
          this.db.prepare(`
            UPDATE session_execution_leases
            SET phase = 'result_observed', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND worker_id = ? AND status = 'active'
          `).run(leaseId, workerId);
        } catch {}

        // 9. Extract token usage
        let tokenUsage: { tokens: number };
        try {
          tokenUsage = extractActualUsage(
            executionResult.usage,
            reservationBundle ? reservationBundle.tokens : 0
          );
        } catch (usageErr) {
          await this.persistExecutionFailure({
            userId,
            sessionId,
            spaceId,
            deliveryId,
            idempotencyKey,
            turnId,
            leaseId,
            reservationBundle,
            error: usageErr,
          });
          return;
        }

        // 10. Transactional completion: assistant message + turn completed + quota commit + release lease
        await this.persistTurnCompletion({
          userId,
          sessionId,
          spaceId,
          deliveryId,
          idempotencyKey,
          turnId,
          leaseId,
          routeKey: `${userId}:web:${spaceId}:${sessionId}`,
          executionResult,
          tokenUsage,
          reservationBundle,
        });
      } catch (fatalErr) {
        this.recordSettledError(fatalErr);
      } finally {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
        this.activeTasks.delete(turnId);
        // Wake scheduler to claim next turn in line
        this.notifyScheduler();
      }
    })();

    this.activeTasks.set(turnId, {
      turnId,
      userId,
      sessionId,
      spaceId,
      leaseId,
      workerId,
      reservationBundle,
      heartbeatTimer,
      promise: taskPromise,
    });
  }

  async finalizeCompletedTurn(params: {
    userId: string;
    sessionId: string;
    spaceId: string;
    deliveryId: string;
    idempotencyKey: string;
    turnId: string;
    leaseId?: string;
    workerId?: string;
    routeKey?: string;
    executionResult: TurnExecutionResult;
    tokenUsage: { tokens: number };
    reservationBundle?: ManagedReservationBundle | QuotaReservationBundle;
    isReconcile?: boolean;
  }): Promise<void> {
    const {
      userId,
      sessionId,
      spaceId,
      deliveryId,
      idempotencyKey,
      turnId,
      leaseId,
      executionResult,
      tokenUsage,
      reservationBundle,
      isReconcile = false,
    } = params;

    const routeKey = params.routeKey || `${userId}:web:${spaceId}:${sessionId}`;
    const nowMs = Date.now();
    const userMsgRow = this.db.prepare("SELECT created_at FROM web_messages WHERE session_id = ? AND user_id = ? AND role = 'user' AND turn_id = ?").get(sessionId, userId, turnId) as { created_at: string } | undefined;
    const userCreatedAtMs = userMsgRow ? new Date(userMsgRow.created_at).getTime() : 0;
    const assistantTimestampMs = Math.max(nowMs, userCreatedAtMs + 1);
    const nowIso = new Date(assistantTimestampMs).toISOString();

    let inTx = false;
    this.db.exec('BEGIN IMMEDIATE');
    inTx = true;
    try {
      // 1. Check current turn status in turn_runs
      const turnRow = this.db.prepare('SELECT status, error FROM turn_runs WHERE turn_id = ? AND user_id = ?').get(turnId, userId) as { status: string; error?: string } | undefined;
      if (!turnRow) {
        throw new PlatformError(`Turn "${turnId}" not found for user "${userId}"`, 'TURN_NOT_FOUND', 404);
      }

      if (turnRow.status === 'completed') {
        // Idempotency: turn was already completed. Ensure lease is released and quota committed.
        if (leaseId) {
          this.db.prepare(`
            UPDATE session_execution_leases
            SET status = 'released', released_at = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'active'
          `).run(nowIso, leaseId);
        } else {
          this.db.prepare(`
            UPDATE session_execution_leases
            SET status = 'released', released_at = ?, updated_at = CURRENT_TIMESTAMP
            WHERE route_id = ? AND user_id = ? AND turn_id = ? AND status = 'active'
          `).run(nowIso, sessionId, userId, turnId);
        }

        if (reservationBundle) {
          try {
            reservationBundle.commitInTransaction(this.db, {
              turns: 1,
              messages: 1,
              tokens: tokenUsage.tokens,
            });
          } catch {}
        }

        this.db.exec('COMMIT');
        inTx = false;
        return;
      }

      if (turnRow.status !== 'running' && !(isReconcile && turnRow.status === 'queued')) {
        // Turn was cancelled, failed, or interrupted: lost race
        this.db.exec('ROLLBACK');
        inTx = false;
        return;
      }

      // 1b. CAS turn_runs from running (or queued on reconcile) -> completed
      const turnStmt = this.db.prepare(`
        UPDATE turn_runs
        SET status = 'completed', finished_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE turn_id = ? AND user_id = ? AND status IN ('running', 'queued')
      `);
      const turnRes = turnStmt.run(nowIso, turnId, userId);
      if (safeChangesCount(turnRes.changes) === 0) {
        this.db.exec('ROLLBACK');
        inTx = false;
        return;
      }

      // 2. CAS delivery_inbox from processing/held -> delivered
      const inboxStmt = this.db.prepare(`
        UPDATE delivery_inbox
        SET status = 'delivered', processed_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND (delivery_id = ? OR turn_id = ?) AND status IN ('held', 'processing')
      `);
      const inboxRes = inboxStmt.run(nowIso, userId, deliveryId, turnId);
      if (!isReconcile && safeChangesCount(inboxRes.changes) === 0) {
        this.db.exec('ROLLBACK');
        inTx = false;
        throw new PlatformError(
          'Database invariant violation: delivery_inbox row was not in processing state',
          'INVARIANT_VIOLATION',
          500
        );
      }

      // 3. Update idempotency_records to completed
      this.db.prepare(`
        UPDATE idempotency_records
        SET state = 'completed', updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND (idempotency_key = ? OR turn_id = ?) AND state IN ('held', 'processing')
      `).run(userId, idempotencyKey, turnId);

      // 4. Insert assistant message into web_messages (idempotent: check if already exists for this turn)
      const existingMsg = this.db.prepare(`
        SELECT id, content, status, created_at FROM web_messages
        WHERE session_id = ? AND user_id = ? AND turn_id = ? AND role = 'assistant'
      `).get(sessionId, userId, turnId) as WebMessageRecord | undefined;

      let assistantMsgRecord: WebMessageRecord;
      if (!existingMsg) {
        const assistantMsgId = generate32HexId('msg');
        this.db.prepare(`
          INSERT INTO web_messages (
            id, session_id, user_id, role, content, status, route_key, turn_id, created_at
          ) VALUES (?, ?, ?, 'assistant', ?, 'delivered', ?, ?, ?)
        `).run(
          assistantMsgId,
          sessionId,
          userId,
          executionResult.replyText,
          routeKey,
          turnId,
          nowIso
        );

        assistantMsgRecord = {
          id: assistantMsgId,
          role: 'assistant',
          content: executionResult.replyText,
          status: 'delivered',
          createdAt: nowIso,
        };

        // 5. Insert assistant message event into web_events
        const eventPayload = JSON.stringify({ message: assistantMsgRecord });
        this.db.prepare(`
          INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
          VALUES (?, ?, ?, 'message', ?, ?)
        `).run(
          generate32HexId('evt'),
          sessionId,
          userId,
          eventPayload,
          nowIso
        );
      } else {
        assistantMsgRecord = existingMsg;
      }

      // 6. Commit quota in same transaction
      if (reservationBundle) {
        reservationBundle.commitInTransaction(this.db, {
          turns: 1,
          messages: 1,
          tokens: tokenUsage.tokens,
        });
      }

      // 7. Release active lease in session_execution_leases
      if (leaseId) {
        const leaseRes = this.db.prepare(`
          UPDATE session_execution_leases
          SET status = 'released', released_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'active'
        `).run(nowIso, leaseId);
        if (!isReconcile && safeChangesCount(leaseRes.changes) === 0) {
          this.db.exec('ROLLBACK');
          inTx = false;
          throw new PlatformError('Lease was lost prior to commit', 'LEASE_LOST', 409);
        }
      } else {
        this.db.prepare(`
          UPDATE session_execution_leases
          SET status = 'released', released_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE route_id = ? AND user_id = ? AND turn_id = ? AND status = 'active'
        `).run(nowIso, sessionId, userId, turnId);
      }

      this.db.exec('COMMIT');
      inTx = false;

      // 8. Safely notify turnCompletedListeners outside the transaction
      for (const listener of this.turnCompletedListeners) {
        try {
          const res = listener({
            userId,
            sessionId,
            spaceId,
            turnId,
            deliveryId,
            idempotencyKey,
            executionResult,
            tokenUsage,
          });
          if (res && typeof (res as Promise<void>).catch === 'function') {
            (res as Promise<void>).catch((listenerErr) => {
              this.recordSettledError(listenerErr);
            });
          }
        } catch (listenerErr) {
          this.recordSettledError(listenerErr);
        }
      }
    } catch (txErr) {
      if (inTx) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rollbackErr) {
          this.recordSettledError(rollbackErr);
        }
      }

      const isLeaseLost = (txErr as { code?: string })?.code === 'LEASE_LOST';

      if (!isLeaseLost) {
        this.recordSettledError(txErr);
      }

      if (isReconcile) {
        throw txErr;
      }

      if ((txErr as { code?: string })?.code !== 'INVARIANT_VIOLATION') {
        try {
          await this.finalizeFailedTurn({
            userId,
            sessionId,
            spaceId,
            deliveryId,
            idempotencyKey,
            turnId,
            leaseId,
            reservationBundle,
            error: txErr,
          });
        } catch (failErr) {
          this.recordSettledError(failErr);
        }
      } else if (reservationBundle) {
        try {
          reservationBundle.releaseInTransaction(this.db);
        } catch (relErr) {
          this.recordSettledError(relErr);
        }
      }

      if (!isLeaseLost) {
        throw txErr;
      }
    }
  }

  async finalizeInterruptedTurn(params: {
    userId: string;
    sessionId: string;
    spaceId?: string;
    deliveryId: string;
    idempotencyKey?: string;
    turnId: string;
    leaseId?: string;
    reservationBundle?: ManagedReservationBundle | QuotaReservationBundle;
    reason?: string;
    code?: PublicEventCode;
  }): Promise<void> {
    const {
      userId,
      sessionId,
      deliveryId,
      idempotencyKey = deliveryId,
      turnId,
      leaseId,
      reservationBundle,
      reason = 'Turn interrupted',
      code = 'RETRY_REQUIRED',
    } = params;

    const nowIso = new Date().toISOString();
    let inTx = false;
    this.db.exec('BEGIN IMMEDIATE');
    inTx = true;
    try {
      const turnRow = this.db.prepare('SELECT status FROM turn_runs WHERE turn_id = ? AND user_id = ?').get(turnId, userId) as { status: string } | undefined;
      if (turnRow && (turnRow.status === 'completed' || turnRow.status === 'interrupted' || turnRow.status === 'failed')) {
        if (leaseId) {
          this.db.prepare(`
            UPDATE session_execution_leases
            SET status = 'released', released_at = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'active'
          `).run(nowIso, leaseId);
        }
        if (reservationBundle) {
          try {
            reservationBundle.releaseInTransaction(this.db);
          } catch {}
        }
        this.db.exec('COMMIT');
        inTx = false;
        return;
      }

      this.db.prepare(`
        UPDATE turn_runs
        SET status = 'interrupted', error = ?, finished_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE turn_id = ? AND user_id = ? AND status IN ('queued', 'running')
      `).run(reason, nowIso, turnId, userId);

      this.db.prepare(`
        UPDATE delivery_inbox
        SET status = 'failed', error = ?, processed_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND (delivery_id = ? OR turn_id = ?) AND status IN ('held', 'processing')
      `).run(reason, nowIso, userId, deliveryId, turnId);

      this.db.prepare(`
        UPDATE idempotency_records
        SET state = 'failed', updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND (idempotency_key = ? OR turn_id = ?) AND state IN ('held', 'processing')
      `).run(userId, idempotencyKey, turnId);

      this.db.prepare(`
        UPDATE web_messages
        SET status = 'failed'
        WHERE session_id = ? AND user_id = ? AND turn_id = ? AND role = 'user'
      `).run(sessionId, userId, turnId);

      this.db.prepare(`
        INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
        VALUES (?, ?, ?, 'turn_failed', ?, ?)
      `).run(
        generate32HexId('evt'),
        sessionId,
        userId,
        JSON.stringify({ code }),
        nowIso
      );

      if (leaseId) {
        this.db.prepare(`
          UPDATE session_execution_leases
          SET status = 'released', released_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'active'
        `).run(nowIso, leaseId);
      } else {
        this.db.prepare(`
          UPDATE session_execution_leases
          SET status = 'released', released_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE route_id = ? AND user_id = ? AND turn_id = ? AND status = 'active'
        `).run(nowIso, sessionId, userId, turnId);
      }

      if (reservationBundle) {
        try {
          reservationBundle.releaseInTransaction(this.db);
        } catch (relErr) {
          this.recordSettledError(relErr);
        }
      }

      this.db.exec('COMMIT');
      inTx = false;
    } catch (err) {
      if (inTx) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rollbackErr) {
          this.recordSettledError(rollbackErr);
        }
      }
      this.recordSettledError(err);
      throw err;
    }
  }

  async finalizeFailedTurn(params: {
    userId: string;
    sessionId: string;
    spaceId?: string;
    deliveryId: string;
    idempotencyKey?: string;
    turnId: string;
    leaseId?: string;
    reservationBundle?: ManagedReservationBundle | QuotaReservationBundle;
    error?: unknown;
    code?: PublicEventCode;
    reason?: string;
    isSessionCorrupted?: boolean;
  }): Promise<void> {
    const {
      userId,
      sessionId,
      deliveryId,
      idempotencyKey = deliveryId,
      turnId,
      leaseId,
      reservationBundle,
      error,
      isSessionCorrupted = isCorruptedSessionError(error),
    } = params;

    const nowIso = new Date().toISOString();
    const isQuota =
      error instanceof QuotaExceededError ||
      (error as { code?: string })?.code === 'QUOTA_EXCEEDED' ||
      (error as { name?: string })?.name === 'QuotaExceededError';
    const isLeaseLost = (error as { code?: string })?.code === 'LEASE_LOST';

    const safeErrorMessage = params.reason || (isQuota
      ? 'Quota exceeded'
      : isSessionCorrupted
      ? 'Session corrupted: recovery required'
      : isLeaseLost
      ? 'Lease lost during execution'
      : 'Turn execution failed');

    const safeErrorCode: PublicEventCode = params.code || (isQuota
      ? 'QUOTA_EXCEEDED'
      : isSessionCorrupted
      ? 'RECOVERY_REQUIRED'
      : 'EXECUTION_FAILED');

    console.error('[delivery-gateway] turn failed', {
      turnId,
      code: safeErrorCode,
      error: error instanceof Error ? error.message : String(error),
    });

    let inTx = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      inTx = true;

      // 1. Update turn_runs to failed
      this.db.prepare(`
        UPDATE turn_runs
        SET status = 'failed', error = ?, finished_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE turn_id = ? AND user_id = ? AND status IN ('queued', 'running')
      `).run(safeErrorMessage, nowIso, turnId, userId);

      // 2. Update delivery_inbox to failed
      this.db.prepare(`
        UPDATE delivery_inbox
        SET status = 'failed', error = ?, processed_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND (delivery_id = ? OR turn_id = ?) AND status IN ('held', 'processing')
      `).run(safeErrorMessage, nowIso, userId, deliveryId, turnId);

      // 3. Update idempotency_records to failed
      this.db.prepare(`
        UPDATE idempotency_records
        SET state = 'failed', updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND (idempotency_key = ? OR turn_id = ?) AND state IN ('held', 'processing')
      `).run(userId, idempotencyKey, turnId);

      // 3b. Update user message in web_messages to failed
      this.db.prepare(`
        UPDATE web_messages
        SET status = 'failed'
        WHERE session_id = ? AND user_id = ? AND turn_id = ? AND role = 'user'
      `).run(sessionId, userId, turnId);

      // 4. Insert turn_failed event into web_events
      this.db.prepare(`
        INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
        VALUES (?, ?, ?, 'turn_failed', ?, ?)
      `).run(
        generate32HexId('evt'),
        sessionId,
        userId,
        JSON.stringify({ code: safeErrorCode }),
        nowIso
      );

      // 4b. If session artifact corruption occurred, record session_recovery_state and block lease
      if (isSessionCorrupted) {
        try {
          const routeRow = this.db.prepare('SELECT current_generation FROM session_routes WHERE id = ?').get(sessionId) as { current_generation?: number } | undefined;
          const currentGen = routeRow?.current_generation ?? 1;
          const recId = generate32HexId('rec');
          this.db.prepare(`
            INSERT INTO session_recovery_state (
              id, user_id, route_id, generation, status, failure_code, failure_detail, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'recovery_required', 'CORRUPTED_SESSION_ARTIFACT', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, route_id, generation) DO UPDATE SET
              status = 'recovery_required',
              failure_code = 'CORRUPTED_SESSION_ARTIFACT',
              failure_detail = excluded.failure_detail,
              updated_at = CURRENT_TIMESTAMP
          `).run(recId, userId, sessionId, currentGen, safeErrorMessage);

          this.db.prepare(`
            INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
            VALUES (?, ?, ?, 'session_recovery_required', ?, ?)
          `).run(
            generate32HexId('evt'),
            sessionId,
            userId,
            JSON.stringify({ code: 'RECOVERY_REQUIRED' }),
            nowIso
          );

          if (leaseId) {
            this.db.prepare(`
              UPDATE session_execution_leases
              SET status = 'blocked', blocked_code = 'RECOVERY_REQUIRED', updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(leaseId);
          } else {
            this.db.prepare(`
              UPDATE session_execution_leases
              SET status = 'blocked', blocked_code = 'RECOVERY_REQUIRED', updated_at = CURRENT_TIMESTAMP
              WHERE route_id = ? AND user_id = ? AND status = 'active'
            `).run(sessionId, userId);
          }
        } catch {}
      } else {
        if (leaseId) {
          this.db.prepare(`
            UPDATE session_execution_leases
            SET status = 'released', released_at = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'active'
          `).run(nowIso, leaseId);
        } else {
          this.db.prepare(`
            UPDATE session_execution_leases
            SET status = 'released', released_at = ?, updated_at = CURRENT_TIMESTAMP
            WHERE route_id = ? AND user_id = ? AND status = 'active'
          `).run(nowIso, sessionId, userId);
        }
      }

      // 5. Release quota reservation in transaction
      if (reservationBundle) {
        try {
          reservationBundle.releaseInTransaction(this.db);
        } catch (relErr) {
          this.recordSettledError(relErr);
        }
      }

      this.db.exec('COMMIT');
      inTx = false;

      // 6. Safely notify turnFailedListeners outside the transaction
      for (const listener of this.turnFailedListeners) {
        try {
          const res = listener({
            userId,
            sessionId,
            spaceId: params.spaceId,
            turnId,
            deliveryId,
            idempotencyKey,
            code: safeErrorCode,
            reason: safeErrorMessage,
          });
          if (res && typeof (res as Promise<void>).catch === 'function') {
            (res as Promise<void>).catch((listenerErr) => {
              this.recordSettledError(listenerErr);
            });
          }
        } catch (listenerErr) {
          this.recordSettledError(listenerErr);
        }
      }
    } catch (err) {
      if (inTx) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rollbackErr) {
          this.recordSettledError(rollbackErr);
        }
      }
      this.recordSettledError(err);
      throw err;
    }
  }

  private async persistTurnCompletion(params: {
    userId: string;
    sessionId: string;
    spaceId: string;
    deliveryId: string;
    idempotencyKey: string;
    turnId: string;
    leaseId: string;
    routeKey: string;
    executionResult: TurnExecutionResult;
    tokenUsage: { tokens: number };
    reservationBundle?: ManagedReservationBundle;
  }): Promise<void> {
    return await this.finalizeCompletedTurn(params);
  }

  private async persistExecutionFailure(params: {
    userId: string;
    sessionId: string;
    spaceId?: string;
    deliveryId: string;
    idempotencyKey: string;
    turnId: string;
    leaseId?: string;
    reservationBundle?: ManagedReservationBundle;
    error?: unknown;
  }): Promise<void> {
    return await this.finalizeFailedTurn(params);
  }

  async getTaskTurnStatus(
    userId: string,
    turnId: string
  ): Promise<{ status: TurnExecutionStatus; error?: string }> {
    return await this.getTurnStatus(userId, turnId);
  }

  async getTurnStatus(
    userId: string,
    turnId: string
  ): Promise<{ status: TurnExecutionStatus; error?: string }> {
    if (typeof userId !== 'string' || typeof turnId !== 'string') {
      throw new ValidationError('Invalid arguments for getTurnStatus');
    }

    const row = this.db.prepare(`
      SELECT status, error
      FROM turn_runs
      WHERE turn_id = ? AND user_id = ?
      LIMIT 1
    `).get(turnId, userId) as { status: string; error?: string } | undefined;

    if (!row) {
      throw new NotFoundError('Turn not found');
    }

    return {
      status: row.status as TurnExecutionStatus,
      error: row.error || undefined,
    };
  }

  async getCurrentTurnStatus(
    userId: string,
    sessionId: string
  ): Promise<{ status: TurnExecutionStatus; code?: PublicEventCode; queuePosition?: number } | null> {
    if (typeof userId !== 'string' || typeof sessionId !== 'string') {
      throw new ValidationError('Invalid arguments for getCurrentTurnStatus');
    }

    // 1. Check if session route is flagged as recovery_required
    try {
      const routeRow = this.db.prepare('SELECT current_generation FROM session_routes WHERE id = ?').get(sessionId) as { current_generation?: number } | undefined;
      const currentGen = routeRow?.current_generation ?? 1;
      const recRow = this.db.prepare(`
        SELECT status, failure_code FROM session_recovery_state
        WHERE user_id = ? AND route_id = ? AND generation = ? AND status = 'recovery_required'
        LIMIT 1
      `).get(userId, sessionId, currentGen) as { status: string; failure_code: string } | undefined;
      if (recRow && recRow.status === 'recovery_required') {
        return {
          status: 'recovery_required',
          code: 'RECOVERY_REQUIRED',
        };
      }
    } catch {}

    // 2. Check if external interaction service has pending approvals
    if (this.externalInteractionService && typeof this.externalInteractionService.listPendingApprovals === 'function') {
      try {
        const pending = this.externalInteractionService.listPendingApprovals({
          userId,
          sessionId,
          status: 'pending',
        });
        if (Array.isArray(pending) && pending.length > 0) {
          return {
            status: 'waiting_approval',
            code: 'WAITING_APPROVAL',
          };
        }
      } catch {}
    }

    // 3. Query turn_runs: running preferred, then oldest queued
    const row = this.db.prepare(`
      SELECT turn_id, status, created_at
      FROM turn_runs
      WHERE user_id = ? AND route_id = ? AND status IN ('queued', 'running')
      ORDER BY CASE status WHEN 'running' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END, created_at ASC
      LIMIT 1
    `).get(userId, sessionId) as { turn_id: string; status: string; created_at: string } | undefined;

    if (!row) {
      return null;
    }

    let queuePos: number | undefined;
    if (row.status === 'queued') {
      const countRow = this.db.prepare(`
        SELECT COUNT(*) as pos
        FROM turn_runs
        WHERE user_id = ? AND route_id = ? AND status IN ('queued', 'running')
          AND created_at <= ?
      `).get(userId, sessionId, row.created_at) as { pos?: number } | undefined;
      queuePos = countRow?.pos ?? 1;
    }

    return {
      status: row.status as TurnExecutionStatus,
      ...(queuePos !== undefined ? { queuePosition: queuePos } : {}),
    };
  }

  async cancelCurrentTurn(userId: string, sessionId: string): Promise<boolean> {
    if (typeof userId !== 'string' || typeof sessionId !== 'string') {
      throw new ValidationError('Invalid arguments for cancelCurrentTurn');
    }

    const row = this.db.prepare(`
      SELECT turn_id
      FROM turn_runs
      WHERE user_id = ? AND route_id = ? AND status IN ('queued', 'running')
      ORDER BY CASE status WHEN 'running' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END, created_at ASC
      LIMIT 1
    `).get(userId, sessionId) as { turn_id: string } | undefined;

    if (!row || !row.turn_id) {
      return false;
    }

    return await this.cancelTurn(userId, row.turn_id);
  }

  async cancelTaskTurn(userId: string, turnId: string): Promise<boolean> {
    return await this.cancelTurn(userId, turnId);
  }

  async cancelTurnInternal(userId: string, turnId: string): Promise<boolean> {
    return await this.cancelTurn(userId, turnId);
  }

  async cancelTurn(userId: string, turnId: string): Promise<boolean> {
    if (typeof userId !== 'string' || typeof turnId !== 'string') {
      throw new ValidationError('Invalid arguments for cancelTurn');
    }

    const turnRow = this.db.prepare(`
      SELECT status, space_id, route_id
      FROM turn_runs
      WHERE turn_id = ? AND user_id = ?
      LIMIT 1
    `).get(turnId, userId) as { status: string; space_id: string; route_id: string } | undefined;

    if (!turnRow) {
      throw new NotFoundError('Turn not found');
    }

    if (
      turnRow.status === 'completed' ||
      turnRow.status === 'failed' ||
      turnRow.status === 'interrupted'
    ) {
      return false;
    }

    const nowIso = new Date().toISOString();
    const sessionId = turnRow.route_id;
    if (!sessionId) {
      throw new PlatformError(
        'Database invariant violation: turn_runs missing route_id',
        'INVARIANT_VIOLATION',
        500
      );
    }

    const activeTask = this.activeTasks.get(turnId);
    const reservationBundle = activeTask?.reservationBundle;

    if (turnRow.status === 'queued') {
      let inTx = false;
      this.db.exec('BEGIN IMMEDIATE');
      inTx = true;
      try {
        const turnRes = this.db.prepare(`
          UPDATE turn_runs
          SET status = 'interrupted', error = 'Turn cancelled by user', finished_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE turn_id = ? AND user_id = ? AND status = 'queued'
        `).run(nowIso, turnId, userId);

        if (safeChangesCount(turnRes.changes) === 0) {
          this.db.exec('ROLLBACK');
          inTx = false;
          return false;
        }

        const checkInbox = this.db.prepare(`
          SELECT status FROM delivery_inbox
          WHERE (turn_id = ? OR delivery_id = ?) AND user_id = ?
          LIMIT 1
        `).get(turnId, turnId, userId) as { status: string } | undefined;

        if (!checkInbox) {
          this.db.exec('ROLLBACK');
          inTx = false;
          throw new PlatformError(
            'Database invariant violation: delivery_inbox state was inconsistent',
            'INVARIANT_VIOLATION',
            500
          );
        }

        const inboxRes = this.db.prepare(`
          UPDATE delivery_inbox
          SET status = 'cancelled', error = 'Turn cancelled by user', updated_at = CURRENT_TIMESTAMP
          WHERE (turn_id = ? OR delivery_id = ?) AND user_id = ? AND status IN ('held', 'processing')
        `).run(turnId, turnId, userId);

        if (safeChangesCount(inboxRes.changes) === 0 && checkInbox.status !== 'cancelled') {
          this.db.exec('ROLLBACK');
          inTx = false;
          throw new PlatformError(
            'Database invariant violation: delivery_inbox state was inconsistent',
            'INVARIANT_VIOLATION',
            500
          );
        }

        this.db.prepare(`
          UPDATE idempotency_records
          SET state = 'failed', updated_at = CURRENT_TIMESTAMP
          WHERE turn_id = ? AND user_id = ?
        `).run(turnId, userId);

        this.db.prepare(`
          INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
          VALUES (?, ?, ?, 'turn_cancelled', ?, ?)
        `).run(
          generate32HexId('evt'),
          sessionId,
          userId,
          JSON.stringify({ code: 'USER_CANCELLED' }),
          nowIso
        );

        this.db.exec('COMMIT');
        inTx = false;

        this.notifyScheduler();
        return true;
      } catch (err) {
        if (inTx) {
          try {
            this.db.exec('ROLLBACK');
          } catch (rollbackErr) {
            this.recordSettledError(rollbackErr);
          }
        }
        throw err;
      }
    }

    if (turnRow.status === 'running') {
      const cancelSuccess = await this.executor.cancel(userId, turnId);
      if (cancelSuccess === false) {
        // Executor did not cancel
        return false;
      }

      let inTx = false;
      this.db.exec('BEGIN IMMEDIATE');
      inTx = true;
      try {
        const turnRes = this.db.prepare(`
          UPDATE turn_runs
          SET status = 'interrupted', error = 'Turn cancelled by user', finished_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE turn_id = ? AND user_id = ? AND status = 'running'
        `).run(nowIso, turnId, userId);

        if (safeChangesCount(turnRes.changes) === 0) {
          this.db.exec('ROLLBACK');
          inTx = false;
          return false;
        }

        const checkInbox = this.db.prepare(`
          SELECT status FROM delivery_inbox
          WHERE (turn_id = ? OR delivery_id = ?) AND user_id = ?
          LIMIT 1
        `).get(turnId, turnId, userId) as { status: string } | undefined;

        if (!checkInbox) {
          this.db.exec('ROLLBACK');
          inTx = false;
          throw new PlatformError(
            'Database invariant violation: delivery_inbox state was inconsistent',
            'INVARIANT_VIOLATION',
            500
          );
        }

        const inboxRes = this.db.prepare(`
          UPDATE delivery_inbox
          SET status = 'cancelled', error = 'Turn cancelled by user', updated_at = CURRENT_TIMESTAMP
          WHERE (turn_id = ? OR delivery_id = ?) AND user_id = ? AND status IN ('held', 'processing')
        `).run(turnId, turnId, userId);

        if (safeChangesCount(inboxRes.changes) === 0 && checkInbox.status !== 'cancelled') {
          this.db.exec('ROLLBACK');
          inTx = false;
          throw new PlatformError(
            'Database invariant violation: delivery_inbox state was inconsistent',
            'INVARIANT_VIOLATION',
            500
          );
        }

        this.db.prepare(`
          UPDATE idempotency_records
          SET state = 'failed', updated_at = CURRENT_TIMESTAMP
          WHERE turn_id = ? AND user_id = ?
        `).run(turnId, userId);

        this.db.prepare(`
          INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
          VALUES (?, ?, ?, 'turn_cancelled', ?, ?)
        `).run(
          generate32HexId('evt'),
          sessionId,
          userId,
          JSON.stringify({ code: 'USER_CANCELLED' }),
          nowIso
        );

        this.db.prepare(`
          UPDATE session_execution_leases
          SET status = 'released', released_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE route_id = ? AND user_id = ? AND status = 'active'
        `).run(nowIso, sessionId, userId);

        if (reservationBundle) {
          reservationBundle.releaseInTransaction(this.db);
        }

        this.db.exec('COMMIT');
        inTx = false;

        this.notifyScheduler();
        return true;
      } catch (err) {
        if (inTx) {
          try {
            this.db.exec('ROLLBACK');
          } catch (rollbackErr) {
            this.recordSettledError(rollbackErr);
          }
        }
        throw err;
      }
    }

    return false;
  }

  /**
   * Recovers stranded turns after crash or platform restart.
   */
  async recoverQueuedTurns(): Promise<number> {
    return await this.redriveHeld();
  }

  async redriveHeld(): Promise<number> {
    // Validate that all held delivery_inbox payloads are valid JSON
    const heldRows = this.db.prepare("SELECT id, payload FROM delivery_inbox WHERE status = 'held'").all() as Array<{ id: string; payload: string | null }>;
    const payloadErrors: Error[] = [];
    for (const row of heldRows) {
      if (row.payload) {
        try {
          JSON.parse(row.payload);
        } catch {
          payloadErrors.push(new Error(`Corrupted JSON payload in delivery_inbox row ${row.id}`));
        }
      }
    }
    if (payloadErrors.length > 0) {
      throw new AggregateError(payloadErrors, 'Corrupted payload found during startup redrive');
    }

    const nowIso = new Date().toISOString();

    const reconcileErrors: Error[] = [];

    // Query active leases to reconcile based on phase
    const activeLeases = this.db.prepare(`
      SELECT id, user_id, route_id, turn_id, generation, phase, worker_id
      FROM session_execution_leases
      WHERE status = 'active'
    `).all() as unknown as Array<{
      id: string;
      user_id: string;
      route_id: string;
      turn_id: string;
      generation: number;
      phase: string | null;
      worker_id: string;
    }>;

    for (const lease of activeLeases) {
      try {
        const leasePhase = lease.phase || 'claimed';
        if (leasePhase === 'claimed') {
          // Executor was not called: release lease and requeue safely
          let inTx = false;
          try {
            this.db.exec('BEGIN IMMEDIATE');
            inTx = true;
            this.db.prepare(`
              UPDATE session_execution_leases
              SET status = 'released', released_at = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(nowIso, lease.id);

            this.db.prepare(`
              UPDATE turn_runs
              SET status = 'queued', updated_at = CURRENT_TIMESTAMP
              WHERE turn_id = ? AND user_id = ?
            `).run(lease.turn_id, lease.user_id);

            this.db.prepare(`
              UPDATE delivery_inbox
              SET status = 'held', updated_at = CURRENT_TIMESTAMP
              WHERE (turn_id = ? OR delivery_id = ?) AND user_id = ?
            `).run(lease.turn_id, lease.turn_id, lease.user_id);

            this.db.prepare(`
              UPDATE idempotency_records
              SET state = 'held', updated_at = CURRENT_TIMESTAMP
              WHERE turn_id = ? AND user_id = ?
            `).run(lease.turn_id, lease.user_id);

            this.db.exec('COMMIT');
            inTx = false;
          } catch (txErr) {
            if (inTx) {
              try {
                this.db.exec('ROLLBACK');
              } catch {}
            }
            throw txErr;
          }
        } else {
          // Phase is 'executing' or 'result_observed': inspect result via executor
        let inspected: InspectedTurnResult = { status: 'absent' };
        if (typeof this.executor.inspectTurnResult === 'function') {
          try {
            const routeRow = this.db.prepare('SELECT dsh_session_id FROM session_routes WHERE id = ?').get(lease.route_id) as { dsh_session_id?: string } | undefined;
            const dshSessionId = routeRow?.dsh_session_id || lease.route_id;
            inspected = await this.executor.inspectTurnResult({
              userId: lease.user_id,
              turnId: lease.turn_id,
              dshSessionId,
            });
          } catch (inspErr) {
            this.recordSettledError(inspErr);
            inspected = { status: 'absent' };
          }
        }

        if (inspected.status === 'completed' && inspected.result?.replyText && inspected.result.replyText.trim().length > 0) {
          // Strict result schema parsing
          if (!inspected.result || typeof inspected.result !== 'object') {
            throw new ValidationError('Inspected turn completed result is missing or not an object');
          }
          if (typeof inspected.result.replyText !== 'string' || inspected.result.replyText.trim().length === 0) {
            throw new ValidationError('Inspected turn completed replyText must be a non-empty string');
          }
          if (Buffer.byteLength(inspected.result.replyText, 'utf8') > 65536) {
            throw new ValidationError('Inspected turn completed replyText exceeds maximum allowed size (64 KiB)');
          }

          // Recover pending quota reservation if quotaMode is enforced
          let recoveredReservation: QuotaReservationBundle | null = null;
          const deliveryRow = this.db.prepare('SELECT delivery_id FROM delivery_inbox WHERE turn_id = ? AND user_id = ?').get(lease.turn_id, lease.user_id) as { delivery_id?: string } | undefined;
          const deliveryId = deliveryRow?.delivery_id || lease.turn_id;

          if (this.quotaMode === 'enforced' && this.quotaProvider && typeof this.quotaProvider.recoverReservation === 'function') {
            try {
              recoveredReservation = await this.quotaProvider.recoverReservation(deliveryId, lease.user_id);
            } catch (qErr) {
              this.recordSettledError(qErr);
            }
          }

          const turnRow = this.db.prepare('SELECT space_id, route_id FROM turn_runs WHERE turn_id = ? AND user_id = ?').get(lease.turn_id, lease.user_id) as { space_id?: string; route_id?: string } | undefined;
          const spaceId = turnRow?.space_id || 'space-a';
          const idemRow = this.db.prepare('SELECT idempotency_key FROM idempotency_records WHERE turn_id = ? AND user_id = ?').get(lease.turn_id, lease.user_id) as { idempotency_key?: string } | undefined;
          const idempotencyKey = idemRow?.idempotency_key || deliveryId;

          // Extract token usage
          let tokenUsage = { tokens: 0 };
          if (inspected.result.usage) {
            tokenUsage = extractActualUsage(inspected.result.usage, recoveredReservation ? recoveredReservation.tokens : 0);
          } else if (recoveredReservation) {
            tokenUsage = { tokens: recoveredReservation.tokens };
          }

          // Record model health if attempts are present
          if (this.modelSelectionService && (inspected.result as any).routeAttempts && Array.isArray((inspected.result as any).routeAttempts)) {
            for (const attempt of (inspected.result as any).routeAttempts) {
              try {
                await this.modelSelectionService.recordHealth({
                  provider: attempt.provider,
                  model: attempt.model,
                  latencyMs: attempt.latencyMs,
                  statusCode: attempt.statusCode,
                  success: attempt.success,
                  errorType: attempt.errorType,
                });
              } catch {}
            }
          }

          // Finalize completed turn transactionally
          await this.finalizeCompletedTurn({
            userId: lease.user_id,
            sessionId: lease.route_id,
            spaceId,
            deliveryId,
            idempotencyKey,
            turnId: lease.turn_id,
            leaseId: lease.id,
            executionResult: inspected.result,
            tokenUsage,
            reservationBundle: recoveredReservation ?? undefined,
            isReconcile: true,
          });
        } else if (inspected.status === 'failed') {
          // Recover pending quota reservation if quotaMode is enforced
          let recoveredReservation: QuotaReservationBundle | null = null;
          const deliveryRow = this.db.prepare('SELECT delivery_id FROM delivery_inbox WHERE turn_id = ? AND user_id = ?').get(lease.turn_id, lease.user_id) as { delivery_id?: string } | undefined;
          const deliveryId = deliveryRow?.delivery_id || lease.turn_id;

          if (this.quotaMode === 'enforced' && this.quotaProvider && typeof this.quotaProvider.recoverReservation === 'function') {
            try {
              recoveredReservation = await this.quotaProvider.recoverReservation(deliveryId, lease.user_id);
            } catch (qErr) {
              this.recordSettledError(qErr);
            }
          }

          const turnRow = this.db.prepare('SELECT space_id, route_id FROM turn_runs WHERE turn_id = ? AND user_id = ?').get(lease.turn_id, lease.user_id) as { space_id?: string; route_id?: string } | undefined;
          const spaceId = turnRow?.space_id || 'space-a';
          const idemRow = this.db.prepare('SELECT idempotency_key FROM idempotency_records WHERE turn_id = ? AND user_id = ?').get(lease.turn_id, lease.user_id) as { idempotency_key?: string } | undefined;
          const idempotencyKey = idemRow?.idempotency_key || deliveryId;

          // Failed result: safe code only, no raw remote error message
          const safeCode: PublicEventCode =
            inspected.errorCode === 'QUOTA_EXCEEDED' ? 'QUOTA_EXCEEDED' :
            inspected.errorCode === 'TURN_TIMEOUT' ? 'TURN_TIMEOUT' :
            inspected.errorCode === 'TURN_CANCELLED' ? 'TURN_CANCELLED' :
            inspected.errorCode === 'INTERRUPTED' ? 'INTERRUPTED' :
            inspected.errorCode === 'SESSION_CORRUPTED' ? 'RECOVERY_REQUIRED' :
            'EXECUTION_FAILED';

          await this.finalizeFailedTurn({
            userId: lease.user_id,
            sessionId: lease.route_id,
            spaceId,
            deliveryId,
            idempotencyKey,
            turnId: lease.turn_id,
            leaseId: lease.id,
            reservationBundle: recoveredReservation ?? undefined,
            code: safeCode,
            reason: 'Turn execution failed',
            isSessionCorrupted: safeCode === 'RECOVERY_REQUIRED',
          });
        } else {
          // Absent or running (stale / interrupted): mark turn interrupted
          let recoveredReservation: QuotaReservationBundle | null = null;
          const deliveryRow = this.db.prepare('SELECT delivery_id FROM delivery_inbox WHERE turn_id = ? AND user_id = ?').get(lease.turn_id, lease.user_id) as { delivery_id?: string } | undefined;
          const deliveryId = deliveryRow?.delivery_id || lease.turn_id;

          if (this.quotaMode === 'enforced' && this.quotaProvider && typeof this.quotaProvider.recoverReservation === 'function') {
            try {
              recoveredReservation = await this.quotaProvider.recoverReservation(deliveryId, lease.user_id);
            } catch (qErr) {
              this.recordSettledError(qErr);
            }
          }

          const turnRow = this.db.prepare('SELECT space_id, route_id FROM turn_runs WHERE turn_id = ? AND user_id = ?').get(lease.turn_id, lease.user_id) as { space_id?: string; route_id?: string } | undefined;
          const spaceId = turnRow?.space_id || 'space-a';
          const idemRow = this.db.prepare('SELECT idempotency_key FROM idempotency_records WHERE turn_id = ? AND user_id = ?').get(lease.turn_id, lease.user_id) as { idempotency_key?: string } | undefined;
          const idempotencyKey = idemRow?.idempotency_key || deliveryId;

          await this.finalizeInterruptedTurn({
            userId: lease.user_id,
            sessionId: lease.route_id,
            spaceId,
            deliveryId,
            idempotencyKey,
            turnId: lease.turn_id,
            leaseId: lease.id,
            reservationBundle: recoveredReservation ?? undefined,
            reason: 'Turn interrupted due to platform restart',
            code: 'INTERRUPTED',
          });
        }
      }
    } catch (leaseErr) {
      const errObj = leaseErr instanceof Error ? leaseErr : new Error(String(leaseErr));
      reconcileErrors.push(errObj);
      this.recordSettledError(errObj);
    }
  }

    // Fail loud: if ANY lease reconciliation failed, throw AggregateError and stop startup immediately!
    // Do NOT proceed to orphan cleanup which could overwrite state.
    if (reconcileErrors.length > 0) {
      throw new AggregateError(reconcileErrors, 'Failed to reconcile active leases during startup redrive');
    }

    // Clean up orphaned running turns without active lease (canonical per-turn finalization)
    const orphanTurns = this.db.prepare(`
      SELECT tr.turn_id, tr.user_id, tr.route_id as session_id, tr.space_id, di.delivery_id, idem.idempotency_key
      FROM turn_runs tr
      LEFT JOIN delivery_inbox di ON tr.turn_id = di.turn_id AND tr.user_id = di.user_id
      LEFT JOIN idempotency_records idem ON tr.turn_id = idem.turn_id AND tr.user_id = idem.user_id
      WHERE tr.status = 'running'
        AND (
          NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_execution_leases')
          OR tr.turn_id NOT IN (SELECT turn_id FROM session_execution_leases WHERE status = 'active')
        )
    `).all() as unknown as Array<{
      turn_id: string;
      user_id: string;
      session_id: string;
      space_id: string | null;
      delivery_id: string | null;
      idempotency_key: string | null;
    }>;

    const orphanErrors: Error[] = [];
    for (const orphan of orphanTurns) {
      try {
        let orphanReservation: QuotaReservationBundle | null = null;
        const deliveryId = orphan.delivery_id || orphan.turn_id;
        if (this.quotaMode === 'enforced' && this.quotaProvider && typeof this.quotaProvider.recoverReservation === 'function') {
          try {
            orphanReservation = await this.quotaProvider.recoverReservation(deliveryId, orphan.user_id);
          } catch {}
        }

        await this.finalizeInterruptedTurn({
          userId: orphan.user_id,
          sessionId: orphan.session_id,
          spaceId: orphan.space_id || 'space-a',
          deliveryId,
          idempotencyKey: orphan.idempotency_key || deliveryId,
          turnId: orphan.turn_id,
          reservationBundle: orphanReservation ?? undefined,
          reason: 'Orphaned running turn interrupted on startup',
          code: 'INTERRUPTED',
        });
      } catch (orphanErr) {
        const errObj = orphanErr instanceof Error ? orphanErr : new Error(String(orphanErr));
        orphanErrors.push(errObj);
        this.recordSettledError(errObj);
      }
    }

    if (orphanErrors.length > 0) {
      throw new AggregateError(orphanErrors, 'Failed to finalize orphaned turns during startup redrive');
    }

    // Synchronize any remaining stuck processing delivery_inbox rows
    this.db.prepare(`
      UPDATE delivery_inbox
      SET status = 'failed', error = 'Orphaned delivery failed on startup', processed_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE status = 'processing'
    `).run(nowIso);

    this.db.prepare(`
      UPDATE idempotency_records
      SET state = 'failed', updated_at = CURRENT_TIMESTAMP
      WHERE state = 'processing'
    `).run();

    // Count sessions with queued turns
    const countRow = this.db.prepare(`
      SELECT COUNT(DISTINCT route_id) as count
      FROM turn_runs
      WHERE status = 'queued'
    `).get() as { count?: number } | undefined;

    // Trigger scheduler
    this.notifyScheduler();

    return countRow?.count ?? 0;
  }

  /**
   * Waits for all in-flight scheduler executions and DB queued/running turns to settle.
   */
  async drain(timeoutMs = 10000): Promise<boolean> {
    const deadline = Date.now() + Math.max(10, timeoutMs);

    // Trigger scheduler to process anything pending
    this.notifyScheduler();

    while (Date.now() < deadline) {
      // 1. If active in-flight tasks exist in this process, await their settlement or race with deadline
      const promises = Array.from(this.activeTasks.values()).map((t) => t.promise);
      if (promises.length > 0) {
        const remainingMs = Math.max(10, deadline - Date.now());
        let timer: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
          timer = setTimeout(() => resolve({ timedOut: true }), remainingMs);
        });

        const raceRes = await Promise.race([
          Promise.allSettled(promises).then(() => ({ timedOut: false })),
          timeoutPromise,
        ]);
        if (timer) clearTimeout(timer);

        if (raceRes.timedOut) {
          break; // Timeout reached, proceed to cancel
        }
      }

      // 2. Check if there are queued or running turns in DB that are not blocked by session recovery
      let queuedOrRunningCount = 0;
      try {
        const row = this.db.prepare(`
          SELECT COUNT(*) as cnt FROM turn_runs tr
          LEFT JOIN session_routes sr ON tr.route_id = sr.id AND tr.user_id = sr.user_id
          WHERE tr.status IN ('queued', 'running')
            AND tr.route_id NOT IN (
              SELECT route_id FROM session_recovery_state WHERE status = 'recovery_required' AND generation = COALESCE(sr.current_generation, 1)
            )
        `).get() as { cnt?: number } | undefined;
        queuedOrRunningCount = row?.cnt ?? 0;
      } catch {}

      if (this.activeTasks.size === 0 && queuedOrRunningCount === 0) {
        if (this.settledErrors.length > 0) {
          const errors = [...this.settledErrors];
          this.settledErrors.length = 0;
          throw new AggregateError(errors, 'One or more turn executions or infrastructure operations failed during drain');
        }
        return true;
      }

      if (Date.now() >= deadline) {
        break;
      }

      // Trigger scheduler again if DB has remaining queued items
      this.notifyScheduler();
      await new Promise((r) => setTimeout(r, 20));
    }

    // Timeout exceeded: if tasks still active, attempt cancel
    if (this.activeTasks.size > 0) {
      const cancelErrors: Error[] = [];
      const cancelPromises: Promise<any>[] = [];
      for (const [turnId, task] of this.activeTasks) {
        cancelPromises.push(
          this.executor.cancel(task.userId, turnId).catch((err) => {
            const e = err instanceof Error ? err : new Error(String(err));
            cancelErrors.push(e);
            this.recordSettledError(e);
          })
        );
      }
      await Promise.allSettled(cancelPromises);

      // Await in-flight task promises to complete settlement with bounded grace
      const remainingPromises = Array.from(this.activeTasks.values()).map((t) => t.promise);
      if (remainingPromises.length > 0) {
        let graceTimer: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.allSettled(remainingPromises),
          new Promise((resolve) => {
            graceTimer = setTimeout(resolve, 200);
          }),
        ]);
        if (graceTimer) clearTimeout(graceTimer);
      }

      if (cancelErrors.length > 0) {
        throw new AggregateError(cancelErrors, 'Failed to cancel active turns on drain timeout');
      }
    }

    if (this.settledErrors.length > 0) {
      const errors = [...this.settledErrors];
      this.settledErrors.length = 0;
      throw new AggregateError(errors, 'One or more turn executions or infrastructure operations failed during drain');
    }

    return this.activeTasks.size === 0;
  }

  async close(): Promise<void> {
    this.isDisposing = true;
    if (this.schedulerLoopTimer) {
      clearInterval(this.schedulerLoopTimer);
      this.schedulerLoopTimer = undefined;
    }
    await this.drain(5000);
  }

  private queryAttachmentsByMessageId(
    messageId: string,
    spaceId: string
  ): CanonicalAttachment[] {
    try {
      const rows = this.db.prepare(`
        SELECT id, relative_path, snapshot_path, etag, size, media_type, display_name
        FROM message_attachments
        WHERE message_id = ?
      `).all(messageId) as Array<{
        id: string;
        relative_path: string;
        snapshot_path: string;
        etag: string;
        size: number;
        media_type: string;
        display_name: string | null;
      }>;

      return rows.map((r) => ({
        id: r.id,
        relativePath: r.relative_path,
        snapshotPath: r.snapshot_path,
        etag: r.etag,
        size: r.size,
        mediaType: r.media_type,
        displayName: r.display_name || undefined,
        downloadReference: `/api/spaces/${encodeURIComponent(spaceId)}/files/download?path=${encodeURIComponent(r.snapshot_path)}`,
      }));
    } catch {
      return [];
    }
  }

  private async processInboundAttachments(
    userId: string,
    spaceId: string,
    deliveryId: string,
    attachments?: readonly any[]
  ): Promise<CanonicalAttachment[]> {
    if (!attachments || attachments.length === 0) {
      return [];
    }

    if (!this.fileProvider) {
      return attachments as CanonicalAttachment[];
    }

    const canonicalList: CanonicalAttachment[] = [];

    for (const rawAtt of attachments) {
      const filePath = rawAtt.path || rawAtt.relativePath;
      const expectedEtag = rawAtt.etag;

      // 1. Stat the file
      let statRes: any;
      try {
        statRes = await this.fileProvider.execute(userId, spaceId, {
          op: 'stat',
          path: filePath,
        });
      } catch (err) {
        throw new PlatformError(
          `Attachment file does not exist: ${filePath}`,
          'NOT_FOUND',
          404
        );
      }

      if (!statRes || statRes.op !== 'stat' || statRes.type !== 'file') {
        throw new PlatformError(
          `Attachment file does not exist: ${filePath}`,
          'NOT_FOUND',
          404
        );
      }

      if (expectedEtag && statRes.etag && expectedEtag !== statRes.etag) {
        throw new PlatformError(
          `Attachment content changed for "${filePath}"`,
          'ATTACHMENT_CHANGED',
          409
        );
      }

      const fileEtag = statRes.etag || expectedEtag || '""';
      const sha = fileEtag.replace(/"/g, '').toLowerCase();
      const baseName = filePath.split(/[/\\]/).pop() || 'file';
      const snapshotPath = `.attachments/${sha}/${baseName}`;
      const size = statRes.size ?? 0;

      // Sniff media type from file header
      let mediaType = rawAtt.mediaType;
      try {
        const readRes = await this.fileProvider.execute(userId, spaceId, {
          op: 'read',
          path: filePath,
          encoding: 'base64',
        });
        if (readRes && 'content' in readRes && typeof (readRes as any).content === 'string') {
          const buf = Buffer.from((readRes as any).content, 'base64');
          mediaType = sniffMimeType(baseName, buf);
        }
      } catch {
        if (!mediaType) {
          mediaType = sniffMimeType(baseName);
        }
      }

      // Check if snapshot already exists
      let snapshotExists = false;
      try {
        const snapStat = await this.fileProvider.execute(userId, spaceId, {
          op: 'stat',
          path: snapshotPath,
        });
        if (snapStat && snapStat.op === 'stat' && snapStat.type === 'file') {
          snapshotExists = true;
        }
      } catch {}

      if (!snapshotExists) {
        // Stage journal
        const journalId = generate32HexId('attc');
        try {
          this.db.prepare(`
            INSERT INTO attachment_snapshot_journal (
              id, delivery_id, user_id, space_id, source_path, snapshot_path, content_sha256, size, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staging', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `).run(
            journalId,
            deliveryId,
            userId,
            spaceId,
            filePath,
            snapshotPath,
            sha,
            size
          );
        } catch {}

        try {
          await this.fileProvider.execute(userId, spaceId, {
            op: 'copy',
            path: filePath,
            targetPath: snapshotPath,
          });

          try {
            this.db.prepare(`
              UPDATE attachment_snapshot_journal
              SET status = 'copied', updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(journalId);
          } catch {}
        } catch (copyErr) {
          try {
            this.db.prepare(`
              UPDATE attachment_snapshot_journal
              SET status = 'aborted', updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(journalId);
          } catch {}
          throw copyErr;
        }
      }

      canonicalList.push({
        id: rawAtt.id || generate32HexId('att'),
        relativePath: filePath,
        snapshotPath,
        etag: fileEtag,
        size,
        mediaType: mediaType || 'application/octet-stream',
        displayName: rawAtt.displayName || undefined,
        downloadReference: `/api/spaces/${encodeURIComponent(spaceId)}/files/download?path=${encodeURIComponent(snapshotPath)}`,
      });
    }

    return canonicalList;
  }
}
