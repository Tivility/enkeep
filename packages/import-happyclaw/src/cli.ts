#!/usr/bin/env node

/**
 * Command-line interface for @enkeep/import-happyclaw.
 *
 * Supported commands:
 *   inspect --source <path> [--groups-dir <dir>] [--json]
 *   migrate --source <path> [--groups-dir <dir>] [--conversation <id>...] [--all] [--user <id>...] [--all-except owner] [--target-db <path>] [--dry-run] [--target-dir <dir>] [--json]
 *   fork --source <path> [--groups-dir <dir>] --conversation <id> --user <id> [--space <folder>] [--title <title>] [--dry-run] [--target-dir <dir>] [--json]
 */

import { formatInspectSummary, inspectSource } from './inspect.js'
import { createMigrationPlan, executeGenericMigration } from './migrate.js'
import { executeMultiUserMigration } from './multi-user/orchestrator.js'

function printHelp(): void {
  console.log(`
Enkeep HappyClaw Migration CLI

Usage:
  enkeep-import-happyclaw <command> [options]

Commands:
  inspect        Inspect HappyClaw SQLite source database without modifying it.
  migrate        Migrate conversations, workspaces, or multiple users into Enkeep platform format.
  migrate-users  Explicitly execute multi-user migration for selected users or all non-owners.
  fork           Fork a single conversation into an Enkeep session with title/space mapping.

Options:
  --source <path>            Path to HappyClaw messages.db SQLite file (REQUIRED)
  --groups-dir <path>        Path to HappyClaw groups workspace folder (optional)
  --memory-dir <path>        Path to HappyClaw memory files directory (optional)
  --config-dir <path>        Path to HappyClaw config directory (optional)
  --conversation <jid>       Conversation/chat JID to migrate (can be specified multiple times)
  --all                      Migrate all conversations found in source database
  --user <userId>            Target Enkeep user ID / username (repeatable for multi-user migration)
  --all-except owner         Migrate all discovered users except the owner/admin account
  --owner-username <name>    Owner username to exclude (default: "owner-user")
  --target-db <path>         Path to target Enkeep platform.db SQLite database
  --target-spaces-dir <path> Target directory to write copied per-user workspace/space files
  --password-file <path>     Path to store generated temporary passwords (private 0600 file outside repo/reports)
  --vault-key <secret>       Master encryption key or file for Lark/channel encrypted credentials
  --space <spaceFolder>      Target space folder / name (default: auto from group/chat)
  --space-name <name>        Target space display name override (e.g. "真实HPC：测试")
  --title <sessionTitle>     Title override for the imported session
  --dry-run                  Output the migration plan without mutating disk or DB
  --target-dir <path>        Directory to output DSH seeds, spaces, and manifest files
  --demo-root <path>         Enforce target directory containment inside this root
  --json                     Output result in structured JSON format
  --help, -h                 Show this help message

Examples:
  # Inspect source database:
  enkeep-import-happyclaw inspect --source ./fixtures/source/db/messages.db

  # Dry-run multi-user migration for all non-owner members:
  enkeep-import-happyclaw migrate --source ./messages.db --groups-dir ./groups --all-except owner --dry-run

  # Multi-user migration for selected users:
  enkeep-import-happyclaw migrate --source ./messages.db --user cxx --user whz --target-db ./platform.db --dry-run

  # Single conversation fork:
  enkeep-import-happyclaw fork --source ./messages.db --conversation "web:general" --user alice --title "Forked Chat"
`)
}

