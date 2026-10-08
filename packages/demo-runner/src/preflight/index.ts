/**
 * Enkeep Deploy Preflight Quiescence Verifier
 *
 * Aggregates:
 * 1. Platform activity from SQLite platform.db:
 *    - Running/queued turns (turn_runs, turn_execution_queue)
 *    - Claimed/running tasks and active leases (task_runs, session_execution_leases)
 *    - Non-terminal journals (file_transfer_journal, attachment_snapshot_journal, daemon-turns)
 *    - Scheduled tasks due within N minutes
 * 2. Runtime activity from every resident Host RuntimeDaemon (via UDS RPC activityStatus)
 * 3. Runtime activity from every running Docker container daemon (via in-container bridge RPC)
 *
 * Prints a concise summary and returns non-zero when not idle.
 *
 * @module @enkeep/demo-runner/preflight
 */

import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { isProcessAlive, type DaemonActivityStatus } from '@enkeep/runtime-runner';
import { getDemoPathConfig } from '../config.js';

export interface PreflightOptions {
  /** Explicit platform data root containing platform.db, host-runtimes, containers (or env ENKEEP_DATA_DIR) */
  dataDir?: string;
  /** Explicit repository root path (default: auto-detected) */
  repoRoot?: string;
  /** Fixed platform port for health checking (or env ENKEEP_PLATFORM_PORT) */
  port?: number;
  /** Lookahead window in minutes for due scheduled tasks (default: 10, or env ENKEEP_PREFLIGHT_DUE_MINUTES) */
  dueWithinMinutes?: number;
  /** UDS socket / container probe timeout in ms (default: 3000ms) */
  timeoutMs?: number;
}

export interface PlatformPreflightActivity {
  runningQueuedTurns: number;
  claimedTaskRuns: number;
  nonTerminalJournals: number;
  tasksDueWithinNMinutes: number;
  isIdle: boolean;
  details?: Record<string, unknown>;
}

export interface RuntimePreflightActivity {
  runtimeType: 'host' | 'container';
  identifier: string;
  pid?: number;
  containerId?: string;
  socketPath?: string;
  isIdle: boolean;
  activity?: DaemonActivityStatus;
  error?: string;
}

export interface PreflightResult {
  ok: boolean;
  isIdle: boolean;
  timestamp: string;
  dataDir: string;
  platform: PlatformPreflightActivity;
  runtimes: RuntimePreflightActivity[];
  issues: string[];
  summary: string;
}

/**
 * Connects to a resident Host Runtime Daemon via UDS socket and fetches its DaemonActivityStatus.
 */
export function queryDaemonActivityOverSocket(
  socketPath: string,
  timeoutMs = 3000
): Promise<DaemonActivityStatus | null> {
  return new Promise((resolvePromise) => {
    let settled = false;
    let buffer = '';
    const reqId = `pf_uds_${randomUUID()}`;

    const client = net.connect(socketPath);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        client.destroy();
        resolvePromise(null);
      }
    }, timeoutMs);

    client.on('connect', () => {
      const payload = JSON.stringify({ id: reqId, op: 'activityStatus' }) + '\n';
      client.write(payload, 'utf8');
    });

    client.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === reqId && parsed.ok && parsed.activity) {
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                client.destroy();
                resolvePromise(parsed.activity as DaemonActivityStatus);
                return;
              }
            }
          } catch {}
        }
      }
    });

    client.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        client.destroy();
        resolvePromise(null);
      }
    });

    client.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolvePromise(null);
      }
    });
  });
}

/**
 * Checks whether a container with the given 64-hex ID is currently running in Docker.
 */
function isContainerRunning(containerId: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    execFile('docker', ['inspect', '-f', '{{.State.Running}}', containerId], (err, stdout) => {
      if (err) {
        resolvePromise(false);
        return;
      }
      resolvePromise(stdout.trim() === 'true');
    });
  });
}

/**
 * Queries an in-container Runtime Daemon over docker exec daemon-bridge stdio.
 */
