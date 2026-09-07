/**
 * Backup and Restore Error Definitions
 *
 * @module @enkeep/backup-restore/errors
 */

export class BackupError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, code: string = 'BACKUP_ERROR', details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class BackupQuiesceError extends BackupError {
  constructor(message: string, details?: unknown) {
    super(message, 'BACKUP_QUIESCE_ERROR', details);
  }
}

export class BackupPathSafetyError extends BackupError {
  constructor(message: string, details?: unknown) {
    super(message, 'BACKUP_PATH_SAFETY_ERROR', details);
  }
}

export class BackupEncryptionError extends BackupError {
  constructor(message: string, details?: unknown) {
    super(message, 'BACKUP_ENCRYPTION_ERROR', details);
  }
}

export class BackupIntegrityError extends BackupError {
  constructor(message: string, details?: unknown) {
    super(message, 'BACKUP_INTEGRITY_ERROR', details);
  }
}

export class BackupManifestError extends BackupError {
  constructor(message: string, details?: unknown) {
    super(message, 'BACKUP_MANIFEST_ERROR', details);
  }
}

export class BackupArchiveError extends BackupError {
  constructor(message: string, details?: unknown) {
    super(message, 'BACKUP_ARCHIVE_ERROR', details);
  }
}

export class BackupVersionMismatchError extends BackupError {
  constructor(message: string, details?: unknown) {
    super(message, 'BACKUP_VERSION_MISMATCH_ERROR', details);
  }
}

export class BackupRestoreSafetyError extends BackupError {
  constructor(message: string, details?: unknown) {
    super(message, 'BACKUP_RESTORE_SAFETY_ERROR', details);
  }
}
