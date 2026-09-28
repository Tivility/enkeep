/**
 * WeChat Channel Gateway.
 * Manages inbound WeChat events, CAS durable inbox transitions,
 * session route resolution, runtime dispatch, context_token caching, and outbound delivery.
 *
 * @module @enkeep/channel-wechat/gateway
 */

import { randomBytes } from 'node:crypto';
import type { WeChatParsedMessage, WeChatTransport } from './types.js';
import { ContextTokenStore } from './context-token-store.js';
import { downloadAndDecryptMedia } from './crypto.js';
import {
  extractFinalAnswerText,
  markdownToPlainText,
  splitTextChunks,
  MSG_SPLIT_LIMIT,
} from './markdown.js';
import type {
  WeChatChannelAccount,
  WeChatChannelBinding,
  WeChatChannelInboxItem,
  WeChatChannelOutboxItem,
  WeChatChannelRepo,
  WeChatChannelGatewayOptions,
  WeChatInboundEnvelope,
  WeChatInboundEnvelopeAttachmentItem,
  WeChatInboundHandlingResult,
  WeChatRuntimeGateway,
  WeChatSessionRoute,
  WeChatSessionRouteRepo,
  WeChatSpaceRepo,
  WeChatTurnCompletedParams,
} from './gateway-types.js';

export const MAX_WECHAT_ATTACHMENT_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MiB per image
export const MAX_WECHAT_ATTACHMENT_FILE_BYTES = 20 * 1024 * 1024; // 20 MiB per file

/**
 * Media attachment ingestor interface compatible with Lark's TenantScopedLarkImageIngestor.
 */
export interface WeChatMediaAttachmentIngestor {
  ingestImage(params: {
    userId: string;
    spaceId: string;
    messageId: string;
    fileKey: string;
    buffer: Buffer;
    contentType?: string;
  }): Promise<{
    path: string;
    etag: string;
    mediaType: string;
    displayName: string;
  }>;
  ingestFile?(params: {
    userId: string;
    spaceId: string;
    messageId: string;
    fileKey: string;
    fileName?: string;
    buffer: Buffer;
    contentType?: string;
  }): Promise<{
    path: string;
    etag: string;
    mediaType: string;
    displayName: string;
  }>;
}

export interface WeChatIngestedAttachment extends WeChatInboundEnvelopeAttachmentItem {
  readonly path: string;
  readonly etag: string;
  readonly displayName: string;
  readonly mediaType?: string;
}

export interface WeChatChannelGatewayExtendedOptions extends WeChatChannelGatewayOptions {
  readonly mediaAttachmentIngestor?: WeChatMediaAttachmentIngestor;
  readonly imageAttachmentIngestor?: WeChatMediaAttachmentIngestor;
  readonly cdnBaseUrl?: string;
  readonly fetchFn?: typeof fetch;
}

export class WeChatChannelGateway {
  readonly account: WeChatChannelAccount;
  readonly transport: WeChatTransport;
  readonly channelRepo: WeChatChannelRepo;
  readonly sessionRouteRepo: WeChatSessionRouteRepo;
  readonly spaceRepo?: WeChatSpaceRepo;
  readonly runtimeGateway: WeChatRuntimeGateway;
  readonly contextTokenStore: ContextTokenStore;
  readonly defaultSpaceId?: string | null;
  readonly mediaAttachmentIngestor?: WeChatMediaAttachmentIngestor;
  readonly cdnBaseUrl?: string;
  readonly fetchFn?: typeof fetch;

  private isDisposed = false;
  private readonly inFlightTurns = new Set<string>();
  private readonly messageHandler: (msg: WeChatParsedMessage) => Promise<void>;
  private readonly cursorCommitHandler?: (cursor: string) => Promise<void> | void;

