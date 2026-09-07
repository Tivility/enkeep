import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  PlatformError,
  ForbiddenError,
  ValidationError,
} from '@enkeep/platform-core';
import type { PlatformOperationsService } from '@enkeep/platform-operations';

export interface VolumeScanResult {
  readonly userId: string;
  readonly volumePath: string;
  readonly totalBytes: number;
  readonly fileCount: number;
  readonly scannedAt: string;
}

export interface VolumeScanServiceOptions {
  readonly db?: DatabaseSync;
  readonly operations?: PlatformOperationsService | any;
}

/**
 * Validates user ID format strictly.
 */
function validateUserId(userId: unknown): string {
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 128 || userId !== userId.trim()) {
    throw new ValidationError('Invalid userId format');
  }
  return userId;
}

/**
 * Storage Baseline Volume Scan Service
 *
 * Recursively scans tenant storage volumes to establish ground-truth storage_bytes baseline.
 * Enforces strict fail-closed security:
 * - Rejects symlinks immediately with FORBIDDEN / SECURITY_VIOLATION.
 * - Rejects special files (FIFOs, sockets, character/block devices) immediately.
 * - Sets authoritative storage_bytes quota usage baseline.
 * - Records audit log with safe metadata (no sensitive path leaks).
 */
export class VolumeScanService {
  private readonly db?: DatabaseSync;
  private readonly operations?: PlatformOperationsService | any;

  constructor(options: VolumeScanServiceOptions = {}) {
    this.db = options.db;
    this.operations = options.operations;
  }

  /**
   * Scans a volume directory and calculates total regular file byte size.
   * Fails closed if any symlink or special file is encountered.
   */
  async scanTenantVolumeBaseline(
    userId: string,
    volumePath: string,
    options: { setBaseline?: boolean } = {}
  ): Promise<VolumeScanResult> {
    const cleanUserId = validateUserId(userId);

    if (!volumePath || typeof volumePath !== 'string' || !volumePath.trim()) {
      throw new ValidationError('volumePath must be a non-empty string');
    }

    if (!fs.existsSync(volumePath)) {
      throw new PlatformError('Volume path does not exist', 'NOT_FOUND', 404);
    }

    const rootStat = fs.lstatSync(volumePath);
    if (rootStat.isSymbolicLink()) {
      throw new ForbiddenError('Volume root directory cannot be a symbolic link');
    }
    if (!rootStat.isDirectory()) {
      throw new PlatformError('Volume path must be a directory', 'INVALID_REQUEST', 400);
    }

    let totalBytes = 0;
    let fileCount = 0;

    const walk = (dir: string): void => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const stat = fs.lstatSync(fullPath);

        // Security Invariant: Fail closed on symlinks
        if (stat.isSymbolicLink() || entry.isSymbolicLink()) {
          throw new ForbiddenError('Symbolic links are strictly forbidden in volume storage');
        }

        if (stat.isDirectory()) {
          walk(fullPath);
        } else if (stat.isFile()) {
          totalBytes += stat.size;
          fileCount++;
        } else {
          // Special file (FIFO, socket, block/char device)
          throw new ForbiddenError('Special files (FIFO/socket/device) are strictly forbidden in volume storage');
        }
      }
    };

    walk(volumePath);

    const scannedAt = new Date().toISOString();

    // Set baseline in quota ledger if requested / operations available
    if (options.setBaseline !== false && this.operations?.forTenant) {
      const tenantQuota = this.operations.forTenant(cleanUserId).quota;
      if (tenantQuota?.setBaselineUsage) {
        await tenantQuota.setBaselineUsage('storage_bytes', totalBytes);
      } else if (tenantQuota?.adjustUsage) {
        await tenantQuota.adjustUsage({ resource: 'storage_bytes', delta: totalBytes });
      }
    }

    // Record audit log without sensitive absolute path leak
    if (this.db) {
      try {
        const auditId = `aud_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        const detailsStr = JSON.stringify({
          resource: 'storage_bytes',
          baselineBytes: totalBytes,
          fileCount,
        });
        this.db.prepare(`
          INSERT INTO auth_audit_log (id, user_id, username, action, details, created_at)
          VALUES (?, ?, ?, 'storage_reconciled', ?, CURRENT_TIMESTAMP)
        `).run(auditId, cleanUserId, cleanUserId, detailsStr);
      } catch {
        // Ignore audit log insertion errors
      }
    }

    return {
      userId: cleanUserId,
      volumePath,
      totalBytes,
      fileCount,
      scannedAt,
    };
  }
}
