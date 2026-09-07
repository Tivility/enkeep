/**
 * Official Platform Profile Service & Governance Implementation
 *
 * Provides versioned Agent Profile management, strict canonical hashing,
 * Unicode NFC and safety validation, tenant-isolated REST backing,
 * space profile binding, and fail-closed session snapshot resolution.
 *
 * @module @enkeep/platform-server/profiles/profile-service
 */

import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  PlatformError,
  NotFoundError,
  ValidationError,
  TenantAccessDeniedError,
  type PlatformStorage,
  type AgentProfile,
  type AgentProfileSnapshot,
  type PublicAgentProfileSnapshot,
  toPublicAgentProfileSnapshot,
  type AgentProfileWithSnapshot,
  type LifecycleStatus,
  type SpaceProfileBindingResult,
  type SafeBoundProfileSummary,
} from '@enkeep/platform-core';

/**
 * Maximum combined UTF-8 byte length for the 4 prompt sections (64 KiB).
 */
export const MAX_PROFILE_PROMPT_BYTES = 64 * 1024; // 65,536 bytes

/**
 * Regex pattern for strictly valid prompt hash (64-character lowercase hex SHA-256).
 */
export const PROMPT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Regex pattern for strictly valid profile ID (prof_ followed by 32 hex characters).
 */
export const PROFILE_ID_PATTERN = /^prof_[0-9a-f]{32}$/;

/**
 * Regex pattern for strictly valid snapshot ID (snap_ followed by 32 hex characters).
 */
export const SNAPSHOT_ID_PATTERN = /^snap_[0-9a-f]{32}$/;

/**
 * Disallowed control and format characters:
 * - Unicode general category Cc (Control) except \t (U+0009), \n (U+000A), \r (U+000D)
 * - Unicode general category Cf (Format, including bidi controls, zero-width spaces, invisible characters)
 * - Unicode Line Separator U+2028 and Paragraph Separator U+2029
 */
export const FORBIDDEN_CONTROL_CHARS_PATTERN = /[^\P{Cc}\t\n\r]|\p{Cf}|[\u2028\u2029]/u;

/**
 * Disallowed prompt template variable tokens `{{` and `}}`.
 * Official systemPrompt assembly throws if template variable tokens are present.
 */
export const TEMPLATE_VARIABLE_PATTERN = /\{\{|\}\}/;

/**
 * Allowed top-level keys in AgentProfileSnapshot for runtime execution contract.
 */
export const ALLOWED_RUNTIME_PROFILE_KEYS = new Set([
  'profileId',
  'version',
  'promptHash',
  'identity',
  'soul',
  'agents',
  'tools',
]);

/**
 * Allowed keys when creating a new agent profile.
 */
export const ALLOWED_CREATE_PROFILE_KEYS = [
  'name',
  'description',
  'identity',
  'soul',
  'agents',
  'tools',
  'changeSummary',
] as const;

/**
 * Allowed keys when creating a new agent profile version.
 */
export const ALLOWED_CREATE_PROFILE_VERSION_KEYS = [
  'identity',
  'soul',
  'agents',
  'tools',
  'changeSummary',
] as const;

/**
 * Allowed keys when binding a space to an agent profile.
 */
export const ALLOWED_BIND_SPACE_PROFILE_KEYS = [
  'profileId',
  'version',
] as const;

/**
 * Runtime Agent Profile Snapshot contract (consumed by execution executor / container runtime).
 * Strictly contains ONLY the 7 allowed runtime keys with canonical SHA-256 hash.
 */
export interface RuntimeAgentProfileSnapshot {
  readonly profileId: string;
  readonly version: number;
  readonly promptHash: string;
  readonly identity: string;
  readonly soul: string;
  readonly agents: string;
  readonly tools: string;
}

/**
 * Safe Agent Profile item for REST management responses (omits userId, no raw hashes exposed).
 */
export interface SafeAgentProfileItem {
  id: string;
  name: string;
  description?: string | null;
  status: LifecycleStatus;
  activeVersion: number;
  createdAt: string;
  updatedAt: string;
}

export {
  canonicalJsonStringify as canonicalProfileJsonStringify,
  type PublicAgentProfileSnapshot,
  toPublicAgentProfileSnapshot as toPublicSnapshot,
  type SpaceProfileBindingResult,
  type SafeBoundProfileSummary,
};

/**
 * Agent Profile with active snapshot details for owner inspect/edit responses.
 */
