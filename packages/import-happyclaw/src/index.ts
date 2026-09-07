/**
 * @enkeep/import-happyclaw
 *
 * Universal migration layer and adapter for HappyClaw SQLite databases to Enkeep DSH seeds and spaces.
 */

// Legacy fixed fixture importer (maintained for backward-compatible test fixtures)
export { importFixedHappyClawFixture } from './run.js'

// Universal Source Adapter & Schema Introspection
export {
  introspectSource,
  KNOWN_HAPPYCLAW_TABLES,
  CORE_REQUIRED_TABLES,
  STANDARD_REQUIRED_TABLES,
} from './introspection.js'

// Safety Guards & Folder Validation
export {
  validateGroupFolder,
  GROUP_FOLDER_PATTERN,
} from './guard.js'

// Source Inspector
export {
  inspectSource,
  formatInspectSummary,
  type InspectSourceOptions,
} from './inspect.js'

// Generic Migration & Fork Engine
export {
  createMigrationPlan,
  executeGenericMigration,
  validateTargetUserId,
} from './migrate.js'

// Deterministic IDs & Seed Compiler
export {
  sessionIdFor,
  deterministicSessionId,
  messageIdFor,
  deterministicSpaceId,
  deterministicSourceProvenanceId,
  folderSlug,
  channelFromJid,
} from './ids.js'

export {
  compileChats,
  compileSeed,
  compareMessages,
  parseTimestamp,
  peopleTalk,
  attachmentNote,
  validateRelativeAttachmentPath,
  type CompileChatsOptions,
} from './seed.js'

// Staging & Manifest Utilities
export {
  buildManifest,
  computeSourceFingerprint,
  IMPORTER_VERSION,
  TARGET_DSH_SPEC,
  SESSION_FORMAT_VERSION,
  ID_ALGORITHM,
} from './manifest.js'

// CLI
export { runCli, parseCliArgs, type ParsedArgs } from './cli.js'

// Types
export type {
  ImportFixedFixtureRequest,
  ImportRequest,
  ImportResult,
  ChatMapping,
  CompiledChat,
  ImportManifest,
  ImportStats,
  ChatReport,
  AnomalyRecord,
  AnomalyType,
  SeedEvent,
  ChatRow,
  GroupRow,
  MessageRow,
  SchemaCompatibilityLevel,
  SchemaDiagnostic,
  ConversationInspectSummary,
  SourceInspectResult,
  GenericMigrateOptions,
  MigrationPlanItem,
  MigrationPlan,
  GenericMigrationResult,
  // Migration V2 Types
  MigrationV2Scopes,
  WorkspaceInspectSummaryV2,
  SourceInspectResultV2,
  UserSnapshotPlan,
  AgentProfileSnapshotPlan,
  SessionMigrationPlan,
  SpaceInstructionPlan,
  UserInstructionPlan,
  ExtensionMigrationPlan,
  TaskMigrationPlan,
  ChannelBindingMigrationPlan,
  ChannelAccountMigrationPlan,
  QuotaMigrationPlan,
  ModelPrefMigrationPlan,
  MigrationV2PlanItem,
  MigrationPlanV2,
  MigrationV2DryRunRequest,
  MigrationV2DryRunResult,
  SourceCredentialCapability,
  SourceRawCredential,
  SourceCredentialReader,
  SourceCredentialItemStatus,
  CredentialTransferRequest,
  CredentialTransferResult,
  MigrationV2StageManifest,
  MigrationV2StageRequest,
  MigrationV2StageResult,
  PilotExecutionStats,
  PilotExecutionResult,
  PilotCleanupResult,
} from './types.js'

export { DEFAULT_MIGRATION_V2_SCOPES } from './types.js'

// Migration V2 Engine, Inspection, Credentials, Staging & Fixtures
export {
  inspectSourceV2,
  createMigrationPlanV2,
  computeDeterministicPlanId,
} from './v2/plan-v2.js'

export {
  validateCredentialCapability,
  executeCredentialAuthorizedTransfer,
  EphemeralCredentialVaultEncryptor,
  FakeSourceCredentialReader,
} from './v2/credential-transfer.js'

export { stageMigrationPackageV2 } from './v2/staging-v2.js'

export {
  executePilotMigrationV2,
  deletePilotMigrationV2,
  verifyStagedPackageIntegrity,
  type ExecutePilotOptions,
  type CleanupPilotOptions,
} from './v2/pilot-v2.js'

export {
  createSyntheticV2Fixture,
  type SyntheticFixtureResult,
} from './v2/fixtures-v2.js'