  constructor(options: WeChatChannelGatewayExtendedOptions) {
    this.account = options.account;
    this.transport = options.transport;
    this.channelRepo = options.channelRepo;
    this.sessionRouteRepo = options.sessionRouteRepo;
    this.spaceRepo = options.spaceRepo;
    this.runtimeGateway = options.runtimeGateway;
    this.contextTokenStore = options.contextTokenStore ?? new ContextTokenStore();
    this.defaultSpaceId = options.defaultSpaceId ?? this.account.defaultSpaceId;
    this.mediaAttachmentIngestor = options.mediaAttachmentIngestor ?? options.imageAttachmentIngestor;
    this.cdnBaseUrl = options.cdnBaseUrl ?? (options.transport as any)?.cdnBaseUrl;
    this.fetchFn = options.fetchFn;

    // 1. Attach message listener to transport
    this.messageHandler = async (msg: WeChatParsedMessage) => {
      if (!this.isDisposed) {
        await this.handleInboundMessage(msg);
      }
    };
    if (typeof (this.transport as any).onMessage === 'function') {
      (this.transport as any).onMessage(this.messageHandler);
    }

    // 2. Attach cursor commit listener if requested
    if (options.onCursorCommit && typeof (this.transport as any).onCursorCommit === 'function') {
      this.cursorCommitHandler = options.onCursorCommit;
      (this.transport as any).onCursorCommit(this.cursorCommitHandler);
    }
  }

  get userId(): string {
    return this.account.userId;
  }