export interface SafeAgentProfileDetail extends SafeAgentProfileItem {
  snapshot?: PublicAgentProfileSnapshot | null;
}

export interface AgentProfileListResult {
  items: SafeAgentProfileItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateProfileRequest {
  name: string;
  description?: string | null;
  identity?: string;
  soul?: string;
  agents?: string;
  tools?: string;
  changeSummary?: string | null;
}

export interface CreateProfileVersionRequest {
  identity?: string;
  soul?: string;
  agents?: string;
  tools?: string;
  changeSummary?: string | null;
}

export interface RollbackProfileRequest {
  targetVersion: number;
  changeSummary?: string | null;
}

/**
 * Idempotency receipt for create_agent_profile operation.
 */
interface CreateProfileReceipt {
  readonly profileId: string;
  readonly version: number;
}

/**
 * Idempotency receipt for create_agent_profile_version operation.
 */
interface CreateProfileVersionReceipt {
  readonly profileId: string;
  readonly version: number;
}

/**
 * Idempotency receipt for rollback_agent_profile_version operation.
 */
interface RollbackProfileVersionReceipt {
  readonly profileId: string;
  readonly version: number;
}

type OperationReceipt = CreateProfileReceipt | CreateProfileVersionReceipt | RollbackProfileVersionReceipt;

/**
 * Strictly parses and validates stored operation idempotency receipt payload.
 */
function parseAndValidateReceipt(rawPayload: string): OperationReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    throw new PlatformError('Corrupted idempotency receipt payload: invalid JSON.', 'DATABASE_CORRUPTED', 500);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PlatformError('Corrupted idempotency receipt payload: expected JSON object.', 'DATABASE_CORRUPTED', 500);
  }

  const record = parsed as Record<string, unknown>;

  // Ensure forbidden properties (promptHash, snapshotId, userId, raw prompt fields) are NEVER present in receipt
  if (
    'promptHash' in record ||
    'snapshotId' in record ||
    'userId' in record ||
    'identity' in record ||
    'soul' in record ||
    'agents' in record ||
    'tools' in record
  ) {
    throw new PlatformError('Idempotency receipt contains forbidden fields.', 'DATABASE_CORRUPTED', 500);
  }

  const { profileId, version } = record;

  if (typeof profileId !== 'string' || !PROFILE_ID_PATTERN.test(profileId)) {
    throw new PlatformError('Idempotent replay record missing valid profileId.', 'DATABASE_CORRUPTED', 500);
  }

  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new PlatformError('Idempotent replay record missing valid version.', 'DATABASE_CORRUPTED', 500);
  }

  // Exact keys check: receipt must only contain 'profileId' and 'version'
  const keys = Object.keys(record);
  for (const k of keys) {
    if (k !== 'profileId' && k !== 'version') {
      throw new PlatformError('Idempotency receipt contains unexpected fields.', 'DATABASE_CORRUPTED', 500);
    }
  }

  return {
    profileId,
    version,
  };
}

/**
 * Deterministically serializes any JSON-compatible value to canonical JSON string
 * with sorted object keys, standard primitive encodings, and no extraneous whitespace.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalJsonStringify(item));
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs: string[] = [];
    for (const key of keys) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined && typeof v !== 'function' && typeof v !== 'symbol') {
        pairs.push(`${JSON.stringify(key)}:${canonicalJsonStringify(v)}`);
      }
    }
    return `{${pairs.join(',')}}`;
  }
  throw new TypeError('Cannot canonically serialize value');
}

/**
 * Constant-time string equality helper.
 */
