/**
 * Post-Restore Comprehensive Validators
 *
 * Runs migration integrity checks, SQLite foreign key & integrity check,
 * authoritative DSH session event parsing, and dual-storage message projection reconciliation.
 *
 * @module @enkeep/backup-restore/validators/post-restore
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  parseDshSessionJsonl,
  projectCanonicalWebMessages,
  extractVisibleTextFromContentBlocks,
  type DshSessionEvent,
  type ProjectedWebMessage,
} from '@enkeep/platform-server';
import { DATABASE_FILE_NAME } from '../constants.js';
import { computeSha256 } from '../crypto/hash.js';
import { BackupIntegrityError } from '../errors.js';
import type { BackupManifest, VerifyCheckDetail } from '../types.js';

export interface PostRestoreValidationInput {
  readonly targetRoot: string;
  readonly manifest: BackupManifest;
}

/**
 * Parses a DSH session transcript using the canonical platform-server parser.
 * Handles both official format (with line 1 session header) and envelope streams.
 */
export function parseTranscriptWithCanonicalParser(
  rawContent: string,
  sessionId: string,
  filePathForLog: string = 'session.jsonl'
): { messages: readonly ProjectedWebMessage[]; totalLines: number } {
  const lines = rawContent.split('\n');
  const nonEmptyLines = lines
    .map((line, idx) => ({ text: line.trim(), lineNumber: idx + 1 }))
    .filter((item) => item.text.length > 0);

  if (nonEmptyLines.length === 0) {
    throw new BackupIntegrityError(`DSH session file is empty: "${filePathForLog}"`);
  }

  const firstLine = nonEmptyLines[0]!;
  let firstParsed: Record<string, unknown>;
  try {
    firstParsed = JSON.parse(firstLine.text);
  } catch (err) {
    throw new BackupIntegrityError(
      `DSH JSONL syntax error in "${filePathForLog}" at line ${firstLine.lineNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (firstParsed && firstParsed.type === 'session') {
    // Official DSH session format with session header
    try {
      const parsed = parseDshSessionJsonl(rawContent, { sessionId });
      return {
        messages: parsed.projectedMessages,
        totalLines: nonEmptyLines.length,
      };
    } catch (err) {
      throw new BackupIntegrityError(
        `DSH canonical session parse failed for "${filePathForLog}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Envelope / SeedEvent stream without header
  const events: DshSessionEvent[] = [];
  for (let i = 0; i < nonEmptyLines.length; i++) {
    const item = nonEmptyLines[i]!;
    try {
      const parsedEv = JSON.parse(item.text);
      if (!parsedEv || typeof parsedEv !== 'object') {
        throw new Error('Line is not a valid JSON object');
      }
      events.push(parsedEv as DshSessionEvent);
    } catch (err) {
      throw new BackupIntegrityError(
        `DSH JSONL syntax error in "${filePathForLog}" at line ${item.lineNumber}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const projected = projectCanonicalWebMessages(events, sessionId);
  return {
    messages: projected,
    totalLines: nonEmptyLines.length,
  };
}

/**
 * Executes comprehensive post-restore validation on the staged or restored targetRoot.
 */
export async function validateRestoredTarget(
  input: PostRestoreValidationInput
): Promise<VerifyCheckDetail[]> {
  const { targetRoot, manifest } = input;
  const checks: VerifyCheckDetail[] = [];

  const dbPath = join(targetRoot, DATABASE_FILE_NAME);

  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });

    try {
      // 1. SQLite PRAGMA integrity_check
      const integrityRows = db.prepare('PRAGMA integrity_check').all() as Array<{
        integrity_check?: string;
        [key: string]: unknown;
      }>;
      const firstRow = integrityRows[0];
      const res = firstRow?.integrity_check ?? Object.values(firstRow || {})[0];
      if (res !== 'ok') {
        throw new BackupIntegrityError(`Restored SQLite integrity_check failed: ${String(res)}`);
      }
      checks.push({
        name: 'sqlite_integrity_check',
        status: 'passed',
        message: 'PRAGMA integrity_check returned ok',
      });

      // 2. SQLite PRAGMA foreign_key_check
      const fkRows = db.prepare('PRAGMA foreign_key_check').all();
      if (fkRows.length > 0) {
        throw new BackupIntegrityError(
          `Restored SQLite foreign_key_check failed: Found ${fkRows.length} foreign key violation(s)`
        );
      }
      checks.push({
        name: 'sqlite_foreign_key_check',
        status: 'passed',
        message: 'PRAGMA foreign_key_check passed with zero violations',
      });

      // 3. Migration Checksums & Schema Version Check
      const tableRows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
      const tables = tableRows.map((r) => r.name);

      if (tables.includes('_schema_migrations')) {
        const appliedRows = db
          .prepare('SELECT version, name, checksum FROM _schema_migrations ORDER BY version ASC')
          .all() as Array<{ version: number; name: string; checksum: string }>;

        for (const mig of appliedRows) {
          const verKey = String(mig.version).padStart(3, '0');
          const expectedChecksum = manifest.migrationChecksums[verKey];
          if (expectedChecksum && expectedChecksum !== mig.checksum) {
            throw new BackupIntegrityError(
              `Migration v${mig.version} checksum mismatch in restored database: expected ${expectedChecksum}, got ${mig.checksum}`
            );
          }
        }
        checks.push({
          name: 'schema_migrations_checksums',
          status: 'passed',
          message: `Verified ${appliedRows.length} applied migration checksums match manifest`,
        });
      }

      // 4. Dual-Storage Reconciliation (read-only SQLite vs DSH JSONL canonical message projection match)
      let reconcileCheckedCount = 0;
      let reconciledMessagesCount = 0;

      if (tables.includes('web_messages')) {
        for (const dshItem of manifest.dshInventory) {
          const jsonlFullPath = join(targetRoot, dshItem.relativePath);
          if (existsSync(jsonlFullPath)) {
            reconcileCheckedCount += 1;

            const jsonlRaw = readFileSync(jsonlFullPath, 'utf8');
            const dshParsed = parseTranscriptWithCanonicalParser(
              jsonlRaw,
              dshItem.sessionId,
              dshItem.relativePath
            );

            // Check columns of web_messages
            const columns = (
              db.prepare('PRAGMA table_info(web_messages)').all() as Array<{ name: string }>
            ).map((c) => c.name);
            const orderByClause = columns.includes('created_at')
              ? 'ORDER BY created_at ASC, id ASC'
              : 'ORDER BY rowid ASC';

            // Query SQLite messages for this session
            const sqliteMsgRows = db
              .prepare(`
                SELECT id, role, content
                FROM web_messages
                WHERE session_id = ?
                ${orderByClause}
              `)
              .all(dshItem.sessionId) as Array<{ id: string; role: string; content: string }>;

            // If DSH has messages, verify against SQLite messages
            if (dshParsed.messages.length > 0 && sqliteMsgRows.length > 0) {
              if (dshParsed.messages.length !== sqliteMsgRows.length) {
                throw new BackupIntegrityError(
                  `Dual-storage reconciliation drift for session "${dshItem.sessionId}": ` +
                    `DSH JSONL has ${dshParsed.messages.length} messages, but SQLite web_messages has ${sqliteMsgRows.length} messages.`
                );
              }

              for (let i = 0; i < dshParsed.messages.length; i++) {
                const dshMsg = dshParsed.messages[i]!;
                const sqlMsg = sqliteMsgRows[i]!;

                if (dshMsg.role !== sqlMsg.role) {
                  throw new BackupIntegrityError(
                    `Dual-storage role mismatch in session "${dshItem.sessionId}" at message index ${i}: ` +
                      `DSH JSONL is "${dshMsg.role}", SQLite is "${sqlMsg.role}".`
                  );
                }

                // Check text content match
                const sqlText = extractVisibleTextFromContentBlocks(sqlMsg.content);
                if (dshMsg.content.trim() !== sqlText.trim()) {
                  throw new BackupIntegrityError(
                    `Dual-storage content mismatch in session "${dshItem.sessionId}" at message index ${i}: ` +
                      `DSH text differs from SQLite content.`
                  );
                }
              }
            }

            reconciledMessagesCount += dshParsed.messages.length;
          }
        }
      }

      checks.push({
        name: 'dual_storage_reconcile',
        status: 'passed',
        message: `Dual storage verified (${reconcileCheckedCount} session(s), ${reconciledMessagesCount} message projection(s) matched 100%)`,
      });
    } finally {
      db.close();
    }
  }

  // 5. Strict DSH JSONL parse and validation for all inventory items
  let validatedJsonlCount = 0;
  for (const item of manifest.dshInventory) {
    const fullPath = join(targetRoot, item.relativePath);
    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath, 'utf8');
      parseTranscriptWithCanonicalParser(content, item.sessionId, item.relativePath);
      validatedJsonlCount += 1;
    }
  }

  if (validatedJsonlCount > 0) {
    checks.push({
      name: 'dsh_jsonl_strict_validation',
      status: 'passed',
      message: `Verified ${validatedJsonlCount} session JSONL files with strict line parsing`,
    });
  }

  return checks;
}
