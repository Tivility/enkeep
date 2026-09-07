/**
 * Host & Port Allocation, HTTP Probing, and Service Integrity Checking
 *
 * Implements strict dynamic ephemeral allocation (127.0.0.1:0 / safe range),
 * never touches 3000/3080, and probes listeners to verify zero disruption.
 *
 * @module @enkeep/demo-runner/utils/probes
 */

import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ALLOWED_HOSTS, FORBIDDEN_HOSTS, RESERVED_PROTECTED_PORTS } from '../config.js';
import type { ProbeSnapshot } from '../types.js';

const execFileAsync = promisify(execFile);

/**
 * Validates that host binding is strictly loopback.
 */
export function validateLoopbackHost(host: string): void {
  const norm = (host || '').trim().toLowerCase();
  for (const forbidden of FORBIDDEN_HOSTS) {
    if (norm === forbidden.toLowerCase()) {
      throw new Error(`Safety Violation: Forbidden host binding "${host}". Only loopback (127.0.0.1) is permitted.`);
    }
  }

  if (!ALLOWED_HOSTS.some((a) => a.toLowerCase() === norm)) {
    throw new Error(`Safety Violation: Unsafe host binding "${host}". Must be one of [${ALLOWED_HOSTS.join(', ')}].`);
  }
}

/**
 * Validates that port is safe (not reserved 3000/3080, valid range).
 */
export function validateSafePort(port: number): void {
  if (RESERVED_PROTECTED_PORTS.includes(port)) {
    throw new Error(
      `Safety Violation: Port ${port} is reserved/protected (HappyClaw 3000 / DSH GUI 3080) and MUST NOT be allocated.`
    );
  }

  if (port !== 0 && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
    throw new Error(`Invalid port ${port}. Must be 0 (ephemeral) or in user-space range 1024-65535.`);
  }
}

/**
 * Finds an available dynamic port on 127.0.0.1.
 */
export async function findEphemeralPort(startPort = 3100, host = '127.0.0.1'): Promise<number> {
  validateLoopbackHost(host);

  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();

    srv.on('error', (err) => {
      reject(err);
    });

    // Binding with port 0 requests the OS to assign a free ephemeral port
    srv.listen({ host, port: 0, exclusive: true }, () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr && addr.port) {
        const allocatedPort = addr.port;
        srv.close(() => {
          if (RESERVED_PROTECTED_PORTS.includes(allocatedPort)) {
            // Unlikely collision with protected port, retry recursively
            findEphemeralPort(startPort, host).then(resolve, reject);
          } else {
            resolve(allocatedPort);
          }
        });
      } else {
        srv.close(() => reject(new Error('Failed to obtain ephemeral port')));
      }
    });
  });
}

/**
 * Probes HTTP status, response fingerprint, and listener PID for a specific port on 127.0.0.1.
 */
export async function probePortListener(port: number, timeoutMs = 1500): Promise<ProbeSnapshot> {
  const timestamp = new Date().toISOString();
  let reachable = false;
  let httpStatus: number | undefined;
  let httpFingerprint: string | undefined;
  let listenerPid: number | undefined;
  let command: string | undefined;

  // 1. Probe HTTP and capture fingerprint
  try {
    const probeResult = await new Promise<{ status: number; bodyChunk: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/',
          method: 'GET',
          timeout: timeoutMs,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            if (body.length < 512) {
              body += chunk.toString();
            }
          });
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 200,
              bodyChunk: body,
            });
          });
        }
      );

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('probe timeout'));
      });
      req.end();
    });

    reachable = true;
    httpStatus = probeResult.status;
    httpFingerprint = createHash('sha256')
      .update(`${probeResult.status}:${probeResult.bodyChunk.substring(0, 128)}`)
      .digest('hex')
      .substring(0, 16);
  } catch (_err: unknown) {
    reachable = false;
  }

  // 2. Discover listener PID via lsof (safe read-only inspection)
  try {
    const { stdout } = await execFileAsync('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-n', '-P']);
    const lines = stdout.trim().split('\n');
    if (lines.length > 1) {
      const match = lines[1].trim().split(/\s+/);
      if (match.length >= 2) {
        command = match[0];
        const parsedPid = parseInt(match[1], 10);
        if (Number.isInteger(parsedPid) && parsedPid > 0) {
          listenerPid = parsedPid;
          reachable = true; // Confirmed listening even if HTTP errored
        }
      }
    }
  } catch (err: unknown) {
    // Exit code 1 indicates no process is listening on the port (normal / non-error in lsof)
    const errCode = (err as { code?: string | number })?.code;
    if (errCode !== 1 && errCode !== '1') {
      const msg = err instanceof Error ? err.message : String(err);
      // Fail-closed: rethrow real lsof failure so caller can detect probe failure
      throw new Error(`FAIL-CLOSED: lsof probe failed for port ${port}: ${msg}`);
    }
  }

  return {
    target: `127.0.0.1:${port}`,
    port,
    reachable,
    httpStatus,
    httpFingerprint,
    listenerPid,
    command,
    timestamp,
  };
}

/**
 * Probes both protected ports (3000 HappyClaw & 3080 DSH GUI).
 */
export async function probeProtectedPorts(): Promise<{ port3000: ProbeSnapshot; port3080: ProbeSnapshot }> {
  const [port3000, port3080] = await Promise.all([
    probePortListener(3000),
    probePortListener(3080),
  ]);

  return { port3000, port3080 };
}

/**
 * Asserts that the probe snapshots before and after are identical (no PID changes, no disruption).
 */
export function assertProbesUnchanged(
  before: { port3000: ProbeSnapshot; port3080: ProbeSnapshot },
  after: { port3000: ProbeSnapshot; port3080: ProbeSnapshot }
): { unchanged: boolean; discrepancies: string[] } {
  const discrepancies: string[] = [];

  // Check 3000
  if (before.port3000.reachable !== after.port3000.reachable) {
    discrepancies.push(
      `Port 3000 reachability changed: before=${before.port3000.reachable}, after=${after.port3000.reachable}`
    );
  }
  if (before.port3000.listenerPid !== after.port3000.listenerPid) {
    discrepancies.push(
      `CRITICAL SAFETY DISRUPTION: Port 3000 listener PID changed from ${before.port3000.listenerPid} to ${after.port3000.listenerPid}`
    );
  }

  // Check 3080
  if (before.port3080.reachable !== after.port3080.reachable) {
    discrepancies.push(
      `Port 3080 reachability changed: before=${before.port3080.reachable}, after=${after.port3080.reachable}`
    );
  }
  if (before.port3080.listenerPid !== after.port3080.listenerPid) {
    discrepancies.push(
      `CRITICAL SAFETY DISRUPTION: Port 3080 listener PID changed from ${before.port3080.listenerPid} to ${after.port3080.listenerPid}`
    );
  }

  return {
    unchanged: discrepancies.length === 0,
    discrepancies,
  };
}
