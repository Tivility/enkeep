import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  assertWeChatApiSuccess,
  dedupKey,
  extractTextContent,
  FakeWeChatTransport,
  parseWeixinMessage,
  processWeChatUpdateBatch,
  WECHAT_ITEM_TYPE_FILE,
  WECHAT_ITEM_TYPE_IMAGE,
  WECHAT_ITEM_TYPE_TEXT,
  WECHAT_ITEM_TYPE_VOICE,
  WECHAT_MESSAGE_TYPE_BOT,
  WECHAT_MESSAGE_TYPE_USER,
  type WeChatGetUpdatesResponse,
  type WeChatParsedMessage,
  type WeixinMessage,
} from '../src/index.js';

describe('WeChat iLink Parser & Types Fixture', () => {
  describe('1. Text Message Parsing & Context Token Extraction', () => {
    it('parses a standard user text message with context_token and sender jid', () => {
      const rawMsg: WeixinMessage = {
        seq: 101,
        message_id: 888123456,
        from_user_id: 'wx_user_alpha_99',
        to_user_id: 'bot_ilink_dev',
        create_time_ms: 1715000000000,
        message_type: WECHAT_MESSAGE_TYPE_USER,
        context_token: 'ctx_tok_alpha_secret_abc123',
        item_list: [
          {
            type: WECHAT_ITEM_TYPE_TEXT,
            text_item: { text: 'Hello Enkeep from WeChat' },
          },
        ],
      };

      const parsed = parseWeixinMessage(rawMsg);
      expect(parsed).not.toBeNull();
      expect(parsed?.messageId).toBe('888123456');
      expect(parsed?.senderId).toBe('wx_user_alpha_99');
      expect(parsed?.senderName).toBe('wx_user_alpha_99');
      expect(parsed?.chatId).toBe('wechat:wx_user_alpha_99');
      expect(parsed?.contextToken).toBe('ctx_tok_alpha_secret_abc123');
      expect(parsed?.text).toBe('Hello Enkeep from WeChat');
      expect(parsed?.isFromBot).toBe(false);
      expect(parsed?.dedupKey).toBe('mid:888123456');
    });

    it('asserts WeChat API success and detects structured error codes', () => {
      expect(() => assertWeChatApiSuccess({ ret: 0, errcode: 0 }, 'sendMessage')).not.toThrow();
      expect(() => assertWeChatApiSuccess({}, 'sendMessage')).not.toThrow();

      expect(() =>
        assertWeChatApiSuccess({ ret: -14, errmsg: 'session expired' }, 'sendMessage')
      ).toThrow('sendMessage failed: ret=-14 message=session expired');

      expect(() =>
        assertWeChatApiSuccess(
          { base_resp: { ret: 5, errmsg: 'invalid context_token' } },
          'sendImage'
        )
      ).toThrow('sendImage failed: base_resp.ret=5 message=invalid context_token');
    });
  });

  describe('2. Addressing, Media Items & Sender Normalization', () => {
    it('extracts multi-item content including voice transcription and image CDN refs', () => {
      const rawMsg: WeixinMessage = {
        seq: 102,
        from_user_id: 'wx_user_multimedia_01@im.user',
        to_user_id: 'bot_ilink_dev',
        create_time_ms: 1715000050000,
        message_type: WECHAT_MESSAGE_TYPE_USER,
        context_token: 'ctx_tok_multi',
        item_list: [
          {
            type: WECHAT_ITEM_TYPE_TEXT,
            text_item: { text: 'Please review this file and voice message:' },
          },
          {
            type: WECHAT_ITEM_TYPE_VOICE,
            voice_item: {
              text: 'Here is my spoken note',
              media: {
                encrypt_query_param: 'enc_voice_param_123',
                aes_key: 'voice_aes_key_base64',
              },
            },
          },
          {
            type: WECHAT_ITEM_TYPE_IMAGE,
            image_item: {
              aeskey: 'img_aes_key_base64',
              media: {
                encrypt_query_param: 'enc_img_param_456',
              },
            },
          },
          {
            type: WECHAT_ITEM_TYPE_FILE,
            file_item: {
              file_name: 'report.pdf',
              media: {
                encrypt_query_param: 'enc_file_param_789',
                aes_key: 'file_aes_key_base64',
              },
            },
          },
        ],
      };

      const parsed = parseWeixinMessage(rawMsg);
      expect(parsed).not.toBeNull();
      expect(parsed?.senderName).toBe('wx_user_multimedia_01');
      expect(parsed?.chatId).toBe('wechat:wx_user_multimedia_01@im.user');
      expect(parsed?.text).toContain('Please review this file and voice message:');
      expect(parsed?.text).toContain('Here is my spoken note');

      expect(parsed?.mediaItems).toHaveLength(3);
      expect(parsed?.mediaItems?.[0]).toEqual({
        type: 'voice',
        encryptQueryParam: 'enc_voice_param_123',
        aesKey: 'voice_aes_key_base64',
        transcribedText: 'Here is my spoken note',
      });
      expect(parsed?.mediaItems?.[1]).toEqual({
        type: 'image',
        encryptQueryParam: 'enc_img_param_456',
        aesKey: 'img_aes_key_base64',
      });
      expect(parsed?.mediaItems?.[2]).toEqual({
        type: 'file',
        name: 'report.pdf',
        encryptQueryParam: 'enc_file_param_789',
        aesKey: 'file_aes_key_base64',
      });
    });

    it('correctly filters out bot self-echo messages', () => {
      const botMsg: WeixinMessage = {
        seq: 103,
        from_user_id: 'bot_ilink_dev',
        message_type: WECHAT_MESSAGE_TYPE_BOT,
        item_list: [{ type: WECHAT_ITEM_TYPE_TEXT, text_item: { text: 'Echo from bot' } }],
      };

      const parsed = parseWeixinMessage(botMsg);
      expect(parsed?.isFromBot).toBe(true);
    });
  });

  describe('3. Batch Progression, Cursor Commit & Duplicate Detection', () => {
    it('generates consistent deduplication keys across message ID, sequence, and fallback', () => {
      expect(dedupKey({ message_id: 12345 })).toBe('mid:12345');
      expect(dedupKey({ seq: 789 })).toBe('seq:789');
      expect(
        dedupKey({
          from_user_id: 'user_a',
          create_time_ms: 1000,
          client_id: 'c1',
        })
      ).toBe('fallback:user_a:1000:c1');
    });

    it('commits cursor only after all messages in batch are processed, and recovers on failure', async () => {
      const processed: string[] = [];
      const cursorPersist = vi.fn();

      const nextCursor = await processWeChatUpdateBatch({
        messages: ['msg_1', 'msg_2', 'msg_3'],
        nextCursor: 'buf_cursor_v2',
        currentCursor: 'buf_cursor_v1',
        processMessage: async (m) => {
          processed.push(m);
        },
        persistCursor: cursorPersist,
      });

      expect(processed).toEqual(['msg_1', 'msg_2', 'msg_3']);
      expect(cursorPersist).toHaveBeenCalledWith('buf_cursor_v2');
      expect(nextCursor).toBe('buf_cursor_v2');

      // Failure during batch processing should abort before committing next cursor
      const failedPersist = vi.fn();
      await expect(
        processWeChatUpdateBatch({
          messages: ['msg_4', 'msg_5_fail'],
          nextCursor: 'buf_cursor_v3',
          currentCursor: 'buf_cursor_v2',
          processMessage: async (m) => {
            if (m === 'msg_5_fail') throw new Error('Processing failed');
          },
          persistCursor: failedPersist,
        })
      ).rejects.toThrow('Processing failed');

      expect(failedPersist).not.toHaveBeenCalled();
    });
  });

  describe('4. Fake WeChat Transport Roundtrip', () => {
    let transport: FakeWeChatTransport;

    beforeEach(async () => {
      transport = new FakeWeChatTransport();
      await transport.start('init_cursor_001');
    });

    it('simulates inbound update dispatch and records outbound replies with context_token', async () => {
      const receivedMessages: WeChatParsedMessage[] = [];
      transport.onMessage(async (msg) => {
        receivedMessages.push(msg);
        // Reply back using the mandatory context_token
        if (msg.contextToken) {
          await transport.sendReply(msg.senderId, msg.contextToken, `Echo reply to: ${msg.text}`);
        }
      });

      const updateBatch: WeChatGetUpdatesResponse = {
        ret: 0,
        get_updates_buf: 'cursor_002',
        longpolling_timeout_ms: 35000,
        msgs: [
          {
            seq: 201,
            message_id: 999111,
            from_user_id: 'wx_alice',
            context_token: 'ctx_alice_999',
            message_type: WECHAT_MESSAGE_TYPE_USER,
            item_list: [
              {
                type: WECHAT_ITEM_TYPE_TEXT,
                text_item: { text: 'Testing Fake WeChat transport' },
              },
            ],
          },
        ],
      };

      await transport.simulateIncomingUpdates(updateBatch);

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].text).toBe('Testing Fake WeChat transport');
      expect(transport.cursor).toBe('cursor_002');

      expect(transport.sentReplies).toHaveLength(1);
      const sent = transport.sentReplies[0];
      expect(sent.toUserId).toBe('wx_alice');
      expect(sent.contextToken).toBe('ctx_alice_999');
      expect(sent.text).toBe('Echo reply to: Testing Fake WeChat transport');
    });

    it('handles simulated transport failures and missing context tokens', async () => {
      // Missing context_token rejection
      const emptyTokenRes = await transport.sendReply('wx_bob', '', 'Hello');
      expect(emptyTokenRes.success).toBe(false);
      expect(emptyTokenRes.error).toContain('Missing required context_token');

      // Simulated network failure injection
      transport.failNextSend = true;
      transport.failNextSendReason = 'Network timeout on iLink endpoint';

      const failRes = await transport.sendReply('wx_bob', 'token_123', 'Hello');
      expect(failRes.success).toBe(false);
      expect(failRes.error).toBe('Network timeout on iLink endpoint');

      // Next send recovers
      const recoverRes = await transport.sendReply('wx_bob', 'token_123', 'Hello 2');
      expect(recoverRes.success).toBe(true);
    });
  });
});
