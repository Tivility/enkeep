#!/usr/bin/env node
/**
 * Enkeep Restore CLI (`enkeep-restore`)
 *
 * Usage:
 *   enkeep-restore --archive <archive-path> --target-root <path> [--passphrase-file <path>] [--dry-run] [--allow-runtime-image-mismatch] [--force]
 *
 * @module @enkeep/backup-restore/cli/restore-cli
 */

import { runBackupCli } from './backup-cli.js';

export async function runRestoreCli(argv: string[] = process.argv): Promise<number> {
  const args = argv.slice(2);
  // If first arg is not a command, prepend 'restore'
  if (args.length > 0 && !args[0]!.startsWith('-') && args[0] !== 'restore') {
    return runBackupCli(argv);
  }
  const forwardedArgv = [argv[0]!, argv[1]!, 'restore', ...args.filter((a) => a !== 'restore')];
  return runBackupCli(forwardedArgv);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRestoreCli(process.argv).then((code) => {
    process.exit(code);
  });
}
