/**
 * Management API Types & Interfaces
 *
 * Defines contracts for Platform Server management console backend,
 * including Admin and Self-Service Manage endpoints and runtime/operations provider integration.
 *
 * @module @enkeep/platform-server/management/types
 */

import type { UserRole, UserStatus, UserLocale, UserTheme } from '@enkeep/platform-core';
import type {
  Task as SafeTask,
  TaskPriority,
  AgentPromptTaskPayload,
  CheckQuotaQuery,
  CheckQuotaResult,
  TenantQuotaLimit,
  QuotaMetric,
  SetQuotaLimitInput as StrictSetQuotaLimitInput,
  TaskWorkerExecutionResult as TaskExecutionResult,
  TaskWorkerDiagnostics,
} from '@enkeep/platform-operations';

export type {
  SafeTask,
  TaskPriority,
  AgentPromptTaskPayload,
  CheckQuotaQuery,
  CheckQuotaResult,
  TenantQuotaLimit,
  QuotaMetric,
  StrictSetQuotaLimitInput,
  TaskExecutionResult,
  TaskWorkerDiagnostics,
};

export interface PluginReadinessStatus {
  receiptStore: boolean;
  inbound: boolean;
  eventRelay: boolean;
  tools: boolean;
  externalInteraction: boolean;
  affinityPolicy: boolean;
  llmAffinity: boolean;
}

export type ToolsUnavailableReasonCode =
  | 'PLATFORM_CLIENT_UNAVAILABLE'
  | 'TOOLS_REGISTRY_UNAVAILABLE'
  | 'TOOLS_SCHEMA_PROBE_FAILED'
  | 'TOOLS_SCHEMA_INCOMPLETE';

/**
 * UserRuntimeStatus only represents a successful runtime health query.
 * Strictly whitelisted fields:
 * - userId: string
 * - status: 'ok' | 'degraded' | 'error'
 * - networkMode: 'none'
 * - dshReady: boolean
 * - uptimeSeconds: number (finite >= 0)
 * - version: string
 * - enkeepBundleLoaded: boolean
 * - toolsCount: number (finite safe integer >= 0)
 * - plugins: PluginReadinessStatus
 * - toolsOperational: boolean
 * - toolsUnavailableReason: exact reason union | null
 *
 * No available, containerId/name/volume, starting/stopped/unavailable.
 */
export interface UserRuntimeStatus {
  userId: string;
  instanceId?: string;
  mode?: 'container' | 'host';
  status: 'ok' | 'degraded' | 'error';
  networkMode: 'none';
  dshReady: boolean;
  uptimeSeconds: number;
  version: string;
  enkeepBundleLoaded: boolean;
  toolsCount: number;
  plugins: PluginReadinessStatus;
  toolsOperational: boolean;
  toolsUnavailableReason: ToolsUnavailableReasonCode | null;
}

export interface RuntimeRestartResult {
  restarted: boolean;
  userIds: string[];
  appliedRuntimes?: string[];
  failedRuntimes?: Array<{ userId: string; error: string }>;
}

/**
 * Narrow, optional provider interface for retrieving live runtime container/plugin status.
 * getUserRuntime returns null when runtime is unavailable or unqueried.
 * listRuntimes returns only statuses that were successfully queried.
 */
export interface ManagementRuntimeProvider {
  getUserRuntime(userId: string, mode?: 'container' | 'host'): Promise<UserRuntimeStatus | null>;
  listRuntimes(): Promise<UserRuntimeStatus[]>;
  restartRuntime?(userId?: string, options?: { mode?: 'container' | 'host' } | 'container' | 'host'): Promise<RuntimeRestartResult>;
  stopRuntime?(userId: string, mode?: 'container' | 'host'): Promise<{ stopped: boolean; userId: string; mode?: 'container' | 'host' }>;
  ensureRuntime?(userId: string, mode?: 'container' | 'host'): Promise<UserRuntimeStatus | null>;
}

