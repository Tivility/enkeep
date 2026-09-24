import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type {
  ToolDefinition,
  PlatformClientService,
  CancelTaskResult,
  TaskStatus,
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

export function isCancelTaskResult(value: unknown): value is CancelTaskResult {
  return (
    isRecord(value) &&
    value.success === true &&
    typeof value.taskId === 'string' &&
    typeof value.status === 'string' &&
    value.cancelled === true
  );
}

export function createCancelTaskTool(
  getClient: () => PlatformClientService | undefined
): ToolDefinition {
  return {
    name: 'cancel_task',
    description:
      'Cancel an existing asynchronous task or schedule on the Enkeep platform.',
    parameters: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description:
            'Canonical platform task ID to cancel (e.g. task_<32hex> or task_hpc_<24hex>).',
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
          status: { type: 'string' },
          cancelled: { type: 'boolean' },
        },
        required: ['success', 'taskId', 'status', 'cancelled'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: JsonValue): ContentBlock[] => {
        if (isCancelTaskResult(value)) {
          return [
            {
              type: 'text',
              text: `Task cancelled: ${value.taskId} (Status: ${value.status})`,
            },
          ];
        }
        return [{ type: 'text', text: 'Task cancelled' }];
      },
    },
    async execute(
      rawArgs: unknown,
      _context?: ToolExecutionContext
    ): Promise<CancelTaskResult> {
      if (!isRecord(rawArgs)) {
        throw new TypeError('cancel_task requires an arguments object');
      }

      for (const key of Object.keys(rawArgs)) {
        if (key !== 'taskId') {
          throw new TypeError(`Unrecognized field "${key}" in cancel_task arguments`);
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
          'Authoritative canonical taskId is required for task cancellation and cannot be fabricated'
        );
      }
      const taskId = rawTaskId;

      const client = getClient();
      if (!client) {
        throw createPlatformToolUnavailableError(
          'Enkeep Platform Client service is not available (ctx.platformClient is undefined)'
        );
      }

      if (client.cancelTask) {
        return client.cancelTask(taskId);
      }

      if (!client.request) {
        throw createPlatformToolUnavailableError(
          'Enkeep Platform Client service is not available (ctx.platformClient.request is missing)'
        );
      }

      const res = await client.request<{
        success?: boolean;
        data?: {
          id?: string;
          status?: string;
          cancelled?: boolean;
          task?: {
            id?: string;
            status?: string;
            [key: string]: unknown;
          };
          [key: string]: unknown;
        };
        error?: {
          code?: string;
          message?: string;
        };
      }>(`/api/manage/tasks/${encodeURIComponent(taskId)}/cancel`, {
        method: 'POST',
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

      const data = rawData.data;
      if (!isRecord(data)) {
        throw createInvalidPlatformResponseError('Platform response data payload is invalid');
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
        (typeof data.status === 'string' ? data.status : undefined) ??
        (typeof taskObj?.status === 'string' ? taskObj.status : undefined) ??
        'cancelled';

      return {
        success: true,
        taskId,
        status: resStatus as TaskStatus,
        cancelled: true,
      };
    },
  };
}
