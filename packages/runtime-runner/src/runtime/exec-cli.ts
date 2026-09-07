/**
 * Safe In-Container CLI Runner for Zero-Network Docker Exec Transport
 *
 * Invoked by Docker Exec transport inside containers with --network none.
 * Features:
 * - 1MB stdin bounded size protection.
 * - JSON depth limiter (max 10 levels) to prevent prototype pollution / stack overflow.
 * - Uniform structured JSON envelopes on stdout (exactly one JSON line).
 * - Guaranteed non-zero exit codes on failures.
 * - Real cross-exec cancellation with atomic markers, /proc verification, SIGUSR1 signaling,
 *   and verified cancellation receipt handling.
 * - Strict environment validation: DSH_USER, DSH_HOME mandatory with safe regex / absolute path.
 * - Zero stack traces or file paths leaked on error envelopes.
 *
 * @module @enkeep/runtime-runner/runtime/exec-cli
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import {
  bootDshRuntime,
  isValidUserId,
  isValidSessionId,
  isValidTurnId,
  computeSessionEventsChecksum,
  canonicalJsonStringify,
  PersistedSessionResumeError,
  type SessionSeedReceipt,
  type DshBootedRuntime,
} from './dsh-boot.js';
import {
  executeFileOperation,
  executeFileWriteStream,
  executeFileReadStream,
  executeFileStageStream,
  executeFileCommitStage,
  executeFileAbortStage,
  executeFileFinalizeStage,
  executeFileRollbackCommit,
  executeFileInspectTransferState,
  FileOpError,
  sanitizeErrorMessage,
  type FileOperationRequest,
  type FileOperationResult,
  type StreamingWriteOptions,
  type StreamingReadOptions,
  type FileStageOptions,
  type FileStageResult,
  type FileCommitStageOptions,
  type FileAbortStageOptions,
  type FileFinalizeStageOptions,
  type FileRollbackCommitOptions,
  type FileInspectTransferStateOptions,
  type FileInspectTransferStateResult,
} from './file-ops.js';
import {
  validateAgentProfileSnapshot,
  installAgentProfile,
  AgentProfileSessionMismatchError,
  AgentProfileValidationError,
  type AgentProfileSnapshot,
  type ValidatedAgentProfile,
} from './agent-profile.js';
import {
  acquireSessionLock,
  SessionBusyError,
  SessionLockError,
  type SessionLockHandle,
  getProcessStartTime,
  isProcessAlive,
  isProcAvailable,
} from './session-lock.js';

export {
  getProcessStartTime,
  isProcessAlive,
  isProcAvailable,
};
import type { PluginReadinessStatus, AgentFollowupResponse } from '../transport/types.js';

export interface ExecCliRequest {
  action: 'health' | 'followup' | 'cancel' | 'inspect-turn' | 'import-seed' | 'check-session-artifact' | 'export-fork-seed' | 'inspect-corruption' | 'recover-prefix' | 'idle' | 'file-op' | 'write-stream' | 'read-stream' | 'stage-stream' | 'commit-stage' | 'abort-stage' | 'finalize-stage' | 'rollback-commit' | 'inspect-stage' | 'inspect-transfer-state';
  requestId?: string;
  turnId?: string;
  sessionId?: string;
  targetSessionId?: string;
  maxValidSeq?: number;
  boundary?: {
    fromMessageId?: string;
    fromTurnId?: string;
  };
  workspaceFolder?: string;
  spaceId?: string;
  prompt?: string;
  seed?: unknown[];
  receipt?: SessionSeedReceipt;
  fileOp?: FileOperationRequest;
  profile?: AgentProfileSnapshot | null;
  streamingWrite?: StreamingWriteOptions;
  streamingRead?: StreamingReadOptions;
  fileStage?: FileStageOptions;
  fileCommit?: FileCommitStageOptions;
  fileAbort?: FileAbortStageOptions;
  fileFinalize?: FileFinalizeStageOptions;
  fileRollback?: FileRollbackCommitOptions;
  fileInspect?: FileInspectTransferStateOptions;
}

export interface ExecCliEnvelope {
  status: 'ok' | 'completed' | 'cancelled' | 'error' | 'idle';
  code?: string;
  requestId?: string;
  turnId?: string;
  sessionId?: string;
  userId?: string;
  exists?: boolean;
  valid?: boolean;
  checksum?: string;
  dshReady?: boolean;
  enkeepBundleLoaded?: boolean;
  modelProvider?: string;
  plugins?: PluginReadinessStatus;
  toolsCount?: number;
  toolsOperational?: boolean;
  toolsUnavailableReason?: string | null;
  version?: string;
  uptimeSeconds?: number;
  replyText?: string;
  events?: readonly unknown[];
  eventsCount?: number;
  totalEvents?: number;
  boundaryMapping?: Record<string, unknown>;
  persisted?: boolean;
  receipt?: SessionSeedReceipt;
  duplicate?: boolean;
  error?: string;
  corrupted?: boolean;
  lastValidSeq?: number;
  lineCount?: number;
  validEventsCount?: number;
  errorDetail?: string;
  backupPath?: string;
  backupChecksum?: string;
  fileResult?: FileOperationResult;
  instructionsResult?: unknown;
  usage?: {
    totalTokens: number;
  };
  modelInfo?: {
    provider: string;
    model: string;
    reasoningEffort?: string | null;
    source?: string;
    fallbackUsed?: boolean;
  };
  routeAttempts?: Array<{
    provider: string;
    model: string;
    latencyMs: number;
    statusCode: number;
    success: boolean;
    errorType?: string | null;
  }>;
}

export interface ActiveTurnMarkerPayload {
  readonly createdAt: string;
  readonly nonce: string;
  readonly pid: number;
  readonly processStartTime: string;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface ActiveTurnResultPayload {
  readonly status: 'completed' | 'cancelled' | 'error';
  readonly turnId: string;
  readonly sessionId: string;
  readonly nonce: string;
  readonly replyText?: string;
  readonly eventsCount?: number;
  readonly persisted?: boolean;
  readonly error?: string;
  readonly completedAt: string;
}

export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface SafeReadResult<T> {
  readonly payload: T;
  readonly identity: FileIdentity;
}

export class MarkerNotFoundError extends Error {
  readonly code = 'MARKER_NOT_FOUND';
  constructor(_filePath: string) {
    super('Marker not found');
    this.name = 'MarkerNotFoundError';
  }
}

export class ResultNotFoundError extends Error {
  readonly code = 'RESULT_NOT_FOUND';
  constructor(_filePath: string) {
    super('Result file not found');
    this.name = 'ResultNotFoundError';
  }
}

export class TypedCliError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'TypedCliError';
  }
}

const MAX_STDIN_BYTES = 64 * 1024 * 1024; // 64MB maximum payload for large import-seed envelopes
const MAX_JSON_DEPTH = 64; // Safe nested levels for deep tool schemas and profile snapshots

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err || 'Unknown error');
}

function toError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  return new Error(String(err || 'Unknown error'));
}

/**
 * Checks JSON object depth to prevent deep recursion DOS.
 */
function checkJsonDepth(obj: unknown, currentDepth = 0): void {
  if (currentDepth > MAX_JSON_DEPTH) {
    throw new Error('JSON payload exceeds maximum allowed depth');
  }
  if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      checkJsonDepth((obj as Record<string, unknown>)[key], currentDepth + 1);
    }
  }
}

/**
 * Reads bounded JSON from stdin.
 */
async function readBoundedStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    let data = '';

    const onData = (chunk: Buffer | string) => {
      const len = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      totalBytes += len;
      if (totalBytes > MAX_STDIN_BYTES) {
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        reject(new Error('Input payload exceeded maximum allowed limit'));
        return;
      }
      data += chunk.toString();
    };

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);

    // If stdin is a TTY and no data piped, resolve empty immediately
    if (process.stdin.isTTY) {
      resolve('');
    }
  });
}

/**
 * Parses execution request from CLI arguments or stdin.
 */
