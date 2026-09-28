/**
 * WeChat iLink Transport implementation.
 * Provides FakeWeChatTransport for tests and CredentialedWeChatTransport for real long-polling.
 *
 * @module @enkeep/channel-wechat/transport
 */

import crypto from 'node:crypto';
import {
  DEFAULT_BASE_URL,
  DEFAULT_CDN_BASE_URL,
  DEFAULT_LONGPOLL_TIMEOUT_MS,
  ERRCODE_SESSION_EXPIRED,
  LONGPOLL_EXTRA_TIMEOUT_MS,
  MSG_SPLIT_LIMIT,
  RECONNECT_MAX_DELAY_MS,
  RECONNECT_MIN_DELAY_MS,
  buildBaseInfo,
  buildWeChatHeaders,
  classifyWeChatConnectionError,
  jitteredWeChatRetryDelay,
  parseWeChatApiResponse,
  randomWechatUin,
  splitTextChunks,
  weChatConnectionErrorMessage,
} from './http.js';
import {
  assertWeChatApiSuccess,
  parseWeixinMessage,
  processWeChatUpdateBatch,
} from './parser.js';
import type {
  CredentialedWeChatTransport as ICredentialedWeChatTransport,
  WeChatConnectionState,
  WeChatTransportConfig,
  WeChatTransportDeps,
} from './transport-types.js';
import {
  WECHAT_ITEM_TYPE_TEXT,
  WECHAT_MESSAGE_TYPE_BOT,
  type WeChatGetUpdatesResponse,
  type WeChatOutboundReply,
  type WeChatParsedMessage,
  type WeChatTransport,
} from './types.js';

export * from './transport-types.js';
export * from './http.js';

/**
 * Fake WeChat iLink Transport for offline / fixture-based testing.
 */
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

/**
 * Production-ready Credentialed WeChat Transport implementing iLink long polling,
 * atomic cursor commits, retry backoff, and text chunking.
 */
export class CredentialedWeChatTransport implements ICredentialedWeChatTransport {
  private readonly config: WeChatTransportConfig;
  private readonly deps: WeChatTransportDeps;
  private readonly fetchImpl: typeof fetch;
  private readonly random: () => number;
  private readonly now: () => number;

  private readonly baseUrl: string;
  private readonly cdnBaseUrl: string;
  private readonly wechatUin: string;

  private _running = false;
  private _stopping = false;
  private _connected = false;
  private currentCursor: string;

  private pollPromise: Promise<void> | null = null;
  private activePollController: AbortController | null = null;
  private cancelSleep: (() => void) | null = null;

  private longpollTimeoutMs = DEFAULT_LONGPOLL_TIMEOUT_MS;
  private consecutiveFailures = 0;
  private consecutivePollTimeouts = 0;
  private failureStartedAt = 0;
  private lastConnectedAt?: string;

  private readonly messageHandlers = new Set<(msg: WeChatParsedMessage) => Promise<void>>();
  private readonly stateChangeHandlers = new Set<(state: WeChatConnectionState) => void>();
  private readonly cursorCommitHandlers = new Set<(cursor: string) => Promise<void> | void>();

  constructor(config: WeChatTransportConfig, deps: WeChatTransportDeps = {}) {
    this.config = config;
    this.deps = deps;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;

    this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    this.cdnBaseUrl = config.cdnBaseUrl || DEFAULT_CDN_BASE_URL;
    this.currentCursor = config.initialCursor ?? '';
    this.wechatUin = randomWechatUin();
  }

  get connected(): boolean {
    return this._connected && this._running && !this._stopping;
  }

  get running(): boolean {
    return this._running && !this._stopping;
  }

  get cursor(): string {
    return this.currentCursor;
  }

  onStateChange(handler: (state: WeChatConnectionState) => void): void {
    this.stateChangeHandlers.add(handler);
  }

  removeStateChangeHandler(handler: (state: WeChatConnectionState) => void): void {
    this.stateChangeHandlers.delete(handler);
  }

  onCursorCommit(handler: (cursor: string) => Promise<void> | void): void {
    this.cursorCommitHandlers.add(handler);
  }

  removeCursorCommitHandler(handler: (cursor: string) => Promise<void> | void): void {
    this.cursorCommitHandlers.delete(handler);
  }

  onMessage(handler: (msg: WeChatParsedMessage) => Promise<void>): void {
    this.messageHandlers.add(handler);
  }

  removeMessageHandler(handler: (msg: WeChatParsedMessage) => Promise<void>): void {
    this.messageHandlers.delete(handler);
  }

