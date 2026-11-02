/**
 * PlatformJarvisSource: the platform side of one Jarvis connection (synthetic, offline).
 * In-memory SQLite with the full platform schema, a fake runtime transport feeding the
 * ApprovalBridge and the RuntimeSessionEventHub, a fake session-history reader.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import type { JarvisSourceListener, PendingApprovalCard, PendingQuestionCard } from '@enkeep/channel-jarvis';
import { PlatformServerMigrationRunner, ALL_PLATFORM_MIGRATIONS } from '../src/storage/migrations.js';
import { SqliteWebMessageStore } from '../src/storage/web-messages.js';
import { DeliveryRuntimeGateway, type DeliveryExecutionRequest } from '../src/runtime/delivery-gateway.js';
import { ApprovalBridge } from '../src/interactions/approval-bridge.js';
import { QuestionBridge } from '../src/interactions/question-bridge.js';
import { RuntimeSessionEventHub } from '../src/runtime/session-event-hub.js';
import { WeChatRuntimeManager } from '../src/channels/wechat-runtime.js';
import {
  PlatformJarvisSource,
  JARVIS_SLASH_REFUSAL,
  JARVIS_LATE_ANSWER_MSG_PREFIX,
  jarvisIdempotencyKey,
  type JarvisDeliveryPort,
  type PlatformJarvisSourceOptions,
} from '../src/channels/jarvis/source.js';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const SPACE_A = 'spc_00000000000000000000000000000001';
const SPACE_B = 'spc_00000000000000000000000000000002';
const BOB_SPACE = 'spc_00000000000000000000000000000009';
const ROUTE_DONE = 'ses_00000000000000000000000000000001';
const ROUTE_IDLE = 'ses_00000000000000000000000000000002';
const ROUTE_OLD = 'ses_00000000000000000000000000000003';
const ROUTE_OLD_BLOCKED = 'ses_00000000000000000000000000000004';
const ROUTE_WORKING = 'ses_00000000000000000000000000000005';
const ROUTE_ARCHIVED = 'ses_00000000000000000000000000000006';
const ROUTE_WECHAT = 'ses_00000000000000000000000000000007';
const ROUTE_BOB = 'ses_00000000000000000000000000000099';
const dsh = (route: string) => route.replace(/^ses_0{4}/, 'ses_dddd');

const tick = () => new Promise((r) => setImmediate(r));
async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** In-memory stand-in for a user's daemon transport (`stream` events, approval ops). */
class FakeRuntimeTransport extends EventEmitter {
  readonly answers: Array<{ approvalId: string; decision: string }> = [];
  constructor() {
    super();
    (this as any).listApprovals = undefined;
  }
  async answerApproval(sessionId: string, approvalId: string, decision: string) {
    this.answers.push({ approvalId, decision });
    setImmediate(() =>
      this.emit('stream', { type: 'event', event: 'approval/decided', sessionId, timestamp: Date.now(), decision: { id: approvalId, outcome: decision } })
    );
    return { ok: true, answered: true, approvalId };
  }
  sessionEvent(dshSessionId: string, event: Record<string, unknown> & { seq: number; type: string }) {
    this.emit('stream', { type: 'event', event: 'turn/event', sessionId: dshSessionId, turnId: 'turn_test_0001', seq: event.seq, timestamp: Date.now(), sessionEvent: { time: Date.now(), ...event } });
  }
  chunk(dshSessionId: string, text: string) {
    this.emit('stream', { type: 'event', event: 'turn/chunk', sessionId: dshSessionId, turnId: 'turn_test_0001', timestamp: Date.now(), chunk: { type: 'text-delta', index: 0, text } });
  }
  readonly questionAnswers: Array<{ questionId: string; answers: unknown }> = [];
  questionError?: Error & { code: string };
  async answerQuestion(questionId: string, answers: unknown) {
    if (this.questionError) throw this.questionError;
    this.questionAnswers.push({ questionId, answers });
    return { questionId, answered: true, answers };
  }
  question(dshSessionId: string, id: string, createdAtMs = Date.now()) {
    this.emit('stream', {
      type: 'event', event: 'question/asked', sessionId: dshSessionId, turnId: 'turn_test_0001', timestamp: createdAtMs,
      question: {
        id, sessionId: dshSessionId, callId: id, sessionSource: 'web',
        questions: [
          { id: 'mode', question: 'Which synthetic mode?', header: 'Mode', options: [{ label: 'Docker', description: 'Isolated.' }, { label: 'Host' }], multiSelect: false },
          { id: 'notes', question: 'Anything else?', options: [], multiSelect: false },
        ],
        createdAt: new Date(createdAtMs).toISOString(), timeoutMs: 600_000, expiresAt: new Date(createdAtMs + 600_000).toISOString(), status: 'pending',
      },
    });
  }
  questionSettled(dshSessionId: string, id: string, outcome: string) {
    this.emit('stream', { type: 'event', event: 'question/settled', sessionId: dshSessionId, timestamp: Date.now(), id, outcome });
  }
  ask(dshSessionId: string, id: string, callId?: string) {
    const now = Date.now();
    this.emit('stream', {
      type: 'event', event: 'turn/event', sessionId: dshSessionId, turnId: 'turn_test_0001', seq: 50, timestamp: now,
      sessionEvent: { type: 'approval/asked', seq: 50, time: now, data: { id, toolName: 'bash', ...(callId ? { callId } : {}), reason: 'Run a synthetic command' } },
    });
  }
}

