/**
 * Jarvis channel runtime manager (docs/jarvis-channel.md §3.2, §3.7).
 *
 * - Account lifecycle for `channel_accounts.type = 'jarvis'` (registered as the `jarvis` channel
 *   manager), inherited from {@link JarvisAccountLifecycle}: creating one is admin-only and one per
 *   user; creation issues a bearer token returned once; rotation replaces it; deleting or disabling
 *   the account revokes it. Every live connection of an account whose token changes or goes away
 *   is closed; a token changed by another process (the admin CLI) is noticed at the connection's
 *   next authorization check, which compares the hash it authenticated with.
 * - The WebSocket endpoint (`/api/jarvis/runtime`): the platform server hands it upgrades after
 *   its Host validation; the engine refuses an Origin, a bad token or a missing subprotocol.
 * - Per connection: a {@link PlatformJarvisSource} scoped to the account owner and a
 *   {@link JarvisRuntime} speaking the Jarvis runtime protocol.
 * - Connection status for the management API (`account.jarvis`): live connections and their
 *   times are kept in memory per account; token times come from `channel_account_tokens`.
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
import type { ChannelAccount, PlatformStorage } from '@enkeep/platform-core';
import type { ChannelAccountLifecycle, ChannelConnectionEndpoint } from '../channel-routes.js';
import type { ApprovalBridge } from '../../interactions/approval-bridge.js';
import type { QuestionBridge } from '../../interactions/question-bridge.js';
import type { RuntimeSessionEventHub } from '../../runtime/session-event-hub.js';
import type { RuntimeSessionReader } from '../../runtime/delivery-gateway.js';
import type { TenantRuntimeFileProvider } from '../../files/runtime-file-api.js';
import { TenantScopedLarkImageIngestor } from '../lark-image-ingestor.js';
import { JARVIS_CHANNEL_TYPE, JarvisAccountLifecycle } from './accounts.js';
import { hashJarvisToken } from './token-store.js';
import {
  PlatformJarvisSource,
  type JarvisDeliveryPort,
  type JarvisImageIngestor,
  type JarvisSessionApi,
} from './source.js';

export { JARVIS_CHANNEL_TYPE } from './accounts.js';
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

/**
 * Connection status of a Jarvis account as the management API shows it (`account.jarvis`).
 * Times are ISO strings; connection times are those seen by this platform process.
 */
export interface JarvisAccountStatus {
  /** A jarvisd node is connected with the account's current token. */
  connected: boolean;
  /** When the current connection was opened. */
  connectedAt?: string;
  lastConnectedAt?: string;
  lastDisconnectedAt?: string;
  /** When the token last authenticated a connection (`channel_account_tokens.last_used_at`). */
  lastUsedAt?: string;
  tokenCreatedAt?: string;
}

interface LiveConnection {
  accountId: string;
  userId: string;
  socket: MessageSocket;
  source: PlatformJarvisSource;
  runtime: JarvisRuntime;
  openedAt: string;
  /** Hash of the token the connection authenticated with (never exposed). */
  credential?: string;
}

/** Connection times of one account in this process (kept in memory only). */
interface AccountConnectionTimes {
  lastConnectedAt?: string;
  lastDisconnectedAt?: string;
}

