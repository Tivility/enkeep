import { randomUUID } from 'node:crypto';
import { ValidationError } from '../errors/index.js';

export type TaskStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = typeof TASK_PRIORITIES[number];

export type AgentPromptSessionPolicy = 'existing_session';

export const TASK_ID_REGEX = /^task_[0-9a-f]{32}$/;
export const SCHEDULE_ID_REGEX = /^sched_[0-9a-f]{32}$/;
export const RUN_ID_REGEX = /^run_[0-9a-f]{32}$/;
export const TURN_ID_REGEX = /^turn_[0-9a-f]{32}$/;
export const MESSAGE_ID_REGEX = /^msg_[0-9a-f]{32}$/;
export const SESSION_ID_REGEX = /^(?:ses_[0-9a-f]{32}|import-[0-9a-f]{32})$/;
export const SPACE_ID_REGEX = /^spc_[0-9a-f]{32}$/;
export const IDEMPOTENCY_KEY_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const TASK_SCHEDULE_TYPES = ['once', 'cron', 'interval'] as const;
export type TaskScheduleType = typeof TASK_SCHEDULE_TYPES[number];

export const TASK_SCHEDULE_MISFIRE_POLICIES = ['coalesce', 'skip'] as const;
export type TaskScheduleMisfirePolicy = typeof TASK_SCHEDULE_MISFIRE_POLICIES[number];

export const TASK_SCHEDULE_OVERLAP_POLICIES = ['skip'] as const;
export type TaskScheduleOverlapPolicy = typeof TASK_SCHEDULE_OVERLAP_POLICIES[number];

export const TASK_RUN_STATUSES = [
  'pending',
  'claimed',
  'running',
  'completed',
  'failed',
  'cancelled',
  'timeout',
  'aborted',
  'lease_lost',
] as const;
export type TaskRunStatus = typeof TASK_RUN_STATUSES[number];

export const ALLOWED_AGENT_PROMPT_PAYLOAD_KEYS = new Set([
  'type',
  'prompt',
  'sessionId',
  'sessionPolicy',
  'spaceId',
]);

export const ALLOWED_AGENT_PROMPT_RESULT_KEYS = new Set([
  'status',
  'completedAt',
  'turnId',
  'sessionId',
  'spaceId',
  'messageId',
]);

export const MAX_PROMPT_BYTES = 65_536; // 64 KiB
export const MAX_ID_LENGTH = 256;

/**
 * Fixed safe protocol error codes for task worker lifecycle and task errors.
 * Strictly avoids raw exception strings, stack traces, and management/tenant info leakage.
 */
export const TASK_PROTOCOL_ERROR_CODES = {
  PAYLOAD_INVALID: 'TASK_PAYLOAD_INVALID',
  RESULT_INVALID: 'TASK_RESULT_INVALID',
  EXECUTION_FAILED: 'TASK_EXECUTION_FAILED',
  LEASE_EXPIRED: 'TASK_LEASE_EXPIRED',
  ABORTED: 'TASK_ABORTED',
  CANCELLED: 'TASK_CANCELLED',
  SETTLEMENT_FAILED: 'TASK_SETTLEMENT_FAILED',
  TENANT_ACCESS_FAILED: 'TENANT_ACCESS_FAILED',
  TENANT_ENUMERATION_FAILED: 'TENANT_ENUMERATION_FAILED',
  RECOVERY_FAILED: 'RECOVERY_FAILED',
  CLAIM_FAILED: 'CLAIM_FAILED',
  CALLBACK_FAILED: 'CALLBACK_FAILED',
  TASK_PAUSED: 'TASK_PAUSED',
  OVERLAP_SKIPPED: 'OVERLAP_SKIPPED',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
} as const;

export type TaskProtocolErrorCode =
  typeof TASK_PROTOCOL_ERROR_CODES[keyof typeof TASK_PROTOCOL_ERROR_CODES];

/**
 * Generate a canonical task ID matching `task_` + 32 lowercase hex characters.
 */
export function generateTaskId(): string {
  return `task_${randomUUID().replace(/-/g, '').toLowerCase()}`;
}

export function generateScheduleId(): string {
  return `sched_${randomUUID().replace(/-/g, '').toLowerCase()}`;
}

export function generateRunId(): string {
  return `run_${randomUUID().replace(/-/g, '').toLowerCase()}`;
}

export function validateTaskId(id: unknown): string {
  if (typeof id !== 'string' || !TASK_ID_REGEX.test(id)) {
    throw new ValidationError('Invalid task ID format');
  }
  return id;
}

export function validateScheduleId(id: unknown): string {
  if (typeof id !== 'string' || !SCHEDULE_ID_REGEX.test(id)) {
    throw new ValidationError('Invalid schedule ID format');
  }
  return id;
}

