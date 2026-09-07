/**
 * Lark Transport implementations.
 * Provides FakeLarkTransport for testing / offline closed-loop execution,
 * and CredentialedLarkTransport for production integration with @larksuiteoapi/node-sdk.
 *
 * @module @enkeep/channel-lark/transport
 */

import * as lark from '@larksuiteoapi/node-sdk';
import {
  REAL_LARK_CREDENTIAL_ACCEPTANCE,
  REAL_LARK_CREDENTIAL_SKIP_REASON,
  type LarkAccountConfig,
  type LarkCredentialResolver,
  type LarkEventHandler,
  type LarkRawEvent,
  type LarkSdkClientFactory,
  type LarkStreamingCardSession,
  type LarkTransport,
  type OutboundReplyResult,
  type ILarkApiClient,
  type ILarkWSClient,
} from './types.js';
import { optimizeMarkdownStyle, chunkMarkdown } from './markdown-card.js';

/**
 * Sanitized safe logger for Lark SDK.
 * Strips sensitive Authorization headers, appSecrets, and suppresses raw Axios config/request objects.
 */
export class SanitizedLarkLogger implements lark.Logger {
  error(...args: any[]): void {
    const sanitized = args.map((arg) => {
      if (arg instanceof Error) {
        return `${arg.name}: ${arg.message}`;
      }
      if (typeof arg === 'string') {
        return arg
          .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [REDACTED]')
          .replace(/"app_?secret"\s*:\s*"[^"]+"/gi, '"app_secret":"[REDACTED]"');
      }
      if (typeof arg === 'object' && arg !== null) {
        const safe: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(arg)) {
          if (/secret|token|auth|key|password/i.test(k)) {
            safe[k] = '[REDACTED]';
          } else {
            safe[k] = v;
          }
        }
        return safe;
      }
      return '[Sanitized Object]';
    });
    console.error(...sanitized);
  }

  warn(...args: any[]): void {
    const sanitized = args.map((arg) => {
      if (arg instanceof Error) {
        return `${arg.name}: ${arg.message}`;
      }
      if (typeof arg === 'string') {
        return arg
          .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [REDACTED]')
          .replace(/"app_?secret"\s*:\s*"[^"]+"/gi, '"app_secret":"[REDACTED]"');
      }
      if (typeof arg === 'object' && arg !== null) {
        const safe: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(arg)) {
          if (/secret|token|auth|key|password/i.test(k)) {
            safe[k] = '[REDACTED]';
          } else {
            safe[k] = v;
          }
        }
        return safe;
      }
      return '[Sanitized Object]';
    });
    console.warn(...sanitized);
  }

  info(): void {}
  debug(): void {}
  trace(): void {}
}

/**
 * Creates a bounded HttpInstance with 15s socket/HTTP timeout and standard SDK response unwrapping.
 */
export function createBoundedHttpInstance(timeoutMs = 15000): lark.HttpInstance {
  const instance = lark.defaultHttpInstance.create({
    timeout: timeoutMs,
  });
  instance.interceptors.response.use((resp: any) => {
    if (resp && resp.config && resp.config['$return_headers']) {
      return {
        data: resp.data,
        headers: resp.headers,
      };
    }
    return resp ? resp.data : resp;
  });
  return instance as unknown as lark.HttpInstance;
}

export const LARK_THREAD_REPLY_UNSUPPORTED_CODES = new Set([230071, 230072]);

export interface ReplyTargetResolution {
  messageId?: string;
  replyInThread: boolean;
}

export function resolveReplyTarget(params: {
  rootId?: string;
  threadId?: string;
  replyToMessageId?: string;
}): ReplyTargetResolution {
  const replyInThread = Boolean(params.rootId || params.threadId);
  let messageId: string | undefined;

  if (params.rootId && /^om_/.test(params.rootId)) {
    messageId = params.rootId;
  } else if (params.replyToMessageId && !params.replyToMessageId.startsWith('omt_')) {
    messageId = params.replyToMessageId;
  }

  return { messageId, replyInThread };
}

