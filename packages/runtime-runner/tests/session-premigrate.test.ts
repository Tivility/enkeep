import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import {
  runSessionPremigrate,
  runSessionPremigrateCli,
  deferPreStepSurfaceEvents,
  stripV0SourceId,
  normalizeV0Events,
} from '../src/runtime/session-premigrate.js';
import { bootDshRuntime } from '../src/runtime/dsh-boot.js';

describe('Session Premigration and Runtime Safety Net', () => {
  let testRoot: string;
  let sessionsDir: string;
  let spacesDir: string;
  let dshHome: string;
  let persistence: any;

  beforeEach(async () => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'premig-test-'));
    dshHome = path.join(testRoot, 'dsh-home');
    sessionsDir = path.join(dshHome, 'sessions');
    spacesDir = path.join(testRoot, 'spaces');
    fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });

    const ctx = new Context();
    await ctx.plugin(SessionPersistenceJsonl, {
      root: sessionsDir,
      compression: 'none',
    });
    persistence = ctx.sessionPersistence;
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  function createSessionDir(sessionId: string, cwd: string): string {
    const loc = persistence.locate({
      id: sessionId,
      cwd,
      version: 0,
      createdAt: 1770000000000,
      isSeeded: false,
      delegationDepth: 0,
    });
    const sDir = path.dirname(loc.path);
    fs.mkdirSync(sDir, { recursive: true, mode: 0o700 });
    return sDir;
  }

  it('unit helpers: stripV0SourceId and deferPreStepSurfaceEvents work correctly', () => {
    const userMsgWithSourceId = {
      type: 'user/message',
      seq: 0,
      data: {
        id: 'msg_001',
        role: 'user',
        content: [{ type: 'text', text: 'Prompt' }],
        source: { kind: 'user', sourceId: 'om_00000000000000000000000000000001' },
      },
    };
    const stripped = stripV0SourceId(userMsgWithSourceId);
    expect(stripped.data.source).toEqual({ kind: 'user' });
    expect((stripped.data.source as any).sourceId).toBeUndefined();

    const preStepEvents = [
      {
        type: 'user/message',
        seq: 0,
        surfaceOp: 'append',
        data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Q1' }], source: { kind: 'user' } },
      },
      {
        type: 'turn/start',
        seq: 1,
        data: { turn: 1 },
      },
      {
        type: 'step/start',
        seq: 2,
        data: { turn: 1, step: 1 },
      },
      {
        type: 'assistant/message',
        seq: 3,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'A1' }], source: { kind: 'model' } },
        },
      },
    ];

    const deferred = deferPreStepSurfaceEvents(preStepEvents);
    expect(deferred.map((e) => e.type)).toEqual([
      'turn/start',
      'step/start',
      'user/message',
      'assistant/message',
    ]);
    expect(deferred.map((e) => e.seq)).toEqual([0, 1, 2, 3]);

    const normalized = normalizeV0Events([userMsgWithSourceId]);
    expect(normalized[0].data.source.sourceId).toBeUndefined();
  });

  it('sourceId case (Class A): removes sourceId, migrates through format catalog and verifies read', async () => {
    const sessionId = 'ses_00000000000000000000000000000001';
    const spacePath = path.join(spacesDir, 'space-01');
    fs.mkdirSync(spacePath, { recursive: true });
    const sDir = createSessionDir(sessionId, spacePath);

    const v0Lines = [
      JSON.stringify({
        type: 'session',
        version: 0,
        id: sessionId,
        createdAt: 1770000000000,
        cwd: spacePath,
        delegationDepth: 0,
      }),
      JSON.stringify({
        type: 'turn/start',
        seq: 0,
        time: 1770000000001,
        data: { turn: 1 },
      }),
      JSON.stringify({
        type: 'step/start',
        seq: 1,
        time: 1770000000002,
        data: { turn: 1, step: 1 },
      }),
      JSON.stringify({
        type: 'user/message',
        seq: 2,
        time: 1770000000003,
        surfaceOp: 'append',
        data: {
          id: 'msg_u_01',
          role: 'user',
          content: [{ type: 'text', text: 'Synthetic user prompt' }],
          source: { kind: 'user', sourceId: 'om_synth_000000000000000000000001' },
        },
      }),
      JSON.stringify({
        type: 'assistant/message',
        seq: 3,
        time: 1770000000004,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'msg_a_01',
            role: 'assistant',
            content: [{ type: 'text', text: 'Synthetic assistant reply' }],
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          },
        },
      }),
      JSON.stringify({
        type: 'step/end',
        seq: 4,
        time: 1770000000005,
        data: { turn: 1, step: 1 },
      }),
      JSON.stringify({
        type: 'turn/end',
        seq: 5,
        time: 1770000000006,
        data: { turn: 1, reason: { kind: 'completed' } },
      }),
    ].join('\n');

    fs.writeFileSync(path.join(sDir, 'session.jsonl'), v0Lines, 'utf8');

    const result = await runSessionPremigrate({
      sessionsRoot: sessionsDir,
    });

    expect(result.failedCount).toBe(0);
    expect(result.migratedCount).toBe(1);
    expect(result.sessions[0].status).toBe('migrated');
    expect(result.sessions[0].removedSourceIdsCount).toBe(1);

    const v4Path = path.join(sDir, 'session.v4.jsonl');
    expect(fs.existsSync(v4Path)).toBe(true);

    const handle = await persistence.open(sessionId, 'read');
    const readRes = await handle.read();
    await handle.close();

    const userMsgs = readRes.events.filter((e: any) => e.type === 'user/message');
    const asstMsgs = readRes.events.filter((e: any) => e.type === 'assistant/message');
    expect(userMsgs.length).toBe(1);
    expect(asstMsgs.length).toBe(1);
    expect(userMsgs[0].data.source).toEqual({ kind: 'user' });
    expect(userMsgs[0].data.source.sourceId).toBeUndefined();
  });

  it('pre-step surface case (Class B): defers surface events before step 1 into step 1 and migrates', async () => {
    const sessionId = 'ses_00000000000000000000000000000002';
    const spacePath = path.join(spacesDir, 'space-02');
    fs.mkdirSync(spacePath, { recursive: true });
    const sDir = createSessionDir(sessionId, spacePath);

    const v0Lines = [
      JSON.stringify({
        type: 'session',
        version: 0,
        id: sessionId,
        createdAt: 1770000000000,
        cwd: spacePath,
        delegationDepth: 0,
        seedLength: 6,
      }),
      // Seq 0: Bare user/message before any turn/step
      JSON.stringify({
        type: 'user/message',
        seq: 0,
        time: 1770000000001,
        surfaceOp: 'append',
        data: {
          id: 'msg_u_02',
          role: 'user',
          content: [{ type: 'text', text: 'Initial prompt before step' }],
          source: { kind: 'user' },
        },
      }),
      JSON.stringify({
        type: 'turn/start',
        seq: 1,
        time: 1770000000002,
        data: { turn: 1 },
      }),
      JSON.stringify({
        type: 'step/start',
        seq: 2,
        time: 1770000000003,
        data: { turn: 1, step: 1 },
      }),
      JSON.stringify({
        type: 'assistant/message',
        seq: 3,
        time: 1770000000004,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'msg_a_02',
            role: 'assistant',
            content: [{ type: 'text', text: 'Assistant response' }],
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          },
        },
      }),
      JSON.stringify({
        type: 'step/end',
        seq: 4,
        time: 1770000000005,
        data: { turn: 1, step: 1 },
      }),
      JSON.stringify({
        type: 'turn/end',
        seq: 5,
        time: 1770000000006,
        data: { turn: 1, reason: { kind: 'completed' } },
      }),
    ].join('\n');

    fs.writeFileSync(path.join(sDir, 'session.jsonl'), v0Lines, 'utf8');

    const result = await runSessionPremigrate({
      sessionsRoot: sessionsDir,
    });

    expect(result.failedCount).toBe(0);
    expect(result.migratedCount).toBe(1);
    expect(result.sessions[0].status).toBe('migrated');
    expect(result.sessions[0].deferredSurfaceCount).toBe(1);

    const v4Path = path.join(sDir, 'session.v4.jsonl');
    expect(fs.existsSync(v4Path)).toBe(true);

    const handle = await persistence.open(sessionId, 'read');
    const readRes = await handle.read();
    await handle.close();

    const userMsgs = readRes.events.filter((e: any) => e.type === 'user/message');
    const asstMsgs = readRes.events.filter((e: any) => e.type === 'assistant/message');
    expect(userMsgs.length).toBe(1);
    expect(asstMsgs.length).toBe(1);
  });

  it('clean session: migrates cleanly without altering structure', async () => {
    const sessionId = 'ses_00000000000000000000000000000003';
    const spacePath = path.join(spacesDir, 'space-03');
    fs.mkdirSync(spacePath, { recursive: true });
    const sDir = createSessionDir(sessionId, spacePath);

    const v0Lines = [
      JSON.stringify({
        type: 'session',
        version: 0,
        id: sessionId,
        createdAt: 1770000000000,
        cwd: spacePath,
        delegationDepth: 0,
      }),
      JSON.stringify({
        type: 'turn/start',
        seq: 0,
        time: 1770000000001,
        data: { turn: 1 },
      }),
      JSON.stringify({
        type: 'step/start',
        seq: 1,
        time: 1770000000002,
        data: { turn: 1, step: 1 },
      }),
      JSON.stringify({
        type: 'user/message',
        seq: 2,
        time: 1770000000003,
        surfaceOp: 'append',
        data: {
          id: 'msg_u_03',
          role: 'user',
          content: [{ type: 'text', text: 'Clean question' }],
          source: { kind: 'user' },
        },
      }),
      JSON.stringify({
        type: 'assistant/message',
        seq: 3,
        time: 1770000000004,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'msg_a_03',
            role: 'assistant',
            content: [{ type: 'text', text: 'Clean answer' }],
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          },
        },
      }),
      JSON.stringify({
        type: 'step/end',
        seq: 4,
        time: 1770000000005,
        data: { turn: 1, step: 1 },
      }),
      JSON.stringify({
        type: 'turn/end',
        seq: 5,
        time: 1770000000006,
        data: { turn: 1, reason: { kind: 'completed' } },
      }),
    ].join('\n');

    fs.writeFileSync(path.join(sDir, 'session.jsonl'), v0Lines, 'utf8');

    const result = await runSessionPremigrate({
      sessionsRoot: sessionsDir,
    });

    expect(result.failedCount).toBe(0);
    expect(result.migratedCount).toBe(1);
    expect(result.sessions[0].removedSourceIdsCount).toBe(0);
    expect(result.sessions[0].deferredSurfaceCount).toBe(0);

    const handle = await persistence.open(sessionId, 'read');
    const readRes = await handle.read();
    await handle.close();

    expect(readRes.events.filter((e: any) => e.type === 'user/message').length).toBe(1);
    expect(readRes.events.filter((e: any) => e.type === 'assistant/message').length).toBe(1);
  });

  it('idempotent rerun: skips session already having session.v4.jsonl', async () => {
    const sessionId = 'ses_00000000000000000000000000000004';
    const spacePath = path.join(spacesDir, 'space-04');
    fs.mkdirSync(spacePath, { recursive: true });
    const sDir = createSessionDir(sessionId, spacePath);

    const v0Lines = [
      JSON.stringify({
        type: 'session',
        version: 0,
        id: sessionId,
        createdAt: 1770000000000,
        cwd: spacePath,
        delegationDepth: 0,
      }),
      JSON.stringify({
        type: 'turn/start',
        seq: 0,
        time: 1770000000001,
        data: { turn: 1 },
      }),
      JSON.stringify({
        type: 'step/start',
        seq: 1,
        time: 1770000000002,
        data: { turn: 1, step: 1 },
      }),
      JSON.stringify({
        type: 'user/message',
        seq: 2,
        time: 1770000000003,
        surfaceOp: 'append',
        data: {
          id: 'msg_u_04',
          role: 'user',
          content: [{ type: 'text', text: 'Q4' }],
          source: { kind: 'user' },
        },
      }),
      JSON.stringify({
        type: 'assistant/message',
        seq: 3,
        time: 1770000000004,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'msg_a_04',
            role: 'assistant',
            content: [{ type: 'text', text: 'A4' }],
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          },
        },
      }),
      JSON.stringify({
        type: 'step/end',
        seq: 4,
        time: 1770000000005,
        data: { turn: 1, step: 1 },
      }),
      JSON.stringify({
        type: 'turn/end',
        seq: 5,
        time: 1770000000006,
        data: { turn: 1, reason: { kind: 'completed' } },
      }),
    ].join('\n');

    fs.writeFileSync(path.join(sDir, 'session.jsonl'), v0Lines, 'utf8');

    // First run: migrates
    const firstRun = await runSessionPremigrate({ sessionsRoot: sessionsDir });
    expect(firstRun.migratedCount).toBe(1);
    expect(firstRun.skippedCount).toBe(0);

    const v4StatBefore = fs.statSync(path.join(sDir, 'session.v4.jsonl'));

    // Second run: skips idempotently
    const secondRun = await runSessionPremigrate({ sessionsRoot: sessionsDir });
    expect(secondRun.migratedCount).toBe(0);
    expect(secondRun.skippedCount).toBe(1);
    expect(secondRun.sessions[0].status).toBe('skipped');

    const v4StatAfter = fs.statSync(path.join(sDir, 'session.v4.jsonl'));
    expect(v4StatAfter.mtimeMs).toBe(v4StatBefore.mtimeMs);
  });

  it('dry-run: writes nothing to disk', async () => {
    const sessionId = 'ses_00000000000000000000000000000005';
    const spacePath = path.join(spacesDir, 'space-05');
    fs.mkdirSync(spacePath, { recursive: true });
    const sDir = createSessionDir(sessionId, spacePath);

    const v0Lines = [
      JSON.stringify({
        type: 'session',
        version: 0,
        id: sessionId,
        createdAt: 1770000000000,
        cwd: spacePath,
        delegationDepth: 0,
      }),
      JSON.stringify({
        type: 'turn/start',
        seq: 0,
        time: 1770000000001,
        data: { turn: 1 },
      }),
      JSON.stringify({
        type: 'step/start',
        seq: 1,
        time: 1770000000002,
        data: { turn: 1, step: 1 },
      }),
      JSON.stringify({
        type: 'user/message',
        seq: 2,
        time: 1770000000003,
        surfaceOp: 'append',
        data: {
          id: 'msg_u_05',
          role: 'user',
          content: [{ type: 'text', text: 'Dry run test prompt' }],
          source: { kind: 'user', sourceId: 'om_synth_05' },
        },
      }),
      JSON.stringify({
        type: 'assistant/message',
        seq: 3,
        time: 1770000000004,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'msg_a_05',
            role: 'assistant',
            content: [{ type: 'text', text: 'Dry run test reply' }],
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          },
        },
      }),
      JSON.stringify({
        type: 'step/end',
        seq: 4,
        time: 1770000000005,
        data: { turn: 1, step: 1 },
      }),
      JSON.stringify({
        type: 'turn/end',
        seq: 5,
        time: 1770000000006,
        data: { turn: 1, reason: { kind: 'completed' } },
      }),
    ].join('\n');

    fs.writeFileSync(path.join(sDir, 'session.jsonl'), v0Lines, 'utf8');

    const result = await runSessionPremigrate({
      sessionsRoot: sessionsDir,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.migratedCount).toBe(1);
    expect(result.failedCount).toBe(0);

    // Verify session.v4.jsonl was NOT written
    expect(fs.existsSync(path.join(sDir, 'session.v4.jsonl'))).toBe(false);

    // Verify no temporary files left
    const files = fs.readdirSync(sDir);
    expect(files).toEqual(['session.jsonl']);
  });

  it('original file byte-identical after run', async () => {
    const sessionId = 'ses_00000000000000000000000000000006';
    const spacePath = path.join(spacesDir, 'space-06');
    fs.mkdirSync(spacePath, { recursive: true });
    const sDir = createSessionDir(sessionId, spacePath);

    const v0Content = [
      JSON.stringify({
        type: 'session',
        version: 0,
        id: sessionId,
        createdAt: 1770000000000,
        cwd: spacePath,
        delegationDepth: 0,
      }),
      JSON.stringify({
        type: 'turn/start',
        seq: 0,
        time: 1770000000001,
        data: { turn: 1 },
      }),
      JSON.stringify({
        type: 'step/start',
        seq: 1,
        time: 1770000000002,
        data: { turn: 1, step: 1 },
      }),
      JSON.stringify({
        type: 'user/message',
        seq: 2,
        time: 1770000000003,
        surfaceOp: 'append',
        data: {
          id: 'msg_u_06',
          role: 'user',
          content: [{ type: 'text', text: 'Hash check test prompt' }],
          source: { kind: 'user', sourceId: 'om_synth_06' },
        },
      }),
      JSON.stringify({
        type: 'assistant/message',
        seq: 3,
        time: 1770000000004,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'msg_a_06',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hash check test reply' }],
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          },
        },
      }),
      JSON.stringify({
        type: 'step/end',
        seq: 4,
        time: 1770000000005,
        data: { turn: 1, step: 1 },
      }),
      JSON.stringify({
        type: 'turn/end',
        seq: 5,
        time: 1770000000006,
        data: { turn: 1, reason: { kind: 'completed' } },
      }),
    ].join('\n');

    const v0Path = path.join(sDir, 'session.jsonl');
    fs.writeFileSync(v0Path, v0Content, 'utf8');

    const hashBefore = crypto.createHash('sha256').update(fs.readFileSync(v0Path)).digest('hex');

    await runSessionPremigrate({ sessionsRoot: sessionsDir });

    const hashAfter = crypto.createHash('sha256').update(fs.readFileSync(v0Path)).digest('hex');
    expect(hashAfter).toBe(hashBefore);
  });

  it('safety-net retry in dsh-boot: transparently normalizes v0 session on resume failure and succeeds', async () => {
    const sessionId = 'ses_00000000000000000000000000000007';
    const spaceFolder = 'space-safety-net';
    const spacePath = path.join(spacesDir, spaceFolder);
    fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(spacePath, '.git'), { recursive: true });

    const sDir = createSessionDir(sessionId, spacePath);

    // Create a Class A + Class B session:
    // 1) Contains sourceId in user/message
    // 2) user/message appears before turn/step (pre-step surface)
    const v0Lines = [
      JSON.stringify({
        type: 'session',
        version: 0,
        id: sessionId,
        createdAt: 1770000000000,
        cwd: spacePath,
        delegationDepth: 0,
        seedLength: 6,
      }),
      JSON.stringify({
        type: 'user/message',
        seq: 0,
        time: 1770000000001,
        surfaceOp: 'append',
        data: {
          id: 'msg_u_07',
          role: 'user',
          content: [{ type: 'text', text: 'Initial prompt with invalid sourceId' }],
          source: { kind: 'user', sourceId: 'om_synth_safety_net_01' },
        },
      }),
      JSON.stringify({
        type: 'turn/start',
        seq: 1,
        time: 1770000000002,
        data: { turn: 1 },
      }),
      JSON.stringify({
        type: 'step/start',
        seq: 2,
        time: 1770000000003,
        data: { turn: 1, step: 1 },
      }),
      JSON.stringify({
        type: 'assistant/message',
        seq: 3,
        time: 1770000000004,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'msg_a_07',
            role: 'assistant',
            content: [{ type: 'text', text: 'Assistant reply' }],
            source: { kind: 'model', provider: 'mock', model: 'mock' },
          },
        },
      }),
      JSON.stringify({
        type: 'step/end',
        seq: 4,
        time: 1770000000005,
        data: { turn: 1, step: 1 },
      }),
      JSON.stringify({
        type: 'turn/end',
        seq: 5,
        time: 1770000000006,
        data: { turn: 1, reason: { kind: 'completed' } },
      }),
    ].join('\n');

    fs.writeFileSync(path.join(sDir, 'session.jsonl'), v0Lines, 'utf8');

    // Without manual premigration, boot runtime and send followup to resume
    const runtime = await bootDshRuntime({
      userId: 'user-alice',
      dshHome,
      spacesDir,
      llmEnabled: false,
    });

    try {
      const resp = await runtime.sendFollowup(
        'Follow-up query triggering resume',
        sessionId,
        'turn_00000000000000000000000000000002',
        null,
        spaceFolder
      );

      expect(resp.status).toBe('completed');
      expect(resp.persisted).toBe(true);

      // Verify that safety net generated session.v4.jsonl
      const v4Path = path.join(sDir, 'session.v4.jsonl');
      expect(fs.existsSync(v4Path)).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  it('CLI: supports --sessions-root, --session, --dry-run, --report and exits cleanly', async () => {
    const sessionId = 'ses_00000000000000000000000000000008';
    const spacePath = path.join(spacesDir, 'space-08');
    fs.mkdirSync(spacePath, { recursive: true });
    const sDir = createSessionDir(sessionId, spacePath);

    const v0Lines = [
      JSON.stringify({
        type: 'session',
        version: 0,
        id: sessionId,
        createdAt: 1770000000000,
        cwd: spacePath,
        delegationDepth: 0,
      }),
      JSON.stringify({
        type: 'turn/start',
        seq: 0,
        time: 1770000000001,
        data: { turn: 1 },
      }),
      JSON.stringify({
        type: 'step/start',
        seq: 1,
        time: 1770000000002,
        data: { turn: 1, step: 1 },
      }),
      JSON.stringify({
        type: 'user/message',
        seq: 2,
        time: 1770000000003,
        surfaceOp: 'append',
        data: {
          id: 'msg_u_08',
          role: 'user',
          content: [{ type: 'text', text: 'CLI test user prompt' }],
          source: { kind: 'user', sourceId: 'om_synth_08' },
        },
      }),
      JSON.stringify({
        type: 'assistant/message',
        seq: 3,
        time: 1770000000004,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'msg_a_08',
            role: 'assistant',
            content: [{ type: 'text', text: 'CLI test assistant reply' }],
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          },
        },
      }),
      JSON.stringify({
        type: 'step/end',
        seq: 4,
        time: 1770000000005,
        data: { turn: 1, step: 1 },
      }),
      JSON.stringify({
        type: 'turn/end',
        seq: 5,
        time: 1770000000006,
        data: { turn: 1, reason: { kind: 'completed' } },
      }),
    ].join('\n');

    fs.writeFileSync(path.join(sDir, 'session.jsonl'), v0Lines, 'utf8');

    const reportFile = path.join(testRoot, 'report.json');

    // Run via runSessionPremigrate
    const res = await runSessionPremigrate({
      sessionsRoot: sessionsDir,
      sessionIds: [sessionId],
      reportFile,
    });

    expect(res.migratedCount).toBe(1);
    expect(res.failedCount).toBe(0);
    expect(fs.existsSync(reportFile)).toBe(true);

    const reportContent = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    expect(reportContent.migratedCount).toBe(1);
    expect(reportContent.sessions[0].sessionId).toBe(sessionId);
    // Verify AGENTS.md rule: report must not print message contents
    expect(JSON.stringify(reportContent)).not.toContain('CLI test user prompt');
  });
});
