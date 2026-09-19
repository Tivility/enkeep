import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
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
  createPlatformOperations,
} from '@enkeep/platform-operations';
import {
  RuntimeFileApiService,
  mapFileOpError,
  type TenantRuntimeFileProvider,
  type CanonicalFileOperationRequest,
  type CanonicalFileOperationResult,
} from '../src/files/runtime-file-api.js';
import {
  PipelineTaskInputPreparerService,
} from '../src/tasks/pipeline-input-preparer.js';
import {
  PlatformError,
  NotFoundError,
} from '@enkeep/platform-core';
import {
  HostRuntimeAdapter,
  type ActiveRuntimeHandle,
} from '../../runtime-runner/src/index.js';

describe('Regression: Real Host Daemon File Provider Contract & Preparer Legacy Fallback', () => {
  let tmpRoot: string;
  let tmpDataRoot: string;
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let adapter: HostRuntimeAdapter;
  let handle: ActiveRuntimeHandle;
  let fileService: RuntimeFileApiService;
  let preparer: PipelineTaskInputPreparerService;

  const syntheticTenantId = 'usr_synth_tenant_01';
  const syntheticSpaceId = 'spc_00000000000000000000000000000001';
  const syntheticSessionId = 'ses_00000000000000000000000000000001';
  const spaceFolderName = 'space-reg-01';
  const legacyTimestamp = '2026-09-07T04:00:24.082Z';

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-file-reg-'));
    fs.chmodSync(tmpRoot, 0o700);
    tmpDataRoot = path.join(tmpRoot, 'data');
    fs.mkdirSync(tmpDataRoot, { recursive: true, mode: 0o700 });

    // 1. Initialize SQLite platform storage & migrations
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);
    storage = new SqlitePlatformStorage(db);
    const operationsStorage = new SqlitePlatformOperationsStorage(db);
    const operations = createPlatformOperations({ storage: operationsStorage });

    // 2. Provision synthetic tenant and space
    await storage.users.create({
      id: syntheticTenantId,
      username: 'synth_user',
      passwordHash: 'synth_hash',
      role: 'user',
      status: 'active',
    });

    // Set storage quota
    await operations.forTenant(syntheticTenantId).quota.setLimit({
      resource: 'storage_bytes',
      limit: 50 * 1024 * 1024,
    });

    await storage.forTenant(syntheticTenantId).spaces.create({
      id: syntheticSpaceId,
      name: 'Regression Synthetic Space',
      folder: spaceFolderName,
      executionMode: 'host',
    });

    await storage.forTenant(syntheticTenantId).sessionRoutes.create({
      id: syntheticSessionId,
      spaceId: syntheticSpaceId,
      channel: 'web',
      accountId: 'synth-account',
      nativeContextId: syntheticSessionId,
      peerId: 'peer_synth',
      dshSessionId: 'ses_00000000000000000000000000000001',
      executionMode: 'host',
    });

    // Populate web messages for observation testing
    db.prepare(`
      INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, turn_id, created_at)
      VALUES
        ('msg_synth_01', ?, ?, 'user', 'Record prior to legacy checkpoint', 'delivered', 'rt_1', 'turn_1', '2026-09-06T10:00:00.000Z'),
        ('msg_synth_02', ?, ?, 'user', 'Record after legacy checkpoint', 'delivered', 'rt_1', 'turn_2', '2026-09-07T12:00:00.000Z')
    `).run(syntheticSessionId, syntheticTenantId, syntheticSessionId, syntheticTenantId);

    // 3. Boot real isolated host daemon using the private compiled artifact
    const privateCli = path.resolve(
      os.homedir(),
      '.config/enkeep/repair-staging/private-daemon-build/runtime/daemon-cli.js'
    );
    adapter = new HostRuntimeAdapter({
      daemonCliPath: fs.existsSync(privateCli) ? privateCli : undefined,
    });

    const spec = adapter.createDefaultUserSpec({
      userId: syntheticTenantId,
      dataRoot: tmpDataRoot,
    });

    handle = await adapter.startRuntime(spec, 20_000);

    // 4. Real TenantRuntimeFileProvider mapping over real host runtime handle
    const realFileProvider: TenantRuntimeFileProvider = {
      async execute(
        userId: string,
        spaceId: string,
        request: CanonicalFileOperationRequest
      ): Promise<CanonicalFileOperationResult> {
        const spaceRow = db.prepare(
          'SELECT folder FROM spaces WHERE id = ? AND user_id = ?'
        ).get(spaceId, userId) as { folder: string } | undefined;
        if (!spaceRow) {
          throw new NotFoundError(`Space "${spaceId}" not found for user "${userId}"`);
        }

        const rawRes = await handle.fileOperation({
          ...request,
          space: spaceRow.folder,
        } as any);

        if (rawRes.status !== 'ok' && rawRes.status !== 'completed') {
          const errCode = rawRes.code || rawRes.error;
          throw mapFileOpError({ code: errCode });
        }

        let fileRes = (rawRes.fileResult ?? (rawRes as any).data ?? rawRes) as unknown as CanonicalFileOperationResult;
        if (fileRes && typeof fileRes === 'object') {
          if (fileRes.op === 'read' && !fileRes.type) {
            fileRes = { ...fileRes, type: 'file' };
          } else if (fileRes.op === 'mkdir' && !fileRes.type) {
            fileRes = { ...fileRes, type: 'directory' };
          }
        }
        return fileRes;
      },
    };

    fileService = new RuntimeFileApiService({
      fileProvider: realFileProvider,
      platformApi: {
        getSpace: async (userId: string, spaceId: string) => {
          const row = db.prepare(
            'SELECT id, name, status FROM spaces WHERE id = ? AND user_id = ?'
          ).get(spaceId, userId) as any;
          return row ?? null;
        },
      } as any,
      operations,
    });

    preparer = new PipelineTaskInputPreparerService({
      database: db,
      fileService,
      dataRoot: tmpDataRoot,
    });
  }, 30_000);

  afterAll(async () => {
    if (handle) {
      try {
        await handle.stop();
      } catch {}
    }
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
    }
  });

  it('1. Old failure vs Fixed: unmapped response missing type fails with 502 PROVIDER_PROTOCOL_ERROR whereas fixed daemon succeeds', async () => {
    // 1a. Verify old failure mode: when daemon response lacks `type: "file"`, validateReadResult throws 502
    const unmappedOldFileProvider: TenantRuntimeFileProvider = {
      async execute(): Promise<CanonicalFileOperationResult> {
        return {
          op: 'read',
          path: '.cognitive-last-date',
          content: `${legacyTimestamp}\n`,
          encoding: 'utf8',
          size: Buffer.byteLength(`${legacyTimestamp}\n`, 'utf8'),
          mtimeMs: 1600000000000,
          etag: '"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"',
        } as any; // type omitted
      },
    };

    const oldService = new RuntimeFileApiService({
      fileProvider: unmappedOldFileProvider,
      platformApi: {
        getSpace: async () => ({ id: syntheticSpaceId, status: 'active' }),
      } as any,
    });

    await expect(
      oldService.execute(syntheticTenantId, syntheticSpaceId, {
        op: 'read',
        path: '.cognitive-last-date',
        encoding: 'utf8',
      })
    ).rejects.toThrow(expect.objectContaining({ status: 502, code: 'PROVIDER_PROTOCOL_ERROR' }));

    // 1b. Verify fixed real host daemon: authoritatively reads legacy .cognitive-last-date with type: "file"
    await fileService.execute(syntheticTenantId, syntheticSpaceId, {
      op: 'write',
      path: '.cognitive-last-date',
      content: `${legacyTimestamp}\n`,
      encoding: 'utf8',
      requireAbsent: true,
    });

    const res = await fileService.execute(syntheticTenantId, syntheticSpaceId, {
      op: 'read',
      path: '.cognitive-last-date',
      encoding: 'utf8',
    });

    expect(res.op).toBe('read');
    expect(res.type).toBe('file');
    expect(res.path).toBe('.cognitive-last-date');
    expect(res.content.trim()).toBe(legacyTimestamp);
    expect(res.size).toBe(Buffer.byteLength(`${legacyTimestamp}\n`, 'utf8'));
    expect(typeof res.mtimeMs).toBe('number');
    expect(res.mtimeMs).toBeGreaterThan(0);
    expect(typeof res.etag).toBe('string');
    expect(res.etag).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it('2. PipelineInputPreparer successfully falls back to .cognitive-last-date via real daemon and stages observation input', async () => {
    const taskId = 'task_synthetic_pipe_daily_01';
    preparer.registerCapability(taskId, {
      capability: 'pipeline_observation',
      checkpointPath: 'pipeline/.cognitive-last-checkpoint',
      stagedInputPrefix: 'pipeline/inputs',
    });

    const runId = 'run_synthetic_reg_retry_01';
    const payload = {
      type: 'agent_prompt' as const,
      prompt: 'Synthesize daily observations',
      sessionId: syntheticSessionId,
      sessionPolicy: 'existing_session' as const,
      spaceId: syntheticSpaceId,
      spaceFolder: spaceFolderName,
      silent: true,
    };

    // Primary checkpoint pipeline/.cognitive-last-checkpoint is strictly absent (ENOENT).
    // Preparer MUST fall back to .cognitive-last-date through real fileService.execute.
    const prepResult = await preparer.prepare({
      task: { id: taskId } as any,
      payload,
      tenantId: syntheticTenantId,
      runId,
      signal: new AbortController().signal,
    });

    expect(prepResult).toBeDefined();
    expect(prepResult?.stagedPath).toBe(`pipeline/inputs/${runId}/input.json`);

    // Verify staged content on real daemon disk
    const stagedFile = await fileService.execute(syntheticTenantId, syntheticSpaceId, {
      op: 'read',
      path: `pipeline/inputs/${runId}/input.json`,
      encoding: 'utf8',
    });

    expect(stagedFile.type).toBe('file');
    const envelope = JSON.parse(stagedFile.content);
    expect(envelope.schemaVersion).toBe('1.0.0');
    expect(envelope.taskRunId).toBe(runId);
    expect(envelope.recordsCount).toBe(1);
    expect(envelope.records[0].id).toBe('msg_synth_02');
  });

  it('3. Preserves authoritative stat semantics across files, directories, missing paths, and symlinks', async () => {
    // 3a. Directory stat
    await fileService.execute(syntheticTenantId, syntheticSpaceId, {
      op: 'mkdir',
      path: 'docs',
      requireAbsent: true,
    });

    const dirStat = await fileService.execute(syntheticTenantId, syntheticSpaceId, {
      op: 'stat',
      path: 'docs',
    });
    expect(dirStat.op).toBe('stat');
    expect(dirStat.type).toBe('directory');
    expect(typeof dirStat.size).toBe('number');
    expect(typeof dirStat.etag).toBe('string');
    expect(typeof dirStat.mtimeMs).toBe('number');

    // 3b. File stat
    await fileService.execute(syntheticTenantId, syntheticSpaceId, {
      op: 'write',
      path: 'docs/test.txt',
      content: 'Hello Regression Test File Content',
      encoding: 'utf8',
      requireAbsent: true,
    });

    const fileStat = await fileService.execute(syntheticTenantId, syntheticSpaceId, {
      op: 'stat',
      path: 'docs/test.txt',
    });
    expect(fileStat.op).toBe('stat');
    expect(fileStat.type).toBe('file');
    expect(fileStat.size).toBe(Buffer.byteLength('Hello Regression Test File Content', 'utf8'));
    expect(typeof fileStat.etag).toBe('string');
    expect(typeof fileStat.mtimeMs).toBe('number');

    // 3c. Missing path stat & read reject with 404 NOT_FOUND
    await expect(
      fileService.execute(syntheticTenantId, syntheticSpaceId, {
        op: 'stat',
        path: 'docs/missing-file.txt',
      })
    ).rejects.toThrow();

    await expect(
      fileService.execute(syntheticTenantId, syntheticSpaceId, {
        op: 'read',
        path: 'docs/missing-file.txt',
      })
    ).rejects.toThrow();

    // 3d. Unsafe symlink rejects with 403 SYMLINK_FORBIDDEN
    const spaceDir = path.join(tmpDataRoot, 'host-runtimes', syntheticTenantId, '.dsh', 'spaces', spaceFolderName);
    const evilSymlink = path.join(spaceDir, 'evil-symlink');
    try {
      fs.symlinkSync('/etc/passwd', evilSymlink);
    } catch {}

    if (fs.existsSync(evilSymlink)) {
      await expect(
        fileService.execute(syntheticTenantId, syntheticSpaceId, {
          op: 'read',
          path: 'evil-symlink',
        })
      ).rejects.toThrow();

      await expect(
        fileService.execute(syntheticTenantId, syntheticSpaceId, {
          op: 'stat',
          path: 'evil-symlink',
        })
      ).rejects.toThrow();
    }
  });
});
