/**
 * QuestionBridge: the host side of `ask_user_question` (synthetic, offline). A fake runtime
 * transport emits the daemon's `question/asked` / `question/settled` pushes and serves the
 * `listQuestions` / `answerQuestion` ops; the bridge backs the routes, the gateway's waiting
 * status and the channels.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { provisionFixtures } from '@enkeep/platform-auth';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { DEFAULT_QUESTION_TIMEOUT_MS } from '@enkeep/dsh-external-interaction/user-questions';
import {
  QuestionBridge,
  toPendingQuestionView,
  type QuestionAskedEvent,
  type QuestionSettledEvent,
} from '../src/interactions/question-bridge.js';
import { PlatformServerMigrationRunner, ALL_PLATFORM_MIGRATIONS } from '../src/storage/migrations.js';
import { DeliveryRuntimeGateway, DEFAULT_INTERACTIVE_TURN_TIMEOUT_MS, type DeliveryExecutionRequest } from '../src/runtime/delivery-gateway.js';
import { PlatformServer, SqliteWebMessageStore } from '../src/index.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const ROUTE = 'ses_00000000000000000000000000000031';
const DSH = 'ses_00000000000000000000000000000131';
const SUBAGENT_DSH = 'ses_ffff0000000000000000000000000031';
const Q1 = 'call_test_question_0001';
const Q2 = 'call_test_question_0002';

const QUESTIONS = [
  {
    id: 'mode',
    question: 'Which deployment mode should the synthetic service use?',
    header: 'Mode',
    options: [{ label: 'Docker', description: 'Isolated and reproducible.' }, { label: 'Host' }],
    multiSelect: false,
  },
  { id: 'extras', question: 'Which extras?', options: [{ label: 'Metrics' }, { label: 'Tracing' }], multiSelect: true },
  { id: 'notes', question: 'Anything else to know?', options: [], multiSelect: false },
];

function pendingRecord(id: string, dshSessionId: string, createdAtMs: number, timeoutMs = 600_000) {
  return {
    id,
    sessionId: dshSessionId,
    callId: id,
    sessionSource: 'web',
    questions: QUESTIONS,
    createdAt: new Date(createdAtMs).toISOString(),
    timeoutMs,
    expiresAt: new Date(createdAtMs + timeoutMs).toISOString(),
    status: 'pending',
  };
}

type FakeError = Error & { code: string; details?: unknown };
function daemonError(code: string, details?: unknown): FakeError {
  return Object.assign(new Error(`[${code}] synthetic`), { code, ...(details !== undefined ? { details } : {}) });
}

/** In-memory stand-in for a user's daemon transport (question pushes and ops). */
class FakeQuestionTransport extends EventEmitter {
  readonly answers: Array<{ questionId: string; answers: unknown }> = [];
  /** Questions the runtime lists (undefined = `listQuestions` not supported). */
  runtimeQuestions?: Array<Record<string, unknown>>;
  enabled = true;
  answerError?: FakeError;
  /** Push `question/settled` after an accepted answer (like the daemon). */
  pushSettled = true;
  /** Hold answers until released (concurrency tests). */
  hold?: Promise<void>;

  constructor(options: { list?: boolean } = {}) {
    super();
    if (options.list) this.runtimeQuestions = [];
    else (this as any).listQuestions = undefined;
  }

  async listQuestions() {
    return { enabled: this.enabled, questions: this.runtimeQuestions ?? [] };
  }

  async answerQuestion(questionId: string, answers: unknown) {
    if (this.hold) await this.hold;
    if (this.answerError) throw this.answerError;
    this.answers.push({ questionId, answers });
    const listed = this.runtimeQuestions?.find((q) => q.id === questionId);
    if (this.runtimeQuestions) this.runtimeQuestions = this.runtimeQuestions.filter((q) => q.id !== questionId);
    if (this.pushSettled) {
      const sessionId = (listed?.sessionId as string | undefined) ?? DSH;
      setImmediate(() => this.settled(sessionId, questionId, 'answered', answers));
    }
    return { questionId, answered: true, answers };
  }