function toolCallEvent(seq: number, callId: string, args: Record<string, unknown>) {
  return { seq, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: args }] } } };
}

/** Fake runtime session history: logs per DSH session id. */
class FakeReader {
  readonly logs = new Map<string, Array<Record<string, unknown> & { seq: number; type: string }>>();
  readonly calls: Array<Record<string, unknown>> = [];
  async readSessionEvents(userId: string, params: { platformSpaceId: string; dshSessionId: string; afterSeq?: number; beforeSeq?: number; limit?: number }) {
    this.calls.push({ userId, ...params });
    const log = this.logs.get(params.dshSessionId);
    if (!log) throw Object.assign(new Error('Session not found'), { code: 'session/not-found' });
    let events = log.filter((e) => (params.afterSeq === undefined || e.seq > params.afterSeq) && (params.beforeSeq === undefined || e.seq < params.beforeSeq));
    const limit = params.limit ?? 200;
    const hasMore = events.length > limit;
    events = params.afterSeq !== undefined ? events.slice(0, limit) : events.slice(-limit);
    return { dshSessionId: params.dshSessionId, events, lastSeq: log.length ? log[log.length - 1]!.seq : -1, hasMore };
  }
  async readAttachment(userId: string, params: { platformSpaceId: string; dshSessionId: string; attachmentId?: string; path?: string }) {
    this.calls.push({ userId, op: 'readAttachment', ...params });
    if (params.attachmentId === 'sha256:missing') throw Object.assign(new Error('gone'), { code: 'attachment/not-found' });
    return { mime: 'image/png', data: 'iVBORw0KGgo=', bytes: 8, sha256: '0'.repeat(64) };
  }
}

function recorder(): JarvisSourceListener & { log: Array<[string, ...unknown[]]>; cards: PendingApprovalCard[]; questionCards: PendingQuestionCard[] } {
  const log: Array<[string, ...unknown[]]> = [];
  const cards: PendingApprovalCard[] = [];
  const questionCards: PendingQuestionCard[] = [];
  return {
    log,
    cards,
    questionCards,
    sessionsChanged: () => log.push(['sessionsChanged']),
    sessionEvent: (id, event, history) => log.push(['sessionEvent', id, event, history]),
    delta: (id, text) => log.push(['delta', id, text]),
    approvalAsked: (card) => {
      cards.push(card);
      log.push(['approvalAsked', card.id]);
    },
    approvalSettled: (id) => log.push(['approvalSettled', id]),
    questionAsked: (card) => {
      questionCards.push(card);
      log.push(['questionAsked', card.id]);
    },
    questionSettled: (id) => log.push(['questionSettled', id]),
  };
}

