/**
 * Process Ownership, Live Inspection, and Safe Termination Guards
 *
 * Enforces:
 * 1. Verification of live process start time, command line, and ownership tokens to prevent PID reuse attacks.
 *    Exact PID startTime and exact command line equality required.
 * 2. Absolute protection against terminating current CLI process (process.pid), parent process (process.ppid),
 *    PID 1, PID <= 0, or listeners on protected ports (3000 HappyClaw / 3080 DSH GUI).
 * 3. Fail-closed: Protected port probe failure fails closed (refuses teardown).
 * 4. Bounded exact rechecks after TERM and KILL with absent confirmation.
 * 5. Testable interfaces with mockable ProcessInspector and ProcessKiller.
 *
 * @module @enkeep/demo-runner/utils/process-guard
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SignedProcessMetadata, ProcessInspector, ProcessKiller, DemoPathOptions } from '../types.js';
import { RESERVED_PROTECTED_PORTS } from '../config.js';
import { probePortListener } from './probes.js';

const execFileAsync = promisify(execFile);

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function getErrnoCode(err: unknown): string | undefined {
  if (isRecord(err) && 'code' in err) {
    const code = err['code'];
    if (typeof code === 'string') return code;
    if (typeof code === 'number') return String(code);
  }
  return undefined;
}

/**
 * Default OS Process Inspector using standard system utilities (`ps`).
 */
export class OsProcessInspector implements ProcessInspector {
  async getProcessInfo(pid: number): Promise<{
    exists: boolean;
    startTime?: string;
    command?: string;
    pid: number;
  }> {
    if (!Number.isInteger(pid) || pid <= 0) {
      return { exists: false, pid };
    }

    // 1. First probe via process.kill(pid, 0)
    let exists = false;
    try {
      process.kill(pid, 0);
      exists = true;
    } catch (err: unknown) {
      const code = getErrnoCode(err);
      if (code === 'ESRCH') {
        return { exists: false, pid };
      } else if (code === 'EPERM') {
        exists = true; // Exists but belongs to another user
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`FAIL-CLOSED: process.kill(${pid}, 0) failed with unexpected code "${code}": ${msg}`);
      }
    }

    // 2. Query ps for start time and command
    let startTime: string | undefined;
    let command: string | undefined;

    try {
      // macOS / BSD / Linux ps options: lstart (start time), command (command line)
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart=,command=']);
      const line = stdout.trim();
      if (line) {
        // Format of lstart is exactly 24 chars ("Day Mon DD HH:MM:SS YYYY")
        if (line.length >= 24) {
          startTime = line.substring(0, 24).trim();
          command = line.substring(24).trim();
        } else {
          command = line;
        }
      }
    } catch (err: unknown) {
      const exitCode = getErrnoCode(err);
      // ps returns exit code 1 when process does not exist (e.g. race condition where process died right after kill(0))
      if (exitCode === '1') {
        try {
          process.kill(pid, 0);
        } catch (killErr: unknown) {
          const kCode = getErrnoCode(killErr);
          if (kCode === 'ESRCH') {
            return { exists: false, pid };
          }
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`FAIL-CLOSED: Failed to inspect process ${pid} via ps: ${msg}`);
    }

    return {
      exists,
      startTime,
      command,
      pid,
    };
  }
}

/**
 * Default OS Process Killer.
 */
export class OsProcessKiller implements ProcessKiller {
  kill(pid: number, signal: NodeJS.Signals | number): void {
    process.kill(pid, signal);
  }
}

export const defaultProcessInspector = new OsProcessInspector();
export const defaultProcessKiller = new OsProcessKiller();

/**
 * Queries current start time token of a live process.
 */
export async function getLiveProcessStartTime(
  pid: number,
  inspector: ProcessInspector = defaultProcessInspector
): Promise<string | undefined> {
  const info = await inspector.getProcessInfo(pid);
  return info.startTime;
}

/**
 * Verifies if a process described by signed metadata is safe to terminate.
 *
 * Rejects:
 * - Current CLI process PID (calling process)
 * - Parent process PID (process.ppid)
 * - System PIDs (<= 1)
 * - Protected ports listeners (3000 / 3080) - failure to probe fails closed
 * - Process with mismatching start time or command (PID reuse detection)
 */
