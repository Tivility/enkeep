import { describe, it, expect } from 'vitest';
import {
  createUpdateTaskTool,
  CANONICAL_TASK_ID_REGEX,
  isUpdateTaskResult,
} from '../src/tools/update-task.js';
import type {
  PlatformClientService,
  UpdateTaskResult,
} from '../src/types.js';
import {
  PlatformToolError,
  PlatformToolErrorCode,
} from '../src/errors.js';

function asPlatformToolError(err: unknown): PlatformToolError {
  if (err instanceof PlatformToolError) {
    return err;
  }
  throw new Error(`Expected PlatformToolError but got: ${String(err)}`);
}

describe('update_task tool', () => {
  const validTaskId = 'task_11111111222233334444555566667777';
  const validHpcTaskId = 'task_hpc_111122223333444455556666';

  it('validates canonical task ID regex', () => {
    expect(CANONICAL_TASK_ID_REGEX.test(validTaskId)).toBe(true);
    expect(CANONICAL_TASK_ID_REGEX.test(validHpcTaskId)).toBe(true);
    expect(CANONICAL_TASK_ID_REGEX.test('invalid_id')).toBe(false);
    expect(CANONICAL_TASK_ID_REGEX.test(` ${validTaskId} `)).toBe(false);
  });

  describe('successful task updates with generic fake client', () => {
    it('updates prompt, title, priority via PUT /api/manage/tasks/:id and strictly omits undefined keys', async () => {
      let requestedPath = '';
      let requestOpts: any = null;

      const mockClient: PlatformClientService = {
        async request(p, opts: any) {
          requestedPath = p;
          requestOpts = opts;
          return {
            status: 200,
            data: {
              success: true,
              data: {
                id: validTaskId,
                status: 'pending',
                updated: true,
                task: {
                  id: validTaskId,
                  title: 'Updated Title',
                  status: 'pending',
                  priority: 'urgent',
                  scheduleType: 'once',
                  nextRunAt: null,
                },
              },
            },
          };
        },
      };

      const tool = createUpdateTaskTool(() => mockClient);
      const res = await tool.execute({
        taskId: validTaskId,
        title: 'Updated Title',
        prompt: 'Updated autonomous prompt instructions',
        priority: 'urgent',
      });

      expect(res.success).toBe(true);
      expect(res.taskId).toBe(validTaskId);
      expect(res.status).toBe('pending');
      expect(res.updated).toBe(true);
      expect(res.title).toBe('Updated Title');
      expect(res.scheduleType).toBe('once');

      expect(requestedPath).toBe(`/api/manage/tasks/${validTaskId}`);
      expect(requestOpts.method).toBe('PUT');

      // Strict payload omitting undefined keys, no owner/userId/sessionId
      expect(requestOpts.body).toEqual({
        title: 'Updated Title',
        prompt: 'Updated autonomous prompt instructions',
        priority: 'urgent',
      });
      expect(requestOpts.body).not.toHaveProperty('userId');
      expect(requestOpts.body).not.toHaveProperty('owner');
      expect(requestOpts.body).not.toHaveProperty('sessionId');
      expect(requestOpts.body).not.toHaveProperty('spaceId');
    });

    it('switches schedule from once to cron with timezone and misfirePolicy', async () => {
      let requestOpts: any = null;
      const mockClient: PlatformClientService = {
        async request(_p, opts: any) {
          requestOpts = opts;
          return {
            status: 200,
            data: {
              success: true,
              data: {
                id: validTaskId,
                status: 'pending',
                updated: true,
                task: {
                  id: validTaskId,
                  title: 'Nightly Sync',
                  status: 'pending',
                  scheduleType: 'cron',
                  nextRunAt: '2026-09-02T03:00:00.000Z',
                },
              },
            },
          };
        },
      };

      const tool = createUpdateTaskTool(() => mockClient);
      const res = await tool.execute({
        taskId: validTaskId,
        scheduleType: 'cron',
        cronExpression: '0 3 * * *',
        timezone: 'Asia/Shanghai',
        misfirePolicy: 'coalesce',
        overlapPolicy: 'skip',
      });

      expect(res.success).toBe(true);
      expect(res.taskId).toBe(validTaskId);
      expect(res.scheduleType).toBe('cron');
      expect(res.nextRunAt).toBe('2026-09-02T03:00:00.000Z');

      expect(requestOpts.body).toEqual({
        scheduleType: 'cron',
        cronExpression: '0 3 * * *',
        timezone: 'Asia/Shanghai',
        misfirePolicy: 'coalesce',
        overlapPolicy: 'skip',
      });
    });

    it('switches schedule to interval with safe integer seconds', async () => {
      let requestOpts: any = null;
      const mockClient: PlatformClientService = {
        async request(_p, opts: any) {
          requestOpts = opts;
          return {
            status: 200,
            data: {
              success: true,
              data: {
                id: validTaskId,
                status: 'pending',
                updated: true,
                task: {
                  id: validTaskId,
                  status: 'pending',
                  scheduleType: 'interval',
                  nextRunAt: '2026-09-01T12:05:00.000Z',
                },
              },
            },
          };
        },
      };

      const tool = createUpdateTaskTool(() => mockClient);
      const res = await tool.execute({
        taskId: validTaskId,
        scheduleType: 'interval',
        intervalSeconds: 300,
      });

      expect(res.success).toBe(true);
      expect(res.scheduleType).toBe('interval');
      expect(requestOpts.body).toEqual({
        scheduleType: 'interval',
        intervalSeconds: 300,
      });
    });

    it('switches schedule to once with exact canonical ISO 8601 UTC dueDate', async () => {
      let requestOpts: any = null;
      const mockClient: PlatformClientService = {
        async request(_p, opts: any) {
          requestOpts = opts;
          return {
            status: 200,
            data: {
              success: true,
              data: {
                id: validTaskId,
                status: 'pending',
                updated: true,
                task: {
                  id: validTaskId,
                  status: 'pending',
                  scheduleType: 'once',
                  nextRunAt: '2026-12-31T23:59:59.000Z',
                },
              },
            },
          };
        },
      };

      const tool = createUpdateTaskTool(() => mockClient);
      const res = await tool.execute({
        taskId: validTaskId,
        scheduleType: 'once',
        dueDate: '2026-12-31T23:59:59.000Z',
      });

      expect(res.success).toBe(true);
      expect(requestOpts.body).toEqual({
        scheduleType: 'once',
        dueDate: '2026-12-31T23:59:59.000Z',
      });
    });

    it('supports nulling nullable fields (description, assignee, cronExpression, intervalSeconds, dueDate)', async () => {
      let requestOpts: any = null;
      const mockClient: PlatformClientService = {
        async request(_p, opts: any) {
          requestOpts = opts;
          return {
            status: 200,
            data: {
              success: true,
              data: {
                id: validTaskId,
                status: 'pending',
                updated: true,
              },
            },
          };
        },
      };

      const tool = createUpdateTaskTool(() => mockClient);
      const res = await tool.execute({
        taskId: validTaskId,
        description: null,
        assignee: null,
        cronExpression: null,
        intervalSeconds: null,
        dueDate: null,
      });

      expect(res.success).toBe(true);
      expect(requestOpts.body).toEqual({
        description: null,
        assignee: null,
        cronExpression: null,
        intervalSeconds: null,
        dueDate: null,
      });
    });

    it('invokes direct client.updateTask method if available', async () => {
      let directCalled = false;
      const directResult: UpdateTaskResult = {
        success: true,
        taskId: validTaskId,
        status: 'pending',
        updated: true,
        title: 'Direct Call Title',
        scheduleType: 'cron',
        nextRunAt: '2026-09-02T00:00:00.000Z',
      };

      const mockClient: PlatformClientService = {
        async updateTask(id, payload) {
          directCalled = true;
          expect(id).toBe(validTaskId);
          expect(payload.title).toBe('Direct Call Title');
          return directResult;
        },
      };

      const tool = createUpdateTaskTool(() => mockClient);
      const res = await tool.execute({
        taskId: validTaskId,
        title: 'Direct Call Title',
      });

      expect(directCalled).toBe(true);
      expect(res).toEqual(directResult);
    });
  });

  describe('unavailable client and input validation failures', () => {
    it('fails closed when client is missing (throws PLATFORM_TOOL_UNAVAILABLE 503)', async () => {
      const tool = createUpdateTaskTool(() => undefined);
      try {
        await tool.execute({
          taskId: validTaskId,
          title: 'New Title',
        });
        expect.unreachable('Should have thrown PlatformToolError');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.PLATFORM_TOOL_UNAVAILABLE);
        expect(pErr.status).toBe(503);
      }
    });

    it('fails closed when client does not implement request or updateTask', async () => {
      const tool = createUpdateTaskTool(() => ({}));
      try {
        await tool.execute({
          taskId: validTaskId,
          title: 'New Title',
        });
        expect.unreachable('Should have thrown PlatformToolError');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.PLATFORM_TOOL_UNAVAILABLE);
      }
    });

    it('rejects invalid or missing canonical taskId', async () => {
      const mockClient: PlatformClientService = { async request() { return { status: 200, data: {} }; } };
      const tool = createUpdateTaskTool(() => mockClient);

      // Missing taskId
      await expect(tool.execute({ title: 'Task' })).rejects.toThrow(PlatformToolError);

      // Non-canonical taskId
      await expect(tool.execute({ taskId: 'bad_id', title: 'Task' })).rejects.toThrow(PlatformToolError);

      // Untrimmed taskId
      await expect(tool.execute({ taskId: ` ${validTaskId} `, title: 'Task' })).rejects.toThrow(PlatformToolError);
    });

    it('rejects empty update with no editable fields (TypeError)', async () => {
      const mockClient: PlatformClientService = { async request() { return { status: 200, data: {} }; } };
      const tool = createUpdateTaskTool(() => mockClient);

      await expect(tool.execute({ taskId: validTaskId })).rejects.toThrow(
        /At least one editable field must be provided/
      );
    });

    it('rejects forbidden immutable fields (owner, userId, sessionId, spaceId, status, etc.)', async () => {
      const mockClient: PlatformClientService = { async request() { return { status: 200, data: {} }; } };
      const tool = createUpdateTaskTool(() => mockClient);

      // Owner tamper
      await expect(tool.execute({ taskId: validTaskId, userId: 'other_user', title: 'T' })).rejects.toThrow(
        /Task ownership is immutable/
      );
      await expect(tool.execute({ taskId: validTaskId, owner: 'other_user', title: 'T' })).rejects.toThrow(
        /Task ownership is immutable/
      );

      // Session / space tamper
      await expect(tool.execute({ taskId: validTaskId, sessionId: 'ses_1234', title: 'T' })).rejects.toThrow(
        /Task session and space bindings are immutable/
      );
      await expect(tool.execute({ taskId: validTaskId, spaceId: 'spc_1234', title: 'T' })).rejects.toThrow(
        /Task session and space bindings are immutable/
      );

      // Status tamper
      await expect(tool.execute({ taskId: validTaskId, status: 'completed', title: 'T' })).rejects.toThrow(
        /Field "status" is immutable/
      );

      // IdempotencyKey tamper
      await expect(tool.execute({ taskId: validTaskId, idempotencyKey: 'some_key', title: 'T' })).rejects.toThrow(
        /Field "idempotencyKey" is immutable/
      );

      // Payload tamper
      await expect(tool.execute({ taskId: validTaskId, payload: {}, title: 'T' })).rejects.toThrow(
        /Field "payload" is immutable/
      );

      // Unrecognized field
      await expect(tool.execute({ taskId: validTaskId, phantomField: 'val', title: 'T' })).rejects.toThrow(
        /Unrecognized field "phantomField"/
      );
    });

    it('validates title (untrimmed, empty, > 256 characters)', async () => {
      const tool = createUpdateTaskTool(() => ({ async request() { return { status: 200, data: {} }; } }));

      await expect(tool.execute({ taskId: validTaskId, title: '  untrimmed  ' })).rejects.toThrow(TypeError);
      await expect(tool.execute({ taskId: validTaskId, title: '' })).rejects.toThrow(TypeError);
      await expect(tool.execute({ taskId: validTaskId, title: 'a'.repeat(257) })).rejects.toThrow(TypeError);
    });

    it('validates prompt (empty, > 64 KiB)', async () => {
      const tool = createUpdateTaskTool(() => ({ async request() { return { status: 200, data: {} }; } }));

      await expect(tool.execute({ taskId: validTaskId, prompt: '   ' })).rejects.toThrow(TypeError);
      await expect(tool.execute({ taskId: validTaskId, prompt: 'a'.repeat(65537) })).rejects.toThrow(TypeError);
    });

    it('validates priority enum', async () => {
      const tool = createUpdateTaskTool(() => ({ async request() { return { status: 200, data: {} }; } }));

      await expect(tool.execute({ taskId: validTaskId, priority: 'critical' as any })).rejects.toThrow(TypeError);
    });

    it('validates scheduleType enum', async () => {
      const tool = createUpdateTaskTool(() => ({ async request() { return { status: 200, data: {} }; } }));

      await expect(tool.execute({ taskId: validTaskId, scheduleType: 'weekly' as any })).rejects.toThrow(TypeError);
    });

    it('validates cronExpression (non-5-field)', async () => {
      const tool = createUpdateTaskTool(() => ({ async request() { return { status: 200, data: {} }; } }));

      await expect(tool.execute({ taskId: validTaskId, cronExpression: '0 0 * * * *' })).rejects.toThrow(TypeError);
      await expect(tool.execute({ taskId: validTaskId, cronExpression: 'invalid_cron' })).rejects.toThrow(TypeError);
    });

    it('validates intervalSeconds (< 60, > 31,536,000, non-integer)', async () => {
      const tool = createUpdateTaskTool(() => ({ async request() { return { status: 200, data: {} }; } }));

      await expect(tool.execute({ taskId: validTaskId, intervalSeconds: 30 })).rejects.toThrow(TypeError);
      await expect(tool.execute({ taskId: validTaskId, intervalSeconds: 40000000 })).rejects.toThrow(TypeError);
      await expect(tool.execute({ taskId: validTaskId, intervalSeconds: 60.5 })).rejects.toThrow(TypeError);
    });

    it('validates dueDate (non-ISO 8601 UTC)', async () => {
      const tool = createUpdateTaskTool(() => ({ async request() { return { status: 200, data: {} }; } }));

      await expect(tool.execute({ taskId: validTaskId, dueDate: '2026-09-01 12:00:00' })).rejects.toThrow(TypeError);
      await expect(tool.execute({ taskId: validTaskId, dueDate: 'invalid-date' })).rejects.toThrow(TypeError);
    });

    it('validates timezone (invalid IANA timezone)', async () => {
      const tool = createUpdateTaskTool(() => ({ async request() { return { status: 200, data: {} }; } }));

      await expect(tool.execute({ taskId: validTaskId, timezone: 'Not/Real_Zone' })).rejects.toThrow(TypeError);
    });

    it('validates misfirePolicy and overlapPolicy', async () => {
      const tool = createUpdateTaskTool(() => ({ async request() { return { status: 200, data: {} }; } }));

      await expect(tool.execute({ taskId: validTaskId, misfirePolicy: 'ignore' as any })).rejects.toThrow(TypeError);
      await expect(tool.execute({ taskId: validTaskId, overlapPolicy: 'allow' as any })).rejects.toThrow(TypeError);
    });
  });

  describe('platform error and invalid response envelope handling', () => {
    it('throws INVALID_PLATFORM_RESPONSE on HTTP status >= 300', async () => {
      const mockClient: PlatformClientService = {
        async request() {
          return {
            status: 409,
            data: {
              success: false,
              error: { code: 'TASK_ALREADY_CLAIMED', message: 'Task is currently claimed by worker' },
            },
          };
        },
      };

      const tool = createUpdateTaskTool(() => mockClient);
      try {
        await tool.execute({ taskId: validTaskId, title: 'Updated Title' });
        expect.unreachable('Should have thrown PlatformToolError');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.INVALID_PLATFORM_RESPONSE);
      }
    });

    it('throws INVALID_PLATFORM_RESPONSE on unsuccessful error envelope', async () => {
      const mockClient: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: false,
              error: { code: 'TASK_NOT_FOUND', message: 'Task not found' },
            },
          };
        },
      };

      const tool = createUpdateTaskTool(() => mockClient);
      try {
        await tool.execute({ taskId: validTaskId, title: 'Updated Title' });
        expect.unreachable('Should have thrown PlatformToolError');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.INVALID_PLATFORM_RESPONSE);
      }
    });

    it('throws INVALID_PLATFORM_RESPONSE when updated is false or missing', async () => {
      const mockClient: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                id: validTaskId,
                status: 'pending',
                updated: false,
              },
            },
          };
        },
      };

      const tool = createUpdateTaskTool(() => mockClient);
      try {
        await tool.execute({ taskId: validTaskId, title: 'Updated Title' });
        expect.unreachable('Should have thrown PlatformToolError');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.INVALID_PLATFORM_RESPONSE);
      }
    });

    it('throws INVALID_PLATFORM_RESPONSE when taskId in response mismatches request', async () => {
      const mockClient: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                id: 'task_99999999999999999999999999999999',
                status: 'pending',
                updated: true,
              },
            },
          };
        },
      };

      const tool = createUpdateTaskTool(() => mockClient);
      try {
        await tool.execute({ taskId: validTaskId, title: 'Updated Title' });
        expect.unreachable('Should have thrown PlatformToolError');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.INVALID_PLATFORM_RESPONSE);
      }
    });

    it('throws INVALID_PLATFORM_RESPONSE when task status is invalid or missing', async () => {
      const mockClient: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                id: validTaskId,
                status: 'invalid_status_val',
                updated: true,
              },
            },
          };
        },
      };

      const tool = createUpdateTaskTool(() => mockClient);
      try {
        await tool.execute({ taskId: validTaskId, title: 'Updated Title' });
        expect.unreachable('Should have thrown PlatformToolError');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.INVALID_PLATFORM_RESPONSE);
      }
    });
  });

  describe('tool metadata and card presentation', () => {
    it('provides correct name and presentation views', () => {
      const tool = createUpdateTaskTool(() => undefined);
      expect(tool.name).toBe('update_task');
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters.required).toEqual(['taskId']);

      expect(tool.presentCall?.({ taskId: validTaskId })).toEqual({
        card: 'generic',
        title: `Update task: ${validTaskId}`,
      });

      expect(tool.presentResult?.({ taskId: validTaskId }, { isError: false } as any)).toEqual({
        card: 'generic',
        title: 'Updated task',
      });

      expect(tool.presentResult?.({ taskId: validTaskId }, { isError: true } as any)).toEqual({
        card: 'generic',
        title: 'Failed to update task',
      });

      const blocks = tool.output.render?.({}, {
        success: true,
        taskId: validTaskId,
        status: 'pending',
        updated: true,
        title: 'Rendered Title',
        scheduleType: 'cron',
        nextRunAt: '2026-09-02T00:00:00.000Z',
      });
      expect(blocks).toBeDefined();
      expect(blocks?.[0]?.type).toBe('text');
      expect((blocks?.[0] as any)?.text).toContain('Task updated:');
    });

    it('isUpdateTaskResult helper verifies valid result structures', () => {
      expect(isUpdateTaskResult({
        success: true,
        taskId: validTaskId,
        status: 'pending',
        updated: true,
      })).toBe(true);

      expect(isUpdateTaskResult({
        success: false,
        taskId: validTaskId,
        status: 'pending',
        updated: true,
      })).toBe(false);

      expect(isUpdateTaskResult(null)).toBe(false);
      expect(isUpdateTaskResult({})).toBe(false);
    });
  });
});