  get accountId(): string {
    return this.account.id;
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  /**
   * Checks whether the account is currently marked active in the database.
   */
  async checkAccountActive(): Promise<boolean> {
    if (this.isDisposed) return false;
    try {
      const liveAccount = await this.channelRepo.findAccountById(this.accountId);
      if (!liveAccount) return false;
      return liveAccount.status === 'active';
    } catch {
      return false;
    }
  }

  /**
   * Processes an incoming parsed WeChat message:
   * 1. Validates active status
   * 2. Caches context_token
   * 3. Resolves channel binding (auto-bind to default space for p2p)
   * 4. CAS idempotency claim into channel_inbox
   * 5. Resolves session route
   * 6. Dispatches to RuntimeGateway
   */
  async handleInboundMessage(msg: WeChatParsedMessage): Promise<WeChatInboundHandlingResult> {
    if (this.isDisposed) {
      return { handled: false, ignoredReason: 'account_disabled' };
    }

    const isActive = await this.checkAccountActive();
    if (!isActive) {
      return { handled: false, ignoredReason: 'account_disabled' };
    }

    if (!msg || !msg.senderId) {
      return { handled: false, ignoredReason: 'parse_error' };
    }

    if (msg.isFromBot) {
      return { handled: false, ignoredReason: 'duplicate_event' };
    }

    const rawSenderId = msg.senderId;
    const bareSenderId = rawSenderId.startsWith('wechat:') ? rawSenderId.slice(7) : rawSenderId;
    const nativeContextId = `wechat:${bareSenderId}`;
    const nativeEventId = msg.messageId || msg.dedupKey;

    // Cache context_token immediately
    if (msg.contextToken) {
      await this.contextTokenStore.set(msg.senderId, msg.contextToken);
      if (bareSenderId !== msg.senderId) {
        await this.contextTokenStore.set(bareSenderId, msg.contextToken);
      }
    }

    // 1. Resolve channel binding
    let binding = await this.channelRepo.findBindingByContext(this.accountId, nativeContextId);
    if (!binding && bareSenderId !== nativeContextId) {
      binding = await this.channelRepo.findBindingByContext(this.accountId, bareSenderId);
    }
    if (!binding && msg.chatId && msg.chatId !== nativeContextId && msg.chatId !== bareSenderId) {
      binding = await this.channelRepo.findBindingByContext(this.accountId, msg.chatId);
      if (!binding && msg.chatId.startsWith('wechat:')) {
        binding = await this.channelRepo.findBindingByContext(this.accountId, msg.chatId.slice(7));
      }
    }

    // Auto-create binding to default space if missing
    if (!binding) {
      const targetSpaceId = this.defaultSpaceId ?? this.account.defaultSpaceId ?? null;
      if (targetSpaceId) {
        let isSpaceActive = true;
        if (this.spaceRepo) {
          const space = await this.spaceRepo.findById(targetSpaceId);
          if (!space || space.status !== 'active') {
            isSpaceActive = false;
          }
        }

        if (isSpaceActive) {
          binding = await this.channelRepo.createBinding({
            accountId: this.accountId,
            spaceId: targetSpaceId,
            nativeContextId,
            activationMode: 'always',
            chatType: 'p2p',
          });
        }
      }
    }

    if (!binding) {
      return { handled: false, ignoredReason: 'no_binding' };
    }

    // 2. Durable Channel Inbox Idempotency & CAS Transition
    const existingInbox = await this.channelRepo.findInboxByEvent(this.accountId, nativeEventId);
    let inboxItem: WeChatChannelInboxItem;

    if (existingInbox) {
      if (existingInbox.status === 'delivered' || existingInbox.status === 'processing') {
        return { handled: false, ignoredReason: 'duplicate_event', inboxItem: existingInbox };
      }
      const claimed = await this.channelRepo.claimInboxForProcessing(existingInbox.id);
      if (!claimed) {
        return { handled: false, ignoredReason: 'duplicate_event', inboxItem: existingInbox };
      }
      inboxItem = claimed;
    } else {
      const { item, isDuplicate } = await this.channelRepo.createInboxItem({
        accountId: this.accountId,
        nativeEventId,
        nativeContextId,
        payloadJson: JSON.stringify({ parsed: msg }),
        status: 'held',
      });

      if (isDuplicate && item.status === 'delivered') {
        return { handled: false, ignoredReason: 'duplicate_event', inboxItem: item };
      }

      const claimed = await this.channelRepo.claimInboxForProcessing(item.id);
      inboxItem = claimed || item;
    }

    // 3. Resolve Session Route (binding.spaceId -> Canonical/Imported SessionRoute)
    let route: WeChatSessionRoute;
    if (typeof this.sessionRouteRepo.getOrCreateCanonicalSession === 'function') {
      route = await this.sessionRouteRepo.getOrCreateCanonicalSession(binding.spaceId, {
        channel: 'wechat',
        accountId: this.accountId,
        nativeContextId,
        peerId: msg.senderId || nativeContextId,
        title: `WeChat ${msg.senderName || msg.senderId}`,
      });
    } else {
      let existingRoute = await this.sessionRouteRepo.findByRouteIdentity(
        'wechat',
        this.accountId,
        nativeContextId
      );
      if (!existingRoute && bareSenderId !== nativeContextId) {
        existingRoute = await this.sessionRouteRepo.findByRouteIdentity(
          'wechat',
          this.accountId,
          bareSenderId
        );
      }
      if (existingRoute) {
        route = existingRoute;
      } else {
        const newSessionId = `ses_${randomBytes(16).toString('hex')}`;
        const dshSessionId = `ses_${randomBytes(16).toString('hex')}`;
        route = await this.sessionRouteRepo.create({
          id: newSessionId,
          spaceId: binding.spaceId,
          channel: 'wechat',
          accountId: this.accountId,
          nativeContextId,
          peerId: msg.senderId || nativeContextId,
          dshSessionId,
          title: `WeChat ${msg.senderName || msg.senderId}`,
        });
      }
    }

    // 4. Inbound Media Download + Decrypt & Attachment Ingestion (Mirror Lark & HappyClaw)
    const envelopeAttachments: WeChatIngestedAttachment[] = [];
    const mediaItems = msg.mediaItems ?? [];

    if (this.mediaAttachmentIngestor && mediaItems.length > 0) {
      for (let i = 0; i < mediaItems.length; i++) {
        const item = mediaItems[i];
        if (item.type === 'image') {
          if (!item.encryptQueryParam || !item.aesKey) {
            continue;
          }
          try {
            const buffer = await downloadAndDecryptMedia({
              encryptQueryParam: item.encryptQueryParam,
              aesKeyBase64: item.aesKey,
              cdnBaseUrl: this.cdnBaseUrl,
              fetchFn: this.fetchFn,
              maxFileSize: MAX_WECHAT_ATTACHMENT_IMAGE_BYTES,
            });

            if (buffer && buffer.length > 0 && buffer.length <= MAX_WECHAT_ATTACHMENT_IMAGE_BYTES) {
              const safeMsgId = (nativeEventId || 'msg').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
              const fileKey = `wx_img_${safeMsgId}_${i}`.slice(0, 128);
              const ingested = await this.mediaAttachmentIngestor.ingestImage({
                userId: this.userId,
                spaceId: binding.spaceId,
                messageId: safeMsgId,
                fileKey,
                buffer,
              });
              envelopeAttachments.push({
                type: 'image',
                name: ingested.displayName,
                displayName: ingested.displayName,
                path: ingested.path,
                etag: ingested.etag,
                mediaType: ingested.mediaType,
              });
            }
          } catch {
            // Keep text fallback on failure (download/decrypt/size/ingest)
          }
        } else if (item.type === 'file') {
          if (!item.encryptQueryParam || !item.aesKey) {
            continue;
          }
          try {
            const buffer = await downloadAndDecryptMedia({
              encryptQueryParam: item.encryptQueryParam,
              aesKeyBase64: item.aesKey,
              cdnBaseUrl: this.cdnBaseUrl,
              fetchFn: this.fetchFn,
              maxFileSize: MAX_WECHAT_ATTACHMENT_FILE_BYTES,
            });

            if (buffer && buffer.length > 0 && buffer.length <= MAX_WECHAT_ATTACHMENT_FILE_BYTES) {
              if (typeof this.mediaAttachmentIngestor.ingestFile === 'function') {
                const safeMsgId = (nativeEventId || 'msg').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
                const fileKey = `wx_file_${safeMsgId}_${i}`.slice(0, 128);
                const ingested = await this.mediaAttachmentIngestor.ingestFile({
                  userId: this.userId,
                  spaceId: binding.spaceId,
                  messageId: safeMsgId,
                  fileKey,
                  fileName: item.name,
                  buffer,
                });
                envelopeAttachments.push({
                  type: 'file',
                  name: ingested.displayName,
                  displayName: ingested.displayName,
                  path: ingested.path,
                  etag: ingested.etag,
                  mediaType: ingested.mediaType,
                });
              }
            }
          } catch {
            // Keep text fallback on failure (download/decrypt/size/ingest)
          }
        }
      }
    }

    // 5. Clean Content & Build Inbound Envelope
    const platformIdempotencyKey = `idem_wechat_${this.accountId}_${nativeEventId}`;
    let effectiveContent = msg.text?.trim() || '';
    if (!effectiveContent && mediaItems.length > 0) {
      const hasImage = mediaItems.some((m) => m.type === 'image');
      const hasFile = mediaItems.some((m) => m.type === 'file');
      if (hasImage && !hasFile) {
        effectiveContent = '[图片]';
      } else if (hasFile && !hasImage) {
        const fileItem = mediaItems.find((m) => m.type === 'file');
        effectiveContent = fileItem?.name ? `[文件: ${fileItem.name}]` : '[文件]';
      } else {
        effectiveContent = '[多媒体消息]';
      }
    }
    if (!effectiveContent) {
      effectiveContent = '[消息]';
    }

    const envelope: WeChatInboundEnvelope = {
      id: platformIdempotencyKey,
      userId: this.userId,
      sessionId: route.id,
      content: effectiveContent,
      timestamp: new Date().toISOString(),
      channelContext: {
        channel: 'wechat',
        accountId: this.accountId,
        chatId: msg.chatId || msg.senderId,
        nativeContextId,
        nativeEventId,
        replyToMessageId: msg.messageId,
      },
      ...(envelopeAttachments.length > 0 ? { attachments: envelopeAttachments } : {}),
    };

    // 5. Dispatch Inbound to Runtime
    let turnId = platformIdempotencyKey;
    try {
      const dispatchResult = await this.runtimeGateway.dispatchInbound(envelope);
      turnId = dispatchResult.turnId || platformIdempotencyKey;
      inboxItem = await this.channelRepo.updateInboxStatus(inboxItem.id, 'delivered');
      return {
        handled: true,
        inboxItem,
        sessionRouteId: route.id,
        turnId,
      };
    } catch (err: any) {
      await this.channelRepo.updateInboxStatus(
        inboxItem.id,
        'failed',
        JSON.stringify({ parsed: msg, error: err?.message || String(err) })
      );
      throw err;
    }
  }

  /**
   * Handles agent turn completion event:
   * 1. Verifies turn origin and active account
   * 2. Extracts final answer text and strips thinking/reasoning blocks
   * 3. Converts Markdown to plain text with sensible table/code block/link formatting
   * 4. Resolves recipient user ID and cached context_token
   * 5. Creates outbox record
   * 6. Sends outbound reply via transport (with length splitting per HappyClaw)
   */
  async handleTurnCompleted(
    params: WeChatTurnCompletedParams
  ): Promise<WeChatChannelOutboxItem | null> {
    if (this.isDisposed) return null;

    const outboxId = `out_wechat_${params.turnId}`;
    if (typeof this.channelRepo.findOutboxById === 'function') {
      const existing = await this.channelRepo.findOutboxById(outboxId);
      if (existing && (existing.status === 'delivered' || existing.status === 'sending')) {
        return existing;
      }
    }

    const inFlightKey = params.turnId || params.idempotencyKey;
    if (inFlightKey) {
      if (this.inFlightTurns.has(inFlightKey)) {
        return null;
      }
      this.inFlightTurns.add(inFlightKey);
    }

    try {
      const isActive = await this.checkAccountActive();
      if (!isActive) return null;

      // Extract only final answer text (filtering thinking/reasoning or using runtime finalText)
      const rawFinalText = extractFinalAnswerText(params);
      // Convert Markdown to clean plain text for WeChat IM
      const plainText = markdownToPlainText(rawFinalText);

      // 1. Resolve route and recipient ID
      const route = await this.sessionRouteRepo.findById(params.sessionId);
      const nativeContextId = params.nativeContextId || route?.nativeContextId || '';

      let toUserId = '';
      if (params.nativeContextId) {
        toUserId = params.nativeContextId.startsWith('wechat:')
          ? params.nativeContextId.slice(7)
          : params.nativeContextId;
      }
      if (!toUserId) {
        toUserId = route?.peerId || '';
      }
      if (!toUserId && nativeContextId.startsWith('wechat:')) {
        toUserId = nativeContextId.slice(7);
      }
      if (!toUserId) {
        toUserId = nativeContextId;
      }

      // 2. Resolve cached context_token
      let contextToken = await this.contextTokenStore.get(toUserId);

      // Fallback: check inbox payload if not found in store
      if (!contextToken && params.nativeEventId) {
        const inbox = await this.channelRepo.findInboxByEvent(this.accountId, params.nativeEventId);
        if (inbox) {
          try {
            const p = JSON.parse(inbox.payloadJson);
            contextToken = p?.parsed?.contextToken;
            if (contextToken) {
              await this.contextTokenStore.set(toUserId, contextToken);
            }
          } catch {}
        }
      }

      if (!contextToken) {
        // Cannot deliver without context_token
        return await this.channelRepo.createOutboxItem({
          id: outboxId,
          accountId: this.accountId,
          sessionId: params.sessionId,
          nativeContextId,
          replyToNativeId: params.replyToMessageId,
          payloadJson: JSON.stringify({
            toUserId,
            text: plainText,
            turnId: params.turnId,
            error: `Missing cached context_token for recipient ${toUserId}`,
          }),
          status: 'failed',
        });
      }

      // 3. Create pending outbox item with clean plain text payload
      let outboxItem = await this.channelRepo.createOutboxItem({
        id: outboxId,
        accountId: this.accountId,
        sessionId: params.sessionId,
        nativeContextId,
        replyToNativeId: params.replyToMessageId,
        payloadJson: JSON.stringify({
          toUserId,
          contextToken,
          text: plainText,
          turnId: params.turnId,
        }),
        status: 'pending',
      });

      // 4. Send reply via transport with length splitting per HappyClaw
      try {
        const chunks = splitTextChunks(plainText, MSG_SPLIT_LIMIT);
        let allSuccess = true;

        for (const chunk of chunks) {
          const replyResult = await this.transport.sendReply(toUserId, contextToken, chunk);
          if (!replyResult.success) {
            allSuccess = false;
            break;
          }
        }

        if (allSuccess) {
          outboxItem = await this.channelRepo.updateOutboxStatus(outboxItem.id, 'delivered');
        } else {
          outboxItem = await this.channelRepo.updateOutboxStatus(outboxItem.id, 'failed', true);
        }
      } catch (err: any) {
        outboxItem = await this.channelRepo.updateOutboxStatus(outboxItem.id, 'failed', true);
      }

      return outboxItem;
    } finally {
      if (inFlightKey) {
        this.inFlightTurns.delete(inFlightKey);
      }
    }
  }

  /**
   * Disposes the gateway and unregisters transport handlers.
   */
  async dispose(): Promise<void> {
    this.isDisposed = true;
    if (typeof (this.transport as any).removeMessageHandler === 'function') {
      (this.transport as any).removeMessageHandler(this.messageHandler);
    }
    if (
      this.cursorCommitHandler &&
      typeof (this.transport as any).removeCursorCommitHandler === 'function'
    ) {
      (this.transport as any).removeCursorCommitHandler(this.cursorCommitHandler);
    }
    if (typeof this.transport.stop === 'function') {
      try {
        await this.transport.stop();
      } catch {
        // Ignore stop error during disposal
      }
    }
  }
}