export function queryContainerActivity(
  containerId: string,
  timeoutMs = 4000
): Promise<DaemonActivityStatus | null> {
  return new Promise((resolvePromise) => {
    const reqId = `pf_ctr_${randomUUID()}`;
    let settled = false;
    let stdoutBuffer = '';

    const child = spawn(
      'docker',
      ['exec', '-i', containerId, 'node', '/app/runtime-runner/dist/runtime/daemon-bridge.js'],
      { stdio: ['pipe', 'pipe', 'ignore'] }
    );

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {}
        resolvePromise(null);
      }
    }, timeoutMs);

    child.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolvePromise(null);
      }
    });

    if (child.stdout) {
      child.stdout.on('data', (d) => {
        stdoutBuffer += d.toString('utf8');
        const newlineIdx = stdoutBuffer.indexOf('\n');
        if (newlineIdx !== -1) {
          const line = stdoutBuffer.slice(0, newlineIdx).trim();
          if (line) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.id === reqId && parsed.ok && parsed.activity) {
                if (!settled) {
                  settled = true;
                  clearTimeout(timer);
                  try {
                    child.kill('SIGTERM');
                  } catch {}
                  resolvePromise(parsed.activity as DaemonActivityStatus);
                }
              }
            } catch {}
          }
        }
      });
    }

    if (child.stdin) {
      child.stdin.write(JSON.stringify({ id: reqId, op: 'activityStatus' }) + '\n');
    }

    child.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolvePromise(null);
      }
    });
  });
}

/**
 * Counts non-terminal unclosed turn journals on disk across known daemon homes.
 */
function countUnclosedTurnJournals(dataDir: string): number {
  let count = 0;
  const candidateDirs: string[] = [join(dataDir, 'daemon-turns')];
  const hostDir = join(dataDir, 'host-runtimes');

  if (existsSync(hostDir)) {
    try {
      const users = readdirSync(hostDir, { withFileTypes: true }) as import('node:fs').Dirent[];
      for (const u of users) {
        if (u.isDirectory()) {
          candidateDirs.push(join(hostDir, String(u.name), 'dsh-home', 'daemon-turns'));
        }
      }
    } catch {}
  }

  for (const cDir of candidateDirs) {
    if (existsSync(cDir)) {
      try {
        const files = readdirSync(cDir);
        for (const f of files) {
          if (f.endsWith('.json')) {
            try {
              const content = JSON.parse(readFileSync(join(cDir, f), 'utf8'));
              if (content?.status === 'accepted' || content?.status === 'executing') {
                count++;
              }
            } catch {}
          }
        }
      } catch {}
    }
  }

  return count;
}

/**
 * Inspects SQLite platform.db for active turns, queued turns, claimed tasks, non-terminal journals, and due tasks.
 */
