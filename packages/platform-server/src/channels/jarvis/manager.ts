/**
 * Jarvis channel runtime manager (docs/jarvis-channel.md §3.2, §3.7).
 *
 * - Account lifecycle for `channel_accounts.type = 'jarvis'` (registered as the `jarvis` channel
 *   manager): creating one is admin-only and one per user; creation issues a bearer token returned
 *   once; rotation replaces it; deleting or disabling the account revokes it. Every live
 *   connection of an account whose token changes or goes away is closed.
 * - The WebSocket endpoint (`/api/jarvis/runtime`): the platform server hands it upgrades after
 *   its Host validation; the engine refuses an Origin, a bad token or a missing subprotocol.
 * - Per connection: a {@link PlatformJarvisSource} scoped to the account owner and a
 *   {@link JarvisRuntime} speaking the Jarvis runtime protocol.
 *
 * Tokens never reach logs or audit details; audit entries carry the account id only.
 *
 * @module @enkeep/platform-server/channels/jarvis/manager
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import {
  JARVIS_RUNTIME_PATH,
  JarvisRuntime,
  createJarvisEndpoint,
  type JarvisConnection,
  type JarvisEndpoint,
  type JarvisLogger,
  type JarvisRuntimeTiming,
  type MessageSocket,
} from '@enkeep/channel-jarvis';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type AuthAuditAction,
  type ChannelAccount,
  type PlatformStorage,
} from '@enkeep/platform-core';
import type { ChannelAccountLifecycle, ChannelConnectionEndpoint } from '../channel-routes.js';
import type { ApprovalBridge } from '../../interactions/approval-bridge.js';
import type { QuestionBridge } from '../../interactions/question-bridge.js';
import type { RuntimeSessionEventHub } from '../../runtime/session-event-hub.js';
import type { RuntimeSessionReader } from '../../runtime/delivery-gateway.js';
import type { TenantRuntimeFileProvider } from '../../files/runtime-file-api.js';
import { TenantScopedLarkImageIngestor } from '../lark-image-ingestor.js';
import { JarvisTokenOwnerConflictError, JarvisTokenStore } from './token-store.js';
import {
  PlatformJarvisSource,
  type JarvisDeliveryPort,
  type JarvisImageIngestor,
  type JarvisSessionApi,
} from './source.js';

export const JARVIS_CHANNEL_TYPE = 'jarvis';
export const JARVIS_DEFAULT_VERSION = '0.1.0';
/** Close code sent when the account's token was rotated or revoked (application range 4000–4999). */
export const JARVIS_CLOSE_REVOKED = 4001;

type TurnSettledListener = (event: { userId: string; sessionId: string }) => unknown;

/** The delivery gateway as the manager uses it (turn listeners are optional). */
export interface JarvisManagerDeliveryPort extends JarvisDeliveryPort {
  onTurnCompleted?(listener: TurnSettledListener): void;
  removeTurnCompletedListener?(listener: TurnSettledListener): void;
  onTurnFailed?(listener: TurnSettledListener): void;
  removeTurnFailedListener?(listener: TurnSettledListener): void;
  getFileProvider?(): TenantRuntimeFileProvider | undefined;
}

export interface JarvisRuntimeManagerOptions {
  db: DatabaseSync;
  /** Users (roles) and the audit log. */
  storage: PlatformStorage;
  gateway: JarvisManagerDeliveryPort;
  /** Session create/rename/archive (PlatformWebApi); a getter allows binding after server start. */
  sessionApi?: JarvisSessionApi | (() => JarvisSessionApi | undefined);
  approvalBridge?: ApprovalBridge;
  /** `ask_user_question` questions of the user's runtimes (question cards). */
  questionBridge?: QuestionBridge;
  sessionEvents?: RuntimeSessionEventHub;
  sessionReader?: Partial<RuntimeSessionReader>;
  /** Defaults to the Lark/WeChat ingestor over `fileProvider` (or the gateway's file provider). */
  imageIngestor?: JarvisImageIngestor;
  fileProvider?: TenantRuntimeFileProvider;
  /** enkeep's version for `runtime.hello`. */
  version?: string;
  /** How long a phone may take to answer a card (seconds); a getter is read per connection. */
  approvalTimeoutSeconds?: number | (() => number | undefined);
  runtimeSpacesDir?: (space: { userId: string; executionMode: string }) => string;
  log?: JarvisLogger;
  /** Engine timing overrides (tests). */
  runtimeTiming?: Partial<JarvisRuntimeTiming>;
}

interface LiveConnection {
  accountId: string;
  userId: string;
  socket: MessageSocket;
  source: PlatformJarvisSource;
  runtime: JarvisRuntime;
}

