#!/usr/bin/env node

/**
 * Command-line interface for @enkeep/import-happyclaw.
 *
 * Supported commands:
 *   inspect --source <path> [--groups-dir <dir>] [--json]
 *   migrate --source <path> [--groups-dir <dir>] [--conversation <id>...] [--all] [--user <id>] [--space <folder>] [--dry-run] [--target-dir <dir>] [--demo-root <dir>] [--json]
 *   fork --source <path> [--groups-dir <dir>] --conversation <id> --user <id> [--space <folder>] [--title <title>] [--dry-run] [--target-dir <dir>] [--demo-root <dir>] [--json]
 */

import { formatInspectSummary, inspectSource } from './inspect.js'
import { createMigrationPlan, executeGenericMigration } from './migrate.js'

function printHelp(): void {
  console.log(`
Enkeep HappyClaw Migration CLI

Usage:
  enkeep-import-happyclaw <command> [options]

Commands:
  inspect      Inspect HappyClaw SQLite source database without modifying it.
  migrate      Migrate one or more conversations into Enkeep platform format.
  fork         Fork a single conversation into an Enkeep session with title/space mapping.

Options:
  --source <path>         Path to HappyClaw messages.db SQLite file (REQUIRED)
  --groups-dir <path>     Path to HappyClaw groups workspace folder (optional)
  --conversation <jid>    Conversation/chat JID to migrate (can be specified multiple times)
  --all                   Migrate all conversations found in source database
  --user <userId>         Target Enkeep user ID (default: "alice")
  --space <spaceFolder>   Target space folder / name (default: auto from group/chat)
  --space-name <name>     Target space display name override (e.g. "真实HPC：测试")
  --title <sessionTitle>  Title override for the imported session
  --dry-run               Output the migration plan without mutating disk or DB
  --target-dir <path>     Directory to output DSH seeds, spaces, and manifest files
  --demo-root <path>      Enforce target directory containment inside this root
  --json                  Output result in structured JSON format
  --help, -h              Show this help message

Examples:
  # Inspect source database:
  enkeep-import-happyclaw inspect --source ./fixtures/source/db/messages.db

  # Dry-run migration of all chats:
  enkeep-import-happyclaw migrate --source ./messages.db --all --user alice --dry-run

  # Fork one specific conversation:
  enkeep-import-happyclaw fork --source ./messages.db --conversation "web:general" --user alice --title "Forked Chat"
`)
}

export interface ParsedArgs {
  readonly command: string
  readonly sourcePath?: string
  readonly groupsDir?: string
  readonly conversations: string[]
  readonly all: boolean
  readonly user: string
  readonly space?: string
  readonly spaceName?: string
  readonly title?: string
  readonly dryRun: boolean
  readonly targetDir?: string
  readonly demoRoot?: string
  readonly json: boolean
  readonly help: boolean
}

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const args = argv.slice(2)
  let command = ''
  let sourcePath: string | undefined
  let groupsDir: string | undefined
  const conversations: string[] = []
  let all = false
  let user = 'alice'
  let space: string | undefined
  let spaceName: string | undefined
  let title: string | undefined
  let dryRun = false
  let targetDir: string | undefined
  let demoRoot: string | undefined
  let json = false
  let help = false

  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (arg === '--help' || arg === '-h') {
      help = true
      i += 1
      continue
    }
    if (arg === '--json') {
      json = true
      i += 1
      continue
    }
    if (arg === '--dry-run') {
      dryRun = true
      i += 1
      continue
    }
    if (arg === '--all') {
      all = true
      i += 1
      continue
    }
    if (arg === '--source') {
      sourcePath = args[i + 1]
      i += 2
      continue
    }
    if (arg === '--groups-dir') {
      groupsDir = args[i + 1]
      i += 2
      continue
    }
    if (arg === '--conversation') {
      if (args[i + 1]) {
        conversations.push(args[i + 1]!)
      }
      i += 2
      continue
    }
    if (arg === '--user') {
      if (args[i + 1]) {
        user = args[i + 1]!
      }
      i += 2
      continue
    }
    if (arg === '--space') {
      space = args[i + 1]
      i += 2
      continue
    }
    if (arg === '--space-name') {
      spaceName = args[i + 1]
      i += 2
      continue
    }
    if (arg === '--title') {
      title = args[i + 1]
      i += 2
      continue
    }
    if (arg === '--target-dir') {
      targetDir = args[i + 1]
      i += 2
      continue
    }
    if (arg === '--demo-root') {
      demoRoot = args[i + 1]
      i += 2
      continue
    }

    if (!command && !arg.startsWith('-')) {
      command = arg
      i += 1
      continue
    }

    i += 1
  }

  return {
    command,
    sourcePath,
    groupsDir,
    conversations,
    all,
    user,
    space,
    title,
    dryRun,
    targetDir,
    demoRoot,
    json,
    help,
  }
}

