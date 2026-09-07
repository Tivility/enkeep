/**
 * Process and Container Ownership Verification Module
 *
 * Implements strict ownership safeguards:
 * 1. Process metadata files stored in <repoRoot>/.demo-data/pids/<service>.json
 * 2. PID metadata structure: service, pid, port, startedAt, owner ('enkeep-demo'), cmd
 * 3. down / cleanup only ever touches processes verified by metadata and ownership signature
 * 4. Docker container ownership: prefix 'enkeep-demo-' and label 'app=enkeep-demo'
 * 5. Safe testable functions without killing unverified / external processes
 */

import { resolve, join } from 'node:path';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import {
  DEMO_OWNERSHIP_TAG,
  DEMO_PID_META_SUBDIR,
  DEMO_DOCKER_CONTAINER_PREFIX,
  DEMO_DOCKER_LABEL_KEY,
  DEMO_DOCKER_LABEL_VALUE,
} from './constants.js';
import { SafetyViolationError } from './errors.js';
import { getCanonicalDemoDataDir, validateDemoDataPath } from './preflight.js';

export interface ProcessMetadata {
  /** Service identifier (e.g., 'platform', 'bridge', 'im-approval') */
  service: string;
  /** Process ID */
  pid: number;
  /** Allocated port (if applicable) */
  port?: number;
  /** ISO timestamp when the process was started */
  startedAt: string;
  /** Mandatory ownership marker (must be 'enkeep-demo') */
  owner: typeof DEMO_OWNERSHIP_TAG;
  /** Command / arguments used to launch the process */
  command?: string;
  /** Additional metadata */
  details?: Record<string, unknown>;
}

export interface ContainerMetadata {
  /** Container name (must start with 'enkeep-demo-') */
  name: string;
  /** Container ID */
  containerId?: string;
  /** Container labels (must include app=enkeep-demo) */
  labels: Record<string, string>;
  /** Image name */
  image?: string;
}

export interface ProcessTeardownPlan {
  service: string;
  pid: number;
  metadataPath: string;
  canTerminate: boolean;
  reason: string;
}

/**
 * Returns the directory used for storing PID metadata files.
 */
export function getPidMetadataDir(repoRoot?: string): string {
  const demoDataDir = getCanonicalDemoDataDir(repoRoot);
  return join(demoDataDir, DEMO_PID_META_SUBDIR);
}

/**
 * Ensures the PID metadata directory exists.
 */
export function ensurePidMetadataDir(repoRoot?: string): string {
  const dir = getPidMetadataDir(repoRoot);
  validateDemoDataPath(dir, repoRoot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Returns the metadata file path for a given service.
 */
export function getServicePidFilePath(service: string, repoRoot?: string): string {
  const sanitized = service.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = getPidMetadataDir(repoRoot);
  return join(dir, `${sanitized}.json`);
}

/**
 * Writes PID metadata for a newly launched demo process.
 */
export function writeProcessMetadata(
  meta: Omit<ProcessMetadata, 'owner' | 'startedAt'> & {
    owner?: typeof DEMO_OWNERSHIP_TAG;
    startedAt?: string;
  },
  repoRoot?: string
): ProcessMetadata {
  if (!meta.service || typeof meta.service !== 'string') {
    throw new SafetyViolationError(
      'INVALID_PID_METADATA',
      'Service name is required for process metadata.'
    );
  }

  if (!Number.isInteger(meta.pid) || meta.pid <= 0) {
    throw new SafetyViolationError(
      'INVALID_PID_METADATA',
      `Invalid PID: ${meta.pid}. Must be a positive integer.`,
      { pid: meta.pid }
    );
  }

  const fullMeta: ProcessMetadata = {
    service: meta.service,
    pid: meta.pid,
    port: meta.port,
    startedAt: meta.startedAt ?? new Date().toISOString(),
    owner: DEMO_OWNERSHIP_TAG,
    command: meta.command,
    details: meta.details,
  };

  const dir = ensurePidMetadataDir(repoRoot);
  const filePath = getServicePidFilePath(meta.service, repoRoot);
  validateDemoDataPath(filePath, repoRoot);

  writeFileSync(filePath, JSON.stringify(fullMeta, null, 2), 'utf-8');
  return fullMeta;
}

/**
 * Reads and verifies the PID metadata file for a service.
 */
export function readProcessMetadata(service: string, repoRoot?: string): ProcessMetadata | null {
  const filePath = getServicePidFilePath(service, repoRoot);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);

    if (parsed.owner !== DEMO_OWNERSHIP_TAG) {
      throw new SafetyViolationError(
        'UNVERIFIED_PROCESS_OWNERSHIP',
        `PID file at ${filePath} does not have valid ownership tag (expected "${DEMO_OWNERSHIP_TAG}", got "${parsed.owner}")`,
        { filePath, parsed }
      );
    }

    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      throw new SafetyViolationError(
        'INVALID_PID_METADATA',
        `PID file at ${filePath} contains invalid PID: ${parsed.pid}`,
        { filePath, parsed }
      );
    }

    return parsed as ProcessMetadata;
  } catch (err: any) {
    if (err instanceof SafetyViolationError) {
      throw err;
    }
    throw new SafetyViolationError(
      'INVALID_PID_METADATA',
      `Failed to parse PID metadata file at ${filePath}: ${err.message}`,
      { filePath }
    );
  }
}