export function getLarkApiErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    const match = String(error).match(/code[=:]\s*(\d+)/i);
    return match ? Number(match[1]) : undefined;
  }
  const value = error as {
    code?: number;
    message?: string;
    response?: { code?: number; data?: { code?: number } };
  };
  if (typeof value.code === 'number') return value.code;
  if (typeof value.response?.data?.code === 'number') {
    return value.response.data.code;
  }
  if (typeof value.response?.code === 'number') return value.response.code;
  const match = value.message?.match(/code[=:]\s*(\d+)/i);
  return match ? Number(match[1]) : undefined;
}

export interface SentReplyRecord {
  readonly chatId: string;
  readonly rootId?: string;
  readonly threadId?: string;
  readonly replyToMessageId?: string;
  readonly content: string;
  readonly format?: 'plain' | 'markdown';
  readonly uuid?: string;
  readonly timestamp: string;
  readonly messageId: string;
}

export interface FakeReactionRecord {
  readonly messageId: string;
  readonly emojiType: string;
  readonly reactionId: string;
  readonly timestamp: string;
}

export interface FakeRemovedReactionRecord {
  readonly messageId: string;
  readonly reactionId: string;
  readonly timestamp: string;
}

export interface FakeStreamingCallRecord {
  readonly type: 'card_create' | 'push' | 'finalize';
  readonly cardId?: string;
  readonly messageId?: string;
  readonly content?: string;
  readonly status?: 'completed' | 'failed';
  readonly params?: any;
  readonly timestamp: string;
}

export class FakeLarkTransport implements LarkTransport {
  private _connected = false;
  private readonly handlers = new Set<LarkEventHandler>();
  private readonly _sentReplies: SentReplyRecord[] = [];
  private readonly _addedReactions: FakeReactionRecord[] = [];
  private readonly _removedReactions: FakeRemovedReactionRecord[] = [];
  private readonly _streamingCalls: FakeStreamingCallRecord[] = [];
  public failNextSend = false;
  public failNextSendReason = 'Simulated network timeout';
  public botOpenId?: string;
  public streamingCardsEnabled = true;
  public failStreamingCard = false;
  public finalizeDelayMs = 0;

  get connected(): boolean {
    return this._connected;
  }

  get sentReplies(): readonly SentReplyRecord[] {
    return this._sentReplies;
  }

  get addedReactions(): readonly FakeReactionRecord[] {
    return this._addedReactions;
  }

  get removedReactions(): readonly FakeRemovedReactionRecord[] {
    return this._removedReactions;
  }

  get streamingCalls(): readonly FakeStreamingCallRecord[] {
    return this._streamingCalls;
  }

  async start(): Promise<void> {
    this._connected = true;
  }

  async stop(): Promise<void> {
    this._connected = false;
  }

  onEvent(handler: LarkEventHandler): void {
    this.handlers.add(handler);
  }

  removeEventHandler(handler: LarkEventHandler): void {
    this.handlers.delete(handler);
  }

  async simulateInboundEvent(event: LarkRawEvent): Promise<void> {
    if (!this._connected) {
      throw new Error('FakeLarkTransport is disconnected; cannot receive inbound events');
    }
    const promises = Array.from(this.handlers).map((h) => h(event));
    await Promise.all(promises);
  }

  async addReaction(messageId: string, emojiType: string): Promise<{ reactionId?: string }> {
    const reactionId = `rx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this._addedReactions.push({
      messageId,
      emojiType,
      reactionId,
      timestamp: new Date().toISOString(),
    });
    return { reactionId };
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    this._removedReactions.push({
      messageId,
      reactionId,
      timestamp: new Date().toISOString(),
    });
  }

  clearReactions(): void {
    this._addedReactions.length = 0;
    this._removedReactions.length = 0;
  }

  async sendReply(params: {
    chatId: string;
    rootId?: string;
    threadId?: string;
    replyToMessageId?: string;
    content: string;
    format?: 'plain' | 'markdown';
    uuid?: string;
  }): Promise<OutboundReplyResult> {
    if (!this._connected) {
      return {
        success: false,
        error: 'FakeLarkTransport is not connected',
      };
    }

    if (this.failNextSend) {
      this.failNextSend = false;
      return {
        success: false,
        error: this.failNextSendReason,
      };
    }

    const replyMsgId = `om_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record: SentReplyRecord = {
      chatId: params.chatId,
      rootId: params.rootId,
      threadId: params.threadId,
      replyToMessageId: params.replyToMessageId,
      content: params.content,
      format: params.format ?? 'plain',
      uuid: params.uuid,
      timestamp: new Date().toISOString(),
      messageId: replyMsgId,
    };
    this._sentReplies.push(record);

    return {
      success: true,
      messageId: replyMsgId,
    };
  }