export async function runCli(argv: readonly string[] = process.argv): Promise<number> {
  const parsed = parseCliArgs(argv)

  if (parsed.help || !parsed.command) {
    printHelp()
    return 0
  }

  if (!parsed.sourcePath) {
    console.error('Error: --source <path> is required.')
    return 1
  }

  try {
    switch (parsed.command) {
      case 'inspect': {
        const inspectRes = inspectSource({
          sourcePath: parsed.sourcePath,
          groupsDir: parsed.groupsDir,
        })
        if (parsed.json) {
          console.log(JSON.stringify(inspectRes, null, 2))
        } else {
          console.log(formatInspectSummary(inspectRes))
        }
        return inspectRes.diagnostic.ok ? 0 : 1
      }

      case 'migrate': {
        const result = await executeGenericMigration({
          sourcePath: parsed.sourcePath,
          sourceGroupsDir: parsed.groupsDir,
          conversations: parsed.conversations.length > 0 ? parsed.conversations : undefined,
          all: parsed.all || parsed.conversations.length === 0,
          userId: parsed.user,
          targetSpace: parsed.space,
          targetSpaceName: parsed.spaceName,
          titleOverride: parsed.title,
          dryRun: parsed.dryRun,
          targetDir: parsed.targetDir,
          demoRoot: parsed.demoRoot,
        })

        if (parsed.json) {
          console.log(JSON.stringify(result, null, 2))
        } else {
          console.log('================================================================================')
          console.log(
            parsed.dryRun
              ? '                    Migration Plan (DRY RUN)                                    '
              : '                    Migration Execution Completed                               '
          )
          console.log('================================================================================')
          console.log(`Source Path:       ${result.plan.sourcePath}`)
          console.log(`Fingerprint:       ${result.sourceFingerprint}`)
          console.log(`Target User:       ${result.targetUserId}`)
          console.log(`Conversations:     ${result.plan.totalConversations}`)
          console.log(`Messages:          ${result.plan.totalMessages}`)
          console.log('--------------------------------------------------------------------------------')
          for (const item of result.plan.items) {
            console.log(`- [${item.sourceKey}] -> Session: ${item.targetSessionId}`)
            console.log(`    Space: ${item.targetFolder} (${item.targetSpaceName}) | Messages: ${item.messageCount}`)
            if (item.filesToCopy.length > 0) {
              console.log(`    Space Files to copy: ${item.filesToCopy.join(', ')}`)
            }
            if (item.missingFiles.length > 0) {
              console.log(`    [Warning] Missing attachment files: ${item.missingFiles.join('; ')}`)
            }
          }
          console.log('================================================================================')
        }
        return 0
      }

      case 'fork': {
        if (parsed.conversations.length === 0) {
          console.error('Error: fork command requires `--conversation <jid>` specifying the conversation to fork.')
          return 1
        }
        const targetConv = parsed.conversations[0]!
        const result = await executeGenericMigration({
          sourcePath: parsed.sourcePath,
          sourceGroupsDir: parsed.groupsDir,
          conversations: [targetConv],
          all: false,
          userId: parsed.user,
          targetSpace: parsed.space,
          targetSpaceName: parsed.spaceName,
          titleOverride: parsed.title,
          dryRun: parsed.dryRun,
          targetDir: parsed.targetDir,
          demoRoot: parsed.demoRoot,
        })

        if (parsed.json) {
          console.log(JSON.stringify(result, null, 2))
        } else {
          const item = result.plan.items[0]
          console.log('================================================================================')
          console.log(
            parsed.dryRun
              ? '                    Fork Plan (DRY RUN)                                         '
              : '                    Fork Completed Successfully                                 '
          )
          console.log('================================================================================')
          console.log(`Source JID:        ${targetConv}`)
          console.log(`Target User:       ${result.targetUserId}`)
          console.log(`Target Session:    ${item?.targetSessionId ?? 'n/a'}`)
          console.log(`Target Space:      ${item?.targetFolder ?? 'n/a'}`)
          console.log(`Title:             ${item?.targetTitle ?? 'n/a'}`)
          console.log(`Messages:          ${item?.messageCount ?? 0}`)
          console.log('================================================================================')
        }
        return 0
      }

      default:
        console.error(`Unknown command "${parsed.command}". Use --help to list available commands.`)
        return 1
    }
  } catch (err: any) {
    if (parsed.json) {
      console.error(JSON.stringify({ error: err?.message ?? String(err) }))
    } else {
      console.error(`Error: ${err?.message ?? String(err)}`)
    }
    return 1
  }
}

// Direct execution guard
if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().then((code) => {
    if (code !== 0) process.exit(code)
  })
}
