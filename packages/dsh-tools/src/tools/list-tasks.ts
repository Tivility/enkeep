import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type {
  ToolDefinition,
  PlatformClientService,
  ListTasksResult,
  TaskSummary,
  TaskStatus,
  TaskPriority,
  ToolExecutionContext,
} from '../types.js';
import {
  createPlatformToolUnavailableError,
  createInvalidPlatformResponseError,
} from '../errors.js';
import { VALID_TASK_STATUSES } from './create-task.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isListTasksResult(value: unknown): value is ListTasksResult {
  return (
    isRecord(value) &&
    value.success === true &&
    Array.isArray(value.tasks) &&
    typeof value.count === 'number'
  );
}

export function createListTasksTool(
  getClient: () => PlatformClientService | undefined
): ToolDefinition {
  return {
    name: 'list_tasks',
    description:
      'List tasks on the Enkeep platform with optional filtering by status and pagination.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'claimed', 'running', 'completed', 'failed', 'cancelled'],
          description: 'Optional filter by task status.',
        },
        limit: {
          type: 'number',
          description: 'Optional maximum number of tasks to return (1-100).',
        },
        offset: {
          type: 'number',
          description: 'Optional pagination offset.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                taskId: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string' },
                priority: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                nextRunAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                dueDate: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                createdAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                lastRun: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                lastRunAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              },
              required: ['taskId', 'title', 'status'],
            },
          },
          count: { type: 'number' },
        },
        required: ['success', 'tasks', 'count'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: JsonValue): ContentBlock[] => {
        if (isListTasksResult(value)) {
          if (value.tasks.length === 0) {
            return [{ type: 'text', text: 'No tasks found.' }];
          }
          const lines = value.tasks.map((t) => {
            const nextInfo = t.nextRunAt ? `, next: ${t.nextRunAt}` : '';
            return `[${t.taskId}] "${t.title}" (${t.status}${nextInfo})`;
          });
          return [{ type: 'text', text: lines.join('\n') }];
        }
        return [{ type: 'text', text: 'Tasks listed' }];
      },
    },
    async execute(
      rawArgs: unknown,
      _context?: ToolExecutionContext
    ): Promise<ListTasksResult> {
      let status: TaskStatus | undefined;
      let limit: number | undefined;
      let offset: number | undefined;

      if (rawArgs !== undefined && rawArgs !== null) {
        if (!isRecord(rawArgs)) {
          throw new TypeError('list_tasks arguments must be an object');
        }

        for (const key of Object.keys(rawArgs)) {
          if (key !== 'status' && key !== 'limit' && key !== 'offset') {
            throw new TypeError(`Unrecognized field "${key}" in list_tasks arguments`);
          }
        }

        if (rawArgs.status !== undefined && rawArgs.status !== null) {
          if (typeof rawArgs.status !== 'string' || !VALID_TASK_STATUSES.has(rawArgs.status as TaskStatus)) {
            throw new TypeError('Invalid task status filter');
          }
          status = rawArgs.status as TaskStatus;
        }

        if (rawArgs.limit !== undefined && rawArgs.limit !== null) {
          if (typeof rawArgs.limit !== 'number' || !Number.isInteger(rawArgs.limit) || rawArgs.limit < 1 || rawArgs.limit > 100) {
            throw new TypeError('Task limit must be an integer between 1 and 100');
          }
          limit = rawArgs.limit;
        }

        if (rawArgs.offset !== undefined && rawArgs.offset !== null) {
          if (typeof rawArgs.offset !== 'number' || !Number.isInteger(rawArgs.offset) || rawArgs.offset < 0) {
            throw new TypeError('Task offset must be a non-negative integer');
          }
          offset = rawArgs.offset;
        }
      }

      const client = getClient();
      if (!client) {
        throw createPlatformToolUnavailableError(
          'Enkeep Platform Client service is not available (ctx.platformClient is undefined)'
        );
      }

      if (client.listTasks) {
        return client.listTasks({ status, limit, offset });
      }

      if (!client.request) {
        throw createPlatformToolUnavailableError(
          'Enkeep Platform Client service is not available (ctx.platformClient.request is missing)'
        );
      }

      const query: Record<string, string | number> = {};
      if (status) query.status = status;
      if (limit !== undefined) query.limit = limit;
      if (offset !== undefined) query.offset = offset;

      const res = await client.request<{
        success?: boolean;
        data?: any;
        error?: {
          code?: string;
          message?: string;
        };
      }>('/api/manage/tasks', {
        method: 'GET',
        query,
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

      let taskList: any[] = [];
      if (Array.isArray(rawData.data)) {
        taskList = rawData.data;
      } else if (isRecord(rawData.data) && Array.isArray(rawData.data.tasks)) {
        taskList = rawData.data.tasks;
      } else {
        throw createInvalidPlatformResponseError('Platform response data must be a list of tasks');
      }

      const tasks: TaskSummary[] = taskList.map((t: any) => {
        const taskId = (typeof t.id === 'string' ? t.id : undefined) ??
          (typeof t.taskId === 'string' ? t.taskId : '');
        const title = typeof t.title === 'string' ? t.title : '';
        const taskStatus = typeof t.status === 'string' ? (t.status as TaskStatus) : 'pending';
        const priority = typeof t.priority === 'string' ? (t.priority as TaskPriority) : (t.priority === null ? null : undefined);
        const nextRunAt = typeof t.nextRunAt === 'string' ? t.nextRunAt : (t.schedule?.nextRunAt ?? null);
        const dueDate = typeof t.dueDate === 'string' ? t.dueDate : (typeof t.due_date === 'string' ? t.due_date : null);
        const createdAt = typeof t.createdAt === 'string' ? t.createdAt : (typeof t.created_at === 'string' ? t.created_at : (t.createdAt === null || t.created_at === null ? null : undefined));
        const lastRun = typeof t.lastRun === 'string' ? t.lastRun : (t.lastRun === null ? null : (typeof t.lastRunAt === 'string' ? t.lastRunAt : (t.lastRunAt === null ? null : (typeof t.last_run_at === 'string' ? t.last_run_at : (t.last_run_at === null ? null : (t.schedule?.lastRunAt ?? undefined))))));

        return {
          taskId,
          title,
          status: taskStatus,
          ...(priority !== undefined ? { priority } : {}),
          nextRunAt: nextRunAt ?? null,
          dueDate: dueDate ?? null,
          ...(createdAt !== undefined ? { createdAt } : {}),
          ...(lastRun !== undefined ? { lastRun } : {}),
        };
      });

      return {
        success: true,
        tasks,
        count: tasks.length,
      };
    },
  };
}
