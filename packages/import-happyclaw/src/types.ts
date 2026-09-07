/**
 * Core type definitions for @enkeep/import-happyclaw.
 */

export interface ChatRow {
  readonly jid: string
  readonly name: string | null
  readonly last_message_time?: string | null
}

export interface GroupRow {
  readonly jid: string
  readonly name: string
  readonly folder: string
  readonly execution_mode?: string | null
  readonly is_home?: number | null
  readonly created_by?: string | null
}

export interface MessageRow {
  readonly id: string
  readonly chat_jid: string
  readonly source_jid?: string | null
  readonly sender?: string | null
  readonly sender_name?: string | null
  readonly content: string | null
  readonly timestamp: string | null
  readonly is_from_me: number
  readonly attachments: string | null
  readonly delivery_status?: string | null
  readonly source_kind?: string | null
  readonly session_id?: string | null
  readonly turn_id?: string | null
}

export interface SeedEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: Readonly<Record<string, unknown>>
  readonly surfaceOp?: 'append'
  readonly sourceEventSeqs?: readonly number[]
}

export type AnomalyType =
  | 'empty_message'
  | 'missing_timestamp'
  | 'invalid_timestamp'
  | 'consecutive_user_message'
  | 'consecutive_assistant_message'
  | 'unpaired_assistant'
  | 'attachment_referenced'
  | 'attachment_file_missing'
  | 'unknown_execution_mode'
  | 'missing_group_registration'

export interface AnomalyRecord {
  readonly type: AnomalyType
  readonly chatJid: string
  readonly messageId?: string
  readonly rawTimestamp?: string | null
  readonly assignedTime?: number
  readonly detail?: string
}

export interface ChatReport {
  readonly chatJid: string
  readonly folder: string
  readonly sessionId: string
  readonly sourceMessages: number
  readonly importedPeopleTalk: number
  readonly droppedEmpty: number
  readonly attachments: number
  readonly unpairedAssistants: number
  readonly consecutiveUserMessages: number
  readonly consecutiveAssistantMessages: number
  readonly executionMode: string | null
}

export interface CompiledChat {
  readonly chatJid: string
  readonly folder: string
  readonly sessionId: string
  readonly seed: readonly SeedEvent[]
  readonly report: ChatReport
  readonly anomalies: readonly AnomalyRecord[]
}

export interface ImportStats {
  readonly chats: number
  readonly sourceMessages: number
  readonly importedPeopleTalk: number
  readonly droppedEmpty: number
  readonly attachments: number
  readonly unpairedAssistants: number
  readonly consecutiveUserMessages: number
  readonly consecutiveAssistantMessages: number
}

export interface ImportManifest {
  readonly sourceFingerprint: string
  readonly importerVersion: string
  readonly targetDsh: string
  readonly sessionFormat: number
  readonly idAlgorithm: string
  readonly createdAt: string
  readonly stats: ImportStats
  readonly chatReports: readonly ChatReport[]
  readonly anomalies: readonly AnomalyRecord[]
}

export interface ChatMapping {
  readonly userId: string
  readonly folder: string
  readonly sessionId: string
  readonly chatJid: string
  readonly executionMode?: string | null
  readonly spaceName?: string
  readonly title?: string
}

/**
 * Public import request interface for importing the fixed offline HappyClaw fixture.
 * Strictly requires exact targetDir, demoRoot, userId 'alice', and deterministicCreatedAt.
 * No arbitrary sources, aliases, or chat filters allowed.
 */
export interface ImportFixedFixtureRequest {
  /** Target output directory strictly contained inside demoRoot */
  readonly targetDir: string
  /** Explicit demo root to enforce confinement boundary */
  readonly demoRoot: string
  /** Target user identifier — strictly 'alice' */
  readonly userId: 'alice'
  /** Fixed timestamp string for deterministic / byte-stable test runs */
  readonly deterministicCreatedAt: string
}

export type ImportRequest = ImportFixedFixtureRequest

export interface ImportResult {
  readonly targetDir: string
  readonly mapping: Readonly<Record<string, ChatMapping>>
  readonly chats: readonly CompiledChat[]
  readonly manifest: ImportManifest
  readonly stats: ImportStats
}

// ---------------------------------------------------------------------------
// Generic Source Adapter & Migration Types
// ---------------------------------------------------------------------------

export type SchemaCompatibilityLevel = 'current' | 'legacy' | 'minimal' | 'incompatible'

export interface SchemaDiagnostic {
  readonly ok: boolean
  readonly compatibilityLevel: SchemaCompatibilityLevel
  readonly detectedSchemaVersion: number | null
  readonly tablesFound: readonly string[]
  readonly missingRequiredTables: readonly string[]
  readonly missingOptionalTables: readonly string[]
  readonly issues: readonly string[]
  readonly recommendations: readonly string[]
  readonly columnMap: Readonly<Record<string, readonly string[]>>
}