  async createStreamingCard(params: {
    chatId: string;
    replyToMessageId?: string;
    rootId?: string;
    threadId?: string;
    title?: string;
  }): Promise<LarkStreamingCardSession | null> {
    if (!this._connected || !this.streamingCardsEnabled || this.failStreamingCard) {
      console.warn('[lark-stream] createStreamingCard returned null', {
        connected: this._connected,
        streamingCardsEnabled: this.streamingCardsEnabled,
        failStreamingCard: this.failStreamingCard,
      });
      return null;
    }

    const cardId = `crd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const messageId = `om_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    this._streamingCalls.push({
      type: 'card_create',
      cardId,
      messageId,
      params,
      timestamp: new Date().toISOString(),
    });

    const session: LarkStreamingCardSession = {
      cardId,
      messageId,
      pushText: async (accumulatedText: string): Promise<void> => {
        this._streamingCalls.push({
          type: 'push',
          cardId,
          messageId,
          content: accumulatedText,
          timestamp: new Date().toISOString(),
        });
      },
      finalize: async (finalText: string, status: 'completed' | 'failed'): Promise<void> => {
        if (this.finalizeDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.finalizeDelayMs));
        }
        this._streamingCalls.push({
          type: 'finalize',
          cardId,
          messageId,
          content: finalText,
          status,
          timestamp: new Date().toISOString(),
        });
      },
    };

    return session;
  }

  simulateDisconnect(): void {
    this._connected = false;
  }

  simulateReconnect(): void {
    this._connected = true;
  }

  clearSentReplies(): void {
    this._sentReplies.length = 0;
    this._streamingCalls.length = 0;
  }

  clearStreamingCalls(): void {
    this._streamingCalls.length = 0;
  }
}

export interface CredentialedLarkTransportOptions {
  account: LarkAccountConfig;
  credentialResolver?: LarkCredentialResolver;
  clientFactory?: LarkSdkClientFactory;
  autoConnect?: boolean;
}

/**
 * Production Lark Transport using official @larksuiteoapi/node-sdk.
 * Credentials resolved via injected resolver. Supports domain selection (Feishu vs Lark),
 * WSClient long-connection with 15000ms handshake timeout, SanitizedLarkLogger to prevent credential leakage,
 * real onReady lifecycle, openapi Client for replies with stable uuid idempotency, bounded HTTP timeout, and bot identity resolution.
 */
export class CredentialedLarkTransport implements LarkTransport {
  private readonly account: LarkAccountConfig;
  private readonly credentialResolver?: LarkCredentialResolver;
  private readonly clientFactory?: LarkSdkClientFactory;
  private _connected = false;
  private _connecting = false;
  private readonly handlers = new Set<LarkEventHandler>();
  private wsClient: ILarkWSClient | null = null;
  private apiClient: any = null;
  private _resolvedBotOpenId?: string;
  private readonly logger = new SanitizedLarkLogger();

  constructor(options: LarkAccountConfig | CredentialedLarkTransportOptions) {
    if ('account' in options) {
      this.account = options.account;
      this.credentialResolver = options.credentialResolver;
      this.clientFactory = options.clientFactory;
    } else {
      this.account = options;
    }
    this._resolvedBotOpenId = this.account.botOpenId;
  }

  get connected(): boolean {
    if (this.wsClient && typeof this.wsClient.getConnectionStatus === 'function') {
      const status = this.wsClient.getConnectionStatus();
      if (typeof status === 'object' && status !== null && 'state' in status) {
        return status.state === 'connected';
      }
      return status === 'connected';
    }
    return this._connected;
  }

  get connecting(): boolean {
    return this._connecting;
  }

  get botOpenId(): string | undefined {
    return this._resolvedBotOpenId || this.account.botOpenId;
  }

  get skipReason(): string {
    return REAL_LARK_CREDENTIAL_SKIP_REASON;
  }

  get acceptanceStatus(): typeof REAL_LARK_CREDENTIAL_ACCEPTANCE {
    return REAL_LARK_CREDENTIAL_ACCEPTANCE;
  }