function secureHashEquals(hashA: string, hashB: string): boolean {
  const bufA = Buffer.from(hashA, 'utf8');
  const bufB = Buffer.from(hashB, 'utf8');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Computes canonical SHA-256 hash (64 lowercase hex characters) over the four prompt sections.
 *
 * Uses deterministic sorted canonical JSON serialization of the 4 sections
 * ({ agents, identity, soul, tools }) to guarantee cross-platform and byte-exact reproducibility.
 *
 * @param sections - The four text sections of the profile.
 * @returns Canonical 64-char lowercase hex SHA-256 hash.
 */
export function computeAgentProfilePromptHash(sections: {
  identity?: string | null;
  soul?: string | null;
  agents?: string | null;
  tools?: string | null;
}): string {
  const canonicalObj = {
    agents: sections.agents ?? '',
    identity: sections.identity ?? '',
    soul: sections.soul ?? '',
    tools: sections.tools ?? '',
  };

  const canonicalJson = canonicalJsonStringify(canonicalObj);
  return crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex').toLowerCase();
}

/**
 * Validates a single prompt section string:
 * 1. Must be normalized in Unicode NFC form.
 * 2. Must not contain forbidden Cc / Cf / Line/Paragraph separator characters (except \t, \n, \r).
 * 3. Must not contain template variable tokens `{{` or `}}`.
 */
export function validateSectionText(sectionName: string, text: string): void {
  void sectionName;
  if (text.length === 0) {
    return;
  }

  // 1. Unicode NFC form check
  if (text.normalize('NFC') !== text) {
    throw new ValidationError('Prompt section must be in Unicode NFC normalized form.');
  }

  // 2. Control, format, and bidi characters check
  if (FORBIDDEN_CONTROL_CHARS_PATTERN.test(text)) {
    throw new ValidationError('Prompt section contains forbidden control or format characters.');
  }

  // 3. Template variable check (any {{ or }} token is rejected)
  if (text.includes('{{') || text.includes('}}') || TEMPLATE_VARIABLE_PATTERN.test(text)) {
    throw new ValidationError('Prompt section contains forbidden template variable token or syntax.');
  }
}

/**
 * Validates all 4 prompt sections and computes the canonical hash.
 * Enforces cumulative 64 KiB (65,536 bytes) limit.
 */
export function validatePromptSections(sections: {
  identity?: string | null;
  soul?: string | null;
  agents?: string | null;
  tools?: string | null;
}): {
  identity: string;
  soul: string;
  agents: string;
  tools: string;
  byteCounts: {
    identity: number;
    soul: number;
    agents: number;
    tools: number;
    total: number;
  };
  promptHash: string;
} {
  const rawIdentity = sections.identity ?? '';
  const rawSoul = sections.soul ?? '';
  const rawAgents = sections.agents ?? '';
  const rawTools = sections.tools ?? '';

  validateSectionText('identity', rawIdentity);
  validateSectionText('soul', rawSoul);
  validateSectionText('agents', rawAgents);
  validateSectionText('tools', rawTools);

  const identity = rawIdentity.normalize('NFC');
  const soul = rawSoul.normalize('NFC');
  const agents = rawAgents.normalize('NFC');
  const tools = rawTools.normalize('NFC');

  const identityBytes = Buffer.byteLength(identity, 'utf8');
  const soulBytes = Buffer.byteLength(soul, 'utf8');
  const agentsBytes = Buffer.byteLength(agents, 'utf8');
  const toolsBytes = Buffer.byteLength(tools, 'utf8');
  const totalBytes = identityBytes + soulBytes + agentsBytes + toolsBytes;

  if (totalBytes > MAX_PROFILE_PROMPT_BYTES) {
    throw new ValidationError(`Total prompt sections size (${totalBytes} bytes) exceeds maximum allowable limit of ${MAX_PROFILE_PROMPT_BYTES} bytes.`);
  }

  const promptHash = computeAgentProfilePromptHash({ identity, soul, agents, tools });
  return {
    identity,
    soul,
    agents,
    tools,
    byteCounts: {
      identity: identityBytes,
      soul: soulBytes,
      agents: agentsBytes,
      tools: toolsBytes,
      total: totalBytes,
    },
    promptHash,
  };
}

/**
 * Injected Agent Profile API Interface
 */
export interface AgentProfileApi {
  listProfiles(
    userId: string,
    options?: { status?: LifecycleStatus; limit?: number; offset?: number }
  ): Promise<AgentProfileListResult>;

  getProfile(
    userId: string,
    profileId: string
  ): Promise<SafeAgentProfileDetail | null>;

  createProfile(
    userId: string,
    input: CreateProfileRequest,
    idempotencyKey?: string
  ): Promise<SafeAgentProfileDetail>;

  archiveProfile(
    userId: string,
    profileId: string
  ): Promise<SafeAgentProfileItem>;

  listVersions(
    userId: string,
    profileId: string
  ): Promise<PublicAgentProfileSnapshot[]>;

  getVersion(
    userId: string,
    profileId: string,
    version: number
  ): Promise<PublicAgentProfileSnapshot | null>;

  createVersion(
    userId: string,
    profileId: string,
    input: CreateProfileVersionRequest,
    idempotencyKey?: string
  ): Promise<PublicAgentProfileSnapshot>;

  rollbackProfileVersion(
    userId: string,
    profileId: string,
    input: RollbackProfileRequest,
    idempotencyKey: string,
    actor?: { id: string; role?: string }
  ): Promise<PublicAgentProfileSnapshot & { newVersion: number }>;

  bindSpaceProfile(
    userId: string,
    spaceId: string,
    input: { profileId: string; version?: number }
  ): Promise<SpaceProfileBindingResult>;

  unbindSpaceProfile(
    userId: string,
    spaceId: string
  ): Promise<SpaceProfileBindingResult>;

  getProfileSnapshotForSession(
    userId: string,
    routeId: string,
    generation: number
  ): Promise<RuntimeAgentProfileSnapshot | null>;

  resolve(
    userId: string,
    sessionRouteId: string,
    generation: number
  ): Promise<RuntimeAgentProfileSnapshot | null>;
}

/**
 * Default implementation of AgentProfileApi using tenant-scoped platform storage.
 */
export class PlatformProfileService implements AgentProfileApi {
  private readonly storage: PlatformStorage;
  private readonly db: DatabaseSync;

  constructor(storage: PlatformStorage, db: DatabaseSync) {
    this.storage = storage;
    this.db = db;
  }

  private computeRequestHash(payload: unknown): string {
    const canonical = canonicalJsonStringify(payload);
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').toLowerCase();
  }

  private checkPersistedIdempotency(
    userId: string,
    scope: string,
    idempotencyKey: string,
    currentRequestHash: string
  ): OperationReceipt | null {
    if (!this.db) {
      throw new PlatformError(
        'Database connection required for idempotency handling.',
        'INTERNAL_ERROR',
        500
      );
    }

    try {
      const stmt = this.db.prepare(`
        SELECT request_hash, response_payload
        FROM operation_idempotency
        WHERE user_id = ? AND scope = ? AND idempotency_key = ?
        LIMIT 1
      `);
      const row = stmt.get(userId, scope, idempotencyKey) as {
        request_hash: string;
        response_payload: string;
      } | undefined;

      if (row) {
        if (row.request_hash === currentRequestHash) {
          return parseAndValidateReceipt(row.response_payload);
        }
        throw new PlatformError(
          'Idempotency key was already used with different request parameters.',
          'CONFLICT',
          409
        );
      }
    } catch (err) {
      if (err instanceof PlatformError) throw err;
      throw new PlatformError(
        'Failed to check operation idempotency.',
        'INTERNAL_ERROR',
        500
      );
    }
    return null;
  }

  private recordPersistedIdempotency(
    userId: string,
    scope: string,
    idempotencyKey: string,
    targetId: string,
    requestHash: string,
    receipt: OperationReceipt
  ): void {
    if (!this.db) {
      throw new PlatformError(
        'Database connection required for idempotency handling.',
        'INTERNAL_ERROR',
        500
      );
    }

    try {
      // Validate receipt structure before recording
      if (
        typeof receipt.profileId !== 'string' ||
        !PROFILE_ID_PATTERN.test(receipt.profileId) ||
        typeof receipt.version !== 'number' ||
        !Number.isSafeInteger(receipt.version) ||
        receipt.version < 1
      ) {
        throw new PlatformError('Invalid receipt structure before recording idempotency.', 'INTERNAL_ERROR', 500);
      }

      const receiptId = `idemp_${crypto.randomUUID().replace(/-/g, '')}`;
      // Canonical, clean receipt payload with exact keys
      const payloadStr = canonicalJsonStringify({
        profileId: receipt.profileId,
        version: receipt.version,
      });

      this.db.prepare(`
        INSERT INTO operation_idempotency (
          id, user_id, scope, idempotency_key, target_id, request_hash, response_payload, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, scope, idempotency_key) DO NOTHING
      `).run(receiptId, userId, scope, idempotencyKey, targetId, requestHash, payloadStr);

      // Verify row invariant after insertion to guard against overwrite races
      const verifyStmt = this.db.prepare(`
        SELECT request_hash, response_payload
        FROM operation_idempotency
        WHERE user_id = ? AND scope = ? AND idempotency_key = ?
        LIMIT 1
      `);
      const existingRow = verifyStmt.get(userId, scope, idempotencyKey) as {
        request_hash: string;
        response_payload: string;
      } | undefined;

      if (!existingRow) {
        throw new PlatformError('Failed to verify persisted idempotency record.', 'INTERNAL_ERROR', 500);
      }
      if (existingRow.request_hash !== requestHash) {
        throw new PlatformError('Idempotency key was already used with different request parameters.', 'CONFLICT', 409);
      }
    } catch (err) {
      if (err instanceof PlatformError) throw err;
      throw new PlatformError(
        'Failed to record operation idempotency.',
        'INTERNAL_ERROR',
        500
      );
    }
  }

  async listProfiles(
    userId: string,
    options?: { status?: LifecycleStatus; limit?: number; offset?: number }
  ): Promise<AgentProfileListResult> {
    const tenant = this.storage.forTenant(userId);
    const profiles = await tenant.agentProfiles.list(options);

    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const items: SafeAgentProfileItem[] = profiles.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      status: p.status,
      activeVersion: p.activeVersion,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));

    return {
      items,
      total: items.length,
      limit,
      offset,
    };
  }

  async getProfile(userId: string, profileId: string): Promise<SafeAgentProfileDetail | null> {
    const tenant = this.storage.forTenant(userId);
    const profileWithSnap = await tenant.agentProfiles.getWithActiveSnapshot(profileId);
    if (!profileWithSnap) {
      return null;
    }

    return {
      id: profileWithSnap.id,
      name: profileWithSnap.name,
      description: profileWithSnap.description,
      status: profileWithSnap.status,
      activeVersion: profileWithSnap.activeVersion,
      createdAt: profileWithSnap.createdAt,
      updatedAt: profileWithSnap.updatedAt,
      snapshot: profileWithSnap.snapshot ? toPublicAgentProfileSnapshot(profileWithSnap.snapshot) : null,
    };
  }

  async createProfile(
    userId: string,
    input: CreateProfileRequest,
    idempotencyKey?: string
  ): Promise<SafeAgentProfileDetail> {
    if (!input.name || typeof input.name !== 'string' || input.name.trim().length === 0) {
      throw new ValidationError('Agent profile name must be a non-empty string.');
    }
    if (input.name.length > 128) {
      throw new ValidationError('Agent profile name must not exceed 128 characters.');
    }

    const validated = validatePromptSections({
      identity: input.identity,
      soul: input.soul,
      agents: input.agents,
      tools: input.tools,
    });

    const payloadToHash = {
      name: input.name.trim(),
      description: input.description ?? null,
      identity: validated.identity,
      soul: validated.soul,
      agents: validated.agents,
      tools: validated.tools,
      changeSummary: input.changeSummary ?? null,
    };

    const currentHash = this.computeRequestHash(payloadToHash);

    if (idempotencyKey) {
      const replay = this.checkPersistedIdempotency(
        userId,
        'create_agent_profile',
        idempotencyKey,
        currentHash
      );
      if (replay) {
        const existing = await this.getProfile(userId, replay.profileId);
        if (!existing) {
          throw new NotFoundError('Agent profile not found.');
        }
        return existing;
      }
    }

    const tenant = this.storage.forTenant(userId);
    const created = await tenant.agentProfiles.create({
      name: input.name.trim(),
      description: input.description ?? null,
      identity: validated.identity,
      soul: validated.soul,
      agents: validated.agents,
      tools: validated.tools,
      changeSummary: input.changeSummary ?? 'Initial version',
      promptMode: 'append',
    });

    const result: SafeAgentProfileDetail = {
      id: created.id,
      name: created.name,
      description: created.description,
      status: created.status,
      activeVersion: created.activeVersion,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      snapshot: created.snapshot ? toPublicAgentProfileSnapshot(created.snapshot) : null,
    };

    // Safe audit logging: records section byte counts and metadata, NEVER raw prompt or hashes, no userId in details
    try {
      if (this.storage.auditLogs?.create) {
        await this.storage.auditLogs.create({
          userId,
          username: `user_${userId}`,
          action: 'user_updated',
          details: {
            subAction: 'create_agent_profile',
            profileId: created.id,
            name: created.name,
            version: created.activeVersion,
            sectionBytes: validated.byteCounts,
            changeSummary: input.changeSummary ?? 'Initial version',
          },
        });
      }
    } catch {
      // Audit log failures should not block core operation
    }

    if (idempotencyKey) {
      this.recordPersistedIdempotency(
        userId,
        'create_agent_profile',
        idempotencyKey,
        created.id,
        currentHash,
        { profileId: created.id, version: created.activeVersion }
      );
    }

    return result;
  }

  async archiveProfile(userId: string, profileId: string): Promise<SafeAgentProfileItem> {
    const tenant = this.storage.forTenant(userId);
    const profile = await tenant.agentProfiles.findById(profileId);
    if (!profile) {
      throw new NotFoundError('Agent profile not found.');
    }

    const updated = await tenant.agentProfiles.update(profileId, {
      status: 'archived',
    });

    // Safe audit logging for archive
    try {
      if (this.storage.auditLogs?.create) {
        await this.storage.auditLogs.create({
          userId,
          username: `user_${userId}`,
          action: 'user_updated',
          details: {
            subAction: 'archive_agent_profile',
            profileId: updated.id,
            name: updated.name,
            status: updated.status,
          },
        });
      }
    } catch {
      // Ignore non-critical audit error
    }

    return {
      id: updated.id,
      name: updated.name,
      description: updated.description,
      status: updated.status,
      activeVersion: updated.activeVersion,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  async listVersions(
    userId: string,
    profileId: string
  ): Promise<PublicAgentProfileSnapshot[]> {
    const tenant = this.storage.forTenant(userId);
    const profile = await tenant.agentProfiles.findById(profileId);
    if (!profile) {
      throw new NotFoundError('Agent profile not found.');
    }

    const snapshots = await tenant.agentProfiles.listSnapshots(profileId);
    return snapshots.map((s) => toPublicAgentProfileSnapshot(s));
  }

  async getVersion(
    userId: string,
    profileId: string,
    version: number
  ): Promise<PublicAgentProfileSnapshot | null> {
    const tenant = this.storage.forTenant(userId);
    const profile = await tenant.agentProfiles.findById(profileId);
    if (!profile) {
      throw new NotFoundError('Agent profile not found.');
    }

    const snapshot = await tenant.agentProfiles.getSnapshot(profileId, version);
    return snapshot ? toPublicAgentProfileSnapshot(snapshot) : null;
  }

  async createVersion(
    userId: string,
    profileId: string,
    input: CreateProfileVersionRequest,
    idempotencyKey?: string
  ): Promise<PublicAgentProfileSnapshot> {
    const tenant = this.storage.forTenant(userId);
    const profile = await tenant.agentProfiles.findById(profileId);
    if (!profile) {
      throw new NotFoundError('Agent profile not found.');
    }

    if (profile.status === 'archived' || profile.status === 'deleted') {
      throw new ValidationError('Cannot modify or bind archived or deleted agent profile.');
    }

    const validated = validatePromptSections({
      identity: input.identity,
      soul: input.soul,
      agents: input.agents,
      tools: input.tools,
    });

    const payloadToHash = {
      profileId,
      identity: validated.identity,
      soul: validated.soul,
      agents: validated.agents,
      tools: validated.tools,
      changeSummary: input.changeSummary ?? null,
    };

    const currentHash = this.computeRequestHash(payloadToHash);

    if (idempotencyKey) {
      const replay = this.checkPersistedIdempotency(
        userId,
        'create_agent_profile_version',
        idempotencyKey,
        currentHash
      );
      if (replay) {
        const existing = await this.getVersion(userId, replay.profileId, replay.version);
        if (!existing) {
          throw new NotFoundError('Agent profile version not found.');
        }
        return existing;
      }
    }

    const snapshot = await tenant.agentProfiles.createVersion(profileId, {
      identity: validated.identity,
      soul: validated.soul,
      agents: validated.agents,
      tools: validated.tools,
      changeSummary: input.changeSummary ?? null,
      promptMode: 'append',
    });

    // Safe audit logging: records byte counts, NEVER raw prompt or hashes, no userId in details
    try {
      if (this.storage.auditLogs?.create) {
        await this.storage.auditLogs.create({
          userId,
          username: `user_${userId}`,
          action: 'user_updated',
          details: {
            subAction: 'create_agent_profile_version',
            profileId,
            version: snapshot.version,
            sectionBytes: validated.byteCounts,
            changeSummary: input.changeSummary ?? null,
          },
        });
      }
    } catch {
      // Ignore non-critical audit failure
    }

    if (idempotencyKey) {
      this.recordPersistedIdempotency(
        userId,
        'create_agent_profile_version',
        idempotencyKey,
        profileId,
        currentHash,
        { profileId, version: snapshot.version }
      );
    }

    return toPublicAgentProfileSnapshot(snapshot);
  }

  async rollbackProfileVersion(
    userId: string,
    profileId: string,
    input: RollbackProfileRequest,
    idempotencyKey: string,
    actor?: { id: string; role?: string }
  ): Promise<PublicAgentProfileSnapshot & { newVersion: number }> {
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
      throw new ValidationError('Missing required Idempotency-Key.');
    }
    if (!input || typeof input.targetVersion !== 'number' || !Number.isSafeInteger(input.targetVersion) || input.targetVersion < 1) {
      throw new ValidationError('Field "targetVersion" must be a positive safe integer.');
    }

    const tenant = this.storage.forTenant(userId);
    const profile = await tenant.agentProfiles.findById(profileId);
    if (!profile) {
      throw new NotFoundError('Agent profile not found.');
    }

    if (profile.status === 'archived' || profile.status === 'deleted') {
      throw new ValidationError('Cannot modify or rollback archived or deleted agent profile.');
    }

    if (input.targetVersion === profile.activeVersion) {
      throw new ValidationError('Cannot rollback to the current active version.');
    }

    const targetSnapshot = await tenant.agentProfiles.getSnapshot(profileId, input.targetVersion);
    if (!targetSnapshot) {
      throw new NotFoundError('Target version does not exist.');
    }

    const payloadToHash = {
      profileId,
      targetVersion: input.targetVersion,
      changeSummary: input.changeSummary ?? null,
    };

    const currentHash = this.computeRequestHash(payloadToHash);

    const replay = this.checkPersistedIdempotency(
      userId,
      'rollback_agent_profile_version',
      idempotencyKey,
      currentHash
    );
    if (replay) {
      const existing = await this.getVersion(userId, replay.profileId, replay.version);
      if (!existing) {
        throw new NotFoundError('Agent profile version not found.');
      }
      return {
        ...existing,
        newVersion: existing.version,
      };
    }

    const snapshot = await tenant.agentProfiles.rollbackVersion(profileId, {
      targetVersion: input.targetVersion,
      changeSummary: input.changeSummary ?? `Rollback to v${input.targetVersion}`,
      actorUserId: actor?.id || userId,
    });

    this.recordPersistedIdempotency(
      userId,
      'rollback_agent_profile_version',
      idempotencyKey,
      profileId,
      currentHash,
      { profileId, version: snapshot.version }
    );

    const publicSnap = toPublicAgentProfileSnapshot(snapshot);
    return {
      ...publicSnap,
      newVersion: publicSnap.version,
    };
  }

  async bindSpaceProfile(
    userId: string,
    spaceId: string,
    input: { profileId: string; version?: number }
  ): Promise<SpaceProfileBindingResult> {
    const tenant = this.storage.forTenant(userId);
    const space = await tenant.spaces.findById(spaceId);
    if (!space) {
      throw new NotFoundError('Space not found.');
    }

    const profile = await tenant.agentProfiles.findById(input.profileId);
    if (!profile) {
      throw new NotFoundError('Agent profile not found.');
    }

    if (profile.status === 'archived' || profile.status === 'deleted') {
      throw new ValidationError('Cannot modify or bind archived or deleted agent profile.');
    }

    let snapshotId: string | null = null;
    let boundVersion: number;

    if (input.version !== undefined) {
      if (!Number.isSafeInteger(input.version) || input.version < 1) {
        throw new ValidationError('Version must be a positive safe integer.');
      }
      const targetSnapshot = await tenant.agentProfiles.getSnapshot(input.profileId, input.version);
      if (!targetSnapshot) {
        throw new NotFoundError('Agent profile version not found.');
      }
      snapshotId = targetSnapshot.id;
      boundVersion = targetSnapshot.version;
    } else {
      const activeSnapshot = await tenant.agentProfiles.getSnapshot(input.profileId, profile.activeVersion);
      if (!activeSnapshot) {
        throw new NotFoundError('Agent profile version not found.');
      }
      snapshotId = activeSnapshot.id;
      boundVersion = profile.activeVersion;
    }

    await tenant.spaces.update(spaceId, {
      agentProfileId: input.profileId,
      agentProfileSnapshotId: snapshotId,
    });

    return {
      spaceId,
      profile: {
        id: profile.id,
        name: profile.name,
        version: boundVersion,
      },
    };
  }

  async unbindSpaceProfile(userId: string, spaceId: string): Promise<SpaceProfileBindingResult> {
    const tenant = this.storage.forTenant(userId);
    const space = await tenant.spaces.findById(spaceId);
    if (!space) {
      throw new NotFoundError('Space not found.');
    }

    await tenant.spaces.update(spaceId, {
      agentProfileId: null,
      agentProfileSnapshotId: null,
    });

    return {
      spaceId,
      profile: null,
    };
  }

  async resolve(
    userId: string,
    sessionRouteId: string,
    generation: number
  ): Promise<RuntimeAgentProfileSnapshot | null> {
    return this.getProfileSnapshotForSession(userId, sessionRouteId, generation);
  }

  async getProfileSnapshotForSession(
    userId: string,
    routeId: string,
    generation: number
  ): Promise<RuntimeAgentProfileSnapshot | null> {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new ValidationError('Generation must be a positive safe integer.');
    }

    const tenant = this.storage.forTenant(userId);

    const stmt = this.db.prepare(`
      SELECT agent_profile_snapshot_id
      FROM session_generations
      WHERE user_id = ? AND route_id = ? AND generation_number = ?
      LIMIT 1
    `);
    const genRow = stmt.get(userId, routeId, generation) as {
      agent_profile_snapshot_id: string | null;
    } | undefined;

    if (!genRow) {
      throw new PlatformError(
        'Session generation record not found.',
        'FAIL_CLOSED',
        500
      );
    }

    if (genRow.agent_profile_snapshot_id === null) {
      return null;
    }

    const snapshot = await tenant.agentProfiles.getSnapshotById(genRow.agent_profile_snapshot_id);
    if (!snapshot) {
      throw new PlatformError(
        'Bound agent profile snapshot not found.',
        'FAIL_CLOSED',
        500
      );
    }

    // Integrity: ensure snapshot.id equals requested and snapshot.userId equals scoped userId
    if (snapshot.id !== genRow.agent_profile_snapshot_id || snapshot.userId !== userId) {
      throw new PlatformError(
        'Bound agent profile snapshot integrity check failed.',
        'FAIL_CLOSED',
        500
      );
    }

    // profileId/version regex/safe validate before runtime
    if (typeof snapshot.profileId !== 'string' || !PROFILE_ID_PATTERN.test(snapshot.profileId)) {
      throw new PlatformError(
        'Bound agent profile snapshot contains invalid profile ID.',
        'FAIL_CLOSED',
        500
      );
    }

    if (typeof snapshot.version !== 'number' || !Number.isSafeInteger(snapshot.version) || snapshot.version < 1) {
      throw new PlatformError(
        'Bound agent profile snapshot contains invalid version.',
        'FAIL_CLOSED',
        500
      );
    }

    // Snapshot profile relationship check (works for active and archived profiles)
    const profileStmt = this.db.prepare(`
      SELECT id FROM agent_profiles WHERE id = ? AND user_id = ? LIMIT 1
    `);
    const profRow = profileStmt.get(snapshot.profileId, userId);
    if (!profRow) {
      throw new PlatformError(
        'Profile associated with snapshot not found.',
        'FAIL_CLOSED',
        500
      );
    }

    // Mandatory stored promptHash validation
    if (typeof snapshot.promptHash !== 'string' || !PROMPT_HASH_PATTERN.test(snapshot.promptHash)) {
      throw new PlatformError(
        'Stored prompt hash is missing or invalid.',
        'FAIL_CLOSED',
        500
      );
    }

    let validated: ReturnType<typeof validatePromptSections>;
    try {
      validated = validatePromptSections({
        identity: snapshot.identity,
        soul: snapshot.soul,
        agents: snapshot.agents,
        tools: snapshot.tools,
      });
    } catch (validationError) {
      if (validationError instanceof PlatformError && validationError.code === 'FAIL_CLOSED') {
        throw validationError;
      }
      throw new PlatformError(
        'Agent profile snapshot failed validation.',
        'FAIL_CLOSED',
        500
      );
    }

    if (!secureHashEquals(snapshot.promptHash, validated.promptHash)) {
      throw new PlatformError(
        'Stored prompt hash does not match recomputed hash.',
        'FAIL_CLOSED',
        500
      );
    }

    return {
      profileId: snapshot.profileId,
      version: snapshot.version,
      promptHash: validated.promptHash,
      identity: validated.identity,
      soul: validated.soul,
      agents: validated.agents,
      tools: validated.tools,
    };
  }
}

/**
 * Factory to create PlatformProfileService instance.
 */
export function createProfileService(storage: PlatformStorage, db: DatabaseSync): AgentProfileApi {
  return new PlatformProfileService(storage, db);
}
