/**
 * Safe Docker Client Wrapper for Enkeep
 *
 * Strictly enforces container name regex (`^enkeep-demo-[a-zA-Z0-9][a-zA-Z0-9_-]{0,60}$`),
 * volume name regex (`^enkeep-demo-dsh-[a-zA-Z0-9][a-zA-Z0-9_-]{0,60}$`),
 * mandatory labels (`app=enkeep-demo`, `enkeep.user`, `enkeep.run-id`, `enkeep.volume-id`),
 * exact full lower64-hex containerId verification, stable volumeId tracking,
 * non-root execution (`1000:1000`), zero-network mode (`--network none`),
 * container hardening (`--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--tmpfs /tmp`, `--pids-limit 1..256`),
 * single volume mount at `/home/dsh`, collision non-adoption, anchored inspect error discrimination,
 * pre- and post-action verification across all operations, bounded stream execution, and volume rollback on failures.
 *
 * PROHIBITIONS:
 * - NO docker system/volume prune or broad cleanup.
 * - NO killing/stopping untracked, mismatched, or non-demo containers.
 * - NO adopting existing colliding containers/volumes.
 * - NO executing commands in containers without verified 64-hex containerId and ownership.
 *
 * @module @enkeep/runtime-runner/docker/client
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DEMO_CONTAINER_PREFIX,
  DEMO_VOLUME_PREFIX,
  DEMO_LABEL_KEY,
  DEMO_LABEL_VALUE,
  USER_LABEL_KEY,
  RUN_ID_LABEL_KEY,
  VOLUME_ID_LABEL_KEY,
  CONTAINER_NAME_REGEX,
  VOLUME_NAME_REGEX,
  USER_ID_REGEX,
  is64HexContainerId,
  validateContainerSpec,
  isRecord,
  DockerOwnershipError,
  DockerCollisionError,
  DockerDaemonError,
  DockerNotFoundError,
  DockerProtocolError,
} from '../spec/validator.js';
import type { RuntimeContainerSpec, RunContainerResult } from '../spec/types.js';
import type { ExecCliRequest, ExecCliEnvelope } from '../runtime/exec-cli.js';
import type { FileOperationResult, FileListEntry, FileOpType } from '../runtime/file-ops.js';
import type { RuntimeMountSpec } from '../spec/types.js';
import type { PluginReadinessStatus } from '../transport/types.js';

const execFileAsync = promisify(execFile);

export const IMAGE_TAG_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,127}$/;

export interface DockerContainerMount {
  type: string;
  name?: string;
  source?: string;
  destination: string;
  mode?: string;
  rw?: boolean;
}

export interface DockerContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  user?: string;
  networkMode?: string;
  readonlyRootfs?: boolean;
  capDrop?: string[];
  securityOpt?: string[];
  pidsLimit?: number;
  portBindings?: Record<string, unknown> | null;
  mounts?: DockerContainerMount[];
  tmpfs?: Record<string, string> | null;
  labels: Record<string, string>;
}

export interface DockerVolumeInfo {
  name: string;
  labels: Record<string, string>;
}

export interface OwnershipExpectation {
  containerName: string;
  userId: string;
  /** Mandatory unique run identifier for safe ownership verification */
  runId: string;
  /** Mandatory full 64-hex container identifier for exact instance matching */
  containerId: string;
  /** Mandatory volume name matching container mount */
  volumeName: string;
  /** Mandatory stable volume identifier */
  volumeId: string;
  /** Mandatory container mount destination path (must be '/home/dsh') */
  containerPath: string;
  /** Controlled host mounts */
  mounts?: readonly RuntimeMountSpec[];
}

export interface VolumeOwnershipExpectation {
  volumeName: string;
  userId: string;
  /** Mandatory stable volume identifier */
  volumeId: string;
}

export const DEFAULT_EXEC_MAX_INPUT_BYTES = 1024 * 1024; // 1 MiB for standard exec envelope
export const DEFAULT_EXEC_MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MiB for standard exec output
export const SEED_IMPORT_MAX_INPUT_BYTES = 64 * 1024 * 1024; // 64 MiB for large session seed imports
export const HEALTH_EXEC_MAX_INPUT_BYTES = 64 * 1024; // 64 KiB for lightweight health check
export const HEALTH_EXEC_MAX_OUTPUT_BYTES = 64 * 1024; // 64 KiB for lightweight health response

export interface ExecOwnedOptions {
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxInputBytes?: number;
  cliPath?: string;
}

export interface LongRunningExecHandle {
  readonly pid: number | undefined;
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  readonly exitPromise: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  kill(signal?: NodeJS.Signals): void;
}

/**
 * Derives canonical path segment encoding for session directory.
 */
export function encodeSessionSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
    }
  }
  return out;
}

/**
 * Derives canonical project directory key according to DSH persistence rules.
 */
export function projectKey(cwd: string): string {
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root';
  return `--${slug.slice(0, 251)}--`;
}

/**
 * Safely extracts error message or stderr without relying on unsafe type assertions.
 * Returns fixed generic text or empty string when no safe string representation exists.
 */
export function getErrorMessage(err: unknown): string {
  if (isRecord(err)) {
    if (typeof err.stderr === 'string' && err.stderr.trim()) {
      return err.stderr.trim();
    }
    if (Buffer.isBuffer(err.stderr) && err.stderr.length > 0) {
      return err.stderr.toString('utf8').trim();
    }
    if (typeof err.message === 'string' && err.message.trim()) {
      return err.message.trim();
    }
  }
  return typeof err === 'string' ? err : 'Docker execution error';
}

/**
 * Checks if a Docker CLI error specifically indicates that the target resource was not found.
 * Strictly parses anchored CLI stderr/message matching exact identifier.
 */
export function isExactNotFoundError(errorMessage: string, resourceIdentifier: string): boolean {
  if (!errorMessage || !resourceIdentifier || typeof errorMessage !== 'string' || typeof resourceIdentifier !== 'string') {
    return false;
  }

  const raw = errorMessage.trim();
  const escaped = resourceIdentifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const patterns = [
    new RegExp(`(?:^|\\n)(?:Error(?: response from daemon)?:\\s*)?No such (?:container|volume|object|image):\\s*${escaped}\\s*$`, 'i'),
    new RegExp(`(?:^|\\n)(?:Error:\\s*)?no such (?:container|volume|object|image):\\s*${escaped}\\s*$`, 'i'),
    new RegExp(`(?:^|\\n)Error response from daemon:\\s*get\\s+${escaped}:\\s*no such volume\\s*$`, 'i'),
  ];

  return patterns.some((p) => p.test(raw));
}

/**
 * Checks if a Docker CLI error specifically indicates that a container name collides with an existing container.
 * Strictly parses anchored Docker daemon conflict errors.
 */
export function isContainerCollisionError(errorMessage: string, containerName: string): boolean {
  if (!errorMessage || !containerName || typeof errorMessage !== 'string' || typeof containerName !== 'string') {
    return false;
  }
  const raw = errorMessage.trim();
  const escaped = containerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`(?:^|\\n)Error response from daemon:\\s*Conflict\\.\\s*The (?:container )?name\\s*["']?/?${escaped}["']?\\s*is already in use by container\\b`, 'i'),
    new RegExp(`(?:^|\\n)Error response from daemon:\\s*Conflict,\\s*the name\\s*["']?/?${escaped}["']?\\s*is already in use\\b`, 'i'),
    new RegExp(`(?:^|\\n)Error response from daemon:\\s*container\\s*["']?/?${escaped}["']?\\s*already exists\\b`, 'i'),
    new RegExp(`(?:^|\\n)Error:\\s*Conflict\\.\\s*The (?:container )?name\\s*["']?/?${escaped}["']?\\s*is already in use\\b`, 'i'),
  ];
  return patterns.some((p) => p.test(raw));
}

/**
 * Checks if a Docker CLI error specifically indicates that a volume name collides with an existing volume.
 * Strictly parses anchored Docker daemon volume conflict errors.
 */
export function isVolumeCollisionError(errorMessage: string, volumeName: string): boolean {
  if (!errorMessage || !volumeName || typeof errorMessage !== 'string' || typeof volumeName !== 'string') {
    return false;
  }
  const raw = errorMessage.trim();
  const escaped = volumeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`(?:^|\\n)Error response from daemon:\\s*(?:create )?${escaped}:\\s*volume already exists\\b`, 'i'),
    new RegExp(`(?:^|\\n)Error response from daemon:\\s*volume already exists:\\s*${escaped}\\b`, 'i'),
    new RegExp(`(?:^|\\n)Error:\\s*(?:create )?${escaped}:\\s*volume already exists\\b`, 'i'),
    new RegExp(`(?:^|\\n)Error:\\s*volume already exists:\\s*${escaped}\\b`, 'i'),
  ];
  return patterns.some((p) => p.test(raw));
}

/**
 * Validates canonical tmpfs options for /tmp (rw,noexec,nosuid,nodev,size=64m).
 */
export function validateCanonicalTmpfsOptions(optionsStr: string): boolean {
  if (typeof optionsStr !== 'string' || !optionsStr.trim()) {
    return false;
  }

  const tokens = optionsStr
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (tokens.length !== 5) {
    return false;
  }

  if (!tokens.includes('rw')) return false;
  if (!tokens.includes('noexec')) return false;
  if (!tokens.includes('nosuid')) return false;
  if (!tokens.includes('nodev')) return false;

  const sizeToken = tokens.find((t) => t.startsWith('size='));
  if (!sizeToken) return false;

  const sizeVal = sizeToken.slice('size='.length).trim();
  let bytes = -1;
  if (/^\d+$/.test(sizeVal)) {
    bytes = parseInt(sizeVal, 10);
  } else if (/^\d+m$/i.test(sizeVal)) {
    bytes = parseInt(sizeVal, 10) * 1024 * 1024;
  } else if (/^\d+k$/i.test(sizeVal)) {
    bytes = parseInt(sizeVal, 10) * 1024;
  } else if (/^\d+g$/i.test(sizeVal)) {
    bytes = parseInt(sizeVal, 10) * 1024 * 1024 * 1024;
  }

  // 64MB = 67,108,864 bytes
  return bytes === 67108864;
}

/**
 * Strictly parses and validates Docker inspect JSON output with runtime schema guards.
 */