export function inspectPlatformDb(dbPath: string, dueWithinMinutes: number): PlatformPreflightActivity {
  if (!existsSync(dbPath)) {
    return {
      runningQueuedTurns: 0,
      claimedTaskRuns: 0,
      nonTerminalJournals: 0,
      tasksDueWithinNMinutes: 0,
      isIdle: true,
    };
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.exec('PRAGMA query_only = ON;');
    } catch {}

    const tableNames = new Set<string>();
    const tablesStmt = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'");
    for (const row of tablesStmt.all() as any[]) {
      if (row?.name) tableNames.add(row.name);
    }

    let runningQueuedTurns = 0;
    if (tableNames.has('turn_runs')) {
      const row = db.prepare("SELECT count(*) as cnt FROM turn_runs WHERE status IN ('running', 'queued')").get() as any;
      runningQueuedTurns += Number(row?.cnt ?? 0);
    }
    if (tableNames.has('turn_execution_queue')) {
      const row = db.prepare('SELECT count(*) as cnt FROM turn_execution_queue').get() as any;
      runningQueuedTurns += Number(row?.cnt ?? 0);
    }

    let claimedTaskRuns = 0;
    if (tableNames.has('task_runs')) {
      const row = db.prepare("SELECT count(*) as cnt FROM task_runs WHERE status IN ('running', 'claimed')").get() as any;
      claimedTaskRuns += Number(row?.cnt ?? 0);
    }
    if (tableNames.has('session_execution_leases')) {
      const row = db.prepare("SELECT count(*) as cnt FROM session_execution_leases WHERE status = 'active'").get() as any;
      claimedTaskRuns += Number(row?.cnt ?? 0);
    }

    let nonTerminalJournals = 0;
    if (tableNames.has('file_transfer_journal')) {
      const row = db.prepare("SELECT count(*) as cnt FROM file_transfer_journal WHERE status NOT IN ('finalized', 'aborted', 'rolled_back')").get() as any;
      nonTerminalJournals += Number(row?.cnt ?? 0);
    }
    if (tableNames.has('attachment_snapshot_journal')) {
      const row = db.prepare("SELECT count(*) as cnt FROM attachment_snapshot_journal WHERE status NOT IN ('linked', 'cleaned', 'aborted')").get() as any;
      nonTerminalJournals += Number(row?.cnt ?? 0);
    }

    let tasksDueWithinNMinutes = 0;
    if (tableNames.has('platform_tasks')) {
      const cutoffIso = new Date(Date.now() + dueWithinMinutes * 60 * 1000).toISOString();
      const hasSchedules = tableNames.has('task_schedules');
      const sql = hasSchedules
        ? `SELECT count(*) as cnt FROM platform_tasks t
           LEFT JOIN task_schedules s ON s.task_id = t.id
           WHERE (t.status NOT IN ('completed', 'failed', 'cancelled') OR t.status IS NULL)
             AND (s.enabled = 1 OR s.enabled IS NULL)
             AND (
               (COALESCE(s.next_run_at, t.next_run_at) IS NOT NULL AND COALESCE(s.next_run_at, t.next_run_at) <= ?)
               OR (COALESCE(s.next_run_at, t.next_run_at) IS NULL AND t.due_date IS NOT NULL AND t.due_date <= ?)
             )`
        : `SELECT count(*) as cnt FROM platform_tasks t
           WHERE (t.status NOT IN ('completed', 'failed', 'cancelled') OR t.status IS NULL)
             AND (
               (t.next_run_at IS NOT NULL AND t.next_run_at <= ?)
               OR (t.next_run_at IS NULL AND t.due_date IS NOT NULL AND t.due_date <= ?)
             )`;
      const row = db.prepare(sql).get(cutoffIso, cutoffIso) as any;
      tasksDueWithinNMinutes = Number(row?.cnt ?? 0);
    }

    const isIdle =
      runningQueuedTurns === 0 &&
      claimedTaskRuns === 0 &&
      nonTerminalJournals === 0 &&
      tasksDueWithinNMinutes === 0;

    return {
      runningQueuedTurns,
      claimedTaskRuns,
      nonTerminalJournals,
      tasksDueWithinNMinutes,
      isIdle,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      runningQueuedTurns: 0,
      claimedTaskRuns: 0,
      nonTerminalJournals: 0,
      tasksDueWithinNMinutes: 0,
      isIdle: false,
      details: { error: `Failed to inspect platform.db: ${msg}` },
    };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }
}

/**
 * Inspects all resident Host Runtime daemons registered in <dataDir>/host-runtimes.
 */
export async function inspectHostRuntimes(
  dataDir: string,
  timeoutMs: number
): Promise<RuntimePreflightActivity[]> {
  const results: RuntimePreflightActivity[] = [];
  const hostRuntimesDir = join(dataDir, 'host-runtimes');
  if (!existsSync(hostRuntimesDir)) {
    return results;
  }

  let userEntries: import('node:fs').Dirent[] = [];
  try {
    userEntries = readdirSync(hostRuntimesDir, { withFileTypes: true }) as import('node:fs').Dirent[];
  } catch {
    return results;
  }

  for (const entry of userEntries) {
    if (!entry.isDirectory()) continue;
    const userName = String(entry.name);
    const runDir = join(hostRuntimesDir, userName, 'run');
    const metaPath = join(runDir, 'process.meta.json');
    if (!existsSync(metaPath)) continue;

    let meta: any;
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    } catch {
      continue;
    }

    const pid = typeof meta?.pid === 'number' ? meta.pid : undefined;
    if (!pid || !isProcessAlive(pid)) {
      continue;
    }

    const socketPath = meta?.paths?.socketPath || join(runDir, 'runtime.sock');
    const activity = await queryDaemonActivityOverSocket(socketPath, timeoutMs);

    if (activity) {
      results.push({
        runtimeType: 'host',
        identifier: userName,
        pid,
        socketPath,
        isIdle: activity.isIdle,
        activity,
      });
    } else {
      results.push({
        runtimeType: 'host',
        identifier: userName,
        pid,
        socketPath,
        isIdle: false,
        error: `Host daemon (PID ${pid}) alive but unresponsive on socket "${socketPath}"`,
      });
    }
  }

  return results;
}

