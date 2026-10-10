/**
 * Daemon Active Background Tasks Journal
 *
 * Tracks in-flight background workflows and subagents persistently under
 * `$DSH_HOME/daemon-active-tasks/<taskId>.json` with mode 0o600, fsync, and atomic write.
 * Upon clean completion or explicit cancellation/stop, records are unlinked.
 * If the runtime crashes or is abruptly killed, leftover records are recovered
 * upon next startup to notify the parent session once.
 *
 * @module @enkeep/runtime-runner/runtime/daemon-active-task-journal
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface ActiveBackgroundTaskRecord {
  readonly taskId: string;
  readonly kind: 'subagent' | 'workflow' | 'job';
  readonly name: string;
  readonly parentSessionId: string;
  readonly originTurnId?: string;
  readonly startedAt?: string;
}

export class DaemonActiveTaskJournal {
  private readonly activeTasksDir: string;
  private readonly memoryCache = new Map<string, ActiveBackgroundTaskRecord>();

  constructor(readonly dshHome: string) {
    this.activeTasksDir = path.join(dshHome, 'daemon-active-tasks');
    this.ensureDirectory();
    this.loadExistingRecords();
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(this.activeTasksDir)) {
      try {
        fs.mkdirSync(this.activeTasksDir, { recursive: true, mode: 0o700 });
      } catch {}
    }
    try {
      fs.chmodSync(this.activeTasksDir, 0o700);
    } catch {}
  }

  private getRecordPath(taskId: string): string {
    const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const resolved = path.join(this.activeTasksDir, `${safeTaskId}.json`);
    if (path.dirname(resolved) !== path.normalize(this.activeTasksDir)) {
      throw new Error(`Security violation: path traversal detected for taskId "${taskId}"`);
    }
    return resolved;
  }

  private loadExistingRecords(): void {
    try {
      if (!fs.existsSync(this.activeTasksDir)) return;
      const files = fs.readdirSync(this.activeTasksDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(this.activeTasksDir, file);
          try {
            const raw = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw) as ActiveBackgroundTaskRecord;
            if (parsed && typeof parsed.taskId === 'string') {
              this.memoryCache.set(parsed.taskId, parsed);
            }
          } catch {}
        }
      }
    } catch {}
  }

  public recordActive(record: ActiveBackgroundTaskRecord): void {
    this.memoryCache.set(record.taskId, record);
    const safeTaskId = record.taskId.replace(/[^a-zA-Z0-9_-]/g, '_');

    try {
      this.ensureDirectory();
      const finalPath = this.getRecordPath(record.taskId);
      const tmpPath = path.join(
        this.activeTasksDir,
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
          const dirFd = fs.openSync(this.activeTasksDir, fs.constants.O_RDONLY);
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

  public removeActive(taskId: string): void {
    this.memoryCache.delete(taskId);
    try {
      const filePath = this.getRecordPath(taskId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        try {
          const dirFd = fs.openSync(this.activeTasksDir, fs.constants.O_RDONLY);
          fs.fsyncSync(dirFd);
          fs.closeSync(dirFd);
        } catch {}
      }
    } catch {}
  }

  public listRemainingRecords(): ActiveBackgroundTaskRecord[] {
    const records: ActiveBackgroundTaskRecord[] = [];
    try {
      if (!fs.existsSync(this.activeTasksDir)) return records;
      const files = fs.readdirSync(this.activeTasksDir);
      for (const file of files) {
        if (file.endsWith('.tmp')) {
          try {
            fs.unlinkSync(path.join(this.activeTasksDir, file));
          } catch {}
          continue;
        }
        if (file.endsWith('.json')) {
          const filePath = path.join(this.activeTasksDir, file);
          try {
            const raw = fs.readFileSync(filePath, 'utf8');
            const record = JSON.parse(raw) as ActiveBackgroundTaskRecord;
            if (record && typeof record.taskId === 'string') {
              records.push(record);
            }
          } catch {}
        }
      }
    } catch {}
    return records;
  }
}
