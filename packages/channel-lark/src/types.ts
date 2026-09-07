/**
 * Lark / Feishu channel types and protocol models.
 * Distilled from Botmux (commit d9a977) and HappyClaw.
 *
 * @module @enkeep/channel-lark/types
 */

import type * as lark from '@larksuiteoapi/node-sdk';

export const REAL_LARK_CREDENTIAL_ACCEPTANCE = 'SKIPPED' as const;
export const REAL_LARK_CREDENTIAL_SKIP_REASON =
  'Real Lark credentials are not configured in test environment; live WS connection to open.feishu.cn is skipped in favor of verified FakeLarkTransport.' as const;

export interface LarkSenderId {
  open_id?: string;
  user_id?: string;
  union_id?: string;
  app_id?: string;
}

export interface LarkEventSender {
  sender_id?: LarkSenderId;
  sender_type?: string;
  tenant_key?: string;
}

export interface LarkRawMention {
  key: string;
  name: string;
  id?: LarkSenderId | string | null;
  id_type?: string;
  tenant_key?: string;
}

export interface LarkEventMessage {
  message_id: string;
  root_id?: string;
  thread_id?: string;
  parent_id?: string;
  message_type: string;
  content: string;
  chat_id: string;
  chat_type: 'p2p' | 'group' | string;
  create_time: string;
  mentions?: LarkRawMention[];
}

export interface LarkRawEventHeader {
  event_id: string;
  event_type: string;
  create_time: string;
  token?: string;
  app_id?: string;
  tenant_key?: string;
}

export interface LarkRawEvent {
  header?: LarkRawEventHeader;
  event?: {
    sender: LarkEventSender;
    message: LarkEventMessage;
  };
  // Flat format compatibility for test payloads
  sender?: LarkEventSender;
  message?: LarkEventMessage;
  uuid?: string;
}

export interface LarkMention {
  key: string;
  name: string;
  openId?: string;
  userId?: string;
  unionId?: string;
  appId?: string;
  idType?: string;
}

export interface MentionIdentity {
  key?: string;
  name?: string;
  openId?: string;
  userId?: string;
  unionId?: string;
  appId?: string;
  idType?: string;
}

export interface LarkMessageResource {
  type: 'image' | 'file';
  key: string;
  name: string;
  messageId?: string;
  unsupported?: boolean;
}

export interface LarkParsedMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  rootId?: string;
  threadId?: string;
  parentId?: string;
  senderId: string;
  senderUnionId?: string;
  senderType?: string;
  msgType: string;
  text: string;
  createTime: string;
  mentions?: LarkMention[];
  resources?: LarkMessageResource[];
}

export interface OutboundReplyPayload {
  readonly text: string;
  readonly format?: 'plain' | 'markdown';
  readonly chatId?: string;
  readonly rootId?: string;
  readonly threadId?: string;
  readonly replyToMessageId?: string;
  readonly turnId?: string;
  readonly nativeEventId?: string;
  readonly messageId?: string;
}

export interface StreamEventSource {
  getLatestRowId?(sessionRouteId: string): Promise<number>;
  listAssistantEvents(
    sessionRouteId: string,
    afterRowId: number,
    limit?: number
  ): Promise<Array<{
    rowId: number;
    type: 'assistant_delta' | 'assistant_stream_end' | 'turn_status' | 'tool_status';
    delta?: string;
    streamId?: string;
    status?: string;
    toolName?: string;
  }>>;
  getPlatformTurnState?(
    sessionRouteId: string,
    turnId: string
  ): Promise<'queued' | 'running' | 'completed' | 'failed' | 'unknown'>;
  hasPendingPlatformTurn?(sessionRouteId: string): Promise<boolean>;
}

export interface OutboundReplyResult {
  readonly success: boolean;
  readonly messageId?: string;
  readonly error?: string;
}

export interface LarkStreamingCardSession {
  readonly cardId: string;
  readonly messageId: string;
  pushText(accumulatedText: string): Promise<void>;
  finalize(finalText: string, status: 'completed' | 'failed'): Promise<void>;
}

export type LarkEventHandler = (event: LarkRawEvent) => Promise<void>;

export interface LarkTransport {
  readonly connected: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent(handler: LarkEventHandler): void;
  removeEventHandler?(handler: LarkEventHandler): void;
  sendReply(params: {
    chatId: string;
    rootId?: string;
    threadId?: string;
    replyToMessageId?: string;
    content: string;
    format?: 'plain' | 'markdown';
    uuid?: string;
  }): Promise<OutboundReplyResult>;
  createStreamingCard?(params: {
    chatId: string;
    replyToMessageId?: string;
    rootId?: string;
    threadId?: string;
    title?: string;
  }): Promise<LarkStreamingCardSession | null>;
  addReaction(messageId: string, emojiType: string): Promise<{ reactionId?: string }>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

export interface LarkAccountConfig {
  readonly id: string;
  readonly userId: string;
  readonly appId?: string;
  readonly appSecret?: string;
  readonly credentialRef?: string;
  readonly brand?: 'feishu' | 'lark';
  readonly botOpenId?: string;
}

export interface LarkResolvedCredentials {
  readonly appId: string;
  readonly appSecret: string;
  readonly domain?: 'feishu' | 'lark';
  readonly botOpenId?: string;
}

export interface LarkCredentialResolver {
  resolve(userId: string, credentialRef: string): Promise<LarkResolvedCredentials | null>;
}

export interface ILarkApiClient {
  cardkit?: {
    v1?: {
      card?: {
        create: (req: any, options?: any) => Promise<any>;
        settings: (req: any, options?: any) => Promise<any>;
        update: (req: any, options?: any) => Promise<any>;
      };
      cardElement?: {
        content: (req: any, options?: any) => Promise<any>;
      };
    };
  };
  im: {
    message: {
      reply: (req: any, options?: any) => Promise<any>;
      create: (req: any, options?: any) => Promise<any>;
      patch?: (req: any, options?: any) => Promise<any>;
    };
    messageReaction?: {
      create: (req: any, options?: any) => Promise<any>;
      delete: (req: any, options?: any) => Promise<any>;
    };
    v1?: {
      message?: {
        reply?: (req: any, options?: any) => Promise<any>;
        create?: (req: any, options?: any) => Promise<any>;
        patch?: (req: any, options?: any) => Promise<any>;
      };
      messageReaction?: {
        create: (req: any, options?: any) => Promise<any>;
        delete: (req: any, options?: any) => Promise<any>;
      };
    };
  };
}

export interface ILarkWSClient {
  start: (params: { eventDispatcher: any }) => Promise<void>;
  close?: () => Promise<void> | void;
  getConnectionStatus?: () => { state: string } | any;
}

export interface LarkSdkClientFactory {
  createClient(options: { appId: string; appSecret: string; domain?: any; logger?: any; loggerLevel?: any }): ILarkApiClient;
  createWSClient?(options: {
    appId: string;
    appSecret: string;
    domain?: any;
    logger?: any;
    loggerLevel?: any;
    handshakeTimeoutMs?: number;
    onReady?: () => void;
    onError?: (err: Error) => void;
    onReconnecting?: () => void;
    onReconnected?: () => void;
  }): ILarkWSClient;
}
