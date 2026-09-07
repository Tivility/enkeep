/**
 * Lark Channel Gateway.
 * Manages inbound Lark events, mention gating, idempotent durable inbox,
 * session route resolution, agent execution dispatch, and durable outbox delivery.
 *
 * @module @enkeep/channel-lark/gateway
 */

import { randomBytes, createHash } from 'node:crypto';
import type {
  ChannelAccount,
  ChannelActivationMode,
  ChannelBinding,
  ChannelInboxItem,
  ChannelOutboxItem,
  CreateChannelBindingInput,
  TenantScopedChannelRepository,
  TenantScopedSessionRouteRepository,
  TenantScopedSpaceRepository,
} from '@enkeep/platform-core';
import type {
  InboundEnvelope,
  RuntimeGateway,
} from '@enkeep/web-channel';
import {
  buildNativeContextId,
  messageMentionsBot,
  parseLarkEvent,
  stripBotMentions,
  stripLeadingMentions,
} from './parser.js';
import type {
  LarkAccountConfig,
  LarkParsedMessage,
  LarkRawEvent,
  LarkTransport,
  OutboundReplyPayload,
  StreamEventSource,
} from './types.js';
import { StreamingReplyTracker } from './streaming-tracker.js';
import { ContinuationWatcher, type ContinuationTarget } from './continuation-watcher.js';

export interface LarkChannelGatewayOptions {
  account: ChannelAccount | LarkAccountConfig;
  transport: LarkTransport;
  channelRepo: TenantScopedChannelRepository;
  sessionRouteRepo: TenantScopedSessionRouteRepository;
  spaceRepo?: TenantScopedSpaceRepository;
  runtimeGateway: RuntimeGateway;
  defaultSpaceId?: string | null;
  groupActivationMode?: ChannelActivationMode;
  streamEventSource?: StreamEventSource;
}

export interface InboundHandlingResult {
  readonly handled: boolean;
  readonly ignoredReason?:
    | 'not_mentioned'
    | 'duplicate_event'
    | 'no_binding'
    | 'parse_error'
    | 'transport_error'
    | 'account_disabled'
    | 'account_not_found'
    | 'empty_after_mention_strip';
  readonly inboxItem?: ChannelInboxItem;
  readonly sessionRouteId?: string;
  readonly turnId?: string;
  readonly outboxItem?: ChannelOutboxItem;
  readonly replyText?: string;
}

export class LarkChannelGateway {
  readonly account: ChannelAccount | LarkAccountConfig;
  readonly transport: LarkTransport;
  readonly channelRepo: TenantScopedChannelRepository;
  readonly sessionRouteRepo: TenantScopedSessionRouteRepository;
  readonly spaceRepo?: TenantScopedSpaceRepository;
  readonly runtimeGateway: RuntimeGateway;
  private readonly defaultSpaceId?: string | null;
  private readonly groupActivationMode?: ChannelActivationMode;
  private readonly streamEventSource?: StreamEventSource;
  private isDisposed = false;
  private readonly pendingReactions = new Map<string, { messageId: string; reactionIdPromise: Promise<string | undefined> }>();
  private readonly activeTrackers = new Map<string, StreamingReplyTracker>();
  private readonly lastInboundTargets = new Map<string, ContinuationTarget>();
  private readonly continuationWatchers = new Map<string, ContinuationWatcher>();
  private readonly inFlightTurns = new Set<string>();

  constructor(options: LarkChannelGatewayOptions) {
    this.account = options.account;
    this.transport = options.transport;
    this.channelRepo = options.channelRepo;
    this.sessionRouteRepo = options.sessionRouteRepo;
    this.spaceRepo = options.spaceRepo;
    this.runtimeGateway = options.runtimeGateway;
    this.defaultSpaceId = options.defaultSpaceId;
    this.groupActivationMode = options.groupActivationMode;
    this.streamEventSource = options.streamEventSource;

    // Register event listener with transport
    this.transport.onEvent(async (rawEvent: LarkRawEvent) => {
      if (!this.isDisposed) {
        await this.handleInboundEvent(rawEvent);
      }
    });
  }

  get userId(): string {
    return this.account.userId;
  }

  get accountId(): string {
    return this.account.id;
  }

  get botAppId(): string | undefined {
    return 'appId' in this.account ? this.account.appId : undefined;
  }

