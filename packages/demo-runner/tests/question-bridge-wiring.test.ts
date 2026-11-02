/**
 * launchDemoSystem wires the platform QuestionBridge (ask_user_question): every bound runtime
 * transport is attached (same slot as the approval bridge), /api/interactions/questions serves
 * and answers the questions, the turn status reports the wait, and the per-user `userQuestions`
 * runtime option is set only for users with an active Jarvis account. Offline: fake runtime
 * adapter + fake daemon transport, platform on an ephemeral 127.0.0.1 port.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  DEFAULT_EXECUTION_BUDGET_MS,
  applyInteractionWait,
  calculateTurnBudgets,
  refreshWaiterIdleTimer,
  type TurnWatchdogWaiter,
} from '@enkeep/runtime-runner';
import { DEFAULT_QUESTION_TIMEOUT_MS } from '@enkeep/dsh-external-interaction/user-questions';
import { resetDemo } from '../src/reset/index.js';
import { launchDemoSystem, type RunningDemoSystem } from '../src/up/index.js';
import type { UserRuntimeHandle } from '../src/ports/index.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';
import { FakeUnitRuntimeContainerAdapter } from './support/fake-runtime.js';

const ROUTE = 'ses_000000000000000000000000000000e1';
const DSH = 'ses_000000000000000000000000000000f1';
const QUESTION_ID = 'call_test_demo_question_01';

class FakeDaemonTransport extends EventEmitter {
  readonly answers: Array<{ questionId: string; answers: unknown }> = [];
  isConnected(): boolean {
    return true;
  }
  async listQuestions() {
    return { enabled: true, questions: [] };
  }
  async answerQuestion(questionId: string, answers: unknown) {
    this.answers.push({ questionId, answers });
    return { questionId, answered: true, answers };
  }
}

/** Fake adapter recording the start options of every runtime it creates. */
class QuestionFakeAdapter extends FakeUnitRuntimeContainerAdapter {
  readonly transports = new Map<string, FakeDaemonTransport>();
  readonly starts: Array<{ userId: string; userQuestions?: boolean; hasOption: boolean }> = [];

  override async startUserRuntime(options: Parameters<FakeUnitRuntimeContainerAdapter['startUserRuntime']>[0] & { userQuestions?: boolean }): Promise<UserRuntimeHandle> {
    this.starts.push({ userId: options.userId, userQuestions: options.userQuestions, hasOption: 'userQuestions' in options && options.userQuestions !== undefined });
    const handle = await super.startUserRuntime(options);
    const transport = new FakeDaemonTransport();
    this.transports.set(options.userId, transport);
    (handle as any).rawHandle = { transport };
    return handle;
  }
}

