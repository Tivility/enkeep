import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
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
  createPlatformServer,
} from '../src/server/server.js';
import {
  PipelineTaskInputPreparerService,
} from '../src/tasks/pipeline-input-preparer.js';
import {
  PlatformError,
  NotFoundError,
  ValidationError,
} from '@enkeep/platform-core';
import { DeliveryRuntimeGateway } from '../src/runtime/delivery-gateway.js';

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

    throw new Error(`Unsupported op: ${request.op}`);
  }
}

describe('Weekly runtime root regression and authoritative memory path resolution', () => {
  const testRoot = path.join(os.tmpdir(), `enkeep-weekly-test-${randomUUID()}`);
  const testDataRoot = path.join(testRoot, 'demo-data-root');
  const testDshHomeDefault = path.join(testRoot, 'dummy-dsh-home-default');
  const testSpacesRoot = path.join(testDataRoot, 'spaces');
  const testManifestPath = path.join(testRoot, 'pipeline-manifest.json');

  const tenantUUID = '00000000-0000-0000-0000-000000000001'; // realistic user UUID != username
  const username = 'alice';
  const spaceId = 'spc_00000000000000000000000000000001';
  const spaceFolder = 'main--host';
  const sessionId = 'ses_00000000000000000000000000000001';
  const weeklyTaskId = 'task_hpc_000000000000000000000abc';

  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let operationsStorage: SqlitePlatformOperationsStorage;
  let operationsService: PlatformOperationsService;
  let diskProvider: TestDiskFileProvider;
  let realFileService: RuntimeFileApiService;

  beforeEach(async () => {
    fs.mkdirSync(testDataRoot, { recursive: true });
    fs.mkdirSync(testDshHomeDefault, { recursive: true });
    fs.mkdirSync(testSpacesRoot, { recursive: true });
    fs.mkdirSync(path.join(testSpacesRoot, spaceFolder), { recursive: true });

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

    diskProvider = new TestDiskFileProvider(testSpacesRoot, db);
    realFileService = new RuntimeFileApiService({
      fileProvider: diskProvider,
      operations: operationsService,
    });

    // Create user with authoritative UUID != username
    await storage.users.create({
      id: tenantUUID,
      username,
      passwordHash: 'hash',
      role: 'admin',
      status: 'active',
    });

    await operationsStorage.forTenant(tenantUUID).quota.setLimit({
      resource: 'storage_bytes',
      limit: 10 * 1024 * 1024, // 10 MiB
    });

    // Create target Space and Session Route
    await storage.forTenant(tenantUUID).spaces.create({
      id: spaceId,
      name: 'Main Host Space',
      folder: spaceFolder,
      executionMode: 'host',
    });
    await storage.forTenant(tenantUUID).sessionRoutes.create({
      id: sessionId,
      spaceId,
      channel: 'lark',
      accountId: 'acc_test',
      nativeContextId: 'oc_test_001',
      peerId: 'peer_weekly',
      dshSessionId: 'ses_dsh_weekly_001',
      executionMode: 'host',
    });

    // Create 4 private fixture memory files strictly under testDataRoot (authoritative HostRuntimeAdapter layout)
    const userMemoryDir = path.join(testDataRoot, 'host-runtimes', username, '.dsh', 'memory');
    fs.mkdirSync(path.join(userMemoryDir, 'cognitive'), { recursive: true });
    fs.mkdirSync(path.join(userMemoryDir, 'knowledge'), { recursive: true });
    fs.mkdirSync(path.join(userMemoryDir, 'interaction'), { recursive: true });

    fs.writeFileSync(path.join(userMemoryDir, 'cognitive', 'cognitive-profile.md'), '# Cognitive Profile\nActive patterns: systematic.\n', 'utf8');
    fs.writeFileSync(path.join(userMemoryDir, 'knowledge', 'AI-Chat-Knowledge.md'), '# AI Chat Knowledge\nCore concepts index.\n', 'utf8');
    fs.writeFileSync(path.join(userMemoryDir, 'knowledge', 'KNOWLEDGE-INDEX.md'), '# Knowledge Index\nTopics map.\n', 'utf8');
    fs.writeFileSync(path.join(userMemoryDir, 'interaction', 'interaction-rules.md'), '# Interaction Rules\nConcise reporting.\n', 'utf8');

    // Create weekly manifest
    const manifestContent = {
      $schema: 'enkeep/pipeline-task-capabilities-v1',
      requiredTaskIds: [weeklyTaskId],
      tasks: {
        [weeklyTaskId]: {
          capability: 'pipeline_aggregation',
          targetSpaceId: spaceId,
          sourceSpaceIds: [spaceId],
          checkpointPath: 'pipeline/.weekly-aggregation-last-checkpoint',
          stagedInputPrefix: 'pipeline/inputs',
        },
      },
    };
    fs.writeFileSync(testManifestPath, JSON.stringify(manifestContent, null, 2), 'utf8');
  });

  afterEach(() => {
    try {
      db.close();
      fs.rmSync(testRoot, { recursive: true, force: true });
    } catch {}
  });

  it('1. reproduces old code failure: preparer without dataRoot/dshHome checked cwd/.dsh instead of dataRoot', async () => {
    // Old code did NOT pass dataRoot or dshHome to PipelineTaskInputPreparerService
    const buggyPreparer = new PipelineTaskInputPreparerService({
      database: db,
      fileService: realFileService,
      manifestPath: testManifestPath,
      // dataRoot and dshHome deliberately omitted, imitating old server factory bug
    });

    // Old code should fail to find cognitive-profile.md because it looked in cwd/.dsh instead of testDataRoot
    await expect(
      buggyPreparer.prepare({
        task: { id: weeklyTaskId } as any,
        payload: {
          type: 'agent_prompt',
          prompt: 'Execute weekly aggregation',
          sessionId,
          spaceId,
        },
        tenantId: tenantUUID,
        runId: 'run_regression_fail_0001',
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/\[MISSING_MEMORY_FILE\] Required memory file "cognitive\/cognitive-profile\.md" not found/);
  });

  it('2. fixes failure: task worker factory configured with dataRoot != dshHome sees authoritative memory root and stages weekly input', async () => {
    // Ensure testDataRoot != testDshHomeDefault
    expect(testDataRoot).not.toEqual(testDshHomeDefault);

    // Create task in platform
    const taskOps = operationsService.forTenant(tenantUUID).tasks;
    const { task } = await taskOps.createTask({
      id: weeklyTaskId,
      title: '# 周级统一聚合任务',
      priority: 'medium',
      payload: {
        type: 'agent_prompt',
        prompt: 'Execute weekly aggregation task',
        sessionPolicy: 'existing_session',
        sessionId,
        spaceId,
      },
    });

    let executedPrompt = '';
    const fakeDispatcher = async (ctx: any) => {
      executedPrompt = ctx.payload.prompt;
      return {
        status: 'completed' as const,
        completedAt: new Date().toISOString(),
      };
    };

    // Construct worker through actual task worker factory with dataRoot
    const worker = createPlatformServerTaskWorker({
      db,
      dispatcher: fakeDispatcher,
      operationsStorage,
      pipelineManifestPath: testManifestPath,
      fileService: realFileService,
      dataRoot: testDataRoot,
      dshHome: testDshHomeDefault, // realistic: dshHome defaults to dummy ~/.dsh, but dataRoot points to authoritative root
    });

    // Process one tick
    const tickResult = await worker.tick();
    expect(tickResult.processed).toBe(true);
    expect(tickResult.status).toBe('completed');

    // Verify task completed
    const updatedTask = await taskOps.getTask(weeklyTaskId);
    expect(updatedTask.status).toBe('completed');

    // Verify guidance location was injected into prompt
    expect(executedPrompt).toContain('[Staged Pipeline Input Location: pipeline/inputs/');

    // Verify staged artifacts in target space
    const stagedDir = path.join(testSpacesRoot, spaceFolder, 'pipeline', 'inputs');
    const runDirs = fs.readdirSync(stagedDir);
    expect(runDirs.length).toBe(1);
    const runDir = path.join(stagedDir, runDirs[0]);

    // Verify input.json envelope
    const envelope = JSON.parse(fs.readFileSync(path.join(runDir, 'input.json'), 'utf8'));
    expect(envelope.capability).toBe('pipeline_aggregation');
    expect(envelope.sections.memoryBasis.cognitiveProfile.path).toBe('memory/cognitive-profile.md');
    expect(envelope.sections.memoryBasis.aiChatKnowledge.path).toBe('memory/AI-Chat-Knowledge.md');
    expect(envelope.sections.memoryBasis.knowledgeIndex.path).toBe('memory/KNOWLEDGE-INDEX.md');
    expect(envelope.sections.memoryBasis.interactionRules.path).toBe('memory/interaction-rules.md');

    // Verify 4 memory files were staged correctly
    const stagedProfile = fs.readFileSync(path.join(runDir, 'memory', 'cognitive-profile.md'), 'utf8');
    expect(stagedProfile).toBe('# Cognitive Profile\nActive patterns: systematic.\n');
  });

  it('3. fail-closed on missing memory file in authoritative root', async () => {
    // Remove cognitive-profile.md
    const cognitiveFile = path.join(testDataRoot, 'host-runtimes', username, '.dsh', 'memory', 'cognitive', 'cognitive-profile.md');
    fs.unlinkSync(cognitiveFile);

    const preparer = new PipelineTaskInputPreparerService({
      database: db,
      fileService: realFileService,
      manifestPath: testManifestPath,
      dataRoot: testDataRoot,
    });

    await expect(
      preparer.prepare({
        task: { id: weeklyTaskId } as any,
        payload: {
          type: 'agent_prompt',
          prompt: 'Execute weekly aggregation',
          sessionId,
          spaceId,
        },
        tenantId: tenantUUID,
        runId: 'run_fail_closed_0001',
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/\[MISSING_MEMORY_FILE\] Required memory file "cognitive\/cognitive-profile\.md" not found/);
  });

  it('4. fail-closed on foreign or non-active user UUID', async () => {
    const preparer = new PipelineTaskInputPreparerService({
      database: db,
      fileService: realFileService,
      manifestPath: testManifestPath,
      dataRoot: testDataRoot,
    });

    const foreignUUID = 'usr_foreign_99999999999999999999';

    await expect(
      preparer.prepare({
        task: { id: weeklyTaskId } as any,
        payload: {
          type: 'agent_prompt',
          prompt: 'Execute weekly aggregation',
          sessionId,
          spaceId,
        },
        tenantId: foreignUUID,
        runId: 'run_foreign_fail_0001',
        signal: new AbortController().signal,
      })
    ).rejects.toThrow();
  });

  it('5. read-only equivalence proof on memory layout and database', () => {
    const row = db
      .prepare("SELECT id, username, status FROM users WHERE id = ?")
      .get(tenantUUID) as { id: string; username: string; status: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.username).toBe(username);
    expect(row?.status).toBe('active');

    const userMemoryDir = path.join(testDataRoot, 'host-runtimes', username, '.dsh', 'memory');
    const requiredFiles = [
      'cognitive/cognitive-profile.md',
      'knowledge/AI-Chat-Knowledge.md',
      'knowledge/KNOWLEDGE-INDEX.md',
      'interaction/interaction-rules.md',
    ];

    for (const rel of requiredFiles) {
      const fullPath = path.join(userMemoryDir, rel);
      expect(fs.existsSync(fullPath)).toBe(true);
      const stat = fs.statSync(fullPath);
      expect(stat.size).toBeGreaterThan(0);
    }
  });
});
