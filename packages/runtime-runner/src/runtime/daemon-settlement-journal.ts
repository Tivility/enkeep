/**
 * Daemon Settlement Notification Journal
 *
 * Records persistently notified abnormal background tasks (failed / cancelled)
 * under `$DSH_HOME/daemon-settlements/<taskId>.json` with mode 0o600, fsync, and atomic write.
 * Prevents duplicate abnormal settlement notification dispatches across process restarts.
 *
 * @module @enkeep/runtime-runner/runtime/daemon-settlement-journal
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface SettlementNotificationRecord {
  readonly taskId: string;
  readonly parentSessionId: string;
  readonly kind: 'subagent' | 'workflow' | 'job';
  readonly status: 'failed' | 'cancelled';
  readonly reason: string;
  readonly originTurnId?: string;
  readonly notifiedAt: string;
}

export class DaemonSettlementJournal {
  private readonly settlementsDir: string;
  private readonly memoryCache = new Set<string>();

  constructor(readonly dshHome: string) {
    this.settlementsDir = path.join(dshHome, 'daemon-settlements');
    this.ensureDirectory();
    this.loadExistingIds();
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(this.settlementsDir)) {
      try {
        fs.mkdirSync(this.settlementsDir, { recursive: true, mode: 0o700 });
      } catch {}
    }
    try {
      fs.chmodSync(this.settlementsDir, 0o700);
    } catch {}
  }

  private getRecordPath(taskId: string): string {
    const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const resolved = path.join(this.settlementsDir, `${safeTaskId}.json`);
    if (path.dirname(resolved) !== path.normalize(this.settlementsDir)) {
      throw new Error(`Security violation: path traversal detected for taskId "${taskId}"`);
    }
    return resolved;
  }

  private loadExistingIds(): void {
    try {
      if (!fs.existsSync(this.settlementsDir)) return;
      const files = fs.readdirSync(this.settlementsDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const taskId = file.slice(0, -5);
          this.memoryCache.add(taskId);
        }
      }
    } catch {}
  }

  public isNotified(taskId: string): boolean {
    if (this.memoryCache.has(taskId)) {
      return true;
    }
    const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (this.memoryCache.has(safeTaskId)) {
      return true;
    }
    try {
      const filePath = this.getRecordPath(taskId);
      if (fs.existsSync(filePath)) {
        this.memoryCache.add(taskId);
        return true;
      }
    } catch {}
    return false;
  }

  public recordNotified(record: SettlementNotificationRecord): void {
    this.memoryCache.add(record.taskId);
    const safeTaskId = record.taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    this.memoryCache.add(safeTaskId);

    try {
      this.ensureDirectory();
      const finalPath = this.getRecordPath(record.taskId);
      const tmpPath = path.join(
        this.settlementsDir,
        `${safeTaskId}.${crypto.randomBytes(8).toString('hex')}.tmp`
      );

      const jsonContent = JSON.stringify(record, null, 2);
      let fd: number | null = null;
      try {
        fd = fs.openSync(
          tmpPath,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            (fs.constants.O_NOFOLLOW ?? 0),
          0o600
        );
        const buf = Buffer.from(jsonContent, 'utf8');
        let written = 0;
        while (written < buf.length) {
          written += fs.writeSync(fd, buf, written, buf.length - written, written);
        }
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;

        fs.chmodSync(tmpPath, 0o600);
        fs.renameSync(tmpPath, finalPath);

        // Best effort directory fsync
        try {
          const dirFd = fs.openSync(this.settlementsDir, fs.constants.O_RDONLY);
          fs.fsyncSync(dirFd);
          fs.closeSync(dirFd);
        } catch {}
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {}
        }
        if (fs.existsSync(tmpPath)) {
          try {
            fs.unlinkSync(tmpPath);
          } catch {}
        }
      }
    } catch {
      // Fail open in memory cache even if disk write has transient failure
    }
  }
}
