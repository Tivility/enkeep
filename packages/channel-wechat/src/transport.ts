/**
 * Fake WeChat iLink Transport for offline / fixture-based testing.
 *
 * @module @enkeep/channel-wechat/transport
 */

import { parseWeixinMessage, processWeChatUpdateBatch } from './parser.js';
import type {
  WeChatGetUpdatesResponse,
  WeChatOutboundReply,
  WeChatParsedMessage,
  WeChatTransport,
} from './types.js';

export class FakeWeChatTransport implements WeChatTransport {
  private _connected = false;
  private currentCursor = '';
  private readonly messageHandlers = new Set<(msg: WeChatParsedMessage) => Promise<void>>();
  private readonly _sentReplies: WeChatOutboundReply[] = [];
  public failNextSend = false;
  public failNextSendReason = 'Simulated network timeout';

  get connected(): boolean {
    return this._connected;
  }

  get sentReplies(): readonly WeChatOutboundReply[] {
    return this._sentReplies;
  }

  get cursor(): string {
    return this.currentCursor;
  }

  async start(initialCursor = ''): Promise<void> {
    this._connected = true;
    this.currentCursor = initialCursor;
  }

  async stop(): Promise<void> {
    this._connected = false;
  }

  onMessage(handler: (msg: WeChatParsedMessage) => Promise<void>): void {
    this.messageHandlers.add(handler);
  }

  removeMessageHandler(handler: (msg: WeChatParsedMessage) => Promise<void>): void {
    this.messageHandlers.delete(handler);
  }

  /**
   * Simulate receiving a long-poll batch from Tencent iLink server.
   */
  async simulateIncomingUpdates(response: WeChatGetUpdatesResponse): Promise<void> {
    if (!this._connected) {
      throw new Error('FakeWeChatTransport is not connected; cannot receive updates');
    }

    const messages = response.msgs ?? [];
    this.currentCursor = await processWeChatUpdateBatch({
      messages,
      nextCursor: response.get_updates_buf,
      currentCursor: this.currentCursor,
      processMessage: async (rawMsg) => {
        const parsed = parseWeixinMessage(rawMsg);
        if (!parsed || parsed.isFromBot) return;
        for (const handler of this.messageHandlers) {
          await handler(parsed);
        }
      },
    });
  }

  /**
   * Send outbound reply using recipient ID and context_token.
   */
  async sendReply(
    toUserId: string,
    contextToken: string,
    text: string
  ): Promise<{ success: boolean; error?: string; messageId?: string }> {
    if (!this._connected) {
      return {
        success: false,
        error: 'FakeWeChatTransport is not connected',
      };
    }

    if (!contextToken) {
      return {
        success: false,
        error: 'Missing required context_token for WeChat reply',
      };
    }

    if (this.failNextSend) {
      this.failNextSend = false;
      return {
        success: false,
        error: this.failNextSendReason,
      };
    }

    const messageId = `msg_wc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const reply: WeChatOutboundReply = {
      toUserId,
      contextToken,
      text,
      messageId,
      timestamp: new Date().toISOString(),
    };

    this._sentReplies.push(reply);
    return {
      success: true,
      messageId,
    };
  }
}
