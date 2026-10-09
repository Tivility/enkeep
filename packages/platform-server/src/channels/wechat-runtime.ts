/**
 * WeChat Channel Runtime Manager.
 * Manages WeChat account lifecycles, single-poller concurrency guard,
 * long-polling transport lifecycle, atomic cursor persistence, and outbox delivery wiring.
 *
 * @module @enkeep/platform-server/channels/wechat-runtime
 */

import { createHash, createDecipheriv, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  PlatformStorage,
  ChannelAccount,
  SessionRoute,
} from '@enkeep/platform-core';
import type { PublicEventCode } from '@enkeep/web-channel';
import {
  type DeliveryRuntimeGateway,
  type TurnExecutionResult,
} from '../runtime/delivery-gateway.js';
import { TenantScopedLarkImageIngestor } from './lark-image-ingestor.js';
import {
  SqliteStreamEventSource,
  type AutonomousTurnCompletedPayload,
} from './sqlite-stream-event-source.js';
import {
  WeChatChannelGateway,
  ContextTokenStore,
  CredentialedWeChatTransport,
  extractFinalAnswerText,
  markdownToPlainText,
  type WeChatConnectionState,
  type WeChatTransport,
  type WeChatTransportConfig,
  type WeChatMediaAttachmentIngestor,
} from '@enkeep/channel-wechat';

export interface WeChatResolvedCredentials {
  readonly botToken: string;
  readonly ilinkBotId: string;
  readonly baseUrl?: string;
  readonly cdnBaseUrl?: string;
  readonly getUpdatesBuf?: string;
  readonly bypassProxy?: boolean;
}

export type WeChatCredentialResolver = (
  userId: string,
  credentialRef: string
) => Promise<WeChatResolvedCredentials | null> | WeChatResolvedCredentials | null;

export type WeChatTransportFactory = (
  account: ChannelAccount,
  resolvedCreds?: WeChatResolvedCredentials | null
) => Promise<WeChatTransport | null> | WeChatTransport | null;

export type WeChatDefaultSpaceResolver = (
  userId: string,
  account: ChannelAccount
) => Promise<string | undefined> | string | undefined;

export interface WeChatRuntimeManagerOptions {
  readonly storage: PlatformStorage;
  readonly db?: DatabaseSync;
  readonly deliveryGateway: DeliveryRuntimeGateway;
  readonly credentialResolver?: WeChatCredentialResolver;
  readonly transportFactory?: WeChatTransportFactory;
  readonly defaultSpaceResolver?: WeChatDefaultSpaceResolver;
  readonly masterKey?: Buffer | string;
  readonly workerIntervalMs?: number;
  readonly autoStart?: boolean;
  readonly mediaAttachmentIngestor?: WeChatMediaAttachmentIngestor;
  readonly imageAttachmentIngestor?: WeChatMediaAttachmentIngestor;
  readonly streamEventSource?: SqliteStreamEventSource;
}

export class WeChatRuntimeManager {
  private readonly storage: PlatformStorage;
  private readonly db?: DatabaseSync;
  private readonly deliveryGateway: DeliveryRuntimeGateway;
  private readonly credentialResolver?: WeChatCredentialResolver;
  private readonly transportFactory?: WeChatTransportFactory;
  private readonly defaultSpaceResolver?: WeChatDefaultSpaceResolver;
  private readonly masterKey?: Buffer;
  private readonly workerIntervalMs: number;
  private readonly mediaAttachmentIngestor?: WeChatMediaAttachmentIngestor;
  private readonly streamEventSource?: SqliteStreamEventSource;

  private isRunning = false;
  private isDisposing = false;
  private isTickRunning = false;
  private workerTimer?: NodeJS.Timeout;

  // Active instances mapped by `${userId}:${accountId}`
  private readonly activeGateways = new Map<string, WeChatChannelGateway>();
  private readonly activeAccounts = new Map<string, ChannelAccount>();
  private readonly activeTransports = new Map<string, WeChatTransport>();

  // Single-Poller Concurrency Guard: in-flight sync promises per account
  private readonly inFlightSyncs = new Map<string, Promise<WeChatChannelGateway | null>>();

