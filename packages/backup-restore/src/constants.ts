/**
 * Backup and Restore Core Constants & Safety Boundaries
 *
 * @module @enkeep/backup-restore/constants
 */

export const BACKUP_FORMAT_VERSION = 1 as const;
export const BACKUP_MAGIC_BYTES = 'ENKPBKP1' as const; // 8 ASCII bytes magic header
export const BACKUP_CONTAINER_VERSION = 1 as const;

export const MANIFEST_FILE_NAME = 'backup-manifest.json' as const;
export const DATABASE_FILE_NAME = 'platform.db' as const;
export const SECRETS_FILE_NAME = 'secrets.json' as const;

/**
 * Default resource safety limits for defense against ZipBombs, memory exhaustion, and DOS.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxFileSize: 1024 * 1024 * 1024, // 1 GiB per individual file
  maxTotalSize: 10 * 1024 * 1024 * 1024, // 10 GiB total uncompressed payload
  maxFileCount: 100_000, // 100,000 files maximum
  tarListingBufferLimit: 64 * 1024 * 1024, // 64 MiB
});

/**
 * Standard crypto parameters for AES-256-GCM + scrypt KDF.
 */
export const CRYPTO_PARAMS = Object.freeze({
  kdf: 'scrypt' as const,
  cipher: 'aes-256-gcm' as const,
  saltBytes: 32,
  ivBytes: 12,
  tagBytes: 16,
  keyBytes: 32,
  scryptN: 32768, // CPU/memory cost parameter (2^15)
  scryptR: 8, // Block size
  scryptP: 1, // Parallelization
  scryptMaxmem: 64 * 1024 * 1024, // 64 MiB max memory for scrypt
});

/**
 * Standard hardened permissions for restored data files and directories.
 */
export const PERMISSIONS = Object.freeze({
  dirMode: 0o700,
  sensitiveFileMode: 0o600,
  standardFileMode: 0o600,
});

/**
 * Transient directories and files strictly excluded from backups.
 */
export const EXCLUDED_TRANSIENT_ENTRIES = Object.freeze([
  'pids',
  'containers',
  'platform.db-wal',
  'platform.db-shm',
  'platform.db-journal',
  'streaming-buffer',
  'logs',
  'ipc',
  '.tmp',
]);

/**
 * Components recognized by Enkeep data root.
 */
export const MANAGED_BACKUP_COMPONENTS = Object.freeze([
  'platform.db',
  'secrets.json',
  'spaces',
  'sessions',
  'volumes',
  'import',
  'config',
]);