export class JarvisRuntimeManager implements ChannelAccountLifecycle, ChannelConnectionEndpoint {
  readonly upgradePath = JARVIS_RUNTIME_PATH;
  readonly tokens: JarvisTokenStore;
  private readonly options: JarvisRuntimeManagerOptions;
  private readonly log: JarvisLogger;
  private endpoint: JarvisEndpoint | null = null;
  private readonly connections = new Set<LiveConnection>();
  private readonly onTurnSettled: TurnSettledListener;
  private gatewayHooked = false;
  private auditChain: Promise<void> = Promise.resolve();

  constructor(options: JarvisRuntimeManagerOptions) {
    if (!options?.db || !options.storage || !options.gateway) {
      throw new TypeError('JarvisRuntimeManager requires db, storage and gateway');
    }
    this.options = options;
    this.log = options.log ?? {};
    this.tokens = new JarvisTokenStore(options.db);
    this.onTurnSettled = (event) => {
      for (const conn of this.connections) {
        if (conn.userId === event.userId) conn.source.notifyTurnSettled(event.sessionId);
      }
    };
  }

  /** Number of live Jarvis connections. */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** Live connections of one account (normally at most one). */
  connectionsOf(accountId: string): number {
    let n = 0;
    for (const conn of this.connections) if (conn.accountId === accountId) n++;
    return n;
  }

  // ─────────────────────────── Endpoint ───────────────────────────

  start(): void {
    if (!this.endpoint) {
      this.endpoint = createJarvisEndpoint({
        authenticate: async (token) => this.authenticate(token),
        onConnection: (connection) => this.onConnection(connection),
        log: this.log,
      });
    }
    if (!this.gatewayHooked) {
      this.options.gateway.onTurnCompleted?.(this.onTurnSettled);
      this.options.gateway.onTurnFailed?.(this.onTurnSettled);
      this.gatewayHooked = true;
    }
  }