  ask(record: Record<string, unknown>, turnId = 'turn_test_0001') {
    this.emit('stream', {
      type: 'event',
      event: 'question/asked',
      sessionId: record.sessionId,
      turnId,
      timestamp: Date.parse(record.createdAt as string),
      question: record,
    });
  }

  settled(sessionId: string, id: string, outcome: string, answers?: unknown) {
    this.emit('stream', {
      type: 'event',
      event: 'question/settled',
      sessionId,
      timestamp: Date.now(),
      id,
      outcome,
      ...(answers !== undefined ? { answers } : {}),
    });
  }
}

const tick = () => new Promise((r) => setImmediate(r));

function collect(bridge: QuestionBridge) {
  const asked: QuestionAskedEvent[] = [];
  const settled: QuestionSettledEvent[] = [];
  bridge.onAsked((e) => asked.push(e));
  bridge.onSettled((e) => settled.push(e));
  return { asked, settled };
}

describe('QuestionBridge', () => {
  let bridge: QuestionBridge;
  let clock: number;
  const at = Date.parse('2026-01-01T00:00:00.000Z');

  function newBridge() {
    return new QuestionBridge({
      resolveRouteId: (userId, dshId) => (userId === ALICE && dshId === DSH ? ROUTE : undefined),
      env: {},
      now: () => clock,
      logger: { warn: () => {} },
    });
  }

  beforeEach(() => {
    clock = at + 1_000;
    bridge = newBridge();
  });

  afterEach(() => {
    bridge.dispose();
  });

  it('emits asked once per question with the route id, the questions and the expiry, and settled once', async () => {
    const transport = new FakeQuestionTransport();
    bridge.attachTransport(ALICE, transport);
    const { asked, settled } = collect(bridge);

    transport.ask(pendingRecord(Q1, DSH, at));
    transport.ask(pendingRecord(Q1, DSH, at)); // duplicate push
    expect(asked).toHaveLength(1);
    expect(asked[0]!.question).toEqual({
      id: Q1,
      userId: ALICE,
      sessionId: ROUTE,
      dshSessionId: DSH,
      routeResolved: true,
      turnId: 'turn_test_0001',
      callId: Q1,
      questions: QUESTIONS,
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:10:00.000Z',
      timeoutMs: 600_000,
    });
    expect(bridge.listPending({ userId: ALICE, sessionId: ROUTE }).map((q) => q.id)).toEqual([Q1]);
    expect(bridge.listPending({ userId: ALICE, sessionId: DSH }).map((q) => q.id)).toEqual([Q1]);

    transport.settled(DSH, Q1, 'cancelled');
    transport.settled(DSH, Q1, 'cancelled');
    transport.ask(pendingRecord(Q1, DSH, at)); // late duplicate of a settled question
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ outcome: 'cancelled', source: 'runtime', question: { id: Q1 } });
    expect(asked).toHaveLength(1);
    expect(bridge.listPending()).toEqual([]);
    expect(bridge.getSettled(Q1, ALICE)).toMatchObject({ outcome: 'cancelled' });
  });

  it('validates answers, answers through the transport and settles exactly once with the channel', async () => {
    const transport = new FakeQuestionTransport();
    bridge.attachTransport(ALICE, transport);
    const { settled } = collect(bridge);
    transport.ask(pendingRecord(Q1, DSH, at));

    await expect(bridge.answer(Q1, [{ id: 'mode', selected: ['Kubernetes'] }], { userId: ALICE })).resolves.toMatchObject({
      ok: false,
      status: 'invalid',
      error: expect.stringContaining('does not offer'),
    });
    await expect(bridge.answer(Q1, [{ id: 'mode', selected: ['Docker', 'Host'] }], { userId: ALICE })).resolves.toMatchObject({
      status: 'invalid',
    });
    await expect(bridge.answer(Q1, 'not-an-array', { userId: ALICE })).resolves.toMatchObject({ status: 'invalid' });
    expect(transport.answers).toEqual([]);

    const answers = [
      { id: 'notes', selected: [], custom: '  Synthetic constraint: keep it small.  ' },
      { id: 'extras', selected: ['Metrics', 'Tracing'] },
      { id: 'mode', selected: ['Docker'] },
    ];
    const normalized = [
      { id: 'mode', selected: ['Docker'] },
      { id: 'extras', selected: ['Metrics', 'Tracing'] },
      { id: 'notes', selected: [], custom: 'Synthetic constraint: keep it small.' },
    ];
    const result = await bridge.answer(Q1, answers, { userId: ALICE, decidedBy: 'web' });
    expect(result).toEqual({ ok: true, status: 'answered', outcome: 'answered', answers: normalized });
    expect(transport.answers).toEqual([{ questionId: Q1, answers: normalized }]);
    await tick(); // the runtime's question/settled push arrives after the answer
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ outcome: 'answered', source: 'answer', decidedBy: 'web', answers: normalized });

    await expect(bridge.answer(Q1, normalized, { userId: ALICE })).resolves.toEqual({
      ok: false,
      status: 'already_settled',
      outcome: 'answered',
    });
    expect(transport.answers).toHaveLength(1);
  });

  it('lets the first of two concurrent answers win', async () => {
    const transport = new FakeQuestionTransport();
    let release!: () => void;
    transport.hold = new Promise<void>((r) => (release = r));
    bridge.attachTransport(ALICE, transport);
    const { settled } = collect(bridge);
    transport.ask(pendingRecord(Q1, DSH, at));

    const first = bridge.answer(Q1, [{ id: 'mode', selected: ['Host'] }], { userId: ALICE, decidedBy: 'jarvis' });
    const second = await bridge.answer(Q1, [{ id: 'mode', selected: ['Docker'] }], { userId: ALICE, decidedBy: 'web' });
    expect(second).toEqual({ ok: false, status: 'already_answering' });
    release();
    await expect(first).resolves.toMatchObject({ ok: true, status: 'answered' });
    await tick();
    expect(transport.answers).toEqual([{ questionId: Q1, answers: [{ id: 'mode', selected: ['Host'] }] }]);
    expect(settled.map((e) => e.decidedBy)).toEqual(['jarvis']);
  });

  it('expires locally and reports a later answer as expired with the question and validated answers', async () => {
    const transport = new FakeQuestionTransport();
    bridge.attachTransport(ALICE, transport);
    const { settled } = collect(bridge);
    transport.ask(pendingRecord(Q1, DSH, at, 60_000));

    clock = at + 60_000 + 5_001; // past expiry + grace
    expect(bridge.listPending({ userId: ALICE })).toEqual([]);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ outcome: 'expired', source: 'expiry' });

    const late = await bridge.answer(Q1, [{ id: 'mode', selected: ['Docker'] }], { userId: ALICE, decidedBy: 'jarvis' });
    expect(late).toMatchObject({ ok: false, status: 'expired', outcome: 'expired', answers: [{ id: 'mode', selected: ['Docker'] }] });
    expect(late.question).toMatchObject({ id: Q1, sessionId: ROUTE, createdAt: '2026-01-01T00:00:00.000Z' });
    expect(transport.answers).toEqual([]);
    await expect(bridge.answer(Q1, [{ id: 'mode', selected: ['Nope'] }], { userId: ALICE })).resolves.toMatchObject({ status: 'invalid' });
    expect(settled).toHaveLength(1);
  });

  it('maps runtime refusals: expired, already settled, not found, and keeps the question on a transport failure', async () => {
    const transport = new FakeQuestionTransport();
    bridge.attachTransport(ALICE, transport);
    const { settled } = collect(bridge);
    const answers = [{ id: 'mode', selected: ['Docker'] }];

    transport.ask(pendingRecord(Q1, DSH, at));
    transport.answerError = daemonError('question/expired', { questionId: Q1 });
    await expect(bridge.answer(Q1, answers, { userId: ALICE })).resolves.toMatchObject({ status: 'expired', question: { id: Q1 } });
    expect(settled.at(-1)).toMatchObject({ outcome: 'expired', source: 'runtime' });

    transport.ask(pendingRecord(Q2, DSH, at));
    transport.answerError = daemonError('question/already-settled', { questionId: Q2, status: 'cancelled' });
    await expect(bridge.answer(Q2, answers, { userId: ALICE })).resolves.toEqual({ ok: false, status: 'already_settled', outcome: 'cancelled' });
    expect(settled.at(-1)).toMatchObject({ outcome: 'cancelled', question: { id: Q2 } });

    const q3 = 'call_test_question_0003';
    transport.ask(pendingRecord(q3, DSH, at));
    transport.answerError = Object.assign(new Error('Transport closed'), { code: 'SHUTTING_DOWN' });
    await expect(bridge.answer(q3, answers, { userId: ALICE })).resolves.toEqual({ ok: false, status: 'failed' });
    expect(bridge.getPending(q3, ALICE)).toBeDefined();
    transport.answerError = daemonError('question/not-found');
    await expect(bridge.answer(q3, answers, { userId: ALICE })).resolves.toEqual({ ok: false, status: 'not_found' });
    expect(settled.at(-1)).toMatchObject({ outcome: 'unavailable', question: { id: q3 } });
    await expect(bridge.answer('call_test_unknown', answers, { userId: ALICE })).resolves.toEqual({ ok: false, status: 'not_found' });
  });

  it('reconciles with listQuestions on attach and on reconnect', async () => {
    const transport = new FakeQuestionTransport({ list: true });
    transport.runtimeQuestions = [pendingRecord(Q1, DSH, at)]; // asked before the platform subscribed
    const { asked, settled } = collect(bridge);
    bridge.attachTransport(ALICE, transport);
    await tick();
    expect(asked.map((e) => e.question.id)).toEqual([Q1]);
    expect(bridge.questionsEnabled(ALICE)).toBe(true);
    expect(bridge.questionsEnabled(BOB)).toBeUndefined();

    // The runtime restarted meanwhile: it no longer has the question.
    transport.runtimeQuestions = [];
    transport.emit('connected');
    await tick();
    await tick();
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ outcome: 'unavailable', source: 'reconcile', question: { id: Q1 } });

    // A runtime without questions says so.
    transport.enabled = false;
    await bridge.reconcile(ALICE);
    expect(bridge.questionsEnabled(ALICE)).toBe(false);
  });

  it('isolates tenants: questions belong to the user whose runtime reported them', async () => {
    const alice = new FakeQuestionTransport();
    const bob = new FakeQuestionTransport();
    bridge.attachTransport(ALICE, alice);
    bridge.attachTransport(BOB, bob);
    alice.ask(pendingRecord(Q1, DSH, at));
    bob.ask(pendingRecord(Q1, DSH, at)); // the same id in another user's runtime

    expect(bridge.listPending({ userId: ALICE })).toHaveLength(1);
    expect(bridge.listPending({ userId: BOB })).toHaveLength(1);
    // Bob's DSH session does not map to Alice's route.
    expect(bridge.getPending(Q1, BOB)).toMatchObject({ userId: BOB, sessionId: DSH, routeResolved: false });

    await expect(bridge.answer(Q1, [{ id: 'mode', selected: ['Host'] }], { userId: BOB })).resolves.toMatchObject({ ok: true });
    expect(bob.answers).toHaveLength(1);
    expect(alice.answers).toHaveLength(0);
    expect(bridge.getPending(Q1, ALICE)).toBeDefined();
    await expect(bridge.answer('call_test_question_0099', [], { userId: ALICE })).resolves.toEqual({ ok: false, status: 'not_found' });
  });

  it('keeps questions of sessions without a route, without a route id in the view', () => {
    const transport = new FakeQuestionTransport();
    bridge.attachTransport(ALICE, transport);
    transport.ask(pendingRecord(Q2, SUBAGENT_DSH, at));
    const question = bridge.getPending(Q2, ALICE)!;
    expect(question).toMatchObject({ sessionId: SUBAGENT_DSH, routeResolved: false });
    const view = toPendingQuestionView(question);
    expect(view).toMatchObject({ id: Q2, sessionId: null, status: 'pending', expiresAt: '2026-01-01T00:10:00.000Z' });
    expect(JSON.stringify(view)).not.toContain(SUBAGENT_DSH);
    expect(JSON.stringify(view)).not.toContain(ALICE);
  });

  it('settles questions of a detached runtime as unavailable and ignores malformed pushes', () => {
    const transport = new FakeQuestionTransport();
    bridge.attachTransport(ALICE, transport, { slot: 'runtime:alice' });
    const { asked, settled } = collect(bridge);
    transport.ask({ ...pendingRecord(Q2, DSH, at), questions: [{ question: 'no id' }] });
    expect(asked).toHaveLength(0);
    transport.ask(pendingRecord(Q1, DSH, at));
    bridge.detachTransport(ALICE, { slot: 'runtime:alice' });
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ outcome: 'unavailable', source: 'detached' });
    transport.ask(pendingRecord('call_test_question_0004', DSH, at)); // after detach: ignored
    expect(asked).toHaveLength(1);
    expect(bridge.hasTransport(ALICE)).toBe(false);
  });
});