/**
 * Inspects all container runtimes registered in <dataDir>/containers.
 */
export async function inspectContainerRuntimes(
  dataDir: string,
  timeoutMs: number
): Promise<RuntimePreflightActivity[]> {
  const results: RuntimePreflightActivity[] = [];
  const containersDir = join(dataDir, 'containers');
  if (!existsSync(containersDir)) {
    return results;
  }

  let files: string[] = [];
  try {
    files = readdirSync(containersDir);
  } catch {
    return results;
  }

  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let meta: any;
    try {
      meta = JSON.parse(readFileSync(join(containersDir, f), 'utf8'));
    } catch {
      continue;
    }

    const containerId = meta?.containerId;
    const containerName = meta?.containerName || f.replace(/\.json$/, '');
    if (!containerId || typeof containerId !== 'string') continue;

    const isRunning = await isContainerRunning(containerId);
    if (!isRunning) {
      continue;
    }

    const activity = await queryContainerActivity(containerId, timeoutMs);
    if (activity) {
      results.push({
        runtimeType: 'container',
        identifier: containerName,
        containerId,
        isIdle: activity.isIdle,
        activity,
      });
    } else {
      results.push({
        runtimeType: 'container',
        identifier: containerName,
        containerId,
        isIdle: false,
        error: `Container "${containerName}" (${containerId.slice(0, 12)}) is running but daemon bridge is unresponsive`,
      });
    }
  }

  return results;
}

/**
 * Main preflight evaluation logic.
 */