describe('PlatformJarvisSource', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let jarvisAccountId: string;
  let wechatAccountId: string;
  let bridge: ApprovalBridge;
  let questions: QuestionBridge;
  let hub: RuntimeSessionEventHub;
  let transport: FakeRuntimeTransport;
  let reader: FakeReader;
  let statuses: Map<string, string>;
  let fakeGateway: JarvisDeliveryPort & { dispatchInbound: ReturnType<typeof vi.fn>; cancelCurrentTurn: ReturnType<typeof vi.fn> };
  const sources: PlatformJarvisSource[] = [];

  function source(overrides: Partial<PlatformJarvisSourceOptions> = {}): PlatformJarvisSource {
    const s = new PlatformJarvisSource({
      userId: ALICE,
      accountId: jarvisAccountId,
      db,
      gateway: fakeGateway,
      approvals: bridge,
      questions,
      events: hub,
      reader,
      ...overrides,
    });
    sources.push(s);
    return s;
  }

  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  function addMessage(route: string, role: 'user' | 'assistant', content: string, createdAt = iso(1000)) {
    db.prepare(`INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at) VALUES (?, ?, ?, ?, ?, 'delivered', 'rk', ?)`)
      .run(`msg_${Math.random().toString(16).slice(2)}`, route, ALICE, role, content, createdAt);
  }

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    await new PlatformServerMigrationRunner(db).migrate(ALL_PLATFORM_MIGRATIONS);
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'alice', 'hash', 'admin')`).run(ALICE);
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'bob', 'hash')`).run(BOB);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, created_at) VALUES (?, ?, 'Alice Main', 'alice-main', '2026-01-01 00:00:00')`).run(SPACE_A, ALICE);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, created_at) VALUES (?, ?, 'Alice Notes', 'alice-notes', '2026-01-02 00:00:00')`).run(SPACE_B, ALICE);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder) VALUES (?, ?, 'Bob Space', 'bob-space')`).run(BOB_SPACE, BOB);
    storage = new SqlitePlatformStorage({ database: db });
    jarvisAccountId = (await storage.forTenant(ALICE).channels.createAccount({ type: 'jarvis', status: 'active' })).id;
    wechatAccountId = (await storage.forTenant(ALICE).channels.createAccount({ type: 'wechat', status: 'active' })).id;
    const routes = storage.forTenant(ALICE).sessionRoutes;
    for (const [id, space, title] of [
      [ROUTE_DONE, SPACE_A, 'Synthetic done'],
      [ROUTE_IDLE, SPACE_B, null],
      [ROUTE_OLD, SPACE_A, 'Old'],
      [ROUTE_OLD_BLOCKED, SPACE_A, 'Old but blocked'],
      [ROUTE_WORKING, SPACE_A, 'Working'],
      [ROUTE_ARCHIVED, SPACE_A, 'Archived'],
    ] as const) {
      await routes.create({ id, spaceId: space, channel: 'web', nativeContextId: id, dshSessionId: dsh(id), title });
    }
    await routes.create({ id: ROUTE_WECHAT, spaceId: SPACE_A, channel: 'wechat', accountId: wechatAccountId, nativeContextId: 'wechat:test-peer-01@im.wechat', dshSessionId: dsh(ROUTE_WECHAT), title: 'WeChat chat' });
    await storage.forTenant(BOB).sessionRoutes.create({ id: ROUTE_BOB, spaceId: BOB_SPACE, channel: 'web', nativeContextId: ROUTE_BOB, dshSessionId: dsh(ROUTE_BOB) });
    db.prepare(`UPDATE session_routes SET status = 'archived' WHERE id = ?`).run(ROUTE_ARCHIVED);
    const tenDaysAgo = iso(10 * 24 * 3600 * 1000);
    db.prepare(`UPDATE session_routes SET created_at = ?, updated_at = ? WHERE id IN (?, ?)`).run(tenDaysAgo, tenDaysAgo, ROUTE_OLD, ROUTE_OLD_BLOCKED);

    bridge = new ApprovalBridge({ db, env: {}, logger: { warn: () => {} } });
    questions = new QuestionBridge({ db, env: {}, logger: { warn: () => {} } });
    hub = new RuntimeSessionEventHub({ logger: { warn: () => {} } });
    transport = new FakeRuntimeTransport();
    bridge.attachTransport(ALICE, transport as any);
    questions.attachTransport(ALICE, transport as any);
    hub.attachTransport(ALICE, transport as any);
    reader = new FakeReader();
    statuses = new Map([[ROUTE_WORKING, 'running']]);
    fakeGateway = {
      dispatchInbound: vi.fn(async () => ({ turnId: 'turn_test_0002', isDuplicate: false })),
      getCurrentTurnStatus: async (_userId: string, sessionId: string) => (statuses.has(sessionId) ? { status: statuses.get(sessionId)! } : null),
      cancelCurrentTurn: vi.fn(async () => true),
    };
  });

  afterEach(() => {
    for (const s of sources.splice(0)) s.dispose();
    bridge.dispose();
    questions.dispose();
    hub.dispose();
    db.close();
  });

  describe('session rows', () => {
    it('lists active, recent or busy sessions of the user with status, rev, last text and cwd', async () => {
      addMessage(ROUTE_DONE, 'user', 'synthetic question');
      addMessage(ROUTE_DONE, 'assistant', `synthetic answer ${'x'.repeat(300)}`);
      db.prepare(`INSERT INTO web_events (id, session_id, user_id, type, payload) VALUES ('evt_test_0001', ?, ?, 'message', '{}')`).run(ROUTE_IDLE, ALICE);
      transport.sessionEvent(dsh(ROUTE_DONE), { seq: 41, type: 'turn/end', data: {} });
      transport.ask(dsh(ROUTE_OLD_BLOCKED), '00000000-0000-4000-8000-0000000000b1');
      await tick();
      await tick();

      const rows = await source().listSessions();
      const byId = new Map(rows.map((r) => [r.session_id, r]));
      expect([...byId.keys()].sort()).toEqual([ROUTE_DONE, ROUTE_IDLE, ROUTE_OLD_BLOCKED, ROUTE_WECHAT, ROUTE_WORKING].sort());
      expect(byId.get(ROUTE_DONE)).toMatchObject({
        title: 'Synthetic done',
        status: 'done',
        cwd: '/home/dsh/spaces/alice-main',
        space_id: SPACE_A,
        space_name: 'Alice Main',
        rev: 42,
      });
      expect(byId.get(ROUTE_DONE)!.last_text).toHaveLength(200);
      expect(byId.get(ROUTE_IDLE)).toMatchObject({ title: 'Alice Notes', status: 'idle', cwd: '/home/dsh/spaces/alice-notes' });
      expect(typeof byId.get(ROUTE_IDLE)!.rev).toBe('number');
      expect(byId.get(ROUTE_OLD_BLOCKED)!.status).toBe('blocked');
      expect(byId.get(ROUTE_WORKING)!.status).toBe('working');
      // Newest first.
      const times = rows.map((r) => r.updated_at);
      expect([...times].sort().reverse()).toEqual(times);

      const s = source();
      expect(await s.getSession(ROUTE_OLD)).toMatchObject({ session_id: ROUTE_OLD, status: 'idle' });
      expect(await s.getSession(ROUTE_BOB)).toBeNull();
      expect(await s.getSession(ROUTE_ARCHIVED)).toBeNull();
    });

    it('marks recovery_required and waiting_approval as blocked', async () => {
      statuses.set(ROUTE_IDLE, 'recovery_required');
      statuses.set(ROUTE_DONE, 'waiting_approval');
      const s = source();
      expect((await s.getSession(ROUTE_IDLE))!.status).toBe('blocked');
      expect((await s.getSession(ROUTE_DONE))!.status).toBe('blocked');
    });

    it('fails the listing and reports revocation once the account is no longer authorized', async () => {
      const onRevoked = vi.fn();
      const s = source({ isAuthorized: () => false, onRevoked });
      await expect(s.listSessions()).rejects.toMatchObject({ code: 'unauthorized' });
      expect(onRevoked).toHaveBeenCalledTimes(1);
    });

    it('refuses every node request once the token is no longer valid (rotated elsewhere)', async () => {
      let authorized = true;
      const onRevoked = vi.fn();
      const s = source({ isAuthorized: () => authorized, onRevoked });
      expect(await s.getSession(ROUTE_IDLE)).not.toBeNull();
      authorized = false;
      await expect(s.getSession(ROUTE_IDLE)).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(s.readEvents(ROUTE_IDLE, {})).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(s.readImage(ROUTE_IDLE, 'att:sha256:missing')).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(
        s.send({ sessionId: ROUTE_IDLE, text: 'synthetic text', images: [], clientMsgId: 'phone-msg-stale-0001' })
      ).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(s.interrupt(ROUTE_IDLE)).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(s.rename(ROUTE_IDLE, 'Synthetic title')).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(s.close(ROUTE_IDLE)).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(s.start({ cwd: '/tmp/enkeep-test/none' })).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(s.answerApproval('apr-synthetic-0001', { allow: true })).rejects.toMatchObject({ code: 'unauthorized' });
      expect(onRevoked).toHaveBeenCalledTimes(9);
      expect(fakeGateway.dispatchInbound).not.toHaveBeenCalled();
      expect(fakeGateway.cancelCurrentTurn).not.toHaveBeenCalled();
      expect(reader.calls).toHaveLength(0);
    });
  });

  describe('history', () => {
    it('reads events through the runtime with the route mapped to its DSH session', async () => {
      reader.logs.set(dsh(ROUTE_DONE), [
        { seq: 0, type: 'user/message', data: {} },
        { seq: 1, type: 'assistant/message', data: {} },
        { seq: 2, type: 'turn/end', data: {} },
      ]);
      const s = source();
      const page = await s.readEvents(ROUTE_DONE, { afterSeq: 0, limit: 10 });
      expect(page).toEqual({ events: [expect.objectContaining({ seq: 1 }), expect.objectContaining({ seq: 2 })], history: `dsh:${dsh(ROUTE_DONE)}`, lastSeq: 2, hasMore: false });
      expect(reader.calls[0]).toEqual({ userId: ALICE, platformSpaceId: SPACE_A, dshSessionId: dsh(ROUTE_DONE), afterSeq: 0, limit: 10 });
      expect(hub.lastSeq(ALICE, dsh(ROUTE_DONE))).toBe(2);

      // A session that never ran has an empty log.
      expect(await s.readEvents(ROUTE_IDLE, {})).toEqual({ events: [], history: `dsh:${dsh(ROUTE_IDLE)}`, lastSeq: -1, hasMore: false });
      // Another user's session is unknown.
      await expect(s.readEvents(ROUTE_BOB, {})).rejects.toMatchObject({ code: 'not_found' });
      expect(reader.calls.some((c) => c.dshSessionId === dsh(ROUTE_BOB))).toBe(false);
    });

    it('reads images by attachment id or workspace path', async () => {
      const s = source();
      expect(await s.readImage(ROUTE_DONE, 'att:sha256:abc')).toEqual({ mime: 'image/png', data: 'iVBORw0KGgo=' });
      expect(reader.calls.at(-1)).toMatchObject({ op: 'readAttachment', dshSessionId: dsh(ROUTE_DONE), attachmentId: 'sha256:abc' });
      await s.readImage(ROUTE_DONE, 'path:.attachments/incoming/synthetic.png');
      expect(reader.calls.at(-1)).toMatchObject({ path: '.attachments/incoming/synthetic.png' });
      await expect(s.readImage(ROUTE_DONE, 'att:sha256:missing')).rejects.toMatchObject({ code: 'not_found' });
      await expect(s.readImage(ROUTE_DONE, 'bogus')).rejects.toMatchObject({ code: 'invalid_params' });
    });
  });

  describe('send', () => {
    it('dispatches an InboundEnvelope with the jarvis channel context and a stable idempotency key', async () => {
      const s = source();
      await s.send({ sessionId: ROUTE_DONE, text: '  hello from the phone  ', images: [], clientMsgId: 'client-msg-0001' });
      const envelope = fakeGateway.dispatchInbound.mock.calls[0]![0];
      const expectedId = `idem_jarvis_${createHash('sha256').update(`${jarvisAccountId}:client-msg-0001`).digest('hex').slice(0, 32)}`;
      expect(jarvisIdempotencyKey(jarvisAccountId, 'client-msg-0001')).toBe(expectedId);
      expect(envelope).toMatchObject({
        id: expectedId,
        userId: ALICE,
        sessionId: ROUTE_DONE,
        content: 'hello from the phone',
        channelContext: {
          channel: 'jarvis',
          accountId: jarvisAccountId,
          chatId: ROUTE_DONE,
          nativeContextId: `jarvis:${jarvisAccountId}`,
          nativeEventId: 'client-msg-0001',
          senderId: ALICE,
          chatType: 'p2p',
        },
      });
      expect(envelope.attachments).toBeUndefined();
    });

    it('refuses slash commands, other users\' sessions and empty messages', async () => {
      const s = source();
      await expect(s.send({ sessionId: ROUTE_DONE, text: '  /stop', images: [], clientMsgId: 'c1' })).rejects.toMatchObject({ code: 'unsupported', message: JARVIS_SLASH_REFUSAL });
      await expect(s.send({ sessionId: ROUTE_BOB, text: 'hi', images: [], clientMsgId: 'c2' })).rejects.toMatchObject({ code: 'not_found' });
      await expect(s.send({ sessionId: ROUTE_ARCHIVED, text: 'hi', images: [], clientMsgId: 'c3' })).rejects.toMatchObject({ code: 'not_found' });
      await expect(s.send({ sessionId: ROUTE_DONE, text: '  ', images: [], clientMsgId: 'c4' })).rejects.toMatchObject({ code: 'invalid_params' });
      expect(fakeGateway.dispatchInbound).not.toHaveBeenCalled();
    });

    it('ingests images into the session space and attaches them', async () => {
      const ingested: Array<Record<string, unknown>> = [];
      const imageIngestor = {
        ingestImage: vi.fn(async (params: any) => {
          ingested.push(params);
          return { path: `.attachments/incoming/${'a'.repeat(64)}.png`, etag: `"${'a'.repeat(64)}"`, mediaType: 'image/png', displayName: `${params.fileKey}.png` };
        }),
      };
      const s = source({ imageIngestor });
      const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
      await s.send({ sessionId: ROUTE_IDLE, text: '', images: [{ mime: 'image/png', data: png.toString('base64') }], clientMsgId: 'img-0001' });
      expect(ingested[0]).toMatchObject({ userId: ALICE, spaceId: SPACE_B, messageId: jarvisIdempotencyKey(jarvisAccountId, 'img-0001'), fileKey: 'jarvis-image-1', contentType: 'image/png' });
      expect((ingested[0]!.buffer as Buffer).equals(png)).toBe(true);
      const envelope = fakeGateway.dispatchInbound.mock.calls[0]![0];
      expect(envelope.content).toBe('[图片]');
      expect(envelope.attachments).toEqual([{ path: `.attachments/incoming/${'a'.repeat(64)}.png`, etag: `"${'a'.repeat(64)}"`, mediaType: 'image/png', displayName: 'jarvis-image-1.png' }]);

      await expect(s.send({ sessionId: ROUTE_IDLE, text: 'x', images: [{ mime: 'image/tiff', data: png.toString('base64') }], clientMsgId: 'img-0002' })).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(s.send({ sessionId: ROUTE_IDLE, text: 'x', images: [{ mime: 'image/png', data: '%%%' }], clientMsgId: 'img-0003' })).rejects.toMatchObject({ code: 'invalid_params' });
      const big = Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64');
      await expect(s.send({ sessionId: ROUTE_IDLE, text: 'x', images: [{ mime: 'image/png', data: big }], clientMsgId: 'img-0004' })).rejects.toMatchObject({ code: 'too_large' });
      await expect(source().send({ sessionId: ROUTE_IDLE, text: 'x', images: [{ mime: 'image/png', data: png.toString('base64') }], clientMsgId: 'img-0005' })).rejects.toMatchObject({ code: 'unsupported' });
    });

    it('through the delivery gateway: one turn per clientMsgId, origin channel jarvis, WeChat does not reply', async () => {
      const executions: DeliveryExecutionRequest[] = [];
      const gateway = new DeliveryRuntimeGateway({
        storage,
        messageStore: new SqliteWebMessageStore(db),
        database: db,
        executor: {
          execute: async (req: DeliveryExecutionRequest) => {
            executions.push(req);
            return { replyText: 'synthetic reply', usage: { totalTokens: 1 } };
          },
          cancel: async () => true,
        },
        quotaMode: 'disabled',
        profileResolver: { resolve: async () => null } as any,
      });
      try {
        const s = source({ gateway });
        await s.send({ sessionId: ROUTE_WECHAT, text: 'synthetic hello', images: [], clientMsgId: 'dup-0001' });
        await s.send({ sessionId: ROUTE_WECHAT, text: 'synthetic hello', images: [], clientMsgId: 'dup-0001' });
        const turns = db.prepare('SELECT turn_id FROM turn_runs WHERE route_id = ?').all(ROUTE_WECHAT) as Array<{ turn_id: string }>;
        expect(turns).toHaveLength(1);
        const origin = db.prepare('SELECT * FROM channel_turn_origins WHERE turn_id = ?').get(turns[0]!.turn_id) as any;
        expect(origin).toMatchObject({ channel: 'jarvis', account_id: jarvisAccountId, session_id: ROUTE_WECHAT, chat_id: ROUTE_WECHAT, native_event_id: 'dup-0001' });
        await waitFor(() => executions.length === 1);

        // The WeChat runtime manager must not forward a Jarvis-originated turn on its bound route.
        const manager = new WeChatRuntimeManager({ storage, db, deliveryGateway: { getFileProvider: () => undefined } } as any);
        const wechatGateway = { handleTurnCompleted: vi.fn().mockResolvedValue(undefined) };
        vi.spyOn(manager, 'getActiveGateway').mockReturnValue(wechatGateway as any);
        (manager as any).isRunning = true;
        await manager.handleTurnCompleted({
          userId: ALICE,
          sessionId: ROUTE_WECHAT,
          spaceId: SPACE_A,
          turnId: turns[0]!.turn_id,
          deliveryId: `deliv_${turns[0]!.turn_id}`,
          idempotencyKey: jarvisIdempotencyKey(jarvisAccountId, 'dup-0001'),
          executionResult: { replyText: 'synthetic reply' },
          tokenUsage: { tokens: 0 },
        } as any);
        expect(wechatGateway.handleTurnCompleted).not.toHaveBeenCalled();
      } finally {
        await gateway.drain(2000);
        await gateway.close();
      }
    });
  });

  describe('session actions', () => {
    function api() {
      return {
        createSession: vi.fn(async (_userId: string, input: { spaceId: string; title?: string | null }) => {
          const id = 'ses_00000000000000000000000000000077';
          await storage.forTenant(ALICE).sessionRoutes.create({ id, spaceId: input.spaceId, channel: 'web', nativeContextId: id, dshSessionId: id, title: input.title ?? null });
          return { id };
        }),
        updateSession: vi.fn(async () => ({})),
        archiveSession: vi.fn(async () => ({})),
      };
    }

    it('interrupts, renames and closes through the platform', async () => {
      const sessionApi = api();
      const s = source({ sessionApi });
      await s.interrupt(ROUTE_WORKING);
      expect(fakeGateway.cancelCurrentTurn).toHaveBeenCalledWith(ALICE, ROUTE_WORKING);
      await s.rename(ROUTE_DONE, '  New synthetic title ');
      expect(sessionApi.updateSession).toHaveBeenCalledWith(ALICE, ROUTE_DONE, { title: 'New synthetic title' });
      await s.close(ROUTE_DONE);
      expect(sessionApi.archiveSession).toHaveBeenCalledWith(ALICE, ROUTE_DONE);
      await expect(s.interrupt(ROUTE_BOB)).rejects.toMatchObject({ code: 'not_found' });
      await expect(s.close(ROUTE_BOB)).rejects.toMatchObject({ code: 'not_found' });
      expect(sessionApi.archiveSession).toHaveBeenCalledTimes(1);
    });

    it('starts a session in the space matching cwd and sends the prompt', async () => {
      const sessionApi = api();
      const s = source({ sessionApi });
      const row = await s.start({ cwd: '/home/dsh/spaces/alice-notes/', prompt: 'Summarize the synthetic notes\nwith details' });
      expect(sessionApi.createSession).toHaveBeenCalledWith(ALICE, { spaceId: SPACE_B, title: 'Summarize the synthetic notes', forceNew: true });
      expect(row).toMatchObject({ session_id: 'ses_00000000000000000000000000000077', space_id: SPACE_B, title: 'Summarize the synthetic notes' });
      const envelope = fakeGateway.dispatchInbound.mock.calls[0]![0];
      expect(envelope).toMatchObject({ sessionId: 'ses_00000000000000000000000000000077', content: 'Summarize the synthetic notes\nwith details' });
      expect(envelope.channelContext.nativeEventId).toMatch(/^start-[0-9a-f-]{36}$/);
    });

    it('falls back to the account default space, else the first space', async () => {
      const sessionApi = api();
      const s = source({ sessionApi });
      await s.start({ cwd: '/somewhere/else' });
      expect(sessionApi.createSession).toHaveBeenLastCalledWith(ALICE, { spaceId: SPACE_A, title: null, forceNew: true });
      db.prepare('DELETE FROM session_routes WHERE id = ?').run('ses_00000000000000000000000000000077');
      db.prepare('UPDATE channel_accounts SET default_space_id = ? WHERE id = ?').run(SPACE_B, jarvisAccountId);
      await s.start({ cwd: '/somewhere/else' });
      expect(sessionApi.createSession).toHaveBeenLastCalledWith(ALICE, { spaceId: SPACE_B, title: null, forceNew: true });
      await expect(s.start({ cwd: '/x', prompt: '/new' })).rejects.toMatchObject({ code: 'unsupported' });
    });

    it('answers questions as unavailable without a question bridge', async () => {
      await expect(source({ questions: undefined }).answerQuestion('call_test_q0', [])).rejects.toMatchObject({ code: 'unavailable' });
    });
  });

  describe('live', () => {
    it('pushes mapped session events, accumulated text deltas and list changes', async () => {
      const s = source();
      const l = recorder();
      s.subscribe(l);
      transport.sessionEvent(dsh(ROUTE_DONE), { seq: 3, type: 'turn/start', data: {} });
      transport.sessionEvent('ses_ffff0000000000000000000000000001', { seq: 0, type: 'assistant/message', data: {} });
      transport.chunk(dsh(ROUTE_DONE), 'Hel');
      transport.chunk(dsh(ROUTE_DONE), 'lo');
      transport.sessionEvent(dsh(ROUTE_DONE), { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Hello' }] } } });
      transport.sessionEvent(dsh(ROUTE_DONE), { seq: 5, type: 'turn/end', data: {} });

      const events = l.log.filter((e) => e[0] === 'sessionEvent');
      expect(events.map((e) => [e[1], (e[2] as any).seq, e[3]])).toEqual([
        [ROUTE_DONE, 3, `dsh:${dsh(ROUTE_DONE)}`],
        [ROUTE_DONE, 4, `dsh:${dsh(ROUTE_DONE)}`],
        [ROUTE_DONE, 5, `dsh:${dsh(ROUTE_DONE)}`],
      ]);
      expect(l.log.filter((e) => e[0] === 'delta')).toEqual([
        ['delta', ROUTE_DONE, 'Hel'],
        ['delta', ROUTE_DONE, 'Hello'],
        ['delta', ROUTE_DONE, null],
      ]);
      expect(l.log.filter((e) => e[0] === 'sessionsChanged').length).toBeGreaterThanOrEqual(2);

      // A turn that completes mid-text ends the live text too.
      transport.chunk(dsh(ROUTE_DONE), 'partial');
      s.notifyTurnSettled(ROUTE_DONE);
      expect(l.log.filter((e) => e[0] === 'delta').at(-1)).toEqual(['delta', ROUTE_DONE, null]);
    });

    it('turns approvals into cards with the tool input, answers them and follows settlements', async () => {
      const s = source();
      const l = recorder();
      s.subscribe(l);
      transport.sessionEvent(dsh(ROUTE_DONE), toolCallEvent(10, 'call_test_0001', { command: 'ls -la' }));

      // Allowed from Jarvis.
      const first = '00000000-0000-4000-8000-000000000001';
      transport.ask(dsh(ROUTE_DONE), first, 'call_test_0001');
      const card = await waitFor(() => l.cards.find((c) => c.id === first));
      expect(card).toMatchObject({ id: first, sessionId: ROUTE_DONE, toolName: 'bash', callId: 'call_test_0001', toolInput: { command: 'ls -la' }, reason: 'Run a synthetic command' });
      expect(typeof card.expiresAt).toBe('string');
      await s.answerApproval(first, { allow: true });
      expect(transport.answers).toEqual([{ approvalId: first, decision: 'allowed-once' }]);
      await tick();
      expect(l.log.some((e) => e[0] === 'approvalSettled' && e[1] === first)).toBe(false);

      // Refused from Jarvis with a reason: rejected, then the reason is queued as the next message.
      const second = '00000000-0000-4000-8000-000000000002';
      reader.logs.set(dsh(ROUTE_DONE), [toolCallEvent(11, 'call_test_0002', { file_path: 'notes.md' }) as any]);
      transport.ask(dsh(ROUTE_DONE), second, 'call_test_0002');
      const card2 = await waitFor(() => l.cards.find((c) => c.id === second));
      expect(card2.toolInput).toEqual({ file_path: 'notes.md' });
      await s.answerApproval(second, { allow: false, message: 'use the other file' });
      expect(transport.answers.at(-1)).toEqual({ approvalId: second, decision: 'rejected' });
      const reason = fakeGateway.dispatchInbound.mock.calls.at(-1)![0];
      expect(reason).toMatchObject({
        id: jarvisIdempotencyKey(jarvisAccountId, `approval-reason-${second}`),
        sessionId: ROUTE_DONE,
        content: '拒绝理由：use the other file',
        channelContext: { channel: 'jarvis', nativeEventId: `approval-reason-${second}` },
      });

      // Answered elsewhere: the card comes off the phone.
      const third = '00000000-0000-4000-8000-000000000003';
      transport.ask(dsh(ROUTE_DONE), third);
      await waitFor(() => l.cards.find((c) => c.id === third));
      await bridge.decide(third, 'rejected', { userId: ALICE, decidedBy: 'web' });
      await waitFor(() => l.log.some((e) => e[0] === 'approvalSettled' && e[1] === third));
      await expect(s.answerApproval(third, { allow: true })).rejects.toMatchObject({ code: 'conflict' });
      await expect(s.answerApproval('00000000-0000-4000-8000-0000000000ff', { allow: true })).rejects.toMatchObject({ code: 'not_found' });
    });

    it('replays pending approvals on subscribe and skips other users and unmapped sessions', async () => {
      const pendingId = '00000000-0000-4000-8000-000000000004';
      transport.ask(dsh(ROUTE_IDLE), pendingId);
      transport.ask('ses_ffff0000000000000000000000000002', '00000000-0000-4000-8000-000000000005');
      const bobTransport = new FakeRuntimeTransport();
      bridge.attachTransport(BOB, bobTransport as any);
      bobTransport.ask(dsh(ROUTE_BOB), '00000000-0000-4000-8000-000000000006');
      await tick();
      await tick();
      const l = recorder();
      source().subscribe(l);
      await waitFor(() => l.cards.length > 0);
      await new Promise((r) => setTimeout(r, 20));
      expect(l.cards.map((c) => c.id)).toEqual([pendingId]);
    });

    it('turns questions into cards, answers them and follows settlements', async () => {
      const replayed = 'call_test_question_0001';
      transport.question(dsh(ROUTE_IDLE), replayed);
      transport.question('ses_ffff0000000000000000000000000003', 'call_test_question_0009'); // no route
      const bobTransport = new FakeRuntimeTransport();
      questions.attachTransport(BOB, bobTransport as any);
      bobTransport.question(dsh(ROUTE_BOB), 'call_test_question_0008');

      const s = source();
      const l = recorder();
      s.subscribe(l);
      // Replayed on subscribe: only this user's questions of sessions with a route.
      expect(l.questionCards).toEqual([
        {
          id: replayed,
          sessionId: ROUTE_IDLE,
          callId: replayed,
          questions: [
            { id: 'mode', question: 'Which synthetic mode?', header: 'Mode', options: [{ label: 'Docker', description: 'Isolated.' }, { label: 'Host' }], multiSelect: false },
            { id: 'notes', question: 'Anything else?', options: [], multiSelect: false },
          ],
          expiresAt: expect.any(String),
        },
      ]);
      // A session with a pending question is blocked.
      expect((await s.getSession(ROUTE_IDLE))!.status).toBe('blocked');
      expect((await s.listSessions()).find((r) => r.session_id === ROUTE_IDLE)!.status).toBe('blocked');

      // Answered from Jarvis: through the bridge to the runtime; no cancel for the card.
      await s.answerQuestion(replayed, [{ id: 'mode', selected: ['Docker'] }, { id: 'notes', selected: [], custom: 'synthetic words' }]);
      expect(transport.questionAnswers).toEqual([
        { questionId: replayed, answers: [{ id: 'mode', selected: ['Docker'] }, { id: 'notes', selected: [], custom: 'synthetic words' }] },
      ]);
      expect(l.log.some((e) => e[0] === 'questionSettled')).toBe(false);
      await expect(s.answerQuestion(replayed, [])).rejects.toMatchObject({ code: 'conflict' });
      await expect(s.answerQuestion('call_test_question_0008', [])).rejects.toMatchObject({ code: 'not_found' });

      // Live: a new question becomes a card; settled elsewhere (cancelled in the runtime) takes it off.
      const live = 'call_test_question_0002';
      transport.question(dsh(ROUTE_DONE), live);
      expect(l.questionCards.map((c) => c.id)).toEqual([replayed, live]);
      await expect(s.answerQuestion(live, [{ id: 'mode', selected: ['Nope'] }])).rejects.toMatchObject({ code: 'invalid_params' });
      transport.questionSettled(dsh(ROUTE_DONE), live, 'cancelled');
      expect(l.log.filter((e) => e[0] === 'questionSettled')).toEqual([['questionSettled', live]]);
      expect((await s.getSession(ROUTE_DONE))!.status).not.toBe('blocked');
    });

    it('sends an answer that arrives after its question expired as the next message of the session', async () => {
      const id = 'call_test_question_0003';
      transport.question(dsh(ROUTE_DONE), id, Date.now());
      transport.questionError = Object.assign(new Error('[question/expired] synthetic'), { code: 'question/expired' });
      const s = source();
      const l = recorder();
      s.subscribe(l);
      // The runtime refuses (expired); the bridge's record keeps the question for wording the answer.
      await s.answerQuestion(id, [{ id: 'mode', selected: ['Host'] }]);
      expect(transport.questionAnswers).toEqual([]);
      const envelope = fakeGateway.dispatchInbound.mock.calls.at(-1)![0];
      expect(envelope).toMatchObject({
        id: jarvisIdempotencyKey(jarvisAccountId, `${JARVIS_LATE_ANSWER_MSG_PREFIX}${id}`),
        sessionId: ROUTE_DONE,
        channelContext: { channel: 'jarvis', nativeEventId: `question-late-${id}` },
      });
      expect(envelope.content).toMatch(/^Answer to the question you asked at .*, which timed out before I answered:\n/);
      expect(envelope.content).toContain('- mode ("Which synthetic mode?"): Host');
      expect(envelope.content).toContain('- notes ("Anything else?"): skipped');
      // The card was taken off when the question expired (not answered by Jarvis).
      expect(l.log.filter((e) => e[0] === 'questionSettled')).toEqual([['questionSettled', id]]);

      // Answering the same expired question again goes through the same idempotent message.
      await s.answerQuestion(id, [{ id: 'mode', selected: ['Host'] }]);
      expect(fakeGateway.dispatchInbound.mock.calls.at(-1)![0].id).toBe(envelope.id);
    });
  });

  describe('rev', () => {
    it('never goes backwards when the DSH seq becomes known, and changes with every new event', async () => {
      db.prepare(`INSERT INTO web_events (id, session_id, user_id, type, payload) VALUES ('evt_test_0101', ?, ?, 'message', '{}')`).run(ROUTE_IDLE, ALICE);
      db.prepare(`INSERT INTO web_events (id, session_id, user_id, type, payload) VALUES ('evt_test_0102', ?, ?, 'message', '{}')`).run(ROUTE_DONE, ALICE);
      const s = source();
      const revOf = async (route: string) => (await s.getSession(route))!.rev!;
      const watermarkOnly = await revOf(ROUTE_IDLE);
      expect(watermarkOnly).toBeGreaterThan(0);

      // The seq becomes known (a small number): the rev still grows.
      transport.sessionEvent(dsh(ROUTE_IDLE), { seq: 0, type: 'turn/start', data: {} });
      const withSeq = await revOf(ROUTE_IDLE);
      expect(withSeq).toBeGreaterThan(watermarkOnly);
      expect(await revOf(ROUTE_IDLE)).toBe(withSeq); // unchanged content: same rev
      transport.sessionEvent(dsh(ROUTE_IDLE), { seq: 1, type: 'turn/end', data: {} });
      const next = await revOf(ROUTE_IDLE);
      expect(next).toBeGreaterThan(withSeq);

      // The DSH log is replaced (session reset to a new DSH session id): still monotonic.
      db.prepare('UPDATE session_routes SET dsh_session_id = ? WHERE id = ?').run('ses_eeee0000000000000000000000000002', ROUTE_IDLE);
      const afterReset = await revOf(ROUTE_IDLE);
      expect(afterReset).toBeGreaterThan(next);
      expect(await revOf(ROUTE_IDLE)).toBe(afterReset);
    });
  });
});
