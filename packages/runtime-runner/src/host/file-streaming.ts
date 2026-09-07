/**
 * Host Filesystem Streaming Operations
 *
 * Provides space-isolated streaming read, write, staging, and atomic commit operations
 * directly on the host storage root for large file transfers.
 * Strictly verifies space boundary containment to prevent path traversal attacks.
 *
 * @module @enkeep/runtime-runner/host/file-streaming
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import type { ExecCliEnvelope } from '../runtime/exec-cli.js';
import {
  executeFileInspectTransferState,
  type FileOperationResult,
  type FileInspectTransferStateResult,
  type FileInspectTransferStateOptions,
} from '../runtime/file-ops.js';
import { isPathContained } from './security.js';
import { HostOwnershipError } from '../spec/provider.js';

export const DEFAULT_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

function computeBufferSha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function computeEtag(size: number, mtimeMs: number): string {
  return `"${crypto.createHash('sha256').update(`${size}-${Math.floor(mtimeMs)}`).digest('hex')}"`;
}

function resolveSpacePath(spacesDir: string, space: string, targetPath: string): {
  spaceRoot: string;
  absolutePath: string;
} {
  if (!space || typeof space !== 'string' || space.includes('..') || space.includes('/') || space.includes('\\')) {
    throw new HostOwnershipError(`Invalid space identifier: "${space}"`);
  }

  const spaceRoot = path.resolve(spacesDir, space);
  if (!isPathContained(spaceRoot, spacesDir)) {
    throw new HostOwnershipError(`Space root resolves outside spacesDir: "${space}"`);
  }

  const cleanTargetPath = targetPath.startsWith('/') ? targetPath.slice(1) : targetPath;
  const absolutePath = path.resolve(spaceRoot, cleanTargetPath);

  if (!isPathContained(absolutePath, spaceRoot)) {
    throw new HostOwnershipError(`Target path "${targetPath}" resolves outside space boundary "${spaceRoot}"`);
  }

  return { spaceRoot, absolutePath };
}

export async function hostWriteStream(
  spacesDir: string,
  options: {
    space: string;
    path: string;
    expectedEtag?: string;
    requireAbsent?: boolean;
    maxSizeBytes?: number;
  },
  inStream: NodeJS.ReadableStream
): Promise<ExecCliEnvelope> {
  const { absolutePath } = resolveSpacePath(spacesDir, options.space, options.path);
  const maxBytes = options.maxSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;

  if (options.requireAbsent && fs.existsSync(absolutePath)) {
    return {
      status: 'error',
      code: 'ALREADY_EXISTS',
      error: `File already exists at "${options.path}" and requireAbsent was specified`,
    };
  }

  if (options.expectedEtag && fs.existsSync(absolutePath)) {
    const stat = fs.statSync(absolutePath);
    const currentEtag = computeEtag(stat.size, stat.mtimeMs);
    if (currentEtag !== options.expectedEtag) {
      return {
        status: 'error',
        code: 'ETAG_MISMATCH',
        error: `ETag mismatch: expected "${options.expectedEtag}", found "${currentEtag}"`,
      };
    }
  }

  const parentDir = path.dirname(absolutePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  const tmpPath = `${absolutePath}.tmp_${crypto.randomBytes(8).toString('hex')}`;
  let bytesWritten = 0;
  const hash = crypto.createHash('sha256');

  try {
    const out = createWriteStream(tmpPath);
    for await (const chunk of inStream as AsyncIterable<Buffer | string>) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      bytesWritten += buf.length;
      if (bytesWritten > maxBytes) {
        out.destroy();
        try { fs.unlinkSync(tmpPath); } catch {}
        return {
          status: 'error',
          code: 'PAYLOAD_TOO_LARGE',
          error: `File size exceeds maximum allowed limit of ${maxBytes} bytes`,
        };
      }
      hash.update(buf);
      if (!out.write(buf)) {
        await new Promise((r) => out.once('drain', r));
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve());
      out.on('error', reject);
    });

    fs.renameSync(tmpPath, absolutePath);
    const stat = fs.statSync(absolutePath);
    const etag = computeEtag(stat.size, stat.mtimeMs);
    const sha256 = hash.digest('hex');

    return {
      status: 'ok',
      fileResult: {
        op: 'write',
        path: options.path,
        space: options.space,
        size: stat.size,
        written: true,
        etag,
        sha256,
      },
    };
  } catch (err: unknown) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    return {
      status: 'error',
      code: 'WRITE_STREAM_FAILED',
      error: (err as any)?.message || 'Write stream failed',
    };
  }
}

export async function hostReadStream(
  spacesDir: string,
  options: {
    space: string;
    path: string;
    range?: { start: number; end: number };
  }
): Promise<{ metadata: FileOperationResult; stream: NodeJS.ReadableStream }> {
  const { absolutePath } = resolveSpacePath(spacesDir, options.space, options.path);

  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw new HostOwnershipError(`File not found at "${options.path}" in space "${options.space}"`);
  }

  const stat = fs.statSync(absolutePath);
  const etag = computeEtag(stat.size, stat.mtimeMs);

  const fileBuf = fs.readFileSync(absolutePath);
  const sha256 = computeBufferSha256(fileBuf);

  const metadata: FileOperationResult = {
    op: 'read',
    path: options.path,
    space: options.space,
    size: stat.size,
    etag,
    sha256,
  };

  const streamOptions: { start?: number; end?: number } = {};
  if (options.range) {
    if (options.range.start !== undefined) streamOptions.start = options.range.start;
    if (options.range.end !== undefined) streamOptions.end = options.range.end;
  }

  const stream = createReadStream(absolutePath, streamOptions);
  return { metadata, stream };
}

export async function hostStageStream(
  spacesDir: string,
  options: {
    space: string;
    path: string;
    maxSizeBytes?: number;
  },
  inStream: NodeJS.ReadableStream
): Promise<{ stageToken: string; space: string; path: string; size: number; sha256: string; etag: string }> {
  const { spaceRoot } = resolveSpacePath(spacesDir, options.space, options.path);
  const stageToken = `stage_${crypto.randomBytes(16).toString('hex')}`;
  const stageDir = path.join(spaceRoot, '.enkeep_stages');
  if (!fs.existsSync(stageDir)) {
    fs.mkdirSync(stageDir, { recursive: true });
  }

  const stageFilePath = path.join(stageDir, stageToken);
  const maxBytes = options.maxSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;

  let bytesWritten = 0;
  const hash = crypto.createHash('sha256');
  const out = createWriteStream(stageFilePath);

  for await (const chunk of inStream as AsyncIterable<Buffer | string>) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    bytesWritten += buf.length;
    if (bytesWritten > maxBytes) {
      out.destroy();
      try { fs.unlinkSync(stageFilePath); } catch {}
      throw new Error(`Stage payload exceeds max size of ${maxBytes} bytes`);
    }
    hash.update(buf);
    if (!out.write(buf)) {
      await new Promise((r) => out.once('drain', r));
    }
  }

  await new Promise<void>((resolve, reject) => {
    out.end(() => resolve());
    out.on('error', reject);
  });

  const stat = fs.statSync(stageFilePath);
  const etag = computeEtag(stat.size, stat.mtimeMs);
  const sha256 = hash.digest('hex');

  return {
    stageToken,
    space: options.space,
    path: options.path,
    size: stat.size,
    sha256,
    etag,
  };
}

export async function hostCommitStage(
  spacesDir: string,
  options: {
    space: string;
    path: string;
    stageToken: string;
    rollbackToken?: string;
    expectedEtag?: string;
    requireAbsent?: boolean;
  }
): Promise<FileOperationResult> {
  const { spaceRoot, absolutePath } = resolveSpacePath(spacesDir, options.space, options.path);
  const stageFilePath = path.join(spaceRoot, '.enkeep_stages', options.stageToken);

  if (!fs.existsSync(stageFilePath)) {
    throw new HostOwnershipError(`Staged file for token "${options.stageToken}" not found`);
  }

  if (options.requireAbsent && fs.existsSync(absolutePath)) {
    throw new HostOwnershipError(`File already exists at "${options.path}"`);
  }

  if (options.expectedEtag && fs.existsSync(absolutePath)) {
    const curStat = fs.statSync(absolutePath);
    const curEtag = computeEtag(curStat.size, curStat.mtimeMs);
    if (curEtag !== options.expectedEtag) {
      throw new HostOwnershipError(`ETag mismatch: expected "${options.expectedEtag}", found "${curEtag}"`);
    }
  }

  // Backup existing file if rollbackToken provided
  if (options.rollbackToken && fs.existsSync(absolutePath)) {
    const backupDir = path.join(spaceRoot, '.enkeep_rollbacks');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(absolutePath, path.join(backupDir, options.rollbackToken));
  }

  const parentDir = path.dirname(absolutePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  fs.renameSync(stageFilePath, absolutePath);
  const finalStat = fs.statSync(absolutePath);
  const buf = fs.readFileSync(absolutePath);
  const sha256 = computeBufferSha256(buf);
  const etag = computeEtag(finalStat.size, finalStat.mtimeMs);

  return {
    op: 'write',
    path: options.path,
    space: options.space,
    size: finalStat.size,
    written: true,
    etag,
    sha256,
  };
}

export async function hostAbortStage(
  spacesDir: string,
  options: {
    space: string;
    path: string;
    stageToken: string;
  }
): Promise<void> {
  const { spaceRoot } = resolveSpacePath(spacesDir, options.space, options.path);
  const stageFilePath = path.join(spaceRoot, '.enkeep_stages', options.stageToken);
  try {
    if (fs.existsSync(stageFilePath)) {
      fs.unlinkSync(stageFilePath);
    }
  } catch {}
}

export async function hostFinalizeStage(
  spacesDir: string,
  options: {
    space: string;
    path: string;
    rollbackToken?: string;
  }
): Promise<void> {
  if (!options.rollbackToken) return;
  const { spaceRoot } = resolveSpacePath(spacesDir, options.space, options.path);
  const backupPath = path.join(spaceRoot, '.enkeep_rollbacks', options.rollbackToken);
  try {
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
  } catch {}
}

export async function hostRollbackCommit(
  spacesDir: string,
  options: {
    space: string;
    path: string;
    rollbackToken?: string;
    stageToken?: string;
    expectedEtag?: string;
  }
): Promise<void> {
  if (!options.rollbackToken) return;
  const { spaceRoot, absolutePath } = resolveSpacePath(spacesDir, options.space, options.path);
  const backupPath = path.join(spaceRoot, '.enkeep_rollbacks', options.rollbackToken);
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, absolutePath);
    try { fs.unlinkSync(backupPath); } catch {}
  }
}

export async function hostInspectTransferState(
  spacesDir: string,
  options: FileInspectTransferStateOptions
): Promise<FileInspectTransferStateResult> {
  return executeFileInspectTransferState(options, {
    spacesDir,
    expectedUid: typeof process.getuid === 'function' ? process.getuid() : 1000,
  });
}
