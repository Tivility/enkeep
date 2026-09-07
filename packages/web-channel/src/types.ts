import type {
  LifecycleStatus,
  AuthContext,
  UserLocale,
  UserTheme,
} from '@enkeep/platform-core';
import type {
  PublicMessageAttachment,
  CanonicalAttachment,
} from '@enkeep/protocol';

/**
 * Public User contract exposed by web channel.
 * Contains flat identity and locale (no nested preferences or language wrapper).
 */
export interface PublicUser {
  readonly id: string;
  readonly username: string;
  readonly role: 'admin' | 'user';
  readonly status?: string;
  readonly displayName?: string | null;
  readonly locale: UserLocale;
  readonly theme: UserTheme;
  readonly mustChangePassword: boolean;
}

/**
 * Public lifecycle status.
 */
export type PublicLifecycleStatus = LifecycleStatus;

/**
 * Safe profile binding information.
 * Exactly profile id, name, version or null. No snapshot/hash.
 */
export interface PublicProfileBinding {
  readonly profile: {
    readonly id: string;
    readonly name: string;
    readonly version: number;
  } | null;
}

/**
 * Public Space contract exposed over HTTP/Web.
 * Exactly id, name, status, times, and optional profileBinding.
 */
export interface PublicSpace {
  readonly id: string;
  readonly name: string;
  readonly executionMode?: 'container' | 'host';
  readonly status: PublicLifecycleStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly profileBinding?: PublicProfileBinding | null;
}

/**
 * Public Session contract exposed over HTTP/Web.
 * Exactly id, spaceId, title (null | string), status, currentGeneration, times.
 */
export interface PublicSession {
  readonly id: string;
  readonly spaceId: string;
  readonly title: string | null;
  readonly status: PublicLifecycleStatus;
  readonly currentGeneration: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Public Session Generation contract exposed over HTTP/Web.
 * Exactly generation, resetReason (null | string), createdAt, isCurrent.
 */
export interface PublicGeneration {
  readonly generation: number;
  readonly resetReason: string | null;
  readonly createdAt: string;
  readonly isCurrent: boolean;
}

export interface MessageReplyReference {
  readonly messageId: string;
  readonly role?: string;
  readonly snippet: string;
}

/**
 * Public Message contract exposed over HTTP/Web.
 * Exactly id, role, content, status (REQUIRED), createdAt, optional attachments.
 */
export interface PublicMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly status: 'pending' | 'delivered' | 'failed';
  readonly createdAt: string;
  readonly attachments?: readonly PublicMessageAttachment[];
  readonly replyReference?: MessageReplyReference;
}

/**
 * Turn execution lifecycle status.
 */
export type TurnExecutionStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'waiting_approval'
  | 'recovery_required';

/**
 * Public Event & Error Codes allowlist union.
 */
export type PublicEventCode =
  | 'TURN_FAILED'
  | 'TURN_TIMEOUT'
  | 'TURN_CANCELLED'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'INTERRUPTED'
  | 'EXECUTION_FAILED'
  | 'INTERNAL_ERROR'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'RECOVERY_REQUIRED'
  | 'WAITING_APPROVAL';

/**
 * Tool execution status on public web channel.
 */
export type PublicToolStatus = 'started' | 'completed' | 'failed';

/**
 * Public Web Channel Event contract exposed over HTTP/Web.
 * Discriminated union of message, assistant_delta, assistant_stream_end, thinking, tool_status, turn_status, and error.
 * No turnId, raw payload, or result fields.
 */
export type PublicWebChannelEvent =
  | {
      readonly id: string;
      readonly type: 'message';
      readonly message: PublicMessage;
      readonly timestamp: string;
    }
  | {
      readonly id: string;
      readonly type: 'assistant_delta';
      readonly streamId: string;
      readonly delta: string;
      readonly accumulatedLength: number;
      readonly timestamp: string;
    }
  | {
      readonly id: string;
      readonly type: 'assistant_stream_end';
      readonly streamId: string;
      readonly timestamp: string;
    }
  | {
      readonly id: string;
      readonly type: 'thinking';
      readonly streamId?: string;
      readonly status: 'thinking';
      readonly timestamp: string;
    }
  | {
      readonly id: string;
      readonly type: 'tool_status';
      readonly toolName: string;
      readonly status: PublicToolStatus;
      readonly timestamp: string;
    }
  | {
      readonly id: string;
      readonly type: 'turn_status';
      readonly status: TurnExecutionStatus;
      readonly code?: PublicEventCode;
      readonly timestamp: string;
    }
  | {
      readonly id: string;
      readonly type: 'error';
      readonly code: PublicEventCode;
      readonly timestamp: string;
    };

/**
 * Options for generational session reset.
 */
export interface ResetSessionOptions {
  readonly idempotencyKey: string;
  readonly reason?: string;
}

/**
 * Safe receipt returned from generational session reset.
 */
export interface ResetSessionResult {
  readonly session: PublicSession;
  readonly generation: PublicGeneration;
  readonly isIdempotentHit: boolean;
}

/**
 * Space creation input (name only).
 */
export interface CreateSpaceInput {
  readonly name: string;
}

/**
 * Space update input (name only).
 */
