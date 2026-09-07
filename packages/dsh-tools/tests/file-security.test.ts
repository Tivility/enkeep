import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  readValidatedFile,
  withValidatedFile,
  validateFileContainment,
  FileSecurityError,
  setDefaultFileSecurityHooks,
  createSimulatedFdResolver,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  MAX_PATH_LENGTH,
  MAX_FILENAME_LENGTH,
} from '../src/file-security.js';

function asFileSecurityError(err: unknown): FileSecurityError {
  if (err instanceof FileSecurityError) {
    return err;
  }
  throw err;
}

describe('dsh-tools: file-security containment and TOCTOU mitigation', () => {
  let tempDir: string;
  let workspaceDir: string;
  let outsideDir: string;

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tools-sec-test-')));
    workspaceDir = path.join(tempDir, 'workspace');
    outsideDir = path.join(tempDir, 'outside');

    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    // Enable default test simulated resolver on macOS / test environments
    setDefaultFileSecurityHooks({
      resolveFdPath: createSimulatedFdResolver(),
    });
  });

  afterEach(() => {
    setDefaultFileSecurityHooks(undefined);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup
    }
  });

  describe('valid file reading and containment', () => {
    it('readValidatedFile reads valid relative file and returns ValidatedFileWithContent', () => {
      const filePath = 'hello.txt';
      const absPath = path.join(workspaceDir, filePath);
      const testContent = 'Hello secure world!';
      fs.writeFileSync(absPath, testContent);

      const result = readValidatedFile({
        workspaceRoot: workspaceDir,
        filePath: 'hello.txt',
      });

      expect(result.relativePath).toBe('hello.txt');
      expect(result.filename).toBe('hello.txt');
      expect(result.size).toBe(Buffer.byteLength(testContent));
      expect(result.content).toBeInstanceOf(Buffer);
      expect(result.content.toString('utf8')).toBe(testContent);
      expect(result.canonicalPath).toBe(path.resolve(workspaceDir, 'hello.txt'));
    });

    it('readValidatedFile reads nested relative file inside workspace', () => {
      const subDir = path.join(workspaceDir, 'sub', 'nested');
      fs.mkdirSync(subDir, { recursive: true });
      const absPath = path.join(subDir, 'doc.md');
      const testContent = '# Secure Document\nContent here.';
      fs.writeFileSync(absPath, testContent);

      const result = readValidatedFile({
        workspaceRoot: workspaceDir,
        filePath: 'sub/nested/doc.md',
      });

      expect(result.relativePath).toBe(path.normalize('sub/nested/doc.md'));
      expect(result.filename).toBe('doc.md');
      expect(result.size).toBe(Buffer.byteLength(testContent));
      expect(result.content.toString('utf8')).toBe(testContent);
    });

    it('withValidatedFile executes sync and async callback with validated file', async () => {
      const filePath = 'async-test.json';
      const absPath = path.join(workspaceDir, filePath);
      fs.writeFileSync(absPath, JSON.stringify({ key: 'value' }));

      const syncResult = await withValidatedFile(
        { workspaceRoot: workspaceDir, filePath },
        (file) => JSON.parse(file.content.toString('utf8'))
      );
      expect(syncResult).toEqual({ key: 'value' });

      const asyncResult = await withValidatedFile(
        { workspaceRoot: workspaceDir, filePath },
        async (file) => {
          await new Promise((r) => setTimeout(r, 5));
          return file.size;
        }
      );
      expect(asyncResult).toBe(Buffer.byteLength(JSON.stringify({ key: 'value' })));
    });

    it('validateFileContainment returns ValidatedFile metadata', () => {
      const filePath = 'metadata.txt';
      const absPath = path.join(workspaceDir, filePath);
      fs.writeFileSync(absPath, 'metadata check');

      const result = validateFileContainment({
        workspaceRoot: workspaceDir,
        filePath,
      });

      expect(result.relativePath).toBe('metadata.txt');
      expect(result.filename).toBe('metadata.txt');
      expect(result.size).toBe(14);
      expect(result.canonicalPath).toBe(path.resolve(workspaceDir, 'metadata.txt'));
    });
  });

  describe('strict path and bounds enforcement', () => {
    it('rejects absolute paths unconditionally', () => {
      const absPath = path.join(workspaceDir, 'hello.txt');
      fs.writeFileSync(absPath, 'Hello');

      expect(() =>
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: absPath,
        })
      ).toThrow(FileSecurityError);

      try {
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: absPath,
        });
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('ABSOLUTE_PATH_DISALLOWED');
        expect(secErr.status).toBe(400);
      }
    });

    it('rejects Windows-style drive absolute paths (e.g. C:/foo/bar)', () => {
      expect(() =>
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'C:/secret/passwords.txt',
        })
      ).toThrow(FileSecurityError);

      try {
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'D:\\data\\file.txt',
        });
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('ABSOLUTE_PATH_DISALLOWED');
      }
    });

    it('rejects empty or whitespace-only filePath', () => {
      expect(() =>
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: '',
        })
      ).toThrow(FileSecurityError);

      try {
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: '   ',
        });
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('INVALID_PATH');
      }
    });

    it('rejects path exceeding MAX_PATH_LENGTH', () => {
      const longPath = 'a/'.repeat(2500) + 'test.txt';
      expect(longPath.length).toBeGreaterThan(MAX_PATH_LENGTH);

      try {
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: longPath,
        });
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('PATH_TOO_LONG');
      }
    });

    it('rejects filename exceeding MAX_FILENAME_LENGTH', () => {
      const longFilename = 'a'.repeat(MAX_FILENAME_LENGTH + 10) + '.txt';
      const subDir = path.join(workspaceDir, 'sub');
      fs.mkdirSync(subDir, { recursive: true });

      try {
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: `sub/${longFilename}`,
        });
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('INVALID_FILENAME');
      }
    });

    it('rejects null byte injection in filePath', () => {
      expect(() =>
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'hello.txt\0.png',
        })
      ).toThrow(FileSecurityError);

      try {
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'hello.txt\0.png',
        });
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('NULL_BYTE_INJECTION');
      }
    });

    it('rejects null byte injection in workspaceRoot', () => {
      try {
        readValidatedFile({
          workspaceRoot: `${workspaceDir}\0`,
          filePath: 'hello.txt',
        });
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('NULL_BYTE_INJECTION');
      }
    });

    it('rejects path traversal attempting to escape workspace via ../', () => {
      const outsideFile = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(outsideFile, 'secret data');

      expect(() =>
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: '../outside/secret.txt',
        })
      ).toThrow(FileSecurityError);

      try {
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: '../outside/secret.txt',
        });
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('PATH_TRAVERSAL_DETECTED');
        expect(secErr.status).toBe(403);
      }
    });

    it('rejects relative path resolving to workspace directory root (e.g. . or empty)', () => {
      try {
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: '.',
        });
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('PATH_TRAVERSAL_DETECTED');
      }
    });
  });

  describe('workspace root validation', () => {
    it('rejects non-existent workspace root', () => {
      try {
        readValidatedFile({
          workspaceRoot: path.join(tempDir, 'non-existent-workspace'),
          filePath: 'test.txt',
        });
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('WORKSPACE_ROOT_NOT_FOUND');
      }
    });

    it('rejects workspace root that is a regular file', () => {
      const fileRoot = path.join(tempDir, 'file-root.txt');
      fs.writeFileSync(fileRoot, 'not a directory');

      try {
        readValidatedFile({
          workspaceRoot: fileRoot,
          filePath: 'test.txt',
        });
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('WORKSPACE_ROOT_NOT_DIRECTORY');
      }
    });

    it('rejects workspace root that is a symlink', () => {
      const realWs = path.join(tempDir, 'real-workspace');
      fs.mkdirSync(realWs);
      const symlinkWs = path.join(tempDir, 'symlink-workspace');
      fs.symlinkSync(realWs, symlinkWs);

      const targetFile = path.join(realWs, 'test.txt');
      fs.writeFileSync(targetFile, 'data');

      try {
        readValidatedFile({
          workspaceRoot: symlinkWs,
          filePath: 'test.txt',
        });
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('WORKSPACE_ROOT_IS_SYMLINK');
        expect(secErr.status).toBe(403);
      }
    });
  });

  describe('strict symlink rejection', () => {
    it('rejects symlink pointing outside workspace root (symlink breakout)', () => {
      const outsideSecret = path.join(outsideDir, 'outside-secret.env');
      fs.writeFileSync(outsideSecret, 'SUPER_SECRET_KEY=12345');

      const symlinkPath = path.join(workspaceDir, 'symlink-escape.txt');
      fs.symlinkSync(outsideSecret, symlinkPath);

      expect(() =>
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'symlink-escape.txt',
        })
      ).toThrow(FileSecurityError);

      try {
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'symlink-escape.txt',
        });
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('SYMLINK_DISALLOWED');
        expect(secErr.status).toBe(403);
      }
    });

    it('rejects symlink pointing inside workspace root (strict no-symlinks policy)', () => {
      const targetFile = path.join(workspaceDir, 'original.txt');
      fs.writeFileSync(targetFile, 'content inside');

      const linkPath = path.join(workspaceDir, 'alias.txt');
      fs.symlinkSync(targetFile, linkPath);

      expect(() =>
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'alias.txt',
        })
      ).toThrow(FileSecurityError);

      try {
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'alias.txt',
        });
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('SYMLINK_DISALLOWED');
        expect(secErr.status).toBe(403);
      }
    });

    it('rejects intermediate path component being a symlinked directory', () => {
      const realSubDir = path.join(tempDir, 'outside-sub');
      fs.mkdirSync(realSubDir);
      fs.writeFileSync(path.join(realSubDir, 'data.json'), '{"leaked": true}');

      const symlinkDir = path.join(workspaceDir, 'linked-dir');
      fs.symlinkSync(realSubDir, symlinkDir);

      try {
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'linked-dir/data.json',
        });
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('SYMLINK_DISALLOWED');
        expect(secErr.status).toBe(403);
      }
    });
  });

  describe('file type, existence and size limit', () => {
    it('rejects directories as target (must be a regular file)', () => {
      const subFolder = path.join(workspaceDir, 'subfolder');
      fs.mkdirSync(subFolder);

      expect(() =>
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'subfolder',
        })
      ).toThrow(FileSecurityError);

      try {
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'subfolder',
        });
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('NOT_A_REGULAR_FILE');
      }
    });

    it('rejects non-existent files', () => {
      expect(() =>
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'non-existent.txt',
        })
      ).toThrow(FileSecurityError);

      try {
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'non-existent.txt',
        });
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('FILE_NOT_FOUND');
        expect(secErr.status).toBe(404);
      }
    });

    it('enforces maximum file size limit', () => {
      const largeFile = path.join(workspaceDir, 'large.bin');
      fs.writeFileSync(largeFile, Buffer.alloc(1024)); // 1 KB

      expect(() =>
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'large.bin',
          maxSizeBytes: 500, // 500 bytes limit
        })
      ).toThrow(FileSecurityError);

      try {
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'large.bin',
          maxSizeBytes: 500,
        });
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('FILE_TOO_LARGE');
        expect(secErr.status).toBe(413);
      }
    });
  });

  describe('TOCTOU race condition and file swap mitigation', () => {
    it('detects inode mismatch when target file is swapped after descriptor opening', () => {
      const testFile = path.join(workspaceDir, 'target.txt');
      fs.writeFileSync(testFile, 'initial safe content');

      expect(() =>
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'target.txt',
          hooks: {
            afterOpen: (_fd, targetPath) => {
              // Simulate an attacker replacing the file with another file on disk
              fs.unlinkSync(targetPath);
              fs.writeFileSync(targetPath, 'attacker swapped content');
            },
          },
        })
      ).toThrow(FileSecurityError);

      try {
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'target.txt',
          hooks: {
            afterOpen: (_fd, targetPath) => {
              fs.unlinkSync(targetPath);
              fs.writeFileSync(targetPath, 'attacker swapped content');
            },
          },
        });
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('TOCTOU_SWAP_DETECTED');
        expect(secErr.status).toBe(403);
      }
    });

    it('detects symlink replacement when file is replaced with symlink during verification', () => {
      const testFile = path.join(workspaceDir, 'victim.txt');
      fs.writeFileSync(testFile, 'safe victim content');

      const outsideSecret = path.join(outsideDir, 'secret-credentials.txt');
      fs.writeFileSync(outsideSecret, 'HIGHLY_CONFIDENTIAL_KEY');

      expect(() =>
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'victim.txt',
          hooks: {
            afterOpen: (_fd, targetPath) => {
              // Simulate attacker replacing victim file with symlink to outside secret
              fs.unlinkSync(targetPath);
              fs.symlinkSync(outsideSecret, targetPath);
            },
          },
        })
      ).toThrow(FileSecurityError);

      try {
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'victim.txt',
          hooks: {
            afterOpen: (_fd, targetPath) => {
              fs.unlinkSync(targetPath);
              fs.symlinkSync(outsideSecret, targetPath);
            },
          },
        });
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('SYMLINK_DISALLOWED');
        expect(secErr.status).toBe(403);
      }
    });

    it('rejects symlink created right before descriptor opening via O_NOFOLLOW / symlink check', () => {
      const testFile = path.join(workspaceDir, 'target-pre.txt');
      fs.writeFileSync(testFile, 'initial content');

      const outsideSecret = path.join(outsideDir, 'secret-pre.txt');
      fs.writeFileSync(outsideSecret, 'SECRET_BEFORE_OPEN');

      try {
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'target-pre.txt',
          hooks: {
            beforeOpen: (targetPath) => {
              fs.unlinkSync(targetPath);
              fs.symlinkSync(outsideSecret, targetPath);
            },
          },
        });
        expect.fail('Should have thrown FileSecurityError');
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('SYMLINK_DISALLOWED');
        expect(secErr.status).toBe(403);
      }
    });

    it('ensures file descriptor is properly closed even if validation fails mid-way', () => {
      const testFile = path.join(workspaceDir, 'close-test.txt');
      fs.writeFileSync(testFile, 'test descriptor close');

      let capturedFd: number | null = null;

      expect(() =>
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'close-test.txt',
          hooks: {
            afterOpen: (fd) => {
              capturedFd = fd;
              throw new Error('Simulated verification crash');
            },
          },
        })
      ).toThrow('Simulated verification crash');

      expect(capturedFd).not.toBeNull();
      // Since fd was closed in finally block, fstatSync on capturedFd must throw EBADF
      expect(() => fs.fstatSync(capturedFd!)).toThrow(/EBADF/);
    });

    it('detects intermediate parent directory swapped to symlink before open and prevents secret leakage', () => {
      const subDir = path.join(workspaceDir, 'sub');
      fs.mkdirSync(subDir, { recursive: true });
      const targetFile = path.join(subDir, 'secret.txt');
      fs.writeFileSync(targetFile, 'inside workspace harmless content');

      const outsideSecretDir = path.join(outsideDir, 'secret-dir');
      fs.mkdirSync(outsideSecretDir, { recursive: true });
      const outsideSecretFile = path.join(outsideSecretDir, 'secret.txt');
      fs.writeFileSync(outsideSecretFile, 'CRITICAL_OUTSIDE_API_KEY_99999');

      let readResult: unknown = null;
      let errorThrown: unknown = null;

      try {
        readResult = readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'sub/secret.txt',
          hooks: {
            beforeOpen: () => {
              // Attacker replaces intermediate parent directory 'sub' with a symlink to outside secret directory
              fs.rmSync(subDir, { recursive: true, force: true });
              fs.symlinkSync(outsideSecretDir, subDir);
            },
          },
        });
      } catch (err: unknown) {
        errorThrown = err;
      }

      expect(readResult).toBeNull();
      expect(errorThrown).toBeInstanceOf(FileSecurityError);
      const secErr = asFileSecurityError(errorThrown);
      expect(secErr.code).toMatch(/^(TOCTOU_SWAP_DETECTED|SYMLINK_DISALLOWED)$/);
      expect(secErr.status).toBe(403);
    });

    it('detects ancestor directory inode modification between snapshot and open as TOCTOU_SWAP_DETECTED', () => {
      const subDir = path.join(workspaceDir, 'sub');
      fs.mkdirSync(subDir, { recursive: true });
      const targetFile = path.join(subDir, 'doc.txt');
      fs.writeFileSync(targetFile, 'original text');

      let readResult: unknown = null;
      let errorThrown: unknown = null;

      try {
        readResult = readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'sub/doc.txt',
          hooks: {
            beforeOpen: () => {
              // Replace intermediate directory with a newly created directory (different inode)
              fs.rmSync(subDir, { recursive: true, force: true });
              fs.mkdirSync(subDir);
              fs.writeFileSync(path.join(subDir, 'doc.txt'), 'swapped dir content');
            },
          },
        });
      } catch (err: unknown) {
        errorThrown = err;
      }

      expect(readResult).toBeNull();
      expect(errorThrown).toBeInstanceOf(FileSecurityError);
      const secErr = asFileSecurityError(errorThrown);
      expect(secErr.code).toBe('TOCTOU_SWAP_DETECTED');
      expect(secErr.status).toBe(403);
    });

    it('detects deeply nested intermediate directory swap to symlink before open', () => {
      const nestedDir = path.join(workspaceDir, 'a', 'b', 'c');
      fs.mkdirSync(nestedDir, { recursive: true });
      const targetFile = path.join(nestedDir, 'data.json');
      fs.writeFileSync(targetFile, '{"safe": true}');

      const outsideTargetDir = path.join(outsideDir, 'c-leak');
      fs.mkdirSync(outsideTargetDir, { recursive: true });
      fs.writeFileSync(path.join(outsideTargetDir, 'data.json'), '{"leaked": true}');

      let errorThrown: unknown = null;
      try {
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'a/b/c/data.json',
          hooks: {
            beforeOpen: () => {
              const bDir = path.join(workspaceDir, 'a', 'b');
              fs.rmSync(bDir, { recursive: true, force: true });
              fs.mkdirSync(bDir, { recursive: true });
              fs.symlinkSync(outsideTargetDir, path.join(bDir, 'c'));
            },
          },
        });
      } catch (err: unknown) {
        errorThrown = err;
      }

      expect(errorThrown).toBeInstanceOf(FileSecurityError);
      const secErr = asFileSecurityError(errorThrown);
      expect(secErr.code).toMatch(/^(TOCTOU_SWAP_DETECTED|SYMLINK_DISALLOWED)$/);
      expect(secErr.status).toBe(403);
    });

    it('preserves primary error with AggregateError when closeSync also fails', () => {
      const testFile = path.join(workspaceDir, 'close-failure.txt');
      fs.writeFileSync(testFile, 'initial content');

      let capturedError: unknown = null;

      try {
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'close-failure.txt',
          hooks: {
            beforeRead: (fd) => {
              // Prematurely close fd so closeSync in finally fails with EBADF
              fs.closeSync(fd);
              // And throw a FileSecurityError as the primary verification error
              throw new FileSecurityError(
                'Simulated security verification failure',
                'SIMULATED_SECURITY_ERROR',
                403
              );
            },
          },
        });
      } catch (err: unknown) {
        capturedError = err;
      }

      expect(capturedError).toBeInstanceOf(AggregateError);
      const aggErr = capturedError as AggregateError;
      expect(aggErr.errors).toHaveLength(2);
      expect(aggErr.errors[0]).toBeInstanceOf(FileSecurityError);
      expect((aggErr.errors[0] as FileSecurityError).code).toBe('SIMULATED_SECURITY_ERROR');
      expect((aggErr.errors[1] as Error).message).toMatch(/EBADF/);
      expect(aggErr.message).toContain('File security validation failed, and closing descriptor also failed');
    });
  });

  describe('kernel file descriptor resolution and fail-closed policy', () => {
    it('throws FD_RESOLUTION_UNSUPPORTED (500) when resolveFdPath hook returns null (simulating unsupported platform or resolution failure)', () => {
      const testFile = path.join(workspaceDir, 'fd-null.txt');
      fs.writeFileSync(testFile, 'hello');

      expect(() =>
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'fd-null.txt',
          hooks: {
            resolveFdPath: () => null,
          },
        })
      ).toThrow(FileSecurityError);

      try {
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'fd-null.txt',
          hooks: {
            resolveFdPath: () => null,
          },
        });
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('FD_RESOLUTION_UNSUPPORTED');
        expect(secErr.status).toBe(500);
        expect(secErr.message).toContain('Kernel file descriptor path resolution is unsupported or failed on this platform (fail-closed policy)');
      }
    });

    it('throws FD_RESOLUTION_UNSUPPORTED (500) when resolveFdPath hook returns /dev/fd/ path (unresolved devfs node)', () => {
      const testFile = path.join(workspaceDir, 'fd-dev.txt');
      fs.writeFileSync(testFile, 'hello');

      expect(() =>
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'fd-dev.txt',
          hooks: {
            resolveFdPath: (fd) => `/dev/fd/${fd}`,
          },
        })
      ).toThrow(FileSecurityError);

      try {
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'fd-dev.txt',
          hooks: {
            resolveFdPath: (fd) => `/dev/fd/${fd}`,
          },
        });
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('FD_RESOLUTION_UNSUPPORTED');
        expect(secErr.status).toBe(500);
      }
    });

    it('throws FD_RESOLUTION_UNSUPPORTED on non-Linux hosts when default hooks are disabled (fail-closed)', () => {
      const testFile = path.join(workspaceDir, 'fd-host.txt');
      fs.writeFileSync(testFile, 'hello');

      setDefaultFileSecurityHooks(undefined);

      if (process.platform !== 'linux') {
        expect(() =>
          readValidatedFile({
            workspaceRoot: workspaceDir,
            filePath: 'fd-host.txt',
          })
        ).toThrow(FileSecurityError);

        try {
          readValidatedFile({
            workspaceRoot: workspaceDir,
            filePath: 'fd-host.txt',
          });
        } catch (err: unknown) {
          const secErr = asFileSecurityError(err);
          expect(secErr.code).toBe('FD_RESOLUTION_UNSUPPORTED');
          expect(secErr.status).toBe(500);
        }
      }
    });

    it('throws PATH_TRAVERSAL_DETECTED (403) when opened descriptor resolves outside workspace boundary', () => {
      const testFile = path.join(workspaceDir, 'traversal-target.txt');
      fs.writeFileSync(testFile, 'harmless content');

      const outsideFile = path.join(outsideDir, 'secret-opened.txt');
      fs.writeFileSync(outsideFile, 'CRITICAL_SECRET');

      expect(() =>
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'traversal-target.txt',
          hooks: {
            resolveFdPath: () => outsideFile,
          },
        })
      ).toThrow(FileSecurityError);

      try {
        readValidatedFile({
          workspaceRoot: workspaceDir,
          filePath: 'traversal-target.txt',
          hooks: {
            resolveFdPath: () => outsideFile,
          },
        });
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('PATH_TRAVERSAL_DETECTED');
        expect(secErr.status).toBe(403);
        expect(secErr.message).toContain('Opened file descriptor resolves outside workspace boundary');
      }
    });

    it('allows read when resolveFdPath resolves to the canonical workspace path', () => {
      const testFile = path.join(workspaceDir, 'allowed.txt');
      fs.writeFileSync(testFile, 'allowed content');

      const result = readValidatedFile({
        workspaceRoot: workspaceDir,
        filePath: 'allowed.txt',
        hooks: {
          resolveFdPath: (_fd, targetPath) => targetPath ?? null,
        },
      });

      expect(result.filename).toBe('allowed.txt');
      expect(result.content.toString('utf8')).toBe('allowed content');
    });
  });
});