  private publishState(state: WeChatConnectionState): void {
    for (const handler of this.stateChangeHandlers) {
      try {
        handler(state);
      } catch (err) {
        this.deps.logger?.error?.(err, 'Error in onStateChange handler');
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.deps.sleep) {
      return this.deps.sleep(ms);
    }
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.cancelSleep = null;
          resolve();
        }
      }, ms);
      this.cancelSleep = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.cancelSleep = null;
          resolve();
        }
      };
    });
  }

  private async apiPost<T>(
    endpoint: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
    trackAsPoll = false
  ): Promise<T> {
    const rawEndpoint = endpoint.replace(/^\//, '');
    const fullUrl = new URL(
      rawEndpoint,
      this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`
    ).toString();
    const headers = buildWeChatHeaders(this.config.botToken, this.wechatUin);
    const bodyStr = JSON.stringify(body);

    const controller = new AbortController();
    if (trackAsPoll) {
      this.activePollController = controller;
    }
    const timer = timeoutMs
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;

    try {
      const res = await this.fetchImpl(fullUrl, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': String(Buffer.byteLength(bodyStr, 'utf-8')),
        },
        body: bodyStr,
        signal: controller.signal,
      });

      return await parseWeChatApiResponse<T>(res, endpoint);
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'))
      ) {
        throw Object.assign(
          new Error(`WeChat API ${endpoint} timed out`, { cause: err }),
          { code: 'WECHAT_REQUEST_TIMEOUT' }
        );
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      if (trackAsPoll && this.activePollController === controller) {
        this.activePollController = null;
      }
    }
  }

  private async getUpdates(): Promise<WeChatGetUpdatesResponse> {
    const httpTimeout = this.longpollTimeoutMs + LONGPOLL_EXTRA_TIMEOUT_MS;
    return this.apiPost<WeChatGetUpdatesResponse>(
      'ilink/bot/getupdates',
      {
        get_updates_buf: this.currentCursor,
        base_info: buildBaseInfo(),
      },
      httpTimeout,
      true
    );
  }

  private markConnectionHealthy(): void {
    const wasConnected = this._connected;
    this._connected = true;
    this.consecutiveFailures = 0;
    this.consecutivePollTimeouts = 0;
    this.failureStartedAt = 0;
    if (!wasConnected) {
      this.lastConnectedAt = new Date(this.now()).toISOString();
      this.publishState({
        status: 'connected',
        lastConnectedAt: this.lastConnectedAt,
      });
    }
  }

  private async handlePollFailure(
    err: unknown,
    baseDelayMs: number
  ): Promise<void> {
    this._connected = false;
    this.consecutiveFailures += 1;
    if (!this.failureStartedAt) {
      this.failureStartedAt = this.now();
    }
    const errorCode = classifyWeChatConnectionError(err);
    const nextRetryMs = jitteredWeChatRetryDelay(baseDelayMs, this.random);
    const userMessage = weChatConnectionErrorMessage(errorCode);
    this.publishState({
      status: 'reconnecting',
      error: userMessage,
      errorCode,
      consecutiveFailures: this.consecutiveFailures,
      nextRetryMs,
      lastConnectedAt: this.lastConnectedAt,
    });
    await this.sleep(nextRetryMs);
  }

  private async pollLoop(): Promise<void> {
    let reconnectDelay = RECONNECT_MIN_DELAY_MS;

    while (!this._stopping) {
      try {
        const response = await this.getUpdates();
        if (this._stopping) break;

        if (response.longpolling_timeout_ms) {
          this.longpollTimeoutMs = response.longpolling_timeout_ms;
        }

        const responseCode = response.ret ?? response.errcode;

        // Session expired (-14): abort polling loop permanently, do not retry
        if (responseCode === ERRCODE_SESSION_EXPIRED) {
          this._connected = false;
          this.publishState({
            status: 'expired',
            error: '微信授权已过期，请重新扫码连接',
          });
          break;
        }

        if (responseCode !== undefined && responseCode !== 0) {
          throw Object.assign(
            new Error(
              `WeChat getUpdates error: code=${responseCode}, message=${response.errmsg ?? ''}`
            ),
            { code: 'WECHAT_API_ERROR' }
          );
        }

        this.markConnectionHealthy();
        reconnectDelay = RECONNECT_MIN_DELAY_MS;

        if (this._stopping) break;

        // Atomic cursor advancement: only advances if all message handlers
        // and persist handlers succeed without throwing.
        this.currentCursor = await processWeChatUpdateBatch({
          messages: response.msgs ?? [],
          nextCursor: response.get_updates_buf,
          currentCursor: this.currentCursor,
          processMessage: async (rawMsg) => {
            const parsed = parseWeixinMessage(rawMsg);
            if (!parsed || parsed.isFromBot) return;
            for (const handler of this.messageHandlers) {
              await handler(parsed);
            }
          },
          persistCursor: async (nextCursor) => {
            for (const handler of this.cursorCommitHandlers) {
              await handler(nextCursor);
            }
          },
        });
      } catch (err) {
        if (this._stopping) break;

        const errorCode = classifyWeChatConnectionError(err);
        if (this._connected && errorCode === 'request_timeout') {
          this.consecutivePollTimeouts += 1;
          if (this.consecutivePollTimeouts === 1) {
            // Client long-poll timeout while connected is a normal cycle boundary
            continue;
          }
        }

        await this.handlePollFailure(err, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
      }
    }
  }

  async start(initialCursor?: string): Promise<void> {
    if (!this.config.botToken || !this.config.ilinkBotId) {
      throw new Error('WeChat botToken and ilinkBotId are required to start transport');
    }

    if (initialCursor !== undefined) {
      this.currentCursor = initialCursor;
    }

    // Single-poller concurrency guard: ignore if already running
    if (this._running && this.pollPromise) {
      return;
    }

    this._stopping = false;
    this._running = true;
    this._connected = false;
    this.consecutiveFailures = 0;
    this.consecutivePollTimeouts = 0;
    this.failureStartedAt = 0;

    this.publishState({ status: 'connecting' });

    this.pollPromise = this.pollLoop()
      .catch((err) => {
        this._connected = false;
        if (!this._stopping) {
          this.publishState({
            status: 'disconnected',
            error: err instanceof Error ? err.message : String(err),
            lastConnectedAt: this.lastConnectedAt,
          });
        }
      })
      .finally(() => {
        this._running = false;
        this.pollPromise = null;
      });
  }

  async stop(): Promise<void> {
    this._stopping = true;
    this._connected = false;

    if (this.activePollController) {
      this.activePollController.abort();
      this.activePollController = null;
    }

    if (this.cancelSleep) {
      this.cancelSleep();
      this.cancelSleep = null;
    }

    const pending = this.pollPromise;
    if (pending) {
      await pending;
    }

    this._running = false;
    this.publishState({
      status: 'disconnected',
      lastConnectedAt: this.lastConnectedAt,
    });
  }

  async sendReply(
    toUserId: string,
    contextToken: string,
    text: string
  ): Promise<{ success: boolean; error?: string; messageId?: string }> {
    if (!this._running) {
      return {
        success: false,
        error: 'CredentialedWeChatTransport is not running',
      };
    }

    if (!contextToken) {
      return {
        success: false,
        error: 'Missing required context_token for WeChat reply',
      };
    }

    try {
      const chunks = splitTextChunks(text, MSG_SPLIT_LIMIT);
      let lastMessageId = '';

      for (const chunk of chunks) {
        const clientId = String(crypto.randomBytes(4).readUInt32BE(0));
        const resp = await this.apiPost<WeChatGetUpdatesResponse>(
          'ilink/bot/sendmessage',
          {
            msg: {
              to_user_id: toUserId,
              context_token: contextToken,
              item_list: [
                {
                  type: WECHAT_ITEM_TYPE_TEXT,
                  text_item: { text: chunk },
                },
              ],
              message_type: WECHAT_MESSAGE_TYPE_BOT,
              message_state: 2, // MESSAGE_STATE_FINISH
              client_id: clientId,
            },
            base_info: buildBaseInfo(),
          }
        );

        assertWeChatApiSuccess(resp, 'sendMessage');
        lastMessageId = clientId;
      }

      return {
        success: true,
        messageId: `msg_wc_${lastMessageId}`,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async sendTyping(
    toUserId: string,
    contextToken: string,
    isTyping: boolean
  ): Promise<void> {
    if (!contextToken) return;

    try {
      const configRes = await this.apiPost<{ typing_ticket?: string }>(
        'ilink/bot/getconfig',
        {
          ilink_user_id: toUserId,
          context_token: contextToken,
          base_info: buildBaseInfo(),
        }
      );

      const ticket = configRes?.typing_ticket;
      if (!ticket) return;

      await this.apiPost('ilink/bot/sendtyping', {
        ilink_user_id: toUserId,
        typing_ticket: ticket,
        status: isTyping ? 1 : 2,
        base_info: buildBaseInfo(),
      });
    } catch (err) {
      this.deps.logger?.debug?.(err, 'WeChat sendTyping failed');
    }
  }
}

/**
 * Factory for creating a CredentialedWeChatTransport instance.
 */
export function createWeChatTransport(
  config: WeChatTransportConfig,
  deps: WeChatTransportDeps = {}
): CredentialedWeChatTransport {
  return new CredentialedWeChatTransport(config, deps);
}