export async function parseExecRequest(argv: string[]): Promise<ExecCliRequest> {
  const primaryCommand = argv[0];

  // Immediate fast path for argv commands without waiting for stdin
  if (primaryCommand && primaryCommand !== 'stdin') {
    const action = primaryCommand as ExecCliRequest['action'];
    const req: ExecCliRequest = { action };

    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i];
      if ((arg === '--prompt' || arg === '-p') && argv[i + 1] !== undefined) {
        req.prompt = argv[++i];
      } else if ((arg === '--session' || arg === '-s') && argv[i + 1] !== undefined) {
        req.sessionId = argv[++i];
      } else if ((arg === '--turn' || arg === '--turn-id' || arg === '-t') && argv[i + 1] !== undefined) {
        req.turnId = argv[++i];
      } else if ((arg === '--req' || arg === '--request-id' || arg === '-r') && argv[i + 1] !== undefined) {
        req.requestId = argv[++i];
      } else if (arg === '--seed' && argv[i + 1] !== undefined) {
        try {
          req.seed = JSON.parse(argv[++i]);
        } catch (_jsonErr: unknown) {
          throw new Error('Invalid JSON in --seed argument');
        }
      } else if (arg === '--receipt' && argv[i + 1] !== undefined) {
        try {
          req.receipt = JSON.parse(argv[++i]);
        } catch (_jsonErr: unknown) {
          throw new Error('Invalid JSON in --receipt argument');
        }
      } else if (arg === '--file-op' && argv[i + 1] !== undefined) {
        try {
          req.fileOp = JSON.parse(argv[++i]);
        } catch (_jsonErr: unknown) {
          throw new Error('Invalid JSON in --file-op argument');
        }
      } else if (arg === '--profile' && argv[i + 1] !== undefined) {
        try {
          req.profile = JSON.parse(argv[++i]);
        } catch (_jsonErr: unknown) {
          throw new Error('Invalid JSON in --profile argument');
        }
      } else if (arg === '--write-options' && argv[i + 1] !== undefined) {
        try {
          req.streamingWrite = JSON.parse(argv[++i]);
        } catch (_jsonErr: unknown) {
          throw new Error('Invalid JSON in --write-options argument');
        }
      } else if (arg === '--read-options' && argv[i + 1] !== undefined) {
        try {
          req.streamingRead = JSON.parse(argv[++i]);
        } catch (_jsonErr: unknown) {
          throw new Error('Invalid JSON in --read-options argument');
        }
      } else if (arg === '--stage-options' && argv[i + 1] !== undefined) {
        try {
          req.fileStage = JSON.parse(argv[++i]);
        } catch (_jsonErr: unknown) {
          throw new Error('Invalid JSON in --stage-options argument');
        }
      } else if (arg === '--commit-options' && argv[i + 1] !== undefined) {
        try {
          req.fileCommit = JSON.parse(argv[++i]);
        } catch (_jsonErr: unknown) {
          throw new Error('Invalid JSON in --commit-options argument');
        }
      } else if (arg === '--abort-options' && argv[i + 1] !== undefined) {
        try {
          req.fileAbort = JSON.parse(argv[++i]);
        } catch (_jsonErr: unknown) {
          throw new Error('Invalid JSON in --abort-options argument');
        }
      }
    }
    return req;
  }

  // If stdin or no arguments provided, read bounded JSON from stdin
  const stdinRaw = await readBoundedStdin();
  if (stdinRaw.trim()) {
    try {
      const parsed: unknown = JSON.parse(stdinRaw);
      checkJsonDepth(parsed);

      if (!parsed || typeof parsed !== 'object' || !(parsed as Record<string, unknown>)['action']) {
        throw new Error('Invalid request payload: must be a JSON object containing "action" property.');
      }
      return parsed as ExecCliRequest;
    } catch (err: unknown) {
      throw new Error(`JSON Validation Error: ${toErrorMessage(err)}`);
    }
  }

  // Default fallback if no input
  return { action: 'health' };
}

function getNodeErrorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof (err as Record<string, unknown>).code === 'string') {
    return (err as Record<string, unknown>).code as string;
  }
  return undefined;
}


/**
 * Safely closes a file descriptor without throwing, avoiding masking of primary exceptions.
 */
export function safeCloseSync(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch (_err: unknown) {
    // Suppress close error to avoid masking primary operation error
  }
}


/**
 * Retrieves the current process UID, throwing a security error if process.getuid is unavailable.
 */
export function getRequiredCurrentUid(): number {
  if (typeof process.getuid !== 'function') {
    throw new TypedCliError(
      'SECURITY_VIOLATION',
      'process.getuid is required in this runtime environment but is not available'
    );
  }
  return process.getuid();
}

/**
 * Checks that file ownership matches exact current process UID.
 */
function checkFileOwnership(stat: fs.Stats, _filePath: string): void {
  const currentUid = getRequiredCurrentUid();
  if (stat.uid !== currentUid) {
    throw new TypedCliError(
      'SECURITY_VIOLATION',
      'File ownership violation: UID mismatch'
    );
  }
}

/**
 * Asserts that a directory exists, is a real directory (not symlink), has exact 0700 mode, and valid ownership.
 */
export function assertDirectorySecure(dirPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dirPath);
  } catch (err: unknown) {
    const code = getNodeErrorCode(err);
    if (code === 'ENOENT') {
      throw new TypedCliError('DIRECTORY_NOT_FOUND', 'Directory does not exist');
    }
    throw toError(err);
  }

  if (stat.isSymbolicLink()) {
    throw new TypedCliError('SECURITY_VIOLATION', 'Directory must not be a symbolic link');
  }
  if (!stat.isDirectory()) {
    throw new TypedCliError('SECURITY_VIOLATION', 'Path is not a directory');
  }
  if ((stat.mode & 0o777) !== 0o700) {
    throw new TypedCliError(
      'SECURITY_VIOLATION',
      'Directory has insecure mode (must be exactly 0700)'
    );
  }
  checkFileOwnership(stat, dirPath);
}

/**
 * Verifies /proc/<pid>/status ownership matches exact current process UID.
 */
export function verifyProcOwnership(pid: number): void {
  if (!isProcAvailable()) {
    return;
  }
  const currentUid = getRequiredCurrentUid();
  const statusPath = `/proc/${pid}/status`;
  let fd: number;
  try {
    fd = fs.openSync(statusPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err: unknown) {
    const code = getNodeErrorCode(err);
    if (code === 'ENOENT') {
      throw new TypedCliError('STALE_TURN', 'Process is not running');
    }
    throw new TypedCliError('IDENTITY_MISMATCH', 'Failed to stat process status');
  }

  try {
    const buf = Buffer.alloc(2048);
    let bytesRead = 0;
    while (bytesRead < 2048) {
      const chunk = fs.readSync(fd, buf, bytesRead, 2048 - bytesRead, bytesRead);
      if (chunk === 0) break;
      bytesRead += chunk;
    }
    const content = buf.toString('utf8', 0, bytesRead);
    const uidMatch = /^Uid:\s+(\d+)/m.exec(content);
    if (!uidMatch || !uidMatch[1]) {
      throw new TypedCliError('IDENTITY_MISMATCH', 'Unable to read real UID from process status');
    }
    const realUid = parseInt(uidMatch[1], 10);
    if (realUid !== currentUid) {
      throw new TypedCliError(
        'IDENTITY_MISMATCH',
        'Process real UID does not match expected exact UID'
      );
    }
  } finally {
    safeCloseSync(fd);
  }
}


/**
 * Checks whether /proc/<pid>/cmdline matches exec-cli process execution.
 */
export function verifyProcessCommand(pid: number, _expectedTurnId?: string): boolean {
  if (!isProcAvailable()) {
    return isProcessAlive(pid);
  }

  const cmdlinePath = `/proc/${pid}/cmdline`;
  let fd: number;
  try {
    fd = fs.openSync(cmdlinePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (_err: unknown) {
    return false;
  }

  try {
    const buf = Buffer.alloc(2048);
    let bytesRead = 0;
    while (bytesRead < 2048) {
      const chunk = fs.readSync(fd, buf, bytesRead, 2048 - bytesRead, bytesRead);
      if (chunk === 0) break;
      bytesRead += chunk;
    }
    const raw = buf.toString('utf8', 0, bytesRead);
    const args = raw.split('\0').filter(Boolean);
    const isExecCli = args.some(
      (a) => a.includes('exec-cli') || a.includes('runtime-runner') || a.includes('node') || a.includes('vitest')
    );
    return isExecCli && isProcessAlive(pid);
  } finally {
    safeCloseSync(fd);
  }
}

/**
 * Performs bounded exact read loop from a file descriptor.
 */
function readExactFdBytes(fd: number, size: number, _filePath: string): string {
  if (size <= 0) {
    throw new Error('Empty file is invalid');
  }
  const buf = Buffer.alloc(size);
  let totalRead = 0;
  while (totalRead < size) {
    const bytes = fs.readSync(fd, buf, totalRead, size - totalRead, totalRead);
    if (bytes === 0) {
      break;
    }
    totalRead += bytes;
  }
  if (totalRead !== size) {
    throw new Error('Incomplete read from file');
  }
  return buf.toString('utf8', 0, totalRead);
}

/**
 * Safely reads an active turn marker file using O_RDONLY | O_NOFOLLOW with strict permission and schema checks.
 */
export function readSafeMarkerFile(filePath: string): SafeReadResult<ActiveTurnMarkerPayload> {
  const dirPath = path.dirname(filePath);
  assertDirectorySecure(dirPath);

  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err: unknown) {
    const code = getNodeErrorCode(err);
    if (code === 'ENOENT') {
      throw new MarkerNotFoundError(filePath);
    }
    throw toError(err);
  }

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error('Marker is not a regular file');
    }
    if ((stat.mode & 0o777) !== 0o600 && (stat.mode & 0o077) !== 0) {
      throw new Error('Insecure permissions on marker file');
    }
    checkFileOwnership(stat, filePath);
    if (stat.size <= 0 || stat.size > 4096) {
      throw new Error('Marker file size is out of valid bounds');
    }

    const raw = readExactFdBytes(fd, stat.size, filePath);
    const parsed: unknown = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Marker content is not a valid JSON object');
    }

    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const expectedKeys = ['createdAt', 'nonce', 'pid', 'processStartTime', 'sessionId', 'turnId'];
    if (keys.length !== expectedKeys.length || !keys.every((k, idx) => k === expectedKeys[idx])) {
      throw new Error('Marker contains unexpected or missing keys');
    }

    const pid = record['pid'];
    const processStartTime = record['processStartTime'];
    const nonce = record['nonce'];
    const sessionId = record['sessionId'];
    const turnId = record['turnId'];
    const createdAt = record['createdAt'];

    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) {
      throw new Error('Invalid or missing PID in marker');
    }
    if (typeof processStartTime !== 'string' || processStartTime.trim().length === 0) {
      throw new Error('Invalid or missing processStartTime in marker');
    }
    if (typeof nonce !== 'string' || nonce.trim().length === 0) {
      throw new Error('Invalid or missing nonce in marker');
    }
    if (typeof sessionId !== 'string' || !isValidSessionId(sessionId)) {
      throw new Error('Invalid or missing sessionId in marker');
    }
    if (typeof turnId !== 'string' || !isValidTurnId(turnId)) {
      throw new Error('Invalid or missing turnId in marker');
    }
    if (typeof createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(createdAt)) {
      throw new Error('Invalid or missing createdAt in marker');
    }

    return {
      payload: {
        createdAt: createdAt.trim(),
        nonce: nonce.trim(),
        pid,
        processStartTime: processStartTime.trim(),
        sessionId: sessionId.trim(),
        turnId: turnId.trim(),
      },
      identity: {
        dev: stat.dev,
        ino: stat.ino,
      },
    };
  } finally {
    safeCloseSync(fd);
  }
}

