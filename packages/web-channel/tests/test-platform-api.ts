import { randomUUID, createHash } from 'node:crypto';
import type {
  User,
  UserSession,
  Space,
  SessionRoute,
  ExecutionMode,
  LifecycleStatus,
} from '@enkeep/platform-core';
import {
  PlatformError,
  NotFoundError,
  UnauthorizedError,
  TenantAccessDeniedError,
  AccountDisabledError,
  ValidationError,
} from '@enkeep/platform-core';
import type {
  PlatformWebApi,
  PublicUser,
  PublicSpace,
  PublicSession,
  PublicGeneration,
  PublicMessage,
  PublicWebChannelEvent,
  CreateSpaceInput,
  UpdateSpaceInput,
  CreateSessionInput,
  UpdateSessionInput,
  ForkSessionOptions,
  ResetSessionOptions,
  ResetSessionResult,
  LoginResult,
} from '../src/types.js';
import {
  createSignedSessionCookie,
  parseSignedSessionCookie,
  generateCryptoSecret,
} from '../src/security.js';

export interface InMemoryPlatformWebApiOptions {
  cookieName?: string;
  cookieSecret?: string;
  cookieSameSite?: 'Strict' | 'Lax';
  sessionTtlSeconds?: number;
}

/**
 * In-memory test harness implementation of PlatformWebApi for contract verification, unit testing, and isolated execution.
 */
export class InMemoryPlatformWebApi implements PlatformWebApi {
  public readonly cookieName: string;
  public readonly cookieSecret: string;
  public readonly cookieSameSite: 'Strict' | 'Lax';
  public readonly sessionTtlSeconds: number;

  // In-memory data tables
  public readonly users = new Map<string, User>();
  public readonly sessions = new Map<string, UserSession>();
  public readonly spaces = new Map<string, Space>();
  public readonly sessionRoutes = new Map<string, SessionRoute>();
  public readonly messages = new Map<string, PublicMessage[]>();
  public readonly events = new Map<string, PublicWebChannelEvent[]>();
  public readonly sessionGenerations = new Map<string, PublicGeneration[]>();
  public readonly operationIdempotency = new Map<string, { requestHash: string; targetId: string; responsePayload: { session: PublicSession; generation: PublicGeneration } }>();
  public readonly activeTurns = new Set<string>();

  constructor(options: InMemoryPlatformWebApiOptions = {}) {
    this.cookieName = options.cookieName ?? 'enkeep_session';
    this.cookieSecret = options.cookieSecret ?? generateCryptoSecret(32);
    this.cookieSameSite = options.cookieSameSite ?? 'Strict'; // Enforces Strict SameSite
    this.sessionTtlSeconds = options.sessionTtlSeconds ?? 86400; // 24 hours
    this.seedDefaultUsers();
  }