/**
 * Lists all registered demo process metadata files in .demo-data/pids/.
 */
export function listDemoProcesses(repoRoot?: string): ProcessMetadata[] {
  const dir = getPidMetadataDir(repoRoot);
  if (!existsSync(dir)) {
    return [];
  }

  const entries = readdirSync(dir);
  const results: ProcessMetadata[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    const serviceName = entry.slice(0, -5);
    try {
      const meta = readProcessMetadata(serviceName, repoRoot);
      if (meta) {
        results.push(meta);
      }
    } catch {
      // Ignore corrupted entries in listing or collect valid ones
    }
  }

  return results;
}

/**
 * Removes the metadata file for a service.
 */
export function removeProcessMetadata(service: string, repoRoot?: string): boolean {
  const filePath = getServicePidFilePath(service, repoRoot);
  if (existsSync(filePath)) {
    validateDemoDataPath(filePath, repoRoot);
    unlinkSync(filePath);
    return true;
  }
  return false;
}

/**
 * Checks if a process with a given PID is alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    // Sending signal 0 tests whether the process exists without killing it
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM'; // Exists but no permission to signal
  }
}

/**
 * Validates ownership before teardown and generates a safe teardown plan.
 * Does NOT execute process killing in Phase 0.
 */
export function planProcessTeardown(service: string, repoRoot?: string): ProcessTeardownPlan {
  const filePath = getServicePidFilePath(service, repoRoot);

  if (!existsSync(filePath)) {
    return {
      service,
      pid: -1,
      metadataPath: filePath,
      canTerminate: false,
      reason: 'No metadata file found for this service',
    };
  }

  try {
    const meta = readProcessMetadata(service, repoRoot);
    if (!meta) {
      return {
        service,
        pid: -1,
        metadataPath: filePath,
        canTerminate: false,
        reason: 'Metadata could not be loaded',
      };
    }

    if (meta.owner !== DEMO_OWNERSHIP_TAG) {
      return {
        service,
        pid: meta.pid,
        metadataPath: filePath,
        canTerminate: false,
        reason: `Ownership mismatch: expected "${DEMO_OWNERSHIP_TAG}", found "${meta.owner}"`,
      };
    }

    const alive = isProcessAlive(meta.pid);

    return {
      service,
      pid: meta.pid,
      metadataPath: filePath,
      canTerminate: true,
      reason: alive ? 'Valid enkeep-demo process ready for teardown' : 'Process already stopped',
    };
  } catch (err: any) {
    return {
      service,
      pid: -1,
      metadataPath: filePath,
      canTerminate: false,
      reason: `Safety verification error: ${err.message}`,
    };
  }
}

/**
 * Validates Docker container name against enkeep-demo prefix.
 */
export function validateDockerContainerName(name: string): void {
  if (!name || typeof name !== 'string') {
    throw new SafetyViolationError(
      'UNVERIFIED_CONTAINER_OWNERSHIP',
      'Docker container name must be a non-empty string.'
    );
  }

  if (!name.startsWith(DEMO_DOCKER_CONTAINER_PREFIX)) {
    throw new SafetyViolationError(
      'UNVERIFIED_CONTAINER_OWNERSHIP',
      `Docker container name "${name}" does not match required prefix "${DEMO_DOCKER_CONTAINER_PREFIX}". ` +
      `Only containers created by enkeep demo can be inspected or managed.`,
      { name, requiredPrefix: DEMO_DOCKER_CONTAINER_PREFIX }
    );
  }
}

/**
 * Validates Docker container labels against enkeep-demo ownership.
 */
export function validateDockerLabels(labels: Record<string, string>): void {
  if (!labels || typeof labels !== 'object') {
    throw new SafetyViolationError(
      'UNVERIFIED_CONTAINER_OWNERSHIP',
      'Docker container labels must be provided as an object.'
    );
  }

  const labelVal = labels[DEMO_DOCKER_LABEL_KEY];
  if (labelVal !== DEMO_DOCKER_LABEL_VALUE) {
    throw new SafetyViolationError(
      'UNVERIFIED_CONTAINER_OWNERSHIP',
      `Docker container missing required label "${DEMO_DOCKER_LABEL_KEY}=${DEMO_DOCKER_LABEL_VALUE}". Found: "${labelVal}".`,
      { labels, requiredLabel: `${DEMO_DOCKER_LABEL_KEY}=${DEMO_DOCKER_LABEL_VALUE}` }
    );
  }
}

/**
 * Validates full container metadata.
 */
export function validateContainerMetadata(container: ContainerMetadata): void {
  validateDockerContainerName(container.name);
  validateDockerLabels(container.labels);
}
