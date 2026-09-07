/**
 * Protected Ports (3000 HappyClaw / 3080 DSH GUI) Safety Probe & Guard
 *
 * Requirements:
 * - Uses lsof -Fpc via execFile to discover listener PID and command.
 * - Only exact exit code 1 with empty stdout means no listener.
 * - If lsof is missing (ENOENT), fails closed immediately.
 * - Parsing malformed or multiple distinct listener PIDs or differing commands fails closed.
 * - When a listener PID exists, requires exactly one distinct non-empty command.
 * - Inspects process start time and full command line via ps -p pid -o lstart=,command=.
 * - Throws typed fail-closed errors if ps fails or returns empty/malformed output.
 * - Uses Node net.connect to verify socket responsiveness without altering process state.
 * - Never signals or touches existing listeners.
 * - Asserts reachability, listener PID, command, startTime, and fullCommandLine remain strictly identical.
 * - Zero type casts: uses strict type guards for error inspection.
 *
 * @module @enkeep/web-e2e/probes/ports-guard
 */

import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PortProbeSnapshot {
  port: number;
  responsive: boolean;
  listenerPid?: number;
  command?: string;
  startTime?: string;
  fullCommandLine?: string;
  timestamp: string;
}

export interface ProtectedPortsSnapshot {
  port3000: PortProbeSnapshot;
  port3080: PortProbeSnapshot;
}

/**
 * Type-safe error helpers without type assertions / casts.
 */
function getErrorCode(err: unknown): string | number | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = err.code;
    if (typeof code === 'string' || typeof code === 'number') {
      return code;
    }
  }
  return undefined;
}

function getErrorStdout(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'stdout' in err) {
    const stdout = err.stdout;
    if (typeof stdout === 'string') {
      return stdout;
    }
  }
  return undefined;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Checks socket responsiveness via Node net.connect on 127.0.0.1.
 */
async function checkSocketResponsive(port: number, timeoutMs = 1200): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;

    const finalize = (result: boolean) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(result);
      }
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finalize(true));
    socket.on('timeout', () => finalize(false));
    socket.on('error', () => finalize(false));
  });
}

/**
 * Discovers listener PID and command using lsof -Fpc.
 * Fails closed if lsof is missing or encounters unexpected errors/outputs.
 */
async function getLsofListener(port: number): Promise<{ pid?: number; command?: string }> {
  let rawStdout: string;
  try {
    const execResult = await execFileAsync('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-n', '-P', '-Fpc']);
    rawStdout = execResult.stdout;
  } catch (err: unknown) {
    const code = getErrorCode(err);
    const stdout = getErrorStdout(err);
    const message = getErrorMessage(err);

    if (code === 'ENOENT') {
      throw new Error('FAIL-CLOSED: Required system utility "lsof" was not found.');
    }
    // Only exact exit code 1 with empty stdout means no listener
    if (code === 1 && (!stdout || stdout.trim() === '')) {
      return {};
    }
    // Hard failure for any other error or non-empty output with exit code != 0
    throw new Error(
      `FAIL-CLOSED: lsof execution failed on port ${port} (code=${code}): ${message}`
    );
  }

  const lines = rawStdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const pids = new Set<number>();
  const commands = new Set<string>();

  for (const line of lines) {
    if (line.startsWith('p')) {
      const rawPid = line.slice(1);
      const parsed = parseInt(rawPid, 10);
      if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== rawPid) {
        throw new Error(`FAIL-CLOSED: Malformed PID "${rawPid}" from lsof for port ${port}`);
      }
      pids.add(parsed);
    } else if (line.startsWith('c')) {
      const cmd = line.slice(1).trim();
      if (cmd) {
        commands.add(cmd);
      }
    }
  }

  if (pids.size > 1) {
    throw new Error(
      `FAIL-CLOSED: Multiple distinct listener PIDs found on port ${port}: ${Array.from(pids).join(', ')}`
    );
  }
  if (commands.size > 1) {
    throw new Error(
      `FAIL-CLOSED: Multiple distinct listener commands found on port ${port}: ${Array.from(commands).join(', ')}`
    );
  }

  if (pids.size === 1) {
    const pid = Array.from(pids)[0];
    if (commands.size !== 1) {
      throw new Error(
        `FAIL-CLOSED: Port ${port} listener PID ${pid} has no distinct command from lsof`
      );
    }
    const command = Array.from(commands)[0];
    return { pid, command };
  }

  return {};
}

/**
 * Discovers process start time and full command line using ps.
 * Throws typed errors on any failure, non-zero exit, or malformed output.
 */
