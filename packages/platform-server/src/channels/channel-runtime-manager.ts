/**
 * Channel Runtime Manager.
 * Manages account-scoped channel transports, gateway lifecycle,
 * reconciliation, and turn-completion delivery wiring.
 *
 * @module @enkeep/platform-server/channels/channel-runtime-manager
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  type PlatformStorage,
  type ChannelAccount,
} from '@enkeep/platform-core';
import type { PublicEventCode } from '@enkeep/web-channel';
import {
  type DeliveryRuntimeGateway,
} from '../runtime/delivery-gateway.js';
import {
  CredentialedLarkTransport,
  FakeLarkTransport,
  LarkChannelGateway,
  type LarkCredentialResolver,
  type LarkSdkClientFactory,
  type LarkTransport,
  type StreamEventSource,
} from '@enkeep/channel-lark';
import { SqliteStreamEventSource } from './sqlite-stream-event-source.js';

export type LarkTransportFactory = (
  account: ChannelAccount,
  credentialResolver?: LarkCredentialResolver
) => Promise<LarkTransport | null> | LarkTransport | null;

export type LarkDefaultSpaceResolver = (
  userId: string,
  account: ChannelAccount
) => Promise<string | undefined> | string | undefined;

export interface ChannelRuntimeManagerOptions {
  storage: PlatformStorage;
  db?: DatabaseSync;
  deliveryGateway: DeliveryRuntimeGateway;
  credentialResolver?: LarkCredentialResolver;
  transportFactory?: LarkTransportFactory;
  defaultSpaceResolver?: LarkDefaultSpaceResolver;
  streamEventSource?: StreamEventSource;
  autoStart?: boolean;
  workerIntervalMs?: number;
}

export class ChannelRuntimeManager {
  private readonly storage: PlatformStorage;
  private readonly db?: DatabaseSync;
  private readonly deliveryGateway: DeliveryRuntimeGateway;
  private readonly credentialResolver?: LarkCredentialResolver;
  private readonly transportFactory?: LarkTransportFactory;
  private readonly defaultSpaceResolver?: LarkDefaultSpaceResolver;
  private readonly streamEventSource?: StreamEventSource;
  private readonly workerIntervalMs: number;
  private readonly activeGateways = new Map<string, LarkChannelGateway>(); // key: `${userId}:${accountId}`
  private readonly activeAccounts = new Map<string, ChannelAccount>(); // key: `${userId}:${accountId}`
  private readonly inFlightSyncs = new Map<string, Promise<LarkChannelGateway | null>>();
  private isRunning = false;
  private isDisposing = false;
  private isTickRunning = false;
  private workerTimer?: NodeJS.Timeout;
  private turnCompletedListener?: (event: {
    userId: string;
    sessionId: string;
    spaceId: string;
    turnId: string;
    deliveryId: string;
    idempotencyKey: string;
    executionResult: { replyText: string };
    tokenUsage: { tokens: number };
  }) => Promise<void> | void;
  private turnFailedListener?: (event: {
    userId: string;
    sessionId: string;
    spaceId?: string;
    turnId: string;
    deliveryId: string;
    idempotencyKey: string;
    code: PublicEventCode;
    reason: string;
  }) => Promise<void> | void;

  constructor(options: ChannelRuntimeManagerOptions) {
    this.storage = options.storage;
    this.db = options.db;
    this.deliveryGateway = options.deliveryGateway;
    this.credentialResolver = options.credentialResolver;
    this.transportFactory = options.transportFactory;
    this.defaultSpaceResolver = options.defaultSpaceResolver;
    this.streamEventSource = options.streamEventSource;
    this.workerIntervalMs = options.workerIntervalMs ?? 2500;
  }

  get running(): boolean {
    return this.isRunning && !this.isDisposing;
  }

  get activeGatewayCount(): number {
    return this.activeGateways.size;
  }

  getActiveGateway(userId: string, accountId: string): LarkChannelGateway | undefined {
    return this.activeGateways.get(`${userId}:${accountId}`);
  }

  /**
   * Starts the Channel Runtime Manager.
   * Hooks into DeliveryRuntimeGateway, reconciles existing active accounts, scans for un-outboxed committed turns,
   * starts background maintenance worker, and redrives pending outbox.
   */
  async start(): Promise<void> {
    if (this.isRunning || this.isDisposing) return;
    this.isRunning = true;

    // 1. Hook into DeliveryRuntimeGateway turn completion and failure
    this.turnCompletedListener = async (event) => {
      if (!this.isRunning || this.isDisposing) return;
      await this.handleTurnCompleted(event);
    };
    this.deliveryGateway.onTurnCompleted(this.turnCompletedListener);

    this.turnFailedListener = async (event) => {
      if (!this.isRunning || this.isDisposing) return;
      await this.handleTurnFailed(event);
    };
    this.deliveryGateway.onTurnFailed(this.turnFailedListener);

    // 2. Reconcile and start active accounts
    await this.reconcileAllAccounts();

    // 3. Scan for any completed turns that missed outbox delivery before startup
    await this.scanAndReconcileCommittedTurns();

    // 4. Start background maintenance worker
    this.startWorker();
  }

  /**
   * Starts the periodic background worker tick (single-flight, unref).
   */
  private startWorker(): void {
    if (this.workerTimer || this.isDisposing) return;

    this.workerTimer = setInterval(() => {
      this.runBackgroundWorkerTick().catch(() => {});
    }, this.workerIntervalMs);

    if (this.workerTimer && typeof this.workerTimer.unref === 'function') {
      this.workerTimer.unref();
    }
  }

  /**
   * Stops the manager, background worker, and all active gateways/transports.
   */
  async stop(): Promise<void> {
    this.isDisposing = true;
    this.isRunning = false;

    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = undefined;
    }

    if (this.turnCompletedListener) {
      this.deliveryGateway.removeTurnCompletedListener(this.turnCompletedListener);
      this.turnCompletedListener = undefined;
    }

    if (this.turnFailedListener) {
      this.deliveryGateway.removeTurnFailedListener(this.turnFailedListener);
      this.turnFailedListener = undefined;
    }

    // Await all in-flight account sync operations before disposing
    if (this.inFlightSyncs.size > 0) {
      await Promise.allSettled(Array.from(this.inFlightSyncs.values()));
    }

    const gateways = Array.from(this.activeGateways.values());
    this.activeGateways.clear();
    this.activeAccounts.clear();
    this.inFlightSyncs.clear();

    for (const gw of gateways) {
      try {
        await gw.dispose();
      } catch {
        // Ignore stop error during shutdown
      }
    }
  }

  /**
   * Executes a single bounded background maintenance tick.
   * 1. Recovers orphan/crashed processing inbox items back to failed (scoped to Lark only)
   * 2. Retries held/failed inbox items using stable keys and updated_at rotation to avoid poison starvation
   * 3. Scans for un-outboxed committed assistant messages
   * 4. Redrives pending/recovered outbox replies
   */
  async runBackgroundWorkerTick(): Promise<void> {
    if (!this.isRunning || this.isDisposing || this.isTickRunning) return;
    this.isTickRunning = true;

    try {
      if (this.db) {
        // 1. Recover orphan processing inbox items older than 60s (strictly scoped to Lark accounts only)
        try {
          this.db.prepare(`
            UPDATE channel_inbox
            SET status = 'failed', updated_at = CURRENT_TIMESTAMP
            WHERE status = 'processing' AND datetime(updated_at) < datetime('now', '-60 seconds')
              AND account_id IN (SELECT id FROM channel_accounts WHERE type = 'lark')
          `).run();
        } catch {}

        // 2. Retry held/failed inbox items (bounded batch 10, ordered by updated_at ASC to rotate)
        try {
          const recoverableInbox = this.db.prepare(`
            SELECT ci.id, ci.user_id, ci.account_id, ci.native_event_id, ci.native_context_id, ci.payload_json
            FROM channel_inbox ci
            JOIN channel_accounts ca ON ca.id = ci.account_id AND ca.status = 'active' AND ca.type = 'lark'
            WHERE ci.status IN ('held', 'failed')
            ORDER BY ci.updated_at ASC
            LIMIT 10
          `).all() as Array<{
            id: string;
            user_id: string;
            account_id: string;
            native_event_id: string;
            native_context_id: string;
            payload_json: string;
          }>;

          for (const item of recoverableInbox) {
            if (!this.isRunning || this.isDisposing) break;
            // Touch updated_at to rotate priority and prevent poison pills from starving queue
            this.db.prepare(`UPDATE channel_inbox SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(item.id);

            const gateway = this.getActiveGateway(item.user_id, item.account_id);
            if (gateway) {
              try {
                const parsedPayload = JSON.parse(item.payload_json);
                const rawEvent = parsedPayload.rawEvent || parsedPayload;
                await gateway.handleInboundEvent(rawEvent);
              } catch {}
            }
          }
        } catch {}
      }

      // 3. Scan for un-outboxed committed turns
      await this.scanAndReconcileCommittedTurns();

      // 4. Redrive pending outbox for all active gateways
      for (const gateway of this.activeGateways.values()) {
        if (!this.isRunning || this.isDisposing) break;
        try {
          await gateway.redrivePendingOutbox();
        } catch {}
      }
    } finally {
      this.isTickRunning = false;
    }
  }

  /**
   * Handles turn completion notification from DeliveryRuntimeGateway.
   * Strictly matches the turn's original channel inbox event to prevent
   * crossing responses between turns or auto-dispatching manual Web messages.
   */
  async handleTurnCompleted(event: {
    userId: string;
    sessionId: string;
    spaceId: string;
    turnId: string;
    deliveryId: string;
    idempotencyKey: string;
    executionResult: { replyText: string };
    tokenUsage: { tokens: number };
  }): Promise<void> {
    if (!this.isRunning || this.isDisposing) return;

    const { userId, sessionId, turnId, idempotencyKey, executionResult } = event;

    // 1. Resolve session route from database to see if it's a channel session
    const tenant = this.storage.forTenant(userId);
    const route = await tenant.sessionRoutes.findById(sessionId);
    if (!route || route.channel !== 'lark') {
      // Not a lark channel session; ignore
      return;
    }

    const accountId = route.accountId;

    // 2. Turn Origin Check: Verify that this turn is strictly tied to an inbound Lark event
    const expectedPrefix = `idem_lark_${accountId}_`;
    let nativeEventId: string | undefined;

    if (idempotencyKey && idempotencyKey.startsWith(expectedPrefix)) {
      nativeEventId = idempotencyKey.slice(expectedPrefix.length);
    }

    // Fallback lookup in idempotency_records if needed
    if (!nativeEventId && this.db) {
      try {
        const row = this.db.prepare(
          'SELECT idempotency_key FROM idempotency_records WHERE turn_id = ? AND user_id = ? LIMIT 1'
        ).get(turnId, userId) as { idempotency_key?: string } | undefined;
        if (row?.idempotency_key && row.idempotency_key.startsWith(expectedPrefix)) {
          nativeEventId = row.idempotency_key.slice(expectedPrefix.length);
        }
      } catch {}
    }

    if (!nativeEventId) {
      // Not an inbound Lark message turn (e.g. manual Web message in same session); do NOT send to Lark
      return;
    }

    // 3. Query the exact, durable inbox item for this native event (never use 'latest' by context!)
    const inboxItem = await tenant.channels.findInboxByEvent(accountId, nativeEventId);
    if (!inboxItem) {
      // No corresponding inbox record; ignore
      return;
    }

    let replyToMessageId: string | undefined;
    let rootId: string | undefined;
    let threadId: string | undefined;
    let chatId: string | undefined;

    try {
      const parsedPayload = JSON.parse(inboxItem.payloadJson);
      const parsed = parsedPayload.parsed;
      if (parsed) {
        replyToMessageId = parsed.messageId;
        chatId = parsed.chatId;
        rootId = parsed.rootId;
        threadId = parsed.threadId || parsed.rootId;
      }
    } catch {}

    // 4. Ensure gateway is active
    let gateway = this.getActiveGateway(userId, accountId);
    if (!gateway) {
      gateway = (await this.syncAccount(userId, accountId)) ?? undefined;
    }

    if (!gateway) {
      // Account disabled or no transport; cannot deliver
      return;
    }

    // 5. Delegate to gateway to create structured outbox item and deliver
    await gateway.handleTurnCompleted({
      sessionId,
      turnId,
      replyText: executionResult.replyText,
      idempotencyKey: idempotencyKey || `idem_lark_${accountId}_${nativeEventId}`,
      nativeContextId: route.nativeContextId,
      replyToMessageId,
      rootId,
      threadId,
      chatId,
      nativeEventId,
    });
  }

  /**
   * Handles turn failure notification from DeliveryRuntimeGateway.
   * Cleans up pending reactions and sends a sanitized error reply through channel outbox.
   */
  async handleTurnFailed(event: {
    userId: string;
    sessionId: string;
    spaceId?: string;
    turnId: string;
    deliveryId: string;
    idempotencyKey: string;
    code: PublicEventCode;
    reason: string;
  }): Promise<void> {
    if (!this.isRunning || this.isDisposing) return;

    const { userId, sessionId, turnId, idempotencyKey, code, reason } = event;

    // 1. Resolve session route from database to see if it's a channel session
    const tenant = this.storage.forTenant(userId);
    const route = await tenant.sessionRoutes.findById(sessionId);
    if (!route || route.channel !== 'lark') {
      return;
    }

    const accountId = route.accountId;

    // 2. Turn Origin Check: Verify that this turn is strictly tied to an inbound Lark event
    const expectedPrefix = `idem_lark_${accountId}_`;
    let nativeEventId: string | undefined;

    if (idempotencyKey && idempotencyKey.startsWith(expectedPrefix)) {
      nativeEventId = idempotencyKey.slice(expectedPrefix.length);
    }

    // Fallback lookup in idempotency_records if needed
    if (!nativeEventId && this.db) {
      try {
        const row = this.db.prepare(
          'SELECT idempotency_key FROM idempotency_records WHERE turn_id = ? AND user_id = ? LIMIT 1'
        ).get(turnId, userId) as { idempotency_key?: string } | undefined;
        if (row?.idempotency_key && row.idempotency_key.startsWith(expectedPrefix)) {
          nativeEventId = row.idempotency_key.slice(expectedPrefix.length);
        }
      } catch {}
    }

    if (!nativeEventId) {
      return;
    }

    // 3. Query the exact, durable inbox item for this native event (never use 'latest' by context!)
    const inboxItem = await tenant.channels.findInboxByEvent(accountId, nativeEventId);
    if (!inboxItem) {
      return;
    }

    let replyToMessageId: string | undefined;
    let rootId: string | undefined;
    let threadId: string | undefined;
    let chatId: string | undefined;

    try {
      const parsedPayload = JSON.parse(inboxItem.payloadJson);
      const parsed = parsedPayload.parsed;
      if (parsed) {
        replyToMessageId = parsed.messageId;
        chatId = parsed.chatId;
        rootId = parsed.rootId;
        threadId = parsed.threadId || parsed.rootId;
      }
    } catch {}

    // 4. Ensure gateway is active
    let gateway = this.getActiveGateway(userId, accountId);
    if (!gateway) {
      gateway = (await this.syncAccount(userId, accountId)) ?? undefined;
    }

    if (!gateway) {
      return;
    }

    // 5. Delegate to gateway to clean up reaction and deliver sanitized error reply
    await gateway.handleTurnFailed({
      sessionId,
      turnId,
      code,
      reason,
      idempotencyKey: idempotencyKey || `idem_lark_${accountId}_${nativeEventId}`,
      nativeContextId: route.nativeContextId,
      replyToMessageId,
      rootId,
      threadId,
      chatId,
      nativeEventId,
    });
  }

  /**
   * Scans SQLite database for completed assistant messages on Lark sessions
   * that do not have an outbox record yet (e.g. server restart immediately after turn completion).
   */
  async scanAndReconcileCommittedTurns(): Promise<void> {
    if (!this.db || !this.isRunning || this.isDisposing) return;

    try {
      const unOutboxedRows = this.db.prepare(`
        SELECT wm.id as message_id, wm.session_id, wm.user_id, wm.turn_id, wm.content as reply_text,
               sr.account_id, sr.native_context_id, ir.idempotency_key
        FROM web_messages wm
        JOIN session_routes sr ON sr.id = wm.session_id AND sr.channel = 'lark'
        LEFT JOIN idempotency_records ir ON ir.turn_id = wm.turn_id AND ir.user_id = wm.user_id
        LEFT JOIN channel_outbox co ON co.session_id = wm.session_id AND co.account_id = sr.account_id
             AND json_extract(co.payload_json, '$.turnId') = wm.turn_id
        WHERE wm.role = 'assistant' AND wm.status = 'delivered'
          AND wm.created_at < datetime('now', '-15 seconds')
          AND co.id IS NULL
          AND ir.idempotency_key LIKE 'idem_lark_%'
      `).all() as Array<{
        message_id: string;
        session_id: string;
        user_id: string;
        turn_id: string;
        reply_text: string;
        account_id: string;
        native_context_id: string;
        idempotency_key: string;
      }>;

      for (const row of unOutboxedRows) {
        if (!this.isRunning || this.isDisposing) break;
        await this.handleTurnCompleted({
          userId: row.user_id,
          sessionId: row.session_id,
          spaceId: '',
          turnId: row.turn_id,
          deliveryId: '',
          idempotencyKey: row.idempotency_key,
          executionResult: { replyText: row.reply_text },
          tokenUsage: { tokens: 0 },
        });
      }
    } catch {
      // Ignore scan query errors if tables not ready
    }
  }

  /**
   * Reconciles all accounts across all tenants.
   */
  async reconcileAllAccounts(): Promise<void> {
    if (!this.db || !this.isRunning || this.isDisposing) return;

    try {
      const activeAccountRows = this.db.prepare(`
        SELECT id, user_id, type, status, credential_ref, created_at, updated_at
        FROM channel_accounts
        WHERE status = 'active' AND type = 'lark'
      `).all() as Array<{
        id: string;
        user_id: string;
        type: string;
        status: string;
        credential_ref: string | null;
        created_at: string;
        updated_at: string;
      }>;

      for (const row of activeAccountRows) {
        if (!this.isRunning || this.isDisposing) break;
        await this.syncAccount(row.user_id, row.id);
      }
    } catch {
      // Ignore reconciliation query errors on fresh db
    }
  }

  /**
   * Synchronizes a single account lifecycle (starts or stops gateway as appropriate).
   * Implements single-flight promise deduplication per account.
   */
  async syncAccount(userId: string, accountId: string): Promise<LarkChannelGateway | null> {
    if (this.isDisposing) return null;

    const key = `${userId}:${accountId}`;
    const inFlight = this.inFlightSyncs.get(key);
    if (inFlight) {
      return inFlight;
    }

    const syncPromise = this.performSyncAccount(userId, accountId, key);
    this.inFlightSyncs.set(key, syncPromise);

    try {
      return await syncPromise;
    } finally {
      this.inFlightSyncs.delete(key);
    }
  }

  private async performSyncAccount(userId: string, accountId: string, key: string): Promise<LarkChannelGateway | null> {
    if (this.isDisposing) return null;

    const tenant = this.storage.forTenant(userId);
    const account = await tenant.channels.findAccountById(accountId);

    // If account was deleted or disabled, stop and dispose existing gateway
    if (!account || account.status !== 'active') {
      const existing = this.activeGateways.get(key);
      if (existing) {
        this.activeGateways.delete(key);
        this.activeAccounts.delete(key);
        await existing.dispose();
      }
      return null;
    }

    const existingAccount = this.activeAccounts.get(key);
    const credentialsChanged = existingAccount && existingAccount.credentialRef !== account.credentialRef;

    // If gateway is active and credentials unchanged and transport connected, reuse
    const existingGateway = this.activeGateways.get(key);
    if (existingGateway && !credentialsChanged && existingGateway.transport.connected) {
      this.activeAccounts.set(key, account);
      if (existingGateway.account) {
        Object.assign(existingGateway.account, account);
      }
      return existingGateway;
    }

    // Dispose old gateway if credentials changed or disconnected
    if (existingGateway) {
      this.activeGateways.delete(key);
      this.activeAccounts.delete(key);
      await existingGateway.dispose();
    }

    if (this.isDisposing) return null;

    // Resolve credentials if resolver present to capture appId and botOpenId
    let botAppId: string | undefined;
    let botOpenId: string | undefined;

    if (this.credentialResolver && account.credentialRef) {
      const creds = await this.credentialResolver.resolve(userId, account.credentialRef);
      if (creds) {
        botAppId = creds.appId;
        botOpenId = creds.botOpenId;
      }
    }

    // 1. Create transport instance (not started yet)
    let transport: LarkTransport | null = null;
    if (this.transportFactory) {
      transport = await this.transportFactory(account, this.credentialResolver);
    } else if (this.credentialResolver && account.credentialRef) {
      const credTransport = new CredentialedLarkTransport({
        account: {
          id: account.id,
          userId: account.userId,
          credentialRef: account.credentialRef,
          appId: botAppId,
          botOpenId,
        },
        credentialResolver: this.credentialResolver,
      });
      transport = credTransport;
    }

    if (!transport) {
      return null;
    }

    // If transport has resolved botOpenId, prioritize that
    if ((transport as any).botOpenId) {
      botOpenId = (transport as any).botOpenId;
    }

    let defaultSpaceId: string | undefined;
    if (this.defaultSpaceResolver) {
      defaultSpaceId = await this.defaultSpaceResolver(userId, account);
    }

    const streamEventSource = this.streamEventSource;

    // 2. Instantiate Gateway FIRST so that it registers onEvent listener with transport
    const gateway = new LarkChannelGateway({
      account: {
        ...account,
        appId: botAppId,
        botOpenId,
      },
      transport,
      channelRepo: tenant.channels,
      sessionRouteRepo: tenant.sessionRoutes,
      spaceRepo: tenant.spaces,
      runtimeGateway: this.deliveryGateway,
      defaultSpaceId,
      groupActivationMode: (account as ChannelAccount).groupActivationMode,
      streamEventSource,
    });

    // 3. Start transport AFTER gateway listeners are registered
    try {
      await transport.start();
    } catch (startErr) {
      try {
        await gateway.dispose();
      } catch {}
      throw startErr;
    }

    // Final publish gate: ensure manager is still running and account is still active
    if (this.isDisposing || !this.isRunning) {
      try {
        await gateway.dispose();
      } catch {}
      return null;
    }

    const liveCheck = await tenant.channels.findAccountById(accountId);
    if (!liveCheck || liveCheck.status !== 'active') {
      try {
        await gateway.dispose();
      } catch {}
      return null;
    }

    // After start, check if transport resolved botOpenId via API
    if ((transport as any).botOpenId && !botOpenId) {
      (gateway.account as any).botOpenId = (transport as any).botOpenId;
    }

    this.activeGateways.set(key, gateway);
    this.activeAccounts.set(key, account);

    // 4. Redrive any pending outbox for this account
    try {
      await gateway.redrivePendingOutbox();
    } catch {}

    return gateway;
  }

  /**
   * Lifecycle notification: called when an account is updated (e.g. status changed).
   */
  async onAccountUpdated(userId: string, accountId: string): Promise<void> {
    await this.syncAccount(userId, accountId);
  }

  /**
   * Lifecycle notification: called when an account is deleted.
   */
  async onAccountDeleted(userId: string, accountId: string): Promise<void> {
    const key = `${userId}:${accountId}`;
    const existing = this.activeGateways.get(key);
    if (existing) {
      this.activeGateways.delete(key);
      this.activeAccounts.delete(key);
      await existing.dispose();
    }
  }
}
