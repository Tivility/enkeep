import { describe, it, expect } from 'vitest';
import {
  stripBotMentions,
  extractTextAndResources,
  isCardActionEvent,
  parseLarkCardAction,
} from '../src/parser.js';

describe('parser: stripBotMentions', () => {
  const botOpenId = 'ou_bot_123';
  const botMentions = [
    { key: '@_user_1', name: '测试机器人', openId: botOpenId, id: { open_id: botOpenId } },
  ];
  const otherUserMentions = [
    { key: '@_user_1', name: '测试机器人', openId: botOpenId, id: { open_id: botOpenId } },
    { key: '@_user_2', name: 'Alice', openId: 'ou_alice_456', id: { open_id: 'ou_alice_456' } },
  ];

  it('removes leading bot mention (placeholder and resolved forms)', () => {
    expect(stripBotMentions('@_user_1 hello world', botMentions, botOpenId)).toBe('hello world');
    expect(stripBotMentions('@测试机器人 hello world', botMentions, botOpenId)).toBe('hello world');
  });

  it('removes middle bot mention (placeholder and resolved forms)', () => {
    expect(stripBotMentions('hello @_user_1 world', botMentions, botOpenId)).toBe('hello world');
    expect(stripBotMentions('hello @测试机器人 world', botMentions, botOpenId)).toBe('hello world');
  });

  it('removes trailing bot mention (placeholder and resolved forms)', () => {
    expect(stripBotMentions('2 @_user_1', botMentions, botOpenId)).toBe('2');
    expect(stripBotMentions('2 @测试机器人', botMentions, botOpenId)).toBe('2');
  });

  it("keeps other users' mentions as @name", () => {
    expect(stripBotMentions('2 @测试机器人 @Alice', otherUserMentions, botOpenId)).toBe('2 @Alice');
    expect(stripBotMentions('@Alice 2 @_user_1', otherUserMentions, botOpenId)).toBe('@Alice 2');
    expect(stripBotMentions('@Alice @测试机器人 please review', otherUserMentions, botOpenId)).toBe('@Alice please review');
  });

  it("returns '' for mention-only text", () => {
    expect(stripBotMentions('@_user_1', botMentions, botOpenId)).toBe('');
    expect(stripBotMentions('@测试机器人', botMentions, botOpenId)).toBe('');
    expect(stripBotMentions('   @测试机器人   ', botMentions, botOpenId)).toBe('');
    expect(stripBotMentions('@测试机器人 @_user_1', botMentions, botOpenId)).toBe('');
  });
});

describe('parser: extractTextAndResources image handling', () => {
  it('extracts single standalone image message as supported image resource', () => {
    const raw = JSON.stringify({ image_key: 'img_v3_test_single_001' });
    const res = extractTextAndResources('image', raw);
    expect(res.text).toBe('[图片]');
    expect(res.resources).toHaveLength(1);
    expect(res.resources[0]).toEqual({
      type: 'image',
      key: 'img_v3_test_single_001',
      name: 'img_v3_test_single_001.jpg',
    });
    expect((res.resources[0] as any).unsupported).toBeUndefined();
  });

  it('extracts rich-text post with 4 images as supported image resources', () => {
    const postPayload = {
      zh_cn: {
        title: '4张图片分析',
        content: [
          [
            { tag: 'text', text: '请分析这4张图片：' },
            { tag: 'img', image_key: 'img_001' },
            { tag: 'img', image_key: 'img_002' },
          ],
          [
            { tag: 'img', image_key: 'img_003' },
            { tag: 'img', image_key: 'img_004' },
          ],
        ],
      },
    };
    const res = extractTextAndResources('post', JSON.stringify(postPayload));
    expect(res.text).toContain('4张图片分析');
    expect(res.text).toContain('[图片]');
    expect(res.resources).toHaveLength(4);
    expect(res.resources.map((r) => r.key)).toEqual(['img_001', 'img_002', 'img_003', 'img_004']);
    for (const r of res.resources) {
      expect(r.type).toBe('image');
      expect((r as any).unsupported).toBeUndefined();
    }
  });

  it('preserves unsupported: true for file type in post and standalone file', () => {
    const filePost = {
      zh_cn: {
        content: [
          [
            { tag: 'file', file_key: 'file_001', file_name: 'doc.pdf' },
            { tag: 'img', image_key: 'img_valid' },
          ],
        ],
      },
    };
    const res = extractTextAndResources('post', JSON.stringify(filePost));
    expect(res.resources).toHaveLength(2);
    const fileRes = res.resources.find((r) => r.type === 'file');
    const imgRes = res.resources.find((r) => r.type === 'image');
    expect(fileRes?.unsupported).toBe(true);
    expect(imgRes?.unsupported).toBeUndefined();
  });

  it('parses standalone PDF file as candidate without hardcoded placeholder', () => {
    const fileMsg = { file_key: 'file_pdf_123', file_name: 'Audit_Report.pdf' };
    const res = extractTextAndResources('file', JSON.stringify(fileMsg));
    expect(res.text).toBe('[文件: Audit_Report.pdf]');
    expect(res.resources).toHaveLength(1);
    expect(res.resources[0]).toEqual({
      type: 'file',
      key: 'file_pdf_123',
      name: 'Audit_Report.pdf',
      unsupported: undefined,
    });
  });

  it('parses generic non-PDF file formats (.md, .zip, .docx) as supported candidate', () => {
    const mdMsg = { file_key: 'file_md_456', file_name: 'notes.md' };
    const resMd = extractTextAndResources('file', JSON.stringify(mdMsg));
    expect(resMd.text).toBe('[文件: notes.md]');
    expect(resMd.resources[0].unsupported).toBeUndefined();

    const zipMsg = { file_key: 'file_zip_456', file_name: 'archive.zip' };
    const resZip = extractTextAndResources('file', JSON.stringify(zipMsg));
    expect(resZip.text).toBe('[文件: archive.zip]');
    expect(resZip.resources[0].unsupported).toBeUndefined();
  });

  it('sanitizes dangerous claimed filenames for safe display', () => {
    const attackMsg = {
      file_key: 'file_atk_789',
      file_name: '../../../../etc/passwd\x00\x1b[31m.pdf',
    };
    const res = extractTextAndResources('file', JSON.stringify(attackMsg));
    expect(res.resources[0].name).not.toContain('..');
    expect(res.resources[0].name).not.toContain('\x00');
    expect(res.resources[0].name).toBe('passwd.pdf');
  });
});