export interface AdminDashboardCounts {
  users: {
    total: number;
    active: number;
    disabled: number;
    admin: number;
    user: number;
  };
  spaces: {
    total: number;
  };
  sessions: {
    total: number;
  };
  messages: {
    total: number;
  };
  tasks: {
    total: number;
    pending: number;
    claimed: number;
    running: number;
    processing: number;
    completed: number;
    failed: number;
    cancelled: number;
  };
  deliveries: {
    total: number;
    held: number;
    processing: number;
    delivered: number;
    duplicate: number;
    cancelled: number;
    failed: number;
  };
  imports: {
    totalReceipts: number;
    totalImportedMessages: number;
  };
  auth: {
    recentLoginFailures24h: number;
  };
  schema: {
    currentVersion: number;
  };
}

export interface AdminDashboardContainerKpi {
  available: boolean;
  active: number | null;
  healthy: number | null;
  total: number | null;
  status: 'available' | 'unavailable' | 'error';
}

export type AdminDashboardRuntimeKpi = AdminDashboardContainerKpi;

export interface AdminDashboardKpis {
  users: {
    total: number;
    active: number;
    disabled: number;
    admin: number;
    user: number;
  };
  spaces: number;
  sessions: number;
  containers: AdminDashboardContainerKpi;
  heldDeliveries: number;
  processingTasks: number;
  runningTasks: number;
  recentLoginFailures24h: number;
  currentSchemaVersion: number;
}

export interface AdminDashboardRuntimeSummary {
  totalRuntimes: number;
  healthyRuntimes: number;
  activeRuntimes: number;
  allDshReady: boolean;
  toolsOperationalCount: number;
}

export interface AdminDashboardRuntime {
  available: boolean;
  providerAttached: boolean;
  status: 'available' | 'unavailable' | 'error';
  totalContainers: number | null;
  activeContainers: number | null;
  healthyContainers: number | null;
  summary: AdminDashboardRuntimeSummary | null;
}

export interface AdminDashboardData {
  uptime: number;
  timestamp: string;
  counts: AdminDashboardCounts;
  kpis: AdminDashboardKpis;
  runtime: AdminDashboardRuntime;
  operations: OperationsReadinessStatus;
  schema: {
    currentVersion: number;
  };
}

export interface SafeAdminUser {
  id: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  displayName: string | null;
  locale: UserLocale;
  theme?: UserTheme;
  mustChangePassword?: boolean;
  createdAt: string;
  updatedAt: string;
  sessionCount: number;
  activeSessionCount: number;
  spaceCount: number;
}

export interface AdminUsersListResult {
  items: SafeAdminUser[];
  total: number;
  limit: number;
  offset: number;
}

export interface PatchUserBody {
  role?: UserRole;
  status?: UserStatus;
  displayName?: string | null;
  locale?: UserLocale;
  theme?: UserTheme;
}

export interface RevokeSessionsResult {
  revokedCount: number;
  targetUserId: string;
  forceLogout: boolean;
}

export interface SafeAdminSpace {
  id: string;
  userId: string;
  username: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sessionCount: number;
}