  stop(): void {
    const endpoint = this.endpoint;
    this.endpoint = null;
    endpoint?.closeAll(1001, 'server stopping');
    for (const conn of Array.from(this.connections)) this.dropConnection(conn, 1001, 'server stopping');
    if (this.gatewayHooked) {
      this.options.gateway.removeTurnCompletedListener?.(this.onTurnSettled);
      this.options.gateway.removeTurnFailedListener?.(this.onTurnSettled);
      this.gatewayHooked = false;
    }
  }

  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (!this.endpoint) this.start();
    await this.endpoint!.handleUpgrade(req, socket, head);
  }

  /** Resolve a bearer token to its active account and active owner. */
  authenticate(token: string): { accountId: string; userId: string } | null {
    try {
      return this.tokens.authenticate(token);
    } catch (err) {
      this.log.error?.({ err: err instanceof Error ? err.name : typeof err }, 'jarvis: token lookup failed');
      return null;
    }
  }

  private onConnection(connection: JarvisConnection): void {
    const { accountId, userId, socket } = connection;
    let conn: LiveConnection | null = null;
    const source = new PlatformJarvisSource({
      userId,
      accountId,
      db: this.options.db,
      gateway: this.options.gateway,
      sessionApi: this.options.sessionApi,
      approvals: this.options.approvalBridge,
      questions: this.options.questionBridge,
      events: this.options.sessionEvents,
      reader: this.options.sessionReader,
      imageIngestor: this.imageIngestor(),
      runtimeSpacesDir: this.options.runtimeSpacesDir,
      isAuthorized: () => this.tokens.isActive(accountId, userId),
      onRevoked: () => {
        if (conn) this.dropConnection(conn, JARVIS_CLOSE_REVOKED, 'revoked');
      },
      log: this.log,
    });
    const timeout = this.approvalTimeoutSeconds();
    const runtime = new JarvisRuntime(socket, source, {
      version: this.options.version ?? JARVIS_DEFAULT_VERSION,
      log: this.log,
      launcher: 'enkeep',
      launcherModel: 'DeepSeek Harness',
      name: 'Enkeep',
      ...(timeout !== undefined ? { approvalTimeoutSeconds: timeout } : {}),
      ...(this.options.runtimeTiming ? { timing: this.options.runtimeTiming } : {}),
    });
    conn = { accountId, userId, socket, source, runtime };
    this.connections.add(conn);
    const opened = conn;
    socket.onClose((code) => {
      if (!this.connections.delete(opened)) return;
      opened.source.dispose();
      void this.audit(userId, 'jarvis.connection_closed', { accountId, code });
    });
    void this.audit(userId, 'jarvis.connection_opened', { accountId });
    void runtime.start();
  }

  private dropConnection(conn: LiveConnection, code: number, reason: string): void {
    if (!this.connections.delete(conn)) return;
    conn.source.dispose();
    // Close with our code first; the engine's stop() would otherwise close with 1001.
    conn.socket.close(code, reason);
    conn.runtime.stop();
    void this.audit(conn.userId, 'jarvis.connection_closed', { accountId: conn.accountId, code });
  }

  /** Close every live connection of an account. */
  closeAccountConnections(accountId: string, code = JARVIS_CLOSE_REVOKED, reason = 'revoked'): number {
    let closed = 0;
    for (const conn of Array.from(this.connections)) {
      if (conn.accountId !== accountId) continue;
      this.dropConnection(conn, code, reason);
      closed++;
    }
    return closed;
  }

  private imageIngestor(): JarvisImageIngestor | undefined {
    if (this.options.imageIngestor) return this.options.imageIngestor;
    const fileProvider = this.options.fileProvider ?? this.options.gateway.getFileProvider?.();
    return fileProvider ? new TenantScopedLarkImageIngestor({ fileProvider }) : undefined;
  }

  private approvalTimeoutSeconds(): number | undefined {
    const raw = this.options.approvalTimeoutSeconds;
    const value = typeof raw === 'function' ? raw() : raw;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  }

  // ─────────────────────────── Account lifecycle ───────────────────────────

  async beforeCreateAccount(userId: string): Promise<void> {
    const user = await this.options.storage.users.findById(userId);
    if (!user || user.role !== 'admin') {
      throw new ForbiddenError('Creating a Jarvis channel is limited to administrators');
    }
    const existing = await this.options.storage.forTenant(userId).channels.listAccounts(JARVIS_CHANNEL_TYPE);
    if (existing.length > 0) {
      throw new ConflictError('This user already has a Jarvis channel', 'JARVIS_ACCOUNT_EXISTS');
    }
  }

  async provisionAccount(userId: string, account: ChannelAccount): Promise<{ token: string }> {
    let token: string;
    try {
      token = this.tokens.issue(account.id, userId);
    } catch (err) {
      // A concurrent creation won the race for this user's one Jarvis account (the caller
      // deletes the account it just created).
      if (err instanceof JarvisTokenOwnerConflictError) {
        throw new ConflictError('This user already has a Jarvis channel', 'JARVIS_ACCOUNT_EXISTS');
      }
      throw err;
    }
    await this.audit(userId, 'jarvis.token_issued', { accountId: account.id });
    return { token };
  }

  async rotateAccountToken(userId: string, accountId: string): Promise<{ token: string }> {
    const user = await this.options.storage.users.findById(userId);
    if (!user || user.role !== 'admin') {
      throw new ForbiddenError('Rotating a Jarvis token is limited to administrators');
    }
    const account = await this.options.storage.forTenant(userId).channels.findAccountById(accountId);
    if (!account || account.type !== JARVIS_CHANNEL_TYPE) {
      throw new NotFoundError(`Channel account "${accountId}" not found`);
    }
    const token = this.tokens.issue(account.id, userId);
    const closed = this.closeAccountConnections(account.id);
    await this.audit(userId, 'jarvis.token_rotated', { accountId: account.id, closedConnections: closed });
    return { token };
  }

  async onAccountCreated(_userId: string, _accountId: string): Promise<void> {
    // The token is issued by provisionAccount; nothing runs until a node connects.
  }

  async onAccountUpdated(userId: string, accountId: string): Promise<void> {
    const account = await this.options.storage.forTenant(userId).channels.findAccountById(accountId);
    if (account && account.status === 'active') return;
    await this.revoke(userId, accountId, account ? 'account_disabled' : 'account_missing');
  }

  async onAccountDeleted(userId: string, accountId: string): Promise<void> {
    await this.revoke(userId, accountId, 'account_deleted');
  }

  async syncAccount(userId: string, accountId: string): Promise<{ connections: number; token: boolean }> {
    const account = await this.options.storage.forTenant(userId).channels.findAccountById(accountId);
    if (!account || account.status !== 'active') {
      this.closeAccountConnections(accountId);
    }
    return { connections: this.connectionsOf(accountId), token: this.tokens.has(accountId) };
  }

  private async revoke(userId: string, accountId: string, reason: string): Promise<void> {
    const removed = this.tokens.revoke(accountId);
    const closed = this.closeAccountConnections(accountId);
    // A deleted account's token row may already be gone through the foreign key cascade.
    if (removed || closed > 0 || reason === 'account_deleted') {
      await this.audit(userId, 'jarvis.token_revoked', { accountId, reason, closedConnections: closed });
    }
  }

  /** Audit entries are written in the order they happen (connection close before rotation, …). */
  private audit(userId: string, action: AuthAuditAction, details: Record<string, unknown>): Promise<void> {
    const write = this.auditChain.then(() => this.writeAudit(userId, action, details));
    this.auditChain = write;
    return write;
  }

  private async writeAudit(userId: string, action: AuthAuditAction, details: Record<string, unknown>): Promise<void> {
    try {
      const user = await this.options.storage.users.findById(userId);
      await this.options.storage.auditLogs.create({
        userId: user ? userId : null,
        username: user?.username ?? null,
        action,
        details,
      });
    } catch (err) {
      this.log.warn?.({ action, err: err instanceof Error ? err.name : typeof err }, 'jarvis: audit log write failed');
    }
  }
}
