import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import * as dshToolsPlugin from '../src/index.js';
import {
  createCreateTaskTool,
  createCancelTaskTool,
  createListTasksTool,
  createGetTaskTool,
  CANONICAL_TASK_ID_REGEX,
  isCancelTaskResult,
  isListTasksResult,
  isGetTaskResult,
} from '../src/index.js';
import type { PlatformClientService, ToolDefinition } from '../src/types.js';
import { PlatformToolError } from '../src/errors.js';

class MockToolsService extends Service {
  public registeredTools: ToolDefinition[] = [];

  constructor(ctx: Context) {
    super(ctx, 'tools');
  }

  register(tool: ToolDefinition) {
    this.registeredTools.push(tool);
    return () => {
      const index = this.registeredTools.indexOf(tool);
      if (index !== -1) {
        this.registeredTools.splice(index, 1);
      }
    };
  }
}

describe('dsh-tools: task management tools (cancel_task, list_tasks, get_task, create_task taskId render)', () => {
  const validTaskId = 'task_11111111222233334444555566667777';
  const validHpcTaskId = 'task_hpc_111122223333444455556666';

  describe('create_task tool taskId confirmation in render (CF-02 / GAP-04)', () => {
    it('render output contains taskId in confirmation text', () => {
      const tool = createCreateTaskTool(() => undefined);
      const renderFn = tool.output?.render;
      expect(renderFn).toBeDefined();

      const blocks = renderFn!(
        {},
        {
          success: true,
          taskId: validTaskId,
          title: 'Benchmark Plan Task',
          status: 'pending',
          isIdempotentHit: false,
        }
      );

      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('text');
      expect((blocks[0] as any).text).toBe(
        `Task created: ${validTaskId} ("Benchmark Plan Task", Status: pending, IdempotentHit: false)`
      );
    });
  });

  describe('cancel_task tool', () => {
    it('validates canonical task ID regex', () => {
      expect(CANONICAL_TASK_ID_REGEX.test(validTaskId)).toBe(true);
      expect(CANONICAL_TASK_ID_REGEX.test(validHpcTaskId)).toBe(true);
      expect(CANONICAL_TASK_ID_REGEX.test('invalid_id')).toBe(false);
      expect(CANONICAL_TASK_ID_REGEX.test(` ${validTaskId} `)).toBe(false);
    });

    it('cancels task via POST /api/manage/tasks/:id/cancel and renders cancelled status', async () => {
      let requestedPath = '';
      let requestMethod = '';

      const mockClient: PlatformClientService = {
        async request(p, opts: any) {
          requestedPath = p;
          requestMethod = opts?.method;
          return {
            status: 200,
            data: {
              success: true,
              data: {
                id: validTaskId,
                status: 'cancelled',
                cancelled: true,
              },
            },
          };
        },
      };

      const tool = createCancelTaskTool(() => mockClient);
      const res = await tool.execute({ taskId: validTaskId });

      expect(res.success).toBe(true);
      expect(res.taskId).toBe(validTaskId);
      expect(res.status).toBe('cancelled');
      expect(res.cancelled).toBe(true);
      expect(requestedPath).toBe(`/api/manage/tasks/${validTaskId}/cancel`);
      expect(requestMethod).toBe('POST');

      // Test render output
      const renderFn = tool.output?.render;
      expect(renderFn).toBeDefined();
      const blocks = renderFn!({}, res as any);
      expect(blocks).toHaveLength(1);
      expect((blocks[0] as any).text).toBe(`Task cancelled: ${validTaskId} (Status: cancelled)`);
    });

    it('rejects unrecognized arguments or malformed taskId', async () => {
      const tool = createCancelTaskTool(() => ({} as any));

      await expect(tool.execute({ taskId: validTaskId, extra: 'bad' })).rejects.toThrow(
        /Unrecognized field "extra"/
      );
      await expect(tool.execute({ taskId: 'bad-task-id' })).rejects.toThrow(
        /Authoritative canonical taskId is required/
      );
      await expect(tool.execute('not-an-object')).rejects.toThrow(
        /cancel_task requires an arguments object/
      );
    });

    it('handles client unavailable error', async () => {
      const tool = createCancelTaskTool(() => undefined);
      await expect(tool.execute({ taskId: validTaskId })).rejects.toThrow(PlatformToolError);
    });
  });

  describe('list_tasks tool', () => {
    it('lists tasks via GET /api/manage/tasks and formats output render with nextRunAt', async () => {
      let requestedPath = '';
      let requestMethod = '';
      let requestQuery: any = null;

      const mockClient: PlatformClientService = {
        async request(p, opts: any) {
          requestedPath = p;
          requestMethod = opts?.method;
          requestQuery = opts?.query;
          return {
            status: 200,
            data: {
              success: true,
              data: [
                {
                  id: validTaskId,
                  title: 'Daily Cleanup',
                  status: 'pending',
                  priority: 'high',
                  nextRunAt: '2026-09-25T00:00:00.000Z',
                },
                {
                  id: validHpcTaskId,
                  title: 'Compute Node Sync',
                  status: 'running',
                  priority: 'urgent',
                },
              ],
            },
          };
        },
      };

      const tool = createListTasksTool(() => mockClient);
      const res = await tool.execute({ status: 'pending', limit: 10 });

      expect(res.success).toBe(true);
      expect(res.count).toBe(2);
      expect(res.tasks).toHaveLength(2);
      expect(res.tasks[0].taskId).toBe(validTaskId);
      expect(res.tasks[0].title).toBe('Daily Cleanup');
      expect(res.tasks[0].nextRunAt).toBe('2026-09-25T00:00:00.000Z');
      expect(res.tasks[1].taskId).toBe(validHpcTaskId);

      expect(requestedPath).toBe('/api/manage/tasks');
      expect(requestMethod).toBe('GET');
      expect(requestQuery).toEqual({ status: 'pending', limit: 10 });

      // Test render output
      const renderFn = tool.output?.render;
      expect(renderFn).toBeDefined();
      const blocks = renderFn!({}, res as any);
      expect(blocks).toHaveLength(1);
      const renderedText = (blocks[0] as any).text;
      expect(renderedText).toContain(`[${validTaskId}] "Daily Cleanup" (pending, next: 2026-09-25T00:00:00.000Z)`);
      expect(renderedText).toContain(`[${validHpcTaskId}] "Compute Node Sync" (running)`);
    });

    it('renders "No tasks found." when empty', async () => {
      const tool = createListTasksTool(() => undefined);
      const renderFn = tool.output?.render;
      const blocks = renderFn!({}, { success: true, tasks: [], count: 0 });
      expect((blocks[0] as any).text).toBe('No tasks found.');
    });

    it('validates filter arguments', async () => {
      const tool = createListTasksTool(() => ({} as any));
      await expect(tool.execute({ status: 'invalid_status' })).rejects.toThrow(/Invalid task status filter/);
      await expect(tool.execute({ limit: 0 })).rejects.toThrow(/integer between 1 and 100/);
      await expect(tool.execute({ limit: 101 })).rejects.toThrow(/integer between 1 and 100/);
      await expect(tool.execute({ offset: -1 })).rejects.toThrow(/non-negative integer/);
      await expect(tool.execute({ unknownField: true })).rejects.toThrow(/Unrecognized field/);
    });
  });

  describe('get_task tool', () => {
    it('retrieves single task via GET /api/manage/tasks/:id', async () => {
      let requestedPath = '';

      const mockClient: PlatformClientService = {
        async request(p) {
          requestedPath = p;
          return {
            status: 200,
            data: {
              success: true,
              data: {
                task: {
                  id: validTaskId,
                  title: 'Deep Research Task',
                  status: 'running',
                  priority: 'medium',
                  nextRunAt: null,
                },
              },
            },
          };
        },
      };

      const tool = createGetTaskTool(() => mockClient);
      const res = await tool.execute({ taskId: validTaskId });

      expect(res.success).toBe(true);
      expect(res.task.taskId).toBe(validTaskId);
      expect(res.task.title).toBe('Deep Research Task');
      expect(res.task.status).toBe('running');
      expect(requestedPath).toBe(`/api/manage/tasks/${validTaskId}`);

      // Test render output
      const renderFn = tool.output?.render;
      const blocks = renderFn!({}, res as any);
      expect((blocks[0] as any).text).toBe(`Task [${validTaskId}]: "Deep Research Task" (Status: running)`);
    });

    it('rejects invalid taskId format or unrecognized arguments', async () => {
      const tool = createGetTaskTool(() => ({} as any));
      await expect(tool.execute({ taskId: 'invalid-id' })).rejects.toThrow(/Authoritative canonical taskId is required/);
      await expect(tool.execute({ taskId: validTaskId, extra: 'bad' })).rejects.toThrow(/Unrecognized field "extra"/);
    });
  });

  describe('Cordis plugin registration with task management tools', () => {
    it('registers all 8 tools when enableTaskManagementTools or workspaceBoundaryRoot is set', async () => {
      const dummyWorkspaceRoot = path.join(os.tmpdir(), 'dsh-plugin-test-ws-8');
      const ctx = new Context();
      const toolsService = new MockToolsService(ctx);

      const fork = await ctx.plugin(dshToolsPlugin, {
        workspaceBoundaryRoot: dummyWorkspaceRoot,
      });

      expect(toolsService.registeredTools.length).toBe(8);
      const names = toolsService.registeredTools.map((t) => t.name);
      expect(names).toContain('send_platform_message');
      expect(names).toContain('send_file');
      expect(names).toContain('create_task');
      expect(names).toContain('update_task');
      expect(names).toContain('check_quota');
      expect(names).toContain('cancel_task');
      expect(names).toContain('list_tasks');
      expect(names).toContain('get_task');

      await fork.dispose();
      expect(toolsService.registeredTools.length).toBe(0);
    });
  });
});