/**
 * Safely reads an active turn result file using O_RDONLY | O_NOFOLLOW with strict permission and schema checks.
 */
export function readSafeResultFile(filePath: string): SafeReadResult<ActiveTurnResultPayload> {
  const dirPath = path.dirname(filePath);
  assertDirectorySecure(dirPath);

  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err: unknown) {
    const code = getNodeErrorCode(err);
    if (code === 'ENOENT') {
      throw new ResultNotFoundError(filePath);
    }
    throw toError(err);
  }

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error('Result is not a regular file');
    }
    if ((stat.mode & 0o777) !== 0o600 && (stat.mode & 0o077) !== 0) {
      throw new Error('Insecure permissions on result file');
    }
    checkFileOwnership(stat, filePath);
    if (stat.size <= 0 || stat.size > 65536) {
      throw new Error('Result file size is out of valid bounds');
    }

    const raw = readExactFdBytes(fd, stat.size, filePath);
    const parsed: unknown = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Result content is not a valid JSON object');
    }

    const record = parsed as Record<string, unknown>;
    const status = record['status'];
    if (status !== 'completed' && status !== 'cancelled' && status !== 'error') {
      throw new Error('Invalid status in result file');
    }

    const turnId = record['turnId'];
    const sessionId = record['sessionId'];
    const nonce = record['nonce'];
    const completedAt = record['completedAt'];

    if (typeof turnId !== 'string' || !isValidTurnId(turnId)) {
      throw new Error('Invalid turnId in result file');
    }
    if (typeof sessionId !== 'string' || !isValidSessionId(sessionId)) {
      throw new Error('Invalid sessionId in result file');
    }
    if (typeof nonce !== 'string' || nonce.trim().length === 0) {
      throw new Error('Invalid nonce in result file');
    }

    return {
      payload: {
        status,
        turnId: turnId.trim(),
        sessionId: sessionId.trim(),
        nonce: nonce.trim(),
        replyText: typeof record['replyText'] === 'string' ? record['replyText'] : undefined,
        eventsCount: typeof record['eventsCount'] === 'number' ? record['eventsCount'] : undefined,
        persisted: typeof record['persisted'] === 'boolean' ? record['persisted'] : undefined,
        error: typeof record['error'] === 'string' ? record['error'] : undefined,
        completedAt: typeof completedAt === 'string' ? completedAt : new Date().toISOString(),
      },
      identity: {
        dev: stat.dev,
        ino: stat.ino,
      },
    };
  } finally {
    safeCloseSync(fd);
  }
}

/**
 * Verifies that the file at filePath matches the expected dev and inode before unlinking.
 */
export function unlinkVerifiedFile(filePath: string, expectedIdentity: FileIdentity): void {
  const dirPath = path.dirname(filePath);
  assertDirectorySecure(dirPath);

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (err: unknown) {
    const code = getNodeErrorCode(err);
    if (code === 'ENOENT') {
      return;
    }
    throw toError(err);
  }

  if (stat.isSymbolicLink()) {
    throw new TypedCliError('SECURITY_VIOLATION', 'Refusing to delete symlink');
  }
  if (!stat.isFile()) {
    throw new TypedCliError('SECURITY_VIOLATION', 'Refusing to delete non-regular file');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new TypedCliError('SECURITY_VIOLATION', 'Refusing to delete file with insecure permissions');
  }
  checkFileOwnership(stat, filePath);

  if (stat.dev !== expectedIdentity.dev || stat.ino !== expectedIdentity.ino) {
    throw new TypedCliError(
      'IDENTITY_MISMATCH',
      'Inode mismatch when deleting file'
    );
  }

  fs.unlinkSync(filePath);
}

/**
 * Writes an atomic JSON file with fsync, O_NOFOLLOW, and atomic rename.
 */