export interface UpdateSpaceInput {
  readonly name?: string;
  readonly executionMode?: 'container' | 'host';
}

/**
 * Session creation input (spaceId and optional title).
 */
export interface CreateSessionInput {
  readonly spaceId: string;
  readonly title?: string | null;
  readonly executionMode?: 'container' | 'host';
}

/**
 * Session update input (optional title).
 */
export interface UpdateSessionInput {
  readonly title?: string | null;
}

/**
 * Login result containing authenticated public user and set-cookie header.
 */
export interface LoginResult {
  readonly user: PublicUser;
  readonly cookieHeader: string;
}

export interface ForkSessionOptions {
  readonly fromMessageId?: string;
  readonly fromTurnId?: string;
  readonly title?: string;
  readonly targetSpaceId?: string;
  readonly idempotencyKey?: string;
}

/**
 * Platform Web API interface exposed to Web Channel handlers.
 */
export interface PlatformWebApi {
  // Auth
  authenticateCookie(cookieHeader?: string): Promise<{ user: PublicUser; session: { id: string } } | null>;
  login(username: string, password: string, context?: AuthContext): Promise<LoginResult>;
  logout(sessionId: string): Promise<void>;

  // Spaces
  listSpaces(userId: string, options?: { includeArchived?: boolean; status?: LifecycleStatus }): Promise<PublicSpace[]>;
  getSpace(userId: string, spaceId: string): Promise<PublicSpace | null>;
  createSpace(userId: string, input: CreateSpaceInput): Promise<PublicSpace>;
  updateSpace(userId: string, spaceId: string, input: UpdateSpaceInput): Promise<PublicSpace>;
  archiveSpace(userId: string, spaceId: string): Promise<PublicSpace>;
  restoreSpace(userId: string, spaceId: string): Promise<PublicSpace>;
  deleteSpace(userId: string, spaceId: string): Promise<boolean>;

  // Sessions - single options object, no string overload
  listSessions(
    userId: string,
    options?: { spaceId?: string; includeArchived?: boolean; status?: LifecycleStatus }
  ): Promise<PublicSession[]>;
  getSession(userId: string, sessionId: string): Promise<PublicSession | null>;
  createSession(userId: string, input: CreateSessionInput): Promise<PublicSession>;
  updateSession(userId: string, sessionId: string, input: UpdateSessionInput): Promise<PublicSession>;
  archiveSession(userId: string, sessionId: string): Promise<PublicSession>;
  restoreSession(userId: string, sessionId: string): Promise<PublicSession>;
  forkSession(userId: string, sessionId: string, options?: ForkSessionOptions): Promise<PublicSession>;
  deleteSession(userId: string, sessionId: string): Promise<boolean>;
  resetSession(userId: string, sessionId: string, options: ResetSessionOptions): Promise<ResetSessionResult>;
  listSessionGenerations(userId: string, sessionId: string): Promise<PublicGeneration[]>;

  // Messages & History - bidirectional keyset pagination
  listMessages(
    userId: string,
    sessionId: string,
    options?: { limit?: number; before?: string; after?: string; cursor?: string }
  ): Promise<{
    readonly messages: PublicMessage[];
    readonly hasMore: boolean;
    readonly olderCursor: string | null;
    readonly newerCursor: string | null;
  }>;
  getMessage(userId: string, sessionId: string, messageId: string): Promise<PublicMessage | null>;

  // Polling / Events - nextCursor is required string | null
  pollEvents(
    userId: string,
    sessionId: string,
    cursor?: string
  ): Promise<{
    readonly events: PublicWebChannelEvent[];
    readonly nextCursor: string | null;
  }>;
}

/**
 * Inbound envelope for Web Channel dispatch.
 * Exact internal contract: id, userId, sessionId, content, timestamp, optional attachments.
 */
export interface InboundEnvelope {
  readonly id: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly content: string;
  readonly timestamp: string;
  readonly attachments?: readonly CanonicalAttachment[];
  readonly replyToMessageId?: string;
}

/**
 * Internal result returned by runtime gateway dispatch.
 * Exact internal contract: accepted, turnId, message, isDuplicate.
 */
export interface InternalRuntimeDispatchResult {
  readonly accepted: true;
  readonly turnId: string;
  readonly message: PublicMessage;
  readonly isDuplicate: boolean;
  readonly queuePosition?: number;
}

/**
 * Runtime gateway interface for web channel turn dispatch and status querying.
 * Public methods strictly limited to dispatchInbound, getCurrentTurnStatus, and cancelCurrentTurn.
 */
export interface RuntimeGateway {
  dispatchInbound(envelope: InboundEnvelope): Promise<InternalRuntimeDispatchResult>;
  getCurrentTurnStatus(userId: string, sessionId: string): Promise<{
    readonly status: TurnExecutionStatus;
    readonly code?: PublicEventCode;
  } | null>;
  cancelCurrentTurn(userId: string, sessionId: string): Promise<boolean>;
  getTurnStatus?(userId: string, turnId: string): Promise<{
    readonly status: TurnExecutionStatus;
    readonly error?: string;
  } | null>;
  cancelTurn?(userId: string, turnId: string): Promise<boolean>;
}

export type { LifecycleStatus, AuthContext, PublicMessageAttachment, CanonicalAttachment };