export interface ConversationInspectSummary {
  readonly sourceKey: string // chat_jid
  readonly name: string
  readonly channel: string // e.g. 'web', 'feishu', 'telegram', 'whatsapp', 'slack', 'group', 'dm'
  readonly folder: string
  readonly executionMode: string | null
  readonly messageCount: number
  readonly firstMessageAt: string | null
  readonly lastMessageAt: string | null
  readonly senderCount: number
  readonly hasAttachments: boolean
}

export interface SourceInspectResult {
  readonly sourcePath: string
  readonly sourceFingerprint: string
  readonly diagnostic: SchemaDiagnostic
  readonly totalConversations: number
  readonly totalMessages: number
  readonly conversations: readonly ConversationInspectSummary[]
}

export interface GenericMigrateOptions {
  /** Path to source SQLite database file */
  readonly sourcePath: string
  /** Optional directory of source spaces/groups files */
  readonly sourceGroupsDir?: string
  /** Specific conversation JIDs to migrate; if empty/omitted and all=true, migrates all */
  readonly conversations?: readonly string[]
  /** When true, migrates all conversations found in source */
  readonly all?: boolean
  /** Target user ID in Enkeep platform (e.g. 'alice', 'bob', or custom valid user ID) */
  readonly userId: string
  /** Target space folder or name override */
  readonly targetSpace?: string
  /** Target space display name override */
  readonly targetSpaceName?: string
  /** Custom session title override (especially useful for single conversation fork) */
  readonly titleOverride?: string
  /** When true, calculates and outputs migration plan without mutating disk or DB */
  readonly dryRun?: boolean
  /** Deterministic timestamp for reproducible testing */
  readonly deterministicCreatedAt?: string
  /** Optional output directory to write seed JSON, spaces, and manifest files */
  readonly targetDir?: string
  /** Confinement boundary root if targetDir is specified */
  readonly demoRoot?: string
}

export interface MigrationPlanItem {
  readonly sourceKey: string
  readonly sourceName: string
  readonly messageCount: number
  readonly targetUserId: string
  readonly targetFolder: string
  readonly targetSpaceName: string
  readonly targetSessionId: string
  readonly targetRouteKey: string
  readonly targetTitle: string
  readonly estimatedSeedEvents: number
  readonly attachmentCount: number
  readonly filesToCopy: readonly string[]
  readonly missingFiles: readonly string[]
}

export interface MigrationPlan {
  readonly sourcePath: string
  readonly sourceFingerprint: string
  readonly dryRun: boolean
  readonly targetUserId: string
  readonly totalConversations: number
  readonly totalMessages: number
  readonly items: readonly MigrationPlanItem[]
  readonly warnings: readonly string[]
}

export interface GenericMigrationResult {
  readonly success: boolean
  readonly dryRun: boolean
  readonly sourceFingerprint: string
  readonly targetUserId: string
  readonly plan: MigrationPlan
  readonly compiledChats: readonly CompiledChat[]
  readonly manifest: ImportManifest
  readonly stats: ImportStats
  readonly targetDir?: string
  readonly mapping: Record<string, ChatMapping>
}

// ---------------------------------------------------------------------------
// Migration V2 Types (Workspaces, Instructions, Extensions M30, Channels M31)
// ---------------------------------------------------------------------------

export interface MigrationV2Scopes {
  readonly coreData: boolean
  readonly extensions: boolean
  readonly tasks: boolean
  readonly channelsMetadata: boolean
  readonly credentials: boolean
}

export const DEFAULT_MIGRATION_V2_SCOPES: Readonly<MigrationV2Scopes> = Object.freeze({
  coreData: true,
  extensions: true,
  tasks: true,
  channelsMetadata: true,
  credentials: false,
})

export interface WorkspaceInspectSummaryV2 {
  readonly workspaceId: string
  readonly name: string
  readonly folder: string
  readonly executionMode: string | null
  readonly conversationCount: number
  readonly messageCount: number
  readonly hasMemoryOrClaudeFile: boolean
  readonly skillsCount: number
  readonly pluginsCount: number
  readonly mcpCount: number
  readonly tasksCount: number
  readonly channels: readonly string[]
}

export interface SourceInspectResultV2 {
  readonly sourcePath: string
  readonly sourceFingerprint: string
  readonly diagnostic: SchemaDiagnostic
  readonly totalWorkspaces: number
  readonly totalConversations: number
  readonly totalMessages: number
  readonly totalExtensions: number
  readonly totalTasks: number
  readonly totalChannels: number
  readonly workspaces: readonly WorkspaceInspectSummaryV2[]
}

