import { randomUUID } from 'node:crypto';
import { ValidationError } from '../errors/index.js';
import {
  validateScheduleType,
  validateCronExpression,
  validateIntervalSeconds,
  validateMisfirePolicy,
  validateOverlapPolicy,
  validateTimezone,
} from '../tasks/schedule-calculator.js';

export type TaskStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = typeof TASK_PRIORITIES[number];

export type AgentPromptSessionPolicy = 'existing_session' | 'isolated';
export type AgentPromptContextMode = 'group' | 'isolated';

export const TASK_ID_REGEX = /^(?:task_[0-9a-f]{32}|task_hpc_[0-9a-f]{24})$/;
export const SCHEDULE_ID_REGEX = /^sched_[0-9a-f]{32}$/;
export const RUN_ID_REGEX = /^run_[0-9a-f]{32}$/;
export const TURN_ID_REGEX = /^turn_[0-9a-f]{32}$/;
export const MESSAGE_ID_REGEX = /^msg_[0-9a-f]{32}$/;
export const SESSION_ID_REGEX = /^(?:ses_[0-9a-f]{32}|import-[0-9a-f]{32})$/;
export const SPACE_ID_REGEX = /^(?:spc_[0-9a-f]{32}|impsp_[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
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
  'contextMode',
  'spaceId',
  'spaceFolder',
  'delivery',
  'silent',
]);

export const ALLOWED_SCRIPT_TASK_PAYLOAD_KEYS = new Set([
  'type',
  'command',
  'spaceId',
  'spaceFolder',
  'timeoutMs',
  'delivery',
  'silent',
]);

export const ALLOWED_AGENT_PROMPT_RESULT_KEYS = new Set([
  'status',
  'completedAt',
  'turnId',
  'sessionId',
  'spaceId',
  'messageId',
]);