export async function verifyProcessForTeardown(
  proc: SignedProcessMetadata,
  inspector: ProcessInspector = defaultProcessInspector,
  _options?: DemoPathOptions | string
): Promise<{
  safe: boolean;
  isAlive: boolean;
  reason?: string;
  code?: string;
}> {
  // 1. Basic PID validation
  if (!Number.isInteger(proc.pid) || proc.pid <= 1) {
    return {
      safe: false,
      isAlive: false,
      reason: `PID ${proc.pid} is an invalid or system process.`,
      code: 'INVALID_PID',
    };
  }

  // 2. Absolute protection: Self PID (current executing CLI process)
  if (proc.pid === process.pid) {
    return {
      safe: false,
      isAlive: true,
      reason: `Cannot terminate self process (PID ${proc.pid}).`,
      code: 'SELF_PID_PROTECTION',
    };
  }

  // 3. Absolute protection: Parent PID
  if (process.ppid && proc.pid === process.ppid) {
    return {
      safe: false,
      isAlive: true,
      reason: `Cannot terminate parent process (PID ${proc.pid}).`,
      code: 'PARENT_PID_PROTECTION',
    };
  }

  // 4. Protection against terminating HappyClaw (3000) or DSH GUI (3080) listeners (fail-closed on probe error)
  for (const protectedPort of RESERVED_PROTECTED_PORTS) {
    try {
      const probe = await probePortListener(protectedPort);
      if (probe.reachable && !probe.listenerPid) {
        return {
          safe: false,
          isAlive: true,
          reason: `FAIL-CLOSED: Protected port ${protectedPort} is responsive/reachable but listener PID could not be determined. Refusing teardown to prevent terminating protected listener.`,
          code: 'PROTECTED_PORT_UNKNOWN_LISTENER',
        };
      }
      if (probe.listenerPid && probe.listenerPid === proc.pid) {
        return {
          safe: false,
          isAlive: true,
          reason: `CRITICAL SAFETY VIOLATION: PID ${proc.pid} owns protected port ${protectedPort} (HappyClaw/DSH GUI).`,
          code: 'PROTECTED_PORT_OWNER',
        };
      }
    } catch (err: unknown) {
      return {
        safe: false,
        isAlive: true,
        reason: `FAIL-CLOSED: Protected port ${protectedPort} probe failed: ${err instanceof Error ? err.message : String(err)}`,
        code: 'PROTECTED_PORT_PROBE_FAILED',
      };
    }
  }

  // 5. Inspect live process
  const info = await inspector.getProcessInfo(proc.pid);
  if (!info.exists) {
    return {
      safe: true,
      isAlive: false,
      reason: `Process PID ${proc.pid} is already stopped.`,
      code: 'ALREADY_STOPPED',
    };
  }

  // 6. PID Reuse Detection: Compare start time strictly
  if (!info.startTime || info.startTime !== proc.startTime) {
    return {
      safe: false,
      isAlive: true,
      reason: `PID REUSE DETECTED: Process PID ${proc.pid} live start time "${info.startTime ?? 'unknown'}" does not match recorded start time "${proc.startTime}".`,
      code: 'PID_REUSE_DETECTED',
    };
  }

  // 7. Command comparison: exact equality
  if (!info.command || info.command !== proc.command) {
    return {
      safe: false,
      isAlive: true,
      reason: `PID REUSE / UNVERIFIED COMMAND DETECTED: Live command "${info.command ?? 'unknown'}" does not match expected demo service command "${proc.command}".`,
      code: 'COMMAND_MISMATCH',
    };
  }

  return {
    safe: true,
    isAlive: true,
    reason: `Process PID ${proc.pid} is verified as enkeep-demo service "${proc.service}".`,
  };
}

/**
 * Safely kills a verified process.
 */
export async function safeKillProcess(
  proc: SignedProcessMetadata,
  options: {
    inspector?: ProcessInspector;
    killer?: ProcessKiller;
    graceTimeoutMs?: number;
    repoRoot?: string;
    dataRoot?: string;
    mode?: 'production' | 'test';
  } = {}
): Promise<{
  success: boolean;
  status: 'terminated' | 'already_stopped' | 'failed';
  error?: string;
}> {
  const inspector = options.inspector ?? defaultProcessInspector;
  const killer = options.killer ?? defaultProcessKiller;
  const graceTimeoutMs = options.graceTimeoutMs ?? 500;

  const verification = await verifyProcessForTeardown(proc, inspector, options);

  if (!verification.safe) {
    return {
      success: false,
      status: 'failed',
      error: verification.reason,
    };
  }

  if (!verification.isAlive) {
    return {
      success: true,
      status: 'already_stopped',
    };
  }

  try {
    // Send SIGTERM
    try {
      killer.kill(proc.pid, 'SIGTERM');
    } catch (termErr: unknown) {
      const errCode = getErrnoCode(termErr);
      if (errCode === 'ESRCH') {
        return {
          success: true,
          status: 'already_stopped',
        };
      }
      return {
        success: false,
        status: 'failed',
        error: `SIGTERM failed: ${termErr instanceof Error ? termErr.message : String(termErr)}`,
      };
    }

    // Bounded recheck after TERM
    const termDeadline = Date.now() + Math.max(graceTimeoutMs, 100);
    let termAbsent = false;
    while (Date.now() < termDeadline) {
      const termCheck = await inspector.getProcessInfo(proc.pid);
      if (!termCheck.exists) {
        termAbsent = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (termAbsent) {
      return {
        success: true,
        status: 'terminated',
      };
    }

    // Process still exists after SIGTERM; send SIGKILL
    try {
      killer.kill(proc.pid, 'SIGKILL');
    } catch (killErr: unknown) {
      const errCode = getErrnoCode(killErr);
      if (errCode === 'ESRCH') {
        return {
          success: true,
          status: 'already_stopped',
        };
      }
      return {
        success: false,
        status: 'failed',
        error: `SIGKILL failed: ${killErr instanceof Error ? killErr.message : String(killErr)}`,
      };
    }

    // Bounded recheck after KILL and only success absent
    const killDeadline = Date.now() + 500;
    let killAbsent = false;
    while (Date.now() < killDeadline) {
      const killCheck = await inspector.getProcessInfo(proc.pid);
      if (!killCheck.exists) {
        killAbsent = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (killAbsent) {
      return {
        success: true,
        status: 'terminated',
      };
    }

    return {
      success: false,
      status: 'failed',
      error: `Process PID ${proc.pid} remained alive after SIGKILL.`,
    };
  } catch (err: unknown) {
    const errCode = getErrnoCode(err);
    if (errCode === 'ESRCH') {
      return {
        success: true,
        status: 'already_stopped',
      };
    }
    return {
      success: false,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
