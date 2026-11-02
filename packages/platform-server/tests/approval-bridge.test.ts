import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { provisionFixtures } from '@enkeep/platform-auth';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  ApprovalBridge,
  type ApprovalAskedEvent,
  type ApprovalSettledEvent,
} from '../src/interactions/approval-bridge.js';
import { PlatformServerMigrationRunner, ALL_PLATFORM_MIGRATIONS } from '../src/storage/migrations.js';
import { DeliveryRuntimeGateway } from '../src/runtime/delivery-gateway.js';
import { PlatformServer, SqliteWebMessageStore } from '../src/index.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

/** In-memory stand-in for a user's DaemonTransport: emits daemon `stream` events. */
class FakeRuntimeTransport extends EventEmitter {
  readonly answers: Array<{ sessionId: string; approvalId: string; decision: string }> = [];
  /** Approvals the fake runtime reports from `listApprovals` (undefined = op not supported). */
  runtimeApprovals?: Array<Record<string, unknown>>;
  /** Whether the runtime still had the approval pending when answered. */
  answerResult = true;
  /** Emit the runtime `approval/decided` when answered (like the real daemon). */
  emitDecidedOnAnswer = true;
  failAnswers = false;

  constructor(options: { listApprovals?: boolean } = {}) {
    super();
    if (options.listApprovals) this.runtimeApprovals = [];
    if (!options.listApprovals) (this as any).listApprovals = undefined;
  }

  async answerApproval(sessionId: string, approvalId: string, decision: string) {
    if (this.failAnswers) throw new Error('daemon disconnected');
    this.answers.push({ sessionId, approvalId, decision });
    if (this.runtimeApprovals) this.runtimeApprovals = this.runtimeApprovals.filter((a) => a.id !== approvalId);
    if (this.answerResult && this.emitDecidedOnAnswer) {
      // The daemon appends approval/decided after the answer resolves the in-container wait.
      setImmediate(() => this.decided(sessionId, approvalId, decision));
    }
    return { id: 'req_test', op: 'answerApproval', ok: true, answered: this.answerResult, approvalId };
  }

  async listApprovals(_sessionId: string) {
    return { id: 'req_test', op: 'listApprovals', ok: true, approvals: this.runtimeApprovals ?? [] };
  }

  /** Emits the frames the daemon pushes for one ask: `turn/event` audit, then `approval/asked`. */
  ask(options: { dshSessionId: string; id: string; toolName: string; callId?: string; reason?: string; turnId?: string; at?: number }) {
    const timestamp = options.at ?? Date.now();
    this.emit('stream', {
      type: 'event',
      event: 'turn/event',
      sessionId: options.dshSessionId,
      turnId: options.turnId ?? 'turn_test_0001',
      seq: 7,
      timestamp,
      sessionEvent: {
        type: 'approval/asked',
        seq: 7,
        time: timestamp,
        data: {
          id: options.id,
          toolName: options.toolName,
          ...(options.callId ? { callId: options.callId } : {}),
          ...(options.reason ? { reason: options.reason } : {}),
        },
      },
    });
    this.emit('stream', {
      type: 'event',
      event: 'approval/asked',
      sessionId: options.dshSessionId,
      turnId: options.turnId ?? 'turn_test_0001',
      timestamp,
      approval: { id: options.id, toolName: options.toolName, risk: 'medium', safeSummary: 'Approval requested' },
    });
  }

  decided(dshSessionId: string, id: string, outcome: string) {
    this.emit('stream', {
      type: 'event',
      event: 'approval/decided',
      sessionId: dshSessionId,
      turnId: 'turn_test_0001',
      timestamp: Date.now(),
      decision: { id, outcome },
    });
  }
}

const tick = () => new Promise((r) => setImmediate(r));

function collect(bridge: ApprovalBridge) {
  const asked: ApprovalAskedEvent[] = [];
  const settled: ApprovalSettledEvent[] = [];
  bridge.on('asked', (e) => asked.push(e));
  bridge.on('settled', (e) => settled.push(e));
  return { asked, settled };
}

