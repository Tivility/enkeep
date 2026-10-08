import { describe, it, expect, vi } from 'vitest';
import type { BackgroundTask } from '@enkeep/platform-server';
import { createBackgroundTaskDelegates, type RuntimeSpaceResolver } from '../src/up/background-delegates.js';

describe('createBackgroundTaskDelegates', () => {
  const syntheticHostUser = 'user-synth-alice-0001';
  const syntheticHostSpace = 'spc_synth_host_0000000000000001';
  const syntheticHostSession = 'dsh_synth_host_session_0001';

  const syntheticContainerUser = 'user-synth-bob-0002';
  const syntheticContainerSpace = 'spc_synth_container_0000000001';
  const syntheticContainerSession = 'dsh_synth_cont_session_0002';

  const syntheticTaskId = 'task_synth_000000000000000000000001';

  const hostTasks: BackgroundTask[] = [
    {
      id: 'task_host_01',
      shortId: 'h001',
      kind: 'subagent',
      name: 'Host Background Worker',
      status: 'running',
      startedAt: new Date(Date.now() - 60000).toISOString(),
      lastActivityAt: new Date(Date.now() - 5000).toISOString(),
      stalled: false,
    },
    {
      id: 'task_host_02',
      shortId: 'h002',
      kind: 'workflow',
      name: 'Host Workflow Pipeline',
      status: 'running',
      startedAt: new Date(Date.now() - 120000).toISOString(),
      lastActivityAt: new Date(Date.now() - 10000).toISOString(),
      stalled: false,
      progress: { agentsDone: 2, agentsTotal: 4 },
    },
  ];

  const containerTasks: BackgroundTask[] = [
    {
      id: 'task_cont_01',
      shortId: 'c001',
      kind: 'workflow',
      name: 'Container Analysis Job',
      status: 'completed',
      startedAt: new Date(Date.now() - 300000).toISOString(),
      finishedAt: new Date(Date.now() - 60000).toISOString(),
      lastActivityAt: new Date(Date.now() - 60000).toISOString(),
      stalled: false,
    },
  ];

  it('1. delegates listBackgroundTasks to host runtime handle for host space users', async () => {
    const listHostFn = vi.fn().mockResolvedValue(hostTasks);
    const fakeHostHandle = {
      listBackgroundTasks: listHostFn,
      stopBackgroundTask: vi.fn(),
    };

    const mockResolver: RuntimeSpaceResolver = vi.fn().mockImplementation(async (userId, spaceId) => {
      if (userId === syntheticHostUser && spaceId === syntheticHostSpace) {
        return {
          handle: fakeHostHandle,
          isHost: true,
          spaceFolder: 'host-folder',
        };
      }
      throw new Error('Unexpected user/space');
    });

    const delegates = createBackgroundTaskDelegates(mockResolver);
    const tasks = await delegates.listBackgroundTasks({
      userId: syntheticHostUser,
      platformSpaceId: syntheticHostSpace,
      dshSessionId: syntheticHostSession,
    });

    expect(mockResolver).toHaveBeenCalledWith(syntheticHostUser, syntheticHostSpace);
    expect(listHostFn).toHaveBeenCalledWith(syntheticHostSession);
    expect(tasks).toEqual(hostTasks);
  });

  it('2. delegates listBackgroundTasks to container runtime handle for container space users', async () => {
    const listContainerFn = vi.fn().mockResolvedValue(containerTasks);
    const fakeContainerHandle = {
      listBackgroundTasks: listContainerFn,
      stopBackgroundTask: vi.fn(),
    };

    const mockResolver: RuntimeSpaceResolver = vi.fn().mockImplementation(async (userId, spaceId) => {
      if (userId === syntheticContainerUser && spaceId === syntheticContainerSpace) {
        return {
          handle: fakeContainerHandle,
          isHost: false,
          spaceFolder: 'container-folder',
        };
      }
      throw new Error('Unexpected user/space');
    });

    const delegates = createBackgroundTaskDelegates(mockResolver);
    const tasks = await delegates.listBackgroundTasks({
      userId: syntheticContainerUser,
      platformSpaceId: syntheticContainerSpace,
      dshSessionId: syntheticContainerSession,
    });

    expect(mockResolver).toHaveBeenCalledWith(syntheticContainerUser, syntheticContainerSpace);
    expect(listContainerFn).toHaveBeenCalledWith(syntheticContainerSession);
    expect(tasks).toEqual(containerTasks);
  });

  it('3. delegates stopBackgroundTask to host runtime handle for host space users', async () => {
    const stopHostFn = vi.fn().mockResolvedValue({ stopped: true });
    const fakeHostHandle = {
      listBackgroundTasks: vi.fn(),
      stopBackgroundTask: stopHostFn,
    };

    const mockResolver: RuntimeSpaceResolver = vi.fn().mockResolvedValue({
      handle: fakeHostHandle,
      isHost: true,
      spaceFolder: 'host-folder',
    });

    const delegates = createBackgroundTaskDelegates(mockResolver);
    const result = await delegates.stopBackgroundTask({
      userId: syntheticHostUser,
      platformSpaceId: syntheticHostSpace,
      dshSessionId: syntheticHostSession,
      taskId: syntheticTaskId,
    });

    expect(mockResolver).toHaveBeenCalledWith(syntheticHostUser, syntheticHostSpace);
    expect(stopHostFn).toHaveBeenCalledWith(syntheticHostSession, syntheticTaskId);
    expect(result).toEqual({ stopped: true });
  });

  it('4. delegates stopBackgroundTask to container runtime handle for container space users', async () => {
    const stopContFn = vi.fn().mockResolvedValue({ stopped: true });
    const fakeContainerHandle = {
      listBackgroundTasks: vi.fn(),
      stopBackgroundTask: stopContFn,
    };

    const mockResolver: RuntimeSpaceResolver = vi.fn().mockResolvedValue({
      handle: fakeContainerHandle,
      isHost: false,
      spaceFolder: 'container-folder',
    });

    const delegates = createBackgroundTaskDelegates(mockResolver);
    const result = await delegates.stopBackgroundTask({
      userId: syntheticContainerUser,
      platformSpaceId: syntheticContainerSpace,
      dshSessionId: syntheticContainerSession,
      taskId: syntheticTaskId,
    });

    expect(mockResolver).toHaveBeenCalledWith(syntheticContainerUser, syntheticContainerSpace);
    expect(stopContFn).toHaveBeenCalledWith(syntheticContainerSession, syntheticTaskId);
    expect(result).toEqual({ stopped: true });
  });

  it('5. falls back to rawHandle if top-level handle method is absent', async () => {
    const listRawFn = vi.fn().mockResolvedValue(hostTasks);
    const stopRawFn = vi.fn().mockResolvedValue({ stopped: true });
    const fakeWrappedHandle = {
      rawHandle: {
        listBackgroundTasks: listRawFn,
        stopBackgroundTask: stopRawFn,
      },
    };

    const mockResolver: RuntimeSpaceResolver = vi.fn().mockResolvedValue({
      handle: fakeWrappedHandle,
      isHost: true,
      spaceFolder: 'host-folder',
    });

    const delegates = createBackgroundTaskDelegates(mockResolver);

    const listResult = await delegates.listBackgroundTasks({
      userId: syntheticHostUser,
      platformSpaceId: syntheticHostSpace,
      dshSessionId: syntheticHostSession,
    });
    expect(listRawFn).toHaveBeenCalledWith(syntheticHostSession);
    expect(listResult).toEqual(hostTasks);

    const stopResult = await delegates.stopBackgroundTask({
      userId: syntheticHostUser,
      platformSpaceId: syntheticHostSpace,
      dshSessionId: syntheticHostSession,
      taskId: syntheticTaskId,
    });
    expect(stopRawFn).toHaveBeenCalledWith(syntheticHostSession, syntheticTaskId);
    expect(stopResult).toEqual({ stopped: true });
  });

  it('6. fail-closed validation for mandatory parameters', async () => {
    const mockResolver: RuntimeSpaceResolver = vi.fn();
    const delegates = createBackgroundTaskDelegates(mockResolver);

    await expect(
      delegates.listBackgroundTasks({
        userId: '',
        platformSpaceId: syntheticHostSpace,
        dshSessionId: syntheticHostSession,
      })
    ).rejects.toThrow('FAIL-CLOSED: Mandatory userId missing or empty');

    await expect(
      delegates.listBackgroundTasks({
        userId: syntheticHostUser,
        platformSpaceId: '  ',
        dshSessionId: syntheticHostSession,
      })
    ).rejects.toThrow('FAIL-CLOSED: Mandatory platformSpaceId missing or empty');

    await expect(
      delegates.listBackgroundTasks({
        userId: syntheticHostUser,
        platformSpaceId: syntheticHostSpace,
        dshSessionId: '',
      })
    ).rejects.toThrow('FAIL-CLOSED: Mandatory dshSessionId missing or empty');

    await expect(
      delegates.stopBackgroundTask({
        userId: syntheticHostUser,
        platformSpaceId: syntheticHostSpace,
        dshSessionId: syntheticHostSession,
        taskId: '',
      })
    ).rejects.toThrow('FAIL-CLOSED: Mandatory taskId missing or empty');
  });

  it('7. returns empty list or stopped: false when handle does not support background tasks', async () => {
    const fakeBareHandle = {};
    const mockResolver: RuntimeSpaceResolver = vi.fn().mockResolvedValue({
      handle: fakeBareHandle,
      isHost: false,
      spaceFolder: 'folder',
    });

    const delegates = createBackgroundTaskDelegates(mockResolver);

    const listRes = await delegates.listBackgroundTasks({
      userId: syntheticContainerUser,
      platformSpaceId: syntheticContainerSpace,
      dshSessionId: syntheticContainerSession,
    });
    expect(listRes).toEqual([]);

    const stopRes = await delegates.stopBackgroundTask({
      userId: syntheticContainerUser,
      platformSpaceId: syntheticContainerSpace,
      dshSessionId: syntheticContainerSession,
      taskId: syntheticTaskId,
    });
    expect(stopRes).toEqual({ stopped: false });
  });
});
