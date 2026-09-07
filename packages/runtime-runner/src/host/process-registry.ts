/**
 * Host Runtime Process Registry & Lifecycle Management
 *
 * Implements signed PID state tracking, collision non-adoption, stale process detection,
 * secure file permissions (0700/0600), and graceful process tree termination (RPC -> SIGTERM -> SIGKILL).
 *
 * @module @enkeep/runtime-runner/host/process-registry
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { HostProcessMetadata } from './types.js';
import { HostOwnershipError, HostCollisionError } from '../spec/provider.js';

export const DEFAULT_SECRET_KEY =
  process.env.ENKEEP_HOST_RUNTIME_SECRET_KEY || crypto.randomBytes(32).toString('hex');

export function computeMetaSignature(
  meta: Omit<HostProcessMetadata, 'signature'>,
  secretKey: string
): string {
  const payload = JSON.stringify({
    pid: meta.pid,
    startTime: meta.startTime,
    nonce: meta.nonce,
    userId: meta.userId,
    runId: meta.runId,
    storageId: meta.storageId,
    paths: meta.paths,
    createdAt: meta.createdAt,
  });
  return crypto.createHmac('sha256', secretKey).update(payload).digest('hex');
}

/**
 * Writes signed process metadata to disk with strict 0600 file and 0700 dir permissions.
 */
export function writeProcessMeta(
  metaPath: string,
  metaData: Omit<HostProcessMetadata, 'signature' | 'createdAt'> & { createdAt?: string },
  secretKey = DEFAULT_SECRET_KEY
): HostProcessMetadata {
  const dir = path.dirname(metaPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}

  const createdAt = metaData.createdAt || new Date().toISOString();
  const unsignedMeta: Omit<HostProcessMetadata, 'signature'> = {
    ...metaData,
    createdAt,
  };

  const signature = computeMetaSignature(unsignedMeta, secretKey);
  const fullMeta: HostProcessMetadata = {
    ...unsignedMeta,
    signature,
  };

  fs.writeFileSync(metaPath, JSON.stringify(fullMeta, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(metaPath, 0o600);
  } catch {}

  return fullMeta;
}

/**
 * Reads and verifies signed process metadata from disk.
 * Returns null if file does not exist or signature is invalid.
 */
export function readProcessMeta(
  metaPath: string,
  secretKey = DEFAULT_SECRET_KEY
): HostProcessMetadata | null {
  if (!fs.existsSync(metaPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(metaPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.signature !== 'string' ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.runId !== 'string'
    ) {
      return null;
    }

    const { signature, ...unsigned } = parsed;
    const expectedSig = computeMetaSignature(unsigned, secretKey);
    if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSig, 'hex'))) {
      return null;
    }

    return parsed as HostProcessMetadata;
  } catch {
    return null;
  }
}

/**
 * Checks if a PID is alive in the operating system.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM'; // EPERM means process exists but we don't have permission to signal it
  }
}

/**
 * Attempts to retrieve process start time or uptime on supported platforms.
 */
export function getProcessStartTime(pid: number): number {
  if (process.platform === 'linux') {
    try {
      const statPath = `/proc/${pid}/stat`;
      if (fs.existsSync(statPath)) {
        const stat = fs.readFileSync(statPath, 'utf8');
        const parts = stat.split(' ');
        const starttimeTicks = parseInt(parts[21] || '0', 10);
        return starttimeTicks;
      }
    } catch {}
  }
  return 0;
}

/**
 * Cleans up stale runtime process artifacts (socket file and meta file).
 */
export function cleanStaleProcess(runDir: string, explicitSocketPath?: string): void {
  const metaPath = path.join(runDir, 'process.meta.json');
  if (!explicitSocketPath && fs.existsSync(metaPath)) {
    try {
      const raw = fs.readFileSync(metaPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.paths?.socketPath && typeof parsed.paths.socketPath === 'string') {
        explicitSocketPath = parsed.paths.socketPath;
      }
    } catch {}
  }

  if (explicitSocketPath) {
    try {
      if (fs.existsSync(explicitSocketPath)) {
        fs.unlinkSync(explicitSocketPath);
      }
    } catch {}
  }

  try {
    const defaultSocketPath = path.join(runDir, 'daemon.sock');
    if (fs.existsSync(defaultSocketPath)) {
      fs.unlinkSync(defaultSocketPath);
    }
  } catch {}

  try {
    if (fs.existsSync(metaPath)) {
      fs.unlinkSync(metaPath);
    }
  } catch {}
}

/**
 * Terminates a process tree with a graceful RPC -> SIGTERM -> SIGKILL escalation pattern.
 */
export async function killProcessTree(
  pid: number,
  timeoutMs = 3000,
  rpcShutdownFn?: () => Promise<void>
): Promise<void> {
  if (!isProcessAlive(pid)) {
    return;
  }

  // 1. Graceful RPC shutdown
  if (rpcShutdownFn) {
    try {
      await Promise.race([
        rpcShutdownFn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('RPC shutdown timeout')), 1500)),
      ]);
    } catch {}
  }

  if (!isProcessAlive(pid)) {
    return;
  }

  // 2. SIGTERM
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}

  // Also try process group if negative pid is supported
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {}

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  // 3. SIGKILL escalation
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  }

  // Brief poll for final death
  const killStart = Date.now();
  while (Date.now() - killStart < 1000) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
