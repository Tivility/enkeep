import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import {
  SqlitePlatformStorage,
  SqlitePlatformOperationsStorage,
} from '@enkeep/platform-storage-sqlite';
import {
  PipelineTaskInputPreparerService,
  type PipelinePreparationRegistration,
} from '../src/tasks/pipeline-input-preparer.js';
import {
  AgentPromptTaskWorker,
} from '@enkeep/platform-operations';

describe('Pipeline Task Input Preparer Service & Staging Contract', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let operationsStorage: SqlitePlatformOperationsStorage;

  const tenantAlice = 'usr_alice_pipe';
  const tenantBob = 'usr_bob_pipe';
  const aliceSpaceId = 'spc_11111111111111111111111111111111';
  const bobSpaceId = 'spc_22222222222222222222222222222222';
  const aliceSessionId = 'ses_11111111111111111111111111111111';

  const writtenFiles: Map<string, string> = new Map();
  let failFileWrite = false;

  const fakeFileService = {
    execute: async (userId: string, spaceId: string, req: any) => {
      const key = `${userId}:${spaceId}:${req.path}`;
      if (req.op === 'read') {
        if (writtenFiles.has(key)) {
          return { op: 'read', path: req.path, content: writtenFiles.get(key)!, encoding: 'utf8' };
        }
        throw new Error(`File not found: ${req.path}`);
      }
      if (req.op === 'write') {
        if (failFileWrite) {
          throw new Error('Disk quota exceeded during pipeline input staging');
        }
        writtenFiles.set(key, req.content);
        return { op: 'write', path: req.path, size: req.content.length };
      }
      throw new Error(`Unsupported op: ${req.op}`);
    },
  };

  beforeEach(async () => {
    writtenFiles.clear();
    failFileWrite = false;

    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    operationsStorage = new SqlitePlatformOperationsStorage(db);

    await storage.users.create({
      id: tenantAlice,
      username: 'alice_pipe',
      passwordHash: 'hash',
      role: 'admin',
      status: 'active',
    });
    await storage.users.create({
      id: tenantBob,
      username: 'bob_pipe',
      passwordHash: 'hash',
      role: 'user',
      status: 'active',
    });

    await storage.forTenant(tenantAlice).spaces.create({
      id: aliceSpaceId,
      name: 'Alice Pipe Space',
      folder: 'space-alice-pipe',
      executionMode: 'host',
    });
    await storage.forTenant(tenantAlice).sessionRoutes.create({
      id: aliceSessionId,
      spaceId: aliceSpaceId,
      channel: 'web',
      accountId: 'web-user',
      nativeContextId: aliceSessionId,
      peerId: 'peer_alice',
      dshSessionId: 'ses_1234567890abcdef1234567890abcdef',
      executionMode: 'host',
    });

    const bobSessionId = 'ses_22222222222222222222222222222222';
    await storage.forTenant(tenantBob).spaces.create({
      id: bobSpaceId,
      name: 'Bob Pipe Space',
      folder: 'space-bob-pipe',
      executionMode: 'host',
    });
    await storage.forTenant(tenantBob).sessionRoutes.create({
      id: bobSessionId,
      spaceId: bobSpaceId,
      channel: 'web',
      accountId: 'web-user',
      nativeContextId: bobSessionId,
      peerId: 'peer_bob',
      dshSessionId: 'ses_234567890abcdef1234567890abcdef1',
      executionMode: 'host',
    });

    // Populate Alice messages in web_messages with same-millisecond timestamps
    const nowIso = '2026-09-10T12:00:00.000Z';
    db.prepare(`
      INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, turn_id, created_at)
      VALUES
        ('msg_0001', ?, ?, 'user', 'Record 1 at t0', 'delivered', 'rt_1', 'turn_1', ?),
        ('msg_0002', ?, ?, 'assistant', 'Reply 1 at t0', 'delivered', 'rt_1', 'turn_1', ?),
        ('msg_0003', ?, ?, 'user', 'Record 2 at t0', 'delivered', 'rt_1', 'turn_2', ?)
    `).run(aliceSessionId, tenantAlice, nowIso, aliceSessionId, tenantAlice, nowIso, aliceSessionId, tenantAlice, nowIso);

    // Populate Bob message in web_messages (tenant isolation check)
    db.prepare(`
      INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, turn_id, created_at)
      VALUES ('msg_bob_0001', ?, ?, 'user', 'SECRET BOB DATA', 'delivered', 'rt_bob', 'turn_b', ?)
    `).run(bobSessionId, tenantBob, nowIso);
  });

  it('1. Prepares immutable per-run input path and prepends location guidance without mutating business prompt', async () => {
    const preparer = new PipelineTaskInputPreparerService({
      database: db,
      fileService: fakeFileService as any,
    });

    const pipelineTaskId = 'task_00000000000000000000000000000001';
    preparer.registerCapability(pipelineTaskId, {
      capability: 'pipeline_observation',
      checkpointPath: 'pipeline/.cognitive-last-checkpoint',
      stagedInputPrefix: 'pipeline/inputs',
    });

    const originalPrompt = 'Extract observations from staged records';
    const payload = {
      type: 'agent_prompt' as const,
      prompt: originalPrompt,
      sessionId: aliceSessionId,
      sessionPolicy: 'existing_session' as const,
      spaceId: aliceSpaceId,
      spaceFolder: 'space-alice-pipe',
      silent: true,
    };

    const runId = 'run_11111111111111111111111111111111';
    const result = await preparer.prepare({
      task: { id: pipelineTaskId } as any,
      payload,
      tenantId: tenantAlice,
      runId,
      signal: new AbortController().signal,
    });

    expect(result).toBeDefined();
    expect(result?.stagedPath).toBe(`pipeline/inputs/${runId}/input.json`);
    expect(result?.preparedPrompt).toContain(`[Staged Pipeline Input Location: pipeline/inputs/${runId}/input.json]`);
    expect(result?.preparedPrompt).toContain(originalPrompt);

    // Verify stored business prompt in payload is unchanged
    expect(payload.prompt).toBe(originalPrompt);

    // Verify staged file content in fake file service
    const fileKey = `${tenantAlice}:${aliceSpaceId}:pipeline/inputs/${runId}/input.json`;
    expect(writtenFiles.has(fileKey)).toBe(true);

    const envelope = JSON.parse(writtenFiles.get(fileKey)!);
    expect(envelope.schemaVersion).toBe('1.0.0');
    expect(envelope.taskRunId).toBe(runId);
    expect(envelope.capability).toBe('pipeline_observation');
    expect(envelope.recordsCount).toBe(3);
    expect(envelope.records.map((r: any) => r.id)).toEqual(['msg_0001', 'msg_0002', 'msg_0003']);

    // Tenant isolation: Bob's message MUST NOT be present
    expect(writtenFiles.get(fileKey)).not.toContain('SECRET BOB DATA');
  });

  it('2. Distinct concurrent taskRunIds write to separate immutable paths without overwrite race', async () => {
    const preparer = new PipelineTaskInputPreparerService({
      database: db,
      fileService: fakeFileService as any,
    });

    const pipelineTaskId = 'task_00000000000000000000000000000002';
    preparer.registerCapability(pipelineTaskId, {
      capability: 'pipeline_observation',
    });

    const payload = {
      type: 'agent_prompt' as const,
      prompt: 'Observation prompt',
      sessionId: aliceSessionId,
      sessionPolicy: 'existing_session' as const,
      spaceId: aliceSpaceId,
    };

    const run1 = 'run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const run2 = 'run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    const [res1, res2] = await Promise.all([
      preparer.prepare({ task: { id: pipelineTaskId } as any, payload, tenantId: tenantAlice, runId: run1, signal: new AbortController().signal }),
      preparer.prepare({ task: { id: pipelineTaskId } as any, payload, tenantId: tenantAlice, runId: run2, signal: new AbortController().signal }),
    ]);

    expect(res1?.stagedPath).toBe(`pipeline/inputs/${run1}/input.json`);
    expect(res2?.stagedPath).toBe(`pipeline/inputs/${run2}/input.json`);
    expect(res1?.stagedPath).not.toBe(res2?.stagedPath);

    expect(writtenFiles.has(`${tenantAlice}:${aliceSpaceId}:pipeline/inputs/${run1}/input.json`)).toBe(true);
    expect(writtenFiles.has(`${tenantAlice}:${aliceSpaceId}:pipeline/inputs/${run2}/input.json`)).toBe(true);
  });

  it('3. Checkpoint read with same-millisecond watermark handles boundary without gaps or duplicates', async () => {
    // Write an existing checkpoint at msg_0001
    const checkpointKey = `${tenantAlice}:${aliceSpaceId}:pipeline/.cognitive-last-checkpoint`;
    writtenFiles.set(checkpointKey, JSON.stringify({
      lastCreatedAt: '2026-09-10T12:00:00.000Z',
      lastId: 'msg_0001',
    }));

    const preparer = new PipelineTaskInputPreparerService({
      database: db,
      fileService: fakeFileService as any,
    });

    const pipelineTaskId = 'task_00000000000000000000000000000003';
    preparer.registerCapability(pipelineTaskId, {
      capability: 'pipeline_observation',
    });

    const res = await preparer.prepare({
      task: { id: pipelineTaskId } as any,
      payload: {
        type: 'agent_prompt',
        prompt: 'Run after checkpoint',
        sessionId: aliceSessionId,
        sessionPolicy: 'existing_session',
        spaceId: aliceSpaceId,
      },
      tenantId: tenantAlice,
      runId: 'run_checkpoint_test_0000000000001',
      signal: new AbortController().signal,
    });

    const fileKey = `${tenantAlice}:${aliceSpaceId}:${res?.stagedPath}`;
    const envelope = JSON.parse(writtenFiles.get(fileKey)!);

    // msg_0001 was the checkpoint watermark -> records must start at msg_0002 (no gap, no duplicate msg_0001)
    expect(envelope.recordsCount).toBe(2);
    expect(envelope.records.map((r: any) => r.id)).toEqual(['msg_0002', 'msg_0003']);
    expect(envelope.window.checkpointWatermark).toEqual({
      createdAt: '2026-09-10T12:00:00.000Z',
      id: 'msg_0003',
    });

    // Verify checkpoint file itself was NOT advanced by preparation
    const postPrepCheckpoint = JSON.parse(writtenFiles.get(checkpointKey)!);
    expect(postPrepCheckpoint.lastId).toBe('msg_0001');
  });

  it('4. Ordinary non-pipeline tasks are a clean no-op preserving prompt and performing no file writes', async () => {
    const preparer = new PipelineTaskInputPreparerService({
      database: db,
      fileService: fakeFileService as any,
    });

    // Unregistered task
    const ordinaryTaskId = 'task_00000000000000000000000000000099';
    const originalPrompt = 'Standard reminder prompt';
    const payload = {
      type: 'agent_prompt' as const,
      prompt: originalPrompt,
      sessionId: aliceSessionId,
      sessionPolicy: 'existing_session' as const,
      spaceId: aliceSpaceId,
    };

    const res = await preparer.prepare({
      task: { id: ordinaryTaskId } as any,
      payload,
      tenantId: tenantAlice,
      runId: 'run_ordinary_000000000000000000001',
      signal: new AbortController().signal,
    });

    // Clean no-op
    expect(res).toBeUndefined();
    expect(payload.prompt).toBe(originalPrompt);
    expect(writtenFiles.size).toBe(0);
  });

  it('5. Failed preparation halts execution, stops heartbeat, fails task without LLM dispatch', async () => {
    failFileWrite = true; // Simulate disk failure during write

    const preparer = new PipelineTaskInputPreparerService({
      database: db,
      fileService: fakeFileService as any,
    });

    const pipelineTaskId = 'task_00000000000000000000000000000005';
    preparer.registerCapability(pipelineTaskId, {
      capability: 'pipeline_observation',
    });

    let dispatcherCalled = false;
    const mockDispatcher = async () => {
      dispatcherCalled = true;
      return { status: 'completed' as const, completedAt: new Date().toISOString() };
    };

    const ops = operationsStorage.forTenant(tenantAlice);
    const createdTask = await ops.tasks.create({
      id: pipelineTaskId,
      title: 'Failing Prep Task',
      priority: 'high',
      payload: {
        type: 'agent_prompt',
        prompt: 'Observation prompt',
        sessionId: aliceSessionId,
        sessionPolicy: 'existing_session',
        spaceId: aliceSpaceId,
      },
    });

    const worker = new AgentPromptTaskWorker({
      dispatcher: mockDispatcher,
      prepareTaskInput: preparer.asPreparerHook(),
      tenantEnumerator: () => [tenantAlice],
      getTenantOperations: () => ({ tasks: ops.tasks, quota: ops.quota }),
      pollIntervalMs: 50,
      db,
    });

    const tickResult = await worker.tick();
    expect(tickResult.processed).toBe(true);
    expect(tickResult.status).toBe('failed');

    // CRITICAL: Dispatcher (LLM) was NEVER called
    expect(dispatcherCalled).toBe(false);

    // Task marked failed in repo
    const reloaded = await ops.tasks.findById(pipelineTaskId);
    expect(reloaded?.status).toBe('failed');
  });

  it('6. Missing required pipeline binding fails closed without LLM dispatch', async () => {
    const preparer = new PipelineTaskInputPreparerService({
      database: db,
      fileService: fakeFileService as any,
    });

    const requiredTaskId = 'task_00000000000000000000000000000006';
    preparer.markRequired(requiredTaskId); // marked required but no registration provided

    let dispatcherCalled = false;
    const mockDispatcher = async () => {
      dispatcherCalled = true;
      return { status: 'completed' as const, completedAt: new Date().toISOString() };
    };

    const ops = operationsStorage.forTenant(tenantAlice);
    await ops.tasks.create({
      id: requiredTaskId,
      title: 'Unbound Required Task',
      priority: 'high',
      payload: {
        type: 'agent_prompt',
        prompt: 'Should fail closed',
        sessionId: aliceSessionId,
        sessionPolicy: 'existing_session',
      },
    });

    const worker = new AgentPromptTaskWorker({
      dispatcher: mockDispatcher,
      prepareTaskInput: preparer.asPreparerHook(),
      tenantEnumerator: () => [tenantAlice],
      getTenantOperations: () => ({ tasks: ops.tasks, quota: ops.quota }),
      pollIntervalMs: 50,
      db,
    });

    const tickResult = await worker.tick();
    expect(tickResult.processed).toBe(true);
    expect(tickResult.status).toBe('failed');
    expect(dispatcherCalled).toBe(false);

    const reloaded = await ops.tasks.findById(requiredTaskId);
    expect(reloaded?.status).toBe('failed');
  });

  it('7. >1000 records triggers explicit DATA_OVER_CAP failure with zero LLM dispatch and zero checkpoint advance', async () => {
    // Populate 1005 messages in Alice space
    const insertStmt = db.prepare(`
      INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, turn_id, created_at)
      VALUES (?, ?, ?, 'user', 'Record overflow', 'delivered', 'rt_1', 'turn_x', '2026-09-10T13:00:00.000Z')
    `);

    for (let i = 10; i < 1015; i++) {
      insertStmt.run(`msg_overflow_${String(i).padStart(5, '0')}`, aliceSessionId, tenantAlice);
    }

    const preparer = new PipelineTaskInputPreparerService({
      database: db,
      fileService: fakeFileService as any,
    });

    const pipelineTaskId = 'task_00000000000000000000000000000007';
    preparer.registerCapability(pipelineTaskId, {
      capability: 'pipeline_observation',
      maxRecordsLimit: 1000,
    });

    await expect(
      preparer.prepare({
        task: { id: pipelineTaskId } as any,
        payload: {
          type: 'agent_prompt',
          prompt: 'Over cap prompt',
          sessionId: aliceSessionId,
          sessionPolicy: 'existing_session',
          spaceId: aliceSpaceId,
        },
        tenantId: tenantAlice,
        runId: 'run_overcap_test_000000000001',
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/\[DATA_OVER_CAP\]/i);
  });

  it('8. Foreign space messages are strictly excluded when sourceSpaceIds is configured', async () => {
    // Create another space for Alice (foreign space)
    const foreignSpaceId = 'spc_33333333333333333333333333333333';
    const foreignSessionId = 'ses_33333333333333333333333333333333';
    await storage.forTenant(tenantAlice).spaces.create({
      id: foreignSpaceId,
      name: 'Foreign Alice Space',
      folder: 'space-foreign',
      executionMode: 'host',
    });
    await storage.forTenant(tenantAlice).sessionRoutes.create({
      id: foreignSessionId,
      spaceId: foreignSpaceId,
      channel: 'web',
      accountId: 'web-user',
      nativeContextId: foreignSessionId,
      peerId: 'peer_foreign',
      dshSessionId: 'ses_34567890abcdef1234567890abcdef12',
      executionMode: 'host',
    });

    db.prepare(`
      INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, turn_id, created_at)
      VALUES ('msg_foreign_001', ?, ?, 'user', 'FOREIGN SPACE SECRET', 'delivered', 'rt_f', 'turn_f', '2026-09-10T12:05:00.000Z')
    `).run(foreignSessionId, tenantAlice);

    const preparer = new PipelineTaskInputPreparerService({
      database: db,
      fileService: fakeFileService as any,
    });

    const pipelineTaskId = 'task_00000000000000000000000000000008';
    preparer.registerCapability(pipelineTaskId, {
      capability: 'pipeline_observation',
      targetSpaceId: aliceSpaceId,
      sourceSpaceIds: [aliceSpaceId], // strictly aliceSpaceId only (exclude foreignSpaceId)
    });

    const res = await preparer.prepare({
      task: { id: pipelineTaskId } as any,
      payload: {
        type: 'agent_prompt',
        prompt: 'Scoped prompt',
        sessionId: aliceSessionId,
        sessionPolicy: 'existing_session',
      },
      tenantId: tenantAlice,
      runId: 'run_scoped_00000000000000000001',
      signal: new AbortController().signal,
    });

    const fileKey = `${tenantAlice}:${aliceSpaceId}:${res?.stagedPath}`;
    expect(writtenFiles.has(fileKey)).toBe(true);
    expect(writtenFiles.get(fileKey)).not.toContain('FOREIGN SPACE SECRET');
  });

  it('9. Appended new data retry is byte-identical without overwriting existing run input', async () => {
    const preparer = new PipelineTaskInputPreparerService({
      database: db,
      fileService: fakeFileService as any,
    });

    const pipelineTaskId = 'task_00000000000000000000000000000009';
    preparer.registerCapability(pipelineTaskId, {
      capability: 'pipeline_observation',
      targetSpaceId: aliceSpaceId,
      sourceSpaceIds: [aliceSpaceId],
    });

    const runId = 'run_immutable_0000000000000001';
    const payload = {
      type: 'agent_prompt' as const,
      prompt: 'Immutability test prompt',
      sessionId: aliceSessionId,
      sessionPolicy: 'existing_session' as const,
    };

    // First run creates input
    const res1 = await preparer.prepare({
      task: { id: pipelineTaskId } as any,
      payload,
      tenantId: tenantAlice,
      runId,
      signal: new AbortController().signal,
    });

    const fileKey = `${tenantAlice}:${aliceSpaceId}:${res1?.stagedPath}`;
    const firstContent = writtenFiles.get(fileKey);

    // Insert new messages into database for same session
    db.prepare(`
      INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, turn_id, created_at)
      VALUES ('msg_late_001', ?, ?, 'user', 'LATE INCOMING DATA', 'delivered', 'rt_late', 'turn_l', '2026-09-10T12:30:00.000Z')
    `).run(aliceSessionId, tenantAlice);

    // Retry preparation for exact same runId
    const res2 = await preparer.prepare({
      task: { id: pipelineTaskId } as any,
      payload,
      tenantId: tenantAlice,
      runId,
      signal: new AbortController().signal,
    });

    const secondContent = writtenFiles.get(fileKey);

    // Content MUST remain byte-identical (no overwrite with late data)
    expect(secondContent).toBe(firstContent);
    expect(secondContent).not.toContain('LATE INCOMING DATA');
  });

  it('10. Path traversal in stagedInputPrefix or checkpointPath is rejected with zero writes', async () => {
    const preparer = new PipelineTaskInputPreparerService({
      database: db,
      fileService: fakeFileService as any,
    });

    const pipelineTaskId = 'task_00000000000000000000000000000010';
    preparer.registerCapability(pipelineTaskId, {
      capability: 'pipeline_observation',
      stagedInputPrefix: '../../etc',
    });

    await expect(
      preparer.prepare({
        task: { id: pipelineTaskId } as any,
        payload: {
          type: 'agent_prompt',
          prompt: 'Traversal test',
          sessionId: aliceSessionId,
          sessionPolicy: 'existing_session',
          spaceId: aliceSpaceId,
        },
        tenantId: tenantAlice,
        runId: 'run_traversal_test_00000000001',
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/path traversal/i);

    // Rejects encoded traversal %2e%2e
    preparer.registerCapability(pipelineTaskId, {
      capability: 'pipeline_observation',
      stagedInputPrefix: '%2e%2e/evil',
    });

    await expect(
      preparer.prepare({
        task: { id: pipelineTaskId } as any,
        payload: {
          type: 'agent_prompt',
          prompt: 'Encoded traversal test',
          sessionId: aliceSessionId,
          sessionPolicy: 'existing_session',
          spaceId: aliceSpaceId,
        },
        tenantId: tenantAlice,
        runId: 'run_traversal_test_00000000002',
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/path traversal/i);
  });
});
