import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type {
  ToolDefinition,
  PlatformClientService,
  TaskPayload,
  TaskPriority,
  TaskStatus,
  CreateTaskResult,
  ToolExecutionContext,
  ToolResult,
} from '../types.js';
import {
  createPlatformToolUnavailableError,
  createInvalidPlatformResponseError,
} from '../errors.js';

export const CANONICAL_UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const CANONICAL_SESSION_ID_REGEX =
  /^(?:ses_[0-9a-f]{32}|import-[0-9a-f]{32})$/;

export const CANONICAL_TASK_ID_REGEX = /^task_[0-9a-f]{32}$/;

export const VALID_TASK_STATUSES = new Set<TaskStatus>([
  'pending',
  'claimed',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export interface CreateTaskArgs {
  title: string;
  prompt: string;
  sessionId: string;
  idempotencyKey: string;
  priority?: TaskPriority;
  dueDate?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isCreateTaskResult(value: unknown): value is CreateTaskResult {
  return (
    isRecord(value) &&
    value.success === true &&
    typeof value.taskId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.status === 'string' &&
    typeof value.isIdempotentHit === 'boolean'
  );
}

function hasExactKeys(obj: unknown, expectedKeys: string[]): obj is Record<string, unknown> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (keys.length !== expectedKeys.length) return false;
  const set = new Set(expectedKeys);
  return keys.every((k) => set.has(k));
}

export function createCreateTaskTool(
  getClient: () => PlatformClientService | undefined
): ToolDefinition {
  return {
    name: 'create_task',
    description:
      'Create an asynchronous task or work item on the Enkeep platform adhering to canonical management APIs.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short descriptive title of the task (up to 256 characters, exact trimmed).',
        },
        prompt: {
          type: 'string',
          description: 'Autonomous agent prompt instructions to execute for this task (preserves exact payload bytes, up to 64 KiB).',
        },
        sessionId: {
          type: 'string',
          description: 'Canonical platform session ID (e.g. ses_<32hex> or import-<32hex>).',
        },
        idempotencyKey: {
          type: 'string',
          description: 'Canonical lowercase UUID-v4 idempotency key provided by authoritative caller.',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'urgent'],
          description: 'Optional priority level for task scheduling.',
        },
        dueDate: {
          type: 'string',
          description: 'Optional exact ISO 8601 UTC due date string (e.g. 2026-09-01T00:00:00.000Z).',
        },
      },
      required: ['title', 'prompt', 'sessionId', 'idempotencyKey'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          taskId: { type: 'string' },
          title: { type: 'string' },
          status: {
            type: 'string',
            enum: ['pending', 'claimed', 'running', 'completed', 'failed', 'cancelled'],
          },
          isIdempotentHit: { type: 'boolean' },
        },
        required: ['success', 'taskId', 'title', 'status', 'isIdempotentHit'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: JsonValue): ContentBlock[] => {
        if (isCreateTaskResult(value)) {
          return [
            {
              type: 'text',
              text: `Task created: "${value.title}" (Status: ${value.status}, IdempotentHit: ${value.isIdempotentHit})`,
            },
          ];
        }
        return [{ type: 'text', text: 'Task created' }];
      },
    },
    async execute(
      rawArgs: unknown,
      _context?: ToolExecutionContext
    ): Promise<CreateTaskResult> {
      if (!isRecord(rawArgs) || typeof rawArgs.title !== 'string' || rawArgs.title.length === 0 || rawArgs.title !== rawArgs.title.trim()) {
        throw new TypeError('create_task requires a non-empty, exact trimmed title string');
      }
      const title = rawArgs.title;
      if (title.length > 256) {
        throw new TypeError('Task title exceeds maximum length of 256 characters');
      }

      // Validate prompt: typeof string, trim nonempty but PRESERVE exact bytes including leading/trailing whitespace, <= 64 KiB
      if (typeof rawArgs.prompt !== 'string') {
        throw new TypeError('create_task requires a prompt string');
      }
      if (rawArgs.prompt.trim().length === 0) {
        throw new TypeError('create_task requires a non-empty prompt string');
      }
      const prompt = rawArgs.prompt;
      const promptBytes = Buffer.byteLength(prompt, 'utf-8');
      if (promptBytes > 65536) {
        throw new TypeError('Task prompt size exceeds maximum limit of 64 KiB');
      }

      // Authoritative sessionId: exact match against canonical identifier format (no alias/context fallback)
      const rawSessionId = rawArgs.sessionId;
      if (
        typeof rawSessionId !== 'string' ||
        rawSessionId.length === 0 ||
        rawSessionId !== rawSessionId.trim() ||
        !CANONICAL_SESSION_ID_REGEX.test(rawSessionId)
      ) {
        throw createPlatformToolUnavailableError(
          'Authoritative canonical sessionId is required for task creation and cannot be fabricated'
        );
      }
      const sessionId = rawSessionId;

      // Authoritative idempotencyKey: exact canonical lowercase UUID-v4 (no alias/context fallback)
      const rawIdempotencyKey = rawArgs.idempotencyKey;
      if (
        typeof rawIdempotencyKey !== 'string' ||
        rawIdempotencyKey.length === 0 ||
        rawIdempotencyKey !== rawIdempotencyKey.trim() ||
        !CANONICAL_UUID_V4_REGEX.test(rawIdempotencyKey)
      ) {
        throw createPlatformToolUnavailableError(
          'Authoritative canonical lowercase UUID-v4 idempotencyKey is required for task creation and cannot be fabricated'
        );
      }
      const idempotencyKey = rawIdempotencyKey;

      // Priority validation
      let priority: TaskPriority | undefined;
      if (rawArgs.priority !== undefined && rawArgs.priority !== null) {
        if (
          typeof rawArgs.priority !== 'string' ||
          !['low', 'medium', 'high', 'urgent'].includes(rawArgs.priority)
        ) {
          throw new TypeError(
            'Invalid task priority. Allowed: low, medium, high, urgent'
          );
        }
        priority = rawArgs.priority as TaskPriority;
      }

      // Due date validation: exact canonical ISO 8601 UTC string (parsed.toISOString() === raw)
      let dueDate: string | undefined;
      if (rawArgs.dueDate !== undefined && rawArgs.dueDate !== null) {
        if (typeof rawArgs.dueDate !== 'string') {
          throw new TypeError('Task dueDate must be a string');
        }
        const parsed = new Date(rawArgs.dueDate);
        if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== rawArgs.dueDate) {
          throw new TypeError(
            'Task dueDate must be an exact canonical ISO 8601 UTC string'
          );
        }
        dueDate = rawArgs.dueDate;
      }

      // Zero-network / missing platform client check
      const client = getClient();
      if (!client || !client.request) {
        throw createPlatformToolUnavailableError(
          'Enkeep Platform Client service is not available (ctx.platformClient is missing)'
        );
      }

      // Strict task payload matching PlatformServer POST /api/manage/tasks body
      const payload: TaskPayload = {
        title,
        prompt,
        sessionId,
        ...(priority !== undefined ? { priority } : {}),
        ...(dueDate !== undefined ? { dueDate } : {}),
      };

      // Canonical Management API: POST /api/manage/tasks with Idempotency-Key header
      const res = await client.request<{
        success?: boolean;
        data?: {
          task?: {
            id?: string;
            title?: string;
            status?: string;
            priority?: string;
            dueDate?: string | null;
            createdAt?: string;
          };
          isIdempotentHit?: boolean;
        };
      }>('/api/manage/tasks', {
        method: 'POST',
        headers: {
          'Idempotency-Key': idempotencyKey,
        },
        body: payload,
      });

      if (!res || typeof res !== 'object' || typeof res.status !== 'number') {
        throw createInvalidPlatformResponseError(
          'Platform request returned an invalid HTTP response structure'
        );
      }

      if (res.status < 200 || res.status >= 300) {
        throw createInvalidPlatformResponseError(
          'Platform request failed'
        );
      }

      const rawData = res.data;
      if (!hasExactKeys(rawData, ['data', 'success'])) {
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
      if (!hasExactKeys(data, ['isIdempotentHit', 'task'])) {
        throw createInvalidPlatformResponseError(
          'Platform response data payload is invalid'
        );
      }

      if (typeof data.isIdempotentHit !== 'boolean') {
        throw createInvalidPlatformResponseError(
          'Platform request response isIdempotentHit must be a strict boolean'
        );
      }

      const task = data.task;
      if (!hasExactKeys(task, ['createdAt', 'dueDate', 'id', 'priority', 'status', 'title'])) {
        throw createInvalidPlatformResponseError(
          'Platform response task payload is invalid'
        );
      }

      if (typeof task.id !== 'string' || !CANONICAL_TASK_ID_REGEX.test(task.id)) {
        throw createInvalidPlatformResponseError(
          'Platform request response is missing authoritative canonical taskId'
        );
      }

      if (typeof task.title !== 'string' || task.title !== title) {
        throw createInvalidPlatformResponseError(
          'Platform request response title does not match authoritative task title'
        );
      }

      if (task.status !== 'pending') {
        throw createInvalidPlatformResponseError(
          'Platform request response contains invalid status'
        );
      }

      const expectedPriority = priority ?? 'medium';
      if (task.priority !== expectedPriority) {
        throw createInvalidPlatformResponseError(
          'Platform request response priority does not match authoritative task priority'
        );
      }

      const expectedDueDate = dueDate ?? null;
      if (task.dueDate !== expectedDueDate) {
        throw createInvalidPlatformResponseError(
          'Platform request response dueDate does not match authoritative task dueDate'
        );
      }

      if (
        typeof task.createdAt !== 'string' ||
        task.createdAt.length === 0 ||
        Number.isNaN(new Date(task.createdAt).getTime()) ||
        new Date(task.createdAt).toISOString() !== task.createdAt
      ) {
        throw createInvalidPlatformResponseError(
          'Platform request response createdAt must be a valid exact ISO 8601 UTC string'
        );
      }

      return {
        success: true,
        taskId: task.id,
        title: task.title,
        status: task.status,
        isIdempotentHit: data.isIdempotentHit,
      };
    },
    presentCall: (rawArgs: unknown) => ({
      card: 'generic',
      title: isRecord(rawArgs) && typeof rawArgs.title === 'string'
        ? `Create task: ${rawArgs.title}`
        : 'Create task',
    }),
    presentResult: (_args: unknown, result: ToolResult) => ({
      card: 'generic',
      title: !result.isError ? 'Created task' : 'Failed to create task',
    }),
  };
}
