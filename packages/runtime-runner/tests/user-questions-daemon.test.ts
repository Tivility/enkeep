/**
 * `ask_user_question` end to end in a real DSH boot (temp DSH_HOME, deterministic demo model):
 * the ENKEEP_USER_QUESTIONS gate, the `question/asked` / `question/settled` pushes, the
 * `listQuestions` / `answerQuestion` ops through the host-mode UDS transport, the model seeing
 * the answer, the idle watchdog pausing while a question waits, cancellation, and expiry.
 * Synthetic users, sessions and paths only.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { RuntimeDaemon } from '../src/runtime/daemon.js';
import {
  DaemonRpcDecoder,
  DaemonRpcEncoder,
  QUESTION_ERROR_CODES,
  type DaemonRequest,
  type DaemonStreamEvent,
  type DaemonStreamQuestionAskedEvent,
  type DaemonStreamQuestionSettledEvent,
} from '../src/runtime/daemon-protocol.js';
import { HostDaemonTransport } from '../src/host/transport.js';
import type { HostQuestionEvent } from '../src/transport/questions-client.js';
import { applyInteractionWait, isGenuineTurnProgress } from '../src/transport/timer-helper.js';

const GATE = 'ENKEEP_USER_QUESTIONS';
const TIMEOUT = 'ENKEEP_QUESTION_TIMEOUT_MS';
const SPACE = 'space-questions';

const QUESTION_ARGS = {
  questions: [
    {
      id: 'mode',
      question: 'Which deployment mode should the synthetic service use?',
      header: 'Mode',
      options: [{ label: 'Docker', description: 'Isolated and reproducible.' }, { label: 'Host' }],
    },
    {
      id: 'extras',
      question: 'Which extras?',
      options: [{ label: 'Metrics' }, { label: 'Tracing' }],
      multi_select: true,
    },
    { id: 'notes', question: 'Anything else to know?' },
  ],
};
const ASK_PROMPT = `Ask before deploying. [enkeep-test-tool-call=ask_user_question:${JSON.stringify(QUESTION_ARGS)}]`;

function sid(n: number): string {
  return `ses_${n.toString(16).padStart(32, '0')}`;
}
function tid(n: number): string {
  return `turn_${n.toString(16).padStart(32, '0')}`;
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface Harness {
  tmpDir: string;
  daemon: RuntimeDaemon;
  streamed: DaemonStreamEvent[];
  close(): Promise<void>;
}

async function bootDaemon(env: Record<string, string | undefined>): Promise<Harness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ek-q-'));
  const dshHome = path.join(tmpDir, 'alice', '.dsh');
  const spacesDir = path.join(tmpDir, 'alice', 'spaces');
  fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(spacesDir, SPACE), { recursive: true, mode: 0o700 });
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  const daemon = new RuntimeDaemon({ userId: 'alice', dshHome, spacesDir });
  try {
    await daemon.start();
  } finally {
    vi.unstubAllEnvs();
  }
  const streamed: DaemonStreamEvent[] = [];
  daemon.on('stream', (event: DaemonStreamEvent) => streamed.push(event));
  return {
    tmpDir,
    daemon,
    streamed,
    async close() {
      await daemon.shutdown();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function toolsOf(daemon: RuntimeDaemon): { get(name: string): unknown } {
  const ctx = (daemon as any).bootedRuntime.context;
  return ctx.tools ?? ctx.get('tools');
}

describe('ask_user_question without ENKEEP_USER_QUESTIONS', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await bootDaemon({ [GATE]: undefined, [TIMEOUT]: undefined });
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  it('composes neither the tool nor the service, and the ops say so', async () => {
    expect(toolsOf(h.daemon).get('ask_user_question')).toBeUndefined();
    const ctx = (h.daemon as any).bootedRuntime.context;
    expect(ctx.get('userQuestions')).toBeUndefined();
    expect(ctx.get('externalInteraction')).toBeDefined();

    const list: any = await h.daemon.handleRequest({ id: 'l1', op: 'listQuestions' } as DaemonRequest);
    expect(list).toMatchObject({ ok: true, enabled: false, questions: [] });
    const answer: any = await h.daemon.handleRequest({
      id: 'a1',
      op: 'answerQuestion',
      questionId: 'call_synthetic',
      answers: [],
    } as DaemonRequest);
    expect(answer).toMatchObject({ ok: false, error: { code: QUESTION_ERROR_CODES.UNAVAILABLE } });

    // The model calling it anyway gets an unknown-tool result; no question is held.
    const res = await h.daemon.submitTurnAndWait({
      id: 's1',
      op: 'submitTurn',
      turnId: tid(0x101),
      sessionId: sid(0x101),
      prompt: ASK_PROMPT,
      workspaceFolder: SPACE,
    });
    expect(res.status).toBe('completed');
    expect(h.streamed.some((e) => e.event === 'question/asked')).toBe(false);
  }, 60_000);
});

describe('ask_user_question with ENKEEP_USER_QUESTIONS=1 (host UDS transport)', () => {
  let h: Harness;
  let server: net.Server;
  let transport: HostDaemonTransport;
  const sockets = new Set<net.Socket>();
  const questionEvents: HostQuestionEvent[] = [];

  beforeAll(async () => {
    h = await bootDaemon({ [GATE]: '1', [TIMEOUT]: undefined });
    const socketPath = path.join(h.tmpDir, 'd.sock');
    server = net.createServer((socket) => {
      sockets.add(socket);
      const decoder = new DaemonRpcDecoder();
      const encoder = new DaemonRpcEncoder();
      const onStream = (event: DaemonStreamEvent) => encoder.write(event);
      h.daemon.on('stream', onStream);
      decoder.on('data', async (request: DaemonRequest) => encoder.write(await h.daemon.handleRequest(request)));
      encoder.pipe(socket);
      socket.pipe(decoder);
      socket.on('close', () => {
        h.daemon.removeListener('stream', onStream);
        sockets.delete(socket);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    transport = new HostDaemonTransport({ socketPath, userId: 'alice' });
    await transport.start();
    transport.onQuestionEvent((event) => questionEvents.push(event));
  }, 60_000);

  afterAll(async () => {
    await transport?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await h?.close();
  });

  it('registers the tool', () => {
    const tool: any = toolsOf(h.daemon).get('ask_user_question');
    expect(tool).toBeDefined();
    expect(tool.description).toMatch(/sparingly/);
  });

  it('pushes question/asked, answers over the transport, and the model sees the answer', async () => {
    const SID = sid(0x201);
    const TURN = tid(0x201);
    const asked: DaemonStreamQuestionAskedEvent[] = [];
    const onAsked = (event: DaemonStreamQuestionAskedEvent) => asked.push(event);
    transport.on('question/asked', onAsked);

    // A short idle watchdog: the question must pause it, or the turn would be cancelled.
    const turn = transport.sendFollowup({
      prompt: ASK_PROMPT,
      sessionId: SID,
      turnId: TURN,
      profile: null,
      workspaceFolder: SPACE,
      idleTimeoutMs: 1_500,
    });

    const pushed = await waitFor(() => asked[0]);
    transport.off('question/asked', onAsked);
    const q = pushed.question;
    expect(pushed).toMatchObject({ type: 'event', event: 'question/asked', sessionId: SID, turnId: TURN });
    expect(q).toMatchObject({ sessionId: SID, sessionSource: expect.any(String), timeoutMs: 600_000, status: 'pending' });
    expect(q.callId).toMatch(/^call_/);
    expect(q.id).toBe(q.callId);
    expect(q.plan).toBeUndefined();
    expect(q.questions).toEqual([
      {
        id: 'mode',
        question: 'Which deployment mode should the synthetic service use?',
        header: 'Mode',
        options: [{ label: 'Docker', description: 'Isolated and reproducible.' }, { label: 'Host' }],
        multiSelect: false,
      },
      { id: 'extras', question: 'Which extras?', options: [{ label: 'Metrics' }, { label: 'Tracing' }], multiSelect: true },
      { id: 'notes', question: 'Anything else to know?', options: [], multiSelect: false },
    ]);
    expect(Date.parse(q.expiresAt) - Date.parse(q.createdAt)).toBe(600_000);

    const listed = await transport.listQuestions();
    expect(listed.enabled).toBe(true);
    expect(listed.questions).toEqual([q]);
    expect((await transport.listQuestions(SID)).questions.map((x) => x.id)).toEqual([q.id]);
    expect((await transport.listQuestions(sid(0x2ff))).questions).toEqual([]);

    await expect(transport.answerQuestion(q.id, [{ id: 'mode', selected: ['Kubernetes'] }])).rejects.toMatchObject({
      code: QUESTION_ERROR_CODES.INVALID_ANSWERS,
    });
    await expect(transport.answerQuestion('call_unknown', [])).rejects.toMatchObject({
      code: QUESTION_ERROR_CODES.NOT_FOUND,
    });

    // Longer than the idle watchdog: the turn must still be alive.
    await new Promise((r) => setTimeout(r, 2_200));

    const answers = [
      { id: 'mode', selected: ['Docker'] },
      { id: 'extras', selected: ['Metrics', 'Tracing'] },
      { id: 'notes', selected: [], custom: 'Synthetic constraint: keep it small.' },
    ];
    const accepted = await transport.answerQuestion(q.id, answers);
    expect(accepted).toEqual({ questionId: q.id, answered: true, answers });

    const result = await turn;
    expect(result.status).toBe('completed');
    const reply = (result as { replyText: string }).replyText;
    expect(reply).toContain('The user answered:');
    expect(reply).toContain('- mode ("Which deployment mode should the synthetic service use?"): Docker');
    expect(reply).toContain('Metrics, Tracing');
    expect(reply).toContain('Synthetic constraint: keep it small.');

    const settled = questionEvents.find(
      (e): e is DaemonStreamQuestionSettledEvent & { userId?: string } => e.event === 'question/settled' && e.id === q.id
    );
    expect(settled).toMatchObject({ sessionId: SID, turnId: TURN, outcome: 'answered', answers, userId: 'alice' });
    expect(questionEvents.filter((e) => e.event === 'question/settled' && e.id === q.id)).toHaveLength(1);

    expect((await transport.listQuestions()).questions).toEqual([]);
    await expect(transport.answerQuestion(q.id, answers)).rejects.toMatchObject({
      code: QUESTION_ERROR_CODES.ALREADY_SETTLED,
    });
  }, 60_000);

  it('settles cancelled when the turn is cancelled', async () => {
    const SID = sid(0x202);
    const TURN = tid(0x202);
    const turn = transport.sendFollowup({ prompt: ASK_PROMPT, sessionId: SID, turnId: TURN, profile: null, workspaceFolder: SPACE });
    const asked = await waitFor(() =>
      questionEvents.find((e): e is DaemonStreamQuestionAskedEvent => e.event === 'question/asked' && e.sessionId === SID)
    );
    await transport.cancelTurn(TURN, 'synthetic interrupt');
    const result = await turn;
    expect(result.status).toBe('cancelled');
    const settled = await waitFor(() =>
      questionEvents.find((e) => e.event === 'question/settled' && e.id === asked.question.id)
    );
    expect(settled).toMatchObject({ outcome: 'cancelled', sessionId: SID });
    expect((await transport.listQuestions()).questions).toEqual([]);
    await expect(transport.answerQuestion(asked.question.id, [])).rejects.toMatchObject({
      code: QUESTION_ERROR_CODES.ALREADY_SETTLED,
      details: { status: 'cancelled' },
    });
  }, 60_000);

  it('validates the op parameters', async () => {
    const missing: any = await h.daemon.handleRequest({ id: 'v1', op: 'answerQuestion', answers: [] } as any);
    expect(missing).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMETERS' } });
    const notArray: any = await h.daemon.handleRequest({ id: 'v2', op: 'answerQuestion', questionId: 'x', answers: {} } as any);
    expect(notArray).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMETERS' } });
    const badSession: any = await h.daemon.handleRequest({ id: 'v3', op: 'listQuestions', sessionId: 42 } as any);
    expect(badSession).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMETERS' } });
  });
});

describe('ask_user_question expiry (ENKEEP_QUESTION_TIMEOUT_MS)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await bootDaemon({ [GATE]: '1', [TIMEOUT]: '1000' });
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  it('expires after the configured wait, tells the model, and refuses a late answer with question/expired', async () => {
    const SID = sid(0x301);
    const res = await h.daemon.submitTurnAndWait({
      id: 'e1',
      op: 'submitTurn',
      turnId: tid(0x301),
      sessionId: SID,
      prompt: ASK_PROMPT,
      workspaceFolder: SPACE,
    });
    expect(res.status).toBe('completed');
    expect((res as { replyText: string }).replyText).toContain('The user did not answer within 1 s');

    const asked = h.streamed.find((e): e is DaemonStreamQuestionAskedEvent => e.event === 'question/asked');
    expect(asked?.question).toMatchObject({ sessionId: SID, timeoutMs: 1_000 });
    const settled = h.streamed.find((e): e is DaemonStreamQuestionSettledEvent => e.event === 'question/settled');
    expect(settled).toMatchObject({ id: asked!.question.id, outcome: 'expired', sessionId: SID });
    expect(settled!.answers).toBeUndefined();

    const late: any = await h.daemon.handleRequest({
      id: 'e2',
      op: 'answerQuestion',
      questionId: asked!.question.id,
      answers: [{ id: 'mode', selected: ['Host'] }],
    } as DaemonRequest);
    expect(late).toMatchObject({
      ok: false,
      error: {
        code: QUESTION_ERROR_CODES.EXPIRED,
        details: { questionId: asked!.question.id, sessionId: SID, expiresAt: asked!.question.expiresAt },
      },
    });
  }, 60_000);
});

describe('turn idle watchdog around questions (shared transport helper)', () => {
  it('pauses on question/asked, resumes after the last interaction settles, ignores malformed pushes', () => {
    let refreshed = 0;
    const waiter: any = { pendingApprovals: new Set<string>(), idleTimer: setTimeout(() => {}, 60_000) };
    const asked = { type: 'event', event: 'question/asked', sessionId: 's', turnId: 't', timestamp: 1, question: { id: 'call_1' } };
    const approval = { type: 'event', event: 'approval/asked', sessionId: 's', turnId: 't', timestamp: 1, approval: { id: 'call_1' } };
    expect(applyInteractionWait(waiter, asked, () => refreshed++)).toBe('paused');
    expect(waiter.idleTimer).toBeUndefined();
    expect(applyInteractionWait(waiter, approval, () => refreshed++)).toBe('paused');
    expect([...waiter.pendingApprovals]).toEqual(['question:call_1', 'call_1']);
    expect(applyInteractionWait(waiter, { type: 'event', event: 'question/settled', id: 'call_1', outcome: 'answered' }, () => refreshed++)).toBe('resumed');
    expect(refreshed).toBe(0);
    expect(applyInteractionWait(waiter, { type: 'event', event: 'approval/decided', decision: { id: 'call_1', outcome: 'rejected' } }, () => refreshed++)).toBe('resumed');
    expect(refreshed).toBe(1);
    expect(applyInteractionWait(waiter, { type: 'event', event: 'question/asked', question: {} }, () => refreshed++)).toBeNull();
    expect(isGenuineTurnProgress(asked)).toBe(true);
    expect(isGenuineTurnProgress({ type: 'event', event: 'question/settled' })).toBe(false);
  });
});
