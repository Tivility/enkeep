/**
 * Backup and Restore Type Definitions
 *
 * @module @enkeep/backup-restore/types
 */

export interface BackupLimits {
  readonly maxFileSize: number;
  readonly maxTotalSize: number;
  readonly maxFileCount: number;
}

export interface BackupFileEntry {
  readonly path: string; // Relative POSIX path, e.g. "platform.db", "sessions/session_1/session.jsonl"
  readonly size: number; // File size in bytes
  readonly sha256: string; // SHA-256 hex digest
  readonly mode: number; // POSIX file permissions mode (e.g. 0o600)
}

export interface SqliteIntegrityReport {
  readonly status: 'ok' | 'error';
  readonly details?: string;
  readonly tables: readonly string[];
  readonly userCount: number;
  readonly spaceCount: number;
  readonly sessionCount: number;
  readonly messageCount: number;
}

export interface DshSessionInventoryItem {
  readonly userId: string;
  readonly sessionId: string;
  readonly dshSessionId?: string;
  readonly relativePath: string;
  readonly lineCount: number;
  readonly sha256: string;
  readonly size: number;
  readonly validJsonl: boolean;
}

export interface BackupManifestSummary {
  readonly totalFiles: number;
  readonly totalBytes: number;
  readonly hasSecrets: boolean;
  readonly encrypted: boolean;
  readonly kdf?: string;
  readonly cipher?: string;
}

export interface BackupManifest {
  readonly formatVersion: number;
  readonly createdAt: string;
  readonly enkeepVersion: string;
  readonly runtimeImage?: string;
  readonly platformSchemaVersion: number;
  readonly migrationChecksums: Readonly<Record<string, string>>;
  readonly sqliteIntegrity: SqliteIntegrityReport;
  readonly dshInventory: readonly DshSessionInventoryItem[];
  readonly files: readonly BackupFileEntry[];
  readonly limits: BackupLimits;
  readonly summary: BackupManifestSummary;
  readonly description?: string;
}

export interface FreezeHooks {
  /**
   * Called before freeze snapshot starts.
   * e.g., pause container, flush DB.
   */
  beforeFreeze?(): Promise<void> | void;

  /**
   * Called after freeze snapshot completes successfully.
   * e.g., resume container.
   */
  afterFreeze?(): Promise<void> | void;

  /**
   * Called if snapshot fails or aborts.
   */
  onAbort?(error: unknown): Promise<void> | void;
}

export interface CreateBackupOptions {
  readonly dataRoot: string;
  readonly outputPath: string;
  readonly passphraseFile?: string;
  readonly allowInsecureUnencrypted?: boolean;
  readonly demoStopConfirmed?: boolean;
  readonly freezeHooks?: FreezeHooks;
  readonly description?: string;
  readonly limits?: Partial<BackupLimits>;
  readonly force?: boolean;
}

export interface CreateBackupResult {
  readonly success: boolean;
  readonly archivePath: string;
  readonly manifest: BackupManifest;
  readonly encrypted: boolean;
  readonly archiveSize: number;
  readonly createdAt: string;
}

export interface InspectBackupOptions {
  readonly archivePath: string;
  readonly passphraseFile?: string;
  readonly json?: boolean;
}

export interface InspectBackupResult {
  readonly archivePath: string;
  readonly encrypted: boolean;
  readonly manifest: BackupManifest;
  readonly archiveSize: number;
  readonly totalFiles: number;
  readonly totalUncompressedBytes: number;
}

export interface VerifyBackupOptions {
  readonly archivePath: string;
  readonly passphraseFile?: string;
  readonly json?: boolean;
  readonly tempDir?: string;
}

export interface VerifyCheckDetail {
  readonly name: string;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly message?: string;
}

export interface VerifyBackupResult {
  readonly verified: boolean;
  readonly archivePath: string;
  readonly manifest: BackupManifest;
  readonly checks: readonly VerifyCheckDetail[];
  readonly recomputedFilesCount: number;
  readonly recomputedTotalBytes: number;
  readonly verifiedAt: string;
}

export interface RestoreBackupOptions {
  readonly archivePath: string;
  readonly targetRoot: string;
  readonly passphraseFile?: string;
  readonly dryRun?: boolean;
  readonly allowRuntimeImageMismatch?: boolean;
  readonly force?: boolean;
  readonly tempDir?: string;
}

export interface RestoreBackupResult {
  readonly success: boolean;
  readonly dryRun: boolean;
  readonly targetRoot: string;
  readonly manifest: BackupManifest;
  readonly restoredFilesCount: number;
  readonly restoredBytes: number;
  readonly postRestoreChecks: readonly VerifyCheckDetail[];
  readonly restoredAt: string;
}