  get botOpenId(): string | undefined {
    return ('botOpenId' in this.account ? this.account.botOpenId : undefined) ?? (this.transport as any)?.botOpenId;
  }

  /**
   * Registers an active streaming reply tracker in a bounded in-memory map (max 200).
   */
  private registerTracker(key: string, tracker: StreamingReplyTracker): void {
    const existing = this.activeTrackers.get(key);
    if (existing) {
      existing.stop();
      this.activeTrackers.delete(key);
    }
    while (this.activeTrackers.size >= 200) {
      const oldestKey = this.activeTrackers.keys().next().value;
      if (!oldestKey) break;
      const oldest = this.activeTrackers.get(oldestKey);
      oldest?.stop();
      this.activeTrackers.delete(oldestKey);
    }
    this.activeTrackers.set(key, tracker);
  }

  /**
   * Checks whether an active inbound streaming tracker exists for a given route.
   */
  hasActiveTrackerForRoute(routeId: string): boolean {
    for (const tracker of this.activeTrackers.values()) {
      if (tracker.getRouteId() === routeId && tracker.isActive()) {
        return true;
      }
    }
    return false;
  }

  /**
   * Starts or extends a continuation watcher for the given session route.
   * Bound to at most 50 watchers per gateway, evicting the oldest.
   */
  startOrExtendContinuationWatcher(routeId: string, cursor?: number): void {
    if (this.isDisposed || !this.streamEventSource) return;

    const target = this.lastInboundTargets.get(routeId);
    if (!target) return;

    const existing = this.continuationWatchers.get(routeId);
    if (existing) {
      existing.extend(cursor, target);
      return;
    }

    while (this.continuationWatchers.size >= 50) {
      const oldestKey = this.continuationWatchers.keys().next().value;
      if (!oldestKey) break;
      const oldest = this.continuationWatchers.get(oldestKey);
      oldest?.stop();
      this.continuationWatchers.delete(oldestKey);
    }

    const watcher = new ContinuationWatcher({
      sessionRouteId: routeId,
      accountId: this.accountId,
      userId: this.userId,
      nativeContextId: target.nativeContextId || target.chatId,
      streamEventSource: this.streamEventSource,
      transport: this.transport,
      channelRepo: this.channelRepo,
      replyTarget: target,
      initialCursor: cursor,
      hasActiveInboundTracker: (rId) => this.hasActiveTrackerForRoute(rId),
      deriveOutboxId: (tId) => this.deriveOutboxId(tId),
      onStopped: () => {
        this.continuationWatchers.delete(routeId);
      },
    });

    this.continuationWatchers.set(routeId, watcher);
    watcher.start();
  }

  /**
   * Gets the active continuation watcher for a route if present (for test inspection).
   */
  getContinuationWatcher(routeId: string): ContinuationWatcher | undefined {
    return this.continuationWatchers.get(routeId);
  }

  /**
   * Checks the latest live account status in database to avoid stale snapshot bypass.
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
   * Records an in-flight receipt reaction ('OnIt') in a bounded in-memory map.
   */
  private recordReaction(idempotencyKey: string, messageId: string): void {
    const maxEntries = 500;
    if (this.pendingReactions.size >= maxEntries) {
      const oldestKey = this.pendingReactions.keys().next().value;
      if (oldestKey !== undefined) {
        this.pendingReactions.delete(oldestKey);
      }
    }

    const reactionIdPromise = (async () => {
      try {
        const res = await this.transport.addReaction(messageId, 'OnIt');
        return res?.reactionId;
      } catch {
        return undefined;
      }
    })();

    this.pendingReactions.set(idempotencyKey, { messageId, reactionIdPromise });
  }

  /**
   * Computes deterministic platform idempotency key from account and native event id.
   */
  deriveIdempotencyKey(nativeEventId: string): string {
    return `idem_lark_${this.accountId}_${nativeEventId}`;
  }

  /**
   * Computes deterministic stable outbox ID from user, account, and turn ID.
   */
  deriveOutboxId(turnId: string): string {
    const hash = createHash('sha256')
      .update(`${this.userId}:${this.accountId}:${turnId}`)
      .digest('hex')
      .slice(0, 24);
    return `out_${hash}`;
  }