export interface UserSnapshotPlan {
  readonly sourceUserId: string
  readonly sourceUsername: string
  readonly targetUserId: string
  readonly targetRole: 'admin' | 'user'
  readonly displayName: string
}

export interface AgentProfileSnapshotPlan {
  readonly sourceProfileId: string
  readonly name: string
  readonly description?: string | null
  readonly systemPromptSnapshot: string
  readonly version: number
  readonly targetProfileId: string
}

export interface SessionMigrationPlan {
  readonly sourceChatJid: string
  readonly title: string
  readonly targetSessionId: string
  readonly targetRouteKey: string
  readonly messageCount: number
  readonly attachmentCount: number
}

export interface SpaceInstructionPlan {
  readonly spaceFolder: string
  readonly sourceFile: string
  readonly instructionType: 'claude_md' | 'memory_md' | 'combined'
  readonly targetPath: string
  readonly contentPreview: string
  readonly byteSize: number
}

export interface UserInstructionPlan {
  readonly sourceFile: string
  readonly instructionType: 'global_claude_md' | 'global_memory_md'
  readonly targetUserId: string
  readonly contentPreview: string
  readonly byteSize: number
}

export interface ExtensionMigrationPlan {
  readonly sourceId: string
  readonly name: string
  readonly slug: string
  readonly kind: 'skill' | 'mcp' | 'cli' | 'dsh-plugin' | 'browser'
  readonly description?: string | null
  readonly sourceKind: 'builtin' | 'archive' | 'git'
  readonly sourceRef?: string | null
  readonly targetPackageSlug: string
  readonly targetContributionKey: string
  readonly status: 'active' | 'disabled'
  readonly quarantined: boolean
  readonly quarantineReason?: string
  readonly spaceBinding: string
}

export interface TaskMigrationPlan {
  readonly sourceTaskId: string
  readonly title: string
  readonly prompt: string
  readonly cronExpression?: string | null
  readonly priority: 'low' | 'normal' | 'high' | 'urgent'
  readonly targetSpaceFolder: string
}

export interface ChannelBindingMigrationPlan {
  readonly sourceBindingId: string
  readonly channelType: 'lark' | 'wechat' | 'web' | string
  readonly nativeContextId: string
  readonly targetSpaceFolder: string
  readonly activationMode: 'mention' | 'always'
  readonly cutoverDeferred: boolean
}

export interface ChannelAccountMigrationPlan {
  readonly sourceAccountId: string
  readonly channelType: 'lark' | 'wechat' | string
  readonly name: string
  readonly status: 'active' | 'disabled' | 'unverified'
  readonly credentialRef: string | null
  readonly hasCredentialAuthorization: boolean
  readonly cutoverDeferred: boolean
}

export interface QuotaMigrationPlan {
  readonly resource: string
  readonly limit: number
  readonly targetUserId: string
}

export interface ModelPrefMigrationPlan {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string | null
  readonly targetUserId: string
}

export interface MigrationV2PlanItem {
  readonly workspaceId: string
  readonly workspaceName: string
  readonly targetSpaceFolder: string
  readonly targetSpaceName: string
  readonly userSnapshots: readonly UserSnapshotPlan[]
  readonly agentProfileSnapshots: readonly AgentProfileSnapshotPlan[]
  readonly sessionPlans: readonly SessionMigrationPlan[]
  readonly instructionPlan: SpaceInstructionPlan | null
  readonly extensionPlans: readonly ExtensionMigrationPlan[]
  readonly taskPlans: readonly TaskMigrationPlan[]
  readonly channelBindingsPlans: readonly ChannelBindingMigrationPlan[]
  readonly quotaPlans: readonly QuotaMigrationPlan[]
  readonly modelPrefPlans: readonly ModelPrefMigrationPlan[]
  readonly warnings: readonly string[]
}

export interface MigrationPlanV2 {
  readonly version: 2
  readonly planId: string
  readonly sourcePath: string
  readonly sourceFingerprint: string
  readonly targetUserId: string
  readonly scopes: MigrationV2Scopes
  readonly selectedWorkspaceIds: readonly string[]
  readonly summary: {
    readonly totalWorkspaces: number
    readonly totalSessions: number
    readonly totalMessages: number
    readonly totalExtensions: number
    readonly totalQuarantinedPlugins: number
    readonly totalTasks: number
    readonly totalChannels: number
    readonly totalCredentialsToTransfer: number
  }
  readonly items: readonly MigrationV2PlanItem[]
  readonly globalInstructions: UserInstructionPlan | null
  readonly channelAccounts: readonly ChannelAccountMigrationPlan[]
  readonly warnings: readonly string[]
  readonly createdAt: string
}