/** A stored time as ISO 8601 (SQLite's `CURRENT_TIMESTAMP` is UTC without a zone). */
function toIsoTime(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const raw = value.trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export class JarvisRuntimeManager
  extends JarvisAccountLifecycle
  implements ChannelAccountLifecycle, ChannelConnectionEndpoint
{
  readonly upgradePath = JARVIS_RUNTIME_PATH;
  private readonly options: JarvisRuntimeManagerOptions;
  private endpoint: JarvisEndpoint | null = null;
  private readonly connections = new Set<LiveConnection>();
  private readonly connectionTimes = new Map<string, AccountConnectionTimes>();
  private readonly onTurnSettled: TurnSettledListener;
  private gatewayHooked = false;

  constructor(options: JarvisRuntimeManagerOptions) {
    if (!options?.db || !options.storage || !options.gateway) {
      throw new TypeError('JarvisRuntimeManager requires db, storage and gateway');
    }
    super({ db: options.db, storage: options.storage, log: options.log });
    this.options = options;
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
  override connectionsOf(accountId: string): number {
    let n = 0;
    for (const conn of this.connections) if (conn.accountId === accountId) n++;
    return n;
  }

  // ─────────────────────────── Status ───────────────────────────

  /**
   * The connection status of one of the user's Jarvis accounts (`account.jarvis` in the management
   * API). Never carries the token or its hash. A live connection whose token is no longer the
   * account's current one (rotated or revoked by another process) counts as disconnected and is
   * dropped here.
   */
  describeAccountStatus(userId: string, account: ChannelAccount): JarvisAccountStatus | undefined {
    if (!account || account.type !== JARVIS_CHANNEL_TYPE || account.userId !== userId) return undefined;
    let connectedAt: string | undefined;
    for (const conn of Array.from(this.connections)) {
      if (conn.accountId !== account.id || conn.userId !== userId) continue;
      // A connection whose token was rotated or revoked elsewhere (the admin CLI) is not connected:
      // drop it now instead of at its next session refresh.
      if (!this.tokens.isActive(conn.accountId, conn.userId, conn.credential)) {
        this.dropConnection(conn, JARVIS_CLOSE_REVOKED, 'revoked');
        continue;
      }
      if (connectedAt === undefined || conn.openedAt > connectedAt) connectedAt = conn.openedAt;
    }
    const times = this.connectionTimes.get(account.id);
    const token = this.tokens.describe(account.id, userId);
    const lastUsedAt = toIsoTime(token?.lastUsedAt);
    const tokenCreatedAt = toIsoTime(token?.createdAt);
    return {
      connected: connectedAt !== undefined,
      ...(connectedAt !== undefined ? { connectedAt } : {}),
      ...(times?.lastConnectedAt ? { lastConnectedAt: times.lastConnectedAt } : {}),
      ...(times?.lastDisconnectedAt ? { lastDisconnectedAt: times.lastDisconnectedAt } : {}),
      ...(lastUsedAt ? { lastUsedAt } : {}),
      ...(tokenCreatedAt ? { tokenCreatedAt } : {}),
    };
  }

  private noteConnectionTime(accountId: string, key: keyof AccountConnectionTimes, at: string): void {
    const times = this.connectionTimes.get(accountId) ?? {};
    times[key] = at;
    this.connectionTimes.set(accountId, times);
  }

  override async onAccountDeleted(userId: string, accountId: string): Promise<void> {
    await super.onAccountDeleted(userId, accountId);
    if (this.connectionsOf(accountId) === 0) this.connectionTimes.delete(accountId);
  }

  // ─────────────────────────── Endpoint ───────────────────────────

  start(): void {
    if (!this.endpoint) {
      this.endpoint = createJarvisEndpoint({
        authenticate: async (token) => {
          const principal = this.authenticate(token);
          // The connection keeps the hash of its token, so a rotation by another process is noticed.
          return principal ? { ...principal, credential: hashJarvisToken(token) } : null;
        },
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
    const { accountId, userId, socket, credential } = connection;
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
      isAuthorized: () => this.tokens.isActive(accountId, userId, credential),
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
    const openedAt = new Date().toISOString();
    conn = { accountId, userId, socket, source, runtime, openedAt, ...(credential !== undefined ? { credential } : {}) };
    this.connections.add(conn);
    this.noteConnectionTime(accountId, 'lastConnectedAt', openedAt);
    const opened = conn;
    socket.onClose((code) => {
      if (!this.connections.delete(opened)) return;
      this.noteConnectionTime(accountId, 'lastDisconnectedAt', new Date().toISOString());
      opened.source.dispose();
      void this.audit(userId, 'jarvis.connection_closed', { accountId, code });
    });
    void this.audit(userId, 'jarvis.connection_opened', { accountId });
    void runtime.start();
  }

  private dropConnection(conn: LiveConnection, code: number, reason: string): void {
    if (!this.connections.delete(conn)) return;
    this.noteConnectionTime(conn.accountId, 'lastDisconnectedAt', new Date().toISOString());
    conn.source.dispose();
    // Close with our code first; the engine's stop() would otherwise close with 1001.
    conn.socket.close(code, reason);
    conn.runtime.stop();
    void this.audit(conn.userId, 'jarvis.connection_closed', { accountId: conn.accountId, code });
  }

  /** Close every live connection of an account. */
  override closeAccountConnections(accountId: string, code = JARVIS_CLOSE_REVOKED, reason = 'revoked'): number {
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
}