export interface AdminSpacesListResult {
  items: SafeAdminSpace[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminTaskItem {
  id: string;
  userId: string;
  username: string;
  title: string;
  priority: string;
  status: string;
  dueDate: string | null;
  scheduleType?: string;
  cronExpression?: string | null;
  intervalSeconds?: number | null;
  nextRunAt?: string | null;
  isPaused?: boolean;
  pausedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  errorPresent: boolean;
  errorCode: string | null;
}

export interface SafeTaskRunItem {
  id: string;
  taskId: string;
  attemptNumber: number;
  status: string;
  scheduledFor: string | null;
  startedAt: string | null;
  completedAt: string | null;
  turnId: string | null;
  deliveryId: string | null;
  errorCode: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  createdAt: string;
}

export interface AdminTaskRunsListResult {
  items: SafeTaskRunItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminTasksListResult {
  items: AdminTaskItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminDeliveryItem {
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminDeliveriesListResult {
  items: AdminDeliveryItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface SafeTurnRunItem {
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AdminQuotaReservationAggregate {
  resource: string;
  status: string;
  count: number;
  amount: number;
}

export interface AdminQuotaItem {
  userId: string;
  username: string;
  limits: Array<{
    resource: string;
    limit: number;
    windowSeconds?: number;
    resetAt?: string | null;
    updatedAt: string;
  }>;
  usage: Array<{
    resource: string;
    usedAmount: number;
    updatedAt: string;
  }>;
  activeReservations: AdminQuotaReservationAggregate[];
}

export interface AdminQuotasListResult {
  items: AdminQuotaItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminAuditItem {
  id: string;
  userId: string | null;
  username: string;
  action: string;
  ipAddress: string | null;
  userAgent: string | null;
  metadataAvailable: boolean;
  createdAt: string;
}

export interface AdminAuditListResult {
  items: AdminAuditItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminImportReceiptItem {
  userId: string;
  username: string;
  importerVersion: string;
  sessionFormat: number;
  sourceChatsCount: number;
  sourceMessagesCount: number;
  importedMessagesCount: number;
  droppedMessagesCount: number;
  attachmentsCount: number;
  status: 'completed';
  createdAt: string;
}

export interface AdminImportsListResult {
  items: AdminImportReceiptItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminPluginRuntimeItem {
  userId: string;
  status: 'ok' | 'degraded' | 'error';
  dshReady: boolean;
  toolsCount: number;
  enkeepBundleLoaded: boolean;
  schemasRegistered: boolean;
  toolsOperational: boolean;
  toolsUnavailableReason: ToolsUnavailableReasonCode | null;
  executionOperational: boolean;
  reason: ToolsUnavailableReasonCode | null;
  plugins: PluginReadinessStatus;
  networkMode: 'none';
  uptimeSeconds: number;
  version: string;
}

export interface AdminPluginsData {
  available: boolean;
  status: 'available' | 'unavailable' | 'error' | 'protocol_error';
  message?: string;
  runtimes: AdminPluginRuntimeItem[];
}

export interface AdminSecurityData {
  migrations: {
    currentVersion: number;
    expectedVersion: number;
    checksumsMatch: boolean;
    applied: Array<{
      version: number;
      name: string;
      appliedAt: string;
    }>;
  };
  securityPolicy: {
    hostBinding: string;
    allowedHosts: readonly string[];
    securityHeaders: Record<string, string>;
    csrfRequired: boolean;
    csrfHeader: string;
    limits: {
      maxBodySizeBytes: number;
      requestTimeoutMs: number;
      maxCookieSizeBytes: number;
      maxFailedLogins: number;
      failedLoginWindowSeconds: number;
    };
  };
}

export interface SafeAuthUser {
  id: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  displayName: string | null;
  createdAt: string;
}

export interface UserOverviewData {
  user: SafeAuthUser;
  counts: {
    spaces: number;
    sessions: number;
    messages: number;
    tasks: {
      total: number;
      pending: number;
      running: number;
      completed: number;
      failed: number;
    };
    deliveries: {
      total: number;
      held: number;
      delivered: number;
      failed: number;
    };
    imports: number;
  };
  runtime: UserRuntimeStatus | null;
  operations: OperationsReadinessStatus;
}

export type AgentPromptSessionPolicy = 'existing_session';

/**
 * Strict Agent Prompt Task Payload adhering to platform core agent contract.
 * Strictly whitelisted fields:
 * - type: 'agent_prompt'
 * - prompt: string
 * - sessionId: string
 * - sessionPolicy: 'existing_session'
 * - spaceId?: string
 */
export interface StrictCreateTaskInput {
  idempotencyKey: string;
  title: string;
  payload: AgentPromptTaskPayload;
  priority?: TaskPriority;
  dueDate?: string;
  scheduleType?: 'once' | 'cron' | 'interval';
  cronExpression?: string;
  intervalSeconds?: number;
  timezone?: string;
  misfirePolicy?: 'coalesce' | 'skip';
  overlapPolicy?: 'skip';
}

/**
 * Exact, single-shape ManagementOperationsProvider for administrative and tenant operations.
 * Strictly non-optional methods when provider is present; operations provider itself is optional in handler.
 * No nested / forTenant duck aliases or index signatures.
 */
export interface ManagementOperationsProvider {
  createTask(userId: string, input: StrictCreateTaskInput): Promise<{ task: SafeTask; isIdempotentHit: boolean }>;
  cancelTask(userId: string, taskId: string): Promise<SafeTask>;
  pauseTask?(userId: string, taskId: string): Promise<SafeTask>;
  resumeTask?(userId: string, taskId: string): Promise<SafeTask>;
  getTask(userId: string, taskId: string): Promise<SafeTask | null>;
  setQuotaLimit(userId: string, input: StrictSetQuotaLimitInput): Promise<TenantQuotaLimit>;
  checkQuota(userId: string, query?: CheckQuotaQuery): Promise<CheckQuotaResult>;
}

export interface TaskWorkerRunner {
  runNow(options: { taskId: string; tenantId: string }): Promise<TaskExecutionResult | null>;
  getDiagnostics?(): TaskWorkerDiagnostics;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export type OperationsProducerUnavailableReason = 'OPERATIONS_PROVIDER_UNAVAILABLE';

export interface OperationsProducerStatus {
  available: boolean;
  unavailableReason: OperationsProducerUnavailableReason | null;
}

export type OperationsWorkerUnavailableReason = 'WORKER_DISABLED' | 'WORKER_UNAVAILABLE';

export interface OperationsWorkerStatus {
  available: boolean;
  running: boolean;
  unavailableReason: OperationsWorkerUnavailableReason | null;
}

// ----------------------------------------------------
// User Management & Security Types
// ----------------------------------------------------

export interface TenantQuotaDefaultsConfig {
  readonly turns: number;
  readonly messages: number;
  readonly tokens: number;
  readonly storage_bytes: number;
  readonly api_calls: number;
  readonly resetInterval?: 'none' | 'daily' | 'monthly' | null;
}

export const DEMO_TENANT_QUOTA_DEFAULTS: TenantQuotaDefaultsConfig = {
  turns: -1,
  messages: -1,
  tokens: -1,
  storage_bytes: -1,
  api_calls: -1,
  resetInterval: 'none',
};

export const TEST_TENANT_QUOTA_DEFAULTS: TenantQuotaDefaultsConfig = DEMO_TENANT_QUOTA_DEFAULTS;

export interface CreateUserBody {
  username: string;
  displayName?: string | null;
  role?: UserRole;
  locale?: UserLocale;
  theme?: UserTheme;
  tempPassword?: string;
}

export interface CreateUserResult {
  user: SafeAdminUser;
  tempPassword: string;
  defaultSpace?: {
    id: string;
    name: string;
    folder: string;
  };
  provisioning?: {
    status: 'pending' | 'ready' | 'failed';
  };
}

export interface ResetPasswordResult {
  targetUserId: string;
  username: string;
  tempPassword: string;
  message: string;
}

export interface ChangePasswordBody {
  oldPassword: string;
  newPassword: string;
}

export interface ChangePasswordResult {
  success: boolean;
  message: string;
}

// ----------------------------------------------------
// Model Config Control Plane Types
// ----------------------------------------------------

export interface SafeDshModel {
  id: string;
  name?: string;
  description?: string;
  contextWindow?: number;
  maxTokens?: number;
  inputModalities?: string[];
  reasoningEfforts?: Record<string, string | null | undefined>;
}

export interface SafeDshProvider {
  id: string;
  displayName?: string;
  api: string;
  configured: boolean;
  defaultContextWindow?: number;
  defaultMaxTokens?: number;
  defaultInput?: string[];
  compat?: Record<string, unknown>;
  models: SafeDshModel[];
}

export interface SafeModelOverride {
  provider: string | null;
  model: string | null;
  reasoningEffort: string | null;
  fallbackChain?: readonly any[] | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface ModelConfigSafeProjection {
  providers: Record<string, SafeDshProvider>;
  defaultModel: {
    provider: string;
    model: string;
    reasoningEffort?: string;
  };
  dshDefaultModel: {
    provider: string;
    model: string;
    reasoningEffort?: string;
  };
  override: SafeModelOverride | null;
  healthSummaries?: any[];
  revision?: string;
  restartRequired?: boolean;
  restartStatus?: 'success' | 'partial' | 'failed' | 'skipped';
  appliedRuntimes?: string[];
  failedRuntimes?: Array<{ userId: string; error: string }>;
  auditRecorded?: boolean;
}

export interface PatchModelConfigBody {
  provider?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  fallbackChain?: readonly any[] | null;
  clear?: boolean;
  applyMode?: 'restart_all' | 'save_only';
  ifMatch?: string | null;
}

export interface OperationsReadinessStatus {
  producer: OperationsProducerStatus;
  worker: OperationsWorkerStatus;
}