export function validateRunId(id: unknown): string {
  if (typeof id !== 'string' || !RUN_ID_REGEX.test(id)) {
    throw new ValidationError('Invalid run ID format');
  }
  return id;
}

export function validateTurnId(id: unknown): string {
  if (typeof id !== 'string' || !TURN_ID_REGEX.test(id)) {
    throw new ValidationError('Invalid turn ID format');
  }
  return id;
}

export function validateMessageId(id: unknown): string {
  if (typeof id !== 'string' || !MESSAGE_ID_REGEX.test(id)) {
    throw new ValidationError('Invalid message ID format');
  }
  return id;
}

export function validateSessionId(id: unknown): string {
  if (typeof id !== 'string' || !SESSION_ID_REGEX.test(id)) {
    throw new ValidationError('Invalid session ID format');
  }
  return id;
}

export function validateSpaceId(id: unknown): string {
  if (typeof id !== 'string' || !SPACE_ID_REGEX.test(id)) {
    throw new ValidationError('Invalid space ID format');
  }
  return id;
}

export function validateIdempotencyKey(key: unknown): string {
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY_REGEX.test(key)) {
    throw new ValidationError('Invalid idempotency key format');
  }
  return key;
}

export function validateClaimantId(id: unknown): string {
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id !== id.trim() ||
    Buffer.byteLength(id, 'utf-8') > 256
  ) {
    throw new ValidationError('Invalid claimant ID format');
  }
  return id;
}

export function validateCanonicalDueDate(dueDate: unknown): string {
  if (typeof dueDate !== 'string' || dueDate.length === 0 || dueDate !== dueDate.trim()) {
    throw new ValidationError('Invalid due date format');
  }
  const parsed = new Date(dueDate);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== dueDate) {
    throw new ValidationError('Invalid due date format');
  }
  return dueDate;
}

export function validateTaskTitle(title: unknown): string {
  if (typeof title !== 'string' || title.length === 0 || title !== title.trim()) {
    throw new ValidationError('Invalid task title');
  }
  if (Buffer.byteLength(title, 'utf-8') > 256) {
    throw new ValidationError('Task title exceeds maximum allowed bytes');
  }
  return title;
}

export function validateTaskPriority(priority: unknown): TaskPriority {
  if (typeof priority !== 'string' || !TASK_PRIORITIES.includes(priority as TaskPriority)) {
    throw new ValidationError('Invalid task priority');
  }
  return priority as TaskPriority;
}

export interface AgentPromptTaskPayload {
  type: 'agent_prompt';
  prompt: string;
  sessionId: string;
  sessionPolicy: 'existing_session';
  spaceId?: string;
}

export function validateAgentPromptPayload(payload: unknown): AgentPromptTaskPayload {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError('Task payload must be a plain object');
  }

  const obj = payload as Record<string, unknown>;
  const keys = Object.keys(obj);

  for (const key of keys) {
    if (!ALLOWED_AGENT_PROMPT_PAYLOAD_KEYS.has(key)) {
      throw new ValidationError('Task payload contains unrecognized or forbidden fields');
    }
  }

  if (obj.type !== 'agent_prompt') {
    throw new ValidationError('Invalid task payload type');
  }

  if (typeof obj.prompt !== 'string') {
    throw new ValidationError('Task payload prompt must be a string');
  }
  if (obj.prompt.trim().length === 0) {
    throw new ValidationError('Task payload prompt must not be empty');
  }
  if (Buffer.byteLength(obj.prompt, 'utf-8') > MAX_PROMPT_BYTES) {
    throw new ValidationError('Task payload prompt exceeds maximum allowed size');
  }

  const sessionId = validateSessionId(obj.sessionId);

  if (obj.sessionPolicy !== 'existing_session') {
    throw new ValidationError('Invalid task payload session policy');
  }

  let spaceId: string | undefined;
  if (obj.spaceId !== undefined) {
    spaceId = validateSpaceId(obj.spaceId);
  }

  return {
    type: 'agent_prompt',
    prompt: obj.prompt,
    sessionId,
    sessionPolicy: 'existing_session',
    ...(spaceId !== undefined ? { spaceId } : {}),
  };
}

export interface AgentPromptDispatchResult {
  status: 'completed';
  completedAt: string;
  turnId?: string;
  sessionId?: string;
  spaceId?: string;
  messageId?: string;
}

export type AgentPromptCompletedResult = AgentPromptDispatchResult;