export function parseDockerContainerInspect(rawJson: string): DockerContainerInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (_err: unknown) {
    throw new DockerDaemonError('Docker inspect returned invalid JSON structure');
  }

  if (!isRecord(parsed)) {
    throw new DockerDaemonError('Docker inspect returned non-object JSON structure');
  }

  if (typeof parsed.id !== 'string' || !parsed.id.trim()) {
    throw new DockerDaemonError('Docker inspect returned missing or empty ID');
  }
  if (typeof parsed.name !== 'string' || !parsed.name.trim()) {
    throw new DockerDaemonError('Docker inspect returned missing or empty name');
  }
  if (typeof parsed.image !== 'string') {
    throw new DockerDaemonError('Docker inspect returned missing image property');
  }
  if (typeof parsed.status !== 'string' || typeof parsed.state !== 'string') {
    throw new DockerDaemonError('Docker inspect returned missing state or status');
  }

  const id = parsed.id.toLowerCase();
  const name = parsed.name.replace(/^\//, '');
  const image = parsed.image;
  const status = parsed.status;
  const state = parsed.state;
  const user = typeof parsed.user === 'string' ? parsed.user : undefined;
  const networkMode = typeof parsed.networkMode === 'string' ? parsed.networkMode : undefined;
  const readonlyRootfs = typeof parsed.readonlyRootfs === 'boolean' ? parsed.readonlyRootfs : undefined;
  let capDrop: string[] | undefined;
  if (!Array.isArray(parsed.capDrop)) {
    capDrop = undefined;
  } else {
    for (const c of parsed.capDrop) {
      if (typeof c !== 'string') {
        throw new DockerDaemonError('Docker inspect returned non-string element in capDrop');
      }
    }
    capDrop = [...parsed.capDrop];
  }

  let securityOpt: string[] | undefined;
  if (!Array.isArray(parsed.securityOpt)) {
    securityOpt = undefined;
  } else {
    for (const s of parsed.securityOpt) {
      if (typeof s !== 'string') {
        throw new DockerDaemonError('Docker inspect returned non-string element in securityOpt');
      }
    }
    securityOpt = [...parsed.securityOpt];
  }
  const pidsLimit = typeof parsed.pidsLimit === 'number' ? parsed.pidsLimit : undefined;

  // Canonical logical portBindings: Docker inspect returns {} when no port bindings are configured.
  // Normalize empty object {} to null to represent canonical zero published port bindings.
  let portBindings: Record<string, unknown> | null = null;
  if (parsed.portBindings === null) {
    portBindings = null;
  } else if (isRecord(parsed.portBindings)) {
    if (Object.keys(parsed.portBindings).length === 0) {
      portBindings = null;
    } else {
      portBindings = parsed.portBindings;
    }
  } else if (parsed.portBindings !== undefined) {
    throw new DockerDaemonError('Docker inspect returned invalid PortBindings structure');
  }

  let mounts: DockerContainerMount[] | undefined;
  if (Array.isArray(parsed.mounts)) {
    mounts = parsed.mounts.map((m: unknown) => {
      if (!isRecord(m)) {
        throw new DockerDaemonError('Docker inspect returned invalid Mounts element');
      }
      return {
        type: typeof m.Type === 'string' ? m.Type : typeof m.type === 'string' ? m.type : '',
        name: typeof m.Name === 'string' ? m.Name : typeof m.name === 'string' ? m.name : undefined,
        source: typeof m.Source === 'string' ? m.Source : typeof m.source === 'string' ? m.source : undefined,
        destination: typeof m.Destination === 'string' ? m.Destination : typeof m.destination === 'string' ? m.destination : '',
        mode: typeof m.Mode === 'string' ? m.Mode : typeof m.mode === 'string' ? m.mode : undefined,
        rw: typeof m.RW === 'boolean' ? m.RW : typeof m.rw === 'boolean' ? m.rw : undefined,
      };
    });
  }

  let tmpfs: Record<string, string> | null = null;
  if (parsed.tmpfs === null) {
    tmpfs = null;
  } else if (isRecord(parsed.tmpfs)) {
    tmpfs = {};
    for (const [k, v] of Object.entries(parsed.tmpfs)) {
      if (typeof v === 'string') {
        tmpfs[k] = v;
      }
    }
  }

  const labels: Record<string, string> = {};
  if (isRecord(parsed.labels)) {
    for (const [k, v] of Object.entries(parsed.labels)) {
      if (typeof v === 'string') {
        labels[k] = v;
      }
    }
  }

  return {
    id,
    name,
    image,
    status,
    state,
    user,
    networkMode,
    readonlyRootfs,
    capDrop,
    securityOpt,
    pidsLimit,
    portBindings,
    mounts,
    tmpfs,
    labels,
  };
}

/**
 * Strictly parses and validates Docker volume inspect JSON output.
 */
function parseDockerVolumeInspect(rawJson: string): DockerVolumeInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (_err: unknown) {
    throw new DockerDaemonError('Docker volume inspect returned invalid JSON structure');
  }

  if (!isRecord(parsed)) {
    throw new DockerDaemonError('Docker volume inspect returned non-object JSON structure');
  }

  if (typeof parsed.name !== 'string' || !parsed.name.trim()) {
    throw new DockerDaemonError('Docker volume inspect returned missing or empty name');
  }

  const labels: Record<string, string> = {};
  if (isRecord(parsed.labels)) {
    for (const [k, v] of Object.entries(parsed.labels)) {
      if (typeof v === 'string') {
        labels[k] = v;
      }
    }
  }

  return {
    name: parsed.name,
    labels,
  };
}

const CHECKSUM_HEX_64_LOWER_REGEX = /^[0-9a-f]{64}$/;

function isExecCliStatus(status: string): status is ExecCliEnvelope['status'] {
  return status === 'ok' || status === 'completed' || status === 'cancelled' || status === 'error' || status === 'idle';
}

function parseExecPlugins(raw: unknown): PluginReadinessStatus | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    throw new DockerDaemonError('Exec envelope plugins must be a valid JSON object when present');
  }

  const pluginKeys: Array<keyof PluginReadinessStatus> = [
    'receiptStore',
    'inbound',
    'eventRelay',
    'tools',
    'externalInteraction',
    'affinityPolicy',
    'llmAffinity',
  ];

  const result: Partial<PluginReadinessStatus> = {};
  for (const key of pluginKeys) {
    const val = raw[key];
    if (val !== undefined && typeof val !== 'boolean') {
      throw new DockerDaemonError('Exec envelope plugins properties must be boolean when present');
    }
    result[key] = typeof val === 'boolean' ? val : false;
  }

  return result as PluginReadinessStatus;
}

function parseExecReceipt(raw: unknown): NonNullable<ExecCliEnvelope['receipt']> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    throw new DockerDaemonError('Exec envelope receipt must be a valid JSON object when present');
  }

  if (raw.algorithm !== 'sha256-session-events-v1') {
    throw new DockerDaemonError('Exec envelope receipt has invalid algorithm');
  }

  if (typeof raw.checksum !== 'string' || !CHECKSUM_HEX_64_LOWER_REGEX.test(raw.checksum)) {
    throw new DockerDaemonError('Exec envelope receipt has invalid checksum');
  }

  if (typeof raw.canonicalBytes !== 'number' || !Number.isSafeInteger(raw.canonicalBytes) || raw.canonicalBytes < 0) {
    throw new DockerDaemonError('Exec envelope receipt has invalid canonicalBytes');
  }

  if (typeof raw.eventCount !== 'number' || !Number.isSafeInteger(raw.eventCount) || raw.eventCount < 0) {
    throw new DockerDaemonError('Exec envelope receipt has invalid eventCount');
  }

  return {
    algorithm: 'sha256-session-events-v1',
    checksum: raw.checksum,
    canonicalBytes: raw.canonicalBytes,
    eventCount: raw.eventCount,
  };
}

function parseFileResult(raw: unknown): FileOperationResult | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    throw new DockerDaemonError('Exec envelope fileResult must be a valid JSON object when present');
  }

  const op = raw.op;
  if (
    op !== 'list' &&
    op !== 'read' &&
    op !== 'write' &&
    op !== 'mkdir' &&
    op !== 'delete' &&
    op !== 'rename' &&
    op !== 'stat' &&
    op !== 'sniff' &&
    op !== 'copy' &&
    op !== 'stage' &&
    op !== 'commit_stage'
  ) {
    throw new DockerDaemonError('Exec envelope fileResult has invalid op');
  }

  if (typeof raw.space !== 'string' || !raw.space.trim()) {
    throw new DockerDaemonError('Exec envelope fileResult must have a non-empty space identifier');
  }

  if (typeof raw.path !== 'string') {
    throw new DockerDaemonError('Exec envelope fileResult must have a string path');
  }

  if (raw.newPath !== undefined && typeof raw.newPath !== 'string') {
    throw new DockerDaemonError('Exec envelope fileResult newPath must be a string when present');
  }

  if (raw.targetPath !== undefined && typeof raw.targetPath !== 'string') {
    throw new DockerDaemonError('Exec envelope fileResult targetPath must be a string when present');
  }

  let entries: FileListEntry[] | undefined;
  if (raw.entries !== undefined) {
    if (!Array.isArray(raw.entries)) {
      throw new DockerDaemonError('Exec envelope fileResult entries must be an array when present');
    }
    entries = raw.entries.map((e: unknown) => {
      if (!isRecord(e)) {
        throw new DockerDaemonError('Exec envelope fileResult entries element must be a valid JSON object');
      }
      if (typeof e.name !== 'string' || !e.name.trim()) {
        throw new DockerDaemonError('Exec envelope fileResult entry must have a non-empty name');
      }
      if (e.type !== 'file' && e.type !== 'directory' && e.type !== 'symlink' && e.type !== 'other') {
        throw new DockerDaemonError('Exec envelope fileResult entry has invalid type');
      }
      if (typeof e.size !== 'number' || !Number.isFinite(e.size) || e.size < 0) {
        throw new DockerDaemonError('Exec envelope fileResult entry must have a non-negative numeric size');
      }
      if (typeof e.mtimeMs !== 'number' || !Number.isFinite(e.mtimeMs) || e.mtimeMs < 0) {
        throw new DockerDaemonError('Exec envelope fileResult entry must have a non-negative numeric mtimeMs');
      }
      if (e.etag !== undefined && typeof e.etag !== 'string') {
        throw new DockerDaemonError('Exec envelope fileResult entry etag must be a string when present');
      }
      return {
        name: e.name,
        type: e.type as FileListEntry['type'],
        size: e.size,
        mtimeMs: e.mtimeMs,
        etag: e.etag as string | undefined,
      };
    });
  }

  if (raw.truncated !== undefined && typeof raw.truncated !== 'boolean') {
    throw new DockerDaemonError('Exec envelope fileResult truncated must be a boolean when present');
  }

  if (raw.content !== undefined && typeof raw.content !== 'string') {
    throw new DockerDaemonError('Exec envelope fileResult content must be a string when present');
  }

  if (raw.encoding !== undefined && raw.encoding !== 'utf8' && raw.encoding !== 'base64') {
    throw new DockerDaemonError('Exec envelope fileResult has invalid encoding');
  }

  if (raw.size !== undefined && (typeof raw.size !== 'number' || !Number.isFinite(raw.size) || raw.size < 0)) {
    throw new DockerDaemonError('Exec envelope fileResult size must be a non-negative number when present');
  }

  if (raw.mtimeMs !== undefined && (typeof raw.mtimeMs !== 'number' || !Number.isFinite(raw.mtimeMs) || raw.mtimeMs < 0)) {
    throw new DockerDaemonError('Exec envelope fileResult mtimeMs must be a non-negative number when present');
  }

  if (raw.etag !== undefined && typeof raw.etag !== 'string') {
    throw new DockerDaemonError('Exec envelope fileResult etag must be a string when present');
  }

  if (raw.written !== undefined && typeof raw.written !== 'boolean') {
    throw new DockerDaemonError('Exec envelope fileResult written must be a boolean when present');
  }

  if (raw.created !== undefined && typeof raw.created !== 'boolean') {
    throw new DockerDaemonError('Exec envelope fileResult created must be a boolean when present');
  }

  if (raw.deleted !== undefined && typeof raw.deleted !== 'boolean') {
    throw new DockerDaemonError('Exec envelope fileResult deleted must be a boolean when present');
  }

  if (raw.renamed !== undefined && typeof raw.renamed !== 'boolean') {
    throw new DockerDaemonError('Exec envelope fileResult renamed must be a boolean when present');
  }

  return {
    op: op as FileOpType,
    space: raw.space,
    path: raw.path,
    type: raw.type as 'file' | 'directory' | undefined,
    targetPath: (raw.targetPath ?? raw.newPath) as string | undefined,
    entries,
    truncated: raw.truncated as boolean | undefined,
    content: raw.content as string | undefined,
    encoding: raw.encoding as 'utf8' | 'base64' | undefined,
    size: raw.size as number | undefined,
    mtimeMs: raw.mtimeMs as number | undefined,
    etag: raw.etag as string | undefined,
    headerBytesBase64: raw.headerBytesBase64 as string | undefined,
    stageToken: raw.stageToken as string | undefined,
    sha256: raw.sha256 as string | undefined,
    written: raw.written as boolean | undefined,
    created: raw.created as boolean | undefined,
    deleted: raw.deleted as boolean | undefined,
    renamed: raw.renamed as boolean | undefined,
  };
}

function parseExecUsage(raw: unknown): { totalTokens: number } | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!isRecord(raw)) {
    throw new DockerDaemonError('Exec envelope usage must be an object when present');
  }
  if (
    raw.totalTokens !== undefined &&
    (typeof raw.totalTokens !== 'number' || !Number.isSafeInteger(raw.totalTokens) || raw.totalTokens < 0)
  ) {
    throw new DockerDaemonError('Exec envelope usage totalTokens must be a non-negative safe integer when present');
  }
  if (typeof raw.totalTokens === 'number') {
    return { totalTokens: raw.totalTokens };
  }
  return undefined;
}