  /**
   * Processes a single inbound Lark WebSocket event.
   */
  async handleInboundEvent(rawEvent: LarkRawEvent): Promise<InboundHandlingResult> {
    if (this.isDisposed) {
      return { handled: false, ignoredReason: 'account_disabled' };
    }

    // 0. Verify active account state dynamically
    const isActive = await this.checkAccountActive();
    if (!isActive) {
      return { handled: false, ignoredReason: 'account_disabled' };
    }

    // 1. Parse raw Lark event (strictly filters non-message events)
    const parsed = parseLarkEvent(rawEvent);
    if (!parsed) {
      return { handled: false, ignoredReason: 'parse_error' };
    }

    const nativeEventId = rawEvent.header?.event_id ?? rawEvent.uuid ?? parsed.messageId;
    const nativeContextId = buildNativeContextId(parsed.chatId, parsed.threadId, parsed.rootId);

    // 2. Resolve binding and activation mode
    let binding = await this.channelRepo.findBindingByContext(this.accountId, nativeContextId);
    if (!binding && parsed.chatId !== nativeContextId) {
      // Fall back to chat-level binding if thread-specific binding doesn't exist
      binding = await this.channelRepo.findBindingByContext(this.accountId, parsed.chatId);
    }

    // Auto-create binding to default space if configured and none exists
    if (!binding) {
      const liveAccount = await this.channelRepo.findAccountById(this.accountId);
      let targetDefaultSpaceId: string | null = null;
      let targetGroupActivationMode: ChannelActivationMode = 'mention';
      if (liveAccount) {
        if (liveAccount.defaultSpaceId !== undefined) {
          // Explicitly set on account (either spaceId or null).
          // null means explicitly cleared; do NOT fallback to constructor defaultSpaceId.
          targetDefaultSpaceId = liveAccount.defaultSpaceId;
        } else {
          targetDefaultSpaceId = this.defaultSpaceId ?? null;
        }
        if (liveAccount.groupActivationMode !== undefined && liveAccount.groupActivationMode !== null) {
          targetGroupActivationMode = liveAccount.groupActivationMode;
        } else if (this.groupActivationMode) {
          targetGroupActivationMode = this.groupActivationMode;
        }
      } else {
        targetDefaultSpaceId = this.defaultSpaceId ?? null;
        if (this.groupActivationMode) {
          targetGroupActivationMode = this.groupActivationMode;
        }
      }

      if (targetDefaultSpaceId) {
        let isSpaceActive = true;
        if (this.spaceRepo) {
          const space = await this.spaceRepo.findById(targetDefaultSpaceId);
          if (!space || space.status !== 'active') {
            isSpaceActive = false;
          }
        }

        if (isSpaceActive) {
          const isP2P = parsed.chatType === 'p2p';
          binding = await this.channelRepo.createBinding({
            accountId: this.accountId,
            spaceId: targetDefaultSpaceId,
            nativeContextId,
            activationMode: isP2P ? 'always' : targetGroupActivationMode,
            chatType: parsed.chatType,
          });
        }
      }
    }

    // If still no binding, we cannot route
    if (!binding) {
      return { handled: false, ignoredReason: 'no_binding' };
    }

    // 3. Mention Gating Check
    const isP2P = parsed.chatType === 'p2p';
    const isInsideThread = !!(parsed.rootId || parsed.threadId);
    let requiresMention = binding.activationMode === 'mention' && !isP2P;

    // Waiver: if the binding is mention mode but a session_routes row ALREADY exists for this nativeContextId
    // and the message is inside a thread (rootId/threadId present), do not require the @mention.
    if (requiresMention && isInsideThread) {
      const existingRoute = await this.sessionRouteRepo.findByRouteIdentity('lark', this.accountId, nativeContextId);
      if (existingRoute) {
        requiresMention = false;
      }
    }

    if (requiresMention) {
      const isMentioned = messageMentionsBot(
        { mentions: rawEvent.event?.message?.mentions ?? rawEvent.message?.mentions, content: rawEvent.event?.message?.content ?? rawEvent.message?.content },
        this.botAppId,
        this.botOpenId
      );
      if (!isMentioned) {
        return { handled: false, ignoredReason: 'not_mentioned' };
      }
    }

    // 4. Durable Channel Inbox Idempotency & CAS Transition
    const existingInbox = await this.channelRepo.findInboxByEvent(this.accountId, nativeEventId);
    let inboxItem: ChannelInboxItem;

    if (existingInbox) {
      if (existingInbox.status === 'delivered') {
        // Already successfully completed; skip duplicate event silently
        return { handled: false, ignoredReason: 'duplicate_event', inboxItem: existingInbox };
      }
      if (existingInbox.status === 'processing') {
        // In-flight processing by another worker/routine; do not re-run concurrently
        return { handled: false, ignoredReason: 'duplicate_event', inboxItem: existingInbox };
      }
      // Status is 'held' or 'failed': safe CAS claim to 'processing'
      const claimed = await this.channelRepo.claimInboxForProcessing(existingInbox.id);
      if (!claimed) {
        return { handled: false, ignoredReason: 'duplicate_event', inboxItem: existingInbox };
      }
      inboxItem = claimed;
      // Fire-and-forget OnIt receipt reaction
      this.recordReaction(this.deriveIdempotencyKey(nativeEventId), parsed.messageId);
    } else {
      const { item, isDuplicate } = await this.channelRepo.createInboxItem({
        accountId: this.accountId,
        nativeEventId,
        nativeContextId,
        payloadJson: JSON.stringify({
          rawEvent,
          parsed,
        }),
        status: 'held',
      });

      if (isDuplicate && item.status === 'delivered') {
        return { handled: false, ignoredReason: 'duplicate_event', inboxItem: item };
      }

      const claimed = await this.channelRepo.claimInboxForProcessing(item.id);
      if (!claimed) {
        return { handled: false, ignoredReason: 'duplicate_event', inboxItem: item };
      }
      inboxItem = claimed;
      // Fire-and-forget OnIt receipt reaction
      this.recordReaction(this.deriveIdempotencyKey(nativeEventId), parsed.messageId);
    }

    // 5. Session Route Resolution (one nativeContextId -> SessionRoute)
    let route = await this.sessionRouteRepo.findByRouteIdentity('lark', this.accountId, nativeContextId);
    if (!route) {
      const dshSessionId = `ses_${randomBytes(16).toString('hex')}`;
      route = await this.sessionRouteRepo.create({
        spaceId: binding.spaceId,
        channel: 'lark',
        accountId: this.accountId,
        nativeContextId,
        peerId: parsed.senderId || nativeContextId,
        dshSessionId,
        title: `Lark ${parsed.chatType === 'p2p' ? 'Direct' : 'Chat'} ${parsed.chatId}`,
      });
    }

    // 6. Clean Text & Dispatch to Enkeep Agent via RuntimeGateway
    const cleanedText = stripBotMentions(parsed.text, parsed.mentions, this.botOpenId);
    // Derive stable platform idempotency key from account + nativeEventId
    const platformIdempotencyKey = this.deriveIdempotencyKey(nativeEventId);

    if (!cleanedText) {
      // Clear OnIt reaction if recorded
      const pending = this.pendingReactions.get(platformIdempotencyKey);
      if (pending) {
        this.pendingReactions.delete(platformIdempotencyKey);
        pending.reactionIdPromise
          .then((rxId) => {
            if (rxId) {
              this.transport.removeReaction(pending.messageId, rxId).catch(() => {});
            }
          })
          .catch(() => {});
      }

      await this.transport.sendReply({
        chatId: parsed.chatId,
        rootId: parsed.rootId,
        threadId: parsed.threadId,
        replyToMessageId: parsed.messageId,
        content: '请在 @我 之后写下你的问题～',
        format: 'plain',
        uuid: this.deriveIdempotencyKey(`${nativeEventId}_empty_hint`),
      });

      if (inboxItem) {
        await this.channelRepo.updateInboxStatus(inboxItem.id, 'delivered');
      }

      return {
        handled: false,
        ignoredReason: 'empty_after_mention_strip',
        inboxItem,
      };
    }

    // Remember last inbound message context as continuation reply target
    this.lastInboundTargets.set(route.id, {
      chatId: parsed.chatId,
      replyToMessageId: parsed.messageId,
      rootId: parsed.rootId,
      threadId: parsed.threadId,
      nativeContextId: parsed.chatId,
    });

    const envelope: InboundEnvelope = {
      id: platformIdempotencyKey,
      userId: this.userId,
      sessionId: route.id,
      content: cleanedText,
      timestamp: new Date().toISOString(),
      // Do NOT pass native message ID into replyToMessageId because Platform expects internal web_messages.id
    };

    let turnId: string = platformIdempotencyKey;
    try {
      const dispatchResult = await this.runtimeGateway.dispatchInbound(envelope);
      turnId = dispatchResult.turnId || platformIdempotencyKey;
      inboxItem = await this.channelRepo.updateInboxStatus(inboxItem.id, 'delivered');

      if (this.streamEventSource && typeof this.transport.createStreamingCard === 'function') {
        let initialCursor: number | undefined;
        if (typeof this.streamEventSource.getLatestRowId === 'function') {
          try {
            initialCursor = await this.streamEventSource.getLatestRowId(route.id);
          } catch {}
        }
        const tracker = new StreamingReplyTracker({
          transport: this.transport,
          streamEventSource: this.streamEventSource,
          sessionRouteId: route.id,
          initialCursor,
          turnId: dispatchResult.turnId,
          cardParams: {
            chatId: parsed.chatId,
            replyToMessageId: parsed.messageId,
            rootId: parsed.rootId,
            threadId: parsed.threadId,
          },
        });
        tracker.start();
        this.registerTracker(platformIdempotencyKey, tracker);
      }
    } catch (err) {
      await this.channelRepo.updateInboxStatus(inboxItem.id, 'failed');
      throw err;
    }

    return {
      handled: true,
      inboxItem,
      sessionRouteId: route.id,
      turnId,
    };
  }

