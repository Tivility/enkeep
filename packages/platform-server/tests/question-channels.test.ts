/**
 * ask_user_question in IM channels (synthetic, offline): the text form and reply parsing, the
 * QuestionChannelNotifier (Lark card / text, WeChat text, skip, automatic fallback answer, card
 * update on settle), and the delivery gateway turning a typed reply into the question's answer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import type { UserQuestion } from '@enkeep/dsh-external-interaction/user-questions';
import { QuestionBridge } from '../src/interactions/question-bridge.js';
import { parseOptionCodes, parseQuestionReply, renderQuestionText } from '../src/interactions/question-text.js';
import {
  QUESTION_FALLBACK_DECIDED_BY,
  QUESTION_FALLBACK_TEXT,
  QuestionChannelNotifier,
  questionOutboxId,
  type QuestionLarkSender,
  type QuestionWeChatSender,
} from '../src/interactions/question-channel-notifier.js';
import { PlatformServerMigrationRunner, ALL_PLATFORM_MIGRATIONS } from '../src/storage/migrations.js';
import { DeliveryRuntimeGateway, QUESTION_ANSWER_RECEIPT, type DeliveryExecutionRequest } from '../src/runtime/delivery-gateway.js';
import { SqliteWebMessageStore } from '../src/index.js';

const ALICE = 'user-alice';
const SPACE = 'spc_00000000000000000000000000000071';
const LARK_ROUTE = 'ses_00000000000000000000000000000071';
const LARK_DSH = 'ses_00000000000000000000000000000171';
const WECHAT_ROUTE = 'ses_00000000000000000000000000000072';
const WECHAT_DSH = 'ses_00000000000000000000000000000172';
const WEB_ROUTE = 'ses_00000000000000000000000000000073';
const WEB_DSH = 'ses_00000000000000000000000000000173';
const QQ_ROUTE = 'ses_00000000000000000000000000000074';
const QQ_DSH = 'ses_00000000000000000000000000000174';
const LARK_ACCOUNT = 'acc_test_lark_000000000000000001';
const WECHAT_ACCOUNT = 'acc_test_wechat_00000000000000001';
const QQ_ACCOUNT = 'acc_test_qq_00000000000000000001';
const CHAT = 'oc_test0000000000000000000000000071';
const ROOT = 'om_test0000000000000000000000000071';
const THREAD = 'omt_test000000000000000000000071';
const SENDER = 'ou_test0000000000000000000000000071';
const OTHER_SENDER = 'ou_test0000000000000000000000000072';
const PEER = 'test-peer-01@im.wechat';

const SCOPE: UserQuestion[] = [
  {
    id: 'scope',
    question: 'Which scope should the synthetic report cover?',
    header: 'Scope',
    options: [{ label: 'Full report (Recommended)', description: 'Everything.' }, { label: 'Plan only' }, { label: 'Project only' }],
    multiSelect: false,
  },
];
const TWO: UserQuestion[] = [
  SCOPE[0],
  { id: 'extras', question: 'Which extras?', options: [{ label: 'Metrics' }, { label: 'Tracing' }], multiSelect: true },
];

class FakeQuestionTransport extends EventEmitter {
  readonly answers: Array<{ questionId: string; answers: unknown }> = [];
  async listQuestions() {
    return { enabled: true, questions: [] };
  }
  async answerQuestion(questionId: string, answers: unknown) {
    this.answers.push({ questionId, answers });
    return { questionId, answered: true, answers };
  }
  ask(id: string, dshSessionId: string, turnId: string, questions: UserQuestion[] = SCOPE) {
    const now = Date.now();
    this.emit('stream', {
      type: 'event',
      event: 'question/asked',
      sessionId: dshSessionId,
      turnId,
      timestamp: now,
      question: {
        id,
        sessionId: dshSessionId,
        callId: id,
        sessionSource: 'im',
        questions,
        createdAt: new Date(now).toISOString(),
        timeoutMs: 600_000,
        expiresAt: new Date(now + 600_000).toISOString(),
        status: 'pending',
      },
    });
  }
}

describe('question text', () => {
  it('renders a single question with letters and the recommended marker', () => {
    const text = renderQuestionText(SCOPE, 600_000);
    expect(text).toContain('需要你确认一个问题（10 分钟内回复');
    expect(text).toContain('Scope：Which scope should the synthetic report cover?');
    expect(text).toContain('A. Full report（推荐）');
    expect(text).toContain('C. Project only');
    expect(text).toContain('回复字母（如「A」）');
  });

  it('renders several questions with numbers and the multi-select hint', () => {
    const text = renderQuestionText(TWO, 600_000);
    expect(text).toContain('需要你确认 2 个问题');
    expect(text).toContain('1. Scope：');
    expect(text).toContain('2. Which extras?（可多选）');
    expect(text).toContain('   B. Tracing');
    expect(text).toContain('回复编号（如「1A 2B」）');
  });

  it('parses option codes', () => {
    expect(parseOptionCodes(SCOPE, 'b')).toEqual([{ id: 'scope', selected: ['Plan only'] }]);
    expect(parseOptionCodes(SCOPE, '1C')).toEqual([{ id: 'scope', selected: ['Project only'] }]);
    expect(parseOptionCodes(TWO, '1a 2ab')).toEqual([
      { id: 'scope', selected: ['Full report (Recommended)'] },
      { id: 'extras', selected: ['Metrics', 'Tracing'] },
    ]);
    expect(parseOptionCodes(TWO, '１Ａ，２Ｂ')).toEqual([
      { id: 'scope', selected: ['Full report (Recommended)'] },
      { id: 'extras', selected: ['Tracing'] },
    ]);
    expect(parseOptionCodes(TWO, '2B')).toEqual([{ id: 'extras', selected: ['Tracing'] }]);
  });

  it('rejects invalid codes', () => {
    expect(parseOptionCodes(SCOPE, 'AB')).toBeNull(); // single-select, two letters
    expect(parseOptionCodes(SCOPE, 'D')).toBeNull(); // no fourth option
    expect(parseOptionCodes(TWO, '3A')).toBeNull(); // no third question
    expect(parseOptionCodes(TWO, '1A 1B')).toBeNull(); // answered twice
    expect(parseOptionCodes(TWO, '2AA')).toBeNull(); // repeated letter
    expect(parseOptionCodes(SCOPE, 'go ahead')).toBeNull();
  });

  it('uses the whole reply as every question’s own words when it is not codes', () => {
    expect(parseQuestionReply(TWO, '  just do it  ')).toEqual([
      { id: 'scope', selected: [], custom: 'just do it' },
      { id: 'extras', selected: [], custom: 'just do it' },
    ]);
    expect(parseQuestionReply(TWO, '1B')).toEqual([{ id: 'scope', selected: ['Plan only'] }]);
  });
});

function setupDb(db: DatabaseSync): void {
  db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'alice', 'hash')`).run(ALICE);
  db.prepare(`INSERT INTO spaces (id, user_id, name, folder) VALUES (?, ?, 'Synthetic', 'synthetic')`).run(SPACE, ALICE);
  for (const [id, type] of [
    [LARK_ACCOUNT, 'lark'],
    [WECHAT_ACCOUNT, 'wechat'],
    [QQ_ACCOUNT, 'qq'],
  ]) {
    db.prepare(`INSERT INTO channel_accounts (id, user_id, type, status) VALUES (?, ?, ?, 'active')`).run(id, ALICE, type);
  }
}

async function createRoutes(storage: SqlitePlatformStorage): Promise<void> {
  const routes = storage.forTenant(ALICE).sessionRoutes;
  await routes.create({ id: LARK_ROUTE, spaceId: SPACE, channel: 'lark', accountId: LARK_ACCOUNT, nativeContextId: `${CHAT}:${THREAD}`, dshSessionId: LARK_DSH } as any);
  await routes.create({ id: WECHAT_ROUTE, spaceId: SPACE, channel: 'wechat', accountId: WECHAT_ACCOUNT, nativeContextId: `wechat:${PEER}`, dshSessionId: WECHAT_DSH } as any);
  await routes.create({ id: WEB_ROUTE, spaceId: SPACE, channel: 'web', nativeContextId: WEB_ROUTE, dshSessionId: WEB_DSH });
  await routes.create({ id: QQ_ROUTE, spaceId: SPACE, channel: 'qq', accountId: QQ_ACCOUNT, nativeContextId: 'qq:test-peer', dshSessionId: QQ_DSH } as any);
}

function addOrigin(db: DatabaseSync, turnId: string, route: string, channel: string, account: string, nativeContextId: string) {
  db.prepare(`
    INSERT INTO channel_turn_origins (turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id, native_event_id, reply_to_message_id, root_id, thread_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(turnId, ALICE, route, account, channel, channel === 'lark' ? CHAT : PEER, nativeContextId, 'om_test_event_01', channel === 'lark' ? 'om_test_reply_01' : null, channel === 'lark' ? ROOT : null, channel === 'lark' ? THREAD : null);
}

function addInboxSender(db: DatabaseSync, turnId: string, route: string, senderId: string) {
  db.prepare(`
    INSERT INTO delivery_inbox (id, user_id, route_id, message_id, delivery_id, status, payload, turn_id)
    VALUES (?, ?, ?, ?, ?, 'delivered', ?, ?)
  `).run(`inbox_${turnId}`, ALICE, route, `msg_${turnId}`, `deliv_${turnId}`, JSON.stringify({ channelContext: { channel: 'lark', senderId } }), turnId);
}

class FakeLark implements QuestionLarkSender {
  cards: any[] = [];
  texts: any[] = [];
  updates: any[] = [];
  failCard = false;
  failText = false;
  async sendQuestionCard(params: any) {
    if (this.failCard) return { success: false, error: 'synthetic card failure' };
    this.cards.push(params);
    return { success: true, messageId: `om_test_card_${this.cards.length}` };
  }
  async updateQuestionCard(params: any) {
    this.updates.push(params);
    return { success: true };
  }
  async sendThreadText(params: any) {
    if (this.failText) return { success: false, error: 'synthetic text failure' };
    this.texts.push(params);
    return { success: true, messageId: 'om_test_text_1' };
  }
}

class FakeWeChat implements QuestionWeChatSender {
  sent: any[] = [];
  async sendProactiveMessage(params: any) {
    this.sent.push(params);
    return { success: true };
  }
}

describe('QuestionChannelNotifier', () => {
  let db: DatabaseSync;
  let bridge: QuestionBridge;
  let transport: FakeQuestionTransport;
  let lark: FakeLark;
  let wechat: FakeWeChat;
  let notifier: QuestionChannelNotifier;

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    await new PlatformServerMigrationRunner(db).migrate(ALL_PLATFORM_MIGRATIONS);
    setupDb(db);
    await createRoutes(new SqlitePlatformStorage({ database: db }));
    bridge = new QuestionBridge({ db, env: {}, logger: { warn: () => {} } });
    transport = new FakeQuestionTransport();
    bridge.attachTransport(ALICE, transport);
    lark = new FakeLark();
    wechat = new FakeWeChat();
    notifier = new QuestionChannelNotifier({ db, bridge, lark: () => lark, wechat: () => wechat, logger: { warn: () => {} } });
    notifier.start();
  });

  afterEach(() => {
    notifier.stop();
    bridge.dispose();
    db.close();
  });

  it('sends a Lark card in the asking turn’s thread, addressed to the turn’s sender, once', async () => {
    addOrigin(db, 'turn_test_lark_01', LARK_ROUTE, 'lark', LARK_ACCOUNT, `${CHAT}:${THREAD}`);
    addInboxSender(db, 'turn_test_lark_01', LARK_ROUTE, SENDER);
    transport.ask('call_test_q_lark_01', LARK_DSH, 'turn_test_lark_01');
    await notifier.idle();
    expect(lark.cards).toHaveLength(1);
    expect(lark.cards[0]).toMatchObject({
      userId: ALICE,
      accountId: LARK_ACCOUNT,
      chatId: CHAT,
      rootId: ROOT,
      threadId: THREAD,
      replyToMessageId: 'om_test_reply_01',
      senderId: SENDER,
      uuid: questionOutboxId(ALICE, 'call_test_q_lark_01'),
    });
    expect(lark.cards[0].question).toMatchObject({ id: 'call_test_q_lark_01', sessionId: LARK_ROUTE, turnId: 'turn_test_lark_01' });
    const row = db.prepare('SELECT status, payload_json FROM channel_outbox WHERE id = ?').get(questionOutboxId(ALICE, 'call_test_q_lark_01')) as any;
    expect(row.status).toBe('delivered');
    expect(JSON.parse(row.payload_json)).toMatchObject({ kind: 'ask_user_question', mode: 'card', messageId: 'om_test_card_1' });

    // A restart / reconcile re-announcing the same question does not resend it.
    const again = new QuestionChannelNotifier({ db, bridge, lark: () => lark, wechat: () => wechat, logger: { warn: () => {} } });
    again.start();
    await again.idle();
    again.stop();
    expect(lark.cards).toHaveLength(1);

    // Settling replaces the card with its final state.
    await bridge.answer('call_test_q_lark_01', [{ id: 'scope', selected: ['Plan only'] }], { userId: ALICE, decidedBy: 'web' });
    await notifier.idle();
    expect(lark.updates).toHaveLength(1);
    expect(lark.updates[0]).toMatchObject({
      accountId: LARK_ACCOUNT,
      messageId: 'om_test_card_1',
      state: { kind: 'answered', via: 'web', answers: [{ id: 'scope', selected: ['Plan only'] }] },
    });
  });

  it('falls back to a text question when the card cannot be sent, and answers for the user when nothing can', async () => {
    addOrigin(db, 'turn_test_lark_02', LARK_ROUTE, 'lark', LARK_ACCOUNT, `${CHAT}:${THREAD}`);
    lark.failCard = true;
    transport.ask('call_test_q_lark_02', LARK_DSH, 'turn_test_lark_02');
    await notifier.idle();
    expect(lark.texts).toHaveLength(1);
    expect(lark.texts[0].text).toContain('A. Full report（推荐）');
    expect(transport.answers).toHaveLength(0);

    addOrigin(db, 'turn_test_lark_03', LARK_ROUTE, 'lark', LARK_ACCOUNT, `${CHAT}:${THREAD}`);
    lark.failText = true;
    transport.ask('call_test_q_lark_03', LARK_DSH, 'turn_test_lark_03');
    await notifier.idle();
    expect(transport.answers).toEqual([
      { questionId: 'call_test_q_lark_03', answers: [{ id: 'scope', selected: [], custom: QUESTION_FALLBACK_TEXT }] },
    ]);
  });

  it('sends WeChat questions as text to the asking contact', async () => {
    addOrigin(db, 'turn_test_wechat_01', WECHAT_ROUTE, 'wechat', WECHAT_ACCOUNT, `wechat:${PEER}`);
    transport.ask('call_test_q_wechat_01', WECHAT_DSH, 'turn_test_wechat_01', TWO);
    await notifier.idle();
    expect(wechat.sent).toHaveLength(1);
    expect(wechat.sent[0]).toMatchObject({
      userId: ALICE,
      accountId: WECHAT_ACCOUNT,
      chatId: `wechat:${PEER}`,
      sessionId: WECHAT_ROUTE,
      outboxId: questionOutboxId(ALICE, 'call_test_q_wechat_01'),
    });
    expect(wechat.sent[0].text).toContain('回复编号（如「1A 2B」）');
    expect(lark.cards).toHaveLength(0);
  });

  it('leaves Web questions to the Web UI', async () => {
    transport.ask('call_test_q_web_01', WEB_DSH, 'turn_test_web_01');
    await notifier.idle();
    expect(lark.cards).toHaveLength(0);
    expect(wechat.sent).toHaveLength(0);
    expect(transport.answers).toHaveLength(0);
    expect(bridge.listPending({ userId: ALICE })).toHaveLength(1);
  });

  it('answers at once for channels without a question surface and for scheduled task turns', async () => {
    transport.ask('call_test_q_qq_01', QQ_DSH, 'turn_test_qq_01');
    await notifier.idle();
    expect(transport.answers.map((a) => a.questionId)).toEqual(['call_test_q_qq_01']);

    db.prepare(`INSERT INTO platform_tasks (id, user_id, title) VALUES ('task_test_01', ?, 'Synthetic task')`).run(ALICE);
    db.prepare(`INSERT INTO task_runs (id, task_id, user_id, status, turn_id) VALUES ('trun_test_01', 'task_test_01', ?, 'running', 'turn_test_task_01')`).run(ALICE);
    addOrigin(db, 'turn_test_task_01', LARK_ROUTE, 'lark', LARK_ACCOUNT, `${CHAT}:${THREAD}`);
    transport.ask('call_test_q_task_01', LARK_DSH, 'turn_test_task_01');
    await notifier.idle();
    expect(transport.answers.map((a) => a.questionId)).toEqual(['call_test_q_qq_01', 'call_test_q_task_01']);
    expect(lark.cards).toHaveLength(0);
    const settledBy = bridge.getSettled('call_test_q_task_01', ALICE);
    expect(settledBy?.outcome).toBe('answered');
    expect(QUESTION_FALLBACK_DECIDED_BY).toBe('system-fallback');
  });

  it('does not deliver a question that settled before delivery', async () => {
    addOrigin(db, 'turn_test_lark_04', LARK_ROUTE, 'lark', LARK_ACCOUNT, `${CHAT}:${THREAD}`);
    notifier.stop();
    transport.ask('call_test_q_lark_04', LARK_DSH, 'turn_test_lark_04');
    await bridge.answer('call_test_q_lark_04', [{ id: 'scope', selected: ['Plan only'] }], { userId: ALICE, decidedBy: 'web' });
    notifier.start();
    await notifier.idle();
    expect(lark.cards).toHaveLength(0);
  });
});

describe('typed IM reply answers a pending question (delivery gateway)', () => {
  let db: DatabaseSync;
  let bridge: QuestionBridge;
  let transport: FakeQuestionTransport;
  let gateway: DeliveryRuntimeGateway;
  let release!: () => void;
  let askedTurnId: string | undefined;

  const larkContext = (senderId: string, eventId: string) => ({
    channel: 'lark',
    accountId: LARK_ACCOUNT,
    chatId: CHAT,
    nativeContextId: `${CHAT}:${THREAD}`,
    nativeEventId: eventId,
    replyToMessageId: eventId,
    rootId: ROOT,
    threadId: THREAD,
    senderId,
    chatType: 'group',
  });

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    await new PlatformServerMigrationRunner(db).migrate(ALL_PLATFORM_MIGRATIONS);
    setupDb(db);
    const storage = new SqlitePlatformStorage({ database: db });
    await createRoutes(storage);
    bridge = new QuestionBridge({ db, env: {}, logger: { warn: () => {} } });
    transport = new FakeQuestionTransport();
    bridge.attachTransport(ALICE, transport);
    const whenReleased = new Promise<void>((r) => (release = r));
    askedTurnId = undefined;
    gateway = new DeliveryRuntimeGateway({
      storage,
      messageStore: new SqliteWebMessageStore(db),
      database: db,
      executor: {
        execute: async (req: DeliveryExecutionRequest) => {
          if (!askedTurnId) {
            askedTurnId = req.turnId;
            transport.ask('call_test_q_gw_01', LARK_DSH, req.turnId, TWO);
            await whenReleased;
          }
          return { replyText: 'synthetic reply', usage: { totalTokens: 1 } };
        },
        cancel: async () => true,
      },
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null } as any,
      questionService: bridge,
    });
    await gateway.dispatchInbound({
      id: `deliv_${'0'.repeat(30)}71`,
      userId: ALICE,
      sessionId: LARK_ROUTE,
      content: 'synthetic prompt that needs a decision',
      timestamp: new Date().toISOString(),
      channelContext: larkContext(SENDER, 'om_test_event_71'),
    } as any);
    const start = Date.now();
    while (bridge.listPending({ userId: ALICE }).length === 0 && Date.now() - start < 3_000) {
      await new Promise((r) => setTimeout(r, 10));
    }
  });

  afterEach(async () => {
    release();
    await gateway.close();
    bridge.dispose();
    db.close();
  });

  it('answers with the parsed reply and records a command turn with a receipt', async () => {
    expect(bridge.listPending({ userId: ALICE })).toHaveLength(1);
    const result = await gateway.dispatchInbound({
      id: `deliv_${'0'.repeat(30)}72`,
      userId: ALICE,
      sessionId: LARK_ROUTE,
      content: '1B 2AB',
      timestamp: new Date().toISOString(),
      channelContext: larkContext(SENDER, 'om_test_event_72'),
    } as any);
    expect(result.executionMode).toBe('command');
    expect(transport.answers).toEqual([
      {
        questionId: 'call_test_q_gw_01',
        answers: [
          { id: 'scope', selected: ['Plan only'] },
          { id: 'extras', selected: ['Metrics', 'Tracing'] },
        ],
      },
    ]);
    expect(bridge.getSettled('call_test_q_gw_01', ALICE)?.outcome).toBe('answered');
    const reply = db
      .prepare(`SELECT content FROM web_messages WHERE turn_id = ? AND role = 'assistant'`)
      .get(result.turnId) as { content: string };
    expect(reply.content).toBe(QUESTION_ANSWER_RECEIPT);

    // Redelivery of the same message is a duplicate, not a second answer or a new turn.
    const dup = await gateway.dispatchInbound({
      id: `deliv_${'0'.repeat(30)}72`,
      userId: ALICE,
      sessionId: LARK_ROUTE,
      content: '1B 2AB',
      timestamp: new Date().toISOString(),
      channelContext: larkContext(SENDER, 'om_test_event_72'),
    } as any);
    expect(dup.isDuplicate).toBe(true);
    expect(transport.answers).toHaveLength(1);
  });

  it('takes free text and /steer text as the answer', async () => {
    const result = await gateway.dispatchInbound({
      id: `deliv_${'0'.repeat(30)}73`,
      userId: ALICE,
      sessionId: LARK_ROUTE,
      content: '/steer just do it',
      timestamp: new Date().toISOString(),
      channelContext: larkContext(SENDER, 'om_test_event_73'),
    } as any);
    expect(result.executionMode).toBe('command');
    expect(transport.answers[0].answers).toEqual([
      { id: 'scope', selected: [], custom: 'just do it' },
      { id: 'extras', selected: [], custom: 'just do it' },
    ]);
  });

  it('does not treat another sender’s message, attachments, commands or Web messages as an answer', async () => {
    const other = await gateway.dispatchInbound({
      id: `deliv_${'0'.repeat(30)}74`,
      userId: ALICE,
      sessionId: LARK_ROUTE,
      content: 'A',
      timestamp: new Date().toISOString(),
      channelContext: larkContext(OTHER_SENDER, 'om_test_event_74'),
    } as any);
    expect(other.executionMode).not.toBe('command');

    const web = await gateway.dispatchInbound({
      id: `deliv_${'0'.repeat(30)}75`,
      userId: ALICE,
      sessionId: LARK_ROUTE,
      content: 'A',
      timestamp: new Date().toISOString(),
    } as any);
    expect(web.executionMode).not.toBe('command');

    const command = await gateway.dispatchInbound({
      id: `deliv_${'0'.repeat(30)}76`,
      userId: ALICE,
      sessionId: LARK_ROUTE,
      content: '/status',
      timestamp: new Date().toISOString(),
      channelContext: larkContext(SENDER, 'om_test_event_76'),
    } as any);
    expect(command.executionMode).toBe('command');

    expect(transport.answers).toHaveLength(0);
    expect(bridge.listPending({ userId: ALICE })).toHaveLength(1);
  });
});