async function login(serverUrl: string, username: string, password: string) {
  const init = (await (await fetch(`${serverUrl}/api/auth/csrf`, { headers: { Origin: serverUrl } })).json()) as any;
  const res = await fetch(`${serverUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': init.data.csrfToken, Origin: serverUrl },
    body: JSON.stringify({ username, password }),
  });
  expect(res.ok).toBe(true);
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  const csrf = (await (await fetch(`${serverUrl}/api/auth/csrf`, { headers: { Cookie: cookie, Origin: serverUrl } })).json()) as any;
  return { cookie, csrfToken: csrf.data.csrfToken as string };
}

describe('launchDemoSystem question bridge wiring', () => {
  let tempRepo: TempRepo;
  let system: RunningDemoSystem | null = null;

  beforeEach(() => {
    tempRepo = createTempRepo();
  });

  afterEach(async () => {
    if (system) {
      await system.close({ removeVolumes: true });
      system = null;
    }
    tempRepo.cleanup();
  });

  it('serves runtime questions, reports the wait and answers through the runtime transport', async () => {
    const reset = await resetDemo({ repoRoot: tempRepo.repoRoot });
    const adapter = new QuestionFakeAdapter();
    system = await launchDemoSystem({ repoRoot: tempRepo.repoRoot, runtimeAdapter: adapter });

    expect(system.questionBridge).toBeDefined();
    expect(system.platformServer.questionBridge).toBe(system.questionBridge);
    const bob = (await system.storage.users.findByUsername(reset.credentials.user.username))!;
    const bobHandle = system.runtimeHandles.get(bob.id)!;
    const transport = adapter.transports.get(bobHandle.userId)!;
    expect(system.questionBridge.hasTransport(bob.id, `runtime:${bobHandle.userId}`)).toBe(true);

    const spaces = await system.storage.forTenant(bob.id).spaces.list();
    await system.storage.forTenant(bob.id).sessionRoutes.create({ id: ROUTE, spaceId: spaces[0]!.id, channel: 'web', nativeContextId: ROUTE, dshSessionId: DSH });
    const now = Date.now();
    transport.emit('stream', {
      type: 'event',
      event: 'question/asked',
      sessionId: DSH,
      turnId: 'turn_test_demo_0001',
      timestamp: now,
      question: {
        id: QUESTION_ID,
        sessionId: DSH,
        callId: QUESTION_ID,
        sessionSource: 'web',
        questions: [{ id: 'mode', question: 'Which synthetic mode?', options: [{ label: 'Docker' }, { label: 'Host' }], multiSelect: false }],
        createdAt: new Date(now).toISOString(),
        timeoutMs: 600_000,
        expiresAt: new Date(now + 600_000).toISOString(),
        status: 'pending',
      },
    });

    const auth = await login(system.platformUrl, reset.credentials.user.username, reset.credentials.user.password);
    const list = (await (await fetch(`${system.platformUrl}/api/interactions/questions?sessionId=${ROUTE}`, { headers: { Cookie: auth.cookie } })).json()) as any;
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({ id: QUESTION_ID, sessionId: ROUTE, status: 'pending' });

    const status = (await (await fetch(`${system.platformUrl}/api/sessions/${ROUTE}/turn/current`, { headers: { Cookie: auth.cookie } })).json()) as any;
    expect(status.data).toMatchObject({ status: 'waiting_approval', waitingFor: 'question' });

    const answered = await fetch(`${system.platformUrl}/api/interactions/questions/${QUESTION_ID}/answer`, {
      method: 'POST',
      headers: { Cookie: auth.cookie, 'Content-Type': 'application/json', 'X-Enkeep-CSRF': auth.csrfToken, Origin: system.platformUrl },
      body: JSON.stringify({ answers: [{ id: 'mode', selected: ['Docker'] }] }),
    });
    expect(answered.status).toBe(200);
    expect(transport.answers).toEqual([{ questionId: QUESTION_ID, answers: [{ id: 'mode', selected: ['Docker'] }] }]);
    expect(system.questionBridge.listPending({ userId: bob.id })).toEqual([]);
  });

  it('offers ask_user_question (userQuestions: true) only to users with an active Jarvis account, from the next runtime start', async () => {
    const reset = await resetDemo({ repoRoot: tempRepo.repoRoot });
    const adapter = new QuestionFakeAdapter();
    system = await launchDemoSystem({ repoRoot: tempRepo.repoRoot, runtimeAdapter: adapter });

    // Boot: nobody has a Jarvis account, the option stays unset (the process-wide switch applies).
    expect(adapter.starts.length).toBeGreaterThan(0);
    expect(adapter.starts.every((s) => !s.hasOption)).toBe(true);

    const admin = (await system.storage.users.findByUsername(reset.credentials.admin.username))!;
    const bob = (await system.storage.users.findByUsername(reset.credentials.user.username))!;
    const adminIdentity = system.runtimeHandles.get(admin.id)!.userId;
    const bobIdentity = system.runtimeHandles.get(bob.id)!.userId;
    const auth = await login(system.platformUrl, reset.credentials.admin.username, reset.credentials.admin.password);
    const created = await fetch(`${system.platformUrl}/api/manage/channels/accounts`, {
      method: 'POST',
      headers: { Cookie: auth.cookie, 'Content-Type': 'application/json', 'X-Enkeep-CSRF': auth.csrfToken, Origin: system.platformUrl },
      body: JSON.stringify({ type: 'jarvis' }),
    });
    expect(created.status).toBe(201);
    const accountId = ((await created.json()) as any).data.id as string;
    // No forced restart: nothing started because of the new account.
    const startsBefore = adapter.starts.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(adapter.starts.length).toBe(startsBefore);

    // The next (re)creation of each runtime decides.
    await system.restartRuntime(admin.id);
    await system.restartRuntime(bob.id);
    const adminStart = adapter.starts.slice(startsBefore).find((s) => s.userId === adminIdentity);
    const bobStart = adapter.starts.slice(startsBefore).find((s) => s.userId === bobIdentity);
    expect(adminStart).toMatchObject({ userQuestions: true });
    expect(bobStart).toMatchObject({ hasOption: false });

    // A disabled account no longer counts.
    await system.storage.forTenant(admin.id).channels.updateAccount(accountId, { status: 'disabled' });
    const startsAfterDisable = adapter.starts.length;
    await system.restartRuntime(admin.id);
    expect(adapter.starts.slice(startsAfterDisable).find((s) => s.userId === adminIdentity)).toMatchObject({ hasOption: false });
  });
});

describe('turn budgets around a waiting question (runtime transport watchdog)', () => {
  it('the per-turn hard cap leaves room for the default question wait', () => {
    const budgets = calculateTurnBudgets({ timeoutMs: DEFAULT_EXECUTION_BUDGET_MS }, {});
    expect(budgets.clientWaitTimeoutMs).toBeGreaterThan(DEFAULT_QUESTION_TIMEOUT_MS);
    expect(budgets.idleTimeoutMs).toBeGreaterThan(DEFAULT_QUESTION_TIMEOUT_MS);
  });

  it('pauses the idle watchdog while a question waits, like an approval, and resumes when it settles', () => {
    let idleFired = 0;
    const waiter: TurnWatchdogWaiter = {
      turnId: 'turn_test_budget_0001',
      sessionId: 'ses_000000000000000000000000000000a9',
      resolve: () => {},
      reject: () => {},
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      idleTimeoutMs: 60_000,
      rawTimeoutMs: 60_000,
      pendingApprovals: new Set<string>(),
    };
    const refresh = () => refreshWaiterIdleTimer(waiter, () => idleFired++);
    refresh();
    expect(waiter.idleTimer).toBeDefined();
    const asked = { type: 'event', event: 'question/asked', sessionId: waiter.sessionId, turnId: waiter.turnId, timestamp: Date.now(), question: { id: 'call_test_budget_q1' } };
    expect(applyInteractionWait(waiter, asked, refresh)).toBe('paused');
    expect(waiter.idleTimer).toBeUndefined();
    // Progress frames while the question waits do not re-arm the idle timer.
    refresh();
    expect(waiter.idleTimer).toBeUndefined();
    const settled = { type: 'event', event: 'question/settled', sessionId: waiter.sessionId, turnId: waiter.turnId, timestamp: Date.now(), id: 'call_test_budget_q1', outcome: 'answered' };
    expect(applyInteractionWait(waiter, settled, refresh)).toBe('resumed');
    expect(waiter.idleTimer).toBeDefined();
    clearTimeout(waiter.idleTimer);
    expect(idleFired).toBe(0);
  });
});