describe('parser: card.action.trigger (C3: card-stop-reply-button)', () => {
  it('isCardActionEvent correctly identifies card.action.trigger events', () => {
    expect(isCardActionEvent({ header: { event_type: 'card.action.trigger' } as any })).toBe(true);
    expect(isCardActionEvent({ action: { value: { action: 'stop_reply' } } } as any)).toBe(true);
    expect(isCardActionEvent({ event: { action: { value: { action: 'stop_reply' } } } } as any)).toBe(true);
    expect(isCardActionEvent({ header: { event_type: 'im.message.receive_v1' } as any })).toBe(false);
    expect(isCardActionEvent(null)).toBe(false);
    expect(isCardActionEvent(undefined)).toBe(false);
  });

  it('parses flattened Lark SDK card.action.trigger callback format', () => {
    const raw = {
      action: {
        value: {
          action: 'stop_reply',
          turnId: 'turn_c3_test_001',
          sessionId: 'ses_c3_test_001',
        },
        tag: 'button',
      },
      operator: {
        open_id: 'ou_operator_test_1',
        user_id: 'usr_operator_1',
        union_id: 'on_operator_1',
      },
      context: {
        open_message_id: 'om_card_msg_123',
        open_chat_id: 'oc_group_chat_456',
      },
    };

    const parsed = parseLarkCardAction(raw as any);
    expect(parsed).not.toBeNull();
    expect(parsed?.eventType).toBe('card.action.trigger');
    expect(parsed?.actionType).toBe('stop_reply');
    expect(parsed?.turnId).toBe('turn_c3_test_001');
    expect(parsed?.sessionId).toBe('ses_c3_test_001');
    expect(parsed?.messageId).toBe('om_card_msg_123');
    expect(parsed?.chatId).toBe('oc_group_chat_456');
    expect(parsed?.operatorId).toBe('ou_operator_test_1');
    expect(parsed?.operatorUserId).toBe('usr_operator_1');
    expect(parsed?.operatorUnionId).toBe('on_operator_1');
  });

  it('parses Schema 2.0 v2 header + event card.action.trigger format', () => {
    const raw = {
      header: {
        event_id: 'evt_c3_v2_999',
        event_type: 'card.action.trigger',
        create_time: '2026-03-30T10:00:00Z',
      },
      event: {
        action: {
          value: {
            action: 'stop_reply',
            turnId: 'turn_v2_002',
            sessionId: 'ses_v2_002',
          },
          tag: 'button',
        },
        operator: {
          operator_id: {
            open_id: 'ou_v2_user',
            user_id: 'usr_v2_user',
            union_id: 'on_v2_user',
          },
        },
        context: {
          open_message_id: 'om_v2_msg_002',
          open_chat_id: 'oc_v2_chat_002',
        },
      },
    };

    const parsed = parseLarkCardAction(raw as any);
    expect(parsed).not.toBeNull();
    expect(parsed?.actionType).toBe('stop_reply');
    expect(parsed?.turnId).toBe('turn_v2_002');
    expect(parsed?.sessionId).toBe('ses_v2_002');
    expect(parsed?.messageId).toBe('om_v2_msg_002');
    expect(parsed?.chatId).toBe('oc_v2_chat_002');
    expect(parsed?.operatorId).toBe('ou_v2_user');
  });

  it('handles stringified JSON in action.value gracefully', () => {
    const raw = {
      header: { event_type: 'card.action.trigger' },
      action: {
        value: JSON.stringify({
          action: 'stop_reply',
          turn_id: 'turn_str_003',
          session_id: 'ses_str_003',
        }),
      },
      operator: { open_id: 'ou_str_user' },
      open_message_id: 'om_str_msg',
      open_chat_id: 'oc_str_chat',
    };

    const parsed = parseLarkCardAction(raw as any);
    expect(parsed).not.toBeNull();
    expect(parsed?.actionType).toBe('stop_reply');
    expect(parsed?.turnId).toBe('turn_str_003');
    expect(parsed?.sessionId).toBe('ses_str_003');
    expect(parsed?.messageId).toBe('om_str_msg');
    expect(parsed?.operatorId).toBe('ou_str_user');
  });

  it('returns null for non-card-action events', () => {
    expect(parseLarkCardAction(null)).toBeNull();
    expect(parseLarkCardAction(undefined)).toBeNull();
    expect(
      parseLarkCardAction({
        header: { event_type: 'im.message.receive_v1' },
        message: { content: 'hello' },
      } as any)
    ).toBeNull();
  });
});
