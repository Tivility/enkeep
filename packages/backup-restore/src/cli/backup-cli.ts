#!/usr/bin/env node
/**
 * Enkeep Backup CLI (`enkeep-backup`)
 *
 * Commands:
 *   enkeep-backup create --data-root <path> --output <archive-path> [--passphrase-file <path>] [--demo-stop-confirmed] [--force]
 *   enkeep-backup inspect --archive <archive-path> [--passphrase-file <path>] [--json]
 *   enkeep-backup verify --archive <archive-path> [--passphrase-file <path>] [--json]
 *   enkeep-backup restore --archive <archive-path> --target-root <path> [--passphrase-file <path>] [--dry-run] [--allow-runtime-image-mismatch] [--force]
 *
 * @module @enkeep/backup-restore/cli/backup-cli
 */

import { resolve } from 'node:path';
import { createBackup } from '../operations/create.js';
import { inspectBackup } from '../operations/inspect.js';
import { verifyBackup } from '../operations/verify.js';
import { restoreBackup } from '../operations/restore.js';
import { formatManifestSummary } from '../manifest/inspector.js';

interface ParsedArgs {
  command?: string;
  dataRoot?: string;
  outputPath?: string;
  archivePath?: string;
  targetRoot?: string;
  passphraseFile?: string;
  allowInsecureUnencrypted?: boolean;
  demoStopConfirmed?: boolean;
  dryRun?: boolean;
  allowRuntimeImageMismatch?: boolean;
  force?: boolean;
  json?: boolean;
  help?: boolean;
  description?: string;
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const parsed: ParsedArgs = {};

  if (args.length === 0) {
    parsed.help = true;
    return parsed;
  }

  const first = args[0];
  if (first && !first.startsWith('-')) {
    parsed.command = first;
  }

  for (let i = parsed.command ? 1 : 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--force' || arg === '-f') {
      parsed.force = true;
    } else if (arg === '--demo-stop-confirmed') {
      parsed.demoStopConfirmed = true;
    } else if (arg === '--allow-insecure-unencrypted') {
      parsed.allowInsecureUnencrypted = true;
    } else if (arg === '--allow-runtime-image-mismatch') {
      parsed.allowRuntimeImageMismatch = true;
    } else if (arg === '--data-root') {
      parsed.dataRoot = args[++i];
    } else if (arg === '--output' || arg === '-o') {
      parsed.outputPath = args[++i];
    } else if (arg === '--archive' || arg === '-a') {
      parsed.archivePath = args[++i];
    } else if (arg === '--target-root' || arg === '-t') {
      parsed.targetRoot = args[++i];
    } else if (arg === '--passphrase-file' || arg === '-p') {
      parsed.passphraseFile = args[++i];
    } else if (arg === '--description') {
      parsed.description = args[++i];
    }
  }

  return parsed;
}

function printUsage(): void {
  console.log(`
Enkeep Enterprise Backup & Restore CLI (enkeep-backup)

USAGE:
  enkeep-backup create --data-root <path> --output <archive-path> [options]
  enkeep-backup inspect --archive <archive-path> [options]
  enkeep-backup verify --archive <archive-path> [options]
  enkeep-backup restore --archive <archive-path> --target-root <path> [options]

COMMANDS:
  create   Creates a consistent, encrypted backup snapshot of SQLite and volumes.
  inspect  Reads and displays the manifest metadata from a backup archive.
  verify   Independently decrypts and validates archive hashes, schemas, and SQLite integrity.
  restore  Safely restores a backup archive into a target root directory.

OPTIONS:
  --data-root <path>                 Source data root directory to back up (required for create).
  --output, -o <archive-path>        Output archive file path (required for create).
  --archive, -a <archive-path>       Backup archive file path (required for inspect/verify/restore).
  --target-root, -t <path>           Destination target root directory (required for restore).
  --passphrase-file, -p <path>       File containing encryption/decryption passphrase.
  --demo-stop-confirmed              Confirm that live background containers/services are stopped.
  --dry-run                          Simulate restore in memory/sandbox without writing to target.
  --allow-runtime-image-mismatch     Permit restore when current runtime image differs from archive.
  --allow-insecure-unencrypted       Explicit opt-in to disable AES-256-GCM encryption.
  --description <text>               Optional human description recorded in the manifest.
  --force, -f                        Overwrite existing output archive or empty non-empty target.
  --json                             Output machine-readable JSON.
  --help, -h                         Show this help message.
`);
}

