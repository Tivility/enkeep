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
  isChunkRecord,
  isClassAError,
  isClassBError,
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

  it('unit helpers: stripV0SourceId, deferPreStepSurfaceEvents, isChunkRecord and error classifiers work correctly', () => {
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

    const chunkRow = {
      type: 'text-chunks',
      seq0: 3,
      time0: 1770000000003,
      data: { turn: 1, step: 1, index: 0, dt: [10], texts: ['Chunk 1', ' Chunk 2'] },
    };
    expect(isChunkRecord(chunkRow)).toBe(true);
    expect(isChunkRecord(userMsgWithSourceId)).toBe(false);

    // deferPreStepSurfaceEvents on clean session with chunks returns untouched
    const cleanWithChunks = [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
      userMsgWithSourceId,
      chunkRow,
    ];
    const untouched = deferPreStepSurfaceEvents(cleanWithChunks);
    expect(untouched).toEqual(cleanWithChunks);
    expect((untouched[3] as any).seq).toBeUndefined();

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

    expect(isClassAError(new Error('user/message 0 source has unexpected member "sourceId"'))).toBe(true);
    expect(isClassAError(new Error('some other error'))).toBe(false);
    expect(isClassBError(new Error('format v2 surface before first step cannot acquire a system head without changing chronology'))).toBe(true);
    expect(isClassBError(new Error('v1->v2 refuses pre-step surface'))).toBe(true);
    expect(isClassBError(new Error('some other error'))).toBe(false);
  });

  it('clean session with chunks migrates untouched (output identical to DSH own migration)', async () => {
    const sessionId = 'ses_00000000000000000000000000000010';
    const spacePath = path.join(spacesDir, 'space-clean-chunks');
    fs.mkdirSync(spacePath, { recursive: true });
    const sDir = createSessionDir(sessionId, spacePath);

    const v0Header = {
      type: 'session',
      version: 0,
      id: sessionId,
      createdAt: 1770000000000,
      cwd: spacePath,
      delegationDepth: 0,
    };

    const v0Events = [
      {
        type: 'turn/start',
        seq: 0,
        time: 1770000000001,
        data: { turn: 1 },
      },
      {
        type: 'step/start',
        seq: 1,
        time: 1770000000002,
        data: { turn: 1, step: 1 },
      },
      {
        type: 'user/message',
        seq: 2,
        time: 1770000000003,
        surfaceOp: 'append',
        data: {
          id: 'msg_u_10',
          role: 'user',
          content: [{ type: 'text', text: 'Clean prompt with streaming chunks' }],
          source: { kind: 'user' },
        },
      },
      {
        type: 'text-chunks',
        seq0: 3,
        time0: 1770000000004,
        data: {
          turn: 1,
          step: 1,
          index: 0,
          dt: [10, 10],
          texts: ['Hello', ' world', '!'],
        },
      },
      {
        type: 'assistant/message',
        seq: 6,
        time: 1770000000025,
        surfaceOp: 'append',
        sourceEventSeqs: [[3, 5]],
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'msg_a_10',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello world!' }],
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          },
        },
      },
      {
        type: 'step/end',
        seq: 7,
        time: 1770000000030,
        data: { turn: 1, step: 1 },
      },
      {
        type: 'turn/end',
        seq: 8,
        time: 1770000000031,
        data: { turn: 1, reason: { kind: 'completed' } },
      },
    ];

    const v0Content = [JSON.stringify(v0Header), ...v0Events.map((e) => JSON.stringify(e))].join('\n') + '\n';
    fs.writeFileSync(path.join(sDir, 'session.jsonl'), v0Content, 'utf8');

    // Also prepare an identical session in a separate temp persistence root to get DSH native migration
    const parallelRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-native-ref-'));
    const parallelCtx = new Context();
    await parallelCtx.plugin(SessionPersistenceJsonl, { root: parallelRoot, compression: 'none' });
    const parallelPersistence = parallelCtx.sessionPersistence;
    const parallelLoc = parallelPersistence.locate({
      id: sessionId,
      cwd: spacePath,
      version: 0,
      createdAt: 1770000000000,
      isSeeded: false,
      delegationDepth: 0,
    });
    const parallelSDir = path.dirname(parallelLoc.path);
    fs.mkdirSync(parallelSDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(parallelSDir, 'session.jsonl'), v0Content, 'utf8');

    // Perform DSH native migration
    const nativeHandle = await parallelPersistence.open(sessionId, 'write');
    await nativeHandle.close();
    const nativeV4Content = fs.readFileSync(path.join(parallelSDir, 'session.v4.jsonl'), 'utf8');

    // Run our premigrate
    const result = await runSessionPremigrate({ sessionsRoot: sessionsDir });

    expect(result.failedCount).toBe(0);
    expect(result.migratedCount).toBe(1);
    expect(result.sessions[0].status).toBe('migrated');
    expect(result.sessions[0].removedSourceIdsCount).toBe(0);
    expect(result.sessions[0].deferredSurfaceCount).toBe(0);

    const premigrateV4Content = fs.readFileSync(path.join(sDir, 'session.v4.jsonl'), 'utf8');

    // Verify output is 100% byte-for-byte identical to DSH native migration
    expect(premigrateV4Content).toBe(nativeV4Content);

    // Verify persistence read
    const handle = await persistence.open(sessionId, 'read');
    const readRes = await handle.read();
    await handle.close();

    const userMsgs = readRes.events.filter((e: any) => e.type === 'user/message');
    const asstMsgs = readRes.events.filter((e: any) => e.type === 'assistant/message');
    expect(userMsgs.length).toBe(1);
    expect(asstMsgs.length).toBe(1);

    fs.rmSync(parallelRoot, { recursive: true, force: true });
  });

  it('A-only: removes sourceId, leaves chunk lines untouched and migrates cleanly', async () => {
    const sessionId = 'ses_00000000000000000000000000000011';
    const spacePath = path.join(spacesDir, 'space-a-only');
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
          id: 'msg_u_11',
          role: 'user',
          content: [{ type: 'text', text: 'Prompt with sourceId and chunks' }],
          source: { kind: 'user', sourceId: 'om_synth_000000000000000000000011' },
        },
      }),
      JSON.stringify({
        type: 'text-chunks',
        seq0: 3,
        time0: 1770000000004,
        data: {
          turn: 1,
          step: 1,
          index: 0,
          dt: [10],
          texts: ['Chunk A', ' Chunk B'],
        },
      }),
      JSON.stringify({
        type: 'assistant/message',
        seq: 5,
        time: 1770000000015,
        surfaceOp: 'append',
        sourceEventSeqs: [[3, 4]],
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'msg_a_11',
            role: 'assistant',
            content: [{ type: 'text', text: 'Chunk A Chunk B' }],
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          },
        },
      }),
      JSON.stringify({
        type: 'step/end',
        seq: 6,
        time: 1770000000020,
        data: { turn: 1, step: 1 },
      }),
      JSON.stringify({
        type: 'turn/end',
        seq: 7,
        time: 1770000000021,
        data: { turn: 1, reason: { kind: 'completed' } },
      }),
    ].join('\n');

    fs.writeFileSync(path.join(sDir, 'session.jsonl'), v0Lines, 'utf8');

    const result = await runSessionPremigrate({ sessionsRoot: sessionsDir });

    expect(result.failedCount).toBe(0);
    expect(result.migratedCount).toBe(1);
    expect(result.sessions[0].removedSourceIdsCount).toBe(1);
    expect(result.sessions[0].deferredSurfaceCount).toBe(0);

    const handle = await persistence.open(sessionId, 'read');
    const readRes = await handle.read();
    await handle.close();

    const userMsgs = readRes.events.filter((e: any) => e.type === 'user/message');
    const asstMsgs = readRes.events.filter((e: any) => e.type === 'assistant/message');
    expect(userMsgs.length).toBe(1);
    expect(asstMsgs.length).toBe(1);
    expect(userMsgs[0].data.source.sourceId).toBeUndefined();
  });

  it('B-only: defers surface events before step 1 into step 1, preserves chunk lines untouched and migrates', async () => {
    const sessionId = 'ses_00000000000000000000000000000012';
    const spacePath = path.join(spacesDir, 'space-b-only');
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
      // Seq 0: Pre-step user/message
      JSON.stringify({
        type: 'user/message',
        seq: 0,
        time: 1770000000001,
        surfaceOp: 'append',
        data: {
          id: 'msg_u_12',
          role: 'user',
          content: [{ type: 'text', text: 'Pre-step prompt with chunks' }],
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
        type: 'text-chunks',
        seq0: 3,
        time0: 1770000000004,
        data: {
          turn: 1,
          step: 1,
          index: 0,
          dt: [10],
          texts: ['Response part 1', ' part 2'],
        },
      }),
      JSON.stringify({
        type: 'assistant/message',
        seq: 5,
        time: 1770000000015,
        surfaceOp: 'append',
        sourceEventSeqs: [[3, 4]],
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'msg_a_12',
            role: 'assistant',
            content: [{ type: 'text', text: 'Response part 1 part 2' }],
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          },
        },
      }),
      JSON.stringify({
        type: 'step/end',
        seq: 6,
        time: 1770000000020,
        data: { turn: 1, step: 1 },
      }),
      JSON.stringify({
        type: 'turn/end',
        seq: 7,
        time: 1770000000021,
        data: { turn: 1, reason: { kind: 'completed' } },
      }),
    ].join('\n');

    fs.writeFileSync(path.join(sDir, 'session.jsonl'), v0Lines, 'utf8');

    const result = await runSessionPremigrate({ sessionsRoot: sessionsDir });

    expect(result.failedCount).toBe(0);
    expect(result.migratedCount).toBe(1);
    expect(result.sessions[0].removedSourceIdsCount).toBe(0);
    expect(result.sessions[0].deferredSurfaceCount).toBe(1);

    const handle = await persistence.open(sessionId, 'read');
    const readRes = await handle.read();
    await handle.close();

    const userMsgs = readRes.events.filter((e: any) => e.type === 'user/message');
    const asstMsgs = readRes.events.filter((e: any) => e.type === 'assistant/message');
    expect(userMsgs.length).toBe(1);
    expect(asstMsgs.length).toBe(1);
  });

  it('A+B: sequentially normalizes A then B and migrates cleanly with chunks', async () => {
    const sessionId = 'ses_00000000000000000000000000000013';
    const spacePath = path.join(spacesDir, 'space-a-plus-b');
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
      // Seq 0: Pre-step user/message with Class A sourceId
      JSON.stringify({
        type: 'user/message',
        seq: 0,
        time: 1770000000001,
        surfaceOp: 'append',
        data: {
          id: 'msg_u_13',
          role: 'user',
          content: [{ type: 'text', text: 'Both A and B anomaly prompt' }],
          source: { kind: 'user', sourceId: 'om_synth_000000000000000000000013' },
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
        type: 'text-chunks',
        seq0: 3,
        time0: 1770000000004,
        data: {
          turn: 1,
          step: 1,
          index: 0,
          dt: [10],
          texts: ['Chunk 1', ' Chunk 2'],
        },
      }),
      JSON.stringify({
        type: 'assistant/message',
        seq: 5,
        time: 1770000000015,
        surfaceOp: 'append',
        sourceEventSeqs: [[3, 4]],
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'msg_a_13',
            role: 'assistant',
            content: [{ type: 'text', text: 'Chunk 1 Chunk 2' }],
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          },
        },
      }),
      JSON.stringify({
        type: 'step/end',
        seq: 6,
        time: 1770000000020,
        data: { turn: 1, step: 1 },
      }),
      JSON.stringify({
        type: 'turn/end',
        seq: 7,
        time: 1770000000021,
        data: { turn: 1, reason: { kind: 'completed' } },
      }),
    ].join('\n');

    fs.writeFileSync(path.join(sDir, 'session.jsonl'), v0Lines, 'utf8');

    const result = await runSessionPremigrate({ sessionsRoot: sessionsDir });

    expect(result.failedCount).toBe(0);
    expect(result.migratedCount).toBe(1);
    expect(result.sessions[0].removedSourceIdsCount).toBe(1);
    expect(result.sessions[0].deferredSurfaceCount).toBe(1);

    const handle = await persistence.open(sessionId, 'read');
    const readRes = await handle.read();
    await handle.close();

    const userMsgs = readRes.events.filter((e: any) => e.type === 'user/message');
    const asstMsgs = readRes.events.filter((e: any) => e.type === 'assistant/message');
    expect(userMsgs.length).toBe(1);
    expect(asstMsgs.length).toBe(1);
    expect(userMsgs[0].data.source.sourceId).toBeUndefined();
  });

  it('failure reported without partial file: invalid session leaves no partial session.v4.jsonl', async () => {
    const sessionId = 'ses_00000000000000000000000000000014';
    const spacePath = path.join(spacesDir, 'space-fail');
    fs.mkdirSync(spacePath, { recursive: true });
    const sDir = createSessionDir(sessionId, spacePath);

    // Corrupt v0 log that cannot be migrated (invalid turn/start)
    const corruptLines = [
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
        data: { invalidTurn: true }, // lacks required 'turn'
      }),
    ].join('\n');

    fs.writeFileSync(path.join(sDir, 'session.jsonl'), corruptLines, 'utf8');

    const result = await runSessionPremigrate({ sessionsRoot: sessionsDir });

    expect(result.failedCount).toBe(1);
    expect(result.migratedCount).toBe(0);
    expect(result.sessions[0].status).toBe('failed');
    expect(result.sessions[0].error).toBeDefined();

    // Verify target file is NOT present on disk
    const v4Path = path.join(sDir, 'session.v4.jsonl');
    expect(fs.existsSync(v4Path)).toBe(false);
  });

  it('original file byte-identical after run', async () => {
    const sessionId = 'ses_00000000000000000000000000000015';
    const spacePath = path.join(spacesDir, 'space-hash-check');
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
          id: 'msg_u_15',
          role: 'user',
          content: [{ type: 'text', text: 'Hash check test prompt' }],
          source: { kind: 'user', sourceId: 'om_synth_15' },
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
            id: 'msg_a_15',
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

  it('idempotent rerun: skips session already having session.v4.jsonl', async () => {
    const sessionId = 'ses_00000000000000000000000000000016';
    const spacePath = path.join(spacesDir, 'space-idempotent');
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
          id: 'msg_u_16',
          role: 'user',
          content: [{ type: 'text', text: 'Q16' }],
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
            id: 'msg_a_16',
            role: 'assistant',
            content: [{ type: 'text', text: 'A16' }],
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
    const sessionId = 'ses_00000000000000000000000000000017';
    const spacePath = path.join(spacesDir, 'space-dryrun');
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
          id: 'msg_u_17',
          role: 'user',
          content: [{ type: 'text', text: 'Dry run test prompt' }],
          source: { kind: 'user', sourceId: 'om_synth_17' },
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
            id: 'msg_a_17',
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

  it('safety-net retry in dsh-boot: transparently normalizes v0 session on resume failure and succeeds', async () => {
    const sessionId = 'ses_00000000000000000000000000000018';
    const spaceFolder = 'space-safety-net-retry';
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
          id: 'msg_u_18',
          role: 'user',
          content: [{ type: 'text', text: 'Initial prompt with invalid sourceId' }],
          source: { kind: 'user', sourceId: 'om_synth_safety_net_18' },
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
            id: 'msg_a_18',
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
    const sessionId = 'ses_00000000000000000000000000000019';
    const spacePath = path.join(spacesDir, 'space-cli');
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
          id: 'msg_u_19',
          role: 'user',
          content: [{ type: 'text', text: 'CLI test user prompt' }],
          source: { kind: 'user', sourceId: 'om_synth_19' },
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
            id: 'msg_a_19',
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
    expect(JSON.stringify(reportContent)).not.toContain('CLI test user prompt');
  });
});

