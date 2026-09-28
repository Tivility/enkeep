import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type {
  ToolDefinition,
  PlatformClientService,
  TaskPriority,
  TaskStatus,
  TaskScheduleType,
  TaskScheduleMisfirePolicy,
  TaskScheduleOverlapPolicy,
  UpdateTaskPayload,
  UpdateTaskResult,
  ToolExecutionContext,
  ToolResult,
} from '../types.js';
import {
  createPlatformToolUnavailableError,
  createInvalidPlatformResponseError,
} from '../errors.js';

export const CANONICAL_TASK_ID_REGEX =
  /^(?:task_[0-9a-f]{32}|task_hpc_[0-9a-f]{24})$/;

export const VALID_TASK_PRIORITIES = new Set<TaskPriority>([
  'low',
  'medium',
  'high',
  'urgent',
]);

export const VALID_SCHEDULE_TYPES = new Set<TaskScheduleType>([
  'once',
  'cron',
  'interval',
]);

export const VALID_MISFIRE_POLICIES = new Set<TaskScheduleMisfirePolicy>([
  'coalesce',
  'skip',
]);

export const VALID_OVERLAP_POLICIES = new Set<TaskScheduleOverlapPolicy>([
  'skip',
]);

export const VALID_TASK_STATUSES = new Set<TaskStatus>([
  'pending',
  'claimed',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export const FORBIDDEN_IMMUTABLE_KEYS = Object.freeze([
  'userId',
  'user_id',
  'owner',
  'sessionId',
  'spaceId',
  'status',
  'createdAt',
  'updatedAt',
  'claimCount',
  'claimantId',
  'leaseExpiresAt',
  'leaseDurationMs',
  'maxRetries',
  'currentRun',
  'result',
  'error',
  'errorCode',
  'idempotencyKey',
  'payload',
] as const);

export const ALLOWED_UPDATE_KEYS = Object.freeze([
  'taskId',
  'title',
  'prompt',
  'priority',
  'description',
  'assignee',
  'scheduleType',
  'cronExpression',
  'intervalSeconds',
  'dueDate',
  'timezone',
  'misfirePolicy',
  'overlapPolicy',
] as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isUpdateTaskResult(value: unknown): value is UpdateTaskResult {
  return (
    isRecord(value) &&
    value.success === true &&
    typeof value.taskId === 'string' &&
    typeof value.status === 'string' &&
    value.updated === true
  );
}

export function createUpdateTaskTool(
  getClient: () => PlatformClientService | undefined
): ToolDefinition {
  return {
    name: 'update_task',
    description:
      'Update an existing asynchronous task or schedule on the Enkeep platform adhering to canonical management APIs.',
    parameters: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description:
            'Canonical platform task ID to update (e.g. task_<32hex> or task_hpc_<24hex>).',
        },
        title: {
          type: 'string',
          description:
            'Optional updated task title (up to 256 characters, trimmed).',
        },
        prompt: {
          type: 'string',
          description:
            'Optional updated autonomous agent prompt instructions (up to 64 KiB).',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'urgent'],
          description: 'Optional updated priority level for task scheduling.',
        },
        description: {
          type: 'string',
          description: 'Optional updated descriptive text for the task.',
        },
        assignee: {
          type: 'string',
          description: 'Optional updated assignee identifier.',
        },
        scheduleType: {
          type: 'string',
          enum: ['once', 'cron', 'interval'],
          description: 'Optional updated schedule type.',
        },
        cronExpression: {
          type: 'string',
          description:
            'Optional updated 5-field cron expression in UTC (minimum 60s recurrence interval).',
        },
        intervalSeconds: {
          type: 'integer',
          description:
            'Optional updated recurrence interval in seconds (60 to 31,536,000).',
        },
        dueDate: {
          type: 'string',
          description:
            'Optional updated exact canonical ISO 8601 UTC due date string (e.g. 2026-12-31T23:59:59.000Z).',
        },
        timezone: {
          type: 'string',
          description:
            'Optional updated IANA timezone string (e.g. UTC, Asia/Shanghai).',
        },
        misfirePolicy: {
          type: 'string',
          enum: ['coalesce', 'skip'],
          description:
            'Optional updated misfire policy for missed schedule triggers.',
        },
        overlapPolicy: {
          type: 'string',
          enum: ['skip'],
          description:
            'Optional updated policy for handling overlapping schedule executions.',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          taskId: { type: 'string' },
          status: {
            type: 'string',
            enum: [
              'pending',
              'claimed',
              'running',
              'completed',
              'failed',
              'cancelled',
            ],
          },
          updated: { type: 'boolean' },
          title: { type: 'string' },
          scheduleType: { type: 'string' },
          nextRunAt: {
            type: 'string',
            description: 'Next scheduled run timestamp or null',
          },
        },
        required: ['success', 'taskId', 'status', 'updated'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: JsonValue): ContentBlock[] => {
        if (isUpdateTaskResult(value)) {
          const details = [
            `Status: ${value.status}`,
            value.title ? `Title: "${value.title}"` : null,
            value.scheduleType ? `Schedule: ${value.scheduleType}` : null,
            value.nextRunAt ? `NextRun: ${value.nextRunAt}` : null,
          ]
            .filter(Boolean)
            .join(', ');
          return [
            {
              type: 'text',
              text: `Task updated: ${value.taskId} (${details})`,
            },
          ];
        }
        return [{ type: 'text', text: 'Task updated' }];
      },
    },
    async execute(
      rawArgs: unknown,
      _context?: ToolExecutionContext
    ): Promise<UpdateTaskResult> {
      if (!isRecord(rawArgs)) {
        throw new TypeError('update_task arguments must be a plain object');
      }

      // Intercept forbidden immutable keys
      for (const key of Object.keys(rawArgs)) {
        if (key === 'userId' || key === 'user_id' || key === 'owner') {
          throw new TypeError('Task ownership is immutable');
        }
        if (key === 'sessionId' || key === 'spaceId') {
          throw new TypeError('Task session and space bindings are immutable');
        }
        if ((FORBIDDEN_IMMUTABLE_KEYS as readonly string[]).includes(key)) {
          throw new TypeError(
            `Field "${key}" is immutable and cannot be updated`
          );
        }
        if (!(ALLOWED_UPDATE_KEYS as readonly string[]).includes(key)) {
          throw new TypeError(
            `Unrecognized field "${key}" in update_task arguments`
          );
        }
      }

      // Authoritative taskId validation
      const rawTaskId = rawArgs.taskId;
      if (
        typeof rawTaskId !== 'string' ||
        rawTaskId.length === 0 ||
        rawTaskId !== rawTaskId.trim() ||
        !CANONICAL_TASK_ID_REGEX.test(rawTaskId)
      ) {
        throw createPlatformToolUnavailableError(
          'Authoritative canonical taskId is required for task update and cannot be fabricated'
        );
      }
      const taskId = rawTaskId;

      // Title validation
      let title: string | undefined;
      if (rawArgs.title !== undefined) {
        if (
          typeof rawArgs.title !== 'string' ||
          rawArgs.title.trim().length === 0 ||
          rawArgs.title !== rawArgs.title.trim()
        ) {
          throw new TypeError(
            'Task title must be a non-empty, exact trimmed string'
          );
        }
        if (rawArgs.title.length > 256) {
          throw new TypeError(
            'Task title exceeds maximum length of 256 characters'
          );
        }
        title = rawArgs.title;
      }

      // Prompt validation (preserves bytes, <= 64 KiB)
      let prompt: string | undefined;
      if (rawArgs.prompt !== undefined) {
        if (typeof rawArgs.prompt !== 'string') {
          throw new TypeError('Task prompt must be a string');
        }
        if (rawArgs.prompt.trim().length === 0) {
          throw new TypeError('Task prompt must be a non-empty string');
        }
        if (Buffer.byteLength(rawArgs.prompt, 'utf-8') > 65536) {
          throw new TypeError(
            'Task prompt size exceeds maximum limit of 64 KiB'
          );
        }
        prompt = rawArgs.prompt;
      }

      // Priority validation
      let priority: TaskPriority | undefined;
      if (rawArgs.priority !== undefined && rawArgs.priority !== null) {
        if (
          typeof rawArgs.priority !== 'string' ||
          !VALID_TASK_PRIORITIES.has(rawArgs.priority as TaskPriority)
        ) {
          throw new TypeError(
            'Invalid task priority. Allowed: low, medium, high, urgent'
          );
        }
        priority = rawArgs.priority as TaskPriority;
      }

      // Description validation
      let description: string | null | undefined;
      if (rawArgs.description !== undefined) {
        if (
          rawArgs.description !== null &&
          typeof rawArgs.description !== 'string'
        ) {
          throw new TypeError('Task description must be a string or null');
        }
        description = rawArgs.description;
      }

      // Assignee validation
      let assignee: string | null | undefined;
      if (rawArgs.assignee !== undefined) {
        if (rawArgs.assignee !== null && typeof rawArgs.assignee !== 'string') {
          throw new TypeError('Task assignee must be a string or null');
        }
        assignee = rawArgs.assignee;
      }

      // Schedule type validation
      let scheduleType: TaskScheduleType | undefined;
      if (rawArgs.scheduleType !== undefined) {
        if (
          typeof rawArgs.scheduleType !== 'string' ||
          !VALID_SCHEDULE_TYPES.has(rawArgs.scheduleType as TaskScheduleType)
        ) {
          throw new TypeError(
            'Invalid schedule type. Allowed: once, cron, interval'
          );
        }
        scheduleType = rawArgs.scheduleType as TaskScheduleType;
      }

      // Cron expression validation
      let cronExpression: string | null | undefined;
      if (rawArgs.cronExpression !== undefined) {
        if (rawArgs.cronExpression === null) {
          cronExpression = null;
        } else {
          if (
            typeof rawArgs.cronExpression !== 'string' ||
            rawArgs.cronExpression.trim().length === 0
          ) {
            throw new TypeError(
              'Cron expression must be a non-empty string or null'
            );
          }
          const trimmed = rawArgs.cronExpression.trim();
          const fields = trimmed.split(/\s+/);
          if (fields.length !== 5) {
            throw new TypeError(
              `Cron expression must have exactly 5 fields (minute, hour, day-of-month, month, day-of-week). Found ${fields.length} fields.`
            );
          }
          cronExpression = trimmed;
        }
      }

      // Interval seconds validation
      let intervalSeconds: number | null | undefined;
      if (rawArgs.intervalSeconds !== undefined) {
        if (rawArgs.intervalSeconds === null) {
          intervalSeconds = null;
        } else {
          if (
            typeof rawArgs.intervalSeconds !== 'number' ||
            !Number.isSafeInteger(rawArgs.intervalSeconds)
          ) {
            throw new TypeError(
              'Interval seconds must be a safe integer or null'
            );
          }
          if (
            rawArgs.intervalSeconds < 60 ||
            rawArgs.intervalSeconds > 31536000
          ) {
            throw new TypeError(
              'Interval seconds must be between 60 and 31536000 (1 year)'
            );
          }
          intervalSeconds = rawArgs.intervalSeconds;
        }
      }

      // Due date validation (exact canonical ISO 8601 UTC string)
      let dueDate: string | null | undefined;
      if (rawArgs.dueDate !== undefined) {
        if (rawArgs.dueDate === null) {
          dueDate = null;
        } else {
          if (typeof rawArgs.dueDate !== 'string') {
            throw new TypeError(
              'Task dueDate must be an exact canonical ISO 8601 UTC string or null'
            );
          }
          const parsed = new Date(rawArgs.dueDate);
          if (
            Number.isNaN(parsed.getTime()) ||
            parsed.toISOString() !== rawArgs.dueDate
          ) {
            throw new TypeError(
              'Task dueDate must be an exact canonical ISO 8601 UTC string'
            );
          }
          dueDate = rawArgs.dueDate;
        }
      }

      // Timezone validation
      let timezone: string | undefined;
      if (rawArgs.timezone !== undefined) {
        if (
          typeof rawArgs.timezone !== 'string' ||
          rawArgs.timezone.trim().length === 0
        ) {
          throw new TypeError('Timezone must be a non-empty string');
        }
        try {
          Intl.DateTimeFormat(undefined, { timeZone: rawArgs.timezone });
        } catch {
          throw new TypeError(`Invalid IANA timezone "${rawArgs.timezone}"`);
        }
        timezone = rawArgs.timezone;
      }

      // Misfire policy validation
      let misfirePolicy: TaskScheduleMisfirePolicy | undefined;
      if (rawArgs.misfirePolicy !== undefined) {
        if (
          typeof rawArgs.misfirePolicy !== 'string' ||
          !VALID_MISFIRE_POLICIES.has(
            rawArgs.misfirePolicy as TaskScheduleMisfirePolicy
          )
        ) {
          throw new TypeError(
            'Invalid misfire policy. Allowed: coalesce, skip'
          );
        }
        misfirePolicy = rawArgs.misfirePolicy as TaskScheduleMisfirePolicy;
      }

      // Overlap policy validation
      let overlapPolicy: TaskScheduleOverlapPolicy | undefined;
      if (rawArgs.overlapPolicy !== undefined) {
        if (
          typeof rawArgs.overlapPolicy !== 'string' ||
          !VALID_OVERLAP_POLICIES.has(
            rawArgs.overlapPolicy as TaskScheduleOverlapPolicy
          )
        ) {
          throw new TypeError('Invalid overlap policy. Allowed: skip');
        }
        overlapPolicy = rawArgs.overlapPolicy as TaskScheduleOverlapPolicy;
      }

      // At least one editable field must be provided
      const hasEditableField = [
        title,
        prompt,
        priority,
        description,
        assignee,
        scheduleType,
        cronExpression,
        intervalSeconds,
        dueDate,
        timezone,
        misfirePolicy,
        overlapPolicy,
      ].some((v) => v !== undefined);

      if (!hasEditableField) {
        throw new TypeError(
          'At least one editable field must be provided for task update'
        );
      }

      // Strict payload omitting undefined keys
      const payload: UpdateTaskPayload = {
        ...(title !== undefined ? { title } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(assignee !== undefined ? { assignee } : {}),
        ...(scheduleType !== undefined ? { scheduleType } : {}),
        ...(cronExpression !== undefined ? { cronExpression } : {}),
        ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
        ...(dueDate !== undefined ? { dueDate } : {}),
        ...(timezone !== undefined ? { timezone } : {}),
        ...(misfirePolicy !== undefined ? { misfirePolicy } : {}),
        ...(overlapPolicy !== undefined ? { overlapPolicy } : {}),
      };

      // Platform client verification
      const client = getClient();
      if (!client || (!client.request && !client.updateTask)) {
        throw createPlatformToolUnavailableError(
          'Enkeep Platform Client service is not available (ctx.platformClient is missing)'
        );
      }

      // Optional direct handler support
      if (typeof client.updateTask === 'function') {
        const directRes = await client.updateTask(taskId, payload);
        if (!isUpdateTaskResult(directRes)) {
          throw createInvalidPlatformResponseError(
            'Platform client updateTask returned an invalid response structure'
          );
        }
        return directRes;
      }

      if (!client.request) {
        throw createPlatformToolUnavailableError(
          'Enkeep Platform Client service is not available (ctx.platformClient.request is missing)'
        );
      }

      // Canonical Management API: PUT /api/manage/tasks/:id
      const res = await client.request<{
        success?: boolean;
        data?: {
          id?: string;
          status?: string;
          updated?: boolean;
          task?: {
            id?: string;
            title?: string;
            status?: string;
            scheduleType?: string;
            nextRunAt?: string | null;
            [key: string]: unknown;
          };
          [key: string]: unknown;
        };
        error?: {
          code?: string;
          message?: string;
        };
      }>(`/api/manage/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PUT',
        body: payload,
      });

      if (!res || typeof res !== 'object' || typeof res.status !== 'number') {
        throw createInvalidPlatformResponseError(
          'Platform request returned an invalid HTTP response structure'
        );
      }

      if (res.status < 200 || res.status >= 300) {
        throw createInvalidPlatformResponseError('Platform request failed');
      }

      const rawData = res.data;
      if (!isRecord(rawData)) {
        throw createInvalidPlatformResponseError(
          'Platform response envelope is invalid'
        );
      }

      if (rawData.success !== true) {
        throw createInvalidPlatformResponseError(
          'Platform request returned unsuccessful error envelope'
        );
      }

      const data = rawData.data;
      if (!isRecord(data)) {
        throw createInvalidPlatformResponseError(
          'Platform response data payload is invalid'
        );
      }

      if (data.updated !== true) {
        throw createInvalidPlatformResponseError(
          'Platform response updated indicator must be true'
        );
      }

      const taskObj = isRecord(data.task) ? data.task : undefined;
      const resTaskId =
        (typeof data.id === 'string' ? data.id : undefined) ??
        (typeof taskObj?.id === 'string' ? taskObj.id : undefined);
      if (!resTaskId || resTaskId !== taskId) {
        throw createInvalidPlatformResponseError(
          'Platform response taskId does not match authoritative task ID'
        );
      }

      const resStatus =
        (typeof taskObj?.status === 'string' ? taskObj.status : undefined) ??
        (typeof data.status === 'string' ? data.status : undefined);
      if (!resStatus || !VALID_TASK_STATUSES.has(resStatus as TaskStatus)) {
        throw createInvalidPlatformResponseError(
          'Platform response contains invalid or missing task status'
        );
      }

      const finalTitle =
        typeof taskObj?.title === 'string'
          ? taskObj.title
          : typeof payload.title === 'string'
            ? payload.title
            : undefined;

      const finalScheduleType =
        typeof taskObj?.scheduleType === 'string'
          ? taskObj.scheduleType
          : typeof payload.scheduleType === 'string'
            ? payload.scheduleType
            : undefined;

      const finalNextRunAt =
        taskObj && 'nextRunAt' in taskObj
          ? ((taskObj.nextRunAt as string | null) ?? null)
          : undefined;

      const result: UpdateTaskResult = {
        success: true,
        taskId,
        status: resStatus as TaskStatus,
        updated: true,
        ...(finalTitle !== undefined ? { title: finalTitle } : {}),
        ...(finalScheduleType !== undefined
          ? { scheduleType: finalScheduleType as TaskScheduleType }
          : {}),
        ...(finalNextRunAt !== undefined ? { nextRunAt: finalNextRunAt } : {}),
      };

      return result;
    },
    presentCall: (rawArgs: unknown) => ({
      card: 'generic',
      title:
        isRecord(rawArgs) && typeof rawArgs.taskId === 'string'
          ? `Update task: ${rawArgs.taskId}`
          : 'Update task',
    }),
    presentResult: (_args: unknown, result: ToolResult) => ({
      card: 'generic',
      title: !result.isError ? 'Updated task' : 'Failed to update task',
    }),
  };
}