  private seedDefaultUsers() {
    const now = new Date().toISOString();

    // Seed Alice (standard user)
    const aliceId = 'usr_alice123';
    this.users.set(aliceId, {
      id: aliceId,
      username: 'alice',
      passwordHash: this.hashPassword('password123'),
      role: 'user',
      status: 'active',
      displayName: 'Alice Walker',
      createdAt: now,
      updatedAt: now,
    });

    // Seed Alice default space
    const aliceSpaceId = 'spc_alice_default';
    this.spaces.set(aliceSpaceId, {
      id: aliceSpaceId,
      userId: aliceId,
      name: "Alice's Main Space",
      folder: 'spaces/alice-main',
      executionMode: 'container',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    // Seed Alice default session
    const aliceSessionId = 'ses_alice_001';
    this.sessionRoutes.set(aliceSessionId, {
      id: aliceSessionId,
      spaceId: aliceSpaceId,
      userId: aliceId,
      channel: 'web',
      accountId: 'web-demo',
      nativeContextId: aliceSessionId,
      peerId: `web:${aliceSessionId}`,
      dshSessionId: `ses_${aliceSessionId}`,
      executionMode: 'container',
      status: 'active',
      resetCount: 0,
      currentGeneration: 1,
      createdAt: now,
      updatedAt: now,
    });
    this.messages.set(aliceSessionId, []);
    this.events.set(aliceSessionId, []);
    this.sessionGenerations.set(aliceSessionId, [
      {
        generation: 1,
        resetReason: 'initial',
        createdAt: now,
        isCurrent: true,
      },
    ]);

    // Seed Bob (another user, for tenant isolation tests)
    const bobId = 'usr_bob456';
    this.users.set(bobId, {
      id: bobId,
      username: 'bob',
      passwordHash: this.hashPassword('password123'),
      role: 'user',
      status: 'active',
      displayName: 'Bob Martinez',
      createdAt: now,
      updatedAt: now,
    });

    // Seed Bob default space
    const bobSpaceId = 'spc_bob_default';
    this.spaces.set(bobSpaceId, {
      id: bobSpaceId,
      userId: bobId,
      name: "Bob's Project Space",
      folder: 'spaces/bob-proj',
      executionMode: 'container',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    // Seed Bob default session
    const bobSessionId = 'ses_bob_001';
    this.sessionRoutes.set(bobSessionId, {
      id: bobSessionId,
      spaceId: bobSpaceId,
      userId: bobId,
      channel: 'web',
      accountId: 'web-demo',
      nativeContextId: bobSessionId,
      peerId: `web:${bobSessionId}`,
      dshSessionId: `ses_${bobSessionId}`,
      executionMode: 'container',
      status: 'active',
      resetCount: 0,
      currentGeneration: 1,
      createdAt: now,
      updatedAt: now,
    });
    this.messages.set(bobSessionId, []);
    this.events.set(bobSessionId, []);
    this.sessionGenerations.set(bobSessionId, [
      {
        generation: 1,
        resetReason: 'initial',
        createdAt: now,
        isCurrent: true,
      },
    ]);
  }

  private hashPassword(password: string): string {
    return createHash('sha256').update(password).digest('hex');
  }

  private toPublicSpace(space: Space): PublicSpace {
    return {
      id: space.id,
      name: space.name,
      status: space.status as PublicSpace['status'],
      createdAt: space.createdAt,
      updatedAt: space.updatedAt,
      profileBinding: space.agentProfileId
        ? { profile: { id: space.agentProfileId, name: 'Default Profile', version: 1 } }
        : null,
    };
  }

  private toPublicSession(route: SessionRoute): PublicSession {
    return {
      id: route.id,
      spaceId: route.spaceId,
      title: route.title ?? null,
      status: route.status as PublicSession['status'],
      currentGeneration: route.currentGeneration ?? 1,
      createdAt: route.createdAt,
      updatedAt: route.updatedAt,
    };
  }

  // --- Auth APIs ---

  async authenticateCookie(cookieHeader?: string): Promise<{ user: PublicUser; session: { id: string } } | null> {
    if (!cookieHeader) return null;

    const token = parseSignedSessionCookie(cookieHeader, this.cookieName, this.cookieSecret);
    if (!token) return null;

    const tokenHash = createHash('sha256').update(token).digest('hex');
    let matchedSession: UserSession | null = null;

    for (const s of this.sessions.values()) {
      if (s.tokenHash === tokenHash) {
        matchedSession = s;
        break;
      }
    }

    if (!matchedSession) return null;
    if (matchedSession.revokedAt) return null;
    if (new Date(matchedSession.expiresAt).getTime() < Date.now()) return null;

    const user = this.users.get(matchedSession.userId);
    if (!user || user.status === 'disabled') return null;

    matchedSession.lastSeenAt = new Date().toISOString();

    return {
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        locale: user.locale ?? 'en',
        theme: user.theme ?? 'dark',
        mustChangePassword: Boolean(user.mustChangePassword),
      },
      session: { id: matchedSession.id },
    };
  }

  async login(
    username: string,
    password: string,
    context?: { ipAddress?: string; userAgent?: string }
  ): Promise<LoginResult> {
    let matchedUser: User | null = null;
    for (const u of this.users.values()) {
      if (u.username.toLowerCase() === username.toLowerCase()) {
        matchedUser = u;
        break;
      }
    }

    if (!matchedUser || matchedUser.passwordHash !== this.hashPassword(password)) {
      throw new UnauthorizedError('Invalid username or password');
    }

    if (matchedUser.status === 'disabled') {
      throw new AccountDisabledError('Your account has been disabled');
    }

    const sessionId = `sess_${randomUUID()}`;
    const token = randomUUID();
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.sessionTtlSeconds * 1000).toISOString();

    const session: UserSession = {
      id: sessionId,
      userId: matchedUser.id,
      tokenHash,
      expiresAt,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    };

    this.sessions.set(sessionId, session);

    const cookieHeader = createSignedSessionCookie(token, this.cookieSecret, {
      cookieName: this.cookieName,
      cookiePath: '/',
      cookieSameSite: this.cookieSameSite,
      maxAgeSeconds: this.sessionTtlSeconds,
    });

    return {
      user: {
        id: matchedUser.id,
        username: matchedUser.username,
        role: matchedUser.role,
        locale: matchedUser.locale ?? 'en',
        theme: matchedUser.theme ?? 'dark',
        mustChangePassword: Boolean(matchedUser.mustChangePassword),
      },
      cookieHeader,
    };
  }

  async logout(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.revokedAt = new Date().toISOString();
    }
  }

  // --- Spaces APIs ---

  async listSpaces(userId: string, options?: { includeArchived?: boolean; status?: LifecycleStatus }): Promise<PublicSpace[]> {
    const result: PublicSpace[] = [];
    for (const space of this.spaces.values()) {
      if (space.userId === userId) {
        if (options?.status) {
          if (space.status === options.status) {
            result.push(this.toPublicSpace(space));
          }
        } else if (options?.includeArchived || space.status !== 'archived') {
          result.push(this.toPublicSpace(space));
        }
      }
    }
    return result;
  }

  async getSpace(userId: string, spaceId: string): Promise<PublicSpace | null> {
    const space = this.spaces.get(spaceId);
    if (!space) return null;
    if (space.userId !== userId) {
      return null;
    }
    return this.toPublicSpace(space);
  }

  async createSpace(userId: string, input: CreateSpaceInput): Promise<PublicSpace> {
    if (!input.name || !input.name.trim()) {
      throw new ValidationError('Space name must not be empty');
    }

    const id = `spc_${randomUUID().replace(/-/g, '')}`;
    const now = new Date().toISOString();
    const folder = `space-${randomUUID().replace(/-/g, '')}`;

    const space: Space = {
      id,
      userId,
      name: input.name.trim(),
      folder,
      executionMode: 'container',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    this.spaces.set(id, space);
    return this.toPublicSpace(space);
  }

  async updateSpace(userId: string, spaceId: string, input: UpdateSpaceInput): Promise<PublicSpace> {
    const space = this.spaces.get(spaceId);
    if (!space || space.userId !== userId) {
      throw new NotFoundError(`Space "${spaceId}" not found`);
    }

    if (!input.name || !input.name.trim()) {
      throw new ValidationError('Space name must not be empty');
    }

    const updated: Space = {
      ...space,
      name: input.name.trim(),
      updatedAt: new Date().toISOString(),
    };
    this.spaces.set(spaceId, updated);
    return this.toPublicSpace(updated);
  }

  async archiveSpace(userId: string, spaceId: string): Promise<PublicSpace> {
    const space = this.spaces.get(spaceId);
    if (!space || space.userId !== userId) {
      throw new NotFoundError(`Space "${spaceId}" not found`);
    }
    if (this.activeTurns.has(spaceId)) {
      throw new PlatformError('Cannot archive space with active (running/queued) turns', 'CONFLICT', 409);
    }

    const now = new Date().toISOString();
    const updated: Space = {
      ...space,
      status: 'archived',
      updatedAt: now,
    };
    this.spaces.set(spaceId, updated);

    for (const route of this.sessionRoutes.values()) {
      if (route.spaceId === spaceId && route.userId === userId) {
        this.sessionRoutes.set(route.id, {
          ...route,
          status: 'archived',
          updatedAt: now,
        });
      }
    }

    return this.toPublicSpace(updated);
  }

  async restoreSpace(userId: string, spaceId: string): Promise<PublicSpace> {
    const space = this.spaces.get(spaceId);
    if (!space || space.userId !== userId) {
      throw new NotFoundError(`Space "${spaceId}" not found`);
    }
    const now = new Date().toISOString();
    const updated: Space = {
      ...space,
      status: 'active',
      updatedAt: now,
    };
    this.spaces.set(spaceId, updated);
    return this.toPublicSpace(updated);
  }

  async deleteSpace(userId: string, spaceId: string): Promise<boolean> {
    await this.archiveSpace(userId, spaceId);
    return true;
  }

  // --- Sessions & Routes APIs ---

  async listSessions(
    userId: string,
    options?: { spaceId?: string; includeArchived?: boolean; status?: LifecycleStatus }
  ): Promise<PublicSession[]> {
    const spaceId = options?.spaceId;
    const includeArchived = Boolean(options?.includeArchived);
    const statusFilter = options?.status;

    const result: PublicSession[] = [];
    for (const route of this.sessionRoutes.values()) {
      if (route.userId === userId) {
        if (!spaceId || route.spaceId === spaceId) {
          if (statusFilter) {
            if (route.status === statusFilter) {
              result.push(this.toPublicSession(route));
            }
          } else if (includeArchived || route.status !== 'archived') {
            result.push(this.toPublicSession(route));
          }
        }
      }
    }
    return result;
  }

  async getSession(userId: string, sessionId: string): Promise<PublicSession | null> {
    const route = this.sessionRoutes.get(sessionId);
    if (!route || route.userId !== userId) return null;
    return this.toPublicSession(route);
  }

  async createSession(userId: string, input: CreateSessionInput): Promise<PublicSession> {
    const space = this.spaces.get(input.spaceId);
    if (!space || space.userId !== userId) {
      throw new TenantAccessDeniedError(`Space ${input.spaceId} not found or access denied`);
    }
    if (space.status === 'archived') {
      throw new ValidationError(`Cannot create session in archived space "${input.spaceId}"`);
    }

    const sessionId = `ses_${randomUUID().replace(/-/g, '')}`;
    const now = new Date().toISOString();
    const route: SessionRoute = {
      id: sessionId,
      spaceId: input.spaceId,
      userId,
      channel: 'web',
      accountId: 'web-demo',
      nativeContextId: sessionId,
      peerId: `web:${sessionId}`,
      dshSessionId: sessionId,
      executionMode: 'container',
      status: 'active',
      title: input.title,
      resetCount: 0,
      currentGeneration: 1,
      createdAt: now,
      updatedAt: now,
    };

    this.sessionRoutes.set(sessionId, route);
    this.messages.set(sessionId, []);
    this.events.set(sessionId, []);
    this.sessionGenerations.set(sessionId, [
      {
        generation: 1,
        resetReason: 'initial',
        createdAt: now,
        isCurrent: true,
      },
    ]);
    return this.toPublicSession(route);
  }

  async updateSession(userId: string, sessionId: string, input: UpdateSessionInput): Promise<PublicSession> {
    const route = this.sessionRoutes.get(sessionId);
    if (!route || route.userId !== userId) {
      throw new NotFoundError(`Session "${sessionId}" not found`);
    }
    if (route.status === 'archived') {
      throw new ValidationError(`Cannot update archived session "${sessionId}"`);
    }

    const updated: SessionRoute = {
      ...route,
      title: input.title !== undefined ? input.title.trim() : route.title,
      updatedAt: new Date().toISOString(),
    };
    this.sessionRoutes.set(sessionId, updated);
    return this.toPublicSession(updated);
  }

  async archiveSession(userId: string, sessionId: string): Promise<PublicSession> {
    const route = this.sessionRoutes.get(sessionId);
    if (!route || route.userId !== userId) {
      throw new NotFoundError(`Session "${sessionId}" not found`);
    }
    if (this.activeTurns.has(sessionId)) {
      throw new PlatformError('Cannot archive session with active (running/queued) turns', 'CONFLICT', 409);
    }

    const now = new Date().toISOString();
    const updated: SessionRoute = {
      ...route,
      status: 'archived',
      updatedAt: now,
    };
    this.sessionRoutes.set(sessionId, updated);
    return this.toPublicSession(updated);
  }

  async restoreSession(userId: string, sessionId: string): Promise<PublicSession> {
    const route = this.sessionRoutes.get(sessionId);
    if (!route || route.userId !== userId) {
      throw new NotFoundError(`Session "${sessionId}" not found`);
    }
    const parentSpace = this.spaces.get(route.spaceId);
    if (!parentSpace || parentSpace.status !== 'active') {
      throw new PlatformError('Cannot restore session in archived space', 'SPACE_ARCHIVED', 400);
    }

    const now = new Date().toISOString();
    const updated: SessionRoute = {
      ...route,
      status: 'active',
      updatedAt: now,
    };
    this.sessionRoutes.set(sessionId, updated);
    return this.toPublicSession(updated);
  }

  async forkSession(
    userId: string,
    sessionId: string,
    options?: ForkSessionOptions
  ): Promise<PublicSession> {
    const sourceRoute = this.sessionRoutes.get(sessionId);
    if (!sourceRoute || sourceRoute.userId !== userId) {
      throw new NotFoundError(`Session "${sessionId}" not found`);
    }
    if (this.activeTurns.has(sessionId)) {
      throw new PlatformError('Cannot fork session while a turn is active', 'TURN_ACTIVE', 409);
    }

    const targetSpaceId = options?.targetSpaceId || sourceRoute.spaceId;
    const targetSpace = this.spaces.get(targetSpaceId);
    if (!targetSpace || targetSpace.userId !== userId) {
      throw new NotFoundError(`Space "${targetSpaceId}" not found`);
    }
    if (targetSpace.status !== 'active') {
      throw new ValidationError('Target space is not active');
    }

    const newId = `ses_${randomUUID().replace(/-/g, '')}`;
    const newDshSessionId = `ses_${randomUUID().replace(/-/g, '')}`;
    const now = new Date().toISOString();

    let forkedTitle = options?.title?.trim() || `${sourceRoute.title || 'Session'} (Fork)`;

    const forkedRoute: SessionRoute = {
      id: newId,
      spaceId: targetSpaceId,
      userId,
      channel: 'web',
      accountId: 'default',
      nativeContextId: newId,
      peerId: newId,
      dshSessionId: newDshSessionId,
      executionMode: 'container',
      status: 'active',
      title: forkedTitle,
      currentGeneration: 1,
      resetCount: 0,
      lastResetAt: null,
      agentProfileId: sourceRoute.agentProfileId,
      agentProfileSnapshotId: sourceRoute.agentProfileSnapshotId,
      createdAt: now,
      updatedAt: now,
    };

    this.sessionRoutes.set(newId, forkedRoute);
    this.sessionGenerations.set(newId, [
      {
        id: `gen_${randomUUID().replace(/-/g, '')}`,
        userId,
        routeId: newId,
        generationNumber: 1,
        dshSessionId: newDshSessionId,
        agentProfileSnapshotId: sourceRoute.agentProfileSnapshotId || null,
        resetReason: 'fork',
        createdAt: now,
      },
    ]);

    // Copy messages up to fork point
    const srcMessages = this.messages.get(sessionId) || [];
    let cutIndex = srcMessages.length;
    if (options?.fromMessageId) {
      const idx = srcMessages.findIndex((m) => m.id === options.fromMessageId);
      if (idx === -1) {
        throw new ValidationError(`Message "${options.fromMessageId}" not found in source session`);
      }
      cutIndex = idx + 1;
    } else if (options?.fromTurnId) {
      let lastIdx = -1;
      for (let i = 0; i < srcMessages.length; i++) {
        if (srcMessages[i]?.turnId === options.fromTurnId) {
          lastIdx = i;
        }
      }
      if (lastIdx === -1) {
        throw new ValidationError(`Turn "${options.fromTurnId}" not found in source session`);
      }
      cutIndex = lastIdx + 1;
    }

    const copiedMessages: PublicMessage[] = [];
    for (let i = 0; i < cutIndex; i++) {
      const orig = srcMessages[i]!;
      const newMsgId = `msg_${randomUUID().replace(/-/g, '')}`;
      copiedMessages.push({
        ...orig,
        id: newMsgId,
        createdAt: orig.createdAt,
      });
    }
    this.messages.set(newId, copiedMessages);

    return this.toPublicSession(forkedRoute);
  }

  async deleteSession(userId: string, sessionId: string): Promise<boolean> {
    await this.archiveSession(userId, sessionId);
    return true;
  }

  async resetSession(
    userId: string,
    sessionId: string,
    options: ResetSessionOptions
  ): Promise<ResetSessionResult> {
    const route = this.sessionRoutes.get(sessionId);
    if (!route || route.userId !== userId) {
      throw new NotFoundError(`Session "${sessionId}" not found`);
    }
    if (route.status === 'archived') {
      throw new ValidationError(`Cannot reset archived session "${sessionId}"`);
    }
    if (this.activeTurns.has(sessionId)) {
      throw new PlatformError('Cannot reset session with active (running/queued) turns', 'CONFLICT', 409);
    }

    const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    if (!options.idempotencyKey || typeof options.idempotencyKey !== 'string' || !UUID_V4_REGEX.test(options.idempotencyKey)) {
      throw new ValidationError('Invalid or missing idempotencyKey: must be a valid lowercase UUIDv4');
    }

    let validReason = 'manual_reset';
    if (options.reason !== undefined && options.reason !== null) {
      if (
        typeof options.reason !== 'string' ||
        options.reason !== options.reason.trim() ||
        options.reason.normalize('NFC') !== options.reason ||
        options.reason.length === 0 ||
        options.reason.length > 128
      ) {
        throw new ValidationError('Reset reason must be a non-empty NFC-normalized string with maximum 128 characters');
      }
      validReason = options.reason;
    }

    const canonicalRequest = JSON.stringify({
      action: 'reset_session',
      userId,
      sessionId,
      reason: validReason,
    });
    const requestHash = createHash('sha256').update(canonicalRequest).digest('hex');
    const idempRecordKey = `${userId}:reset_session:${options.idempotencyKey}`;
    const existing = this.operationIdempotency.get(idempRecordKey);
    if (existing) {
      if (existing.requestHash !== requestHash || existing.targetId !== sessionId) {
        throw new PlatformError(
          `Idempotency key "${options.idempotencyKey}" already used for different request or target session`,
          'CONFLICT',
          409
        );
      }
      return {
        session: existing.responsePayload.session,
        generation: existing.responsePayload.generation,
        isIdempotentHit: true,
      };
    }

    const list = this.sessionGenerations.get(sessionId) || [];
    const nextGen = (route.currentGeneration ?? list.length) + 1;
    const newDshSessionId = `ses_${randomUUID().replace(/-/g, '')}`;
    const now = new Date().toISOString();

    const genRecord: PublicGeneration = {
      generation: nextGen,
      resetReason: validReason,
      createdAt: now,
      isCurrent: true,
    };
    // Update prior gens isCurrent to false
    for (const g of list) {
      (g as { isCurrent: boolean }).isCurrent = false;
    }
    list.push(genRecord);
    this.sessionGenerations.set(sessionId, list);

    const updatedRoute: SessionRoute = {
      ...route,
      dshSessionId: newDshSessionId,
      lastResetAt: now,
      resetCount: (route.resetCount ?? 0) + 1,
      currentGeneration: nextGen,
      updatedAt: now,
    };
    this.sessionRoutes.set(sessionId, updatedRoute);

    const publicSession = this.toPublicSession(updatedRoute);
    const receipt = {
      session: publicSession,
      generation: genRecord,
    };

    this.operationIdempotency.set(idempRecordKey, {
      requestHash,
      targetId: sessionId,
      responsePayload: receipt,
    });

    return {
      session: publicSession,
      generation: genRecord,
      isIdempotentHit: false,
    };
  }

  async listSessionGenerations(userId: string, sessionId: string): Promise<PublicGeneration[]> {
    const route = this.sessionRoutes.get(sessionId);
    if (!route || route.userId !== userId) {
      throw new NotFoundError(`Session "${sessionId}" not found`);
    }
    return this.sessionGenerations.get(sessionId) || [];
  }

  // --- Messages & History APIs ---

  private ensureSessionAccess(userId: string, sessionId: string): SessionRoute {
    const route = this.sessionRoutes.get(sessionId);
    if (!route || route.userId !== userId) {
      throw new NotFoundError(`Session "${sessionId}" not found or access denied`);
    }
    return route;
  }

  async listMessages(
    userId: string,
    sessionId: string,
    options?: { limit?: number; before?: string; after?: string; cursor?: string }
  ): Promise<{ messages: PublicMessage[]; hasMore: boolean; olderCursor: string | null; newerCursor: string | null }> {
    this.ensureSessionAccess(userId, sessionId);

    const list = this.messages.get(sessionId) || [];
    const limit = options?.limit ?? 50;

    let slice: PublicMessage[];
    let hasMore = false;

    if (options?.before) {
      const cursorIdx = list.findIndex((m) => m.id === options.before);
      const endIdx = cursorIdx !== -1 ? cursorIdx : list.length;
      const startIdx = Math.max(0, endIdx - limit);
      slice = list.slice(startIdx, endIdx);
      hasMore = startIdx > 0;
    } else if (options?.after) {
      const cursorIdx = list.findIndex((m) => m.id === options.after);
      const startIdx = cursorIdx !== -1 ? cursorIdx + 1 : 0;
      slice = list.slice(startIdx, startIdx + limit);
      hasMore = startIdx + limit < list.length;
    } else {
      // Initial: latest limit messages
      const startIdx = Math.max(0, list.length - limit);
      slice = list.slice(startIdx);
      hasMore = startIdx > 0;
    }

    const olderCursor = slice.length > 0 ? slice[0].id : null;
    const newerCursor = slice.length > 0 ? slice[slice.length - 1].id : null;

    return {
      messages: slice,
      hasMore,
      olderCursor,
      newerCursor,
    };
  }

  async getMessage(userId: string, sessionId: string, messageId: string): Promise<PublicMessage | null> {
    this.ensureSessionAccess(userId, sessionId);
    const list = this.messages.get(sessionId) || [];
    const found = list.find((m) => m.id === messageId);
    if (!found) return null;
    return found;
  }

  seedMessage(userId: string, sessionId: string, content: string): PublicMessage {
    this.ensureSessionAccess(userId, sessionId);

    const list = this.messages.get(sessionId) || [];
    const msg: PublicMessage = {
      id: `msg_${randomUUID()}`,
      role: 'user',
      content,
      status: 'delivered',
      createdAt: new Date().toISOString(),
    };

    list.push(msg);
    this.messages.set(sessionId, list);

    // Record event
    const eventList = this.events.get(sessionId) || [];
    eventList.push({
      id: `ev_${randomUUID()}`,
      type: 'message',
      message: msg,
      timestamp: new Date().toISOString(),
    });
    this.events.set(sessionId, eventList);

    return msg;
  }

  async pollEvents(
    userId: string,
    sessionId: string,
    cursor?: string
  ): Promise<{ events: PublicWebChannelEvent[]; nextCursor: string | null }> {
    this.ensureSessionAccess(userId, sessionId);

    const eventList = this.events.get(sessionId) || [];
    let startIndex = 0;
    if (cursor) {
      const idx = eventList.findIndex((e) => e.id === cursor);
      if (idx !== -1) {
        startIndex = idx + 1;
      }
    }

    const slice = eventList.slice(startIndex);
    const nextCursor = slice.length > 0 ? slice[slice.length - 1].id : (cursor ?? null);

    return {
      events: slice,
      nextCursor,
    };
  }
}