describe('QuestionBridge with the delivery gateway', () => {
  let db: DatabaseSync;
  let bridge: QuestionBridge;

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    await new PlatformServerMigrationRunner(db).migrate(ALL_PLATFORM_MIGRATIONS);
    bridge = new QuestionBridge({
      resolveRouteId: (userId, dshId) => (userId === ALICE && dshId === DSH ? ROUTE : undefined),
      env: {},
      logger: { warn: () => {} },
    });
  });

  afterEach(() => {
    bridge.dispose();
    db.close();
  });

  it('reports a session waiting for an answer through getCurrentTurnStatus', async () => {
    const gateway = new DeliveryRuntimeGateway({
      storage: {} as any,
      messageStore: {} as any,
      database: db,
      executor: { execute: async () => ({ replyText: 'synthetic' }), cancel: async () => true } as any,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => ({ profileId: 'default' }) } as any,
      questionService: bridge,
    });
    try {
      expect(await gateway.getCurrentTurnStatus(ALICE, ROUTE)).toBeNull();
      const transport = new FakeQuestionTransport();
      bridge.attachTransport(ALICE, transport);
      transport.ask(pendingRecord(Q1, DSH, Date.now()));
      expect(await gateway.getCurrentTurnStatus(ALICE, ROUTE)).toEqual({
        status: 'waiting_approval',
        code: 'WAITING_APPROVAL',
        waitingFor: 'question',
      });
      expect(await gateway.getCurrentTurnStatus(BOB, ROUTE)).toBeNull();
      await bridge.answer(Q1, [], { userId: ALICE });
      expect(await gateway.getCurrentTurnStatus(ALICE, ROUTE)).toBeNull();
    } finally {
      await gateway.close();
    }
  });

  it('keeps a turn alive while its question waits: the per-turn budget fits the default question wait', async () => {
    const storage = new SqlitePlatformStorage({ database: db });
    const spaceId = 'spc_00000000000000000000000000000031';
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'alice', 'hash')`).run(ALICE);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder) VALUES (?, ?, 'Synthetic', 'synthetic')`).run(spaceId, ALICE);
    await storage.forTenant(ALICE).sessionRoutes.create({ id: ROUTE, spaceId, channel: 'web', nativeContextId: ROUTE, dshSessionId: DSH });
    const transport = new FakeQuestionTransport();
    bridge.attachTransport(ALICE, transport);

    const executions: DeliveryExecutionRequest[] = [];
    const cancel = vi.fn(async () => true);
    let answered!: () => void;
    const whenAnswered = new Promise<void>((r) => (answered = r));
    transport.on('stream', (e: any) => {
      if (e.event === 'question/settled') answered();
    });
    const gateway = new DeliveryRuntimeGateway({
      storage,
      messageStore: new SqliteWebMessageStore(db),
      database: db,
      executor: {
        // The runtime asks a question mid-turn and the turn resumes once it is answered.
        execute: async (req: DeliveryExecutionRequest) => {
          executions.push(req);
          transport.ask(pendingRecord(Q1, DSH, Date.now()), req.turnId);
          await whenAnswered;
          return { replyText: 'synthetic reply after the answer', usage: { totalTokens: 1 } };
        },
        cancel,
      },
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null } as any,
      questionService: bridge,
    });
    try {
      await gateway.dispatchInbound({
        id: `deliv_${'0'.repeat(31)}1`,
        userId: ALICE,
        sessionId: ROUTE,
        content: 'synthetic prompt that needs a decision',
        timestamp: new Date().toISOString(),
      } as any);
      const start = Date.now();
      while (bridge.listPending({ userId: ALICE }).length === 0 && Date.now() - start < 3_000) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(await gateway.getCurrentTurnStatus(ALICE, ROUTE)).toMatchObject({ status: 'waiting_approval', waitingFor: 'question' });
      // The hard cap handed to the runtime leaves room for the whole default question wait.
      expect(executions[0]!.timeoutMs).toBe(DEFAULT_INTERACTIVE_TURN_TIMEOUT_MS);
      expect(executions[0]!.timeoutMs!).toBeGreaterThan(DEFAULT_QUESTION_TIMEOUT_MS);

      await new Promise((r) => setTimeout(r, 50));
      expect(cancel).not.toHaveBeenCalled();
      await expect(bridge.answer(Q1, [{ id: 'mode', selected: ['Docker'] }], { userId: ALICE, decidedBy: 'web' })).resolves.toMatchObject({ ok: true });
      await gateway.drain(3_000);
      const turn = db.prepare('SELECT status FROM turn_runs WHERE route_id = ?').get(ROUTE) as { status: string };
      expect(turn.status).toBe('completed');
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      await gateway.close();
    }
  });
});

