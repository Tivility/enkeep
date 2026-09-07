import { describe, it, expect } from 'vitest';
import {
  validateMountName,
  validateMountMode,
  computeMountSourceFingerprint,
  MOUNT_NAME_SLUG_REGEX,
  VALID_MOUNT_MODES,
  RESERVED_MOUNT_NAMES,
  ValidationError,
} from '../src/index.js';

describe('platform-core pure mount-security', () => {
  it('validates mount slug names strictly', () => {
    expect(validateMountName('dataset')).toBe('dataset');
    expect(validateMountName('my_project_1')).toBe('my_project_1');
    expect(validateMountName('data-share-2026')).toBe('data-share-2026');

    // Rejects empty / whitespace
    expect(() => validateMountName('')).toThrow(ValidationError);
    expect(() => validateMountName('  ')).toThrow(ValidationError);
    expect(() => validateMountName(' dataset ')).toThrow(ValidationError);

    // Rejects uppercase and invalid characters
    expect(() => validateMountName('Dataset')).toThrow(ValidationError);
    expect(() => validateMountName('data.set')).toThrow(ValidationError);
    expect(() => validateMountName('data/set')).toThrow(ValidationError);
    expect(() => validateMountName('data@set')).toThrow(ValidationError);

    // Rejects reserved names
    for (const resName of RESERVED_MOUNT_NAMES) {
      expect(() => validateMountName(resName)).toThrow(ValidationError);
    }
  });

  it('validates mount mode strictly', () => {
    expect(validateMountMode('ro')).toBe('ro');
    expect(validateMountMode('rw')).toBe('rw');

    expect(() => validateMountMode('read')).toThrow(ValidationError);
    expect(() => validateMountMode('write')).toThrow(ValidationError);
    expect(() => validateMountMode('')).toThrow(ValidationError);
    expect(() => validateMountMode(null)).toThrow(ValidationError);
  });

  it('computes HMAC-SHA256 fingerprint deterministically without fs/path dependencies', () => {
    const secret = 'test-platform-secret-32-chars-long';
    const path1 = '/home/user/project';
    const fp1 = computeMountSourceFingerprint(path1, secret);
    expect(fp1).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);

    const fp2 = computeMountSourceFingerprint(path1, secret);
    expect(fp1).toBe(fp2);

    const fp3 = computeMountSourceFingerprint('/other/path', secret);
    expect(fp1).not.toBe(fp3);

    expect(() => computeMountSourceFingerprint('', secret)).toThrow();
    expect(() => computeMountSourceFingerprint(path1, '')).toThrow();
  });
});