describe('ApprovalBridge', () => {
  const alice = 'user-alice';
  const bob = 'user-bob';
  const routeId = 'ses_00000000000000000000000000000001';
  const dshSessionId = 'ses_00000000000000000000000000000101';
  const approvalId = '00000000-0000-4000-8000-000000000001';
  let bridge: ApprovalBridge;

  beforeEach(() => {
    bridge = new ApprovalBridge({
      resolveRouteId: (userId, dshId) => (userId === alice && dshId === dshSessionId ? routeId : undefined),
      env: {},
      logger: { warn: () => {} },
    });
  });

  afterEach(() => {
    bridge.dispose();
  });

  it('emits one asked event per runtime approval with route id, call details and expiry', async () => {
    const at = Date.parse('2026-01-01T00:00:00.000Z');
    bridge.dispose();
    bridge = new ApprovalBridge({
      resolveRouteId: (userId, dshId) => (userId === alice && dshId === dshSessionId ? routeId : undefined),
      env: {},
      now: () => at + 1_000,
      logger: { warn: () => {} },
    });
    const transport = new FakeRuntimeTransport();
    bridge.attachTransport(alice, transport);
    const { asked } = collect(bridge);

    transport.ask({ dshSessionId, id: approvalId, toolName: 'bash', callId: 'call_test_0001', reason: 'Run the test suite', at });
    await tick();

    expect(asked).toHaveLength(1);
    expect(asked[0].approval).toEqual({
      id: approvalId,
      userId: alice,
      sessionId: routeId,
      dshSessionId,
      routeResolved: true,
      turnId: 'turn_test_0001',
      toolName: 'bash',
      callId: 'call_test_0001',
      reason: 'Run the test suite',
      risk: 'high',
      safeSummary: 'Run the test suite',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:01:00.000Z',
      timeoutMs: 60_000,
    });
    expect(bridge.getApprovalTimeoutMs()).toBe(60_000);

    // Route compatibility (IExternalInteractionService)
    const views = bridge.listPendingApprovals({ userId: alice, sessionId: routeId, status: 'pending' });
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ id: approvalId, sessionId: routeId, status: 'pending', risk: 'high', expiresAt: '2026-01-01T00:01:00.000Z' });
    expect(views[0]).not.toHaveProperty('dshSessionId');
    expect(bridge.listPendingApprovals({ userId: bob })).toHaveLength(0);
    expect(bridge.listPendingApprovals({ status: 'expired' })).toHaveLength(0);
  });

  it('answers through the transport; first answer wins and every channel learns the outcome', async () => {
    const transport = new FakeRuntimeTransport();
    bridge.attachTransport(alice, transport);
    const { settled } = collect(bridge);
    transport.ask({ dshSessionId, id: approvalId, toolName: 'write' });
    await tick();

    const first = bridge.decide(approvalId, 'allowed-once', { userId: alice, decidedBy: 'jarvis' });
    const concurrent = await bridge.decide(approvalId, 'rejected', { userId: alice, decidedBy: 'web' });
    expect(concurrent).toEqual({ ok: false, status: 'already_answering', outcome: 'allowed-once' });
    await expect(first).resolves.toEqual({ ok: true, status: 'answered', outcome: 'allowed-once' });

    expect(transport.answers).toEqual([{ sessionId: dshSessionId, approvalId, decision: 'allowed-once' }]);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ outcome: 'allowed-once', source: 'answer', decidedBy: 'jarvis' });
    expect(bridge.listPending()).toHaveLength(0);

    await expect(bridge.decide(approvalId, 'rejected', { userId: alice })).resolves.toEqual({
      ok: false,
      status: 'already_settled',
      outcome: 'allowed-once',
    });
    // Same answer again is idempotent for the sync route API.
    expect(bridge.answerApproval(approvalId, 'allowed-once')).toBe(true);
    expect(bridge.getPendingApproval(approvalId)).toMatchObject({ status: 'allowed-once', decisionOutcome: 'allowed-once' });
  });

  it('settles approvals decided in the runtime and maps runtime timeouts to expired', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    bridge.dispose();
    bridge = new ApprovalBridge({ env: {}, now: () => now, logger: { warn: () => {} } });
    const transport = new FakeRuntimeTransport();
    bridge.attachTransport(alice, transport);
    const { settled } = collect(bridge);

    transport.ask({ dshSessionId, id: approvalId, toolName: 'edit', at: now });
    transport.ask({ dshSessionId, id: '00000000-0000-4000-8000-000000000002', toolName: 'edit', at: now });
    await tick();
    // Unmapped DSH session: the approval keeps the DSH id and says so.
    expect(bridge.getPending(approvalId)).toMatchObject({ sessionId: dshSessionId, routeResolved: false });

    transport.decided(dshSessionId, approvalId, 'rejected');
    now += 60_000;
    transport.decided(dshSessionId, '00000000-0000-4000-8000-000000000002', 'unavailable');

    expect(settled.map((e) => [e.outcome, e.source])).toEqual([
      ['rejected', 'runtime'],
      ['expired', 'runtime'],
    ]);
  });

  it('cancel rejects in the runtime and settles as cancelled', async () => {
    const transport = new FakeRuntimeTransport();
    bridge.attachTransport(alice, transport);
    const { settled } = collect(bridge);
    transport.ask({ dshSessionId, id: approvalId, toolName: 'bash' });
    await tick();

    expect(bridge.cancelApproval(approvalId)).toBe(true);
    await vi.waitFor(() => expect(settled).toHaveLength(1));
    expect(transport.answers[0].decision).toBe('rejected');
    expect(settled[0]).toMatchObject({ outcome: 'cancelled', source: 'answer' });
  });

  it('keeps tenants apart', async () => {
    const aliceTransport = new FakeRuntimeTransport();
    const bobTransport = new FakeRuntimeTransport();
    bridge.attachTransport(alice, aliceTransport);
    bridge.attachTransport(bob, bobTransport);
    aliceTransport.ask({ dshSessionId, id: approvalId, toolName: 'bash' });
    await tick();

    // Bob's runtime cannot settle or re-own Alice's approval.
    bobTransport.decided(dshSessionId, approvalId, 'allowed-once');
    bobTransport.ask({ dshSessionId, id: approvalId, toolName: 'read' });
    await tick();
    expect(bridge.getPending(approvalId)).toMatchObject({ userId: alice, toolName: 'bash' });

    await expect(bridge.decide(approvalId, 'allowed-once', { userId: bob })).resolves.toEqual({ ok: false, status: 'not_found' });
    expect(bobTransport.answers).toHaveLength(0);
    expect(aliceTransport.answers).toHaveLength(0);
  });

  it('uses the runtime approval list for authoritative expiry and backfills on attach', async () => {
    const transport = new FakeRuntimeTransport({ listApprovals: true });
    const createdAt = '2026-01-01T00:00:00.000Z';
    // Approval already pending in the runtime before the platform subscribed (platform restart).
    transport.runtimeApprovals = [
      {
        id: approvalId,
        sessionId: dshSessionId,
        userId: 'container-user',
        toolName: 'bash',
        callId: 'call_test_0002',
        risk: 'high',
        safeSummary: 'Execute shell command in space workspace',
        createdAt,
        timeoutMs: 600_000,
        status: 'pending',
      },
    ];
    const { asked } = collect(bridge);
    bridge.attachTransport(alice, transport);
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0].approval).toMatchObject({
      id: approvalId,
      userId: alice,
      sessionId: routeId,
      callId: 'call_test_0002',
      timeoutMs: 600_000,
      expiresAt: '2026-01-01T00:10:00.000Z',
    });

    // A new ask is announced after enrichment with the runtime's own timeout.
    const secondId = '00000000-0000-4000-8000-000000000003';
    transport.runtimeApprovals.push({
      id: secondId,
      sessionId: dshSessionId,
      toolName: 'write',
      risk: 'medium',
      safeSummary: 'Write or replace file in space workspace',
      createdAt,
      timeoutMs: 600_000,
      status: 'pending',
    });
    transport.ask({ dshSessionId, id: secondId, toolName: 'write', at: Date.parse(createdAt) });
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[1].approval).toMatchObject({ id: secondId, timeoutMs: 600_000, expiresAt: '2026-01-01T00:10:00.000Z' });
  });

  it('settles approvals the runtime lost after a reconnect, and on detach', async () => {
    const transport = new FakeRuntimeTransport({ listApprovals: true });
    bridge.attachTransport(alice, transport);
    const { asked, settled } = collect(bridge);
    transport.runtimeApprovals!.push({ id: approvalId, sessionId: dshSessionId, toolName: 'bash', status: 'pending' });
    transport.ask({ dshSessionId, id: approvalId, toolName: 'bash' });
    await vi.waitFor(() => expect(asked).toHaveLength(1));

    // Container restarted: its new daemon no longer has the approval.
    transport.runtimeApprovals = [];
    transport.emit('connected');
    await vi.waitFor(() => expect(settled).toHaveLength(1));
    expect(settled[0]).toMatchObject({ outcome: 'unavailable', source: 'reconcile' });

    const other = new FakeRuntimeTransport();
    bridge.attachTransport(bob, other);
    other.ask({ dshSessionId: 'ses_00000000000000000000000000000202', id: '00000000-0000-4000-8000-000000000004', toolName: 'bash' });
    await tick();
    bridge.detachTransport(bob);
    expect(settled.at(-1)).toMatchObject({ outcome: 'unavailable', source: 'detached' });
    expect(other.listenerCount('stream')).toBe(0);
  });

  it('keeps several runtimes of one user apart (container and host slots)', async () => {
    const container = new FakeRuntimeTransport();
    const host = new FakeRuntimeTransport();
    bridge.attachTransport(alice, container, { slot: 'runtime-container' });
    bridge.attachTransport(alice, host, { slot: 'runtime-host' });
    const { settled } = collect(bridge);
    container.ask({ dshSessionId, id: approvalId, toolName: 'bash' });
    host.ask({ dshSessionId: 'ses_00000000000000000000000000000102', id: '00000000-0000-4000-8000-000000000005', toolName: 'edit' });
    await tick();
    expect(bridge.listPending({ userId: alice })).toHaveLength(2);

    await bridge.decide('00000000-0000-4000-8000-000000000005', 'rejected');
    expect(host.answers).toHaveLength(1);
    expect(container.answers).toHaveLength(0);

    // Restarting the container slot replaces only that transport.
    const restarted = new FakeRuntimeTransport();
    bridge.attachTransport(alice, restarted, { slot: 'runtime-container' });
    expect(container.listenerCount('stream')).toBe(0);
    expect(host.listenerCount('stream')).toBe(1);
    await bridge.decide(approvalId, 'allowed-once');
    expect(restarted.answers).toEqual([{ sessionId: dshSessionId, approvalId, decision: 'allowed-once' }]);

    bridge.detachTransport(alice, { slot: 'runtime-host' });
    expect(bridge.hasTransport(alice, 'runtime-host')).toBe(false);
    expect(bridge.hasTransport(alice, 'runtime-container')).toBe(true);
    expect(settled.map((e) => e.outcome)).toEqual(['rejected', 'allowed-once']);
  });

  it('expires approvals locally when the runtime never reports a decision', async () => {
    vi.useFakeTimers();
    try {
      bridge.dispose();
      bridge = new ApprovalBridge({ env: { ENKEEP_APPROVAL_TIMEOUT_MS: '600000' }, expiryGraceMs: 1_000, logger: { warn: () => {} } });
      expect(bridge.getApprovalTimeoutMs()).toBe(600_000);
      const transport = new FakeRuntimeTransport();
      bridge.attachTransport(alice, transport);
      const { asked, settled } = collect(bridge);
      transport.ask({ dshSessionId, id: approvalId, toolName: 'bash' });
      await vi.advanceTimersByTimeAsync(10);
      expect(asked).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(settled).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({ outcome: 'expired', source: 'expiry' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reverts a failed answer so the approval can be answered again', async () => {
    const transport = new FakeRuntimeTransport();
    bridge.attachTransport(alice, transport);
    transport.ask({ dshSessionId, id: approvalId, toolName: 'bash' });
    await tick();
    transport.failAnswers = true;
    await expect(bridge.decide(approvalId, 'allowed-once')).resolves.toEqual({ ok: false, status: 'failed' });
    expect(bridge.getPending(approvalId)).toBeDefined();
    transport.failAnswers = false;
    await expect(bridge.decide(approvalId, 'rejected')).resolves.toMatchObject({ ok: true, status: 'answered' });
  });

  it('reports waiting_approval through getCurrentTurnStatus by platform route id', async () => {
    const db = new DatabaseSync(':memory:');
    await new PlatformServerMigrationRunner(db).migrate(ALL_PLATFORM_MIGRATIONS);
    const gateway = new DeliveryRuntimeGateway({
      storage: {} as any,
      messageStore: {} as any,
      database: db,
      executor: { execute: async () => ({ replyText: 'synthetic' }), cancel: async () => true } as any,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => ({ profileId: 'default' }) } as any,
      externalInteractionService: bridge,
    });
    expect(await gateway.getCurrentTurnStatus(alice, routeId)).toBeNull();

    const transport = new FakeRuntimeTransport();
    bridge.attachTransport(alice, transport);
    transport.ask({ dshSessionId, id: approvalId, toolName: 'bash' });
    await tick();
    expect(await gateway.getCurrentTurnStatus(alice, routeId)).toEqual({ status: 'waiting_approval', code: 'WAITING_APPROVAL' });
    expect(await gateway.getCurrentTurnStatus(bob, routeId)).toBeNull();
    db.close();
  });
});

