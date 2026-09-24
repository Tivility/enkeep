/**
 * Types and interfaces for WeChat Channel Gateway.
 *
 * @module @enkeep/channel-wechat/gateway-types
 */

import type { WeChatTransport, WeChatParsedMessage } from './types.js';
import type { ContextTokenStore } from './context-token-store.js';

export type WeChatAccountStatus = 'active' | 'disabled' | 'unverified';

export interface WeChatChannelAccount {
  readonly id: string;
  readonly userId: string;
  readonly type?: string; // 'wechat'
  readonly status: WeChatAccountStatus | string;
  readonly credentialRef?: string | null;
  readonly defaultSpaceId?: string | null;
  readonly groupActivationMode?: 'mention' | 'always' | string | null;
}

export interface WeChatChannelBinding {
  readonly id: string;
  readonly userId?: string;
  readonly accountId: string;
  readonly spaceId: string;
  readonly nativeContextId: string;
  readonly activationMode: 'mention' | 'always';
  readonly chatType?: string | null;
}

export interface WeChatChannelInboxItem {
  readonly id: string;
  readonly userId?: string;
  readonly accountId: string;
  readonly nativeEventId: string;
  readonly nativeContextId: string;
  readonly payloadJson: string;
  readonly status: 'held' | 'processing' | 'delivered' | 'failed';
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface WeChatChannelOutboxItem {
  readonly id: string;
  readonly userId?: string;
  readonly accountId: string;
  readonly sessionId: string;
  readonly nativeContextId: string;
  readonly replyToNativeId?: string | null;
  readonly payloadJson: string;
  readonly status: 'pending' | 'sending' | 'delivered' | 'failed';
  readonly attempts?: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface WeChatSessionRoute {
  readonly id: string;
  readonly spaceId: string;
  readonly channel: string;
  readonly accountId: string;
  readonly nativeContextId: string;
  readonly peerId?: string;
  readonly dshSessionId?: string;
  readonly title?: string | null;
}

export interface WeChatChannelRepo {
  findAccountById(id: string): Promise<WeChatChannelAccount | null>;
  findBindingByContext(accountId: string, nativeContextId: string): Promise<WeChatChannelBinding | null>;
  createBinding(input: {
    accountId: string;
    spaceId: string;
    nativeContextId: string;
    activationMode: 'mention' | 'always';
    chatType?: string;
  }): Promise<WeChatChannelBinding>;
  findInboxByEvent(accountId: string, nativeEventId: string): Promise<WeChatChannelInboxItem | null>;
  createInboxItem(input: {
    accountId: string;
    nativeEventId: string;
    nativeContextId: string;
    payloadJson: string;
    status: 'held' | 'processing' | 'delivered' | 'failed';
  }): Promise<{ item: WeChatChannelInboxItem; isDuplicate?: boolean }>;
  claimInboxForProcessing(id: string): Promise<WeChatChannelInboxItem | null>;
  updateInboxStatus(
    id: string,
    status: 'held' | 'processing' | 'delivered' | 'failed',
    payloadJson?: string
  ): Promise<WeChatChannelInboxItem>;
  findOutboxById?(id: string): Promise<WeChatChannelOutboxItem | null>;
  createOutboxItem(input: {
    id?: string;
    accountId: string;
    sessionId: string;
    nativeContextId: string;
    replyToNativeId?: string;
    payloadJson: string;
    status?: 'pending' | 'sending' | 'delivered' | 'failed';
  }): Promise<WeChatChannelOutboxItem>;
  updateOutboxStatus(
    id: string,
    status: 'pending' | 'sending' | 'delivered' | 'failed',
    incrementAttempt?: boolean
  ): Promise<WeChatChannelOutboxItem>;
}

export interface WeChatSessionRouteRepo {
  findById(id: string): Promise<WeChatSessionRoute | null>;
  findByRouteIdentity(
    channel: string,
    accountId: string,
    nativeContextId: string
  ): Promise<WeChatSessionRoute | null>;
  create(input: any): Promise<WeChatSessionRoute>;
  getOrCreateCanonicalSession?(
    spaceId: string,
    params: {
      channel: string;
      accountId: string;
      nativeContextId: string;
      peerId?: string;
      title?: string;
    }
  ): Promise<WeChatSessionRoute>;
}

export interface WeChatSpaceRepo {
  findById(id: string): Promise<{ id: string; status: string } | null>;
}

export interface WeChatInboundEnvelopeAttachmentItem {
  readonly type: string;
  readonly name?: string;
  readonly url?: string;
  readonly mimeType?: string;
  readonly key?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface WeChatInboundEnvelope {
  readonly id: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly content: string;
  readonly timestamp: string;
  readonly channelContext?: {
    readonly channel: 'wechat';
    readonly accountId: string;
    readonly chatId: string;
    readonly nativeContextId: string;
    readonly nativeEventId: string;
    readonly replyToMessageId?: string;
  };
  readonly attachments?: WeChatInboundEnvelopeAttachmentItem[];
}

export interface WeChatRuntimeDispatchResult {
  readonly turnId: string;
  readonly executionMode?: 'runtime' | 'command';
  readonly status?: string;
}

export interface WeChatRuntimeGateway {
  dispatchInbound(
    envelope: any,
    options?: any
  ): Promise<any>;
}

export interface WeChatChannelGatewayOptions {
  readonly account: WeChatChannelAccount;
  readonly transport: WeChatTransport;
  readonly channelRepo: WeChatChannelRepo;
  readonly sessionRouteRepo: WeChatSessionRouteRepo;
  readonly spaceRepo?: WeChatSpaceRepo;
  readonly runtimeGateway: WeChatRuntimeGateway;
  readonly contextTokenStore?: ContextTokenStore;
  readonly defaultSpaceId?: string | null;
  readonly onCursorCommit?: (cursor: string) => Promise<void> | void;
}

export interface WeChatInboundHandlingResult {
  readonly handled: boolean;
  readonly ignoredReason?:
    | 'duplicate_event'
    | 'no_binding'
    | 'parse_error'
    | 'account_disabled'
    | 'account_not_found'
    | 'transport_error';
  readonly inboxItem?: WeChatChannelInboxItem;
  readonly sessionRouteId?: string;
  readonly turnId?: string;
  readonly outboxItem?: WeChatChannelOutboxItem;
  readonly replyText?: string;
}

export interface WeChatTurnCompletedEvent {
  readonly userId: string;
  readonly sessionId: string;
  readonly spaceId?: string;
  readonly turnId: string;
  readonly deliveryId?: string;
  readonly idempotencyKey?: string;
  readonly executionResult: { readonly replyText: string };
  readonly tokenUsage?: { readonly tokens: number };
  readonly executionMode?: 'runtime' | 'command';
}

export interface WeChatOutboxPayload {
  readonly toUserId: string;
  readonly contextToken: string;
  readonly text: string;
  readonly turnId?: string;
  readonly messageId?: string;
  readonly error?: string;
}