export async function runPreflight(options: PreflightOptions = {}): Promise<PreflightResult> {
  const dataDir = options.dataDir
    ? resolve(options.dataDir)
    : getDemoPathConfig({ repoRoot: options.repoRoot }).dataRoot;

  const dueWithinMinutes = options.dueWithinMinutes ?? 10;
  const timeoutMs = options.timeoutMs ?? 3000;
  const dbPath = join(dataDir, 'platform.db');

  // 1. Inspect platform database
  const platform = inspectPlatformDb(dbPath, dueWithinMinutes);

  // Check disk unclosed turn journals
  const diskJournals = countUnclosedTurnJournals(dataDir);
  if (diskJournals > 0) {
    platform.nonTerminalJournals += diskJournals;
    platform.isIdle = false;
  }

  // 2. Inspect host and container runtimes
  const hostRuntimes = await inspectHostRuntimes(dataDir, timeoutMs);
  const containerRuntimes = await inspectContainerRuntimes(dataDir, timeoutMs);
  const runtimes = [...hostRuntimes, ...containerRuntimes];

  // 3. Collect issues and compute quiescence
  const issues: string[] = [];

  if (platform.runningQueuedTurns > 0) {
    issues.push(`Platform has ${platform.runningQueuedTurns} running or queued turn(s) in turn_runs/turn_execution_queue.`);
  }
  if (platform.claimedTaskRuns > 0) {
    issues.push(`Platform has ${platform.claimedTaskRuns} claimed or running task run(s) or active lease(s).`);
  }
  if (platform.nonTerminalJournals > 0) {
    issues.push(`Platform has ${platform.nonTerminalJournals} non-terminal journal record(s) in flight.`);
  }
  if (platform.tasksDueWithinNMinutes > 0) {
    issues.push(`Platform has ${platform.tasksDueWithinNMinutes} scheduled task(s) due within ${dueWithinMinutes} minute(s).`);
  }

  for (const r of runtimes) {
    if (!r.isIdle) {
      if (r.error) {
        issues.push(`Runtime ${r.runtimeType} "${r.identifier}": ${r.error}`);
      } else if (r.activity) {
        if (r.activity.activeTurnsCount > 0) {
          const autoCount = r.activity.autonomousTurnsCount;
          issues.push(
            `Runtime ${r.runtimeType} "${r.identifier}" has ${r.activity.activeTurnsCount} active turn(s)` +
              (autoCount > 0 ? ` (${autoCount} autonomous)` : '') +
              '.'
          );
        }
        if (r.activity.runningJobsCount > 0) {
          const wfCount = r.activity.runningWorkflowJobsCount;
          issues.push(
            `Runtime ${r.runtimeType} "${r.identifier}" has ${r.activity.runningJobsCount} running background job(s)` +
              (wfCount > 0 ? ` (${wfCount} workflow)` : '') +
              '.'
          );
        }
        if (r.activity.liveSubagentsCount > 0) {
          issues.push(
            `Runtime ${r.runtimeType} "${r.identifier}" has ${r.activity.liveSubagentsCount} live background subagent(s).`
          );
        }
        if (r.activity.pendingInboxItemsCount > 0) {
          issues.push(
            `Runtime ${r.runtimeType} "${r.identifier}" has ${r.activity.pendingInboxItemsCount} pending inbox item(s).`
          );
        }
        if (r.activity.queuedTurnsCount > 0) {
          issues.push(
            `Runtime ${r.runtimeType} "${r.identifier}" has ${r.activity.queuedTurnsCount} queued turn(s).`
          );
        }
      }
    }
  }

  const allRuntimesIdle = runtimes.every((r) => r.isIdle);
  const isIdle = platform.isIdle && allRuntimesIdle && issues.length === 0;

  // Build summary string
  const hostLines =
    hostRuntimes.length === 0
      ? '    (none)'
      : hostRuntimes
          .map((h) => {
            if (h.error) return `    * ${h.identifier} (PID ${h.pid}): ERROR (${h.error}) ✖`;
            const act = h.activity!;
            const label = act.isIdle
              ? 'IDLE ✔'
              : `BUSY (${act.activeTurnsCount} turns [${act.autonomousTurnsCount} auto], ${act.runningJobsCount} jobs [${act.runningWorkflowJobsCount} wf], ${act.liveSubagentsCount} subagents, ${act.pendingInboxItemsCount} inbox) ✖`;
            return `    * ${h.identifier} (PID ${h.pid}): ${label}`;
          })
          .join('\n');

  const containerLines =
    containerRuntimes.length === 0
      ? '    (none)'
      : containerRuntimes
          .map((c) => {
            if (c.error) return `    * ${c.identifier} (${c.containerId?.slice(0, 12)}): ERROR (${c.error}) ✖`;
            const act = c.activity!;
            const label = act.isIdle
              ? 'IDLE ✔'
              : `BUSY (${act.activeTurnsCount} turns [${act.autonomousTurnsCount} auto], ${act.runningJobsCount} jobs, ${act.liveSubagentsCount} subagents, ${act.pendingInboxItemsCount} inbox) ✖`;
            return `    * ${c.identifier} (${c.containerId?.slice(0, 12)}): ${label}`;
          })
          .join('\n');

  const summary = `
=== Enkeep Deploy Preflight Quiescence Summary ===
Data Directory: ${dataDir}
Timestamp:      ${new Date().toISOString()}

Platform Activity:
  - Running/Queued Turns:  ${platform.runningQueuedTurns}
  - Claimed/Running Tasks: ${platform.claimedTaskRuns}
  - Non-terminal Journals: ${platform.nonTerminalJournals}
  - Tasks Due (within ${dueWithinMinutes}m): ${platform.tasksDueWithinNMinutes}
  => Platform Status:     ${platform.isIdle ? 'IDLE ✔' : 'BUSY ✖'}

Runtime Activity:
  - Host Daemons (${hostRuntimes.length} discovered):
${hostLines}
  - Container Runtimes (${containerRuntimes.length} discovered):
${containerLines}
  => Runtimes Status:     ${allRuntimesIdle ? 'IDLE ✔' : 'BUSY ✖'}
${issues.length > 0 ? '\nIssues Blocking Teardown/Deploy:\n' + issues.map((i) => `  ✖ ${i}`).join('\n') + '\n' : ''}
Overall Preflight Status: ${isIdle ? 'QUIESCENT / IDLE ✔' : 'BUSY / NOT IDLE ✖'}
${
  isIdle
    ? '✔ Quiescent: Safe to proceed with service shutdown, deployment, or restart.'
    : '✖ Safety Gate Violation: Deployment or restart cannot proceed while platform turns or runtimes are active.'
}
`.trim();

  return {
    ok: true,
    isIdle,
    timestamp: new Date().toISOString(),
    dataDir,
    platform,
    runtimes,
    issues,
    summary,
  };
}