describe('ApprovalBridge behind /api/interactions/approvals', () => {
  const csrf = 'test-csrf-token-32-chars-long-secure-12345678!';
  let server: PlatformServer;
  let bridge: ApprovalBridge;
  let baseUrl: string;
  let ownerId: string;
  let ownerCookie: string;
  let adminCookie: string;
  let routeId: string;
  const dshSessionId = 'ses_00000000000000000000000000000111';

  async function login(username: string, password: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': csrf, Origin: baseUrl },
      body: JSON.stringify({ username, password }),
    });
    expect(res.status).toBe(200);
    return res.headers.get('set-cookie')!.split(';')[0];
  }

  beforeEach(async () => {
    const db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    bridge = new ApprovalBridge({ db, env: {}, logger: { warn: () => {} } });
    server = new PlatformServer({
      database: db,
      host: '127.0.0.1',
      port: 0,
      cookieSecret: 'approval-bridge-secret-key-32-chars!',
      csrfToken: csrf,
      runtimeGateway: new TestOnlyRuntimeGateway({ storage, messageStore, autoReply: true, autoReplyDelayMs: 10 }),
      approvalBridge: bridge,
    });
    baseUrl = (await server.start()).url;
    const fixtures = await provisionFixtures(server.storage, server.authService, {
      adminUsername: 'alice',
      adminPassword: 'AlicePassword123!',
      userPassword: 'BobPassword123!',
      disabledPassword: 'CharlieDisabledPassword123!',
    });
    // The fixture's regular user ("bob") owns the session and the approval; "alice" is the admin.
    ownerId = fixtures.user.id;
    routeId = 'ses_00000000000000000000000000000011';
    await server.storage.forTenant(ownerId).sessionRoutes.create({
      id: routeId,
      spaceId: fixtures.userContainerSpace.id,
      channel: 'web',
      nativeContextId: routeId,
      dshSessionId,
    });
    ownerCookie = await login('bob', 'BobPassword123!');
    adminCookie = await login('alice', 'AlicePassword123!');
  });

  afterEach(async () => {
    bridge.dispose();
    await server.stop();
  });

  it('serves runtime approvals to their owner and answers them through the runtime transport', async () => {
    expect(server.approvalBridge).toBe(bridge);
    expect(server.externalInteractionService).toBe(bridge);

    const transport = new FakeRuntimeTransport();
    bridge.attachTransport(ownerId, transport);
    transport.ask({ dshSessionId, id: '00000000-0000-4000-8000-000000000011', toolName: 'bash', reason: 'Run the build' });
    await tick();

    const ownerList = await fetch(`${baseUrl}/api/interactions/approvals?sessionId=${routeId}`, { headers: { Cookie: ownerCookie } });
    expect(ownerList.status).toBe(200);
    const ownerData = (await ownerList.json()) as any;
    expect(ownerData.data).toHaveLength(1);
    expect(ownerData.data[0]).toMatchObject({
      id: '00000000-0000-4000-8000-000000000011',
      sessionId: routeId,
      toolName: 'bash',
      risk: 'high',
      safeSummary: 'Run the build',
      status: 'pending',
    });
    expect(typeof ownerData.data[0].expiresAt).toBe('string');

    // The admin sees every user's approvals (existing route behavior).
    const adminList = (await (await fetch(`${baseUrl}/api/interactions/approvals`, { headers: { Cookie: adminCookie } })).json()) as any;
    expect(adminList.data).toHaveLength(1);

    const decide = await fetch(`${baseUrl}/api/interactions/approvals/00000000-0000-4000-8000-000000000011/decide`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json', 'X-Enkeep-CSRF': csrf, Origin: baseUrl },
      body: JSON.stringify({ outcome: 'allowed-once' }),
    });
    expect(decide.status).toBe(200);
    const decideData = (await decide.json()) as any;
    expect(decideData.data).toEqual({ id: '00000000-0000-4000-8000-000000000011', status: 'allowed-once', decided: true });
    expect(transport.answers).toEqual([
      { sessionId: dshSessionId, approvalId: '00000000-0000-4000-8000-000000000011', decision: 'allowed-once' },
    ]);

    const after = (await (await fetch(`${baseUrl}/api/interactions/approvals`, { headers: { Cookie: ownerCookie } })).json()) as any;
    expect(after.data).toHaveLength(0);
  });
});
