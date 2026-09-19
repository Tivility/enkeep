import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  PipelineTaskInputPreparerService,
  isValidIsoDateString,
  isFileNotFoundError,
} from '../src/tasks/pipeline-input-preparer.js';
// Real production consumer module
import {
  processStagedExtraction,
  commitCheckpoint,
} from '../../../reports/task-portability/staged-bundle/scripts/workspace-task-consumer.mjs';

describe('Daily Over Cap Fix & Bounded Staging Contract', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join('/tmp', `daily-fix-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function createMockFileService(filesMap: Map<string, string>) {
    return {
      execute: async (userId: string, spaceId: string, req: any) => {
        const key = `${userId}:${spaceId}:${req.path}`;
        if (req.op === 'read') {
          if (!filesMap.has(key)) {
            const err: any = new Error(`File not found: ${req.path}`);
            err.code = 'ENOENT';
            err.status = 404;
            throw err;
          }
          return { content: filesMap.get(key)!, size: Buffer.byteLength(filesMap.get(key)!, 'utf8') };
        }
        if (req.op === 'write') {
          if (req.requireAbsent && filesMap.has(key)) {
            const err: any = new Error(`File already exists: ${req.path}`);
            err.code = 'EEXIST';
            err.status = 409;
            throw err;
          }
          filesMap.set(key, req.content);
          return { writtenBytes: Buffer.byteLength(req.content, 'utf8') };
        }
        throw new Error(`Unsupported op: ${req.op}`);
      },
    };
  }

  it('1. Legacy fallback: when primary checkpoint is ENOENT, falls back to .cognitive-last-date and retrieves exact baseline records', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT);
      CREATE TABLE spaces (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, folder TEXT, execution_mode TEXT, status TEXT, canonical_session_id TEXT);
      CREATE TABLE session_routes (id TEXT PRIMARY KEY, space_id TEXT, user_id TEXT, channel TEXT, status TEXT, created_at TEXT);
      CREATE TABLE web_messages (id TEXT PRIMARY KEY, session_id TEXT, user_id TEXT, role TEXT, content TEXT, status TEXT, turn_id TEXT, created_at TEXT);
    `);

    const tenantId = 'tenant_1';
    const spaceId = 'spc_host';
    const canonSessionId = 'ses_canon_1';
    const legacyDate = '2026-09-07T04:00:24.082Z';

    db.prepare('INSERT INTO users VALUES (?, ?)').run(tenantId, 'testuser');
    db.prepare('INSERT INTO spaces VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      spaceId, tenantId, 'Host', 'main--host', 'host', 'active', canonSessionId
    );
    db.prepare('INSERT INTO session_routes VALUES (?, ?, ?, ?, ?, ?)').run(
      canonSessionId, spaceId, tenantId, 'web', 'active', '2026-03-14T00:00:00.000Z'
    );

    // Insert 1 message before legacy date (excluded), 1 message AT legacy date (included >=), and 34 after (included)
    db.prepare(`
      INSERT INTO web_messages VALUES ('msg_old', ?, ?, 'user', 'Old message', 'delivered', 't_0', '2026-09-07T03:59:59.000Z')
    `).run(canonSessionId, tenantId);

    db.prepare(`
      INSERT INTO web_messages VALUES ('msg_boundary', ?, ?, 'assistant', 'Boundary message at exact ms', 'delivered', 't_1', ?)
    `).run(canonSessionId, tenantId, legacyDate);

    for (let i = 1; i <= 34; i++) {
      const ts = `2026-09-07T04:${String(i).padStart(2, '0')}:00.000Z`;
      db.prepare(`
        INSERT INTO web_messages VALUES (?, ?, ?, 'user', ?, 'delivered', 't_x', ?)
      `).run(`msg_subsequent_${String(i).padStart(3, '0')}`, canonSessionId, tenantId, `Subsequent ${i}`, ts);
    }

    // Storage map contains ONLY .cognitive-last-date, primary checkpoint is ENOENT
    const files = new Map<string, string>();
    files.set(`${tenantId}:${spaceId}:.cognitive-last-date`, `${legacyDate}\n`);

    const fileService = createMockFileService(files);
    const preparer = new PipelineTaskInputPreparerService({
      database: db,
      fileService: fileService as any,
    });

    const taskId = 'task_daily_01';
    preparer.registerCapability(taskId, {
      capability: 'pipeline_observation',
      targetSpaceId: spaceId,
      sourceSpaceIds: [spaceId],
      checkpointPath: 'pipeline/.cognitive-last-checkpoint',
      stagedInputPrefix: 'pipeline/inputs',
      maxRecordsLimit: 1000,
    });

    const runId = 'run_daily_test_000000000001';
    const res = await preparer.prepare({
      task: { id: taskId } as any,
      payload: { prompt: 'Run daily extraction', sessionId: canonSessionId, sessionPolicy: 'existing_session', spaceId },
      tenantId,
      runId,
      signal: new AbortController().signal,
    });

    expect(res).toBeDefined();
    expect(res?.stagedPath).toBe(`pipeline/inputs/${runId}/input.json`);

    // Verify staged file
    const stagedKey = `${tenantId}:${spaceId}:pipeline/inputs/${runId}/input.json`;
    expect(files.has(stagedKey)).toBe(true);

    const envelope = JSON.parse(files.get(stagedKey)!);
    expect(envelope.schemaVersion).toBe('1.0.0');
    expect(envelope.capability).toBe('pipeline_observation');
    // Exactly 35 records: 1 at boundary ms + 34 subsequent
    expect(envelope.recordsCount).toBe(35);
    expect(envelope.records.length).toBe(35);
    expect(envelope.records[0].id).toBe('msg_boundary');
    expect(envelope.records[0].createdAt).toBe(legacyDate);
    expect(envelope.records[34].id).toBe('msg_subsequent_034');

    // Watermark matches 35th message
    expect(envelope.window.checkpointWatermark).toEqual({
      createdAt: '2026-09-07T04:34:00.000Z',
      id: 'msg_subsequent_034',
    });
  });

  it('2. Strict failure on corrupted/illegal primary checkpoint: does NOT fallback or reset to empty', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE spaces (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, folder TEXT, execution_mode TEXT, status TEXT, canonical_session_id TEXT);
      CREATE TABLE session_routes (id TEXT PRIMARY KEY, space_id TEXT, user_id TEXT, status TEXT);
    `);
    const tenantId = 't_err';
    const spaceId = 'spc_err';
    db.prepare('INSERT INTO spaces VALUES (?, ?, ?, ?, ?, ?, ?)').run(spaceId, tenantId, 'Host', 'main--host', 'host', 'active', 'ses_1');
    db.prepare('INSERT INTO session_routes VALUES (?, ?, ?, ?)').run('ses_1', spaceId, tenantId, 'active');

    const files = new Map<string, string>();
    // Primary exists but has malformed JSON
    files.set(`${tenantId}:${spaceId}:pipeline/.cognitive-last-checkpoint`, '{ "createdAt": bad json');
    files.set(`${tenantId}:${spaceId}:.cognitive-last-date`, '2026-09-07T04:00:24.082Z');

    const fileService = createMockFileService(files);
    const preparer = new PipelineTaskInputPreparerService({
      database: db,
      fileService: fileService as any,
    });

    const taskId = 'task_err_01';
    preparer.registerCapability(taskId, {
      capability: 'pipeline_observation',
      targetSpaceId: spaceId,
      checkpointPath: 'pipeline/.cognitive-last-checkpoint',
    });

    await expect(
      preparer.prepare({
        task: { id: taskId } as any,
        payload: { prompt: 'Daily', sessionId: 'ses_1', sessionPolicy: 'existing_session', spaceId },
        tenantId,
        runId: 'run_err_0001',
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/\[INVALID_CHECKPOINT\].*malformed JSON/i);

    // Primary exists with non-JSON corrupted text
    files.set(`${tenantId}:${spaceId}:pipeline/.cognitive-last-checkpoint`, 'CORRUPTED NOT JSON');
    await expect(
      preparer.prepare({
        task: { id: taskId } as any,
        payload: { prompt: 'Daily', sessionId: 'ses_1', sessionPolicy: 'existing_session', spaceId },
        tenantId,
        runId: 'run_err_0001_b',
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/\[INVALID_CHECKPOINT\].*invalid ISO date string/i);

    // Primary exists but has invalid ISO date
    files.set(`${tenantId}:${spaceId}:pipeline/.cognitive-last-checkpoint`, JSON.stringify({ createdAt: 'invalid-date-xyz' }));
    await expect(
      preparer.prepare({
        task: { id: taskId } as any,
        payload: { prompt: 'Daily', sessionId: 'ses_1', sessionPolicy: 'existing_session', spaceId },
        tenantId,
        runId: 'run_err_0002',
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/\[INVALID_CHECKPOINT\].*invalid or future createdAt/i);
  });

  it('3. Two-run idempotent boundary: Run 1 advances watermark, Run 2 uses composite keyset with zero duplicates', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE spaces (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, folder TEXT, execution_mode TEXT, status TEXT, canonical_session_id TEXT);
      CREATE TABLE session_routes (id TEXT PRIMARY KEY, space_id TEXT, user_id TEXT, channel TEXT, status TEXT, created_at TEXT);
      CREATE TABLE web_messages (id TEXT PRIMARY KEY, session_id TEXT, user_id TEXT, role TEXT, content TEXT, status TEXT, turn_id TEXT, created_at TEXT);
    `);

    const tenantId = 'tenant_2run';
    const spaceId = 'spc_2run';
    const canonSessionId = 'ses_canon_2run';

    db.prepare('INSERT INTO spaces VALUES (?, ?, ?, ?, ?, ?, ?)').run(spaceId, tenantId, 'Host', 'main--host', 'host', 'active', canonSessionId);
    db.prepare('INSERT INTO session_routes VALUES (?, ?, ?, ?, ?, ?)').run(canonSessionId, spaceId, tenantId, 'web', 'active', '2026-03-14T00:00:00.000Z');

    const t0 = '2026-09-07T04:00:24.082Z';
    // 3 messages at exact same millisecond
    db.prepare("INSERT INTO web_messages VALUES ('msg_t0_1', ?, ?, 'user', 'M1', 'delivered', 't_1', ?)").run(canonSessionId, tenantId, t0);
    db.prepare("INSERT INTO web_messages VALUES ('msg_t0_2', ?, ?, 'assistant', 'M2', 'delivered', 't_1', ?)").run(canonSessionId, tenantId, t0);
    db.prepare("INSERT INTO web_messages VALUES ('msg_t0_3', ?, ?, 'user', 'M3', 'delivered', 't_2', ?)").run(canonSessionId, tenantId, t0);

    // Initial state: fallback to .cognitive-last-date = t0
    const files = new Map<string, string>();
    files.set(`${tenantId}:${spaceId}:.cognitive-last-date`, `${t0}\n`);

    const fileService = createMockFileService(files);
    const preparer = new PipelineTaskInputPreparerService({
      database: db,
      fileService: fileService as any,
    });

    const taskId = 'task_2run';
    preparer.registerCapability(taskId, {
      capability: 'pipeline_observation',
      targetSpaceId: spaceId,
      sourceSpaceIds: [spaceId],
      checkpointPath: 'pipeline/.cognitive-last-checkpoint',
      stagedInputPrefix: 'pipeline/inputs',
      maxRecordsLimit: 1000,
    });

    // Run 1: processes all 3 messages
    await preparer.prepare({
      task: { id: taskId } as any,
      payload: { prompt: 'Run 1', sessionId: canonSessionId, sessionPolicy: 'existing_session', spaceId },
      tenantId,
      runId: 'run_batch_1',
      signal: new AbortController().signal,
    });

    const run1Key = `${tenantId}:${spaceId}:pipeline/inputs/run_batch_1/input.json`;
    const run1Env = JSON.parse(files.get(run1Key)!);
    expect(run1Env.recordsCount).toBe(3);
    expect(run1Env.records.map((r: any) => r.id)).toEqual(['msg_t0_1', 'msg_t0_2', 'msg_t0_3']);
    expect(run1Env.window.checkpointWatermark).toEqual({
      createdAt: t0,
      id: 'msg_t0_3',
    });

    // Simulate consumer committing watermark after 3 receipts verified
    const committedWatermark = {
      ...run1Env.window.checkpointWatermark,
      committedAt: new Date().toISOString(),
    };
    files.set(
      `${tenantId}:${spaceId}:pipeline/.cognitive-last-checkpoint`,
      JSON.stringify(committedWatermark, null, 2)
    );

    // Run 2: starts with newly committed composite watermark (t0, 'msg_t0_3')
    await preparer.prepare({
      task: { id: taskId } as any,
      payload: { prompt: 'Run 2', sessionId: canonSessionId, sessionPolicy: 'existing_session', spaceId },
      tenantId,
      runId: 'run_batch_2',
      signal: new AbortController().signal,
    });

    const run2Key = `${tenantId}:${spaceId}:pipeline/inputs/run_batch_2/input.json`;
    const run2Env = JSON.parse(files.get(run2Key)!);
    // ZERO duplicates!
    expect(run2Env.recordsCount).toBe(0);
    expect(run2Env.records).toEqual([]);

    // Now insert a new message at t0 with id > msg_t0_3, and a new message at t1
    db.prepare("INSERT INTO web_messages VALUES ('msg_t0_4', ?, ?, 'user', 'M4', 'delivered', 't_3', ?)").run(canonSessionId, tenantId, t0);
    db.prepare("INSERT INTO web_messages VALUES ('msg_t1_1', ?, ?, 'user', 'M5', 'delivered', 't_4', '2026-09-07T05:00:00.000Z')").run(canonSessionId, tenantId);

    // Run 3: picks up only the new messages without gaps or duplicates
    await preparer.prepare({
      task: { id: taskId } as any,
      payload: { prompt: 'Run 3', sessionId: canonSessionId, sessionPolicy: 'existing_session', spaceId },
      tenantId,
      runId: 'run_batch_3',
      signal: new AbortController().signal,
    });

    const run3Key = `${tenantId}:${spaceId}:pipeline/inputs/run_batch_3/input.json`;
    const run3Env = JSON.parse(files.get(run3Key)!);
    expect(run3Env.recordsCount).toBe(2);
    expect(run3Env.records.map((r: any) => r.id)).toEqual(['msg_t0_4', 'msg_t1_1']);
  });

  it('4. Real workspace-task-consumer integration: validates envelope, consumes records, gates checkpoint advance', async () => {
    const fsFiles = new Map<string, string>();
    const localFsService = {
      execute: async (_u: string, _s: string, req: any) => {
        const full = path.join(tmpDir, req.path);
        if (req.op === 'read') {
          if (!fs.existsSync(full)) {
            const err: any = new Error(`File not found: ${req.path}`);
            err.code = 'ENOENT';
            throw err;
          }
          return { content: fs.readFileSync(full, 'utf8') };
        }
        if (req.op === 'write') {
          const dir = path.dirname(full);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          if (req.requireAbsent && fs.existsSync(full)) {
            const err: any = new Error(`File exists: ${req.path}`);
            err.code = 'EEXIST';
            throw err;
          }
          fs.writeFileSync(full, req.content, 'utf8');
          return { writtenBytes: Buffer.byteLength(req.content, 'utf8') };
        }
      },
    };

    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE spaces (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, folder TEXT, execution_mode TEXT, status TEXT, canonical_session_id TEXT);
      CREATE TABLE session_routes (id TEXT PRIMARY KEY, space_id TEXT, user_id TEXT, channel TEXT, status TEXT, created_at TEXT);
      CREATE TABLE web_messages (id TEXT PRIMARY KEY, session_id TEXT, user_id TEXT, role TEXT, content TEXT, status TEXT, turn_id TEXT, created_at TEXT);
    `);
    const tenantId = 't_cons';
    const spaceId = 'spc_cons';
    const canonSessionId = 'ses_cons';
    db.prepare('INSERT INTO spaces VALUES (?, ?, ?, ?, ?, ?, ?)').run(spaceId, tenantId, 'Host', 'main--host', 'host', 'active', canonSessionId);
    db.prepare('INSERT INTO session_routes VALUES (?, ?, ?, ?, ?, ?)').run(canonSessionId, spaceId, tenantId, 'web', 'active', '2026-03-14T00:00:00.000Z');

    // Create 5 synthetic messages
    for (let i = 1; i <= 5; i++) {
      db.prepare("INSERT INTO web_messages VALUES (?, ?, ?, 'user', ?, 'delivered', 't_x', ?)").run(
        `msg_cons_${i}`, canonSessionId, tenantId, `Content ${i}`, `2026-09-08T10:0${i}:00.000Z`
      );
    }

    const preparer = new PipelineTaskInputPreparerService({
      database: db,
      fileService: localFsService as any,
    });

    const taskId = 'task_cons_01';
    preparer.registerCapability(taskId, {
      capability: 'pipeline_observation',
      targetSpaceId: spaceId,
      sourceSpaceIds: [spaceId],
      checkpointPath: 'pipeline/.cognitive-last-checkpoint',
      stagedInputPrefix: 'pipeline/inputs',
    });

    const runId = 'run_consumer_integration_001';
    const prepRes = await preparer.prepare({
      task: { id: taskId } as any,
      payload: { prompt: 'Extract observations', sessionId: canonSessionId, sessionPolicy: 'existing_session', spaceId },
      tenantId,
      runId,
      signal: new AbortController().signal,
    });

    expect(prepRes).toBeDefined();

    const manifestFullPath = path.join(tmpDir, prepRes!.stagedPath);
    const checkpointFullPath = path.join(tmpDir, 'pipeline/.cognitive-last-checkpoint');

    // Execute real production consumer on the staged file
    const consumerResult = processStagedExtraction({
      inputPathOrGuidance: manifestFullPath,
      checkpointFilePath: checkpointFullPath,
      dryRun: false,
    });

    expect(consumerResult.success).toBe(true);
    expect(consumerResult.taskRunId).toBe(runId);
    expect(consumerResult.recordsCount).toBe(5);
    expect(consumerResult.watermark).toEqual({
      createdAt: '2026-09-08T10:05:00.000Z',
      id: 'msg_cons_5',
    });

    // Checkpoint must NOT be created before persistence
    expect(fs.existsSync(checkpointFullPath)).toBe(false);

    // If one receipt is missing -> fails explicitly
    expect(() => {
      consumerResult.commitCheckpointAfterPersist({
        cognitivePersisted: true,
        knowledgePersisted: false,
        interactionPersisted: true,
      });
    }).toThrow(/\[PERSIST_INCOMPLETE\]/);
    expect(fs.existsSync(checkpointFullPath)).toBe(false);

    // All 3 receipts verified -> commits checkpoint atomically
    consumerResult.commitCheckpointAfterPersist({
      cognitivePersisted: true,
      knowledgePersisted: true,
      interactionPersisted: true,
    });
    expect(fs.existsSync(checkpointFullPath)).toBe(true);

    const committed = JSON.parse(fs.readFileSync(checkpointFullPath, 'utf8'));
    expect(committed.createdAt).toBe('2026-09-08T10:05:00.000Z');
    expect(committed.id).toBe('msg_cons_5');
    expect(committed.committedAt).toBeDefined();
  });

  it('5. Bounded manifest & sections pagination (>1000 records) verified with real consumer', async () => {
    const localFsService = {
      execute: async (_u: string, _s: string, req: any) => {
        const full = path.join(tmpDir, req.path);
        if (req.op === 'read') {
          if (!fs.existsSync(full)) {
            const err: any = new Error(`File not found: ${req.path}`);
            err.code = 'ENOENT';
            throw err;
          }
          return { content: fs.readFileSync(full, 'utf8') };
        }
        if (req.op === 'write') {
          const dir = path.dirname(full);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          if (req.requireAbsent && fs.existsSync(full)) {
            const err: any = new Error(`File exists: ${req.path}`);
            err.code = 'EEXIST';
            throw err;
          }
          fs.writeFileSync(full, req.content, 'utf8');
          return { writtenBytes: Buffer.byteLength(req.content, 'utf8') };
        }
      },
    };

    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE spaces (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, folder TEXT, execution_mode TEXT, status TEXT, canonical_session_id TEXT);
      CREATE TABLE session_routes (id TEXT PRIMARY KEY, space_id TEXT, user_id TEXT, channel TEXT, status TEXT, created_at TEXT);
      CREATE TABLE web_messages (id TEXT PRIMARY KEY, session_id TEXT, user_id TEXT, role TEXT, content TEXT, status TEXT, turn_id TEXT, created_at TEXT);
    `);
    const tenantId = 't_page';
    const spaceId = 'spc_page';
    const canonSessionId = 'ses_page';
    db.prepare('INSERT INTO spaces VALUES (?, ?, ?, ?, ?, ?, ?)').run(spaceId, tenantId, 'Host', 'main--host', 'host', 'active', canonSessionId);
    db.prepare('INSERT INTO session_routes VALUES (?, ?, ?, ?, ?, ?)').run(canonSessionId, spaceId, tenantId, 'web', 'active', '2026-03-14T00:00:00.000Z');

    // Populate 1050 records
    const insertStmt = db.prepare(`
      INSERT INTO web_messages VALUES (?, ?, ?, 'user', ?, 'delivered', 't_x', ?)
    `);
    for (let i = 1; i <= 1050; i++) {
      const ts = `2026-09-08T12:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`;
      insertStmt.run(`msg_p_${String(i).padStart(4, '0')}`, canonSessionId, tenantId, `Payload record ${i}`, ts);
    }

    const preparer = new PipelineTaskInputPreparerService({
      database: db,
      fileService: localFsService as any,
    });

    const taskId = 'task_page_01';
    // Enable pagination with batch cap of 1000 records
    preparer.registerCapability(taskId, {
      capability: 'pipeline_observation',
      targetSpaceId: spaceId,
      sourceSpaceIds: [spaceId],
      checkpointPath: 'pipeline/.cognitive-last-checkpoint',
      stagedInputPrefix: 'pipeline/inputs',
      maxRecordsLimit: 1000,
      enablePagination: true,
    });

    const runId = 'run_pagination_test_001';
    const prepRes = await preparer.prepare({
      task: { id: taskId } as any,
      payload: { prompt: 'Paginated extract', sessionId: canonSessionId, sessionPolicy: 'existing_session', spaceId },
      tenantId,
      runId,
      signal: new AbortController().signal,
    });

    expect(prepRes).toBeDefined();
    const manifestFullPath = path.join(tmpDir, prepRes!.stagedPath);

    // Real consumer loads manifest and sections
    const consumerRes = processStagedExtraction({
      inputPathOrGuidance: manifestFullPath,
      checkpointFilePath: path.join(tmpDir, 'pipeline/.cognitive-last-checkpoint'),
      dryRun: true,
    });

    expect(consumerRes.success).toBe(true);
    expect(consumerRes.recordsCount).toBe(1000);
    expect(Object.keys(consumerRes.loadedSections).length).toBeGreaterThanOrEqual(1);

    // Verify sections content
    const part1Str = consumerRes.loadedSections['part_1'];
    expect(part1Str).toBeDefined();
    const part1Records = JSON.parse(part1Str);
    expect(Array.isArray(part1Records)).toBe(true);
    expect(part1Records[0].id).toBe('msg_p_0001');

    // Checkpoint watermark points to upper watermark of 1000th record
    expect(consumerRes.watermark.id).toBe('msg_p_1000');
  });

  it('6. Synthetic database fixture proof: resolves 35 messages with legacy fallback', async () => {
    const fixtureDb = new DatabaseSync(':memory:');
    fixtureDb.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, status TEXT);
      CREATE TABLE spaces (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, folder TEXT, execution_mode TEXT, status TEXT, canonical_session_id TEXT);
      CREATE TABLE session_routes (id TEXT PRIMARY KEY, space_id TEXT, user_id TEXT, channel TEXT, status TEXT, created_at TEXT);
      CREATE TABLE web_messages (id TEXT PRIMARY KEY, session_id TEXT, user_id TEXT, role TEXT, content TEXT, status TEXT, turn_id TEXT, created_at TEXT);
    `);

    const tenantId = '00000000-0000-0000-0000-000000000001';
    const targetSpaceId = 'spc_00000000000000000000000000000001';
    const targetSessionId = 'ses_0123456789abcdef0123456789abcdef';
    const taskId = 'task_hpc_000000000000000000000abc';

    fixtureDb.prepare('INSERT INTO users VALUES (?, ?, ?)').run(tenantId, 'alice', 'active');
    fixtureDb.prepare('INSERT INTO spaces VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      targetSpaceId, tenantId, 'Target Space', 'target--space', 'host', 'active', targetSessionId
    );
    fixtureDb.prepare('INSERT INTO session_routes VALUES (?, ?, ?, ?, ?, ?)').run(
      targetSessionId, targetSpaceId, tenantId, 'web', 'active', '2026-01-01T00:00:00.000Z'
    );

    const sourceSpaceIds = Array.from({ length: 24 }, (_, i) =>
      `spc_000000000000000000000000000000${(i + 2).toString().padStart(2, '0')}`
    );

    for (let i = 0; i < 24; i++) {
      const sId = sourceSpaceIds[i];
      const rId = `ses_000000000000000000000000000000${(i + 2).toString().padStart(2, '0')}`;
      fixtureDb.prepare('INSERT INTO spaces VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        sId, tenantId, `Source Space ${i}`, `source--space-${i}`, 'host', 'active', rId
      );
      fixtureDb.prepare('INSERT INTO session_routes VALUES (?, ?, ?, ?, ?, ?)').run(
        rId, sId, tenantId, 'web', 'active', '2026-01-01T00:00:00.000Z'
      );
    }

    // Insert 35 messages across the source spaces
    // Message 1 at legacy fallback date: 2026-09-07T04:00:24.082Z
    fixtureDb.prepare(`
      INSERT INTO web_messages VALUES ('msg_hpc_000000000000000000000001', ?, ?, 'user', 'First message', 'delivered', 't_1', '2026-09-07T04:00:24.082Z')
    `).run('ses_00000000000000000000000000000002', tenantId);

    // Messages 2..34
    for (let i = 2; i <= 34; i++) {
      const sIdx = (i % 24) + 2;
      const rId = `ses_000000000000000000000000000000${sIdx.toString().padStart(2, '0')}`;
      const ts = new Date(Date.parse('2026-09-07T04:00:24.082Z') + i * 3600 * 1000).toISOString();
      fixtureDb.prepare(`
        INSERT INTO web_messages VALUES (?, ?, ?, 'user', ?, 'delivered', ?, ?)
      `).run(`msg_000000000000000000000000000000${i.toString().padStart(2, '0')}`, rId, tenantId, `Message ${i}`, `t_${i}`, ts);
    }

    // Message 35 at 2026-09-11T06:27:59.627Z
    fixtureDb.prepare(`
      INSERT INTO web_messages VALUES ('msg_00000000000000000000000000000035', ?, ?, 'user', 'Final message', 'delivered', 't_35', '2026-09-11T06:27:59.627Z')
    `).run('ses_00000000000000000000000000000002', tenantId);

    // Mock file service representing target space with .cognitive-last-date present and primary absent
    const files = new Map<string, string>();
    files.set(`${tenantId}:${targetSpaceId}:.cognitive-last-date`, '2026-09-07T04:00:24.082Z\n');

    const fileService = createMockFileService(files);
    const preparer = new PipelineTaskInputPreparerService({
      database: fixtureDb,
      fileService: fileService as any,
    });

    preparer.registerCapability(taskId, {
      capability: 'pipeline_observation',
      targetSpaceId,
      sourceSpaceIds,
      checkpointPath: 'pipeline/.cognitive-last-checkpoint',
      stagedInputPrefix: 'pipeline/inputs',
      maxRecordsLimit: 1000,
      maxChunkSizeBytes: 1048576,
    });

    const runId = 'run_production_verify_001';
    const prepRes = await preparer.prepare({
      task: { id: taskId } as any,
      payload: {
        prompt: 'Daily test prompt',
        sessionId: targetSessionId,
        sessionPolicy: 'existing_session',
        spaceId: targetSpaceId,
      },
      tenantId,
      runId,
      signal: new AbortController().signal,
    });

    expect(prepRes).toBeDefined();

    const stagedKey = `${tenantId}:${targetSpaceId}:pipeline/inputs/${runId}/input.json`;
    expect(files.has(stagedKey)).toBe(true);

    const stagedEnvelope = JSON.parse(files.get(stagedKey)!);
    expect(stagedEnvelope.schemaVersion).toBe('1.0.0');
    expect(stagedEnvelope.taskRunId).toBe(runId);
    expect(stagedEnvelope.capability).toBe('pipeline_observation');
    expect(stagedEnvelope.recordsCount).toBe(35);
    expect(stagedEnvelope.records.length).toBe(35);
    expect(stagedEnvelope.records[0].id).toBe('msg_hpc_000000000000000000000001');
    expect(stagedEnvelope.records[0].createdAt).toBe('2026-09-07T04:00:24.082Z');
    expect(stagedEnvelope.records[34].id).toBe('msg_00000000000000000000000000000035');
    expect(stagedEnvelope.records[34].createdAt).toBe('2026-09-11T06:27:59.627Z');
    expect(stagedEnvelope.window.checkpointWatermark).toEqual({
      createdAt: '2026-09-11T06:27:59.627Z',
      id: 'msg_00000000000000000000000000000035',
    });
  });
});
