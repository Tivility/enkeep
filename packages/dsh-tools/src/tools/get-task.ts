import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type {
  ToolDefinition,
  PlatformClientService,
  GetTaskResult,
  TaskSummary,
  TaskStatus,
  TaskPriority,
  ToolExecutionContext,
} from '../types.js';
import {
  createPlatformToolUnavailableError,
  createInvalidPlatformResponseError,
} from '../errors.js';

export const CANONICAL_TASK_ID_REGEX =
  /^(?:task_[0-9a-f]{32}|task_hpc_[0-9a-f]{24})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isGetTaskResult(value: unknown): value is GetTaskResult {
  return (
    isRecord(value) &&
    value.success === true &&
    isRecord(value.task) &&
    typeof value.task.taskId === 'string' &&
    typeof value.task.title === 'string' &&
    typeof value.task.status === 'string'
  );
}

export function createGetTaskTool(
  getClient: () => PlatformClientService | undefined
): ToolDefinition {
  return {
    name: 'get_task',
    description:
      'Get details of an existing task on the Enkeep platform by taskId.',
    parameters: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description:
            'Canonical platform task ID to retrieve (e.g. task_<32hex> or task_hpc_<24hex>).',
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
          task: {
            type: 'object',
            properties: {
              taskId: { type: 'string' },
              title: { type: 'string' },
              status: { type: 'string' },
              priority: { type: 'string' },
              nextRunAt: { type: 'string' },
              dueDate: { type: 'string' },
              createdAt: { type: 'string' },
            },
            required: ['taskId', 'title', 'status'],
          },
        },
        required: ['success', 'task'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: JsonValue): ContentBlock[] => {
        if (isGetTaskResult(value)) {
          const t = value.task;
          const nextInfo = t.nextRunAt ? `, next: ${t.nextRunAt}` : '';
          return [
            {
              type: 'text',
              text: `Task [${t.taskId}]: "${t.title}" (Status: ${t.status}${nextInfo})`,
            },
          ];
        }
        return [{ type: 'text', text: 'Task retrieved' }];
      },
    },
    async execute(
      rawArgs: unknown,
      _context?: ToolExecutionContext
    ): Promise<GetTaskResult> {
      if (!isRecord(rawArgs)) {
        throw new TypeError('get_task requires an arguments object');
      }

      for (const key of Object.keys(rawArgs)) {
        if (key !== 'taskId') {
          throw new TypeError(`Unrecognized field "${key}" in get_task arguments`);
        }
      }

      const rawTaskId = rawArgs.taskId;
      if (
        typeof rawTaskId !== 'string' ||
        rawTaskId.length === 0 ||
        rawTaskId !== rawTaskId.trim() ||
        !CANONICAL_TASK_ID_REGEX.test(rawTaskId)
      ) {
        throw createPlatformToolUnavailableError(
          'Authoritative canonical taskId is required for get_task and cannot be fabricated'
        );
      }
      const taskId = rawTaskId;

      const client = getClient();
      if (!client) {
        throw createPlatformToolUnavailableError(
          'Enkeep Platform Client service is not available (ctx.platformClient is undefined)'
        );
      }

      if (client.getTask) {
        return client.getTask(taskId);
      }

      if (!client.request) {
        throw createPlatformToolUnavailableError(
          'Enkeep Platform Client service is not available (ctx.platformClient.request is missing)'
        );
      }

      const res = await client.request<{
        success?: boolean;
        data?: any;
        error?: {
          code?: string;
          message?: string;
        };
      }>(`/api/manage/tasks/${encodeURIComponent(taskId)}`, {
        method: 'GET',
      });

      if (!res || typeof res !== 'object' || typeof res.status !== 'number') {
        throw createInvalidPlatformResponseError(
          'Platform request returned an invalid HTTP response structure'
        );
      }

      if (res.status < 200 || res.status >= 300) {
        throw createInvalidPlatformResponseError(res.data?.error?.message || 'Platform request failed');
      }

      const rawData = res.data;
      if (!isRecord(rawData)) {
        throw createInvalidPlatformResponseError('Platform response envelope is invalid');
      }

      if (rawData.success !== true) {
        throw createInvalidPlatformResponseError('Platform request returned unsuccessful error envelope');
      }

      const data = isRecord(rawData.data) ? rawData.data : undefined;
      if (!data) {
        throw createInvalidPlatformResponseError('Platform response data payload is invalid');
      }

      const taskObj = isRecord(data.task) ? data.task : data;
      const resTaskId = (typeof taskObj.id === 'string' ? taskObj.id : undefined) ??
        (typeof taskObj.taskId === 'string' ? taskObj.taskId : undefined);
      if (!resTaskId || resTaskId !== taskId) {
        throw createInvalidPlatformResponseError(
          'Platform response taskId does not match authoritative task ID'
        );
      }

      const resTitle = typeof taskObj.title === 'string' ? taskObj.title : '';
      const resStatus = typeof taskObj.status === 'string' ? (taskObj.status as TaskStatus) : 'pending';
      const resPriority = typeof taskObj.priority === 'string' ? (taskObj.priority as TaskPriority) : undefined;
      const nextRunAt = typeof taskObj.nextRunAt === 'string' ? taskObj.nextRunAt : ((taskObj.schedule as any)?.nextRunAt ?? null);
      const dueDate = typeof taskObj.dueDate === 'string' ? taskObj.dueDate : (typeof taskObj.due_date === 'string' ? taskObj.due_date : null);
      const createdAt = typeof taskObj.createdAt === 'string' ? taskObj.createdAt : (typeof taskObj.created_at === 'string' ? taskObj.created_at : undefined);

      const taskSummary: TaskSummary = {
        taskId: resTaskId,
        title: resTitle,
        status: resStatus,
        priority: resPriority,
        nextRunAt: nextRunAt ?? null,
        dueDate: dueDate ?? null,
        createdAt,
      };

      return {
        success: true,
        task: taskSummary,
      };
    },
  };
}
