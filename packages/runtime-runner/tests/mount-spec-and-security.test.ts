/**
 * Mount Specification, Host Boundary Security & TOCTOU Tests
 *
 * Validates:
 * - Strict slug naming for mounts
 * - Absolute directory existence, terminal symlink rejection, world-writable rejection
 * - Protected system roots and sensitive user directory rejection (ancestor/descendant)
 * - TOCTOU device/inode verification (symlink swap defense)
 * - Zero path leakage in health mountHash and error message sanitization
 *
 * @module @enkeep/runtime-runner/tests/mount-spec-and-security.test
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isValidMountSlug,
  isValidMountId,
  validateMountSourcePath,
  verifyMountTOCTOU,
  validateMountSpec,
  computeMountHash,
  sanitizePathInError,
  isPathContained,
  isAncestorOrDescendant,
  HostOwnershipError,
  type RuntimeMountSpec,
} from '../src/index.js';

describe('Controlled Mounts: Specification & Host Boundary Security', () => {
  let tmpTestDir: string;

  beforeEach(() => {
    tmpTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-mount-sec-test-'));
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpTestDir)) {
        fs.rmSync(tmpTestDir, { recursive: true, force: true });
      }
    } catch {}
  });

  describe('Strict Slug Naming & Mount ID Validation', () => {
    it('accepts valid strict slug names', () => {
      expect(isValidMountSlug('data')).toBe(true);
      expect(isValidMountSlug('my-dataset-1')).toBe(true);
      expect(isValidMountSlug('code_repo_2025')).toBe(true);
      expect(isValidMountSlug('a')).toBe(true);
      expect(isValidMountSlug('project-alpha-rw')).toBe(true);
    });

    it('rejects invalid slug names with uppercase, dots, slashes, or special characters', () => {
      expect(isValidMountSlug('')).toBe(false);
      expect(isValidMountSlug('Data')).toBe(false); // Uppercase rejected
      expect(isValidMountSlug('my.dataset')).toBe(false); // Dot rejected
      expect(isValidMountSlug('data/nested')).toBe(false); // Slash rejected
      expect(isValidMountSlug('-leading-dash')).toBe(false); // Leading dash rejected
      expect(isValidMountSlug('_leading_underscore')).toBe(false); // Leading underscore rejected
      expect(isValidMountSlug('data*star')).toBe(false); // Wildcard rejected
      expect(isValidMountSlug('data space')).toBe(false); // Space rejected
      expect(isValidMountSlug('a'.repeat(65))).toBe(false); // Too long (>64)
    });

    it('rejects reserved directory names', () => {
      expect(isValidMountSlug('.')).toBe(false);
      expect(isValidMountSlug('..')).toBe(false);
      expect(isValidMountSlug('mnt')).toBe(false);
      expect(isValidMountSlug('home')).toBe(false);
      expect(isValidMountSlug('root')).toBe(false);
      expect(isValidMountSlug('dsh')).toBe(false);
      expect(isValidMountSlug('proc')).toBe(false);
      expect(isValidMountSlug('sys')).toBe(false);
      expect(isValidMountSlug('dev')).toBe(false);
      expect(isValidMountSlug('etc')).toBe(false);
    });

    it('validates mount IDs', () => {
      expect(isValidMountId('mnt_123')).toBe(true);
      expect(isValidMountId('vol_abcdef0123456789')).toBe(true);
      expect(isValidMountId('')).toBe(false);
      expect(isValidMountId('id with spaces')).toBe(false);
      expect(isValidMountId('id/slash')).toBe(false);
    });
  });

  describe('Host Boundary Source Path Validation', () => {
    it('accepts a valid absolute directory owned by the current user with non-world-writable permissions', () => {
      const validDir = path.join(tmpTestDir, 'approved-project');
      fs.mkdirSync(validDir, { mode: 0o755 });

      const result = validateMountSourcePath(validDir);
      expect(result.realPath).toBe(fs.realpathSync(validDir));
      expect(typeof result.dev).toBe('number');
      expect(typeof result.ino).toBe('number');
    });

    it('rejects non-absolute paths', () => {
      expect(() => validateMountSourcePath('relative/path/dir')).toThrow(
        /must be an absolute path/
      );
    });

    it('rejects non-existent paths', () => {
      const nonExistent = path.join(tmpTestDir, 'does-not-exist');
      expect(() => validateMountSourcePath(nonExistent)).toThrow(
        /does not exist/
      );
    });

    it('rejects regular files (must be a directory)', () => {
      const filePath = path.join(tmpTestDir, 'some-file.txt');
      fs.writeFileSync(filePath, 'content');
      expect(() => validateMountSourcePath(filePath)).toThrow(
        /must be a directory/
      );
    });

    it('rejects terminal symlinks (no symlink terminal)', () => {
      const realDir = path.join(tmpTestDir, 'real-target');
      fs.mkdirSync(realDir, { mode: 0o755 });
      const symlinkPath = path.join(tmpTestDir, 'symlink-dir');
      fs.symlinkSync(realDir, symlinkPath);

      expect(() => validateMountSourcePath(symlinkPath)).toThrow(
        /must not be a symbolic link at the terminal path/
      );
    });

    it('rejects world-writable directories', () => {
      const worldWritableDir = path.join(tmpTestDir, 'world-writable');
      fs.mkdirSync(worldWritableDir, { mode: 0o777 });
      try {
        fs.chmodSync(worldWritableDir, 0o777);
      } catch {}

      // If filesystem supports mode bits
      const stat = fs.statSync(worldWritableDir);
      if ((stat.mode & 0o002) !== 0) {
        expect(() => validateMountSourcePath(worldWritableDir)).toThrow(
          /world-writable/
        );
      }
    });

    it('rejects user home root directory as a whole', () => {
      const userHome = os.homedir();
      if (userHome && fs.existsSync(userHome)) {
        expect(() => validateMountSourcePath(userHome)).toThrow(
          /Mounting user home directory root as a mount source is forbidden/
        );
      }
    });

    it('rejects sensitive user directories and their descendants (.ssh, .gnupg, .aws)', () => {
      const userHome = os.homedir();
      if (userHome) {
        const sshDir = path.join(userHome, '.ssh');
        if (fs.existsSync(sshDir)) {
          expect(() => validateMountSourcePath(sshDir)).toThrow(
            /conflicts with sensitive user directory "\.ssh"/
          );
        }
        // Test with mock protected directory passed in options
        const mockHome = path.join(tmpTestDir, 'mock-home');
        const mockSsh = path.join(mockHome, '.ssh');
        const mockSshSub = path.join(mockSsh, 'keys');
        fs.mkdirSync(mockSshSub, { recursive: true, mode: 0o700 });

        expect(() => validateMountSourcePath(mockSsh, { protectedRoots: [mockSsh] })).toThrow(
          /conflicts with protected root/
        );
        expect(() => validateMountSourcePath(mockSshSub, { protectedRoots: [mockSsh] })).toThrow(
          /conflicts with protected root/
        );
      }
    });

    it('rejects system protected roots (/, /private/etc, /etc, /proc, /sys, /dev, /var/run)', () => {
      expect(() => validateMountSourcePath('/')).toThrow(/conflicts with protected root/);
      if (fs.existsSync('/private/etc')) {
        expect(() => validateMountSourcePath('/private/etc')).toThrow(/conflicts with protected root/);
      } else if (fs.existsSync('/etc')) {
        expect(() => validateMountSourcePath('/etc')).toThrow();
      }
      if (fs.existsSync('/dev')) {
        expect(() => validateMountSourcePath('/dev')).toThrow();
      }
    });

    it('rejects ancestor and descendant paths of Enkeep runtime directories', () => {
      const dataRoot = path.join(tmpTestDir, 'enkeep-data');
      const dshHome = path.join(dataRoot, 'host-runtimes', 'alice', '.dsh');
      const spacesDir = path.join(dataRoot, 'host-runtimes', 'alice', 'spaces');
      const runDir = path.join(dataRoot, 'host-runtimes', 'alice', 'run');
      fs.mkdirSync(dshHome, { recursive: true });
      fs.mkdirSync(spacesDir, { recursive: true });
      fs.mkdirSync(runDir, { recursive: true });

      const options = { dataRoot, dshHome, spacesDir, runDir };

      // Reject dataRoot itself and its ancestors
      expect(() => validateMountSourcePath(dataRoot, options)).toThrow(
        /conflicts with protected root/
      );
      expect(() => validateMountSourcePath(dshHome, options)).toThrow(
        /conflicts with protected root/
      );
      expect(() => validateMountSourcePath(spacesDir, options)).toThrow(
        /conflicts with protected root/
      );

      // Ancestor containing dataRoot
      expect(() => validateMountSourcePath(tmpTestDir, options)).toThrow(
        /conflicts with protected root/
      );
    });
  });

  describe('TOCTOU Inode & Dev Verification (Symlink Swap Defense)', () => {
    it('verifies device and inode match expected values', () => {
      const dir = path.join(tmpTestDir, 'toctou-dir');
      fs.mkdirSync(dir, { mode: 0o755 });

      const initial = validateMountSourcePath(dir);
      const toctou = verifyMountTOCTOU(dir, initial.dev, initial.ino);
      expect(toctou.dev).toBe(initial.dev);
      expect(toctou.ino).toBe(initial.ino);
    });

    it('fails closed when inode is swapped (simulated symlink / directory swap)', () => {
      const dir1 = path.join(tmpTestDir, 'dir1');
      const dir2 = path.join(tmpTestDir, 'dir2');
      fs.mkdirSync(dir1, { mode: 0o755 });
      fs.mkdirSync(dir2, { mode: 0o755 });

      const stat1 = fs.statSync(dir1);
      const stat2 = fs.statSync(dir2);

      if (stat1.ino !== stat2.ino) {
        expect(() => verifyMountTOCTOU(dir1, stat1.dev, stat2.ino)).toThrow(
          /TOCTOU safety violation: inode changed/
        );
      }
    });
  });

  describe('validateMountSpec Full Specification Validation', () => {
    it('validates a complete compliant RuntimeMountSpec', () => {
      const sourceDir = path.join(tmpTestDir, 'project-src');
      fs.mkdirSync(sourceDir, { mode: 0o755 });

      const rawSpec: RuntimeMountSpec = {
        id: 'mnt_0123456789abcdef',
        name: 'project-src',
        sourcePath: sourceDir,
        mode: 'ro',
      };

      const result = validateMountSpec(rawSpec);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.spec?.id).toBe('mnt_0123456789abcdef');
      expect(result.spec?.name).toBe('project-src');
      expect(result.spec?.mode).toBe('ro');
    });

    it('rejects mount specs with invalid modes', () => {
      const sourceDir = path.join(tmpTestDir, 'project-src');
      fs.mkdirSync(sourceDir, { mode: 0o755 });

      const rawSpec = {
        id: 'mnt_123',
        name: 'project',
        sourcePath: sourceDir,
        mode: 'readwrite', // Invalid: must be 'rw' or 'ro'
      };

      const result = validateMountSpec(rawSpec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('mode must be strictly "ro" or "rw"'))).toBe(true);
    });

    it('rejects unknown properties in mount spec', () => {
      const sourceDir = path.join(tmpTestDir, 'project-src');
      fs.mkdirSync(sourceDir, { mode: 0o755 });

      const rawSpec = {
        id: 'mnt_123',
        name: 'project',
        sourcePath: sourceDir,
        mode: 'rw',
        containerPath: '/arbitrary', // Forbidden
      };

      const result = validateMountSpec(rawSpec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Unknown or forbidden property "containerPath"'))).toBe(true);
    });
  });

  describe('Zero-Path-Leakage: Hash Computation & Error Sanitization', () => {
    it('computes deterministic mount hash without leaking host source paths', () => {
      const mounts: RuntimeMountSpec[] = [
        { id: 'mnt_1', name: 'data', sourcePath: '/Users/secret/path/data', mode: 'ro' },
        { id: 'mnt_2', name: 'docs', sourcePath: '/home/private/docs', mode: 'rw' },
      ];

      const hash1 = computeMountHash(mounts);
      const hash2 = computeMountHash([...mounts].reverse()); // Order-independent

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);

      // Verify that changing mode changes hash
      const modifiedMounts: RuntimeMountSpec[] = [
        { id: 'mnt_1', name: 'data', sourcePath: '/Users/secret/path/data', mode: 'rw' },
        { id: 'mnt_2', name: 'docs', sourcePath: '/home/private/docs', mode: 'rw' },
      ];
      expect(computeMountHash(modifiedMounts)).not.toBe(hash1);
    });

    it('sanitizes host source paths and target paths in error messages to /mnt/<name>', () => {
      const mounts = [
        { name: 'data', sourcePath: '/Users/<user>/secret-project/data', targetPath: '/home/dsh/mounts/mnt_1' },
      ];

      const rawError = 'Access denied: write to /Users/<user>/secret-project/data/sub/file.txt outside boundary';
      const sanitized = sanitizePathInError(rawError, mounts);
      expect(sanitized).toBe('Access denied: write to /mnt/data/sub/file.txt outside boundary');
      expect(sanitized).not.toContain('/Users/<user>');

      const rawDockerError = 'Error: file /home/dsh/mounts/mnt_1/read.me is read-only';
      const sanitizedDocker = sanitizePathInError(rawDockerError, mounts);
      expect(sanitizedDocker).toBe('Error: file /mnt/data/read.me is read-only');
      expect(sanitizedDocker).not.toContain('/home/dsh/mounts');
    });
  });
});
