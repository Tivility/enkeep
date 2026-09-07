/**
 * In-Container File Operations Security & Correctness Test Suite
 *
 * Comprehensive tests for:
 * - Strict relative path validation & traversal prevention (.., absolute, Windows drive, null/control chars)
 * - Space name validation & isolation
 * - Segment-by-segment symlink verification and rejection
 * - O_NOFOLLOW + fstat regular file & TOCTOU race detection
 * - Read / write 1MiB bounds & UTF-8 / Base64 binary encoding
 * - Atomic write with preconditions (expectedEtag XOR requireAbsent)
 * - Directory listing capped at 500 entries without symlink following
 * - Space root deletion prohibition
 * - Output & error path / stack trace sanitization
 * - Process stat reader & lock owner validation
 * - Stale lock recovery & nonce race protection
 * - Storage metadata validation & fixed FileOpError messages
 * - ExecCli file-op action runner & ActiveRuntimeHandle integration
 *
 * @module @enkeep/runtime-runner/tests/file-ops.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  executeFileOperation,
  validateSpaceName,
  validateRelativePath,
  verifyNoSymlinksInPath,
  sanitizeErrorMessage,
  computeFileETag,
  computeDirectoryETag,
  computeDirectoryETagRecursive,
  inspectDirectory,
  getNoFollowFlag,
  getProcessStartTicks,
  extractValidMetadata,
  withPathLocks,
  FileOpError,
  MAX_FILE_OP_BYTES,
  MAX_DIR_ENTRIES,
  type FileOperationRequest,
  type FileOperationResult,
  type FileOpExecutionOptions,
} from '../src/runtime/file-ops.js';
import {
  parseExecEnvelope,
  SafeDockerClient,
  type OwnershipExpectation,
} from '../src/docker/client.js';
import {
  DockerRuntimeAdapter,
  parseRuntimeHealthStatus,
} from '../src/docker/adapter.js';
import { DockerDaemonError } from '../src/spec/validator.js';
import type {
  RuntimeDaemonTransportPort,
  RuntimeHealthStatus,
  AgentFollowupRequest,
  AgentFollowupResponse,
} from '../src/transport/types.js';
import type {
  FileOpDaemonResponse,
  CancelResponse,
} from '../src/runtime/daemon-protocol.js';

class FakeDaemonTransport implements RuntimeDaemonTransportPort {
  constructor(
    private readonly client: SafeDockerClient,
    private readonly expectation: OwnershipExpectation
  ) {}

  async start(): Promise<void> {}
  async close(): Promise<void> {}
  isConnected(): boolean {
    return true;
  }

  async checkHealth(): Promise<RuntimeHealthStatus> {
    const res = await this.client.execOwned(this.expectation, { action: 'health' });
    return parseRuntimeHealthStatus(res, this.expectation.userId);
  }

  async fileOperation(req: FileOperationRequest): Promise<FileOpDaemonResponse> {
    const res = await this.client.execOwned(this.expectation, { action: 'file-op', fileOp: req });
    return {
      id: 'mock_file_op',
      op: 'fileOp',
      ok: res.status === 'ok',
      fileResult: res.fileResult!,
    };
  }

  async sendFollowup(req: AgentFollowupRequest): Promise<AgentFollowupResponse> {
    const res = await this.client.execOwned(this.expectation, { action: 'followup', ...req });
    if (res.status === 'completed') {
      return {
        status: 'completed',
        turnId: req.turnId,
        sessionId: req.sessionId,
        replyText: res.replyText || '',
        eventsCount: res.eventsCount ?? 0,
        persisted: true,
      };
    }
    return {
      status: 'cancelled',
      turnId: req.turnId,
      sessionId: req.sessionId,
      eventsCount: res.eventsCount ?? 0,
      persisted: true,
    };
  }

  async cancelTurn(turnId: string): Promise<CancelResponse> {
    const res = await this.client.execOwned(this.expectation, { action: 'cancel', turnId });
    return {
      id: 'mock_cancel',
      op: 'cancel',
      ok: true,
      cancelled: res.status === 'cancelled',
      turnId,
    };
  }
}

describe('In-Container File Operations Security & Invariants', () => {
  let tmpDir: string;
  let spacesDir: string;
  let defaultSpace: string;
  let spaceRoot: string;
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  let defaultOptions: FileOpExecutionOptions;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-ops-test-'));
    spacesDir = path.join(tmpDir, 'spaces');
    defaultSpace = 'test-space';
    spaceRoot = path.join(spacesDir, defaultSpace);

    fs.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spaceRoot, { recursive: true, mode: 0o700 });

    defaultOptions = {
      spacesDir,
      expectedUid: currentUid,
      procStatReader: (_pid: number) => ({ starttime: '12345' }),
    };
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_cleanupErr: unknown) {
      // ignore cleanup errors
    }
  });

  describe('Space Name & Path Input Validation', () => {
    it('validates compliant space names and rejects invalid ones', () => {
      expect(validateSpaceName('default')).toBe('default');
      expect(validateSpaceName('space-1')).toBe('space-1');
      expect(validateSpaceName('space_alice_2')).toBe('space_alice_2');

      expect(() => validateSpaceName('')).toThrow(FileOpError);
      expect(() => validateSpaceName('   ')).toThrow(FileOpError);
      expect(() => validateSpaceName('../evil')).toThrow(FileOpError);
      expect(() => validateSpaceName('space/sub')).toThrow(FileOpError);
      expect(() => validateSpaceName('space\\sub')).toThrow(FileOpError);
      expect(() => validateSpaceName('space@bad')).toThrow(FileOpError);
      expect(() => validateSpaceName('space.bad')).toThrow(FileOpError);
      expect(() => validateSpaceName('a'.repeat(65))).toThrow(FileOpError);
    });

    it('strictly rejects unknown request parameters with INVALID_REQUEST', () => {
      expect(() =>
        executeFileOperation(
          {
            op: 'read',
            space: defaultSpace,
            path: 'file.txt',
            unknownOption: 'malicious',
          } as unknown as FileOperationRequest,
          defaultOptions
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          {
            op: 'read',
            space: defaultSpace,
            path: 'file.txt',
            unknownOption: 'malicious',
          } as unknown as FileOperationRequest,
          defaultOptions
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('INVALID_REQUEST');
      }
    });

    it('rejects absolute paths', () => {
      expect(() => validateRelativePath('/etc/passwd')).toThrow(FileOpError);
      expect(() => validateRelativePath('\\Windows\\System32')).toThrow(FileOpError);
      expect(() =>
        executeFileOperation({ op: 'read', space: defaultSpace, path: '/etc/passwd' }, defaultOptions)
      ).toThrow(FileOpError);
    });

    it('rejects path traversal with ".."', () => {
      expect(() => validateRelativePath('../secret.txt')).toThrow(FileOpError);
      expect(() => validateRelativePath('sub/../../evil.txt')).toThrow(FileOpError);
      expect(() => validateRelativePath('sub/..')).toThrow(FileOpError);
      expect(() =>
        executeFileOperation({ op: 'read', space: defaultSpace, path: '../evil.txt' }, defaultOptions)
      ).toThrow(FileOpError);
    });

    it('rejects Windows drive letters', () => {
      expect(() => validateRelativePath('C:evil.txt')).toThrow(FileOpError);
      expect(() => validateRelativePath('d:/sub/doc.txt')).toThrow(FileOpError);
      expect(() =>
        executeFileOperation({ op: 'read', space: defaultSpace, path: 'C:test.txt' }, defaultOptions)
      ).toThrow(FileOpError);
    });

    it('rejects null bytes and control characters across all positions', () => {
      expect(() => validateRelativePath('file\0.txt')).toThrow(FileOpError);
      expect(() => validateRelativePath('sub/\x01/file.txt')).toThrow(FileOpError);
      expect(() => validateRelativePath('sub/\x1F/file.txt')).toThrow(FileOpError);
      expect(() => validateRelativePath('sub/\x7F/file.txt')).toThrow(FileOpError);
      expect(() =>
        executeFileOperation({ op: 'read', space: defaultSpace, path: 'file\0.txt' }, defaultOptions)
      ).toThrow(FileOpError);
    });

    it('rejects complex traversal attempts and mixed separators', () => {
      expect(() => validateRelativePath('a/b/../../../etc/passwd')).toThrow(FileOpError);
      expect(() => validateRelativePath('a\\b\\..\\..\\..\\etc\\passwd')).toThrow(FileOpError);
      expect(() => validateRelativePath('./../evil')).toThrow(FileOpError);
    });

    it('normalizes valid relative subpaths safely', () => {
      expect(validateRelativePath('doc.txt')).toEqual({
        normalizedPath: 'doc.txt',
        segments: ['doc.txt'],
      });
      expect(validateRelativePath('sub/dir/doc.txt')).toEqual({
        normalizedPath: 'sub/dir/doc.txt',
        segments: ['sub', 'dir', 'doc.txt'],
      });
      expect(validateRelativePath('sub\\dir\\doc.txt')).toEqual({
        normalizedPath: 'sub/dir/doc.txt',
        segments: ['sub', 'dir', 'doc.txt'],
      });
      expect(validateRelativePath('./sub/./doc.txt')).toEqual({
        normalizedPath: 'sub/doc.txt',
        segments: ['sub', 'doc.txt'],
      });
      expect(validateRelativePath('')).toEqual({
        normalizedPath: '.',
        segments: [],
      });
      expect(validateRelativePath(undefined)).toEqual({
        normalizedPath: '.',
        segments: [],
      });
    });
  });

  describe('Symlink Defense & Non-Traversal', () => {
    it('rejects operations if the space root itself is a symbolic link', () => {
      const evilSpace = 'symlink-space';
      const evilRoot = path.join(spacesDir, evilSpace);
      const outsideDir = path.join(tmpDir, 'outside-target');
      fs.mkdirSync(outsideDir, { recursive: true, mode: 0o700 });
      fs.symlinkSync(outsideDir, evilRoot);

      expect(() =>
        executeFileOperation({ op: 'list', space: evilSpace, path: '.' }, defaultOptions)
      ).toThrow(FileOpError);

      try {
        executeFileOperation({ op: 'list', space: evilSpace, path: '.' }, defaultOptions);
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('SYMLINK_FORBIDDEN');
      }
    });

    it('rejects operations if an intermediate directory segment is a symbolic link', () => {
      const intermediateSymlink = path.join(spaceRoot, 'symlink-folder');
      const outsideFolder = path.join(tmpDir, 'outside-folder');
      fs.mkdirSync(outsideFolder, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(outsideFolder, 'target.txt'), 'secret', { mode: 0o600 });
      fs.symlinkSync(outsideFolder, intermediateSymlink);

      expect(() =>
        executeFileOperation(
          { op: 'read', space: defaultSpace, path: 'symlink-folder/target.txt' },
          defaultOptions
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          { op: 'read', space: defaultSpace, path: 'symlink-folder/target.txt' },
          defaultOptions
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('SYMLINK_FORBIDDEN');
      }
    });

    it('rejects reading a symbolic link file directly', () => {
      const outsideSecret = path.join(tmpDir, 'host-secret.txt');
      fs.writeFileSync(outsideSecret, 'super-secret', { mode: 0o600 });
      const symlinkFile = path.join(spaceRoot, 'leak.txt');
      fs.symlinkSync(outsideSecret, symlinkFile);

      expect(() =>
        executeFileOperation({ op: 'read', space: defaultSpace, path: 'leak.txt' }, defaultOptions)
      ).toThrow(FileOpError);

      try {
        executeFileOperation({ op: 'read', space: defaultSpace, path: 'leak.txt' }, defaultOptions);
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('SYMLINK_FORBIDDEN');
      }
    });

    it('rejects writing to an existing symbolic link file to prevent symlink hijack', () => {
      const outsideTarget = path.join(tmpDir, 'victim.txt');
      fs.writeFileSync(outsideTarget, 'original', { mode: 0o600 });
      const symlinkFile = path.join(spaceRoot, 'hijack.txt');
      fs.symlinkSync(outsideTarget, symlinkFile);

      const validEtag = '"' + 'a'.repeat(64) + '"';
      expect(() =>
        executeFileOperation(
          {
            op: 'write',
            space: defaultSpace,
            path: 'hijack.txt',
            content: 'malicious overwrite',
            expectedEtag: validEtag,
          },
          defaultOptions
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          {
            op: 'write',
            space: defaultSpace,
            path: 'hijack.txt',
            content: 'malicious overwrite',
            expectedEtag: validEtag,
          },
          defaultOptions
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('SYMLINK_FORBIDDEN');
      }

      // Verify victim target on host was NOT modified
      expect(fs.readFileSync(outsideTarget, 'utf8')).toBe('original');
    });
  });

  describe('Read Operations: O_NOFOLLOW, Bounds & Encodings', () => {
    it('successfully reads a regular file with UTF-8 encoding', () => {
      const filePath = path.join(spaceRoot, 'hello.txt');
      fs.writeFileSync(filePath, 'Hello, DeepSeek Harness!', { mode: 0o600 });

      const result = executeFileOperation(
        { op: 'read', space: defaultSpace, path: 'hello.txt', encoding: 'utf8' },
        defaultOptions
      );

      expect(result.op).toBe('read');
      expect(result.space).toBe(defaultSpace);
      expect(result.path).toBe('hello.txt');
      expect(result.content).toBe('Hello, DeepSeek Harness!');
      expect(result.encoding).toBe('utf8');
      expect(result.size).toBe(Buffer.byteLength('Hello, DeepSeek Harness!'));
      expect(result.etag).toBeDefined();
      expect(result.mtimeMs).toBeGreaterThan(0);
    });

    it('successfully reads binary file with Base64 encoding', () => {
      const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG header
      const filePath = path.join(spaceRoot, 'image.png');
      fs.writeFileSync(filePath, binaryData, { mode: 0o600 });

      const result = executeFileOperation(
        { op: 'read', space: defaultSpace, path: 'image.png', encoding: 'base64' },
        defaultOptions
      );

      expect(result.op).toBe('read');
      expect(result.content).toBe(binaryData.toString('base64'));
      expect(result.encoding).toBe('base64');
      expect(result.size).toBe(binaryData.length);
    });

    it('rejects reading a directory as a file', () => {
      const dirPath = path.join(spaceRoot, 'subfolder');
      fs.mkdirSync(dirPath, { mode: 0o700 });

      expect(() =>
        executeFileOperation({ op: 'read', space: defaultSpace, path: 'subfolder' }, defaultOptions)
      ).toThrow(FileOpError);

      try {
        executeFileOperation({ op: 'read', space: defaultSpace, path: 'subfolder' }, defaultOptions);
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('INVALID_TARGET');
      }
    });

    it('rejects reading non-existent file with NOT_FOUND', () => {
      expect(() =>
        executeFileOperation({ op: 'read', space: defaultSpace, path: 'ghost.txt' }, defaultOptions)
      ).toThrow(FileOpError);

      try {
        executeFileOperation({ op: 'read', space: defaultSpace, path: 'ghost.txt' }, defaultOptions);
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('NOT_FOUND');
      }
    });

    it('detects TOCTOU inode/dev identity mismatch between lstat and open', () => {
      const targetFile = path.join(spaceRoot, 'toctou-target.txt');
      fs.writeFileSync(targetFile, 'content before race', { mode: 0o600 });

      let fstatCalls = 0;
      const customFs = {
        ...fs,
        fstatSync: (fd: number, options?: fs.StatOptions) => {
          fstatCalls++;
          const realStat = (fs.fstatSync as Function)(fd, options) as fs.Stats;
          // Simulate inode change indicating file was replaced
          return {
            ...realStat,
            ino: realStat.ino + 9999,
            dev: realStat.dev,
            isFile: () => true,
            isSymbolicLink: () => false,
            isDirectory: () => false,
          } as fs.Stats;
        },
      } as unknown as typeof fs;

      expect(() =>
        executeFileOperation(
          { op: 'read', space: defaultSpace, path: 'toctou-target.txt' },
          { ...defaultOptions, fsImpl: customFs }
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          { op: 'read', space: defaultSpace, path: 'toctou-target.txt' },
          { ...defaultOptions, fsImpl: customFs }
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('TOCTOU_MISMATCH');
      }
    });

    it('reads exactly 1MiB file boundary successfully', () => {
      const exactFile = path.join(spaceRoot, 'exact-1mb.bin');
      const exactBuffer = Buffer.alloc(MAX_FILE_OP_BYTES, 0x42);
      fs.writeFileSync(exactFile, exactBuffer, { mode: 0o600 });

      const result = executeFileOperation(
        { op: 'read', space: defaultSpace, path: 'exact-1mb.bin', encoding: 'base64' },
        defaultOptions
      );

      expect(result.op).toBe('read');
      expect(result.size).toBe(MAX_FILE_OP_BYTES);
    });
  });

  describe('Write Operations: Atomicity, Preconditions & 1MiB Bound', () => {
    it('writes file atomically with requireAbsent=true and creates parent directories automatically', () => {
      const result = executeFileOperation(
        {
          op: 'write',
          space: defaultSpace,
          path: 'nested/deep/directory/test.txt',
          content: 'Atomic content write',
          requireAbsent: true,
        },
        defaultOptions
      );

      expect(result.op).toBe('write');
      expect(result.written).toBe(true);
      expect(result.size).toBe(Buffer.byteLength('Atomic content write'));

      const writtenOnDisk = fs.readFileSync(
        path.join(spaceRoot, 'nested/deep/directory/test.txt'),
        'utf8'
      );
      expect(writtenOnDisk).toBe('Atomic content write');

      const parentFiles = fs.readdirSync(path.join(spaceRoot, 'nested/deep/directory'));
      expect(parentFiles.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
    });

    it('writes binary payload encoded in Base64 with requireAbsent=true', () => {
      const binaryPayload = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe]);
      const base64Str = binaryPayload.toString('base64');

      const result = executeFileOperation(
        {
          op: 'write',
          space: defaultSpace,
          path: 'binary.dat',
          content: base64Str,
          encoding: 'base64',
          requireAbsent: true,
        },
        defaultOptions
      );

      expect(result.written).toBe(true);
      expect(result.size).toBe(binaryPayload.length);

      const writtenOnDisk = fs.readFileSync(path.join(spaceRoot, 'binary.dat'));
      expect(writtenOnDisk).toEqual(binaryPayload);
    });

    it('atomically replaces an existing file with expectedEtag without leaving temp files', () => {
      const targetPath = path.join(spaceRoot, 'replace-me.txt');
      fs.writeFileSync(targetPath, 'Old version', { mode: 0o600 });
      const oldEtag = computeFileETag(Buffer.from('Old version'));

      const result = executeFileOperation(
        {
          op: 'write',
          space: defaultSpace,
          path: 'replace-me.txt',
          content: 'New updated version',
          expectedEtag: oldEtag,
        },
        defaultOptions
      );

      expect(result.written).toBe(true);
      expect(fs.readFileSync(targetPath, 'utf8')).toBe('New updated version');

      const files = fs.readdirSync(spaceRoot);
      expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
    });

    it('rejects write request without exactly one precondition (expectedEtag XOR requireAbsent)', () => {
      // Neither precondition
      expect(() =>
        executeFileOperation(
          {
            op: 'write',
            space: defaultSpace,
            path: 'bad-precon.txt',
            content: 'data',
          },
          defaultOptions
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          {
            op: 'write',
            space: defaultSpace,
            path: 'bad-precon.txt',
            content: 'data',
          },
          defaultOptions
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('INVALID_REQUEST');
      }

      // Both preconditions
      expect(() =>
        executeFileOperation(
          {
            op: 'write',
            space: defaultSpace,
            path: 'bad-precon.txt',
            content: 'data',
            expectedEtag: '"12345"',
            requireAbsent: true,
          },
          defaultOptions
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          {
            op: 'write',
            space: defaultSpace,
            path: 'bad-precon.txt',
            content: 'data',
            expectedEtag: '"12345"',
            requireAbsent: true,
          },
          defaultOptions
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('INVALID_REQUEST');
      }
    });

    it('rejects write payload larger than 1MiB (1,048,576 bytes)', () => {
      const oversizedPayload = 'a'.repeat(MAX_FILE_OP_BYTES + 1);

      expect(() =>
        executeFileOperation(
          {
            op: 'write',
            space: defaultSpace,
            path: 'oversized.txt',
            content: oversizedPayload,
            requireAbsent: true,
          },
          defaultOptions
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          {
            op: 'write',
            space: defaultSpace,
            path: 'oversized.txt',
            content: oversizedPayload,
            requireAbsent: true,
          },
          defaultOptions
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('PAYLOAD_TOO_LARGE');
      }
    });

    it('rejects writing directly to space root directory', () => {
      expect(() =>
        executeFileOperation(
          {
            op: 'write',
            space: defaultSpace,
            path: '.',
            content: 'data',
            requireAbsent: true,
          },
          defaultOptions
        )
      ).toThrow(FileOpError);
    });

    it('rejects overwriting an existing directory with a file', () => {
      const dirPath = path.join(spaceRoot, 'existing-dir');
      fs.mkdirSync(dirPath, { mode: 0o700 });

      expect(() =>
        executeFileOperation(
          {
            op: 'write',
            space: defaultSpace,
            path: 'existing-dir',
            content: 'data',
            expectedEtag: '*',
          },
          defaultOptions
        )
      ).toThrow(FileOpError);
    });

    it('succeeds write when expectedEtag matches existing file ETag', () => {
      const filePath = path.join(spaceRoot, 'match-target.txt');
      const initialContent = 'version-1 content';
      fs.writeFileSync(filePath, initialContent, { mode: 0o600 });
      const expectedEtag = computeFileETag(Buffer.from(initialContent, 'utf8'));

      const res = executeFileOperation(
        {
          op: 'write',
          space: defaultSpace,
          path: 'match-target.txt',
          content: 'version-2 content',
          expectedEtag,
        },
        defaultOptions
      );

      expect(res.written).toBe(true);
      expect(res.etag).toBe(computeFileETag(Buffer.from('version-2 content', 'utf8')));
      expect(fs.readFileSync(filePath, 'utf8')).toBe('version-2 content');
    });

    it('rejects write when expectedEtag is not exact quoted 64-hex SHA-256 (unquoted or wildcard)', () => {
      const filePath = path.join(spaceRoot, 'match-unquoted.txt');
      const initialContent = 'unquoted test';
      fs.writeFileSync(filePath, initialContent, { mode: 0o600 });
      const rawHash = crypto.createHash('sha256').update(Buffer.from(initialContent)).digest('hex');

      expect(() =>
        executeFileOperation(
          {
            op: 'write',
            space: defaultSpace,
            path: 'match-unquoted.txt',
            content: 'updated unquoted',
            expectedEtag: rawHash,
          } as any,
          defaultOptions
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          {
            op: 'write',
            space: defaultSpace,
            path: 'match-unquoted.txt',
            content: 'updated unquoted',
            expectedEtag: rawHash,
          } as any,
          defaultOptions
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('INVALID_REQUEST');
      }

      // Wildcard '*' is also strictly rejected
      expect(() =>
        executeFileOperation(
          {
            op: 'write',
            space: defaultSpace,
            path: 'match-unquoted.txt',
            content: 'updated wildcard',
            expectedEtag: '*',
          } as any,
          defaultOptions
        )
      ).toThrow(FileOpError);
    });

    it('fails write with PRECONDITION_FAILED when expectedEtag does not match, leaving file untouched', () => {
      const filePath = path.join(spaceRoot, 'mismatch-target.txt');
      const initialContent = 'original unchanged content';
      fs.writeFileSync(filePath, initialContent, { mode: 0o600 });
      const mismatchedEtag = '"' + 'f'.repeat(64) + '"';

      expect(() =>
        executeFileOperation(
          {
            op: 'write',
            space: defaultSpace,
            path: 'mismatch-target.txt',
            content: 'should never be written',
            expectedEtag: mismatchedEtag,
          },
          defaultOptions
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          {
            op: 'write',
            space: defaultSpace,
            path: 'mismatch-target.txt',
            content: 'should never be written',
            expectedEtag: mismatchedEtag,
          },
          defaultOptions
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('PRECONDITION_FAILED');
      }

      expect(fs.readFileSync(filePath, 'utf8')).toBe(initialContent);
    });

    it('fails write with PRECONDITION_FAILED when expectedEtag target file does not exist', () => {
      const validEtag = '"' + 'a'.repeat(64) + '"';
      expect(() =>
        executeFileOperation(
          {
            op: 'write',
            space: defaultSpace,
            path: 'non-existent-match.txt',
            content: 'content',
            expectedEtag: validEtag,
          },
          defaultOptions
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          {
            op: 'write',
            space: defaultSpace,
            path: 'non-existent-match.txt',
            content: 'content',
            expectedEtag: validEtag,
          },
          defaultOptions
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('PRECONDITION_FAILED');
      }
    });

    it('succeeds write with requireAbsent=true when file does not exist', () => {
      const res = executeFileOperation(
        {
          op: 'write',
          space: defaultSpace,
          path: 'absent-new.txt',
          content: 'brand new',
          requireAbsent: true,
        },
        defaultOptions
      );

      expect(res.written).toBe(true);
      expect(fs.readFileSync(path.join(spaceRoot, 'absent-new.txt'), 'utf8')).toBe('brand new');
    });

    it('fails write with PRECONDITION_FAILED when requireAbsent=true and file already exists', () => {
      const filePath = path.join(spaceRoot, 'already-exists.txt');
      fs.writeFileSync(filePath, 'existing', { mode: 0o600 });

      expect(() =>
        executeFileOperation(
          {
            op: 'write',
            space: defaultSpace,
            path: 'already-exists.txt',
            content: 'should fail',
            requireAbsent: true,
          },
          defaultOptions
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          {
            op: 'write',
            space: defaultSpace,
            path: 'already-exists.txt',
            content: 'should fail',
            requireAbsent: true,
          },
          defaultOptions
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('PRECONDITION_FAILED');
      }

      expect(fs.readFileSync(filePath, 'utf8')).toBe('existing');
    });

    it('aggregates errors when write fails and temp file unlink cleanup also fails', () => {
      const customFs = {
        ...fs,
        writeSync: (fd: number, buffer: NodeJS.ArrayBufferView, offset?: number, length?: number, position?: number | null) => {
          if (buffer && buffer.toString().includes('procStartTicks')) {
            return (fs.writeSync as Function)(fd, buffer, offset, length, position);
          }
          throw new Error('Disk write error');
        },
        unlinkSync: (targetPath: fs.PathLike) => {
          if (String(targetPath).includes('.tmp')) {
            throw new Error('Temp unlink error');
          }
          return fs.unlinkSync(targetPath);
        },
      } as unknown as typeof fs;

      try {
        executeFileOperation(
          {
            op: 'write',
            space: defaultSpace,
            path: 'fail-cleanup.txt',
            content: 'data',
            requireAbsent: true,
          },
          { ...defaultOptions, fsImpl: customFs }
        );
        expect.unreachable('Should have thrown AggregateError');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(AggregateError);
        const agg = err as AggregateError;
        expect(agg.errors.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('aggregates errors when linkSync fails and temp file unlink cleanup also fails', () => {
      const customFs = {
        ...fs,
        linkSync: () => {
          const err = new Error('EEXIST') as Error & { code?: string };
          err.code = 'EEXIST';
          throw err;
        },
        unlinkSync: (targetPath: fs.PathLike) => {
          if (String(targetPath).includes('.tmp')) {
            throw new Error('Temp unlink error');
          }
          return fs.unlinkSync(targetPath);
        },
      } as unknown as typeof fs;

      try {
        executeFileOperation(
          {
            op: 'write',
            space: defaultSpace,
            path: 'fail-link-cleanup.txt',
            content: 'data',
            requireAbsent: true,
          },
          { ...defaultOptions, fsImpl: customFs }
        );
        expect.unreachable('Should have thrown AggregateError');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(AggregateError);
        const agg = err as AggregateError;
        expect(agg.errors.length).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe('Directory Operations: mkdir & list with 500 entry limit', () => {
    it('creates directories with requireAbsent=true and returns directory ETag', () => {
      // First create level 1
      const res1 = executeFileOperation(
        {
          op: 'mkdir',
          space: defaultSpace,
          path: 'folder',
          requireAbsent: true,
        },
        defaultOptions
      );

      expect(res1.op).toBe('mkdir');
      expect(res1.created).toBe(true);
      expect(res1.etag).toBe(computeDirectoryETag([]));
      expect(typeof res1.size).toBe('number');
      expect(res1.size).toBeGreaterThanOrEqual(0);
      expect(typeof res1.mtimeMs).toBe('number');
      expect(fs.existsSync(path.join(spaceRoot, 'folder'))).toBe(true);

      // Now create nested subfolder (non-recursive parent must exist)
      const res2 = executeFileOperation(
        {
          op: 'mkdir',
          space: defaultSpace,
          path: 'folder/subfolder',
          requireAbsent: true,
        },
        defaultOptions
      );

      expect(res2.created).toBe(true);
      expect(res2.etag).toBe(computeDirectoryETag([]));
      expect(fs.existsSync(path.join(spaceRoot, 'folder/subfolder'))).toBe(true);
    });

    it('computes directory ETag recursively rejecting symlinks and special files', () => {
      const parentDir = path.join(spaceRoot, 'recursive-dir');
      fs.mkdirSync(parentDir, { mode: 0o700 });
      fs.writeFileSync(path.join(parentDir, 'a.txt'), 'content a', { mode: 0o600 });
      const childDir = path.join(parentDir, 'sub');
      fs.mkdirSync(childDir, { mode: 0o700 });
      fs.writeFileSync(path.join(childDir, 'b.txt'), 'content b', { mode: 0o600 });

      const etag = computeDirectoryETagRecursive(fs, parentDir, currentUid);
      expect(typeof etag).toBe('string');
      expect(etag.startsWith('"')).toBe(true);
      expect(etag.endsWith('"')).toBe(true);

      // Now create a symlink inside sub and verify computeDirectoryETagRecursive throws SYMLINK_FORBIDDEN
      fs.symlinkSync(path.join(childDir, 'b.txt'), path.join(parentDir, 'symlink-inside'));
      expect(() => computeDirectoryETagRecursive(fs, parentDir, currentUid)).toThrow(FileOpError);
      try {
        computeDirectoryETagRecursive(fs, parentDir, currentUid);
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('SYMLINK_FORBIDDEN');
      }
    });

    it('mkdir strictly requires requireAbsent=true and rejects missing or false', () => {
      expect(() =>
        executeFileOperation(
          {
            op: 'mkdir',
            space: defaultSpace,
            path: 'bad-mkdir',
          },
          defaultOptions
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          {
            op: 'mkdir',
            space: defaultSpace,
            path: 'bad-mkdir',
          },
          defaultOptions
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('INVALID_REQUEST');
      }

      // requireAbsent: false is also rejected
      expect(() =>
        executeFileOperation(
          {
            op: 'mkdir',
            space: defaultSpace,
            path: 'bad-mkdir',
            requireAbsent: false as any,
          },
          defaultOptions
        )
      ).toThrow(FileOpError);
    });

    it('mkdir fails with PRECONDITION_FAILED when directory already exists', () => {
      fs.mkdirSync(path.join(spaceRoot, 'existing-dir'), { mode: 0o700 });

      expect(() =>
        executeFileOperation(
          {
            op: 'mkdir',
            space: defaultSpace,
            path: 'existing-dir',
            requireAbsent: true,
          },
          defaultOptions
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          {
            op: 'mkdir',
            space: defaultSpace,
            path: 'existing-dir',
            requireAbsent: true,
          },
          defaultOptions
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('PRECONDITION_FAILED');
      }
    });

    it('mkdir fails with NOT_FOUND when parent directory does not exist (non-recursive semantics)', () => {
      expect(() =>
        executeFileOperation(
          {
            op: 'mkdir',
            space: defaultSpace,
            path: 'non-existent-parent/child',
            requireAbsent: true,
          },
          defaultOptions
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          {
            op: 'mkdir',
            space: defaultSpace,
            path: 'non-existent-parent/child',
            requireAbsent: true,
          },
          defaultOptions
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('NOT_FOUND');
      }
    });

    it('lists directory contents with metadata and does not follow symlinks', () => {
      fs.writeFileSync(path.join(spaceRoot, 'file1.txt'), 'content 1', { mode: 0o600 });
      fs.writeFileSync(path.join(spaceRoot, 'file2.txt'), 'longer content 2', { mode: 0o600 });
      fs.mkdirSync(path.join(spaceRoot, 'subdir'), { mode: 0o700 });

      const outsideFile = path.join(tmpDir, 'outside.txt');
      fs.writeFileSync(outsideFile, 'outside', { mode: 0o600 });
      fs.symlinkSync(outsideFile, path.join(spaceRoot, 'symlink-entry.txt'));

      const result = executeFileOperation(
        { op: 'list', space: defaultSpace, path: '.' },
        defaultOptions
      );

      expect(result.op).toBe('list');
      expect(result.entries).toBeDefined();
      expect(result.truncated).toBe(false);
      expect(result.etag).toBeDefined();
      expect(typeof result.etag).toBe('string');
      expect(typeof result.mtimeMs).toBe('number');

      const names = result.entries!.map((e) => e.name);
      expect(names).toContain('file1.txt');
      expect(names).toContain('file2.txt');
      expect(names).toContain('subdir');
      expect(names).toContain('symlink-entry.txt');

      const symlinkEntry = result.entries!.find((e) => e.name === 'symlink-entry.txt');
      expect(symlinkEntry?.type).toBe('symlink');

      const dirEntry = result.entries!.find((e) => e.name === 'subdir');
      expect(dirEntry?.type).toBe('directory');
      expect(dirEntry?.etag).toBe(computeDirectoryETag([]));

      const fileEntry = result.entries!.find((e) => e.name === 'file1.txt');
      expect(fileEntry?.type).toBe('file');
      expect(fileEntry?.size).toBe(Buffer.byteLength('content 1'));
      expect(fileEntry?.etag).toBe(computeFileETag(Buffer.from('content 1')));
    });

    it('caps list entries at 500 items and sets truncated flag', () => {
      const listFolder = path.join(spaceRoot, 'many-files');
      fs.mkdirSync(listFolder, { mode: 0o700 });

      for (let i = 0; i < 520; i++) {
        fs.writeFileSync(path.join(listFolder, `file_${String(i).padStart(4, '0')}.txt`), 'x', {
          mode: 0o600,
        });
      }

      const result = executeFileOperation(
        { op: 'list', space: defaultSpace, path: 'many-files' },
        defaultOptions
      );

      expect(result.entries).toHaveLength(MAX_DIR_ENTRIES);
      expect(result.truncated).toBe(true);
      expect(result.etag).toBeDefined();
    });
  });

  describe('Delete Operations & Space Root Protection', () => {
    it('strictly prohibits deleting space root directory', () => {
      expect(() =>
        executeFileOperation(
          { op: 'delete', space: defaultSpace, path: '.', expectedEtag: '*' },
          defaultOptions
        )
      ).toThrow(FileOpError);

      expect(() =>
        executeFileOperation(
          { op: 'delete', space: defaultSpace, path: '', expectedEtag: '*' },
          defaultOptions
        )
      ).toThrow(FileOpError);

      expect(() =>
        executeFileOperation(
          { op: 'delete', space: defaultSpace, expectedEtag: '*' },
          defaultOptions
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          { op: 'delete', space: defaultSpace, path: '.', expectedEtag: '*' },
          defaultOptions
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('FORBIDDEN');
      }

      expect(fs.existsSync(spaceRoot)).toBe(true);
    });

    it('delete strictly mandates expectedEtag and rejects requests without it', () => {
      const targetFile = path.join(spaceRoot, 'no-etag-del.txt');
      fs.writeFileSync(targetFile, 'data', { mode: 0o600 });

      expect(() =>
        executeFileOperation(
          { op: 'delete', space: defaultSpace, path: 'no-etag-del.txt' },
          defaultOptions
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          { op: 'delete', space: defaultSpace, path: 'no-etag-del.txt' },
          defaultOptions
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('INVALID_REQUEST');
      }

      expect(fs.existsSync(targetFile)).toBe(true);
    });

    it('deletes a single file inside space with matching expectedEtag', () => {
      const targetFile = path.join(spaceRoot, 'remove-me.txt');
      fs.writeFileSync(targetFile, 'data', { mode: 0o600 });
      const fileEtag = computeFileETag(Buffer.from('data'));
      expect(fs.existsSync(targetFile)).toBe(true);

      const result = executeFileOperation(
        { op: 'delete', space: defaultSpace, path: 'remove-me.txt', expectedEtag: fileEtag },
        defaultOptions
      );

      expect(result.op).toBe('delete');
      expect(result.deleted).toBe(true);
      expect(fs.existsSync(targetFile)).toBe(false);
    });

    it('delete fails with PRECONDITION_FAILED when expectedEtag does not match file content', () => {
      const targetFile = path.join(spaceRoot, 'mismatch-del.txt');
      fs.writeFileSync(targetFile, 'actual-content', { mode: 0o600 });

      expect(() =>
        executeFileOperation(
          {
            op: 'delete',
            space: defaultSpace,
            path: 'mismatch-del.txt',
            expectedEtag: '"0000000000000000000000000000000000000000000000000000000000000000"',
          },
          defaultOptions
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          {
            op: 'delete',
            space: defaultSpace,
            path: 'mismatch-del.txt',
            expectedEtag: '"0000000000000000000000000000000000000000000000000000000000000000"',
          },
          defaultOptions
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('PRECONDITION_FAILED');
      }

      expect(fs.existsSync(targetFile)).toBe(true);
    });

    it('deletes an empty directory with matching directory expectedEtag', () => {
      const emptyDir = path.join(spaceRoot, 'empty-dir');
      fs.mkdirSync(emptyDir, { mode: 0o700 });
      const emptyDirEtag = computeDirectoryETag([]);

      const result = executeFileOperation(
        { op: 'delete', space: defaultSpace, path: 'empty-dir', expectedEtag: emptyDirEtag },
        defaultOptions
      );

      expect(result.deleted).toBe(true);
      expect(fs.existsSync(emptyDir)).toBe(false);
    });

    it('fails to delete a non-empty directory and throws PRECONDITION_FAILED', () => {
      const parentDir = path.join(spaceRoot, 'non-empty-dir');
      fs.mkdirSync(parentDir, { mode: 0o700 });
      fs.writeFileSync(path.join(parentDir, 'child.txt'), 'nested content', { mode: 0o600 });

      const dirInfo = inspectDirectory(fs, parentDir, currentUid);

      expect(() =>
        executeFileOperation(
          { op: 'delete', space: defaultSpace, path: 'non-empty-dir', expectedEtag: dirInfo.etag },
          defaultOptions
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          { op: 'delete', space: defaultSpace, path: 'non-empty-dir', expectedEtag: dirInfo.etag },
          defaultOptions
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('PRECONDITION_FAILED');
      }

      expect(fs.existsSync(parentDir)).toBe(true);
    });

    it('rejects unknown recursive parameter with INVALID_REQUEST', () => {
      const emptyDir = path.join(spaceRoot, 'rec-test');
      fs.mkdirSync(emptyDir, { mode: 0o700 });

      expect(() =>
        executeFileOperation(
          { op: 'delete', space: defaultSpace, path: 'rec-test', expectedEtag: '*', recursive: true } as any,
          defaultOptions
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          { op: 'delete', space: defaultSpace, path: 'rec-test', expectedEtag: '*', recursive: true } as any,
          defaultOptions
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('INVALID_REQUEST');
      }
    });
  });

  describe('Rename Operation & Precondition Guards', () => {
    it('renames a regular file with source expectedEtag and requireTargetAbsent=true', () => {
      const sourceFile = path.join(spaceRoot, 'source.txt');
      fs.writeFileSync(sourceFile, 'rename payload', { mode: 0o600 });
      const sourceEtag = computeFileETag(Buffer.from('rename payload'));

      const res = executeFileOperation(
        {
          op: 'rename',
          space: defaultSpace,
          path: 'source.txt',
          targetPath: 'destination.txt',
          expectedEtag: sourceEtag,
          requireTargetAbsent: true,
        },
        defaultOptions
      );

      expect(res.op).toBe('rename');
      expect(res.path).toBe('source.txt');
      expect(res.targetPath).toBe('destination.txt');
      expect(res.renamed).toBe(true);
      expect(fs.existsSync(sourceFile)).toBe(false);
      expect(fs.readFileSync(path.join(spaceRoot, 'destination.txt'), 'utf8')).toBe('rename payload');
    });

    it('renames a file into a newly created nested subfolder with requireTargetAbsent=true', () => {
      const sourceFile = path.join(spaceRoot, 'move-source.txt');
      fs.writeFileSync(sourceFile, 'moved content', { mode: 0o600 });
      const sourceEtag = computeFileETag(Buffer.from('moved content'));

      const res = executeFileOperation(
        {
          op: 'rename',
          space: defaultSpace,
          path: 'move-source.txt',
          targetPath: 'nested/sub/dest.txt',
          expectedEtag: sourceEtag,
          requireTargetAbsent: true,
        },
        defaultOptions
      );

      expect(res.renamed).toBe(true);
      expect(fs.existsSync(sourceFile)).toBe(false);
      expect(fs.readFileSync(path.join(spaceRoot, 'nested', 'sub', 'dest.txt'), 'utf8')).toBe('moved content');
    });

    it('renames with target expectedTargetEtag replacing existing target file', () => {
      const sourceFile = path.join(spaceRoot, 'src-replace.txt');
      const destFile = path.join(spaceRoot, 'dest-replace.txt');
      fs.writeFileSync(sourceFile, 'new src content', { mode: 0o600 });
      fs.writeFileSync(destFile, 'old dest content', { mode: 0o600 });

      const sourceEtag = computeFileETag(Buffer.from('new src content'));
      const targetEtag = computeFileETag(Buffer.from('old dest content'));

      const res = executeFileOperation(
        {
          op: 'rename',
          space: defaultSpace,
          path: 'src-replace.txt',
          targetPath: 'dest-replace.txt',
          expectedEtag: sourceEtag,
          expectedTargetEtag: targetEtag,
        },
        defaultOptions
      );

      expect(res.renamed).toBe(true);
      expect(fs.existsSync(sourceFile)).toBe(false);
      expect(fs.readFileSync(destFile, 'utf8')).toBe('new src content');
    });

    it('rejects rename if destination already exists and requireTargetAbsent=true', () => {
      const sourceFile = path.join(spaceRoot, 'src-exists.txt');
      const destFile = path.join(spaceRoot, 'dest-exists.txt');
      fs.writeFileSync(sourceFile, 'src data', { mode: 0o600 });
      fs.writeFileSync(destFile, 'existing dest data', { mode: 0o600 });
      const sourceEtag = computeFileETag(Buffer.from('src data'));

      expect(() =>
        executeFileOperation(
          {
            op: 'rename',
            space: defaultSpace,
            path: 'src-exists.txt',
            targetPath: 'dest-exists.txt',
            expectedEtag: sourceEtag,
            requireTargetAbsent: true,
          },
          defaultOptions
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          {
            op: 'rename',
            space: defaultSpace,
            path: 'src-exists.txt',
            targetPath: 'dest-exists.txt',
            expectedEtag: sourceEtag,
            requireTargetAbsent: true,
          },
          defaultOptions
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('PRECONDITION_FAILED');
      }

      expect(fs.readFileSync(sourceFile, 'utf8')).toBe('src data');
      expect(fs.readFileSync(destFile, 'utf8')).toBe('existing dest data');
    });

    it('renames a directory validating source directory ETag and returning target directory ETag', () => {
      const srcDir = path.join(spaceRoot, 'orig-folder');
      fs.mkdirSync(srcDir, { mode: 0o700 });
      fs.writeFileSync(path.join(srcDir, 'file.txt'), 'hello inside folder', { mode: 0o600 });

      const dirInfo = inspectDirectory(fs, srcDir, currentUid);

      const res = executeFileOperation(
        {
          op: 'rename',
          space: defaultSpace,
          path: 'orig-folder',
          targetPath: 'new-folder',
          expectedEtag: dirInfo.etag,
          requireTargetAbsent: true,
        },
        defaultOptions
      );

      expect(res.op).toBe('rename');
      expect(res.path).toBe('orig-folder');
      expect(res.targetPath).toBe('new-folder');
      expect(res.renamed).toBe(true);
      expect(res.etag).toBeDefined();
      expect(typeof res.etag).toBe('string');
      expect(fs.existsSync(srcDir)).toBe(false);
      expect(fs.existsSync(path.join(spaceRoot, 'new-folder', 'file.txt'))).toBe(true);
    });

    it('rejects rename missing source expectedEtag or target precondition', () => {
      // Missing source expectedEtag
      expect(() =>
        executeFileOperation(
          {
            op: 'rename',
            space: defaultSpace,
            path: 'a.txt',
            targetPath: 'b.txt',
            requireTargetAbsent: true,
          } as unknown as FileOperationRequest,
          defaultOptions
        )
      ).toThrow(FileOpError);

      // Missing target precondition
      expect(() =>
        executeFileOperation(
          {
            op: 'rename',
            space: defaultSpace,
            path: 'a.txt',
            targetPath: 'b.txt',
            expectedEtag: '"123"',
          } as unknown as FileOperationRequest,
          defaultOptions
        )
      ).toThrow(FileOpError);

      // Both target preconditions
      expect(() =>
        executeFileOperation(
          {
            op: 'rename',
            space: defaultSpace,
            path: 'a.txt',
            targetPath: 'b.txt',
            expectedEtag: '"123"',
            expectedTargetEtag: '"456"',
            requireTargetAbsent: true,
          } as unknown as FileOperationRequest,
          defaultOptions
        )
      ).toThrow(FileOpError);
    });

    it('strictly prohibits renaming the space root directory', () => {
      expect(() =>
        executeFileOperation(
          {
            op: 'rename',
            space: defaultSpace,
            path: '.',
            targetPath: 'renamed-root',
            expectedEtag: '*',
            requireTargetAbsent: true,
          },
          defaultOptions
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          {
            op: 'rename',
            space: defaultSpace,
            path: '.',
            targetPath: 'renamed-root',
            expectedEtag: '*',
            requireTargetAbsent: true,
          },
          defaultOptions
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('FORBIDDEN');
      }
    });

    it('strictly prohibits renaming a file to become the space root directory', () => {
      const sourceFile = path.join(spaceRoot, 'src-to-root.txt');
      fs.writeFileSync(sourceFile, 'data', { mode: 0o600 });
      const sourceEtag = computeFileETag(Buffer.from('data'));

      expect(() =>
        executeFileOperation(
          {
            op: 'rename',
            space: defaultSpace,
            path: 'src-to-root.txt',
            targetPath: '.',
            expectedEtag: sourceEtag,
            requireTargetAbsent: true,
          },
          defaultOptions
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          {
            op: 'rename',
            space: defaultSpace,
            path: 'src-to-root.txt',
            targetPath: '.',
            expectedEtag: sourceEtag,
            requireTargetAbsent: true,
          },
          defaultOptions
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('FORBIDDEN');
      }
    });

    it('rejects rename if source is a symbolic link', () => {
      const outsideTarget = path.join(tmpDir, 'rename-outside.txt');
      fs.writeFileSync(outsideTarget, 'outside', { mode: 0o600 });

      const symlinkSource = path.join(spaceRoot, 'symlink-src.txt');
      fs.symlinkSync(outsideTarget, symlinkSource);

      const validEtag = '"' + 'a'.repeat(64) + '"';
      expect(() =>
        executeFileOperation(
          {
            op: 'rename',
            space: defaultSpace,
            path: 'symlink-src.txt',
            targetPath: 'dest.txt',
            expectedEtag: validEtag,
            requireTargetAbsent: true,
          },
          defaultOptions
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          {
            op: 'rename',
            space: defaultSpace,
            path: 'symlink-src.txt',
            targetPath: 'dest.txt',
            expectedEtag: validEtag,
            requireTargetAbsent: true,
          },
          defaultOptions
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('SYMLINK_FORBIDDEN');
      }
    });
  });

  describe('Metadata Validation: STORAGE_METADATA_INVALID & extractValidMetadata', () => {
    it('validates exact finite nonnegative metadata and throws STORAGE_METADATA_INVALID on invalid numbers', () => {
      const validStat = { size: 100, mtimeMs: 1680000000000 } as fs.Stats;
      const res = extractValidMetadata(validStat);
      expect(res.size).toBe(100);
      expect(res.mtimeMs).toBe(1680000000000);

      // NaN size
      expect(() => extractValidMetadata({ size: NaN, mtimeMs: 1000 } as fs.Stats)).toThrow(FileOpError);
      // Negative size
      expect(() => extractValidMetadata({ size: -1, mtimeMs: 1000 } as fs.Stats)).toThrow(FileOpError);
      // Fractional size
      expect(() => extractValidMetadata({ size: 1.5, mtimeMs: 1000 } as fs.Stats)).toThrow(FileOpError);
      // Infinite size
      expect(() => extractValidMetadata({ size: Infinity, mtimeMs: 1000 } as fs.Stats)).toThrow(FileOpError);
      // Negative mtimeMs
      expect(() => extractValidMetadata({ size: 10, mtimeMs: -50 } as fs.Stats)).toThrow(FileOpError);
      // NaN mtimeMs
      expect(() => extractValidMetadata({ size: 10, mtimeMs: NaN } as fs.Stats)).toThrow(FileOpError);
    });

    it('list throws STORAGE_METADATA_INVALID immediately if stat of entry fails (no placeholder)', () => {
      const listFolder = path.join(spaceRoot, 'bad-meta-dir');
      fs.mkdirSync(listFolder, { mode: 0o700 });
      fs.writeFileSync(path.join(listFolder, 'file.txt'), 'data', { mode: 0o600 });

      const customFs = {
        ...fs,
        lstatSync: (targetPath: fs.PathLike) => {
          if (String(targetPath).endsWith('file.txt')) {
            throw new Error('Disk I/O error reading metadata');
          }
          return fs.lstatSync(targetPath);
        },
      } as unknown as typeof fs;

      expect(() =>
        executeFileOperation(
          { op: 'list', space: defaultSpace, path: 'bad-meta-dir' },
          { ...defaultOptions, fsImpl: customFs }
        )
      ).toThrow(FileOpError);

      try {
        executeFileOperation(
          { op: 'list', space: defaultSpace, path: 'bad-meta-dir' },
          { ...defaultOptions, fsImpl: customFs }
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('STORAGE_METADATA_INVALID');
      }
    });
  });

  describe('Process Stat Reader & Lock Security', () => {
    it('getNoFollowFlag returns non-zero positive number and throws BUSY if 0/undefined', () => {
      const flag = getNoFollowFlag();
      expect(typeof flag).toBe('number');
      expect(flag).toBeGreaterThan(0);
    });

    it('getProcessStartTicks parses valid decimal start ticks from custom reader or filesystem', () => {
      const res = getProcessStartTicks(1234, fs, (_pid) => ({ starttime: '45678' }));
      expect(res).toEqual({ starttime: '45678' });

      // Number starttime normalized to decimal string
      const resNum = getProcessStartTicks(1234, fs, (_pid) => ({ starttime: 45678 }));
      expect(resNum).toEqual({ starttime: '45678' });
    });

    it('getProcessStartTicks returns null only on ENOENT/ESRCH or custom reader returning null', () => {
      const res = getProcessStartTicks(9999, fs, (_pid) => null);
      expect(res).toBeNull();
    });

    it('getProcessStartTicks throws BUSY on EPERM/EACCES/EIO or malformed start ticks (never stale)', () => {
      // Non-decimal string from custom reader
      expect(() =>
        getProcessStartTicks(1234, fs, (_pid) => ({ starttime: 'invalid-ticks' }))
      ).toThrow(FileOpError);

      // Custom reader throws
      expect(() =>
        getProcessStartTicks(1234, fs, (_pid) => {
          const err = new Error('Permission denied');
          (err as { code?: string }).code = 'EPERM';
          throw err;
        })
      ).toThrow(FileOpError);

      try {
        getProcessStartTicks(1234, fs, (_pid) => {
          throw new Error('EIO simulation');
        });
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('BUSY');
      }

      // Malformed /proc/<pid>/stat without closing paren
      const malformedFs1 = {
        ...fs,
        readFileSync: () => '1234 (bash R 1 2 3',
      } as unknown as typeof fs;
      expect(() => getProcessStartTicks(1234, malformedFs1)).toThrow(FileOpError);

      // Malformed /proc/<pid>/stat with fewer than 22 fields
      const malformedFs2 = {
        ...fs,
        readFileSync: () => '1234 (bash) R 1 2 3 4 5',
      } as unknown as typeof fs;
      expect(() => getProcessStartTicks(1234, malformedFs2)).toThrow(FileOpError);

      // Valid /proc/<pid>/stat with 22+ fields and decimal start ticks (field 22 = rest[19])
      const validProcStat = '1234 (bash) R 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20 21';
      const validFs = {
        ...fs,
        readFileSync: () => validProcStat,
      } as unknown as typeof fs;
      const parsedTicks = getProcessStartTicks(1234, validFs);
      expect(parsedTicks).toEqual({ starttime: '987654' });
    });

    it('withPathLocks throws BUSY if current process start ticks cannot be determined', () => {
      const lockDir = path.join(tmpDir, 'test-locks-no-proc');
      expect(() =>
        withPathLocks(
          [{ space: defaultSpace, path: 'file.txt' }],
          { spacesDir, lockDir, expectedUid: currentUid, procStatReader: () => null },
          () => 'fail'
        )
      ).toThrow(FileOpError);

      try {
        withPathLocks(
          [{ space: defaultSpace, path: 'file.txt' }],
          { spacesDir, lockDir, expectedUid: currentUid, procStatReader: () => null },
          () => 'fail'
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('BUSY');
      }
    });

    it('acquires lock with exact metadata {pid, procStartTicks, nonce} and cleans up on finish', () => {
      const lockDir = path.join(tmpDir, 'test-locks-exact');
      let executed = false;

      const result = withPathLocks(
        [{ space: defaultSpace, path: 'locked-file.txt' }],
        { ...defaultOptions, lockDir },
        () => {
          executed = true;
          const canonical = `${defaultSpace}/locked-file.txt`;
          const hash = crypto.createHash('sha256').update(canonical).digest('hex');
          const lockPath = path.join(lockDir, hash);
          const ownerFile = path.join(lockPath, 'owner.json');
          expect(fs.existsSync(lockPath)).toBe(true);
          expect(fs.existsSync(ownerFile)).toBe(true);

          const ownerMeta = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
          expect(ownerMeta.pid).toBe(process.pid);
          expect(ownerMeta.procStartTicks).toBe('12345');
          expect(ownerMeta.nonce).toBeDefined();
          // Verify no extraneous keys
          const keys = Object.keys(ownerMeta);
          expect(keys.sort()).toEqual(['nonce', 'pid', 'procStartTicks'].sort());
          return 'done';
        }
      );

      expect(executed).toBe(true);
      expect(result).toBe('done');

      const canonical = `${defaultSpace}/locked-file.txt`;
      const hash = crypto.createHash('sha256').update(canonical).digest('hex');
      const lockPath = path.join(lockDir, hash);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('stale lock recovery cleans up and acquires when owner PID is dead (procStatReader returns null)', () => {
      const lockDir = path.join(tmpDir, 'test-locks-dead-pid');
      fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });

      const canonical = `${defaultSpace}/dead-pid-file.txt`;
      const hash = crypto.createHash('sha256').update(canonical).digest('hex');
      const lockPath = path.join(lockDir, hash);
      fs.mkdirSync(lockPath, { mode: 0o700 });

      const deadOwnerMeta = {
        pid: 9999999,
        procStartTicks: '99999',
        nonce: 'a'.repeat(32),
      };
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(deadOwnerMeta), { mode: 0o600 });

      const procStatReader = (pid: number) => {
        if (pid === process.pid) return { starttime: '12345' };
        return null; // PID absent
      };

      let executed = false;
      withPathLocks(
        [{ space: defaultSpace, path: 'dead-pid-file.txt' }],
        { spacesDir, lockDir, expectedUid: currentUid, procStatReader },
        () => {
          executed = true;
        }
      );

      expect(executed).toBe(true);
    });

    it('stale lock recovery cleans up and acquires when PID was reused (starttime mismatch)', () => {
      const lockDir = path.join(tmpDir, 'test-locks-pid-reuse');
      fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });

      const canonical = `${defaultSpace}/reused-pid-file.txt`;
      const hash = crypto.createHash('sha256').update(canonical).digest('hex');
      const lockPath = path.join(lockDir, hash);
      fs.mkdirSync(lockPath, { mode: 0o700 });

      const reusedOwnerMeta = {
        pid: 12345,
        procStartTicks: '1001',
        nonce: 'b'.repeat(32),
      };
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(reusedOwnerMeta), { mode: 0o600 });

      const procStatReader = (pid: number) => {
        if (pid === process.pid) return { starttime: '12345' };
        if (pid === 12345) return { starttime: '9999' };
        return null;
      };

      let executed = false;
      withPathLocks(
        [{ space: defaultSpace, path: 'reused-pid-file.txt' }],
        { spacesDir, lockDir, expectedUid: currentUid, procStatReader },
        () => {
          executed = true;
        }
      );

      expect(executed).toBe(true);
    });

    it('active live lock (matching starttime) is NOT stolen and throws BUSY', () => {
      const lockDir = path.join(tmpDir, 'test-locks-active');
      fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });

      const canonical = `${defaultSpace}/active-file.txt`;
      const hash = crypto.createHash('sha256').update(canonical).digest('hex');
      const lockPath = path.join(lockDir, hash);
      fs.mkdirSync(lockPath, { mode: 0o700 });

      const activeOwnerMeta = {
        pid: 7777,
        procStartTicks: '55555',
        nonce: 'c'.repeat(32),
      };
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(activeOwnerMeta), { mode: 0o600 });

      const procStatReader = (pid: number) => {
        if (pid === process.pid) return { starttime: '12345' };
        if (pid === 7777) return { starttime: '55555' };
        return null;
      };

      expect(() =>
        withPathLocks(
          [{ space: defaultSpace, path: 'active-file.txt' }],
          { spacesDir, lockDir, expectedUid: currentUid, procStatReader },
          () => 'fail'
        )
      ).toThrow(FileOpError);

      try {
        withPathLocks(
          [{ space: defaultSpace, path: 'active-file.txt' }],
          { spacesDir, lockDir, expectedUid: currentUid, procStatReader },
          () => 'fail'
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('BUSY');
      }

      // Verify lock still exists
      expect(fs.existsSync(lockPath)).toBe(true);
    });

    it('unlock verifies nonce and does not remove successor lock if nonce changed', () => {
      const lockDir = path.join(tmpDir, 'test-locks-nonce');
      fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });

      const canonical = `${defaultSpace}/successor.txt`;
      const hash = crypto.createHash('sha256').update(canonical).digest('hex');
      const lockPath = path.join(lockDir, hash);

      withPathLocks(
        [{ space: defaultSpace, path: 'successor.txt' }],
        { ...defaultOptions, lockDir },
        () => {
          const successorMeta = {
            pid: process.pid,
            procStartTicks: '12345',
            nonce: 'f'.repeat(32),
          };
          fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(successorMeta), { mode: 0o600 });
        }
      );

      // Verify that successor lock was preserved and NOT deleted by previous holder
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(fs.existsSync(path.join(lockPath, 'owner.json'))).toBe(true);
      const remainingJson = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
      expect(remainingJson.nonce).toBe('f'.repeat(32));
    });

    it('rejects corrupt lock owner metadata failing closed with BUSY (no stale steal)', () => {
      const lockDir = path.join(tmpDir, 'test-locks-corrupt');
      fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });

      const canonical = `${defaultSpace}/corrupt-file.txt`;
      const hash = crypto.createHash('sha256').update(canonical).digest('hex');
      const lockPath = path.join(lockDir, hash);
      fs.mkdirSync(lockPath, { mode: 0o700 });

      // Corrupt JSON file
      fs.writeFileSync(path.join(lockPath, 'owner.json'), 'not valid json {{{', { mode: 0o600 });

      expect(() =>
        withPathLocks(
          [{ space: defaultSpace, path: 'corrupt-file.txt' }],
          { ...defaultOptions, lockDir },
          () => 'fail'
        )
      ).toThrow(FileOpError);

      try {
        withPathLocks(
          [{ space: defaultSpace, path: 'corrupt-file.txt' }],
          { ...defaultOptions, lockDir },
          () => 'fail'
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('BUSY');
      }

      // Non-object JSON
      fs.writeFileSync(path.join(lockPath, 'owner.json'), '12345', { mode: 0o600 });
      expect(() =>
        withPathLocks(
          [{ space: defaultSpace, path: 'corrupt-file.txt' }],
          { ...defaultOptions, lockDir },
          () => 'fail'
        )
      ).toThrow(FileOpError);

      // Extraneous keys
      const badKeys = {
        pid: 1234,
        procStartTicks: '1234',
        nonce: 'a'.repeat(32),
        extraKey: 'forbidden',
      };
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(badKeys), { mode: 0o600 });
      expect(() =>
        withPathLocks(
          [{ space: defaultSpace, path: 'corrupt-file.txt' }],
          { ...defaultOptions, lockDir },
          () => 'fail'
        )
      ).toThrow(FileOpError);
    });

    it('stale lock removal rechecks metadata before unlink and throws BUSY if successor changed nonce', () => {
      const lockDir = path.join(tmpDir, 'test-locks-stale-race');
      fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });

      const canonical = `${defaultSpace}/stale-race.txt`;
      const hash = crypto.createHash('sha256').update(canonical).digest('hex');
      const lockPath = path.join(lockDir, hash);
      fs.mkdirSync(lockPath, { mode: 0o700 });

      const initialStaleOwner = {
        pid: 9999999,
        procStartTicks: '1000',
        nonce: '1'.repeat(32),
      };
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(initialStaleOwner), { mode: 0o600 });

      let readCount = 0;
      const customFs = {
        ...fs,
        readSync: (fd: number, buffer: NodeJS.ArrayBufferView, offset?: number, length?: number, position?: number | null) => {
          readCount++;
          if (readCount === 2) {
            // On second read (the recheck before unlink), simulate a successor writing a new live owner file
            const successorOwner = {
              pid: process.pid,
              procStartTicks: '12345',
              nonce: '2'.repeat(32),
            };
            fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(successorOwner), { mode: 0o600 });
          }
          return (fs.readSync as Function)(fd, buffer, offset, length, position);
        },
      } as unknown as typeof fs;

      const procStatReader = (pid: number) => {
        if (pid === process.pid) return { starttime: '12345' };
        return null; // PID 9999999 is dead
      };

      expect(() =>
        withPathLocks(
          [{ space: defaultSpace, path: 'stale-race.txt' }],
          { spacesDir, lockDir, expectedUid: currentUid, procStatReader, fsImpl: customFs },
          () => 'fail'
        )
      ).toThrow(FileOpError);

      try {
        withPathLocks(
          [{ space: defaultSpace, path: 'stale-race.txt' }],
          { spacesDir, lockDir, expectedUid: currentUid, procStatReader, fsImpl: customFs },
          () => 'fail'
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('BUSY');
      }
    });

    it('directory fsync failure during lock acquisition fails closed throwing BUSY', () => {
      const lockDir = path.join(tmpDir, 'test-locks-dir-fsync-fail');
      fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });

      let dirFsyncAttempted = false;
      const customFs = {
        ...fs,
        fsyncSync: (fd: number) => {
          const stat = fs.fstatSync(fd);
          if (stat.isDirectory()) {
            dirFsyncAttempted = true;
            throw new Error('Simulated directory fsync failure');
          }
          return fs.fsyncSync(fd);
        },
      } as unknown as typeof fs;

      expect(() =>
        withPathLocks(
          [{ space: defaultSpace, path: 'file.txt' }],
          { ...defaultOptions, lockDir, fsImpl: customFs },
          () => 'should-fail'
        )
      ).toThrow(FileOpError);

      expect(dirFsyncAttempted).toBe(true);

      try {
        withPathLocks(
          [{ space: defaultSpace, path: 'file.txt' }],
          { ...defaultOptions, lockDir, fsImpl: customFs },
          () => 'should-fail'
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('BUSY');
      }
    });

    it('owner file write/fsync failure cleans up incomplete owner file and directory and throws BUSY', () => {
      const lockDir = path.join(tmpDir, 'test-locks-owner-write-fail');
      fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });

      const canonical = `${defaultSpace}/write-fail-file.txt`;
      const hash = crypto.createHash('sha256').update(canonical).digest('hex');
      const lockPath = path.join(lockDir, hash);
      const ownerFilePath = path.join(lockPath, 'owner.json');

      const customFs = {
        ...fs,
        writeSync: (fd: number, buffer: NodeJS.ArrayBufferView, offset?: number, length?: number, position?: number | null) => {
          throw new Error('Simulated disk full during owner file write');
        },
      } as unknown as typeof fs;

      expect(() =>
        withPathLocks(
          [{ space: defaultSpace, path: 'write-fail-file.txt' }],
          { ...defaultOptions, lockDir, fsImpl: customFs },
          () => 'should-fail'
        )
      ).toThrow(FileOpError);

      try {
        withPathLocks(
          [{ space: defaultSpace, path: 'write-fail-file.txt' }],
          { ...defaultOptions, lockDir, fsImpl: customFs },
          () => 'should-fail'
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('BUSY');
      }

      // Verify that incomplete owner file and lock directory were cleanly removed
      expect(fs.existsSync(ownerFilePath)).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('unlock owner read failure on corrupted owner file throws cleanup error into AggregateError', () => {
      const lockDir = path.join(tmpDir, 'test-locks-release-corrupt');
      fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });

      const canonical = `${defaultSpace}/corrupt-release.txt`;
      const hash = crypto.createHash('sha256').update(canonical).digest('hex');
      const lockPath = path.join(lockDir, hash);
      const ownerFilePath = path.join(lockPath, 'owner.json');

      expect(() =>
        withPathLocks(
          [{ space: defaultSpace, path: 'corrupt-release.txt' }],
          { ...defaultOptions, lockDir },
          () => {
            // Corrupt the owner file during action execution
            fs.writeFileSync(ownerFilePath, 'corrupt content not json', { mode: 0o600 });
            return 'action-done';
          }
        )
      ).toThrow();

      try {
        withPathLocks(
          [{ space: defaultSpace, path: 'corrupt-release.txt' }],
          { ...defaultOptions, lockDir },
          () => {
            fs.writeFileSync(ownerFilePath, 'corrupt content not json', { mode: 0o600 });
            return 'action-done';
          }
        );
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(FileOpError);
        expect((err as FileOpError).code).toBe('BUSY');
      }
    });

    it('throws LOCK_UNAVAILABLE if lock base directory cannot be initialized or verified', () => {
      const nonDirFile = path.join(tmpDir, 'not-a-dir-lock');
      fs.writeFileSync(nonDirFile, 'regular file', { mode: 0o600 });

      expect(() => {
        withPathLocks(
          [{ space: defaultSpace, path: 'file.txt' }],
          { ...defaultOptions, lockDir: nonDirFile },
          () => 'should-fail'
        );
      }).toThrow(FileOpError);

      try {
        withPathLocks(
          [{ space: defaultSpace, path: 'file.txt' }],
          { ...defaultOptions, lockDir: nonDirFile },
          () => 'should-fail'
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('LOCK_UNAVAILABLE');
      }
    });

    it('fails closed with SYMLINK_FORBIDDEN and NEVER unlinks attacker symlink in lock path', () => {
      const lockDir = path.join(tmpDir, 'test-locks-symlink-attack');
      fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });

      const victimTarget = path.join(tmpDir, 'critical-victim-file.txt');
      fs.writeFileSync(victimTarget, 'CRITICAL DATA NEVER DELETE', { mode: 0o600 });

      const canonical = `${defaultSpace}/target.txt`;
      const hash = crypto.createHash('sha256').update(canonical).digest('hex');
      const lockPath = path.join(lockDir, hash);
      fs.symlinkSync(victimTarget, lockPath);

      expect(() => {
        withPathLocks(
          [{ space: defaultSpace, path: 'target.txt' }],
          { ...defaultOptions, lockDir },
          () => 'should-fail'
        );
      }).toThrow(FileOpError);

      try {
        withPathLocks(
          [{ space: defaultSpace, path: 'target.txt' }],
          { ...defaultOptions, lockDir },
          () => 'should-fail'
        );
      } catch (err: unknown) {
        expect((err as FileOpError).code).toBe('SYMLINK_FORBIDDEN');
      }

      expect(fs.existsSync(lockPath)).toBe(true);
      expect(fs.existsSync(victimTarget)).toBe(true);
      expect(fs.readFileSync(victimTarget, 'utf8')).toBe('CRITICAL DATA NEVER DELETE');
    });

    it('aggregates cleanup errors when action succeeds', () => {
      const lockDir = path.join(tmpDir, 'test-locks-cleanup-err');
      fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });

      const customFs = {
        ...fs,
        unlinkSync: (targetPath: fs.PathLike) => {
          if (String(targetPath).includes('owner.json')) {
            throw new Error('Simulated disk failure during unlock unlink');
          }
          return fs.unlinkSync(targetPath);
        },
      } as unknown as typeof fs;

      expect(() => {
        withPathLocks(
          [{ space: defaultSpace, path: 'file-clean.txt' }],
          { ...defaultOptions, lockDir, fsImpl: customFs },
          () => 'action-success'
        );
      }).toThrow('Simulated disk failure during unlock unlink');
    });

    it('aggregates action failure and cleanup error into AggregateError when both fail', () => {
      const lockDir = path.join(tmpDir, 'test-locks-both-err');
      fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });

      const customFs = {
        ...fs,
        unlinkSync: (targetPath: fs.PathLike) => {
          if (String(targetPath).includes('owner.json')) {
            throw new Error('Simulated unlock cleanup error');
          }
          return fs.unlinkSync(targetPath);
        },
      } as unknown as typeof fs;

      try {
        withPathLocks(
          [{ space: defaultSpace, path: 'file-both.txt' }],
          { ...defaultOptions, lockDir, fsImpl: customFs },
          () => {
            throw new Error('Action execution failed');
          }
        );
        expect.unreachable('Should have thrown AggregateError');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(AggregateError);
        const agg = err as AggregateError;
        expect(agg.errors.length).toBeGreaterThanOrEqual(2);
        expect(agg.errors[0].message).toContain('Action execution failed');
      }
    });
  });

  describe('Output and Error Sanitization (No Leaked Paths or Stacks)', () => {
    it('sanitizes error messages removing absolute paths and stack traces', () => {
      const rawErrorWithPaths = `Error: Cannot open /home/dsh/spaces/secret-space/confidential.txt\n    at Object.openSync (fs.js:100:20)\n    at /app/runtime-runner/src/runtime/file-ops.ts:250:10`;
      const sanitized = sanitizeErrorMessage(rawErrorWithPaths);

      expect(sanitized).not.toContain('/home/dsh/spaces/secret-space/confidential.txt');
      expect(sanitized).not.toContain('at Object.openSync');
      expect(sanitized).not.toContain('file-ops.ts');
      expect(sanitized).not.toContain('\n');
    });

    it('file op error throws with fixed mapped messages without full absolute path leaks', () => {
      try {
        executeFileOperation(
          { op: 'read', space: defaultSpace, path: 'non-existent/deep/missing.txt' },
          defaultOptions
        );
        expect.unreachable('Should have thrown');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(FileOpError);
        const fileErr = err as FileOpError;
        expect(fileErr.message).toBe('Target not found');
        expect(fileErr.message).not.toContain(spacesDir);
      }
    });
  });

  describe('Exec-CLI In-Container Execution & Transport Parsing Fail-Closed', () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      originalEnv = { ...process.env };
      process.env.DSH_USER = 'alice';
      process.env.DSH_HOME = path.join(tmpDir, 'alice', '.dsh');
      process.env.DSH_SPACES = spacesDir;
      fs.mkdirSync(process.env.DSH_HOME, { recursive: true, mode: 0o700 });
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('parseExecEnvelope successfully parses and validates valid fileResult', () => {
      const validJson = JSON.stringify({
        status: 'ok',
        userId: 'alice',
        fileResult: {
          op: 'read',
          space: 'space-1',
          path: 'file.txt',
          content: 'Hello World',
          encoding: 'utf8',
          size: 11,
        },
      });

      const parsed = parseExecEnvelope(validJson);
      expect(parsed.status).toBe('ok');
      expect(parsed.fileResult).toBeDefined();
      expect(parsed.fileResult?.op).toBe('read');
      expect(parsed.fileResult?.space).toBe('space-1');
      expect(parsed.fileResult?.path).toBe('file.txt');
      expect(parsed.fileResult?.content).toBe('Hello World');
      expect(parsed.fileResult?.size).toBe(11);
    });

    it('parseExecEnvelope rejects malformed fileResult with DockerDaemonError (Fail-Closed)', () => {
      expect(() =>
        parseExecEnvelope(
          JSON.stringify({
            status: 'ok',
            fileResult: { op: 'invalid_op', space: 's', path: 'p' },
          })
        )
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(
          JSON.stringify({
            status: 'ok',
            fileResult: { op: 'read', space: '', path: 'p' },
          })
        )
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(
          JSON.stringify({
            status: 'ok',
            fileResult: { op: 'list', space: 's', path: 'p', entries: 'not-an-array' },
          })
        )
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(
          JSON.stringify({
            status: 'ok',
            fileResult: { op: 'read', space: 's', path: 'p', size: -5 },
          })
        )
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(
          JSON.stringify({
            status: 'ok',
            fileResult: { op: 'list', space: 's', path: 'p', truncated: 'yes' },
          })
        )
      ).toThrow(DockerDaemonError);
    });
  });

  describe('ActiveRuntimeHandle & Docker Adapter File Operations Contract', () => {
    it('ActiveRuntimeHandle dispatches file operations through SafeDockerClient.execOwned with pre/post inspection', async () => {
      const mockClient = new SafeDockerClient();
      const valid64HexId = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

      const adapter = new DockerRuntimeAdapter(mockClient, {
        daemonTransportFactory: (c, exp) => new FakeDaemonTransport(c, exp),
      });
      const spec = adapter.createDefaultUserSpec({ userId: 'alice' });

      vi.spyOn(mockClient, 'inspectVolume').mockResolvedValue(null);
      vi.spyOn(mockClient, 'runContainer').mockResolvedValue({
        containerId: valid64HexId,
        volumeCreated: true,
      });
      vi.spyOn(mockClient, 'runContainerWithOwnedVolume').mockResolvedValue({
        containerId: valid64HexId,
        volumeCreated: false,
      });
      vi.spyOn(mockClient, 'stopContainer').mockResolvedValue(undefined);
      vi.spyOn(mockClient, 'removeContainer').mockResolvedValue(undefined);
      vi.spyOn(mockClient, 'removeVolume').mockResolvedValue(undefined);

      const execOwnedSpy = vi.spyOn(mockClient, 'execOwned').mockImplementation(async (_expectation, req) => {
        if (req.action === 'file-op') {
          return {
            status: 'ok',
            userId: 'alice',
            fileResult: {
              op: req.fileOp?.op || 'list',
              space: req.fileOp?.space || 'default',
              path: req.fileOp?.path || '.',
              entries: [],
              truncated: false,
              written: true,
              created: true,
              deleted: true,
              content: 'test content',
              size: 12,
            },
          };
        }
        if (req.action === 'followup') {
          return {
            status: 'completed',
            userId: 'alice',
            sessionId: req.sessionId || 'session-1',
            turnId: req.turnId || 'turn-1',
            replyText: 'Followup response',
            eventsCount: 2,
            persisted: true,
          };
        }
        if (req.action === 'cancel') {
          return {
            status: 'cancelled',
            userId: 'alice',
            turnId: req.turnId || 'turn-1',
          };
        }
        return {
          status: 'ok',
          dshReady: true,
          enkeepBundleLoaded: true,
          userId: 'alice',
          version: '0.1.1-rc.2',
          modelProvider: 'cpa-claude',
          uptimeSeconds: 10,
          plugins: {
            receiptStore: true,
            inbound: true,
            eventRelay: true,
            tools: true,
            externalInteraction: true,
            affinityPolicy: true,
            llmAffinity: true,
          },
          toolsCount: 4,
          toolsOperational: true,
          sessionId: 'session-alice-1',
          totalEvents: 5,
        };
      });

      vi.spyOn(mockClient, 'inspectContainer').mockImplementation(async (idOrName) => {
        if (idOrName === spec.containerName) return null;
        return {
          id: valid64HexId,
          name: spec.containerName,
          image: spec.image,
          status: 'running',
          state: 'running',
          user: '1000:1000',
          networkMode: 'none',
          readonlyRootfs: true,
          capDrop: ['ALL'],
          securityOpt: ['no-new-privileges:true'],
          pidsLimit: 256,
          portBindings: null,
          mounts: [
            {
              type: 'volume',
              name: spec.volume.volumeName,
              destination: '/home/dsh',
              rw: true,
              source: '/var/lib/docker/volumes/...',
            },
          ],
          tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=64m' },
          labels: {
            app: 'enkeep-demo',
            'enkeep.user': 'alice',
            'enkeep.run-id': spec.runId,
            'enkeep.volume-id': spec.volume.volumeId,
          },
        };
      });

      const handle = await adapter.startRuntime(spec, 5000);

      const listRes = await handle.fileOperation({
        op: 'list',
        space: 'alice-workspace',
        path: '.',
      });
      expect(listRes.status).toBe('ok');
      expect(listRes.fileResult?.op).toBe('list');

      const readRes = await handle.fileOperation({
        op: 'read',
        space: 'alice-workspace',
        path: 'test.txt',
        encoding: 'utf8',
      });
      expect(readRes.status).toBe('ok');
      expect(readRes.fileResult?.content).toBe('test content');

      const mockEtag = '"' + 'a'.repeat(64) + '"';
      const writeRes = await handle.fileOperation({
        op: 'write',
        space: 'alice-workspace',
        path: 'test.txt',
        content: 'new data',
        expectedEtag: mockEtag,
      });
      expect(writeRes.status).toBe('ok');
      expect(writeRes.fileResult?.written).toBe(true);

      const renameRes = await handle.fileOperation({
        op: 'rename',
        space: 'alice-workspace',
        path: 'test.txt',
        targetPath: 'test-renamed.txt',
        expectedEtag: mockEtag,
        requireTargetAbsent: true,
      });
      expect(renameRes.status).toBe('ok');

      const mkdirRes = await handle.fileOperation({
        op: 'mkdir',
        space: 'alice-workspace',
        path: 'new-dir',
        requireAbsent: true,
      });
      expect(mkdirRes.status).toBe('ok');

      const delRes = await handle.fileOperation({
        op: 'delete',
        space: 'alice-workspace',
        path: 'old.txt',
        expectedEtag: mockEtag,
      });
      expect(delRes.status).toBe('ok');

      expect(execOwnedSpy).toHaveBeenCalledWith(
        expect.objectContaining({ containerId: valid64HexId, userId: 'alice' }),
        expect.objectContaining({ action: 'file-op' })
      );

      await handle.teardown(true);
    });

    it('connectRuntime handle executes file operations', async () => {
      const mockClient = new SafeDockerClient();
      const valid64HexId = 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3';

      const adapter = new DockerRuntimeAdapter(mockClient, {
        daemonTransportFactory: (c, exp) => new FakeDaemonTransport(c, exp),
      });
      const spec = adapter.createDefaultUserSpec({
        userId: 'bob',
      });

      vi.spyOn(mockClient, 'inspectVolume').mockResolvedValue({
        name: spec.volume.volumeName,
        labels: {
          app: 'enkeep-demo',
          'enkeep.user': 'bob',
          'enkeep.volume-id': spec.volume.volumeId,
        },
      });

      vi.spyOn(mockClient, 'inspectContainer').mockImplementation(async (_idOrName) => {
        return {
          id: valid64HexId,
          name: spec.containerName,
          image: spec.image,
          status: 'running',
          state: 'running',
          user: '1000:1000',
          networkMode: 'none',
          readonlyRootfs: true,
          capDrop: ['ALL'],
          securityOpt: ['no-new-privileges:true'],
          pidsLimit: 256,
          portBindings: null,
          mounts: [
            {
              type: 'volume',
              name: spec.volume.volumeName,
              destination: '/home/dsh',
              rw: true,
              source: '/var/lib/docker/volumes/...',
            },
          ],
          tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=64m' },
          labels: {
            app: 'enkeep-demo',
            'enkeep.user': 'bob',
            'enkeep.run-id': spec.runId,
            'enkeep.volume-id': spec.volume.volumeId,
          },
        };
      });

      vi.spyOn(mockClient, 'execOwned').mockImplementation(async (_expectation, req) => {
        if (req.action === 'file-op') {
          return {
            status: 'ok',
            userId: 'bob',
            fileResult: {
              op: req.fileOp?.op || 'read',
              space: req.fileOp?.space || 'bob-space',
              path: req.fileOp?.path || 'file.txt',
              content: 'bob content',
              encoding: 'utf8',
              size: 11,
            },
          };
        }
        return {
          status: 'ok',
          dshReady: true,
          enkeepBundleLoaded: true,
          userId: 'bob',
          version: '0.1.1-rc.2',
          modelProvider: 'cpa-claude',
          uptimeSeconds: 50,
          plugins: {
            receiptStore: true,
            inbound: true,
            eventRelay: true,
            tools: true,
            externalInteraction: true,
            affinityPolicy: true,
            llmAffinity: true,
          },
          toolsCount: 4,
          toolsOperational: true,
          sessionId: 'session-bob-1',
          totalEvents: 12,
        };
      });

      const connectIdentity = {
        containerId: valid64HexId,
        containerName: spec.containerName,
        userId: 'bob',
        runId: spec.runId,
        volumeName: spec.volume.volumeName,
        volumeId: spec.volume.volumeId,
      };

      const handle = await adapter.connectRuntime(spec, connectIdentity, 5000);
      expect(handle.isCreated).toBe(false);
      expect(handle.containerId).toBe(valid64HexId);

      const readRes = await handle.fileOperation({
        op: 'read',
        space: 'bob-space',
        path: 'file.txt',
        encoding: 'utf8',
      });
      expect(readRes.status).toBe('ok');
      expect(readRes.fileResult?.content).toBe('bob content');
    });
  });
});
