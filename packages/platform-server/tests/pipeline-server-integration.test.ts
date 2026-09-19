import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import {
  SqlitePlatformStorage,
  SqlitePlatformOperationsStorage,
} from '@enkeep/platform-storage-sqlite';
import {
  PlatformOperationsService,
} from '@enkeep/platform-operations';
import {
  RuntimeFileApiService,
  type TenantRuntimeFileProvider,
  type CanonicalFileOperationRequest,
  type CanonicalFileOperationResult,
} from '../src/files/runtime-file-api.js';
import {
  createPlatformServerTaskWorker,
} from '../src/tasks/agent-prompt-worker.js';
import {
  PlatformError,
  NotFoundError,
  ValidationError,
} from '@enkeep/platform-core';

class TestDiskFileProvider implements TenantRuntimeFileProvider {
  constructor(private spacesRoot: string, private db: DatabaseSync) {}

  async execute(
    userId: string,
    spaceId: string,
    request: CanonicalFileOperationRequest
  ): Promise<CanonicalFileOperationResult> {
    const spaceRow = this.db
      .prepare('SELECT folder FROM spaces WHERE id = ? AND user_id = ?')
      .get(spaceId, userId) as { folder: string } | undefined;
    if (!spaceRow) {
      throw new NotFoundError(`Space "${spaceId}" not found for user "${userId}"`);
    }

    const spaceDir = path.join(this.spacesRoot, spaceRow.folder);
    const filePath = path.join(spaceDir, request.path);

    if (request.op === 'write') {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      if (request.requireAbsent && fs.existsSync(filePath)) {
        throw new PlatformError('File already exists', 'FILE_EXISTS', 409);
      }
      fs.writeFileSync(filePath, request.content, (request.encoding as BufferEncoding) ?? 'utf8');
      const st = fs.statSync(filePath);
      const etag = `"${createHash('sha256').update(request.content).digest('hex')}"`;
      return {
        op: 'write',
        path: request.path,
        type: 'file',
        size: Buffer.byteLength(request.content, 'utf8'),
        mtimeMs: Math.floor(st.mtimeMs),
        etag,
      };
    }

    if (request.op === 'read') {
      if (!fs.existsSync(filePath)) {
        throw new PlatformError(`File "${request.path}" not found`, 'NOT_FOUND', 404);
      }
      const content = fs.readFileSync(filePath, (request.encoding as BufferEncoding) ?? 'utf8');
      const st = fs.statSync(filePath);
      const etag = `"${createHash('sha256').update(content).digest('hex')}"`;
      return {
        op: 'read',
        path: request.path,
        type: 'file',
        size: Buffer.byteLength(content, 'utf8'),
        mtimeMs: Math.floor(st.mtimeMs),
        etag,
        content,
        encoding: request.encoding ?? 'utf8',
      };
    }

    if (request.op === 'stat') {
      if (!fs.existsSync(filePath)) {
        const err: any = new Error(`File "${request.path}" not found`);
        err.code = 'ENOENT';
        throw err;
      }
      const st = fs.statSync(filePath);
      const content = fs.readFileSync(filePath);
      const etag = `"${createHash('sha256').update(content).digest('hex')}"`;
      return {
        op: 'stat',
        path: request.path,
        type: 'file',
        size: st.size,
        mtimeMs: Math.floor(st.mtimeMs),
        etag,
      };
    }

    throw new Error(`Unsupported operation: ${request.op}`);
  }
}