/**
 * Strictly parses and validates in-container Exec CLI envelope JSON.
 */
export function parseExecEnvelope(rawJson: string): ExecCliEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson.trim());
  } catch (_err: unknown) {
    throw new DockerDaemonError('Failed to parse Exec envelope');
  }

  if (!isRecord(parsed)) {
    throw new DockerDaemonError('Exec envelope is not a valid JSON object');
  }

  const status = typeof parsed.status === 'string' ? parsed.status : '';
  if (!isExecCliStatus(status)) {
    throw new DockerDaemonError('Exec envelope has invalid status');
  }

  // Type validation for optional string fields
  if (parsed.code !== undefined && typeof parsed.code !== 'string') {
    throw new DockerDaemonError('Exec envelope code must be a string when present');
  }
  if (parsed.requestId !== undefined && typeof parsed.requestId !== 'string') {
    throw new DockerDaemonError('Exec envelope requestId must be a string when present');
  }
  if (parsed.turnId !== undefined && typeof parsed.turnId !== 'string') {
    throw new DockerDaemonError('Exec envelope turnId must be a string when present');
  }
  if (parsed.sessionId !== undefined && typeof parsed.sessionId !== 'string') {
    throw new DockerDaemonError('Exec envelope sessionId must be a string when present');
  }
  if (parsed.userId !== undefined && (typeof parsed.userId !== 'string' || !parsed.userId.trim())) {
    throw new DockerDaemonError('Exec envelope userId must be a non-empty string when present');
  }
  if (parsed.version !== undefined && (typeof parsed.version !== 'string' || !parsed.version.trim())) {
    throw new DockerDaemonError('Exec envelope version must be a non-empty string when present');
  }
  if (
    parsed.modelProvider !== undefined &&
    (typeof parsed.modelProvider !== 'string' ||
      parsed.modelProvider.length === 0 ||
      parsed.modelProvider !== parsed.modelProvider.trim() ||
      parsed.modelProvider !== parsed.modelProvider.normalize('NFC'))
  ) {
    throw new DockerDaemonError('Exec envelope modelProvider must be a valid non-empty string when present');
  }
  if (
    parsed.toolsUnavailableReason !== undefined &&
    parsed.toolsUnavailableReason !== null &&
    typeof parsed.toolsUnavailableReason !== 'string'
  ) {
    throw new DockerDaemonError('Exec envelope toolsUnavailableReason must be a string or null when present');
  }
  if (parsed.replyText !== undefined && typeof parsed.replyText !== 'string') {
    throw new DockerDaemonError('Exec envelope replyText must be a string when present');
  }
  if (parsed.error !== undefined && typeof parsed.error !== 'string') {
    throw new DockerDaemonError('Exec envelope error must be a string when present');
  }

  // Type validation for optional boolean fields
  if (parsed.exists !== undefined && typeof parsed.exists !== 'boolean') {
    throw new DockerDaemonError('Exec envelope exists must be a boolean when present');
  }
  if (parsed.valid !== undefined && typeof parsed.valid !== 'boolean') {
    throw new DockerDaemonError('Exec envelope valid must be a boolean when present');
  }
  if (parsed.checksum !== undefined && typeof parsed.checksum !== 'string') {
    throw new DockerDaemonError('Exec envelope checksum must be a string when present');
  }
  if (parsed.events !== undefined && !Array.isArray(parsed.events)) {
    throw new DockerDaemonError('Exec envelope events must be an array when present');
  }
  if (parsed.dshReady !== undefined && typeof parsed.dshReady !== 'boolean') {
    throw new DockerDaemonError('Exec envelope dshReady must be a boolean when present');
  }
  if (parsed.enkeepBundleLoaded !== undefined && typeof parsed.enkeepBundleLoaded !== 'boolean') {
    throw new DockerDaemonError('Exec envelope enkeepBundleLoaded must be a boolean when present');
  }
  if (parsed.toolsOperational !== undefined && typeof parsed.toolsOperational !== 'boolean') {
    throw new DockerDaemonError('Exec envelope toolsOperational must be a boolean when present');
  }
  if (parsed.persisted !== undefined && typeof parsed.persisted !== 'boolean') {
    throw new DockerDaemonError('Exec envelope persisted must be a boolean when present');
  }
  if (parsed.duplicate !== undefined && typeof parsed.duplicate !== 'boolean') {
    throw new DockerDaemonError('Exec envelope duplicate must be a boolean when present');
  }

  // Type validation for optional numeric fields
  if (
    parsed.toolsCount !== undefined &&
    (typeof parsed.toolsCount !== 'number' || !Number.isSafeInteger(parsed.toolsCount) || parsed.toolsCount < 0)
  ) {
    throw new DockerDaemonError('Exec envelope toolsCount must be a non-negative safe integer when present');
  }
  if (
    parsed.uptimeSeconds !== undefined &&
    (typeof parsed.uptimeSeconds !== 'number' || !Number.isFinite(parsed.uptimeSeconds) || parsed.uptimeSeconds < 0)
  ) {
    throw new DockerDaemonError('Exec envelope uptimeSeconds must be a non-negative number when present');
  }
  if (
    parsed.eventsCount !== undefined &&
    (typeof parsed.eventsCount !== 'number' || !Number.isSafeInteger(parsed.eventsCount) || parsed.eventsCount < 0)
  ) {
    throw new DockerDaemonError('Exec envelope eventsCount must be a non-negative safe integer when present');
  }
  if (
    parsed.totalEvents !== undefined &&
    (typeof parsed.totalEvents !== 'number' || !Number.isSafeInteger(parsed.totalEvents) || parsed.totalEvents < 0)
  ) {
    throw new DockerDaemonError('Exec envelope totalEvents must be a non-negative safe integer when present');
  }

  const receipt = parseExecReceipt(parsed.receipt);
  const plugins = parseExecPlugins(parsed.plugins);

  return {
    status,
    code: parsed.code as string | undefined,
    requestId: parsed.requestId as string | undefined,
    turnId: parsed.turnId as string | undefined,
    sessionId: parsed.sessionId as string | undefined,
    userId: parsed.userId as string | undefined,
    exists: parsed.exists as boolean | undefined,
    valid: parsed.valid as boolean | undefined,
    checksum: parsed.checksum as string | undefined,
    dshReady: parsed.dshReady as boolean | undefined,
    enkeepBundleLoaded: parsed.enkeepBundleLoaded as boolean | undefined,
    plugins,
    toolsCount: parsed.toolsCount as number | undefined,
    toolsOperational: parsed.toolsOperational as boolean | undefined,
    toolsUnavailableReason: parsed.toolsUnavailableReason as string | undefined,
    version: parsed.version as string | undefined,
    modelProvider: parsed.modelProvider as string | undefined,
    uptimeSeconds: parsed.uptimeSeconds as number | undefined,
    replyText: parsed.replyText as string | undefined,
    events: Array.isArray(parsed.events) ? parsed.events : undefined,
    eventsCount: parsed.eventsCount as number | undefined,
    totalEvents: parsed.totalEvents as number | undefined,
    boundaryMapping: isRecord(parsed.boundaryMapping) ? (parsed.boundaryMapping as Record<string, unknown>) : undefined,
    persisted: parsed.persisted as boolean | undefined,
    receipt,
    duplicate: parsed.duplicate as boolean | undefined,
    error: parsed.error as string | undefined,
    fileResult: parseFileResult(parsed.fileResult),
    usage: parseExecUsage(parsed.usage),
  };
}

export class SafeDockerClient {
  constructor(private readonly dockerBin: string = 'docker') {}