export async function runBackupCli(argv: string[] = process.argv): Promise<number> {
  const args = parseCliArgs(argv);

  if (args.help || !args.command) {
    printUsage();
    return 0;
  }

  try {
    switch (args.command) {
      case 'create': {
        if (!args.dataRoot) {
          console.error('Error: --data-root <path> is required for "create"');
          return 2;
        }
        if (!args.outputPath) {
          console.error('Error: --output <archive-path> is required for "create"');
          return 2;
        }

        const result = await createBackup({
          dataRoot: resolve(args.dataRoot),
          outputPath: resolve(args.outputPath),
          passphraseFile: args.passphraseFile,
          allowInsecureUnencrypted: args.allowInsecureUnencrypted,
          demoStopConfirmed: args.demoStopConfirmed,
          description: args.description,
          force: args.force,
        });

        if (args.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`✅ Backup created successfully: ${result.archivePath}`);
          console.log(`   Encrypted: ${result.encrypted ? 'AES-256-GCM + scrypt' : 'Plain'}`);
          console.log(`   Size: ${(result.archiveSize / 1024 / 1024).toFixed(2)} MiB (${result.archiveSize.toLocaleString()} bytes)`);
          console.log(`   Files: ${result.manifest.files.length}`);
        }
        return 0;
      }

      case 'inspect': {
        if (!args.archivePath) {
          console.error('Error: --archive <archive-path> is required for "inspect"');
          return 2;
        }

        const result = await inspectBackup({
          archivePath: resolve(args.archivePath),
          passphraseFile: args.passphraseFile,
          json: args.json,
        });

        if (args.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatManifestSummary(result.manifest, result.archiveSize));
        }
        return 0;
      }

      case 'verify': {
        if (!args.archivePath) {
          console.error('Error: --archive <archive-path> is required for "verify"');
          return 2;
        }

        const result = await verifyBackup({
          archivePath: resolve(args.archivePath),
          passphraseFile: args.passphraseFile,
          json: args.json,
        });

        if (args.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`🔍 Backup Archive Verification: ${result.archivePath}`);
          console.log('─────────────────────────────────────────────────────────────────');
          for (const check of result.checks) {
            console.log(`  [✓] ${check.name}: ${check.message}`);
          }
          console.log('─────────────────────────────────────────────────────────────────');
          console.log(`✅ Verification Passed: ${result.recomputedFilesCount} files, ${(result.recomputedTotalBytes / 1024 / 1024).toFixed(2)} MiB validated.`);
        }
        return 0;
      }

      case 'restore': {
        if (!args.archivePath) {
          console.error('Error: --archive <archive-path> is required for "restore"');
          return 2;
        }
        if (!args.targetRoot) {
          console.error('Error: --target-root <path> is required for "restore"');
          return 2;
        }

        const result = await restoreBackup({
          archivePath: resolve(args.archivePath),
          targetRoot: resolve(args.targetRoot),
          passphraseFile: args.passphraseFile,
          dryRun: args.dryRun,
          allowRuntimeImageMismatch: args.allowRuntimeImageMismatch,
          force: args.force,
        });

        if (args.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          if (result.dryRun) {
            console.log(`🔎 Dry-run restore simulated successfully (0 bytes written to disk)`);
          } else {
            console.log(`✅ Backup restored successfully to: ${result.targetRoot}`);
          }
          console.log(`   Restored files: ${result.restoredFilesCount}`);
          console.log(`   Restored bytes: ${(result.restoredBytes / 1024 / 1024).toFixed(2)} MiB`);
          for (const check of result.postRestoreChecks) {
            console.log(`   - ${check.name}: ${check.message}`);
          }
        }
        return 0;
      }

      default: {
        console.error(`Unknown command: "${args.command}"`);
        printUsage();
        return 2;
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (args.json) {
      console.error(JSON.stringify({ success: false, error: errorMsg }, null, 2));
    } else {
      console.error(`❌ Error: ${errorMsg}`);
    }
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBackupCli(process.argv).then((code) => {
    process.exit(code);
  });
}
