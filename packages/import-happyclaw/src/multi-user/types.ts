/**
 * Multi-user migration type definitions for HappyClaw to Enkeep.
 */

export interface MultiUserSelectOptions {
  /**
   * Specific users to migrate (can be username or user ID, repeatable).
   */
  readonly users?: readonly string[]

  /**
   * When true, migrates all users except the owner/admin account.
   */
  readonly allExceptOwner?: boolean

  /**
   * The owner's username or user ID to exclude when allExceptOwner is true.
   * Defaults to 'owner-user'.
   */
  readonly ownerUsername?: string
}

export interface DisambiguatedSpaceMapping {
  readonly workspaceJid: string
  readonly workspaceName: string
  readonly srcFolder: string
  readonly targetFolder: string
  readonly spaceId: string
  readonly executionMode: 'container'
  readonly isHome: boolean
  readonly isDisambiguated: boolean
  readonly disambiguationReason?: string
}

export interface SpaceMigrationPlanItem {
  readonly workspaceJid: string
  readonly workspaceName: string
  readonly srcFolder: string
  readonly targetFolder: string
  readonly spaceId: string
  readonly executionMode: 'container'
  readonly isHome: boolean
  readonly filesCount: number
  readonly totalFileBytes: number
  readonly filesToCopy: readonly string[]
  readonly excludedFiles: readonly string[]
}

export interface SessionMigrationPlanItem {
  readonly chatJid: string
  readonly title: string
  readonly spaceId: string
  readonly targetFolder: string
  readonly targetSessionId: string
  readonly targetRouteKey: string
  readonly messageCount: number
  readonly attachmentCount: number
}

export interface MemoryFilePlanItem {
  readonly sourceFile: string
  readonly relativePath: string
  readonly targetPath: string
  readonly byteSize: number
  readonly targetFolder: string
}

export interface ChannelAccountPlanItem {
  readonly sourceAccountId: string
  readonly channelType: 'lark' | 'wechat' | string
  readonly name: string
  readonly status: 'disabled'
  readonly credentialRef: string
  readonly credentialAction: 'encrypted' | 'placeholder'
  readonly bindingCount: number
}

export interface UserMigrationPlan {
  readonly sourceUser: {
    readonly id: string
    readonly username: string
    readonly displayName: string
    readonly role: string
  }
  readonly targetUserId: string
  readonly isNewUser: boolean
  readonly mustChangePassword: true
  readonly spaces: readonly SpaceMigrationPlanItem[]
  readonly sessions: readonly SessionMigrationPlanItem[]
  readonly memoryFiles: readonly MemoryFilePlanItem[]
  readonly channelAccounts: readonly ChannelAccountPlanItem[]
  readonly summary: {
    readonly spacesCount: number
    readonly sessionsCount: number
    readonly messagesCount: number
    readonly filesCount: number
    readonly totalFileBytes: number
    readonly memoryFilesCount: number
    readonly channelAccountsCount: number
  }
}

export type IdCollisionReason = 'within_batch' | 'against_enkeep'

export interface IdCollisionDetail {
  readonly table: string
  readonly id: string
  readonly reason: IdCollisionReason
  readonly message: string
  readonly sourceChatJid?: string
  readonly sourceMessageId?: string
  readonly targetUserId?: string
  readonly conflictingUserId?: string
}

export interface MultiUserMigrationPlan {
  readonly sourcePath: string
  readonly sourceFingerprint: string
  readonly dryRun: boolean
  readonly selectedUsers: readonly string[]
  readonly userPlans: readonly UserMigrationPlan[]
  readonly plannedPasswordsFile: string
  readonly summary: {
    readonly totalUsers: number
    readonly totalNewUsers: number
    readonly totalExistingUsers: number
    readonly totalSpaces: number
    readonly totalSessions: number
    readonly totalMessages: number
    readonly totalMemoryFiles: number
    readonly totalFileBytes: number
    readonly totalChannelAccounts: number
  }
  readonly warnings: readonly string[]
  readonly collisions: readonly IdCollisionDetail[]
}

export interface MultiUserMigrateOptions {
  /** Path to source SQLite database file */
  readonly sourcePath: string
  /** Directory containing workspace/group folder files */
  readonly sourceGroupsDir?: string
  /** Directory containing memory files (e.g. data/memory) */
  readonly sourceMemoryDir?: string
  /** Directory containing configuration/credential files */
  readonly sourceConfigDir?: string
  /** Target Enkeep platform SQLite database path (optional for dry-run or staged-only) */
  readonly targetDbPath?: string
  /** Target spaces directory to copy workspace files */
  readonly targetSpacesDir?: string
  /** User selection options */
  readonly select: MultiUserSelectOptions
  /** Whether to perform a dry-run without mutating disk or DB */
  readonly dryRun?: boolean
  /** Path to save private passwords file (MUST be 0600 outside repo/reports) */
  readonly passwordFile?: string
  /** Encryption master key for Lark/channel credentials (32-byte hex or Buffer) */
  readonly masterKey?: Buffer | string
  /** Deterministic timestamp for byte-stable testing */
  readonly deterministicCreatedAt?: string
  /** Whether to throw immediately when collisions are detected (defaults to false in plan, true in execute) */
  readonly throwOnCollision?: boolean
}

export interface MultiUserMigrationResult {
  readonly success: boolean
  readonly dryRun: boolean
  readonly plan: MultiUserMigrationPlan
  readonly passwordsFile?: string
  readonly executedAt: string
  readonly targetDbPath?: string
  readonly targetSpacesDir?: string
}
