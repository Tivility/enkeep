/**
 * Quiesce Protocol & FreezeHooks Adapter
 *
 * Enforces transactional consistency for SQLite databases and active Docker volumes.
 * Prevents dirty snapshots caused by reading live Docker container volumes while in-flight
 * writes are occurring.
 *
 * @module @enkeep/backup-restore/quiesce/quiesce
 */

import { existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { BackupQuiesceError } from '../errors.js';
import type { FreezeHooks } from '../types.js';

export interface RunningProcessInfo {
  readonly name: string;
  readonly pid: number;
  readonly pidFile: string;
}

/**
 * Checks for running processes recorded in the dataRoot/pids directory.
 */
export function detectActiveProcesses(dataRoot: string): RunningProcessInfo[] {
  const pidsDir = join(dataRoot, 'pids');
  if (!existsSync(pidsDir)) return [];

  const active: RunningProcessInfo[] = [];

  try {
    const entries = readdirSync(pidsDir);
    for (const entry of entries) {
      if (!entry.endsWith('.pid') && !entry.endsWith('.json')) continue;
      const pidFile = join(pidsDir, entry);
      const stat = lstatSync(pidFile);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;

      try {
        const raw = readFileSync(pidFile, 'utf8').trim();
        let pid: number | null = null;

        if (raw.startsWith('{')) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.pid === 'number') {
            pid = parsed.pid;
          }
        } else {
          const parsedNum = parseInt(raw, 10);
          if (!isNaN(parsedNum) && parsedNum > 0) {
            pid = parsedNum;
          }
        }

        if (pid !== null) {
          // Probe if process is alive
          try {
            process.kill(pid, 0); // signal 0 tests existence without sending signal
            active.push({
              name: entry.replace(/\.(pid|json)$/, ''),
              pid,
              pidFile,
            });
          } catch (_err) {
            // Process is dead (stale PID file)
          }
        }
      } catch {
        // Ignore unreadable pid file
      }
    }
  } catch {
    // Ignore readdir failure
  }

  return active;
}

export interface QuiesceCheckOptions {
  readonly dataRoot: string;
  readonly demoStopConfirmed?: boolean;
  readonly freezeHooks?: FreezeHooks;
}

/**
 * Validates the quiescence state of the target data root before creating a snapshot.
 *
 * If active processes are detected and neither --demo-stop-confirmed nor freezeHooks
 * are provided, throws BackupQuiesceError to protect snapshot consistency.
 */
export async function assertQuiescentEnvironment(options: QuiesceCheckOptions): Promise<void> {
  const { dataRoot, demoStopConfirmed, freezeHooks } = options;

  const activeProcesses = detectActiveProcesses(dataRoot);

  if (activeProcesses.length > 0) {
    if (!demoStopConfirmed && !freezeHooks) {
      const procList = activeProcesses.map((p) => `${p.name} (PID ${p.pid})`).join(', ');
      throw new BackupQuiesceError(
        `Cannot create consistent backup from active environment: Detected active running process(es): ${procList}. ` +
          `Active containers or servers may mutate SQLite and DSH session volumes during backup. ` +
          `Stop the environment gracefully first, or provide --demo-stop-confirmed / FreezeHooks to confirm quiescence.`
      );
    }
  }

  // Execute pre-freeze hook if configured
  if (freezeHooks?.beforeFreeze) {
    try {
      await freezeHooks.beforeFreeze();
    } catch (err) {
      throw new BackupQuiesceError(
        `FreezeHooks.beforeFreeze failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/**
 * Releases quiescence state after snapshot completes or fails.
 */
export async function releaseQuiescence(
  freezeHooks?: FreezeHooks,
  error?: unknown
): Promise<void> {
  if (!freezeHooks) return;

  if (error) {
    if (freezeHooks.onAbort) {
      try {
        await freezeHooks.onAbort(error);
      } catch (_err) {
        // Suppress secondary abort errors
      }
    }
  } else {
    if (freezeHooks.afterFreeze) {
      try {
        await freezeHooks.afterFreeze();
      } catch (_err) {
        // Suppress release errors
      }
    }
  }
}
