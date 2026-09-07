import type { DatabaseSync } from 'node:sqlite';
import type {
  PlatformStorage,
  SpaceMount,
  PublicSpaceMount,
  SpaceMountDto,
  SpaceMountMode,
  RuntimeMountReconciler,
  RuntimeMountSpec,
  RuntimeMountResolver,
  CredentialCipherPort,
} from '@enkeep/platform-core';
import {
  PlatformError,
  NotFoundError,
  ValidationError,
  ForbiddenError,
  ConflictError,
  validateMountName,
  validateMountMode,
  computeMountSourceFingerprint,
} from '@enkeep/platform-core';
import { AesGcmCredentialCipher } from '../notifications/credential-cipher.js';

export interface SpaceMountServiceOptions {
  readonly db: DatabaseSync;
  readonly storage: PlatformStorage;
  readonly cipherSecret: string;
  readonly platformSecret?: string;
  readonly cipher?: CredentialCipherPort;
  readonly reconciler?: RuntimeMountReconciler;
}

export class SpaceMountService implements RuntimeMountResolver {
  private readonly db: DatabaseSync;
  private readonly storage: PlatformStorage;
  private readonly cipher: CredentialCipherPort;
  private readonly platformSecret: string;
  private readonly reconciler?: RuntimeMountReconciler;

  constructor(options: SpaceMountServiceOptions) {
    this.db = options.db;
    this.storage = options.storage;
    this.platformSecret = options.platformSecret || options.cipherSecret;
    this.cipher = options.cipher || new AesGcmCredentialCipher(options.cipherSecret);
    this.reconciler = options.reconciler;
  }

  getReconciler(): RuntimeMountReconciler | undefined {
    return this.reconciler;
  }

  /**
   * Resolves and decrypts exact active mounts for a given user and space.
   * Returns authoritative id, name, sourcePath, and mode.
   * Strictly never logs decrypted source paths.
   */
  async resolveForSpace(userId: string, platformSpaceId: string): Promise<readonly RuntimeMountSpec[]> {
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      throw new ValidationError('userId is required for resolveForSpace');
    }
    if (!platformSpaceId || typeof platformSpaceId !== 'string' || platformSpaceId.trim().length === 0) {
      throw new ValidationError('platformSpaceId is required for resolveForSpace');
    }

    const space = await this.storage.forTenant(userId).spaces.findById(platformSpaceId);
    if (!space) {
      throw new NotFoundError(`Space "${platformSpaceId}" not found`);
    }

    const mounts = await this.storage.forTenant(userId).spaceMounts.listBySpace(platformSpaceId);
    const resolved: RuntimeMountSpec[] = [];

    for (const m of mounts) {
      const sourcePath = await Promise.resolve(this.cipher.decrypt(m.sourcePathEncrypted));
      resolved.push(
        Object.freeze({
          id: m.id,
          name: m.name,
          sourcePath,
          mode: m.mode,
        })
      );
    }

