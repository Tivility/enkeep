import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  PlatformStorage,
  AuthService,
  AuthContext,
  LifecycleStatus,
  Space,
  SessionRoute,
  ExecutionMode,
} from '@enkeep/platform-core';
import {
  NotFoundError,
  ValidationError,
  ForbiddenError,
  ConflictError,
  PlatformError,
} from '@enkeep/platform-core';
import { canManageHostRuntime } from '@enkeep/platform-auth';
import type { RuntimeProviderRegistry } from '../runtime/provider-registry.js';
import type {
  PlatformWebApi,
  PublicUser,
  PublicSpace,
  PublicProfileBinding,
  PublicSession,
  PublicGeneration,
  PublicMessage,
  PublicWebChannelEvent,
  PublicEventCode,
  TurnExecutionStatus,
  CreateSpaceInput,
  UpdateSpaceInput,
  CreateSessionInput,
  UpdateSessionInput,
  ForkSessionOptions,
  ResetSessionOptions,
  ResetSessionResult,
  LoginResult,
} from '@enkeep/web-channel';
import { WEB_CHANNEL_NAME, DEFAULT_WEB_ACCOUNT_ID } from '@enkeep/web-channel';
import { SqliteWebMessageStore, generate32HexId } from './web-messages.js';
import { computeAgentProfilePromptHash, canonicalJsonStringify } from '../profiles/profile-service.js';
import type { ForkService } from '../sessions/fork-service.js';
import type { SessionLifecycleService } from '../sessions/session-lifecycle-service.js';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROMPT_HASH_REGEX = /^[0-9a-f]{64}$/;