  async start(): Promise<void> {
    // 1. Resolve credentials
    let appId = this.account.appId;
    let appSecret = this.account.appSecret;
    let brand = this.account.brand ?? 'feishu';

    if (this.credentialResolver && this.account.credentialRef) {
      const resolved = await this.credentialResolver.resolve(
        this.account.userId,
        this.account.credentialRef
      );
      if (resolved) {
        appId = resolved.appId;
        appSecret = resolved.appSecret;
        if (resolved.domain) {
          brand = resolved.domain;
        }
        if (resolved.botOpenId) {
          this._resolvedBotOpenId = resolved.botOpenId;
        }
      }
    }

    if (!appId || !appSecret) {
      // In absence of valid appId/appSecret, do not fake online.
      this._connected = false;
      this._connecting = false;
      return;
    }

    const domain = brand === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;
    const boundedHttpInstance = createBoundedHttpInstance(15000);
    const sanitizedLogger = this.logger;

    // 2. Initialize API Client with sanitized logger
    if (this.clientFactory) {
      this.apiClient = this.clientFactory.createClient({ appId, appSecret, domain });
    } else {
      this.apiClient = new lark.Client({
        appId,
        appSecret,
        domain,
        httpInstance: boundedHttpInstance,
        logger: sanitizedLogger,
        loggerLevel: lark.LoggerLevel.error,
      });
    }

    // 2b. If botOpenId not provided, query /open-apis/bot/v3/info
    if (!this._resolvedBotOpenId && this.apiClient) {
      try {
        if (typeof this.apiClient.request === 'function') {
          const infoRes = await this.apiClient.request({
            url: '/open-apis/bot/v3/info',
            method: 'GET',
          });
          if (infoRes?.bot?.open_id) {
            this._resolvedBotOpenId = infoRes.bot.open_id;
          }
        }
      } catch {
        // Fall back to mentions by appId if bot/v3/info query fails or in mock
      }
    }

    // 3. Initialize Event Dispatcher & WSClient with sanitized logger and 15000ms handshakeTimeoutMs
    const eventDispatcher = new lark.EventDispatcher({
      logger: sanitizedLogger,
    } as any).register({
      'im.message.receive_v1': async (data: any) => {
        // SDK EventDispatcher provides flattened data (data.sender, data.message, data.event_id, etc.)
        const rawEvent: LarkRawEvent = {
          header: data.header ?? {
            event_id: data.event_id,
            event_type: data.event_type ?? 'im.message.receive_v1',
            create_time: data.create_time,
            token: data.token,
            app_id: data.app_id,
            tenant_key: data.tenant_key,
          },
          event: data.event ?? {
            sender: data.sender,
            message: data.message,
          },
          sender: data.sender ?? data.event?.sender,
          message: data.message ?? data.event?.message,
          uuid: data.uuid,
        };
        const promises = Array.from(this.handlers).map((h) => h(rawEvent));
        await Promise.all(promises);
      },
    });

    const onReadyCallback = () => {
      this._connected = true;
      this._connecting = false;
    };
    const onErrorCallback = (_err: Error) => {
      this._connected = false;
    };
    const onReconnectingCallback = () => {
      this._connected = false;
      this._connecting = true;
    };
    const onReconnectedCallback = () => {
      this._connected = true;
      this._connecting = false;
    };

    this._connecting = true;
    try {
      if (this.clientFactory && this.clientFactory.createWSClient) {
        this.wsClient = this.clientFactory.createWSClient({
          appId,
          appSecret,
          domain,
          logger: sanitizedLogger,
          loggerLevel: lark.LoggerLevel.error,
          handshakeTimeoutMs: 15000,
          onReady: onReadyCallback,
          onError: onErrorCallback,
          onReconnecting: onReconnectingCallback,
          onReconnected: onReconnectedCallback,
        });
      } else {
        this.wsClient = new lark.WSClient({
          appId,
          appSecret,
          domain,
          httpInstance: boundedHttpInstance,
          logger: sanitizedLogger,
          loggerLevel: lark.LoggerLevel.error,
          handshakeTimeoutMs: 15000,
          onReady: onReadyCallback,
          onError: onErrorCallback,
          onReconnecting: onReconnectingCallback,
          onReconnected: onReconnectedCallback,
        });
      }

      // Start WSClient with eventDispatcher
      if (this.wsClient && typeof this.wsClient.start === 'function') {
        await this.wsClient.start({ eventDispatcher });
      }

      // If WSClient provides getConnectionStatus, check if state is connected
      if (this.wsClient && typeof this.wsClient.getConnectionStatus === 'function') {
        const status = this.wsClient.getConnectionStatus();
        if (typeof status === 'object' && status !== null && 'state' in status) {
          this._connected = status.state === 'connected';
        }
      }
      this._connecting = false;
    } catch (err) {
      this._connected = false;
      this._connecting = false;
      throw err;
    }
  }