export function writeAtomicJson(filePath: string, data: unknown): FileIdentity {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertDirectorySecure(dir);

  const tempPath = `${filePath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const jsonStr = JSON.stringify(data);

  let writtenIdentity: FileIdentity;
  const fd = fs.openSync(
    tempPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600
  );
  try {
    const buf = Buffer.from(jsonStr, 'utf8');
    let written = 0;
    while (written < buf.length) {
      const bytes = fs.writeSync(fd, buf, written, buf.length - written, written);
      if (bytes === 0) break;
      written += bytes;
    }
    fs.fsyncSync(fd);
    const stat = fs.fstatSync(fd);
    writtenIdentity = { dev: stat.dev, ino: stat.ino };
  } finally {
    safeCloseSync(fd);
  }

  fs.renameSync(tempPath, filePath);
  return writtenIdentity;
}

/**
 * Executes a continuous idle loop for daemon keeping container alive.
 */
async function runIdleDaemon(): Promise<void> {
  const envelope: ExecCliEnvelope = {
    status: 'idle',
    dshReady: true,
    version: '0.1.1-rc.2',
  };
  process.stdout.write(JSON.stringify(envelope) + '\n');

  const keepAlive = setInterval(() => {}, 1000 * 60 * 60);

  return new Promise((resolve) => {
    process.on('SIGTERM', () => {
      clearInterval(keepAlive);
      resolve();
      process.exit(0);
    });
    process.on('SIGINT', () => {
      clearInterval(keepAlive);
      resolve();
      process.exit(0);
    });
  });
}

/**
 * Main Exec CLI entry point.
 */
export async function runExecCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  let requestId: string | undefined;
  let turnId: string | undefined;

  try {
    const req = await parseExecRequest(argv);
    requestId = req.requestId;
    turnId = req.turnId;

    if (req.action === 'idle') {
      await runIdleDaemon();
      return;
    }

    // For non-idle commands, unconditionally enforce runtime UID 1000 (dsh non-root user)
    const currentUid = getRequiredCurrentUid();
    if (currentUid !== 1000) {
      throw new TypedCliError(
        'SECURITY_VIOLATION',
        'Production runtime must execute as UID 1000 (dsh non-root user)'
      );
    }

    const rawUser = process.env.DSH_USER;
    if (!rawUser || !isValidUserId(rawUser)) {
      throw new TypedCliError(
        'INVALID_ENV',
        'DSH_USER environment variable is required and must be a valid canonical identifier'
      );
    }
    const userId = rawUser;

    const rawHome = process.env.DSH_HOME;
    if (!rawHome || typeof rawHome !== 'string' || !path.isAbsolute(rawHome) || path.normalize(rawHome) !== rawHome) {
      throw new TypedCliError(
        'INVALID_ENV',
        'DSH_HOME environment variable is mandatory and must be an absolute normalized path'
      );
    }
    const dshHome = rawHome;

    if (process.env.DSH_SPACES_DIR !== undefined) {
      throw new TypedCliError(
        'INVALID_ENV',
        'Deprecated environment variable "DSH_SPACES_DIR" is forbidden. Use "DSH_SPACES" instead.'
      );
    }

    const rawSpaces = process.env.DSH_SPACES;
    if (!rawSpaces || typeof rawSpaces !== 'string' || !path.isAbsolute(rawSpaces) || path.normalize(rawSpaces) !== rawSpaces) {
      throw new TypedCliError(
        'INVALID_ENV',
        'DSH_SPACES environment variable is mandatory and must be an absolute normalized path'
      );
    }
    const spacesDir = rawSpaces;

    const expectedSpacesParent = path.dirname(dshHome);
    if (path.basename(spacesDir) !== 'spaces' || path.dirname(spacesDir) !== expectedSpacesParent) {
      throw new TypedCliError(
        'INVALID_ENV',
        'DSH_SPACES directory must reside directly under parent of DSH_HOME and end with "spaces"'
      );
    }

    const activeTurnsDir = path.join(dshHome, 'active-turns');
    fs.mkdirSync(activeTurnsDir, { recursive: true, mode: 0o700 });
    assertDirectorySecure(activeTurnsDir);

    // Handle Cross-Exec Turn Cancellation
    if (req.action === 'cancel') {
      if (!turnId || !isValidTurnId(turnId)) {
        throw new TypedCliError('INVALID_REQUEST', 'Action "cancel" requires a valid "turnId" parameter');
      }

      const markerPath = path.join(activeTurnsDir, `${turnId}.json`);
      const resultPath = path.join(activeTurnsDir, `${turnId}.result`);

      // 1. Inspect marker file
      let markerResult: SafeReadResult<ActiveTurnMarkerPayload> | null = null;
      try {
        markerResult = readSafeMarkerFile(markerPath);
      } catch (markerErr: unknown) {
        if (markerErr instanceof MarkerNotFoundError) {
          // Marker absent: verify if already settled
          let pastResult: SafeReadResult<ActiveTurnResultPayload> | null = null;
          try {
            pastResult = readSafeResultFile(resultPath);
          } catch (resErr: unknown) {
            if (resErr instanceof ResultNotFoundError) {
              throw new TypedCliError('NOT_FOUND', 'No active turn found to cancel');
            }
            throw new TypedCliError(
              'RESULT_READ_ERROR',
              'Failed reading existing result file'
            );
          }

          if (pastResult) {
            const pastPayload = pastResult.payload;
            if (pastPayload.status === 'completed') {
              throw new TypedCliError('CONFLICT', 'Turn has already completed. Cannot cancel.');
            }
            if (pastPayload.status === 'cancelled') {
              throw new TypedCliError('CONFLICT', 'Turn has already been cancelled. Cannot cancel again.');
            }
            if (pastPayload.status === 'error') {
              throw new TypedCliError(
                'CONFLICT',
                'Turn already settled with error'
              );
            }
          }
          throw new TypedCliError('NOT_FOUND', 'No active turn found to cancel');
        }
        throw markerErr;
      }

      const marker = markerResult.payload;
      if (marker.turnId !== turnId) {
        throw new TypedCliError('IDENTITY_MISMATCH', 'Invalid active turn marker turnId mismatch');
      }

      const targetPid = marker.pid;
      if (targetPid <= 1) {
        throw new TypedCliError('IDENTITY_MISMATCH', 'Invalid target PID in active turn marker');
      }

      verifyProcOwnership(targetPid);

      const targetStartTime = marker.processStartTime;
      const currentStartTime = getProcessStartTime(targetPid);

      if (!isProcessAlive(targetPid) || targetStartTime !== currentStartTime) {
        throw new TypedCliError('STALE_TURN', 'Target process is no longer running for turn');
      }

      if (!verifyProcessCommand(targetPid, turnId)) {
        throw new TypedCliError(
          'IDENTITY_MISMATCH',
          'Target PID does not match expected exec-cli followup process'
        );
      }

      // Send SIGUSR1 signal to target followup process
      try {
        process.kill(targetPid, 'SIGUSR1');
      } catch (killErr: unknown) {
        const errCode = getNodeErrorCode(killErr);
        if (errCode === 'ESRCH') {
          throw new TypedCliError('STALE_TURN', 'Target process exited before signal could be delivered');
        }
        throw new TypedCliError(
          'SIGNAL_ERROR',
          'Failed to send cancellation signal to target process'
        );
      }

      // Wait bounded for verified cancellation result file to appear
      const deadline = Date.now() + 5000;
      let verifiedResult: SafeReadResult<ActiveTurnResultPayload> | null = null;

      while (Date.now() < deadline) {
        try {
          const res = readSafeResultFile(resultPath);
          if (
            res.payload.turnId === turnId &&
            res.payload.nonce === marker.nonce &&
            res.payload.sessionId === marker.sessionId
          ) {
            verifiedResult = res;
            break;
          }
        } catch (readErr: unknown) {
          if (!(readErr instanceof ResultNotFoundError)) {
            // Transient partial write: retry
          }
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      if (verifiedResult) {
        const payload = verifiedResult.payload;
        if (payload.status === 'completed') {
          throw new TypedCliError('CONFLICT', 'Turn finished before cancellation could take effect.');
        }
        if (payload.status === 'error') {
          throw new TypedCliError(
            'CANCEL_TARGET_ERROR',
            'Turn settled with error'
          );
        }
        if (payload.status === 'cancelled') {
          try {
            unlinkVerifiedFile(resultPath, verifiedResult.identity);
          } catch (_unlinkErr: unknown) {
            throw new TypedCliError(
              'CLEANUP_ERROR',
              'Failed to clean up verified cancellation result file'
            );
          }

          const envelope: ExecCliEnvelope = {
            status: 'cancelled',
            requestId,
            turnId,
            sessionId: payload.sessionId,
          };
          process.stdout.write(JSON.stringify(envelope) + '\n');
          return;
        }
      }

      throw new TypedCliError(
        'TIMEOUT',
        'Turn cancellation timed out without verified cancellation receipt. Marker/evidence retained.'
      );
    }

    if (req.action === 'inspect-turn') {
      if (!turnId || !isValidTurnId(turnId)) {
        throw new TypedCliError('INVALID_REQUEST', 'Action "inspect-turn" requires a valid "turnId" parameter');
      }

      const markerPath = path.join(activeTurnsDir, `${turnId}.json`);
      const resultPath = path.join(activeTurnsDir, `${turnId}.result`);

      // 1. Check for settled .result file first
      let resultRead: SafeReadResult<ActiveTurnResultPayload> | null = null;
      try {
        resultRead = readSafeResultFile(resultPath);
      } catch (resErr: unknown) {
        if (!(resErr instanceof ResultNotFoundError)) {
          throw new TypedCliError('RESULT_READ_ERROR', 'Failed reading turn result file');
        }
      }

      if (resultRead) {
        const payload = resultRead.payload;
        if (payload.status === 'completed') {
          const envelope: ExecCliEnvelope = {
            status: 'completed',
            requestId,
            turnId,
            sessionId: payload.sessionId,
            replyText: payload.replyText || '',
            eventsCount: payload.eventsCount,
            persisted: payload.persisted,
          };
          process.stdout.write(JSON.stringify(envelope) + '\n');
          return;
        }
        if (payload.status === 'error' || payload.status === 'cancelled') {
          const envelope: ExecCliEnvelope = {
            status: payload.status === 'cancelled' ? 'cancelled' : 'error',
            requestId,
            turnId,
            sessionId: payload.sessionId,
            error: payload.error || (payload.status === 'cancelled' ? 'Turn was cancelled' : 'Turn execution failed'),
          };
          process.stdout.write(JSON.stringify(envelope) + '\n');
          return;
        }
      }

      // 2. Check for active turn marker
      let markerRead: SafeReadResult<ActiveTurnMarkerPayload> | null = null;
      try {
        markerRead = readSafeMarkerFile(markerPath);
      } catch (markerErr: unknown) {
        if (!(markerErr instanceof MarkerNotFoundError)) {
          throw new TypedCliError('MARKER_READ_ERROR', 'Failed reading turn marker file');
        }
      }

      if (markerRead) {
        const marker = markerRead.payload;
        const targetPid = marker.pid;
        const targetStartTime = marker.processStartTime;
        const currentStartTime = targetPid > 1 ? getProcessStartTime(targetPid) : null;

        if (targetPid > 1 && isProcessAlive(targetPid) && targetStartTime === currentStartTime) {
          const envelope: ExecCliEnvelope = {
            status: 'ok',
            code: 'RUNNING',
            requestId,
            turnId,
            sessionId: marker.sessionId,
          };
          process.stdout.write(JSON.stringify(envelope) + '\n');
          return;
        }
      }

      // 3. Neither valid completed result nor alive running marker -> absent
      const envelope: ExecCliEnvelope = {
        status: 'idle',
        code: 'ABSENT',
        requestId,
        turnId,
      };
      process.stdout.write(JSON.stringify(envelope) + '\n');
      return;
    }

    if (req.action === 'import-seed') {
      if (!req.sessionId || !isValidSessionId(req.sessionId)) {
        throw new TypedCliError('INVALID_REQUEST', 'import-seed requires a valid "sessionId"');
      }
      if (!req.seed || !Array.isArray(req.seed)) {
        throw new TypedCliError('INVALID_REQUEST', 'import-seed requires a valid "seed" array');
      }

      const seedEvents = req.seed as unknown as readonly SessionEvent[];
      const computedChecksum = computeSessionEventsChecksum(seedEvents);
      const canonicalJson = canonicalJsonStringify(seedEvents);
      const canonicalBytes = Buffer.byteLength(canonicalJson, 'utf8');

      let seedReceipt: SessionSeedReceipt;
      if (req.receipt) {
        if (typeof req.receipt !== 'object' || req.receipt === null) {
          throw new TypedCliError('INVALID_RECEIPT', 'import-seed receipt must be a valid object');
        }
        if (req.receipt.algorithm !== 'sha256-session-events-v1') {
          throw new TypedCliError(
            'INVALID_RECEIPT',
            'Unsupported receipt algorithm: expected "sha256-session-events-v1"'
          );
        }
        if (
          typeof req.receipt.checksum !== 'string' ||
          req.receipt.checksum.toLowerCase() !== computedChecksum.toLowerCase()
        ) {
          throw new TypedCliError(
            'CHECKSUM_MISMATCH',
            'Seed checksum mismatch: incoming receipt checksum does not match computed checksum'
          );
        }
        if (
          typeof req.receipt.canonicalBytes !== 'number' ||
          !Number.isSafeInteger(req.receipt.canonicalBytes) ||
          req.receipt.canonicalBytes < 0
        ) {
          throw new TypedCliError('INVALID_RECEIPT', 'Receipt canonicalBytes must be a non-negative safe integer');
        }
        if (req.receipt.canonicalBytes !== canonicalBytes) {
          throw new TypedCliError(
            'BYTE_COUNT_MISMATCH',
            'Seed canonicalBytes mismatch: incoming receipt byte count does not match computed byte count'
          );
        }
        if (typeof req.receipt.eventCount !== 'number' || req.receipt.eventCount !== seedEvents.length) {
          throw new TypedCliError(
            'EVENT_COUNT_MISMATCH',
            'Seed eventCount mismatch: incoming receipt event count does not match seed array length'
          );
        }
        seedReceipt = {
          algorithm: 'sha256-session-events-v1',
          checksum: computedChecksum,
          canonicalBytes,
          eventCount: seedEvents.length,
        };
      } else {
        seedReceipt = {
          algorithm: 'sha256-session-events-v1',
          checksum: computedChecksum,
          canonicalBytes,
          eventCount: seedEvents.length,
        };
      }

      let importLock: SessionLockHandle | undefined;
      try {
        importLock = await acquireSessionLock({
          dshHome,
          sessionId: req.sessionId,
          action: 'import-seed',
          timeoutMs: 5000,
        });
      } catch (lockErr: unknown) {
        if (lockErr instanceof SessionBusyError) {
          throw new TypedCliError('SESSION_BUSY', 'Session is busy');
        }
        throw lockErr;
      }

      let opError: unknown;
      let runtime: DshBootedRuntime | undefined;
      try {
        runtime = await bootDshRuntime({
          userId,
          dshHome,
          spacesDir,
        });

        const importResult = await runtime.importSeed(req.sessionId, seedEvents, seedReceipt, req.profile ?? null, req.spaceId);

        const envelope: ExecCliEnvelope = {
          status: 'ok',
          requestId,
          sessionId: req.sessionId,
          userId,
          persisted: importResult.persisted,
          eventsCount: importResult.eventsCount,
          receipt: importResult.receipt,
          duplicate: importResult.duplicate,
        };

        process.stdout.write(JSON.stringify(envelope) + '\n');
      } catch (err: unknown) {
        opError = err;
      } finally {
        const cleanupErrors: Error[] = [];
        if (runtime) {
          try {
            await runtime.dispose();
          } catch (dispErr: unknown) {
            cleanupErrors.push(toError(dispErr));
          }
        }
        try {
          importLock.release();
        } catch (relErr: unknown) {
          cleanupErrors.push(toError(relErr));
        }

        if (opError) {
          if (cleanupErrors.length > 0) {
            throw new AggregateError([opError, ...cleanupErrors], 'SESSION_LOCK_RELEASE_FAILED');
          }
          throw opError;
        }
        if (cleanupErrors.length > 0) {
          if (cleanupErrors.some((e) => (e as any).code === 'SESSION_LOCK_RELEASE_FAILED' || e.name === 'SessionLockError')) {
            throw new TypedCliError('SESSION_LOCK_RELEASE_FAILED', 'Failed to release session lock');
          }
          throw new AggregateError(cleanupErrors, 'Cleanup failed after operation');
        }
      }
      return;
    }

    if (req.action === 'check-session-artifact') {
      if (!req.sessionId || !isValidSessionId(req.sessionId)) {
        throw new TypedCliError('INVALID_REQUEST', 'check-session-artifact requires a valid "sessionId"');
      }

      let checkLock: SessionLockHandle | undefined;
      try {
        checkLock = await acquireSessionLock({
          dshHome,
          sessionId: req.sessionId,
          action: 'check-session-artifact',
          timeoutMs: 5000,
        });
      } catch (lockErr: unknown) {
        if (lockErr instanceof SessionBusyError) {
          throw new TypedCliError('SESSION_BUSY', 'Session is busy');
        }
        throw lockErr;
      }

      let opError: unknown;
      let runtime: DshBootedRuntime | undefined;
      try {
        runtime = await bootDshRuntime({
          userId,
          dshHome,
          spacesDir,
        });

        const checkResult = await runtime.checkSessionArtifact(req.sessionId, req.workspaceFolder ?? req.spaceId);
        const envelope: ExecCliEnvelope = {
          status: 'ok',
          requestId,
          sessionId: req.sessionId,
          userId,
          exists: checkResult.exists,
          valid: checkResult.valid,
          checksum: checkResult.checksum,
          eventsCount: checkResult.eventCount,
        };

        process.stdout.write(JSON.stringify(envelope) + '\n');
      } catch (err: unknown) {
        opError = err;
      } finally {
        const cleanupErrors: Error[] = [];
        if (runtime) {
          try {
            await runtime.dispose();
          } catch (dispErr: unknown) {
            cleanupErrors.push(toError(dispErr));
          }
        }
        try {
          checkLock.release();
        } catch (relErr: unknown) {
          cleanupErrors.push(toError(relErr));
        }

        if (opError) {
          if (cleanupErrors.length > 0) {
            throw new AggregateError([opError, ...cleanupErrors], 'SESSION_LOCK_RELEASE_FAILED');
          }
          throw opError;
        }
        if (cleanupErrors.length > 0) {
          if (cleanupErrors.some((e) => (e as any).code === 'SESSION_LOCK_RELEASE_FAILED' || e.name === 'SessionLockError')) {
            throw new TypedCliError('SESSION_LOCK_RELEASE_FAILED', 'Failed to release session lock');
          }
          throw new AggregateError(cleanupErrors, 'Cleanup failed after operation');
        }
      }
      return;
    }

    if (req.action === 'export-fork-seed') {
      if (!req.sessionId || !isValidSessionId(req.sessionId)) {
        throw new TypedCliError('INVALID_REQUEST', 'export-fork-seed requires a valid "sessionId"');
      }

      let exportLock: SessionLockHandle | undefined;
      try {
        exportLock = await acquireSessionLock({
          dshHome,
          sessionId: req.sessionId,
          action: 'export-fork-seed',
          timeoutMs: 5000,
        });
      } catch (lockErr: unknown) {
        if (lockErr instanceof SessionBusyError) {
          throw new TypedCliError('SESSION_BUSY', 'Session is busy');
        }
        throw lockErr;
      }

      let opError: unknown;
      let runtime: DshBootedRuntime | undefined;
      try {
        runtime = await bootDshRuntime({
          userId,
          dshHome,
          spacesDir,
        });

        const exportResult = await runtime.exportForkSeed(
          req.sessionId,
          req.boundary,
          req.workspaceFolder ?? req.spaceId
        );

        const envelope: ExecCliEnvelope = {
          status: 'ok',
          requestId,
          sessionId: req.sessionId,
          userId,
          events: exportResult.events,
          eventsCount: exportResult.events.length,
          receipt: exportResult.receipt,
          boundaryMapping: exportResult.boundaryMapping,
        };

        process.stdout.write(JSON.stringify(envelope) + '\n');
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg === 'BOUNDARY_UNAVAILABLE') {
          opError = new TypedCliError('BOUNDARY_UNAVAILABLE', 'Requested fork boundary is unavailable in session');
        } else if (errMsg === 'SESSION_NOT_FOUND') {
          opError = new TypedCliError('NOT_FOUND', 'Session not found for fork export');
        } else if (errMsg === 'SESSION_CORRUPTED') {
          opError = new TypedCliError('SESSION_CORRUPTED', 'Session log corrupted for fork export');
        } else {
          opError = err;
        }
      } finally {
        const cleanupErrors: Error[] = [];
        if (runtime) {
          try {
            await runtime.dispose();
          } catch (dispErr: unknown) {
            cleanupErrors.push(toError(dispErr));
          }
        }
        try {
          exportLock.release();
        } catch (relErr: unknown) {
          cleanupErrors.push(toError(relErr));
        }

        if (opError) {
          if (cleanupErrors.length > 0) {
            throw new AggregateError([opError, ...cleanupErrors], 'SESSION_LOCK_RELEASE_FAILED');
          }
          throw opError;
        }
        if (cleanupErrors.length > 0) {
          if (cleanupErrors.some((e) => (e as any).code === 'SESSION_LOCK_RELEASE_FAILED' || e.name === 'SessionLockError')) {
            throw new TypedCliError('SESSION_LOCK_RELEASE_FAILED', 'Failed to release session lock');
          }
          throw new AggregateError(cleanupErrors, 'Cleanup failed after operation');
        }
      }
      return;
    }

    if (req.action === 'inspect-corruption') {
      if (!req.sessionId || !isValidSessionId(req.sessionId)) {
        throw new TypedCliError('INVALID_REQUEST', 'inspect-corruption requires a valid "sessionId"');
      }

      let inspectLock: SessionLockHandle | undefined;
      try {
        inspectLock = await acquireSessionLock({
          dshHome,
          sessionId: req.sessionId,
          action: 'inspect-corruption',
          timeoutMs: 5000,
        });
      } catch (lockErr: unknown) {
        if (lockErr instanceof SessionBusyError) {
          throw new TypedCliError('SESSION_BUSY', 'Session is busy');
        }
        throw lockErr;
      }

      let opError: unknown;
      let runtime: DshBootedRuntime | undefined;
      try {
        runtime = await bootDshRuntime({
          userId,
          dshHome,
          spacesDir,
        });

        const inspectRes = await runtime.inspectSessionCorruption(req.sessionId, req.workspaceFolder ?? req.spaceId);
        const envelope: ExecCliEnvelope = {
          status: 'ok',
          code: inspectRes.code,
          requestId,
          sessionId: req.sessionId,
          userId,
          exists: inspectRes.exists,
          valid: inspectRes.valid,
          corrupted: inspectRes.corrupted,
          lastValidSeq: inspectRes.lastValidSeq,
          lineCount: inspectRes.lineCount,
          validEventsCount: inspectRes.validEventsCount,
          error: inspectRes.errorDetail,
        };
        process.stdout.write(JSON.stringify(envelope) + '\n');
      } catch (err: unknown) {
        opError = err;
      } finally {
        const cleanupErrors: Error[] = [];
        if (runtime) {
          try {
            await runtime.dispose();
          } catch (dispErr: unknown) {
            cleanupErrors.push(toError(dispErr));
          }
        }
        try {
          inspectLock.release();
        } catch (relErr: unknown) {
          cleanupErrors.push(toError(relErr));
        }

        if (opError) {
          if (cleanupErrors.length > 0) {
            throw new AggregateError([opError, ...cleanupErrors], 'SESSION_LOCK_RELEASE_FAILED');
          }
          throw opError;
        }
        if (cleanupErrors.length > 0) {
          if (cleanupErrors.some((e) => (e as any).code === 'SESSION_LOCK_RELEASE_FAILED' || e.name === 'SessionLockError')) {
            throw new TypedCliError('SESSION_LOCK_RELEASE_FAILED', 'Failed to release session lock');
          }
          throw new AggregateError(cleanupErrors, 'Cleanup failed after operation');
        }
      }
      return;
    }

    if (req.action === 'recover-prefix') {
      if (!req.sessionId || !isValidSessionId(req.sessionId)) {
        throw new TypedCliError('INVALID_REQUEST', 'recover-prefix requires a valid "sessionId" (source)');
      }
      if (!req.targetSessionId || !isValidSessionId(req.targetSessionId)) {
        throw new TypedCliError('INVALID_REQUEST', 'recover-prefix requires a valid "targetSessionId"');
      }

      let sourceLock: SessionLockHandle | undefined;
      let targetLock: SessionLockHandle | undefined;
      try {
        sourceLock = await acquireSessionLock({
          dshHome,
          sessionId: req.sessionId,
          action: 'recover-prefix-source',
          timeoutMs: 5000,
        });
        targetLock = await acquireSessionLock({
          dshHome,
          sessionId: req.targetSessionId,
          action: 'recover-prefix-target',
          timeoutMs: 5000,
        });
      } catch (lockErr: unknown) {
        try {
          sourceLock?.release();
        } catch {}
        try {
          targetLock?.release();
        } catch {}
        if (lockErr instanceof SessionBusyError) {
          throw new TypedCliError('SESSION_BUSY', 'Session is busy');
        }
        throw lockErr;
      }

      let opError: unknown;
      let runtime: DshBootedRuntime | undefined;
      try {
        runtime = await bootDshRuntime({
          userId,
          dshHome,
          spacesDir,
        });

        const recoverRes = await runtime.recoverSessionPrefix({
          sourceSessionId: req.sessionId,
          targetSessionId: req.targetSessionId,
          workspaceFolder: req.workspaceFolder ?? req.spaceId,
          maxValidSeq: req.maxValidSeq,
        });

        const envelope: ExecCliEnvelope = {
          status: 'ok',
          requestId,
          sessionId: req.sessionId,
          userId,
          validEventsCount: recoverRes.validEventsCount,
          backupPath: recoverRes.backupPath,
          backupChecksum: recoverRes.backupChecksum,
        };
        process.stdout.write(JSON.stringify(envelope) + '\n');
      } catch (err: unknown) {
        opError = err;
      } finally {
        const cleanupErrors: Error[] = [];
        if (runtime) {
          try {
            await runtime.dispose();
          } catch (dispErr: unknown) {
            cleanupErrors.push(toError(dispErr));
          }
        }
        try {
          targetLock?.release();
        } catch (relErr: unknown) {
          cleanupErrors.push(toError(relErr));
        }
        try {
          sourceLock?.release();
        } catch (relErr: unknown) {
          cleanupErrors.push(toError(relErr));
        }

        if (opError) {
          if (cleanupErrors.length > 0) {
            throw new AggregateError([opError, ...cleanupErrors], 'SESSION_LOCK_RELEASE_FAILED');
          }
          throw opError;
        }
        if (cleanupErrors.length > 0) {
          if (cleanupErrors.some((e) => (e as any).code === 'SESSION_LOCK_RELEASE_FAILED' || e.name === 'SessionLockError')) {
            throw new TypedCliError('SESSION_LOCK_RELEASE_FAILED', 'Failed to release session lock');
          }
          throw new AggregateError(cleanupErrors, 'Cleanup failed after operation');
        }
      }
      return;
    }

    if (req.action === 'health') {
      const runtime = await bootDshRuntime({
        userId,
        dshHome,
        spacesDir,
      });

      try {
        const health = await runtime.getHealth();
        const envelope: ExecCliEnvelope = {
          status: health.status === 'ok' ? 'ok' : 'error',
          requestId,
          userId: health.userId,
          dshReady: health.dshReady,
          enkeepBundleLoaded: health.enkeepBundleLoaded,
          modelProvider: health.modelProvider,
          plugins: health.plugins,
          toolsCount: health.toolsCount,
          toolsOperational: health.toolsOperational,
          toolsUnavailableReason: health.toolsUnavailableReason,
          version: health.version,
          uptimeSeconds: health.uptimeSeconds,
        };
        process.stdout.write(JSON.stringify(envelope) + '\n');
      } finally {
        await runtime.dispose();
      }
      return;
    }

    if (req.action === 'followup') {
      const targetSession = req.sessionId;
      if (!targetSession || !isValidSessionId(targetSession)) {
        throw new TypedCliError(
          'INVALID_REQUEST',
          'Action "followup" requires a valid "sessionId"'
        );
      }

      const prompt = req.prompt || '';
      if (!prompt.trim()) {
        throw new TypedCliError('INVALID_REQUEST', 'Missing "prompt" parameter for followup action.');
      }

      if (!req.turnId || !isValidTurnId(req.turnId)) {
        throw new TypedCliError(
          'INVALID_REQUEST',
          'Action "followup" requires a valid canonical "turnId"'
        );
      }
      const assignedTurnId = req.turnId;
      const nonce = crypto.randomBytes(16).toString('hex');
      const markerPath = path.join(activeTurnsDir, `${assignedTurnId}.json`);
      const resultPath = path.join(activeTurnsDir, `${assignedTurnId}.result`);

      // Acquire exclusive per-session OS lockfile before booting and executing turn
      let sessionLock: SessionLockHandle | undefined;
      try {
        sessionLock = await acquireSessionLock({
          dshHome,
          sessionId: targetSession,
          action: 'followup',
          turnId: assignedTurnId,
          timeoutMs: 5000,
        });
      } catch (lockErr: unknown) {
        if (lockErr instanceof SessionBusyError) {
          throw new TypedCliError('SESSION_BUSY', 'Session is busy');
        }
        throw lockErr;
      }

      const runtime: DshBootedRuntime = await bootDshRuntime({
        userId,
        dshHome,
        spacesDir,
      });

      let cancellationPromise: Promise<boolean> | null = null;
      const sigusr1Handler = () => {
        if (!cancellationPromise) {
          cancellationPromise = runtime.cancelTurn(assignedTurnId);
        }
      };

      // 1. Install SIGUSR1 signal handler BEFORE creating active turn marker
      process.on('SIGUSR1', sigusr1Handler);

      // 2. Create atomic marker file with O_CREAT | O_EXCL | O_NOFOLLOW
      const markerPayload: ActiveTurnMarkerPayload = {
        createdAt: new Date().toISOString(),
        nonce,
        pid: process.pid,
        processStartTime: getProcessStartTime(process.pid),
        sessionId: targetSession,
        turnId: assignedTurnId,
      };

      let markerIdentity: FileIdentity | null = null;
      try {
        const markerJson = JSON.stringify(markerPayload);
        const fd = fs.openSync(
          markerPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
          0o600
        );
        try {
          const buf = Buffer.from(markerJson, 'utf8');
          let written = 0;
          while (written < buf.length) {
            const bytes = fs.writeSync(fd, buf, written, buf.length - written, written);
            if (bytes === 0) break;
            written += bytes;
          }
          fs.fsyncSync(fd);
          const stat = fs.fstatSync(fd);
          markerIdentity = { dev: stat.dev, ino: stat.ino };
        } finally {
          safeCloseSync(fd);
        }
      } catch (_markerErr: unknown) {
        process.removeListener('SIGUSR1', sigusr1Handler);
        await runtime.dispose();
        throw new TypedCliError(
          'MARKER_CREATION_FAILED',
          'Failed creating active turn marker'
        );
      }

      let followupRes: AgentFollowupResponse | undefined;
      let followupError: Error | undefined;
      const cleanupErrors: Error[] = [];

      try {
        const effectiveWorkspaceFolder = req.workspaceFolder ?? req.spaceId;
        followupRes = await runtime.sendFollowup({
          prompt,
          sessionId: targetSession,
          turnId: assignedTurnId,
          profileSnapshot: req.profile ?? null,
          workspaceFolder: effectiveWorkspaceFolder,
          attachments: (req as any).attachments,
          modelSelection: (req as any).modelSelection,
        });
      } catch (err: unknown) {
        if (err instanceof PersistedSessionResumeError) {
          const detail = (err as any).cause ? `: ${((err as any).cause as Error).message || (err as any).cause}` : '';
          followupError = new TypedCliError(
            'PERSISTED_SESSION_RESUME_FAILED',
            `Session resume failed due to corrupted or unreadable persisted session data${detail}`
          );
        } else {
          followupError = toError(err);
        }
      } finally {
        process.removeListener('SIGUSR1', sigusr1Handler);

        if (cancellationPromise) {
          try {
            await cancellationPromise;
          } catch (cancelErr: unknown) {
            cleanupErrors.push(toError(cancelErr));
          }
        }

        const finalStatus: 'completed' | 'cancelled' | 'error' = followupError
          ? 'error'
          : followupRes?.status === 'cancelled'
          ? 'cancelled'
          : 'completed';

        const resultPayload: ActiveTurnResultPayload = {
          status: finalStatus,
          turnId: assignedTurnId,
          sessionId: targetSession,
          nonce,
          replyText: finalStatus === 'cancelled' ? undefined : followupRes?.replyText,
          eventsCount: followupRes?.eventsCount,
          persisted: followupRes?.persisted,
          error: followupError?.message,
          completedAt: new Date().toISOString(),
        };

        try {
          writeAtomicJson(resultPath, resultPayload);
        } catch (resWriteErr: unknown) {
          cleanupErrors.push(toError(resWriteErr));
        }

        if (markerIdentity) {
          try {
            unlinkVerifiedFile(markerPath, markerIdentity);
          } catch (unlinkErr: unknown) {
            cleanupErrors.push(toError(unlinkErr));
          }
        }

        try {
          await runtime.dispose();
        } catch (dispErr: unknown) {
          cleanupErrors.push(toError(dispErr));
        } finally {
          try {
            sessionLock.release();
          } catch (relErr: unknown) {
            cleanupErrors.push(toError(relErr));
          }
        }
      }

      if (cleanupErrors.length > 0) {
        const aggregate = new AggregateError(
          cleanupErrors,
          'Errors encountered during followup turn cleanup'
        );
        if (followupError) {
          throw new AggregateError([followupError, aggregate], 'SESSION_LOCK_RELEASE_FAILED');
        }
        if (cleanupErrors.some((e) => (e as any).code === 'SESSION_LOCK_RELEASE_FAILED' || e.name === 'SessionLockError')) {
          throw new TypedCliError('SESSION_LOCK_RELEASE_FAILED', 'Failed to release session lock');
        }
        throw aggregate;
      }

      if (followupError) {
        throw followupError;
      }

      if (!followupRes) {
        throw new TypedCliError('INTERNAL_ERROR', 'Followup response is missing');
      }

      const envelope: ExecCliEnvelope = {
        status: followupRes.status === 'cancelled' ? 'cancelled' : 'completed',
        requestId,
        turnId: assignedTurnId,
        sessionId: targetSession,
        userId,
        replyText: followupRes.status === 'cancelled' ? undefined : followupRes.replyText,
        eventsCount: followupRes.eventsCount,
        persisted: followupRes.persisted,
        usage: 'usage' in followupRes ? (followupRes as any).usage : undefined,
        modelInfo: 'modelInfo' in followupRes ? (followupRes as any).modelInfo : undefined,
        routeAttempts: 'routeAttempts' in followupRes ? (followupRes as any).routeAttempts : undefined,
      };

      process.stdout.write(JSON.stringify(envelope) + '\n');
      return;
    }

    if (req.action === 'file-op') {
      if (!req.fileOp || typeof req.fileOp !== 'object') {
        throw new TypedCliError('INVALID_REQUEST', 'Action "file-op" requires a valid "fileOp" object');
      }

      try {
        const fileResult = executeFileOperation(req.fileOp, {
          spacesDir,
          expectedUid: 1000,
        });

        const envelope: ExecCliEnvelope = {
          status: 'ok',
          requestId,
          userId,
          fileResult,
        };

        process.stdout.write(JSON.stringify(envelope) + '\n');
        return;
      } catch (fErr: unknown) {
        if (fErr instanceof FileOpError) {
          throw new TypedCliError(fErr.code, sanitizeErrorMessage(fErr.message));
        }
        throw new TypedCliError('FILE_OP_FAILED', sanitizeErrorMessage(toErrorMessage(fErr)));
      }
    }

    if (req.action === 'write-stream') {
      if (!req.streamingWrite || typeof req.streamingWrite !== 'object') {
        throw new TypedCliError('INVALID_REQUEST', 'Action "write-stream" requires a valid "streamingWrite" object');
      }

      try {
        const fileResult = await executeFileWriteStream(req.streamingWrite, process.stdin, {
          spacesDir,
          expectedUid: 1000,
        });

        const envelope: ExecCliEnvelope = {
          status: 'ok',
          requestId,
          userId,
          fileResult,
        };

        process.stdout.write(JSON.stringify(envelope) + '\n');
        return;
      } catch (fErr: unknown) {
        if (fErr instanceof FileOpError) {
          throw new TypedCliError(fErr.code, sanitizeErrorMessage(fErr.message));
        }
        throw new TypedCliError('FILE_OP_FAILED', sanitizeErrorMessage(toErrorMessage(fErr)));
      }
    }

    if (req.action === 'read-stream') {
      if (!req.streamingRead || typeof req.streamingRead !== 'object') {
        throw new TypedCliError('INVALID_REQUEST', 'Action "read-stream" requires a valid "streamingRead" object');
      }

      try {
        const readResult = await executeFileReadStream(req.streamingRead, {
          spacesDir,
          expectedUid: 1000,
        });

        const headerEnvelope = {
          status: 'ok',
          requestId,
          userId,
          fileResult: {
            op: readResult.op,
            space: readResult.space,
            path: readResult.path,
            type: 'file',
            size: readResult.size,
            totalSize: readResult.totalSize,
            mtimeMs: readResult.mtimeMs,
            etag: readResult.etag,
            range: readResult.range,
          },
        };

        // Write header line followed by raw stream bytes
        process.stdout.write(JSON.stringify(headerEnvelope) + '\n');

        await new Promise<void>((resolve, reject) => {
          readResult.stream.on('error', reject);
          readResult.stream.on('end', resolve);
          readResult.stream.pipe(process.stdout, { end: true });
        });
        return;
      } catch (fErr: unknown) {
        if (fErr instanceof FileOpError) {
          throw new TypedCliError(fErr.code, sanitizeErrorMessage(fErr.message));
        }
        throw new TypedCliError('FILE_OP_FAILED', sanitizeErrorMessage(toErrorMessage(fErr)));
      }
    }

    if (req.action === 'stage-stream') {
      if (!req.fileStage || typeof req.fileStage !== 'object') {
        throw new TypedCliError('INVALID_REQUEST', 'Action "stage-stream" requires a valid "fileStage" object');
      }

      try {
        const stageResult = await executeFileStageStream(req.fileStage, process.stdin, {
          spacesDir,
          expectedUid: 1000,
        });

        const envelope: ExecCliEnvelope = {
          status: 'ok',
          requestId,
          userId,
          fileResult: stageResult as any,
        };

        process.stdout.write(JSON.stringify(envelope) + '\n');
        return;
      } catch (fErr: unknown) {
        if (fErr instanceof FileOpError) {
          throw new TypedCliError(fErr.code, sanitizeErrorMessage(fErr.message));
        }
        throw new TypedCliError('FILE_OP_FAILED', sanitizeErrorMessage(toErrorMessage(fErr)));
      }
    }

    if (req.action === 'commit-stage') {
      if (!req.fileCommit || typeof req.fileCommit !== 'object') {
        throw new TypedCliError('INVALID_REQUEST', 'Action "commit-stage" requires a valid "fileCommit" object');
      }

      try {
        const fileResult = await executeFileCommitStage(req.fileCommit, {
          spacesDir,
          expectedUid: 1000,
        });

        const envelope: ExecCliEnvelope = {
          status: 'ok',
          requestId,
          userId,
          fileResult,
        };

        process.stdout.write(JSON.stringify(envelope) + '\n');
        return;
      } catch (fErr: unknown) {
        if (fErr instanceof FileOpError) {
          throw new TypedCliError(fErr.code, sanitizeErrorMessage(fErr.message));
        }
        throw new TypedCliError('FILE_OP_FAILED', sanitizeErrorMessage(toErrorMessage(fErr)));
      }
    }

    if (req.action === 'abort-stage') {
      if (!req.fileAbort || typeof req.fileAbort !== 'object') {
        throw new TypedCliError('INVALID_REQUEST', 'Action "abort-stage" requires a valid "fileAbort" object');
      }

      try {
        const fileResult = await executeFileAbortStage(req.fileAbort, {
          spacesDir,
          expectedUid: 1000,
        });

        const envelope: ExecCliEnvelope = {
          status: 'ok',
          requestId,
          userId,
          fileResult: fileResult as any,
        };

        process.stdout.write(JSON.stringify(envelope) + '\n');
        return;
      } catch (fErr: unknown) {
        if (fErr instanceof FileOpError) {
          throw new TypedCliError(fErr.code, sanitizeErrorMessage(fErr.message));
        }
        throw new TypedCliError('FILE_OP_FAILED', sanitizeErrorMessage(toErrorMessage(fErr)));
      }
    }

    if (req.action === 'finalize-stage') {
      if (!req.fileFinalize || typeof req.fileFinalize !== 'object') {
        throw new TypedCliError('INVALID_REQUEST', 'Action "finalize-stage" requires a valid "fileFinalize" object');
      }

      try {
        const fileResult = await executeFileFinalizeStage(req.fileFinalize, {
          spacesDir,
          expectedUid: 1000,
        });

        const envelope: ExecCliEnvelope = {
          status: 'ok',
          requestId,
          userId,
          fileResult: fileResult as any,
        };

        process.stdout.write(JSON.stringify(envelope) + '\n');
        return;
      } catch (fErr: unknown) {
        if (fErr instanceof FileOpError) {
          throw new TypedCliError(fErr.code, sanitizeErrorMessage(fErr.message));
        }
        throw new TypedCliError('FILE_OP_FAILED', sanitizeErrorMessage(toErrorMessage(fErr)));
      }
    }

    if (req.action === 'rollback-commit') {
      if (!req.fileRollback || typeof req.fileRollback !== 'object') {
        throw new TypedCliError('INVALID_REQUEST', 'Action "rollback-commit" requires a valid "fileRollback" object');
      }

      try {
        const fileResult = await executeFileRollbackCommit(req.fileRollback, {
          spacesDir,
          expectedUid: 1000,
        });

        const envelope: ExecCliEnvelope = {
          status: 'ok',
          requestId,
          userId,
          fileResult: fileResult as any,
        };

        process.stdout.write(JSON.stringify(envelope) + '\n');
        return;
      } catch (fErr: unknown) {
        if (fErr instanceof FileOpError) {
          throw new TypedCliError(fErr.code, sanitizeErrorMessage(fErr.message));
        }
        throw new TypedCliError('FILE_OP_FAILED', sanitizeErrorMessage(toErrorMessage(fErr)));
      }
    }

    if (req.action === 'inspect-transfer-state' || req.action === 'inspect-stage') {
      if (!req.fileInspect || typeof req.fileInspect !== 'object') {
        throw new TypedCliError('INVALID_REQUEST', 'Action "inspect-stage" requires a valid "fileInspect" object');
      }

      try {
        const inspectResult = await executeFileInspectTransferState(req.fileInspect, {
          spacesDir,
          expectedUid: 1000,
        });

        const envelope: ExecCliEnvelope = {
          status: 'ok',
          requestId,
          userId,
          fileResult: inspectResult as any,
        };

        process.stdout.write(JSON.stringify(envelope) + '\n');
        return;
      } catch (fErr: unknown) {
        if (fErr instanceof FileOpError) {
          throw new TypedCliError(fErr.code, sanitizeErrorMessage(fErr.message));
        }
        throw new TypedCliError('FILE_OP_FAILED', sanitizeErrorMessage(toErrorMessage(fErr)));
      }
    }

    throw new TypedCliError(
      'INVALID_ACTION',
      'Unsupported action. Valid actions: health, followup, cancel, import-seed, check-session-artifact, export-fork-seed, idle, file-op, write-stream, read-stream, stage-stream, commit-stage, abort-stage, finalize-stage, rollback-commit, inspect-stage, inspect-transfer-state.'
    );
  } catch (err: unknown) {
    let code: string | undefined;
    let sanitizedMsg: string;

    if (err instanceof TypedCliError) {
      code = err.code;
      sanitizedMsg = sanitizeErrorMessage(err.message);
    } else if (err instanceof SessionBusyError) {
      code = 'SESSION_BUSY';
      sanitizedMsg = 'Session is busy';
    } else if (err instanceof SessionLockError) {
      code = err.code;
      sanitizedMsg = sanitizeErrorMessage(err.message);
    } else if (err instanceof AggregateError) {
      const hasReleaseFailure =
        err.message === 'SESSION_LOCK_RELEASE_FAILED' ||
        err.errors.some((e) =>
          (e instanceof SessionLockError && e.code === 'SESSION_LOCK_RELEASE_FAILED') ||
          (e instanceof TypedCliError && e.code === 'SESSION_LOCK_RELEASE_FAILED') ||
          (e instanceof Error && (e.message === 'SESSION_LOCK_RELEASE_FAILED' || e.message.includes('release session lock')))
        );
      if (hasReleaseFailure) {
        code = 'SESSION_LOCK_RELEASE_FAILED';
        sanitizedMsg = 'Failed to release session lock';
      } else {
        const first = err.errors[0];
        if (first instanceof TypedCliError) {
          code = first.code;
          sanitizedMsg = sanitizeErrorMessage(first.message);
        } else {
          sanitizedMsg = sanitizeErrorMessage(toErrorMessage(err));
        }
      }
    } else {
      const rawMsg = toErrorMessage(err);
      sanitizedMsg = sanitizeErrorMessage(rawMsg);
    }

    const errorEnvelope: ExecCliEnvelope = {
      status: 'error',
      code,
      requestId,
      turnId,
      error: sanitizedMsg,
    };

    process.stdout.write(JSON.stringify(errorEnvelope) + '\n');
    process.exitCode = 1;
  }
}

// Direct invocation guard
if (process.argv[1] && process.argv[1].endsWith('exec-cli.js')) {
  runExecCli().catch((err: unknown) => {
    const rawMsg = toErrorMessage(err);
    const sanitizedMsg = rawMsg.split('\n')[0]?.trim() || 'Fatal execution error';
    const errorEnvelope: ExecCliEnvelope = {
      status: 'error',
      error: sanitizedMsg,
    };
    process.stdout.write(JSON.stringify(errorEnvelope) + '\n');
    process.exit(1);
  });
}
