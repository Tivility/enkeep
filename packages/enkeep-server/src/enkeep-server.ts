#!/usr/bin/env node
/**
 * enkeep-server — the production entry point of an Enkeep deployment.
 *
 *   enkeep-server serve      --data-dir <dir> [--port <n>] [--network-mode none|bridge] [--allow-host] [--dsh-home <dir>]
 *   enkeep-server preflight  --data-dir <dir> --port <n> [--wait --timeout-seconds <n> --interval-seconds <n>] [--due-within-minutes <n>]
 *   enkeep-server stop       --data-dir <dir>      (stops the platform and runtime containers; never removes volumes)
 *   enkeep-server jarvis-token issue|revoke --data-dir <dir> --user <username> [--token-file <file>]
 *   enkeep-server mark-production --data-dir <dir>
 *   enkeep-server migrate-data-dir --from <dir> --to <dir> --copy-image <image> [--link-old] [--dry-run]
 *
 * `serve` requires a production data directory (marked with enkeep-production.json) and names the
 * runtime containers and volumes `enkeep-runtime-*` / `enkeep-home-*`. The demo tooling
 * (`demo-runner reset|up|down|test`) refuses such a directory.
 *
 * @module @enkeep/server/cli
 */

import { resolve } from 'node:path';
import { runDemoRunnerCli, writeProductionMarker, isProductionDataDir, parseDataDir } from '@enkeep/demo-runner';
import { migrateDataDir, revertDataDirMigration } from './migrate.js';

const USAGE = `enkeep-server <command> [options]

  serve             Run the platform of a deployment (requires --data-dir of a production data directory)
  preflight         Check that the deployment is idle (same options as demo-runner preflight)
  stop              Stop the platform and its runtime containers (volumes are kept)
  jarvis-token      Issue or revoke a user's Jarvis token (same options as demo-runner jarvis-token)
  mark-production   Mark --data-dir as a production data directory
  migrate-data-dir  Move a data directory (--from) to --to and rename its runtimes to the production names;
                    --copy-image <image> copies home volumes, --link-old leaves a symlink, --dry-run plans only;
                    --revert (same --from/--to) moves it back and restores the demo runtime metadata
`;

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

function requireDataDir(args: string[]): string {
  const dataDir = parseDataDir(args, {});
  if (!dataDir) throw new Error('--data-dir <dir> is required');
  return resolve(dataDir);
}

export async function runEnkeepServerCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  process.title = 'enkeep-server';
  const [command, ...rest] = argv;
  switch (command) {
    case 'serve': {
      const dataDir = requireDataDir(rest);
      if (!isProductionDataDir(dataDir)) {
        throw new Error(`${dataDir} is not a production data directory (run "enkeep-server mark-production" first)`);
      }
      await runDemoRunnerCli(['up', '--production', ...rest]);
      return;
    }
    case 'stop': {
      requireDataDir(rest);
      await runDemoRunnerCli(['down', '--production', ...rest]);
      return;
    }
    case 'preflight':
    case 'jarvis-token':
      await runDemoRunnerCli([command, ...rest]);
      return;
    case 'mark-production': {
      const dataDir = requireDataDir(rest);
      console.log(`Marked ${writeProductionMarker(dataDir)}`);
      return;
    }
    case 'migrate-data-dir': {
      const from = flag(rest, '--from');
      const to = flag(rest, '--to');
      if (rest.includes('--revert')) {
        if (!from || !to) throw new Error('migrate-data-dir --revert requires --from and --to (as given to the migration)');
        await revertDataDirMigration({ original: from, migrated: to });
        console.log('Reverted.');
        return;
      }
      const copyImage = flag(rest, '--copy-image');
      if (!from || !to || !copyImage) throw new Error('migrate-data-dir requires --from, --to and --copy-image');
      const dryRun = rest.includes('--dry-run');
      console.log(dryRun ? 'Migration plan:' : 'Migrating:');
      const result = await migrateDataDir({ from, to, copyImage, linkOld: rest.includes('--link-old'), dryRun });
      if (rest.includes('--json')) console.log(JSON.stringify(result, null, 2));
      console.log(dryRun ? 'Dry run: nothing changed.' : `Done. Start the platform with: enkeep-server serve --data-dir ${result.to}`);
      return;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return;
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      process.exit(1);
  }
}

if (process.argv[1] && (process.argv[1].endsWith('enkeep-server.js') || process.argv[1].endsWith('enkeep-server.ts'))) {
  runEnkeepServerCli().catch((err: unknown) => {
    console.error(`\n✖ enkeep-server: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