async function getProcessDetails(pid: number): Promise<{ startTime: string; fullCommandLine: string }> {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`FAIL-CLOSED: Invalid PID ${pid} passed to getProcessDetails`);
  }

  let rawStdout: string;
  try {
    const execResult = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart=,command=']);
    rawStdout = execResult.stdout;
  } catch (err: unknown) {
    const code = getErrorCode(err);
    const message = getErrorMessage(err);
    if (code === 'ENOENT') {
      throw new Error('FAIL-CLOSED: Required system utility "ps" was not found.');
    }
    throw new Error(
      `FAIL-CLOSED: ps execution failed for PID ${pid} (code=${code}): ${message}`
    );
  }

  const line = rawStdout.trim();
  if (!line) {
    throw new Error(`FAIL-CLOSED: ps returned empty output for PID ${pid}`);
  }
  if (line.length < 24) {
    throw new Error(`FAIL-CLOSED: ps output format malformed for PID ${pid}: "${line}"`);
  }
  const startTime = line.substring(0, 24).trim();
  const fullCommandLine = line.substring(24).trim();
  if (!startTime || !fullCommandLine) {
    throw new Error(`FAIL-CLOSED: Failed to parse startTime/command for PID ${pid} from "${line}"`);
  }
  return { startTime, fullCommandLine };
}

/**
 * Probes a single protected port.
 */
export async function probeSingleProtectedPort(port: number): Promise<PortProbeSnapshot> {
  const [responsive, lsofInfo] = await Promise.all([
    checkSocketResponsive(port),
    getLsofListener(port),
  ]);

  let startTime: string | undefined;
  let fullCommandLine: string | undefined;

  if (lsofInfo.pid) {
    const psInfo = await getProcessDetails(lsofInfo.pid);
    startTime = psInfo.startTime;
    fullCommandLine = psInfo.fullCommandLine;
  }

  return {
    port,
    responsive,
    listenerPid: lsofInfo.pid,
    command: lsofInfo.command,
    startTime,
    fullCommandLine,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Probes both protected ports 3000 and 3080.
 */
export async function probeProtectedPorts(): Promise<ProtectedPortsSnapshot> {
  const [port3000, port3080] = await Promise.all([
    probeSingleProtectedPort(3000),
    probeSingleProtectedPort(3080),
  ]);

  return { port3000, port3080 };
}

/**
 * Asserts that the protected ports 3000 and 3080 meet all acceptance readiness criteria:
 * - Both ports responsive
 * - Exactly one listener PID per port (> 0)
 * - Non-empty command, startTime, and fullCommandLine
 */
export function assertProtectedPortsReady(snapshot: ProtectedPortsSnapshot): void {
  for (const port of [3000, 3080] as const) {
    const portSnap = port === 3000 ? snapshot.port3000 : snapshot.port3080;
    if (!portSnap.responsive) {
      throw new Error(`FAIL-CLOSED: Protected port ${port} is not responsive to TCP connection`);
    }
    if (!portSnap.listenerPid || portSnap.listenerPid <= 0) {
      throw new Error(`FAIL-CLOSED: Protected port ${port} has no active listener PID discovered`);
    }
    if (!portSnap.command || portSnap.command.trim() === '') {
      throw new Error(`FAIL-CLOSED: Protected port ${port} has empty command`);
    }
    if (!portSnap.startTime || portSnap.startTime.trim() === '') {
      throw new Error(`FAIL-CLOSED: Protected port ${port} has empty process startTime`);
    }
    if (!portSnap.fullCommandLine || portSnap.fullCommandLine.trim() === '') {
      throw new Error(`FAIL-CLOSED: Protected port ${port} has empty process fullCommandLine`);
    }
  }
}

/**
 * Asserts that the protected port snapshots before and after test execution remain 100% identical.
 * Compares responsiveness, listener PID, command, startTime, and fullCommandLine.
 */
export function assertProtectedPortsUnmolested(
  before: ProtectedPortsSnapshot,
  after: ProtectedPortsSnapshot
): void {
  const discrepancies: string[] = [];

  for (const port of [3000, 3080] as const) {
    const b = port === 3000 ? before.port3000 : before.port3080;
    const a = port === 3000 ? after.port3000 : after.port3080;

    if (b.responsive !== a.responsive) {
      discrepancies.push(
        `Port ${port} socket responsiveness changed: before=${b.responsive}, after=${a.responsive}`
      );
    }
    if (b.listenerPid !== a.listenerPid) {
      discrepancies.push(
        `CRITICAL SAFETY VIOLATION: Port ${port} listener PID changed from ${b.listenerPid} to ${a.listenerPid}`
      );
    }
    if (b.command !== a.command) {
      discrepancies.push(
        `CRITICAL SAFETY VIOLATION: Port ${port} command changed from "${b.command}" to "${a.command}"`
      );
    }
    if (b.startTime !== a.startTime) {
      discrepancies.push(
        `CRITICAL SAFETY VIOLATION: Port ${port} process start time changed: before="${b.startTime}", after="${a.startTime}"`
      );
    }
    if (b.fullCommandLine !== a.fullCommandLine) {
      discrepancies.push(
        `CRITICAL SAFETY VIOLATION: Port ${port} process full command line changed: before="${b.fullCommandLine}", after="${a.fullCommandLine}"`
      );
    }
  }

  if (discrepancies.length > 0) {
    throw new Error(
      `CRITICAL SAFETY DISRUPTION DETECTED: Protected services on 3000/3080 were altered during test execution!\n${discrepancies.join('\n')}`
    );
  }
}