  // Account state & cursor tracking
  private readonly accountStates = new Map<string, WeChatConnectionState>();
  private readonly accountNeedsReLogin = new Map<string, boolean>();
  private readonly persistedCursors = new Map<string, string>();

  // Two-level Context Token Store
  readonly contextTokenStore: ContextTokenStore;

  private turnCompletedListener?: (event: {
    userId: string;
    sessionId: string;
    spaceId: string;
    turnId: string;
    deliveryId: string;
    idempotencyKey: string;
    executionResult: TurnExecutionResult;
    tokenUsage: { tokens: number };
    executionMode?: 'runtime' | 'command';
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

  constructor(options: WeChatRuntimeManagerOptions) {
    this.storage = options.storage;
    this.db = options.db;
    this.deliveryGateway = options.deliveryGateway;
    this.credentialResolver = options.credentialResolver;
    this.transportFactory = options.transportFactory;
    this.defaultSpaceResolver = options.defaultSpaceResolver;
    this.workerIntervalMs = options.workerIntervalMs ?? 2500;

    if (options.masterKey) {
      if (typeof options.masterKey === 'string') {
        this.masterKey = createHash('sha256').update(options.masterKey, 'utf8').digest();
      } else if (Buffer.isBuffer(options.masterKey)) {
        this.masterKey =
          options.masterKey.length === 32
            ? options.masterKey
            : createHash('sha256').update(options.masterKey).digest();
      }
    }

    if (options.mediaAttachmentIngestor || options.imageAttachmentIngestor) {
      this.mediaAttachmentIngestor = options.mediaAttachmentIngestor ?? options.imageAttachmentIngestor;
    } else {
      const fp = this.deliveryGateway.getFileProvider();
      if (fp) {
        this.mediaAttachmentIngestor = new TenantScopedLarkImageIngestor({ fileProvider: fp });
      }
    }

    this.contextTokenStore = new ContextTokenStore({ db: this.db });
    this.streamEventSource =
      options.streamEventSource ?? (this.db ? new SqliteStreamEventSource(this.db) : undefined);

    if (this.db) {
      this.initDatabaseTables();
    }
  }

  private initDatabaseTables(): void {
    if (!this.db) return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS channel_wechat_cursors (
          account_id TEXT PRIMARY KEY,
          cursor TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );
        CREATE INDEX IF NOT EXISTS idx_wechat_cursors_updated ON channel_wechat_cursors(updated_at);
      `);
    } catch {
      // Ignore table creation error
    }
  }

  get running(): boolean {
    return this.isRunning && !this.isDisposing;
  }

  get activeGatewayCount(): number {
    return this.activeGateways.size;
  }

  getActiveGateway(userId: string, accountId: string): WeChatChannelGateway | undefined {
    return this.activeGateways.get(`${userId}:${accountId}`);
  }

  getAccountState(accountId: string): WeChatConnectionState | undefined {
    return this.accountStates.get(accountId);
  }

  getAccountNeedsReLogin(accountId: string): boolean {
    return this.accountNeedsReLogin.get(accountId) === true;
  }

  getPersistedCursor(accountId: string): string {
    const memory = this.persistedCursors.get(accountId);
    if (memory !== undefined) return memory;

    if (this.db) {
      try {
        const row = this.db
          .prepare('SELECT cursor FROM channel_wechat_cursors WHERE account_id = ?')
          .get(accountId) as { cursor?: string } | undefined;
        if (row?.cursor) {
          this.persistedCursors.set(accountId, row.cursor);
          return row.cursor;
        }
      } catch {
        // Ignore query error
      }
    }
    return '';
  }

  setPersistedCursor(accountId: string, cursor: string): void {
    this.persistedCursors.set(accountId, cursor);
    if (this.db) {
      try {
        this.db
          .prepare(`
            INSERT INTO channel_wechat_cursors (account_id, cursor, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(account_id) DO UPDATE SET
              cursor = excluded.cursor,
              updated_at = CURRENT_TIMESTAMP
          `)
          .run(accountId, cursor);
      } catch {
        // Ignore write error
      }
    }
  }

  /**
   * Starts the runtime manager, subscribes to turn events, reconciles accounts, and launches background tick.
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isDisposing = false;

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

    // 3. Start background maintenance worker
    this.startWorker();
  }

  /**
   * Stops the runtime manager, all active gateways, transports, and cleans up event subscriptions.
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

    // Await all in-flight account sync operations
    if (this.inFlightSyncs.size > 0) {
      await Promise.allSettled(Array.from(this.inFlightSyncs.values()));
    }

    const gateways = Array.from(this.activeGateways.values());
    const transports = Array.from(this.activeTransports.values());

    this.activeGateways.clear();
    this.activeAccounts.clear();
    this.activeTransports.clear();
    this.inFlightSyncs.clear();

    for (const gw of gateways) {
      try {
        await gw.dispose();
      } catch {
        // Ignore stop errors during teardown
      }
    }

    for (const transport of transports) {
      try {
        await transport.stop();
      } catch {
        // Ignore transport stop error
      }
    }
  }

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
   * Reconciles all active WeChat accounts in database.
   */
  async reconcileAllAccounts(): Promise<void> {
    if (!this.db || !this.isRunning || this.isDisposing) return;

    try {
      const activeRows = this.db
        .prepare(`
          SELECT id, user_id, type, status, credential_ref
          FROM channel_accounts
          WHERE status = 'active' AND type = 'wechat'
        `)
        .all() as Array<{ id: string; user_id: string; type: string; status: string }>;

      for (const row of activeRows) {
        if (!this.isRunning || this.isDisposing) break;
        await this.syncAccount(row.user_id, row.id);
      }
    } catch {
      // Ignore reconciliation errors on fresh db
    }
  }

  /**
   * Synchronizes an account lifecycle (start, stop, or reuse poller).
   * Implements Single-Poller Concurrency Guard using promise coalescing.
   */
  async syncAccount(userId: string, accountId: string): Promise<WeChatChannelGateway | null> {
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

  private async performSyncAccount(
    userId: string,
    accountId: string,
    key: string
  ): Promise<WeChatChannelGateway | null> {
    if (this.isDisposing) return null;

    const tenant = this.storage.forTenant(userId);
    const account = await tenant.channels.findAccountById(accountId);

    // 1. If account deleted or disabled, stop and dispose existing poller
    if (!account || account.status !== 'active') {
      const existingGateway = this.activeGateways.get(key);
      const existingTransport = this.activeTransports.get(key);
      if (existingGateway || existingTransport) {
        this.activeGateways.delete(key);
        this.activeAccounts.delete(key);
        this.activeTransports.delete(key);
        if (existingGateway) await existingGateway.dispose();
        if (existingTransport) await existingTransport.stop();
      }
      return null;
    }

    const existingAccount = this.activeAccounts.get(key);
    const existingGateway = this.activeGateways.get(key);
    const existingTransport = this.activeTransports.get(key);

    const credentialsChanged =
      existingAccount && existingAccount.credentialRef !== account.credentialRef;

    // 2. Single-poller reuse: If gateway exists and credentials unchanged and transport is connected, reuse
    if (
      existingGateway &&
      existingTransport &&
      !credentialsChanged &&
      existingTransport.connected
    ) {
      this.activeAccounts.set(key, account);
      return existingGateway;
    }

    // 3. Dispose old gateway before creating new one
    if (existingGateway || existingTransport) {
      this.activeGateways.delete(key);
      this.activeAccounts.delete(key);
      this.activeTransports.delete(key);
      if (existingGateway) await existingGateway.dispose();
      if (existingTransport) await existingTransport.stop();
    }

    if (this.isDisposing) return null;

    // 4. Resolve credentials
    let creds: WeChatResolvedCredentials | null = null;
    if (this.credentialResolver && account.credentialRef) {
      creds = await this.credentialResolver(userId, account.credentialRef);
    } else if (account.credentialRef) {
      creds = await this.resolveCredentialsFromDb(userId, account.credentialRef);
    }

    // 5. Initial cursor resolution: check persisted cursor table first, fallback to credentials
    let initialCursor = this.getPersistedCursor(accountId);
    if (!initialCursor && creds?.getUpdatesBuf) {
      initialCursor = creds.getUpdatesBuf;
      this.setPersistedCursor(accountId, initialCursor);
    }

    // 6. Create transport
    let transport: WeChatTransport | null = null;
    if (this.transportFactory) {
      transport = await this.transportFactory(account, creds);
    } else if (creds) {
      const config: WeChatTransportConfig = {
        botToken: creds.botToken,
        ilinkBotId: creds.ilinkBotId,
        baseUrl: creds.baseUrl,
        cdnBaseUrl: creds.cdnBaseUrl,
        initialCursor,
        bypassProxy: creds.bypassProxy,
        logContext: { accountId, userId },
      };
      transport = new CredentialedWeChatTransport(config);
    }

    if (!transport) {
      return null;
    }

    // 7. Wire cursor persistence hook on transport
    if (typeof (transport as any).onCursorCommit === 'function') {
      (transport as any).onCursorCommit(async (cursor: string) => {
        this.setPersistedCursor(accountId, cursor);
      });
    }

    // 8. Wire state change hook: handle -14 expired without crash
    if (typeof (transport as any).onStateChange === 'function') {
      (transport as any).onStateChange(async (state: WeChatConnectionState) => {
        this.accountStates.set(accountId, state);
        if (state.status === 'expired') {
          // -14 session expired: mark account as needing re-login
          this.accountNeedsReLogin.set(accountId, true);
          try {
            if (this.db) {
              this.db
                .prepare(`
                  UPDATE channel_accounts
                  SET status = 'unverified', updated_at = CURRENT_TIMESTAMP
                  WHERE id = ?
                `)
                .run(accountId);
            }
            await tenant.channels.updateAccount(accountId, { status: 'unverified' });
          } catch {
            // Ignore DB update error
          }

          // Tear down gateway cleanly
          const gw = this.activeGateways.get(key);
          const tr = this.activeTransports.get(key);
          this.activeGateways.delete(key);
          this.activeAccounts.delete(key);
          this.activeTransports.delete(key);
          if (gw) await gw.dispose().catch(() => {});
          if (tr) await tr.stop().catch(() => {});
        }
      });
    }

    // 9. Instantiate WeChatChannelGateway (attaches onMessage and onCursorCommit before poller starts)
    const gateway = new WeChatChannelGateway({
      account,
      transport,
      channelRepo: tenant.channels,
      sessionRouteRepo: tenant.sessionRoutes,
      spaceRepo: tenant.spaces,
      runtimeGateway: this.deliveryGateway,
      contextTokenStore: this.contextTokenStore,
      defaultSpaceId: account.defaultSpaceId,
      mediaAttachmentIngestor: this.mediaAttachmentIngestor,
      onCursorCommit: async (cursor: string) => {
        this.setPersistedCursor(accountId, cursor);
      },
    });

    // Attach proactive delivery method to gateway for task-worker and external triggers
    (gateway as any).sendProactiveMessage = async (params: {
      chatId: string;
      text: string;
      title?: string;
      sessionId?: string;
      outboxId?: string;
      accountId?: string;
    }): Promise<{ success: boolean; messageId?: string; error?: string }> => {
      let toUserId = params.chatId;
      if (toUserId.startsWith('wechat:')) toUserId = toUserId.slice(7);
      if (toUserId.includes(':')) toUserId = toUserId.split(':')[0];
      toUserId = toUserId.trim();

      // 1. Resolve persisted context_token
      const contextToken = await this.contextTokenStore.get(toUserId);
      if (!contextToken) {
        const errorMsg = `Missing cached context_token for recipient "${toUserId}". User must message the bot first before proactive delivery is allowed.`;
        if (params.outboxId) {
          try {
            await tenant.channels.createOutboxItem({
              id: params.outboxId,
              accountId,
              sessionId: params.sessionId || '',
              nativeContextId: params.chatId,
              replyToNativeId: null,
              payloadJson: JSON.stringify({
                toUserId,
                text: params.text,
                error: errorMsg,
              }),
              status: 'failed',
            });
          } catch {}
        }
        throw new Error(`WeChat proactive delivery failed: ${errorMsg}`);
      }

      // 2. Create pending outbox item
      const outboxId = params.outboxId || `out_wechat_proactive_${randomUUID()}`;
      let outboxItem = await tenant.channels.createOutboxItem({
        id: outboxId,
        accountId,
        sessionId: params.sessionId || '',
        nativeContextId: params.chatId,
        replyToNativeId: null,
        payloadJson: JSON.stringify({
          toUserId,
          contextToken,
          text: params.text,
        }),
        status: 'pending',
      });

      // 3. Send outbound reply via transport
      try {
        const replyResult = await transport.sendReply(toUserId, contextToken, params.text);
        if (replyResult.success) {
          await tenant.channels.updateOutboxStatus(outboxItem.id, 'delivered');
          return { success: true };
        } else {
          await tenant.channels.updateOutboxStatus(outboxItem.id, 'failed', true);
          return { success: false, error: replyResult.error || 'Failed to send proactive message' };
        }
      } catch (err: any) {
        await tenant.channels.updateOutboxStatus(outboxItem.id, 'failed', true);
        throw err;
      }
    };

    // 10. Start transport poller
    await transport.start();

    this.activeGateways.set(key, gateway);
    this.activeAccounts.set(key, account);
    this.activeTransports.set(key, transport);

    return gateway;
  }

  private async resolveCredentialsFromDb(
    userId: string,
    credentialRef: string
  ): Promise<WeChatResolvedCredentials | null> {
    if (!this.db) return null;

    try {
      const row = this.db
        .prepare(`
          SELECT encrypted_payload
          FROM channel_encrypted_credentials
          WHERE credential_ref = ?
        `)
        .get(credentialRef) as { encrypted_payload?: string } | undefined;

      if (!row?.encrypted_payload) return null;
      const raw = row.encrypted_payload;

      // Plain JSON or plain object
      if (raw.startsWith('{')) {
        return JSON.parse(raw);
      }

      // AES-256-GCM encrypted format: v1:iv:tag:ciphertext
      if (raw.startsWith('v1:') && this.masterKey) {
        const parts = raw.split(':');
        if (parts.length === 4) {
          const [, ivHex, tagHex, dataHex] = parts;
          const iv = Buffer.from(ivHex, 'hex');
          const tag = Buffer.from(tagHex, 'hex');
          const ciphertext = Buffer.from(dataHex, 'hex');
          const aad = Buffer.from(`${userId}:${credentialRef}`, 'utf8');

          const decipher = createDecipheriv('aes-256-gcm', this.masterKey, iv);
          decipher.setAAD(aad);
          decipher.setAuthTag(tag);
          const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
          return JSON.parse(decrypted.toString('utf8'));
        }
      }
    } catch {
      // Decryption or parse error
    }
    return null;
  }

  /**
   * Handles turn completion notification from DeliveryRuntimeGateway.
   */
  async handleTurnCompleted(event: {
    userId: string;
    sessionId: string;
    spaceId: string;
    turnId: string;
    deliveryId: string;
    idempotencyKey: string;
    executionResult: TurnExecutionResult;
    tokenUsage: { tokens: number };
    executionMode?: 'runtime' | 'command';
  }): Promise<void> {
    const { userId, sessionId, turnId, idempotencyKey, executionResult } = event;
    const tenant = this.storage.forTenant(userId);
    const route = await tenant.sessionRoutes.findById(sessionId);

    // 1. Resolve turn origin: check channel_turn_origins, idempotencyKey prefix, or idempotency_records (mirroring Lark)
    let accountId: string | undefined;
    let nativeEventId: string | undefined;
    let replyToMessageId: string | undefined;
    let nativeContextId: string | undefined;

    if (this.db) {
      try {
        const originRow = this.db.prepare(
          'SELECT account_id, channel, native_event_id, reply_to_message_id, native_context_id FROM channel_turn_origins WHERE turn_id = ? AND user_id = ? LIMIT 1'
        ).get(turnId, userId) as {
          account_id?: string;
          channel?: string;
          native_event_id?: string;
          reply_to_message_id?: string;
          native_context_id?: string;
        } | undefined;
        if (originRow && originRow.channel === 'wechat' && originRow.account_id) {
          accountId = originRow.account_id;
          nativeEventId = originRow.native_event_id || undefined;
          replyToMessageId = originRow.reply_to_message_id || undefined;
          nativeContextId = originRow.native_context_id || undefined;
        }
      } catch {}
    }

    if (!accountId && idempotencyKey) {
      const match = idempotencyKey.match(/^idem_wechat_([^_]+)_(.+)$/);
      if (match) {
        accountId = match[1];
        nativeEventId = match[2];
      }
    }

    if (!accountId && this.db) {
      try {
        const row = this.db.prepare(
          'SELECT idempotency_key FROM idempotency_records WHERE turn_id = ? AND user_id = ? LIMIT 1'
        ).get(turnId, userId) as { idempotency_key?: string } | undefined;
        if (row?.idempotency_key) {
          const match = row.idempotency_key.match(/^idem_wechat_([^_]+)_(.+)$/);
          if (match) {
            accountId = match[1];
            nativeEventId = match[2];
          }
        }
      } catch {}
    }

    if (!accountId && route && route.channel === 'wechat' && route.accountId) {
      accountId = route.accountId;
    }

    if (!accountId) {
      // Not a WeChat channel turn
      return;
    }

    // 2. Query exact inbox item to resolve context_token and reply metadata (mirroring Lark's findInboxByEvent)
    let toUserId: string | undefined;
    const effectiveNativeContextId = nativeContextId || route?.nativeContextId || '';
    if (effectiveNativeContextId) {
      toUserId = effectiveNativeContextId.startsWith('wechat:')
        ? effectiveNativeContextId.slice(7)
        : effectiveNativeContextId;
      if (toUserId.includes(':')) {
        toUserId = toUserId.split(':')[0];
      }
    }

    if (nativeEventId) {
      try {
        const inboxItem = await tenant.channels.findInboxByEvent(accountId, nativeEventId);
        if (inboxItem) {
          try {
            const parsedPayload = JSON.parse(inboxItem.payloadJson);
            const parsed = parsedPayload?.parsed;
            if (parsed) {
              if (!replyToMessageId && parsed.messageId) {
                replyToMessageId = String(parsed.messageId);
              }
              const senderId = parsed.senderId || toUserId;
              if (parsed.contextToken && senderId) {
                await this.contextTokenStore.set(senderId, parsed.contextToken);
              }
            }
          } catch {}
        }
      } catch {}
    }

    // 3. Ensure gateway is active
    let gateway = this.getActiveGateway(userId, accountId);
    if (!gateway) {
      gateway = (await this.syncAccount(userId, accountId)) ?? undefined;
    }

    if (!gateway) {
      // Account disabled or poller inactive
      return;
    }

    // 4. Delegate to gateway to create structured outbox item and deliver using persisted context_token
    await gateway.handleTurnCompleted({
      sessionId,
      turnId,
      replyText: executionResult.replyText,
      idempotencyKey: idempotencyKey || `idem_wechat_${accountId}_${nativeEventId || turnId}`,
      nativeContextId: effectiveNativeContextId,
      nativeEventId,
      replyToMessageId,
    });
  }

  /**
   * Handles turn failure notification from DeliveryRuntimeGateway.
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
    if (event.code === 'TURN_TIMEOUT') return;

    const { userId, sessionId, turnId, idempotencyKey } = event;
    const tenant = this.storage.forTenant(userId);
    const route = await tenant.sessionRoutes.findById(sessionId);

    let accountId: string | undefined;
    let nativeEventId: string | undefined;

    if (this.db) {
      try {
        const originRow = this.db.prepare(
          'SELECT account_id, channel, native_event_id FROM channel_turn_origins WHERE turn_id = ? AND user_id = ? LIMIT 1'
        ).get(turnId, userId) as { account_id?: string; channel?: string; native_event_id?: string } | undefined;
        if (originRow && originRow.channel === 'wechat' && originRow.account_id) {
          accountId = originRow.account_id;
          nativeEventId = originRow.native_event_id || undefined;
        }
      } catch {}
    }

    if (!accountId && idempotencyKey) {
      const match = idempotencyKey.match(/^idem_wechat_([^_]+)_(.+)$/);
      if (match) {
        accountId = match[1];
        nativeEventId = match[2];
      }
    }

    if (!accountId && route && route.channel === 'wechat' && route.accountId) {
      accountId = route.accountId;
    }

    if (!accountId) return;

    let gateway = this.getActiveGateway(userId, accountId);
    if (!gateway) {
      gateway = (await this.syncAccount(userId, accountId)) ?? undefined;
    }
    if (!gateway) return;

    const errorReply = '抱歉，当前处理遇到问题，请稍后重试。';
    await gateway.handleTurnCompleted({
      sessionId,
      turnId: `${turnId}_err`,
      replyText: errorReply,
      idempotencyKey: `idem_wechat_err_${accountId}_${nativeEventId || turnId}`,
      nativeContextId: route?.nativeContextId || '',
      nativeEventId,
    });
  }

  /**
   * Handles autonomous turn completion notification for WeChat channel (Item E).
   * Verifies origin, deduplicates outbox ID per Rule C, extracts answer text, and delivers proactively.
   */
  async handleAutonomousTurnCompleted(event: AutonomousTurnCompletedPayload): Promise<void> {
    const { sessionRouteId, turnId, originTurnId, causeChildId } = event;
    if (!this.db || !this.isRunning || this.isDisposing) return;

    const orig = await (this.streamEventSource
      ? this.streamEventSource.resolveTurnOrigin(originTurnId, sessionRouteId)
      : null);
    if (!orig || orig.channel !== 'wechat' || !orig.accountId || !orig.userId) return;

    const outboxId = causeChildId ? `cont_${originTurnId}_${causeChildId}` : `cont_${originTurnId}_${turnId}`;
    if (this.db.prepare('SELECT 1 FROM channel_outbox WHERE id = ? LIMIT 1').get(outboxId)) return;

    const toUserId = (orig.nativeContextId || '').replace(/^wechat:/, '').split(':')[0].trim();
    if (!toUserId) return;
    const contextToken = await this.contextTokenStore.get(toUserId);
    if (!contextToken) {
      console.warn('[wechat-runtime] skipping continuation: missing context_token', { toUserId, turnId, originTurnId });
      return;
    }

    const rows = this.db.prepare(
      `SELECT payload FROM web_events WHERE session_id = ? AND type = 'assistant_delta' AND json_extract(payload, '$.turnId') = ? ORDER BY rowid ASC`
    ).all(sessionRouteId, turnId) as Array<{ payload: string }>;
    const rawReply = rows.map((r) => {
      try { const p = JSON.parse(r.payload); return typeof p.delta === 'string' ? p.delta : ''; } catch { return ''; }
    }).join('');
    if (!rawReply.trim()) return;

    const replyText = markdownToPlainText(extractFinalAnswerText(rawReply));
    if (!replyText.trim()) return;

    await this.sendProactiveMessage({
      userId: orig.userId, accountId: orig.accountId, chatId: orig.nativeContextId || toUserId,
      text: replyText, sessionId: sessionRouteId, outboxId,
    }).catch((err) => console.warn('[wechat-runtime] continuation delivery failed', { outboxId, err }));
  }

  /**
   * Proactively sends a message to a WeChat user via an active account gateway.
   * Fails clearly with an Error if context_token has not been established yet.
   */
  async sendProactiveMessage(params: {
    userId: string;
    accountId: string;
    chatId: string;
    text: string;
    title?: string;
    sessionId?: string;
    outboxId?: string;
  }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const { userId, accountId } = params;
    let gateway = this.getActiveGateway(userId, accountId);
    if (!gateway) {
      gateway = (await this.syncAccount(userId, accountId)) ?? undefined;
    }
    if (!gateway) {
      throw new Error(`WeChat account "${accountId}" not active or gateway unavailable for user "${userId}"`);
    }
    if (typeof (gateway as any).sendProactiveMessage === 'function') {
      return (gateway as any).sendProactiveMessage(params);
    }
    throw new Error('Active WeChat gateway does not support sendProactiveMessage');
  }

  /**
   * Executes periodic background maintenance:
   * 1. Recovers orphan processing inbox items
   * 2. Redrives pending/failed outbox replies (up to 3 attempts)
   */
  async runBackgroundWorkerTick(): Promise<void> {
    if (!this.isRunning || this.isDisposing || this.isTickRunning) return;
    this.isTickRunning = true;

    try {
      if (this.db) {
        // 1. Recover orphan processing inbox items
        try {
          this.db
            .prepare(`
              UPDATE channel_inbox
              SET status = 'failed', updated_at = CURRENT_TIMESTAMP
              WHERE status = 'processing'
                AND datetime(updated_at) < datetime('now', '-60 seconds')
                AND account_id IN (SELECT id FROM channel_accounts WHERE type = 'wechat')
            `)
            .run();
        } catch {
          // Ignore
        }

        // 2. Redrive pending/failed outbox replies (max 3 attempts)
        await this.redrivePendingOutbox();

        // 3. Scan and reconcile committed assistant turns missing outbox records (like Lark)
        await this.scanAndReconcileCommittedTurns();
      }
    } finally {
      this.isTickRunning = false;
    }
  }

  /**
   * Scans SQLite database for completed assistant messages on WeChat sessions
   * that do not have an outbox record yet (e.g. server restart immediately after turn completion).
   */
  async scanAndReconcileCommittedTurns(): Promise<void> {
    if (!this.db || !this.isRunning || this.isDisposing) return;

    try {
      const unOutboxedRows = this.db.prepare(`
        SELECT wm.id as message_id, wm.session_id, wm.user_id, wm.turn_id, wm.content as reply_text,
               sr.account_id, sr.native_context_id, ir.idempotency_key
        FROM web_messages wm
        JOIN session_routes sr ON sr.id = wm.session_id AND sr.channel = 'wechat'
        LEFT JOIN idempotency_records ir ON ir.turn_id = wm.turn_id AND ir.user_id = wm.user_id
        LEFT JOIN channel_outbox co ON co.session_id = wm.session_id AND co.account_id = sr.account_id
             AND json_extract(co.payload_json, '$.turnId') = wm.turn_id
        WHERE wm.role = 'assistant' AND wm.status = 'delivered'
          AND wm.created_at < datetime('now', '-15 seconds')
          AND co.id IS NULL
          AND (ir.idempotency_key LIKE 'idem_wechat_%' OR sr.channel = 'wechat')
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
          idempotencyKey: row.idempotency_key || `idem_wechat_${row.account_id}_${row.turn_id}`,
          executionResult: { replyText: row.reply_text },
          tokenUsage: { tokens: 0 },
        });
      }
    } catch {
      // Ignore scan query errors if tables not ready
    }
  }

  private async redrivePendingOutbox(): Promise<void> {
    if (!this.db) return;

    try {
      const rows = this.db
        .prepare(`
          SELECT co.id, co.user_id, co.account_id, co.session_id, co.payload_json, co.attempts
          FROM channel_outbox co
          JOIN channel_accounts ca ON ca.id = co.account_id AND ca.status = 'active' AND ca.type = 'wechat'
          WHERE co.status IN ('pending', 'failed')
            AND co.attempts < 3
            AND (json_extract(co.payload_json, '$.deliveryStatus') IS NULL OR json_extract(co.payload_json, '$.deliveryStatus') != 'unknown')
          ORDER BY co.created_at ASC LIMIT 10
        `)
        .all() as Array<{
        id: string;
        user_id: string;
        account_id: string;
        session_id: string;
        payload_json: string;
        attempts: number;
      }>;

      for (const row of rows) {
        const gateway =
          this.getActiveGateway(row.user_id, row.account_id) ??
          (await this.syncAccount(row.user_id, row.account_id));

        if (!gateway) continue;

        try {
          const payload = JSON.parse(row.payload_json);
          const toUserId = payload.toUserId;
          const text = payload.text;
          const contextToken = payload.contextToken || (await this.contextTokenStore.get(toUserId));

          if (!toUserId || !text || !contextToken) {
            continue;
          }

          const res = await gateway.transport.sendReply(toUserId, contextToken, text);
          if (res.success) {
            this.db
              .prepare(`
                UPDATE channel_outbox
                SET status = 'delivered', updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
              `)
              .run(row.id);
          } else {
            this.db
              .prepare(`
                UPDATE channel_outbox
                SET attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
              `)
              .run(row.id);
          }
        } catch {
          this.db
            .prepare(`
              UPDATE channel_outbox
              SET attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `)
            .run(row.id);
        }
      }
    } catch {
      // Ignore redrive query errors
    }
  }
}