  /**
   * Creates a durable outbox item from a completed turn and attempts delivery.
   * Strictly requires structured origin context from channel inbox; refuses split guessing.
   */
  async handleTurnCompleted(params: {
    sessionId: string;
    turnId: string;
    replyText: string;
    idempotencyKey?: string;
    nativeContextId?: string;
    replyToMessageId?: string;
    rootId?: string;
    threadId?: string;
    chatId?: string;
    nativeEventId?: string;
  }): Promise<ChannelOutboxItem | null> {
    if (this.isDisposed) return null;

    if (params.turnId && typeof this.channelRepo.findOutboxById === 'function') {
      const existing = await this.channelRepo.findOutboxById(this.deriveOutboxId(params.turnId));
      if (existing) {
        return existing;
      }
    }

    const inFlightKey = params.turnId || params.idempotencyKey;
    if (inFlightKey) {
      if (this.inFlightTurns.has(inFlightKey)) {
        console.warn('[lark-stream] duplicate completion ignored', {
          turnId: params.turnId,
          idempotencyKey: params.idempotencyKey,
        });
        return null;
      }
      this.inFlightTurns.add(inFlightKey);
    }

    try {
      const isActive = await this.checkAccountActive();
      if (!isActive) return null;

    // 1. Resolve route and verify account ownership
    const route = await this.sessionRouteRepo.findById(params.sessionId);
    if (!route || route.accountId !== this.accountId || route.channel !== 'lark') {
      return null;
    }

    // 2. Turn origin verification: Ensure turn originated from an inbound Lark event
    let nativeEventId = params.nativeEventId;
    let replyToMessageId = params.replyToMessageId;
    let rootId = params.rootId;
    let threadId = params.threadId;
    let chatId = params.chatId;

    const expectedPrefix = `idem_lark_${this.accountId}_`;
    if (params.idempotencyKey && params.idempotencyKey.startsWith(expectedPrefix)) {
      nativeEventId = nativeEventId || params.idempotencyKey.slice(expectedPrefix.length);
    }

    if (nativeEventId) {
      const inboxItem = await this.channelRepo.findInboxByEvent(this.accountId, nativeEventId);
      if (inboxItem) {
        try {
          const payload = JSON.parse(inboxItem.payloadJson);
          const parsed = payload.parsed;
          if (parsed) {
            chatId = chatId || parsed.chatId;
            rootId = rootId || parsed.rootId;
            threadId = threadId || parsed.threadId || parsed.rootId;
            replyToMessageId = replyToMessageId || parsed.messageId;
          }
        } catch {}
      }
    } else {
      // If no nativeEventId is provided and idempotencyKey is not a Lark inbound,
      // this is a manual Web message in a channel-bound session; do not send to Lark.
      return null;
    }

    // Require valid structured chatId (no split guessing)
    if (!chatId || typeof chatId !== 'string' || chatId.trim().length === 0) {
      return null;
    }

    const nativeContextId = params.nativeContextId || route.nativeContextId;

    const idemKey = params.idempotencyKey || (nativeEventId ? this.deriveIdempotencyKey(nativeEventId) : undefined);
    const tracker = idemKey ? this.activeTrackers.get(idemKey) : undefined;
    if (idemKey) {
      this.activeTrackers.delete(idemKey);
    }

    let streamingHandled = false;
    let streamingMessageId: string | undefined;
    if (tracker) {
      const r = await tracker.finalize(params.replyText, 'completed');
      if (r.handled) {
        streamingHandled = true;
        streamingMessageId = r.messageId;
      }
    }

    const outboxId = this.deriveOutboxId(params.turnId);
    let outboxItem: ChannelOutboxItem;

    if (streamingHandled) {
      const payload: OutboundReplyPayload = {
        text: params.replyText,
        format: 'markdown',
        chatId,
        rootId,
        threadId,
        replyToMessageId,
        turnId: params.turnId,
        nativeEventId,
        messageId: streamingMessageId,
      };

      outboxItem = await this.channelRepo.createOutboxItem({
        id: outboxId,
        accountId: this.accountId,
        sessionId: route.id,
        nativeContextId,
        replyToNativeId: replyToMessageId ?? null,
        payloadJson: JSON.stringify(payload),
        status: 'delivered',
      });
      // Skip deliverOutboxItem / sendReply for streaming cards
    } else {
      console.warn('[lark-stream] gateway fallback to plain text reply', {
        code: 'FALLBACK_TO_PLAIN',
        message: 'Streaming card was not handled or failed',
      });
      // Structured payload storing explicit chatId, rootId, threadId, replyToMessageId, turnId
      const payload: OutboundReplyPayload = {
        text: params.replyText,
        format: 'plain',
        chatId,
        rootId,
        threadId,
        replyToMessageId,
        turnId: params.turnId,
        nativeEventId,
      };

      outboxItem = await this.channelRepo.createOutboxItem({
        id: outboxId,
        accountId: this.accountId,
        sessionId: route.id,
        nativeContextId,
        replyToNativeId: replyToMessageId ?? null,
        payloadJson: JSON.stringify(payload),
        status: 'pending',
      });

      // Attempt immediate delivery
      await this.deliverOutboxItem(outboxItem);
    }

    // Best-effort reaction update: remove 'OnIt' then add 'DONE'
    const pending = idemKey ? this.pendingReactions.get(idemKey) : undefined;
    if (idemKey) {
      this.pendingReactions.delete(idemKey);
    }
    const messageIdForReaction = pending?.messageId || replyToMessageId || params.replyToMessageId;
    if (messageIdForReaction) {
      (async () => {
        try {
          if (pending) {
            const reactionId = await pending.reactionIdPromise;
            if (reactionId) {
              await this.transport.removeReaction(messageIdForReaction, reactionId);
            }
          }
          await this.transport.addReaction(messageIdForReaction, 'DONE');
        } catch {
          // Best effort; ignore
        }
      })().catch(() => {});
    }

    // Start or extend continuation watcher on this route to monitor autonomous continuation turns
    this.startOrExtendContinuationWatcher(route.id, tracker?.getCursor());

    return outboxItem;
    } finally {
      if (inFlightKey) {
        this.inFlightTurns.delete(inFlightKey);
      }
    }
  }

