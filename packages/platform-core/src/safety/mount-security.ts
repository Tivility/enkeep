import crypto from 'node:crypto';
import { ValidationError } from '../errors/index.js';
import type { SpaceMountMode } from '../types/space-mount.js';

export const MOUNT_NAME_SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const VALID_MOUNT_MODES: ReadonlySet<SpaceMountMode> = new Set(['ro', 'rw']);

export const RESERVED_MOUNT_NAMES = new Set([
  '.',
  '..',
  'mnt',
  'home',
  'root',
  'dsh',
  'proc',
  'sys',
  'dev',
  'etc',
  'var',
  'tmp',
  'bin',
  'usr',
  'lib',
]);

/**
 * Validates a mount slug name strictly.
 * Must match ^[a-z0-9][a-z0-9_-]{0,63}$ and not be in reserved names.
 */
export function validateMountName(rawName: unknown): string {
  if (typeof rawName !== 'string' || !rawName.trim()) {
    throw new ValidationError('Mount name must be a non-empty string');
  }
  const trimmed = rawName.trim();
  if (rawName !== trimmed) {
    throw new ValidationError('Mount name must not have leading or trailing whitespace');
  }
  if (!MOUNT_NAME_SLUG_REGEX.test(trimmed)) {
    throw new ValidationError(
      'Mount name must be a strict slug matching pattern ^[a-z0-9][a-z0-9_-]{0,63}$ (lowercase alphanumeric, hyphen, underscore, 1-64 characters)'
    );
  }
  if (RESERVED_MOUNT_NAMES.has(trimmed.toLowerCase())) {
    throw new ValidationError(`Mount name "${trimmed}" is a reserved system name`);
  }
  return trimmed;
}

/**
 * Validates mount mode ('ro' or 'rw').
 */
export function validateMountMode(rawMode: unknown): SpaceMountMode {
  if (rawMode !== 'ro' && rawMode !== 'rw') {
    throw new ValidationError('Mount mode must be either "ro" or "rw"');
  }
  return rawMode;
}

/**
 * Computes a keyed HMAC-SHA256 fingerprint for a mount source path using a platform secret.
 * Format: `hmac-sha256:<hex>`
 */
export function computeMountSourceFingerprint(sourcePath: string, platformSecret: string): string {
  if (!sourcePath || typeof sourcePath !== 'string') {
    throw new Error('sourcePath must be a non-empty string');
  }
  if (!platformSecret || typeof platformSecret !== 'string') {
    throw new Error('platformSecret must be a non-empty string');
  }
  const hmac = crypto.createHmac('sha256', platformSecret).update(sourcePath, 'utf8').digest('hex');
  return `hmac-sha256:${hmac}`;
}