export interface ParsedArgs {
  readonly command: string
  readonly sourcePath?: string
  readonly groupsDir?: string
  readonly memoryDir?: string
  readonly configDir?: string
  readonly targetDb?: string
  readonly targetSpacesDir?: string
  readonly passwordFile?: string
  readonly vaultKey?: string
  readonly ownerUsername?: string
  readonly conversations: string[]
  readonly all: boolean
  readonly users: string[]
  readonly user: string
  readonly allExceptOwner: boolean
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
  let memoryDir: string | undefined
  let configDir: string | undefined
  let targetDb: string | undefined
  let targetSpacesDir: string | undefined
  let passwordFile: string | undefined
  let vaultKey: string | undefined
  let ownerUsername: string | undefined
  const conversations: string[] = []
  let all = false
  const users: string[] = []
  let user = 'alice'
  let allExceptOwner = false
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
    if (arg === '--all-except' && args[i + 1] === 'owner') {
      allExceptOwner = true
      i += 2
      continue
    }
    if (arg === '--all-except-owner') {
      allExceptOwner = true
      i += 1
      continue
    }
    if (arg === '--owner-username') {
      ownerUsername = args[i + 1]
      i += 2
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
    if (arg === '--memory-dir') {
      memoryDir = args[i + 1]
      i += 2
      continue
    }
    if (arg === '--config-dir') {
      configDir = args[i + 1]
      i += 2
      continue
    }
    if (arg === '--target-db') {
      targetDb = args[i + 1]
      i += 2
      continue
    }
    if (arg === '--target-spaces-dir') {
      targetSpacesDir = args[i + 1]
      i += 2
      continue
    }
    if (arg === '--password-file') {
      passwordFile = args[i + 1]
      i += 2
      continue
    }
    if (arg === '--vault-key') {
      vaultKey = args[i + 1]
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
        const u = args[i + 1]!
        users.push(u)
        user = u
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
    memoryDir,
    configDir,
    targetDb,
    targetSpacesDir,
    passwordFile,
    vaultKey,
    ownerUsername,
    conversations,
    all,
    users,
    user,
    allExceptOwner,
    space,
    spaceName,
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

      case 'migrate-users':
      case 'migrate': {
        // Multi-user migration triggered by --all-except owner, multiple --user, or command migrate-users
        const isMultiUser =
          parsed.command === 'migrate-users' ||
          parsed.allExceptOwner ||
          parsed.users.length > 1 ||
          Boolean(parsed.targetDb && parsed.users.length > 0 && parsed.conversations.length === 0 && !parsed.all)

        if (isMultiUser) {
          const muResult = await executeMultiUserMigration({
            sourcePath: parsed.sourcePath,
            sourceGroupsDir: parsed.groupsDir,
            sourceMemoryDir: parsed.memoryDir,
            sourceConfigDir: parsed.configDir,
            targetDbPath: parsed.targetDb,
            targetSpacesDir: parsed.targetSpacesDir,
            select: {
              users: parsed.users.length > 0 ? parsed.users : undefined,
              allExceptOwner: parsed.allExceptOwner,
              ownerUsername: parsed.ownerUsername,
            },
            dryRun: parsed.dryRun,
            passwordFile: parsed.passwordFile,
            masterKey: parsed.vaultKey,
          })

          if (parsed.json) {
            console.log(JSON.stringify(muResult, null, 2))
          } else {
            console.log('================================================================================')
            console.log(
              parsed.dryRun
                ? '               Enkeep Multi-User Migration Plan (DRY RUN)                       '
                : '               Enkeep Multi-User Migration Execution Completed                   '
            )
            console.log('================================================================================')
            console.log(`Source Path:         ${muResult.plan.sourcePath}`)
            console.log(`Source Fingerprint:  ${muResult.plan.sourceFingerprint}`)
            console.log(`Selected Users:      ${muResult.plan.selectedUsers.join(', ')} (${muResult.plan.summary.totalUsers} users)`)
            console.log(`Planned Passwords:   ${muResult.plan.plannedPasswordsFile} (mode: 0600)`)
            if (muResult.targetDbPath) {
              console.log(`Target Platform DB:  ${muResult.targetDbPath}`)
            }
            console.log('--------------------------------------------------------------------------------')

            for (const up of muResult.plan.userPlans) {
              console.log(`\n[User: ${up.sourceUser.username}] (${up.sourceUser.displayName})`)
              console.log(`  User ID:          ${up.targetUserId} (New: ${up.isNewUser ? 'YES' : 'NO - existing preserved'})`)
              console.log(`  Must Change Pwd:  ${up.mustChangePassword ? 'YES' : 'NO'}`)
              console.log(`  Spaces (${up.spaces.length}):`)
              for (const sp of up.spaces) {
                console.log(`    - Folder: ${sp.targetFolder} [container] | Name: "${sp.workspaceName}"`)
                if (sp.srcFolder !== sp.targetFolder) {
                  console.log(`      (Disambiguated from shared source: "${sp.srcFolder}" to prevent cross-contamination)`)
                }
                console.log(`      Files to copy: ${sp.filesCount} (${(sp.totalFileBytes / 1024).toFixed(1)} KB)`)
                if (sp.excludedFiles.length > 0) {
                  console.log(`      Excluded secret files: ${sp.excludedFiles.length}`)
                }
              }
              console.log(`  Sessions (${up.sessions.length}):`)
              for (const s of up.sessions) {
                console.log(`    - [${s.chatJid}] -> Session: ${s.targetSessionId} | Messages: ${s.messageCount}`)
              }
              if (up.memoryFiles.length > 0) {
                console.log(`  Memory Files (${up.memoryFiles.length}):`)
                for (const mf of up.memoryFiles) {
                  console.log(`    - ${mf.targetPath} (${mf.byteSize} bytes)`)
                }
              }
              if (up.channelAccounts.length > 0) {
                console.log(`  Channel Accounts (${up.channelAccounts.length}):`)
                for (const ca of up.channelAccounts) {
                  console.log(`    - Type: ${ca.channelType} | Status: ${ca.status} (Credential: ${ca.credentialAction})`)
                }
              }
            }

            console.log('\n================================================================================')
            console.log(`Totals: ${muResult.plan.summary.totalUsers} users, ${muResult.plan.summary.totalSpaces} spaces, ${muResult.plan.summary.totalSessions} sessions, ${muResult.plan.summary.totalMessages} msgs, ${muResult.plan.summary.totalMemoryFiles} mem files, ${(muResult.plan.summary.totalFileBytes / 1024).toFixed(1)} KB`)
            console.log(`ID Collisions:        ${muResult.plan.collisions?.length ?? 0}`)
            if (muResult.passwordsFile) {
              console.log(`[Notice] Passwords safely saved in private file: ${muResult.passwordsFile}`)
            }
            console.log('================================================================================')
          }

          return 0
        }

        // Single user / conversation migration (classic mode)
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