  /**
   * Handles a failed turn by cleaning up in-progress receipt reactions and enqueueing
   * a sanitized user-facing error reply through the channel outbox.
   */
  async handleTurnFailed(params: {
    sessionId: string;
    turnId: string;
    idempotencyKey?: string;
    code?: string;
    reason?: string;
    nativeContextId?: string;
    replyToMessageId?: string;
    rootId?: string;
    threadId?: string;
    chatId?: string;
    nativeEventId?: string;
  }): Promise<ChannelOutboxItem | null> {
    if (this.isDisposed) return null;

    if (params.turnId && typeof this.channelRepo.findOutboxById === 'function') {
      const existing = await this.channelRepo.findOutboxById(this.deriveOutboxId(params.turnId));
      if (existing) {
        return existing;
      }
    }

    const inFlightKey = params.turnId || params.idempotencyKey;
    if (inFlightKey) {
      if (this.inFlightTurns.has(inFlightKey)) {
        console.warn('[lark-stream] duplicate completion ignored', {
          turnId: params.turnId,
          idempotencyKey: params.idempotencyKey,
        });
        return null;
      }
      this.inFlightTurns.add(inFlightKey);
    }

    try {
      const isActive = await this.checkAccountActive();
      if (!isActive) return null;

    // 1. Resolve route and verify account ownership
    const route = await this.sessionRouteRepo.findById(params.sessionId);
    if (!route || route.accountId !== this.accountId || route.channel !== 'lark') {
      return null;
    }

    // 2. Turn origin verification: Ensure turn originated from an inbound Lark event
    let nativeEventId = params.nativeEventId;
    let replyToMessageId = params.replyToMessageId;
    let rootId = params.rootId;
    let threadId = params.threadId;
    let chatId = params.chatId;

    const expectedPrefix = `idem_lark_${this.accountId}_`;
    if (params.idempotencyKey && params.idempotencyKey.startsWith(expectedPrefix)) {
      nativeEventId = nativeEventId || params.idempotencyKey.slice(expectedPrefix.length);
    }

    if (nativeEventId) {
      const inboxItem = await this.channelRepo.findInboxByEvent(this.accountId, nativeEventId);
      if (inboxItem) {
        try {
          const payload = JSON.parse(inboxItem.payloadJson);
          const parsed = payload.parsed;
          if (parsed) {
            chatId = chatId || parsed.chatId;
            rootId = rootId || parsed.rootId;
            threadId = threadId || parsed.threadId || parsed.rootId;
            replyToMessageId = replyToMessageId || parsed.messageId;
          }
        } catch {}
      }
    } else {
      // Not a Lark turn
      return null;
    }

    // Best-effort reaction cleanup: remove 'OnIt' only (do NOT add 'DONE')
    const idemKey = params.idempotencyKey || (nativeEventId ? this.deriveIdempotencyKey(nativeEventId) : undefined);
    const pending = idemKey ? this.pendingReactions.get(idemKey) : undefined;
    if (idemKey) {
      this.pendingReactions.delete(idemKey);
    }
    const messageIdForReaction = pending?.messageId || replyToMessageId || params.replyToMessageId;
    if (messageIdForReaction && pending) {
      (async () => {
        try {
          const reactionId = await pending.reactionIdPromise;
          if (reactionId) {
            await this.transport.removeReaction(messageIdForReaction, reactionId);
          }
        } catch {
          // Best effort; ignore
        }
      })().catch(() => {});
    }

    // Require valid structured chatId
    if (!chatId || typeof chatId !== 'string' || chatId.trim().length === 0) {
      return null;
    }

    const isQuota = params.code === 'QUOTA_EXCEEDED' || params.reason === 'Quota exceeded' || params.reason === '配额已用尽';
    const errorReplyText = isQuota ? '配额已用尽' : '处理失败，请稍后重试。';

    const nativeContextId = params.nativeContextId || route.nativeContextId;

    const tracker = idemKey ? this.activeTrackers.get(idemKey) : undefined;
    if (idemKey) {
      this.activeTrackers.delete(idemKey);
    }

    let streamingHandled = false;
    let streamingMessageId: string | undefined;
    if (tracker) {
      const r = await tracker.finalize(errorReplyText, 'failed');
      if (r.handled) {
        streamingHandled = true;
        streamingMessageId = r.messageId;
      }
    }

    const outboxId = this.deriveOutboxId(params.turnId);

    if (streamingHandled) {
      const payload: OutboundReplyPayload = {
        text: errorReplyText,
        format: 'markdown',
        chatId,
        rootId,
        threadId,
        replyToMessageId,
        turnId: params.turnId,
        nativeEventId,
        messageId: streamingMessageId,
      };

      const outboxItem = await this.channelRepo.createOutboxItem({
        id: outboxId,
        accountId: this.accountId,
        sessionId: route.id,
        nativeContextId,
        replyToNativeId: replyToMessageId ?? null,
        payloadJson: JSON.stringify(payload),
        status: 'delivered',
      });

      return outboxItem;
    }

    console.warn('[lark-stream] gateway fallback to plain text error reply', {
      code: 'FALLBACK_TO_PLAIN',
      message: 'Streaming card was not handled or failed',
    });

    const payload: OutboundReplyPayload = {
      text: errorReplyText,
      format: 'plain',
      chatId,
      rootId,
      threadId,
      replyToMessageId,
      turnId: params.turnId,
      nativeEventId,
    };

    const outboxItem = await this.channelRepo.createOutboxItem({
      id: outboxId,
      accountId: this.accountId,
      sessionId: route.id,
      nativeContextId,
      replyToNativeId: replyToMessageId ?? null,
      payloadJson: JSON.stringify(payload),
      status: 'pending',
    });

    await this.deliverOutboxItem(outboxItem);
    return outboxItem;
    } finally {
      if (inFlightKey) {
        this.inFlightTurns.delete(inFlightKey);
      }
    }
  }