  async stop(): Promise<void> {
    this._connected = false;
    this._connecting = false;
    if (this.wsClient) {
      try {
        if (typeof this.wsClient.close === 'function') {
          await this.wsClient.close();
        }
      } catch {
        // Ignore close error on shutdown
      }
      this.wsClient = null;
    }
    this.apiClient = null;
  }

  onEvent(handler: LarkEventHandler): void {
    this.handlers.add(handler);
  }

  removeEventHandler(handler: LarkEventHandler): void {
    this.handlers.delete(handler);
  }

  async addReaction(messageId: string, emojiType: string): Promise<{ reactionId?: string }> {
    if (!this.apiClient) {
      return {};
    }
    try {
      const reactionApi = this.apiClient.im?.v1?.messageReaction || this.apiClient.im?.messageReaction;
      if (!reactionApi || typeof reactionApi.create !== 'function') {
        return {};
      }
      const res = await reactionApi.create({
        path: {
          message_id: messageId,
        },
        data: {
          reaction_type: {
            emoji_type: emojiType,
          },
        },
      });
      const reactionId = res?.data?.reaction_id;
      return { reactionId };
    } catch {
      return {};
    }
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    if (!this.apiClient || !reactionId) {
      return;
    }
    try {
      const reactionApi = this.apiClient.im?.v1?.messageReaction || this.apiClient.im?.messageReaction;
      if (!reactionApi || typeof reactionApi.delete !== 'function') {
        return;
      }
      await reactionApi.delete({
        path: {
          message_id: messageId,
          reaction_id: reactionId,
        },
      });
    } catch {
      // Best-effort; ignore errors
    }
  }

  /**
   * Send reply using official SDK API.
   * Uses plain text format. Chooses reply or create message based on replyToMessageId/rootId.
   * Passes stable uuid for idempotency in API params/payload.
   */
  async sendReply(params: {
    chatId: string;
    rootId?: string;
    threadId?: string;
    replyToMessageId?: string;
    content: string;
    format?: 'plain' | 'markdown';
    uuid?: string;
  }): Promise<OutboundReplyResult> {
    if (!this.apiClient) {
      return {
        success: false,
        error: `Live Lark reply skipped (${REAL_LARK_CREDENTIAL_ACCEPTANCE}): ${REAL_LARK_CREDENTIAL_SKIP_REASON}`,
      };
    }

    try {
      const textContent = JSON.stringify({ text: params.content });
      const target = resolveReplyTarget({
        rootId: params.rootId,
        threadId: params.threadId,
        replyToMessageId: params.replyToMessageId,
      });

      if (target.messageId) {
        const doReply = async (replyInThread: boolean, msgId: string) => {
          const replyFn =
            this.apiClient.im?.message?.reply || this.apiClient.im?.v1?.message?.reply;
          return await replyFn({
            path: {
              message_id: msgId,
            },
            params: params.uuid ? { uuid: params.uuid } : undefined,
            data: {
              content: textContent,
              msg_type: 'text',
              reply_in_thread: replyInThread,
              uuid: params.uuid,
            },
          });
        };

        const fallbackTarget =
          params.replyToMessageId && !params.replyToMessageId.startsWith('omt_')
            ? params.replyToMessageId
            : target.messageId;

        let res: any;
        try {
          res = await doReply(target.replyInThread, target.messageId);
        } catch (firstErr) {
          const errCode = getLarkApiErrorCode(firstErr);
          if (target.replyInThread && errCode && LARK_THREAD_REPLY_UNSUPPORTED_CODES.has(errCode) && fallbackTarget) {
            res = await doReply(false, fallbackTarget);
          } else {
            throw firstErr;
          }
        }

        // If returned response contains unsupported code (some SDK responses return non-zero code instead of throwing)
        if (target.replyInThread && res?.code && LARK_THREAD_REPLY_UNSUPPORTED_CODES.has(res.code) && fallbackTarget) {
          res = await doReply(false, fallbackTarget);
        }

        if (res?.code === 0 || res?.data?.message_id) {
          return {
            success: true,
            messageId: res.data?.message_id,
          };
        } else {
          return {
            success: false,
            error: res?.msg || `Lark API reply failed with code ${res?.code}`,
          };
        }
      } else {
        const res = await this.apiClient.im.message.create({
          params: {
            receive_id_type: 'chat_id',
            ...(params.uuid ? { uuid: params.uuid } : {}),
          },
          data: {
            receive_id: params.chatId,
            content: textContent,
            msg_type: 'text',
            uuid: params.uuid,
          },
        });

        if (res?.code === 0 || res?.data?.message_id) {
          return {
            success: true,
            messageId: res.data?.message_id,
          };
        } else {
          return {
            success: false,
            error: res?.msg || `Lark API create message failed with code ${res?.code}`,
          };
        }
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown Lark API error',
      };
    }
  }