export const ALLOWED_SCRIPT_TASK_RESULT_KEYS = new Set([
  'status',
  'completedAt',
  'stdout',
  'stderr',
  'exitCode',
  'durationMs',
  'timedOut',
  'aborted',
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

export interface TaskDeliveryTarget {
  channel: 'lark' | string;
  accountId: string;
  nativeContextId: string;
}

export interface AgentPromptTaskPayload {
  type: 'agent_prompt';
  prompt: string;
  sessionId: string;
  sessionPolicy: AgentPromptSessionPolicy;
  contextMode?: AgentPromptContextMode;
  spaceId?: string;
  spaceFolder?: string;
  delivery?: TaskDeliveryTarget;
  silent?: boolean;
}

export interface ScriptTaskPayload {
  type: 'script';
  command: string;
  spaceId: string;
  spaceFolder?: string;
  timeoutMs?: number;
  delivery?: TaskDeliveryTarget;
  silent?: boolean;
}

export type TaskPayload = AgentPromptTaskPayload | ScriptTaskPayload;

export const SPACE_FOLDER_REGEX = /^[a-zA-Z0-9._-]+$/;

export function validateSpaceFolder(folder: unknown): string {
  if (
    typeof folder !== 'string' ||
    folder.length === 0 ||
    folder !== folder.trim() ||
    folder.length > 128 ||
    !SPACE_FOLDER_REGEX.test(folder) ||
    folder === '.' ||
    folder === '..' ||
    folder.includes('..')
  ) {
    throw new ValidationError('Invalid space folder format');
  }
  return folder;
}

export function validateAgentPromptPayload(payload: unknown): AgentPromptTaskPayload {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError('Task payload must be a plain object');
  }

  const obj = payload as Record<string, unknown>;
  if (obj.type === 'script') {
    return validateScriptTaskPayload(payload) as unknown as AgentPromptTaskPayload;
  }

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

  let sessionPolicy: AgentPromptSessionPolicy = 'existing_session';
  if (obj.sessionPolicy !== undefined) {
    if (obj.sessionPolicy !== 'existing_session' && obj.sessionPolicy !== 'isolated') {
      throw new ValidationError('Invalid task payload session policy');
    }
    sessionPolicy = obj.sessionPolicy;
  }

  let contextMode: AgentPromptContextMode | undefined;
  if (obj.contextMode !== undefined) {
    if (obj.contextMode !== 'group' && obj.contextMode !== 'isolated') {
      throw new ValidationError('Invalid task payload context mode');
    }
    contextMode = obj.contextMode;
    if (obj.sessionPolicy === undefined) {
      sessionPolicy = contextMode === 'isolated' ? 'isolated' : 'existing_session';
    } else {
      const mapped = contextMode === 'isolated' ? 'isolated' : 'existing_session';
      if (sessionPolicy !== mapped) {
        throw new ValidationError('Conflicting sessionPolicy and contextMode in task payload');
      }
    }
  }

  let spaceId: string | undefined;
  if (obj.spaceId !== undefined) {
    spaceId = validateSpaceId(obj.spaceId);
  }

  let spaceFolder: string | undefined;
  if (obj.spaceFolder !== undefined) {
    spaceFolder = validateSpaceFolder(obj.spaceFolder);
  }

  let silent: boolean | undefined;
  if (obj.silent !== undefined) {
    if (typeof obj.silent !== 'boolean') {
      throw new ValidationError('Task payload silent must be a boolean');
    }
    silent = obj.silent;
  }

  let delivery: TaskDeliveryTarget | undefined;
  if (obj.delivery !== undefined && obj.delivery !== null) {
    if (silent === true) {
      throw new ValidationError('Task payload cannot specify both silent=true and a delivery target');
    }
    if (typeof obj.delivery !== 'object' || Array.isArray(obj.delivery)) {
      throw new ValidationError('Task payload delivery must be an object');
    }
    const del = obj.delivery as Record<string, unknown>;
    if (typeof del.channel !== 'string' || !del.channel.trim()) {
      throw new ValidationError('Task payload delivery channel must be a non-empty string');
    }
    if (typeof del.accountId !== 'string' || !del.accountId.trim()) {
      throw new ValidationError('Task payload delivery accountId must be a non-empty string');
    }
    if (typeof del.nativeContextId !== 'string' || !del.nativeContextId.trim()) {
      throw new ValidationError('Task payload delivery nativeContextId must be a non-empty string');
    }
    delivery = {
      channel: del.channel.trim(),
      accountId: del.accountId.trim(),
      nativeContextId: del.nativeContextId.trim(),
    };
  }

  return {
    type: 'agent_prompt',
    prompt: obj.prompt,
    sessionId,
    sessionPolicy,
    ...(contextMode !== undefined ? { contextMode } : {}),
    ...(spaceId !== undefined ? { spaceId } : {}),
    ...(spaceFolder !== undefined ? { spaceFolder } : {}),
    ...(delivery !== undefined ? { delivery } : {}),
    ...(silent !== undefined ? { silent } : {}),
  };
}

export function validateScriptTaskPayload(payload: unknown): ScriptTaskPayload {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError('Task payload must be a plain object');
  }

  const obj = payload as Record<string, unknown>;
  const keys = Object.keys(obj);

  for (const key of keys) {
    if (!ALLOWED_SCRIPT_TASK_PAYLOAD_KEYS.has(key)) {
      throw new ValidationError('Task payload contains unrecognized or forbidden fields');
    }
  }

  if (obj.type !== 'script') {
    throw new ValidationError('Invalid task payload type');
  }

  if (typeof obj.command !== 'string') {
    throw new ValidationError('Task payload command must be a string');
  }
  if (obj.command.trim().length === 0) {
    throw new ValidationError('Task payload command must not be empty');
  }
  if (Buffer.byteLength(obj.command, 'utf-8') > MAX_PROMPT_BYTES) {
    throw new ValidationError('Task payload command exceeds maximum allowed size');
  }

  const spaceId = validateSpaceId(obj.spaceId);

  let spaceFolder: string | undefined;
  if (obj.spaceFolder !== undefined) {
    spaceFolder = validateSpaceFolder(obj.spaceFolder);
  }

  let timeoutMs: number | undefined;
  if (obj.timeoutMs !== undefined) {
    if (
      typeof obj.timeoutMs !== 'number' ||
      !Number.isSafeInteger(obj.timeoutMs) ||
      obj.timeoutMs <= 0 ||
      obj.timeoutMs > 1_800_000
    ) {
      throw new ValidationError('Invalid timeoutMs: must be a positive integer <= 1800000');
    }
    timeoutMs = obj.timeoutMs;
  }

  let silent: boolean | undefined;
  if (obj.silent !== undefined) {
    if (typeof obj.silent !== 'boolean') {
      throw new ValidationError('Task payload silent must be a boolean');
    }
    silent = obj.silent;
  }

  let delivery: TaskDeliveryTarget | undefined;
  if (obj.delivery !== undefined && obj.delivery !== null) {
    if (silent === true) {
      throw new ValidationError('Task payload cannot specify both silent=true and a delivery target');
    }
    if (typeof obj.delivery !== 'object' || Array.isArray(obj.delivery)) {
      throw new ValidationError('Task payload delivery must be an object');
    }
    const del = obj.delivery as Record<string, unknown>;
    if (typeof del.channel !== 'string' || !del.channel.trim()) {
      throw new ValidationError('Task payload delivery channel must be a non-empty string');
    }
    if (typeof del.accountId !== 'string' || !del.accountId.trim()) {
      throw new ValidationError('Task payload delivery accountId must be a non-empty string');
    }
    if (typeof del.nativeContextId !== 'string' || !del.nativeContextId.trim()) {
      throw new ValidationError('Task payload delivery nativeContextId must be a non-empty string');
    }
    delivery = {
      channel: del.channel.trim(),
      accountId: del.accountId.trim(),
      nativeContextId: del.nativeContextId.trim(),
    };
  }

  return {
    type: 'script',
    command: obj.command,
    spaceId,
    ...(spaceFolder !== undefined ? { spaceFolder } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(delivery !== undefined ? { delivery } : {}),
    ...(silent !== undefined ? { silent } : {}),
  };
}

export function validateTaskPayload(payload: unknown): TaskPayload {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError('Task payload must be a plain object');
  }
  const obj = payload as Record<string, unknown>;
  if (obj.type === 'script') {
    return validateScriptTaskPayload(payload);
  }
  return validateAgentPromptPayload(payload);
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

export interface ScriptTaskDispatchResult {
  status: 'completed';
  completedAt: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut?: boolean;
  aborted?: boolean;
}

export type TaskDispatchResult = AgentPromptDispatchResult | ScriptTaskDispatchResult;

export function validateScriptTaskResult(result: unknown): ScriptTaskDispatchResult {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new ValidationError('Task dispatch result must be a plain object');
  }

  const obj = result as Record<string, unknown>;
  const keys = Object.keys(obj);

  for (const key of keys) {
    if (!ALLOWED_SCRIPT_TASK_RESULT_KEYS.has(key)) {
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

  if (typeof obj.stdout !== 'string') {
    throw new ValidationError('Task dispatch result stdout must be a string');
  }
  if (typeof obj.stderr !== 'string') {
    throw new ValidationError('Task dispatch result stderr must be a string');
  }
  if (typeof obj.exitCode !== 'number' || !Number.isInteger(obj.exitCode)) {
    throw new ValidationError('Task dispatch result exitCode must be an integer');
  }
  if (typeof obj.durationMs !== 'number' || obj.durationMs < 0) {
    throw new ValidationError('Task dispatch result durationMs must be a non-negative number');
  }

  return {
    status: 'completed',
    completedAt: obj.completedAt,
    stdout: obj.stdout,
    stderr: obj.stderr,
    exitCode: obj.exitCode,
    durationMs: obj.durationMs,
    ...(typeof obj.timedOut === 'boolean' ? { timedOut: obj.timedOut } : {}),
    ...(typeof obj.aborted === 'boolean' ? { aborted: obj.aborted } : {}),
  };
}

export function validateTaskResult(result: unknown): TaskDispatchResult {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new ValidationError('Task dispatch result must be a plain object');
  }
  const obj = result as Record<string, unknown>;
  if ('stdout' in obj || 'exitCode' in obj) {
    return validateScriptTaskResult(result);
  }
  return validateAgentPromptResult(result);
}

export function validateAgentPromptResult(result: unknown): AgentPromptDispatchResult {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new ValidationError('Task dispatch result must be a plain object');
  }

  const obj = result as Record<string, unknown>;
  if ('stdout' in obj || 'exitCode' in obj) {
    return validateScriptTaskResult(result) as unknown as AgentPromptDispatchResult;
  }

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
  payload: TaskPayload;
  result?: TaskDispatchResult | null;
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

export const ALLOWED_UPDATE_TASK_KEYS = new Set([
  'title',
  'description',
  'assignee',
  'priority',
  'prompt',
  'command',
  'script_command',
  'timeoutMs',
  'payload',
  'dueDate',
  'scheduleType',
  'cronExpression',
  'intervalSeconds',
  'timezone',
  'misfirePolicy',
  'overlapPolicy',
]);

export const FORBIDDEN_IMMUTABLE_UPDATE_KEYS = new Set([
  'id',
  'userId',
  'user_id',
  'createdAt',
  'updatedAt',
  'claimCount',
  'claimantId',
  'leaseExpiresAt',
  'leaseDurationMs',
  'maxRetries',
  'status',
  'currentRun',
  'result',
  'error',
  'errorCode',
  'idempotencyKey',
]);

export function validateUpdateTaskInput(input: unknown): UpdateTaskInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Task update input must be a plain object');
  }

  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);

  for (const key of keys) {
    if (FORBIDDEN_IMMUTABLE_UPDATE_KEYS.has(key)) {
      if (key === 'userId' || key === 'user_id') {
        throw new ValidationError('Task ownership is immutable');
      }
      if (key === 'status') {
        throw new ValidationError('Field "status" is immutable and cannot be directly updated');
      }
      if (key === 'updatedAt') {
        throw new ValidationError('Field "updatedAt" is managed automatically and cannot be updated');
      }
      throw new ValidationError(`Field "${key}" is immutable and cannot be updated`);
    }
    if (!ALLOWED_UPDATE_TASK_KEYS.has(key)) {
      throw new ValidationError(`Task update input contains unrecognized field "${key}"`);
    }
  }

  let hasEditableField = false;

  let title: string | undefined;
  if (obj.title !== undefined) {
    title = validateTaskTitle(obj.title);
    hasEditableField = true;
  }

  let description: string | null | undefined;
  if (obj.description !== undefined) {
    if (obj.description !== null && typeof obj.description !== 'string') {
      throw new ValidationError('Task description must be a string or null');
    }
    description = obj.description;
    hasEditableField = true;
  }

  let assignee: string | null | undefined;
  if (obj.assignee !== undefined) {
    if (obj.assignee !== null && typeof obj.assignee !== 'string') {
      throw new ValidationError('Task assignee must be a string or null');
    }
    assignee = obj.assignee;
    hasEditableField = true;
  }

  let priority: TaskPriority | undefined;
  if (obj.priority !== undefined) {
    priority = validateTaskPriority(obj.priority);
    hasEditableField = true;
  }

  let prompt: string | undefined;
  if (obj.prompt !== undefined) {
    if (typeof obj.prompt !== 'string' || obj.prompt.trim().length === 0) {
      throw new ValidationError('Task prompt must be a non-empty string');
    }
    if (Buffer.byteLength(obj.prompt, 'utf-8') > MAX_PROMPT_BYTES) {
      throw new ValidationError('Task prompt exceeds maximum allowed size');
    }
    prompt = obj.prompt;
    hasEditableField = true;
  }

  let command: string | undefined;
  if (obj.command !== undefined || obj.script_command !== undefined) {
    const rawCmd = (obj.command ?? obj.script_command) as unknown;
    if (typeof rawCmd !== 'string' || rawCmd.trim().length === 0) {
      throw new ValidationError('Task command must be a non-empty string');
    }
    if (Buffer.byteLength(rawCmd, 'utf-8') > MAX_PROMPT_BYTES) {
      throw new ValidationError('Task command exceeds maximum allowed size');
    }
    command = rawCmd;
    hasEditableField = true;
  }

  let timeoutMs: number | undefined;
  if (obj.timeoutMs !== undefined) {
    if (
      typeof obj.timeoutMs !== 'number' ||
      !Number.isSafeInteger(obj.timeoutMs) ||
      obj.timeoutMs <= 0 ||
      obj.timeoutMs > 1_800_000
    ) {
      throw new ValidationError('Invalid timeoutMs: must be a positive integer <= 1800000');
    }
    timeoutMs = obj.timeoutMs;
    hasEditableField = true;
  }

  if (obj.payload !== undefined && obj.payload !== null) {
    if (typeof obj.payload !== 'object' || Array.isArray(obj.payload)) {
      throw new ValidationError('Task payload must be a plain object');
    }
    const payloadObj = obj.payload as Record<string, unknown>;
    for (const k of Object.keys(payloadObj)) {
      if (
        k === 'sessionId' ||
        k === 'sessionPolicy' ||
        k === 'contextMode' ||
        k === 'spaceId' ||
        k === 'spaceFolder' ||
        k === 'delivery' ||
        k === 'silent'
      ) {
        throw new ValidationError('Task session and space bindings are immutable');
      }
      if (
        k !== 'prompt' &&
        k !== 'type' &&
        k !== 'command' &&
        k !== 'script_command' &&
        k !== 'timeoutMs'
      ) {
        throw new ValidationError(`Field "payload.${k}" is immutable and cannot be updated`);
      }
    }
    if (
      payloadObj.type !== undefined &&
      payloadObj.type !== 'agent_prompt' &&
      payloadObj.type !== 'script'
    ) {
      throw new ValidationError('Task payload type is immutable');
    }
    if (payloadObj.prompt !== undefined) {
      if (typeof payloadObj.prompt !== 'string' || payloadObj.prompt.trim().length === 0) {
        throw new ValidationError('Task payload prompt must be a non-empty string');
      }
      if (Buffer.byteLength(payloadObj.prompt, 'utf-8') > MAX_PROMPT_BYTES) {
        throw new ValidationError('Task payload prompt exceeds maximum allowed size');
      }
      if (prompt !== undefined && prompt !== payloadObj.prompt) {
        throw new ValidationError('Conflicting prompt values provided in root and payload');
      }
      prompt = payloadObj.prompt;
      hasEditableField = true;
    }
    if (payloadObj.command !== undefined) {
      if (typeof payloadObj.command !== 'string' || payloadObj.command.trim().length === 0) {
        throw new ValidationError('Task payload command must be a non-empty string');
      }
      if (Buffer.byteLength(payloadObj.command, 'utf-8') > MAX_PROMPT_BYTES) {
        throw new ValidationError('Task payload command exceeds maximum allowed size');
      }
      if (command !== undefined && command !== payloadObj.command) {
        throw new ValidationError('Conflicting command values provided in root and payload');
      }
      command = payloadObj.command;
      hasEditableField = true;
    }
    if (payloadObj.timeoutMs !== undefined) {
      if (
        typeof payloadObj.timeoutMs !== 'number' ||
        !Number.isSafeInteger(payloadObj.timeoutMs) ||
        payloadObj.timeoutMs <= 0 ||
        payloadObj.timeoutMs > 1_800_000
      ) {
        throw new ValidationError('Invalid timeoutMs: must be a positive integer <= 1800000');
      }
      if (timeoutMs !== undefined && timeoutMs !== payloadObj.timeoutMs) {
        throw new ValidationError('Conflicting timeoutMs values provided in root and payload');
      }
      timeoutMs = payloadObj.timeoutMs;
      hasEditableField = true;
    }
  }

  let dueDate: string | null | undefined;
  if (obj.dueDate !== undefined) {
    dueDate = obj.dueDate === null ? null : validateCanonicalDueDate(obj.dueDate);
    hasEditableField = true;
  }

  let scheduleType: TaskScheduleType | undefined;
  if (obj.scheduleType !== undefined) {
    scheduleType = validateScheduleType(obj.scheduleType);
    hasEditableField = true;
  }

  let cronExpression: string | null | undefined;
  if (obj.cronExpression !== undefined) {
    cronExpression = obj.cronExpression === null ? null : validateCronExpression(obj.cronExpression);
    hasEditableField = true;
  }

  let intervalSeconds: number | null | undefined;
  if (obj.intervalSeconds !== undefined) {
    intervalSeconds = obj.intervalSeconds === null ? null : validateIntervalSeconds(obj.intervalSeconds);
    hasEditableField = true;
  }

  let timezone: string | undefined;
  if (obj.timezone !== undefined) {
    timezone = validateTimezone(obj.timezone);
    hasEditableField = true;
  }

  let misfirePolicy: TaskScheduleMisfirePolicy | undefined;
  if (obj.misfirePolicy !== undefined) {
    misfirePolicy = validateMisfirePolicy(obj.misfirePolicy);
    hasEditableField = true;
  }

  let overlapPolicy: TaskScheduleOverlapPolicy | undefined;
  if (obj.overlapPolicy !== undefined) {
    overlapPolicy = validateOverlapPolicy(obj.overlapPolicy);
    hasEditableField = true;
  }

  if (!hasEditableField) {
    throw new ValidationError('At least one editable field must be provided for task update');
  }

  const returnPayload: Record<string, unknown> = {};
  if (prompt !== undefined) returnPayload.prompt = prompt;
  if (command !== undefined) returnPayload.command = command;
  if (timeoutMs !== undefined) returnPayload.timeoutMs = timeoutMs;
  const hasPayload = Object.keys(returnPayload).length > 0;

  return {
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(assignee !== undefined ? { assignee } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(hasPayload ? { payload: returnPayload as any } : {}),
    ...(dueDate !== undefined ? { dueDate } : {}),
    ...(scheduleType !== undefined ? { scheduleType } : {}),
    ...(cronExpression !== undefined ? { cronExpression } : {}),
    ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
    ...(timezone !== undefined ? { timezone } : {}),
    ...(misfirePolicy !== undefined ? { misfirePolicy } : {}),
    ...(overlapPolicy !== undefined ? { overlapPolicy } : {}),
  };
}

export interface CreateTaskInput {
  id?: string;
  idempotencyKey?: string;
  title: string;
  description?: string;
  assignee?: string;
  priority?: TaskPriority;
  payload: TaskPayload;
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

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  assignee?: string | null;
  priority?: TaskPriority;
  prompt?: string;
  command?: string;
  script_command?: string;
  timeoutMs?: number;
  payload?: {
    prompt?: string;
    command?: string;
    timeoutMs?: number;
  };
  dueDate?: string | null;
  scheduleType?: TaskScheduleType;
  cronExpression?: string | null;
  intervalSeconds?: number | null;
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
  result: TaskDispatchResult;
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