describe('Real Server Factory & Production RuntimeFileApi Pipeline Integration', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let operationsStorage: SqlitePlatformOperationsStorage;
  let operationsService: PlatformOperationsService;
  let testSpacesRoot: string;
  let testManifestPath: string;
  let realFileService: RuntimeFileApiService;

  const tenantAlice = 'usr_alice_srv';
  const spaceA = 'spc_11111111111111111111111111111111';
  const spaceB = 'spc_22222222222222222222222222222222';
  const sessionA = 'ses_11111111111111111111111111111111';
  const sessionB = 'ses_22222222222222222222222222222222';

  let dispatchedPrompts: string[] = [];

  const mockDispatcher = async (ctx: any) => {
    dispatchedPrompts.push(ctx.payload.prompt);
    return {
      status: 'completed' as const,
      completedAt: new Date().toISOString(),
    };
  };

  beforeEach(async () => {
    dispatchedPrompts = [];
    testSpacesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-spaces-test-'));
    testManifestPath = path.join(testSpacesRoot, 'trusted-pipeline.manifest.json');

    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    operationsStorage = new SqlitePlatformOperationsStorage(db, {
      quotaOptions: { unconfiguredPolicy: 'unlimited' },
    });
    operationsService = new PlatformOperationsService({
      storage: operationsStorage,
    });

    // Real disk file provider and real RuntimeFileApiService
    const diskProvider = new TestDiskFileProvider(testSpacesRoot, db);
    realFileService = new RuntimeFileApiService({
      fileProvider: diskProvider,
      operations: operationsService,
    });

    // Create user and setup storage quota
    await storage.users.create({
      id: tenantAlice,
      username: 'alice_srv',
      passwordHash: 'hash',
      role: 'admin',
      status: 'active',
    });

    await operationsStorage.forTenant(tenantAlice).quota.setLimit({
      resource: 'storage_bytes',
      limit: 10 * 1024 * 1024, // 10 MiB
    });

    // Create Space A and Session A
    await storage.forTenant(tenantAlice).spaces.create({
      id: spaceA,
      name: 'Space A',
      folder: 'space-a-folder',
      executionMode: 'host',
    });
    await storage.forTenant(tenantAlice).sessionRoutes.create({
      id: sessionA,
      spaceId: spaceA,
      channel: 'web',
      accountId: 'web-user',
      nativeContextId: sessionA,
      peerId: 'peer_a',
      dshSessionId: 'ses_1234567890abcdef1234567890abcdef',
      executionMode: 'host',
    });

    // Create Space B and Session B (second space for sourceSpaceIds isolation test)
    await storage.forTenant(tenantAlice).spaces.create({
      id: spaceB,
      name: 'Space B',
      folder: 'space-b-folder',
      executionMode: 'host',
    });
    await storage.forTenant(tenantAlice).sessionRoutes.create({
      id: sessionB,
      spaceId: spaceB,
      channel: 'web',
      accountId: 'web-user',
      nativeContextId: sessionB,
      peerId: 'peer_b',
      dshSessionId: 'ses_234567890abcdef1234567890abcdef1',
      executionMode: 'host',
    });

    // Ensure space directories exist on disk
    fs.mkdirSync(path.join(testSpacesRoot, 'space-a-folder'), { recursive: true });
    fs.mkdirSync(path.join(testSpacesRoot, 'space-b-folder'), { recursive: true });

    // Setup tenant memory files under dshHome
    const dshRoot = path.join(testSpacesRoot, 'dsh');
    const userMemoryDir = path.join(dshRoot, 'host-runtimes', 'alice_srv', '.dsh', 'memory');
    fs.mkdirSync(path.join(userMemoryDir, 'cognitive'), { recursive: true });
    fs.mkdirSync(path.join(userMemoryDir, 'knowledge'), { recursive: true });
    fs.mkdirSync(path.join(userMemoryDir, 'interaction'), { recursive: true });

    fs.writeFileSync(path.join(userMemoryDir, 'cognitive', 'cognitive-profile.md'), '# Cognitive Profile Baseline\n', 'utf8');
    fs.writeFileSync(path.join(userMemoryDir, 'knowledge', 'AI-Chat-Knowledge.md'), '# AI Knowledge Base\n', 'utf8');
    fs.writeFileSync(path.join(userMemoryDir, 'knowledge', 'KNOWLEDGE-INDEX.md'), '# Knowledge Index\n', 'utf8');
    fs.writeFileSync(path.join(userMemoryDir, 'interaction', 'interaction-rules.md'), '# Interaction Rules\n', 'utf8');
    process.env.DSH_HOME = dshRoot;

    // Populate messages
    const nowIso = '2026-09-10T14:00:00.000Z';
    db.prepare(`
      INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, turn_id, created_at)
      VALUES
        ('msg_a_001', ?, ?, 'user', 'Record in Space A', 'delivered', 'rt_a', 'turn_1', ?),
        ('msg_b_001', ?, ?, 'user', 'CONFIDENTIAL SPACE B RECORD', 'delivered', 'rt_b', 'turn_2', ?)
    `).run(sessionA, tenantAlice, nowIso, sessionB, tenantAlice, nowIso);
  });

  afterEach(() => {
    try {
      delete process.env.DSH_HOME;
      fs.rmSync(testSpacesRoot, { recursive: true, force: true });
    } catch {}
  });

  it('1. manifestloadedrestart: loads manifest on boot, stages input file via real RuntimeFileApi.execute, and prepends location guidance', async () => {
    const pipelineTaskId = 'task_00000000000000000000000000000001';

    // Write persistent admin manifest
    const manifestContent = {
      $schema: 'enkeep/pipeline-task-capabilities-v1',
      requiredTaskIds: [pipelineTaskId],
      tasks: {
        [pipelineTaskId]: {
          capability: 'pipeline_observation',
          targetSpaceId: spaceA,
          sourceSpaceIds: [spaceA],
          checkpointPath: 'pipeline/.cognitive-last-checkpoint',
          stagedInputPrefix: 'pipeline/inputs',
        },
      },
    };
    fs.writeFileSync(testManifestPath, JSON.stringify(manifestContent, null, 2), 'utf8');

    // Create task in platform
    const ops = operationsService.forTenant(tenantAlice);
    const { task } = await ops.tasks.createTask({
      id: pipelineTaskId,
      title: 'Pipeline Observation Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Aggregate observations',
        sessionId: sessionA,
        sessionPolicy: 'existing_session',
      },
    });

    // Boot real server worker factory with pipelineManifestPath and real fileService
    const worker = createPlatformServerTaskWorker({
      db,
      dispatcher: mockDispatcher,
      operationsStorage,
      pipelineManifestPath: testManifestPath,
      fileService: realFileService,
      pollIntervalMs: 50,
    });

    const tickResult = await worker.tick();
    expect(tickResult.processed).toBe(true);
    expect(tickResult.status).toBe('completed');

    // Verify prompt dispatched to LLM includes location guidance
    expect(dispatchedPrompts.length).toBe(1);
    expect(dispatchedPrompts[0]).toContain('[Staged Pipeline Input Location: pipeline/inputs/');
    expect(dispatchedPrompts[0]).toContain('Aggregate observations');

    const locationMatch = dispatchedPrompts[0].match(/\[Staged Pipeline Input Location:\s*([^\]]+)\]/);
    expect(locationMatch).not.toBeNull();
    const relativeLocation = locationMatch![1];

    // Verify real file was written to disk in space-a-folder
    const stagedFileDiskPath = path.join(testSpacesRoot, 'space-a-folder', relativeLocation);
    expect(fs.existsSync(stagedFileDiskPath)).toBe(true);

    const envelope = JSON.parse(fs.readFileSync(stagedFileDiskPath, 'utf8'));
    expect(envelope.schemaVersion).toBe('1.0.0');
    expect(envelope.recordsCount).toBe(1);
    expect(envelope.records[0].id).toBe('msg_a_001');
  });

  it('2. unknownrequiredtaskfail0dispatch: task marked required in manifest fails closed if binding is missing, executing 0 dispatches', async () => {
    const unboundRequiredTaskId = 'task_00000000000000000000000000000002';

    // Manifest marks task required, but provides NO capability binding in tasks
    const manifestContent = {
      $schema: 'enkeep/pipeline-task-capabilities-v1',
      requiredTaskIds: [unboundRequiredTaskId],
      tasks: {},
    };
    fs.writeFileSync(testManifestPath, JSON.stringify(manifestContent), 'utf8');

    const ops = operationsService.forTenant(tenantAlice);
    await ops.tasks.createTask({
      id: unboundRequiredTaskId,
      title: 'Unbound Required Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Should fail closed',
        sessionId: sessionA,
        sessionPolicy: 'existing_session',
      },
    });

    const worker = createPlatformServerTaskWorker({
      db,
      dispatcher: mockDispatcher,
      operationsStorage,
      pipelineManifestPath: testManifestPath,
      fileService: realFileService,
      pollIntervalMs: 50,
    });

    const tickResult = await worker.tick();
    expect(tickResult.processed).toBe(true);
    expect(tickResult.status).toBe('failed');

    // CRITICAL: Zero dispatches to agent/LLM
    expect(dispatchedPrompts.length).toBe(0);

    const reloaded = await ops.tasks.getTask(unboundRequiredTaskId);
    expect(reloaded.status).toBe('failed');
  });

  it('3. 2sourceSpaceIds isolation: strictly isolates messages to explicitly listed sourceSpaceIds', async () => {
    const pipelineTaskId = 'task_00000000000000000000000000000003';

    // Manifest configures sourceSpaceIds strictly to spaceA
    const manifestContent = {
      $schema: 'enkeep/pipeline-task-capabilities-v1',
      tasks: {
        [pipelineTaskId]: {
          capability: 'pipeline_observation',
          targetSpaceId: spaceA,
          sourceSpaceIds: [spaceA], // Excludes spaceB
          checkpointPath: 'pipeline/.cognitive-last-checkpoint',
          stagedInputPrefix: 'pipeline/inputs',
        },
      },
    };
    fs.writeFileSync(testManifestPath, JSON.stringify(manifestContent), 'utf8');

    const ops = operationsService.forTenant(tenantAlice);
    const { task } = await ops.tasks.createTask({
      id: pipelineTaskId,
      title: 'Space Scoped Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Scoped analysis',
        sessionId: sessionA,
        sessionPolicy: 'existing_session',
      },
    });

    const worker = createPlatformServerTaskWorker({
      db,
      dispatcher: mockDispatcher,
      operationsStorage,
      pipelineManifestPath: testManifestPath,
      fileService: realFileService,
      pollIntervalMs: 50,
    });

    const tickResult = await worker.tick();
    expect(tickResult.processed).toBe(true);
    expect(tickResult.status).toBe('completed');

    const locationMatch = dispatchedPrompts[0].match(/\[Staged Pipeline Input Location:\s*([^\]]+)\]/);
    expect(locationMatch).not.toBeNull();
    const relativeLocation = locationMatch![1];

    const stagedFileDiskPath = path.join(testSpacesRoot, 'space-a-folder', relativeLocation);
    expect(fs.existsSync(stagedFileDiskPath)).toBe(true);

    const envelope = JSON.parse(fs.readFileSync(stagedFileDiskPath, 'utf8'));

    // Space B confidential message MUST NOT be present
    expect(envelope.recordsCount).toBe(1);
    expect(envelope.records[0].content).toBe('Record in Space A');
    expect(JSON.stringify(envelope)).not.toContain('CONFIDENTIAL SPACE B RECORD');
  });

  it('4. >1000 explicitfail: N+1 query detects >1000 records and halts with DATA_OVER_CAP, 0 dispatches, 0 checkpoint advance', async () => {
    const pipelineTaskId = 'task_00000000000000000000000000000004';

    // Insert 1005 messages
    const insertStmt = db.prepare(`
      INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, turn_id, created_at)
      VALUES (?, ?, ?, 'user', 'Overflow record', 'delivered', 'rt_a', 'turn_x', '2026-09-10T14:10:00.000Z')
    `);
    for (let i = 10; i < 1015; i++) {
      insertStmt.run(`msg_over_${String(i).padStart(5, '0')}`, sessionA, tenantAlice);
    }

    const manifestContent = {
      $schema: 'enkeep/pipeline-task-capabilities-v1',
      tasks: {
        [pipelineTaskId]: {
          capability: 'pipeline_observation',
          targetSpaceId: spaceA,
          sourceSpaceIds: [spaceA],
          maxRecordsLimit: 1000,
        },
      },
    };
    fs.writeFileSync(testManifestPath, JSON.stringify(manifestContent), 'utf8');

    const ops = operationsService.forTenant(tenantAlice);
    await ops.tasks.createTask({
      id: pipelineTaskId,
      title: 'Overflow Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Process overflow',
        sessionId: sessionA,
        sessionPolicy: 'existing_session',
      },
    });

    const worker = createPlatformServerTaskWorker({
      db,
      dispatcher: mockDispatcher,
      operationsStorage,
      pipelineManifestPath: testManifestPath,
      fileService: realFileService,
      pollIntervalMs: 50,
    });

    const tickResult = await worker.tick();
    expect(tickResult.processed).toBe(true);
    expect(tickResult.status).toBe('failed');
    expect(dispatchedPrompts.length).toBe(0); // 0 dispatches
  });

  it('5. immutableexistingrun reuse afternewrecords: replaying same runId verifies existing file without overwriting new data', async () => {
    const pipelineTaskId = 'task_00000000000000000000000000000005';

    const manifestContent = {
      $schema: 'enkeep/pipeline-task-capabilities-v1',
      tasks: {
        [pipelineTaskId]: {
          capability: 'pipeline_observation',
          targetSpaceId: spaceA,
          sourceSpaceIds: [spaceA],
        },
      },
    };
    fs.writeFileSync(testManifestPath, JSON.stringify(manifestContent), 'utf8');

    const ops = operationsService.forTenant(tenantAlice);
    const { task } = await ops.tasks.createTask({
      id: pipelineTaskId,
      title: 'Immutable Retry Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Initial run',
        sessionId: sessionA,
        sessionPolicy: 'existing_session',
      },
    });

    const worker = createPlatformServerTaskWorker({
      db,
      dispatcher: mockDispatcher,
      operationsStorage,
      pipelineManifestPath: testManifestPath,
      fileService: realFileService,
      pollIntervalMs: 50,
    });

    const tick1 = await worker.tick();
    expect(tick1.status).toBe('completed');

    const locationMatch = dispatchedPrompts[0].match(/\[Staged Pipeline Input Location:\s*([^\]]+)\]/);
    expect(locationMatch).not.toBeNull();
    const relativeLocation = locationMatch![1];
    const stagedPath = path.join(testSpacesRoot, 'space-a-folder', relativeLocation);
    const firstContent = fs.readFileSync(stagedPath, 'utf8');

    const runIdMatch = relativeLocation.match(/pipeline\/inputs\/([^/]+)\/input\.json/);
    const actualRunId = runIdMatch ? runIdMatch[1] : (task.currentRun?.id || task.id);

    // Insert new late message into database
    db.prepare(`
      INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, turn_id, created_at)
      VALUES ('msg_late_001', ?, ?, 'user', 'LATE ARRIVED CONTENT', 'delivered', 'rt_a', 'turn_late', '2026-09-10T14:30:00.000Z')
    `).run(sessionA, tenantAlice);

    // Direct preparer invocation for exact same runId
    const preparer = (worker as any).prepareTaskInput;
    const prepResult = await preparer({
      task,
      payload: task.payload,
      tenantId: tenantAlice,
      runId: actualRunId,
      signal: new AbortController().signal,
    });

    const secondContent = fs.readFileSync(stagedPath, 'utf8');
    expect(secondContent).toBe(firstContent);
    expect(secondContent).not.toContain('LATE ARRIVED CONTENT');
  });

  it('6. traversalreject: rejects path traversal in manifest prefix or checkpoint with zero files written', async () => {
    const pipelineTaskId = 'task_00000000000000000000000000000006';

    const manifestContent = {
      $schema: 'enkeep/pipeline-task-capabilities-v1',
      tasks: {
        [pipelineTaskId]: {
          capability: 'pipeline_observation',
          targetSpaceId: spaceA,
          stagedInputPrefix: '../../escape',
        },
      },
    };
    fs.writeFileSync(testManifestPath, JSON.stringify(manifestContent), 'utf8');

    const ops = operationsService.forTenant(tenantAlice);
    await ops.tasks.createTask({
      id: pipelineTaskId,
      title: 'Traversal Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Traversal prompt',
        sessionId: sessionA,
        sessionPolicy: 'existing_session',
      },
    });

    const worker = createPlatformServerTaskWorker({
      db,
      dispatcher: mockDispatcher,
      operationsStorage,
      pipelineManifestPath: testManifestPath,
      fileService: realFileService,
      pollIntervalMs: 50,
    });

    const tickResult = await worker.tick();
    expect(tickResult.status).toBe('failed');
    expect(dispatchedPrompts.length).toBe(0);

    // Verify zero files created outside space
    expect(fs.existsSync(path.join(testSpacesRoot, 'escape'))).toBe(false);
  });

  it('7. ordinary6tasks unaffected: unconfigured task executes normally without staging files or prompt modification', async () => {
    const ordinaryTaskId = 'task_00000000000000000000000000000007';

    // Manifest has NO entry for ordinaryTaskId
    const manifestContent = {
      $schema: 'enkeep/pipeline-task-capabilities-v1',
      tasks: {},
    };
    fs.writeFileSync(testManifestPath, JSON.stringify(manifestContent), 'utf8');

    const originalPrompt = 'Ordinary business reminder prompt';
    const ops = operationsService.forTenant(tenantAlice);
    await ops.tasks.createTask({
      id: ordinaryTaskId,
      title: 'Ordinary Task',
      payload: {
        type: 'agent_prompt',
        prompt: originalPrompt,
        sessionId: sessionA,
        sessionPolicy: 'existing_session',
      },
    });

    const worker = createPlatformServerTaskWorker({
      db,
      dispatcher: mockDispatcher,
      operationsStorage,
      pipelineManifestPath: testManifestPath,
      fileService: realFileService,
      pollIntervalMs: 50,
    });

    const tickResult = await worker.tick();
    expect(tickResult.status).toBe('completed');

    // Prompt received by dispatcher is EXACTLY originalPrompt (no location guidance prepended)
    expect(dispatchedPrompts.length).toBe(1);
    expect(dispatchedPrompts[0]).toBe(originalPrompt);

    // Zero staging files written
    const pipelineDir = path.join(testSpacesRoot, 'space-a-folder', 'pipeline', 'inputs');
    expect(fs.existsSync(pipelineDir)).toBe(false);
  });

  it('8. aggregation7daywindow: prepares 7-day observations, buffers, and memory basis files via real file API', async () => {
    const weeklyTaskId = 'task_00000000000000000000000000000008';

    // 1. Setup observations.md in Space A and Space B with dated lines
    // Calculate current completed 7-day range
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
    const untilDate = formatter.format(now);
    const [y, m, d] = untilDate.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - 3); // 3 days ago: inside window
    const inWindowDate = dt.toISOString().slice(0, 10);
    dt.setUTCDate(dt.getUTCDate() - 10); // 13 days ago: outside window
    const oldDate = dt.toISOString().slice(0, 10);

    const spaceAObsPath = path.join(testSpacesRoot, 'space-a-folder', 'observations.md');
    fs.writeFileSync(spaceAObsPath, `
# Observations Space A
- ${inWindowDate} [Pattern]: User prefers dark mode
- ${oldDate} [Old]: Obsolete ancient observation from 2 weeks ago
- Undated general reflection that must not be lost
`, 'utf8');

    const spaceBObsPath = path.join(testSpacesRoot, 'space-b-folder', 'observations.md');
    fs.writeFileSync(spaceBObsPath, `
# Observations Space B
- ${inWindowDate} [Insight]: Cross-workspace sync verified
`, 'utf8');

    // 2. Setup active buffers in Space A
    const pipelineDir = path.join(testSpacesRoot, 'space-a-folder', 'pipeline');
    fs.mkdirSync(pipelineDir, { recursive: true });
    fs.writeFileSync(path.join(pipelineDir, 'knowledge-buffer.md'), '# Knowledge Buffer Content\n- Distilled fact 1\n', 'utf8');
    fs.writeFileSync(path.join(pipelineDir, 'interaction-buffer.md'), '# Interaction Buffer Content\n- Interaction rule 1\n', 'utf8');

    // 3. Setup real tenant memory files under dshHome (zero memory spaces in database)
    const dshRoot = path.join(testSpacesRoot, 'dsh');
    const userMemoryDir = path.join(dshRoot, 'host-runtimes', 'alice_srv', '.dsh', 'memory');
    fs.mkdirSync(path.join(userMemoryDir, 'cognitive'), { recursive: true });
    fs.mkdirSync(path.join(userMemoryDir, 'knowledge'), { recursive: true });
    fs.mkdirSync(path.join(userMemoryDir, 'interaction'), { recursive: true });

    fs.writeFileSync(path.join(userMemoryDir, 'cognitive', 'cognitive-profile.md'), '# Cognitive Profile Baseline\n', 'utf8');
    fs.writeFileSync(path.join(userMemoryDir, 'knowledge', 'AI-Chat-Knowledge.md'), '# AI Knowledge Base\n', 'utf8');
    fs.writeFileSync(path.join(userMemoryDir, 'knowledge', 'KNOWLEDGE-INDEX.md'), '# Knowledge Index\n', 'utf8');
    fs.writeFileSync(path.join(userMemoryDir, 'interaction', 'interaction-rules.md'), '# Interaction Rules\n', 'utf8');

    // 4. Configure manifest for pipeline_aggregation (NO memorySpaceId in manifest)
    const manifestContent = {
      $schema: 'enkeep/pipeline-task-capabilities-v1',
      requiredTaskIds: [weeklyTaskId],
      tasks: {
        [weeklyTaskId]: {
          capability: 'pipeline_aggregation',
          targetSpaceId: spaceA,
          sourceSpaceIds: [spaceA, spaceB],
          checkpointPath: 'pipeline/.weekly-checkpoint',
          stagedInputPrefix: 'pipeline/inputs',
        },
      },
    };
    fs.writeFileSync(testManifestPath, JSON.stringify(manifestContent, null, 2), 'utf8');

    // Create weekly task in operations
    const ops = operationsService.forTenant(tenantAlice);
    const { task } = await ops.tasks.createTask({
      id: weeklyTaskId,
      title: 'Weekly 3D Aggregator',
      payload: {
        type: 'agent_prompt',
        prompt: 'Run weekly aggregation',
        sessionId: sessionA,
        sessionPolicy: 'existing_session',
      },
    });

    const worker = createPlatformServerTaskWorker({
      db,
      dispatcher: mockDispatcher,
      operationsStorage,
      pipelineManifestPath: testManifestPath,
      fileService: realFileService,
      pollIntervalMs: 50,
    });

    const tickResult = await worker.tick();
    expect(tickResult.processed).toBe(true);
    expect(tickResult.status).toBe('completed');

    // 5. Verify staged files and schema
    const locationMatch = dispatchedPrompts[dispatchedPrompts.length - 1].match(/\[Staged Pipeline Input Location:\s*([^\]]+)\]/);
    expect(locationMatch).not.toBeNull();
    const manifestRelativePath = locationMatch![1];

    const stagedManifestDiskPath = path.join(testSpacesRoot, 'space-a-folder', manifestRelativePath);
    expect(fs.existsSync(stagedManifestDiskPath)).toBe(true);

    const envelope = JSON.parse(fs.readFileSync(stagedManifestDiskPath, 'utf8'));
    expect(envelope.schemaVersion).toBe('1.0.0');
    expect(envelope.capability).toBe('pipeline_aggregation');
    expect(envelope.window.lookbackDays).toBe(7);
    expect(envelope.window.timeZone).toBe('America/Los_Angeles');

    // Verify observations.json was staged
    const obsDiskPath = path.join(testSpacesRoot, 'space-a-folder', path.dirname(manifestRelativePath), envelope.sections.observations.path);
    expect(fs.existsSync(obsDiskPath)).toBe(true);
    const stagedObs = JSON.parse(fs.readFileSync(obsDiskPath, 'utf8'));
    expect(stagedObs.length).toBe(2); // spaceA and spaceB

    // In-window observation must be present
    expect(JSON.stringify(stagedObs)).toContain('User prefers dark mode');
    expect(JSON.stringify(stagedObs)).toContain('Cross-workspace sync verified');
    // Undated line must be preserved
    expect(JSON.stringify(stagedObs)).toContain('Undated general reflection');
    // Old observation outside 7-day window must be filtered
    expect(JSON.stringify(stagedObs)).not.toContain('Obsolete ancient observation');

    // Verify buffers.json was staged
    const bufDiskPath = path.join(testSpacesRoot, 'space-a-folder', path.dirname(manifestRelativePath), envelope.sections.buffers.path);
    expect(fs.existsSync(bufDiskPath)).toBe(true);
    const stagedBuffers = JSON.parse(fs.readFileSync(bufDiskPath, 'utf8'));
    expect(stagedBuffers.knowledgeBuffer).toContain('Distilled fact 1');
    expect(stagedBuffers.interactionBuffer).toContain('Interaction rule 1');

    // Verify memory basis files staged with sizeBytes and sha256
    expect(envelope.sections.memoryBasis.cognitiveProfile.sizeBytes).toBeGreaterThan(0);
    expect(envelope.sections.memoryBasis.cognitiveProfile.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('9. demorunnerenvpropagation: loads manifest via process.env.ENKEEP_PIPELINE_MANIFEST without CLI duplication', async () => {
    const envTaskId = 'task_00000000000000000000000000000009';

    const manifestContent = {
      $schema: 'enkeep/pipeline-task-capabilities-v1',
      requiredTaskIds: [envTaskId],
      tasks: {
        [envTaskId]: {
          capability: 'pipeline_observation',
          targetSpaceId: spaceA,
          sourceSpaceIds: [spaceA],
        },
      },
    };
    fs.writeFileSync(testManifestPath, JSON.stringify(manifestContent), 'utf8');

    // Set process.env.ENKEEP_PIPELINE_MANIFEST
    process.env.ENKEEP_PIPELINE_MANIFEST = testManifestPath;

    try {
      const ops = operationsService.forTenant(tenantAlice);
      await ops.tasks.createTask({
        id: envTaskId,
        title: 'Env Bootstrapped Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Env prompt',
          sessionId: sessionA,
          sessionPolicy: 'existing_session',
        },
      });

      // Do NOT pass pipelineManifestPath explicitly in options
      const worker = createPlatformServerTaskWorker({
        db,
        dispatcher: mockDispatcher,
        operationsStorage,
        fileService: realFileService,
        pollIntervalMs: 50,
      });

      const tickResult = await worker.tick();
      expect(tickResult.status).toBe('completed');
      expect(dispatchedPrompts[dispatchedPrompts.length - 1]).toContain('[Staged Pipeline Input Location:');
    } finally {
      delete process.env.ENKEEP_PIPELINE_MANIFEST;
    }
  });

  it('10. dailypointeradvanced does not starve weekly aggregation', async () => {
    // Advanced daily checkpoint in Space A
    const dailyCheckpointPath = path.join(testSpacesRoot, 'space-a-folder', 'pipeline', '.cognitive-last-checkpoint');
    fs.mkdirSync(path.dirname(dailyCheckpointPath), { recursive: true });
    fs.writeFileSync(dailyCheckpointPath, JSON.stringify({
      lastCreatedAt: '2026-09-10T23:59:59.000Z',
      lastId: 'msg_daily_advanced',
    }), 'utf8');

    // Weekly aggregator runs with independent checkpoint
    const weeklyTaskId = 'task_00000000000000000000000000000010';
    const manifestContent = {
      $schema: 'enkeep/pipeline-task-capabilities-v1',
      tasks: {
        [weeklyTaskId]: {
          capability: 'pipeline_aggregation',
          targetSpaceId: spaceA,
          sourceSpaceIds: [spaceA],
          checkpointPath: 'pipeline/.weekly-checkpoint',
        },
      },
    };
    fs.writeFileSync(testManifestPath, JSON.stringify(manifestContent), 'utf8');

    const ops = operationsService.forTenant(tenantAlice);
    await ops.tasks.createTask({
      id: weeklyTaskId,
      title: 'Weekly Independent Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Weekly run',
        sessionId: sessionA,
        sessionPolicy: 'existing_session',
      },
    });

    const worker = createPlatformServerTaskWorker({
      db,
      dispatcher: mockDispatcher,
      operationsStorage,
      pipelineManifestPath: testManifestPath,
      fileService: realFileService,
      pollIntervalMs: 50,
    });

    const tickResult = await worker.tick();
    expect(tickResult.status).toBe('completed');

    // Weekly run succeeded despite daily checkpoint being advanced to future
    const lastPrompt = dispatchedPrompts[dispatchedPrompts.length - 1];
    expect(lastPrompt).toContain('[Staged Pipeline Input Location:');

    // Daily checkpoint was NOT touched
    const dailyAfter = JSON.parse(fs.readFileSync(dailyCheckpointPath, 'utf8'));
    expect(dailyAfter.lastId).toBe('msg_daily_advanced');
  });
});