  /**
   * Checks if Docker daemon is accessible.
   */
  async isDockerAvailable(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(this.dockerBin, ['version', '--format', '{{.Server.Version}}']);
      return stdout.trim().length > 0;
    } catch (_err: unknown) {
      return false;
    }
  }

  /**
   * Asserts container name matches strict regex.
   */
  public assertSafeContainerName(name: string): void {
    if (!name || typeof name !== 'string' || !CONTAINER_NAME_REGEX.test(name)) {
      throw new DockerOwnershipError('Container name must match required pattern without forbidden characters');
    }
  }

  /**
   * Asserts volume name matches strict regex.
   */
  public assertSafeVolumeName(name: string): void {
    if (!name || typeof name !== 'string' || !VOLUME_NAME_REGEX.test(name)) {
      throw new DockerOwnershipError('Volume name must match required pattern without forbidden characters');
    }
  }

  /**
   * Spawns a bounded Docker process execution with strict timeout reaping, output byte capping,
   * input byte capping before spawn, safe stream error tracking, and single-settlement reaping on the close event.
   */
  public async spawnBoundedExec(
    containerId: string,
    commandArgs: readonly string[],
    stdinPayload: string | null,
    timeoutMs: number,
    maxOutputBytes: number,
    maxInputBytes: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (typeof maxInputBytes !== 'number' || !Number.isFinite(maxInputBytes) || maxInputBytes < 0) {
      throw new DockerProtocolError(`Invalid maxInputBytes limit: ${maxInputBytes}`);
    }
    if (typeof maxOutputBytes !== 'number' || !Number.isFinite(maxOutputBytes) || maxOutputBytes < 0) {
      throw new DockerDaemonError(`Invalid maxOutputBytes limit: ${maxOutputBytes}`);
    }

    const payloadWithNewline = stdinPayload !== null ? stdinPayload + '\n' : null;
    const inputBytes = payloadWithNewline !== null ? Buffer.byteLength(payloadWithNewline, 'utf8') : 0;

    if (inputBytes > maxInputBytes) {
      throw new DockerProtocolError(
        `Exec stdin payload byte length (${inputBytes} bytes) exceeds maximum input limit (${maxInputBytes} bytes)`
      );
    }

    return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let totalBytes = 0;
      let timedOut = false;
      let bytesExceeded = false;
      let epipeOccurred = false;
      let settled = false;
      let proc: ReturnType<typeof spawn> | null = null;
      let timer: NodeJS.Timeout | null = null;
      let killError: Error | null = null;
      let stdinError: Error | null = null;
      let spawnError: Error | null = null;

      const safeSettle = (err?: Error, result?: { stdout: string; stderr: string; exitCode: number }) => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (err) {
          reject(err);
        } else if (result) {
          resolve(result);
        }
      };

      try {
        proc = spawn(this.dockerBin, ['exec', '-i', containerId, ...commandArgs], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (spawnErr: unknown) {
        safeSettle(new DockerDaemonError('Failed to spawn docker exec process', spawnErr));
        return;
      }

      const child = proc;
      if (!child) {
        safeSettle(new DockerDaemonError('Failed to initialize child process for docker exec'));
        return;
      }

      timer = setTimeout(() => {
        timedOut = true;
        if (!child.killed) {
          try {
            child.kill('SIGKILL');
          } catch (kErr: unknown) {
            if (isRecord(kErr) && kErr.code !== 'ESRCH') {
              killError = kErr instanceof Error ? kErr : new Error('Process termination error');
            }
          }
        }
      }, timeoutMs);

      if (child.stdout) {
        child.stdout.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > maxOutputBytes) {
            bytesExceeded = true;
            if (!child.killed) {
              try {
                child.kill('SIGKILL');
              } catch (kErr: unknown) {
                if (isRecord(kErr) && kErr.code !== 'ESRCH') {
                  killError = kErr instanceof Error ? kErr : new Error('Process termination error');
                }
              }
            }
            return;
          }
          stdout += chunk.toString('utf8');
        });
      }

      if (child.stderr) {
        child.stderr.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > maxOutputBytes) {
            bytesExceeded = true;
            if (!child.killed) {
              try {
                child.kill('SIGKILL');
              } catch (kErr: unknown) {
                if (isRecord(kErr) && kErr.code !== 'ESRCH') {
                  killError = kErr instanceof Error ? kErr : new Error('Process termination error');
                }
              }
            }
            return;
          }
          stderr += chunk.toString('utf8');
        });
      }

      if (child.stdin) {
        child.stdin.on('error', (err: unknown) => {
          if (isRecord(err) && err.code === 'EPIPE') {
            epipeOccurred = true;
            return;
          }
          stdinError = err instanceof Error ? err : new Error('Stdin stream error');
        });
      }

      child.on('error', (err: Error) => {
        spawnError = err;
        // Do not settle immediately; wait for close event to reap streams
      });

      child.on('close', (code) => {
        if (spawnError) {
          safeSettle(new DockerDaemonError('Docker exec process encountered an error', spawnError));
          return;
        }
        if (timedOut) {
          const primary = new DockerDaemonError('Docker exec timed out');
          if (killError) {
            safeSettle(new AggregateError([primary, killError], 'Docker exec timed out and termination failed'));
          } else {
            safeSettle(primary);
          }
          return;
        }
        if (bytesExceeded) {
          const primary = new DockerDaemonError('Docker exec output exceeded maximum limit');
          if (killError) {
            safeSettle(new AggregateError([primary, killError], 'Docker exec output exceeded limit and termination failed'));
          } else {
            safeSettle(primary);
          }
          return;
        }
        if (stdinError) {
          safeSettle(new DockerDaemonError('Docker exec stdin stream encountered an error', stdinError));
          return;
        }
        if (epipeOccurred) {
          if (code === 0) {
            safeSettle(new DockerProtocolError('Docker exec process exited cleanly (exit code 0) despite broken stdin pipe'));
          } else {
            safeSettle(new DockerDaemonError(`Docker exec stdin stream broken pipe (exit code ${code ?? 'unknown'})`));
          }
          return;
        }
        safeSettle(undefined, { stdout, stderr, exitCode: code ?? 0 });
      });

      if (child.stdin) {
        if (payloadWithNewline !== null) {
          child.stdin.end(payloadWithNewline, 'utf8', (err?: Error | null) => {
            if (err) {
              if (isRecord(err) && err.code === 'EPIPE') {
                epipeOccurred = true;
              } else if (!stdinError) {
                stdinError = err instanceof Error ? err : new Error(String(err));
              }
            }
          });
        } else {
          child.stdin.end();
        }
      }
    });
  }

  /**
   * Inspects a specific image and returns its ID after strict image tag validation.
   */
  async inspectImageExact(image: string): Promise<string> {
    if (!image || typeof image !== 'string' || !IMAGE_TAG_REGEX.test(image.trim())) {
      throw new DockerOwnershipError('Image inspection rejected: invalid image name/tag format');
    }
    const cleanImage = image.trim();
    try {
      const { stdout } = await execFileAsync(this.dockerBin, [
        'image',
        'inspect',
        '--format',
        '{{.Id}}',
        cleanImage,
      ]);
      const id = stdout.trim();
      if (!id) {
        throw new DockerNotFoundError('Docker image returned empty ID on inspect');
      }
      return id;
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      if (isExactNotFoundError(msg, cleanImage)) {
        throw new DockerNotFoundError('Docker image not found');
      }
      throw new DockerDaemonError('Failed to inspect Docker image', err);
    }
  }

  /**
   * Inspects a specific volume and retrieves its labels.
   * STRICT FAIL-CLOSED: Only returns null on genuine anchored "No such volume/object" error;
   * throws typed DockerDaemonError on all daemon, socket, parse, or permission errors.
   */
  async inspectVolume(volumeName: string): Promise<DockerVolumeInfo | null> {
    this.assertSafeVolumeName(volumeName);
    try {
      const format = '{"name":"{{.Name}}","labels":{{json .Labels}}}';
      const { stdout } = await execFileAsync(this.dockerBin, ['volume', 'inspect', '--format', format, volumeName]);
      return parseDockerVolumeInspect(stdout.trim());
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      if (isExactNotFoundError(msg, volumeName)) {
        return null;
      }
      throw new DockerDaemonError('Failed to inspect volume', err);
    }
  }

  /**
   * Verifies volume ownership labels against expected user and stable volume ID.
   */
  assertVolumeOwnership(info: DockerVolumeInfo, expectation: VolumeOwnershipExpectation): void {
    if (!expectation || typeof expectation !== 'object') {
      throw new DockerOwnershipError('VolumeOwnershipExpectation object is required.');
    }
    if (!expectation.userId || typeof expectation.userId !== 'string') {
      throw new DockerOwnershipError('VolumeOwnershipExpectation userId is required.');
    }
    if (!USER_ID_REGEX.test(expectation.userId)) {
      throw new DockerOwnershipError(
        'VolumeOwnershipExpectation userId must match pattern ^[a-z0-9][a-z0-9_-]{0,63}$'
      );
    }
    this.assertSafeVolumeName(info.name);
    this.assertSafeVolumeName(expectation.volumeName);

    if (info.name !== expectation.volumeName) {
      throw new DockerOwnershipError('Volume name mismatch');
    }

    const isExactUserVolume =
      info.name === `enkeep-demo-dsh-${expectation.userId}` ||
      info.name.startsWith(`enkeep-demo-dsh-${expectation.userId}-`);
    if (!isExactUserVolume) {
      throw new DockerOwnershipError('Volume is not scoped to user');
    }

    if (info.labels[DEMO_LABEL_KEY] !== DEMO_LABEL_VALUE) {
      throw new DockerOwnershipError('Volume lacks mandatory ownership label app=enkeep-demo');
    }

    if (info.labels[USER_LABEL_KEY] !== expectation.userId) {
      throw new DockerOwnershipError('Volume user mismatch');
    }

    if (!expectation.volumeId || typeof expectation.volumeId !== 'string' || expectation.volumeId.trim() === '') {
      throw new DockerOwnershipError('Volume ownership verification requires a non-empty volumeId.');
    }

    const actualVolId = info.labels[VOLUME_ID_LABEL_KEY];
    if (!actualVolId || actualVolId !== expectation.volumeId) {
      throw new DockerOwnershipError('Volume volume-id mismatch');
    }
  }

  /**
   * Creates a dedicated Docker volume.
   * STRICT FAIL-CLOSED: Refuses to adopt any existing volume; existing volume collision throws DockerCollisionError.
   */
  async createVolume(volumeName: string, expectation: VolumeOwnershipExpectation): Promise<void> {
    this.assertSafeVolumeName(volumeName);

    const existing = await this.inspectVolume(volumeName);
    if (existing) {
      throw new DockerCollisionError('Volume already exists on host. Creation refused.');
    }

    const args = [
      'volume',
      'create',
      '--label',
      `${DEMO_LABEL_KEY}=${DEMO_LABEL_VALUE}`,
      '--label',
      `${USER_LABEL_KEY}=${expectation.userId}`,
      '--label',
      `${VOLUME_ID_LABEL_KEY}=${expectation.volumeId}`,
      volumeName,
    ];

    try {
      await execFileAsync(this.dockerBin, args);
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      if (isVolumeCollisionError(msg, volumeName)) {
        throw new DockerCollisionError('Volume already exists on host. Creation refused.');
      }
      throw new DockerDaemonError('Failed to create volume', err);
    }
  }

  /**
   * Verifies existing volume ownership for reconnect operations.
   */
  async connectVolume(volumeName: string, expectation: VolumeOwnershipExpectation): Promise<void> {
    this.assertSafeVolumeName(volumeName);
    const existing = await this.inspectVolume(volumeName);
    if (!existing) {
      throw new DockerNotFoundError('Volume not found for reconnection');
    }
    this.assertVolumeOwnership(existing, expectation);
  }

  /**
   * Executes hardened docker run arguments.
   */
  private async executeDockerRun(spec: RuntimeContainerSpec): Promise<string> {
    const args: string[] = [
      'run',
      '-d',
      '--name',
      spec.containerName,
      '--user',
      spec.user, // Mandatory non-root user ('1000:1000')
      '--workdir',
      spec.workingDir, // Mandatory '/home/dsh'
      '--network',
      spec.networkMode, // Strict zero-network enforcement ('none')
      '--read-only', // Hardening: read-only rootfs
      '--cap-drop',
      'ALL', // Hardening: drop all Linux capabilities
      '--security-opt',
      'no-new-privileges:true', // Hardening: no new privileges (canonical)
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=64m', // Hardening: restricted tmpfs
      '--pids-limit',
      '256', // Hardening: limit pids to prevent fork bombs
    ];

    // Dedicated working writable volume mount
    args.push('-v', `${spec.volume.volumeName}:${spec.volume.containerPath}`);

    // Controlled host bind mounts to /home/dsh/mounts/<mountId>
    if (Array.isArray(spec.mounts)) {
      for (const mount of spec.mounts) {
        args.push('-v', `${mount.sourcePath}:/home/dsh/mounts/${mount.id}:${mount.mode}`);
      }
    }

    // Mandatory and user labels (including runId and volumeId)
    for (const [k, v] of Object.entries(spec.labels)) {
      args.push('--label', `${k}=${v}`);
    }

    // Environment variables
    for (const [k, v] of Object.entries(spec.environment)) {
      args.push('-e', `${k}=${v}`);
    }

    // Image
    args.push(spec.image);

    const res = await execFileAsync(this.dockerBin, args);
    return res.stdout;
  }

  /**
   * Runs a new container using the validated RuntimeContainerSpec with full hardening.
   * Strictly enforces --user 1000:1000, --read-only, --cap-drop ALL, --security-opt no-new-privileges,
   * --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m, --pids-limit 256, --network none.
   * On any creation failure or malformed ID: rolls back the created volume, refuses name cleanup without verified ID,
   * and immediately inspects and asserts container ownership post-creation with cleanup on mismatch.
   */
  async runContainer(spec: RuntimeContainerSpec): Promise<RunContainerResult> {
    const validation = validateContainerSpec(spec);
    if (!validation.valid) {
      throw new DockerOwnershipError('Cannot run container: Spec validation failed');
    }

    this.assertSafeContainerName(spec.containerName);
    this.assertSafeVolumeName(spec.volume.volumeName);

    // Collision check: If container with this name already exists, refuse to run
    const existing = await this.inspectContainer(spec.containerName);
    if (existing) {
      throw new DockerCollisionError('Container already exists on host. Creation refused.');
    }

    // 1. Create fresh volume (fails closed if volume already exists)
    await this.createVolume(spec.volume.volumeName, {
      volumeName: spec.volume.volumeName,
      userId: spec.userId,
      volumeId: spec.volume.volumeId,
    });

    let stdout = '';
    try {
      stdout = await this.executeDockerRun(spec);
    } catch (err: unknown) {
      // Rollback newly created volume on run failure
      let volErr: unknown;
      try {
        await this.removeVolume({
          volumeName: spec.volume.volumeName,
          userId: spec.userId,
          volumeId: spec.volume.volumeId,
        });
      } catch (rErr: unknown) {
        volErr = rErr;
      }

      const msg = getErrorMessage(err);
      const isCollision = isContainerCollisionError(msg, spec.containerName);

      const primaryErr = isCollision
        ? new DockerCollisionError('Container already exists on host. Creation refused.')
        : new DockerDaemonError('Failed to run container', err);

      if (volErr) {
        throw new AggregateError(
          [primaryErr, volErr instanceof Error ? volErr : new Error('Volume rollback failed')],
          'Failed to run container and volume rollback also failed'
        );
      }
      throw primaryErr;
    }

    const containerId = stdout.trim().toLowerCase();
    if (!is64HexContainerId(containerId)) {
      // On malformed ID: DO NOT name-cleanup (cannot authorize container without verified ID), but attempt safe volume removal
      let volErr: unknown;
      try {
        await this.removeVolume({
          volumeName: spec.volume.volumeName,
          userId: spec.userId,
          volumeId: spec.volume.volumeId,
        });
      } catch (rErr: unknown) {
        volErr = rErr;
      }

      const malformedErr = new DockerDaemonError(
        'Docker returned invalid non-64hex container ID. Container identity could not be verified; name cleanup skipped.'
      );
      if (volErr) {
        throw new AggregateError(
          [malformedErr, volErr instanceof Error ? volErr : new Error('Volume removal failed')],
          'Docker returned malformed container ID and volume removal failed'
        );
      }
      throw malformedErr;
    }

    // Immediate post-run inspection & ownership verification
    const expectation: OwnershipExpectation = {
      containerName: spec.containerName,
      userId: spec.userId,
      runId: spec.runId,
      containerId,
      volumeName: spec.volume.volumeName,
      volumeId: spec.volume.volumeId,
      containerPath: spec.volume.containerPath,
      mounts: spec.mounts,
    };

    try {
      const info = await this.inspectContainer(containerId);
      if (!info) {
        throw new DockerNotFoundError('Container disappeared immediately after creation');
      }
      this.assertContainerOwnership(info, expectation);
    } catch (inspectAssertErr: unknown) {
      // Immediate cleanup of container and volume on ownership failure, aggregating errors
      const cleanupErrors: Error[] = [];
      try {
        await this.cleanupFreshlyCreatedContainer(expectation, 2);
      } catch (cErr: unknown) {
        cleanupErrors.push(cErr instanceof Error ? cErr : new Error('Container cleanup failed'));
      }

      try {
        await this.removeVolume({
          volumeName: spec.volume.volumeName,
          userId: spec.userId,
          volumeId: spec.volume.volumeId,
        });
      } catch (vErr: unknown) {
        cleanupErrors.push(vErr instanceof Error ? vErr : new Error('Volume cleanup failed'));
      }

      const primary = inspectAssertErr instanceof Error ? inspectAssertErr : new Error('Post-creation ownership assertion failed');
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [primary, ...cleanupErrors],
          'Container created but failed post-run ownership verification'
        );
      }
      throw primary;
    }

    return {
      containerId,
      volumeCreated: true,
    };
  }

  /**
   * Runs a new container attaching an existing owned Docker volume without creating or deleting the volume.
   * Strictly enforces caller-supplied VolumeOwnershipExpectation, zero-network mode, and container hardening.
   * On failure or ownership mismatch, never removes or mutates the retained volume.
   */
  async runContainerWithOwnedVolume(
    spec: RuntimeContainerSpec,
    expectation: VolumeOwnershipExpectation
  ): Promise<RunContainerResult> {
    const validation = validateContainerSpec(spec);
    if (!validation.valid) {
      throw new DockerOwnershipError('Cannot run container: Spec validation failed');
    }

    if (!expectation || typeof expectation !== 'object') {
      throw new DockerOwnershipError('VolumeOwnershipExpectation object is required.');
    }

    if (expectation.volumeName !== spec.volume.volumeName) {
      throw new DockerOwnershipError('Volume expectation name mismatch');
    }
    if (expectation.userId !== spec.userId) {
      throw new DockerOwnershipError('Volume expectation userId mismatch');
    }
    if (expectation.volumeId !== spec.volume.volumeId) {
      throw new DockerOwnershipError('Volume expectation volumeId mismatch');
    }

    this.assertSafeContainerName(spec.containerName);
    this.assertSafeVolumeName(spec.volume.volumeName);

    // 1. Collision check: If container with this name already exists, refuse to run
    const existing = await this.inspectContainer(spec.containerName);
    if (existing) {
      throw new DockerCollisionError('Container already exists on host. Creation refused.');
    }

    // 2. Connect and verify caller-supplied owned volume (DO NOT create or mutate volume)
    await this.connectVolume(spec.volume.volumeName, expectation);

    // 3. Execute hardened container run CLI (shared private helper)
    let stdout = '';
    try {
      stdout = await this.executeDockerRun(spec);
    } catch (err: unknown) {
      // IMPORTANT: On run failure, NEVER remove or roll back the caller's retained volume!
      const msg = getErrorMessage(err);
      const isCollision = isContainerCollisionError(msg, spec.containerName);
      if (isCollision) {
        throw new DockerCollisionError('Container already exists on host. Creation refused.');
      }
      throw new DockerDaemonError('Failed to run container', err);
    }

    const containerId = stdout.trim().toLowerCase();
    if (!is64HexContainerId(containerId)) {
      // On malformed ID: DO NOT remove volume; DO NOT perform name-based cleanup without verified ID
      throw new DockerDaemonError(
        'Docker returned invalid non-64hex container ID. Container identity could not be verified; name cleanup skipped.'
      );
    }

    // 4. Immediate post-run inspection & ownership verification
    const containerExpectation: OwnershipExpectation = {
      containerName: spec.containerName,
      userId: spec.userId,
      runId: spec.runId,
      containerId,
      volumeName: spec.volume.volumeName,
      volumeId: spec.volume.volumeId,
      containerPath: spec.volume.containerPath,
      mounts: spec.mounts,
    };

    try {
      const info = await this.inspectContainer(containerId);
      if (!info) {
        throw new DockerNotFoundError('Container disappeared immediately after creation');
      }
      this.assertContainerOwnership(info, containerExpectation);
    } catch (inspectAssertErr: unknown) {
      // On post-create failure: cleanup ONLY the newly returned container; DO NOT remove the volume!
      const cleanupErrors: Error[] = [];
      try {
        await this.cleanupFreshlyCreatedContainer(containerExpectation, 2);
      } catch (cErr: unknown) {
        cleanupErrors.push(cErr instanceof Error ? cErr : new Error('Container cleanup failed'));
      }

      const primary = inspectAssertErr instanceof Error ? inspectAssertErr : new Error('Post-creation ownership assertion failed');
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [primary, ...cleanupErrors],
          'Container created with owned volume but failed post-run ownership verification'
        );
      }
      throw primary;
    }

    return {
      containerId,
      volumeCreated: false,
    };
  }

  /**
   * Inspects a specific demo container and retrieves its configuration and hardening status.
   * STRICT FAIL-CLOSED: Only returns null on genuine anchored "No such container/object" error;
   * throws typed DockerDaemonError on all daemon, parse, or permission errors.
   */
  async inspectContainer(containerIdentifier: string): Promise<DockerContainerInfo | null> {
    if (!is64HexContainerId(containerIdentifier)) {
      this.assertSafeContainerName(containerIdentifier);
    }

    try {
      const format =
        '{"id":"{{.Id}}","name":"{{.Name}}","image":"{{.Config.Image}}","status":"{{.State.Status}}","state":"{{.State.Status}}","user":"{{.Config.User}}","networkMode":"{{.HostConfig.NetworkMode}}","readonlyRootfs":{{json .HostConfig.ReadonlyRootfs}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}},"pidsLimit":{{json .HostConfig.PidsLimit}},"portBindings":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}},"tmpfs":{{json .HostConfig.Tmpfs}},"labels":{{json .Config.Labels}}}';
      const { stdout } = await execFileAsync(this.dockerBin, [
        'inspect',
        '--format',
        format,
        containerIdentifier,
      ]);
      return parseDockerContainerInspect(stdout.trim());
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      if (isExactNotFoundError(msg, containerIdentifier)) {
        return null;
      }
      throw new DockerDaemonError('Failed to inspect container', err);
    }
  }

  /**
   * Asserts container ownership and hardening invariants against expectations.
   * Fails closed on any mismatch in containerName, exact lower64 containerId, labels, user,
   * networkMode, readonlyRootfs, capDrop, securityOpt, pidsLimit, portBindings, mounts, or tmpfs.
   */
  assertContainerOwnership(info: DockerContainerInfo, expectation: OwnershipExpectation): void {
    if (!expectation || typeof expectation !== 'object') {
      throw new DockerOwnershipError('OwnershipExpectation object is required.');
    }
    if (!expectation.containerName || typeof expectation.containerName !== 'string') {
      throw new DockerOwnershipError('OwnershipExpectation containerName is required.');
    }
    if (!expectation.userId || typeof expectation.userId !== 'string') {
      throw new DockerOwnershipError('OwnershipExpectation userId is required.');
    }
    if (!USER_ID_REGEX.test(expectation.userId)) {
      throw new DockerOwnershipError(
        'OwnershipExpectation userId must match pattern ^[a-z0-9][a-z0-9_-]{0,63}$'
      );
    }
    if (!expectation.runId || typeof expectation.runId !== 'string') {
      throw new DockerOwnershipError('OwnershipExpectation runId is required.');
    }
    if (!expectation.containerId || typeof expectation.containerId !== 'string' || !is64HexContainerId(expectation.containerId)) {
      throw new DockerOwnershipError('OwnershipExpectation containerId must be a valid 64-hex SHA256 string.');
    }
    if (!expectation.volumeName || typeof expectation.volumeName !== 'string') {
      throw new DockerOwnershipError('OwnershipExpectation volumeName is required.');
    }
    if (!expectation.volumeId || typeof expectation.volumeId !== 'string') {
      throw new DockerOwnershipError('OwnershipExpectation volumeId is required.');
    }
    if (!expectation.containerPath || typeof expectation.containerPath !== 'string' || expectation.containerPath !== '/home/dsh') {
      throw new DockerOwnershipError('OwnershipExpectation containerPath must be exactly "/home/dsh"');
    }

    this.assertSafeContainerName(info.name);
    this.assertSafeContainerName(expectation.containerName);
    this.assertSafeVolumeName(expectation.volumeName);

    // Exact container name match
    if (info.name !== expectation.containerName) {
      throw new DockerOwnershipError('Container name mismatch');
    }

    const isExactUserContainer =
      info.name === `enkeep-demo-${expectation.userId}` ||
      info.name.startsWith(`enkeep-demo-${expectation.userId}-`);
    if (!isExactUserContainer) {
      throw new DockerOwnershipError('Container is not scoped to user');
    }

    // Exact full lower64 ID equality (NO short prefix, NO substring matching)
    if (!is64HexContainerId(info.id)) {
      throw new DockerOwnershipError('Container ID is not a valid 64-hex SHA256 string.');
    }
    if (info.id.toLowerCase() !== expectation.containerId.toLowerCase()) {
      throw new DockerOwnershipError('Container ID mismatch');
    }

    // Mandatory ownership labels
    if (info.labels[DEMO_LABEL_KEY] !== DEMO_LABEL_VALUE) {
      throw new DockerOwnershipError('Container lacks mandatory label app=enkeep-demo');
    }

    if (info.labels[USER_LABEL_KEY] !== expectation.userId) {
      throw new DockerOwnershipError('Container user mismatch');
    }

    const actualRunId = info.labels[RUN_ID_LABEL_KEY];
    if (!actualRunId || actualRunId !== expectation.runId) {
      throw new DockerOwnershipError('Container run-id mismatch');
    }

    const actualVolId = info.labels[VOLUME_ID_LABEL_KEY];
    if (!actualVolId || actualVolId !== expectation.volumeId) {
      throw new DockerOwnershipError('Container volume-id mismatch');
    }

    // Mandatory exact user '1000:1000'
    if (!info.user || info.user.trim() !== '1000:1000') {
      throw new DockerOwnershipError('Container Config.User must be exactly "1000:1000"');
    }

    // Mandatory exact NetworkMode 'none'
    if (!info.networkMode || info.networkMode.trim() !== 'none') {
      throw new DockerOwnershipError('Container NetworkMode must be "none". Zero-network violation.');
    }

    // Mandatory exact ReadonlyRootfs true
    if (info.readonlyRootfs !== true) {
      throw new DockerOwnershipError('Container root filesystem is not read-only');
    }

    // Mandatory CapDrop raw exact ['ALL']
    if (!Array.isArray(info.capDrop) || info.capDrop.length !== 1 || info.capDrop[0] !== 'ALL') {
      throw new DockerOwnershipError('Container CapDrop must be exactly ["ALL"]');
    }

    // Mandatory SecurityOpt exact canonical ['no-new-privileges:true']
    if (
      !Array.isArray(info.securityOpt) ||
      info.securityOpt.length !== 1 ||
      info.securityOpt[0] !== 'no-new-privileges:true'
    ) {
      throw new DockerOwnershipError('Container SecurityOpt must contain only no-new-privileges option');
    }

    // Mandatory PidsLimit exact 256
    if (
      typeof info.pidsLimit !== 'number' ||
      !Number.isInteger(info.pidsLimit) ||
      info.pidsLimit !== 256
    ) {
      throw new DockerOwnershipError('Container pidsLimit must be an integer between 1 and 256 (must be exactly 256)');
    }

    // PortBindings: exact null only
    if (info.portBindings !== null) {
      throw new DockerOwnershipError('Container has published port bindings. Zero-network violation.');
    }

    // Mounts: mandatory exactly ONE type volume mount matching expectation.containerPath (/home/dsh) and expectation.volumeName with rw true,
    // plus any approved controlled bind mounts matching /home/dsh/mounts/<id>
    if (!Array.isArray(info.mounts)) {
      throw new DockerOwnershipError('Container must have exactly ONE volume mount');
    }

    const expectedControlledMounts = expectation.mounts ?? [];
    if (expectedControlledMounts.length === 0) {
      if (info.mounts.length !== 1) {
        throw new DockerOwnershipError('Container must have exactly ONE volume mount');
      }

      const mount = info.mounts[0];
      if (mount.type !== 'volume') {
        throw new DockerOwnershipError('Container mount must be of type "volume". Host bind mounts are strictly forbidden.');
      }

      if (mount.name !== expectation.volumeName) {
        throw new DockerOwnershipError('Container mounted volume name mismatch');
      }

      if (mount.destination !== expectation.containerPath) {
        throw new DockerOwnershipError('Container mount destination mismatch');
      }

      if (mount.rw !== true) {
        throw new DockerOwnershipError('Container volume mount must be read-write');
      }

      if (!mount.source || typeof mount.source !== 'string' || mount.source.trim().length === 0) {
        throw new DockerOwnershipError('Container volume mount source cannot be empty');
      }
    } else {
      const totalExpected = 1 + expectedControlledMounts.length;
      if (info.mounts.length !== totalExpected) {
        throw new DockerOwnershipError(
          `Container must have exactly ${totalExpected} mounts (1 volume + ${expectedControlledMounts.length} controlled bind mounts), got ${info.mounts.length}`
        );
      }

      const volumeMounts = info.mounts.filter((m) => m.type === 'volume');
      if (volumeMounts.length !== 1) {
        throw new DockerOwnershipError('Container must have exactly ONE volume mount');
      }

      const vol = volumeMounts[0];
      if (vol.name !== expectation.volumeName) {
        throw new DockerOwnershipError('Container mounted volume name mismatch');
      }
      if (vol.destination !== expectation.containerPath) {
        throw new DockerOwnershipError('Container mount destination mismatch');
      }
      if (vol.rw !== true) {
        throw new DockerOwnershipError('Container volume mount must be read-write');
      }
      if (!vol.source || typeof vol.source !== 'string' || vol.source.trim().length === 0) {
        throw new DockerOwnershipError('Container volume mount source cannot be empty');
      }

      const bindMounts = info.mounts.filter((m) => m.type === 'bind');
      if (bindMounts.length !== expectedControlledMounts.length) {
        throw new DockerOwnershipError('Container bind mount count mismatch with expectation');
      }

      for (const bind of bindMounts) {
        const dest = bind.destination;
        if (
          dest === '/var/run/docker.sock' ||
          dest.startsWith('/proc') ||
          dest.startsWith('/sys') ||
          dest.startsWith('/dev') ||
          dest.startsWith('/etc') ||
          dest.startsWith('/root')
        ) {
          throw new DockerOwnershipError(`Forbidden bind mount destination: "${dest}"`);
        }
        if (!dest.startsWith('/home/dsh/mounts/')) {
          throw new DockerOwnershipError(
            `Controlled bind mount must target /home/dsh/mounts/<id>, got "${dest}"`
          );
        }
        const mountId = dest.slice('/home/dsh/mounts/'.length);
        const expected = expectedControlledMounts.find((m) => m.id === mountId);
        if (!expected) {
          throw new DockerOwnershipError(`Unexpected bind mount for ID "${mountId}"`);
        }
        const expectedRw = expected.mode === 'rw';
        if (bind.rw !== expectedRw) {
          throw new DockerOwnershipError(
            `Bind mount "${mountId}" mode mismatch: expected rw=${expectedRw}, got rw=${bind.rw}`
          );
        }
      }
    }

    // Tmpfs: mandatory exact only /tmp with canonical options (rw,noexec,nosuid,nodev,size=64m)
    if (!info.tmpfs || !isRecord(info.tmpfs)) {
      throw new DockerOwnershipError('Container lacks required tmpfs mount for /tmp');
    }

    const tmpfsKeys = Object.keys(info.tmpfs);
    if (tmpfsKeys.length !== 1 || tmpfsKeys[0] !== '/tmp') {
      throw new DockerOwnershipError('Container tmpfs mounts must contain only "/tmp"');
    }

    const tmpOptions = info.tmpfs['/tmp'];
    if (!validateCanonicalTmpfsOptions(tmpOptions)) {
      throw new DockerOwnershipError('Container tmpfs options for /tmp are not canonical');
    }
  }

  /**
   * Safely executes an owned request inside an authenticated enkeep-demo container by full 64-hex container ID.
   * Strictly verifies ownership immediately before and after execution, and uses single-settlement bounded stream reaping.
   */
  async execOwned(
    expectation: OwnershipExpectation,
    request: ExecCliRequest,
    options: ExecOwnedOptions = {}
  ): Promise<ExecCliEnvelope> {
    this.assertSafeContainerName(expectation.containerName);

    if (!is64HexContainerId(expectation.containerId)) {
      throw new DockerOwnershipError('execOwned requires a valid 64-hex containerId');
    }

    // 1. Pre-execution inspect and assertion
    const infoBefore = await this.inspectContainer(expectation.containerId);
    if (!infoBefore) {
      throw new DockerNotFoundError('Container not found for exec');
    }

    this.assertContainerOwnership(infoBefore, expectation);

    if (infoBefore.state !== 'running') {
      throw new DockerOwnershipError('Cannot exec into container: container is not in running state');
    }

    const timeoutMs = options.timeoutMs ?? 30000;
    const maxOutputBytes = options.maxBodyBytes ?? (
      request.action === 'health'
        ? HEALTH_EXEC_MAX_OUTPUT_BYTES
        : (request.action === 'export-fork-seed' ? SEED_IMPORT_MAX_INPUT_BYTES : DEFAULT_EXEC_MAX_OUTPUT_BYTES)
    );
    const maxInputBytes = options.maxInputBytes ?? (
      request.action === 'import-seed'
        ? SEED_IMPORT_MAX_INPUT_BYTES
        : (request.action === 'health' ? HEALTH_EXEC_MAX_INPUT_BYTES : DEFAULT_EXEC_MAX_INPUT_BYTES)
    );
    const cliPath = options.cliPath ?? '/app/runtime-runner/dist/runtime/exec-cli.js';
    const stdinPayload = JSON.stringify(request);

    let execResult: { stdout: string; stderr: string; exitCode: number } | undefined;
    let execError: unknown;

    try {
      execResult = await this.spawnBoundedExec(
        infoBefore.id,
        ['node', cliPath],
        stdinPayload,
        timeoutMs,
        maxOutputBytes,
        maxInputBytes
      );
    } catch (err: unknown) {
      execError = err;
    }

    // 2. Post-execution inspect and assertion (always executed, even on execError)
    let postAssertError: unknown;
    try {
      const infoAfter = await this.inspectContainer(expectation.containerId);
      if (!infoAfter) {
        throw new DockerNotFoundError('Post-exec inspection failed: container not found');
      }
      this.assertContainerOwnership(infoAfter, expectation);
    } catch (paErr: unknown) {
      postAssertError = paErr;
    }

    if (execError && postAssertError) {
      const p1 = execError instanceof Error ? execError : new Error('Exec error');
      const p2 = postAssertError instanceof Error ? postAssertError : new Error('Post-exec verification error');
      throw new AggregateError(
        [p1, p2],
        'execOwned failed and post-execution ownership verification also failed'
      );
    }
    if (execError) {
      throw execError;
    }
    if (postAssertError) {
      throw postAssertError;
    }

    if (!execResult) {
      throw new DockerDaemonError('Exec process terminated without producing a result');
    }

    const { stdout, exitCode } = execResult;
    if (exitCode !== 0) {
      const trimmed = stdout.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          return parseExecEnvelope(trimmed);
        } catch (_parseErr: unknown) {
          throw new DockerDaemonError('Exec exited with non-zero code and malformed JSON envelope');
        }
      }

      throw new DockerDaemonError('Exec process exited with non-zero exit code');
    }

    return parseExecEnvelope(stdout);
  }

  /**
   * Safely stages binary stream into a temporary staged file inside an authenticated container.
   */
  async execStageStream(
    expectation: OwnershipExpectation,
    options: {
      space: string;
      path: string;
      maxSizeBytes?: number;
      cliPath?: string;
    },
    inStream: NodeJS.ReadableStream
  ): Promise<{ stageToken: string; space: string; path: string; size: number; sha256: string; etag: string }> {
    const cliPath = options.cliPath ?? '/app/runtime-runner/dist/runtime/exec-cli.js';
    const stageOptionsArg = JSON.stringify({
      space: options.space,
      path: options.path,
      maxSizeBytes: options.maxSizeBytes,
    });

    const handle = await this.spawnLongRunningExecOwned(expectation, [
      'node',
      cliPath,
      'stage-stream',
      '--stage-options',
      stageOptionsArg,
    ]);

    let stdoutData = '';
    let stderrData = '';
    handle.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString('utf8');
    });
    handle.stderr.on('data', (chunk) => {
      stderrData += chunk.toString('utf8');
    });

    try {
      await new Promise<void>((resolve, reject) => {
        inStream.on('error', (err) => {
          if (typeof (handle.stdin as any).destroy === 'function') {
            (handle.stdin as any).destroy(err);
          }
          reject(err);
        });
        handle.stdin.on('error', (err) => {
          reject(err);
        });
        inStream.pipe(handle.stdin);
        inStream.on('end', () => {
          resolve();
        });
      });
    } catch {
      // In stream error or stdin pipe error
    }

    const { exitCode } = await handle.exitPromise;

    // Post-execution inspect and assertion
    const infoAfter = await this.inspectContainer(expectation.containerId);
    if (!infoAfter) {
      throw new DockerNotFoundError('Post-exec inspection failed: container not found');
    }
    this.assertContainerOwnership(infoAfter, expectation);

    const firstLine = stdoutData.trim().split('\n')[0];
    let envelope: ExecCliEnvelope;
    try {
      envelope = JSON.parse(firstLine || '{}');
    } catch {
      throw new DockerDaemonError(`Exec stage-stream produced invalid JSON response: ${stdoutData || stderrData}`);
    }

    if (exitCode !== 0 || envelope.status === 'error' || !envelope.fileResult) {
      throw new DockerDaemonError(`Exec stage-stream failed (exitCode ${exitCode}): ${envelope.error || stderrData || 'Unknown error'}`);
    }

    return envelope.fileResult as any;
  }

  /**
   * Safely commits a previously staged file to target path atomically inside an authenticated container.
   */
  async execCommitStage(
    expectation: OwnershipExpectation,
    options: {
      space: string;
      path: string;
      stageToken: string;
      expectedEtag?: string;
      requireAbsent?: boolean;
      cliPath?: string;
    }
  ): Promise<FileOperationResult> {
    const cliPath = options.cliPath ?? '/app/runtime-runner/dist/runtime/exec-cli.js';
    const commitOptionsArg = JSON.stringify({
      space: options.space,
      path: options.path,
      stageToken: options.stageToken,
      expectedEtag: options.expectedEtag,
      requireAbsent: options.requireAbsent,
    });

    const envelope = await this.execOwned(expectation, {
      action: 'commit-stage',
      fileCommit: {
        space: options.space,
        path: options.path,
        stageToken: options.stageToken,
        expectedEtag: options.expectedEtag,
        requireAbsent: options.requireAbsent,
      },
    }, { cliPath, maxInputBytes: DEFAULT_EXEC_MAX_INPUT_BYTES });

    if (envelope.status === 'error' || !envelope.fileResult) {
      throw new DockerDaemonError(`Exec commit-stage failed: ${envelope.error || 'Unknown error'}`);
    }

    return envelope.fileResult;
  }

  /**
   * Safely aborts a previously staged temporary file inside an authenticated container.
   */
  async execAbortStage(
    expectation: OwnershipExpectation,
    options: {
      space: string;
      path: string;
      stageToken: string;
      cliPath?: string;
    }
  ): Promise<void> {
    const cliPath = options.cliPath ?? '/app/runtime-runner/dist/runtime/exec-cli.js';
    try {
      await this.execOwned(expectation, {
        action: 'abort-stage',
        fileAbort: {
          space: options.space,
          path: options.path,
          stageToken: options.stageToken,
        },
      }, { cliPath, maxInputBytes: DEFAULT_EXEC_MAX_INPUT_BYTES });
    } catch {
      // Best-effort abort
    }
  }

  /**
   * Safely finalizes a stage commit by deleting the backup file after DB transaction commit.
   */
  async execFinalizeStage(
    expectation: OwnershipExpectation,
    options: {
      space: string;
      path: string;
      rollbackToken?: string;
      cliPath?: string;
    }
  ): Promise<void> {
    if (!options.rollbackToken) return;
    const cliPath = options.cliPath ?? '/app/runtime-runner/dist/runtime/exec-cli.js';
    try {
      await this.execOwned(expectation, {
        action: 'finalize-stage',
        fileFinalize: {
          space: options.space,
          path: options.path,
          rollbackToken: options.rollbackToken,
        },
      }, { cliPath, maxInputBytes: DEFAULT_EXEC_MAX_INPUT_BYTES });
    } catch {
      // Best-effort cleanup
    }
  }

  /**
   * Safely rolls back a committed file in the container.
   */
  async execRollbackCommit(
    expectation: OwnershipExpectation,
    options: {
      space: string;
      path: string;
      rollbackToken?: string;
      stageToken?: string;
      cliPath?: string;
    }
  ): Promise<void> {
    const cliPath = options.cliPath ?? '/app/runtime-runner/dist/runtime/exec-cli.js';
    try {
      await this.execOwned(expectation, {
        action: 'rollback-commit',
        fileRollback: {
          space: options.space,
          path: options.path,
          rollbackToken: options.rollbackToken,
          stageToken: options.stageToken,
        },
      }, { cliPath, maxInputBytes: DEFAULT_EXEC_MAX_INPUT_BYTES });
    } catch {
      // Best-effort rollback
    }
  }

  /**
   * Safely inspects the transfer state (target, stageToken, rollbackToken) inside an authenticated container.
   */
  async execInspectTransferState(
    expectation: OwnershipExpectation,
    options: {
      space: string;
      path: string;
      stageToken?: string;
      rollbackToken?: string;
      expectedContentSha256: string;
      overwrite?: boolean;
      cliPath?: string;
    }
  ): Promise<any> {
    const cliPath = options.cliPath ?? '/app/runtime-runner/dist/runtime/exec-cli.js';
    const envelope = await this.execOwned(expectation, {
      action: 'inspect-transfer-state',
      fileInspect: {
        space: options.space,
        path: options.path,
        stageToken: options.stageToken,
        rollbackToken: options.rollbackToken,
        expectedContentSha256: options.expectedContentSha256,
        overwrite: options.overwrite,
      },
    }, { cliPath, maxInputBytes: DEFAULT_EXEC_MAX_INPUT_BYTES });

    if (envelope.status === 'error' || !envelope.fileResult) {
      throw new DockerDaemonError(`Exec inspect-transfer-state failed: ${envelope.error || 'Unknown error'}`);
    }

    return envelope.fileResult;
  }

  /**
   * Safely streams binary data into a file inside an authenticated container via ownership-verified docker exec.
   */
  async execWriteStream(
    expectation: OwnershipExpectation,
    options: {
      space: string;
      path: string;
      expectedEtag?: string;
      requireAbsent?: boolean;
      maxSizeBytes?: number;
      cliPath?: string;
    },
    inStream: NodeJS.ReadableStream
  ): Promise<ExecCliEnvelope> {
    const cliPath = options.cliPath ?? '/app/runtime-runner/dist/runtime/exec-cli.js';
    const writeOptionsArg = JSON.stringify({
      space: options.space,
      path: options.path,
      expectedEtag: options.expectedEtag,
      requireAbsent: options.requireAbsent,
      maxSizeBytes: options.maxSizeBytes,
    });

    const handle = await this.spawnLongRunningExecOwned(expectation, [
      'node',
      cliPath,
      'write-stream',
      '--write-options',
      writeOptionsArg,
    ]);

    let stdoutData = '';
    let stderrData = '';
    handle.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString('utf8');
    });
    handle.stderr.on('data', (chunk) => {
      stderrData += chunk.toString('utf8');
    });

    try {
      await new Promise<void>((resolve, reject) => {
        inStream.on('error', (err) => {
          if (typeof (handle.stdin as any).destroy === 'function') {
            (handle.stdin as any).destroy(err);
          }
          reject(err);
        });
        handle.stdin.on('error', (err) => {
          reject(err);
        });
        inStream.pipe(handle.stdin);
        inStream.on('end', () => {
          resolve();
        });
      });
    } catch (pipeErr) {
      // In stream error or stdin pipe error
    }

    const { exitCode } = await handle.exitPromise;

    // Post-execution inspect and assertion
    const infoAfter = await this.inspectContainer(expectation.containerId);
    if (!infoAfter) {
      throw new DockerNotFoundError('Post-exec inspection failed: container not found');
    }
    this.assertContainerOwnership(infoAfter, expectation);

    const firstLine = stdoutData.trim().split('\n')[0];
    let envelope: ExecCliEnvelope;
    try {
      envelope = JSON.parse(firstLine || '{}');
    } catch {
      throw new DockerDaemonError(`Exec write-stream produced invalid JSON response: ${stdoutData || stderrData}`);
    }

    if (exitCode !== 0 || envelope.status === 'error') {
      throw new DockerDaemonError(`Exec write-stream failed (exitCode ${exitCode}): ${envelope.error || stderrData || 'Unknown error'}`);
    }

    return envelope;
  }

  /**
   * Safely streams binary data out of a file inside an authenticated container via ownership-verified docker exec.
   */
  async execReadStream(
    expectation: OwnershipExpectation,
    options: {
      space: string;
      path: string;
      range?: { start: number; end: number };
      cliPath?: string;
    }
  ): Promise<{ metadata: FileOperationResult; stream: NodeJS.ReadableStream }> {
    const cliPath = options.cliPath ?? '/app/runtime-runner/dist/runtime/exec-cli.js';
    const readOptionsArg = JSON.stringify({
      space: options.space,
      path: options.path,
      range: options.range,
    });

    const handle = await this.spawnLongRunningExecOwned(expectation, [
      'node',
      cliPath,
      'read-stream',
      '--read-options',
      readOptionsArg,
    ]);

    // Read the first line (metadata JSON) from stdout
    const { PassThrough } = await import('node:stream');
    const outStream = new PassThrough();

    return new Promise<{ metadata: FileOperationResult; stream: NodeJS.ReadableStream }>((resolve, reject) => {
      let headerBuf = Buffer.alloc(0);
      let headerParsed = false;
      let headerEnvelope: any = null;

      const onData = (chunk: Buffer) => {
        if (!headerParsed) {
          headerBuf = Buffer.concat([headerBuf, chunk]);
          const newlineIdx = headerBuf.indexOf(0x0a); // \n
          if (newlineIdx !== -1) {
            const line = headerBuf.subarray(0, newlineIdx).toString('utf8');
            const rest = headerBuf.subarray(newlineIdx + 1);
            try {
              headerEnvelope = JSON.parse(line);
            } catch (pErr) {
              handle.stdout.removeListener('data', onData);
              reject(new DockerDaemonError(`Exec read-stream produced invalid header JSON: ${line}`));
              return;
            }

            if (headerEnvelope.status === 'error' || !headerEnvelope.fileResult) {
              handle.stdout.removeListener('data', onData);
              reject(new DockerDaemonError(`Exec read-stream failed: ${headerEnvelope.error || 'Unknown error'}`));
              return;
            }

            headerParsed = true;
            if (rest.length > 0) {
              outStream.write(rest);
            }
            resolve({
              metadata: headerEnvelope.fileResult,
              stream: outStream,
            });
          }
        } else {
          outStream.write(chunk);
        }
      };

      handle.stdout.on('data', onData);
      handle.stdout.on('end', () => {
        if (!headerParsed) {
          reject(new DockerDaemonError('Exec read-stream ended before header received'));
        } else {
          outStream.end();
        }
      });
      handle.stdout.on('error', (err) => {
        if (!headerParsed) {
          reject(err);
        } else {
          outStream.destroy(err);
        }
      });
    });
  }

  /**
   * Spawns a long-running owned process inside an authenticated container by full 64-hex container ID.
   * Strictly verifies container ownership before launching the process.
   * Returns a LongRunningExecHandle exposing raw stdin/stdout/stderr streams and an exit promise.
   */
  async spawnLongRunningExecOwned(
    expectation: OwnershipExpectation,
    commandArgs: readonly string[]
  ): Promise<LongRunningExecHandle> {
    this.assertSafeContainerName(expectation.containerName);

    if (!is64HexContainerId(expectation.containerId)) {
      throw new DockerOwnershipError('spawnLongRunningExecOwned requires a valid 64-hex containerId');
    }

    // 1. Pre-execution inspect and assertion
    const infoBefore = await this.inspectContainer(expectation.containerId);
    if (!infoBefore) {
      throw new DockerNotFoundError('Container not found for long-running exec');
    }

    this.assertContainerOwnership(infoBefore, expectation);

    if (infoBefore.state !== 'running') {
      throw new DockerOwnershipError('Cannot exec into container: container is not in running state');
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(this.dockerBin, ['exec', '-i', infoBefore.id, ...commandArgs], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (spawnErr: unknown) {
      throw new DockerDaemonError('Failed to spawn long-running docker exec process', spawnErr);
    }

    if (!child || !child.stdin || !child.stdout || !child.stderr) {
      throw new DockerDaemonError('Failed to initialize stdio pipes for long-running docker exec');
    }

    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderr = child.stderr;
    const pid = child.pid;

    const exitPromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on('close', (code, signal) => {
          resolve({ exitCode: code, signal });
        });
        child.on('error', () => {
          // Keep promise settling on close event
        });
      }
    );

    const handle: LongRunningExecHandle = {
      pid,
      stdin,
      stdout,
      stderr,
      exitPromise,
      kill: (signal = 'SIGTERM') => {
        if (!child.killed) {
          try {
            child.kill(signal);
          } catch (kErr: unknown) {
            if (isRecord(kErr) && kErr.code !== 'ESRCH') {
              // Ignore ESRCH
            }
          }
        }
      },
    };

    return handle;
  }

  /**
   * Safely corrupts an owned session file for acceptance testing.
   * Strictly validates sessionId, derives canonical path internally,
   * checks for regular file / no symlink / exact UID 1000, opens with O_APPEND | O_WRONLY | O_NOFOLLOW,
   * performs post-open fstat dev/ino validation to prevent TOCTOU races,
   * appends fixed invalid line with fsync, and verifies ownership before and after execution.
   */
  async corruptOwnedSessionForAcceptance(
    expectation: OwnershipExpectation,
    sessionId: string,
    options?: {
      type?: 'tail_crash' | 'mid_log_seq_gap' | 'syntax_error';
    }
  ): Promise<void> {
    this.assertSafeContainerName(expectation.containerName);

    if (!is64HexContainerId(expectation.containerId)) {
      throw new DockerOwnershipError('corruptOwnedSessionForAcceptance requires a valid 64-hex containerId');
    }

    if (!sessionId || typeof sessionId !== 'string' || !/^[A-Za-z0-9_\-:.]{1,128}$/.test(sessionId)) {
      throw new DockerOwnershipError('corruptOwnedSessionForAcceptance rejected: invalid sessionId');
    }

    // 1. Pre-execution inspect and assertion
    const infoBefore = await this.inspectContainer(expectation.containerId);
    if (!infoBefore) {
      throw new DockerNotFoundError('Container not found for corruption test');
    }
    this.assertContainerOwnership(infoBefore, expectation);

    if (infoBefore.state !== 'running') {
      throw new DockerOwnershipError('Cannot corrupt session in container: container is not in running state');
    }

    // Derive canonical session file path internally
    const pKey = projectKey('/home/dsh/spaces');
    const seg = encodeSessionSegment(sessionId);
    const canonicalPath = `/home/dsh/.dsh/sessions/${pKey}/${seg}/session.jsonl`;

    const nodeScript = `
const fs = require('node:fs');
const filePath = process.argv.slice(1).find((a) => a !== '[eval]') || '';
if (!filePath || !filePath.startsWith('/home/dsh/.dsh/sessions/') || !filePath.endsWith('/session.jsonl') || filePath.includes('..')) {
  process.exit(10);
}
let stat;
try {
  stat = fs.lstatSync(filePath);
} catch (e) {
  process.exit(11);
}
if (!stat.isFile() || stat.isSymbolicLink()) {
  process.exit(11);
}
if (stat.uid !== 1000) {
  process.exit(12);
}
let fd;
try {
  const nofollow = fs.constants.O_NOFOLLOW || 0;
  fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_APPEND | nofollow);
} catch (e) {
  process.exit(13);
}
try {
  const fstat = fs.fstatSync(fd);
  if (!fstat.isFile() || fstat.uid !== 1000 || fstat.dev !== stat.dev || fstat.ino !== stat.ino) {
    fs.closeSync(fd);
    process.exit(14);
  }
  const type = '${options?.type ?? 'tail_crash'}';
  let data;
  if (type === 'mid_log_seq_gap') {
    data = Buffer.from(
      JSON.stringify({
        type: 'user/message',
        seq: 999,
        time: Date.now(),
        data: { id: 'msg_corrupt_gap', content: 'Injected seq gap in committed region' },
      }) + '\\n' +
      JSON.stringify({
        type: 'turn/end',
        seq: 1000,
        time: Date.now(),
      }) + '\\n',
      'utf8'
    );
  } else if (type === 'syntax_error') {
    data = Buffer.from(
      'INVALID_SYNTAX_JSON_RECORD_IN_COMMITTED_REGION\\n' +
      JSON.stringify({
        type: 'turn/end',
        seq: 1000,
        time: Date.now(),
      }) + '\\n',
      'utf8'
    );
  } else {
    data = Buffer.from('{INVALID_CORRUPTED_TAIL_RECORD\\n', 'utf8');
  }
  let written = 0;
  while (written < data.length) {
    written += fs.writeSync(fd, data, written, data.length - written);
  }
  fs.fsyncSync(fd);
  fs.closeSync(fd);
} catch (e) {
  try {
    fs.closeSync(fd);
  } catch (ce) {
    process.exit(17);
  }
  process.exit(15);
}
`;

    let execResult: { stdout: string; stderr: string; exitCode: number } | undefined;
    let execError: unknown;

    try {
      execResult = await this.spawnBoundedExec(
        infoBefore.id,
        ['node', '-e', nodeScript, canonicalPath],
        null,
        15000,
        1024 * 1024,
        0
      );
    } catch (err: unknown) {
      execError = err;
    }

    // 2. Post-execution inspect and assertion
    let postAssertError: unknown;
    try {
      const infoAfter = await this.inspectContainer(expectation.containerId);
      if (!infoAfter) {
        throw new DockerNotFoundError('Post-corruption inspection failed: container not found');
      }
      this.assertContainerOwnership(infoAfter, expectation);
    } catch (paErr: unknown) {
      postAssertError = paErr;
    }

    if (execError && postAssertError) {
      const p1 = execError instanceof Error ? execError : new Error('Exec error');
      const p2 = postAssertError instanceof Error ? postAssertError : new Error('Post-exec error');
      throw new AggregateError(
        [p1, p2],
        'corruptOwnedSessionForAcceptance failed and post-corruption ownership verification also failed'
      );
    }
    if (execError) {
      throw execError;
    }
    if (postAssertError) {
      throw postAssertError;
    }

    if (!execResult) {
      throw new DockerDaemonError('Corruption script execution terminated without producing a result');
    }

    if (execResult.exitCode !== 0) {
      throw new DockerDaemonError('Corruption script execution failed with non-zero exit code');
    }
  }

  /**
   * Private emergency cleanup route for a container freshly returned by docker create/run in this call.
   * Authorizes cleanup by strictly validating exact 64-hex container ID and identity labels
   * (app, user, run-id, volume-id, and containerName), allowing cleanup to proceed even if
   * post-run hardening checks failed (which is the very reason this cleanup is invoked).
   * Verifies the container is completely absent after removal to prevent leaks.
   */
  private async cleanupFreshlyCreatedContainer(
    expectation: OwnershipExpectation,
    timeoutSeconds = 2
  ): Promise<void> {
    this.assertSafeContainerName(expectation.containerName);

    if (!is64HexContainerId(expectation.containerId)) {
      throw new DockerOwnershipError('cleanupFreshlyCreatedContainer requires a valid 64-hex containerId');
    }

    const info = await this.inspectContainer(expectation.containerId);
    if (!info) {
      // Container already absent
      return;
    }

    // Safety verification: Ensure ID, name, and identity labels match before deletion
    if (info.id.toLowerCase() !== expectation.containerId.toLowerCase()) {
      throw new DockerOwnershipError('cleanupFreshlyCreatedContainer refused: container ID mismatch');
    }

    if (info.name !== expectation.containerName) {
      throw new DockerOwnershipError('cleanupFreshlyCreatedContainer refused: container name mismatch');
    }

    if (info.labels[DEMO_LABEL_KEY] !== DEMO_LABEL_VALUE) {
      throw new DockerOwnershipError('cleanupFreshlyCreatedContainer refused: missing or invalid app label');
    }

    if (info.labels[USER_LABEL_KEY] !== expectation.userId) {
      throw new DockerOwnershipError('cleanupFreshlyCreatedContainer refused: user label mismatch');
    }

    if (info.labels[RUN_ID_LABEL_KEY] !== expectation.runId) {
      throw new DockerOwnershipError('cleanupFreshlyCreatedContainer refused: run-id label mismatch');
    }

    if (info.labels[VOLUME_ID_LABEL_KEY] !== expectation.volumeId) {
      throw new DockerOwnershipError('cleanupFreshlyCreatedContainer refused: volume-id label mismatch');
    }

    // 1. Stop if running
    if (info.state === 'running') {
      try {
        await execFileAsync(this.dockerBin, ['stop', '-t', String(timeoutSeconds), info.id]);
      } catch (err: unknown) {
        const msg = getErrorMessage(err);
        if (!isExactNotFoundError(msg, info.id)) {
          // Continue to forced removal
        }
      }
    }

    // 2. Remove forced
    try {
      await execFileAsync(this.dockerBin, ['rm', '-f', info.id]);
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      if (!isExactNotFoundError(msg, info.id)) {
        throw new DockerDaemonError('Failed to remove freshly created container', err);
      }
    }

    // 3. Post-action verification: Wait until container is verified absent
    const waitDeadline = Date.now() + 5000;
    while (Date.now() < waitDeadline) {
      const updated = await this.inspectContainer(info.id);
      if (!updated) {
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    throw new DockerDaemonError('Container failed to disappear within deadline after removal');
  }

  /**
   * Safely starts an existing stopped enkeep-demo container by full 64-hex container ID after verifying ownership.
   */
  async startContainer(expectation: OwnershipExpectation): Promise<void> {
    this.assertSafeContainerName(expectation.containerName);

    if (!is64HexContainerId(expectation.containerId)) {
      throw new DockerOwnershipError('startContainer requires a valid 64-hex containerId');
    }

    const info = await this.inspectContainer(expectation.containerId);
    if (!info) {
      throw new DockerNotFoundError('Container not found for start');
    }

    // Fail closed if ownership mismatch before action
    this.assertContainerOwnership(info, expectation);

    if (info.state === 'running') {
      return; // Already running
    }

    try {
      await execFileAsync(this.dockerBin, ['start', info.id]);
    } catch (err: unknown) {
      throw new DockerDaemonError('Failed to start container', err);
    }

    // Post-action verification: Wait until state settles to running and assert ownership again
    const waitDeadline = Date.now() + 5000;
    while (Date.now() < waitDeadline) {
      const updated = await this.inspectContainer(info.id);
      if (updated && updated.state === 'running') {
        this.assertContainerOwnership(updated, expectation);
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    throw new DockerDaemonError('Container failed to reach running state within deadline');
  }

  /**
   * Safely stops a specific enkeep-demo container by full 64-hex container ID after verifying ownership.
   * Idempotent: If container is already exited/stopped, completes safely.
   */
  async stopContainer(expectation: OwnershipExpectation, timeoutSeconds = 5): Promise<void> {
    this.assertSafeContainerName(expectation.containerName);

    if (!is64HexContainerId(expectation.containerId)) {
      throw new DockerOwnershipError('stopContainer requires a valid 64-hex containerId');
    }

    const info = await this.inspectContainer(expectation.containerId);
    if (!info) {
      throw new DockerNotFoundError('Container not found for stop');
    }

    // Fail closed if ownership mismatch before action
    this.assertContainerOwnership(info, expectation);

    if (info.state !== 'running') {
      return; // Already in stopped/exited state
    }

    try {
      await execFileAsync(this.dockerBin, ['stop', '-t', String(timeoutSeconds), info.id]);
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      if (isExactNotFoundError(msg, info.id)) {
        return;
      }
      throw new DockerDaemonError('Failed to stop container', err);
    }

    // Post-action verification: Wait until state settles out of 'running'
    const waitDeadline = Date.now() + 5000;
    while (Date.now() < waitDeadline) {
      const updated = await this.inspectContainer(info.id);
      if (!updated || updated.state !== 'running') {
        if (updated) {
          this.assertContainerOwnership(updated, expectation);
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    throw new DockerDaemonError('Container failed to stop within deadline');
  }

  /**
   * Safely removes a specific enkeep-demo container by full 64-hex container ID after verifying ownership.
   * Awaits confirmation that container is completely absent (post-action verification).
   */
  async removeContainer(expectation: OwnershipExpectation, force = true): Promise<void> {
    this.assertSafeContainerName(expectation.containerName);

    if (!is64HexContainerId(expectation.containerId)) {
      throw new DockerOwnershipError('removeContainer requires a valid 64-hex containerId');
    }

    const info = await this.inspectContainer(expectation.containerId);
    if (!info) {
      // Container is already absent
      return;
    }

    // Fail closed if ownership mismatch before action
    this.assertContainerOwnership(info, expectation);

    try {
      const args = ['rm'];
      if (force) args.push('-f');
      args.push(info.id);
      await execFileAsync(this.dockerBin, args);
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      if (isExactNotFoundError(msg, info.id)) {
        return;
      }
      throw new DockerDaemonError('Failed to remove container', err);
    }

    // Post-action verification: Wait until container is verified absent
    const waitDeadline = Date.now() + 5000;
    while (Date.now() < waitDeadline) {
      const updated = await this.inspectContainer(info.id);
      if (!updated) {
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    throw new DockerDaemonError('Container removal verification failed: container still present after deadline');
  }

  /**
   * Safely removes a specific enkeep-demo volume after verifying ownership.
   * Post-action verification: verifies volume is absent before returning; throws if deadline expires.
   */
  async removeVolume(expectation: VolumeOwnershipExpectation, deadlineMs = 5000): Promise<void> {
    this.assertSafeVolumeName(expectation.volumeName);

    const info = await this.inspectVolume(expectation.volumeName);
    if (!info) {
      // Volume is already absent
      return;
    }

    // Fail closed if ownership mismatch before action
    this.assertVolumeOwnership(info, expectation);

    const escaped = expectation.volumeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      try {
        await execFileAsync(this.dockerBin, ['volume', 'rm', expectation.volumeName]);
        break;
      } catch (err: unknown) {
        const msg = getErrorMessage(err);
        if (isExactNotFoundError(msg, expectation.volumeName)) {
          break;
        }
        const isInUse = new RegExp(`volume\\s+["']?${escaped}["']?\\s+is in use`, 'i').test(msg);
        if (isInUse && Date.now() + 200 < deadline) {
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        throw new DockerDaemonError('Failed to remove volume', err);
      }
    }

    // Post-action verification: Ensure volume is absent
    const verifyDeadline = Date.now() + Math.min(deadlineMs, 3000);
    while (Date.now() < verifyDeadline) {
      const updated = await this.inspectVolume(expectation.volumeName);
      if (!updated) {
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    throw new DockerDaemonError('Volume removal verification failed: volume still present after deadline');
  }
}
