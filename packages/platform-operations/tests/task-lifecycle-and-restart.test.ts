import { describe, it, expect, beforeEach } from 'vitest';
import { FakePlatformOperationsStorage } from './support/index.js';
import { PlatformOperationsService } from '../src/services/platform-operations-service.js';
import {
  TaskAlreadyClaimedError,
  TaskAlreadyCompletedError,
  TaskAlreadyClaimedError as TaskClaimedOrConflictError,
  TaskNotFoundError,
} from '../src/errors/index.js';

describe('Task Lifecycle, Claim/Lease Semantics, Idempotency & Restart Recovery', () => {
  let storage: FakePlatformOperationsStorage;
  let service: PlatformOperationsService;

  const validSessionId = 'ses_0123456789abcdef0123456789abcdef';
  const validSpaceId = 'spc_0123456789abcdef0123456789abcdef';

  beforeEach(() => {
    storage = new FakePlatformOperationsStorage();
    service = new PlatformOperationsService({ storage });
  });

  it('guarantees at-most-once task creation idempotency via idempotencyKey', async () => {
    const ops = service.forTenant('user_1');
    const validUuid = '11111111-2222-4333-8444-555555555555';
    const payload = {
      type: 'agent_prompt' as const,
      prompt: 'Import Customer Data Prompt',
      sessionId: validSessionId,
      sessionPolicy: 'existing_session' as const,
    };

    const create1 = await ops.tasks.createTask({
      idempotencyKey: validUuid,
      title: 'Import Customer Data',
      priority: 'high',
      payload,
    });

    expect(create1.isIdempotentHit).toBe(false);
    expect(create1.task.idempotencyKey).toBe(validUuid);

    // Duplicate call with same idempotencyKey
    const create2 = await ops.tasks.createTask({
      idempotencyKey: validUuid,
      title: 'Import Customer Data (Duplicate attempt)',
      priority: 'low',
      payload,
    });

    expect(create2.isIdempotentHit).toBe(true);
    expect(create2.task.id).toBe(create1.task.id);
    expect(create2.task.title).toBe('Import Customer Data'); // Kept original

    const allTasks = await ops.tasks.listTasks();
    expect(allTasks).toHaveLength(1);
  });

  it('enforces exclusive execution via claim lease and prevents concurrent worker duplicate processing', async () => {
    const ops = service.forTenant('user_1');

    const { task } = await ops.tasks.createTask({
      title: 'Process Payment Batch',
      leaseDurationMs: 10_000,
      payload: {
        type: 'agent_prompt',
        prompt: 'Process payment batch prompt',
        sessionId: validSessionId,
        sessionPolicy: 'existing_session',
      },
    });

    // Worker 1 claims the task
    const claimedByW1 = await ops.tasks.claimTask({
      claimantId: 'worker_alpha',
      preferredTaskId: task.id,
    });

    expect(claimedByW1?.status).toBe('claimed');
    expect(claimedByW1?.claimantId).toBe('worker_alpha');

    // Worker 2 attempts to claim the same task while lease is active -> rejected
    await expect(
      ops.tasks.claimTask({
        claimantId: 'worker_beta',
        preferredTaskId: task.id,
      })
    ).rejects.toThrow(TaskAlreadyClaimedError);

    // Worker 2 searching for any available task gets null (since none are free)
    const claimedAny = await ops.tasks.claimTask({
      claimantId: 'worker_beta',
    });
    expect(claimedAny).toBeNull();
  });

  it('claims pending tasks strictly according to priority (urgent > high > medium > low)', async () => {
    const ops = service.forTenant('user_priority');
    const makePayload = (p: string) => ({
      type: 'agent_prompt' as const,
      prompt: `Prompt for ${p}`,
      sessionId: validSessionId,
      sessionPolicy: 'existing_session' as const,
    });

    await ops.tasks.createTask({ title: 'Low Task', priority: 'low', payload: makePayload('Low') });
    await ops.tasks.createTask({ title: 'Urgent Task', priority: 'urgent', payload: makePayload('Urgent') });
    await ops.tasks.createTask({ title: 'Medium Task', priority: 'medium', payload: makePayload('Medium') });
    await ops.tasks.createTask({ title: 'High Task', priority: 'high', payload: makePayload('High') });

    // Claim 1: should pick urgent
    const claim1 = await ops.tasks.claimTask({ claimantId: 'worker_1' });
    expect(claim1?.title).toBe('Urgent Task');

    // Claim 2: should pick high
    const claim2 = await ops.tasks.claimTask({ claimantId: 'worker_2' });
    expect(claim2?.title).toBe('High Task');

    // Claim 3: should pick medium
    const claim3 = await ops.tasks.claimTask({ claimantId: 'worker_3' });
    expect(claim3?.title).toBe('Medium Task');

    // Claim 4: should pick low
    const claim4 = await ops.tasks.claimTask({ claimantId: 'worker_4' });
    expect(claim4?.title).toBe('Low Task');

    // Claim 5: queue empty -> null
    const claim5 = await ops.tasks.claimTask({ claimantId: 'worker_5' });
    expect(claim5).toBeNull();
  });

  it('supports lease heartbeat renewal and successful completion', async () => {
    const ops = service.forTenant('user_1');

    const { task } = await ops.tasks.createTask({
      title: 'Long Running Backup',
      leaseDurationMs: 5_000,
      payload: {
        type: 'agent_prompt',
        prompt: 'Long running backup prompt',
        sessionId: validSessionId,
        sessionPolicy: 'existing_session',
      },
    });

    await ops.tasks.claimTask({
      claimantId: 'worker_alpha',
      preferredTaskId: task.id,
      leaseDurationMs: 5_000,
    });

    // Worker alpha extends lease
    const renewed = await ops.tasks.renewLease(task.id, {
      claimantId: 'worker_alpha',
      leaseDurationMs: 15_000,
    });

    expect(renewed.leaseDurationMs).toBe(15_000);

    const nowIso = new Date().toISOString();
    const validResult = {
      status: 'completed' as const,
      completedAt: nowIso,
    };

    // Wrong worker cannot complete task
    await expect(
      ops.tasks.completeTask(task.id, {
        claimantId: 'worker_imposter',
        result: validResult,
      })
    ).rejects.toThrow();

    // Worker alpha completes task successfully
    const completed = await ops.tasks.completeTask(task.id, {
      claimantId: 'worker_alpha',
      result: validResult,
    });

    expect(completed.status).toBe('completed');
    expect(completed.result).toEqual(validResult);
    expect(completed.completedAt).toBeDefined();

    // Cannot re-complete or fail after completion
    await expect(
      ops.tasks.failTask(task.id, {
        claimantId: 'worker_alpha',
        error: 'Too late',
      })
    ).rejects.toThrow(TaskAlreadyCompletedError);
  });

  it('recovers crashed worker tasks upon lease expiry and respects maxRetries', async () => {
    const ops = service.forTenant('user_1');

    const { task } = await ops.tasks.createTask({
      title: 'Flaky Integration Job',
      leaseDurationMs: 1_000,
      maxRetries: 2,
      payload: {
        type: 'agent_prompt',
        prompt: 'Flaky integration prompt',
        sessionId: validSessionId,
        sessionPolicy: 'existing_session',
      },
    });

    // Worker 1 claims task and crashes
    await ops.tasks.claimTask({
      claimantId: 'worker_crashed_1',
      preferredTaskId: task.id,
      leaseDurationMs: 1_000,
    });

    // 2 seconds later (worker 1 lease expired), restart recovery sweep runs
    const futureTimeIso = new Date(Date.now() + 2_000).toISOString();
    const sweep1 = await service.recoverAfterRestart({ nowIso: futureTimeIso });

    expect(sweep1.recoveredTasks).toBe(1);

    const reloaded1 = await ops.tasks.getTask(task.id);
    expect(reloaded1?.status).toBe('pending'); // Reset to pending for retry
    expect(reloaded1?.claimCount).toBe(1);

    // Worker 2 claims it for retry #2 and also crashes
    await ops.tasks.claimTask({
      claimantId: 'worker_crashed_2',
      preferredTaskId: task.id,
      leaseDurationMs: 1_000,
    });

    // Another sweep after second lease expiration
    const futureTime2Iso = new Date(Date.now() + 5_000).toISOString();
    const sweep2 = await service.recoverAfterRestart({ nowIso: futureTime2Iso });
    expect(sweep2.recoveredTasks).toBe(1);

    const reloaded2 = await ops.tasks.getTask(task.id);
    // Max retries (2) reached -> task is marked failed permanently
    expect(reloaded2?.status).toBe('failed');
    expect(reloaded2?.claimCount).toBe(2);
    expect(reloaded2?.error).toContain('max retries exhausted');
  });

  it('performs multi-tenant crash recovery across all tenants in a single sweep', async () => {
    const aliceOps = service.forTenant('tenant_alice');
    const bobOps = service.forTenant('tenant_bob');

    const { task: tAlice } = await aliceOps.tasks.createTask({
      title: 'Alice Job',
      leaseDurationMs: 500,
      payload: {
        type: 'agent_prompt',
        prompt: 'Alice job prompt',
        sessionId: validSessionId,
        sessionPolicy: 'existing_session',
      },
    });
    const { task: tBob } = await bobOps.tasks.createTask({
      title: 'Bob Job',
      leaseDurationMs: 500,
      payload: {
        type: 'agent_prompt',
        prompt: 'Bob job prompt',
        sessionId: validSessionId,
        sessionPolicy: 'existing_session',
      },
    });

    // Both get claimed and then workers crash
    await aliceOps.tasks.claimTask({ claimantId: 'worker_a', preferredTaskId: tAlice.id, leaseDurationMs: 500 });
    await bobOps.tasks.claimTask({ claimantId: 'worker_b', preferredTaskId: tBob.id, leaseDurationMs: 500 });

    const futureIso = new Date(Date.now() + 1000).toISOString();
    const sweep = await service.recoverAfterRestart({ nowIso: futureIso });

    expect(sweep.recoveredTasks).toBe(2);

    const aliceCheck = await aliceOps.tasks.getTask(tAlice.id);
    const bobCheck = await bobOps.tasks.getTask(tBob.id);

    expect(aliceCheck?.status).toBe('pending');
    expect(bobCheck?.status).toBe('pending');
  });
});