  /**
   * Attempts delivery of a single outbox item through transport with CAS claim.
   */
  async deliverOutboxItem(
    outboxItem: ChannelOutboxItem
  ): Promise<boolean> {
    if (this.isDisposed) return false;

    // Verify account active
    const isActive = await this.checkAccountActive();
    if (!isActive) return false;

    // Verify account ownership
    if (outboxItem.accountId !== this.accountId) {
      return false;
    }

    let payload: OutboundReplyPayload;
    try {
      payload = JSON.parse(outboxItem.payloadJson);
    } catch {
      await this.channelRepo.updateOutboxStatus(outboxItem.id, 'failed', true);
      return false;
    }

    // Strict validation: Require explicit chatId in structured payload (no split guessing)
    const chatId = payload.chatId;
    if (!chatId || typeof chatId !== 'string' || chatId.trim().length === 0) {
      await this.channelRepo.updateOutboxStatus(outboxItem.id, 'failed', true);
      return false;
    }

    // Atomic CAS claim: pending -> sending (with attempt increment)
    const claimed = await this.channelRepo.claimPendingOutboxItem(outboxItem.id, this.accountId);
    if (!claimed) {
      // Could not claim (another worker sending or already delivered/failed)
      return false;
    }

    const rootId = payload.rootId;
    const threadId = payload.threadId || rootId;
    const replyToMessageId = payload.replyToMessageId || outboxItem.replyToNativeId || undefined;

    const result = await this.transport.sendReply({
      chatId,
      rootId,
      threadId,
      replyToMessageId,
      content: payload.text,
      format: 'plain', // Plain text format (no CardKit)
      uuid: outboxItem.id,
    });

    if (result.success) {
      await this.channelRepo.updateOutboxStatus(claimed.id, 'delivered', false);
      return true;
    } else {
      // If attempts exceeded max (3), mark failed, otherwise revert to pending for retry
      const maxAttempts = 3;
      const nextStatus = claimed.attempts >= maxAttempts ? 'failed' : 'pending';
      await this.channelRepo.updateOutboxStatus(claimed.id, nextStatus, false);
      return false;
    }
  }

  /**
   * Redrives pending outbox items scoped to this account.
   */
  async redrivePendingOutbox(limit = 20): Promise<number> {
    if (!this.transport.connected || this.isDisposed) {
      return 0;
    }

    // Recover stale sending items first (e.g. older than 60s)
    await this.channelRepo.recoverStaleSendingOutbox(60, this.accountId);

    // List pending outbox items strictly scoped to this account
    const pending = await this.channelRepo.listPendingOutbox(limit, this.accountId);
    let deliveredCount = 0;

    for (const item of pending) {
      if (item.status === 'pending') {
        const delivered = await this.deliverOutboxItem(item);
        if (delivered) {
          deliveredCount++;
        }
      }
    }

    return deliveredCount;
  }

  /**
   * Disposes this gateway instance and cleans up listeners.
   */
  async dispose(): Promise<void> {
    this.isDisposed = true;
    for (const tracker of this.activeTrackers.values()) {
      tracker.stop();
    }
    this.activeTrackers.clear();
    for (const watcher of this.continuationWatchers.values()) {
      watcher.stop();
    }
    this.continuationWatchers.clear();
    if (this.transport) {
      await this.transport.stop();
    }
  }
}