    return Object.freeze(resolved);
  }

  /**
   * Lists all mounts for a space with just-in-time decrypted source paths.
   */
  async listMounts(userId: string, spaceId: string): Promise<PublicSpaceMount[]> {
    const space = await this.storage.forTenant(userId).spaces.findById(spaceId);
    if (!space) {
      throw new NotFoundError(`Space "${spaceId}" not found`);
    }

    const mounts = await this.storage.forTenant(userId).spaceMounts.listBySpace(spaceId);
    const dtos: PublicSpaceMount[] = [];

    for (const m of mounts) {
      let sourcePath: string;
      try {
        sourcePath = await Promise.resolve(this.cipher.decrypt(m.sourcePathEncrypted));
      } catch {
        sourcePath = '<decryption_failed>';
      }

      dtos.push({
        id: m.id,
        name: m.name,
        sourcePath,
        mode: m.mode,
        createdAt: m.createdAt,
      });
    }

    return dtos;
  }

  /**
   * Helper to build mounts map grouped by spaceId for a user and mode.
   */
  private async buildUserMountsBySpace(
    userId: string,
    targetMode: 'host' | 'container'
  ): Promise<Record<string, RuntimeMountSpec[]>> {
    const spaces = await this.storage.forTenant(userId).spaces.list();
    const modeSpaceIds = new Set(
      spaces
        .filter((s) => (s.executionMode || 'container') === targetMode)
        .map((s) => s.id)
    );

    const allMounts = await this.storage.forTenant(userId).spaceMounts.listAllForUser();
    const mountsBySpace: Record<string, RuntimeMountSpec[]> = {};

    for (const m of allMounts) {
      if (!modeSpaceIds.has(m.spaceId)) {
        continue;
      }
      let sourcePath: string;
      try {
        sourcePath = await Promise.resolve(this.cipher.decrypt(m.sourcePathEncrypted));
      } catch {
        continue;
      }

      if (!mountsBySpace[m.spaceId]) {
        mountsBySpace[m.spaceId] = [];
      }
      mountsBySpace[m.spaceId].push({
        id: m.id,
        name: m.name,
        sourcePath,
        mode: m.mode,
      });
    }

    return mountsBySpace;
  }

  /**
   * Creates a new space mount following the strict Saga pattern:
   * preflight (runtime authority) -> encrypt & insert -> runtime reconcile -> rollback on failure -> audit log.
   */
  async createMount(
    userId: string,
    spaceId: string,
    input: { name: string; sourcePath: string; mode: SpaceMountMode },
    auditContext?: { username?: string; ipAddress?: string; userAgent?: string }
  ): Promise<PublicSpaceMount> {
    const space = await this.storage.forTenant(userId).spaces.findById(spaceId);
    if (!space) {
      throw new NotFoundError(`Space "${spaceId}" not found`);
    }

    const executionMode = (space.executionMode || 'container') as 'host' | 'container';
    const name = validateMountName(input.name);
    const mode = validateMountMode(input.mode);

    if (typeof input.sourcePath !== 'string' || !input.sourcePath.trim()) {
      throw new ValidationError('Field "sourcePath" must be a non-empty string');
    }

    const rawSourcePath = input.sourcePath.trim();

    // Check duplicate name in space
    const existing = await this.storage.forTenant(userId).spaceMounts.findByName(spaceId, name);
    if (existing) {
      throw new ConflictError(`Mount name "${name}" already exists in space "${spaceId}"`);
    }

    // 1. Runtime preflight (Runtime is the sole authority for mount source validation)
    if (!this.reconciler) {
      throw new PlatformError(
        'Runtime mount reconciler is not configured',
        'SERVICE_UNAVAILABLE',
        503
      );
    }

    try {
      await this.reconciler.preflightSource(rawSourcePath);
    } catch (err: unknown) {
      if (err instanceof ForbiddenError || err instanceof ValidationError || err instanceof PlatformError) {
        throw err;
      }
      throw new ValidationError('Mount source path preflight validation failed');
    }

    // 2. Encrypt sourcePath & compute HMAC fingerprint
    const encryptedPath = await Promise.resolve(this.cipher.encrypt(rawSourcePath));
    const fingerprint = computeMountSourceFingerprint(rawSourcePath, this.platformSecret);

    // 3. DB insert transaction
    const created = await this.storage.forTenant(userId).spaceMounts.create({
      spaceId,
      name,
      sourcePathEncrypted: encryptedPath,
      sourceFingerprint: fingerprint,
      mode,
    });

    // 4. Reconcile full user + mode set
    try {
      const fullMounts = await this.buildUserMountsBySpace(userId, executionMode);
      await this.reconciler.reconcileUserMounts(userId, executionMode, fullMounts);
    } catch {
      // SAGA ROLLBACK: delete inserted row & best-effort restore old runtime state
      try {
        await this.storage.forTenant(userId).spaceMounts.delete(created.id);
        const rollbackMounts = await this.buildUserMountsBySpace(userId, executionMode);
        await this.reconciler.reconcileUserMounts(userId, executionMode, rollbackMounts);
      } catch {
        // best-effort cleanup
      }

      throw new PlatformError(
        'Failed to reconcile runtime mounts after adding mount',
        'RUNTIME_RECONCILE_FAILED',
        500
      );
    }

    // 5. Audit log (strictly mount id/name/mode/fingerprint only; NEVER path/ciphertext)
    if (this.storage.auditLogs && typeof this.storage.auditLogs.create === 'function') {
      try {
        await this.storage.auditLogs.create({
          userId,
          username: auditContext?.username ?? null,
          action: 'space_mount.created',
          ipAddress: auditContext?.ipAddress ?? null,
          userAgent: auditContext?.userAgent ?? null,
          details: {
            mountId: created.id,
            name: created.name,
            mode: created.mode,
            fingerprint: created.sourceFingerprint,
          },
        });
      } catch {
        // ignore audit logging error
      }
    }

    return {
      id: created.id,
      name: created.name,
      sourcePath: rawSourcePath,
      mode: created.mode,
      createdAt: created.createdAt,
    };
  }

  /**
   * Deletes a space mount following the strict Saga pattern:
   * capture row -> delete from DB -> runtime reconcile -> rollback on failure -> audit log.
   */
  async deleteMount(
    userId: string,
    spaceId: string,
    mountId: string,
    auditContext?: { username?: string; ipAddress?: string; userAgent?: string }
  ): Promise<{ deleted: boolean; id: string }> {
    const space = await this.storage.forTenant(userId).spaces.findById(spaceId);
    if (!space) {
      throw new NotFoundError(`Space "${spaceId}" not found`);
    }

    const executionMode = (space.executionMode || 'container') as 'host' | 'container';
    const existing = await this.storage.forTenant(userId).spaceMounts.findById(mountId);
    if (!existing || existing.spaceId !== spaceId) {
      throw new NotFoundError(`Space mount "${mountId}" not found in space "${spaceId}"`);
    }

    // 1. Capture exact row before deletion for saga rollback
    const capturedRow: SpaceMount = { ...existing };

    // 2. Delete from DB
    await this.storage.forTenant(userId).spaceMounts.delete(mountId);

    // 3. Reconcile full remaining user + mode set
    if (!this.reconciler) {
      throw new PlatformError(
        'Runtime mount reconciler is not configured',
        'SERVICE_UNAVAILABLE',
        503
      );
    }

    try {
      const remainingMounts = await this.buildUserMountsBySpace(userId, executionMode);
      await this.reconciler.reconcileUserMounts(userId, executionMode, remainingMounts);
    } catch {
      // SAGA ROLLBACK: restore exact row & re-reconcile
      try {
        await this.storage.forTenant(userId).spaceMounts.restore(capturedRow);
        const rollbackMounts = await this.buildUserMountsBySpace(userId, executionMode);
        await this.reconciler.reconcileUserMounts(userId, executionMode, rollbackMounts);
      } catch {
        // best-effort restore
      }

      throw new PlatformError(
        'Failed to reconcile runtime mounts after deleting mount',
        'RUNTIME_RECONCILE_FAILED',
        500
      );
    }

    // 4. Audit log (strictly mount id/name/mode/fingerprint only; NEVER path/ciphertext)
    if (this.storage.auditLogs && typeof this.storage.auditLogs.create === 'function') {
      try {
        await this.storage.auditLogs.create({
          userId,
          username: auditContext?.username ?? null,
          action: 'space_mount.deleted',
          ipAddress: auditContext?.ipAddress ?? null,
          userAgent: auditContext?.userAgent ?? null,
          details: {
            mountId: capturedRow.id,
            name: capturedRow.name,
            mode: capturedRow.mode,
            fingerprint: capturedRow.sourceFingerprint,
          },
        });
      } catch {
        // ignore audit logging error
      }
    }

    return { deleted: true, id: mountId };
  }

  /**
   * Startup composition helper:
   * Reconciles all active mounts across all users before accepting requests.
   * If existing rows in space_mounts and missing reconciler, fails closed!
   */
  async reconcileAllActiveMountsOnStartup(): Promise<void> {
    const rowCount = (
      this.db.prepare('SELECT COUNT(*) as count FROM space_mounts').get() as { count: number } | undefined
    )?.count ?? 0;

    if (rowCount === 0) {
      return;
    }

    if (!this.reconciler) {
      throw new PlatformError(
        `FAIL-CLOSED: Database contains ${rowCount} space mount(s), but no RuntimeMountReconciler is configured on PlatformServer.`,
        'CONFIGURATION_ERROR',
        500
      );
    }

    // Group active mounts by user and executionMode
    const userRows = this.db
      .prepare(
        `SELECT DISTINCT sm.user_id, COALESCE(s.execution_mode, 'container') as execution_mode
         FROM space_mounts sm
         LEFT JOIN spaces s ON sm.space_id = s.id`
      )
      .all() as Array<{ user_id: string; execution_mode: string }>;

    for (const row of userRows) {
      const mode = (row.execution_mode || 'container') as 'host' | 'container';
      const mountsBySpace = await this.buildUserMountsBySpace(row.user_id, mode);
      await this.reconciler.reconcileUserMounts(row.user_id, mode, mountsBySpace);
    }
  }
}
