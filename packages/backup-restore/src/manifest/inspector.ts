/**
 * Manifest Inspector & Validator
 *
 * @module @enkeep/backup-restore/manifest/inspector
 */

import { BACKUP_FORMAT_VERSION } from '../constants.js';
import { BackupManifestError } from '../errors.js';
import type { BackupManifest } from '../types.js';

/**
 * Validates that a parsed JSON object adheres strictly to the BackupManifest schema.
 */
export function validateBackupManifest(raw: unknown): BackupManifest {
  if (!raw || typeof raw !== 'object') {
    throw new BackupManifestError('Manifest must be a non-null object');
  }

  const manifest = raw as Partial<BackupManifest>;

  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new BackupManifestError(
      `Unsupported backup manifest formatVersion: ${manifest.formatVersion} (expected ${BACKUP_FORMAT_VERSION})`
    );
  }

  if (!manifest.createdAt || typeof manifest.createdAt !== 'string') {
    throw new BackupManifestError('Manifest missing or invalid createdAt field');
  }

  if (typeof manifest.platformSchemaVersion !== 'number') {
    throw new BackupManifestError('Manifest missing or invalid platformSchemaVersion field');
  }

  if (!manifest.migrationChecksums || typeof manifest.migrationChecksums !== 'object') {
    throw new BackupManifestError('Manifest missing migrationChecksums map');
  }

  if (!manifest.sqliteIntegrity || typeof manifest.sqliteIntegrity !== 'object') {
    throw new BackupManifestError('Manifest missing sqliteIntegrity section');
  }

  if (!Array.isArray(manifest.files)) {
    throw new BackupManifestError('Manifest missing files array');
  }

  if (!Array.isArray(manifest.dshInventory)) {
    throw new BackupManifestError('Manifest missing dshInventory array');
  }

  if (!manifest.summary || typeof manifest.summary !== 'object') {
    throw new BackupManifestError('Manifest missing summary section');
  }

  return manifest as BackupManifest;
}

/**
 * Formats a human-readable text summary of a BackupManifest for CLI display.
 */
export function formatManifestSummary(manifest: BackupManifest, archiveSize?: number): string {
  const lines: string[] = [];

  lines.push('📦 Enkeep Backup Archive Information');
  lines.push('─────────────────────────────────────────────────────────────────');
  lines.push(`Format Version:          v${manifest.formatVersion}`);
  lines.push(`Created At:              ${manifest.createdAt}`);
  lines.push(`Enkeep Version:          ${manifest.enkeepVersion}`);
  lines.push(`Runtime Image:           ${manifest.runtimeImage ?? 'unspecified'}`);
  lines.push(`Platform Schema Version: v${manifest.platformSchemaVersion}`);
  lines.push(`Encrypted:               ${manifest.summary.encrypted ? `Yes (${manifest.summary.cipher} + ${manifest.summary.kdf})` : 'No (Plain)'}`);
  lines.push(`Has Secrets:             ${manifest.summary.hasSecrets ? 'Yes (secrets.json included)' : 'No'}`);
  if (archiveSize !== undefined) {
    lines.push(`Archive Compressed Size: ${(archiveSize / 1024 / 1024).toFixed(2)} MiB (${archiveSize.toLocaleString()} bytes)`);
  }
  lines.push(`Total Uncompressed Size: ${(manifest.summary.totalBytes / 1024 / 1024).toFixed(2)} MiB (${manifest.summary.totalBytes.toLocaleString()} bytes)`);
  lines.push(`Total Files:             ${manifest.summary.totalFiles}`);

  lines.push('');
  lines.push('🗄️  SQLite Database Summary:');
  lines.push(`  Integrity Status:      ${manifest.sqliteIntegrity.status}`);
  lines.push(`  Users:                 ${manifest.sqliteIntegrity.userCount}`);
  lines.push(`  Spaces:                ${manifest.sqliteIntegrity.spaceCount}`);
  lines.push(`  Sessions:              ${manifest.sqliteIntegrity.sessionCount}`);
  lines.push(`  Messages:              ${manifest.sqliteIntegrity.messageCount}`);
  lines.push(`  Tables:                ${manifest.sqliteIntegrity.tables.join(', ') || 'none'}`);
  lines.push(`  Applied Migrations:    ${Object.keys(manifest.migrationChecksums).length} migrations`);

  lines.push('');
  lines.push('🧠 DSH Session JSONL Inventory:');
  lines.push(`  Total Sessions:        ${manifest.dshInventory.length}`);
  for (const item of manifest.dshInventory.slice(0, 5)) {
    lines.push(`  - [${item.userId}] ${item.relativePath} (${item.lineCount} lines, valid JSONL: ${item.validJsonl})`);
  }
  if (manifest.dshInventory.length > 5) {
    lines.push(`  ... and ${manifest.dshInventory.length - 5} more sessions`);
  }

  if (manifest.description) {
    lines.push('');
    lines.push(`Description:             ${manifest.description}`);
  }
  lines.push('─────────────────────────────────────────────────────────────────');

  return lines.join('\n');
}
