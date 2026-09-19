import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
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
  computeLosAngelesCompletedSevenDays,
  PipelineTaskInputPreparerService,
} from '../src/tasks/pipeline-input-preparer.js';
import { createPlatformServerTaskWorker } from '../src/tasks/agent-prompt-worker.js';
import { PlatformError, NotFoundError, ForbiddenError } from '@enkeep/platform-core';

class TransportInjectedFileProvider implements TenantRuntimeFileProvider {
  public injectedErrors: Map<string, Error> = new Map();

  constructor(private spacesRoot: string, private db: DatabaseSync) {}

  async execute(
    userId: string,
    spaceId: string,
    request: CanonicalFileOperationRequest
  ): Promise<CanonicalFileOperationResult> {
    // If an error is injected for this file path, throw it to simulate boundary transport/provider errors
    const errorKey = `${request.op}:${request.path}`;
    if (this.injectedErrors.has(errorKey)) {
      throw this.injectedErrors.get(errorKey)!;
    }
    if (this.injectedErrors.has(`*:${request.path}`)) {
      throw this.injectedErrors.get(`*:${request.path}`)!;
    }

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

describe('Weekly Input Read Error Fix & Precise Optional Classification', () => {
  const testRoot = path.join(os.tmpdir(), `enkeep-weekly-input-fix-${randomUUID()}`);
  const testDataRoot = path.join(testRoot, 'demo-data-root');
  const testDshHomeDefault = path.join(testRoot, 'dummy-dsh-home');
  const testSpacesRoot = path.join(testDataRoot, 'spaces');
  const testManifestPath = path.join(testRoot, 'pipeline-manifest.json');

  const tenantUUID = '00000000-0000-0000-0000-000000000001';
  const username = 'alice';
  const spaceId = 'spc_00000000000000000000000000000001';
  const spaceFolder = 'main--host';
  const sessionId = 'ses_00000000000000000000000000000001';
  const weeklyTaskId = 'task_hpc_000000000000000000000abc';

  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let operationsStorage: SqlitePlatformOperationsStorage;
  let operationsService: PlatformOperationsService;
  let fileProvider: TransportInjectedFileProvider;
  let fileService: RuntimeFileApiService;
  let dispatcherCallCount = 0;
  let dispatchedPayload: any = null;

  beforeEach(async () => {
    dispatcherCallCount = 0;
    dispatchedPayload = null;

    fs.mkdirSync(testRoot, { recursive: true });
    fs.mkdirSync(testDataRoot, { recursive: true });
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

    fileProvider = new TransportInjectedFileProvider(testSpacesRoot, db);
    fileService = new RuntimeFileApiService({
      fileProvider,
      operations: operationsService,
    });

    await storage.users.create({
      id: tenantUUID,
      username,
      passwordHash: 'hash',
      role: 'admin',
      status: 'active',
    });

    await operationsStorage.forTenant(tenantUUID).quota.setLimit({
      resource: 'storage_bytes',
      limit: 20 * 1024 * 1024,
    });

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

    // Authoritative 4 memory basis files
    const userMemoryDir = path.join(testDataRoot, 'host-runtimes', username, '.dsh', 'memory');
    fs.mkdirSync(path.join(userMemoryDir, 'cognitive'), { recursive: true });
    fs.mkdirSync(path.join(userMemoryDir, 'knowledge'), { recursive: true });
    fs.mkdirSync(path.join(userMemoryDir, 'interaction'), { recursive: true });

    fs.writeFileSync(path.join(userMemoryDir, 'cognitive', 'cognitive-profile.md'), '# Cognitive Profile\nSystematic patterns.\n', 'utf8');
    fs.writeFileSync(path.join(userMemoryDir, 'knowledge', 'AI-Chat-Knowledge.md'), '# AI Chat Knowledge\nCore concepts.\n', 'utf8');
    fs.writeFileSync(path.join(userMemoryDir, 'knowledge', 'KNOWLEDGE-INDEX.md'), '# Knowledge Index\nTopics map.\n', 'utf8');
    fs.writeFileSync(path.join(userMemoryDir, 'interaction', 'interaction-rules.md'), '# Interaction Rules\nConcise reporting.\n', 'utf8');

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

  function createWorker() {
    const fakeDispatcher = async (ctx: any) => {
      dispatcherCallCount++;
      dispatchedPayload = ctx.payload;
      return {
        status: 'completed' as const,
        completedAt: new Date().toISOString(),
      };
    };

    return createPlatformServerTaskWorker({
      db,
      dispatcher: fakeDispatcher,
      operationsStorage,
      pipelineManifestPath: testManifestPath,
      fileService,
      dataRoot: testDataRoot,
      dshHome: testDshHomeDefault,
    });
  }

  async function createTask(taskId = weeklyTaskId) {
    const taskOps = operationsService.forTenant(tenantUUID).tasks;
    return await taskOps.createTask({
      id: taskId,
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
  }

  it('1. valid non-empty observed record + buffer inside 7-day window -> manifest count non-zero + exact content hash', async () => {
    const { sinceDate, untilDate } = computeLosAngelesCompletedSevenDays();
    const [y, m, d] = sinceDate.split('-').map(Number);
    const midDate = new Date(Date.UTC(y, m - 1, d + 2)).toISOString().slice(0, 10);

    const spaceDir = path.join(testSpacesRoot, spaceFolder);
    const obsContent = `## [${midDate}T10:15:30.000Z] Observation entry in lookback window\n`;
    fs.writeFileSync(path.join(spaceDir, 'observations.md'), obsContent, 'utf8');

    fs.mkdirSync(path.join(spaceDir, 'pipeline'), { recursive: true });
    const bufferContent = `# Knowledge Buffer\n\n- [${midDate}] Recorded buffer item: 1446 bytes verified payload.\n`;
    fs.writeFileSync(path.join(spaceDir, 'pipeline', 'knowledge-buffer.md'), bufferContent, 'utf8');

    await createTask();
    const worker = createWorker();

    const tickResult = await worker.tick();
    expect(tickResult.processed).toBe(true);
    expect(tickResult.status).toBe('completed');
    expect(dispatcherCallCount).toBe(1);

    const stagedDir = path.join(spaceDir, 'pipeline', 'inputs');
    const runDirs = fs.readdirSync(stagedDir);
    expect(runDirs.length).toBe(1);
    const runDir = path.join(stagedDir, runDirs[0]);

    const envelope = JSON.parse(fs.readFileSync(path.join(runDir, 'input.json'), 'utf8'));
    expect(envelope.capability).toBe('pipeline_aggregation');
    expect(envelope.sections.observations.totalObservationsCount).toBe(1);
    expect(envelope.sections.observations.spacesCount).toBe(1);
    expect(envelope.sections.buffers.knowledgeBufferSize).toBe(Buffer.byteLength(bufferContent, 'utf8'));

    // Check exact content hashes
    const obsJson = fs.readFileSync(path.join(runDir, 'observations.json'), 'utf8');
    const expectedObsHash = createHash('sha256').update(obsJson).digest('hex');
    expect(envelope.sections.observations.sha256).toBe(expectedObsHash);

    const bufJson = fs.readFileSync(path.join(runDir, 'buffers.json'), 'utf8');
    const expectedBufHash = createHash('sha256').update(bufJson).digest('hex');
    expect(envelope.sections.buffers.sha256).toBe(expectedBufHash);
  });

  it('2. transport error 502 (PROVIDER_PROTOCOL_ERROR) on observations.md -> fails task, 0 dispatcher executions, no checkpoint advance', async () => {
    // Inject 502 PROVIDER_PROTOCOL_ERROR at provider boundary for observations.md
    fileProvider.injectedErrors.set(
      'read:observations.md',
      new PlatformError('Bad gateway: invalid provider response (missing type: file)', 'PROVIDER_PROTOCOL_ERROR', 502)
    );

    const spaceDir = path.join(testSpacesRoot, spaceFolder);
    fs.mkdirSync(path.join(spaceDir, 'pipeline'), { recursive: true });
    const checkpointFile = path.join(spaceDir, 'pipeline', '.weekly-aggregation-last-checkpoint');
    fs.writeFileSync(checkpointFile, '2026-09-04', 'utf8');
    const checkpointStatBefore = fs.statSync(checkpointFile);

    await createTask();
    const worker = createWorker();

    const tickResult = await worker.tick();
    expect(tickResult.processed).toBe(true);
    expect(tickResult.status).toBe('failed');

    // Invariants: 0 dispatcher executions, 0 model calls, no notification, checkpoint strictly unadvanced
    expect(dispatcherCallCount).toBe(0);
    const checkpointContentAfter = fs.readFileSync(checkpointFile, 'utf8');
    expect(checkpointContentAfter).toBe('2026-09-04');
    expect(fs.statSync(checkpointFile).mtimeMs).toBe(checkpointStatBefore.mtimeMs);

    // Staged input manifest MUST NOT exist
    const stagedInputsDir = path.join(spaceDir, 'pipeline', 'inputs');
    if (fs.existsSync(stagedInputsDir)) {
      const entries = fs.readdirSync(stagedInputsDir);
      for (const e of entries) {
        expect(fs.existsSync(path.join(stagedInputsDir, e, 'input.json'))).toBe(false);
      }
    }

    // Task status in database must be failed
    const taskRecord = await operationsService.forTenant(tenantUUID).tasks.getTask(weeklyTaskId);
    expect(taskRecord.status).toBe('failed');
  });

  it('3. transport error 502 on knowledge-buffer.md -> fails closed, 0 dispatcher calls, manifest uncommitted', async () => {
    // Inject 502 PROVIDER_PROTOCOL_ERROR for knowledge-buffer.md
    fileProvider.injectedErrors.set(
      'read:pipeline/knowledge-buffer.md',
      new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502)
    );

    await createTask();
    const worker = createWorker();

    const tickResult = await worker.tick();
    expect(tickResult.processed).toBe(true);
    expect(tickResult.status).toBe('failed');
    expect(dispatcherCallCount).toBe(0);

    const taskRecord = await operationsService.forTenant(tenantUUID).tasks.getTask(weeklyTaskId);
    expect(taskRecord.status).toBe('failed');
  });

  it('4. permission error (403 FORBIDDEN / EACCES) on file read -> fails closed, never swallowed as empty', async () => {
    fileProvider.injectedErrors.set(
      'read:observations.md',
      new ForbiddenError('Access denied: operation not permitted on observations.md')
    );

    await createTask();
    const worker = createWorker();

    const tickResult = await worker.tick();
    expect(tickResult.processed).toBe(true);
    expect(tickResult.status).toBe('failed');
    expect(dispatcherCallCount).toBe(0);

    const taskRecord = await operationsService.forTenant(tenantUUID).tasks.getTask(weeklyTaskId);
    expect(taskRecord.status).toBe('failed');
  });

  it('5. timeout / service unavailable (503 SERVICE_UNAVAILABLE) on file read -> fails closed, never swallowed', async () => {
    fileProvider.injectedErrors.set(
      'read:observations.md',
      new PlatformError('Service unavailable: container offline or timeout', 'SERVICE_UNAVAILABLE', 503)
    );

    await createTask();
    const worker = createWorker();

    const tickResult = await worker.tick();
    expect(tickResult.processed).toBe(true);
    expect(tickResult.status).toBe('failed');
    expect(dispatcherCallCount).toBe(0);

    const taskRecord = await operationsService.forTenant(tenantUUID).tasks.getTask(weeklyTaskId);
    expect(taskRecord.status).toBe('failed');
  });

  it('6. expected missing optional files (ENOENT / 404) -> legitimate 0 records with source count diagnostic', async () => {
    // observations.md, knowledge-buffer.md, interaction-buffer.md, checkpoint are ALL legitimately absent (ENOENT)
    const spaceDir = path.join(testSpacesRoot, spaceFolder);
    expect(fs.existsSync(path.join(spaceDir, 'observations.md'))).toBe(false);
    expect(fs.existsSync(path.join(spaceDir, 'pipeline', 'knowledge-buffer.md'))).toBe(false);

    await createTask();
    const worker = createWorker();

    const tickResult = await worker.tick();
    expect(tickResult.processed).toBe(true);
    expect(tickResult.status).toBe('completed');
    expect(dispatcherCallCount).toBe(1);

    const stagedDir = path.join(spaceDir, 'pipeline', 'inputs');
    const runDirs = fs.readdirSync(stagedDir);
    expect(runDirs.length).toBe(1);
    const runDir = path.join(stagedDir, runDirs[0]);

    const envelope = JSON.parse(fs.readFileSync(path.join(runDir, 'input.json'), 'utf8'));
    expect(envelope.capability).toBe('pipeline_aggregation');
    // Legit 0 records with diagnostic preserved
    expect(envelope.sections.observations.totalObservationsCount).toBe(0);
    expect(envelope.sections.observations.spacesCount).toBe(0);
    expect(envelope.sections.buffers.knowledgeBufferSize).toBe(0);
    expect(envelope.sections.buffers.interactionBufferSize).toBe(0);
  });

  it('7. retry after failed staging -> previous failure left no committed manifest, clean retry stages without mixed partials', async () => {
    const spaceDir = path.join(testSpacesRoot, spaceFolder);
    const { sinceDate } = computeLosAngelesCompletedSevenDays();
    const [y, m, d] = sinceDate.split('-').map(Number);
    const midDate = new Date(Date.UTC(y, m - 1, d + 2)).toISOString().slice(0, 10);

    // Initial attempt: 502 on observations.md
    fileProvider.injectedErrors.set(
      'read:observations.md',
      new PlatformError('Bad gateway: 502 PROVIDER_PROTOCOL_ERROR', 'PROVIDER_PROTOCOL_ERROR', 502)
    );

    await createTask();
    const worker = createWorker();

    const firstTick = await worker.tick();
    expect(firstTick.status).toBe('failed');
    expect(dispatcherCallCount).toBe(0);

    // Manifest input.json was never written
    const stagedInputsDir = path.join(spaceDir, 'pipeline', 'inputs');
    if (fs.existsSync(stagedInputsDir)) {
      const runDirs = fs.readdirSync(stagedInputsDir);
      for (const r of runDirs) {
        expect(fs.existsSync(path.join(stagedInputsDir, r, 'input.json'))).toBe(false);
      }
    }

    // Now transport recovers (e.g. daemon fix applied)
    fileProvider.injectedErrors.clear();
    fs.writeFileSync(
      path.join(spaceDir, 'observations.md'),
      `## [${midDate}T14:20:00.000Z] Recovered observation after retry\n`,
      'utf8'
    );

    // Retry task with second run (simulating manual retry or scheduler retry)
    const retryTaskId = 'task_00000000000000000000000000000002';
    const manifestContent = {
      $schema: 'enkeep/pipeline-task-capabilities-v1',
      requiredTaskIds: [retryTaskId],
      tasks: {
        [retryTaskId]: {
          capability: 'pipeline_aggregation',
          targetSpaceId: spaceId,
          sourceSpaceIds: [spaceId],
          checkpointPath: 'pipeline/.weekly-aggregation-last-checkpoint',
          stagedInputPrefix: 'pipeline/inputs',
        },
      },
    };
    fs.writeFileSync(testManifestPath, JSON.stringify(manifestContent, null, 2), 'utf8');

    await createTask(retryTaskId);
    const retryWorker = createWorker();
    const retryTick = await retryWorker.tick();
    expect(retryTick.status).toBe('completed');
    expect(dispatcherCallCount).toBe(1);

    // Verify retry staged cleanly
    const allRunDirs = fs.readdirSync(stagedInputsDir);
    const validRunDirs = allRunDirs.filter((r) => fs.existsSync(path.join(stagedInputsDir, r, 'input.json')));
    expect(validRunDirs.length).toBe(1);

    const retryEnvelope = JSON.parse(fs.readFileSync(path.join(stagedInputsDir, validRunDirs[0], 'input.json'), 'utf8'));
    expect(retryEnvelope.sections.observations.totalObservationsCount).toBe(1);
    expect(retryEnvelope.sections.observations.spacesCount).toBe(1);
  });
});