export function validateAgentPromptResult(result: unknown): AgentPromptDispatchResult {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new ValidationError('Task dispatch result must be a plain object');
  }

  const obj = result as Record<string, unknown>;
  const keys = Object.keys(obj);

  for (const key of keys) {
    if (!ALLOWED_AGENT_PROMPT_RESULT_KEYS.has(key)) {
      throw new ValidationError('Task dispatch result contains unrecognized or forbidden fields');
    }
  }

  if (obj.status !== 'completed') {
    throw new ValidationError('Task dispatch result status must be completed');
  }

  if (
    typeof obj.completedAt !== 'string' ||
    obj.completedAt.length === 0 ||
    obj.completedAt !== obj.completedAt.trim()
  ) {
    throw new ValidationError('Task dispatch result completedAt must be a canonical ISO timestamp');
  }
  const parsedDate = new Date(obj.completedAt);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString() !== obj.completedAt) {
    throw new ValidationError('Task dispatch result completedAt must be a canonical ISO timestamp');
  }

  return {
    status: 'completed',
    completedAt: obj.completedAt,
    ...(typeof obj.turnId === 'string' ? { turnId: obj.turnId } : {}),
    ...(typeof obj.sessionId === 'string' ? { sessionId: obj.sessionId } : {}),
    ...(typeof obj.spaceId === 'string' ? { spaceId: obj.spaceId } : {}),
    ...(typeof obj.messageId === 'string' ? { messageId: obj.messageId } : {}),
  };
}

export interface TaskSchedule {
  id: string;
  taskId: string;
  userId: string;
  scheduleType: TaskScheduleType;
  cronExpression?: string | null;
  intervalSeconds?: number | null;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  timezone: string;
  enabled: boolean;
  pausedAt?: string | null;
  misfirePolicy: TaskScheduleMisfirePolicy;
  overlapPolicy: TaskScheduleOverlapPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRun {
  id: string;
  taskId: string;
  scheduleId?: string | null;
  userId: string;
  attemptNumber: number;
  status: TaskRunStatus;
  claimantId?: string | null;
  leaseExpiresAt?: string | null;
  scheduledFor?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  deliveryId?: string | null;
  turnId?: string | null;
  sessionId?: string | null;
  errorCode?: string | null;
  error?: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  userId: string;
  idempotencyKey?: string | null;
  title: string;
  description?: string | null;
  assignee?: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  payload: AgentPromptTaskPayload;
  result?: AgentPromptDispatchResult | null;
  error?: string | null;
  claimantId?: string | null;
  leaseExpiresAt?: string | null;
  leaseDurationMs: number;
  claimCount: number;
  maxRetries: number;
  dueDate?: string | null;
  scheduleType?: TaskScheduleType;
  cronExpression?: string | null;
  intervalSeconds?: number | null;
  nextRunAt?: string | null;
  timezone?: string;
  schedule?: TaskSchedule | null;
  currentRun?: TaskRun | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

export interface CreateTaskInput {
  id?: string;
  idempotencyKey?: string;
  title: string;
  description?: string;
  assignee?: string;
  priority?: TaskPriority;
  payload: AgentPromptTaskPayload;
  leaseDurationMs?: number;
  maxRetries?: number;
  dueDate?: string;
  scheduleType?: TaskScheduleType;
  cronExpression?: string;
  intervalSeconds?: number;
  timezone?: string;
  misfirePolicy?: TaskScheduleMisfirePolicy;
  overlapPolicy?: TaskScheduleOverlapPolicy;
}

export interface ClaimTaskInput {
  claimantId: string;
  leaseDurationMs?: number;
  preferredTaskId?: string;
  now?: Date | string;
}

export interface RenewLeaseInput {
  claimantId: string;
  leaseDurationMs?: number;
  runId?: string;
}

export interface CompleteTaskInput {
  claimantId: string;
  result: AgentPromptDispatchResult;
  runId?: string;
  tokenUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface FailTaskInput {
  claimantId: string;
  error: string;
  errorCode?: string;
  retryable?: boolean;
  runId?: string;
}

export interface CancelTaskInput {
  reason?: string;
}

export interface TaskQueryOptions {
  status?: TaskStatus | TaskStatus[];
  priority?: TaskPriority;
  assignee?: string;
  scheduleType?: TaskScheduleType;
  limit?: number;
  offset?: number;
}

export interface TaskRunQueryOptions {
  taskId?: string;
  status?: TaskRunStatus | TaskRunStatus[];
  limit?: number;
  offset?: number;
}

export interface TaskRunsListResult {
  items: TaskRun[];
  total: number;
  limit: number;
  offset: number;
}

export interface TaskRecoveryResult {
  recoveredCount: number;
  retriedIds: string[];
  failedIds: string[];
  taskIds?: string[];
}