  /**
   * Create a CardKit Schema 2.0 streaming card session.
   * Creates the card entity via CardKit, sends it using IM message reply/create,
   * and returns a session to push streaming text and finalize upon turn completion.
   */
  async createStreamingCard(params: {
    chatId: string;
    replyToMessageId?: string;
    rootId?: string;
    threadId?: string;
    title?: string;
  }): Promise<LarkStreamingCardSession | null> {
    if (!this.apiClient) {
      this.logger.warn('[lark-stream] createStreamingCard failed: no apiClient');
      return null;
    }

    try {
      const cardCreateFn = this.apiClient.cardkit?.v1?.card?.create;
      if (typeof cardCreateFn !== 'function') {
        this.logger.warn('[lark-stream] createStreamingCard failed: cardkit.v1.card.create is not a function');
        return null;
      }

      // 1. Build schema 2.0 card JSON
      const initialCard = {
        schema: '2.0',
        config: {
          update_multi: true,
          streaming_mode: true,
        },
        header: {
          title: {
            tag: 'plain_text',
            content: params.title ?? 'Enkeep',
          },
          template: 'blue',
        },
        body: {
          direction: 'vertical',
          elements: [
            {
              tag: 'markdown',
              element_id: 'main_content',
              content: '正在思考…',
            },
          ],
        },
      };

      // 2. cardkit.v1.card.create({ data: { type: 'card_json', data: JSON.stringify(card) } })
      const cardCreateRes = await this.apiClient.cardkit.v1.card.create({
        data: {
          type: 'card_json',
          data: JSON.stringify(initialCard),
        },
      });

      const cardId = cardCreateRes?.data?.card_id;
      if (!cardId) {
        this.logger.warn('[lark-stream] createStreamingCard failed: no card_id', {
          code: cardCreateRes?.code,
          message: cardCreateRes?.msg,
        });
        return null;
      }

      let seq = 1;

      // 3. Send: reuse the SAME thread targeting rule as sendReply
      const target = resolveReplyTarget({
        rootId: params.rootId,
        threadId: params.threadId,
        replyToMessageId: params.replyToMessageId,
      });

      const cardContent = JSON.stringify({
        type: 'card',
        data: { card_id: cardId },
      });

      let messageId: string | undefined;

      const replyFn =
        this.apiClient.im?.message?.reply || this.apiClient.im?.v1?.message?.reply;
      const messageCreateFn =
        this.apiClient.im?.message?.create || this.apiClient.im?.v1?.message?.create;

      if (target.messageId) {
        if (typeof replyFn !== 'function') {
          this.logger.warn('[lark-stream] createStreamingCard failed: im.message.reply is not a function');
          return null;
        }

        const doReply = async (replyInThread: boolean, msgId: string) => {
          return await replyFn({
            path: {
              message_id: msgId,
            },
            data: {
              content: cardContent,
              msg_type: 'interactive',
              reply_in_thread: replyInThread,
            },
          });
        };

        const fallbackTarget =
          params.replyToMessageId && !params.replyToMessageId.startsWith('omt_')
            ? params.replyToMessageId
            : target.messageId;

        let res: any;
        try {
          res = await doReply(target.replyInThread, target.messageId);
        } catch (firstErr) {
          const errCode = getLarkApiErrorCode(firstErr);
          if (target.replyInThread && errCode && LARK_THREAD_REPLY_UNSUPPORTED_CODES.has(errCode) && fallbackTarget) {
            res = await doReply(false, fallbackTarget);
          } else {
            this.logger.warn('[lark-stream] createStreamingCard reply error', {
              code: errCode,
              message: firstErr instanceof Error ? firstErr.message : String(firstErr),
            });
            throw firstErr;
          }
        }

        if (target.replyInThread && res?.code && LARK_THREAD_REPLY_UNSUPPORTED_CODES.has(res.code) && fallbackTarget) {
          res = await doReply(false, fallbackTarget);
        }

        if (res?.code === 0 || res?.data?.message_id) {
          messageId = res.data?.message_id;
        } else {
          this.logger.warn('[lark-stream] createStreamingCard reply failed', {
            code: res?.code,
            message: res?.msg,
          });
          return null;
        }
      } else {
        if (typeof messageCreateFn !== 'function') {
          this.logger.warn('[lark-stream] createStreamingCard failed: im.message.create is not a function');
          return null;
        }

        const res = await messageCreateFn({
          params: {
            receive_id_type: 'chat_id',
          },
          data: {
            receive_id: params.chatId,
            content: cardContent,
            msg_type: 'interactive',
          },
        });

        if (res?.code === 0 || res?.data?.message_id) {
          messageId = res.data?.message_id;
        } else {
          this.logger.warn('[lark-stream] createStreamingCard message create failed', {
            code: res?.code,
            message: res?.msg,
          });
          return null;
        }
      }

      if (!messageId) {
        this.logger.warn('[lark-stream] createStreamingCard failed: no message_id obtained');
        return null;
      }

      const boundMessageId = messageId;
      const logger = this.logger;
      const client = this.apiClient;

      // 4. Return streaming card session
      const session: LarkStreamingCardSession = {
        cardId,
        messageId: boundMessageId,
        pushText: async (accumulatedText: string): Promise<void> => {
          try {
            const contentFn = client.cardkit?.v1?.cardElement?.content;
            if (typeof contentFn !== 'function') return;

            seq += 1;
            let res: any;
            try {
              res = await contentFn({
                path: {
                  card_id: cardId,
                  element_id: 'main_content',
                },
                data: {
                  content: accumulatedText,
                  sequence: seq,
                },
              });
            } catch (contentErr) {
              const errCode = getLarkApiErrorCode(contentErr);
              if (errCode === 200850 || errCode === 300309) {
                // Re-enable streaming mode and retry once
                seq += 1;
                const settingsFn = client.cardkit?.v1?.card?.settings;
                if (typeof settingsFn === 'function') {
                  try {
                    await settingsFn({
                      path: { card_id: cardId },
                      data: {
                        settings: JSON.stringify({ config: { streaming_mode: true } }),
                        sequence: seq,
                      },
                    });
                  } catch (settingsErr) {
                    logger.warn('[lark-stream] settings streaming_mode retry failed', {
                      code: (settingsErr as any)?.code,
                      message: settingsErr instanceof Error ? settingsErr.message : String(settingsErr),
                    });
                  }
                }
                seq += 1;
                await contentFn({
                  path: {
                    card_id: cardId,
                    element_id: 'main_content',
                  },
                  data: {
                    content: accumulatedText,
                    sequence: seq,
                  },
                });
                return;
              }
              logger.warn('[lark-stream] pushText failed', {
                code: errCode,
                message: contentErr instanceof Error ? contentErr.message : String(contentErr),
              });
              return;
            }

            // Check non-throwing error code in response
            if (res?.code === 200850 || res?.code === 300309) {
              seq += 1;
              const settingsFn = client.cardkit?.v1?.card?.settings;
              if (typeof settingsFn === 'function') {
                try {
                  await settingsFn({
                    path: { card_id: cardId },
                    data: {
                      settings: JSON.stringify({ config: { streaming_mode: true } }),
                      sequence: seq,
                    },
                  });
                } catch (settingsErr) {
                  logger.warn('[lark-stream] settings streaming_mode retry failed', {
                    code: (settingsErr as any)?.code,
                    message: settingsErr instanceof Error ? settingsErr.message : String(settingsErr),
                  });
                }
              }
              seq += 1;
              await contentFn({
                path: {
                  card_id: cardId,
                  element_id: 'main_content',
                },
                data: {
                  content: accumulatedText,
                  sequence: seq,
                },
              });
            }
          } catch (err) {
            logger.warn('[lark-stream] pushText error', {
              code: (err as any)?.code,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        },
        finalize: async (finalText: string, status: 'completed' | 'failed'): Promise<void> => {
          // Close streaming mode via card.settings (swallow errors)
          try {
            const settingsFn = client.cardkit?.v1?.card?.settings;
            if (typeof settingsFn === 'function') {
              seq += 1;
              await settingsFn({
                path: { card_id: cardId },
                data: {
                  settings: JSON.stringify({ config: { streaming_mode: false } }),
                  sequence: seq,
                },
              });
            }
          } catch (settingsErr) {
            logger.warn('[lark-stream] settings streaming_mode false failed', {
              code: (settingsErr as any)?.code,
              message: settingsErr instanceof Error ? settingsErr.message : String(settingsErr),
            });
          }

          // Build final card JSON
          const optimized = optimizeMarkdownStyle(finalText);
          const chunks = chunkMarkdown(optimized, 4000);
          const bodyElements =
            chunks.length === 0 || (chunks.length === 1 && chunks[0].trim() === '')
              ? [{ tag: 'markdown', content: '(空回复)' }]
              : chunks.map((c) => ({ tag: 'markdown', content: c }));

          const finalCard = {
            schema: '2.0',
            header:
              status === 'completed'
                ? {
                    title: { tag: 'plain_text', content: params.title ?? 'Enkeep' },
                    template: 'green',
                  }
                : {
                    title: { tag: 'plain_text', content: '处理失败' },
                    template: 'red',
                  },
            body: {
              direction: 'vertical',
              elements: bodyElements,
            },
          };

          const finalCardJson = JSON.stringify(finalCard);

          // Full card update via cardkit.v1.card.update
          let updateSuccess = false;
          let updateError: any;

          try {
            const cardUpdateFn = client.cardkit?.v1?.card?.update;
            if (typeof cardUpdateFn === 'function') {
              seq += 1;
              const updateRes = await cardUpdateFn({
                path: { card_id: cardId },
                data: {
                  card: {
                    type: 'card_json',
                    data: finalCardJson,
                  },
                  sequence: seq,
                },
              });
              if (updateRes?.code === 0 || (!updateRes?.code && !updateRes?.msg)) {
                updateSuccess = true;
              } else {
                updateError = new Error(
                  updateRes?.msg || `card.update returned code ${updateRes?.code}`
                );
                (updateError as any).code = updateRes?.code;
              }
            } else {
              updateError = new Error('cardkit.v1.card.update is not available');
            }
          } catch (err) {
            updateError = err;
          }

          if (updateSuccess) {
            return;
          }

          logger.warn('[lark-stream] session.finalize card.update failed, falling back to message.patch', {
            code: updateError?.code ?? (updateError as any)?.status,
            message: updateError instanceof Error ? updateError.message : String(updateError),
          });

          // Fallback to im.v1.message.patch
          try {
            const patchFn =
              client.im?.v1?.message?.patch || client.im?.message?.patch;
            if (typeof patchFn === 'function') {
              const patchRes = await patchFn({
                path: { message_id: boundMessageId },
                data: {
                  content: finalCardJson,
                },
              });
              if (patchRes?.code === 0 || (!patchRes?.code && !patchRes?.msg)) {
                return;
              }
              const err = new Error(
                patchRes?.msg || `message.patch returned code ${patchRes?.code}`
              );
              (err as any).code = patchRes?.code;
              throw err;
            } else {
              throw new Error('im.message.patch is not available');
            }
          } catch (patchErr) {
            logger.warn('[lark-stream] session.finalize message.patch failed', {
              code: (patchErr as any)?.code,
              message: patchErr instanceof Error ? patchErr.message : String(patchErr),
            });
            logger.error(
              `Failed to finalize streaming card via card.update and message.patch: ${
                patchErr instanceof Error ? patchErr.message : String(patchErr)
              }`
            );
            throw patchErr;
          }
        },
      };

      return session;
    } catch (err) {
      this.logger.warn('[lark-stream] createStreamingCard error', {
        code: (err as any)?.code ?? (err as any)?.status,
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