const ALLOWED_PUBLIC_EVENT_CODES: ReadonlySet<string> = new Set([
  'TURN_FAILED',
  'TURN_TIMEOUT',
  'TURN_CANCELLED',
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'INTERRUPTED',
  'EXECUTION_FAILED',
  'INTERNAL_ERROR',
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function secureHashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return timingSafeEqual(bufA, bufB);
}

export interface SqlitePlatformWebApiOptions {
  storage: PlatformStorage;
  messageStore: SqliteWebMessageStore;
  authService?: AuthService;
  db: DatabaseSync;
  forkService?: ForkService;
  sessionLifecycleService?: SessionLifecycleService;
  runtimeProviderRegistry?: RuntimeProviderRegistry;
}

/**
 * SQLite-backed PlatformWebApi implementation ensuring strict multi-tenant isolation,
 * real persistent storage across restarts, and full integration with PlatformCore & Auth.
 */
export class SqlitePlatformWebApiAdapter implements PlatformWebApi {
  private readonly storage: PlatformStorage;
  private readonly messageStore: SqliteWebMessageStore;
  private readonly authService?: AuthService;
  private readonly db: DatabaseSync;
  private readonly forkService?: ForkService;
  private readonly sessionLifecycleService?: SessionLifecycleService;
  private readonly runtimeProviderRegistry?: RuntimeProviderRegistry;

  constructor(options: SqlitePlatformWebApiOptions) {
    if (!options || typeof options !== 'object') {
      throw new ValidationError('SqlitePlatformWebApiAdapter requires options object');
    }
    if (!options.storage) {
      throw new ValidationError('SqlitePlatformWebApiAdapter requires storage instance');
    }
    if (!options.messageStore) {
      throw new ValidationError('SqlitePlatformWebApiAdapter requires messageStore instance');
    }
    if (!options.db) {
      throw new ValidationError('SqlitePlatformWebApiAdapter requires db instance');
    }
    this.storage = options.storage;
    this.messageStore = options.messageStore;
    this.authService = options.authService;
    this.db = options.db;
    this.forkService = options.forkService;
    this.sessionLifecycleService = options.sessionLifecycleService;
    this.runtimeProviderRegistry = options.runtimeProviderRegistry;
  }

  // --- Auth APIs ---

  async authenticateCookie(
    cookieHeader?: string
  ): Promise<{ user: PublicUser; session: { id: string } } | null> {
    if (!cookieHeader || !this.authService) return null;
    const result = await this.authService.authenticateCookie(cookieHeader);
    if (!result.authenticated || !result.user || !result.session) {
      return null;
    }
    return {
      user: {
        id: result.user.id,
        username: result.user.username,
        role: result.user.role === 'admin' ? 'admin' : 'user',
        status: result.user.status,
        displayName: result.user.displayName ?? null,
        locale: result.user.locale ?? 'en',
        theme: result.user.theme ?? 'dark',
        mustChangePassword: Boolean(result.user.mustChangePassword),
      },
      session: {
        id: result.session.id,
      },
    };
  }

  async login(username: string, password: string, context?: AuthContext): Promise<LoginResult> {
    if (!this.authService) {
      throw new PlatformError('Auth service is not configured on SqlitePlatformWebApiAdapter', 'INTERNAL_ERROR', 500);
    }
    const loginResult = await this.authService.login(username, password, context);
    return {
      user: {
        id: loginResult.user.id,
        username: loginResult.user.username,
        role: loginResult.user.role === 'admin' ? 'admin' : 'user',
        status: loginResult.user.status,
        displayName: loginResult.user.displayName ?? null,
        locale: loginResult.user.locale ?? 'en',
        theme: loginResult.user.theme ?? 'dark',
        mustChangePassword: Boolean(loginResult.user.mustChangePassword),
      },
      cookieHeader: loginResult.cookieHeader,
    };
  }

  async logout(sessionIdOrCookie: string): Promise<void> {
    if (this.authService) {
      let actualSessionId = sessionIdOrCookie;
      const auth = await this.authService.authenticateCookie(sessionIdOrCookie);
      if (auth.authenticated && auth.session) {
        actualSessionId = auth.session.id;
      }
      await this.authService.logout(actualSessionId);
    }
  }

  // --- Spaces APIs ---

  private resolveProfileBinding(userId: string, profileId?: string | null): PublicProfileBinding | undefined {
    if (!profileId) return undefined;
    const profileRow = this.db
      .prepare('SELECT id, name, active_version FROM agent_profiles WHERE id = ? AND user_id = ?')
      .get(profileId, userId) as { id: string; name: string; active_version: number } | undefined;
    if (!profileRow) {
      return { profile: null };
    }
    return {
      profile: {
        id: profileRow.id,
        name: profileRow.name,
        version: Number(profileRow.active_version),
      },
    };
  }

  private toPublicSpace(userId: string, space: Space): PublicSpace {
    if (!space || typeof space !== 'object') {
      throw new PlatformError('Invalid space record', 'DATABASE_CORRUPTED', 500);
    }
    if (!space.id || typeof space.id !== 'string') {
      throw new PlatformError('Invalid space record: missing id', 'DATABASE_CORRUPTED', 500);
    }
    if (!space.name || typeof space.name !== 'string') {
      throw new PlatformError('Invalid space record: missing name', 'DATABASE_CORRUPTED', 500);
    }
    if (space.status !== 'active' && space.status !== 'archived' && space.status !== 'deleted') {
      throw new PlatformError('Invalid space record: invalid status', 'DATABASE_CORRUPTED', 500);
    }
    if (!space.createdAt || typeof space.createdAt !== 'string') {
      throw new PlatformError('Invalid space record: missing createdAt', 'DATABASE_CORRUPTED', 500);
    }
    if (!space.updatedAt || typeof space.updatedAt !== 'string') {
      throw new PlatformError('Invalid space record: missing updatedAt', 'DATABASE_CORRUPTED', 500);
    }

    const profileBinding = this.resolveProfileBinding(userId, space.agentProfileId);

    return {
      id: space.id,
      name: space.name,
      executionMode: space.executionMode,
      status: space.status,
      createdAt: space.createdAt,
      updatedAt: space.updatedAt,
      ...(profileBinding !== undefined ? { profileBinding } : {}),
    };
  }

  async listSpaces(
    userId: string,
    options?: { includeArchived?: boolean; status?: LifecycleStatus }
  ): Promise<PublicSpace[]> {
    const tenant = this.storage.forTenant(userId);
    let spaces: Space[];

    if (options?.status) {
      spaces = await tenant.spaces.list({ status: options.status });
    } else if (options?.includeArchived) {
      spaces = await tenant.spaces.list();
    } else {
      spaces = await tenant.spaces.list({ status: 'active' });
    }

    return spaces.map((s) => this.toPublicSpace(userId, s));
  }

  async getSpace(userId: string, spaceId: string): Promise<PublicSpace | null> {
    const tenant = this.storage.forTenant(userId);
    const space = await tenant.spaces.findById(spaceId);
    if (!space) return null;
    return this.toPublicSpace(userId, space);
  }

  async createSpace(userId: string, input: CreateSpaceInput): Promise<PublicSpace> {
    if (!input || typeof input !== 'object') {
      throw new ValidationError('Create space input must be an object');
    }
    if (
      typeof input.name !== 'string' ||
      input.name !== input.name.trim() ||
      input.name.normalize('NFC') !== input.name ||
      input.name.length === 0 ||
      input.name.length > 256
    ) {
      throw new ValidationError('Space name must be a non-empty NFC-normalized string with maximum 256 characters');
    }

    const name = input.name;
    const executionMode: ExecutionMode = (input as any).executionMode ?? 'container';
    if (executionMode !== 'container' && executionMode !== 'host') {
      throw new ValidationError('Invalid executionMode: Expected container or host');
    }

    if (executionMode === 'host') {
      const user = await this.storage.users.findById(userId);
      if (!user || !canManageHostRuntime(user)) {
        throw new ForbiddenError('Only administrators can create spaces in host execution mode');
      }
    }

    // Generate internal folder: space-<32hex>
    const folderHex = randomUUID().replace(/-/g, '');
    const internalFolder = (input as any).folder || `space-${folderHex}`;

    const tenant = this.storage.forTenant(userId);
    const created = await tenant.spaces.create({
      name,
      folder: internalFolder,
      executionMode,
      status: 'active',
    });

    // Space Provisioning Saga: ensure workspace root on provider
    if (this.runtimeProviderRegistry?.hasProvider(executionMode)) {
      const provider = this.runtimeProviderRegistry.getProvider(executionMode);
      if (provider && typeof provider.ensureSpaceWorkspace === 'function') {
        try {
          await provider.ensureSpaceWorkspace(userId, { id: created.id, folder: created.folder });
        } catch (sagaErr) {
          // Failure rollback: delete newly created DB record
          this.db.prepare('DELETE FROM spaces WHERE id = ? AND user_id = ?').run(created.id, userId);
          throw sagaErr;
        }
      }
    }

    // Fixed audit record with no host path or PID
    if (executionMode === 'host') {
      try {
        await this.storage.auditLogs.create({
          userId,
          action: 'host_runtime_space_created',
          details: { spaceId: created.id, executionMode: 'host' },
        });
      } catch {
        // audit failure must not block space return
      }
    }

    return this.toPublicSpace(userId, created);
  }

  async updateSpace(userId: string, spaceId: string, input: UpdateSpaceInput): Promise<PublicSpace> {
    if (!input || typeof input !== 'object') {
      throw new ValidationError('Update space input must be an object');
    }

    const tenant = this.storage.forTenant(userId);
    const existing = await tenant.spaces.findById(spaceId);
    if (!existing) {
      throw new NotFoundError('Space not found');
    }

    if (input.executionMode !== undefined && input.executionMode !== existing.executionMode) {
      throw new ConflictError('Switching space execution mode requires migration', 'MIGRATION_REQUIRED');
    }

    if (input.executionMode === 'host' || existing.executionMode === 'host') {
      const user = await this.storage.users.findById(userId);
      if (!user || !canManageHostRuntime(user)) {
        throw new ForbiddenError('Only administrators can manage host execution mode');
      }
    }

    if (input.name !== undefined) {
      if (
        typeof input.name !== 'string' ||
        input.name !== input.name.trim() ||
        input.name.normalize('NFC') !== input.name ||
        input.name.length === 0 ||
        input.name.length > 256
      ) {
        throw new ValidationError('Space name must be a non-empty NFC-normalized string with maximum 256 characters');
      }
    }

    const updated = await tenant.spaces.update(spaceId, {
      name: input.name,
    });

    return this.toPublicSpace(userId, updated);
  }

  async archiveSpace(userId: string, spaceId: string): Promise<PublicSpace> {
    const tenant = this.storage.forTenant(userId);
    const existing = await tenant.spaces.findById(spaceId);
    if (!existing) {
      throw new NotFoundError('Space not found');
    }

    let inTx = false;
    this.db.exec('BEGIN IMMEDIATE');
    inTx = true;
    try {
      const spaceRow = this.db
        .prepare('SELECT id FROM spaces WHERE id = ? AND user_id = ? LIMIT 1')
        .get(spaceId, userId);

      if (!spaceRow) {
        throw new NotFoundError('Space not found');
      }

      // Check for active (running/queued) turns in the space
      const activeTurns = this.db
        .prepare(
          `SELECT id FROM turn_runs
           WHERE space_id = ? AND user_id = ? AND status IN ('running', 'queued')
           LIMIT 1`
        )
        .get(spaceId, userId);

      if (activeTurns) {
        throw new PlatformError('Cannot archive space with active (running/queued) turns', 'CONFLICT', 409);
      }

      // Soft-delete / archive space
      this.db
        .prepare('UPDATE spaces SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
        .run('archived', spaceId, userId);

      // Cascade archive child sessions
      this.db
        .prepare(
          `UPDATE session_routes
           SET status = 'archived', updated_at = CURRENT_TIMESTAMP
           WHERE space_id = ? AND user_id = ? AND status != 'archived'`
        )
        .run(spaceId, userId);

      this.db.exec('COMMIT');
      inTx = false;

      const updated = await tenant.spaces.findById(spaceId);
      if (!updated) {
        throw new PlatformError('Failed to retrieve space after archive', 'INTERNAL_ERROR', 500);
      }
      return this.toPublicSpace(userId, updated);
    } catch (err) {
      if (inTx) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rbErr) {
          const primary = err instanceof Error ? err : new Error('Database transaction failed');
          const rollback = rbErr instanceof Error ? rbErr : new Error('Database rollback failed');
          throw new AggregateError([primary, rollback], 'Database transaction and rollback failed');
        }
      }
      throw err;
    }
  }

  async restoreSpace(userId: string, spaceId: string): Promise<PublicSpace> {
    const tenant = this.storage.forTenant(userId);
    const existing = await tenant.spaces.findById(spaceId);
    if (!existing) {
      throw new NotFoundError('Space not found');
    }
    if (existing.status === 'deleted') {
      throw new ValidationError('Cannot restore deleted space');
    }
    if (existing.status === 'active') {
      return this.toPublicSpace(userId, existing);
    }

    let inTx = false;
    this.db.exec('BEGIN IMMEDIATE');
    inTx = true;
    try {
      const spaceRow = this.db
        .prepare('SELECT id, status FROM spaces WHERE id = ? AND user_id = ? LIMIT 1')
        .get(spaceId, userId) as { id: string; status: string } | undefined;

      if (!spaceRow) {
        throw new NotFoundError('Space not found');
      }

      this.db
        .prepare('UPDATE spaces SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
        .run('active', spaceId, userId);

      this.db.exec('COMMIT');
      inTx = false;

      const updated = await tenant.spaces.findById(spaceId);
      if (!updated) {
        throw new PlatformError('Failed to retrieve space after restore', 'INTERNAL_ERROR', 500);
      }
      return this.toPublicSpace(userId, updated);
    } catch (err) {
      if (inTx) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rbErr) {
          const primary = err instanceof Error ? err : new Error('Database transaction failed');
          const rollback = rbErr instanceof Error ? rbErr : new Error('Database rollback failed');
          throw new AggregateError([primary, rollback], 'Database transaction and rollback failed');
        }
      }
      throw err;
    }
  }

  async deleteSpace(userId: string, spaceId: string): Promise<boolean> {
    await this.archiveSpace(userId, spaceId);
    return true;
  }

  // --- Sessions & Routes APIs ---

  private toPublicSession(route: SessionRoute): PublicSession {
    if (!route || typeof route !== 'object') {
      throw new PlatformError('Invalid session record', 'DATABASE_CORRUPTED', 500);
    }
    if (!route.id || typeof route.id !== 'string') {
      throw new PlatformError('Invalid session record: missing id', 'DATABASE_CORRUPTED', 500);
    }
    if (!route.spaceId || typeof route.spaceId !== 'string') {
      throw new PlatformError('Invalid session record: missing spaceId', 'DATABASE_CORRUPTED', 500);
    }
    if (route.status !== 'active' && route.status !== 'archived' && route.status !== 'deleted') {
      throw new PlatformError('Invalid session record: invalid status', 'DATABASE_CORRUPTED', 500);
    }
    if (
      typeof route.currentGeneration !== 'number' ||
      !Number.isInteger(route.currentGeneration) ||
      route.currentGeneration < 1
    ) {
      throw new PlatformError('Invalid session record: invalid currentGeneration', 'DATABASE_CORRUPTED', 500);
    }
    if (!route.createdAt || typeof route.createdAt !== 'string') {
      throw new PlatformError('Invalid session record: missing createdAt', 'DATABASE_CORRUPTED', 500);
    }
    if (!route.updatedAt || typeof route.updatedAt !== 'string') {
      throw new PlatformError('Invalid session record: missing updatedAt', 'DATABASE_CORRUPTED', 500);
    }

    return {
      id: route.id,
      spaceId: route.spaceId,
      title: route.title ?? null,
      status: route.status,
      currentGeneration: route.currentGeneration,
      createdAt: route.createdAt,
      updatedAt: route.updatedAt,
    };
  }

  async listSessions(
    userId: string,
    options?: { spaceId?: string; includeArchived?: boolean; status?: LifecycleStatus }
  ): Promise<PublicSession[]> {
    const tenant = this.storage.forTenant(userId);
    const spaceId = options?.spaceId;
    const includeArchived = Boolean(options?.includeArchived);
    const statusFilter = options?.status;

    let routes: SessionRoute[];

    if (statusFilter) {
      if (spaceId) {
        routes = await tenant.sessionRoutes.listBySpaceId(spaceId, { status: statusFilter });
      } else {
        routes = await tenant.sessionRoutes.list({ status: statusFilter });
      }
    } else if (spaceId) {
      const allRoutes = await tenant.sessionRoutes.listBySpaceId(spaceId);
      routes = includeArchived
        ? allRoutes
        : allRoutes.filter((r) => r.status !== 'archived' && r.status !== 'deleted');
    } else {
      const allRoutes = await tenant.sessionRoutes.list();
      routes = includeArchived
        ? allRoutes
        : allRoutes.filter((r) => r.status !== 'archived' && r.status !== 'deleted');
    }

    return routes.map((r) => this.toPublicSession(r));
  }

  async getSession(userId: string, sessionId: string): Promise<PublicSession | null> {
    const tenant = this.storage.forTenant(userId);
    const route = await tenant.sessionRoutes.findById(sessionId);
    if (!route) return null;
    return this.toPublicSession(route);
  }

  async createSession(userId: string, input: CreateSessionInput): Promise<PublicSession> {
    if (!input || typeof input !== 'object') {
      throw new ValidationError('Create session input must be an object');
    }
    if (!input.spaceId || typeof input.spaceId !== 'string' || !input.spaceId.trim()) {
      throw new ValidationError('Missing or invalid spaceId');
    }

    let title: string | null = null;
    if (input.title !== undefined && input.title !== null) {
      if (
        typeof input.title !== 'string' ||
        input.title !== input.title.trim() ||
        input.title.normalize('NFC') !== input.title ||
        input.title.length > 256
      ) {
        throw new ValidationError('Session title must be an NFC-normalized string with maximum 256 characters');
      }
      title = input.title;
    }

    // 128-bit hex UUID (32 hex characters)
    const sessionId = `ses_${randomUUID().replace(/-/g, '')}`;

    let inTx = false;
    this.db.exec('BEGIN IMMEDIATE');
    inTx = true;
    try {
      // Re-read Space inside BEGIN IMMEDIATE write lock to prevent archive/create race
      const spaceRow = this.db
        .prepare(
          `SELECT id, user_id, status, execution_mode, agent_profile_id, agent_profile_snapshot_id
           FROM spaces
           WHERE id = ? AND user_id = ?
           LIMIT 1`
        )
        .get(input.spaceId, userId) as
        | {
            id: string;
            user_id: string;
            status: string;
            execution_mode: string;
            agent_profile_id: string | null;
            agent_profile_snapshot_id: string | null;
          }
        | undefined;

      if (!spaceRow) {
        throw new NotFoundError('Space not found');
      }
      if (spaceRow.status !== 'active') {
        if (spaceRow.status === 'archived' || spaceRow.status === 'deleted') {
          throw new ValidationError('Cannot create session in archived space');
        }
        throw new PlatformError('Invalid space record: invalid status', 'DATABASE_CORRUPTED', 500);
      }

      const spaceExecutionMode = (spaceRow.execution_mode ?? 'container') as ExecutionMode;
      if (input.executionMode !== undefined) {
        if (input.executionMode !== 'container' && input.executionMode !== 'host') {
          throw new ValidationError('Invalid executionMode: Expected container or host');
        }
        if (input.executionMode !== spaceExecutionMode) {
          throw new ValidationError('Session executionMode cannot override or mismatch space executionMode');
        }
      }

      // Authoritative profile resolution & prompt hash validation
      let boundProfileId: string | null = null;
      let boundSnapshotId: string | null = null;

      if (spaceRow.agent_profile_snapshot_id) {
        const snapRow = this.db
          .prepare(
            `SELECT id, profile_id, version, user_id, prompt_hash, identity, soul, agents, tools
             FROM agent_profile_snapshots
             WHERE id = ? AND user_id = ?
             LIMIT 1`
          )
          .get(spaceRow.agent_profile_snapshot_id, userId) as
          | {
              id: string;
              profile_id: string;
              version: number;
              user_id: string;
              prompt_hash: string;
              identity: string;
              soul: string;
              agents: string;
              tools: string;
            }
          | undefined;

        if (!snapRow) {
          throw new PlatformError(
            '[FAIL_CLOSED] Space references corrupt or missing agent profile snapshot',
            'FAIL_CLOSED',
            500
          );
        }

        // Verify that the bound agent profile is not archived or deleted
        const profileRow = this.db
          .prepare(
            `SELECT id, user_id, status
             FROM agent_profiles
             WHERE id = ? AND user_id = ?
             LIMIT 1`
          )
          .get(snapRow.profile_id, userId) as
          | { id: string; user_id: string; status: string }
          | undefined;

        if (!profileRow) {
          throw new PlatformError(
            '[FAIL_CLOSED] Space references corrupt or missing agent profile',
            'FAIL_CLOSED',
            500
          );
        }
        if (profileRow.status !== 'active') {
          if (profileRow.status === 'archived' || profileRow.status === 'deleted') {
            throw new PlatformError(
              '[FAIL_CLOSED] Space references archived or deleted agent profile',
              'FAIL_CLOSED',
              500
            );
          }
          throw new PlatformError(
            'Invalid agent profile record: invalid status',
            'DATABASE_CORRUPTED',
            500
          );
        }

        // Validate prompt hash integrity
        if (typeof snapRow.prompt_hash !== 'string' || !PROMPT_HASH_REGEX.test(snapRow.prompt_hash)) {
          throw new PlatformError(
            '[FAIL_CLOSED] Agent profile snapshot stored prompt_hash is missing or invalid',
            'FAIL_CLOSED',
            500
          );
        }

        const recomputedHash = computeAgentProfilePromptHash({
          identity: snapRow.identity,
          soul: snapRow.soul,
          agents: snapRow.agents,
          tools: snapRow.tools,
        });

        if (!secureHashEquals(snapRow.prompt_hash, recomputedHash)) {
          throw new PlatformError(
            '[FAIL_CLOSED] Agent profile snapshot stored prompt_hash does not match recomputed hash',
            'FAIL_CLOSED',
            500
          );
        }

        if (spaceRow.agent_profile_id && spaceRow.agent_profile_id !== snapRow.profile_id) {
          throw new PlatformError(
            '[FAIL_CLOSED] Space agent_profile_id does not match snapshot profile_id',
            'FAIL_CLOSED',
            500
          );
        }

        boundSnapshotId = snapRow.id;
        boundProfileId = snapRow.profile_id;
      } else if (spaceRow.agent_profile_id) {
        const profileRow = this.db
          .prepare(
            `SELECT id, user_id, status, active_version
             FROM agent_profiles
             WHERE id = ? AND user_id = ?
             LIMIT 1`
          )
          .get(spaceRow.agent_profile_id, userId) as
          | { id: string; user_id: string; status: string; active_version: number }
          | undefined;

        if (!profileRow) {
          throw new PlatformError(
            '[FAIL_CLOSED] Space references corrupt or missing agent profile',
            'FAIL_CLOSED',
            500
          );
        }
        if (profileRow.status !== 'active') {
          if (profileRow.status === 'archived' || profileRow.status === 'deleted') {
            throw new PlatformError(
              '[FAIL_CLOSED] Space references archived or deleted agent profile',
              'FAIL_CLOSED',
              500
            );
          }
          throw new PlatformError(
            'Invalid agent profile record: invalid status',
            'DATABASE_CORRUPTED',
            500
          );
        }

        const snapRow = this.db
          .prepare(
            `SELECT id, profile_id, version, user_id, prompt_hash, identity, soul, agents, tools
             FROM agent_profile_snapshots
             WHERE profile_id = ? AND version = ? AND user_id = ?
             LIMIT 1`
          )
          .get(profileRow.id, profileRow.active_version, userId) as
          | {
              id: string;
              profile_id: string;
              version: number;
              user_id: string;
              prompt_hash: string;
              identity: string;
              soul: string;
              agents: string;
              tools: string;
            }
          | undefined;

        if (!snapRow) {
          throw new PlatformError(
            '[FAIL_CLOSED] Agent profile active version snapshot missing',
            'FAIL_CLOSED',
            500
          );
        }

        if (typeof snapRow.prompt_hash !== 'string' || !PROMPT_HASH_REGEX.test(snapRow.prompt_hash)) {
          throw new PlatformError(
            '[FAIL_CLOSED] Agent profile snapshot stored prompt_hash is missing or invalid',
            'FAIL_CLOSED',
            500
          );
        }

        const recomputedHash = computeAgentProfilePromptHash({
          identity: snapRow.identity,
          soul: snapRow.soul,
          agents: snapRow.agents,
          tools: snapRow.tools,
        });

        if (!secureHashEquals(snapRow.prompt_hash, recomputedHash)) {
          throw new PlatformError(
            '[FAIL_CLOSED] Agent profile snapshot stored prompt_hash does not match recomputed hash',
            'FAIL_CLOSED',
            500
          );
        }

        boundSnapshotId = snapRow.id;
        boundProfileId = profileRow.id;
      }

      // 1. Create session route
      const peerId = `web:${sessionId}`;
      this.db
        .prepare(
          `INSERT INTO session_routes (
            id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id,
            execution_mode, status, title, reset_count, current_generation, agent_profile_id, agent_profile_snapshot_id, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 0, 1, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
        )
        .run(
          sessionId,
          input.spaceId,
          userId,
          WEB_CHANNEL_NAME,
          DEFAULT_WEB_ACCOUNT_ID,
          sessionId,
          peerId,
          sessionId,
          spaceExecutionMode,
          input.title ? input.title.trim() : null,
          boundProfileId,
          boundSnapshotId
        );

      // 2. Initialize generation 1 mandatory row in session_generations
      const gen1Id = `gen_${randomUUID().replace(/-/g, '')}`;
      this.db
        .prepare(
          `INSERT INTO session_generations (
            id, user_id, route_id, generation_number, dsh_session_id, agent_profile_snapshot_id, reset_reason, created_at
          )
          VALUES (?, ?, ?, 1, ?, ?, 'initial', CURRENT_TIMESTAMP)`
        )
        .run(gen1Id, userId, sessionId, sessionId, boundSnapshotId);

      this.db.exec('COMMIT');
      inTx = false;

      const tenant = this.storage.forTenant(userId);
      const route = await tenant.sessionRoutes.findById(sessionId);
      if (!route) {
        throw new PlatformError('Failed to retrieve newly created session', 'INTERNAL_ERROR', 500);
      }

      return this.toPublicSession(route);
    } catch (err) {
      if (inTx) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rbErr) {
          const primary = err instanceof Error ? err : new Error('Database transaction failed');
          const rollback = rbErr instanceof Error ? rbErr : new Error('Database rollback failed');
          throw new AggregateError([primary, rollback], 'Database transaction and rollback failed');
        }
      }
      throw err;
    }
  }

  async updateSession(userId: string, sessionId: string, input: UpdateSessionInput): Promise<PublicSession> {
    if (!input || typeof input !== 'object') {
      throw new ValidationError('Update session input must be an object');
    }

    const tenant = this.storage.forTenant(userId);
    const existing = await tenant.sessionRoutes.findById(sessionId);
    if (!existing) {
      throw new NotFoundError('Session not found');
    }
    if (existing.status !== 'active') {
      if (existing.status === 'archived' || existing.status === 'deleted') {
        throw new ValidationError('Cannot update archived session');
      }
      throw new PlatformError('Invalid session record: invalid status', 'DATABASE_CORRUPTED', 500);
    }

    let title: string | null = null;
    if (input.title !== undefined && input.title !== null) {
      if (
        typeof input.title !== 'string' ||
        input.title !== input.title.trim() ||
        input.title.normalize('NFC') !== input.title ||
        input.title.length > 256
      ) {
        throw new ValidationError('Session title must be an NFC-normalized string with maximum 256 characters');
      }
      title = input.title;
    } else if (input.title === undefined) {
      title = existing.title ?? null;
    } else {
      title = null;
    }

    const updated = await tenant.sessionRoutes.update(sessionId, {
      title,
    });

    return this.toPublicSession(updated);
  }

  async archiveSession(userId: string, sessionId: string): Promise<PublicSession> {
    const tenant = this.storage.forTenant(userId);
    const existing = await tenant.sessionRoutes.findById(sessionId);
    if (!existing) {
      throw new NotFoundError('Session not found');
    }

    let inTx = false;
    this.db.exec('BEGIN IMMEDIATE');
    inTx = true;
    try {
      const sessionRow = this.db
        .prepare('SELECT id FROM session_routes WHERE id = ? AND user_id = ? LIMIT 1')
        .get(sessionId, userId);

      if (!sessionRow) {
        throw new NotFoundError('Session not found');
      }

      // Check for active turns
      const activeTurns = this.db
        .prepare(
          `SELECT id FROM turn_runs
           WHERE route_id = ? AND user_id = ? AND status IN ('running', 'queued')
           LIMIT 1`
        )
        .get(sessionId, userId);

      if (activeTurns) {
        throw new PlatformError('Cannot archive session with active turns', 'CONFLICT', 409);
      }

      this.db
        .prepare('UPDATE session_routes SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
        .run('archived', sessionId, userId);

      this.db.exec('COMMIT');
      inTx = false;

      const updated = await tenant.sessionRoutes.findById(sessionId);
      if (!updated) {
        throw new PlatformError('Failed to retrieve session after archive', 'INTERNAL_ERROR', 500);
      }
      return this.toPublicSession(updated);
    } catch (err) {
      if (inTx) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rbErr) {
          const primary = err instanceof Error ? err : new Error('Database transaction failed');
          const rollback = rbErr instanceof Error ? rbErr : new Error('Database rollback failed');
          throw new AggregateError([primary, rollback], 'Database transaction and rollback failed');
        }
      }
      throw err;
    }
  }

  async restoreSession(userId: string, sessionId: string): Promise<PublicSession> {
    if (!this.sessionLifecycleService) {
      throw new PlatformError(
        'Session lifecycle service is not configured on platform API',
        'SERVICE_UNAVAILABLE',
        503
      );
    }
    return this.sessionLifecycleService.restoreSession(userId, sessionId);
  }

  async forkSession(
    userId: string,
    sessionId: string,
    options?: ForkSessionOptions
  ): Promise<PublicSession> {
    if (!this.forkService) {
      throw new PlatformError(
        'Fork service is not configured on platform API',
        'SERVICE_UNAVAILABLE',
        503
      );
    }
    return this.forkService.forkSession(userId, sessionId, options);
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
    if (!options || typeof options !== 'object') {
      throw new ValidationError('Reset session options must be an object');
    }
    if (
      !options.idempotencyKey ||
      typeof options.idempotencyKey !== 'string' ||
      !UUID_V4_REGEX.test(options.idempotencyKey)
    ) {
      throw new ValidationError('Invalid or missing idempotencyKey: must be a valid lowercase UUIDv4');
    }
    const idempotencyKey = options.idempotencyKey;

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

    let inTx = false;
    this.db.exec('BEGIN IMMEDIATE');
    inTx = true;
    try {
      // Re-read route and space inside write lock
      const routeRow = this.db
        .prepare(
          `SELECT id, space_id, user_id, status, title, dsh_session_id, current_generation, reset_count, agent_profile_snapshot_id, created_at, updated_at
           FROM session_routes
           WHERE id = ? AND user_id = ?
           LIMIT 1`
        )
        .get(sessionId, userId) as
        | {
            id: string;
            space_id: string;
            user_id: string;
            status: string;
            title: string | null;
            dsh_session_id: string;
            current_generation: number;
            reset_count: number;
            agent_profile_snapshot_id: string | null;
            created_at: string;
            updated_at: string;
          }
        | undefined;

      if (!routeRow) {
        throw new NotFoundError('Session not found');
      }
      if (routeRow.status !== 'active') {
        if (routeRow.status === 'archived' || routeRow.status === 'deleted') {
          throw new ValidationError('Cannot reset archived session');
        }
        throw new PlatformError('Invalid session record: invalid status', 'DATABASE_CORRUPTED', 500);
      }

      // Validate counters as mandatory safe integers (no ?? fallbacks)
      if (!Number.isInteger(routeRow.current_generation) || routeRow.current_generation < 1) {
        throw new PlatformError(
          'Corrupted session route: current_generation must be a positive integer',
          'DATABASE_CORRUPTED',
          500
        );
      }
      if (!Number.isInteger(routeRow.reset_count) || routeRow.reset_count < 0) {
        throw new PlatformError(
          'Corrupted session route: reset_count must be a non-negative integer',
          'DATABASE_CORRUPTED',
          500
        );
      }

      const spaceRow = this.db
        .prepare(
          `SELECT id, status, agent_profile_id, agent_profile_snapshot_id
           FROM spaces
           WHERE id = ? AND user_id = ?
           LIMIT 1`
        )
        .get(routeRow.space_id, userId) as
        | {
            id: string;
            status: string;
            agent_profile_id: string | null;
            agent_profile_snapshot_id: string | null;
          }
        | undefined;

      if (!spaceRow) {
        throw new NotFoundError('Space not found');
      }
      if (spaceRow.status !== 'active') {
        if (spaceRow.status === 'archived' || spaceRow.status === 'deleted') {
          throw new ValidationError('Cannot reset session in archived space');
        }
        throw new PlatformError('Invalid space record: invalid status', 'DATABASE_CORRUPTED', 500);
      }

      // Check for running / queued turns
      const activeTurn = this.db
        .prepare(
          `SELECT id FROM turn_runs
           WHERE route_id = ? AND user_id = ? AND status IN ('running', 'queued')
           LIMIT 1`
        )
        .get(sessionId, userId);

      if (activeTurn) {
        throw new PlatformError('Cannot reset session with active (running/queued) turns', 'CONFLICT', 409);
      }

      // Check operation idempotency
      const checkIdemp = this.db
        .prepare(
          `SELECT id, target_id, request_hash, response_payload
           FROM operation_idempotency
           WHERE user_id = ? AND scope = 'reset_session' AND idempotency_key = ?
           LIMIT 1`
        )
        .get(userId, idempotencyKey) as
        | { id: string; target_id: string; request_hash: string; response_payload: string }
        | undefined;

      if (checkIdemp) {
        if (checkIdemp.target_id !== sessionId) {
          throw new PlatformError('Idempotency key reused for different session', 'CONFLICT', 409);
        }
        if (checkIdemp.request_hash !== requestHash) {
          throw new PlatformError('Idempotency key reused with different request payload', 'CONFLICT', 409);
        }
        this.db.exec('COMMIT');
        inTx = false;

        // Parse stored immutable receipt and return with isIdempotentHit = true
        const storedReceipt = JSON.parse(checkIdemp.response_payload) as {
          session: PublicSession;
          generation: PublicGeneration;
        };

        return {
          session: storedReceipt.session,
          generation: storedReceipt.generation,
          isIdempotentHit: true,
        };
      }

      // Re-resolve active profile for next generation; reject archived profile binding
      let newBoundProfileId: string | null = null;
      let newBoundSnapshotId: string | null = null;

      if (spaceRow.agent_profile_snapshot_id) {
        const snapRow = this.db
          .prepare(
            `SELECT id, profile_id, version, user_id, prompt_hash, identity, soul, agents, tools
             FROM agent_profile_snapshots
             WHERE id = ? AND user_id = ?
             LIMIT 1`
          )
          .get(spaceRow.agent_profile_snapshot_id, userId) as
          | {
              id: string;
              profile_id: string;
              version: number;
              user_id: string;
              prompt_hash: string;
              identity: string;
              soul: string;
              agents: string;
              tools: string;
            }
          | undefined;

        if (!snapRow) {
          throw new PlatformError(
            '[FAIL_CLOSED] Space references corrupt or missing agent profile snapshot',
            'FAIL_CLOSED',
            500
          );
        }

        // Verify that the bound agent profile is not archived or deleted
        const profileRow = this.db
          .prepare(
            `SELECT id, user_id, status
             FROM agent_profiles
             WHERE id = ? AND user_id = ?
             LIMIT 1`
          )
          .get(snapRow.profile_id, userId) as
          | { id: string; user_id: string; status: string }
          | undefined;

        if (!profileRow) {
          throw new PlatformError(
            '[FAIL_CLOSED] Space references corrupt or missing agent profile',
            'FAIL_CLOSED',
            500
          );
        }
        if (profileRow.status !== 'active') {
          if (profileRow.status === 'archived' || profileRow.status === 'deleted') {
            throw new PlatformError(
              '[FAIL_CLOSED] Space references archived or deleted agent profile',
              'FAIL_CLOSED',
              500
            );
          }
          throw new PlatformError(
            'Invalid agent profile record: invalid status',
            'DATABASE_CORRUPTED',
            500
          );
        }

        if (typeof snapRow.prompt_hash !== 'string' || !PROMPT_HASH_REGEX.test(snapRow.prompt_hash)) {
          throw new PlatformError(
            '[FAIL_CLOSED] Agent profile snapshot stored prompt_hash is missing or invalid',
            'FAIL_CLOSED',
            500
          );
        }

        const recomputedHash = computeAgentProfilePromptHash({
          identity: snapRow.identity,
          soul: snapRow.soul,
          agents: snapRow.agents,
          tools: snapRow.tools,
        });

        if (!secureHashEquals(snapRow.prompt_hash, recomputedHash)) {
          throw new PlatformError(
            '[FAIL_CLOSED] Agent profile snapshot stored prompt_hash does not match recomputed hash',
            'FAIL_CLOSED',
            500
          );
        }

        if (spaceRow.agent_profile_id && spaceRow.agent_profile_id !== snapRow.profile_id) {
          throw new PlatformError(
            '[FAIL_CLOSED] Space agent_profile_id does not match snapshot profile_id',
            'FAIL_CLOSED',
            500
          );
        }

        newBoundSnapshotId = snapRow.id;
        newBoundProfileId = snapRow.profile_id;
      } else if (spaceRow.agent_profile_id) {
        const profileRow = this.db
          .prepare(
            `SELECT id, user_id, status, active_version
             FROM agent_profiles
             WHERE id = ? AND user_id = ?
             LIMIT 1`
          )
          .get(spaceRow.agent_profile_id, userId) as
          | { id: string; user_id: string; status: string; active_version: number }
          | undefined;

        if (!profileRow) {
          throw new PlatformError(
            '[FAIL_CLOSED] Space references corrupt or missing agent profile',
            'FAIL_CLOSED',
            500
          );
        }
        if (profileRow.status !== 'active') {
          if (profileRow.status === 'archived' || profileRow.status === 'deleted') {
            throw new PlatformError(
              '[FAIL_CLOSED] Space references archived or deleted agent profile',
              'FAIL_CLOSED',
              500
            );
          }
          throw new PlatformError(
            'Invalid agent profile record: invalid status',
            'DATABASE_CORRUPTED',
            500
          );
        }

        const snapRow = this.db
          .prepare(
            `SELECT id, profile_id, version, user_id, prompt_hash, identity, soul, agents, tools
             FROM agent_profile_snapshots
             WHERE profile_id = ? AND version = ? AND user_id = ?
             LIMIT 1`
          )
          .get(profileRow.id, profileRow.active_version, userId) as
          | {
              id: string;
              profile_id: string;
              version: number;
              user_id: string;
              prompt_hash: string;
              identity: string;
              soul: string;
              agents: string;
              tools: string;
            }
          | undefined;

        if (!snapRow) {
          throw new PlatformError(
            '[FAIL_CLOSED] Agent profile active version snapshot missing',
            'FAIL_CLOSED',
            500
          );
        }

        if (typeof snapRow.prompt_hash !== 'string' || !PROMPT_HASH_REGEX.test(snapRow.prompt_hash)) {
          throw new PlatformError(
            '[FAIL_CLOSED] Agent profile snapshot stored prompt_hash is missing or invalid',
            'FAIL_CLOSED',
            500
          );
        }

        const recomputedHash = computeAgentProfilePromptHash({
          identity: snapRow.identity,
          soul: snapRow.soul,
          agents: snapRow.agents,
          tools: snapRow.tools,
        });

        if (!secureHashEquals(snapRow.prompt_hash, recomputedHash)) {
          throw new PlatformError(
            '[FAIL_CLOSED] Agent profile snapshot stored prompt_hash does not match recomputed hash',
            'FAIL_CLOSED',
            500
          );
        }

        newBoundSnapshotId = snapRow.id;
        newBoundProfileId = profileRow.id;
      }

      // Safe counters increment
      const nextGeneration = routeRow.current_generation + 1;
      const nextResetCount = routeRow.reset_count + 1;
      const newDshSessionId = `ses_${randomUUID().replace(/-/g, '')}`;
      const nowIso = new Date().toISOString();
      const generationId = `gen_${randomUUID().replace(/-/g, '')}`;

      // Insert new generation row into session_generations
      this.db
        .prepare(
          `INSERT INTO session_generations (
            id, user_id, route_id, generation_number, dsh_session_id, agent_profile_snapshot_id, reset_reason, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        )
        .run(
          generationId,
          userId,
          sessionId,
          nextGeneration,
          newDshSessionId,
          newBoundSnapshotId,
          validReason
        );

      // Update session_routes
      this.db
        .prepare(
          `UPDATE session_routes
           SET dsh_session_id = ?,
               current_generation = ?,
               reset_count = ?,
               last_reset_at = ?,
               agent_profile_id = ?,
               agent_profile_snapshot_id = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND user_id = ?`
        )
        .run(
          newDshSessionId,
          nextGeneration,
          nextResetCount,
          nowIso,
          newBoundProfileId,
          newBoundSnapshotId,
          sessionId,
          userId
        );

      // Construct public objects for original transaction snapshot
      const publicSession: PublicSession = {
        id: routeRow.id,
        spaceId: routeRow.space_id,
        title: routeRow.title,
        status: routeRow.status as PublicSession['status'],
        currentGeneration: nextGeneration,
        createdAt: routeRow.created_at,
        updatedAt: nowIso,
      };

      const publicGeneration: PublicGeneration = {
        generation: nextGeneration,
        resetReason: validReason,
        createdAt: nowIso,
        isCurrent: true,
      };

      const storedReceipt = {
        session: publicSession,
        generation: publicGeneration,
      };

      // Store in operation_idempotency
      const idempId = `idemp_${randomUUID().replace(/-/g, '')}`;
      this.db
        .prepare(
          `INSERT INTO operation_idempotency (
            id, user_id, scope, idempotency_key, target_id, request_hash, response_payload, created_at
          )
          VALUES (?, ?, 'reset_session', ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        )
        .run(
          idempId,
          userId,
          idempotencyKey,
          sessionId,
          requestHash,
          JSON.stringify(storedReceipt)
        );

      this.db.exec('COMMIT');
      inTx = false;

      return {
        session: publicSession,
        generation: publicGeneration,
        isIdempotentHit: false,
      };
    } catch (err) {
      if (inTx) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rbErr) {
          const primary = err instanceof Error ? err : new Error('Database transaction failed');
          const rollback = rbErr instanceof Error ? rbErr : new Error('Database rollback failed');
          throw new AggregateError([primary, rollback], 'Database transaction and rollback failed');
        }
      }
      throw err;
    }
  }

  async listSessionGenerations(userId: string, sessionId: string): Promise<PublicGeneration[]> {
    const tenant = this.storage.forTenant(userId);
    const existing = await tenant.sessionRoutes.findById(sessionId);
    if (!existing) {
      throw new NotFoundError('Session not found');
    }

    if (
      typeof existing.currentGeneration !== 'number' ||
      !Number.isInteger(existing.currentGeneration) ||
      existing.currentGeneration < 1
    ) {
      throw new PlatformError(
        'Corrupted session route: currentGeneration must be a positive integer',
        'DATABASE_CORRUPTED',
        500
      );
    }
    const currentGen = existing.currentGeneration;

    const rows = this.db
      .prepare(
        `SELECT generation_number, reset_reason, created_at
         FROM session_generations
         WHERE route_id = ? AND user_id = ?
         ORDER BY generation_number ASC`
      )
      .all(sessionId, userId) as Array<{
      generation_number: number;
      reset_reason: string | null;
      created_at: string;
    }>;

    return rows.map((r) => {
      if (
        typeof r.generation_number !== 'number' ||
        !Number.isInteger(r.generation_number) ||
        r.generation_number < 1
      ) {
        throw new PlatformError('Invalid generation number in record', 'DATABASE_CORRUPTED', 500);
      }
      if (r.reset_reason !== null && typeof r.reset_reason !== 'string') {
        throw new PlatformError('Invalid resetReason in generation record', 'DATABASE_CORRUPTED', 500);
      }
      if (!r.created_at || typeof r.created_at !== 'string') {
        throw new PlatformError('Invalid createdAt in generation record', 'DATABASE_CORRUPTED', 500);
      }
      return {
        generation: r.generation_number,
        resetReason: r.reset_reason,
        createdAt: r.created_at,
        isCurrent: r.generation_number === currentGen,
      };
    });
  }

  // --- Messages & Events APIs ---

  private async ensureSessionAccess(
    userId: string,
    sessionId: string
  ): Promise<SessionRoute> {
    const tenant = this.storage.forTenant(userId);
    const route = await tenant.sessionRoutes.findById(sessionId);
    if (!route) {
      throw new NotFoundError('Session not found');
    }
    return route;
  }

  /**
   * Enforces that session and parent space are active before allowing new turns or message writes.
   */
  async ensureActiveSessionForTurn(
    userId: string,
    sessionId: string
  ): Promise<SessionRoute> {
    const route = await this.ensureSessionAccess(userId, sessionId);
    if (route.status !== 'active') {
      if (route.status === 'archived' || route.status === 'deleted') {
        throw new PlatformError('Session is archived and cannot accept new turns', 'SESSION_ARCHIVED', 400);
      }
      throw new PlatformError('Invalid session record: invalid status', 'DATABASE_CORRUPTED', 500);
    }

    const tenant = this.storage.forTenant(userId);
    const space = await tenant.spaces.findById(route.spaceId);
    if (!space) {
      throw new NotFoundError('Space not found');
    }
    if (space.status !== 'active') {
      if (space.status === 'archived' || space.status === 'deleted') {
        throw new PlatformError('Space is archived; session cannot accept new turns', 'SPACE_ARCHIVED', 400);
      }
      throw new PlatformError('Invalid space record: invalid status', 'DATABASE_CORRUPTED', 500);
    }

    return route;
  }

  async listMessages(
    userId: string,
    sessionId: string,
    options?: { limit?: number; before?: string; after?: string; cursor?: string }
  ): Promise<{ messages: PublicMessage[]; hasMore: boolean; olderCursor: string | null; newerCursor: string | null }> {
    await this.ensureSessionAccess(userId, sessionId);

    if (options && (options as any).cursor !== undefined) {
      throw new ValidationError('Legacy "cursor" parameter is removed; use "before" for historical pagination or "after" for forward catch-up');
    }

    const result = await this.messageStore.listMessages(userId, sessionId, {
      limit: options?.limit,
      before: options?.before,
      after: options?.after,
    });

    const messages: PublicMessage[] = result.messages.map((m) => {
      if (!m.id || typeof m.id !== 'string') {
        throw new PlatformError('Corrupted message record: missing id', 'DATABASE_CORRUPTED', 500);
      }
      if (!m.createdAt || typeof m.createdAt !== 'string') {
        throw new PlatformError('Corrupted message record: missing createdAt', 'DATABASE_CORRUPTED', 500);
      }
      return {
        id: m.id,
        role: m.role,
        content: m.content,
        status: m.status,
        createdAt: m.createdAt,
        ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
        ...(m.replyReference ? { replyReference: m.replyReference } : {}),
      };
    });

    return {
      messages,
      hasMore: result.hasMore,
      olderCursor: result.olderCursor,
      newerCursor: result.newerCursor,
    };
  }

  async getMessage(userId: string, sessionId: string, messageId: string): Promise<PublicMessage | null> {
    await this.ensureSessionAccess(userId, sessionId);
    const m = await this.messageStore.getMessage(userId, sessionId, messageId);
    if (!m) return null;
    if (!m.id || typeof m.id !== 'string' || !m.createdAt || typeof m.createdAt !== 'string') {
      throw new PlatformError('Corrupted message record', 'DATABASE_CORRUPTED', 500);
    }
    return {
      id: m.id,
      role: m.role,
      content: m.content,
      status: m.status,
      createdAt: m.createdAt,
      ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
      ...(m.replyReference ? { replyReference: m.replyReference } : {}),
    };
  }

  async pollEvents(
    userId: string,
    sessionId: string,
    cursor?: string
  ): Promise<{ events: PublicWebChannelEvent[]; nextCursor: string | null }> {
    await this.ensureSessionAccess(userId, sessionId);

    const result = await this.messageStore.pollEvents(userId, sessionId, cursor);
    const events: PublicWebChannelEvent[] = result.events.map((e) => {
      if (!e.id || typeof e.id !== 'string') {
        throw new PlatformError('Corrupted event record: missing id', 'DATABASE_CORRUPTED', 500);
      }
      if (!e.createdAt || typeof e.createdAt !== 'string') {
        throw new PlatformError('Corrupted event record: missing timestamp', 'DATABASE_CORRUPTED', 500);
      }
      if (!e.payload || typeof e.payload !== 'object') {
        throw new PlatformError('Corrupted event record: invalid payload', 'DATABASE_CORRUPTED', 500);
      }

      const payload = e.payload as Record<string, unknown>;

      switch (e.type) {
        case 'message': {
          const rawMsg = (payload['message'] && isRecord(payload['message'])) ? payload['message'] : payload;
          if (!rawMsg || typeof rawMsg !== 'object') {
            throw new PlatformError('Corrupted message event: missing message payload', 'DATABASE_CORRUPTED', 500);
          }
          const msgId = typeof rawMsg['id'] === 'string' ? rawMsg['id'] : e.id;
          const role = rawMsg['role'];
          if (role !== 'user' && role !== 'assistant' && role !== 'system') {
            throw new PlatformError('Corrupted message event: invalid role', 'DATABASE_CORRUPTED', 500);
          }
          const content = typeof rawMsg['content'] === 'string' ? rawMsg['content'] : '';
          const rawStatus = rawMsg['status'];
          const status = (rawStatus === 'pending' || rawStatus === 'delivered' || rawStatus === 'failed')
            ? rawStatus
            : 'delivered';
          const createdAt = typeof rawMsg['createdAt'] === 'string' ? rawMsg['createdAt'] : e.createdAt;

          const rawAttachments = Array.isArray(rawMsg['attachments']) ? rawMsg['attachments'] : undefined;

          const publicMsg: PublicMessage = {
            id: msgId,
            role,
            content,
            status,
            createdAt,
            ...(rawAttachments && rawAttachments.length > 0 ? { attachments: rawAttachments as any } : {}),
            ...(rawMsg['replyReference'] ? { replyReference: rawMsg['replyReference'] as any } : {}),
          };

          return {
            id: e.id,
            type: 'message',
            message: publicMsg,
            timestamp: e.createdAt,
          };
        }

        case 'assistant_delta': {
          const streamId = typeof payload['streamId'] === 'string' ? payload['streamId'] : e.id;
          const delta = typeof payload['delta'] === 'string' ? payload['delta'] : '';
          const accumulatedLength = typeof payload['accumulatedLength'] === 'number' && Number.isFinite(payload['accumulatedLength'])
            ? payload['accumulatedLength']
            : delta.length;
          return {
            id: e.id,
            type: 'assistant_delta',
            streamId,
            delta,
            accumulatedLength,
            timestamp: e.createdAt,
          };
        }

        case 'assistant_stream_end': {
          const streamId = typeof payload['streamId'] === 'string' ? payload['streamId'] : e.id;
          return {
            id: e.id,
            type: 'assistant_stream_end',
            streamId,
            timestamp: e.createdAt,
          };
        }

        case 'thinking': {
          const streamId = typeof payload['streamId'] === 'string' ? payload['streamId'] : undefined;
          return {
            id: e.id,
            type: 'thinking',
            ...(streamId ? { streamId } : {}),
            status: 'thinking',
            timestamp: e.createdAt,
          };
        }

        case 'tool_status': {
          const rawToolName = payload['toolName'] ?? payload['name'];
          const toolName = typeof rawToolName === 'string' && rawToolName.trim() ? rawToolName.trim() : 'custom_tool';
          const rawStatus = payload['status'];
          const status = (rawStatus === 'started' || rawStatus === 'completed' || rawStatus === 'failed') ? rawStatus : 'started';
          return {
            id: e.id,
            type: 'tool_status',
            toolName,
            status,
            timestamp: e.createdAt,
          };
        }

        case 'turn_status':
        case 'turn_failed':
        case 'turn_cancelled':
        case 'status_update': {
          const rawStatus = (payload['turnStatus'] && isRecord(payload['turnStatus']))
            ? (payload['turnStatus'] as Record<string, unknown>)['status']
            : payload['status'];
          let finalStatus: TurnExecutionStatus = 'running';
          if (
            rawStatus === 'queued' ||
            rawStatus === 'running' ||
            rawStatus === 'completed' ||
            rawStatus === 'failed' ||
            rawStatus === 'interrupted'
          ) {
            finalStatus = rawStatus;
          } else if (e.type === 'turn_failed') {
            finalStatus = 'failed';
          } else if (e.type === 'turn_cancelled') {
            finalStatus = 'interrupted';
          } else {
            finalStatus = 'running';
          }
          const rawCode = typeof payload['code'] === 'string'
            ? payload['code']
            : (e.type === 'turn_cancelled' ? 'TURN_CANCELLED' : (e.type === 'turn_failed' ? 'TURN_FAILED' : undefined));
          let validCode: PublicEventCode | undefined = undefined;
          if (rawCode && ALLOWED_PUBLIC_EVENT_CODES.has(rawCode)) {
            validCode = rawCode as PublicEventCode;
          }
          return {
            id: e.id,
            type: 'turn_status',
            status: finalStatus,
            ...(validCode ? { code: validCode } : {}),
            timestamp: e.createdAt,
          };
        }

        case 'error': {
          const rawCode = typeof payload['code'] === 'string' ? payload['code'] : 'INTERNAL_ERROR';
          const validCode: PublicEventCode = ALLOWED_PUBLIC_EVENT_CODES.has(rawCode)
            ? (rawCode as PublicEventCode)
            : 'INTERNAL_ERROR';
          return {
            id: e.id,
            type: 'error',
            code: validCode,
            timestamp: e.createdAt,
          };
        }

        default:
          throw new PlatformError('Corrupted event record: unknown event type', 'DATABASE_CORRUPTED', 500);
      }
    });

    return {
      events,
      nextCursor: (typeof result.nextCursor === 'string' && result.nextCursor.length > 0) ? result.nextCursor : null,
    };
  }
}

export { SqlitePlatformWebApiAdapter as SqlitePlatformApi };