export interface MigrationV2DryRunRequest {
  readonly sourcePath?: string
  readonly stagedId?: string
  readonly sourceGroupsDir?: string
  readonly targetUserId?: string
  readonly selectedWorkspaceIds: readonly string[]
  readonly scopes?: Partial<MigrationV2Scopes>
  readonly titleOverride?: string
  readonly targetSpace?: string
  readonly idempotencyKey?: string
}

export interface MigrationV2DryRunResult {
  readonly success: boolean
  readonly dryRun: true
  readonly plan: MigrationPlanV2
  readonly warnings: readonly string[]
}

// ---------------------------------------------------------------------------
// Credential Authorized Transfer Types
// ---------------------------------------------------------------------------

export interface SourceCredentialCapability {
  readonly capabilityToken: string
  readonly sourceProviderRef: string
  readonly authorizedCredentialIds: readonly string[]
  readonly expiresAt: string
  readonly singleUse: boolean
  readonly issuedBy: string
}

export interface SourceRawCredential {
  readonly credentialId: string
  readonly channelType: 'lark' | 'wechat' | 'generic' | string
  readonly accountId: string
  readonly accountName?: string
  readonly secretPayload: Record<string, unknown>
  readonly requiresReauth?: boolean
}

export interface SourceCredentialReader {
  readCredentials(capability: SourceCredentialCapability): Promise<readonly SourceRawCredential[]>
}

export interface SourceCredentialItemStatus {
  readonly credentialId: string
  readonly channelType: string
  readonly accountId: string
  readonly status: 'transferred' | 'reauthorization_required' | 'skipped' | 'failed'
  readonly targetRefId?: string
  readonly detail?: string
  readonly warnings: readonly string[]
}

export interface CredentialTransferRequest {
  readonly capability: SourceCredentialCapability
  readonly stagedId?: string
  readonly sourcePath?: string
  readonly targetUserId?: string
  readonly connectivityValidation?: boolean
}

export interface CredentialTransferResult {
  readonly success: boolean
  readonly sourceProviderRef: string
  readonly transferredCount: number
  readonly reauthRequiredCount: number
  readonly failedCount: number
  readonly skippedCount: number
  readonly credentials: readonly SourceCredentialItemStatus[]
  readonly transferredAt: string
  readonly warnings: readonly string[]
}

// ---------------------------------------------------------------------------
// Staged Pilot Package V2 Types
// ---------------------------------------------------------------------------

export interface MigrationV2StageManifest {
  readonly version: 2
  readonly planId: string
  readonly sourceFingerprint: string
  readonly importerVersion: string
  readonly targetDsh: string
  readonly packageChecksum: string
  readonly payloadChecksums?: Record<string, string>
  readonly selectedWorkspaceIds: readonly string[]
  readonly scopes: MigrationV2Scopes
  readonly summary: MigrationPlanV2['summary']
  readonly credentialStatusSummary: {
    readonly transferred: number
    readonly reauthorizationRequired: number
  }
  readonly stagedAt: string
}

export interface MigrationV2StageRequest {
  readonly sourcePath?: string
  readonly stagedId?: string
  readonly sourceGroupsDir?: string
  readonly targetUserId?: string
  readonly selectedWorkspaceIds: readonly string[]
  readonly scopes?: Partial<MigrationV2Scopes>
  readonly credentialTransfer?: CredentialTransferResult
  readonly idempotencyKey?: string
}

export interface MigrationV2StageResult {
  readonly success: boolean
  readonly staged: true
  readonly stageDir: string
  readonly planId: string
  readonly packageChecksum: string
  readonly manifest: MigrationV2StageManifest
  readonly summary: MigrationPlanV2['summary']
  readonly stagedAt: string
  readonly warnings: readonly string[]
}

// ---------------------------------------------------------------------------
// Migration V2 Pilot Execution & Cleanup Types
// ---------------------------------------------------------------------------

export interface PilotExecutionStats {
  readonly workspaces: number
  readonly sessions: number
  readonly messages: number
  readonly extensions: number
  readonly quarantinedExtensions: number
  readonly tasks: number
  readonly channelAccounts: number
  readonly channelBindings: number
  readonly files: number
  readonly fileShas: Record<string, string>
}

export interface PilotExecutionResult {
  readonly success: boolean
  readonly planId: string
  readonly targetUserId: string
  readonly stats: PilotExecutionStats
  readonly warnings: readonly string[]
  readonly skippedRealChannelCredentials: readonly string[]
  readonly executedAt: string
}

export interface PilotCleanupResult {
  readonly success: boolean
  readonly planId: string
  readonly deletedCounts: {
    readonly spaces: number
    readonly agentProfiles: number
    readonly sessionRoutes: number
    readonly webMessages: number
    readonly extensions: number
    readonly tasks: number
    readonly channelAccounts: number
    readonly channelBindings: number
    readonly files: number
    readonly receipts: number
    readonly importJobs: number
  }
  readonly cleanedAt: string
}