describe('QuestionBridge behind /api/interactions/questions', () => {
  const csrf = 'test-csrf-token-32-chars-long-secure-12345678!';
  let server: PlatformServer;
  let bridge: QuestionBridge;
  let baseUrl: string;
  let ownerId: string;
  let adminId: string;
  let ownerCookie: string;
  let adminCookie: string;
  let routeId: string;
  let adminRouteId: string;
  const dshSessionId = 'ses_00000000000000000000000000000141';
  const questionId = 'call_test_route_question_01';

  async function login(username: string, password: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': csrf, Origin: baseUrl },
      body: JSON.stringify({ username, password }),
    });
    expect(res.status).toBe(200);
    return res.headers.get('set-cookie')!.split(';')[0]!;
  }

  function answer(cookie: string, id: string, body: unknown, withCsrf = true) {
    return fetch(`${baseUrl}/api/interactions/questions/${encodeURIComponent(id)}/answer`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: baseUrl, ...(withCsrf ? { 'X-Enkeep-CSRF': csrf } : {}) },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    const db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    bridge = new QuestionBridge({ db, env: {}, logger: { warn: () => {} } });
    server = new PlatformServer({
      database: db,
      host: '127.0.0.1',
      port: 0,
      cookieSecret: 'question-bridge-secret-key-32-chars!',
      csrfToken: csrf,
      runtimeGateway: new TestOnlyRuntimeGateway({ storage, messageStore, autoReply: true, autoReplyDelayMs: 10 }),
      questionBridge: bridge,
    });
    baseUrl = (await server.start()).url;
    const fixtures = await provisionFixtures(server.storage, server.authService, {
      adminUsername: 'alice',
      adminPassword: 'AlicePassword123!',
      userPassword: 'BobPassword123!',
      disabledPassword: 'CharlieDisabledPassword123!',
    });
    ownerId = fixtures.user.id;
    adminId = fixtures.admin.id;
    routeId = 'ses_00000000000000000000000000000041';
    adminRouteId = 'ses_00000000000000000000000000000042';
    await server.storage.forTenant(ownerId).sessionRoutes.create({
      id: routeId,
      spaceId: fixtures.userContainerSpace.id,
      channel: 'web',
      nativeContextId: routeId,
      dshSessionId,
    });
    await server.storage.forTenant(adminId).sessionRoutes.create({
      id: adminRouteId,
      spaceId: fixtures.adminContainerSpace.id,
      channel: 'web',
      nativeContextId: adminRouteId,
      dshSessionId: 'ses_00000000000000000000000000000142',
    });
    ownerCookie = await login('bob', 'BobPassword123!');
    adminCookie = await login('alice', 'AlicePassword123!');
  });

  afterEach(async () => {
    bridge.dispose();
    await server.stop();
  });

  it('lists a user\'s pending questions (safe fields only) and answers them with CSRF and a tenant check', async () => {
    expect(server.questionBridge).toBe(bridge);
    const transport = new FakeQuestionTransport();
    bridge.attachTransport(ownerId, transport);
    transport.ask(pendingRecord(questionId, dshSessionId, Date.now()));

    const list = await fetch(`${baseUrl}/api/interactions/questions?sessionId=${routeId}`, { headers: { Cookie: ownerCookie } });
    expect(list.status).toBe(200);
    const data = ((await list.json()) as any).data;
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ id: questionId, sessionId: routeId, callId: questionId, questions: QUESTIONS, status: 'pending', timeoutMs: 600_000 });
    expect(JSON.stringify(data)).not.toContain(dshSessionId);
    expect(JSON.stringify(data)).not.toContain(ownerId);
    expect((((await (await fetch(`${baseUrl}/api/interactions/questions`, { headers: { Cookie: ownerCookie } })).json()) as any).data)).toHaveLength(1);

    // Another tenant (even an admin) sees nothing and cannot answer; another user's session is unknown.
    expect(((await (await fetch(`${baseUrl}/api/interactions/questions`, { headers: { Cookie: adminCookie } })).json()) as any).data).toEqual([]);
    expect((await fetch(`${baseUrl}/api/interactions/questions?sessionId=${routeId}`, { headers: { Cookie: adminCookie } })).status).toBe(404);
    expect(((await (await fetch(`${baseUrl}/api/interactions/questions?sessionId=${adminRouteId}`, { headers: { Cookie: adminCookie } })).json()) as any).data).toEqual([]);
    expect((await answer(adminCookie, questionId, { answers: [] })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/interactions/questions`, {})).status).toBe(401);

    expect((await answer(ownerCookie, questionId, { answers: [] }, false)).status).toBe(403);
    expect((await answer(ownerCookie, questionId, { answers: 'nope' })).status).toBe(400);
    expect((await answer(ownerCookie, questionId, { answers: [{ id: 'mode', selected: ['Kubernetes'] }] })).status).toBe(400);
    expect((await answer(ownerCookie, 'bad/../id', { answers: [] })).status).toBeGreaterThanOrEqual(400);
    expect(transport.answers).toEqual([]);

    const ok = await answer(ownerCookie, questionId, { answers: [{ id: 'mode', selected: ['Host'] }, { id: 'notes', custom: 'synthetic note' }] });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).data).toEqual({ id: questionId, status: 'answered', answered: true });
    expect(transport.answers).toEqual([
      { questionId, answers: [{ id: 'mode', selected: ['Host'] }, { id: 'notes', selected: [], custom: 'synthetic note' }] },
    ]);
    const again = await answer(ownerCookie, questionId, { answers: [] });
    expect(again.status).toBe(409);
    expect(((await (await fetch(`${baseUrl}/api/interactions/questions`, { headers: { Cookie: ownerCookie } })).json()) as any).data).toEqual([]);
  });

  it('refuses an answer to an expired question with 409', async () => {
    const transport = new FakeQuestionTransport();
    bridge.attachTransport(ownerId, transport);
    transport.ask(pendingRecord(questionId, dshSessionId, Date.now()));
    transport.answerError = daemonError('question/expired', { questionId });
    const res = await answer(ownerCookie, questionId, { answers: [{ id: 'mode', selected: ['Docker'] }] });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe('QUESTION_EXPIRED');
  });
});
