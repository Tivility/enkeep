/**
 * ask_user_question cards in Lark (synthetic, offline): card layouts, callback → answers,
 * the `answer_question` card action in the gateway (permission, outcomes, timeout), sending /
 * patching cards through the transport, and the "waiting for your answer" status line.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  answersFromCardAction,
  buildQuestionCard,
  buildSettledQuestionCard,
  displayOptionLabel,
  parseQuestionCardActionValue,
  usesButtonLayout,
  type LarkQuestionView,
} from '../src/question-card.js';
import { parseLarkCardAction } from '../src/parser.js';
import { FakeLarkTransport, CredentialedLarkTransport, buildStreamingStatusLine } from '../src/transport.js';
import { LarkChannelGateway, type LarkQuestionService } from '../src/gateway.js';
import type { ILarkApiClient, LarkSdkClientFactory } from '../src/types.js';

const ROUTE = 'ses_00000000000000000000000000000081';
const SENDER = 'ou_test0000000000000000000000000081';
const OTHER = 'ou_test0000000000000000000000000082';
const CHAT = 'oc_test0000000000000000000000000081';

const SINGLE: LarkQuestionView = {
  id: 'call_test_q_card_01',
  sessionId: ROUTE,
  turnId: 'turn_test_card_01',
  timeoutMs: 600_000,
  questions: [
    {
      id: 'scope',
      question: 'Which scope?',
      header: 'Scope',
      options: [{ label: 'Full (Recommended)', description: 'Everything.' }, { label: 'Plan only' }],
      multiSelect: false,
    },
  ],
};

const MULTI: LarkQuestionView = {
  ...SINGLE,
  id: 'call_test_q_card_02',
  questions: [
    SINGLE.questions[0],
    { id: 'extras', question: 'Which extras?', options: [{ label: 'Metrics' }, { label: 'Tracing' }], multiSelect: true },
    { id: 'notes', question: 'Anything else?', options: [], multiSelect: false },
  ],
};

function walk(node: any, out: any[] = []): any[] {
  if (node && typeof node === 'object') {
    out.push(node);
    for (const v of Object.values(node)) walk(v, out);
  }
  return out;
}

describe('question card layouts', () => {
  it('uses one-click buttons for a single single-select question', () => {
    expect(usesButtonLayout(SINGLE)).toBe(true);
    const card: any = buildQuestionCard(SINGLE, { senderId: SENDER });
    expect(card.schema).toBe('2.0');
    expect(card.config.update_multi).toBe(true);
    expect(card.header.title.content).toBe('Scope');
    const buttons = card.body.elements.filter((e: any) => e.tag === 'button');
    expect(buttons.map((b: any) => b.text.content)).toEqual(['Full（推荐）', 'Plan only']);
    expect(buttons[0].type).toBe('primary_filled');
    expect(buttons[1].behaviors[0]).toEqual({
      type: 'callback',
      value: { action: 'answer_question', qid: SINGLE.id, sessionId: ROUTE, turnId: SINGLE.turnId, sid: SENDER, opt: '1' },
    });
  });

  it('uses a form for several, multi-select or free-text questions', () => {
    expect(usesButtonLayout(MULTI)).toBe(false);
    const card: any = buildQuestionCard(MULTI);
    const form = card.body.elements.find((e: any) => e.tag === 'form');
    expect(form).toBeDefined();
    const names = walk(form).filter((n) => typeof n.name === 'string').map((n) => `${n.tag}:${n.name}`);
    expect(names).toEqual([
      'form:q_form',
      'select_static:q0_sel',
      'input:q0_txt',
      'multi_select_static:q1_sel',
      'input:q1_txt',
      'input:q2_txt',
      'button:q_submit',
    ]);
    const submit = walk(form).find((n) => n.name === 'q_submit');
    expect(submit.form_action_type).toBe('submit');
    expect(submit.behaviors[0].value).toMatchObject({ action: 'answer_question', qid: MULTI.id });
  });

  it('renders settled states without controls', () => {
    const answered: any = buildSettledQuestionCard(SINGLE, { kind: 'answered', answers: [{ id: 'scope', selected: ['Full (Recommended)'] }], via: 'web' });
    expect(walk(answered).some((n) => n.tag === 'button' || n.tag === 'form')).toBe(false);
    expect(JSON.stringify(answered)).toContain('已回答（来自Web 端）');
    expect(JSON.stringify(answered)).toContain('Full（推荐）');
    expect(JSON.stringify(buildSettledQuestionCard(SINGLE, { kind: 'expired' }))).toContain('已超时');
    expect(displayOptionLabel('Plain')).toBe('Plain');
  });
});

describe('question card callbacks', () => {
  it('maps a button and a form back to answers', () => {
    expect(answersFromCardAction(SINGLE, { opt: '0' }, undefined)).toEqual([{ id: 'scope', selected: ['Full (Recommended)'] }]);
    expect(answersFromCardAction(SINGLE, { opt: '7' }, undefined)).toBeNull();
    expect(
      answersFromCardAction(MULTI, {}, { q0_sel: '1', q1_sel: ['0', '1', '1'], q1_txt: '  both  ', q2_txt: 'none' })
    ).toEqual([
      { id: 'scope', selected: ['Plan only'] },
      { id: 'extras', selected: ['Metrics', 'Tracing'], custom: 'both' },
      { id: 'notes', selected: [], custom: 'none' },
    ]);
    expect(answersFromCardAction(MULTI, {}, { q0_sel: '', q2_txt: '   ' })).toBeNull();
  });

  it('parses form_value and the component name from card.action.trigger', () => {
    const parsed = parseLarkCardAction({
      header: { event_type: 'card.action.trigger' },
      action: { tag: 'button', name: 'q_submit', value: { action: 'answer_question', qid: 'q1', sessionId: ROUTE }, form_value: { q0_sel: '1' } },
      operator: { open_id: SENDER },
      context: { open_chat_id: CHAT, open_message_id: 'om_test_card_81' },
    } as any);
    expect(parsed).toMatchObject({ actionType: 'answer_question', formValue: { q0_sel: '1' }, componentName: 'q_submit', operatorId: SENDER });
    expect(parseQuestionCardActionValue(parsed!.actionValue)).toMatchObject({ qid: 'q1', sessionId: ROUTE });
    expect(parseQuestionCardActionValue({ action: 'stop_reply' })).toBeNull();
  });
});

function makeGateway(service: LarkQuestionService | undefined, options: { timeoutMs?: number } = {}) {
  const transport = new FakeLarkTransport();
  const gateway = new LarkChannelGateway({
    account: { id: 'acc_test_lark_81', userId: 'user-alice' },
    transport,
    channelRepo: { findAccountById: vi.fn().mockResolvedValue({ id: 'acc_test_lark_81', status: 'active' }), listBindings: vi.fn().mockResolvedValue([]) } as any,
    sessionRouteRepo: { findById: vi.fn().mockResolvedValue(null) } as any,
    runtimeGateway: { dispatchInbound: vi.fn() } as any,
    questionService: service,
    questionAnswerTimeoutMs: options.timeoutMs,
  });
  return { gateway, transport };
}

function clickEvent(operator: string, value: Record<string, unknown>, formValue?: Record<string, unknown>) {
  return {
    header: { event_type: 'card.action.trigger' },
    action: { tag: 'button', value, ...(formValue ? { form_value: formValue } : {}) },
    operator: { open_id: operator },
    context: { open_chat_id: CHAT, open_message_id: 'om_test_card_81' },
  } as any;
}

const BUTTON_VALUE = { action: 'answer_question', qid: SINGLE.id, sessionId: ROUTE, turnId: SINGLE.turnId, sid: SENDER, opt: '1' };

describe('answer_question card action', () => {
  it('answers for the addressed user and replaces the card', async () => {
    const answer = vi.fn(async () => ({ ok: true, status: 'answered', answers: [{ id: 'scope', selected: ['Plan only'] }] }));
    const { gateway } = makeGateway({ getPending: () => SINGLE, answer });
    const res = await gateway.handleInboundEvent(clickEvent(SENDER, BUTTON_VALUE));
    expect(answer).toHaveBeenCalledWith(SINGLE.id, [{ id: 'scope', selected: ['Plan only'] }], { userId: 'user-alice', decidedBy: 'lark-card' });
    expect(res.toast).toEqual({ type: 'success', content: '已提交' });
    expect(res.card?.type).toBe('raw');
    expect(JSON.stringify(res.card?.data)).toContain('已回答');
  });

  it('refuses other users', async () => {
    const answer = vi.fn();
    const { gateway } = makeGateway({ getPending: () => SINGLE, answer: answer as any });
    (gateway as any).checkChatOwnerOrAdmin = async () => false;
    const res = await gateway.handleInboundEvent(clickEvent(OTHER, BUTTON_VALUE));
    expect(res.ignoredReason).toBe('permission_denied');
    expect(res.toast?.content).toBe('只有提问对象可以回答');
    expect(answer).not.toHaveBeenCalled();
  });

  it('reports an empty form, an expired question, a question answered elsewhere and failures', async () => {
    const formValue = { action: 'answer_question', qid: MULTI.id, sessionId: ROUTE, sid: SENDER };
    const empty = makeGateway({ getPending: () => MULTI, answer: vi.fn() as any });
    expect((await empty.gateway.handleInboundEvent(clickEvent(SENDER, formValue, { q0_sel: '' }))).toast?.content).toBe('请至少回答一题');

    const expired = makeGateway({
      getPending: () => undefined,
      getSettled: () => ({ question: SINGLE, outcome: 'expired' }),
      answer: vi.fn() as any,
    });
    const expiredRes = await expired.gateway.handleInboundEvent(clickEvent(SENDER, BUTTON_VALUE));
    expect(expiredRes.toast?.content).toContain('已超时');
    expect(JSON.stringify(expiredRes.card?.data)).toContain('已超时');

    const elsewhere = makeGateway({ getPending: () => SINGLE, answer: async () => ({ ok: false, status: 'already_settled' }) });
    expect((await elsewhere.gateway.handleInboundEvent(clickEvent(SENDER, BUTTON_VALUE))).toast?.content).toBe('已在其他地方回答');

    const failed = makeGateway({ getPending: () => SINGLE, answer: async () => ({ ok: false, status: 'transport_unavailable' }) });
    expect((await failed.gateway.handleInboundEvent(clickEvent(SENDER, BUTTON_VALUE))).toast?.content).toBe('提交失败，请直接在话题里打字回复');

    const none = makeGateway(undefined);
    expect((await none.gateway.handleInboundEvent(clickEvent(SENDER, BUTTON_VALUE))).toast?.content).toBe('提交失败，请直接在话题里打字回复');
  });

  it('answers "提交中…" when the runtime is slow', async () => {
    const slow = makeGateway({ getPending: () => SINGLE, answer: () => new Promise(() => {}) }, { timeoutMs: 20 });
    const res = await slow.gateway.handleInboundEvent(clickEvent(SENDER, BUTTON_VALUE));
    expect(res.toast?.content).toBe('提交中…');
    expect(res.card).toBeUndefined();
  });

  it('sends and patches question cards through the transport', async () => {
    const { gateway, transport } = makeGateway(undefined);
    await transport.start();
    const sent = await gateway.sendQuestionCard({ question: SINGLE, chatId: CHAT, rootId: 'om_test_root_81', senderId: SENDER, uuid: 'q_test_uuid' });
    expect(sent.success).toBe(true);
    expect(transport.sentCards).toHaveLength(1);
    expect((transport.sentCards[0].card as any).header.title.content).toBe('Scope');
    // Same uuid: no second message.
    await gateway.sendQuestionCard({ question: SINGLE, chatId: CHAT, uuid: 'q_test_uuid' });
    expect(transport.sentCards).toHaveLength(1);
    const patched = await gateway.updateQuestionCard({ messageId: sent.messageId!, question: SINGLE, state: { kind: 'cancelled' } });
    expect(patched.success).toBe(true);
    expect(JSON.stringify(transport.patchedCards[0].card)).toContain('已取消');
  });
});

describe('CredentialedLarkTransport interactive cards', () => {
  it('replies in thread with msg_type interactive and patches with im.message.patch', async () => {
    const reply = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'om_test_sent_81' } });
    const patch = vi.fn().mockResolvedValue({ code: 0 });
    const client = { im: { message: { reply, patch, create: vi.fn() } } } as unknown as ILarkApiClient;
    const transport = new CredentialedLarkTransport({
      account: { id: 'acc_test_cred_81', userId: 'user-alice', appId: 'cli_test_81', appSecret: 'sec_test_81' },
      clientFactory: { createClient: () => client } as LarkSdkClientFactory,
    });
    await transport.start();
    const res = await transport.sendInteractiveCard({ chatId: CHAT, rootId: 'om_test_root_81', threadId: 'omt_test_81', card: { schema: '2.0' }, uuid: 'q_test_uuid' });
    expect(res).toEqual({ success: true, messageId: 'om_test_sent_81' });
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_test_root_81' },
        data: expect.objectContaining({ msg_type: 'interactive', reply_in_thread: true, content: '{"schema":"2.0"}', uuid: 'q_test_uuid' }),
      })
    );
    await expect(transport.patchInteractiveCard({ messageId: 'om_test_sent_81', card: { schema: '2.0', x: 1 } })).resolves.toEqual({ success: true });
    expect(patch).toHaveBeenCalledWith({ path: { message_id: 'om_test_sent_81' }, data: { content: '{"schema":"2.0","x":1}' } });
    await transport.stop();
  });
});

describe('waiting-for-answer status line', () => {
  it('shows the waiting notice instead of the idle notice', () => {
    const now = 1_800_000_000_000;
    const waiting = buildStreamingStatusLine({ elapsedMs: 300_000, nowMs: now, lastActivityAt: now - 300_000, waitingForAnswer: true });
    expect(waiting).toContain('等待你回答');
    expect(waiting).not.toContain('无新事件');
    const idle = buildStreamingStatusLine({ elapsedMs: 300_000, nowMs: now, lastActivityAt: now - 300_000 });
    expect(idle).toContain('无新事件');
  });
});
