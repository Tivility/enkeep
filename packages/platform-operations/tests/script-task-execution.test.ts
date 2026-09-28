import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakePlatformOperationsStorage } from './support/index.js';
import { PlatformOperationsService } from '../src/services/platform-operations-service.js';
import {
  AgentPromptTaskWorker,
  TASK_PROTOCOL_ERROR_CODES,
  type ScriptTaskPayload,
  type ScriptTaskDispatchResult,
} from '../src/index.js';

describe('Script Task Execution via Task Worker (0-Token, Exit Codes, Timeout, CWD)', () => {
  let storage: FakePlatformOperationsStorage;
  let service: PlatformOperationsService;
  let activeWorkers: AgentPromptTaskWorker[] = [];

  const validSpaceId = 'spc_0123456789abcdef0123456789abcdef';

  beforeEach(() => {
    storage = new FakePlatformOperationsStorage();
    service = new PlatformOperationsService({ storage });
    activeWorkers = [];
  });

  afterEach(async () => {
    for (const w of activeWorkers) {
      await w.stop({ abortInFlight: true });
    }
  });

  function createWorker(options?: {
    resolveSpaceCwd?: (params: { tenantId: string; spaceId: string; spaceFolder?: string }) => Promise<string> | string;
    runScript?: any;
    leaseDurationMs?: number;
    heartbeatIntervalMs?: number;
  }) {
    const worker = new AgentPromptTaskWorker({
      tenantEnumerator: () => ['user_admin'],
      getTenantOperations: (tenantId) => service.forTenant(tenantId),
      dispatcher: async () => {
        throw new Error('LLM Agent dispatcher should NEVER be called for script tasks (violates 0-token spec)');
      },
      resolveSpaceCwd: options?.resolveSpaceCwd ?? (() => process.cwd()),
      runScript: options?.runScript,
      leaseDurationMs: options?.leaseDurationMs ?? 5000,
      heartbeatIntervalMs: options?.heartbeatIntervalMs ?? 500,
      pollIntervalMs: 50,
      recoverOnStart: false,
    });
    activeWorkers.push(worker);
    return worker;
  }

  it('executes host shell command directly without invoking LLM, achieves 0 tokens and captures stdout/exit code 0', async () => {
    const ops = service.forTenant('user_admin');
    const { task } = await ops.tasks.createTask({
      title: 'Host Health Check Script',
      payload: {
        type: 'script',
        command: 'echo "{\\"status\\":\\"healthy\\",\\"code\\":0}"',
        spaceId: validSpaceId,
      } as ScriptTaskPayload,
    });

    const worker = createWorker();
    const tickResult = await worker.tick();

    expect(tickResult.processed).toBe(true);
    expect(tickResult.taskId).toBe(task.id);
    expect(tickResult.status).toBe('completed');

    const result = tickResult.result as ScriptTaskDispatchResult;
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('{"status":"healthy","code":0}');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const completedTask = await ops.tasks.getTask(task.id);
    expect(completedTask?.status).toBe('completed');
    expect(completedTask?.result).toMatchObject({
      status: 'completed',
      exitCode: 0,
    });

    // Verify 0-Token invariant
    const runsRes = await (storage.forTenant('user_admin').tasks as any).listRuns(task.id);
    const runs = runsRes.items || runsRes;
    expect(runs.length).toBe(1);
    expect(runs[0].promptTokens).toBe(0);
    expect(runs[0].completionTokens).toBe(0);
    expect(runs[0].totalTokens).toBe(0);
  });

  it('records non-zero exit code and captures stderr', async () => {
    const ops = service.forTenant('user_admin');
    const { task } = await ops.tasks.createTask({
      title: 'Failing Script Task',
      payload: {
        type: 'script',
        command: '/bin/sh -c "echo \\"diagnostic failure\\" >&2; exit 42"',
        spaceId: validSpaceId,
      } as ScriptTaskPayload,
    });

    const worker = createWorker();
    const tickResult = await worker.tick();

    expect(tickResult.processed).toBe(true);
    expect(tickResult.status).toBe('completed');

    const result = tickResult.result as ScriptTaskDispatchResult;
    expect(result.exitCode).toBe(42);
    expect(result.stderr.trim()).toContain('diagnostic failure');

    // 0-token guarantee even for non-zero exit codes
    const runsRes = await (storage.forTenant('user_admin').tasks as any).listRuns(task.id);
    const runs = runsRes.items || runsRes;
    expect(runs[0].totalTokens).toBe(0);
  });

  it('enforces script timeout and terminates hung process tree with SIGKILL', async () => {
    const ops = service.forTenant('user_admin');
    const { task } = await ops.tasks.createTask({
      title: 'Hung Script Task',
      payload: {
        type: 'script',
        command: '/bin/sh -c "sleep 30"',
        spaceId: validSpaceId,
        timeoutMs: 300, // 300ms timeout
      } as ScriptTaskPayload,
    });

    const worker = createWorker();
    const tickResult = await worker.tick();

    expect(tickResult.processed).toBe(true);
    expect(tickResult.status).toBe('failed');
    expect(tickResult.error).toBe(TASK_PROTOCOL_ERROR_CODES.EXECUTION_FAILED);

    const failedTask = await ops.tasks.getTask(task.id);
    expect(failedTask?.status).toBe('failed');
    expect(failedTask?.error).toContain('timed out');
  });

  it('truncates stdout and stderr to 1MB ceiling to prevent buffer overflow', async () => {
    const ops = service.forTenant('user_admin');
    // Generate ~1.5MB output
    const { task } = await ops.tasks.createTask({
      title: 'Huge Output Script Task',
      payload: {
        type: 'script',
        command: 'node -e "process.stdout.write(\'X\'.repeat(1500000))"',
        spaceId: validSpaceId,
      } as ScriptTaskPayload,
    });

    const worker = createWorker();
    const tickResult = await worker.tick();

    expect(tickResult.processed).toBe(true);
    expect(tickResult.status).toBe('completed');

    const result = tickResult.result as ScriptTaskDispatchResult;
    expect(result.stdout.length).toBeLessThanOrEqual(1024 * 1024);
  });

  it('fails execution if space resolution fails (e.g. container mode rejected)', async () => {
    const ops = service.forTenant('user_admin');
    const { task } = await ops.tasks.createTask({
      title: 'Container Space Script Rejection Task',
      payload: {
        type: 'script',
        command: 'echo "should not run"',
        spaceId: validSpaceId,
      } as ScriptTaskPayload,
    });

    const worker = createWorker({
      resolveSpaceCwd: () => {
        throw new Error('Script tasks can only execute in host mode spaces (container mode rejected)');
      },
    });

    const tickResult = await worker.tick();
    expect(tickResult.processed).toBe(true);
    expect(tickResult.status).toBe('failed');
    expect(tickResult.error).toBe(TASK_PROTOCOL_ERROR_CODES.EXECUTION_FAILED);

    const failedTask = await ops.tasks.getTask(task.id);
    expect(failedTask?.status).toBe('failed');
    expect(failedTask?.error).toContain('container mode rejected');
  });
});
