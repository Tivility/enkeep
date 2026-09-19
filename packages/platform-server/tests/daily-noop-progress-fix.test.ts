import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PipelineTaskInputPreparerService,
} from '../src/tasks/pipeline-input-preparer.js';
import {
  processStagedExtraction,
  commitCheckpoint,
} from './fixtures/workspace-task-consumer.fixture.mjs';

describe('Daily No-Op Progress & Processed-Watermark Contract', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: DatabaseSync;

  // Fully synthetic, valid identifiers (zero prod IDs in public test source)
  const tenantId = 'user_synth_tenant_01';
  const spaceId = 'space_synth_main_01';
  const canonSessionId = 'ses_synth_canon_01';
  const taskId = 'task_synth_daily_obs_01';

  // Synthetic 6-record window matching native no-op topology:
  // msg_synth_cursor_start_01 (cursor start) -> 4 automated recovery prompts + 2 assistant turns -> msg_synth_watermark_upper_06 (upper watermark)
  const initialCheckpointWatermark = {
    createdAt: '2026-09-11T08:12:18.807Z',
    id: 'msg_synth_cursor_start_01',
  };

  const fixtureRecords = [
    {
      id: 'msg_auto_rec_01',
      session_id: canonSessionId,
      user_id: tenantId,
      role: 'user',
      content: '# 任务恢复自检请求：请检查当前管道运行状态并同步最新配置',
      status: 'delivered',
      turn_id: 'turn_01',
      created_at: '2026-09-11T08:15:00.000Z',
    },
    {
      id: 'msg_auto_rec_02',
      session_id: canonSessionId,
      user_id: tenantId,
      role: 'assistant',
      content: '自检已完成，当前空间未检测到新增业务事件，所有服务正常。',
      status: 'delivered',
      turn_id: 'turn_01',
      created_at: '2026-09-11T08:15:30.000Z',
    },
    {
      id: 'msg_auto_rec_03',
      session_id: canonSessionId,
      user_id: tenantId,
      role: 'user',
      content: '# 恢复重试探测：执行空操作心跳确认',
      status: 'delivered',
      turn_id: 'turn_02',
      created_at: '2026-09-11T09:00:00.000Z',
    },
    {
      id: 'msg_auto_rec_04',
      session_id: canonSessionId,
      user_id: tenantId,
      role: 'assistant',
      content: '心跳确认通过，无需触发变更。',
      status: 'delivered',
      turn_id: 'turn_02',
      created_at: '2026-09-11T09:00:15.000Z',
    },
    {
      id: 'msg_auto_rec_05',
      session_id: canonSessionId,
      user_id: tenantId,
      role: 'user',
      content: '# 管道守护状态检查：确认前置依赖',
      status: 'delivered',
      turn_id: 'turn_03',
      created_at: '2026-09-11T10:00:00.000Z',
    },
    {
      id: 'msg_synth_watermark_upper_06',
      session_id: canonSessionId,
      user_id: tenantId,
      role: 'user',
      content: '# 阶段收尾指令：无新消息等待下一调度周期',
      status: 'delivered',
      turn_id: 'turn_04',
      created_at: '2026-09-11T10:31:28.125Z',
    },
  ];

  beforeEach(() => {
    tmpDir = path.join('/tmp', `daily-noop-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    dbPath = path.join(tmpDir, 'test_platform.db');
    db = new DatabaseSync(dbPath);

    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT);
      CREATE TABLE spaces (id TEXT PRIMARY KEY, user_id TEXT, folder TEXT, name TEXT, status TEXT, canonical_session_id TEXT);
      CREATE TABLE session_routes (id TEXT PRIMARY KEY, space_id TEXT, user_id TEXT, channel TEXT, status TEXT, created_at TEXT);
      CREATE TABLE web_messages (id TEXT PRIMARY KEY, session_id TEXT, user_id TEXT, role TEXT, content TEXT, status TEXT, turn_id TEXT, created_at TEXT);
    `);

    db.prepare('INSERT INTO users VALUES (?, ?)').run(tenantId, 'synth_owner');
    db.prepare('INSERT INTO spaces VALUES (?, ?, ?, ?, ?, ?)').run(
      spaceId,
      tenantId,
      'main--host',
      'Main Host',
      'active',
      canonSessionId
    );
    db.prepare('INSERT INTO session_routes VALUES (?, ?, ?, ?, ?, ?)').run(
      canonSessionId,
      spaceId,
      tenantId,
      'web',
      'active',
      '2026-09-11T00:00:00.000Z'
    );

    const insertMsg = db.prepare(
      'INSERT INTO web_messages (id, session_id, user_id, role, content, status, turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const r of fixtureRecords) {
      insertMsg.run(r.id, r.session_id, r.user_id, r.role, r.content, r.status, r.turn_id, r.created_at);
    }
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function createMockFileService(filesMap: Map<string, string>) {
    return {
      execute: async (userId: string, targetSpaceId: string, req: any) => {
        const key = `${userId}:${targetSpaceId}:${req.path}`;
        if (req.op === 'read') {
          if (!filesMap.has(key)) {
            const err: any = new Error(`File not found: ${req.path}`);
            err.code = 'ENOENT';
            err.status = 404;
            throw err;
          }
          return { content: filesMap.get(key) };
        }
        if (req.op === 'write') {
          if (req.requireAbsent && filesMap.has(key)) {
            const err: any = new Error(`File already exists: ${req.path}`);
            err.code = 'EEXIST';
            err.status = 409;
            throw err;
          }
          filesMap.set(key, req.content);
          return { written: true, sizeBytes: Buffer.byteLength(req.content, 'utf8') };
        }
        throw new Error(`Unsupported op: ${req.op}`);
      },
    };
  }

  it('Scenario 1: 3 complete verified_no_change receipts advance checkpoint to upper watermark without business file writes', async () => {
    const filesMap = new Map<string, string>();
    const checkpointPath = 'pipeline/.cognitive-last-checkpoint';

    // 1. Initial checkpoint file at cursor start
    filesMap.set(
      `${tenantId}:${spaceId}:${checkpointPath}`,
      JSON.stringify(initialCheckpointWatermark, null, 2)
    );

    // 2. Prepare task input via real PipelineTaskInputPreparerService
    const preparer = new PipelineTaskInputPreparerService({
      database: db,
      fileService: createMockFileService(filesMap),
      registrations: new Map([
        [
          taskId,
          {
            capability: 'pipeline_observation',
            targetSpaceId: spaceId,
            checkpointPath,
            stagedInputPrefix: 'pipeline/inputs',
          },
        ],
      ]),
    });

    const prepResult = await preparer.prepare({
      task: { id: taskId, execution_mode: 'agent' },
      payload: { prompt: '# 天级统一提取任务' },
      tenantId,
      runId: 'run_synth_noop_01',
    });

    expect(prepResult).toBeDefined();
    const stagedPath = prepResult!.stagedPath;
    const stagedContent = filesMap.get(`${tenantId}:${spaceId}:${stagedPath}`)!;
    expect(stagedContent).toBeDefined();

    // Write staged file and checkpoint to isolated filesystem for consumer execution
    const localInputPath = path.join(tmpDir, 'input.json');
    const localCheckpointPath = path.join(tmpDir, '.cognitive-last-checkpoint');
    fs.writeFileSync(localInputPath, stagedContent, 'utf8');
    fs.writeFileSync(localCheckpointPath, JSON.stringify(initialCheckpointWatermark, null, 2), 'utf8');

    // 3. Consumer processes staged input
    const consumerRes = processStagedExtraction({
      inputPathOrGuidance: localInputPath,
      checkpointFilePath: localCheckpointPath,
      dryRun: false,
    });

    expect(consumerRes.recordsCount).toBe(6);
    expect(consumerRes.sourceRecordIds).toHaveLength(6);
    expect(consumerRes.watermark.id).toBe('msg_synth_watermark_upper_06');

    // 4. Subagents examined all 6 records and yielded no business output
    const commitSuccess = consumerRes.commitCheckpointAfterPersist({
      cognitive: {
        status: 'no_change',
        stage: 'cognitive',
        inputSha256: consumerRes.inputSha256,
        coveredSourceIds: consumerRes.sourceRecordIds,
        reason: 'all 6 records evaluated: automated recovery prompts without cognitive pattern',
      },
      knowledge: {
        status: 'no_change',
        stage: 'knowledge',
        inputSha256: consumerRes.inputSha256,
        coveredSourceIds: consumerRes.sourceRecordIds,
        reason: 'all 6 records evaluated: automated recovery prompts without knowledge artifact',
      },
      interaction: {
        status: 'no_change',
        stage: 'interaction',
        inputSha256: consumerRes.inputSha256,
        coveredSourceIds: consumerRes.sourceRecordIds,
        reason: 'all 6 records evaluated: no human user interaction signals present',
      },
    });

    expect(commitSuccess).toBe(true);

    // 5. Verify checkpoint file advanced monotonically
    const updatedCheckpoint = JSON.parse(fs.readFileSync(localCheckpointPath, 'utf8'));
    expect(updatedCheckpoint.id).toBe('msg_synth_watermark_upper_06');
    expect(updatedCheckpoint.createdAt).toBe('2026-09-11T10:31:28.125Z');
    expect(updatedCheckpoint.committedAt).toBeDefined();

    // 6. Verify zero business output files were written (no observations.md, no buffers)
    expect(fs.existsSync(path.join(tmpDir, 'observations.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'pipeline/knowledge-buffer.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'pipeline/interaction-buffer.md'))).toBe(false);

    // 7. Re-query verification: next run with advanced checkpoint finds 0 records (NO REPLAY)
    filesMap.set(`${tenantId}:${spaceId}:${checkpointPath}`, JSON.stringify(updatedCheckpoint, null, 2));
    const nextPrep = await preparer.prepare({
      task: { id: taskId, execution_mode: 'agent' },
      payload: { prompt: '# 天级统一提取任务' },
      tenantId,
      runId: 'run_next_synth_02',
    });

    const nextStagedContent = JSON.parse(filesMap.get(`${tenantId}:${spaceId}:${nextPrep!.stagedPath}`)!);
    expect(nextStagedContent.recordsCount).toBe(0);
    expect(nextStagedContent.records).toHaveLength(0);
    expect(nextStagedContent.window.sinceId).toBe('msg_synth_watermark_upper_06');
  });

  it('Scenario 2: Incomplete coverage or missing stage rejects checkpoint advancement', () => {
    const localInputPath = path.join(tmpDir, 'input_rej.json');
    const localCheckpointPath = path.join(tmpDir, 'cp_rej');

    const envelope = {
      schemaVersion: '1.0.0',
      taskRunId: 'run_rej_01',
      capability: 'pipeline_observation',
      window: {
        sinceCreatedAt: '2026-09-11T08:12:18.807Z',
        sinceId: 'msg_synth_cursor_start_01',
        checkpointWatermark: {
          createdAt: '2026-09-11T10:31:28.125Z',
          id: 'msg_synth_watermark_upper_06',
        },
      },
      recordsCount: 3,
      records: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
    };

    fs.writeFileSync(localInputPath, JSON.stringify(envelope, null, 2), 'utf8');
    fs.writeFileSync(localCheckpointPath, JSON.stringify({ id: 'msg_synth_cursor_start_01' }, null, 2), 'utf8');

    const consumerRes = processStagedExtraction({
      inputPathOrGuidance: localInputPath,
      checkpointFilePath: localCheckpointPath,
      dryRun: false,
    });

    // Incomplete coverage in cognitive stage (covered 2 of 3)
    expect(() => {
      consumerRes.commitCheckpointAfterPersist({
        cognitive: {
          status: 'no_change',
          stage: 'cognitive',
          inputSha256: consumerRes.inputSha256,
          coveredSourceIds: ['m1', 'm2'], // Missing m3!
          reason: 'partial examination',
        },
        knowledge: {
          status: 'no_change',
          stage: 'knowledge',
          inputSha256: consumerRes.inputSha256,
          coveredSourceIds: ['m1', 'm2', 'm3'],
          reason: 'all checked',
        },
        interaction: {
          status: 'no_change',
          stage: 'interaction',
          inputSha256: consumerRes.inputSha256,
          coveredSourceIds: ['m1', 'm2', 'm3'],
          reason: 'all checked',
        },
      });
    }).toThrow(/INCOMPLETE_COVERAGE/);

    // Missing interaction stage
    expect(() => {
      consumerRes.commitCheckpointAfterPersist({
        cognitive: {
          status: 'no_change',
          stage: 'cognitive',
          inputSha256: consumerRes.inputSha256,
          coveredSourceIds: ['m1', 'm2', 'm3'],
          reason: 'checked',
        },
        knowledge: {
          status: 'no_change',
          stage: 'knowledge',
          inputSha256: consumerRes.inputSha256,
          coveredSourceIds: ['m1', 'm2', 'm3'],
          reason: 'checked',
        },
      });
    }).toThrow(/missing one or more verified persistence receipts/i);

    // Failed stage status
    expect(() => {
      consumerRes.commitCheckpointAfterPersist({
        cognitive: { status: 'changed', outputPath: 'obs.md' },
        knowledge: { status: 'failed' },
        interaction: { status: 'no_change', stage: 'interaction', inputSha256: consumerRes.inputSha256, coveredSourceIds: ['m1', 'm2', 'm3'], reason: 'checked' },
      });
    }).toThrow(/missing one or more verified persistence receipts/i);

    // Checkpoint remained untouched
    const cpUnchanged = JSON.parse(fs.readFileSync(localCheckpointPath, 'utf8'));
    expect(cpUnchanged.id).toBe('msg_synth_cursor_start_01');
  });

  it('Scenario 3: Mixed changed + no_change succeeds and rejects fake business writes', () => {
    const localInputPath = path.join(tmpDir, 'input_mix.json');
    const localCheckpointPath = path.join(tmpDir, 'cp_mix');

    const envelope = {
      schemaVersion: '1.0.0',
      taskRunId: 'run_mix_01',
      capability: 'pipeline_observation',
      window: {
        sinceCreatedAt: '2026-09-11T08:12:18.807Z',
        sinceId: 'msg_synth_cursor_start_01',
        checkpointWatermark: {
          createdAt: '2026-09-11T10:31:28.125Z',
          id: 'msg_synth_watermark_upper_06',
        },
      },
      recordsCount: 2,
      records: [{ id: 'm1' }, { id: 'm2' }],
    };

    fs.writeFileSync(localInputPath, JSON.stringify(envelope, null, 2), 'utf8');
    fs.writeFileSync(localCheckpointPath, JSON.stringify({ id: 'msg_synth_cursor_start_01' }, null, 2), 'utf8');

    const consumerRes = processStagedExtraction({
      inputPathOrGuidance: localInputPath,
      checkpointFilePath: localCheckpointPath,
      dryRun: false,
    });

    const commitSuccess = consumerRes.commitCheckpointAfterPersist({
      cognitive: { status: 'changed', outputPath: 'main--host/observations.md' },
      knowledge: {
        status: 'no_change',
        stage: 'knowledge',
        inputSha256: consumerRes.inputSha256,
        coveredSourceIds: ['m1', 'm2'],
        reason: 'no knowledge extractable',
      },
      interaction: {
        status: 'no_change',
        stage: 'interaction',
        inputSha256: consumerRes.inputSha256,
        coveredSourceIds: ['m1', 'm2'],
        reason: 'no interaction patterns',
      },
    });

    expect(commitSuccess).toBe(true);
    const updatedCp = JSON.parse(fs.readFileSync(localCheckpointPath, 'utf8'));
    expect(updatedCp.id).toBe('msg_synth_watermark_upper_06');
  });

  it('Scenario 4: Monotonic safety prevents backwards watermark regression', () => {
    const cpPath = path.join(tmpDir, 'cp_monotonic');
    fs.writeFileSync(
      cpPath,
      JSON.stringify({
        createdAt: '2026-09-11T10:00:00.000Z',
        id: 'msg_newer',
      }),
      'utf8'
    );

    // Attempt to commit older timestamp -> throws CHECKPOINT_REGRESSION
    expect(() => {
      commitCheckpoint(cpPath, {
        createdAt: '2026-09-11T09:00:00.000Z',
        id: 'msg_older',
      });
    }).toThrow(/CHECKPOINT_REGRESSION/);

    // Attempt to commit older id at same timestamp -> throws CHECKPOINT_REGRESSION
    expect(() => {
      commitCheckpoint(cpPath, {
        createdAt: '2026-09-11T10:00:00.000Z',
        id: 'msg_a_older',
      });
    }).toThrow(/CHECKPOINT_REGRESSION/);
  });

  it('Scenario 5: Backward compatibility preserves legacy 3 booleans true', () => {
    const localInputPath = path.join(tmpDir, 'input_leg.json');
    const localCheckpointPath = path.join(tmpDir, 'cp_leg');

    const envelope = {
      schemaVersion: '1.0.0',
      taskRunId: 'run_leg_01',
      capability: 'pipeline_observation',
      window: {
        sinceCreatedAt: null,
        sinceId: null,
        checkpointWatermark: { createdAt: '2026-09-11T12:00:00.000Z', id: 'msg_leg_end' },
      },
      recordsCount: 0,
      records: [],
    };

    fs.writeFileSync(localInputPath, JSON.stringify(envelope, null, 2), 'utf8');

    const consumerRes = processStagedExtraction({
      inputPathOrGuidance: localInputPath,
      checkpointFilePath: localCheckpointPath,
      dryRun: false,
    });

    const commitSuccess = consumerRes.commitCheckpointAfterPersist({
      cognitivePersisted: true,
      knowledgePersisted: true,
      interactionPersisted: true,
    });

    expect(commitSuccess).toBe(true);
    const cp = JSON.parse(fs.readFileSync(localCheckpointPath, 'utf8'));
    expect(cp.id).toBe('msg_leg_end');
  });

  it('Scenario 6: Rejects receipt with extra IDs not present in staged input', () => {
    const localInputPath = path.join(tmpDir, 'input_extra.json');
    const localCheckpointPath = path.join(tmpDir, 'cp_extra');

    const envelope = {
      schemaVersion: '1.0.0',
      taskRunId: 'run_extra_01',
      capability: 'pipeline_observation',
      window: {
        sinceCreatedAt: '2026-09-11T08:12:18.807Z',
        sinceId: 'msg_synth_cursor_start_01',
        checkpointWatermark: {
          createdAt: '2026-09-11T10:31:28.125Z',
          id: 'msg_synth_watermark_upper_06',
        },
      },
      recordsCount: 2,
      records: [{ id: 'm1' }, { id: 'm2' }],
    };

    fs.writeFileSync(localInputPath, JSON.stringify(envelope, null, 2), 'utf8');
    fs.writeFileSync(localCheckpointPath, JSON.stringify({ id: 'msg_synth_cursor_start_01' }, null, 2), 'utf8');

    const consumerRes = processStagedExtraction({
      inputPathOrGuidance: localInputPath,
      checkpointFilePath: localCheckpointPath,
      dryRun: false,
    });

    expect(() => {
      consumerRes.commitCheckpointAfterPersist({
        cognitive: {
          status: 'no_change',
          stage: 'cognitive',
          inputSha256: consumerRes.inputSha256,
          coveredSourceIds: ['m1', 'm2', 'm3_extra'],
          reason: 'extra id included',
        },
        knowledge: {
          status: 'no_change',
          stage: 'knowledge',
          inputSha256: consumerRes.inputSha256,
          coveredSourceIds: ['m1', 'm2'],
          reason: 'all checked',
        },
        interaction: {
          status: 'no_change',
          stage: 'interaction',
          inputSha256: consumerRes.inputSha256,
          coveredSourceIds: ['m1', 'm2'],
          reason: 'all checked',
        },
      });
    }).toThrow(/INVALID_COVERAGE/);
  });

  it('Scenario 7: Rejects receipt with duplicate IDs in coveredSourceIds', () => {
    const localInputPath = path.join(tmpDir, 'input_dup.json');
    const localCheckpointPath = path.join(tmpDir, 'cp_dup');

    const envelope = {
      schemaVersion: '1.0.0',
      taskRunId: 'run_dup_01',
      capability: 'pipeline_observation',
      window: {
        sinceCreatedAt: '2026-09-11T08:12:18.807Z',
        sinceId: 'msg_synth_cursor_start_01',
        checkpointWatermark: {
          createdAt: '2026-09-11T10:31:28.125Z',
          id: 'msg_synth_watermark_upper_06',
        },
      },
      recordsCount: 2,
      records: [{ id: 'm1' }, { id: 'm2' }],
    };

    fs.writeFileSync(localInputPath, JSON.stringify(envelope, null, 2), 'utf8');
    fs.writeFileSync(localCheckpointPath, JSON.stringify({ id: 'msg_synth_cursor_start_01' }, null, 2), 'utf8');

    const consumerRes = processStagedExtraction({
      inputPathOrGuidance: localInputPath,
      checkpointFilePath: localCheckpointPath,
      dryRun: false,
    });

    expect(() => {
      consumerRes.commitCheckpointAfterPersist({
        cognitive: {
          status: 'no_change',
          stage: 'cognitive',
          inputSha256: consumerRes.inputSha256,
          coveredSourceIds: ['m1', 'm2', 'm1'],
          reason: 'duplicate id included',
        },
        knowledge: {
          status: 'no_change',
          stage: 'knowledge',
          inputSha256: consumerRes.inputSha256,
          coveredSourceIds: ['m1', 'm2'],
          reason: 'all checked',
        },
        interaction: {
          status: 'no_change',
          stage: 'interaction',
          inputSha256: consumerRes.inputSha256,
          coveredSourceIds: ['m1', 'm2'],
          reason: 'all checked',
        },
      });
    }).toThrow(/VALIDATION_ERROR/);
  });
});
