import { describe, it, expect, vi } from 'vitest';
import {
  optimizeMarkdownStyle,
  chunkMarkdown,
  findCodeBlockRanges,
} from '../src/markdown-card.js';
import {
  CredentialedLarkTransport,
  FakeLarkTransport,
  resolveReplyTarget,
} from '../src/transport.js';
import type { LarkSdkClientFactory, ILarkApiClient } from '../src/types.js';

describe('Task 2a: Feishu/Lark Streaming Card & Markdown Protocol', () => {
  function createMockApiClient(overrides: {
    cardCreateResult?: any;
    cardCreateThrows?: boolean;
    replyResult?: any;
    contentErrCodes?: number[];
    cardUpdateResult?: any;
    cardUpdateThrows?: boolean;
    patchResult?: any;
  } = {}) {
    const calls = {
      cardCreate: [] as any[],
      cardSettings: [] as any[],
      cardUpdate: [] as any[],
      cardElementContent: [] as any[],
      imReply: [] as any[],
      imCreate: [] as any[],
      imPatch: [] as any[],
    };

    let contentCallIndex = 0;

    const client: ILarkApiClient = {
      cardkit: {
        v1: {
          card: {
            create: async (payload: any) => {
              calls.cardCreate.push(payload);
              if (overrides.cardCreateThrows) {
                throw new Error('Simulated card.create error');
              }
              return overrides.cardCreateResult ?? {
                code: 0,
                data: { card_id: 'crd_mock_12345' },
              };
            },
            settings: async (payload: any) => {
              calls.cardSettings.push(payload);
              return { code: 0, data: {} };
            },
            update: async (payload: any) => {
              calls.cardUpdate.push(payload);
              if (overrides.cardUpdateThrows) {
                throw new Error('Simulated card.update network error');
              }
              return overrides.cardUpdateResult ?? { code: 0, data: {} };
            },
          },
          cardElement: {
            content: async (payload: any) => {
              calls.cardElementContent.push(payload);
              const currentErrCode = overrides.contentErrCodes?.[contentCallIndex];
              contentCallIndex++;
              if (currentErrCode) {
                const err: any = new Error(`Lark error code ${currentErrCode}`);
                err.code = currentErrCode;
                throw err;
              }
              return { code: 0, data: {} };
            },
          },
        },
      },
      im: {
        message: {
          reply: async (payload: any) => {
            calls.imReply.push(payload);
            return overrides.replyResult ?? {
              code: 0,
              data: { message_id: 'om_reply_mock_67890' },
            };
          },
          create: async (payload: any) => {
            calls.imCreate.push(payload);
            return {
              code: 0,
              data: { message_id: 'om_create_mock_11111' },
            };
          },
          patch: async (payload: any) => {
            calls.imPatch.push(payload);
            return overrides.patchResult ?? { code: 0, data: {} };
          },
        },
      },
    };

    return { client, calls };
  }

  describe('(a) Markdown Card formatting and safe boundary chunking', () => {
    it('demotes H1 to H4 and H2..H6 to H5 when text contains top-level headings', () => {
      const input = '# Main Title\n## Section 2\n### Section 3\n#### Section 4\n##### Section 5\n###### Section 6';
      const output = optimizeMarkdownStyle(input);

      expect(output).toContain('#### Main Title');
      expect(output).toContain('##### Section 2');
      expect(output).toContain('##### Section 3');
      expect(output).toContain('##### Section 4');
      expect(output).toContain('##### Section 5');
      expect(output).toContain('##### Section 6');
      expect(output).not.toMatch(/^# Main/m);
      expect(output).not.toMatch(/^## Section/m);
    });

    it('protects code block fences and contents from formatting alterations', () => {
      const input = 'Here is code:\n```typescript\n# Not a heading\n| col1 | col2 |\n```\nOutside table:\n| A | B |\n|---|---|\n| 1 | 2 |';
      const output = optimizeMarkdownStyle(input);

      expect(output).toContain('```typescript\n# Not a heading\n| col1 | col2 |\n```');
      expect(output).toContain('<br>');
    });

    it('chunkMarkdown splits at paragraph boundary when text exceeds maxLen', () => {
      const p1 = 'Paragraph 1: ' + 'A'.repeat(2500);
      const p2 = 'Paragraph 2: ' + 'B'.repeat(2500);
      const input = `${p1}\n\n${p2}`;

      const chunks = chunkMarkdown(input, 4000);
      expect(chunks.length).toBe(2);
      expect(chunks[0]).toBe(p1);
      expect(chunks[1]).toBe(p2);
      expect(chunks[0].length).toBeLessThanOrEqual(4000);
      expect(chunks[1].length).toBeLessThanOrEqual(4000);
    });

    it('chunkMarkdown never breaks inside a code block fence without safe closure/reopening', () => {
      const beforeCode = 'Intro text\n\n';
      const codeContent = 'const longArray = [\n' + '  "item",\n'.repeat(300) + '];';
      const codeBlock = '```typescript\n' + codeContent + '\n```';
      const input = beforeCode + codeBlock;

      const chunks = chunkMarkdown(input, 1500);
      expect(chunks.length).toBeGreaterThan(1);

      // Verify that every chunk has balanced code fences (``` count is even)
      for (const chunk of chunks) {
        const fenceMatches = chunk.match(/^```/gm);
        const count = fenceMatches ? fenceMatches.length : 0;
        expect(count % 2).toBe(0);
      }

      // Check that code block ranges can be scanned cleanly
      for (const chunk of chunks) {
        const ranges = findCodeBlockRanges(chunk);
        expect(Array.isArray(ranges)).toBe(true);
      }
    });
  });

  describe('(b) CredentialedLarkTransport.createStreamingCard', () => {
    it('creates streaming card, targets thread correctly, pushes sequence 2,3, and finalizes with green header', async () => {
      const { client, calls } = createMockApiClient();

      const transport = new CredentialedLarkTransport({
        account: {
          id: 'acc_stream_test',
          userId: 'usr_1',
          appId: 'cli_mock_stream',
          appSecret: 'sec_mock_stream',
          brand: 'feishu',
        },
        clientFactory: {
          createClient: () => client,
        } as LarkSdkClientFactory,
      });

      await transport.start();

      const session = await transport.createStreamingCard({
        chatId: 'oc_test_chat_1',
        rootId: 'om_root_999',
        threadId: 'om_thread_888',
        replyToMessageId: 'om_reply_777',
        title: 'Custom Title',
      });

      expect(session).not.toBeNull();
      if (!session) throw new Error('Session is null');

      expect(session.cardId).toBe('crd_mock_12345');
      expect(session.messageId).toBe('om_reply_mock_67890');

      // 1. Verify card.create payload
      expect(calls.cardCreate.length).toBe(1);
      const initialCardData = JSON.parse(calls.cardCreate[0].data.data);
      expect(initialCardData.schema).toBe('2.0');
      expect(initialCardData.config.streaming_mode).toBe(true);
      expect(initialCardData.header.title.content).toBe('Custom Title');
      expect(initialCardData.header.template).toBe('blue');
      expect(initialCardData.body.elements[0].content).toBe('正在思考…');

      // 2. Verify im.message.reply payload & thread targeting
      expect(calls.imReply.length).toBe(1);
      expect(calls.imReply[0].path.message_id).toBe('om_root_999'); // rootId preferred
      expect(calls.imReply[0].data.reply_in_thread).toBe(true);
      expect(calls.imReply[0].data.msg_type).toBe('interactive');
      const replyCardContent = JSON.parse(calls.imReply[0].data.content);
      expect(replyCardContent.type).toBe('card');
      expect(replyCardContent.data.card_id).toBe('crd_mock_12345');

      // 3. Push text 1: sequence = 2
      await session.pushText('Hello');
      expect(calls.cardElementContent.length).toBe(1);
      expect(calls.cardElementContent[0].data.content).toBe('Hello');
      expect(calls.cardElementContent[0].data.sequence).toBe(2);

      // 4. Push text 2: sequence = 3
      await session.pushText('Hello world');
      expect(calls.cardElementContent.length).toBe(2);
      expect(calls.cardElementContent[1].data.content).toBe('Hello world');
      expect(calls.cardElementContent[1].data.sequence).toBe(3);

      // 5. Finalize completed: settings(streaming_mode:false) with seq=4, then card.update with seq=5
      await session.finalize('# Final Answer Header\nCompleted output text', 'completed');
      expect(calls.cardSettings.length).toBe(1);
      const settingsPayload = JSON.parse(calls.cardSettings[0].data.settings);
      expect(settingsPayload.config.streaming_mode).toBe(false);
      expect(calls.cardSettings[0].data.sequence).toBe(4);

      expect(calls.cardUpdate.length).toBe(1);
      expect(calls.cardUpdate[0].data.sequence).toBe(5);
      const finalCardData = JSON.parse(calls.cardUpdate[0].data.card.data);
      expect(finalCardData.schema).toBe('2.0');
      expect(finalCardData.header.template).toBe('green');
      expect(finalCardData.header.title.content).toBe('Custom Title');
      // Body headings should be demoted
      expect(finalCardData.body.elements[0].content).toContain('#### Final Answer Header');
    });

    it('triggers card.settings retry and sequence increments when error code 200850 occurs during pushText', async () => {
      // First call throws 200850, second call succeeds
      const { client, calls } = createMockApiClient({
        contentErrCodes: [200850],
      });

      const transport = new CredentialedLarkTransport({
        account: {
          id: 'acc_stream_test2',
          userId: 'usr_1',
          appId: 'cli_mock_stream',
          appSecret: 'sec_mock_stream',
        },
        clientFactory: {
          createClient: () => client,
        } as LarkSdkClientFactory,
      });

      await transport.start();

      const session = await transport.createStreamingCard({
        chatId: 'oc_test_chat_2',
        replyToMessageId: 'om_parent_123',
      });
      expect(session).not.toBeNull();
      if (!session) throw new Error('Session is null');

      // pushText: initial seq=2 hits 200850 -> settings called with seq=3 -> retry called with seq=4
      await session.pushText('Retrying stream');

      expect(calls.cardElementContent.length).toBe(2);
      expect(calls.cardElementContent[0].data.sequence).toBe(2);
      expect(calls.cardSettings.length).toBe(1);
      const settingsData = JSON.parse(calls.cardSettings[0].data.settings);
      expect(settingsData.config.streaming_mode).toBe(true);
      expect(calls.cardSettings[0].data.sequence).toBe(3);
      expect(calls.cardElementContent[1].data.sequence).toBe(4);
      expect(calls.cardElementContent[1].data.content).toBe('Retrying stream');
    });

    it('falls back to im.v1.message.patch if cardkit.v1.card.update fails during finalize', async () => {
      const { client, calls } = createMockApiClient({
        cardUpdateThrows: true,
      });

      const transport = new CredentialedLarkTransport({
        account: {
          id: 'acc_stream_fallback',
          userId: 'usr_1',
          appId: 'cli_mock_stream',
          appSecret: 'sec_mock_stream',
        },
        clientFactory: {
          createClient: () => client,
        } as LarkSdkClientFactory,
      });

      await transport.start();

      const session = await transport.createStreamingCard({
        chatId: 'oc_test_chat_3',
        replyToMessageId: 'om_parent_321',
      });
      expect(session).not.toBeNull();
      if (!session) throw new Error('Session is null');

      // Finalize should attempt card.update, fail, and succeed on im.patch
      await session.finalize('Fallback answer', 'completed');
      expect(calls.cardUpdate.length).toBe(1);
      expect(calls.imPatch.length).toBe(1);
      expect(calls.imPatch[0].path.message_id).toBe('om_reply_mock_67890');
      const patchedCard = JSON.parse(calls.imPatch[0].data.content);
      expect(patchedCard.header.template).toBe('green');
      expect(patchedCard.body.elements[0].content).toBe('Fallback answer');
    });

    it('formats failed finalize status with red header template and "处理失败" title', async () => {
      const { client, calls } = createMockApiClient();

      const transport = new CredentialedLarkTransport({
        account: {
          id: 'acc_stream_failed',
          userId: 'usr_1',
          appId: 'cli_mock_stream',
          appSecret: 'sec_mock_stream',
        },
        clientFactory: {
          createClient: () => client,
        } as LarkSdkClientFactory,
      });

      await transport.start();

      const session = await transport.createStreamingCard({
        chatId: 'oc_test_chat_4',
        replyToMessageId: 'om_parent_444',
      });
      expect(session).not.toBeNull();
      if (!session) throw new Error('Session is null');

      await session.finalize('', 'failed');
      expect(calls.cardUpdate.length).toBe(1);
      const cardData = JSON.parse(calls.cardUpdate[0].data.card.data);
      expect(cardData.header.template).toBe('red');
      expect(cardData.header.title.content).toBe('处理失败');
      expect(cardData.body.elements[0].content).toBe('(空回复)');
    });

    it('returns null if card.create throws or fails before obtaining message_id', async () => {
      const { client } = createMockApiClient({
        cardCreateThrows: true,
      });

      const transport = new CredentialedLarkTransport({
        account: {
          id: 'acc_stream_err',
          userId: 'usr_1',
          appId: 'cli_mock_stream',
          appSecret: 'sec_mock_stream',
        },
        clientFactory: {
          createClient: () => client,
        } as LarkSdkClientFactory,
      });

      await transport.start();

      const session = await transport.createStreamingCard({
        chatId: 'oc_test_chat_err',
        replyToMessageId: 'om_err_1',
      });

      expect(session).toBeNull();
    });
  });

  describe('(c) FakeLarkTransport streaming session and control toggles', () => {
    it('records card_create, push, and finalize events and obeys streamingCardsEnabled / failStreamingCard toggles', async () => {
      const fakeTransport = new FakeLarkTransport();
      await fakeTransport.start();

      expect(fakeTransport.streamingCardsEnabled).toBe(true);
      expect(fakeTransport.failStreamingCard).toBe(false);

      const session = await fakeTransport.createStreamingCard({
        chatId: 'oc_fake_1',
        title: 'Fake Title',
      });
      expect(session).not.toBeNull();
      if (!session) throw new Error('Session is null');

      expect(session.cardId).toMatch(/^crd_/);
      expect(session.messageId).toMatch(/^om_/);

      await session.pushText('Partial 1');
      await session.pushText('Partial 2');
      await session.finalize('Final text', 'completed');

      expect(fakeTransport.streamingCalls.length).toBe(4);
      expect(fakeTransport.streamingCalls[0].type).toBe('card_create');
      expect(fakeTransport.streamingCalls[1].type).toBe('push');
      expect(fakeTransport.streamingCalls[1].content).toBe('Partial 1');
      expect(fakeTransport.streamingCalls[2].type).toBe('push');
      expect(fakeTransport.streamingCalls[2].content).toBe('Partial 2');
      expect(fakeTransport.streamingCalls[3].type).toBe('finalize');
      expect(fakeTransport.streamingCalls[3].content).toBe('Final text');
      expect(fakeTransport.streamingCalls[3].status).toBe('completed');

      // Test failStreamingCard toggle
      fakeTransport.failStreamingCard = true;
      const failedSession = await fakeTransport.createStreamingCard({ chatId: 'oc_fake_2' });
      expect(failedSession).toBeNull();

      // Test streamingCardsEnabled toggle
      fakeTransport.failStreamingCard = false;
      fakeTransport.streamingCardsEnabled = false;
      const disabledSession = await fakeTransport.createStreamingCard({ chatId: 'oc_fake_3' });
      expect(disabledSession).toBeNull();
    });
  });

  describe('(d) resolveReplyTarget & topic-group reply targeting', () => {
    it('resolveReplyTarget correctly resolves messageId and replyInThread', () => {
      // topic-group params: threadId is omt_, rootId absent
      expect(resolveReplyTarget({ threadId: 'omt_x', replyToMessageId: 'om_y' })).toEqual({
        messageId: 'om_y',
        replyInThread: true,
      });

      // rootId is om_ message
      expect(resolveReplyTarget({ rootId: 'om_root', replyToMessageId: 'om_y' })).toEqual({
        messageId: 'om_root',
        replyInThread: true,
      });

      // plain reply
      expect(resolveReplyTarget({ replyToMessageId: 'om_y' })).toEqual({
        messageId: 'om_y',
        replyInThread: false,
      });

      // never an omt_ value for messageId
      expect(resolveReplyTarget({ rootId: 'omt_not_a_msg', threadId: 'omt_x', replyToMessageId: 'om_y' })).toEqual({
        messageId: 'om_y',
        replyInThread: true,
      });
    });

    it('sendReply and createStreamingCard with topic-group params { threadId: "omt_x", replyToMessageId: "om_y" } target om_y + reply_in_thread: true', async () => {
      const { client, calls } = createMockApiClient();
      const transport = new CredentialedLarkTransport({
        account: {
          id: 'acc_target_test',
          userId: 'usr_1',
          appId: 'cli_mock_stream',
          appSecret: 'sec_mock_stream',
          brand: 'feishu',
        },
        clientFactory: {
          createClient: () => client,
        } as LarkSdkClientFactory,
      });
      await transport.start();

      // 1. sendReply
      await transport.sendReply({
        chatId: 'oc_test',
        threadId: 'omt_x',
        replyToMessageId: 'om_y',
        content: 'hello topic',
      });
      expect(calls.imReply.length).toBe(1);
      expect(calls.imReply[0].path.message_id).toBe('om_y');
      expect(calls.imReply[0].data.reply_in_thread).toBe(true);

      // 2. createStreamingCard
      await transport.createStreamingCard({
        chatId: 'oc_test',
        threadId: 'omt_x',
        replyToMessageId: 'om_y',
      });
      expect(calls.imReply.length).toBe(2);
      expect(calls.imReply[1].path.message_id).toBe('om_y');
      expect(calls.imReply[1].data.reply_in_thread).toBe(true);
    });

    it('sendReply and createStreamingCard with { rootId: "om_root", replyToMessageId: "om_y" } target om_root + reply_in_thread: true', async () => {
      const { client, calls } = createMockApiClient();
      const transport = new CredentialedLarkTransport({
        account: {
          id: 'acc_target_test_2',
          userId: 'usr_1',
          appId: 'cli_mock_stream',
          appSecret: 'sec_mock_stream',
          brand: 'feishu',
        },
        clientFactory: {
          createClient: () => client,
        } as LarkSdkClientFactory,
      });
      await transport.start();

      await transport.sendReply({
        chatId: 'oc_test',
        rootId: 'om_root',
        replyToMessageId: 'om_y',
        content: 'hello root',
      });
      expect(calls.imReply[0].path.message_id).toBe('om_root');
      expect(calls.imReply[0].data.reply_in_thread).toBe(true);

      await transport.createStreamingCard({
        chatId: 'oc_test',
        rootId: 'om_root',
        replyToMessageId: 'om_y',
      });
      expect(calls.imReply[1].path.message_id).toBe('om_root');
      expect(calls.imReply[1].data.reply_in_thread).toBe(true);
    });

    it('sendReply and createStreamingCard with plain { replyToMessageId: "om_y" } target om_y + reply_in_thread: false', async () => {
      const { client, calls } = createMockApiClient();
      const transport = new CredentialedLarkTransport({
        account: {
          id: 'acc_target_test_3',
          userId: 'usr_1',
          appId: 'cli_mock_stream',
          appSecret: 'sec_mock_stream',
          brand: 'feishu',
        },
        clientFactory: {
          createClient: () => client,
        } as LarkSdkClientFactory,
      });
      await transport.start();

      await transport.sendReply({
        chatId: 'oc_test',
        replyToMessageId: 'om_y',
        content: 'hello plain',
      });
      expect(calls.imReply[0].path.message_id).toBe('om_y');
      expect(calls.imReply[0].data.reply_in_thread).toBe(false);

      await transport.createStreamingCard({
        chatId: 'oc_test',
        replyToMessageId: 'om_y',
      });
      expect(calls.imReply[1].path.message_id).toBe('om_y');
      expect(calls.imReply[1].data.reply_in_thread).toBe(false);
    });
  });
});
