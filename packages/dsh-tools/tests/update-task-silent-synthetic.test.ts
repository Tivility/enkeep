import { describe, it, expect } from 'vitest';
import { createUpdateTaskTool } from '../src/tools/update-task.js';
import type { PlatformClientService } from '../src/types.js';

describe('Synthetic update_task tool silent parameter tests', () => {
  const validTaskId = 'task_00000000000000000000000000000001';

  it('tool schema accepts optional boolean silent parameter with clear description', () => {
    const tool = createUpdateTaskTool(() => undefined);
    expect(tool.parameters.properties).toHaveProperty('silent');
    const silentParam = (tool.parameters.properties as any).silent;
    expect(silentParam.type).toBe('boolean');
    expect(silentParam.description).toBeDefined();
    expect(typeof silentParam.description).toBe('string');
    expect(silentParam.description.length).toBeGreaterThan(10);
  });

  it('passes silent=true to management API request body', async () => {
    let capturedBody: any = null;
    const mockClient: PlatformClientService = {
      async request(_path, opts: any) {
        capturedBody = opts.body;
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
                title: 'Task Alpha',
                status: 'pending',
                scheduleType: 'once',
              },
            },
          },
        };
      },
    };

    const tool = createUpdateTaskTool(() => mockClient);
    const result = await tool.execute({
      taskId: validTaskId,
      silent: true,
    });

    expect(result.success).toBe(true);
    expect(capturedBody).toBeDefined();
    expect(capturedBody.silent).toBe(true);
  });

  it('passes silent=false to management API request body', async () => {
    let capturedBody: any = null;
    const mockClient: PlatformClientService = {
      async request(_path, opts: any) {
        capturedBody = opts.body;
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
                title: 'Task Beta',
                status: 'pending',
                scheduleType: 'once',
              },
            },
          },
        };
      },
    };

    const tool = createUpdateTaskTool(() => mockClient);
    const result = await tool.execute({
      taskId: validTaskId,
      silent: false,
    });

    expect(result.success).toBe(true);
    expect(capturedBody).toBeDefined();
    expect(capturedBody.silent).toBe(false);
  });

  it('rejects non-boolean silent with TypeError', async () => {
    const tool = createUpdateTaskTool(() => undefined);
    await expect(
      tool.execute({
        taskId: validTaskId,
        silent: 'yes' as any,
      })
    ).rejects.toThrow(TypeError);
  });

  it('still rejects forbidden immutable keys', async () => {
    const tool = createUpdateTaskTool(() => undefined);
    await expect(
      tool.execute({
        taskId: validTaskId,
        sessionId: 'ses_00000000000000000000000000000001' as any,
      })
    ).rejects.toThrow(TypeError);

    await expect(
      tool.execute({
        taskId: validTaskId,
        userId: 'usr_00000000000000000000000000000001' as any,
      })
    ).rejects.toThrow(TypeError);
  });
});
