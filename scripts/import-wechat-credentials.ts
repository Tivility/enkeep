#!/usr/bin/env tsx
/**
 * WeChat Credential Importer & Cutover CLI (Module I).
 *
 * Implements scan-free migration of HappyClaw WeChat iLink bot credentials to Enkeep:
 * - Decrypts HappyClaw AES-256-GCM credentials (claude-provider.key).
 * - Re-encrypts with Enkeep AES-256-GCM with tenant AAD (${userId}:${credentialRef}).
 * - Updates channel_encrypted_credentials, channel_accounts, and channel_bindings.
 * - Supports staging (status: 'disabled') and direct activation (status: 'active').
 * - Zero secrets leakage: outputs only masked fingerprints.
 * - Zero external network calls.
 *
 * Usage:
 *   # Dry-run inspection
 *   tsx scripts/import-wechat-credentials.ts --dry-run --hc-dir=<happyclaw-root>
 *
 *   # Formal migration to disabled status
 *   tsx scripts/import-wechat-credentials.ts --hc-dir=<happyclaw-root> --status=disabled
 *
 *   # Single user activation
 *   tsx scripts/import-wechat-credentials.ts --user=cxx --activate
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface WeChatMigrationItem {
  readonly username: string;
  readonly sourceUserId: string;
  readonly targetUserId: string;
  readonly sourceAccountId: string;
  readonly targetAccountId: string;
  readonly ilinkBotIdMasked: string;
  readonly cursorLen: number;
  readonly credentialRef: string;
  readonly status: 'active' | 'disabled';
  readonly defaultSpaceId: string | null;
  readonly bindingsCount: number;
}

export interface WeChatMigrationOptions {
  readonly hcDir?: string;
  readonly hcKeyPath?: string;
  readonly targetDbPath?: string;
  readonly masterKey?: string;
  readonly dryRun?: boolean;
  readonly status?: 'disabled' | 'active';
  readonly activate?: boolean;
  readonly user?: string;
  readonly onlyActive?: boolean;
  readonly checkEndpoint?: boolean;
}

export interface WeChatMigrationReport {
  readonly success: boolean;
  readonly dryRun: boolean;
  readonly items: readonly WeChatMigrationItem[];
  readonly warnings: readonly string[];
  readonly endpointChecks?: readonly {
    readonly username: string;
    readonly ok: boolean;
    readonly status?: number;
    readonly message?: string;
  }[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function printUsage(): void {
  console.log(`
Enkeep WeChat Credential Importer & Migration CLI (Module I)

Usage:
  tsx scripts/import-wechat-credentials.ts [options]

Options:
  --dry-run               Dry run mode: validate and decrypt without writing to target DB
  --hc-dir=<path>         Path to HappyClaw root directory (default: <happyclaw-root>)
  --hc-key=<path>         Path to HappyClaw claude-provider.key file
  --target-db=<path>      Path to target Enkeep platform.db (default: .demo-data/platform.db)
  --vault-key=<secret>    Master encryption key (hex or string) for Enkeep credentials
  --status=<status>       Target account status: "disabled" | "active" (default: "disabled")
  --activate              Shorthand for --status=active
  --user=<name>           Filter migration to a single HappyClaw username or ID (e.g. "cxx")
  --only-active           Only import accounts that were active/enabled in HappyClaw
  --check                 Perform local offline endpoint connectivity check (fake server only)
  --json                  Output report in structured JSON format
  --help, -h              Show this help message

Examples:
  tsx scripts/import-wechat-credentials.ts --dry-run --hc-dir=<happyclaw-root>
  tsx scripts/import-wechat-credentials.ts --hc-dir=<happyclaw-root> --status=disabled
  tsx scripts/import-wechat-credentials.ts --user=cxx --activate
`);
}

function parseCliArgs(argv: string[]): {
  options: WeChatMigrationOptions;
  json: boolean;
  help: boolean;
} {
  let dryRun = false;
  let hcDir = process.env.HAPPYCLAW_DIR || path.join(os.tmpdir(), 'happyclaw');
  let hcKeyPath: string | undefined;
  let targetDbPath = process.env.ENKEEP_PLATFORM_DB || path.join(REPO_ROOT, '.demo-data', 'platform.db');
  let masterKey: string | undefined;
  let status: 'disabled' | 'active' = 'disabled';
  let user: string | undefined;
  let onlyActive = false;
  let checkEndpoint = false;
  let json = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--activate') {
      status = 'active';
    } else if (arg === '--only-active') {
      onlyActive = true;
    } else if (arg === '--check') {
      checkEndpoint = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('--hc-dir=')) {
      hcDir = arg.slice('--hc-dir='.length);
    } else if (arg === '--hc-dir' && i + 1 < argv.length) {
      hcDir = argv[++i];
    } else if (arg.startsWith('--hc-key=')) {
      hcKeyPath = arg.slice('--hc-key='.length);
    } else if (arg === '--hc-key' && i + 1 < argv.length) {
      hcKeyPath = argv[++i];
    } else if (arg.startsWith('--target-db=')) {
      targetDbPath = arg.slice('--target-db='.length);
    } else if (arg === '--target-db' && i + 1 < argv.length) {
      targetDbPath = argv[++i];
    } else if (arg.startsWith('--vault-key=')) {
      masterKey = arg.slice('--vault-key='.length);
    } else if (arg === '--vault-key' && i + 1 < argv.length) {
      masterKey = argv[++i];
    } else if (arg.startsWith('--status=')) {
      const val = arg.slice('--status='.length);
      if (val === 'active' || val === 'disabled') {
        status = val;
      }
    } else if (arg === '--status' && i + 1 < argv.length) {
      const val = argv[++i];
      if (val === 'active' || val === 'disabled') {
        status = val;
      }
    } else if (arg.startsWith('--user=')) {
      user = arg.slice('--user='.length);
    } else if (arg === '--user' && i + 1 < argv.length) {
      user = argv[++i];
    }
  }

  return {
    options: {
      hcDir,
      hcKeyPath,
      targetDbPath,
      masterKey,
      status,
      dryRun,
      user,
      onlyActive,
      checkEndpoint,
    },
    json,
    help,
  };
}

async function loadImporter(): Promise<(options: WeChatMigrationOptions) => Promise<WeChatMigrationReport>> {
  const importerPath = path.resolve(__dirname, '../packages/import-happyclaw/src/wechat-importer.js');
  const mod = await import(pathToFileURL(importerPath).href);
  return mod.importWeChatCredentials;
}

async function main(): Promise<void> {
  const { options, json, help } = parseCliArgs(process.argv.slice(2));

  if (help) {
    printUsage();
    process.exit(0);
  }

  try {
    const importWeChatCredentials = await loadImporter();
    const report = await importWeChatCredentials(options);

    if (json) {
      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    }

    if (report.warnings.length > 0) {
      for (const warn of report.warnings) {
        console.warn(`[WARN] ${warn}`);
      }
    }

    if (report.items.length === 0) {
      console.log('[INFO] No matching WeChat accounts found to migrate.');
      process.exit(0);
    }

    for (const item of report.items) {
      console.log(
        `[OK] Migrated WeChat account for user "${item.username}": botId=${item.ilinkBotIdMasked}, cursorLen=${item.cursorLen}, credRef=${item.credentialRef}`
      );
    }

    if (report.dryRun) {
      console.log('[DRY RUN]演练完成：未写入数据库与磁盘。');
    } else {
      console.log(`[DONE]成功导入 ${report.items.length} 个微信渠道账号（状态: ${options.status}）。`);
    }

    process.exit(0);
  } catch (err: any) {
    console.error(`[ERROR] WeChat credential migration failed: ${err.message}`);
    process.exit(1);
  }
}

main();
