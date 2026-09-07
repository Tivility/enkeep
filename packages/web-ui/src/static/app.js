/**
 * Enkeep Web UI Frontend Application Logic
 *
 * Implements:
 * - CSP-compliant DOM rendering (zero unsafe markup injections, zero inline styles, textContent only)
 * - Hash routing with role-aware navigation and protection
 * - Admin & Self management console endpoints
 * - Session turn history inspector
 * - Workspace / Chat preservation with polling lifecycle management
 */

import {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  SUPPORTED_THEMES,
  DEFAULT_THEME,
  catalogs,
  t as i18nT,
  interpolate,
  setLocale,
  getLocale,
  detectLocale,
  initI18n,
  translateDom,
  syncLanguageControls,
  syncThemeControls,
  getMissingKeyCount,
} from './i18n.js';

// Comprehensive dictionary for Management Console i18n (en & zh-CN)
const MANAGEMENT_LOCALES = {
  en: {
    // Nav & Breadcrumbs
    'management.navLabel': 'Management',
    'management.breadcrumb': 'Management',
    'management.breadcrumbOverview': 'Management / Overview',
    'management.breadcrumbSection': 'Management / {tab} / {section}',
    'management.tabRuntime': 'Runtime',
    'management.tabWorkspaces': 'Workspaces',
    'management.tabStorage': 'Storage',
    'management.tabUsers': 'Users',
    'management.tabModels': 'Models',
    'section.runtime.runtime.label': 'Runtime Engine',
    'section.runtime.runtime.desc': 'Container runner status and sandbox telemetry',
    'section.runtime.userRuntime.label': 'My Runtime',
    'section.runtime.userRuntime.desc': 'User container sandbox and DSH engine status',
    'section.runtime.plugins.label': 'Plugins',
    'section.runtime.plugins.desc': 'Cordis plugins and tool execution enclaves',
    'section.runtime.tasks.label': 'Tasks',
    'section.runtime.tasks.desc': 'Async execution tasks and worker queues',
    'section.runtime.security.label': 'Security Posture',
    'section.runtime.security.desc': 'CSP, CSRF, and isolation policies',
    'section.workspaces.spacesSessions.label': 'Spaces & Sessions',
    'section.workspaces.spacesSessions.desc': 'Cluster workspace spaces and session metrics',
    'section.workspaces.instructions.label': 'Space Instructions',
    'section.workspaces.instructions.desc': 'Workspace rules and system prompt instructions (AGENTS.md / CLAUDE.md)',
    'section.workspaces.profiles.label': 'Agent Profiles',
    'section.workspaces.profiles.desc': 'Agent personas, behavioral guidelines and versions',
    'section.workspaces.extensions.label': 'Extension Center',
    'section.workspaces.extensions.desc': 'Installed extensions, skill packages, Git/archive installation, and diffs',
    'section.workspaces.channels.label': 'Channels',
    'section.workspaces.channels.desc': 'Lark / Feishu account references, space bindings, and activation modes',
    'channels.groupTrigger': 'Group trigger',
    'channels.groupTriggerHint': 'Direct chats are unaffected; saving also applies to groups this bot has already joined.',
    'channels.groupTriggerModeMention': 'Reply only when @mentioned',
    'channels.groupTriggerModeAlways': 'Reply to all group messages',
    'channels.groupTriggerSaved': 'Group trigger saved',
    'channels.groupTriggerSaveFailed': 'Failed to update group trigger',
    'section.workspaces.deliveries.label': 'Delivery Pipeline',
    'section.workspaces.deliveries.desc': 'Inbound delivery receipts and dispatch status',
    'section.storage.files.label': 'Files Workbench',
    'section.storage.files.desc': 'Container volume file explorer and editor',
    'section.storage.quotas.label': 'Quotas',
    'section.storage.quotas.desc': 'Resource usage limits and concurrency rules',
    'section.storage.imports.label': 'Imports',
    'section.storage.imports.desc': 'Imported historical workspace seeds',
    'section.storage.reconcile.label': 'Storage Reconcile',
    'section.storage.reconcile.desc': 'Dual-storage consistency scan and repair',
    'section.users.users.label': 'Users & Access',
    'section.users.users.desc': 'Tenant accounts, roles, and status control',
    'section.users.audit.label': 'Activity Audit',
    'section.users.audit.desc': 'Security audit trail and access logs',
    'section.users.account.label': 'Account Settings',
    'section.users.account.desc': 'Personal credentials and security',
    'section.models.modelConfig.label': 'Model Configuration',
    'section.models.modelConfig.desc': 'LLM provider routing and overrides',
    'section.models.userModelConfig.label': 'Available Models',
    'section.models.userModelConfig.desc': 'Read-only inspection of active model providers',
    'section.models.modelUsage.label': 'Model Usage',
    'section.models.modelUsage.desc': 'Token metering and model quota breakdown',

    // Overview
    'overview.adminTitle': 'Admin Dashboard',
    'overview.adminSubtitle': 'Global cluster overview, tenant metrics, and health status',
    'overview.userTitle': 'Console Overview',
    'overview.userSubtitle': 'Operational status, key metrics, and workspace telemetry',
    'overview.kpiTotalUsers': 'Total Users',
    'overview.kpiTotalSpaces': 'Total Spaces',
    'overview.kpiTotalSessions': 'Total Sessions',
    'overview.kpiTotalMessages': 'Total Messages',
    'overview.kpiPlatformTasks': 'Platform Tasks',
    'overview.kpiDeliveryPipeline': 'Delivery Pipeline',
    'overview.kpiStorageImports': 'Storage / Imports',
    'overview.kpiRuntimeEngine': 'Runtime Engine',
    'overview.kpiToolExecution': 'Tool Execution',
    'overview.kpiUptime': 'System Uptime',
    'overview.kpiUserIdentity': 'User Identity',
    'overview.kpiActiveSpaces': 'Active Spaces',
    'overview.kpiActiveSessions': 'Active Sessions',
    'overview.kpiSystemMode': 'System Mode',
    'overview.accountSummaryTitle': 'Account Summary',
    'overview.signedInAs': 'Signed in as {name} ({role})',
    'overview.unavailableTitle': 'Overview Telemetry Unavailable',
    'overview.unavailableDesc': 'The management overview service is currently unreachable or uninitialized. Status cannot be verified.',
    'overview.adminUnavailableTitle': 'Admin Dashboard Unavailable',
    'overview.adminUnavailableDesc': 'The admin dashboard service (/api/admin/dashboard) is unavailable.',

    // Runtime & Plugins
    'runtime.userTitle': 'My Runtime Engine',
    'runtime.userSubtitle': 'Personal container sandbox execution status and telemetry',
    'runtime.adminTitle': 'Runtime Engine',
    'runtime.adminSubtitle': 'Container runner status, ephemeral Docker sandbox, and execution telemetry',
    'runtime.serviceUnavailableTitle': 'Runtime Service Unavailable',
    'runtime.serviceUnavailableDesc': 'Your container runtime sandbox is currently uninitialized or unreachable.',
    'runtime.adminServiceUnavailableDesc': 'The runtime management endpoint (/api/admin/runtime) is unavailable or uninitialized.',
    'runtime.kpiStatus': 'Runtime Status',
    'runtime.kpiCoreEngine': 'DSH Core Engine',
    'runtime.kpiToolSchemas': 'Tool Schemas',
    'runtime.kpiToolExecution': 'Tool Execution',
    'runtime.kpiTotalRuntimes': 'Total Runtimes',
    'runtime.kpiToolsOperational': 'Tools Operational',
    'runtime.kpiNetwork': 'Network Isolation',
    'runtime.sectionSandboxDetails': 'Sandbox Isolation Details',
    'runtime.sectionContainerSandboxes': 'Container Sandboxes',
    'runtime.labelUserAccount': 'User Account: {user}',
    'runtime.labelNetworkMode': 'Network Mode: {mode}',
    'runtime.toolWarning': 'Tool Execution Warning: {reason}',
    'runtime.colUserId': 'User ID',
    'runtime.colCoreStatus': 'Core Status',
    'runtime.colDshReady': 'DSH Ready',
    'runtime.colToolSchemas': 'Tool Schemas',
    'runtime.colToolExecution': 'Tool Execution',
    'runtime.colNetwork': 'Network',
    'runtime.colActions': 'Actions',
    'runtime.btnRestart': 'Restart',
    'runtime.actionRestart': 'Restart',
    'runtime.restarting': 'Restarting...',
    'runtime.confirmRestartTitle': 'Confirm Container Restart',
    'runtime.confirmRestartMessage': 'Are you sure you want to restart runtime container for user {userId}? In-flight turns and active execution will be interrupted.',
    'runtime.restartSuccess': 'Container for user {userId} restarted successfully.',
    'runtime.restartPartial': 'Runtime container restart finished with warnings: {details}',
    'runtime.restartFailed': 'Failed to restart container: {error}',
    'plugins.title': 'Plugins Registry',
    'plugins.subtitle': 'Active extensions, custom tool bundles, and external connectors',
    'plugins.sectionTitle': 'Enkeep Cordis Plugin Enclaves',
    'plugins.unavailableTitle': 'Plugins Registry Unavailable',
    'plugins.unavailableDesc': 'The plugins endpoint (/api/admin/plugins) is unavailable. Status: Unavailable.',
    'plugins.noTelemetry': 'No Runtime Telemetry',
    'plugins.noTelemetryDesc': 'Zero runtime instances reported by the runtime provider.',
    'plugins.colBundle': 'Bundle Loaded',
    'plugins.colDshReady': 'DSH Ready',
    'plugins.colToolSchemas': 'Tool Schemas',
    'plugins.colToolExecution': 'Tool Execution',
    'plugins.colPlugins': 'Cordis Plugins (7)',
    'plugins.colStatus': 'Status',
    'plugins.toolsDegraded': 'Degraded / Offline',

    // Tasks
    'tasks.title': 'Tasks',
    'tasks.subtitle': 'Async execution tasks, background jobs, and worker queues',
    'tasks.unavailableTitle': 'Tasks Service Unavailable',
    'tasks.unavailableDesc': 'The tasks service is currently unavailable.',
    'tasks.kpiProducer': 'Task Producer',
    'tasks.kpiWorker': 'Task Worker',
    'tasks.kpiQueued': 'Queued Tasks',
    'tasks.createCardTitle': '+ Create Scheduled Agent Prompt Task',
    'tasks.formTitle': 'Task Title *',
    'tasks.formTitlePlaceholder': 'e.g. Run daily code hygiene check',
    'tasks.formSession': 'Target Active Session *',
    'tasks.formPrompt': 'Agent Prompt *',
    'tasks.formPromptPlaceholder': 'Enter instruction for the agent to execute...',
    'tasks.formPriority': 'Priority',
    'tasks.formDueDate': 'Due Date (Optional)',
    'tasks.btnSchedule': 'Schedule Task',
    'tasks.btnRunNow': 'Run Now',
    'tasks.btnCancel': 'Cancel',
    'tasks.emptyTitle': 'No Task Records',
    'tasks.emptyDesc': 'No task records were returned for this account.',
    'tasks.noActiveSessions': 'No active container sessions found',
    'tasks.tableTitle': 'Platform Tasks Stream',
    'tasks.colId': 'Task ID',
    'tasks.colTitle': 'Title',
    'tasks.colStatus': 'Status',
    'tasks.colPriority': 'Priority',
    'tasks.colDueDate': 'Due Date',
    'tasks.colCreatedAt': 'Created At',
    'tasks.colActions': 'Actions',

    // Profiles
    'profiles.title': 'Agent Profiles',
    'profiles.subtitle': 'Versioned system prompt governance, space bindings, and runtime personas',
    'profiles.unavailableTitle': 'Agent Profiles Unavailable',
    'profiles.unavailableDesc': 'The agent profiles service (/api/manage/agent-profiles) is currently unreachable or uninitialized.',
    'profiles.lifecycleNotice': 'Lifecycle Rule: Agent profile version changes only apply to newly created session generations. Existing sessions remain permanently pinned to their generation snapshot.',
    'profiles.bindingTitle': 'Space Profile Binding',
    'profiles.bindingSubtitle': 'Bind an agent profile persona to a multi-tenant space',
    'profiles.btnBind': 'Bind Profile to Space',
    'profiles.btnCreateProfile': '+ Create Profile',
    'profiles.btnNewVersion': '+ New Version',
    'profiles.btnRollback': 'Rollback',
    'profiles.rollingBack': 'Rolling back...',
    'profiles.btnViewVersions': 'History',
    'profiles.emptyTitle': 'No Agent Profiles',
    'profiles.emptyDesc': 'No agent profiles have been created yet. Create a profile to govern agent personas and system prompt versions.',
    'profiles.noSpaces': 'No spaces available',
    'profiles.noProfiles': 'No profiles created',
    'profiles.colName': 'Name',
    'profiles.colActiveVersion': 'Active Version',
    'profiles.colStatus': 'Status',
    'profiles.colCreatedAt': 'Created At',
    'profiles.colActions': 'Actions',
    'profiles.statusActiveVersion': 'Active',
    'profiles.confirmRollbackTitle': 'Confirm Profile Version Rollback',
    'profiles.confirmRollbackMessage': "Rolling back to Version {targetVersion} will create a new Version (N+1) with this snapshot configuration. Existing sessions will not be modified automatically; you must perform 'Reset Generation' on sessions to apply the new profile version. Are you sure you want to proceed?",
    'profiles.rollbackSuccess': 'Profile rolled back successfully. Created new active Version v{version}.',
    'profiles.rollbackFailed': 'Failed to rollback profile version: {error}',

    // Deliveries
    'delivery.title': 'Delivery Pipeline',
    'delivery.subtitle': 'Inbound delivery inbox receipts, dispatch status, and route metadata',
    'delivery.unavailableTitle': 'Delivery Pipeline Unavailable',
    'delivery.unavailableDesc': 'The delivery pipeline service is currently unavailable.',
    'delivery.emptyTitle': 'No Delivery Receipts',
    'delivery.emptyDesc': 'No delivery history recorded for this tenant.',
    'delivery.colStatus': 'Status',
    'delivery.colReceivedAt': 'Received At',
    'delivery.colUpdatedAt': 'Updated At',

    // Files
    'files.title': 'Files Workbench',
    'files.subtitle': 'Safe container-volume browser and file manager for isolated workspaces',
    'files.noSpaceTitle': 'No Active Space Available',
    'files.noSpaceDesc': 'No active workspace spaces found. Please create or select an active space to access files.',
    'files.labelSpace': 'Space:',
    'files.badgeVolume': 'Tenant volume / {space}',
    'files.btnNewFolder': '+ New Folder',
    'files.btnNewFile': '+ New File',
    'files.btnUpload': 'Upload Files',
    'files.btnCancelUpload': 'Cancel',
    'files.btnDownload': 'Download',
    'files.btnDownloadFile': 'Download {name}',
    'files.btnDownloadSelected': 'Download File',
    'files.cannotDownloadDir': 'Directories cannot be downloaded.',
    'files.crumbRoot': 'Root (/)',
    'files.colName': 'Name',
    'files.colType': 'Type',
    'files.colSize': 'Size',
    'files.colModified': 'Modified',
    'files.colActions': 'Actions',
    'files.btnEdit': 'Edit',
    'files.btnDelete': 'Delete',
    'files.parentFolder': '.. (Go to Parent Folder)',
    'files.emptyDir': 'Empty Directory',
    'files.emptyDirSub': 'No files or directories found in this container space volume.',
    'files.editorTitle': 'File Editor',
    'files.btnSave': 'Save File',
    'files.btnClose': 'Close Editor',
    'files.conflictWarning': 'Conflict: File was modified by another operation. Reload before saving.',
    'files.confirmOverwrite': 'File "{name}" already exists. Do you want to overwrite it?',
    'files.confirmOverwriteTitle': 'Confirm File Overwrite',
    'files.dragDropActive': 'Drop files here to upload to {path}',
    'files.dragDropZone': 'Drag & drop files here, or click Upload above',
    'files.runtimeUnavailable': 'The container runtime for space "{space}" is not currently running or available. Start the runtime to access files.',
    'files.spaceArchived': 'The workspace space is archived and file operations are unavailable.',
    'files.operationFailed': 'Failed to access container volume files.',
    'files.noFileSelected': 'No File Selected',
    'files.noFileSelectedSub': 'Select a file from the directory tree on the left to view or edit UTF-8 content.',
    'files.uploadProgress': 'Uploading "{name}": {percent}%',
    'files.uploadSuccess': 'Uploaded "{name}" successfully.',
    'files.uploadFailed': 'Failed to upload "{name}": {error}',
    'files.uploadCancelled': 'Upload cancelled for "{name}".',
    'files.uploadInProgress': 'Uploading {current} of {total} files...',
    'files.batchUploadComplete': 'Uploaded {count} file(s) successfully.',

    // Quotas & Reconcile
    'quotas.title': 'Resource Quotas',
    'quotas.subtitle': 'Concurrency limits, space storage allocations, and turn thresholds',
    'quotas.unavailableTitle': 'Quotas Service Unavailable',
    'quotas.unavailableDesc': 'The resource quotas service is currently unavailable.',
    'quotas.kpiLimits': 'Configured Limits',
    'quotas.kpiReservations': 'Active Reservations',
    'quotas.kpiUsages': 'Monitored Usages',
    'quotas.adminControlsTitle': 'Admin Quota Controls',
    'quotas.adminControlsSubtitle': 'Configure explicit resource limits for the 5 fixed metrics: tokens, messages, turns, storage_bytes, api_calls',
    'quotas.btnOpenEdit': '+ Set / Update Metric Limit',
    'quotas.emptyTitle': 'No Quotas Configured',
    'quotas.emptyDesc': 'No specific resource quotas or limits have been configured for this account.',
    'quotas.sectionAllocations': 'Quota Allocations',
    'quotas.colUser': 'User / Scope',
    'quotas.colMetric': 'Metric / Resource',
    'quotas.colLimit': 'Limit',
    'quotas.colUpdatedAt': 'Updated At',
    'quotas.colActions': 'Actions',
    'reconcile.title': 'Storage Consistency & Reconciliation',
    'reconcile.subtitle': 'Dual-storage consistency verification between SQLite web_messages and runtime DSH JSONL',
    'reconcile.unavailableTitle': 'Reconciliation Service Unavailable',
    'reconcile.unavailableDesc': 'The storage reconciliation endpoint (/api/admin/storage/reconcile) is unreachable.',
    'reconcile.kpiScanned': 'Total Sessions Scanned',
    'reconcile.kpiMatched': 'Matched Sessions',
    'reconcile.kpiDrift': 'Drift Detected',
    'reconcile.kpiMissing': 'Missing in SQLite',
    'reconcile.sectionReports': 'Session Reconciliation Reports',
    'reconcile.colSessionId': 'Session ID',
    'reconcile.colStatus': 'Consistency Status',
    'reconcile.colDsh': 'DSH JSONL Messages',
    'reconcile.colSqlite': 'SQLite Messages',
    'reconcile.colDifferences': 'Discrepancies & Drift',
    'reconcile.colVerifiedAt': 'Verified At',
    'reconcile.colActions': 'Actions',
    'reconcile.emptyTitle': 'No Reconciliation Records',
    'reconcile.emptyDesc': 'No session reconciliation logs were found.',
    'reconcile.btnScanBaseline': 'Scan Baseline',
    'reconcile.scanningBaseline': 'Scanning Baseline...',
    'reconcile.confirmBaselineTitle': 'Scan Storage Baseline',
    'reconcile.confirmBaselineMessage': 'Scan tenant container volume to discover baseline storage usage and update quota usage. Continue?',
    'reconcile.scanBaselineSuccess': 'Storage baseline scan complete ({bytes} across {files} files).',
    'reconcile.scanBaselineFailed': 'Failed to scan storage baseline: {error}',
    'reconcile.btnPreviewRepair': 'Repair',
    'reconcile.btnConfirmRepair': 'Execute Repair',
    'reconcile.btnCancel': 'Cancel',
    'reconcile.repairing': 'Repairing...',
    'reconcile.previewModalTitle': 'Storage Repair Preview & Confirmation',
    'reconcile.previewModalDesc': 'Reconciliation preview analyzed discrepancies between SQLite and runtime JSONL authority. Review repair plan before proceeding:',
    'reconcile.previewCountMissing': 'Missing Messages to Backfill: {count}',
    'reconcile.previewCountContent': 'Mismatched Messages to Update: {count}',
    'reconcile.previewCountOrphan': 'Orphan Messages in SQLite: {count}',
    'reconcile.optDeleteOrphans': 'Delete orphan SQLite messages (Permanent)',
    'reconcile.optDeleteOrphansWarning': 'Warning: Orphan messages present in SQLite but missing in DSH runtime JSONL will be permanently removed.',
    'reconcile.repairSuccess': 'Storage repaired successfully ({count} records reconciled).',
    'reconcile.repairFailed': 'Failed to repair storage: {error}',
    'reconcile.discConsistent': 'Consistent',
    'reconcile.discMissing': '{count} Missing in SQLite',
    'reconcile.discOrphan': '{count} Orphan in SQLite',
    'reconcile.discContent': '{count} Content Mismatch',
    'reconcile.discRole': '{count} Role Mismatch',

    // Users & Audit
    'users.title': 'Users & Access Control',
    'users.subtitle': 'Manage tenant accounts, roles, access statuses, and session revocation',
    'users.btnCreateUser': '➕ Create User',
    'users.unavailableTitle': 'User Management Unavailable',
    'users.unavailableDesc': 'The user management endpoint (/api/admin/users) is unreachable.',
    'users.colUsername': 'Username',
    'users.colDisplayName': 'Display Name',
    'users.colRole': 'Role',
    'users.colStatus': 'Status',
    'users.colStats': 'Spaces / Sessions',
    'users.colActions': 'Actions',
    'users.btnEdit': 'Edit',
    'users.btnResetPwd': 'Reset Pwd',
    'users.btnRevokeSessions': 'Revoke Sessions',
    'users.confirmRevokeTitle': 'Revoke Active Sessions',
    'users.confirmRevokeMsg': 'Revoke all active login sessions for user "{username}"? The user will be logged out immediately.',
    'users.confirmMutationTitle': 'Confirm User Mutation',
    'users.confirmMutationMsg': 'Apply changes to user {userId}? (Role: {role}, Status: {status}, Display Name: {displayName})',
    'audit.title': 'Activity & Audit Log',
    'audit.subtitle': 'Security events, mutations, access history, and session lifecycles',
    'audit.unavailableTitle': 'Audit Log Unavailable',
    'audit.unavailableDesc': 'The activity audit log service is currently unavailable.',
    'audit.emptyTitle': 'No Activity Records',
    'audit.emptyDesc': 'No security or lifecycle audit events recorded.',
    'audit.colTimestamp': 'Timestamp',
    'audit.colActor': 'Actor',
    'audit.colAction': 'Action',
    'audit.colClient': 'IP / Client',

    // Imports & Spaces
    'imports.title': 'Import Registry',
    'imports.subtitle': 'Imported historical workspaces, messages, and external session seeds',
    'imports.unavailableTitle': 'Import Registry Unavailable',
    'imports.unavailableDesc': 'The import registry service is currently unreachable.',
    'imports.emptyTitle': 'No Imports Found',
    'imports.emptyDesc': 'No external datasets or fixtures have been imported.',
    'imports.colUser': 'User',
    'imports.colVersion': 'Importer Version',
    'imports.colStatus': 'Status',
    'imports.colMessages': 'Messages (Imported / Source)',
    'imports.colAttachments': 'Attachments',
    'imports.colImportedAt': 'Imported At',
    'imports.wizardTitle': 'Staged HappyClaw Migration',
    'imports.wizardSubtitle': 'Step-by-step migration from operator-staged HappyClaw SQLite databases',
    'imports.stepSelect': '1. Select Database',
    'imports.stepInspect': '2. Inspect & Filter',
    'imports.stepTarget': '3. Target & Plan',
    'imports.stepMigrate': '4. Migrate',
    'imports.stepComplete': '5. Completed',
    'imports.guidanceTitle': 'Operator Staging Guidance',
    'imports.guidanceDesc': 'Place SQLite database files into the configured staging directory on the host, or upload a .db file below.',
    'imports.noStagedFound': 'No staged databases found in staging directories.',
    'imports.uploadDb': 'Upload Database (.db)',
    'imports.btnUpload': 'Upload',
    'imports.btnRefresh': 'Refresh Staged Files',
    'imports.btnNextInspect': 'Next: Inspect Database',
    'imports.btnNextTarget': 'Next: Target & Dry-Run',
    'imports.btnBack': 'Back',
    'imports.btnRunDryRun': 'Run Dry-Run Preview',
    'imports.btnStartMigration': 'Start Migration',
    'imports.btnCancelMigration': 'Cancel Migration',
    'imports.btnImportAnother': 'Import Another Database',
    'imports.attachmentNotice': 'Notice: Text transcripts and metadata will be migrated directly. Binary attachments referenced in chats will not be copied automatically unless files exist in space folders on host.',
    'imports.schemaCompatibility': 'Compatibility',
    'imports.schemaVersion': 'Schema Version',
    'imports.totalChats': 'Total Conversations',
    'imports.totalMessages': 'Total Messages',
    'imports.totalAttachments': 'Total Attachments',
    'imports.searchPlaceholder': 'Search by title, key, or folder...',
    'imports.selectAll': 'Select All ({count})',
    'imports.deselectAll': 'Deselect All',
    'imports.selectedCount': '{count} selected',
    'imports.colChat': 'Conversation',
    'imports.colChannel': 'Channel',
    'imports.colFolder': 'Folder',
    'imports.colMsgCount': 'Messages',
    'imports.colDateRange': 'Date Range',
    'imports.colWarnings': 'Warnings',
    'imports.targetUser': 'Target User ID',
    'imports.targetSpace': 'Target Space Name (Optional)',
    'imports.titleOverride': 'Session Title Override (Optional)',
    'imports.dryRunSummaryTitle': 'Dry-Run Migration Plan',
    'imports.planSpacesToCreate': 'Spaces to Create: {count}',
    'imports.planRoutesToCreate': 'Session Routes to Create: {count}',
    'imports.planSeedEvents': 'Estimated Seed Events: {count}',
    'imports.migratingInProgress': 'Migration in progress...',
    'imports.migratingDesc': 'Dual-writing records, creating spaces, session routes, and message history...',
    'imports.successTitle': 'Migration Completed Successfully',
    'imports.successDesc': 'Imported {chats} conversations and {messages} messages into platform spaces.',
    'imports.importedSessionsTitle': 'Imported Spaces & Sessions',
    'imports.openInChat': 'Open in Chat',
    'imports.historyTitle': 'Import Receipts & History',
    'imports.modeStandard': 'Standard V1 (Chats)',
    'imports.modePilotV2': 'Pilot V2 (Workspaces & Scopes)',
    'imports.pilotV2Title': 'Migration Pilot V2',
    'imports.pilotV2Subtitle': 'Scoped workspace-level pilot migration (P1-7 readiness, zero real cutover)',
    'imports.scopeCoreData': 'Core Data (Users, Space, Profiles, Chats, Messages)',
    'imports.scopeExtensions': 'Extensions (Skills, MCP, Plugins with Auto-Quarantine)',
    'imports.scopeTasks': 'Scheduled Tasks',
    'imports.scopeChannelsMetadata': 'Channel Metadata (Lark/WeChat Contexts - Cutover Deferred)',
    'imports.scopeCredentials': 'Credential Transfer (One-Time Capability Auth)',
    'imports.workspacesSelected': '{count} Workspaces Selected',
    'imports.btnRunPilotDryRun': 'Run Pilot V2 Dry-Run',
    'imports.btnStagePilotPackage': 'Stage Pilot Package (P1-8 Ready)',
    'imports.btnExecutePilot': 'Execute Pilot Migration',
    'imports.btnDeletePilotData': 'Delete Pilot Data',
    'imports.pilotExecSuccess': 'Pilot migration executed successfully',
    'imports.pilotDeleteSuccess': 'Pilot migration data cleaned up successfully',
    'imports.btnAuthorizeCredentials': 'Authorize & Encrypt Credentials',
    'imports.stageSuccessTitle': 'Pilot Package Staged Successfully',
    'imports.stageSuccessDesc': 'Immutable staged package created with verified checksum. Ready for P1-8 pilot execution. Live database was not mutated.',
    'imports.quarantinedBadge': 'Quarantined (Security Policy)',
    'imports.credentialAuthStatus': 'Credential Transfer Status',
    'imports.btnNextInspectV2': 'Next: Inspect Workspaces (V2)',
    'imports.colWorkspaces': 'Workspaces',
    'imports.scopeSummaryTitle': 'Pilot Scope Selector',
    'imports.btnNextPlan': 'Next: Target & Dry-Run Plan',
    'spaces.title': 'Spaces & Sessions',
    'spaces.subtitle': 'Cluster workspace spaces, execution containers, and aggregate tenant metrics',
    'spaces.unavailableTitle': 'Spaces Service Unavailable',
    'spaces.unavailableDesc': 'Endpoint /api/admin/spaces is currently unavailable.',
    'spaces.emptyTitle': 'No Spaces Registered',
    'spaces.emptyDesc': 'No workspace spaces found in the platform database.',
    'spaces.colOwner': 'Owner',
    'spaces.colName': 'Space Name',
    'spaces.colSessions': 'Sessions',
    'spaces.colCreatedAt': 'Created At',
    'spaces.executionMode': 'Execution Mode',
    'spaces.migrationRequired': 'Migration required',
    'spaces.modeDocker': 'Docker',
    'spaces.modeHost': 'Host',
    'modal.executionModeLabel': 'Execution Mode',
    'modal.execModeDocker': 'Docker (Default)',
    'modal.execModeHost': 'Host (High Risk)',
    'modal.execModeHostDesc': 'runs on platform host with controlled Enkeep workspace;not arbitrary mount yet;admin only',
    'modal.hostConfirmTitle': 'High Risk Confirmation',
    'modal.hostConfirmMessage': 'Host execution mode runs on platform host with controlled Enkeep workspace (not arbitrary mount yet; admin only). Are you sure you want to proceed?',
    'runtime.colMode': 'Mode',
    'runtime.modeDocker': 'Docker',
    'runtime.modeHost': 'Host',

    // Security & Account
    'security.title': 'Security & Posture',
    'security.subtitle': 'CSP enforcement, CSRF origin verification, and tenant isolation policies',
    'security.unavailableTitle': 'Security Telemetry Unavailable',
    'security.unavailableDesc': 'The security management endpoint (/api/admin/security) is unavailable.',
    'security.kpiCsrf': 'CSRF Shield',
    'security.kpiHost': 'Host Isolation',
    'security.kpiMigrations': 'Migrations',
    'account.title': 'Account & Security Settings',
    'account.subtitle': 'Manage personal credentials and security',
    'account.unavailableTitle': 'Account Unavailable',
    'account.unavailableDesc': 'No user profile found. Please sign in again.',
    'account.profileTitle': 'Account Profile',
    'account.securityTitle': 'Security & Password',
    'account.currentPwdLabel': 'Current Password *',
    'account.newPwdLabel': 'New Password *',
    'account.confirmPwdLabel': 'Confirm New Password *',
    'account.btnChangePwd': 'Update Password',

    // Models
    'models.adminTitle': 'Model Configuration Control Plane',
    'models.adminSubtitle': 'Manage default model routing and inspection of configured LLM providers',
    'models.userTitle': 'Available Models',
    'models.userSubtitle': 'Inspection of platform model providers and reasoning capabilities available for your workspace',
    'models.unavailableTitle': 'Model Configuration Unavailable',
    'models.unavailableDesc': 'The model configuration endpoint (/api/admin/model-config) is unreachable.',
    'models.userUnavailableTitle': 'Model Service Status Unavailable',
    'models.userUnavailableDesc': 'Model routing status is currently unreachable.',
    'models.kpiActiveDefault': 'Active Default Model',
    'models.kpiDshDefault': 'DSH Base Default',
    'models.kpiProvidersCount': 'Providers Count',
    'models.badgeOverride': 'Active Platform Override',
    'models.badgeInherit': 'Inheriting DSH Default',
    'models.overrideSectionTitle': 'Override Default Model',
    'models.labelProvider': 'Provider *',
    'models.labelModel': 'Model *',
    'models.labelRevision': 'Revision: {revision}',
    'models.labelApplyMode': 'Apply Mode',
    'models.applyModeRestartAll': 'Save & Rolling Restart All Runtimes (Recommended)',
    'models.applyModeSaveOnly': 'Save Configuration Only (Restart Later)',
    'models.btnSaveOverride': 'Save Platform Override',
    'models.btnResetOverride': 'Reset to DSH Default',
    'models.saving': 'Saving & Applying...',
    'models.saveSuccess': 'Model configuration saved and applied ({count} runtimes restarted)',
    'models.savePartial': 'Configuration saved, but some runtimes failed to restart: {details}',
    'models.saveFailed': 'Configuration saved, but runtime restart failed: {details}',
    'models.saveSkipped': 'Model configuration saved (restart skipped)',
    'models.providersTableTitle': 'Discovered Providers & Credential Status',
    'models.colProviderId': 'Provider ID',
    'models.colDisplayName': 'Display Name',
    'models.colProtocol': 'Protocol API',
    'models.colConfigured': 'Configured Status',
    'models.colModels': 'Available Models',
    'models.statusConfigured': 'Configured',
    'models.statusNoToken': 'no token',
    'models.usageTitle': 'Model Usage & Token Metering',
    'models.usageSubtitle': 'Resource consumption, token metering, and chat execution quota telemetry',
    'models.usageUnavailableTitle': 'Usage Telemetry Unavailable',
    'models.usageUnavailableDesc': 'The model usage and quota telemetry service is unreachable.',
    'models.kpiTokenConsumption': 'Token Consumption',
    'models.kpiMessageVolume': 'Message Volume',
    'models.kpiExecutionTurns': 'Execution Turns',
    'models.kpiApiInvocations': 'API Invocations',
    'models.meteringActiveTitle': 'Model Metering Active',
    'models.meteringActiveDesc': 'Platform token metering and usage quotas are enforced across all sessions.',
    'turns.colStarted': 'Started',
    'turns.colFinished': 'Finished',
  },
  'zh-CN': {
    // Nav & Breadcrumbs
    'management.navLabel': '管理',
    'management.breadcrumb': '管理',
    'management.breadcrumbOverview': '管理 / 概览',
    'management.breadcrumbSection': '管理 / {tab} / {section}',
    'management.tabRuntime': '运行时',
    'management.tabWorkspaces': '工作区',
    'management.tabStorage': '存储',
    'management.tabUsers': '用户',
    'management.tabModels': '模型',
    'section.runtime.runtime.label': '运行时引擎',
    'section.runtime.runtime.desc': '容器运行器状态与沙箱遥测',
    'section.runtime.userRuntime.label': '我的运行时',
    'section.runtime.userRuntime.desc': '用户容器沙箱与 DSH 引擎状态',
    'section.runtime.plugins.label': '插件中心',
    'section.runtime.plugins.desc': 'Cordis 插件与工具执行隔离区',
    'section.runtime.tasks.label': '任务流水',
    'section.runtime.tasks.desc': '异步执行任务与工作队列',
    'section.runtime.security.label': '安全态势',
    'section.runtime.security.desc': 'CSP、CSRF 与隔离策略',
    'section.workspaces.spacesSessions.label': '空间与会话',
    'section.workspaces.spacesSessions.desc': '集群工作区空间与会话指标',
    'section.workspaces.instructions.label': '空间提示词指令',
    'section.workspaces.instructions.desc': '工作区规则与系统提示词规范文件 (AGENTS.md / CLAUDE.md)',
    'section.workspaces.profiles.label': '智能体画像',
    'section.workspaces.profiles.desc': '智能体人设、行为准则与版本治理',
    'section.workspaces.extensions.label': '扩展中心',
    'section.workspaces.extensions.desc': '已安装扩展、技能包、Git/归档安装与差异比对',
    'section.workspaces.channels.label': '通信渠道',
    'section.workspaces.channels.desc': '飞书/Lark 渠道账号凭据引用、空间绑定与唤醒模式',
    'channels.groupTrigger': '群聊触发方式',
    'channels.groupTriggerHint': '私聊不受影响；保存后同步应用到该机器人已加入的群。',
    'channels.groupTriggerModeMention': '仅 @ 机器人时回复',
    'channels.groupTriggerModeAlways': '监听群内所有消息',
    'channels.groupTriggerSaved': '群聊触发方式已保存',
    'channels.groupTriggerSaveFailed': '保存群聊触发方式失败',
    'section.workspaces.deliveries.label': '投递流水线',
    'section.workspaces.deliveries.desc': '入站投递回执与分发状态',
    'section.storage.files.label': '文件工作台',
    'section.storage.files.desc': '容器卷文件资源管理器与编辑器',
    'section.storage.quotas.label': '配额治理',
    'section.storage.quotas.desc': '资源使用限制与并发规则',
    'section.storage.imports.label': '数据导入',
    'section.storage.imports.desc': '导入的历史工作区种子数据',
    'section.storage.reconcile.label': '存储对账',
    'section.storage.reconcile.desc': '双存储一致性扫描与修复',
    'section.users.users.label': '用户与权限',
    'section.users.users.desc': '租户账户、角色与状态管控',
    'section.users.audit.label': '活动审计',
    'section.users.audit.desc': '安全审计追踪与访问日志',
    'section.users.account.label': '账户设置',
    'section.users.account.desc': '个人凭据与安全配置',
    'section.models.modelConfig.label': '模型配置',
    'section.models.modelConfig.desc': '大语言模型提供商路由与覆盖设置',
    'section.models.userModelConfig.label': '可用模型',
    'section.models.userModelConfig.desc': '活跃模型提供商只读巡检',
    'section.models.modelUsage.label': '模型用量',
    'section.models.modelUsage.desc': 'Token 计量与模型配额明细',

    // Overview
    'overview.adminTitle': '管理员仪表盘',
    'overview.adminSubtitle': '全局集群概览、租户指标与健康状态',
    'overview.userTitle': '控制台概览',
    'overview.userSubtitle': '运行状态、核心指标与工作区遥测',
    'overview.kpiTotalUsers': '用户总数',
    'overview.kpiTotalSpaces': '空间总数',
    'overview.kpiTotalSessions': '会话总数',
    'overview.kpiTotalMessages': '消息总数',
    'overview.kpiPlatformTasks': '平台任务',
    'overview.kpiDeliveryPipeline': '投递流水线',
    'overview.kpiStorageImports': '存储 / 导入种子',
    'overview.kpiRuntimeEngine': '运行时引擎',
    'overview.kpiToolExecution': '工具执行',
    'overview.kpiUptime': '系统运行时间',
    'overview.kpiUserIdentity': '用户身份',
    'overview.kpiActiveSpaces': '活跃空间',
    'overview.kpiActiveSessions': '活跃会话',
    'overview.kpiSystemMode': '系统模式',
    'overview.accountSummaryTitle': '账户信息摘要',
    'overview.signedInAs': '已登录为 {name} ({role})',
    'overview.unavailableTitle': '概览遥测数据不可用',
    'overview.unavailableDesc': '管理概览服务当前不可用或未初始化，无法校验状态。',
    'overview.adminUnavailableTitle': '管理员仪表盘不可用',
    'overview.adminUnavailableDesc': '管理员仪表盘服务 (/api/admin/dashboard) 当前不可用。',

    // Runtime & Plugins
    'runtime.userTitle': '我的运行时引擎',
    'runtime.userSubtitle': '个人容器沙箱执行状态与遥测',
    'runtime.adminTitle': '运行时引擎',
    'runtime.adminSubtitle': '容器运行器状态、临时 Docker 沙箱与执行遥测',
    'runtime.serviceUnavailableTitle': '运行时服务不可用',
    'runtime.serviceUnavailableDesc': '您的个人容器运行时沙箱当前未初始化或无法连接。',
    'runtime.adminServiceUnavailableDesc': '运行时管理端点 (/api/admin/runtime) 不可用或未初始化。',
    'runtime.kpiStatus': '运行时状态',
    'runtime.kpiCoreEngine': 'DSH 核心引擎',
    'runtime.kpiToolSchemas': '工具 Schema',
    'runtime.kpiToolExecution': '工具执行状态',
    'runtime.kpiTotalRuntimes': '运行时总数',
    'runtime.kpiToolsOperational': '可用工具数',
    'runtime.kpiNetwork': '网络隔离模式',
    'runtime.sectionSandboxDetails': '沙箱隔离详情',
    'runtime.sectionContainerSandboxes': '容器沙箱列表',
    'runtime.labelUserAccount': '用户账户: {user}',
    'runtime.labelNetworkMode': '网络模式: {mode}',
    'runtime.toolWarning': '工具执行警告: {reason}',
    'runtime.colUserId': '用户 ID',
    'runtime.colCoreStatus': '核心状态',
    'runtime.colDshReady': 'DSH 就绪',
    'runtime.colToolSchemas': '工具 Schema',
    'runtime.colToolExecution': '工具执行',
    'runtime.colNetwork': '网络模式',
    'runtime.colActions': '操作',
    'runtime.btnRestart': '重启',
    'runtime.actionRestart': '重启',
    'runtime.restarting': '正在重启...',
    'runtime.confirmRestartTitle': '确认重启容器',
    'runtime.confirmRestartMessage': '确定要重启用户 {userId} 的运行时容器吗？正在进行的轮次与执行将被中断。',
    'runtime.restartSuccess': '用户 {userId} 的运行时容器已成功重启。',
    'runtime.restartPartial': '运行时容器重启完成但存在警告: {details}',
    'runtime.restartFailed': '容器重启失败: {error}',
    'plugins.title': '插件注册表',
    'plugins.subtitle': '活动扩展、自定义工具包与外部连接器',
    'plugins.sectionTitle': 'Enkeep Cordis 插件隔离区',
    'plugins.unavailableTitle': '插件注册表不可用',
    'plugins.unavailableDesc': '插件注册表端点 (/api/admin/plugins) 当前不可用。状态: 不可用。',
    'plugins.noTelemetry': '暂无运行时遥测数据',
    'plugins.noTelemetryDesc': '运行时提供程序报告了 0 个活动实例。',
    'plugins.colBundle': 'Bundle 加载状态',
    'plugins.colDshReady': 'DSH 就绪',
    'plugins.colToolSchemas': '工具 Schema',
    'plugins.colToolExecution': '工具执行',
    'plugins.colPlugins': 'Cordis 插件 (7)',
    'plugins.colStatus': '状态',
    'plugins.toolsDegraded': '降级 / 离线',

    // Tasks
    'tasks.title': '任务流水',
    'tasks.subtitle': '异步执行任务、后台作业与工作队列',
    'tasks.unavailableTitle': '任务服务不可用',
    'tasks.unavailableDesc': '任务服务当前不可用。',
    'tasks.kpiProducer': '任务生成器',
    'tasks.kpiWorker': '任务执行器',
    'tasks.kpiQueued': '排队任务数',
    'tasks.createCardTitle': '+ 创建定时智能体 Prompt 任务',
    'tasks.formTitle': '任务标题 *',
    'tasks.formTitlePlaceholder': '例如：执行每日代码规范检查',
    'tasks.formSession': '目标活跃会话 *',
    'tasks.formPrompt': '智能体指令 Prompt *',
    'tasks.formPromptPlaceholder': '输入供智能体执行的指令内容...',
    'tasks.formPriority': '优先级',
    'tasks.formDueDate': '截止日期（可选）',
    'tasks.btnSchedule': '提交调度任务',
    'tasks.btnRunNow': '立即执行',
    'tasks.btnCancel': '取消任务',
    'tasks.emptyTitle': '暂无任务记录',
    'tasks.emptyDesc': '当前账户暂无任何任务记录。',
    'tasks.noActiveSessions': '未找到活跃容器会话',
    'tasks.tableTitle': '平台任务流水列表',
    'tasks.colId': '任务 ID',
    'tasks.colTitle': '任务标题',
    'tasks.colStatus': '状态',
    'tasks.colPriority': '优先级',
    'tasks.colDueDate': '截止日期',
    'tasks.colCreatedAt': '创建时间',
    'tasks.colActions': '操作',

    // Profiles
    'profiles.title': '智能体画像治理',
    'profiles.subtitle': '版本化系统 Prompt 治理、空间绑定与运行时人设',
    'profiles.unavailableTitle': '智能体画像服务不可用',
    'profiles.unavailableDesc': '智能体画像服务 (/api/manage/agent-profiles) 当前不可用或未初始化。',
    'profiles.lifecycleNotice': '生命周期规则：智能体画像版本变更仅对新创建的会话代际生效；既有会话永久锁定在其创建时的代际快照。',
    'profiles.bindingTitle': '空间画像绑定',
    'profiles.bindingSubtitle': '将智能体画像人设绑定至多租户空间',
    'profiles.btnBind': '绑定画像至空间',
    'profiles.btnCreateProfile': '+ 创建画像',
    'profiles.btnNewVersion': '+ 发布新版本',
    'profiles.btnRollback': '回滚',
    'profiles.rollingBack': '正在回滚...',
    'profiles.btnViewVersions': '版本历史',
    'profiles.emptyTitle': '暂无智能体画像',
    'profiles.emptyDesc': '尚未创建任何智能体画像。创建画像可治理智能体人设及系统 Prompt 版本。',
    'profiles.noSpaces': '暂无可用空间',
    'profiles.noProfiles': '尚未创建画像',
    'profiles.colName': '画像名称',
    'profiles.colActiveVersion': '生效版本',
    'profiles.colStatus': '状态',
    'profiles.colCreatedAt': '创建时间',
    'profiles.colActions': '操作',
    'profiles.statusActiveVersion': '当前生效',
    'profiles.confirmRollbackTitle': '确认回滚画像版本',
    'profiles.confirmRollbackMessage': '回滚至版本 {targetVersion} 将基于该快照创建新的生效版本（N+1）。历史已存在的会话不会被自动修改；您需要在会话中执行“重置代际 (Reset Generation)”以应用新画像版本。确定要继续吗？',
    'profiles.rollbackSuccess': '画像版本回滚成功，已创建新版本 v{version}。',
    'profiles.rollbackFailed': '画像版本回滚失败: {error}',

    // Deliveries
    'delivery.title': '投递流水线',
    'delivery.subtitle': '入站投递回执与分发状态',
    'delivery.unavailableTitle': '投递流水线不可用',
    'delivery.unavailableDesc': '投递流水线服务当前不可用。',
    'delivery.emptyTitle': '暂无投递回执',
    'delivery.emptyDesc': '当前租户暂无投递历史记录。',
    'delivery.colStatus': '状态',
    'delivery.colReceivedAt': '接收时间',
    'delivery.colUpdatedAt': '更新时间',

    // Files
    'files.title': '文件工作台',
    'files.subtitle': '隔离工作区的安全容器卷文件浏览器与管理器',
    'files.noSpaceTitle': '暂无可用空间',
    'files.noSpaceDesc': '未找到活跃工作区空间。请创建或选择一个活跃空间以访问文件。',
    'files.labelSpace': '空间:',
    'files.badgeVolume': '租户独立存储卷 / {space}',
    'files.btnNewFolder': '+ 新建文件夹',
    'files.btnNewFile': '+ 新建文件',
    'files.btnUpload': '上传文件',
    'files.btnCancelUpload': '取消',
    'files.btnDownload': '下载',
    'files.btnDownloadFile': '下载 {name}',
    'files.btnDownloadSelected': '下载文件',
    'files.cannotDownloadDir': '目录不支持直接下载。',
    'files.crumbRoot': '根目录 (/)',
    'files.colName': '名称',
    'files.colType': '类型',
    'files.colSize': '大小',
    'files.colModified': '修改时间',
    'files.colActions': '操作',
    'files.btnEdit': '编辑',
    'files.btnDelete': '删除',
    'files.parentFolder': '.. (返回上级目录)',
    'files.emptyDir': '目录为空',
    'files.emptyDirSub': '此容器空间卷中未找到任何文件或目录。',
    'files.editorTitle': '文件编辑器',
    'files.btnSave': '保存文件',
    'files.btnClose': '关闭编辑器',
    'files.conflictWarning': '冲突：文件已被其他操作修改，请重新加载后再保存。',
    'files.confirmOverwrite': '文件 "{name}" 已存在。是否覆盖该文件？',
    'files.confirmOverwriteTitle': '确认覆盖文件',
    'files.dragDropActive': '释放文件以上传至 {path}',
    'files.dragDropZone': '拖拽文件至此处，或点击上方“上传文件”',
    'files.runtimeUnavailable': '空间 "{space}" 的容器运行时当前未运行或不可用。启动运行时后即可访问文件。',
    'files.spaceArchived': '该工作区空间已归档，文件操作不可用。',
    'files.operationFailed': '访问容器卷文件失败。',
    'files.noFileSelected': '未选择任何文件',
    'files.noFileSelectedSub': '请从左侧目录树中选择一个文件以查看或编辑 UTF-8 文本内容。',
    'files.uploadProgress': '正在上传 "{name}": {percent}%',
    'files.uploadSuccess': '成功上传 "{name}"。',
    'files.uploadFailed': '上传 "{name}" 失败: {error}',
    'files.uploadCancelled': '已取消上传 "{name}"。',
    'files.uploadInProgress': '正在上传 {current} / {total} 个文件...',
    'files.batchUploadComplete': '成功上传 {count} 个文件。',

    // Quotas & Reconcile
    'quotas.title': '资源配额治理',
    'quotas.subtitle': '并发限制、空间存储容量分配与轮次阈值',
    'quotas.unavailableTitle': '配额服务不可用',
    'quotas.unavailableDesc': '资源配额服务当前不可用。',
    'quotas.kpiLimits': '已配置限制数',
    'quotas.kpiReservations': '活动预占数',
    'quotas.kpiUsages': '监控用量数',
    'quotas.adminControlsTitle': '管理员配额管控',
    'quotas.adminControlsSubtitle': '为 5 项核心指标配置显式资源限制：tokens、messages、turns、storage_bytes、api_calls',
    'quotas.btnOpenEdit': '+ 设置 / 更新配额限制',
    'quotas.emptyTitle': '未配置特定配额',
    'quotas.emptyDesc': '当前账户尚未配置任何特定资源配额或限制。',
    'quotas.sectionAllocations': '配额分配列表',
    'quotas.colUser': '用户 / 范围',
    'quotas.colMetric': '指标 / 资源',
    'quotas.colLimit': '配额上限',
    'quotas.colUpdatedAt': '更新时间',
    'quotas.colActions': '操作',
    'reconcile.title': '存储一致性与对账',
    'reconcile.subtitle': 'SQLite web_messages 与运行时 DSH JSONL 双存储一致性校验',
    'reconcile.unavailableTitle': '对账服务不可用',
    'reconcile.unavailableDesc': '存储对账端点 (/api/admin/storage/reconcile) 无法连接。',
    'reconcile.kpiScanned': '已扫描会话总数',
    'reconcile.kpiMatched': '一致会话数',
    'reconcile.kpiDrift': '偏差会话数',
    'reconcile.kpiMissing': 'SQLite 缺失数',
    'reconcile.sectionReports': '会话对账报告',
    'reconcile.colSessionId': '会话 ID',
    'reconcile.colStatus': '一致性状态',
    'reconcile.colDsh': 'DSH JSONL 消息数',
    'reconcile.colSqlite': 'SQLite 消息数',
    'reconcile.colDifferences': '偏差明细',
    'reconcile.colVerifiedAt': '校验时间',
    'reconcile.colActions': '操作',
    'reconcile.emptyTitle': '暂无对账记录',
    'reconcile.emptyDesc': '未找到会话对账日志。',
    'reconcile.btnScanBaseline': '扫描基准用量',
    'reconcile.scanningBaseline': '正在扫描基准...',
    'reconcile.confirmBaselineTitle': '扫描存储基准',
    'reconcile.confirmBaselineMessage': '扫描租户容器卷以发现基准存储用量并更新配额。是否继续？',
    'reconcile.scanBaselineSuccess': '存储基准扫描完成 (共 {bytes}，{files} 个文件)。',
    'reconcile.scanBaselineFailed': '扫描存储基准失败: {error}',
    'reconcile.btnPreviewRepair': '修复',
    'reconcile.btnConfirmRepair': '执行修复',
    'reconcile.btnCancel': '取消',
    'reconcile.repairing': '正在修复...',
    'reconcile.previewModalTitle': '存储对账修复预览与确认',
    'reconcile.previewModalDesc': '对账预览已比对 SQLite 与运行时 JSONL 权威数据。请在执行前确认修复方案：',
    'reconcile.previewCountMissing': '待回填缺失消息数: {count}',
    'reconcile.previewCountContent': '待更新内容偏差消息数: {count}',
    'reconcile.previewCountOrphan': 'SQLite 孤立消息数: {count}',
    'reconcile.optDeleteOrphans': '清理 SQLite 孤立消息 (永久删除)',
    'reconcile.optDeleteOrphansWarning': '警告：仅存在于 SQLite 但在 DSH 运行时 JSONL 中缺失的孤立消息将被永久物理删除。',
    'reconcile.repairSuccess': '存储一致性修复成功 (共修复 {count} 条记录)。',
    'reconcile.repairFailed': '存储对账修复失败: {error}',
    'reconcile.discConsistent': '一致',
    'reconcile.discMissing': '{count} 条 SQLite 缺失',
    'reconcile.discOrphan': '{count} 条 SQLite 孤立',
    'reconcile.discContent': '{count} 条内容不一致',
    'reconcile.discRole': '{count} 条角色不一致',

    // Users & Audit
    'users.title': '用户与权限管控',
    'users.subtitle': '管理租户账户、角色、访问状态与会话吊销',
    'users.btnCreateUser': '➕ 创建用户',
    'users.unavailableTitle': '用户管理不可用',
    'users.unavailableDesc': '用户管理端点 (/api/admin/users) 无法连接。',
    'users.colUsername': '用户名',
    'users.colDisplayName': '显示名称',
    'users.colRole': '角色',
    'users.colStatus': '状态',
    'users.colStats': '空间 / 会话',
    'users.colActions': '操作',
    'users.btnEdit': '编辑',
    'users.btnResetPwd': '重置密码',
    'users.btnRevokeSessions': '吊销会话',
    'users.confirmRevokeTitle': '吊销活动会话',
    'users.confirmRevokeMsg': '是否吊销用户 "{username}" 的所有活动登录会话？目标用户将被立即强制登出。',
    'users.confirmMutationTitle': '确认修改用户属性',
    'users.confirmMutationMsg': '是否对用户 {userId} 应用修改？(角色: {role}, 状态: {status}, 显示名称: {displayName})',
    'audit.title': '活动审计日志',
    'audit.subtitle': '安全审计追踪与访问日志',
    'audit.unavailableTitle': '审计日志不可用',
    'audit.unavailableDesc': '活动审计日志服务当前不可用。',
    'audit.emptyTitle': '暂无活动记录',
    'audit.emptyDesc': '未记录任何安全或生命周期审计事件。',
    'audit.colTimestamp': '时间戳',
    'audit.colActor': '操作人',
    'audit.colAction': '操作动作',
    'audit.colClient': 'IP / 客户端',

    // Imports & Spaces
    'imports.title': '导入注册表',
    'imports.subtitle': '导入的历史工作区种子数据',
    'imports.unavailableTitle': '导入注册表不可用',
    'imports.unavailableDesc': '导入注册表服务当前无法连接。',
    'imports.emptyTitle': '未找到导入记录',
    'imports.emptyDesc': '尚未导入任何外部数据集或固件。',
    'imports.colUser': '用户',
    'imports.colVersion': '导入器版本',
    'imports.colStatus': '状态',
    'imports.colMessages': '消息（导入 / 原始）',
    'imports.colAttachments': '附件数',
    'imports.colImportedAt': '导入时间',
    'imports.wizardTitle': '受控迁移向导',
    'imports.wizardSubtitle': '分步迁移受控暂存的 HappyClaw 数据库',
    'imports.stepSelect': '1. 选择数据库',
    'imports.stepInspect': '2. 检查与筛选',
    'imports.stepTarget': '3. 目标与规划',
    'imports.stepMigrate': '4. 执行迁移',
    'imports.stepComplete': '5. 完成',
    'imports.guidanceTitle': '暂存区放置指引',
    'imports.guidanceDesc': '请将 SQLite 数据库文件放置在服务器配置的暂存目录中，或在下方上传 .db 文件。',
    'imports.noStagedFound': '暂存目录中未找到任何待迁移的数据库文件。',
    'imports.uploadDb': '上传数据库 (.db)',
    'imports.btnUpload': '上传',
    'imports.btnRefresh': '刷新暂存列表',
    'imports.btnNextInspect': '下一步：检查数据库',
    'imports.btnNextTarget': '下一步：配置目标与演练',
    'imports.btnBack': '返回上一步',
    'imports.btnRunDryRun': '运行演练预览',
    'imports.btnStartMigration': '开始迁移',
    'imports.btnCancelMigration': '取消迁移',
    'imports.btnImportAnother': '迁移其他数据库',
    'imports.attachmentNotice': '提示：将直接迁移文字会话和元数据。会话中引用的二进制附件不会直接迁移，除非主机空间目录中存在对应文件。',
    'imports.schemaCompatibility': '兼容级别',
    'imports.schemaVersion': '架构版本',
    'imports.totalChats': '会话总数',
    'imports.totalMessages': '消息总数',
    'imports.totalAttachments': '附件总数',
    'imports.searchPlaceholder': '按标题、标识或文件夹搜索...',
    'imports.selectAll': '全选 ({count})',
    'imports.deselectAll': '取消全选',
    'imports.selectedCount': '已选择 {count} 个',
    'imports.colChat': '会话',
    'imports.colChannel': '渠道',
    'imports.colFolder': '目录',
    'imports.colMsgCount': '消息数',
    'imports.colDateRange': '时间范围',
    'imports.colWarnings': '诊断警告',
    'imports.targetUser': '目标用户 ID',
    'imports.targetSpace': '目标空间名称（可选）',
    'imports.titleOverride': '会话标题覆盖（可选）',
    'imports.dryRunSummaryTitle': '演练迁移计划',
    'imports.planSpacesToCreate': '将创建的工作区空间：{count}',
    'imports.planRoutesToCreate': '将创建的会话路由：{count}',
    'imports.planSeedEvents': '预计种子事件数：{count}',
    'imports.migratingInProgress': '正在执行迁移，请稍候...',
    'imports.migratingDesc': '正在写入空间、会话路由和历史消息记录...',
    'imports.successTitle': '数据迁移已成功完成',
    'imports.successDesc': '已成功将 {chats} 个会话和 {messages} 条消息导入至平台空间。',
    'imports.importedSessionsTitle': '已导入的空间与会话',
    'imports.openInChat': '在聊天中打开',
    'imports.historyTitle': '导入历史记录与凭证',
    'imports.modeStandard': '标准 V1（会话级别）',
    'imports.modePilotV2': '试点 V2（工作区与作用域）',
    'imports.pilotV2Title': '迁移试点 V2',
    'imports.pilotV2Subtitle': '受控工作区级别试点迁移（P1-7 演练与凭据转移，不切流真实渠道）',
    'imports.scopeCoreData': '核心数据（用户、空间、画像、会话、消息）',
    'imports.scopeExtensions': '扩展包（Skill、MCP、自动隔离不可信插件）',
    'imports.scopeTasks': '定时任务',
    'imports.scopeChannelsMetadata': '渠道元数据（飞书/微信绑定，试点期不切流）',
    'imports.scopeCredentials': '授权凭据转移（单次 Capability 鉴权）',
    'imports.workspacesSelected': '已选择 {count} 个工作区',
    'imports.btnRunPilotDryRun': '执行试点 V2 演练',
    'imports.btnStagePilotPackage': '暂存试点数据包（供 P1-8 试点执行）',
    'imports.btnExecutePilot': '执行试点迁移',
    'imports.btnDeletePilotData': '清理试点数据',
    'imports.pilotExecSuccess': '试点迁移执行成功',
    'imports.pilotDeleteSuccess': '试点迁移数据已彻底清理',
    'imports.btnAuthorizeCredentials': '授权并加密转移凭据',
    'imports.stageSuccessTitle': '试点数据包暂存就绪',
    'imports.stageSuccessDesc': '不可变暂存数据包已生成并校验指纹，供 P1-8 试点执行。未修改实时数据库。',
    'imports.quarantinedBadge': '已隔离（安全策略）',
    'imports.credentialAuthStatus': '凭据转移状态',
    'imports.btnNextInspectV2': '下一步：检查工作区 (V2)',
    'imports.colWorkspaces': '工作区',
    'imports.scopeSummaryTitle': '试点作用域选择器',
    'imports.btnNextPlan': '下一步：目标与演练规划',
    'spaces.title': '空间与会话',
    'spaces.subtitle': '集群工作区空间与会话指标',
    'spaces.unavailableTitle': '空间服务不可用',
    'spaces.unavailableDesc': '端点 /api/admin/spaces 当前不可用。',
    'spaces.emptyTitle': '未注册任何空间',
    'spaces.emptyDesc': '平台数据库中未找到任何工作区空间。',
    'spaces.colOwner': '所有者',
    'spaces.colName': '空间名称',
    'spaces.colSessions': '会话数',
    'spaces.colCreatedAt': '创建时间',
    'spaces.executionMode': '执行模式',
    'spaces.migrationRequired': '需要迁移',
    'spaces.modeDocker': 'Docker',
    'spaces.modeHost': 'Host',
    'modal.executionModeLabel': '执行模式',
    'modal.execModeDocker': 'Docker（默认）',
    'modal.execModeHost': 'Host（高风险）',
    'modal.execModeHostDesc': '运行在平台宿主机受控 Enkeep 工作区；暂不支持任意挂载；仅限管理员。',
    'modal.hostConfirmTitle': '高风险操作确认',
    'modal.hostConfirmMessage': '宿主机执行模式将直接在平台宿主机上运行受控 Enkeep 工作区（暂不支持任意挂载；仅限管理员）。确定要继续吗？',
    'runtime.colMode': '运行模式',
    'runtime.modeDocker': 'Docker',
    'runtime.modeHost': 'Host',

    // Security & Account
    'security.title': '安全态势',
    'security.subtitle': 'CSP、CSRF 与隔离策略',
    'security.unavailableTitle': '安全遥测不可用',
    'security.unavailableDesc': '安全管理端点 (/api/admin/security) 当前不可用。',
    'security.kpiCsrf': 'CSRF 防护',
    'security.kpiHost': '主机隔离',
    'security.kpiMigrations': '数据库迁移',
    'account.title': '账户与安全设置',
    'account.subtitle': '个人凭据与安全配置',
    'account.unavailableTitle': '账户信息不可用',
    'account.unavailableDesc': '未找到用户配置文件，请重新登录。',
    'account.profileTitle': '个人信息',
    'account.securityTitle': '安全与修改密码',
    'account.currentPwdLabel': '当前密码 *',
    'account.newPwdLabel': '新密码 *',
    'account.confirmPwdLabel': '确认新密码 *',
    'account.btnChangePwd': '更新密码',

    // Models
    'models.adminTitle': '模型配置控制面',
    'models.adminSubtitle': '管理默认模型路由及已配置 LLM 提供商巡检',
    'models.userTitle': '可用模型服务',
    'models.userSubtitle': '巡检工作区可用的平台模型提供商与推理能力',
    'models.unavailableTitle': '模型配置不可用',
    'models.unavailableDesc': '模型配置端点 (/api/admin/model-config) 无法连接。',
    'models.userUnavailableTitle': '模型服务状态不可用',
    'models.userUnavailableDesc': '模型路由状态当前无法连接。',
    'models.kpiActiveDefault': '当前默认模型',
    'models.kpiDshDefault': 'DSH 底层默认模型',
    'models.kpiProvidersCount': '提供商数量',
    'models.badgeOverride': '平台覆盖生效中',
    'models.badgeInherit': '继承 DSH 底层默认',
    'models.overrideSectionTitle': '覆盖默认模型设置',
    'models.labelProvider': '提供商 *',
    'models.labelModel': '模型 *',
    'models.labelRevision': '配置版本: {revision}',
    'models.labelApplyMode': '生效策略',
    'models.applyModeRestartAll': '保存并滚动重启所有运行时容器 (推荐)',
    'models.applyModeSaveOnly': '仅保存配置 (稍后手动重启)',
    'models.btnSaveOverride': '保存平台模型覆盖',
    'models.btnResetOverride': '恢复为 DSH 默认设置',
    'models.saving': '正在保存并生效...',
    'models.saveSuccess': '模型配置已保存并生效 (已滚动重启 {count} 个运行时)',
    'models.savePartial': '配置已保存，但部分运行时重启失败: {details}',
    'models.saveFailed': '配置已保存，但运行时容器重启失败: {details}',
    'models.saveSkipped': '模型配置已保存 (跳过重启)',
    'models.providersTableTitle': '已发现提供商与凭据状态',
    'models.colProviderId': '提供商 ID',
    'models.colDisplayName': '显示名称',
    'models.colProtocol': '协议 API',
    'models.colConfigured': '配置状态',
    'models.colModels': '可用模型',
    'models.statusConfigured': '已配置',
    'models.statusNoToken': '未配置 Token',
    'models.usageTitle': '模型用量与 Token 计量',
    'models.usageSubtitle': '资源消耗、Token 计量与会话执行配额遥测',
    'models.usageUnavailableTitle': '用量遥测不可用',
    'models.usageUnavailableDesc': '模型用量与配额遥测服务无法连接。',
    'models.kpiTokenConsumption': 'Token 消耗量',
    'models.kpiMessageVolume': '消息吞吐量',
    'models.kpiExecutionTurns': '执行轮次数',
    'models.kpiApiInvocations': 'API 调用次数',
    'models.meteringActiveTitle': '模型计量已启用',
    'models.meteringActiveDesc': '平台已在所有会话中执行 Token 计量与用量配额。',
    'turns.colStarted': '开始时间',
    'turns.colFinished': '结束时间',
  },
};

/**
 * Enhanced translation helper that falls back gracefully across catalogs and management dictionary.
 */
function t(key, params = null, fallback = undefined) {
  if (typeof key !== 'string' || key.length === 0) {
    return '';
  }
  const loc = getLocale() === 'zh-CN' ? 'zh-CN' : 'en';

  // 1. Check catalogs from i18n.js first
  const activeCatalog = catalogs[loc] || catalogs.en || {};
  if (activeCatalog[key] !== undefined) {
    return i18nT(key, params);
  }

  // 2. Check MANAGEMENT_LOCALES dictionary
  const mgmtDict = MANAGEMENT_LOCALES[loc] || MANAGEMENT_LOCALES.en || {};
  if (mgmtDict[key] !== undefined) {
    return interpolate(mgmtDict[key], params);
  }

  // Fallback to English in management dictionary
  if (MANAGEMENT_LOCALES.en && MANAGEMENT_LOCALES.en[key] !== undefined) {
    return interpolate(MANAGEMENT_LOCALES.en[key], params);
  }

  // 3. Fallback parameter if provided
  if (fallback !== undefined) {
    return interpolate(fallback, params);
  }

  // 4. Default to i18nT
  return i18nT(key, params);
}

/**
 * Shared internationalized Date formatter using active locale.
 */
function formatDate(date, options = null) {
  if (!date) return '-';
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '-';
  const loc = getLocale() === 'zh-CN' ? 'zh-CN' : 'en-US';
  try {
    return new Intl.DateTimeFormat(loc, options || {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

/**
 * Shared internationalized Number formatter using active locale.
 */
function formatNumber(num, options = null) {
  if (num === null || num === undefined || isNaN(Number(num))) return '0';
  const loc = getLocale() === 'zh-CN' ? 'zh-CN' : 'en-US';
  try {
    return new Intl.NumberFormat(loc, options || undefined).format(Number(num));
  } catch {
    return String(num);
  }
}

/**
 * Shared internationalized Bytes formatter using active locale.
 */
function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || isNaN(Number(bytes))) return '0 B';
  const n = Number(bytes);
  if (n === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(k));
  const idx = Math.min(i, sizes.length - 1);
  const val = (n / Math.pow(k, idx)).toFixed(idx === 0 ? 0 : 1);
  return `${val} ${sizes[idx]}`;
}

/**
 * Capture unsaved form input values across a container.
 */
function captureFormState(root) {
  const target = root || (typeof document !== 'undefined' ? document : null);
  if (!target || typeof target.querySelectorAll !== 'function') return {};
  const stateMap = {};
  const fields = target.querySelectorAll('input:not([type="hidden"]), select, textarea');
  fields.forEach((f) => {
    const key = f.id || f.name;
    if (key) {
      if (f.type === 'checkbox' || f.type === 'radio') {
        stateMap[key] = f.checked;
      } else {
        stateMap[key] = f.value;
      }
    }
  });
  return stateMap;
}

/**
 * Restore previously captured form input values to a container.
 */
function restoreFormState(root, savedState) {
  const target = root || (typeof document !== 'undefined' ? document : null);
  if (!target || !savedState || typeof target.querySelectorAll !== 'function') return;
  const fields = target.querySelectorAll('input:not([type="hidden"]), select, textarea');
  fields.forEach((f) => {
    const key = f.id || f.name;
    if (key && Object.prototype.hasOwnProperty.call(savedState, key)) {
      const val = savedState[key];
      if (f.type === 'checkbox' || f.type === 'radio') {
        f.checked = Boolean(val);
      } else {
        f.value = val;
      }
    }
  });
}

/**
 * Translation mapping for role, status, action, and metric enums.
 */
const ENUM_TRANSLATION_MAP = {
  role: {
    admin: { en: 'Admin', 'zh-CN': '管理员' },
    user: { en: 'Member', 'zh-CN': '普通成员' },
    member: { en: 'Member', 'zh-CN': '普通成员' },
  },
  executionMode: {
    container: { en: 'Docker', 'zh-CN': 'Docker' },
    host: { en: 'Host', 'zh-CN': 'Host' },
  },
  mode: {
    container: { en: 'Docker', 'zh-CN': 'Docker' },
    host: { en: 'Host', 'zh-CN': 'Host' },
  },
  status: {
    active: { en: 'Active', 'zh-CN': '正常' },
    disabled: { en: 'Disabled', 'zh-CN': '已禁用' },
    ok: { en: 'Available', 'zh-CN': '正常可用' },
    available: { en: 'Available', 'zh-CN': '正常可用' },
    healthy: { en: 'Healthy', 'zh-CN': '健康正常' },
    degraded: { en: 'Degraded', 'zh-CN': '降级运行' },
    error: { en: 'Error', 'zh-CN': '异常错误' },
    unavailable: { en: 'Unavailable', 'zh-CN': '不可用' },
    ready: { en: 'Ready', 'zh-CN': '已就绪' },
    not_ready: { en: 'Not Ready', 'zh-CN': '未就绪' },
    running: { en: 'Running', 'zh-CN': '运行中' },
    idle: { en: 'Idle', 'zh-CN': '空闲中' },
    pending: { en: 'Pending', 'zh-CN': '等待中' },
    claimed: { en: 'Claimed', 'zh-CN': '已认领' },
    processing: { en: 'Processing', 'zh-CN': '处理中' },
    completed: { en: 'Completed', 'zh-CN': '已完成' },
    failed: { en: 'Failed', 'zh-CN': '已失败' },
    quota_exceeded: { en: 'Quota Exceeded', 'zh-CN': '配额耗尽' },
    recovery_required: { en: 'Recovery Required', 'zh-CN': '必需重置恢复' },
    execution_failed: { en: 'Execution Failed', 'zh-CN': '执行失败' },
    retry_required: { en: 'Retry Required', 'zh-CN': '需要重试' },
    turn_timeout: { en: 'Turn Timeout', 'zh-CN': '轮次超时' },
    lease_lost: { en: 'Lease Lost', 'zh-CN': '租约丢失' },
    cancelled: { en: 'Cancelled', 'zh-CN': '已取消' },
    delivered: { en: 'Delivered', 'zh-CN': '已投递' },
    held: { en: 'Held', 'zh-CN': '积压中' },
    duplicate: { en: 'Duplicate', 'zh-CN': '重复忽略' },
    matched: { en: 'Matched', 'zh-CN': '完全一致' },
    drift: { en: 'Drift', 'zh-CN': '存在偏差' },
    missing: { en: 'Missing', 'zh-CN': '记录缺失' },
    archived: { en: 'Archived', 'zh-CN': '已归档' },
    operational: { en: 'Operational', 'zh-CN': '正常运行' },
    settled: { en: 'Settled', 'zh-CN': '已结算' },
    loaded: { en: 'Loaded', 'zh-CN': '已加载' },
    'not loaded': { en: 'Not Loaded', 'zh-CN': '未加载' },
    closed: { en: 'Healthy (Closed)', 'zh-CN': '健康 (闭合)' },
    open: { en: 'Tripped (Open)', 'zh-CN': '熔断开启 (跳闸)' },
    'half-open': { en: 'Testing (Half-Open)', 'zh-CN': '试探检测 (半开)' },
    deadletter: { en: 'Deadletter', 'zh-CN': '死信' },
    'allowed-once': { en: 'Allowed Once', 'zh-CN': '已允许本次' },
    rejected: { en: 'Rejected', 'zh-CN': '已拒绝' },
    debug: { en: 'Debug', 'zh-CN': '调试' },
    info: { en: 'Info', 'zh-CN': '信息' },
    warn: { en: 'Warning', 'zh-CN': '警告' },
  },
  action: {
    'login': { en: 'Sign In', 'zh-CN': '用户登录' },
    'logout': { en: 'Sign Out', 'zh-CN': '用户登出' },
    'user.create': { en: 'Create User', 'zh-CN': '创建用户' },
    'user.update': { en: 'Update User', 'zh-CN': '更新用户' },
    'user.password_reset': { en: 'Reset Password', 'zh-CN': '重置密码' },
    'user.password_change': { en: 'Change Password', 'zh-CN': '修改密码' },
    'user.revoke_sessions': { en: 'Revoke Sessions', 'zh-CN': '吊销会话' },
    'space.create': { en: 'Create Space', 'zh-CN': '创建空间' },
    'space.rename': { en: 'Rename Space', 'zh-CN': '重命名空间' },
    'space.archive': { en: 'Archive Space', 'zh-CN': '归档空间' },
    'session.create': { en: 'Create Session', 'zh-CN': '创建会话' },
    'session.rename': { en: 'Rename Session', 'zh-CN': '重命名会话' },
    'session.archive': { en: 'Archive Session', 'zh-CN': '归档会话' },
    'session.reset': { en: 'Reset Generation', 'zh-CN': '重置会话代际' },
    'task.create': { en: 'Create Task', 'zh-CN': '创建任务' },
    'task.run': { en: 'Run Task', 'zh-CN': '执行任务' },
    'task.cancel': { en: 'Cancel Task', 'zh-CN': '取消任务' },
    'quota.update': { en: 'Update Quota', 'zh-CN': '更新配额' },
    'model.override': { en: 'Override Model', 'zh-CN': '覆盖模型配置' },
    'model.reset': { en: 'Reset Model Override', 'zh-CN': '重置模型覆盖' },
    'profile.create': { en: 'Create Profile', 'zh-CN': '创建画像' },
    'profile.version_create': { en: 'Publish Version', 'zh-CN': '发布画像版本' },
    'profile.bind': { en: 'Bind Space Profile', 'zh-CN': '绑定空间画像' },
    'storage.repair': { en: 'Repair Storage', 'zh-CN': '修复存储一致性' },
    'skill.install': { en: 'Install Skill', 'zh-CN': '安装技能' },
    'skill.update': { en: 'Update Skill', 'zh-CN': '更新技能' },
    'skill.rollback': { en: 'Rollback Skill', 'zh-CN': '回滚技能' },
    'skill.uninstall': { en: 'Uninstall Skill', 'zh-CN': '卸载技能' },
    'skill.enable': { en: 'Enable Skill', 'zh-CN': '启用技能' },
    'skill.disable': { en: 'Disable Skill', 'zh-CN': '禁用技能' },
    'preset.update': { en: 'Update Permission Preset', 'zh-CN': '更新权限预设' },
    'approval.decide': { en: 'Decide Approval', 'zh-CN': '裁定审批' },
    'approval.cancel': { en: 'Cancel Approval', 'zh-CN': '取消审批' },
    'webhook.subscribe': { en: 'Subscribe Webhook', 'zh-CN': '订阅 Webhook' },
    'webhook.retry': { en: 'Retry Webhook', 'zh-CN': '重试 Webhook' },
  },
  metric: {
    'tokens': { en: 'Tokens (Token consumption)', 'zh-CN': 'Tokens（Token 消耗量）' },
    'messages': { en: 'Messages (Chat message volume)', 'zh-CN': 'Messages（会话消息量）' },
    'turns': { en: 'Turns (Execution turns count)', 'zh-CN': 'Turns（执行轮次数）' },
    'storage_bytes': { en: 'Storage Bytes (Space volume storage)', 'zh-CN': 'Storage Bytes（空间存储容量）' },
    'api_calls': { en: 'API Calls (Total HTTP/REST requests)', 'zh-CN': 'API Calls（API 接口调用次数）' },
  },
};

/**
 * Return localized label for enum values. Returns localized 'Unknown' / '未知' for unknown values.
 */
function getLocalizedEnum(category, value) {
  if (value === null || value === undefined || value === '') {
    return getLocale() === 'zh-CN' ? '未知' : 'Unknown';
  }
  const rawStr = String(value);
  const key = rawStr.toLowerCase();
  const map = ENUM_TRANSLATION_MAP[category];
  const loc = getLocale() === 'zh-CN' ? 'zh-CN' : 'en';
  if (map && map[key] && map[key][loc]) {
    return map[key][loc];
  }
  if (category !== 'status' && ENUM_TRANSLATION_MAP.status[key] && ENUM_TRANSLATION_MAP.status[key][loc]) {
    return ENUM_TRANSLATION_MAP.status[key][loc];
  }
  return getLocale() === 'zh-CN' ? '未知' : 'Unknown';
}

// Application Global State
const state = {
  currentUser: null,
  csrfToken: null,
  currentRoute: 'workspace',
  spaces: [],
  currentSpaceId: null,
  sessions: [],
  currentSessionId: null,
  currentSessionRoute: null,
  messages: [],
  streamingState: null,
  olderMessagesCursor: null,
  hasMoreMessages: false,
  isLoadingOlderMessages: false,
  loadOlderError: null,
  eventCursor: null,
  hasCancellableTurn: false,
  activeTurnStatus: null,
  isCancellingTurn: false,
  isSendingMessage: false,
  isPollingInFlight: false,
  isTurnSyncInFlight: false,
  showArchivedSessions: false,
  sessionSearchQuery: '',
  forceScrollBottom: false,
  isSidebarCollapsed: false,
  pollingTimer: null,
  isPollingActive: false,
  consecutivePollingFailures: 0,
  pendingConfirmAction: null,
  pendingCancelAction: null,
  activeModals: [],
  previousActiveElement: null,
  managementRenderGen: 0,
  fileUploadQueue: [],
  activeUploadCount: 0,
  filesDropZoneActive: false,
  filesSpacePaths: {},
  // Approvals & Interactions State
  pendingApprovals: [],
  approvalsPollTimer: null,
  // Skills / Extensions Governance Filter State
  activeExtensionFilterKind: 'all',
  activeSkillFilterSpace: '',
  activeSkillFilterSource: '',
  activeSkillFilterEnabled: '',
  // Diagnostics State
  activeDiagnosticsLevel: '',
  diagnosticsCursor: null,
  diagnosticsHasMore: false,
  // Chat Composer Attachments & Reply State
  activeAttachments: [],
  activeReply: null,
  drafts: {},
  composerUploadQueue: [],
  activeComposerUploadCount: 0,
  filePickerCurrentPath: '.',
  filePickerSelectedEntries: new Map(),
  filePickerSearchQuery: '',
  processedEventIds: new Set(),
};

if (typeof window !== 'undefined') {
  window.state = state;
}

// UI Helper Functions
function showToast(messageOrKey, type = 'info', params = null, action = null) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  const typeClass = type === 'error' ? 'toast-error' : (type === 'warning' ? 'toast-warning' : (type === 'success' ? 'toast-success' : ''));
  toast.className = `toast ${typeClass}`.trim();

  const textSpan = document.createElement('span');
  const message = typeof messageOrKey === 'string' && (catalogs.en[messageOrKey] || catalogs['zh-CN']?.[messageOrKey])
    ? t(messageOrKey, params)
    : String(messageOrKey || '');
  textSpan.textContent = message;
  toast.appendChild(textSpan);

  if (action && typeof action === 'object' && action.label) {
    const actionBtn = document.createElement('button');
    actionBtn.className = 'toast-action-btn';
    actionBtn.type = 'button';
    actionBtn.textContent = action.label;
    actionBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toast.remove();
      if (typeof action.handler === 'function') {
        action.handler();
      }
    });
    toast.appendChild(actionBtn);
  }

  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast-close';
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => toast.remove());
  toast.appendChild(closeBtn);

  container.appendChild(toast);
  setTimeout(() => {
    if (toast.parentElement) toast.remove();
  }, 4500);
}

// Modal helpers with Accessibility & Focus Management
function openModal(modalId) {
  const cleanId = modalId.replace(/^modal-/, '');
  const fullId = 'modal-' + cleanId;
  const el = document.getElementById(fullId);
  if (!el) return;

  if (document.activeElement && !state.activeModals.includes(fullId)) {
    state.previousActiveElement = document.activeElement;
  }

  // Ensure modal DOM elements are translated to active locale
  translateDom(el);

  el.classList.remove('hidden');
  if (!state.activeModals.includes(fullId)) {
    state.activeModals.push(fullId);
  }

  // Focus the first focusable element inside the modal
  const focusable = el.querySelector('input:not([type="hidden"]), select, textarea, button:not(.modal-close), [tabindex="0"]');
  if (focusable && typeof focusable.focus === 'function') {
    focusable.focus();
  }
}

function closeModal(modalId) {
  const cleanId = modalId.replace(/^modal-/, '');
  const fullId = 'modal-' + cleanId;
  const el = document.getElementById(fullId);
  if (el) el.classList.add('hidden');

  if (fullId === 'modal-channel-onboarding') {
    if (typeof window !== 'undefined' && window.channelOnboardingController && typeof window.channelOnboardingController.cleanup === 'function') {
      window.channelOnboardingController.cleanup();
    }
  }

  state.activeModals = state.activeModals.filter((id) => id !== fullId);

  // Restore focus if all modals are closed
  if (state.activeModals.length === 0 && state.previousActiveElement && typeof state.previousActiveElement.focus === 'function') {
    try {
      state.previousActiveElement.focus();
    } catch {
      // Ignore focus errors
    }
    state.previousActiveElement = null;
  }
}

function closeTopModal() {
  if (state.activeModals.length > 0) {
    const topModal = state.activeModals[state.activeModals.length - 1];
    closeModal(topModal);
    return true;
  }
  return false;
}

// Generic Confirmation Dialog Helper
function showConfirmation(title, message, onConfirm, onCancel = null) {
  openModal('modal-confirm');

  const titleEl = document.getElementById('confirm-modal-title');
  const msgEl = document.getElementById('confirm-modal-message');

  if (titleEl && title) titleEl.textContent = typeof title === 'string' && (catalogs.en[title] || catalogs['zh-CN']?.[title]) ? t(title) : title;
  if (msgEl && message) msgEl.textContent = typeof message === 'string' && (catalogs.en[message] || catalogs['zh-CN']?.[message]) ? t(message) : message;

  state.pendingConfirmAction = onConfirm;
  state.pendingCancelAction = onCancel;
}

/**
 * Async modal confirmation helper returning Promise<boolean>.
 */
function showConfirmDialog(title, message) {
  return new Promise((resolve) => {
    showConfirmation(
      title,
      message,
      () => resolve(true),
      () => resolve(false)
    );
  });
}

// Setup confirmation proceed trigger
const globalProceedBtn = typeof document !== 'undefined' ? document.getElementById('btn-confirm-proceed') : null;
if (globalProceedBtn) {
  globalProceedBtn.addEventListener('click', () => {
    const action = state.pendingConfirmAction;
    state.pendingConfirmAction = null;
    state.pendingCancelAction = null;
    closeModal('modal-confirm');
    if (typeof action === 'function') {
      action();
    }
  });
}

const globalCancelBtn = typeof document !== 'undefined' ? document.getElementById('btn-confirm-cancel') : null;
if (globalCancelBtn) {
  globalCancelBtn.addEventListener('click', () => {
    const cancelAction = state.pendingCancelAction;
    state.pendingConfirmAction = null;
    state.pendingCancelAction = null;
    closeModal('modal-confirm');
    if (typeof cancelAction === 'function') {
      cancelAction();
    }
  });
}

// Setup modal close triggers and Escape key listener
document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    const target = e.currentTarget.getAttribute('data-close');
    if (target) {
      if (target === 'modal-confirm' && typeof state.pendingCancelAction === 'function') {
        const cancelAction = state.pendingCancelAction;
        state.pendingConfirmAction = null;
        state.pendingCancelAction = null;
        cancelAction();
      }
      closeModal(target);
    }
  });
});

document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      if (backdrop.id === 'modal-confirm' && typeof state.pendingCancelAction === 'function') {
        const cancelAction = state.pendingCancelAction;
        state.pendingConfirmAction = null;
        state.pendingCancelAction = null;
        cancelAction();
      }
      closeModal(backdrop.id);
    }
  });
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key === 'Esc') {
    if (state.activeModals.includes('modal-confirm') && typeof state.pendingCancelAction === 'function') {
      const cancelAction = state.pendingCancelAction;
      state.pendingConfirmAction = null;
      state.pendingCancelAction = null;
      cancelAction();
    }
    closeTopModal();
  }
});

// Idempotency Key Validation Helper using exact Fetch Headers semantics
function getIdempotencyKey(headers) {
  if (!headers) return null;

  // If a plain headers object contains duplicate casing for idempotency-key, reject it
  if (typeof headers === 'object' && !(headers instanceof Headers) && !Array.isArray(headers)) {
    const matchingKeys = Object.keys(headers).filter(
      (k) => k.toLowerCase() === 'idempotency-key'
    );
    if (matchingKeys.length > 1) {
      throw new Error('Duplicate Idempotency-Key header with different casing is rejected');
    }
  }

  // Construct standard Fetch Headers for normalized case-insensitive retrieval
  const parsedHeaders = new Headers(headers);
  const key = parsedHeaders.get('Idempotency-Key');
  if (!key) return null;

  const trimmed = key.trim();
  const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!UUID_V4_REGEX.test(trimmed)) {
    return null;
  }
  return trimmed;
}

// API Client Helper with Explicit Idempotent Network Retry Only
async function apiRequest(url, options = {}) {
  const defaultHeaders = {
    'Accept': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Enkeep-Client': 'web-ui',
  };
  if (state.csrfToken) {
    defaultHeaders['X-Enkeep-CSRF'] = state.csrfToken;
  }

  let bodyData = options.body;
  if (bodyData && typeof bodyData === 'object' && !(bodyData instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
    bodyData = JSON.stringify(bodyData);
  }

  // Extract and validate canonical Idempotency-Key using Fetch Headers semantics
  const idempotencyKey = getIdempotencyKey(options.headers);

  // Build merged headers using standard Fetch Headers
  const mergedHeaders = new Headers(defaultHeaders);
  if (options.headers) {
    const customHeaders = new Headers(options.headers);
    customHeaders.forEach((value, key) => {
      mergedHeaders.set(key, value);
    });
  }

  const requestOptions = {
    ...options,
    body: bodyData,
    credentials: 'include', // Ensure server-side HTTP cookies are always passed
    headers: mergedHeaders,
  };

  const executeFetch = async () => {
    return await fetch(url, requestOptions);
  };

  // Default retry is false; only retry when explicitly enabled AND valid Idempotency-Key is present
  const allowNetworkRetry = Boolean(options.retryNetwork === true && idempotencyKey);

  let response;
  try {
    response = await executeFetch();
  } catch (networkErr) {
    if (allowNetworkRetry) {
      try {
        response = await executeFetch();
      } catch {
        throw networkErr;
      }
    } else {
      throw networkErr;
    }
  }

  const contentType = response.headers.get('content-type') || '';
  let payload;
  if (contentType.includes('application/json')) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  } else {
    payload = await response.text();
  }

  if (!response.ok) {
    // If a 401 Unauthorized occurs AFTER the user is logged in, transition to auth view
    // (Preserve safe initial bootstrap behavior to avoid checkAuth recursion)
    if (response.status === 401 && state.currentUser) {
      showAuthView();
    }

    const errCode = (payload && payload.error && typeof payload.error.code === 'string')
      ? payload.error.code
      : null;
    const err = new Error(`HTTP ${response.status}`);
    err.status = response.status;
    err.code = errCode;
    throw err;
  }

  return payload;
}

// Safe error message mappings
const SAFE_ERROR_MESSAGES = {
  create_profile: 'Failed to create agent profile.',
  create_profile_version: 'Failed to create agent profile version.',
  update_quota: 'Failed to update resource quota limit.',
  create_session: 'Failed to create chat session.',
  load_messages: 'Failed to load session messages.',
  stop_turn: 'Failed to stop turn.',
  send_message: 'Failed to send message.',
  poll_events: 'Error synchronizing session events.',
  create_space: 'Failed to create space.',
  rename_space: 'Failed to rename space.',
  archive_space: 'Failed to archive space.',
  rename_session: 'Failed to rename session.',
  archive_session: 'Failed to archive session.',
  reset_session: 'Failed to reset session.',
};

function showSafeError(actionCode, fallback = 'An unexpected error occurred. Please try again.') {
  const msg = SAFE_ERROR_MESSAGES[actionCode] || fallback;
  showToast(msg, 'error');
}

// Sanitized UI Error Helper (fixed user-safe error messages; no status or raw message leakage)
function getSafeErrorMessage(err, fallback = 'An unexpected error occurred. Please try again.') {
  if (typeof fallback === 'string' && (catalogs.en[fallback] || catalogs['zh-CN']?.[fallback])) {
    return t(fallback);
  }
  return typeof fallback === 'string' && fallback.length > 0
    ? fallback
    : t('error.unexpected');
}

// Sanitized Webhook Error Mapping (maps fixed errorCodes to localized i18n keys)
function getWebhookErrorMessage(errorCode) {
  const code = (typeof errorCode === 'string') ? errorCode.toUpperCase().trim() : '';
  if (code === 'WEBHOOK_HTTP_ERROR' || code === 'HTTP_ERROR') {
    return t('notifications.errorWebhookHttp');
  }
  if (code === 'WEBHOOK_NETWORK' || code === 'WEBHOOK_NETWORK_ERROR' || code === 'NETWORK') {
    return t('notifications.errorWebhookNetwork');
  }
  if (code === 'WEBHOOK_TIMEOUT' || code === 'TIMEOUT') {
    return t('notifications.errorWebhookTimeout');
  }
  if (code === 'WEBHOOK_POLICY_REJECTED' || code === 'POLICY_REJECTED') {
    return t('notifications.errorWebhookPolicyRejected');
  }
  if (code === 'WEBHOOK_CIPHER_ERROR' || code === 'CIPHER_ERROR') {
    return t('notifications.errorWebhookCipher');
  }
  return t('notifications.errorWebhookUnknown');
}

// Fixed mapping for tool unavailability reason codes
const TOOLS_UNAVAILABLE_REASON_MAP = {
  PLATFORM_CLIENT_UNAVAILABLE: {
    en: 'Platform client service is unavailable',
    'zh-CN': '平台客户端服务不可用',
  },
  TOOLS_REGISTRY_UNAVAILABLE: {
    en: 'Tools registry service is not registered or unavailable',
    'zh-CN': '工具注册表服务未注册或不可用',
  },
  TOOLS_SCHEMA_PROBE_FAILED: {
    en: 'Failed to probe tools registry schemas',
    'zh-CN': '探测工具注册表 Schema 失败',
  },
  TOOLS_SCHEMA_INCOMPLETE: {
    en: 'Tool schemas are incomplete or insufficient tools registered',
    'zh-CN': '工具 Schema 不完整或注册的工具不足',
  },
};

function getToolsUnavailableReason(reasonCode) {
  if (typeof reasonCode !== 'string') return null;
  const loc = getLocale() === 'zh-CN' ? 'zh-CN' : 'en';
  const entry = TOOLS_UNAVAILABLE_REASON_MAP[reasonCode];
  if (entry && entry[loc]) {
    return entry[loc];
  }
  return reasonCode;
}

// CSRF Bootstrap Helper
async function fetchCsrfToken() {
  try {
    const res = await apiRequest('/api/auth/csrf');
    if (res && res.success && res.data && res.data.csrfToken) {
      state.csrfToken = res.data.csrfToken;
      return state.csrfToken;
    }
  } catch (csrfErr) {
    // CSRF bootstrap handled silently
  }
  return state.csrfToken;
}

// Authentication Handlers
async function checkAuth() {
  try {
    const res = await apiRequest('/api/auth/me');
    if (res && res.success && res.data && res.data.user) {
      if (res.data.user.mustChangePassword) {
        showForcedPasswordView(res.data.user);
      } else {
        onLoginSuccess(res.data.user);
      }
    } else {
      showAuthView();
    }
  } catch {
    showAuthView();
  }
}

function showAuthView() {
  state.currentUser = null;
  state.spaces = [];
  state.currentSpaceId = null;
  state.sessions = [];
  state.currentSessionId = null;
  state.currentSessionRoute = null;
  state.messages = [];
  state.olderMessagesCursor = null;
  state.eventCursor = null;
  state.hasCancellableTurn = false;
  state.activeTurnStatus = null;
  state.isCancellingTurn = false;
  state.consecutivePollingFailures = 0;
  state.pendingConfirmAction = null;
  state.activeModals = [];
  state.previousActiveElement = null;
  state.filesActiveSpaceId = null;
  state.filesCurrentPath = '.';
  state.filesActiveFile = null;
  stopPolling();
  if (typeof window !== 'undefined' && window.channelOnboardingController && typeof window.channelOnboardingController.cleanup === 'function') {
    window.channelOnboardingController.cleanup();
  }

  const tenantIndicator = document.getElementById('tenant-indicator');
  if (tenantIndicator) {
    tenantIndicator.textContent = '';
  }
  const userDisplayName = document.getElementById('user-display-name');
  if (userDisplayName) {
    userDisplayName.textContent = '';
  }
  const userRoleBadge = document.getElementById('user-role-badge');
  if (userRoleBadge) {
    userRoleBadge.textContent = '';
    userRoleBadge.className = 'badge badge-role';
  }
  const adminNavSection = document.getElementById('nav-admin-section');
  if (adminNavSection) {
    adminNavSection.classList.add('hidden');
  }

  // Restore unauthenticated local locale preference (localStorage -> navigator -> default)
  const localLocale = detectLocale(null);
  setLocale(localLocale, { persist: false });

  // Restore unauthenticated local theme preference (localStorage -> prefers-color-scheme -> default)
  const localTheme = detectTheme(null);
  setTheme(localTheme, { persist: false });

  document.getElementById('auth-view').classList.remove('hidden');
  const forcedView = document.getElementById('forced-password-view');
  if (forcedView) forcedView.classList.add('hidden');
  document.getElementById('app-view').classList.add('hidden');
}

function showForcedPasswordView(user) {
  state.currentUser = user;
  stopPolling();

  // Apply user canonical locale & theme
  const targetLocale = detectLocale(user);
  setLocale(targetLocale, { persist: true, source: 'forcedPassword' });

  const targetTheme = detectTheme(user);
  setTheme(targetTheme, { persist: false, source: 'forcedPassword' });

  document.getElementById('auth-view').classList.add('hidden');
  document.getElementById('app-view').classList.add('hidden');
  const forcedView = document.getElementById('forced-password-view');
  if (forcedView) {
    forcedView.classList.remove('hidden');
  }

  const currentPwdInput = document.getElementById('forced-current-password');
  if (currentPwdInput) {
    currentPwdInput.value = '';
    currentPwdInput.focus();
  }
  const newPwdInput = document.getElementById('forced-new-password');
  if (newPwdInput) newPwdInput.value = '';
  const confirmPwdInput = document.getElementById('forced-confirm-password');
  if (confirmPwdInput) confirmPwdInput.value = '';
}

async function handleForcedPasswordSubmit(e) {
  e.preventDefault();
  const currentPasswordInput = document.getElementById('forced-current-password');
  const newPasswordInput = document.getElementById('forced-new-password');
  const confirmPasswordInput = document.getElementById('forced-confirm-password');

  const currentPassword = currentPasswordInput ? currentPasswordInput.value : '';
  const newPassword = newPasswordInput ? newPasswordInput.value : '';
  const confirmPassword = confirmPasswordInput ? confirmPasswordInput.value : '';

  if (!currentPassword || !newPassword || !confirmPassword) {
    showToast(t('auth.emptyCredentials', null, 'Please fill in all password fields'), 'error');
    return;
  }

  if (newPassword.length < 8) {
    showToast(t('forcedPassword.passwordTooShort', null, 'New password must be at least 8 characters'), 'error');
    return;
  }

  if (newPassword !== confirmPassword) {
    showToast(t('forcedPassword.passwordMismatch', null, 'New passwords do not match'), 'error');
    return;
  }

  if (newPassword === currentPassword) {
    showToast(t('forcedPassword.passwordSameAsOld', null, 'New password must be different from current temporary password'), 'error');
    return;
  }

  const submitBtn = document.getElementById('btn-forced-password-submit');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = t('forcedPassword.updating', null, 'Updating Password...');
  }

  try {
    const res = await apiRequest('/api/auth/password', {
      method: 'PUT',
      body: { oldPassword: currentPassword, newPassword },
    });

    if (!res || !res.success) {
      throw new Error(res?.error?.message || 'Failed to update password');
    }

    // Refresh CSRF token for future requests
    await fetchCsrfToken();

    // Query me to get updated user with mustChangePassword = false
    const meRes = await apiRequest('/api/auth/me');
    if (meRes && meRes.success && meRes.data && meRes.data.user) {
      const forcedView = document.getElementById('forced-password-view');
      if (forcedView) forcedView.classList.add('hidden');
      showToast(t('forcedPassword.success', null, 'Password updated successfully. Welcome to your workspace!'), 'success');
      onLoginSuccess(meRes.data.user);
    } else {
      showAuthView();
    }
  } catch (err) {
    showToast(getSafeErrorMessage(err, t('account.changePasswordFailed', null, 'Failed to update password. Please check your credentials.')), 'error');
  } finally {
    if (currentPasswordInput) currentPasswordInput.value = '';
    if (newPasswordInput) newPasswordInput.value = '';
    if (confirmPasswordInput) confirmPasswordInput.value = '';
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = t('forcedPassword.submitButton', null, 'Update Password & Continue');
    }
  }
}

function updateTenantIndicator(user) {
  const tenantIndicator = document.getElementById('tenant-indicator');
  if (!tenantIndicator || !user) return;
  const roleText = user.role ? ` (${getLocalizedEnum('role', user.role)})` : '';
  const nameText = user.displayName && user.displayName !== user.username
    ? `${user.displayName} (${user.username})`
    : (user.username || user.displayName || 'Account');
  if (getLocale() === 'zh-CN') {
    tenantIndicator.textContent = `账户: ${nameText}${roleText}`;
  } else {
    tenantIndicator.textContent = `Account: ${nameText}${roleText}`;
  }
}

function onLoginSuccess(user) {
  state.currentUser = user;

  // Detect and apply user canonical locale & theme synchronously
  const targetLocale = detectLocale(user);
  setLocale(targetLocale, { persist: true, source: 'login' });

  const targetTheme = detectTheme(user);
  setTheme(targetTheme, { persist: false, source: 'login' });

  document.getElementById('auth-view').classList.add('hidden');
  document.getElementById('app-view').classList.remove('hidden');

  const displayNameEl = document.getElementById('user-display-name');
  if (displayNameEl) {
    displayNameEl.textContent = user.displayName || user.username;
  }

  updateTenantIndicator(user);

  const roleBadgeEl = document.getElementById('user-role-badge');
  const adminNavSection = document.getElementById('nav-admin-section');
  const isAdmin = Boolean(user && user.role === 'admin');

  if (roleBadgeEl) {
    roleBadgeEl.textContent = isAdmin ? (t('auth.roleAdmin', null, 'Admin') || 'Admin') : (t('auth.roleUser', null, 'Member') || 'Member');
    roleBadgeEl.className = `badge badge-role ${isAdmin ? 'badge-admin' : 'badge-user'}`;
  }

  if (adminNavSection) {
    if (isAdmin) {
      adminNavSection.classList.remove('hidden');
    } else {
      adminNavSection.classList.add('hidden');
    }
  }

  showToast(t('auth.loginSuccess', { name: user.displayName || user.username }, `Welcome back, ${user.displayName || user.username}!`), 'success');

  // Initialize Route Navigation
  handleRouteHash();

  // Load Spaces for workspace
  loadSpaces();
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const passwordInput = document.getElementById('login-password');
  const password = passwordInput ? passwordInput.value : '';

  if (!username || !password) {
    if (passwordInput) passwordInput.value = '';
    showToast(t('auth.emptyCredentials', null, 'Please enter both username and password'), 'error');
    return;
  }

  const submitBtn = document.getElementById('btn-login-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = t('auth.signingIn', null, 'Signing in...');

  try {
    const res = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: { username, password },
    });

    if (res.success && res.data && res.data.user) {
      if (res.data.user.mustChangePassword) {
        showForcedPasswordView(res.data.user);
      } else {
        onLoginSuccess(res.data.user);
      }
    } else {
      throw new Error('Unexpected login response');
    }
  } catch (err) {
    showToast(getSafeErrorMessage(err, t('auth.loginFailed', null, 'Login failed. Please check your credentials.')), 'error');
  } finally {
    if (passwordInput) passwordInput.value = '';
    submitBtn.disabled = false;
    submitBtn.textContent = t('auth.signInButton', null, 'Sign In');
  }
}

async function handleLogout() {
  try {
    await apiRequest('/api/auth/logout', { method: 'POST' });
  } catch {
    // Logout failure handled silently
  }
  showToast(t('auth.loggedOut', null, 'Logged out successfully'), 'success');
  showAuthView();
}

// ----------------------------------------------------
// Hash Routing & Management Views
// ----------------------------------------------------

const ADMIN_ONLY_ROUTES = [
  'admin-dashboard',
  'admin-users',
  'admin-spaces',
  'admin-models',
  'admin-runtime',
  'admin-plugins',
  'admin-security',
];

const VALID_MANAGEMENT_ROUTES = [
  'management',
  'files',
  'overview',
  'tasks',
  'agent-profiles',
  'delivery',
  'quotas',
  'activity',
  'imports',
  'account',
  ...ADMIN_ONLY_ROUTES,
];

const MANAGEMENT_TABS = ['runtime', 'workspaces', 'storage', 'users', 'models'];

const TAB_SECTIONS_ADMIN = {
  runtime: [
    { id: 'runtime', label: 'Runtime Engine', desc: 'Container runner status and sandbox telemetry' },
    { id: 'plugins', label: 'Plugins', desc: 'Cordis plugins and tool execution enclaves' },
    { id: 'tasks', label: 'Tasks', desc: 'Async execution tasks and worker queues' },
    { id: 'security', label: 'Security Posture', desc: 'CSP, CSRF, and isolation policies' },
  ],
  workspaces: [
    { id: 'spaces-sessions', label: 'Spaces & Sessions', desc: 'Cluster workspace spaces and session metrics' },
    { id: 'instructions', label: 'Space Instructions', desc: 'Workspace rules and system prompt instructions (AGENTS.md / CLAUDE.md)' },
    { id: 'profiles', label: 'Agent Profiles', desc: 'Agent personas, behavioral guidelines and versions' },
    { id: 'extensions', label: 'Extension Center', desc: 'Installed extensions, skill packages, Git/archive installation, and diffs' },
    { id: 'channels', label: 'Channels', desc: 'Lark / Feishu account references, space bindings, and activation modes' },
    { id: 'deliveries', label: 'Delivery Pipeline', desc: 'Inbound delivery receipts and dispatch status' },
  ],
  storage: [
    { id: 'files', label: 'Files Workbench', desc: 'Container volume file explorer and editor' },
    { id: 'quotas', label: 'Quotas', desc: 'Resource usage limits and concurrency rules' },
    { id: 'imports', label: 'Imports', desc: 'Imported historical workspace seeds' },
    { id: 'reconcile', label: 'Storage Reconcile', desc: 'Dual-storage consistency scan and repair' },
  ],
  users: [
    { id: 'users', label: 'Users & Access', desc: 'Tenant accounts, roles, and status control' },
    { id: 'audit', label: 'Activity Audit', desc: 'Security audit trail and access logs' },
    { id: 'account', label: 'Account Settings', desc: 'Personal credentials and security' },
  ],
  models: [
    { id: 'model-config', label: 'Model Configuration', desc: 'LLM provider routing and overrides' },
    { id: 'model-usage', label: 'Model Usage', desc: 'Token metering and model quota breakdown' },
  ],
};

const TAB_SECTIONS_MEMBER = {
  runtime: [
    { id: 'runtime', label: 'My Runtime', desc: 'User container sandbox and DSH engine status' },
    { id: 'tasks', label: 'Tasks', desc: 'Async execution tasks and prompt worker' },
  ],
  workspaces: [
    { id: 'instructions', label: 'Space Instructions', desc: 'Workspace rules and system prompt instructions (AGENTS.md / CLAUDE.md)' },
    { id: 'profiles', label: 'Agent Profiles', desc: 'Agent personas, behavioral guidelines and versions' },
    { id: 'extensions', label: 'Extension Center', desc: 'Installed extensions, skill packages, Git/archive installation, and diffs' },
    { id: 'channels', label: 'Channels', desc: 'Lark / Feishu account references, space bindings, and activation modes' },
    { id: 'deliveries', label: 'Delivery Pipeline', desc: 'Inbound delivery receipts and dispatch status' },
  ],
  storage: [
    { id: 'files', label: 'Files Workbench', desc: 'Container volume file explorer and editor' },
    { id: 'quotas', label: 'Quotas', desc: 'Resource usage limits and allocation' },
    { id: 'imports', label: 'Imports', desc: 'Imported historical workspace seeds' },
  ],
  users: [
    { id: 'audit', label: 'Activity Audit', desc: 'Security audit trail and access logs' },
    { id: 'account', label: 'Account Settings', desc: 'Personal credentials and security' },
  ],
  models: [
    { id: 'model-config', label: 'Available Models', desc: 'Read-only inspection of active model providers' },
    { id: 'model-usage', label: 'Model Usage', desc: 'Token metering and model quota breakdown' },
  ],
};

const OLD_ROUTE_MAP = {
  'overview': 'management',
  'admin-dashboard': 'management',
  'tasks': 'management/runtime/tasks',
  'admin-runtime': 'management/runtime/runtime',
  'admin-plugins': 'management/runtime/plugins',
  'admin-security': 'management/runtime/security',
  'admin-spaces': 'management/workspaces/spaces-sessions',
  'instructions': 'management/workspaces/instructions',
  'space-instructions': 'management/workspaces/instructions',
  'agent-profiles': 'management/workspaces/profiles',
  'delivery': 'management/workspaces/deliveries',
  'files': 'management/storage/files',
  'quotas': 'management/storage/quotas',
  'imports': 'management/storage/imports',
  'admin-users': 'management/users/users',
  'activity': 'management/users/audit',
  'account': 'management/users/account',
  'admin-models': 'management/models/model-config',
  'extensions': 'management/workspaces/extensions',
  'channels': 'management/workspaces/channels',
  'admin-channels': 'management/workspaces/channels',
};

const ROUTE_LABELS = {
  'workspace': 'Workspace',
  'files': 'Files / Container Volume Workbench',
  'overview': 'Management / Overview',
  'management': 'Management / Overview',
  'tasks': 'Management / Tasks',
  'instructions': 'Management / Space Instructions',
  'agent-profiles': 'Management / Agent Profiles',
  'extensions': 'Management / Extension Center',
  'delivery': 'Management / Delivery',
  'quotas': 'Management / Quotas',
  'activity': 'Management / Activity Audit',
  'imports': 'Management / Imports',
  'account': 'Account & Security Settings',
  'admin-dashboard': 'Admin / Dashboard',
  'admin-users': 'Admin / Users & Access',
  'admin-spaces': 'Admin / Spaces & Sessions',
  'admin-models': 'Admin / Model Configuration',
  'admin-runtime': 'Admin / Runtime Engine',
  'admin-plugins': 'Admin / Plugins',
  'admin-security': 'Admin / Security Posture',
};

function parseManagementRoute(rawRoute, isAdmin) {
  let route = (rawRoute || '').trim().replace(/^#/, '');

  // 1. empty or workspace -> workspace
  if (!route || route === 'workspace') {
    return { type: 'workspace', canonicalHash: '#workspace' };
  }

  // 2. management or overview -> management overview
  if (route === 'management' || route === 'overview') {
    return { type: 'management-overview', tab: null, section: null, canonicalHash: '#management' };
  }

  // 3. Old route mapping (recursive resolution)
  if (OLD_ROUTE_MAP[route]) {
    const canonicalTarget = OLD_ROUTE_MAP[route];
    return parseManagementRoute(canonicalTarget, isAdmin);
  }

  // 4. management/... 5-tab parsing
  if (route.startsWith('management/')) {
    const parts = route.split('/').filter(Boolean);
    const tab = parts[1] || null;
    const section = parts[2] || null;

    if (!tab || !MANAGEMENT_TABS.includes(tab)) {
      return { type: 'management-overview', tab: null, section: null, canonicalHash: '#management' };
    }

    const availableSections = (isAdmin ? TAB_SECTIONS_ADMIN : TAB_SECTIONS_MEMBER)[tab] || [];
    if (availableSections.length === 0) {
      return { type: 'management-overview', tab: null, section: null, canonicalHash: '#management' };
    }

    const matchedSection = availableSections.find((s) => s.id === section);
    if (matchedSection) {
      return {
        type: 'management-section',
        tab,
        section: matchedSection.id,
        canonicalHash: `#management/${tab}/${matchedSection.id}`,
      };
    }

    if (tab === 'workspaces' && section === 'extensions') {
      return {
        type: 'management-section',
        tab: 'workspaces',
        section: 'extensions',
        canonicalHash: '#management/workspaces/extensions',
      };
    }

    // Default to first available section for this tab
    const defaultSec = availableSections[0];
    return {
      type: 'management-section',
      tab,
      section: defaultSec.id,
      canonicalHash: `#management/${tab}/${defaultSec.id}`,
    };
  }

  // 5. fallback: workspace
  return { type: 'workspace', canonicalHash: '#workspace' };
}

function getRouteBreadcrumb(parsedRoute, isAdmin) {
  if (!parsedRoute || parsedRoute.type === 'workspace') {
    return t('chat.navLabel', null, 'Chat');
  }
  if (parsedRoute.type === 'management-overview') {
    return t('management.breadcrumbOverview', null, 'Management / Overview');
  }
  if (!parsedRoute.tab) {
    return t('management.breadcrumb', null, 'Management');
  }
  const tabCapitalized = parsedRoute.tab.charAt(0).toUpperCase() + parsedRoute.tab.slice(1);
  const tabName = t(`management.tab${tabCapitalized}`, null, tabCapitalized);
  const sections = (isAdmin ? TAB_SECTIONS_ADMIN : TAB_SECTIONS_MEMBER)[parsedRoute.tab] || [];
  const sec = sections.find((s) => s.id === parsedRoute.section);
  let secName = parsedRoute.section || 'Section';
  if (sec) {
    secName = t(`section.${parsedRoute.tab}.${sec.id}.label`, null, sec.label);
  }
  return `${t('management.breadcrumb', null, 'Management')} / ${tabName} / ${secName}`;
}

function handleRouteHash() {
  if (typeof window !== 'undefined' && window.channelOnboardingController && typeof window.channelOnboardingController.cleanup === 'function') {
    window.channelOnboardingController.cleanup();
  }
  const channelModal = document.getElementById('modal-channel-onboarding');
  if (channelModal && !channelModal.classList.contains('hidden')) {
    closeModal('modal-channel-onboarding');
  }

  if (!state.currentUser) return;
  if (state.currentUser.mustChangePassword) {
    showForcedPasswordView(state.currentUser);
    return;
  }

  const rawHash = (window.location.hash || '').replace(/^#/, '').trim();
  const isAdmin = Boolean(state.currentUser && state.currentUser.role === 'admin');

  let route = rawHash;
  if (!route || /\s/.test(route)) {
    route = 'workspace';
  }

  // Non-admin redirect if accessing restricted admin route -> management
  if (ADMIN_ONLY_ROUTES.includes(route) && !isAdmin) {
    showToast(t('management.accessRestricted', null, 'Access restricted: Administration routes require admin privileges.'), 'error');
    window.location.hash = '#management';
    route = 'management';
  }

  const parsed = parseManagementRoute(route, isAdmin);

  // If URL hash is not canonical, update window.location.hash and route
  if (window.location.hash !== parsed.canonicalHash) {
    window.location.hash = parsed.canonicalHash;
    route = parsed.canonicalHash.replace(/^#/, '');
  }

  state.currentRoute = route || 'workspace';

  // Update Left Main Navigation Active State
  const navWorkspace = document.getElementById('nav-workspace');
  const navManagement = document.getElementById('nav-management');
  const navAccount = document.getElementById('nav-account');

  if (navWorkspace) {
    navWorkspace.classList.toggle('active', parsed.type === 'workspace');
  }
  if (navManagement) {
    navManagement.classList.toggle('active', parsed.type === 'management-overview' || parsed.type === 'management-section');
  }
  if (navAccount) {
    navAccount.classList.toggle('active', parsed.tab === 'users' && parsed.section === 'account');
  }

  // Update Management Tab Buttons
  MANAGEMENT_TABS.forEach((t) => {
    const btn = document.getElementById(`tab-btn-${t}`);
    if (btn) {
      const isTabActive = parsed.tab === t;
      btn.className = `btn btn-sm ${isTabActive ? 'btn-primary' : 'btn-secondary'}`;
      btn.setAttribute('aria-selected', isTabActive ? 'true' : 'false');
    }
  });

  // Update Topbar Breadcrumb
  const breadcrumbEl = document.getElementById('active-view-label');
  if (breadcrumbEl) {
    breadcrumbEl.textContent = getRouteBreadcrumb(parsed, isAdmin);
  }

  // Switch View Panels
  const workspaceView = document.getElementById('view-workspace');
  const managementView = document.getElementById('view-management');

  if (parsed.type === 'workspace') {
    if (workspaceView) workspaceView.classList.remove('hidden');
    if (managementView) managementView.classList.add('hidden');

    // Resume chat polling if session is active
    if (state.currentSessionId && !state.isPollingActive) {
      startPolling(state.currentSessionId);
    }
  } else {
    // Stop chat polling on management routes
    stopPolling();

    if (workspaceView) workspaceView.classList.add('hidden');
    if (managementView) managementView.classList.remove('hidden');

    renderManagementView(route);
  }
}

// ----------------------------------------------------
// Management View Renderers (DOM Nodes & CSP Compliant)
// ----------------------------------------------------

// UI Building Blocks
function createHeader(title, subtitle, onRefresh) {
  const header = document.createElement('div');
  header.className = 'management-header';

  const titleDiv = document.createElement('div');
  titleDiv.className = 'management-header-title';

  const h2 = document.createElement('h2');
  h2.textContent = typeof title === 'string' ? t(title, null, title) : '';
  titleDiv.appendChild(h2);

  if (subtitle) {
    const p = document.createElement('p');
    p.textContent = typeof subtitle === 'string' ? t(subtitle, null, subtitle) : '';
    titleDiv.appendChild(p);
  }

  header.appendChild(titleDiv);

  if (onRefresh) {
    const actions = document.createElement('div');
    actions.className = 'management-actions';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary btn-sm';
    btn.textContent = getLocale() === 'zh-CN' ? '↻ 刷新' : '↻ Refresh';
    btn.addEventListener('click', onRefresh);

    actions.appendChild(btn);
    header.appendChild(actions);
  }

  return header;
}

function createKpiCard(label, value, subtitle) {
  const card = document.createElement('div');
  card.className = 'kpi-card';

  const header = document.createElement('div');
  header.className = 'kpi-card-header';

  const lbl = document.createElement('span');
  lbl.className = 'kpi-label';
  lbl.textContent = typeof label === 'string' ? t(label, null, label) : '';
  header.appendChild(lbl);
  card.appendChild(header);

  const val = document.createElement('div');
  val.className = 'kpi-value';
  val.textContent = typeof value === 'number' ? formatNumber(value) : String(value);
  card.appendChild(val);

  if (subtitle) {
    const sub = document.createElement('div');
    sub.className = 'kpi-subtitle';
    sub.textContent = typeof subtitle === 'string' ? t(subtitle, null, subtitle) : '';
    card.appendChild(sub);
  }

  return card;
}

function createStateCard(title, message, isUnavailable = false, isError = false) {
  const card = document.createElement('div');
  card.className = `state-card ${isUnavailable ? 'state-unavailable' : isError ? 'state-error' : ''}`;

  const h4 = document.createElement('h4');
  h4.textContent = typeof title === 'string' ? t(title, null, title) : '';
  card.appendChild(h4);

  const p = document.createElement('p');
  p.textContent = typeof message === 'string' ? t(message, null, message) : '';
  card.appendChild(p);

  return card;
}

function createSkeletonLoader() {
  const container = document.createElement('div');
  container.className = 'skeleton-container';

  const box1 = document.createElement('div');
  box1.className = 'skeleton-box skeleton-header';
  container.appendChild(box1);

  for (let i = 0; i < 4; i++) {
    const row = document.createElement('div');
    row.className = `skeleton-box ${i % 2 === 0 ? 'skeleton-row' : 'skeleton-row-short'}`;
    container.appendChild(row);
  }

  return container;
}

function createBadgeElement(text, variant = 'muted', category = 'status') {
  const badge = document.createElement('span');
  badge.className = `badge badge-${variant}`;
  if (category === 'role' || variant === 'admin' || variant === 'user') {
    badge.textContent = getLocalizedEnum('role', text);
  } else if (category === 'action') {
    badge.textContent = getLocalizedEnum('action', text);
  } else if (category === 'metric') {
    badge.textContent = getLocalizedEnum('metric', text);
  } else if (ENUM_TRANSLATION_MAP.status[String(text).toLowerCase()]) {
    badge.textContent = getLocalizedEnum('status', text);
  } else {
    badge.textContent = typeof text === 'string' ? t(text, null, text) : String(text);
  }
  return badge;
}

function createSectionNavBar(tabKey, activeSectionId, availableSections) {
  const tabCapitalized = tabKey.charAt(0).toUpperCase() + tabKey.slice(1);
  const tabName = t(`management.tab${tabCapitalized}`, null, tabCapitalized);
  const bar = document.createElement('div');
  bar.className = 'management-section-nav flex-row-wrap';
  bar.setAttribute('role', 'tablist');
  bar.setAttribute('aria-label', `${tabName} Sections`);

  availableSections.forEach((sec) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const isActive = sec.id === activeSectionId;
    btn.className = `btn btn-sm ${isActive ? 'btn-primary' : 'btn-secondary'}`;
    btn.textContent = t(`section.${tabKey}.${sec.id}.label`, null, sec.label);
    btn.setAttribute('data-section', sec.id);
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    btn.addEventListener('click', () => {
      window.location.hash = `#management/${tabKey}/${sec.id}`;
    });
    bar.appendChild(btn);
  });

  return bar;
}

// User Runtime View (GET /api/manage/overview -> runtime)
async function renderUserRuntimeView(container) {
  let userRuntime = null;
  let isUnavailable = false;

  try {
    const res = await apiRequest('/api/manage/overview');
    if (res && res.data && res.data.runtime) {
      userRuntime = res.data.runtime;
    } else {
      isUnavailable = true;
    }
  } catch {
    isUnavailable = true;
  }

  container.replaceChildren();
  const header = createHeader('runtime.userTitle', 'runtime.userSubtitle', () => renderManagementView('management/runtime/runtime'));
  const btnDiag = document.createElement('button');
  btnDiag.type = 'button';
  btnDiag.className = 'btn btn-secondary btn-sm ml-auto';
  btnDiag.textContent = t('diagnostics.btnOpen', null, 'Runtime Diagnostics');
  btnDiag.addEventListener('click', () => openDiagnosticsModal(state.currentUser && state.currentUser.id));
  header.appendChild(btnDiag);
  container.appendChild(header);

  if (isUnavailable || !userRuntime) {
    container.appendChild(
      createStateCard(
        'runtime.serviceUnavailableTitle',
        'runtime.serviceUnavailableDesc',
        true
      )
    );
    return;
  }

  const kpiGrid = document.createElement('div');
  kpiGrid.className = 'kpi-grid';

  const isOk = userRuntime.status === 'ok';
  const isDegraded = userRuntime.status === 'degraded';
  const rowStatusKey = isOk ? 'status.ok' : (isDegraded ? 'status.degraded' : 'status.unavailable');
  const rowStatus = getLocalizedEnum('status', isOk ? 'ok' : (isDegraded ? 'degraded' : 'unavailable'));
  const badgeType = isOk
    ? (getLocale() === 'zh-CN' ? '实时沙箱已连接' : 'Live sandbox attached')
    : (getLocale() === 'zh-CN' ? '降级模式' : 'Degraded mode');
  kpiGrid.appendChild(createKpiCard('runtime.kpiStatus', rowStatus, badgeType));

  const dshState = getLocalizedEnum('status', userRuntime.dshReady === true ? 'ready' : (userRuntime.dshReady === false ? 'not_ready' : 'unavailable'));
  const dshSub = getLocale() === 'zh-CN' ? '沙箱容器就绪状态' : 'Sandbox container readiness';
  kpiGrid.appendChild(createKpiCard('runtime.kpiCoreEngine', dshState, dshSub));

  const countVal = typeof userRuntime.toolsCount === 'number'
    ? (getLocale() === 'zh-CN' ? `${formatNumber(userRuntime.toolsCount)} 个 Schema` : `${userRuntime.toolsCount} Schemas`)
    : getLocalizedEnum('status', 'unavailable');
  const schemasSub = getLocale() === 'zh-CN' ? '已注册工具 Schema' : 'Registered tool schemas';
  kpiGrid.appendChild(createKpiCard('runtime.kpiToolSchemas', countVal, schemasSub));

  const execState = getLocalizedEnum('status', userRuntime.toolsOperational === true ? 'operational' : (userRuntime.toolsOperational === false ? 'degraded' : 'unavailable'));
  const execSub = getLocale() === 'zh-CN' ? '交互式工具执行状态' : 'Interactive tool execution status';
  kpiGrid.appendChild(createKpiCard('runtime.kpiToolExecution', execState, execSub));
  container.appendChild(kpiGrid);

  // Status detail card
  const section = document.createElement('div');
  section.className = 'management-section';
  const sHead = document.createElement('div');
  sHead.className = 'section-header';
  const h3 = document.createElement('h3');
  h3.textContent = t('runtime.sectionSandboxDetails', null, 'Sandbox Isolation Details');
  sHead.appendChild(h3);
  section.appendChild(sHead);

  const cardPanel = document.createElement('div');
  cardPanel.className = 'card-panel';
  const p1 = document.createElement('p');
  p1.textContent = t('runtime.labelUserAccount', { user: userRuntime.userId || 'Self' }, `User Account: ${userRuntime.userId || 'Self'}`);
  cardPanel.appendChild(p1);

  const p2 = document.createElement('p');
  const modeText = userRuntime.networkMode === 'none'
    ? (getLocale() === 'zh-CN' ? '--network none (纯沙箱隔离)' : '--network none (Air-gapped)')
    : (userRuntime.networkMode || getLocalizedEnum('status', 'unavailable'));
  p2.textContent = t('runtime.labelNetworkMode', { mode: modeText }, `Network Mode: ${userRuntime.networkMode === 'none' ? '--network none (Air-gapped)' : (userRuntime.networkMode || 'Unavailable')}`);
  cardPanel.appendChild(p2);

  const pMode = document.createElement('p');
  const userExecMode = (userRuntime.mode === 'host' || userRuntime.executionMode === 'host') ? 'host' : 'container';
  const modeLabel = userExecMode === 'host' ? t('spaces.modeHost', null, 'Host') : t('spaces.modeDocker', null, 'Docker');
  pMode.textContent = `${t('spaces.executionMode', null, 'Execution Mode')}: ${modeLabel}`;
  cardPanel.appendChild(pMode);

  if (userRuntime.toolsUnavailableReason) {
    const reasonEl = document.createElement('div');
    reasonEl.className = 'callout callout-warning';
    const reasonText = getToolsUnavailableReason(userRuntime.toolsUnavailableReason);
    reasonEl.textContent = t('runtime.toolWarning', { reason: reasonText }, `Tool Execution Warning: ${reasonText}`);
    cardPanel.appendChild(reasonEl);
  }

  section.appendChild(cardPanel);
  container.appendChild(section);
}

// Storage Reconcile View (GET /api/admin/storage/reconcile, POST /api/admin/storage/repair, POST /api/admin/storage/scan-baseline)
async function renderStorageReconcileView(container) {
  let reconcileData = null;
  let isUnavailable = false;

  try {
    const res = await apiRequest('/api/admin/storage/reconcile');
    if (res && res.data) {
      reconcileData = res.data;
    } else {
      isUnavailable = true;
    }
  } catch {
    isUnavailable = true;
  }

  container.replaceChildren();
  const header = createHeader(
    'reconcile.title',
    'reconcile.subtitle',
    () => renderManagementView('management/storage/reconcile')
  );

  // Add Scan Baseline action button to header
  const headerActions = header.querySelector('.management-actions');
  if (headerActions) {
    const btnScanBaseline = document.createElement('button');
    btnScanBaseline.type = 'button';
    btnScanBaseline.className = 'btn btn-secondary btn-sm btn-scan-baseline';
    btnScanBaseline.textContent = t('reconcile.btnScanBaseline', null, 'Scan Baseline');
    btnScanBaseline.addEventListener('click', () => {
      const confirmTitle = t('reconcile.confirmBaselineTitle', null, 'Scan Storage Baseline');
      const confirmMsg = t('reconcile.confirmBaselineMessage', null, 'Scan tenant container volume to discover baseline storage usage and update quota usage. Continue?');

      showConfirmation(confirmTitle, confirmMsg, async () => {
        try {
          btnScanBaseline.disabled = true;
          btnScanBaseline.textContent = t('reconcile.scanningBaseline', null, 'Scanning Baseline...');

          const currentUserId = state.currentUser?.id || 'alice';
          const scanRes = await apiRequest('/api/admin/storage/scan-baseline', {
            method: 'POST',
            body: {
              userId: currentUserId,
              volumePath: `/tmp/enkeep-volumes/${currentUserId}`,
              setBaseline: true,
            },
          });

          const resData = scanRes && scanRes.data;
          const bytesStr = resData && typeof resData.totalBytes === 'number' ? formatBytes(resData.totalBytes) : '0 B';
          const filesCount = resData && typeof resData.fileCount === 'number' ? formatNumber(resData.fileCount) : '0';
          showToast(
            t('reconcile.scanBaselineSuccess', { bytes: bytesStr, files: filesCount }, `Storage baseline scan complete (${bytesStr} across ${filesCount} files).`),
            'success'
          );

          await renderStorageReconcileView(container);
        } catch (err) {
          showToast(getSafeErrorMessage(err, t('reconcile.scanBaselineFailed', { error: err?.message || 'Unknown error' }, 'Failed to scan storage baseline.')), 'error');
        } finally {
          btnScanBaseline.disabled = false;
          btnScanBaseline.textContent = t('reconcile.btnScanBaseline', null, 'Scan Baseline');
        }
      });
    });

    headerActions.prepend(btnScanBaseline);
  }

  container.appendChild(header);

  if (isUnavailable || !reconcileData) {
    container.appendChild(
      createStateCard(
        'reconcile.unavailableTitle',
        'reconcile.unavailableDesc',
        true
      )
    );
    return;
  }

  const kpiGrid = document.createElement('div');
  kpiGrid.className = 'kpi-grid';
  kpiGrid.appendChild(createKpiCard('reconcile.kpiScanned', String(reconcileData.totalSessions ?? 0), getLocale() === 'zh-CN' ? '已索引会话' : 'Indexed sessions'));
  kpiGrid.appendChild(createKpiCard('reconcile.kpiMatched', String(reconcileData.matchedCount ?? 0), getLocale() === 'zh-CN' ? '一致记录' : 'Consistent records'));
  kpiGrid.appendChild(createKpiCard('reconcile.kpiDrift', String(reconcileData.driftCount ?? 0), getLocale() === 'zh-CN' ? '数量或顺序偏差' : 'Count or ordering drift'));
  kpiGrid.appendChild(createKpiCard('reconcile.kpiMissing', String(reconcileData.missingCount ?? 0), getLocale() === 'zh-CN' ? '未索引记录' : 'Unindexed records'));
  container.appendChild(kpiGrid);

  const reports = Array.isArray(reconcileData.reports) ? reconcileData.reports : [];
  if (reports.length > 0) {
    const section = document.createElement('div');
    section.className = 'management-section';
    const sHead = document.createElement('div');
    sHead.className = 'section-header';
    const h3 = document.createElement('h3');
    h3.textContent = t('reconcile.sectionReports', null, 'Session Reconciliation Reports');
    sHead.appendChild(h3);
    section.appendChild(sHead);

    const tableContainer = document.createElement('div');
    tableContainer.className = 'data-table-container';
    const table = document.createElement('table');
    table.className = 'data-table';

    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');
    const cols = ['Session ID', 'Consistency Status', 'DSH JSONL Messages', 'SQLite Messages', 'Discrepancies & Drift', 'Verified At', 'Actions'];
    const colKeys = ['reconcile.colSessionId', 'reconcile.colStatus', 'reconcile.colDsh', 'reconcile.colSqlite', 'reconcile.colDifferences', 'reconcile.colVerifiedAt', 'reconcile.colActions'];
    cols.forEach((col, idx) => {
      const th = document.createElement('th');
      th.textContent = t(colKeys[idx], null, col);
      trHead.appendChild(th);
    });
    thead.appendChild(trHead);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    reports.forEach((rep) => {
      const tr = document.createElement('tr');

      const tdId = document.createElement('td');
      tdId.className = 'mono-cell';
      tdId.textContent = rep.sessionId || '-';
      tr.appendChild(tdId);

      const tdStatus = document.createElement('td');
      const badgeVariant = rep.status === 'matched' ? 'success' : (rep.status === 'drift' ? 'warning' : 'danger');
      tdStatus.appendChild(createBadgeElement(rep.status || 'unknown', badgeVariant));
      tr.appendChild(tdStatus);

      const dshCount = rep.dshMessageCount ?? rep.dshMessagesCount ?? 0;
      const tdDsh = document.createElement('td');
      tdDsh.textContent = formatNumber(dshCount);
      tr.appendChild(tdDsh);

      const sqliteCount = rep.platformMessageCount ?? rep.sqliteMessagesCount ?? 0;
      const tdSqlite = document.createElement('td');
      tdSqlite.textContent = formatNumber(sqliteCount);
      tr.appendChild(tdSqlite);

      // Discrepancy breakdown calculation
      const discrepancies = Array.isArray(rep.discrepancies) ? rep.discrepancies : [];
      let missingCount = 0;
      let orphanCount = 0;
      let contentCount = 0;
      let roleCount = 0;

      discrepancies.forEach((d) => {
        if (d.type === 'missingInSqlite') missingCount++;
        else if (d.type === 'orphanInSqlite') orphanCount++;
        else if (d.type === 'contentMismatch') contentCount++;
        else if (d.type === 'roleMismatch') roleCount++;
      });

      if (discrepancies.length === 0 && rep.status !== 'matched') {
        if (dshCount > sqliteCount) missingCount = dshCount - sqliteCount;
        else if (sqliteCount > dshCount) orphanCount = sqliteCount - dshCount;
      }

      const tdDiff = document.createElement('td');
      if (rep.status === 'matched' && missingCount === 0 && orphanCount === 0 && contentCount === 0 && roleCount === 0) {
        tdDiff.appendChild(createBadgeElement(t('reconcile.discConsistent', null, 'Consistent'), 'success'));
      } else {
        const diffList = document.createElement('div');
        diffList.className = 'flex-row-wrap';

        if (missingCount > 0) {
          const b = createBadgeElement(t('reconcile.discMissing', { count: missingCount }, `${missingCount} Missing in SQLite`), 'danger');
          diffList.appendChild(b);
        }
        if (orphanCount > 0) {
          const b = createBadgeElement(t('reconcile.discOrphan', { count: orphanCount }, `${orphanCount} Orphan in SQLite`), 'warning');
          diffList.appendChild(b);
        }
        if (contentCount > 0) {
          const b = createBadgeElement(t('reconcile.discContent', { count: contentCount }, `${contentCount} Content Mismatch`), 'warning');
          diffList.appendChild(b);
        }
        if (roleCount > 0) {
          const b = createBadgeElement(t('reconcile.discRole', { count: roleCount }, `${roleCount} Role Mismatch`), 'warning');
          diffList.appendChild(b);
        }

        tdDiff.appendChild(diffList);
      }
      tr.appendChild(tdDiff);

      const tdTime = document.createElement('td');
      tdTime.className = 'text-muted';
      tdTime.textContent = rep.checkedAt ? formatDate(rep.checkedAt) : '-';
      tr.appendChild(tdTime);

      // Actions: Repair Button for drifted/missing sessions
      const tdActions = document.createElement('td');
      tdActions.className = 'file-actions-cell';

      if (rep.status !== 'matched' || discrepancies.length > 0) {
        const btnRepair = document.createElement('button');
        btnRepair.type = 'button';
        btnRepair.className = 'btn btn-primary btn-xs btn-storage-repair';
        btnRepair.textContent = t('reconcile.btnPreviewRepair', null, 'Repair');
        btnRepair.setAttribute('data-session-id', rep.sessionId);

        btnRepair.addEventListener('click', async () => {
          try {
            btnRepair.disabled = true;
            btnRepair.textContent = t('reconcile.repairing', null, 'Repairing...');

            const targetUserId = rep.userId || state.currentUser?.id || 'alice';

            // 1. Dry Run / Preview request (does NOT expose internal file path to user in UI)
            const previewPayload = {
              userId: targetUserId,
              sessionId: rep.sessionId,
              dryRun: true,
            };
            if (rep.dshJsonlPath) {
              previewPayload.dshJsonlPath = rep.dshJsonlPath;
            }

            let previewData = null;
            try {
              const previewRes = await apiRequest('/api/admin/storage/repair', {
                method: 'POST',
                body: previewPayload,
              });
              previewData = previewRes && previewRes.data;
            } catch (prevErr) {
              // Fallback preview from current discrepancy scan if endpoint strict check
              previewData = {
                repairedCount: missingCount,
                updatedCount: contentCount + roleCount,
                deletedOrphansCount: orphanCount,
                discrepancies,
              };
            }

            const repairedCount = previewData?.repairedCount ?? missingCount;
            const updatedCount = previewData?.updatedCount ?? (contentCount + roleCount);
            const orphanTotal = previewData?.deletedOrphansCount ?? orphanCount;

            const modalTitle = t('reconcile.previewModalTitle', null, 'Storage Repair Preview & Confirmation');
            const modalMsg = `${t('reconcile.previewModalDesc', null, 'Reconciliation preview analyzed discrepancies:')}\n• ${t('reconcile.previewCountMissing', { count: repairedCount }, `Missing Messages to Backfill: ${repairedCount}`)}\n• ${t('reconcile.previewCountContent', { count: updatedCount }, `Mismatched Messages to Update: ${updatedCount}`)}\n• ${t('reconcile.previewCountOrphan', { count: orphanTotal }, `Orphan Messages in SQLite: ${orphanTotal}`)}`;

            showConfirmation(modalTitle, modalMsg, async () => {
              try {
                btnRepair.disabled = true;
                btnRepair.textContent = t('reconcile.repairing', null, 'Repairing...');

                const repairPayload = {
                  userId: targetUserId,
                  sessionId: rep.sessionId,
                  dryRun: false,
                };
                if (rep.dshJsonlPath) {
                  repairPayload.dshJsonlPath = rep.dshJsonlPath;
                }

                const execRes = await apiRequest('/api/admin/storage/repair', {
                  method: 'POST',
                  body: repairPayload,
                });

                const execData = execRes && execRes.data;
                const totalReconciled = (execData?.repairedCount ?? repairedCount) + (execData?.updatedCount ?? updatedCount);
                showToast(
                  t('reconcile.repairSuccess', { count: totalReconciled }, `Storage repaired successfully (${totalReconciled} records reconciled).`),
                  'success'
                );

                // Refresh reconcile view to verify matched state
                await renderStorageReconcileView(container);
              } catch (execErr) {
                showToast(getSafeErrorMessage(execErr, t('reconcile.repairFailed', { error: execErr?.message || 'Unknown error' }, 'Failed to repair storage.')), 'error');
              } finally {
                btnRepair.disabled = false;
                btnRepair.textContent = t('reconcile.btnPreviewRepair', null, 'Repair');
              }
            });
          } catch (err) {
            showToast(getSafeErrorMessage(err, t('reconcile.repairFailed', { error: err?.message || 'Unknown error' }, 'Failed to repair storage.')), 'error');
          } finally {
            btnRepair.disabled = false;
            btnRepair.textContent = t('reconcile.btnPreviewRepair', null, 'Repair');
          }
        });

        tdActions.appendChild(btnRepair);
      }

      tr.appendChild(tdActions);
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    tableContainer.appendChild(table);
    section.appendChild(tableContainer);
    container.appendChild(section);
  } else {
    container.appendChild(createStateCard('reconcile.emptyTitle', 'reconcile.emptyDesc'));
  }
}

// User Model Config View (for Member / Bob)
async function renderUserModelConfigView(container) {
  let modelData = null;
  let userOverrideData = null;
  let isUnavailable = false;

  try {
    const [mRes, oRes] = await Promise.all([
      apiRequest('/api/models'),
      apiRequest('/api/account/model-override').catch(() => ({ data: null })),
    ]);
    modelData = mRes && mRes.data;
    userOverrideData = oRes && oRes.data;
  } catch {
    isUnavailable = true;
  }

  container.replaceChildren();
  container.appendChild(
    createHeader(
      'models.userTitle',
      'models.userSubtitle',
      () => renderManagementView('management/models/model-config')
    )
  );

  if (isUnavailable || !modelData) {
    container.appendChild(
      createStateCard(
        'models.userUnavailableTitle',
        'models.userUnavailableDesc',
        true
      )
    );
    return;
  }

  const providersMap = modelData.providers || {};
  const activeDef = userOverrideData && userOverrideData.provider
    ? `${userOverrideData.provider} / ${userOverrideData.model}`
    : (modelData.defaultModel ? `${modelData.defaultModel.provider} / ${modelData.defaultModel.model}` : (getLocale() === 'zh-CN' ? '未配置' : 'Unconfigured'));

  const kpiGrid = document.createElement('div');
  kpiGrid.className = 'kpi-grid';
  kpiGrid.appendChild(createKpiCard(t('models.kpiActiveDefault', null, 'Active Default Model'), activeDef, userOverrideData ? t('models.badgeOverride', null, 'Active Platform Override') : t('models.badgeInherit', null, 'Inheriting DSH Default')));
  kpiGrid.appendChild(createKpiCard(t('models.kpiInferenceMode', null, 'Inference Mode'), 'Streaming SSE', getLocale() === 'zh-CN' ? '逐 Token 响应式流式传输' : 'Token-by-token responsive delivery'));
  kpiGrid.appendChild(createKpiCard(t('models.kpiReasoningEngine', null, 'Reasoning Engine'), getLocalizedEnum('status', 'active'), getLocale() === 'zh-CN' ? '支持 DeepSeek 多轮深度推理' : 'DeepSeek multi-turn reasoning supported'));
  container.appendChild(kpiGrid);

  // Effective Model Resolution Preview
  await renderEffectiveModelPreview(container, state.currentSpaceId, state.currentSessionId);

  // User Preference Override Section
  const prefSection = document.createElement('div');
  prefSection.className = 'management-section';
  const sHeadPref = document.createElement('div');
  sHeadPref.className = 'section-header';
  const h3Pref = document.createElement('h3');
  h3Pref.textContent = t('models.userPreferenceTitle', null, 'My Model Preference');
  sHeadPref.appendChild(h3Pref);
  prefSection.appendChild(sHeadPref);

  const prefPanel = document.createElement('div');
  prefPanel.className = 'card-panel';
  const formPref = document.createElement('form');
  formPref.id = 'form-user-model-preference';

  const grpPrefProvider = document.createElement('div');
  grpPrefProvider.className = 'form-group';
  const lblPrefProvider = document.createElement('label');
  lblPrefProvider.textContent = t('models.labelProvider', null, 'Provider *');
  const selPrefProvider = document.createElement('select');
  selPrefProvider.className = 'form-select';

  Object.keys(providersMap).forEach((pkey) => {
    const opt = document.createElement('option');
    opt.value = pkey;
    opt.textContent = `${providersMap[pkey].displayName || pkey}`;
    selPrefProvider.appendChild(opt);
  });

  const grpPrefModel = document.createElement('div');
  grpPrefModel.className = 'form-group';
  const lblPrefModel = document.createElement('label');
  lblPrefModel.textContent = t('models.labelModel', null, 'Model *');
  const selPrefModel = document.createElement('select');
  selPrefModel.className = 'form-select';

  function populateUserModels(pkey) {
    selPrefModel.replaceChildren();
    const p = providersMap[pkey];
    if (p && Array.isArray(p.models) && p.models.length > 0) {
      p.models.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name ? `${m.name} (${m.id})` : m.id;
        selPrefModel.appendChild(opt);
      });
    } else {
      const opt = document.createElement('option');
      opt.value = 'default';
      opt.textContent = t('common.defaultOption', null, 'default');
      selPrefModel.appendChild(opt);
    }
  }

  selPrefProvider.addEventListener('change', () => populateUserModels(selPrefProvider.value));
  if (userOverrideData && userOverrideData.provider) {
    selPrefProvider.value = userOverrideData.provider;
  } else if (modelData.defaultModel && modelData.defaultModel.provider) {
    selPrefProvider.value = modelData.defaultModel.provider;
  }
  populateUserModels(selPrefProvider.value);
  if (userOverrideData && userOverrideData.model) {
    selPrefModel.value = userOverrideData.model;
  } else if (modelData.defaultModel && modelData.defaultModel.model) {
    selPrefModel.value = modelData.defaultModel.model;
  }

  grpPrefProvider.appendChild(lblPrefProvider);
  grpPrefProvider.appendChild(selPrefProvider);
  grpPrefModel.appendChild(lblPrefModel);
  grpPrefModel.appendChild(selPrefModel);
  formPref.appendChild(grpPrefProvider);
  formPref.appendChild(grpPrefModel);

  const actRow = document.createElement('div');
  actRow.className = 'form-actions';
  const btnSavePref = document.createElement('button');
  btnSavePref.type = 'submit';
  btnSavePref.className = 'btn btn-primary';
  btnSavePref.textContent = t('models.btnSavePreference', null, 'Save Preference');
  actRow.appendChild(btnSavePref);

  if (userOverrideData) {
    const btnResetPref = document.createElement('button');
    btnResetPref.type = 'button';
    btnResetPref.className = 'btn btn-secondary';
    btnResetPref.textContent = t('models.btnResetOverride', null, 'Reset to DSH Default');
    btnResetPref.addEventListener('click', async () => {
      try {
        btnResetPref.disabled = true;
        await apiRequest('/api/account/model-override', { method: 'DELETE' });
        showToast(getLocale() === 'zh-CN' ? '已恢复为默认模型' : 'Reset to default model successfully', 'success');
        await renderManagementView('management/models/model-config');
      } catch (err) {
        showToast(getSafeErrorMessage(err, 'Failed to reset preference.'), 'error');
      } finally {
        btnResetPref.disabled = false;
      }
    });
    actRow.appendChild(btnResetPref);
  }

  formPref.appendChild(actRow);
  formPref.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      btnSavePref.disabled = true;
      await apiRequest('/api/account/model-override', {
        method: 'PUT',
        body: JSON.stringify({
          provider: selPrefProvider.value,
          model: selPrefModel.value,
        }),
      });
      showToast(getLocale() === 'zh-CN' ? '个人模型偏好已保存' : 'Model preference saved successfully', 'success');
      await renderManagementView('management/models/model-config');
    } catch (err) {
      showToast(getSafeErrorMessage(err, 'Failed to save preference.'), 'error');
    } finally {
      btnSavePref.disabled = false;
    }
  });

  prefPanel.appendChild(formPref);
  prefSection.appendChild(prefPanel);
  container.appendChild(prefSection);

  // Available Providers Table
  const tableSection = document.createElement('div');
  tableSection.className = 'management-section';
  const h3Table = document.createElement('h3');
  h3Table.textContent = t('models.providersTableTitle', null, 'Discovered Providers & Credential Status');
  tableSection.appendChild(h3Table);

  const tableContainer = document.createElement('div');
  tableContainer.className = 'data-table-container';
  const table = document.createElement('table');
  table.className = 'data-table';

  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');
  const colKeys = ['models.colProviderId', 'models.colDisplayName', 'models.colProtocol', 'models.colConfigured', 'models.colModels'];
  colKeys.forEach((k) => {
    const th = document.createElement('th');
    th.textContent = t(k, null, k);
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  Object.keys(providersMap).forEach((pkey) => {
    const p = providersMap[pkey];
    const tr = document.createElement('tr');
    const tdId = document.createElement('td');
    tdId.className = 'mono-cell';
    tdId.textContent = p.id;
    tr.appendChild(tdId);

    const tdName = document.createElement('td');
    tdName.textContent = p.displayName || p.id;
    tr.appendChild(tdName);

    const tdApi = document.createElement('td');
    tdApi.className = 'mono-cell';
    tdApi.textContent = p.api || 'openai-completions';
    tr.appendChild(tdApi);

    const tdStatus = document.createElement('td');
    const statusLabel = p.configured ? t('models.statusConfigured', null, 'Configured') : t('models.statusNoToken', null, 'Unconfigured');
    tdStatus.appendChild(createBadgeElement(statusLabel, p.configured ? 'success' : 'danger'));
    tr.appendChild(tdStatus);

    const tdModels = document.createElement('td');
    const modelNames = (p.models || []).map((m) => m.id).join(', ');
    tdModels.textContent = modelNames || (getLocale() === 'zh-CN' ? '未指定具体模型' : 'None specified');
    tr.appendChild(tdModels);
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  tableContainer.appendChild(table);
  tableSection.appendChild(tableContainer);
  container.appendChild(tableSection);
}

// Model Usage & Token Metering View
async function renderModelUsageView(container) {
  const isAdmin = Boolean(state.currentUser && state.currentUser.role === 'admin');
  const endpoint = isAdmin ? '/api/admin/quotas' : '/api/manage/quotas';

  let quotaData = null;
  let isUnavailable = false;

  try {
    const res = await apiRequest(endpoint);
    quotaData = res && res.data;
  } catch {
    isUnavailable = true;
  }

  container.replaceChildren();
  container.appendChild(
    createHeader(
      'models.usageTitle',
      'models.usageSubtitle',
      () => renderManagementView('management/models/model-usage')
    )
  );

  // Usage Snapshot Export Toolbar (Native <a> streaming download with cookie auth)
  const exportBar = document.createElement('div');
  exportBar.className = 'filter-toolbar mb-2';
  const exportCsvLink = document.createElement('a');
  exportCsvLink.className = 'btn btn-secondary btn-sm';
  exportCsvLink.href = '/api/admin/usage/export?format=csv&limit=10000';
  exportCsvLink.setAttribute('download', 'usage_snapshot.csv');
  exportCsvLink.textContent = getLocale() === 'zh-CN' ? '导出用量快照 (CSV)' : 'Export Usage Snapshot (CSV)';

  const exportJsonlLink = document.createElement('a');
  exportJsonlLink.className = 'btn btn-secondary btn-sm';
  exportJsonlLink.href = '/api/admin/usage/export?format=jsonl&limit=10000';
  exportJsonlLink.setAttribute('download', 'usage_snapshot.jsonl');
  exportJsonlLink.textContent = getLocale() === 'zh-CN' ? '导出用量快照 (JSONL)' : 'Export Usage Snapshot (JSONL)';

  exportBar.appendChild(exportCsvLink);
  exportBar.appendChild(exportJsonlLink);
  container.appendChild(exportBar);

  if (isUnavailable || !quotaData) {
    container.appendChild(
      createStateCard(
        'models.usageUnavailableTitle',
        'models.usageUnavailableDesc',
        true
      )
    );
    return;
  }

  // Display token usage metrics
  if (quotaData.usage) {
    const kpiGrid = document.createElement('div');
    kpiGrid.className = 'kpi-grid';

    const formatLimit = (lim) => {
      if (typeof lim === 'number' && lim < 0) {
        return getLocale() === 'zh-CN' ? '无限制' : 'Unlimited';
      }
      return typeof lim === 'number' ? formatNumber(lim) : (getLocale() === 'zh-CN' ? '未设定' : 'Unset');
    };

    const tokensUsage = typeof quotaData.usage.tokens === 'number' ? formatNumber(quotaData.usage.tokens) : getLocalizedEnum('status', 'unavailable');
    const tokensLimit = quotaData.limit ? formatLimit(quotaData.limit.tokens) : (getLocale() === 'zh-CN' ? '未设定' : 'Unset');
    kpiGrid.appendChild(createKpiCard('models.kpiTokenConsumption', tokensUsage, `${getLocale() === 'zh-CN' ? '配额上限' : 'Limit'}: ${tokensLimit}`));

    const msgsUsage = typeof quotaData.usage.messages === 'number' ? formatNumber(quotaData.usage.messages) : getLocalizedEnum('status', 'unavailable');
    const msgsLimit = quotaData.limit ? formatLimit(quotaData.limit.messages) : (getLocale() === 'zh-CN' ? '未设定' : 'Unset');
    kpiGrid.appendChild(createKpiCard('models.kpiMessageVolume', msgsUsage, `${getLocale() === 'zh-CN' ? '配额上限' : 'Limit'}: ${msgsLimit}`));

    const turnsUsage = typeof quotaData.usage.turns === 'number' ? formatNumber(quotaData.usage.turns) : getLocalizedEnum('status', 'unavailable');
    const turnsLimit = quotaData.limit ? formatLimit(quotaData.limit.turns) : (getLocale() === 'zh-CN' ? '未设定' : 'Unset');
    kpiGrid.appendChild(createKpiCard('models.kpiExecutionTurns', turnsUsage, `${getLocale() === 'zh-CN' ? '配额上限' : 'Limit'}: ${turnsLimit}`));

    const apisUsage = typeof quotaData.usage.api_calls === 'number' ? formatNumber(quotaData.usage.api_calls) : getLocalizedEnum('status', 'unavailable');
    kpiGrid.appendChild(createKpiCard('models.kpiApiInvocations', apisUsage, getLocale() === 'zh-CN' ? 'HTTP REST 请求数' : 'HTTP REST requests'));
    container.appendChild(kpiGrid);
  } else {
    // If admin quotas list
    container.appendChild(createStateCard('models.meteringActiveTitle', 'models.meteringActiveDesc'));
  }
}

async function renderManagementView(rawRoute) {
  const canvas = document.getElementById('management-canvas');
  if (!canvas) return;

  const isAdmin = Boolean(state.currentUser && state.currentUser.role === 'admin');
  const parsed = parseManagementRoute(rawRoute, isAdmin);
  const route = (parsed && parsed.canonicalHash) ? parsed.canonicalHash.replace(/^#/, '') : rawRoute;
  state.currentRoute = route;

  // Increment render generation to cancel any in-flight async renders
  state.managementRenderGen += 1;
  const currentGen = state.managementRenderGen;

  canvas.replaceChildren(createSkeletonLoader());

  // Render into detached off-DOM container to prevent mutation races
  const offDomContainer = document.createElement('div');
  offDomContainer.className = 'management-canvas-inner';

  try {
    if (route === 'admin-dashboard') {
      await renderAdminDashboardView(offDomContainer);
    } else if (route === 'admin-users') {
      await renderAdminUsersView(offDomContainer);
    } else if (route === 'admin-spaces') {
      await renderAdminSpacesView(offDomContainer);
    } else if (route === 'admin-models') {
      await renderAdminModelsView(offDomContainer);
    } else if (route === 'admin-runtime') {
      await renderAdminRuntimeView(offDomContainer);
    } else if (route === 'admin-plugins') {
      await renderAdminPluginsView(offDomContainer);
    } else if (route === 'admin-security') {
      await renderAdminSecurityView(offDomContainer);
    } else if (route === 'files') {
      await renderFilesView(offDomContainer);
    } else if (route === 'tasks') {
      await renderTasksView(offDomContainer);
    } else if (route === 'instructions' || route === 'space-instructions') {
      await renderSpaceInstructionsView(offDomContainer);
    } else if (route === 'agent-profiles') {
      await renderAgentProfilesView(offDomContainer);
    } else if (route === 'extensions') {
      await renderExtensionsView(offDomContainer);
    } else if (route === 'delivery') {
      await renderDeliveryView(offDomContainer);
    } else if (route === 'quotas') {
      await renderQuotasView(offDomContainer);
    } else if (route === 'activity') {
      await renderActivityView(offDomContainer);
    } else if (route === 'imports') {
      await renderImportsView(offDomContainer);
    } else if (route === 'account') {
      await renderAccountView(offDomContainer);
    } else if (route === 'overview' || route === 'management') {
      await renderOverviewView(offDomContainer);
    } else {
      const parsed = parseManagementRoute(route, isAdmin);
      if (parsed.type === 'management-overview') {
        await renderOverviewView(offDomContainer);
      } else if (parsed.type === 'management-section') {
        const { tab, section } = parsed;
        const availableSections = (isAdmin ? TAB_SECTIONS_ADMIN : TAB_SECTIONS_MEMBER)[tab] || [];

        // Section Navigation Bar
        const sectionNav = createSectionNavBar(tab, section, availableSections);
        offDomContainer.appendChild(sectionNav);

      const sectionBody = document.createElement('div');
      sectionBody.className = 'management-section-body';

      switch (section) {
        // Runtime Tab
        case 'runtime':
          if (isAdmin) {
            await renderAdminRuntimeView(sectionBody);
          } else {
            await renderUserRuntimeView(sectionBody);
          }
          break;
        case 'plugins':
          if (isAdmin) {
            await renderAdminPluginsView(sectionBody);
          }
          break;
        case 'tasks':
          await renderTasksView(sectionBody);
          break;
        case 'security':
          if (isAdmin) {
            await renderAdminSecurityView(sectionBody);
          }
          break;

        // Workspaces Tab
        case 'spaces-sessions':
          if (isAdmin) {
            await renderAdminSpacesView(sectionBody);
          }
          break;
        case 'instructions':
          await renderSpaceInstructionsView(sectionBody);
          break;
        case 'profiles':
          await renderAgentProfilesView(sectionBody);
          break;
        case 'extensions':
          await renderExtensionsView(sectionBody);
          break;
        case 'channels':
          await renderChannelsView(sectionBody);
          break;
        case 'deliveries':
          await renderDeliveryView(sectionBody);
          break;

        // Storage Tab
        case 'files':
          await renderFilesView(sectionBody);
          break;
        case 'quotas':
          await renderQuotasView(sectionBody);
          break;
        case 'imports':
          await renderImportsView(sectionBody);
          break;
        case 'reconcile':
          if (isAdmin) {
            await renderStorageReconcileView(sectionBody);
          }
          break;

        // Users Tab
        case 'users':
          if (isAdmin) {
            await renderAdminUsersView(sectionBody);
          }
          break;
        case 'audit':
          await renderActivityView(sectionBody);
          break;
        case 'account':
          await renderAccountView(sectionBody);
          break;

        // Models Tab
        case 'model-config':
          if (isAdmin) {
            await renderAdminModelsView(sectionBody);
          } else {
            await renderUserModelConfigView(sectionBody);
          }
          break;
        case 'model-usage':
          await renderModelUsageView(sectionBody);
          break;

        default:
          sectionBody.appendChild(createStateCard('management.sectionNotFoundTitle', t('management.sectionNotFoundDesc', { section }, `No view defined for section #${section}`), false, true));
      }

      offDomContainer.appendChild(sectionBody);
    } else {
      offDomContainer.replaceChildren(createStateCard('management.viewNotFoundTitle', t('management.viewNotFoundDesc', { route }, `No management canvas defined for route #${route}`), false, true));
    }
  }

  // Commit off-DOM rendered tree only if route and generation are still current
  if (state.managementRenderGen === currentGen && state.currentRoute === route) {
    canvas.replaceChildren(...offDomContainer.childNodes);
  }
} catch (err) {
  if (state.managementRenderGen === currentGen && state.currentRoute === route) {
      canvas.replaceChildren(
        createHeader('management.headerViewTitle', 'management.headerViewDesc', () => renderManagementView(route)),
        createStateCard('management.viewLoadErrorTitle', err ? String(err.stack || err.message || err) : 'management.viewLoadErrorDesc', false, true)
      );
    }
  }
}

// 0. Files Workbench View (Self: /api/spaces/:spaceId/files* on safe container volume)

/**
 * Trigger native streaming browser download using real <a href="..." download> element.
 * Does NOT buffer large files into JavaScript Blob/memory.
 */
function triggerNativeDownload(downloadUrl, filename) {
  const anchor = document.createElement('a');
  anchor.href = downloadUrl;
  anchor.download = filename || 'download';
  anchor.className = 'hidden';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * Render or refresh the file upload progress tray.
 */
function renderFilesUploadTray() {
  const tray = document.getElementById('files-upload-tray');
  if (!tray) return;

  if (state.fileUploadQueue.length === 0) {
    tray.replaceChildren();
    tray.classList.add('hidden');
    return;
  }

  tray.classList.remove('hidden');
  tray.replaceChildren();

  const trayHeader = document.createElement('div');
  trayHeader.className = 'files-upload-tray-header';

  const totalCount = state.fileUploadQueue.length;
  const completedCount = state.fileUploadQueue.filter((item) => item.status === 'completed').length;
  const activeCount = state.fileUploadQueue.filter((item) => item.status === 'uploading' || item.status === 'pending').length;

  const headerLeft = document.createElement('span');
  headerLeft.textContent = activeCount > 0
    ? tr('files.uploadInProgress', { current: formatNumber(completedCount + 1), total: formatNumber(totalCount) }, `Uploading ${completedCount + 1} of ${totalCount} files...`)
    : tr('files.batchUploadComplete', { count: formatNumber(completedCount) }, `Uploaded ${completedCount} file(s) successfully.`);
  trayHeader.appendChild(headerLeft);

  const hasFinished = state.fileUploadQueue.some((item) => item.status === 'completed' || item.status === 'failed' || item.status === 'cancelled');
  if (hasFinished && activeCount === 0) {
    const btnDismiss = document.createElement('button');
    btnDismiss.type = 'button';
    btnDismiss.className = 'btn btn-secondary btn-xs';
    btnDismiss.textContent = getLocale() === 'zh-CN' ? '清除完成项' : 'Dismiss';
    btnDismiss.addEventListener('click', () => {
      state.fileUploadQueue = state.fileUploadQueue.filter((item) => item.status === 'pending' || item.status === 'uploading');
      renderFilesUploadTray();
    });
    trayHeader.appendChild(btnDismiss);
  }

  tray.appendChild(trayHeader);

  for (const item of state.fileUploadQueue) {
    const itemRow = document.createElement('div');
    itemRow.className = 'files-upload-item';

    const header = document.createElement('div');
    header.className = 'files-upload-item-header';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'files-upload-item-name';
    nameSpan.textContent = item.file.name;
    header.appendChild(nameSpan);

    const actions = document.createElement('div');
    actions.className = 'files-upload-item-actions';

    const progressText = document.createElement('span');
    progressText.className = 'files-upload-item-progress-text';
    progressText.textContent = item.status === 'completed'
      ? (getLocale() === 'zh-CN' ? '已完成' : '100%')
      : item.status === 'cancelled'
        ? (getLocale() === 'zh-CN' ? '已取消' : 'Cancelled')
        : item.status === 'failed'
          ? (getLocale() === 'zh-CN' ? '已失败' : 'Failed')
          : `${item.percent}%`;
    actions.appendChild(progressText);

    if (item.status === 'uploading' || item.status === 'pending') {
      const btnCancel = document.createElement('button');
      btnCancel.type = 'button';
      btnCancel.className = 'btn btn-secondary btn-xs';
      btnCancel.textContent = tr('files.btnCancelUpload', null, 'Cancel');
      btnCancel.title = `${tr('files.btnCancelUpload', null, 'Cancel')} ${item.file.name}`;
      btnCancel.addEventListener('click', () => {
        if (item.xhr && typeof item.xhr.abort === 'function') {
          item.xhr.abort();
        }
        item.status = 'cancelled';
        showToast(tr('files.uploadCancelled', { name: item.file.name }, `Upload cancelled for "${item.file.name}".`), 'info');
        processFileUploadQueue();
        renderFilesUploadTray();
      });
      actions.appendChild(btnCancel);
    }

    header.appendChild(actions);
    itemRow.appendChild(header);

    const progressBg = document.createElement('div');
    progressBg.className = 'files-upload-progress-bar-bg';

    const progressFill = document.createElement('div');
    const roundedPercent = Math.min(100, Math.max(0, Math.floor(item.percent / 10) * 10));
    progressFill.className = `files-upload-progress-bar-fill progress-${roundedPercent}`;
    progressBg.appendChild(progressFill);
    itemRow.appendChild(progressBg);

    tray.appendChild(itemRow);
  }
}

/**
 * Process next items in the upload queue with bounded concurrency = 2.
 */
function processFileUploadQueue() {
  const MAX_CONCURRENT = 2;

  while (state.activeUploadCount < MAX_CONCURRENT) {
    const nextItem = state.fileUploadQueue.find((item) => item.status === 'pending');
    if (!nextItem) break;

    state.activeUploadCount++;
    nextItem.status = 'uploading';
    renderFilesUploadTray();
    uploadSingleFile(nextItem);
  }

  if (state.activeUploadCount === 0) {
    const allDone = state.fileUploadQueue.length > 0 && state.fileUploadQueue.every((item) => item.status === 'completed' || item.status === 'failed' || item.status === 'cancelled');
    if (allDone) {
      const completedCount = state.fileUploadQueue.filter((item) => item.status === 'completed').length;
      if (completedCount > 0) {
        showToast(tr('files.batchUploadComplete', { count: formatNumber(completedCount) }, `Uploaded ${completedCount} file(s) successfully.`), 'success');
        // Only refresh if user is still on the same space in files view
        const lastItem = state.fileUploadQueue[state.fileUploadQueue.length - 1];
        if (lastItem && state.filesActiveSpaceId === lastItem.spaceId && (state.currentRoute === 'files' || (typeof window !== 'undefined' && window.location.hash.includes('files')))) {
          renderManagementView(state.currentRoute);
        }
      }
      renderFilesUploadTray();
    }
  }
}

/**
 * Perform single file multipart upload via XHR with upload progress, CSRF/cookie/Origin support, and 409 conflict handling.
 */
function uploadSingleFile(item) {
  const xhr = new XMLHttpRequest();
  item.xhr = xhr;

  let uploadUrl = `/api/spaces/${encodeURIComponent(item.spaceId)}/files/upload?path=${encodeURIComponent(item.targetPath)}`;
  if (item.isOverwrite && item.overwriteEtag) {
    uploadUrl += '&overwrite=true';
  }

  xhr.open('POST', uploadUrl, true);
  xhr.withCredentials = true;

  // Header Idempotency-Key (independent crypto UUID)
  xhr.setRequestHeader('Idempotency-Key', item.idempotencyKey);

  // X-Enkeep-CSRF token
  if (state.csrfToken) {
    xhr.setRequestHeader('X-Enkeep-CSRF', state.csrfToken);
  }

  // If-Match when overwriting
  if (item.isOverwrite && item.overwriteEtag) {
    xhr.setRequestHeader('If-Match', item.overwriteEtag);
  }

  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable && e.total > 0) {
      const pct = Math.min(100, Math.round((e.loaded / e.total) * 100));
      item.percent = pct;
      renderFilesUploadTray();
    }
  });

  xhr.addEventListener('load', async () => {
    state.activeUploadCount = Math.max(0, state.activeUploadCount - 1);

    if (xhr.status >= 200 && xhr.status < 300) {
      item.status = 'completed';
      item.percent = 100;
      showToast(tr('files.uploadSuccess', { name: item.file.name }, `Uploaded "${item.file.name}" successfully.`), 'success');
      processFileUploadQueue();
      renderFilesUploadTray();
    } else if (xhr.status === 409 && !item.isOverwrite) {
      // 409 Conflict: File exists. Prompt for overwrite confirmation (never auto-overwrite)
      item.status = 'paused_conflict';
      renderFilesUploadTray();

      const confirmTitle = t('files.confirmOverwriteTitle', null, getLocale() === 'zh-CN' ? '确认覆盖文件' : 'Confirm File Overwrite');
      const confirmMsg = tr(
        'files.confirmOverwrite',
        { name: item.file.name },
        `File "${item.file.name}" already exists. Do you want to overwrite it?`
      );

      const shouldOverwrite = await showConfirmDialog(confirmTitle, confirmMsg);

      if (shouldOverwrite) {
        // Retrieve latest ETag from list entries
        let existingEtag = null;
        try {
          const listRes = await apiRequest(
            `/api/spaces/${encodeURIComponent(item.spaceId)}/files?path=${encodeURIComponent(item.targetPath)}`
          );
          if (listRes && listRes.data && Array.isArray(listRes.data.entries)) {
            const match = listRes.data.entries.find((e) => e.name === item.file.name);
            if (match && match.etag) {
              existingEtag = match.etag;
            }
          }
        } catch (listErr) {
          showToast(getSafeErrorMessage(listErr, tr('files.operationFailed', null, 'Failed to access container volume files.')), 'error');
        }

        if (existingEtag) {
          // Retry single file with overwrite=true and If-Match and fresh idempotency key
          item.isOverwrite = true;
          item.overwriteEtag = existingEtag;
          if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            item.idempotencyKey = crypto.randomUUID();
          }
          item.status = 'pending';
          item.percent = 0;
          processFileUploadQueue();
          renderFilesUploadTray();
          return;
        } else {
          showToast(tr('files.operationFailed', null, 'Failed to resolve file ETag for overwrite.'), 'error');
        }
      }

      // User cancelled overwrite or ETag could not be resolved
      item.status = 'failed';
      showToast(tr('files.uploadCancelled', { name: item.file.name }, `Upload cancelled for "${item.file.name}".`), 'info');
      processFileUploadQueue();
      renderFilesUploadTray();
    } else {
      item.status = 'failed';
      let errPayload = null;
      try {
        errPayload = JSON.parse(xhr.responseText);
      } catch (parseErr) {
        errPayload = null;
      }
      const safeMsg = getSafeErrorMessage(
        { status: xhr.status, code: errPayload?.error?.code },
        tr('files.uploadFailed', { name: item.file.name, error: `HTTP ${xhr.status}` }, `Failed to upload "${item.file.name}".`)
      );
      showToast(safeMsg, 'error');
      processFileUploadQueue();
      renderFilesUploadTray();
    }
  });

  xhr.addEventListener('error', () => {
    state.activeUploadCount = Math.max(0, state.activeUploadCount - 1);
    if (item.status !== 'cancelled') {
      item.status = 'failed';
      showToast(t('error.network', null, 'Network connection failed.'), 'error');
    }
    processFileUploadQueue();
    renderFilesUploadTray();
  });

  xhr.addEventListener('abort', () => {
    state.activeUploadCount = Math.max(0, state.activeUploadCount - 1);
    item.status = 'cancelled';
    processFileUploadQueue();
    renderFilesUploadTray();
  });

  const formData = new FormData();
  formData.append('file', item.file, item.file.name);
  xhr.send(formData);
}

/**
 * Enqueue selected or dropped files for upload to current space and path.
 */
function enqueueFilesUpload(fileList, spaceId, targetPath) {
  if (!fileList || fileList.length === 0) return;

  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    showToast(tr('toast.cryptoUnavailable', null, 'Cryptographic context unavailable. Cannot generate Idempotency-Key.'), 'error');
    return;
  }

  const currentGen = state.managementRenderGen;

  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    const uploadItem = {
      id: `up_${crypto.randomUUID().replace(/-/g, '')}`,
      file,
      spaceId,
      targetPath,
      routeGeneration: currentGen,
      idempotencyKey: crypto.randomUUID(),
      percent: 0,
      status: 'pending',
      xhr: null,
      isOverwrite: false,
      overwriteEtag: null,
    };
    state.fileUploadQueue.push(uploadItem);
  }

  renderFilesUploadTray();
  processFileUploadQueue();
}

async function renderFilesView(container) {
  // Always ensure spaces are refreshed for space selection
  try {
    const spacesRes = await apiRequest('/api/spaces');
    if (spacesRes && spacesRes.success && Array.isArray(spacesRes.data)) {
      state.spaces = spacesRes.data;
    }
  } catch {
    // Graceful sanitized handling without console leakage of internal IDs
  }

  // Resolve active space by SPACE ID (authoritative multi-tenant resolution)
  const availableSpaces = Array.isArray(state.spaces) ? state.spaces.filter((s) => s.status !== 'archived') : [];
  let activeSpaceObj = null;

  if (state.filesActiveSpaceId) {
    activeSpaceObj = availableSpaces.find((s) => s.id === state.filesActiveSpaceId) || null;
  }
  if (!activeSpaceObj && availableSpaces.length > 0) {
    activeSpaceObj = availableSpaces[0];
    state.filesActiveSpaceId = activeSpaceObj.id;
  }

  container.replaceChildren();

  // Header
  container.appendChild(
    createHeader(
      'files.title',
      'files.subtitle',
      () => renderManagementView(state.currentRoute)
    )
  );

  // If no authoritative space exists, do not fabricate default or issue unauthorized API requests
  if (!activeSpaceObj) {
    container.appendChild(
      createStateCard(
        'files.noSpaceTitle',
        'files.noSpaceDesc',
        true
      )
    );
    return;
  }

  const activeSpaceId = activeSpaceObj.id;
  const spaceDisplayName = activeSpaceObj.name || 'Workspace';
  const currentPath = (state.filesActiveSpaceId && state.filesSpacePaths[state.filesActiveSpaceId]) || state.filesCurrentPath || '.';
  state.filesCurrentPath = currentPath;
  if (activeSpaceId) {
    state.filesSpacePaths[activeSpaceId] = currentPath;
  }

  let filesData = null;
  let fileFetchError = null;

  try {
    const res = await apiRequest(
      `/api/spaces/${encodeURIComponent(activeSpaceId)}/files?path=${encodeURIComponent(currentPath)}`
    );
    if (res && res.data && Array.isArray(res.data.entries)) {
      filesData = res.data;
    } else {
      fileFetchError = new Error('Malformed container volume directory response');
    }
  } catch (err) {
    fileFetchError = err;
  }

  const workbenchWrapper = document.createElement('div');
  workbenchWrapper.className = 'files-workbench';

  // 1. Toolbar (Space Selector + Container Volume Badge + Breadcrumbs + Actions)
  const toolbar = document.createElement('div');
  toolbar.className = 'files-toolbar';

  const toolbarLeft = document.createElement('div');
  toolbarLeft.className = 'files-toolbar-left';

  // Space selector dropdown
  const spaceLabel = document.createElement('label');
  spaceLabel.textContent = t('files.labelSpace', null, 'Space:');
  spaceLabel.className = 'form-label-inline';
  toolbarLeft.appendChild(spaceLabel);

  const spaceSelect = document.createElement('select');
  spaceSelect.id = 'files-space-select';
  spaceSelect.className = 'form-select';

  if (availableSpaces.length === 0) {
    const opt = document.createElement('option');
    opt.value = activeSpaceId;
    opt.textContent = spaceDisplayName;
    spaceSelect.appendChild(opt);
  } else {
    for (const sp of availableSpaces) {
      const opt = document.createElement('option');
      opt.value = sp.id;
      opt.textContent = sp.name || 'Workspace';
      if (sp.id === activeSpaceId) {
        opt.selected = true;
      }
      spaceSelect.appendChild(opt);
    }
  }

  spaceSelect.addEventListener('change', () => {
    state.filesActiveSpaceId = spaceSelect.value;
    state.filesCurrentPath = state.filesSpacePaths[spaceSelect.value] || '.';
    state.filesActiveFile = null;
    renderManagementView(state.currentRoute);
  });
  toolbarLeft.appendChild(spaceSelect);

  // Tenant Volume Badge (Space relative folder, NO internal paths, NO absolute paths)
  const activeSpaceName = activeSpaceObj && typeof activeSpaceObj.name === 'string' && activeSpaceObj.name.length > 0 ? activeSpaceObj.name : 'Workspace';
  const volumeBadge = document.createElement('span');
  volumeBadge.className = 'badge-container-volume';
  volumeBadge.textContent = t('files.badgeVolume', { space: activeSpaceName }, `Tenant volume / ${activeSpaceName}`);
  toolbarLeft.appendChild(volumeBadge);

  toolbar.appendChild(toolbarLeft);

  // Toolbar Right Actions
  const toolbarRight = document.createElement('div');
  toolbarRight.className = 'files-toolbar-right';

  // New Folder button
  const btnNewFolder = document.createElement('button');
  btnNewFolder.type = 'button';
  btnNewFolder.id = 'btn-files-new-folder';
  btnNewFolder.className = 'btn btn-secondary btn-sm';
  btnNewFolder.textContent = t('files.btnNewFolder', null, '+ New Folder');
  btnNewFolder.addEventListener('click', async () => {
    const folderPromptMsg = getLocale() === 'zh-CN' ? '请输入新建文件夹名称:' : 'Enter new folder name:';
    const folderName = window.prompt(folderPromptMsg);
    if (!folderName || folderName.trim().length === 0) return;
    const cleanName = folderName.trim();
    const targetPath = currentPath === '.' ? cleanName : `${currentPath}/${cleanName}`;

    try {
      if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
        showToast(tr('toast.cryptoUnavailable', null, 'Cryptographic context unavailable. Cannot generate Idempotency-Key.'), 'error');
        return;
      }
      await apiRequest(`/api/spaces/${encodeURIComponent(activeSpaceId)}/files/mkdir`, {
        method: 'POST',
        headers: {
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: {
          path: targetPath,
        },
      });
      showToast(getLocale() === 'zh-CN' ? `已创建文件夹 "${cleanName}"` : `Created folder "${cleanName}"`, 'success');
      renderManagementView(state.currentRoute);
    } catch (err) {
      showToast(getSafeErrorMessage(err, 'Failed to create folder.'), 'error');
    }
  });
  toolbarRight.appendChild(btnNewFolder);

  // New File button
  const btnNewFile = document.createElement('button');
  btnNewFile.type = 'button';
  btnNewFile.id = 'btn-files-new-file';
  btnNewFile.className = 'btn btn-secondary btn-sm';
  btnNewFile.textContent = t('files.btnNewFile', null, '+ New File');
  btnNewFile.addEventListener('click', () => {
    const filePromptMsg = getLocale() === 'zh-CN' ? '请输入新建文件名称 (例如 script.js, notes.txt):' : 'Enter new file name (e.g. script.js, notes.txt):';
    const fileName = window.prompt(filePromptMsg);
    if (!fileName || fileName.trim().length === 0) return;
    const cleanFile = fileName.trim();
    const targetPath = currentPath === '.' ? cleanFile : `${currentPath}/${cleanFile}`;

    state.filesActiveFile = {
      path: targetPath,
      content: '',
      isNew: true,
    };
    renderManagementView(state.currentRoute);
  });
  toolbarRight.appendChild(btnNewFile);

  // Upload Files button & hidden input
  const fileUploadInput = document.createElement('input');
  fileUploadInput.type = 'file';
  fileUploadInput.multiple = true;
  fileUploadInput.id = 'files-upload-input';
  fileUploadInput.className = 'hidden';
  fileUploadInput.addEventListener('change', (e) => {
    const target = e.target;
    if (target && target.files && target.files.length > 0) {
      enqueueFilesUpload(target.files, activeSpaceId, currentPath);
      target.value = '';
    }
  });
  toolbarRight.appendChild(fileUploadInput);

  const btnUpload = document.createElement('button');
  btnUpload.type = 'button';
  btnUpload.id = 'btn-files-upload';
  btnUpload.className = 'btn btn-primary btn-sm';
  btnUpload.textContent = t('files.btnUpload', null, 'Upload Files');
  btnUpload.addEventListener('click', () => {
    fileUploadInput.click();
  });
  toolbarRight.appendChild(btnUpload);

  toolbar.appendChild(toolbarRight);
  workbenchWrapper.appendChild(toolbar);

  // 2. Breadcrumbs Bar
  const breadcrumbBar = document.createElement('div');
  breadcrumbBar.className = 'files-breadcrumbs';

  const rootBtn = document.createElement('button');
  rootBtn.type = 'button';
  rootBtn.className = 'files-crumb-btn';
  rootBtn.textContent = t('files.crumbRoot', null, 'Root (/)');
  rootBtn.addEventListener('click', () => {
    state.filesCurrentPath = '.';
    if (activeSpaceId) state.filesSpacePaths[activeSpaceId] = '.';
    renderManagementView(state.currentRoute);
  });
  breadcrumbBar.appendChild(rootBtn);

  if (currentPath !== '.') {
    const parts = currentPath.split('/');
    let accumulated = '';
    for (let i = 0; i < parts.length; i++) {
      const sep = document.createElement('span');
      sep.textContent = ' / ';
      breadcrumbBar.appendChild(sep);

      accumulated = accumulated ? `${accumulated}/${parts[i]}` : parts[i];
      const targetAcc = accumulated;

      if (i === parts.length - 1) {
        const activeCrumb = document.createElement('span');
        activeCrumb.textContent = parts[i];
        activeCrumb.className = 'breadcrumb-current';
        breadcrumbBar.appendChild(activeCrumb);
      } else {
        const crumbBtn = document.createElement('button');
        crumbBtn.type = 'button';
        crumbBtn.className = 'files-crumb-btn';
        crumbBtn.textContent = parts[i];
        crumbBtn.addEventListener('click', () => {
          state.filesCurrentPath = targetAcc;
          if (activeSpaceId) state.filesSpacePaths[activeSpaceId] = targetAcc;
          renderManagementView(state.currentRoute);
        });
        breadcrumbBar.appendChild(crumbBtn);
      }
    }
  }
  workbenchWrapper.appendChild(breadcrumbBar);

  // 2b. File Upload Progress Tray
  const uploadTray = document.createElement('div');
  uploadTray.id = 'files-upload-tray';
  uploadTray.className = 'files-upload-tray hidden';
  workbenchWrapper.appendChild(uploadTray);
  renderFilesUploadTray();

  // 2c. Drag & Drop Zone handlers on workbenchWrapper
  workbenchWrapper.classList.add('files-dropzone');
  workbenchWrapper.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!workbenchWrapper.classList.contains('files-dropzone-active')) {
      workbenchWrapper.classList.add('files-dropzone-active');
    }
  });

  workbenchWrapper.addEventListener('dragenter', (e) => {
    e.preventDefault();
    e.stopPropagation();
    workbenchWrapper.classList.add('files-dropzone-active');
  });

  workbenchWrapper.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Only remove class if leaving workbenchWrapper boundaries
    const rect = workbenchWrapper.getBoundingClientRect();
    if (
      e.clientX <= rect.left ||
      e.clientX >= rect.right ||
      e.clientY <= rect.top ||
      e.clientY >= rect.bottom
    ) {
      workbenchWrapper.classList.remove('files-dropzone-active');
    }
  });

  workbenchWrapper.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    workbenchWrapper.classList.remove('files-dropzone-active');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      enqueueFilesUpload(e.dataTransfer.files, activeSpaceId, currentPath);
    }
  });

  // Check if listing error occurred (e.g. 503 Provider Unavailable, 409 Archived, or 404 Directory Not Found)
  if (fileFetchError || !filesData) {
    const is503 = Boolean(fileFetchError && (fileFetchError.status === 503 || fileFetchError.code === 'SERVICE_UNAVAILABLE'));
    const is409 = Boolean(fileFetchError && (fileFetchError.status === 409 || fileFetchError.code === 'CONFLICT'));

    workbenchWrapper.appendChild(
      createStateCard(
        is503
          ? (getLocale() === 'zh-CN' ? '运行时容器卷不可用' : 'Runtime Container Volume Unavailable')
          : is409
            ? (getLocale() === 'zh-CN' ? '空间存储卷已归档' : 'Space Volume Archived')
            : (getLocale() === 'zh-CN' ? '文件操作失败' : 'File Operation Failed'),
        is503
          ? (getLocale() === 'zh-CN' ? `空间 "${spaceDisplayName}" 的容器运行时当前未运行或不可用。启动运行时后即可访问文件。` : `The container runtime for space "${spaceDisplayName}" is not currently running or available. Start the runtime to access files.`)
          : is409
            ? (getLocale() === 'zh-CN' ? '该工作区空间已归档，文件操作不可用。' : 'The workspace space is archived and file operations are unavailable.')
            : (getLocale() === 'zh-CN' ? '访问容器卷文件失败。' : 'Failed to access container volume files.'),
        is503,
        !is503
      )
    );
    container.appendChild(workbenchWrapper);
    return;
  }

  // 3. Main Split Grid (File Tree / Table on left, File Viewer / Editor on right)
  const filesGrid = document.createElement('div');
  filesGrid.className = 'files-grid';

  // --- Left Panel: File Listing Table ---
  const treePanel = document.createElement('div');
  treePanel.className = 'files-tree-panel';

  const treePanelHeader = document.createElement('div');
  treePanelHeader.className = 'files-panel-header';
  const treeHeaderTitle = document.createElement('span');
  treeHeaderTitle.textContent = `${getLocale() === 'zh-CN' ? '当前目录: ' : 'Directory: '}${currentPath === '.' ? '/' : currentPath}`;
  treePanelHeader.appendChild(treeHeaderTitle);

  const entryCount = document.createElement('span');
  entryCount.className = 'badge';
  entryCount.textContent = getLocale() === 'zh-CN' ? `${formatNumber(filesData.entries.length)} 项` : `${filesData.entries.length} items`;
  treePanelHeader.appendChild(entryCount);
  treePanel.appendChild(treePanelHeader);

  const tableContainer = document.createElement('div');
  tableContainer.className = 'files-table-container';

  const table = document.createElement('table');
  table.className = 'data-table';

  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');

  const thName = document.createElement('th');
  thName.textContent = t('files.colName', null, 'Name');
  trHead.appendChild(thName);

  const thType = document.createElement('th');
  thType.textContent = t('files.colType', null, 'Type');
  trHead.appendChild(thType);

  const thSize = document.createElement('th');
  thSize.textContent = t('files.colSize', null, 'Size');
  trHead.appendChild(thSize);

  const thModified = document.createElement('th');
  thModified.textContent = t('files.colModified', null, 'Modified');
  trHead.appendChild(thModified);

  const thActions = document.createElement('th');
  thActions.textContent = t('files.colActions', null, 'Actions');
  trHead.appendChild(thActions);

  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  // Go to parent directory row if not in root
  if (currentPath !== '.') {
    const trParent = document.createElement('tr');

    const tdParentName = document.createElement('td');
    tdParentName.colSpan = 5;

    const parentBtn = document.createElement('button');
    parentBtn.type = 'button';
    parentBtn.className = 'file-row-btn';
    const parentIcon = document.createElement('span');
    parentIcon.className = 'file-icon';
    parentIcon.textContent = '📁';
    parentBtn.appendChild(parentIcon);

    const parentLabel = document.createElement('span');
    parentLabel.textContent = t('files.parentFolder', null, '.. (Go to Parent Folder)');
    parentBtn.appendChild(parentLabel);

    parentBtn.addEventListener('click', () => {
      const segments = currentPath.split('/');
      segments.pop();
      const parentPath = segments.length === 0 ? '.' : segments.join('/');
      state.filesCurrentPath = parentPath;
      if (activeSpaceId) state.filesSpacePaths[activeSpaceId] = parentPath;
      renderManagementView(state.currentRoute);
    });

    tdParentName.appendChild(parentBtn);
    trParent.appendChild(tdParentName);
    tbody.appendChild(trParent);
  }

  const entries = Array.isArray(filesData.entries) ? filesData.entries : [];
  if (entries.length === 0 && currentPath === '.') {
    const trEmpty = document.createElement('tr');
    const tdEmpty = document.createElement('td');
    tdEmpty.colSpan = 5;
    tdEmpty.className = 'files-empty-state';

    const emptyTitle = document.createElement('h4');
    emptyTitle.textContent = t('files.emptyDir', null, 'Empty Directory');
    tdEmpty.appendChild(emptyTitle);

    const emptySub = document.createElement('p');
    emptySub.textContent = t('files.emptyDirSub', null, 'No files or directories found in this container space volume.');
    tdEmpty.appendChild(emptySub);

    trEmpty.appendChild(tdEmpty);
    tbody.appendChild(trEmpty);
  } else {
    for (const entry of entries) {
      const tr = document.createElement('tr');
      const isDir = entry.type === 'directory';
      const itemRelPath = currentPath === '.' ? entry.name : `${currentPath}/${entry.name}`;

      // Name column
      const tdName = document.createElement('td');
      const itemBtn = document.createElement('button');
      itemBtn.type = 'button';
      itemBtn.className = 'file-row-btn';

      const icon = document.createElement('span');
      icon.className = 'file-icon';
      icon.textContent = isDir ? '📁' : '📄';
      itemBtn.appendChild(icon);

      const nameText = document.createElement('span');
      nameText.textContent = entry.name;
      itemBtn.appendChild(nameText);

      itemBtn.addEventListener('click', async () => {
        if (isDir) {
          state.filesCurrentPath = itemRelPath;
          if (activeSpaceId) state.filesSpacePaths[activeSpaceId] = itemRelPath;
          renderManagementView(state.currentRoute);
        } else {
          // Open file in Editor/Viewer
          try {
            const fileRes = await apiRequest(
              `/api/spaces/${encodeURIComponent(activeSpaceId)}/files/content?path=${encodeURIComponent(itemRelPath)}`
            );
            if (fileRes && fileRes.data) {
              state.filesActiveFile = {
                path: itemRelPath,
                content: fileRes.data.content,
                size: fileRes.data.size,
                mtimeMs: fileRes.data.mtimeMs,
                etag: fileRes.data.etag,
                isNew: false,
              };
              renderManagementView(state.currentRoute);
            }
          } catch (err) {
            showToast(getSafeErrorMessage(err, 'Failed to open file.'), 'error');
          }
        }
      });
      tdName.appendChild(itemBtn);
      tr.appendChild(tdName);

      // Type column
      const tdType = document.createElement('td');
      const typeBadge = document.createElement('span');
      typeBadge.className = `badge ${isDir ? 'badge-user' : 'badge-active'}`;
      typeBadge.textContent = isDir ? (getLocale() === 'zh-CN' ? '目录' : 'Directory') : (getLocale() === 'zh-CN' ? '文件' : 'File');
      tdType.appendChild(typeBadge);
      tr.appendChild(tdType);

      // Size column (Strict non-negative validation; no guessing 0 when undefined)
      const tdSize = document.createElement('td');
      if (isDir) {
        tdSize.textContent = '-';
      } else if (typeof entry.size === 'number' && entry.size >= 0) {
        tdSize.textContent = formatBytes(entry.size);
      } else {
        tdSize.textContent = getLocalizedEnum('status', 'unavailable');
      }
      tr.appendChild(tdSize);

      // Modified column (Strict timestamp validation)
      const tdMod = document.createElement('td');
      if (typeof entry.mtimeMs === 'number') {
        tdMod.textContent = formatDate(entry.mtimeMs);
      } else {
        tdMod.textContent = '-';
      }
      tr.appendChild(tdMod);

      // Actions column
      const tdAct = document.createElement('td');
      tdAct.className = 'file-actions-cell';

      // Download button (files only, directories do not download)
      if (!isDir) {
        const btnDownload = document.createElement('button');
        btnDownload.type = 'button';
        btnDownload.className = 'btn btn-secondary btn-xs';
        btnDownload.textContent = t('files.btnDownload', null, 'Download');
        btnDownload.title = `${t('files.btnDownload', null, 'Download')} ${entry.name}`;
        btnDownload.addEventListener('click', (e) => {
          e.stopPropagation();
          const downloadUrl = `/api/spaces/${encodeURIComponent(activeSpaceId)}/files/download?path=${encodeURIComponent(itemRelPath)}`;
          triggerNativeDownload(downloadUrl, entry.name);
        });
        tdAct.appendChild(btnDownload);
      }

      // Delete button
      const btnDelete = document.createElement('button');
      btnDelete.type = 'button';
      btnDelete.className = 'btn btn-danger btn-xs';
      btnDelete.textContent = t('files.btnDelete', null, 'Delete');
      btnDelete.title = `${t('files.btnDelete', null, 'Delete')} ${entry.name}`;
      btnDelete.addEventListener('click', (e) => {
        e.stopPropagation();
        const deleteConfirmTitle = getLocale() === 'zh-CN' ? '确认删除文件' : 'Confirm File Deletion';
        const deleteConfirmMsg = getLocale() === 'zh-CN' ? `确定要删除 "${entry.name}" 吗？` : `Are you sure you want to delete "${entry.name}"?`;

        showConfirmation(deleteConfirmTitle, deleteConfirmMsg, async () => {
          if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
            showToast(tr('toast.cryptoUnavailable', null, 'Cryptographic context unavailable. Cannot generate Idempotency-Key.'), 'error');
            return;
          }

          try {
            const delHeaders = {
              'Idempotency-Key': crypto.randomUUID(),
            };
            const delBody = {
              path: itemRelPath,
              expectedEtag: entry.etag,
            };

            await apiRequest(
              `/api/spaces/${encodeURIComponent(activeSpaceId)}/files`,
              {
                method: 'DELETE',
                headers: delHeaders,
                body: delBody,
              }
            );
            showToast(getLocale() === 'zh-CN' ? `已删除 "${entry.name}"` : `Deleted "${entry.name}"`, 'success');
            if (state.filesActiveFile && state.filesActiveFile.path === itemRelPath) {
              state.filesActiveFile = null;
            }
            renderManagementView(state.currentRoute);
          } catch (err) {
            showToast(getSafeErrorMessage(err, 'Failed to delete file.'), 'error');
          }
        });
      });
      tdAct.appendChild(btnDelete);

      tr.appendChild(tdAct);
      tbody.appendChild(tr);
    }
  }

  table.appendChild(tbody);
  tableContainer.appendChild(table);
  treePanel.appendChild(tableContainer);
  filesGrid.appendChild(treePanel);

  // --- Right Panel: File Editor / Viewer ---
  const editorPanel = document.createElement('div');
  editorPanel.className = 'files-editor-panel';

  const activeFile = state.filesActiveFile;

  if (!activeFile) {
    const editorEmpty = document.createElement('div');
    editorEmpty.className = 'files-empty-state';

    const emptyH4 = document.createElement('h4');
    emptyH4.textContent = t('files.noFileSelected', null, 'No File Selected');
    editorEmpty.appendChild(emptyH4);

    const emptyP = document.createElement('p');
    emptyP.textContent = t('files.noFileSelectedSub', null, 'Select a file from the directory tree on the left to view or edit UTF-8 content.');
    editorEmpty.appendChild(emptyP);

    editorPanel.appendChild(editorEmpty);
  } else {
    // Editor Header
    const editorHeader = document.createElement('div');
    editorHeader.className = 'files-editor-header';

    const titleRow = document.createElement('div');
    titleRow.className = 'files-editor-title-row';

    const pathSpan = document.createElement('span');
    pathSpan.id = 'files-active-path';
    pathSpan.className = 'files-editor-path';
    pathSpan.textContent = activeFile.path;
    titleRow.appendChild(pathSpan);

    const btnClose = document.createElement('button');
    btnClose.type = 'button';
    btnClose.className = 'btn btn-secondary btn-xs';
    btnClose.textContent = `✕ ${t('common.close', null, 'Close')}`;
    btnClose.addEventListener('click', () => {
      state.filesActiveFile = null;
      renderManagementView(state.currentRoute);
    });
    titleRow.appendChild(btnClose);
    editorHeader.appendChild(titleRow);

    // Meta bar
    const metaBar = document.createElement('div');
    metaBar.className = 'files-editor-meta';

    if (!activeFile.isNew && typeof activeFile.size === 'number') {
      const sizeMeta = document.createElement('span');
      sizeMeta.textContent = `${t('files.colSize', null, 'Size')}: ${formatBytes(activeFile.size)}`;
      metaBar.appendChild(sizeMeta);
    }

    if (!activeFile.isNew && typeof activeFile.mtimeMs === 'number') {
      const mtimeMeta = document.createElement('span');
      mtimeMeta.textContent = `${t('files.colModified', null, 'Modified')}: ${formatDate(activeFile.mtimeMs)}`;
      metaBar.appendChild(mtimeMeta);
    } else if (activeFile.isNew) {
      const draftMeta = document.createElement('span');
      draftMeta.textContent = getLocale() === 'zh-CN' ? '新建文件 (未保存草稿)' : 'New File (Unsaved Draft)';
      metaBar.appendChild(draftMeta);
    }

    editorHeader.appendChild(metaBar);
    editorPanel.appendChild(editorHeader);

    // Content Textarea
    const textarea = document.createElement('textarea');
    textarea.id = 'files-editor-textarea';
    textarea.className = 'files-editor-textarea';
    textarea.value = activeFile.content;
    textarea.placeholder = getLocale() === 'zh-CN' ? '输入 UTF-8 文件内容...' : 'Enter UTF-8 file content...';
    editorPanel.appendChild(textarea);

    // Editor Footer Actions
    const editorFooter = document.createElement('div');
    editorFooter.className = 'files-editor-footer';

    const footerLeft = document.createElement('span');
    footerLeft.className = 'text-muted';
    footerLeft.textContent = activeFile.isNew
      ? (getLocale() === 'zh-CN' ? '新建文件 (未保存草稿)' : 'New File (Unsaved Draft)')
      : (getLocale() === 'zh-CN' ? 'UTF-8 常规文件' : 'UTF-8 Regular File');
    editorFooter.appendChild(footerLeft);

    const footerRight = document.createElement('div');
    footerRight.className = 'files-toolbar-right';

    // Download button (if not new file)
    if (!activeFile.isNew) {
      const btnDownloadActive = document.createElement('button');
      btnDownloadActive.type = 'button';
      btnDownloadActive.id = 'btn-files-download-active';
      btnDownloadActive.className = 'btn btn-secondary btn-sm';
      btnDownloadActive.textContent = t('files.btnDownloadSelected', null, 'Download File');
      btnDownloadActive.addEventListener('click', () => {
        const fileName = activeFile.path.split('/').pop() || 'file';
        const downloadUrl = `/api/spaces/${encodeURIComponent(activeSpaceId)}/files/download?path=${encodeURIComponent(activeFile.path)}`;
        triggerNativeDownload(downloadUrl, fileName);
      });
      footerRight.appendChild(btnDownloadActive);
    }

    // Reload button (if not new file)
    if (!activeFile.isNew) {
      const btnReload = document.createElement('button');
      btnReload.type = 'button';
      btnReload.className = 'btn btn-secondary btn-sm';
      btnReload.textContent = getLocale() === 'zh-CN' ? '↺ 重新加载' : '↺ Reload';
      btnReload.addEventListener('click', async () => {
        try {
          const res = await apiRequest(
            `/api/spaces/${encodeURIComponent(activeSpaceId)}/files/content?path=${encodeURIComponent(activeFile.path)}`
          );
          if (res && res.data) {
            activeFile.content = res.data.content;
            activeFile.size = res.data.size;
            activeFile.mtimeMs = res.data.mtimeMs;
            activeFile.etag = res.data.etag;
            textarea.value = res.data.content;
            showToast(getLocale() === 'zh-CN' ? '已从服务端重新加载文件' : 'Reloaded file from server', 'info');
          }
        } catch (err) {
          showToast(getSafeErrorMessage(err, 'Failed to reload file from server.'), 'error');
        }
      });
      footerRight.appendChild(btnReload);
    }

    // Save button
    const btnSave = document.createElement('button');
    btnSave.type = 'button';
    btnSave.id = 'btn-files-save';
    btnSave.className = 'btn btn-primary btn-sm';
    btnSave.textContent = t('files.btnSave', null, '💾 Save Changes');
    btnSave.addEventListener('click', async () => {
      const updatedContent = textarea.value;

      if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
        showToast(tr('toast.cryptoSendUnavailable', null, 'Secure cryptographic context (crypto.randomUUID) is unavailable. Save aborted.'), 'error');
        return;
      }
      const headers = {
        'Idempotency-Key': crypto.randomUUID(),
      };

      const body = activeFile.isNew
        ? {
            path: activeFile.path,
            content: updatedContent,
            requireAbsent: true,
          }
        : {
            path: activeFile.path,
            content: updatedContent,
            expectedEtag: activeFile.etag,
          };

      try {
        const saveRes = await apiRequest(`/api/spaces/${encodeURIComponent(activeSpaceId)}/files/content`, {
          method: 'PUT',
          headers,
          body,
        });

        if (saveRes && saveRes.data) {
          activeFile.content = updatedContent;
          activeFile.size = saveRes.data.size;
          activeFile.mtimeMs = saveRes.data.mtimeMs;
          activeFile.etag = saveRes.data.etag;
          activeFile.isNew = false;
          showToast(getLocale() === 'zh-CN' ? `成功保存 "${activeFile.path}"` : `Saved "${activeFile.path}" successfully`, 'success');
          renderManagementView(state.currentRoute);
        }
      } catch (err) {
        if (err && err.status === 409) {
          showToast(t('files.conflictWarning', null, 'Conflict: File was modified by another operation. Reload before saving.'), 'error');
        } else {
          showToast(getSafeErrorMessage(err, 'Failed to save file.'), 'error');
        }
      }
    });
    footerRight.appendChild(btnSave);

    editorFooter.appendChild(footerRight);
    editorPanel.appendChild(editorFooter);
  }

  filesGrid.appendChild(editorPanel);
  workbenchWrapper.appendChild(filesGrid);
  container.appendChild(workbenchWrapper);
}

// 1. Overview View (Self: /api/manage/overview or Admin: /api/admin/dashboard)
async function renderUserOverviewView(container) {
  let data = null;
  let isUnavailable = false;

  try {
    const res = await apiRequest('/api/manage/overview');
    if (!res || !res.data || typeof res.data !== 'object') {
      isUnavailable = true;
    } else {
      const raw = res.data;
      // Validate exact UserOverviewData DTO
      if (
        !raw.counts ||
        typeof raw.counts !== 'object' ||
        typeof raw.counts.spaces !== 'number' ||
        typeof raw.counts.sessions !== 'number' ||
        typeof raw.counts.messages !== 'number' ||
        (raw.runtime !== null && raw.runtime !== undefined && (typeof raw.runtime !== 'object' || typeof raw.runtime.status !== 'string'))
      ) {
        isUnavailable = true;
      } else {
        data = raw;
      }
    }
  } catch {
    isUnavailable = true;
  }

  container.replaceChildren();
  container.appendChild(
    createHeader('overview.userTitle', 'overview.userSubtitle', () => renderManagementView('overview'))
  );

  if (isUnavailable || !data) {
    container.appendChild(
      createStateCard(
        'overview.unavailableTitle',
        'overview.unavailableDesc',
        true
      )
    );
    return;
  }

  // Render KPI Grid with exact typed telemetry
  const kpiGrid = document.createElement('div');
  kpiGrid.className = 'kpi-grid';

  const spacesCount = data.counts.spaces;
  const sessionsCount = data.counts.sessions;
  const messagesCount = data.counts.messages;
  let systemMode = getLocalizedEnum('status', 'unavailable');

  if (data.runtime && typeof data.runtime === 'object') {
    const rtStatus = data.runtime.status;
    if (rtStatus === 'ok') {
      systemMode = data.runtime.toolsOperational === false
        ? (getLocale() === 'zh-CN' ? '沙箱 (工具降级)' : 'Sandbox (Tools Degraded)')
        : (getLocale() === 'zh-CN' ? '沙箱 (健康运行)' : 'Sandbox (Healthy)');
    } else if (rtStatus === 'degraded') {
      systemMode = getLocale() === 'zh-CN' ? '沙箱 (降级模式)' : 'Sandbox (Degraded)';
    } else if (rtStatus === 'error') {
      systemMode = getLocale() === 'zh-CN' ? '沙箱 (异常错误)' : 'Sandbox (Error)';
    } else {
      systemMode = getLocale() === 'zh-CN' ? '沙箱 (不可用)' : 'Sandbox (Unavailable)';
    }
  }

  const roleText = `${t('account.role', null, 'Role')}: ${getLocalizedEnum('role', state.currentUser.role)}`;
  kpiGrid.appendChild(createKpiCard('overview.kpiUserIdentity', state.currentUser.displayName || state.currentUser.username, roleText));
  kpiGrid.appendChild(createKpiCard('overview.kpiActiveSpaces', formatNumber(spacesCount), getLocale() === 'zh-CN' ? '已注册空间' : 'Registered spaces'));
  kpiGrid.appendChild(createKpiCard('overview.kpiActiveSessions', formatNumber(sessionsCount), getLocale() === 'zh-CN' ? '活跃会话实例' : 'Session instances'));
  kpiGrid.appendChild(createKpiCard('overview.kpiTotalMessages', formatNumber(messagesCount), getLocale() === 'zh-CN' ? '会话消息总数' : 'Chat conversation count'));
  kpiGrid.appendChild(createKpiCard('overview.kpiSystemMode', systemMode, 'Enkeep Platform'));

  container.appendChild(kpiGrid);

  // Section with details
  const section = document.createElement('div');
  section.className = 'management-section';

  const sectionHeader = document.createElement('div');
  sectionHeader.className = 'section-header';
  const h3 = document.createElement('h3');
  h3.textContent = t('overview.accountSummaryTitle', null, 'Account Summary');
  sectionHeader.appendChild(h3);
  section.appendChild(sectionHeader);

  const body = document.createElement('div');
  body.className = 'state-card';
  const p = document.createElement('p');
  const localizedRole = getLocalizedEnum('role', state.currentUser.role);
  p.textContent = t('overview.signedInAs', { name: state.currentUser.displayName || state.currentUser.username, role: localizedRole }, `Signed in as ${state.currentUser.displayName || state.currentUser.username} (${state.currentUser.role})`);
  body.appendChild(p);
  section.appendChild(body);

  container.appendChild(section);
}

async function renderManagementOverview(container) {
  const isAdmin = Boolean(state.currentUser && state.currentUser.role === 'admin');
  if (isAdmin) {
    await renderAdminDashboardView(container);
  } else {
    await renderUserOverviewView(container);
  }
}

async function renderOverviewView(container) {
  return renderManagementOverview(container);
}

// 2. Tasks View (GET /api/manage/tasks or /api/admin/tasks, POST /api/manage/tasks, /run, /cancel, /pause, /resume, /runs)
async function showTaskRunsModal(taskId, taskTitle) {
  const isAdmin = Boolean(state.currentUser && state.currentUser.role === 'admin');
  const endpoint = isAdmin ? `/api/admin/tasks/${taskId}/runs` : `/api/manage/tasks/${taskId}/runs`;

  const titleEl = document.getElementById('task-runs-modal-title');
  const contentEl = document.getElementById('task-runs-content');

  if (titleEl) {
    titleEl.textContent = `${t('tasks.runsModalTitle', null, 'Task Execution Runs History')}${taskTitle ? ` - ${taskTitle}` : ''}`;
  }

  if (contentEl) {
    contentEl.replaceChildren(createSkeletonLoader());
  }

  openModal('modal-task-runs');

  const modalWrapper = document.createElement('div');
  modalWrapper.className = 'task-modal-wrapper';

  // Tabs Header inside modal
  const tabsBar = document.createElement('div');
  tabsBar.className = 'modal-tabs-header';

  const btnTabRuns = document.createElement('button');
  btnTabRuns.type = 'button';
  btnTabRuns.className = 'modal-tab-btn active';
  btnTabRuns.textContent = t('tasks.runsModalTitle', null, 'Runs History');

  const btnTabWebhooks = document.createElement('button');
  btnTabWebhooks.type = 'button';
  btnTabWebhooks.className = 'modal-tab-btn';
  btnTabWebhooks.textContent = t('notifications.title', null, 'Notifications & Webhooks');

  tabsBar.appendChild(btnTabRuns);
  tabsBar.appendChild(btnTabWebhooks);
  modalWrapper.appendChild(tabsBar);

  const tabBody = document.createElement('div');
  tabBody.className = 'modal-tab-body';
  modalWrapper.appendChild(tabBody);

  const renderRunsTab = async () => {
    btnTabRuns.className = 'modal-tab-btn active';
    btnTabWebhooks.className = 'modal-tab-btn';
    tabBody.replaceChildren(createSkeletonLoader());

    try {
      const res = await apiRequest(endpoint);
      const raw = res && res.data;
      const runs = (raw && Array.isArray(raw.items)) ? raw.items : null;

      tabBody.replaceChildren();

      if (!runs) {
        tabBody.appendChild(createStateCard('tasks.unavailableTitle', 'tasks.unavailableDesc', true));
        return;
      }

      if (runs.length === 0) {
        tabBody.appendChild(createStateCard('tasks.runsEmptyTitle', 'tasks.runsEmptyDesc'));
        return;
      }

      const tableContainer = document.createElement('div');
      tableContainer.className = 'data-table-container';
      const table = document.createElement('table');
      table.className = 'data-table';

      const thead = document.createElement('thead');
      const trHead = document.createElement('tr');
      const cols = ['Attempt', 'Status', 'Scheduled For', 'Started At', 'Completed At', 'Turn ID', 'Tokens (P / C / Total)', 'Error Code'];
      const colKeys = ['tasks.colAttempt', 'tasks.colStatus', 'tasks.colScheduledFor', 'tasks.colStartedAt', 'tasks.colCompletedAt', 'tasks.colTurnId', 'tasks.colTokens', 'tasks.colErrorCode'];
      cols.forEach((col, idx) => {
        const th = document.createElement('th');
        th.textContent = t(colKeys[idx], null, col);
        trHead.appendChild(th);
      });
      thead.appendChild(trHead);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      runs.forEach((r) => {
        const tr = document.createElement('tr');

        const tdAttempt = document.createElement('td');
        tdAttempt.textContent = `#${r.attemptNumber || 1}`;
        tr.appendChild(tdAttempt);

        const tdStatus = document.createElement('td');
        const st = r.status || 'pending';
        const badgeType = st === 'completed' ? 'success' : (st === 'running' || st === 'claimed' ? 'running' : (st === 'failed' || st === 'cancelled' || st === 'aborted' || st === 'lease_lost' ? 'danger' : 'muted'));
        tdStatus.appendChild(createBadgeElement(st, badgeType));
        tr.appendChild(tdStatus);

        const tdScheduled = document.createElement('td');
        tdScheduled.textContent = r.scheduledFor ? formatDate(r.scheduledFor) : '-';
        tr.appendChild(tdScheduled);

        const tdStarted = document.createElement('td');
        tdStarted.textContent = r.startedAt ? formatDate(r.startedAt) : '-';
        tr.appendChild(tdStarted);

        const tdCompleted = document.createElement('td');
        tdCompleted.textContent = r.completedAt ? formatDate(r.completedAt) : '-';
        tr.appendChild(tdCompleted);

        const tdTurn = document.createElement('td');
        tdTurn.textContent = r.turnId ? r.turnId.slice(0, 16) + '...' : '-';
        if (r.turnId) tdTurn.title = r.turnId;
        tr.appendChild(tdTurn);

        const tdTokens = document.createElement('td');
        const pTok = r.promptTokens || 0;
        const cTok = r.completionTokens || 0;
        const totTok = r.totalTokens || (pTok + cTok);
        tdTokens.textContent = `${formatNumber(pTok)} / ${formatNumber(cTok)} / ${formatNumber(totTok)}`;
        tr.appendChild(tdTokens);

        const tdError = document.createElement('td');
        if (r.errorCode) {
          tdError.appendChild(createBadgeElement(r.errorCode, 'danger'));
        } else {
          tdError.textContent = '-';
        }
        tr.appendChild(tdError);

        tbody.appendChild(tr);
      });

      table.appendChild(tbody);
      tableContainer.appendChild(table);
      tabBody.appendChild(tableContainer);
    } catch (err) {
      tabBody.replaceChildren(createStateCard('tasks.unavailableTitle', 'tasks.unavailableDesc', true));
    }
  };

  const renderWebhooksTab = async () => {
    btnTabRuns.className = 'modal-tab-btn';
    btnTabWebhooks.className = 'modal-tab-btn active';
    tabBody.replaceChildren(createSkeletonLoader());

    try {
      const [subsRes, delivRes] = await Promise.allSettled([
        apiRequest(`/api/manage/tasks/${taskId}/notifications/subscriptions`),
        apiRequest(`/api/manage/tasks/${taskId}/notifications/deliveries`),
      ]);

      tabBody.replaceChildren();

      // Subscriptions Management Section
      const subsSection = document.createElement('div');
      subsSection.className = 'management-section mb-3';
      const sHead = document.createElement('div');
      sHead.className = 'section-header';
      const h3Subs = document.createElement('h3');
      h3Subs.textContent = t('notifications.subscriptionsTab', null, 'Webhook Subscriptions');
      sHead.appendChild(h3Subs);
      subsSection.appendChild(sHead);

      // Create Subscription Form
      const createSubPanel = document.createElement('div');
      createSubPanel.className = 'card-panel mb-2';
      const subForm = document.createElement('form');
      subForm.id = 'form-task-subscription';

      const row1 = document.createElement('div');
      row1.className = 'form-row grid-2-col';

      // Channel
      const grpChannel = document.createElement('div');
      grpChannel.className = 'form-group';
      const lblChannel = document.createElement('label');
      lblChannel.textContent = t('notifications.formChannel', null, 'Channel *');
      const selChannel = document.createElement('select');
      selChannel.className = 'form-select';
      const optWebhook = document.createElement('option');
      optWebhook.value = 'webhook';
      optWebhook.textContent = t('notifications.channelWebhook', null, 'Webhook');
      const optInApp = document.createElement('option');
      optInApp.value = 'in_app';
      optInApp.textContent = t('notifications.channelInApp', null, 'In-App');
      selChannel.appendChild(optWebhook);
      selChannel.appendChild(optInApp);
      grpChannel.appendChild(lblChannel);
      grpChannel.appendChild(selChannel);
      row1.appendChild(grpChannel);

      // Destination URL
      const grpDest = document.createElement('div');
      grpDest.className = 'form-group';
      const lblDest = document.createElement('label');
      lblDest.textContent = t('notifications.formDestination', null, 'Webhook Destination URL *');
      const inpDest = document.createElement('input');
      inpDest.type = 'url';
      inpDest.className = 'form-input';
      inpDest.placeholder = 'https://example.com/api/webhooks/task-events';
      grpDest.appendChild(lblDest);
      grpDest.appendChild(inpDest);
      row1.appendChild(grpDest);
      subForm.appendChild(row1);

      // Secret Input (One-Time Input - Never re-displayed in DOM)
      const grpSecret = document.createElement('div');
      grpSecret.className = 'form-group';
      const lblSecret = document.createElement('label');
      lblSecret.textContent = t('notifications.formSecret', null, 'Webhook Secret (One-Time Input)');
      const inpSecret = document.createElement('input');
      inpSecret.type = 'password';
      inpSecret.className = 'form-input';
      inpSecret.placeholder = t('notifications.formSecretPlaceholder', null, 'Optional webhook secret for signature verification...');
      const helpSecret = document.createElement('small');
      helpSecret.className = 'form-help';
      helpSecret.textContent = t('notifications.formSecretHelp', null, 'Secret is sent to the server securely for HMAC signature verification and never re-displayed in the browser.');
      grpSecret.appendChild(lblSecret);
      grpSecret.appendChild(inpSecret);
      grpSecret.appendChild(helpSecret);
      subForm.appendChild(grpSecret);

      // Trigger Events
      const grpEvents = document.createElement('div');
      grpEvents.className = 'form-group';
      const lblEvents = document.createElement('label');
      lblEvents.textContent = t('notifications.formEvents', null, 'Trigger Events *');
      grpEvents.appendChild(lblEvents);

      const eventsRow = document.createElement('div');
      eventsRow.className = 'flex-row-wrap';
      const eventTypes = ['completed', 'failed', 'cancelled', 'timeout', 'started'];
      const eventCheckboxes = {};
      eventTypes.forEach((ev) => {
        const evLabel = document.createElement('label');
        evLabel.className = 'form-label-inline mr-2';
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.value = ev;
        chk.checked = ev !== 'started';
        eventCheckboxes[ev] = chk;
        evLabel.appendChild(chk);
        evLabel.appendChild(document.createTextNode(` ${ev}`));
        eventsRow.appendChild(evLabel);
      });
      grpEvents.appendChild(eventsRow);
      subForm.appendChild(grpEvents);

      // Test Result Banner
      const testResultBanner = document.createElement('div');
      testResultBanner.className = 'mb-2 hidden';
      subForm.appendChild(testResultBanner);

      // Form Action Buttons
      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'flex-row-center';

      const btnTestWebhook = document.createElement('button');
      btnTestWebhook.type = 'button';
      btnTestWebhook.className = 'btn btn-secondary btn-sm';
      btnTestWebhook.textContent = t('notifications.btnTest', null, 'Test Webhook');
      btnTestWebhook.addEventListener('click', async () => {
        const url = inpDest.value.trim();
        if (!url) {
          showToast('Webhook destination URL is required for test.', 'warning');
          return;
        }
        try {
          btnTestWebhook.disabled = true;
          btnTestWebhook.textContent = 'Testing...';
          const testRes = await apiRequest(`/api/manage/tasks/${taskId}/notifications/test`, {
            method: 'POST',
            body: { url, secret: inpSecret.value || undefined },
          });
          const resData = testRes && testRes.data;
          if (resData && resData.success) {
            testResultBanner.className = 'callout callout-info mb-2';
            testResultBanner.textContent = t('notifications.testSuccess', {
              statusCode: resData.statusCode ?? 200,
              responseTimeMs: resData.responseTimeMs ?? 0,
            });
            testResultBanner.classList.remove('hidden');
            showToast(t('notifications.testSuccessToast', null, 'Webhook test succeeded!'), 'success');
          } else {
            const rawCode = (resData && (resData.errorCode || resData.code)) || 'unknown';
            const msg = getWebhookErrorMessage(rawCode);
            testResultBanner.className = 'callout callout-warning mb-2';
            testResultBanner.textContent = t('notifications.testFailed', { error: msg });
            testResultBanner.classList.remove('hidden');
            showToast(msg, 'error');
          }
        } catch (err) {
          const rawCode = (err && (err.code || err.errorCode)) || 'unknown';
          const msg = getWebhookErrorMessage(rawCode);
          testResultBanner.className = 'callout callout-warning mb-2';
          testResultBanner.textContent = t('notifications.testFailed', { error: msg });
          testResultBanner.classList.remove('hidden');
          showToast(msg, 'error');
        } finally {
          btnTestWebhook.disabled = false;
          btnTestWebhook.textContent = t('notifications.btnTest', null, 'Test Webhook');
        }
      });
      actionsDiv.appendChild(btnTestWebhook);

      const btnSaveSub = document.createElement('button');
      btnSaveSub.type = 'submit';
      btnSaveSub.className = 'btn btn-primary btn-sm';
      btnSaveSub.textContent = t('notifications.btnSaveSubscription', null, 'Save Subscription');
      actionsDiv.appendChild(btnSaveSub);

      subForm.appendChild(actionsDiv);

      subForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const selectedEvents = eventTypes.filter((ev) => eventCheckboxes[ev].checked);
        if (selectedEvents.length === 0) {
          showToast('Select at least one trigger event.', 'warning');
          return;
        }

        try {
          btnSaveSub.disabled = true;
          const secretValue = inpSecret.value || undefined;
          await apiRequest(`/api/manage/tasks/${taskId}/notifications/subscriptions`, {
            method: 'POST',
            body: {
              channel: selChannel.value,
              destination: selChannel.value === 'webhook' ? inpDest.value.trim() : null,
              secret: secretValue,
              events: selectedEvents,
              enabled: true,
            },
          });
          // Clear secret immediately from DOM to ensure one-time entry safety
          inpSecret.value = '';
          showToast(t('notifications.saveSuccess', null, 'Notification subscription saved successfully.'), 'success');
          await renderWebhooksTab();
        } catch (err) {
          const msg = (err && err.message && err.message.includes('rejected'))
            ? t('notifications.ssrfBlocked', null, 'Webhook destination rejected: Private or loopback IP addresses are blocked by security policy.')
            : getSafeErrorMessage(err, 'Failed to save subscription.');
          showToast(msg, 'error');
        } finally {
          btnSaveSub.disabled = false;
        }
      });

      createSubPanel.appendChild(subForm);
      subsSection.appendChild(createSubPanel);

      // Subscriptions Table
      const rawSubs = subsRes.status === 'fulfilled' && subsRes.value ? subsRes.value.data : [];
      const subs = Array.isArray(rawSubs) ? rawSubs : (rawSubs && Array.isArray(rawSubs.items) ? rawSubs.items : []);

      if (subs.length > 0) {
        const subTableContainer = document.createElement('div');
        subTableContainer.className = 'data-table-container mb-2';
        const subTable = document.createElement('table');
        subTable.className = 'data-table';

        const thead = document.createElement('thead');
        const trHead = document.createElement('tr');
        ['Channel', 'Destination', 'Events', 'Status', 'Actions'].forEach((c) => {
          const th = document.createElement('th');
          th.textContent = c;
          trHead.appendChild(th);
        });
        thead.appendChild(trHead);
        subTable.appendChild(thead);

        const tbody = document.createElement('tbody');
        subs.forEach((s) => {
          const tr = document.createElement('tr');

          const tdChan = document.createElement('td');
          tdChan.textContent = s.channel || 'webhook';
          tr.appendChild(tdChan);

          const tdDest = document.createElement('td');
          tdDest.className = 'mono-cell';
          tdDest.textContent = s.destination || '-';
          tr.appendChild(tdDest);

          const tdEvs = document.createElement('td');
          const evArr = Array.isArray(s.events) ? s.events : (typeof s.events === 'string' ? JSON.parse(s.events || '[]') : []);
          tdEvs.textContent = evArr.join(', ') || '-';
          tr.appendChild(tdEvs);

          const tdStatus = document.createElement('td');
          tdStatus.appendChild(createBadgeElement(s.enabled ? 'Enabled' : 'Disabled', s.enabled ? 'success' : 'muted'));
          tr.appendChild(tdStatus);

          const tdActions = document.createElement('td');
          tdActions.className = 'file-actions-cell';

          // Toggle Enabled
          const btnToggle = document.createElement('button');
          btnToggle.type = 'button';
          btnToggle.className = 'btn btn-secondary btn-xs';
          btnToggle.textContent = s.enabled ? 'Disable' : 'Enable';
          btnToggle.addEventListener('click', async () => {
            try {
              btnToggle.disabled = true;
              await apiRequest(`/api/manage/tasks/${taskId}/notifications/subscriptions/${s.id}`, {
                method: 'PATCH',
                body: { enabled: !s.enabled },
              });
              await renderWebhooksTab();
            } catch (err) {
              showToast(getSafeErrorMessage(err, 'Failed to toggle subscription.'), 'error');
            } finally {
              btnToggle.disabled = false;
            }
          });
          tdActions.appendChild(btnToggle);

          // Delete
          const btnDel = document.createElement('button');
          btnDel.type = 'button';
          btnDel.className = 'btn btn-danger btn-xs';
          btnDel.textContent = 'Delete';
          btnDel.addEventListener('click', async () => {
            try {
              btnDel.disabled = true;
              await apiRequest(`/api/manage/tasks/${taskId}/notifications/subscriptions/${s.id}`, {
                method: 'DELETE',
              });
              showToast(t('notifications.deleteSuccess', null, 'Subscription deleted.'), 'success');
              await renderWebhooksTab();
            } catch (err) {
              showToast(getSafeErrorMessage(err, 'Failed to delete subscription.'), 'error');
            } finally {
              btnDel.disabled = false;
            }
          });
          tdActions.appendChild(btnDel);

          tr.appendChild(tdActions);
          tbody.appendChild(tr);
        });

        subTable.appendChild(tbody);
        subTableContainer.appendChild(subTable);
        subsSection.appendChild(subTableContainer);
      }
      tabBody.appendChild(subsSection);

      // Deliveries Section
      const delivSection = document.createElement('div');
      delivSection.className = 'management-section';
      const dHead = document.createElement('div');
      dHead.className = 'section-header';
      const h3Deliv = document.createElement('h3');
      h3Deliv.textContent = t('notifications.deliveriesTab', null, 'Deliveries & Dispatch History');
      dHead.appendChild(h3Deliv);
      delivSection.appendChild(dHead);

      const rawDeliv = delivRes.status === 'fulfilled' && delivRes.value ? delivRes.value.data : [];
      const deliveries = Array.isArray(rawDeliv) ? rawDeliv : (rawDeliv && Array.isArray(rawDeliv.items) ? rawDeliv.items : []);

      if (deliveries.length === 0) {
        delivSection.appendChild(createStateCard('notifications.deliveriesEmptyTitle', 'notifications.deliveriesEmptyDesc'));
      } else {
        const delivTableContainer = document.createElement('div');
        delivTableContainer.className = 'data-table-container';
        const delivTable = document.createElement('table');
        delivTable.className = 'data-table';

        const thead = document.createElement('thead');
        const trHead = document.createElement('tr');
        ['Destination', 'Event', 'Status', 'HTTP Code', 'Attempts', 'Time', 'Actions'].forEach((c) => {
          const th = document.createElement('th');
          th.textContent = c;
          trHead.appendChild(th);
        });
        thead.appendChild(trHead);
        delivTable.appendChild(thead);

        const tbody = document.createElement('tbody');
        deliveries.forEach((d) => {
          const tr = document.createElement('tr');

          const tdDest = document.createElement('td');
          tdDest.className = 'mono-cell';
          tdDest.textContent = d.destination || '-';
          tr.appendChild(tdDest);

          const tdEv = document.createElement('td');
          tdEv.textContent = d.event || '-';
          tr.appendChild(tdEv);

          const tdSt = document.createElement('td');
          const stBadgeType = d.status === 'delivered' ? 'success' : (d.status === 'deadletter' ? 'muted' : 'danger');
          tdSt.appendChild(createBadgeElement(d.status || 'failed', stBadgeType));
          tr.appendChild(tdSt);

          const tdCode = document.createElement('td');
          tdCode.textContent = d.statusCode ? String(d.statusCode) : '-';
          tr.appendChild(tdCode);

          const tdAtm = document.createElement('td');
          tdAtm.textContent = d.attempts ? String(d.attempts) : '1';
          tr.appendChild(tdAtm);

          const tdTime = document.createElement('td');
          tdTime.textContent = d.createdAt ? formatDate(d.createdAt) : '-';
          tr.appendChild(tdTime);

          const tdAct = document.createElement('td');
          if (d.status === 'failed' || d.status === 'deadletter') {
            const btnRetry = document.createElement('button');
            btnRetry.type = 'button';
            btnRetry.className = 'btn btn-secondary btn-xs';
            btnRetry.textContent = t('notifications.btnRetry', null, 'Retry');
            btnRetry.addEventListener('click', async () => {
              try {
                btnRetry.disabled = true;
                await apiRequest(`/api/manage/tasks/${taskId}/notifications/deliveries/${d.id}/retry`, {
                  method: 'POST',
                });
                showToast(t('notifications.retrySuccess', null, 'Webhook retry dispatched.'), 'success');
                await renderWebhooksTab();
              } catch (err) {
                showToast(getSafeErrorMessage(err, 'Failed to retry delivery.'), 'error');
              } finally {
                btnRetry.disabled = false;
              }
            });
            tdAct.appendChild(btnRetry);
          }
          tr.appendChild(tdAct);
          tbody.appendChild(tr);
        });

        delivTable.appendChild(tbody);
        delivTableContainer.appendChild(delivTable);
        delivSection.appendChild(delivTableContainer);
      }

      tabBody.appendChild(delivSection);
    } catch (err) {
      tabBody.replaceChildren(createStateCard('tasks.unavailableTitle', getSafeErrorMessage(err, 'Failed to load webhooks.'), true));
    }
  };

  btnTabRuns.addEventListener('click', renderRunsTab);
  btnTabWebhooks.addEventListener('click', renderWebhooksTab);

  contentEl.replaceChildren(modalWrapper);
  await renderRunsTab();
}

async function renderTasksView(container) {
  const isAdmin = Boolean(state.currentUser && state.currentUser.role === 'admin');
  const endpoint = isAdmin ? '/api/admin/tasks' : '/api/manage/tasks';

  let tasks = null;
  let isUnavailable = false;
  let availableSessions = [];
  let isTaskProducerReady = true;
  let isTaskWorkerAvailable = false;
  let isTaskWorkerRunning = false;
  let taskWorkerStatus = 'unavailable';

  try {
    const [tasksRes, sessionsRes, readinessRes] = await Promise.allSettled([
      apiRequest(endpoint),
      apiRequest('/api/sessions'),
      apiRequest('/api/readiness'),
    ]);

    if (tasksRes.status === 'fulfilled' && tasksRes.value && tasksRes.value.data) {
      const raw = tasksRes.value.data;
      if (Array.isArray(raw)) {
        tasks = raw;
      } else if (raw && Array.isArray(raw.items)) {
        tasks = raw.items;
      } else {
        isUnavailable = true;
      }
    } else {
      isUnavailable = true;
    }

    if (sessionsRes.status === 'fulfilled' && sessionsRes.value && sessionsRes.value.data) {
      const sRaw = sessionsRes.value.data;
      const sList = Array.isArray(sRaw) ? sRaw : (Array.isArray(sRaw.sessions) ? sRaw.sessions : []);
      availableSessions = sList.filter((s) => s.status === 'active');
    }

    if (readinessRes.status === 'fulfilled' && readinessRes.value && readinessRes.value.data) {
      const ops = readinessRes.value.data.operations;
      if (ops) {
        isTaskProducerReady = Boolean(ops.producer && ops.producer.available === true);
        isTaskWorkerAvailable = Boolean(ops.worker && ops.worker.available === true);
        isTaskWorkerRunning = Boolean(ops.worker && ops.worker.running === true);
        taskWorkerStatus = isTaskWorkerRunning ? 'running' : (isTaskWorkerAvailable ? 'idle' : 'unavailable');
      }
    }
  } catch {
    isUnavailable = true;
  }

  container.replaceChildren();
  container.appendChild(createHeader('tasks.title', 'tasks.subtitle', () => renderManagementView('tasks')));

  if (isUnavailable) {
    container.appendChild(createStateCard('tasks.unavailableTitle', 'tasks.unavailableDesc', true));
    return;
  }

  // Diagnostics KPI Grid: Producer Available vs Worker Status
  const kpiGrid = document.createElement('div');
  kpiGrid.className = 'kpi-grid';
  kpiGrid.appendChild(
    createKpiCard(
      'tasks.kpiProducer',
      isTaskProducerReady ? getLocalizedEnum('status', 'available') : getLocalizedEnum('status', 'unavailable'),
      isTaskProducerReady
        ? (getLocale() === 'zh-CN' ? '任务调度与生成器已就绪' : 'Scheduled task ingestion ready')
        : (getLocale() === 'zh-CN' ? '任务调度生成器不可用' : 'Task scheduling unavailable')
    )
  );
  kpiGrid.appendChild(
    createKpiCard(
      'tasks.kpiWorker',
      getLocalizedEnum('status', taskWorkerStatus),
      isTaskWorkerRunning
        ? (getLocale() === 'zh-CN' ? '后台 Worker 执行中' : 'Background execution active')
        : (isTaskWorkerAvailable
            ? (getLocale() === 'zh-CN' ? 'Worker 空闲待命中' : 'Worker idle / waiting')
            : (getLocale() === 'zh-CN' ? 'Worker 已禁用或不可用' : 'Worker disabled or unavailable'))
    )
  );
  kpiGrid.appendChild(
    createKpiCard(
      'tasks.kpiQueued',
      tasks ? formatNumber(tasks.filter((t) => t.status === 'pending' || t.status === 'accepted').length) : '-',
      getLocale() === 'zh-CN' ? '等待 Worker 执行' : 'Awaiting worker execution'
    )
  );
  container.appendChild(kpiGrid);

  // 1. Scheduled Task Creation Form Card (Restricted agent_prompt scheduled tasks)
  const createCard = document.createElement('div');
  createCard.className = 'task-create-card';

  const cardHeader = document.createElement('div');
  cardHeader.className = 'task-create-header';
  const cardTitle = document.createElement('h3');
  cardTitle.textContent = t('tasks.createCardTitle', null, '+ Create Scheduled Agent Prompt Task');
  cardHeader.appendChild(cardTitle);
  createCard.appendChild(cardHeader);

  const form = document.createElement('form');
  form.id = 'create-task-form';

  const formGrid = document.createElement('div');
  formGrid.className = 'form-row grid-2-col';

  // Task Title
  const titleGroup = document.createElement('div');
  titleGroup.className = 'form-group';
  const titleLabel = document.createElement('label');
  titleLabel.textContent = t('tasks.formTitle', null, 'Task Title *');
  titleLabel.htmlFor = 'task-title-input';
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.id = 'task-title-input';
  titleInput.className = 'form-input';
  titleInput.required = true;
  titleInput.placeholder = t('tasks.formTitlePlaceholder', null, 'e.g. Run daily code hygiene check');
  titleGroup.appendChild(titleLabel);
  titleGroup.appendChild(titleInput);
  formGrid.appendChild(titleGroup);

  // Target Active Session
  const sessionGroup = document.createElement('div');
  sessionGroup.className = 'form-group';
  const sessionLabel = document.createElement('label');
  sessionLabel.textContent = t('tasks.formSession', null, 'Target Active Session *');
  sessionLabel.htmlFor = 'task-session-select';
  const sessionSelect = document.createElement('select');
  sessionSelect.id = 'task-session-select';
  sessionSelect.className = 'form-select';
  sessionSelect.required = true;

  if (availableSessions.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = t('tasks.noActiveSessions', null, 'No active container sessions found');
    sessionSelect.appendChild(opt);
  } else {
    availableSessions.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      const spaceName = s.spaceName || 'Workspace';
      const sessionTitle = s.title ? s.title : 'Untitled';
      opt.textContent = `${spaceName} / ${sessionTitle}`;
      sessionSelect.appendChild(opt);
    });
  }
  sessionGroup.appendChild(sessionLabel);
  sessionGroup.appendChild(sessionSelect);
  formGrid.appendChild(sessionGroup);

  form.appendChild(formGrid);

  // Prompt Content
  const promptGroup = document.createElement('div');
  promptGroup.className = 'form-group';
  const promptLabel = document.createElement('label');
  promptLabel.textContent = t('tasks.formPrompt', null, 'Agent Prompt *');
  promptLabel.htmlFor = 'task-prompt-input';
  const promptInput = document.createElement('textarea');
  promptInput.id = 'task-prompt-input';
  promptInput.className = 'form-textarea';
  promptInput.rows = 3;
  promptInput.required = true;
  promptInput.placeholder = t('tasks.formPromptPlaceholder', null, 'Enter instruction for the agent to execute...');
  promptGroup.appendChild(promptLabel);
  promptGroup.appendChild(promptInput);
  form.appendChild(promptGroup);

  // Schedule Type & Dynamic Parameters
  const schedGrid = document.createElement('div');
  schedGrid.className = 'form-row grid-2-col';

  const typeGroup = document.createElement('div');
  typeGroup.className = 'form-group';
  const typeLabel = document.createElement('label');
  typeLabel.textContent = t('tasks.formScheduleType', null, 'Schedule Type *');
  typeLabel.htmlFor = 'task-schedule-type-select';
  const typeSelect = document.createElement('select');
  typeSelect.id = 'task-schedule-type-select';
  typeSelect.className = 'form-select';

  const schedOptions = [
    { value: 'once', label: t('tasks.typeOnce', null, 'Once (Due Date)') },
    { value: 'cron', label: t('tasks.typeCron', null, 'Cron Expression') },
    { value: 'interval', label: t('tasks.typeInterval', null, 'Fixed Interval (Seconds)') },
  ];
  schedOptions.forEach((optData) => {
    const opt = document.createElement('option');
    opt.value = optData.value;
    opt.textContent = optData.label;
    typeSelect.appendChild(opt);
  });
  typeGroup.appendChild(typeLabel);
  typeGroup.appendChild(typeSelect);
  schedGrid.appendChild(typeGroup);

  // Dynamic Parameter Field Container
  const dynamicParamGroup = document.createElement('div');
  dynamicParamGroup.className = 'form-group';
  dynamicParamGroup.id = 'task-dynamic-param-group';

  const dueLabel = document.createElement('label');
  dueLabel.textContent = t('tasks.formDueDate', null, 'Due Date (Optional)');
  dueLabel.htmlFor = 'task-due-date-input';
  const dueInput = document.createElement('input');
  dueInput.type = 'datetime-local';
  dueInput.id = 'task-due-date-input';
  dueInput.className = 'form-input';

  const cronLabel = document.createElement('label');
  cronLabel.textContent = t('tasks.formCron', null, 'Cron Expression * (5 fields, UTC)');
  cronLabel.htmlFor = 'task-cron-input';
  const cronInput = document.createElement('input');
  cronInput.type = 'text';
  cronInput.id = 'task-cron-input';
  cronInput.className = 'form-input';
  cronInput.placeholder = t('tasks.formCronPlaceholder', null, 'e.g. */10 * * * * (Every 10 minutes)');

  const intervalLabel = document.createElement('label');
  intervalLabel.textContent = t('tasks.formInterval', null, 'Interval (Seconds, min 60) *');
  intervalLabel.htmlFor = 'task-interval-input';
  const intervalInput = document.createElement('input');
  intervalInput.type = 'number';
  intervalInput.id = 'task-interval-input';
  intervalInput.className = 'form-input';
  intervalInput.min = '60';
  intervalInput.step = '1';
  intervalInput.placeholder = t('tasks.formIntervalPlaceholder', null, 'e.g. 300 (5 minutes)');

  function updateDynamicParamView() {
    dynamicParamGroup.replaceChildren();
    const currentType = typeSelect.value;
    if (currentType === 'once') {
      dynamicParamGroup.appendChild(dueLabel);
      dynamicParamGroup.appendChild(dueInput);
    } else if (currentType === 'cron') {
      dynamicParamGroup.appendChild(cronLabel);
      dynamicParamGroup.appendChild(cronInput);
    } else if (currentType === 'interval') {
      dynamicParamGroup.appendChild(intervalLabel);
      dynamicParamGroup.appendChild(intervalInput);
    }
  }

  typeSelect.addEventListener('change', updateDynamicParamView);
  updateDynamicParamView();
  schedGrid.appendChild(dynamicParamGroup);
  form.appendChild(schedGrid);

  // Priority Row
  const priorityGrid = document.createElement('div');
  priorityGrid.className = 'form-row grid-2-col';

  const priorityGroup = document.createElement('div');
  priorityGroup.className = 'form-group';
  const priorityLabel = document.createElement('label');
  priorityLabel.textContent = t('tasks.formPriority', null, 'Priority');
  priorityLabel.htmlFor = 'task-priority-select';
  const prioritySelect = document.createElement('select');
  prioritySelect.id = 'task-priority-select';
  prioritySelect.className = 'form-select';
  const priorityLabels = {
    low: { en: 'Low', 'zh-CN': '低' },
    medium: { en: 'Medium', 'zh-CN': '中' },
    high: { en: 'High', 'zh-CN': '高' },
    urgent: { en: 'Urgent', 'zh-CN': '紧急' },
  };
  ['low', 'medium', 'high', 'urgent'].forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = priorityLabels[p] ? priorityLabels[p][getLocale() === 'zh-CN' ? 'zh-CN' : 'en'] : p;
    if (p === 'medium') opt.selected = true;
    prioritySelect.appendChild(opt);
  });
  priorityGroup.appendChild(priorityLabel);
  priorityGroup.appendChild(prioritySelect);
  priorityGrid.appendChild(priorityGroup);

  form.appendChild(priorityGrid);

  // Submit Button
  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'modal-actions';
  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.id = 'btn-create-task-submit';
  submitBtn.className = 'btn btn-primary';
  submitBtn.textContent = t('tasks.btnSchedule', null, 'Schedule Task');
  actionsDiv.appendChild(submitBtn);
  form.appendChild(actionsDiv);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = titleInput.value.trim();
    const prompt = promptInput.value.trim();
    const sessionId = sessionSelect.value.trim();
    const priority = prioritySelect.value;
    const scheduleType = typeSelect.value;

    if (!title || !prompt || !sessionId) {
      showToast(t('tasks.formRequired', null, getLocale() === 'zh-CN' ? '任务标题、指令与目标活跃会话为必填项' : 'Title, prompt, and target active session are required'), 'error');
      return;
    }

    if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
      showToast(tr('toast.cryptoUnavailable', null, 'Cryptographic context unavailable. Cannot generate Idempotency-Key.'), 'error');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = getLocale() === 'zh-CN' ? '正在提交...' : 'Scheduling...';

    try {
      const idempotencyKey = crypto.randomUUID();
      const body = {
        title,
        prompt,
        sessionId,
        priority,
        scheduleType,
      };

      if (scheduleType === 'once') {
        const rawDueDate = dueInput.value;
        if (rawDueDate) {
          body.dueDate = new Date(rawDueDate).toISOString();
        }
      } else if (scheduleType === 'cron') {
        const cronVal = cronInput.value.trim();
        if (!cronVal) {
          showToast(getLocale() === 'zh-CN' ? '请输入有效的 Cron 表达式' : 'Cron expression is required', 'error');
          submitBtn.disabled = false;
          submitBtn.textContent = t('tasks.btnSchedule', null, 'Schedule Task');
          return;
        }
        body.cronExpression = cronVal;
      } else if (scheduleType === 'interval') {
        const intervalVal = parseInt(intervalInput.value, 10);
        if (Number.isNaN(intervalVal) || intervalVal < 60) {
          showToast(getLocale() === 'zh-CN' ? '间隔秒数必须大于等于 60 秒' : 'Interval seconds must be at least 60 seconds', 'error');
          submitBtn.disabled = false;
          submitBtn.textContent = t('tasks.btnSchedule', null, 'Schedule Task');
          return;
        }
        body.intervalSeconds = intervalVal;
      }

      await apiRequest('/api/manage/tasks', {
        method: 'POST',
        headers: {
          'Idempotency-Key': idempotencyKey,
        },
        body,
      });

      showToast(getLocale() === 'zh-CN' ? `任务 "${title}" 调度成功！` : `Task "${title}" scheduled successfully!`, 'success');
      form.reset();
      renderManagementView(state.currentRoute || 'tasks');
    } catch (err) {
      showToast(getSafeErrorMessage(err, 'Failed to schedule task.'), 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = t('tasks.btnSchedule', null, 'Schedule Task');
    }
  });

  createCard.appendChild(form);
  container.appendChild(createCard);

  // 2. Tasks Table
  if (!tasks || tasks.length === 0) {
    container.appendChild(createStateCard('tasks.emptyTitle', 'tasks.emptyDesc'));
    return;
  }

  const tableContainer = document.createElement('div');
  tableContainer.className = 'data-table-container';

  const table = document.createElement('table');
  table.className = 'data-table';

  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');
  const cols = ['Title / User', 'Schedule', 'Priority', 'Status', 'Next Run', 'Created At', 'Actions'];
  const colKeys = ['tasks.colTitle', 'tasks.colScheduleType', 'tasks.colPriority', 'tasks.colStatus', 'tasks.colNextRun', 'tasks.colCreatedAt', 'tasks.colActions'];
  cols.forEach((col, idx) => {
    const th = document.createElement('th');
    th.textContent = t(colKeys[idx], null, col);
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const VALID_TASK_STATUSES = ['active', 'paused', 'pending', 'claimed', 'accepted', 'running', 'processing', 'completed', 'failed', 'cancelled'];
  const VALID_TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

  tasks.forEach((tTask) => {
    const isValidTask = Boolean(
      tTask &&
      typeof tTask === 'object' &&
      typeof tTask.id === 'string' &&
      VALID_TASK_STATUSES.includes(tTask.status) &&
      VALID_TASK_PRIORITIES.includes(tTask.priority)
    );

    if (!isValidTask) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.className = 'text-muted';
      td.textContent = t('common.invalidRecord', null, getLocale() === 'zh-CN' ? '无效记录' : 'Invalid record');
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    const t = tTask;
    const trRow = document.createElement('tr');
    trRow.setAttribute('data-task-id', t.id || '');

    // Title / User
    const tdTitle = document.createElement('td');
    tdTitle.textContent = t.title || t.username || '-';
    trRow.appendChild(tdTitle);

    // Schedule Type
    const tdSched = document.createElement('td');
    const schedType = t.scheduleType || 'once';
    const schedBadge = createBadgeElement(schedType, schedType === 'cron' ? 'info' : (schedType === 'interval' ? 'warning' : 'muted'));
    tdSched.appendChild(schedBadge);
    if (t.cronExpression) {
      const cronSpan = document.createElement('span');
      cronSpan.className = 'text-muted task-schedule-detail';
      cronSpan.textContent = ` ${t.cronExpression}`;
      tdSched.appendChild(cronSpan);
    } else if (t.intervalSeconds) {
      const intSpan = document.createElement('span');
      intSpan.className = 'text-muted task-schedule-detail';
      intSpan.textContent = ` ${t.intervalSeconds}s`;
      tdSched.appendChild(intSpan);
    }
    trRow.appendChild(tdSched);

    // Priority
    const tdPriority = document.createElement('td');
    const taskPriority = t.priority;
    tdPriority.appendChild(createBadgeElement(taskPriority, taskPriority === 'high' || taskPriority === 'urgent' ? 'danger' : taskPriority === 'medium' ? 'info' : 'muted'));
    trRow.appendChild(tdPriority);

    // Status (including Paused indicator)
    const tdStatus = document.createElement('td');
    const taskStatus = t.status;
    const badgeType = taskStatus === 'running' ? 'running' : (taskStatus === 'completed' ? 'success' : (taskStatus === 'failed' || taskStatus === 'cancelled' ? 'danger' : (taskStatus === 'claimed' ? 'info' : 'muted')));
    tdStatus.appendChild(createBadgeElement(taskStatus, badgeType));
    if (t.isPaused) {
      const pausedBadge = createBadgeElement(tr('tasks.statusPaused', null, 'Paused'), 'danger');
      tdStatus.appendChild(document.createTextNode(' '));
      tdStatus.appendChild(pausedBadge);
    }
    trRow.appendChild(tdStatus);

    // Next Run
    const tdNextRun = document.createElement('td');
    const nextTime = t.nextRunAt || t.dueDate;
    tdNextRun.textContent = nextTime ? formatDate(nextTime) : '-';
    trRow.appendChild(tdNextRun);

    // Created At
    const tdTime = document.createElement('td');
    tdTime.textContent = t.createdAt ? formatDate(t.createdAt) : '-';
    trRow.appendChild(tdTime);

    // Real Action Controls: Run Now, Pause/Resume, Runs History, Cancel
    const tdActions = document.createElement('td');
    tdActions.className = 'file-actions-cell';

    const isFinished = taskStatus === 'completed' || taskStatus === 'failed' || taskStatus === 'cancelled';
    const isWorkerExecutable = isTaskWorkerAvailable || isTaskWorkerRunning;

    // 1. Run Now Button
    const runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'btn btn-secondary btn-xs';
    runBtn.textContent = tr('tasks.btnRunNow', null, 'Run Now');
    runBtn.disabled = isFinished || !isWorkerExecutable;
    if (!isFinished && !isWorkerExecutable) {
      runBtn.title = getLocale() === 'zh-CN' ? 'Worker 未在运行或不可用，任务无法立即执行。' : 'Worker is not running or available. Task cannot be executed immediately.';
    }
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      runBtn.textContent = getLocale() === 'zh-CN' ? '执行中...' : 'Running...';
      try {
        const runRes = await apiRequest(`/api/manage/tasks/${t.id}/run`, {
          method: 'POST',
        });
        const actualStatus = (runRes && runRes.data && runRes.data.status) || 'running';
        showToast(getLocale() === 'zh-CN' ? `任务开始执行：状态为 "${getLocalizedEnum('status', actualStatus)}"` : `Task execution started: status is "${actualStatus}"`, 'info');
        renderManagementView('tasks');
      } catch (err) {
        showToast(getSafeErrorMessage(err, 'Failed to run task on worker.'), 'error');
        runBtn.disabled = false;
        runBtn.textContent = tr('tasks.btnRunNow', null, 'Run Now');
      }
    });
    tdActions.appendChild(runBtn);

    // 2. Pause / Resume Button
    const isPaused = Boolean(t.isPaused);
    const pauseBtn = document.createElement('button');
    pauseBtn.type = 'button';
    pauseBtn.className = isPaused ? 'btn btn-success btn-xs' : 'btn btn-warning btn-xs';
    pauseBtn.textContent = isPaused ? tr('tasks.btnResume', null, 'Resume') : tr('tasks.btnPause', null, 'Pause');
    pauseBtn.disabled = taskStatus === 'cancelled';
    pauseBtn.addEventListener('click', async () => {
      pauseBtn.disabled = true;
      try {
        if (isPaused) {
          await apiRequest(`/api/manage/tasks/${t.id}/resume`, { method: 'POST' });
          showToast(getLocale() === 'zh-CN' ? '任务已恢复调度' : 'Task resumed successfully', 'success');
        } else {
          await apiRequest(`/api/manage/tasks/${t.id}/pause`, { method: 'POST' });
          showToast(getLocale() === 'zh-CN' ? '任务已暂停调度' : 'Task paused successfully', 'info');
        }
        renderManagementView('tasks');
      } catch (err) {
        showToast(getSafeErrorMessage(err, isPaused ? 'Failed to resume task.' : 'Failed to pause task.'), 'error');
        pauseBtn.disabled = false;
      }
    });
    tdActions.appendChild(pauseBtn);

    // 3. Runs History Button
    const historyBtn = document.createElement('button');
    historyBtn.type = 'button';
    historyBtn.className = 'btn btn-info btn-xs';
    historyBtn.textContent = tr('tasks.btnRunsHistory', null, 'Runs History');
    historyBtn.addEventListener('click', () => {
      showTaskRunsModal(t.id, t.title);
    });
    tdActions.appendChild(historyBtn);

    // 4. Cancel Button
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-danger btn-xs';
    cancelBtn.textContent = tr('tasks.btnCancel', null, 'Cancel');
    cancelBtn.disabled = isFinished;
    cancelBtn.addEventListener('click', () => {
      const modalTitle = getLocale() === 'zh-CN' ? '取消定时任务' : 'Cancel Scheduled Task';
      const modalMsg = getLocale() === 'zh-CN' ? `确定要取消任务 "${t.title || '定时任务'}" 吗？` : `Are you sure you want to cancel task "${t.title || 'Scheduled Task'}"?`;
      showConfirmation(modalTitle, modalMsg, async () => {
        try {
          await apiRequest(`/api/manage/tasks/${t.id}/cancel`, {
            method: 'POST',
          });
          showToast(getLocale() === 'zh-CN' ? '任务已成功取消' : 'Task cancelled successfully', 'success');
          renderManagementView('tasks');
        } catch (err) {
          showToast(getSafeErrorMessage(err, 'Failed to cancel task.'), 'error');
        }
      });
    });
    tdActions.appendChild(cancelBtn);

    trRow.appendChild(tdActions);
    tbody.appendChild(trRow);
  });
  table.appendChild(tbody);
  tableContainer.appendChild(table);

  container.appendChild(tableContainer);
}

// ==========================================================================
// 2.2 Instructions Editor & Space Instructions View
// ==========================================================================

/**
 * Calculates UTF-8 byte length of a string without external dependencies.
 */
function getUtf8ByteLength(str) {
  if (typeof str !== 'string' || str.length === 0) return 0;
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str).length;
  }
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const codePoint = str.charCodeAt(i);
    if (codePoint <= 0x007f) {
      bytes += 1;
    } else if (codePoint <= 0x07ff) {
      bytes += 2;
    } else if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      i++;
      bytes += 4;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Reusable Instructions Editor Component Factory for Global (Personal) & Space Instructions.
 *
 * @param {Object} options
 * @param {'global'|'space'} options.target
 * @param {number} [options.maxBytes]
 * @param {string} [options.cardTitleKey]
 * @param {string} [options.cardDescKey]
 * @param {string} [options.explanationKey]
 * @param {Array<{id: string, name: string, folder?: string}>} [options.spaces]
 * @param {string} [options.selectedSpaceId]
 * @param {string} [options.initialFile]
 */
function createInstructionsEditor(options) {
  const target = options.target || 'global';
  const isGlobal = target === 'global';
  const maxBytes = options.maxBytes || (isGlobal ? 20480 : 65536);
  const titleKey = options.cardTitleKey || (isGlobal ? 'instructions.globalCardTitle' : 'instructions.spaceCardTitle');
  const descKey = options.cardDescKey || (isGlobal ? 'instructions.globalCardDesc' : 'instructions.spaceCardDesc');
  const explanationKey = options.explanationKey || (isGlobal ? 'instructions.globalExplanation' : 'instructions.spaceExplanation');
  const spaces = Array.isArray(options.spaces) ? options.spaces : [];

  let activeFile = options.initialFile || 'AGENTS.md';
  let activeSpaceId = options.selectedSpaceId || (spaces[0]?.id ?? '');
  let serverContent = '';
  let currentEtag = null;
  let serverEtag = null;
  let isDirty = false;
  let isSaving = false;
  let isLoading = false;

  // Root Card Panel
  const card = document.createElement('div');
  card.className = 'instructions-editor-card';

  // 1. Header Area
  const header = document.createElement('div');
  header.className = 'instructions-editor-header';

  const headerTop = document.createElement('div');
  headerTop.className = 'instructions-header-top';

  const titleGroup = document.createElement('div');
  titleGroup.className = 'instructions-title-group';
  const h3Title = document.createElement('h3');
  h3Title.textContent = t(titleKey, null, isGlobal ? 'Account Global Instructions' : 'Space Instructions');
  const pDesc = document.createElement('p');
  pDesc.textContent = t(descKey, null, isGlobal ? 'Global instructions applied to all agent turns across every space and session for your account.' : 'Workspace rules and system prompt instructions (AGENTS.md / CLAUDE.md) loaded on every new turn');
  titleGroup.appendChild(h3Title);
  titleGroup.appendChild(pDesc);
  headerTop.appendChild(titleGroup);

  const targetBadge = document.createElement('span');
  targetBadge.className = 'badge badge-outline';
  targetBadge.textContent = isGlobal ? (getLocale() === 'zh-CN' ? '全局指令' : 'Global Target') : (getLocale() === 'zh-CN' ? '空间指令' : 'Space Target');
  headerTop.appendChild(targetBadge);
  header.appendChild(headerTop);

  // Notice Banner: explains turn lifecycle
  const noticeBanner = document.createElement('div');
  noticeBanner.className = 'form-notice';
  const noticeP = document.createElement('p');
  noticeP.textContent = t(
    explanationKey,
    null,
    isGlobal
      ? 'Every new or next turn automatically loads these global instructions into the agent context baseline.'
      : 'Every new or next turn in this Space loads these instructions into the agent context baseline. AGENTS.md has priority, CLAUDE.md is supplementary.'
  );
  noticeBanner.appendChild(noticeP);
  header.appendChild(noticeBanner);

  // Toolbar: Space Picker & File Tabs (for Space Instructions)
  let spaceSelect = null;
  const tabButtons = [];

  if (!isGlobal) {
    const toolbar = document.createElement('div');
    toolbar.className = 'instructions-toolbar';

    // Space Selector
    const spacePicker = document.createElement('div');
    spacePicker.className = 'instructions-space-picker';
    const spaceLabel = document.createElement('label');
    spaceLabel.htmlFor = 'instructions-space-select';
    spaceLabel.textContent = t('instructions.labelSpace', null, 'Target Space:');
    spacePicker.appendChild(spaceLabel);

    spaceSelect = document.createElement('select');
    spaceSelect.id = 'instructions-space-select';
    spaceSelect.className = 'form-select';
    spaceSelect.setAttribute('aria-label', t('instructions.labelSpace', null, 'Target Space'));

    spaces.forEach((sp) => {
      const opt = document.createElement('option');
      opt.value = sp.id;
      opt.textContent = sp.name || sp.folder || sp.id;
      if (sp.id === activeSpaceId) {
        opt.selected = true;
      }
      spaceSelect.appendChild(opt);
    });
    spacePicker.appendChild(spaceSelect);
    toolbar.appendChild(spacePicker);

    // File Tabs (AGENTS.md / CLAUDE.md)
    const fileTabs = document.createElement('div');
    fileTabs.className = 'instructions-file-tabs';
    fileTabs.setAttribute('role', 'tablist');
    fileTabs.setAttribute('aria-label', 'Instructions Files');

    ['AGENTS.md', 'CLAUDE.md'].forEach((filename) => {
      const tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.className = `instructions-file-tab ${filename === activeFile ? 'active' : ''}`;
      tabBtn.setAttribute('data-file', filename);
      tabBtn.setAttribute('role', 'tab');
      const isAct = filename === activeFile;
      tabBtn.setAttribute('aria-selected', isAct ? 'true' : 'false');
      tabBtn.textContent = filename === 'AGENTS.md' ? t('instructions.tabAgents', null, 'AGENTS.md') : t('instructions.tabClaude', null, 'CLAUDE.md');
      tabButtons.push(tabBtn);
      fileTabs.appendChild(tabBtn);
    });
    toolbar.appendChild(fileTabs);

    header.appendChild(toolbar);
  }

  card.appendChild(header);

  // 2. Meta Bar
  const metaBar = document.createElement('div');
  metaBar.className = 'instructions-meta-bar';

  const metaLeft = document.createElement('div');
  metaLeft.className = 'instructions-meta-left';

  const fileMetaItem = document.createElement('div');
  fileMetaItem.className = 'instructions-meta-item';
  const fileMetaLabel = document.createElement('span');
  fileMetaLabel.className = 'instructions-meta-label';
  fileMetaLabel.textContent = t('instructions.labelFile', null, 'Active File:');
  const fileMetaValue = document.createElement('span');
  fileMetaValue.className = 'instructions-meta-value instructions-file-display';
  fileMetaValue.textContent = activeFile;
  fileMetaItem.appendChild(fileMetaLabel);
  fileMetaItem.appendChild(fileMetaValue);
  metaLeft.appendChild(fileMetaItem);

  const etagMetaItem = document.createElement('div');
  etagMetaItem.className = 'instructions-meta-item';
  const etagMetaLabel = document.createElement('span');
  etagMetaLabel.className = 'instructions-meta-label';
  etagMetaLabel.textContent = t('instructions.labelEtag', null, 'ETag:');
  const etagMetaValue = document.createElement('span');
  etagMetaValue.className = 'instructions-meta-value instructions-etag-display';
  etagMetaValue.textContent = '-';
  etagMetaItem.appendChild(etagMetaLabel);
  etagMetaItem.appendChild(etagMetaValue);
  metaLeft.appendChild(etagMetaItem);
  metaBar.appendChild(metaLeft);

  const metaRight = document.createElement('div');
  metaRight.className = 'instructions-meta-right';

  const unsavedBadge = document.createElement('span');
  unsavedBadge.className = 'instructions-unsaved-badge hidden';
  unsavedBadge.textContent = t('instructions.badgeUnsaved', null, '● Unsaved Draft');
  metaRight.appendChild(unsavedBadge);

  const byteCounter = document.createElement('span');
  byteCounter.className = 'instructions-byte-counter';
  byteCounter.setAttribute('aria-live', 'polite');
  byteCounter.textContent = `0 / ${maxBytes} B`;
  metaRight.appendChild(byteCounter);
  metaBar.appendChild(metaRight);

  card.appendChild(metaBar);

  // 3. Content Area
  const contentArea = document.createElement('div');
  contentArea.className = 'instructions-content-area';

  // Conflict Banner (Hidden by default)
  const conflictBanner = document.createElement('div');
  conflictBanner.className = 'instructions-conflict-banner hidden';
  conflictBanner.setAttribute('role', 'alert');

  const conflictTitle = document.createElement('div');
  conflictTitle.className = 'instructions-conflict-title';
  conflictTitle.textContent = `⚠️ ${t('instructions.conflictTitle', null, 'Instructions Concurrency Conflict')}`;
  conflictBanner.appendChild(conflictTitle);

  const conflictDesc = document.createElement('p');
  conflictDesc.className = 'instructions-conflict-desc';
  conflictDesc.textContent = t('instructions.conflictDesc', { localEtag: 'none', serverEtag: 'remote' }, 'The instructions file was modified on the server since loaded. Please reload to review before saving.');
  conflictBanner.appendChild(conflictDesc);

  const conflictActions = document.createElement('div');
  conflictActions.className = 'instructions-conflict-actions';

  const btnConflictReload = document.createElement('button');
  btnConflictReload.type = 'button';
  btnConflictReload.className = 'btn btn-sm btn-secondary';
  btnConflictReload.textContent = t('instructions.btnConflictReload', null, 'Reload Server Version');
  conflictActions.appendChild(btnConflictReload);

  conflictBanner.appendChild(conflictActions);
  contentArea.appendChild(conflictBanner);

  // Textarea
  const textarea = document.createElement('textarea');
  textarea.className = 'form-textarea instructions-textarea';
  textarea.id = isGlobal ? 'personal-instructions-textarea' : 'space-instructions-textarea';
  textarea.rows = 12;
  textarea.spellcheck = false;
  textarea.placeholder = t('instructions.placeholder', null, 'Enter system prompt rules, behavioral constraints, and instructions in Markdown...');
  textarea.setAttribute('aria-label', t(titleKey, null, 'Instructions Editor'));
  contentArea.appendChild(textarea);

  card.appendChild(contentArea);

  // 4. Actions Bar
  const actionsBar = document.createElement('div');
  actionsBar.className = 'instructions-actions-bar';

  const btnDiscard = document.createElement('button');
  btnDiscard.type = 'button';
  btnDiscard.className = 'btn btn-secondary hidden';
  btnDiscard.textContent = t('instructions.btnDiscard', null, 'Discard Draft');
  actionsBar.appendChild(btnDiscard);

  const btnReload = document.createElement('button');
  btnReload.type = 'button';
  btnReload.className = 'btn btn-secondary';
  btnReload.textContent = t('instructions.btnConflictReload', null, 'Reload Server Version');
  actionsBar.appendChild(btnReload);

  const btnSave = document.createElement('button');
  btnSave.type = 'button';
  btnSave.className = 'btn btn-primary';
  btnSave.textContent = t('instructions.btnSave', null, 'Save Instructions');
  actionsBar.appendChild(btnSave);

  card.appendChild(actionsBar);

  // Helper functions
  function updateByteCounter() {
    const currentBytes = getUtf8ByteLength(textarea.value);
    byteCounter.textContent = `${currentBytes} / ${maxBytes} B`;

    if (currentBytes > maxBytes) {
      byteCounter.classList.remove('warning');
      byteCounter.classList.add('exceeded');
      btnSave.disabled = true;
    } else if (currentBytes > maxBytes * 0.9) {
      byteCounter.classList.remove('exceeded');
      byteCounter.classList.add('warning');
      btnSave.disabled = isSaving || isLoading;
    } else {
      byteCounter.classList.remove('warning', 'exceeded');
      btnSave.disabled = isSaving || isLoading;
    }
  }

  function setDirty(dirty) {
    isDirty = dirty;
    if (isDirty) {
      unsavedBadge.classList.remove('hidden');
      btnDiscard.classList.remove('hidden');
    } else {
      unsavedBadge.classList.add('hidden');
      btnDiscard.classList.add('hidden');
    }
  }

  function updateMeta() {
    fileMetaValue.textContent = activeFile;
    etagMetaValue.textContent = currentEtag || '-';
  }

  async function confirmDiscardIfDirty() {
    if (!isDirty) return true;
    return await showConfirmDialog(
      t('instructions.unsavedAlertTitle', null, 'Unsaved Instructions Draft'),
      t('instructions.unsavedAlertDesc', null, 'You have unsaved changes in the instructions editor. Do you want to discard your draft and switch?')
    );
  }

  async function loadInstructions() {
    isLoading = true;
    textarea.disabled = true;
    btnSave.disabled = true;
    btnReload.disabled = true;
    conflictBanner.classList.add('hidden');

    try {
      let url;
      if (isGlobal) {
        url = '/api/account/instructions/global';
      } else {
        if (!activeSpaceId) {
          textarea.value = '';
          serverContent = '';
          currentEtag = null;
          serverEtag = null;
          updateMeta();
          updateByteCounter();
          setDirty(false);
          return;
        }
        url = `/api/spaces/${encodeURIComponent(activeSpaceId)}/instructions?file=${encodeURIComponent(activeFile)}`;
      }

      const res = await apiRequest(url);
      const data = res?.data || res || {};
      serverContent = typeof data.content === 'string' ? data.content : '';
      currentEtag = data.etag || null;
      serverEtag = currentEtag;
      textarea.value = serverContent;
      setDirty(false);
      updateMeta();
      updateByteCounter();
    } catch (err) {
      showToast(getSafeErrorMessage(err, t('common.error', null, 'Failed to load instructions.')), 'error');
    } finally {
      isLoading = false;
      textarea.disabled = false;
      btnReload.disabled = false;
      updateByteCounter();
    }
  }

  async function saveInstructions() {
    const contentToSave = textarea.value;
    const currentBytes = getUtf8ByteLength(contentToSave);

    if (currentBytes > maxBytes) {
      showToast(
        t('instructions.byteLimitExceeded', { current: currentBytes, max: maxBytes }, `Instructions size (${currentBytes} bytes) exceeds limit of ${maxBytes} bytes.`),
        'error'
      );
      return;
    }

    isSaving = true;
    btnSave.disabled = true;
    btnReload.disabled = true;
    btnDiscard.disabled = true;

    try {
      let url;
      const body = { content: contentToSave };
      const headers = {};

      if (isGlobal) {
        url = '/api/account/instructions/global';
        if (currentEtag) {
          headers['If-Match'] = currentEtag;
        }
      } else {
        url = `/api/spaces/${encodeURIComponent(activeSpaceId)}/instructions?file=${encodeURIComponent(activeFile)}`;
        if (currentEtag) {
          headers['If-Match'] = currentEtag;
        }
      }

      const res = await apiRequest(url, {
        method: 'PUT',
        headers,
        body,
      });

      const data = res?.data || res || {};
      serverContent = contentToSave;
      currentEtag = data.etag || null;
      serverEtag = currentEtag;
      setDirty(false);
      conflictBanner.classList.add('hidden');
      updateMeta();
      updateByteCounter();

      showToast(t('instructions.saveSuccess', { file: activeFile }, `Instructions for "${activeFile}" saved successfully.`), 'success');
    } catch (err) {
      if (err && (err.status === 409 || err.status === 428)) {
        // Concurrency conflict
        conflictBanner.classList.remove('hidden');
        conflictDesc.textContent = t('instructions.conflictDesc', {
          localEtag: currentEtag || 'none',
          serverEtag: err?.serverEtag || 'remote',
        }, 'The instructions file was modified on the server since loaded. Please reload to review before saving.');
        showToast(t('instructions.conflictTitle', null, 'Instructions Concurrency Conflict'), 'error');
      } else {
        showToast(getSafeErrorMessage(err, t('common.error', null, 'Failed to save instructions.')), 'error');
      }
    } finally {
      isSaving = false;
      btnReload.disabled = false;
      btnDiscard.disabled = false;
      updateByteCounter();
    }
  }

  // Textarea input event
  textarea.addEventListener('input', () => {
    updateByteCounter();
    const dirty = textarea.value !== serverContent;
    setDirty(dirty);
  });

  // Action Buttons events
  btnSave.addEventListener('click', () => saveInstructions());

  btnReload.addEventListener('click', async () => {
    if (await confirmDiscardIfDirty()) {
      await loadInstructions();
    }
  });

  btnDiscard.addEventListener('click', () => {
    textarea.value = serverContent;
    setDirty(false);
    updateByteCounter();
    conflictBanner.classList.add('hidden');
  });

  btnConflictReload.addEventListener('click', async () => {
    await loadInstructions();
  });

  // File Tab switching
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const targetFile = btn.getAttribute('data-file');
      if (!targetFile || targetFile === activeFile) return;

      if (await confirmDiscardIfDirty()) {
        activeFile = targetFile;
        tabButtons.forEach((b) => {
          const isAct = b.getAttribute('data-file') === activeFile;
          b.classList.toggle('active', isAct);
          b.setAttribute('aria-selected', isAct ? 'true' : 'false');
        });
        await loadInstructions();
      }
    });
  });

  // Space selection change
  if (spaceSelect) {
    spaceSelect.addEventListener('change', async (e) => {
      const newSpaceId = e.target.value;
      if (newSpaceId === activeSpaceId) return;

      if (await confirmDiscardIfDirty()) {
        activeSpaceId = newSpaceId;
        await loadInstructions();
      } else {
        spaceSelect.value = activeSpaceId;
      }
    });
  }

  return {
    element: card,
    load: loadInstructions,
    isDirty: () => isDirty,
    getActiveFile: () => activeFile,
    getActiveSpaceId: () => activeSpaceId,
    getTextarea: () => textarea,
  };
}

/**
 * 2.2 Space Instructions View (GET /api/spaces/:id/instructions, PUT /api/spaces/:id/instructions)
 */
async function renderSpaceInstructionsView(container) {
  let spaces = [];
  let isUnavailable = false;

  try {
    const spacesRes = await apiRequest('/api/spaces');
    if (spacesRes && spacesRes.data) {
      if (Array.isArray(spacesRes.data.spaces)) {
        spaces = spacesRes.data.spaces;
      } else if (Array.isArray(spacesRes.data)) {
        spaces = spacesRes.data;
      }
    }
  } catch (err) {
    isUnavailable = true;
  }

  container.replaceChildren();
  container.appendChild(
    createHeader(
      'instructions.title',
      'instructions.subtitle',
      () => renderManagementView('management/workspaces/instructions')
    )
  );

  if (isUnavailable) {
    container.appendChild(
      createStateCard(
        'common.error',
        'instructions.unavailableDesc',
        true
      )
    );
    return;
  }

  if (spaces.length === 0) {
    container.appendChild(
      createStateCard(
        'instructions.title',
        t('instructions.emptySpace', null, 'No spaces available. Create a space first to manage workspace instructions.'),
        false,
        false
      )
    );
    return;
  }

  const selectedSpaceId = state.currentSpaceId || spaces[0]?.id || '';

  const editor = createInstructionsEditor({
    target: 'space',
    maxBytes: 65536,
    cardTitleKey: 'instructions.spaceCardTitle',
    cardDescKey: 'instructions.spaceCardDesc',
    explanationKey: 'instructions.spaceExplanation',
    spaces,
    selectedSpaceId,
    initialFile: 'AGENTS.md',
  });

  container.appendChild(editor.element);
  await editor.load();
}

// 2.5 Agent Profiles View (GET /api/manage/agent-profiles, POST /api/manage/agent-profiles, /versions, /api/spaces/:id/agent-profile)
async function renderAgentProfilesView(container) {
  let profiles = null;
  let spaces = [];
  let isUnavailable = false;

  try {
    const [profilesRes, spacesRes] = await Promise.allSettled([
      apiRequest('/api/manage/agent-profiles'),
      apiRequest('/api/spaces'),
    ]);

    if (profilesRes.status === 'fulfilled' && profilesRes.value && profilesRes.value.data && Array.isArray(profilesRes.value.data.items)) {
      profiles = profilesRes.value.data.items;
    } else {
      isUnavailable = true;
    }

    if (spacesRes.status === 'fulfilled' && spacesRes.value && spacesRes.value.data) {
      if (Array.isArray(spacesRes.value.data.spaces)) {
        spaces = spacesRes.value.data.spaces;
      } else if (Array.isArray(spacesRes.value.data)) {
        spaces = spacesRes.value.data;
      }
    }
  } catch (err) {
    isUnavailable = true;
  }

  container.replaceChildren();
  container.appendChild(
    createHeader(
      'profiles.title',
      'profiles.subtitle',
      () => renderManagementView('agent-profiles')
    )
  );

  if (isUnavailable) {
    container.appendChild(
      createStateCard(
        'profiles.unavailableTitle',
        'profiles.unavailableDesc',
        true
      )
    );
    return;
  }

  // 1. Mandatory Governance & Lifecycle Notice Banner
  const noticeDiv = document.createElement('div');
  noticeDiv.className = 'form-notice';
  const noticeP = document.createElement('p');
  noticeP.textContent = t('profiles.lifecycleNotice', null, 'Lifecycle Rule: Agent profile version changes only apply to newly created session generations. Existing sessions remain permanently pinned to their generation snapshot.');
  noticeDiv.appendChild(noticeP);
  container.appendChild(noticeDiv);

  // 2. Space Profile Binding Toolbar
  const bindingBar = document.createElement('div');
  bindingBar.className = 'profile-binding-bar';

  const bindingTitle = document.createElement('div');
  const bH4 = document.createElement('h4');
  bH4.textContent = t('profiles.bindingTitle', null, 'Space Profile Binding');
  const bSub = document.createElement('p');
  bSub.className = 'text-muted';
  bSub.textContent = t('profiles.bindingSubtitle', null, 'Bind an agent profile persona to a multi-tenant space');
  bindingTitle.appendChild(bH4);
  bindingTitle.appendChild(bSub);
  bindingBar.appendChild(bindingTitle);

  const bindingForm = document.createElement('div');
  bindingForm.className = 'profile-binding-form';

  // Space select
  const spaceSelect = document.createElement('select');
  spaceSelect.id = 'profile-space-select';
  spaceSelect.className = 'form-select';
  if (spaces.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = t('profiles.noSpaces', null, 'No spaces available');
    spaceSelect.appendChild(opt);
  } else {
    spaces.forEach((sp) => {
      const opt = document.createElement('option');
      opt.value = sp.id;
      opt.textContent = sp.name || 'Untitled Space';
      if (sp.id === state.currentSpaceId) opt.selected = true;
      spaceSelect.appendChild(opt);
    });
  }
  bindingForm.appendChild(spaceSelect);

  // Profile select
  const profileSelect = document.createElement('select');
  profileSelect.id = 'profile-select-for-binding';
  profileSelect.className = 'form-select';
  if (!profiles || profiles.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = t('profiles.noProfiles', null, 'No profiles created');
    profileSelect.appendChild(opt);
  } else {
    profiles.forEach((p) => {
      if (!p || typeof p !== 'object' || !p.id) return;
      const opt = document.createElement('option');
      opt.value = p.id;
      const v = p.activeVersion !== undefined ? p.activeVersion : (p.version !== undefined ? p.version : (p.currentVersion !== undefined ? p.currentVersion : null));
      const vText = v !== null ? ` (v${v})` : '';
      opt.textContent = `${p.name || 'Untitled'}${vText}`;
      profileSelect.appendChild(opt);
    });
  }
  bindingForm.appendChild(profileSelect);

  // Bind Button
  const bindBtn = document.createElement('button');
  bindBtn.type = 'button';
  bindBtn.className = 'btn btn-primary btn-sm';
  bindBtn.textContent = t('profiles.btnBind', null, 'Bind to Space');
  bindBtn.disabled = spaces.length === 0 || !profiles || profiles.length === 0;
  bindBtn.addEventListener('click', async () => {
    const targetSpaceId = spaceSelect.value;
    const targetProfileId = profileSelect.value;
    if (!targetSpaceId || !targetProfileId) {
      showToast(t('profiles.selectBothRequired', null, getLocale() === 'zh-CN' ? '请选择要绑定的空间与智能体画像' : 'Select both a space and an agent profile to bind'), 'error');
      return;
    }

    bindBtn.disabled = true;
    bindBtn.textContent = getLocale() === 'zh-CN' ? '正在绑定...' : 'Binding...';
    try {
      await apiRequest(`/api/spaces/${targetSpaceId}/agent-profile`, {
        method: 'POST',
        body: { profileId: targetProfileId },
      });
      showToast(getLocale() === 'zh-CN' ? '智能体画像绑定成功！' : 'Agent profile bound to space successfully!', 'success');
      renderManagementView('agent-profiles');
    } catch (err) {
      showToast(getSafeErrorMessage(err, 'Failed to bind agent profile.'), 'error');
    } finally {
      bindBtn.disabled = false;
      bindBtn.textContent = t('profiles.btnBind', null, 'Bind to Space');
    }
  });
  bindingForm.appendChild(bindBtn);

  // Unbind Button
  const unbindBtn = document.createElement('button');
  unbindBtn.type = 'button';
  unbindBtn.className = 'btn btn-secondary btn-sm';
  unbindBtn.textContent = getLocale() === 'zh-CN' ? '解绑空间' : 'Unbind Space';
  unbindBtn.disabled = spaces.length === 0;
  unbindBtn.addEventListener('click', () => {
    const targetSpaceId = spaceSelect.value;
    if (!targetSpaceId) return;
    const unbindTitle = getLocale() === 'zh-CN' ? '解绑空间智能体画像' : 'Unbind Space Agent Profile';
    const unbindMsg = getLocale() === 'zh-CN' ? `确定从空间 "${spaceSelect.options[spaceSelect.selectedIndex]?.text}" 解绑智能体画像吗？` : `Remove the agent profile binding from space "${spaceSelect.options[spaceSelect.selectedIndex]?.text}"?`;
    showConfirmation(unbindTitle, unbindMsg, async () => {
      try {
        await apiRequest(`/api/spaces/${targetSpaceId}/agent-profile`, {
          method: 'DELETE',
        });
        showToast(getLocale() === 'zh-CN' ? '空间画像已成功解绑' : 'Space unbind completed', 'success');
        renderManagementView('agent-profiles');
      } catch (err) {
        showToast(getSafeErrorMessage(err, 'Failed to unbind agent profile.'), 'error');
      }
    });
  });
  bindingForm.appendChild(unbindBtn);

  bindingBar.appendChild(bindingForm);
  container.appendChild(bindingBar);

  // 3. Profiles List Header + "+ New Profile" Action
  const listSection = document.createElement('div');
  listSection.className = 'management-section';

  const listHeader = document.createElement('div');
  listHeader.className = 'section-header';
  const lhTitle = document.createElement('h3');
  lhTitle.textContent = getLocale() === 'zh-CN' ? '已注册智能体画像' : 'Registered Agent Profiles';
  listHeader.appendChild(lhTitle);

  const btnNewProfile = document.createElement('button');
  btnNewProfile.type = 'button';
  btnNewProfile.id = 'btn-open-create-profile';
  btnNewProfile.className = 'btn btn-primary btn-sm';
  btnNewProfile.textContent = t('profiles.btnCreateProfile', null, '+ Create Agent Profile');
  btnNewProfile.addEventListener('click', () => {
    openModal('modal-create-profile');
  });
  listHeader.appendChild(btnNewProfile);
  listSection.appendChild(listHeader);

  if (!profiles || profiles.length === 0) {
    listSection.appendChild(createStateCard('profiles.emptyTitle', 'profiles.emptyDesc'));
    container.appendChild(listSection);
    await renderPermissionPresetsCard(container, { profileId: null, spaceId: state.currentSpaceId });
    await renderExtensionsView(container, true);
    return;
  }

  // Profiles Table
  const tableContainer = document.createElement('div');
  tableContainer.className = 'data-table-container';
  const table = document.createElement('table');
  table.className = 'data-table';

  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');
  const cols = ['Name', 'Description', 'Active Version', 'Status', 'Created At', 'Actions'];
  const colKeys = ['profiles.colName', 'common.description', 'profiles.colActiveVersion', 'profiles.colStatus', 'profiles.colCreatedAt', 'profiles.colActions'];
  cols.forEach((col, idx) => {
    const th = document.createElement('th');
    th.textContent = t(colKeys[idx], null, col);
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  profiles.forEach((p) => {
    if (!p || typeof p !== 'object' || !p.id || !p.name) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'text-muted';
      td.textContent = t('common.invalidRecord', null, getLocale() === 'zh-CN' ? '无效记录' : 'Invalid record');
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = p.name || '-';
    tr.appendChild(tdName);

    const tdDesc = document.createElement('td');
    tdDesc.textContent = p.description || '-';
    tr.appendChild(tdDesc);

    const tdVer = document.createElement('td');
    const verNum = p.activeVersion !== undefined ? `v${p.activeVersion}` : (p.version !== undefined ? `v${p.version}` : (p.currentVersion !== undefined ? `v${p.currentVersion}` : '-'));
    tdVer.appendChild(createBadgeElement(verNum, 'info'));
    tr.appendChild(tdVer);

    const tdStatus = document.createElement('td');
    const status = p.status || 'active';
    tdStatus.appendChild(createBadgeElement(status, status === 'active' ? 'success' : 'muted'));
    tr.appendChild(tdStatus);

    const tdTime = document.createElement('td');
    tdTime.textContent = p.createdAt ? formatDate(p.createdAt) : '-';
    tr.appendChild(tdTime);

    const tdActions = document.createElement('td');
    tdActions.className = 'file-actions-cell';

    // View Versions Button
    const viewVerBtn = document.createElement('button');
    viewVerBtn.type = 'button';
    viewVerBtn.className = 'btn btn-secondary btn-xs';
    viewVerBtn.textContent = t('profiles.btnViewVersions', null, 'Versions');
    viewVerBtn.addEventListener('click', () => {
      openProfileVersionsModal(p.id, p.name, p.activeVersion);
    });
    tdActions.appendChild(viewVerBtn);

    // Create New Version Button
    const newVerBtn = document.createElement('button');
    newVerBtn.type = 'button';
    newVerBtn.className = 'btn btn-primary btn-xs';
    newVerBtn.textContent = t('profiles.btnNewVersion', null, '+ Version');
    newVerBtn.addEventListener('click', () => {
      openCreateProfileVersionModal(p.id, p.name);
    });
    tdActions.appendChild(newVerBtn);

    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  tableContainer.appendChild(table);
  listSection.appendChild(tableContainer);
  container.appendChild(listSection);

  // Permission Presets Card & Extension Center
  await renderPermissionPresetsCard(container, { profileId: null, spaceId: state.currentSpaceId });
  await renderExtensionsView(container, true);
}

/**
 * Renders Permission Presets Policy Card & Editor (GET/PUT /api/manage/permission-presets/effective)
 */
async function renderPermissionPresetsCard(container, context = {}) {
  const section = document.createElement('div');
  section.className = 'management-section';

  const sHead = document.createElement('div');
  sHead.className = 'section-header';
  const h3 = document.createElement('h3');
  h3.textContent = t('presets.sectionTitle', null, 'Permission Presets & Sandbox Policies');
  sHead.appendChild(h3);
  section.appendChild(sHead);

  const card = document.createElement('div');
  card.className = 'card-panel';

  let effectivePreset = null;
  const spaceId = context.spaceId || state.currentSpaceId || null;
  const profileId = context.profileId || null;

  try {
    const params = new URLSearchParams();
    if (spaceId) params.append('spaceId', spaceId);
    if (profileId) params.append('profileId', profileId);
    const query = params.toString() ? `?${params.toString()}` : '';
    const res = await apiRequest(`/api/manage/permission-presets/effective${query}`);
    effectivePreset = (res && res.data) || null;
  } catch (err) {
    // Graceful fallback default
  }

  const currentPresetVal = (effectivePreset && effectivePreset.preset) || 'workspace-write';
  const currentSandboxVal = (effectivePreset && effectivePreset.sandboxMode) || 'workspace-write';
  const currentApprovalVal = (effectivePreset && effectivePreset.approvalPolicy) || 'ask';
  const currentRevision = (effectivePreset && typeof effectivePreset.revision === 'number') ? effectivePreset.revision : 1;

  // Effective Policy Indicator
  const effInfo = document.createElement('div');
  effInfo.className = 'preset-hierarchy-indicator mb-2';
  const effBadge = createBadgeElement(`Preset: ${currentPresetVal}`, currentPresetVal === 'danger-full-access' ? 'danger' : 'info');
  const sandBadge = createBadgeElement(`Sandbox: ${currentSandboxVal}`, currentSandboxVal === 'danger-full-access' ? 'danger' : 'success');
  const appBadge = createBadgeElement(`Approval: ${currentApprovalVal}`, currentApprovalVal === 'never' ? 'danger' : 'warning');
  const revBadge = document.createElement('span');
  revBadge.className = 'badge badge-xs text-muted mono-cell';
  revBadge.textContent = t('presets.labelRevision', { revision: currentRevision }, `Revision: ${currentRevision}`);

  effInfo.appendChild(effBadge);
  effInfo.appendChild(sandBadge);
  effInfo.appendChild(appBadge);
  effInfo.appendChild(revBadge);
  card.appendChild(effInfo);

  // Form
  const form = document.createElement('form');
  form.id = 'form-permission-preset';

  const formGrid = document.createElement('div');
  formGrid.className = 'form-row grid-3-col';

  // Preset select
  const grpPreset = document.createElement('div');
  grpPreset.className = 'form-group';
  const lblPreset = document.createElement('label');
  lblPreset.htmlFor = 'perm-preset-select';
  lblPreset.textContent = t('presets.labelPreset', null, 'Permission Preset *');
  const selPreset = document.createElement('select');
  selPreset.id = 'perm-preset-select';
  selPreset.className = 'form-select';

  const presetOptions = [
    { value: 'read-only', label: t('presets.optReadOnly', null, 'Read Only (Safe Inspection)') },
    { value: 'workspace-write', label: t('presets.optWorkspaceWrite', null, 'Workspace Write (Standard Sandbox)') },
    { value: 'danger-full-access', label: t('presets.optDangerFullAccess', null, 'Danger Full Access (Unrestricted Host)') },
    { value: 'custom', label: t('presets.optCustom', null, 'Custom (Advanced)') },
  ];
  presetOptions.forEach((opt) => {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    if (opt.value === currentPresetVal) el.selected = true;
    selPreset.appendChild(el);
  });
  grpPreset.appendChild(lblPreset);
  grpPreset.appendChild(selPreset);
  formGrid.appendChild(grpPreset);

  // Sandbox Mode select
  const grpSandbox = document.createElement('div');
  grpSandbox.className = 'form-group';
  const lblSandbox = document.createElement('label');
  lblSandbox.htmlFor = 'perm-sandbox-select';
  lblSandbox.textContent = t('presets.labelSandboxMode', null, 'Sandbox Execution Mode *');
  const selSandbox = document.createElement('select');
  selSandbox.id = 'perm-sandbox-select';
  selSandbox.className = 'form-select';

  const sandboxOptions = [
    { value: 'read-only', label: t('presets.optReadOnly', null, 'Read Only') },
    { value: 'workspace-write', label: t('presets.optWorkspaceWrite', null, 'Workspace Write') },
    { value: 'danger-full-access', label: t('presets.optDangerFullAccess', null, 'Danger Full Access') },
  ];
  sandboxOptions.forEach((opt) => {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    if (opt.value === currentSandboxVal) el.selected = true;
    selSandbox.appendChild(el);
  });
  grpSandbox.appendChild(lblSandbox);
  grpSandbox.appendChild(selSandbox);
  formGrid.appendChild(grpSandbox);

  // Approval Policy select
  const grpApproval = document.createElement('div');
  grpApproval.className = 'form-group';
  const lblApproval = document.createElement('label');
  lblApproval.htmlFor = 'perm-approval-select';
  lblApproval.textContent = t('presets.labelApprovalPolicy', null, 'Approval Policy *');
  const selApproval = document.createElement('select');
  selApproval.id = 'perm-approval-select';
  selApproval.className = 'form-select';

  const approvalOptions = [
    { value: 'ask', label: t('presets.approvalAsk', null, 'Ask on Sensitive Tools (Default)') },
    { value: 'never', label: t('presets.approvalNever', null, 'Never Ask (Auto-Allow All - Dangerous)') },
  ];
  approvalOptions.forEach((opt) => {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    if (opt.value === currentApprovalVal) el.selected = true;
    selApproval.appendChild(el);
  });
  grpApproval.appendChild(lblApproval);
  grpApproval.appendChild(selApproval);
  formGrid.appendChild(grpApproval);

  form.appendChild(formGrid);

  // Auto-sync sandbox mode and approval policy when standard preset is chosen
  selPreset.addEventListener('change', () => {
    if (selPreset.value === 'read-only') {
      selSandbox.value = 'read-only';
      selApproval.value = 'ask';
    } else if (selPreset.value === 'workspace-write') {
      selSandbox.value = 'workspace-write';
      selApproval.value = 'ask';
    } else if (selPreset.value === 'danger-full-access') {
      selSandbox.value = 'danger-full-access';
    }
  });

  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'flex-row-center';

  const btnSave = document.createElement('button');
  btnSave.type = 'submit';
  btnSave.className = 'btn btn-primary btn-sm';
  btnSave.textContent = t('presets.btnSave', null, 'Save Permission Preset');
  actionsDiv.appendChild(btnSave);

  form.appendChild(actionsDiv);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const chosenPreset = selPreset.value;
    const chosenSandbox = selSandbox.value;
    const chosenApproval = selApproval.value;

    const performSave = async () => {
      try {
        btnSave.disabled = true;
        btnSave.textContent = getLocale() === 'zh-CN' ? '正在保存...' : 'Saving...';

        const payload = {
          preset: chosenPreset,
          sandboxMode: chosenSandbox,
          approvalPolicy: chosenApproval,
          spaceId: spaceId || undefined,
          profileId: profileId || undefined,
          revision: currentRevision,
        };

        const res = await apiRequest('/api/manage/permission-presets', {
          method: 'PUT',
          headers: {
            'If-Match': String(currentRevision),
          },
          body: payload,
        });

        const newRev = (res && res.data && res.data.revision) || (currentRevision + 1);
        showToast(t('presets.saveSuccess', { revision: newRev }, `Permission preset saved successfully (Revision ${newRev}).`), 'success');
        renderManagementView(state.currentRoute);
      } catch (err) {
        if (err && (err.status === 409 || err.code === 'CONFLICT')) {
          showToast(t('presets.saveConflict', null, 'Permission preset was modified concurrently. Please reload to see latest settings.'), 'warning');
        } else {
          showToast(getSafeErrorMessage(err, t('presets.saveFailed', { error: '' }, 'Failed to save permission preset.')), 'error');
        }
      } finally {
        btnSave.disabled = false;
        btnSave.textContent = t('presets.btnSave', null, 'Save Permission Preset');
      }
    };

    if (chosenPreset === 'danger-full-access' || chosenSandbox === 'danger-full-access' || chosenApproval === 'never') {
      showConfirmation(
        t('presets.confirmDangerTitle', null, 'Confirm High-Risk Permission Preset'),
        t('presets.confirmDangerMessage', null, 'Warning: You are selecting Danger Full Access or disabling approval prompts. Are you sure you want to proceed?'),
        performSave
      );
    } else {
      await performSave();
    }
  });

  card.appendChild(form);
  section.appendChild(card);
  container.appendChild(section);
}

/**
 * Sanitizes repository and source URLs, stripping plaintext embedded credentials.
 */
function sanitizeSourceUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  try {
    if (trimmed.includes('@') && (trimmed.startsWith('http://') || trimmed.startsWith('https://'))) {
      const parsed = new URL(trimmed);
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    }
  } catch {}
  return trimmed;
}

/**
 * 2.6 Extension Center & Skills Governance View
 * (GET /api/manage/extensions, POST /api/manage/extensions/install, /update, /rollback, /enable, /disable, /uninstall)
 */
async function renderExtensionsView(container, isSubSection = false) {
  const section = document.createElement('div');
  section.className = 'management-section extensions-container skills-container';

  if (!isSubSection) {
    container.replaceChildren();
    container.appendChild(createHeader('extensions.title', 'extensions.subtitle', () => renderManagementView('management/workspaces/extensions')));
  }

  const sHead = document.createElement('div');
  sHead.className = 'section-header';
  const h3 = document.createElement('h3');
  h3.textContent = t('extensions.title', null, 'Extension Center');
  sHead.appendChild(h3);

  const btnInstall = document.createElement('button');
  btnInstall.type = 'button';
  btnInstall.id = 'btn-open-install-extension';
  btnInstall.className = 'btn btn-primary btn-sm';
  btnInstall.textContent = t('extensions.btnInstall', null, '+ Install Extension');
  btnInstall.addEventListener('click', openInstallSkillModal);
  sHead.appendChild(btnInstall);
  section.appendChild(sHead);

  // Filter Toolbar
  const filterBar = document.createElement('div');
  filterBar.className = 'extensions-filter-toolbar skills-filter-toolbar';

  // 1. Kind filter (All / Skills / MCP)
  const kindSelect = document.createElement('select');
  kindSelect.id = 'extension-filter-kind';
  kindSelect.className = 'form-select';
  const kindOpts = [
    { value: 'all', label: t('extensions.filterAllKinds', null, 'All Types') },
    { value: 'skill', label: t('extensions.filterKindSkill', null, 'Skills') },
    { value: 'mcp', label: t('extensions.filterKindMcp', null, 'MCP') },
  ];
  kindOpts.forEach((ko) => {
    const opt = document.createElement('option');
    opt.value = ko.value;
    opt.textContent = ko.label;
    if (ko.value === state.activeExtensionFilterKind) opt.selected = true;
    kindSelect.appendChild(opt);
  });
  filterBar.appendChild(kindSelect);

  // 2. Space select
  const spaceSelect = document.createElement('select');
  spaceSelect.id = 'skill-filter-space';
  spaceSelect.className = 'form-select';
  const optAllSpaces = document.createElement('option');
  optAllSpaces.value = '';
  optAllSpaces.textContent = t('extensions.spaceSelectorAll', null, 'All Spaces');
  spaceSelect.appendChild(optAllSpaces);

  if (!state.spaces || state.spaces.length === 0) {
    try {
      const sRes = await apiRequest('/api/spaces');
      const sData = sRes && sRes.data;
      state.spaces = Array.isArray(sData) ? sData : ((sData && Array.isArray(sData.spaces)) ? sData.spaces : []);
    } catch {}
  }

  (state.spaces || []).forEach((sp) => {
    const opt = document.createElement('option');
    opt.value = sp.id;
    opt.textContent = sp.name || sp.id;
    if (sp.id === state.activeSkillFilterSpace) opt.selected = true;
    spaceSelect.appendChild(opt);
  });
  filterBar.appendChild(spaceSelect);

  // 3. Source filter
  const sourceSelect = document.createElement('select');
  sourceSelect.id = 'skill-filter-source';
  sourceSelect.className = 'form-select';
  const sourceOpts = [
    { value: '', label: t('extensions.filterAllSources', null, 'All Sources') },
    { value: 'bundled', label: t('extensions.sourceBundled', null, 'Bundled') },
    { value: 'global', label: t('extensions.sourceGlobal', null, 'Global') },
    { value: 'space', label: t('extensions.sourceSpace', null, 'Space') },
  ];
  sourceOpts.forEach((so) => {
    const opt = document.createElement('option');
    opt.value = so.value;
    opt.textContent = so.label;
    if (so.value === state.activeSkillFilterSource) opt.selected = true;
    sourceSelect.appendChild(opt);
  });
  filterBar.appendChild(sourceSelect);

  // 4. Enabled / Status filter
  const enabledSelect = document.createElement('select');
  enabledSelect.id = 'skill-filter-enabled';
  enabledSelect.className = 'form-select';
  const enabledOpts = [
    { value: '', label: t('extensions.filterAllEnabled', null, 'All Statuses') },
    { value: 'true', label: t('extensions.filterEnabled', null, 'Enabled Only') },
    { value: 'false', label: t('extensions.filterDisabled', null, 'Disabled Only') },
  ];
  enabledOpts.forEach((eo) => {
    const opt = document.createElement('option');
    opt.value = eo.value;
    opt.textContent = eo.label;
    if (eo.value === state.activeSkillFilterEnabled) opt.selected = true;
    enabledSelect.appendChild(opt);
  });
  filterBar.appendChild(enabledSelect);

  section.appendChild(filterBar);

  const contentArea = document.createElement('div');
  contentArea.className = 'extensions-content-area skills-content-area';
  contentArea.replaceChildren(createSkeletonLoader());
  section.appendChild(contentArea);

  const loadExtensions = async () => {
    const params = new URLSearchParams();
    const targetSpace = state.activeSkillFilterSpace || state.currentSpaceId || (state.spaces && state.spaces[0] && state.spaces[0].id);
    if (targetSpace) params.append('spaceId', targetSpace);
    if (state.activeExtensionFilterKind === 'skill') params.append('kind', 'skill');
    else if (state.activeExtensionFilterKind === 'mcp') params.append('kind', 'mcp');
    else if (state.activeExtensionFilterKind === 'dsh-plugin') params.append('kind', 'dsh-plugin');
    if (state.activeSkillFilterEnabled === 'true') params.append('status', 'active');
    else if (state.activeSkillFilterEnabled === 'false') params.append('status', 'disabled');
    params.append('limit', '50');

    try {
      const res = await apiRequest(`/api/manage/extensions?${params.toString()}`);
      const raw = res && res.data;
      let extensions = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : []);

      contentArea.replaceChildren();

      // Client-side fallback filtering
      if (state.activeExtensionFilterKind === 'skill') {
        extensions = extensions.filter((ext) => !ext.contributions || ext.contributions.length === 0 || ext.contributions.some((c) => c.kind === 'skill'));
      } else if (state.activeExtensionFilterKind === 'mcp') {
        extensions = extensions.filter((ext) => ext.contributions && ext.contributions.some((c) => c.kind === 'mcp'));
      } else if (state.activeExtensionFilterKind && state.activeExtensionFilterKind !== 'all') {
        extensions = [];
      }
      if (state.activeSkillFilterSource === 'bundled') {
        extensions = extensions.filter((ext) => ext.sourceKind === 'builtin');
      } else if (state.activeSkillFilterSource === 'global') {
        extensions = extensions.filter((ext) => ext.sourceKind !== 'builtin' && (!ext.targetSpaceId && !ext.spaceId));
      } else if (state.activeSkillFilterSource === 'space') {
        extensions = extensions.filter((ext) => ext.sourceKind !== 'builtin');
      }

      if (state.activeSkillFilterEnabled !== '') {
        const wantEnabled = state.activeSkillFilterEnabled === 'true';
        extensions = extensions.filter((ext) => ext.enabled === wantEnabled || (wantEnabled ? ext.status === 'active' : ext.status === 'disabled'));
      }

      if (extensions.length === 0) {
        contentArea.appendChild(createStateCard('extensions.emptyTitle', 'extensions.emptyDesc'));
        return;
      }

      // KPI Grid
      const kpiGrid = document.createElement('div');
      kpiGrid.className = 'kpi-grid mb-2';
      const bundledCount = extensions.filter((s) => s.sourceKind === 'builtin').length;
      const spaceCount = extensions.filter((s) => s.sourceKind !== 'builtin').length;
      const enabledCount = extensions.filter((s) => s.enabled === true || s.status === 'active').length;

      kpiGrid.appendChild(createKpiCard('extensions.kpiTotal', String(extensions.length), getLocale() === 'zh-CN' ? '已安装扩展' : 'Installed extensions'));
      kpiGrid.appendChild(createKpiCard('extensions.kpiEnabled', String(enabledCount), getLocale() === 'zh-CN' ? '空间或集群中已启用' : 'Active in space/cluster'));
      kpiGrid.appendChild(createKpiCard('extensions.kpiSpace', String(spaceCount), getLocale() === 'zh-CN' ? '绑定至空间' : 'Bound to spaces'));
      kpiGrid.appendChild(createKpiCard('extensions.kpiBundled', String(bundledCount), getLocale() === 'zh-CN' ? '内置预装扩展包' : 'Built-in packages'));
      contentArea.appendChild(kpiGrid);

      // Extensions Table
      const tableContainer = document.createElement('div');
      tableContainer.className = 'data-table-container';
      const table = document.createElement('table');
      table.className = 'data-table';

      const thead = document.createElement('thead');
      const trHead = document.createElement('tr');
      const cols = [
        t('extensions.colName', null, 'Name'),
        t('extensions.colKind', null, 'Kind'),
        t('extensions.colVersion', null, 'Version'),
        t('extensions.colSource', null, 'Source'),
        t('extensions.colBindings', null, 'Bindings'),
        t('extensions.colHealth', null, 'Health / Available'),
        t('extensions.colStatus', null, 'Status'),
        t('extensions.colDescription', null, 'Description / Provenance'),
        t('extensions.colActions', null, 'Actions'),
      ];
      cols.forEach((col) => {
        const th = document.createElement('th');
        th.textContent = col;
        trHead.appendChild(th);
      });
      thead.appendChild(trHead);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      extensions.forEach((ext) => {
        if (!ext || typeof ext !== 'object') return;

        const isBundled = ext.sourceKind === 'builtin';
        const isEnabled = ext.enabled === true || (isBundled && ext.status === 'active');
        const displayName = ext.name || ext.slug || '-';
        const versionNum = ext.installedVersion !== undefined ? ext.installedVersion : (ext.activeVersion !== undefined ? ext.activeVersion : 1);

        const tr = document.createElement('tr');

        // 1. Name & Slug (clickable for Details modal)
        const tdName = document.createElement('td');
        const nameLink = document.createElement('span');
        nameLink.className = 'mono-cell font-semibold extension-link-action';
        nameLink.textContent = displayName;
        nameLink.setAttribute('role', 'button');
        nameLink.setAttribute('tabindex', '0');
        nameLink.setAttribute('title', t('extensions.btnDetail', null, 'View Extension Details'));
        nameLink.addEventListener('click', () => {
          openExtensionDetailModal(ext.slug || ext.id, targetSpace);
        });
        nameLink.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openExtensionDetailModal(ext.slug || ext.id, targetSpace);
          }
        });
        tdName.appendChild(nameLink);
        tr.appendChild(tdName);

        // 2. Kind Chip
        const tdKind = document.createElement('td');
        const hasPlugin = ext.contributions && ext.contributions.some((c) => c.kind === 'dsh-plugin');
        const hasMcp = ext.contributions && ext.contributions.some((c) => c.kind === 'mcp');
        const hasCli = ext.contributions && ext.contributions.some((c) => c.kind === 'cli');
        const hasSkill = !ext.contributions || ext.contributions.length === 0 || ext.contributions.some((c) => c.kind === 'skill');
        if (hasPlugin) {
          tdKind.appendChild(createBadgeElement(t('extensions.kindChipDshPlugin', null, 'DSH Plugin'), 'info'));
        } else if (hasCli) {
          tdKind.appendChild(createBadgeElement(t('extensions.kindChipCli', null, 'CLI'), 'info'));
        } else if (hasMcp && hasSkill && ext.contributions && ext.contributions.length > 1) {
          const kindWrap = document.createElement('div');
          kindWrap.className = 'flex-row gap-1';
          kindWrap.appendChild(createBadgeElement(t('extensions.kindChipSkill', null, 'Skill'), 'info'));
          kindWrap.appendChild(createBadgeElement(t('extensions.kindChipMcp', null, 'MCP'), 'info'));
          tdKind.appendChild(kindWrap);
        } else if (hasMcp) {
          tdKind.appendChild(createBadgeElement(t('extensions.kindChipMcp', null, 'MCP'), 'info'));
        } else {
          tdKind.appendChild(createBadgeElement(t('extensions.kindChipSkill', null, 'Skill'), 'info'));
        }
        tr.appendChild(tdKind);

        // 3. Version (Position maintained for contract test compatibility)
        const tdVer = document.createElement('td');
        tdVer.appendChild(createBadgeElement(`v${versionNum}`, 'info'));
        tr.appendChild(tdVer);

        // 4. Source
        const tdSource = document.createElement('td');
        let srcLabel = t('extensions.sourceSpace', null, 'Space');
        let srcBadgeType = 'user';
        if (isBundled) {
          srcLabel = t('extensions.sourceBundled', null, 'Bundled');
          srcBadgeType = 'muted';
        } else if (ext.sourceKind === 'git') {
          srcLabel = t('extensions.sourceGit', null, 'Git');
          srcBadgeType = 'user';
        } else if (ext.sourceKind === 'archive') {
          srcLabel = t('extensions.sourceArchive', null, 'Archive');
          srcBadgeType = 'user';
        }
        tdSource.appendChild(createBadgeElement(srcLabel, srcBadgeType));
        tr.appendChild(tdSource);

        // 5. Bindings
        const tdBindings = document.createElement('td');
        const matchedSpace = (state.spaces || []).find((sp) => sp.id === targetSpace);
        const bindingLabel = isBundled
          ? t('extensions.scopeGlobal', null, 'Cluster Global')
          : (matchedSpace ? matchedSpace.name : (targetSpace || t('extensions.spaceSelectorAll', null, 'All Spaces')));
        tdBindings.textContent = bindingLabel;
        tr.appendChild(tdBindings);

        // 6. Health / Available
        const tdHealth = document.createElement('td');
        let healthLabel = isEnabled ? t('extensions.healthOperational', null, 'Operational') : t('extensions.healthDisabled', null, 'Disabled');
        const mcpContribForHealth = ext.contributions && ext.contributions.find((c) => c.kind === 'mcp');
        if (mcpContribForHealth && isEnabled) {
          const mTools = mcpContribForHealth.manifest && (Array.isArray(mcpContribForHealth.manifest.tools) ? mcpContribForHealth.manifest.tools : (Array.isArray(mcpContribForHealth.manifest.declaredTools) ? mcpContribForHealth.manifest.declaredTools : null));
          if (mTools && mTools.length > 0) {
            healthLabel = `${t('extensions.healthOperational', null, 'Operational')} (${t('extensions.mcpToolsCount', { count: mTools.length }, `${mTools.length} Tools`)})`;
          }
        }
        tdHealth.appendChild(createBadgeElement(
          healthLabel,
          isEnabled ? 'success' : 'muted'
        ));
        tr.appendChild(tdHealth);

        // 7. Status
        const tdStatus = document.createElement('td');
        tdStatus.appendChild(createBadgeElement(
          isEnabled ? t('extensions.badgeEnabled', null, 'Enabled') : t('extensions.badgeDisabled', null, 'Disabled'),
          isEnabled ? 'success' : 'muted'
        ));
        tr.appendChild(tdStatus);

        // 8. Description & Provenance
        const tdDescProv = document.createElement('td');
        const descDiv = document.createElement('div');
        descDiv.className = 'text-sm text-secondary mb-1';
        descDiv.textContent = ext.description || '-';
        tdDescProv.appendChild(descDiv);

        const provTag = document.createElement('span');
        provTag.className = 'provenance-tag';
        if (isBundled) {
          provTag.textContent = t('extensions.provenanceBundled', null, 'Built-in');
        } else if (ext.sourceKind === 'git' || ext.sourceRef) {
          const safeUrl = sanitizeSourceUrl(ext.sourceRef || 'repo');
          const shortHash = ext.integritySha256 ? ` @ ${ext.integritySha256.slice(0, 7)}` : '';
          provTag.textContent = `git: ${safeUrl}${shortHash}`;
        } else if (ext.sourceKind === 'archive') {
          provTag.textContent = `upload: sha256:${(ext.integritySha256 || '').slice(0, 8)}`;
        } else {
          provTag.textContent = t('extensions.provenanceBundled', null, 'Built-in');
        }
        tdDescProv.appendChild(provTag);
        tr.appendChild(tdDescProv);

        // 9. Actions
        const tdActions = document.createElement('td');
        tdActions.className = 'file-actions-cell';

        // Detail Button
        const detailBtn = document.createElement('button');
        detailBtn.type = 'button';
        detailBtn.className = 'btn btn-secondary btn-xs';
        detailBtn.textContent = t('extensions.btnDetail', null, 'Detail');
        detailBtn.addEventListener('click', () => {
          openExtensionDetailModal(ext.slug || ext.id, targetSpace);
        });
        tdActions.appendChild(detailBtn);

        if (!isBundled || hasPlugin) {
          // Enable / Disable toggle
          const toggleBtn = document.createElement('button');
          toggleBtn.type = 'button';
          toggleBtn.className = `btn btn-xs ${isEnabled ? 'btn-secondary' : 'btn-success'}`;
          toggleBtn.textContent = isEnabled ? t('extensions.btnDisable', null, 'Disable') : t('extensions.btnEnable', null, 'Enable');
          toggleBtn.addEventListener('click', async () => {
            try {
              toggleBtn.disabled = true;
              const actionEndpoint = isEnabled
                ? `/api/manage/extensions/${encodeURIComponent(ext.slug || ext.id)}/disable`
                : `/api/manage/extensions/${encodeURIComponent(ext.slug || ext.id)}/enable`;
              const finalSpace = targetSpace || state.currentSpaceId || (state.spaces && state.spaces[0] && state.spaces[0].id);
              await apiRequest(actionEndpoint, {
                method: 'POST',
                body: { spaceId: finalSpace },
              });
              showToast(
                isEnabled
                  ? t('extensions.disableSuccess', { name: ext.name || ext.slug }, `Extension "${ext.name || ext.slug}" disabled.`)
                  : t('extensions.enableSuccess', { name: ext.name || ext.slug }, `Extension "${ext.name || ext.slug}" enabled.`),
                'success'
              );
              await loadExtensions();
            } catch (err) {
              showToast(getSafeErrorMessage(err, 'Failed to toggle extension.'), 'error');
            } finally {
              toggleBtn.disabled = false;
            }
          });
          tdActions.appendChild(toggleBtn);
        }

        if (!isBundled) {
          // Update Button
          const updateBtn = document.createElement('button');
          updateBtn.type = 'button';
          updateBtn.className = 'btn btn-secondary btn-xs';
          updateBtn.textContent = t('extensions.btnUpdate', null, 'Update');
          updateBtn.addEventListener('click', () => {
            openUpdateSkillModal(ext.slug || ext.name, ext.sourceKind || 'git', targetSpace);
          });
          tdActions.appendChild(updateBtn);

          // Rollback Button
          const rollbackBtn = document.createElement('button');
          rollbackBtn.type = 'button';
          rollbackBtn.className = 'btn btn-secondary btn-xs';
          rollbackBtn.textContent = t('extensions.btnRollback', null, 'Rollback');
          rollbackBtn.addEventListener('click', () => {
            openRollbackSkillModal(ext.slug || ext.name, ext.sourceKind || 'git', targetSpace);
          });
          tdActions.appendChild(rollbackBtn);

          // Uninstall Button
          const uninstallBtn = document.createElement('button');
          uninstallBtn.type = 'button';
          uninstallBtn.className = 'btn btn-danger btn-xs';
          uninstallBtn.textContent = t('extensions.btnUninstall', null, 'Uninstall');
          uninstallBtn.addEventListener('click', () => {
            showConfirmation(
              t('extensions.confirmUninstallTitle', null, 'Confirm Extension Uninstallation'),
              t('extensions.confirmUninstallMessage', { name: ext.name || ext.slug }, `Are you sure you want to uninstall extension "${ext.name || ext.slug}"?`),
              async () => {
                try {
                  const finalSpace = targetSpace || state.currentSpaceId;
                  await apiRequest(`/api/manage/extensions/${encodeURIComponent(ext.slug || ext.id)}/uninstall`, {
                    method: 'POST',
                    body: finalSpace ? { spaceId: finalSpace } : {},
                  });
                  showToast(t('extensions.uninstallSuccess', { name: ext.name || ext.slug }, `Extension "${ext.name || ext.slug}" uninstalled successfully.`), 'success');
                  await loadExtensions();
                } catch (err) {
                  showToast(getSafeErrorMessage(err, t('extensions.uninstallFailed', { error: '' }, 'Failed to uninstall extension.')), 'error');
                }
              }
            );
          });
          tdActions.appendChild(uninstallBtn);
        } else {
          // Bundled packages are read-only: no update/disable/rollback/uninstall unless backend binding exists
          const readonlyBadge = document.createElement('span');
          readonlyBadge.className = 'badge badge-muted text-xs';
          readonlyBadge.textContent = t('extensions.readonlyBundled', null, 'Built-in (Read-only)');
          tdActions.appendChild(readonlyBadge);
        }

        tr.appendChild(tdActions);
        tbody.appendChild(tr);
      });

      table.appendChild(tbody);
      tableContainer.appendChild(table);
      contentArea.appendChild(tableContainer);
    } catch (err) {
      contentArea.replaceChildren(createStateCard('common.error', getSafeErrorMessage(err, 'Failed to load extensions.'), true));
    }
  };

  kindSelect.addEventListener('change', () => {
    state.activeExtensionFilterKind = kindSelect.value;
    loadExtensions();
  });
  spaceSelect.addEventListener('change', () => {
    state.activeSkillFilterSpace = spaceSelect.value;
    loadExtensions();
  });
  sourceSelect.addEventListener('change', () => {
    state.activeSkillFilterSource = sourceSelect.value;
    loadExtensions();
  });
  enabledSelect.addEventListener('change', () => {
    state.activeSkillFilterEnabled = enabledSelect.value;
    loadExtensions();
  });

  await loadExtensions();
  container.appendChild(section);
}

/**
 * Opens and renders the Extension Details & Manifest Modal
 */
async function openExtensionDetailModal(slug, spaceId) {
  const modal = document.getElementById('modal-extension-detail');
  const body = document.getElementById('extension-detail-body');
  if (!modal || !body) return;

  body.replaceChildren(createSkeletonLoader());
  openModal('modal-extension-detail');

  try {
    const targetSpace = spaceId || state.currentSpaceId;
    const url = `/api/manage/extensions/${encodeURIComponent(slug)}${targetSpace ? '?spaceId=' + encodeURIComponent(targetSpace) : ''}`;
    const res = await apiRequest(url);
    const detail = res && res.data;

    if (!detail) {
      body.replaceChildren(createStateCard('common.error', 'Extension details could not be loaded.', true));
      return;
    }

    body.replaceChildren();

    const isBundled = detail.sourceKind === 'builtin';
    const isEnabled = detail.enabled === true || (isBundled && detail.status === 'active');
    const versionNum = detail.activeVersion || detail.installedVersion || 1;

    // 1. Header & Metadata
    const headerEl = document.createElement('div');
    headerEl.className = 'extension-detail-header';

    const titleRow = document.createElement('div');
    titleRow.className = 'extension-detail-title-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'extension-detail-name';
    nameEl.textContent = detail.name || detail.slug;
    titleRow.appendChild(nameEl);

    const detailHasPlugin = detail.contributions && detail.contributions.some((c) => c.kind === 'dsh-plugin');
    const detailHasMcp = detail.contributions && detail.contributions.some((c) => c.kind === 'mcp');
    const detailHasCli = detail.contributions && detail.contributions.some((c) => c.kind === 'cli');
    const detailHasSkill = !detail.contributions || detail.contributions.length === 0 || detail.contributions.some((c) => c.kind === 'skill');
    if (detailHasPlugin) {
      titleRow.appendChild(createBadgeElement(t('extensions.kindChipDshPlugin', null, 'DSH Plugin'), 'info'));
    } else if (detailHasCli) {
      titleRow.appendChild(createBadgeElement(t('extensions.kindChipCli', null, 'CLI'), 'info'));
    } else if (detailHasMcp && detailHasSkill && detail.contributions && detail.contributions.length > 1) {
      titleRow.appendChild(createBadgeElement(t('extensions.kindChipSkill', null, 'Skill'), 'info'));
      titleRow.appendChild(createBadgeElement(t('extensions.kindChipMcp', null, 'MCP'), 'info'));
    } else if (detailHasMcp) {
      titleRow.appendChild(createBadgeElement(t('extensions.kindChipMcp', null, 'MCP'), 'info'));
    } else {
      titleRow.appendChild(createBadgeElement(t('extensions.kindChipSkill', null, 'Skill'), 'info'));
    }
    titleRow.appendChild(createBadgeElement(`v${versionNum}`, 'info'));
    titleRow.appendChild(createBadgeElement(
      isBundled ? t('extensions.sourceBundled', null, 'Bundled') : (detail.sourceKind === 'git' ? t('extensions.sourceGit', null, 'Git') : t('extensions.sourceArchive', null, 'Archive')),
      isBundled ? 'muted' : 'user'
    ));
    titleRow.appendChild(createBadgeElement(
      isEnabled ? t('extensions.badgeEnabled', null, 'Enabled') : t('extensions.badgeDisabled', null, 'Disabled'),
      isEnabled ? 'success' : 'muted'
    ));
    headerEl.appendChild(titleRow);

    const metaGrid = document.createElement('div');
    metaGrid.className = 'extension-detail-meta-grid';

    // Slug
    const itemSlug = document.createElement('div');
    itemSlug.className = 'extension-meta-item';
    const lblSlug = document.createElement('span');
    lblSlug.className = 'extension-meta-label';
    lblSlug.textContent = 'Slug';
    const valSlug = document.createElement('span');
    valSlug.className = 'extension-meta-value mono-cell';
    valSlug.textContent = detail.slug;
    itemSlug.appendChild(lblSlug);
    itemSlug.appendChild(valSlug);
    metaGrid.appendChild(itemSlug);

    // Source URL
    const itemSrc = document.createElement('div');
    itemSrc.className = 'extension-meta-item';
    const lblSrc = document.createElement('span');
    lblSrc.className = 'extension-meta-label';
    lblSrc.textContent = t('extensions.safeUrl', null, 'Source URL');
    const valSrc = document.createElement('span');
    valSrc.className = 'extension-meta-value mono-cell';
    valSrc.textContent = isBundled ? t('extensions.provenanceBundled', null, 'Built-in') : sanitizeSourceUrl(detail.sourceRef || '-');
    itemSrc.appendChild(lblSrc);
    itemSrc.appendChild(valSrc);
    metaGrid.appendChild(itemSrc);

    // SHA-256
    const itemSha = document.createElement('div');
    itemSha.className = 'extension-meta-item';
    const lblSha = document.createElement('span');
    lblSha.className = 'extension-meta-label';
    lblSha.textContent = t('extensions.integritySha256', null, 'Integrity SHA-256');
    const valSha = document.createElement('span');
    valSha.className = 'extension-meta-value mono-cell';
    valSha.textContent = detail.integritySha256 ? `${detail.integritySha256.slice(0, 16)}...` : '-';
    if (detail.integritySha256) valSha.setAttribute('title', detail.integritySha256);
    itemSha.appendChild(lblSha);
    itemSha.appendChild(valSha);
    metaGrid.appendChild(itemSha);

    headerEl.appendChild(metaGrid);
    body.appendChild(headerEl);

    // 2. Tabs Navigation
    const tabsContainer = document.createElement('div');
    tabsContainer.className = 'extension-detail-tabs';

    const tabBtnContent = document.createElement('button');
    tabBtnContent.type = 'button';
    tabBtnContent.className = 'extension-detail-tab-btn active';
    tabBtnContent.textContent = t('extensions.tabContent', null, 'Content & Manifest');

    const tabBtnVersions = document.createElement('button');
    tabBtnVersions.type = 'button';
    tabBtnVersions.className = 'extension-detail-tab-btn';
    tabBtnVersions.textContent = t('extensions.tabVersions', null, 'Version History');

    const tabBtnBindings = document.createElement('button');
    tabBtnBindings.type = 'button';
    tabBtnBindings.className = 'extension-detail-tab-btn';
    tabBtnBindings.textContent = t('extensions.tabBindings', null, 'Space Bindings');

    tabsContainer.appendChild(tabBtnContent);
    tabsContainer.appendChild(tabBtnVersions);
    tabsContainer.appendChild(tabBtnBindings);
    body.appendChild(tabsContainer);

    // 3. Tab Panels
    const panelContent = document.createElement('div');
    panelContent.className = 'extension-tab-panel';

    const panelVersions = document.createElement('div');
    panelVersions.className = 'extension-tab-panel hidden';

    const panelBindings = document.createElement('div');
    panelBindings.className = 'extension-tab-panel hidden';

    // ---- Panel 1: Content & Manifest ----
    const manifestWrap = document.createElement('div');
    manifestWrap.className = 'extension-manifest-panel';

    if (detail.description) {
      const descSec = document.createElement('div');
      descSec.className = 'extension-manifest-section';
      const descTitle = document.createElement('span');
      descTitle.className = 'extension-manifest-section-title';
      descTitle.textContent = t('common.description', null, 'Description');
      const descText = document.createElement('p');
      descText.className = 'text-sm';
      descText.textContent = detail.description;
      descSec.appendChild(descTitle);
      descSec.appendChild(descText);
      manifestWrap.appendChild(descSec);
    }

    const firstContrib = detail.contributions && detail.contributions[0];
    if (firstContrib && firstContrib.whenToUse) {
      const wtuSec = document.createElement('div');
      wtuSec.className = 'extension-manifest-section';
      const wtuTitle = document.createElement('span');
      wtuTitle.className = 'extension-manifest-section-title';
      wtuTitle.textContent = t('extensions.whenToUse', null, 'When to Use');
      const wtuText = document.createElement('p');
      wtuText.className = 'text-sm';
      wtuText.textContent = firstContrib.whenToUse;
      wtuSec.appendChild(wtuTitle);
      wtuSec.appendChild(wtuText);
      manifestWrap.appendChild(wtuSec);
    }

    if (firstContrib) {
      const policySec = document.createElement('div');
      policySec.className = 'extension-manifest-section';
      const policyTitle = document.createElement('span');
      policyTitle.className = 'extension-manifest-section-title';
      policyTitle.textContent = t('extensions.invocationPolicy', null, 'Invocation Policy');

      const policyRow = document.createElement('div');
      policyRow.className = 'flex-row gap-2 mt-1';
      policyRow.appendChild(createBadgeElement(`${t('extensions.modelInvocable', null, 'Model Invocable')}: ${firstContrib.modelInvocable ? t('extensions.yes', null, 'Yes') : t('extensions.no', null, 'No')}`, firstContrib.modelInvocable ? 'success' : 'muted'));
      policyRow.appendChild(createBadgeElement(`${t('extensions.userInvocable', null, 'User Invocable')}: ${firstContrib.userInvocable ? t('extensions.yes', null, 'Yes') : t('extensions.no', null, 'No')}`, firstContrib.userInvocable ? 'success' : 'muted'));
      policySec.appendChild(policyTitle);
      policySec.appendChild(policyRow);
      manifestWrap.appendChild(policySec);
    }

    // Check for MCP contributions
    const mcpContributions = detail.contributions ? detail.contributions.filter((c) => c.kind === 'mcp') : [];
    if (mcpContributions.length > 0) {
      mcpContributions.forEach((mc) => {
        const mcpSec = document.createElement('div');
        mcpSec.className = 'extension-manifest-section';
        const mcpTitle = document.createElement('span');
        mcpTitle.className = 'extension-manifest-section-title';
        mcpTitle.textContent = `MCP Server: ${mc.name || mc.contributionKey}`;
        mcpSec.appendChild(mcpTitle);

        const manifest = mc.manifest || {};
        const transportType = String(manifest.transport || 'stdio').toLowerCase();
        const isHttp = transportType === 'streamable-http' || transportType === 'http';
        const declaredTools = Array.isArray(manifest.tools) ? manifest.tools : (Array.isArray(manifest.declaredTools) ? manifest.declaredTools : []);

        const mcpGrid = document.createElement('div');
        mcpGrid.className = 'extension-detail-meta-grid mb-2';

        // 1. Transport Type
        const itemTrans = document.createElement('div');
        itemTrans.className = 'extension-meta-item';
        const lblTrans = document.createElement('span');
        lblTrans.className = 'extension-meta-label';
        lblTrans.textContent = t('extensions.mcpTransport', null, 'Transport Type');
        const valTrans = document.createElement('span');
        valTrans.className = 'extension-meta-value';
        valTrans.appendChild(createBadgeElement(
          isHttp ? t('extensions.mcpTransportHttp', null, 'Streamable HTTP') : t('extensions.mcpTransportStdio', null, 'STDIO (Subprocess)'),
          'info'
        ));
        itemTrans.appendChild(lblTrans);
        itemTrans.appendChild(valTrans);
        mcpGrid.appendChild(itemTrans);

        // 2. Tool Health / Count
        const itemHealth = document.createElement('div');
        itemHealth.className = 'extension-meta-item';
        const lblHealth = document.createElement('span');
        lblHealth.className = 'extension-meta-label';
        lblHealth.textContent = t('extensions.mcpToolHealth', null, 'Tool Health');
        const valHealth = document.createElement('span');
        valHealth.className = 'extension-meta-value';
        const healthText = isEnabled
          ? (declaredTools.length > 0 ? `${t('extensions.healthOperational', null, 'Operational')} (${t('extensions.mcpToolsCount', { count: declaredTools.length }, `${declaredTools.length} Tools`)})` : t('extensions.healthOperational', null, 'Operational'))
          : t('extensions.healthDisabled', null, 'Disabled');
        valHealth.appendChild(createBadgeElement(healthText, isEnabled ? 'success' : 'muted'));
        itemHealth.appendChild(lblHealth);
        itemHealth.appendChild(valHealth);
        mcpGrid.appendChild(itemHealth);

        // 3. Credential References (Names only - strictly NO plaintext values)
        const itemCreds = document.createElement('div');
        itemCreds.className = 'extension-meta-item';
        const lblCreds = document.createElement('span');
        lblCreds.className = 'extension-meta-label';
        lblCreds.textContent = t('extensions.mcpCredentialRefs', null, 'Credential References');
        const valCreds = document.createElement('span');
        valCreds.className = 'extension-meta-value mono-cell';
        const rawCredRefs = manifest.credentialRefs || manifest.envRefs;
        let credRefNames = [];
        if (Array.isArray(rawCredRefs)) {
          credRefNames = rawCredRefs.map((r) => (typeof r === 'string' ? r : (r && r.id ? r.id : String(r))));
        } else if (rawCredRefs && typeof rawCredRefs === 'object') {
          credRefNames = Object.keys(rawCredRefs);
        }
        valCreds.textContent = credRefNames.length > 0 ? credRefNames.join(', ') : t('extensions.mcpNoCredentialRefs', null, 'No credential references');
        itemCreds.appendChild(lblCreds);
        itemCreds.appendChild(valCreds);
        mcpGrid.appendChild(itemCreds);

        // 4. Command / URL (Read-only display, no editing!)
        const itemCmd = document.createElement('div');
        itemCmd.className = 'extension-meta-item';
        const lblCmd = document.createElement('span');
        lblCmd.className = 'extension-meta-label';
        lblCmd.textContent = isHttp ? t('extensions.mcpUrl', null, 'Endpoint URL') : t('extensions.mcpCommand', null, 'Command');
        const valCmd = document.createElement('span');
        valCmd.className = 'extension-meta-value mono-cell text-xs';
        if (isHttp) {
          valCmd.textContent = manifest.url ? sanitizeSourceUrl(manifest.url) : '-';
        } else {
          const cmdStr = manifest.command ? String(manifest.command) : '';
          const argsList = Array.isArray(manifest.args) ? manifest.args : (Array.isArray(manifest.argv) ? manifest.argv : []);
          valCmd.textContent = [cmdStr, ...argsList].filter(Boolean).join(' ') || '-';
        }
        itemCmd.appendChild(lblCmd);
        itemCmd.appendChild(valCmd);
        mcpGrid.appendChild(itemCmd);

        mcpSec.appendChild(mcpGrid);

        // 5. Declared Tools List
        if (declaredTools.length > 0) {
          const toolsTitle = document.createElement('span');
          toolsTitle.className = 'extension-manifest-section-title mt-1';
          toolsTitle.textContent = t('extensions.mcpToolsDeclared', null, 'Declared Tools');
          mcpSec.appendChild(toolsTitle);

          const toolsList = document.createElement('div');
          toolsList.className = 'extension-mcp-tools-list';
          declaredTools.forEach((tool) => {
            if (!tool || typeof tool !== 'object') return;
            const toolItem = document.createElement('div');
            toolItem.className = 'extension-mcp-tool-item';
            const toolHead = document.createElement('div');
            toolHead.className = 'extension-mcp-tool-header';
            const toolName = document.createElement('span');
            toolName.className = 'extension-mcp-tool-name';
            toolName.textContent = tool.name || '-';
            toolHead.appendChild(toolName);
            toolItem.appendChild(toolHead);

            if (tool.description) {
              const toolDesc = document.createElement('div');
              toolDesc.className = 'extension-mcp-tool-desc';
              toolDesc.textContent = tool.description;
              toolItem.appendChild(toolDesc);
            }
            toolsList.appendChild(toolItem);
          });
          mcpSec.appendChild(toolsList);
        }

        manifestWrap.appendChild(mcpSec);
      });
    }

    // Check for CLI contributions
    const cliContributions = detail.contributions ? detail.contributions.filter((c) => c.kind === 'cli') : [];
    if (cliContributions.length > 0) {
      cliContributions.forEach((cc) => {
        const cliSec = document.createElement('div');
        cliSec.className = 'extension-manifest-section';
        const cliTitle = document.createElement('span');
        cliTitle.className = 'extension-manifest-section-title';
        cliTitle.textContent = `CLI Tool: ${cc.name || cc.contributionKey}`;
        cliSec.appendChild(cliTitle);

        const manifest = cc.manifest || {};
        const cliGrid = document.createElement('div');
        cliGrid.className = 'extension-detail-meta-grid mb-2';

        // 1. Command
        const itemCmd = document.createElement('div');
        itemCmd.className = 'extension-meta-item';
        const lblCmd = document.createElement('span');
        lblCmd.className = 'extension-meta-label';
        lblCmd.textContent = 'Command';
        const valCmd = document.createElement('span');
        valCmd.className = 'extension-meta-value mono-cell text-xs';
        const cmdStr = manifest.command || 'node';
        const scriptStr = manifest.script || '';
        const fixedArgs = Array.isArray(manifest.fixedArgs) ? manifest.fixedArgs : (Array.isArray(manifest.args) ? manifest.args : []);
        valCmd.textContent = [cmdStr, scriptStr, ...fixedArgs].filter(Boolean).join(' ') || '-';
        itemCmd.appendChild(lblCmd);
        itemCmd.appendChild(valCmd);
        cliGrid.appendChild(itemCmd);

        // 2. Tool Name
        const itemTool = document.createElement('div');
        itemTool.className = 'extension-meta-item';
        const lblTool = document.createElement('span');
        lblTool.className = 'extension-meta-label';
        lblTool.textContent = 'Tool Name';
        const valTool = document.createElement('span');
        valTool.className = 'extension-meta-value mono-cell text-xs';
        valTool.textContent = `cli__${(cc.contributionKey || '').replace(/[^a-zA-Z0-9_]/g, '_')}__run`;
        itemTool.appendChild(lblTool);
        itemTool.appendChild(valTool);
        cliGrid.appendChild(itemTool);

        cliSec.appendChild(cliGrid);
        manifestWrap.appendChild(cliSec);
      });
    }

    if (detail.content) {
      const codeSec = document.createElement('div');
      codeSec.className = 'extension-manifest-section mt-2';
      const codeTitle = document.createElement('span');
      codeTitle.className = 'extension-manifest-section-title';
      codeTitle.textContent = 'SKILL.md';
      const pre = document.createElement('pre');
      pre.className = 'extension-content-pre';
      pre.textContent = detail.content;
      codeSec.appendChild(codeTitle);
      codeSec.appendChild(pre);
      manifestWrap.appendChild(codeSec);
    } else if (!detail.description && !firstContrib && mcpContributions.length === 0) {
      manifestWrap.appendChild(createStateCard('extensions.noContent', ''));
    }
    panelContent.appendChild(manifestWrap);

    // ---- Panel 2: Version History ----
    const versions = Array.isArray(detail.versions) ? detail.versions : [];
    if (versions.length === 0) {
      panelVersions.appendChild(createStateCard('extensions.noVersions', ''));
    } else {
      const vTableContainer = document.createElement('div');
      vTableContainer.className = 'data-table-container';
      const vTable = document.createElement('table');
      vTable.className = 'data-table extension-versions-table';

      const vHead = document.createElement('thead');
      const vHeadTr = document.createElement('tr');
      ['Version', 'Source', 'Commit', 'SHA-256', 'Created At', 'Summary', 'Actions'].forEach((c) => {
        const th = document.createElement('th');
        th.textContent = c;
        vHeadTr.appendChild(th);
      });
      vHead.appendChild(vHeadTr);
      vTable.appendChild(vHead);

      const vBody = document.createElement('tbody');
      versions.forEach((v) => {
        const vTr = document.createElement('tr');

        // Version badge
        const tdVVer = document.createElement('td');
        tdVVer.appendChild(createBadgeElement(`v${v.version}`, v.version === versionNum ? 'success' : 'info'));
        vTr.appendChild(tdVVer);

        // Source Kind
        const tdVSrc = document.createElement('td');
        tdVSrc.textContent = v.sourceKind || '-';
        vTr.appendChild(tdVSrc);

        // Commit SHA
        const tdVCommit = document.createElement('td');
        tdVCommit.className = 'mono-cell text-xs';
        tdVCommit.textContent = v.commitSha ? v.commitSha.slice(0, 8) : '-';
        vTr.appendChild(tdVCommit);

        // SHA-256
        const tdVSha = document.createElement('td');
        tdVSha.className = 'mono-cell text-xs';
        tdVSha.textContent = v.integritySha256 ? `${v.integritySha256.slice(0, 10)}...` : '-';
        vTr.appendChild(tdVSha);

        // Created At
        const tdVTime = document.createElement('td');
        tdVTime.textContent = v.createdAt ? formatDate(v.createdAt) : '-';
        vTr.appendChild(tdVTime);

        // Summary
        const tdVSummary = document.createElement('td');
        tdVSummary.className = 'text-sm text-secondary';
        tdVSummary.textContent = v.changeSummary || '-';
        vTr.appendChild(tdVSummary);

        // Actions (Rollback to this version)
        const tdVActions = document.createElement('td');
        if (!isBundled && v.version !== versionNum) {
          const rbBtn = document.createElement('button');
          rbBtn.type = 'button';
          rbBtn.className = 'btn btn-xs btn-secondary';
          rbBtn.textContent = t('extensions.btnRollback', null, 'Rollback');
          rbBtn.addEventListener('click', async () => {
            closeModal('modal-extension-detail');
            openRollbackSkillModal(detail.slug, detail.sourceKind, targetSpace);
            const verInput = document.getElementById('rollback-skill-target-version-input');
            if (verInput) verInput.value = String(v.version);
          });
          tdVActions.appendChild(rbBtn);
        }
        vTr.appendChild(tdVActions);

        vBody.appendChild(vTr);
      });
      vTable.appendChild(vBody);
      vTableContainer.appendChild(vTable);
      panelVersions.appendChild(vTableContainer);
    }

    // ---- Panel 3: Space Bindings ----
    const allSpaces = state.spaces || [];
    if (allSpaces.length === 0) {
      panelBindings.appendChild(createStateCard('extensions.noBindings', ''));
    } else {
      const bTableContainer = document.createElement('div');
      bTableContainer.className = 'data-table-container';
      const bTable = document.createElement('table');
      bTable.className = 'data-table extension-bindings-table';

      const bHead = document.createElement('thead');
      const bHeadTr = document.createElement('tr');
      ['Space Name', 'Status', 'Actions'].forEach((col) => {
        const th = document.createElement('th');
        th.textContent = col;
        bHeadTr.appendChild(th);
      });
      bHead.appendChild(bHeadTr);
      bTable.appendChild(bHead);

      const bBody = document.createElement('tbody');
      const bindingsList = Array.isArray(detail.bindings) ? detail.bindings : [];

      allSpaces.forEach((sp) => {
        const bTr = document.createElement('tr');

        // Space Name
        const tdBSpace = document.createElement('td');
        tdBSpace.className = 'font-medium';
        tdBSpace.textContent = sp.name || sp.id;
        bTr.appendChild(tdBSpace);

        // Binding Status
        const existingBinding = bindingsList.find((b) => b.spaceId === sp.id);
        const isSpaceBound = Boolean(existingBinding && existingBinding.enabled);
        const tdBStatus = document.createElement('td');
        tdBStatus.appendChild(createBadgeElement(
          isSpaceBound ? t('extensions.boundSpace', null, 'Bound') : t('extensions.unboundSpace', null, 'Unbound'),
          isSpaceBound ? 'success' : 'muted'
        ));
        bTr.appendChild(tdBStatus);

        // Action (Toggle Bind / Unbind)
        const tdBActions = document.createElement('td');
        const canToggleSpace = !isBundled || detailHasPlugin;
        if (canToggleSpace) {
          const toggleSpaceBtn = document.createElement('button');
          toggleSpaceBtn.type = 'button';
          toggleSpaceBtn.className = `btn btn-xs ${isSpaceBound ? 'btn-secondary' : 'btn-primary'}`;
          toggleSpaceBtn.textContent = isSpaceBound ? t('extensions.btnUnbindSpace', null, 'Unbind / Disable') : t('extensions.bindSpace', null, 'Bind & Enable');
          toggleSpaceBtn.addEventListener('click', async () => {
            try {
              toggleSpaceBtn.disabled = true;
              const ep = isSpaceBound
                ? `/api/manage/extensions/${encodeURIComponent(detail.slug)}/disable`
                : `/api/manage/extensions/${encodeURIComponent(detail.slug)}/enable`;
              await apiRequest(ep, {
                method: 'POST',
                body: { spaceId: sp.id },
              });
              showToast(isSpaceBound ? `Unbound from ${sp.name || sp.id}` : `Bound to ${sp.name || sp.id}`, 'success');
              await openExtensionDetailModal(detail.slug, targetSpace);
            } catch (err) {
              showToast(getSafeErrorMessage(err, 'Failed to update space binding.'), 'error');
            } finally {
              toggleSpaceBtn.disabled = false;
            }
          });
          tdBActions.appendChild(toggleSpaceBtn);
        } else {
          const ro = document.createElement('span');
          ro.className = 'badge badge-muted text-xs';
          ro.textContent = t('extensions.readonlyBundled', null, 'Built-in (Read-only)');
          tdBActions.appendChild(ro);
        }
        bTr.appendChild(tdBActions);

        bBody.appendChild(bTr);
      });
      bTable.appendChild(bBody);
      bTableContainer.appendChild(bTable);
      panelBindings.appendChild(bTableContainer);
    }

    // Tab switching logic
    tabBtnContent.addEventListener('click', () => {
      tabBtnContent.classList.add('active');
      tabBtnVersions.classList.remove('active');
      tabBtnBindings.classList.remove('active');
      panelContent.classList.remove('hidden');
      panelVersions.classList.add('hidden');
      panelBindings.classList.add('hidden');
    });

    tabBtnVersions.addEventListener('click', () => {
      tabBtnContent.classList.remove('active');
      tabBtnVersions.classList.add('active');
      tabBtnBindings.classList.remove('active');
      panelContent.classList.add('hidden');
      panelVersions.classList.remove('hidden');
      panelBindings.classList.add('hidden');
    });

    tabBtnBindings.addEventListener('click', () => {
      tabBtnContent.classList.remove('active');
      tabBtnVersions.classList.remove('active');
      tabBtnBindings.classList.add('active');
      panelContent.classList.add('hidden');
      panelVersions.classList.add('hidden');
      panelBindings.classList.remove('hidden');
    });

    body.appendChild(panelContent);
    body.appendChild(panelVersions);
    body.appendChild(panelBindings);
  } catch (err) {
    body.replaceChildren(createStateCard('common.error', getSafeErrorMessage(err, 'Failed to load extension details.'), true));
  }
}

async function openInstallSkillModal() {
  const form = document.getElementById('install-skill-form');
  if (form) form.reset();

  const spaceSelect = document.getElementById('skill-target-space-select');
  if (spaceSelect) {
    if (!state.spaces || state.spaces.length === 0) {
      try {
        const sRes = await apiRequest('/api/spaces');
        const sData = sRes && sRes.data;
        state.spaces = Array.isArray(sData) ? sData : ((sData && Array.isArray(sData.spaces)) ? sData.spaces : []);
      } catch {}
    }
    spaceSelect.replaceChildren();
    (state.spaces || []).forEach((sp) => {
      const opt = document.createElement('option');
      opt.value = sp.id;
      opt.textContent = sp.name || sp.id;
      if (sp.id === state.currentSpaceId) opt.selected = true;
      spaceSelect.appendChild(opt);
    });
  }

  const scopeGlobalOpt = document.getElementById('skill-scope-opt-global');
  if (scopeGlobalOpt) {
    const isAdmin = Boolean(state.currentUser && state.currentUser.role === 'admin');
    scopeGlobalOpt.disabled = !isAdmin;
  }

  openModal('modal-install-skill');
}

function openUpdateSkillModal(skillName, scope, spaceId) {
  const form = document.getElementById('update-skill-form');
  if (form) form.reset();

  const nameInput = document.getElementById('update-skill-name');
  const scopeInput = document.getElementById('update-skill-scope');
  const spaceInput = document.getElementById('update-skill-space-id');
  const titleEl = document.getElementById('modal-update-skill-title');
  const diffContainer = document.getElementById('skill-diff-preview-container');

  if (nameInput) nameInput.value = skillName;
  if (scopeInput) scopeInput.value = scope || 'space';
  if (spaceInput) spaceInput.value = spaceId || '';
  if (diffContainer) diffContainer.classList.add('hidden');
  if (titleEl) titleEl.textContent = `${t('extensions.updateModalTitle', null, 'Update Extension Package & Preview Diff')}: ${skillName}`;

  openModal('modal-update-skill');
}

function openRollbackSkillModal(skillName, scope, spaceId) {
  const form = document.getElementById('rollback-skill-form');
  if (form) form.reset();

  const nameInput = document.getElementById('rollback-skill-name');
  const scopeInput = document.getElementById('rollback-skill-scope');
  const spaceInput = document.getElementById('rollback-skill-space-id');
  const titleEl = document.getElementById('modal-rollback-skill-title');

  if (nameInput) nameInput.value = skillName;
  if (scopeInput) scopeInput.value = scope || 'space';
  if (spaceInput) spaceInput.value = spaceId || '';
  if (titleEl) titleEl.textContent = `${t('extensions.rollbackModalTitle', null, 'Rollback Extension to Version')}: ${skillName}`;

  openModal('modal-rollback-skill');
}

/**
 * ==========================================================================
 * APPROVALS & DECISION LOGIC (GET/POST /api/interactions/approvals/*)
 * ==========================================================================
 */

async function fetchPendingApprovals(sessionIdFilter) {
  try {
    const params = new URLSearchParams();
    if (sessionIdFilter) params.append('sessionId', sessionIdFilter);
    const query = params.toString() ? `?${params.toString()}` : '';
    const res = await apiRequest(`/api/interactions/approvals${query}`);
    const raw = res && res.data;
    const approvals = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : []);
    state.pendingApprovals = approvals;
    updateApprovalBadges(approvals);
    return approvals;
  } catch {
    return [];
  }
}

function updateApprovalBadges(approvals) {
  if (Array.isArray(approvals)) {
    state.pendingApprovals = approvals;
  }
  const effectiveApprovals = Array.isArray(approvals) ? approvals : (state.pendingApprovals || []);
  const pendingCount = effectiveApprovals.filter((a) => a.status === 'pending').length;
  const chatApprovalBtn = document.getElementById('btn-chat-approvals');

  if (chatApprovalBtn) {
    if (pendingCount > 0) {
      chatApprovalBtn.classList.remove('hidden');
      chatApprovalBtn.textContent = `⚠️ ${t('approvals.headerPendingCount', { count: pendingCount }, `${pendingCount} Pending Approvals`)}`;
    } else {
      chatApprovalBtn.classList.add('hidden');
    }
  }

  updateTurnStatusBadge(effectiveApprovals);
}

async function openApprovalsModal(sessionIdFilter) {
  const contentEl = document.getElementById('approvals-modal-list');
  if (contentEl) {
    contentEl.replaceChildren(createSkeletonLoader());
  }
  openModal('modal-approvals');

  const approvals = await fetchPendingApprovals(sessionIdFilter || state.currentSessionId);
  if (contentEl) {
    renderApprovalsList(contentEl, approvals);
  }
}

function renderApprovalsList(container, approvals) {
  container.replaceChildren();

  const pending = (approvals || []).filter((a) => a.status === 'pending');
  if (pending.length === 0) {
    container.appendChild(createStateCard('approvals.emptyTitle', 'approvals.emptyDesc'));
    return;
  }

  pending.forEach((ap) => {
    const card = document.createElement('div');
    card.className = 'approval-card';

    const header = document.createElement('div');
    header.className = 'approval-header';

    const toolGrp = document.createElement('div');
    toolGrp.className = 'approval-tool-group';

    const toolName = document.createElement('span');
    toolName.className = 'approval-tool-name';
    toolName.textContent = formatToolName(ap.toolName || 'tool_execution');
    toolGrp.appendChild(toolName);

    // Risk badge
    const riskBadge = document.createElement('span');
    const RISK_KEY_MAP = {
      low: 'approvals.riskLow',
      medium: 'approvals.riskMedium',
      high: 'approvals.riskHigh',
      critical: 'approvals.riskCritical',
    };
    const rawRisk = (typeof ap.risk === 'string') ? ap.risk.toLowerCase().trim() : '';
    const riskLevel = (rawRisk === 'low' || rawRisk === 'medium' || rawRisk === 'high' || rawRisk === 'critical') ? rawRisk : 'unknown';
    riskBadge.className = `badge badge-risk-${riskLevel}`;
    riskBadge.textContent = riskLevel !== 'unknown' ? t(RISK_KEY_MAP[riskLevel]) : t('approvals.riskUnknown');
    toolGrp.appendChild(riskBadge);

    header.appendChild(toolGrp);

    const timeSpan = document.createElement('span');
    timeSpan.className = 'text-muted text-xs';
    timeSpan.textContent = ap.createdAt ? formatDate(ap.createdAt) : '';
    header.appendChild(timeSpan);
    card.appendChild(header);

    // Safe Summary (Strictly no raw arguments / reason!)
    const summaryP = document.createElement('div');
    summaryP.className = 'approval-summary';
    const isSafeSummaryValid = typeof ap.safeSummary === 'string' && ap.safeSummary.trim().length > 0;
    summaryP.textContent = isSafeSummaryValid ? ap.safeSummary.trim() : t('approvals.genericSummary');
    card.appendChild(summaryP);

    // Action Buttons
    const actions = document.createElement('div');
    actions.className = 'approval-actions';

    // Allow Once Button
    const btnAllow = document.createElement('button');
    btnAllow.type = 'button';
    btnAllow.className = 'btn btn-primary btn-sm';
    btnAllow.textContent = t('approvals.btnAllow', null, 'Allow Once');
    btnAllow.addEventListener('click', async () => {
      await decideApproval(ap.id, 'allowed-once', container);
    });
    actions.appendChild(btnAllow);

    // Reject Button
    const btnReject = document.createElement('button');
    btnReject.type = 'button';
    btnReject.className = 'btn btn-danger btn-sm';
    btnReject.textContent = t('approvals.btnReject', null, 'Reject');
    btnReject.addEventListener('click', async () => {
      await decideApproval(ap.id, 'rejected', container);
    });
    actions.appendChild(btnReject);

    // Cancel Button
    const btnCancel = document.createElement('button');
    btnCancel.type = 'button';
    btnCancel.className = 'btn btn-secondary btn-sm';
    btnCancel.textContent = t('approvals.btnCancel', null, 'Cancel');
    btnCancel.addEventListener('click', async () => {
      await cancelApproval(ap.id, 'Cancelled by user', container);
    });
    actions.appendChild(btnCancel);

    card.appendChild(actions);
    container.appendChild(card);
  });
}

async function decideApproval(approvalId, outcome, container) {
  try {
    const idempotencyKey = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : undefined;
    await apiRequest(`/api/interactions/approvals/${approvalId}/decide`, {
      method: 'POST',
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
      body: { outcome },
    });
    showToast(outcome === 'allowed-once' ? t('approvals.allowSuccess', null, 'Tool execution allowed.') : t('approvals.rejectSuccess', null, 'Tool execution rejected.'), 'success');
    const fresh = await fetchPendingApprovals(state.currentSessionId);
    if (container) renderApprovalsList(container, fresh);
    if (fresh.length === 0) closeModal('modal-approvals');
  } catch (err) {
    showToast(getSafeErrorMessage(err, 'Failed to decide approval.'), 'error');
  }
}

async function cancelApproval(approvalId, reason, container) {
  try {
    const idempotencyKey = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : undefined;
    await apiRequest(`/api/interactions/approvals/${approvalId}/cancel`, {
      method: 'POST',
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
      body: { reason },
    });
    showToast(t('approvals.cancelSuccess', null, 'Approval request cancelled.'), 'info');
    const fresh = await fetchPendingApprovals(state.currentSessionId);
    if (container) renderApprovalsList(container, fresh);
    if (fresh.length === 0) closeModal('modal-approvals');
  } catch (err) {
    showToast(getSafeErrorMessage(err, 'Failed to cancel approval.'), 'error');
  }
}

/**
 * ==========================================================================
 * RUNTIME DIAGNOSTICS & TELEMETRY TIMELINE (GET /api/admin/runtime/:userId/diagnostics)
 * ==========================================================================
 */

async function openDiagnosticsModal(userId) {
  const targetUser = userId || (state.currentUser && state.currentUser.id) || 'alice';
  const gridEl = document.getElementById('diagnostics-resource-grid');
  const timelineEl = document.getElementById('diagnostics-timeline-container');
  const levelSelect = document.getElementById('diagnostics-level-select');

  if (gridEl) gridEl.replaceChildren(createSkeletonLoader());
  if (timelineEl) timelineEl.replaceChildren(createSkeletonLoader());

  openModal('modal-diagnostics');

  await loadDiagnosticsTimeline(targetUser, state.activeDiagnosticsLevel);

  if (levelSelect) {
    levelSelect.value = state.activeDiagnosticsLevel || '';
    levelSelect.addEventListener('change', () => {
      state.activeDiagnosticsLevel = levelSelect.value;
      loadDiagnosticsTimeline(targetUser, state.activeDiagnosticsLevel);
    });
  }

  const btnRefresh = document.getElementById('btn-diagnostics-refresh');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      loadDiagnosticsTimeline(targetUser, state.activeDiagnosticsLevel);
    });
  }
}

async function loadDiagnosticsTimeline(userId, levelFilter, beforeCursor) {
  const gridEl = document.getElementById('diagnostics-resource-grid');
  const timelineEl = document.getElementById('diagnostics-timeline-container');

  try {
    const params = new URLSearchParams();
    if (levelFilter) params.append('level', levelFilter);
    if (beforeCursor) params.append('before', beforeCursor);
    params.append('limit', '50');

    const res = await apiRequest(`/api/admin/runtime/${encodeURIComponent(userId)}/diagnostics?${params.toString()}`);
    const raw = res && res.data;
    const items = (raw && Array.isArray(raw.items)) ? raw.items : (Array.isArray(raw) ? raw : []);

    // Compute Resource KPIs from recent item with stats
    if (gridEl) {
      gridEl.replaceChildren();
      const itemWithStats = items.find((i) => i.stats && typeof i.stats === 'object') || items[0] || {};
      const stats = itemWithStats.stats || itemWithStats;

      const cpuVal = typeof stats.cpuPercent === 'number' ? `${stats.cpuPercent.toFixed(1)}%` : (typeof stats.cpu_percent === 'number' ? `${stats.cpu_percent.toFixed(1)}%` : '0.0%');
      const memVal = stats.memoryUsageBytes ? formatBytes(stats.memoryUsageBytes) : (stats.memory_usage_bytes ? formatBytes(stats.memory_usage_bytes) : '-');
      const pidsVal = stats.pidsCount !== undefined ? String(stats.pidsCount) : (stats.pids_count !== undefined ? String(stats.pids_count) : '-');
      const volVal = stats.volumeBytes ? formatBytes(stats.volumeBytes) : (stats.volume_bytes ? formatBytes(stats.volume_bytes) : '-');

      gridEl.appendChild(createKpiCard('diagnostics.kpiCpu', cpuVal, 'Sandbox CPU'));
      gridEl.appendChild(createKpiCard('diagnostics.kpiMemory', memVal, 'RAM Allocation'));
      gridEl.appendChild(createKpiCard('diagnostics.kpiPids', pidsVal, 'Active Processes'));
      gridEl.appendChild(createKpiCard('diagnostics.kpiVolume', volVal, 'Container Volume'));
    }

    if (timelineEl) {
      timelineEl.replaceChildren();

      if (items.length === 0) {
        timelineEl.appendChild(createStateCard('diagnostics.emptyTitle', 'diagnostics.emptyDesc'));
        return;
      }

      items.forEach((item) => {
        if (!item || typeof item !== 'object') return;

        const card = document.createElement('div');
        const lvl = item.level || 'info';
        card.className = `timeline-event-card level-${lvl}`;

        const header = document.createElement('div');
        header.className = 'timeline-header';

        const codeSpan = document.createElement('span');
        codeSpan.className = 'timeline-code';
        codeSpan.textContent = item.code || item.eventType || 'DIAGNOSTIC_EVENT';
        header.appendChild(codeSpan);

        const lvlBadge = createBadgeElement(lvl, lvl === 'error' ? 'danger' : (lvl === 'warn' ? 'warning' : (lvl === 'info' ? 'info' : 'muted')));
        header.appendChild(lvlBadge);

        const timeSpan = document.createElement('span');
        timeSpan.className = 'timeline-time';
        timeSpan.textContent = item.createdAt ? formatDate(item.createdAt) : '';
        header.appendChild(timeSpan);
        card.appendChild(header);

        const msgDiv = document.createElement('div');
        msgDiv.className = 'timeline-message';
        msgDiv.textContent = item.message || 'Structured runtime event';
        card.appendChild(msgDiv);

        if (item.details && typeof item.details === 'object' && Object.keys(item.details).length > 0) {
          const detDiv = document.createElement('div');
          detDiv.className = 'timeline-details-table';
          detDiv.textContent = JSON.stringify(item.details, null, 2);
          card.appendChild(detDiv);
        }

        timelineEl.appendChild(card);
      });
    }
  } catch (err) {
    if (timelineEl) {
      timelineEl.replaceChildren(createStateCard('common.error', getSafeErrorMessage(err, 'Failed to load diagnostics.'), true));
    }
  }
}

/**
 * ==========================================================================
 * MODEL RESOLUTION PREVIEW & HEALTH CIRCUIT BREAKERS
 * ==========================================================================
 */

async function renderEffectiveModelPreview(container, spaceId, sessionId) {
  const previewCard = document.createElement('div');
  previewCard.className = 'card-panel mb-3';

  const title = document.createElement('h4');
  title.textContent = t('models.effectiveResolutionTitle', null, 'Effective Model Resolution Preview');
  previewCard.appendChild(title);

  try {
    const params = new URLSearchParams();
    if (spaceId) params.append('spaceId', spaceId);
    if (sessionId) params.append('sessionId', sessionId);
    const res = await apiRequest(`/api/models/effective?${params.toString()}`);
    const eff = res && res.data;

    if (!eff) {
      previewCard.appendChild(createStateCard('models.unavailableTitle', 'models.unavailableDesc'));
      container.appendChild(previewCard);
      return;
    }

    const flowDiv = document.createElement('div');
    flowDiv.className = 'fallback-chain-flow mb-2';

    const sourceBadge = createBadgeElement(t(`models.scope${eff.source ? eff.source.charAt(0).toUpperCase() + eff.source.slice(1) : 'Platform'}`, null, `Layer: ${eff.source || 'platform'}`), 'info');
    flowDiv.appendChild(sourceBadge);

    const primaryNode = document.createElement('span');
    primaryNode.className = 'fallback-node';
    primaryNode.textContent = `${eff.provider} / ${eff.model}${eff.reasoningEffort ? ` (${eff.reasoningEffort})` : ''}`;
    flowDiv.appendChild(primaryNode);

    if (Array.isArray(eff.fallbackChain) && eff.fallbackChain.length > 0) {
      eff.fallbackChain.forEach((fb) => {
        const arrow = document.createElement('span');
        arrow.className = 'fallback-arrow';
        arrow.textContent = '➔';
        flowDiv.appendChild(arrow);

        const fbNode = document.createElement('span');
        fbNode.className = 'fallback-node';
        fbNode.textContent = `${fb.provider} / ${fb.model}${fb.reasoningEffort ? ` (${fb.reasoningEffort})` : ''}`;
        flowDiv.appendChild(fbNode);
      });
    }

    previewCard.appendChild(flowDiv);

    // Update Chat Header Model Badge if in chat session context
    const headerModelBadge = document.getElementById('session-model-badge');
    if (headerModelBadge) {
      headerModelBadge.textContent = `⚡ ${eff.model}`;
      headerModelBadge.classList.remove('hidden');
    }
  } catch (err) {
    // Non-fatal preview
  }

  container.appendChild(previewCard);
}

function renderModelHealthTable(container, healthSummaries, discoveredProviders, isAdmin = false) {
  const section = document.createElement('div');
  section.className = 'management-section';

  const sHead = document.createElement('div');
  sHead.className = 'section-header';
  const h3 = document.createElement('h3');
  h3.textContent = t('models.healthSectionTitle', null, 'Model Health & Circuit Breakers');
  sHead.appendChild(h3);

  if (isAdmin) {
    const btnResetAll = document.createElement('button');
    btnResetAll.type = 'button';
    btnResetAll.className = 'btn btn-secondary btn-sm';
    btnResetAll.textContent = t('models.btnResetBreaker', null, 'Reset Circuit Breakers');
    btnResetAll.addEventListener('click', async () => {
      try {
        btnResetAll.disabled = true;
        btnResetAll.textContent = t('models.btnResetBreakerRunning', null, 'Resetting...');
        const res = await apiRequest('/api/admin/models/circuit-breaker/reset', {
          method: 'POST',
          body: {},
        });
        showToast(t('models.circuitResetSuccess', { count: (res && res.data && res.data.count) || 0 }, 'Circuit breakers reset successfully.'), 'success');
        renderManagementView(state.currentRoute);
      } catch (err) {
        showToast(getSafeErrorMessage(err, 'Failed to reset circuit breakers.'), 'error');
      } finally {
        btnResetAll.disabled = false;
        btnResetAll.textContent = t('models.btnResetBreaker', null, 'Reset Circuit Breakers');
      }
    });
    sHead.appendChild(btnResetAll);
  }

  section.appendChild(sHead);

  const tableContainer = document.createElement('div');
  tableContainer.className = 'data-table-container';
  const table = document.createElement('table');
  table.className = 'data-table';

  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');
  const cols = ['Provider', 'Model', 'Circuit State', 'Avg Latency', 'Failures', 'Last Success', 'Actions'];
  cols.forEach((col) => {
    const th = document.createElement('th');
    th.textContent = col;
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const summaries = Array.isArray(healthSummaries) ? healthSummaries : [];

  summaries.forEach((hs) => {
    const tr = document.createElement('tr');

    const tdProv = document.createElement('td');
    tdProv.className = 'mono-cell';
    tdProv.textContent = hs.provider || '-';
    tr.appendChild(tdProv);

    const tdModel = document.createElement('td');
    tdModel.className = 'mono-cell';
    tdModel.textContent = hs.model || '-';
    tr.appendChild(tdModel);

    // Circuit state badge with dot indicator
    const tdCircuit = document.createElement('td');
    const cState = hs.circuitState || hs.state || 'closed';
    const cWrap = document.createElement('div');
    cWrap.className = `circuit-state-badge circuit-${cState}`;
    const dot = document.createElement('span');
    dot.className = 'circuit-dot';
    const label = document.createElement('span');
    label.textContent = t(`models.circuit${cState === 'closed' ? 'Closed' : (cState === 'open' ? 'Open' : 'HalfOpen')}`, null, cState);
    cWrap.appendChild(dot);
    cWrap.appendChild(label);
    tdCircuit.appendChild(cWrap);
    tr.appendChild(tdCircuit);

    const tdLat = document.createElement('td');
    tdLat.textContent = hs.avgLatencyMs ? `${hs.avgLatencyMs}ms` : (hs.latencyMs ? `${hs.latencyMs}ms` : '-');
    tr.appendChild(tdLat);

    const tdFail = document.createElement('td');
    tdFail.textContent = String(hs.failuresCount || hs.failures || 0);
    tr.appendChild(tdFail);

    const tdSuccess = document.createElement('td');
    tdSuccess.textContent = hs.lastSuccess ? formatDate(hs.lastSuccess) : '-';
    tr.appendChild(tdSuccess);

    const tdActions = document.createElement('td');
    tdActions.className = 'file-actions-cell';

    if (isAdmin) {
      const btnProbe = document.createElement('button');
      btnProbe.type = 'button';
      btnProbe.className = 'btn btn-secondary btn-xs';
      btnProbe.textContent = t('models.btnProbe', null, 'Probe Health');
      btnProbe.addEventListener('click', async () => {
        try {
          btnProbe.disabled = true;
          btnProbe.textContent = t('models.btnProbeRunning', null, 'Probing...');
          const pRes = await apiRequest('/api/admin/models/probe', {
            method: 'POST',
            body: { provider: hs.provider, model: hs.model },
          });
          const pData = pRes && pRes.data;
          showToast(t('models.probeSuccess', { latency: pData.latencyMs || 0, tokens: pData.tokens || 0 }, `Probe succeeded (${pData.latencyMs || 0}ms)`), 'success');
          renderManagementView(state.currentRoute);
        } catch (err) {
          showToast(getSafeErrorMessage(err, 'Probe failed.'), 'error');
        } finally {
          btnProbe.disabled = false;
          btnProbe.textContent = t('models.btnProbe', null, 'Probe Health');
        }
      });
      tdActions.appendChild(btnProbe);
    }

    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  tableContainer.appendChild(table);
  section.appendChild(tableContainer);
  container.appendChild(section);
}

// Agent Profile Versions Modal Inspector (GET /api/manage/agent-profiles/:id/versions, POST /api/manage/agent-profiles/:id/rollback)
async function openProfileVersionsModal(profileId, profileName, activeVersion) {
  const modal = document.getElementById('modal-profile-versions');
  const titleEl = document.getElementById('profile-versions-modal-title');
  const contentEl = document.getElementById('profile-versions-content');
  if (!modal || !contentEl) return;

  if (titleEl) {
    titleEl.textContent = getLocale() === 'zh-CN' ? `画像版本历史: ${profileName || profileId}` : `Versions for: ${profileName || profileId}`;
  }

  contentEl.replaceChildren(createSkeletonLoader());
  openModal('modal-profile-versions');

  try {
    const res = await apiRequest(`/api/manage/agent-profiles/${profileId}/versions`);
    const raw = res && res.data;
    const versions = (raw && Array.isArray(raw.items))
      ? raw.items
      : (Array.isArray(raw) ? raw : null);

    contentEl.replaceChildren();

    if (!versions) {
      contentEl.appendChild(createStateCard('profiles.versionsUnavailableTitle', 'profiles.versionsUnavailableDesc', true));
      return;
    }

    if (versions.length === 0) {
      contentEl.appendChild(createStateCard('profiles.noVersionsTitle', 'profiles.noVersionsDesc'));
      return;
    }

    const versionNumbers = versions.map((v) => (typeof v.version === 'number' ? v.version : 0));
    const maxVersion = versionNumbers.length > 0 ? Math.max(...versionNumbers) : 1;
    const currentActiveVersion = typeof activeVersion === 'number' ? activeVersion : maxVersion;

    versions.forEach((v) => {
      if (!v || typeof v !== 'object') {
        const errCard = document.createElement('div');
        errCard.className = 'state-card';
        const errP = document.createElement('p');
        errP.className = 'text-muted';
        errP.textContent = t('common.invalidRecord', null, getLocale() === 'zh-CN' ? '无效记录' : 'Invalid record');
        errCard.appendChild(errP);
        contentEl.appendChild(errCard);
        return;
      }

      const card = document.createElement('div');
      card.className = 'generation-card';

      const cHeader = document.createElement('div');
      cHeader.className = 'generation-card-header';

      const hLeft = document.createElement('div');
      hLeft.className = 'flex-row-center';

      const vBadge = document.createElement('span');
      vBadge.className = 'badge badge-generation';
      const verNum = v.version !== undefined ? v.version : (v.activeVersion !== undefined ? v.activeVersion : '1');
      vBadge.textContent = t('profiles.versionBadge', { number: verNum }, `Version ${verNum}`);
      hLeft.appendChild(vBadge);

      const isActive = Number(verNum) === currentActiveVersion;
      if (isActive) {
        const activeBadge = document.createElement('span');
        activeBadge.className = 'badge badge-success';
        activeBadge.textContent = t('profiles.statusActiveVersion', null, 'Active');
        hLeft.appendChild(activeBadge);
      }

      const timeSpan = document.createElement('span');
      timeSpan.className = 'text-muted';
      timeSpan.textContent = v.createdAt ? formatDate(v.createdAt) : '';
      hLeft.appendChild(timeSpan);

      cHeader.appendChild(hLeft);

      // Rollback Button for non-active versions
      if (!isActive) {
        const btnRollback = document.createElement('button');
        btnRollback.type = 'button';
        btnRollback.className = 'btn btn-secondary btn-xs btn-profile-rollback';
        btnRollback.textContent = t('profiles.btnRollback', null, 'Rollback');
        btnRollback.setAttribute('data-target-version', String(verNum));

        btnRollback.addEventListener('click', () => {
          const confirmTitle = t('profiles.confirmRollbackTitle', null, 'Confirm Profile Version Rollback');
          const confirmMsg = t('profiles.confirmRollbackMessage', { targetVersion: verNum }, `Rolling back to Version ${verNum} will create a new Version (N+1) with this snapshot configuration. Existing sessions will not be modified automatically; you must perform 'Reset Generation' on sessions to apply the new profile version. Are you sure you want to proceed?`);

          showConfirmation(confirmTitle, confirmMsg, async () => {
            try {
              btnRollback.disabled = true;
              btnRollback.textContent = t('profiles.rollingBack', null, 'Rolling back...');

              if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
                showToast(t('toast.cryptoUnavailable', null, 'Cryptographic context unavailable. Cannot generate Idempotency-Key.'), 'error');
                return;
              }
              const idempotencyKey = crypto.randomUUID();

              const rollbackRes = await apiRequest(`/api/manage/agent-profiles/${encodeURIComponent(profileId)}/rollback`, {
                method: 'POST',
                headers: {
                  'Idempotency-Key': idempotencyKey,
                },
                body: {
                  targetVersion: Number(verNum),
                  changeSummary: getLocale() === 'zh-CN' ? `回滚至 v${verNum}` : `Rollback to v${verNum}`,
                },
              });

              const rolledBack = rollbackRes && rollbackRes.data;
              const newVer = rolledBack?.version ?? rolledBack?.newVersion ?? (currentActiveVersion + 1);
              showToast(
                t('profiles.rollbackSuccess', { version: newVer }, `Profile rolled back successfully. Created new active Version v${newVer}.`),
                'success'
              );

              // Refresh modal and profile view with new active version
              await openProfileVersionsModal(profileId, profileName, newVer);
              const currentHash = window.location.hash.slice(1);
              if (currentHash.includes('profiles')) {
                await renderManagementView(currentHash);
              }
            } catch (err) {
              showToast(getSafeErrorMessage(err, t('profiles.rollbackFailed', { error: err?.message || 'Unknown error' }, 'Failed to rollback profile version.')), 'error');
            } finally {
              btnRollback.disabled = false;
              btnRollback.textContent = t('profiles.btnRollback', null, 'Rollback');
            }
          });
        });

        cHeader.appendChild(btnRollback);
      }

      card.appendChild(cHeader);

      if (v.changeSummary) {
        const summaryP = document.createElement('p');
        summaryP.className = 'text-muted';
        summaryP.textContent = `${getLocale() === 'zh-CN' ? '变更摘要: ' : 'Changes: '}${v.changeSummary}`;
        card.appendChild(summaryP);
      }

      // Render the 4 prompt sections if present
      const sectionsGrid = document.createElement('div');
      sectionsGrid.className = 'form-row grid-2-col';

      const sections = [
        { label: getLocale() === 'zh-CN' ? '1. 人设定义 (Identity)' : 'Identity', text: v.identity },
        { label: getLocale() === 'zh-CN' ? '2. 行为准则 (Soul / Rules)' : 'Soul / Rules', text: v.soul },
        { label: getLocale() === 'zh-CN' ? '3. 委托路由 (Agents / Routing)' : 'Agents / Routing', text: v.agents },
        { label: getLocale() === 'zh-CN' ? '4. 工具权限 (Tools)' : 'Tools', text: v.tools },
      ];

      sections.forEach((sec) => {
        const secCard = document.createElement('div');
        secCard.className = 'profile-section-card';
        const sHead = document.createElement('div');
        sHead.className = 'profile-section-header';
        sHead.textContent = sec.label;
        secCard.appendChild(sHead);

        const sBody = document.createElement('div');
        sBody.className = 'profile-section-content';
        sBody.textContent = sec.text || t('common.empty', null, '(empty)');
        secCard.appendChild(sBody);

        sectionsGrid.appendChild(secCard);
      });

      card.appendChild(sectionsGrid);
      contentEl.appendChild(card);
    });
  } catch (err) {
    contentEl.replaceChildren(
      createStateCard('profiles.versionsUnavailableTitle', 'profiles.versionsUnavailableDesc', true)
    );
  }
}

function openCreateProfileVersionModal(profileId, profileName) {
  const hiddenInput = document.getElementById('version-target-profile-id');
  const titleEl = document.getElementById('create-version-modal-title');
  if (hiddenInput) hiddenInput.value = profileId;
  if (titleEl) titleEl.textContent = getLocale() === 'zh-CN' ? `发布画像新版本: ${profileName || profileId}` : `Create Profile Version: ${profileName || profileId}`;

  const form = document.getElementById('create-profile-version-form');
  if (form) form.reset();

  openModal('modal-create-profile-version');
}

// 2.9 Channels View (GET/POST/DELETE /api/manage/channels/accounts & bindings)
window.channelOnboardingController = {
  epoch: 0,
  active: false,
  currentJobId: null,
  currentStatus: null,
  activePollInterval: null,
  countdownTimer: null,
  cleanup: async function () {
    this.epoch = (this.epoch || 0) + 1;
    this.active = false;
    if (this.activePollInterval) {
      clearInterval(this.activePollInterval);
      this.activePollInterval = null;
    }
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    const jobId = this.currentJobId;
    const status = this.currentStatus;
    this.currentJobId = null;
    this.currentStatus = null;

    // cleanup仅waiting/configuring/verifying状态cancel；ready/awaiting_approval关闭不发cancel已提交任务（只本地stop）
    const cancellableStatuses = ['waiting_for_scan', 'configuring', 'verifying', 'waiting', 'pending'];
    if (jobId && status && cancellableStatuses.includes(status)) {
      try {
        await apiRequest(`/api/manage/channels/onboarding/jobs/${encodeURIComponent(jobId)}/cancel`, {
          method: 'POST',
        });
      } catch {}
    }
  },
};

function openChannelOnboardingModal(action, accounts = [], spaces = [], initialAccountId = null) {
  if (window.channelOnboardingController) {
    window.channelOnboardingController.cleanup();
    window.channelOnboardingController.epoch = (window.channelOnboardingController.epoch || 0) + 1;
    window.channelOnboardingController.active = true;
    window.channelOnboardingController.currentJobId = null;
    window.channelOnboardingController.currentStatus = null;
  }

  const modalBody = document.getElementById('channel-onboarding-modal-body');
  if (!modalBody) return;
  modalBody.replaceChildren();

  const titleEl = document.getElementById('channel-onboarding-modal-title');
  if (titleEl) {
    titleEl.textContent = action === 'create_new'
      ? (getLocale() === 'zh-CN' ? '新建机器人' : 'Create New Bot')
      : (getLocale() === 'zh-CN' ? '配置已有机器人' : 'Configure Existing Bot');
  }

  const renderStep1 = () => {
    modalBody.replaceChildren();

    const stepHeader = document.createElement('h4');
    stepHeader.className = 'channel-step-subtitle';
    stepHeader.textContent = getLocale() === 'zh-CN' ? '1. 选择机器人与默认工作区' : '1. Select Bot & Default Workspace';
    modalBody.appendChild(stepHeader);

    const form = document.createElement('form');
    form.className = 'channel-onboarding-modal-form';

    let appIdInput = null;
    let appNameInput = null;
    let accSelect = null;

    if (action === 'configure_existing') {
      const larkAccounts = accounts.filter((a) => a.type === 'lark');
      if (larkAccounts.length > 0) {
        const accGroup = document.createElement('div');
        accGroup.className = 'form-group';
        const accLabel = document.createElement('label');
        accLabel.textContent = getLocale() === 'zh-CN' ? '选择机器人' : 'Choose bot';
        accLabel.htmlFor = 'channel-modal-bot-select';
        accSelect = document.createElement('select');
        accSelect.id = 'channel-modal-bot-select';
        accSelect.className = 'form-select channel-modal-bot-select';

        const manualOpt = document.createElement('option');
        manualOpt.value = '';
        manualOpt.textContent = getLocale() === 'zh-CN' ? '-- 输入其他已有应用 App ID --' : '-- Enter other App ID --';
        accSelect.appendChild(manualOpt);

        larkAccounts.forEach((a) => {
          const opt = document.createElement('option');
          opt.value = a.id;
          const match = a.credentialRef ? a.credentialRef.match(/cli_[a-zA-Z0-9]+/) : null;
          const appSuffix = match ? ` (...${match[0].slice(-6)})` : ` (${a.id.slice(-6)})`;
          opt.textContent = `${a.name || (getLocale() === 'zh-CN' ? '飞书账号' : 'Feishu Account')}${appSuffix}`;
          accSelect.appendChild(opt);
        });

        accGroup.appendChild(accLabel);
        accGroup.appendChild(accSelect);
        form.appendChild(accGroup);
      }

      const appGroup = document.createElement('div');
      appGroup.className = 'form-group';
      const appLabel = document.createElement('label');
      appLabel.textContent = getLocale() === 'zh-CN' ? '已有应用 App ID (cli_*) *' : 'Existing App ID (cli_*) *';
      appLabel.htmlFor = 'channel-modal-appid-input';
      appIdInput = document.createElement('input');
      appIdInput.id = 'channel-modal-appid-input';
      appIdInput.type = 'text';
      appIdInput.className = 'form-input';
      appIdInput.placeholder = 'cli_xxxxxxxxxxxxxxxx';
      appIdInput.required = true;
      appGroup.appendChild(appLabel);
      appGroup.appendChild(appIdInput);
      form.appendChild(appGroup);
    } else {
      const nameGroup = document.createElement('div');
      nameGroup.className = 'form-group';
      const nameLabel = document.createElement('label');
      nameLabel.textContent = getLocale() === 'zh-CN' ? '机器人名称 (可选)' : 'Bot Name (optional)';
      nameLabel.htmlFor = 'channel-modal-appname-input';
      appNameInput = document.createElement('input');
      appNameInput.id = 'channel-modal-appname-input';
      appNameInput.type = 'text';
      appNameInput.className = 'form-input';
      appNameInput.placeholder = getLocale() === 'zh-CN' ? '飞书机器人' : 'Enkeep Bot';
      nameGroup.appendChild(nameLabel);
      nameGroup.appendChild(appNameInput);
      form.appendChild(nameGroup);
    }

    // Default workspace selector (pure workspace name, NO UUIDs in text!)
    const spaceGroup = document.createElement('div');
    spaceGroup.className = 'form-group';
    const spaceLabel = document.createElement('label');
    spaceLabel.textContent = getLocale() === 'zh-CN' ? '默认工作区 *' : 'Default workspace *';
    spaceLabel.htmlFor = 'channel-modal-space-select';
    const spaceHint = document.createElement('small');
    spaceHint.className = 'form-hint form-text-muted';
    spaceHint.textContent = getLocale() === 'zh-CN'
      ? '新聊天默认进入此工作区，已有聊天绑定不受影响。'
      : 'New chats default to this workspace; existing chat bindings are unaffected.';
    const spaceSelect = document.createElement('select');
    spaceSelect.id = 'channel-modal-space-select';
    spaceSelect.className = 'form-select';
    spaceSelect.required = true;

    const emptySpaceOpt = document.createElement('option');
    emptySpaceOpt.value = '';
    emptySpaceOpt.textContent = getLocale() === 'zh-CN' ? '-- 请选择默认工作区 --' : '-- Select default workspace --';
    spaceSelect.appendChild(emptySpaceOpt);

    spaces.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name || s.folder || s.id;
      spaceSelect.appendChild(opt);
    });

    spaceGroup.appendChild(spaceLabel);
    spaceGroup.appendChild(spaceHint);
    spaceGroup.appendChild(spaceSelect);
    form.appendChild(spaceGroup);

    // Existing bot pre-selection logic
    if (action === 'configure_existing') {
      const larkAccounts = accounts.filter((a) => a.type === 'lark');
      const updateSelectedBot = (acc) => {
        if (acc) {
          const match = acc.credentialRef ? acc.credentialRef.match(/cli_[a-zA-Z0-9]+/) : null;
          if (appIdInput) appIdInput.value = match ? match[0] : '';
          if (spaceSelect) {
            if (acc.defaultSpaceId && spaces.some((s) => s.id === acc.defaultSpaceId)) {
              spaceSelect.value = acc.defaultSpaceId;
            } else {
              spaceSelect.value = '';
            }
          }
        } else {
          if (appIdInput) appIdInput.value = '';
          if (spaceSelect) spaceSelect.value = '';
        }
      };

      if (accSelect) {
        let defaultAcc = null;
        if (initialAccountId) {
          defaultAcc = larkAccounts.find((a) => a.id === initialAccountId);
        }
        if (!defaultAcc) {
          defaultAcc = larkAccounts.find((a) => a.credentialRef && /cli_[a-zA-Z0-9]+/.test(a.credentialRef));
        }
        if (!defaultAcc && larkAccounts.length > 0) {
          defaultAcc = larkAccounts[0];
        }

        if (defaultAcc) {
          accSelect.value = defaultAcc.id;
          updateSelectedBot(defaultAcc);
        } else {
          accSelect.value = '';
          updateSelectedBot(null);
        }

        accSelect.addEventListener('change', () => {
          if (accSelect.value) {
            const acc = larkAccounts.find((a) => a.id === accSelect.value);
            updateSelectedBot(acc || null);
          } else {
            updateSelectedBot(null);
          }
        });
      } else if (larkAccounts.length === 0 && spaces.length > 0) {
        spaceSelect.value = spaces[0].id;
      }
    }

    // Modal action buttons
    const actionsRow = document.createElement('div');
    actionsRow.className = 'modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = getLocale() === 'zh-CN' ? '取消' : 'Cancel';
    cancelBtn.addEventListener('click', () => {
      closeModal('modal-channel-onboarding');
    });

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'btn btn-primary';
    submitBtn.textContent = getLocale() === 'zh-CN' ? '下一步：扫码授权' : 'Next: Scan QR';

    actionsRow.appendChild(cancelBtn);
    actionsRow.appendChild(submitBtn);
    form.appendChild(actionsRow);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      submitBtn.textContent = getLocale() === 'zh-CN' ? '正在生成二维码...' : 'Generating QR...';

      const currentEpoch = window.channelOnboardingController.epoch;

      try {
        const payload = {
          action,
          spaceId: spaceSelect.value ? spaceSelect.value : undefined,
          accountId: accSelect && accSelect.value ? accSelect.value : undefined,
          appId: appIdInput ? appIdInput.value.trim() : undefined,
          appName: appNameInput ? appNameInput.value.trim() : undefined,
        };

        const res = await apiRequest('/api/manage/channels/onboarding/jobs', {
          method: 'POST',
          body: JSON.stringify(payload),
        });

        const modalEl = document.getElementById('modal-channel-onboarding');
        const isModalVisible = modalEl && !modalEl.classList.contains('hidden');

        // Check controller active, epoch, and modal visibility
        if (
          !window.channelOnboardingController.active ||
          window.channelOnboardingController.epoch !== currentEpoch ||
          !isModalVisible
        ) {
          // Closed while POST was in flight -> cancel created job immediately, do NOT render/poll
          const job = res && res.data;
          if (job && job.id) {
            const jobStatus = job.status || 'waiting_for_scan';
            const cancellableStatuses = ['waiting_for_scan', 'configuring', 'verifying', 'waiting', 'pending'];
            if (cancellableStatuses.includes(jobStatus)) {
              try {
                await apiRequest(`/api/manage/channels/onboarding/jobs/${encodeURIComponent(job.id)}/cancel`, {
                  method: 'POST',
                });
              } catch {}
            }
          }
          return;
        }

        const job = res.data;
        renderStep2(job, currentEpoch);
      } catch (err) {
        const modalEl = document.getElementById('modal-channel-onboarding');
        const isModalVisible = modalEl && !modalEl.classList.contains('hidden');
        if (!window.channelOnboardingController.active || window.channelOnboardingController.epoch !== currentEpoch || !isModalVisible) {
          return;
        }
        showToast(err.message || 'Failed to start onboarding', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = getLocale() === 'zh-CN' ? '下一步：扫码授权' : 'Next: Scan QR';
      }
    });

    modalBody.appendChild(form);
  };

  const renderStep2 = (initialJob, stepEpoch) => {
    const modalEl = document.getElementById('modal-channel-onboarding');
    if (!modalEl || modalEl.classList.contains('hidden')) return;
    if (!window.channelOnboardingController.active || window.channelOnboardingController.epoch !== stepEpoch) return;

    let currentJob = initialJob;
    window.channelOnboardingController.currentJobId = currentJob.id;
    window.channelOnboardingController.currentStatus = currentJob.status;
    modalBody.replaceChildren();

    const stepHeader = document.createElement('h4');
    stepHeader.className = 'channel-step-subtitle';
    stepHeader.textContent = getLocale() === 'zh-CN' ? '2. 请用飞书App扫一扫，并在手机确认' : '2. Please scan with Feishu App and confirm on mobile';
    modalBody.appendChild(stepHeader);

    const qrBox = document.createElement('div');
    qrBox.className = 'channel-qr-box';

    const qrCanvas = document.createElement('div');
    qrCanvas.className = 'channel-qr-canvas';

    const qrMediaWrap = document.createElement('div');
    qrMediaWrap.className = 'channel-qr-media-wrap';
    qrCanvas.appendChild(qrMediaWrap);

    const updateQrDisplay = () => {
      qrMediaWrap.replaceChildren();
      if (currentJob.status !== 'waiting_for_scan') {
        return;
      }
      if (currentJob.qrSvg) {
        try {
          const parser = new DOMParser();
          const doc = parser.parseFromString(currentJob.qrSvg, 'image/svg+xml');
          const svgEl = doc.querySelector('svg');
          if (svgEl) {
            svgEl.setAttribute('width', '240');
            svgEl.setAttribute('height', '240');
            const imported = document.importNode(svgEl, true);
            qrMediaWrap.appendChild(imported);
          }
        } catch {}
      } else if (currentJob.qrDataUrl) {
        const qrImg = document.createElement('img');
        qrImg.src = currentJob.qrDataUrl;
        qrImg.alt = 'Feishu QR Code';
        qrImg.setAttribute('width', '240');
        qrImg.setAttribute('height', '240');
        qrMediaWrap.appendChild(qrImg);
      }
    };
    updateQrDisplay();

    const qrPrompt = document.createElement('div');
    qrPrompt.className = 'channel-qr-prompt';
    qrPrompt.textContent = getLocale() === 'zh-CN' ? '请用飞书App扫一扫，并在手机确认' : 'Please scan with Feishu App and confirm on mobile';
    qrCanvas.appendChild(qrPrompt);

    const countdownSpan = document.createElement('div');
    countdownSpan.className = 'channel-countdown-span form-text-muted';
    qrCanvas.appendChild(countdownSpan);

    const diagSpan = document.createElement('div');
    diagSpan.className = 'channel-diag-span form-text-muted';
    qrCanvas.appendChild(diagSpan);

    if (currentJob.qrUrl && /^https:\/\/(accounts|ask|open)\.feishu\.cn\//i.test(currentJob.qrUrl)) {
      const link = document.createElement('a');
      link.href = currentJob.qrUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.className = 'channel-official-link';
      link.textContent = getLocale() === 'zh-CN' ? '👉 点击在浏览器打开官方授权链接' : '👉 Click to Open Official Authorization Link';
      qrCanvas.appendChild(link);
    }
    qrBox.appendChild(qrCanvas);

    const clearQrDisplay = () => {
      qrMediaWrap.replaceChildren();
      qrPrompt.classList.add('hidden');
      countdownSpan.textContent = '';
      if (window.channelOnboardingController.countdownTimer) {
        clearInterval(window.channelOnboardingController.countdownTimer);
        window.channelOnboardingController.countdownTimer = null;
      }
    };

    const updateCountdown = () => {
      if (!currentJob.expiresAt) return;
      const expireTime = new Date(currentJob.expiresAt).getTime();
      const remainMs = expireTime - Date.now();
      if (remainMs <= 0) {
        countdownSpan.textContent = getLocale() === 'zh-CN' ? '二维码已失效' : 'QR code expired';
        clearQrDisplay();
        if (window.channelOnboardingController.activePollInterval) {
          clearInterval(window.channelOnboardingController.activePollInterval);
          window.channelOnboardingController.activePollInterval = null;
        }
        if (window.channelOnboardingController.countdownTimer) {
          clearInterval(window.channelOnboardingController.countdownTimer);
          window.channelOnboardingController.countdownTimer = null;
        }
        const waitingJobId = currentJob.id;
        const waitingStatus = currentJob.status || window.channelOnboardingController.currentStatus;
        if (waitingStatus === 'waiting_for_scan' || waitingStatus === 'waiting') {
          try {
            apiRequest(`/api/manage/channels/onboarding/jobs/${encodeURIComponent(waitingJobId)}/cancel`, {
              method: 'POST',
            }).catch(() => {});
          } catch {}
        }
        currentJob.status = 'expired';
        window.channelOnboardingController.currentStatus = 'expired';
        renderStatus('expired', getLocale() === 'zh-CN' ? '二维码已失效，请重新生成' : 'QR code expired, please retry');
        retryBtn.classList.remove('hidden');
        cancelBtn.textContent = getLocale() === 'zh-CN' ? '关闭' : 'Close';
        return;
      }
      const totalSec = Math.floor(remainMs / 1000);
      const mins = Math.floor(totalSec / 60);
      const secs = totalSec % 60;
      const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
      countdownSpan.textContent = getLocale() === 'zh-CN' ? `二维码有效时间：${timeStr}` : `QR valid for: ${timeStr}`;
    };
    updateCountdown();
    window.channelOnboardingController.countdownTimer = setInterval(updateCountdown, 1000);

    // Status row with role=status and aria-live for accessibility
    const statusRow = document.createElement('div');
    statusRow.className = 'channel-status-badge-row';
    statusRow.setAttribute('role', 'status');
    statusRow.setAttribute('aria-live', 'polite');

    const badge = createBadgeElement(currentJob.status, 'warning');
    const msgSpan = document.createElement('span');
    msgSpan.className = 'channel-status-msg';
    msgSpan.textContent = currentJob.statusMessage || currentJob.status;
    statusRow.appendChild(badge);
    statusRow.appendChild(msgSpan);
    qrBox.appendChild(statusRow);

    const alertBox = document.createElement('div');
    alertBox.className = 'channel-alert-box hidden';
    qrBox.appendChild(alertBox);

    const renderStatus = (newStatus, customMessage) => {
      badge.replaceWith(createBadgeElement(
        newStatus,
        newStatus === 'ready' ? 'success' : (newStatus === 'failed' || newStatus === 'expired' || newStatus === 'cancelled' || newStatus === 'error' ? 'error' : (newStatus === 'configuring' || newStatus === 'verifying' ? 'primary' : 'warning'))
      ));
      if (customMessage) {
        msgSpan.textContent = customMessage;
      }
    };

    // Actions row
    const actRow = document.createElement('div');
    actRow.className = 'modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = getLocale() === 'zh-CN' ? '取消任务' : 'Cancel Job';
    cancelBtn.addEventListener('click', async () => {
      await window.channelOnboardingController.cleanup();
      closeModal('modal-channel-onboarding');
      await renderManagementView('management/workspaces/channels');
    });

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'btn btn-primary hidden';
    retryBtn.textContent = getLocale() === 'zh-CN' ? '重新生成二维码' : 'Retry';
    retryBtn.addEventListener('click', () => {
      renderStep1();
    });

    const checkApprovalBtn = document.createElement('button');
    checkApprovalBtn.type = 'button';
    checkApprovalBtn.className = 'btn btn-secondary hidden';
    checkApprovalBtn.textContent = getLocale() === 'zh-CN' ? '检查审批状态' : 'Check Approval Status';
    checkApprovalBtn.addEventListener('click', async () => {
      checkApprovalBtn.disabled = true;
      try {
        const res = await apiRequest(`/api/manage/channels/onboarding/jobs/${encodeURIComponent(currentJob.id)}`);
        if (res && res.data) {
          currentJob = res.data;
          window.channelOnboardingController.currentStatus = currentJob.status;
          msgSpan.textContent = currentJob.statusMessage || currentJob.status;
          if (currentJob.status === 'ready') {
            showToast(getLocale() === 'zh-CN' ? '审批已通过，渠道已就绪！' : 'Approved and channel ready!', 'success');
            await renderManagementView('management/workspaces/channels');
          } else {
            showToast(getLocale() === 'zh-CN' ? '当前仍在审批中' : 'Still awaiting approval', 'info');
          }
        }
      } catch (e) {
        showToast(e.message || 'Check failed', 'error');
      } finally {
        checkApprovalBtn.disabled = false;
      }
    });

    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'btn btn-primary hidden';
    doneBtn.textContent = getLocale() === 'zh-CN' ? '完成' : 'Done';
    doneBtn.addEventListener('click', async () => {
      await window.channelOnboardingController.cleanup();
      closeModal('modal-channel-onboarding');
      await renderManagementView('management/workspaces/channels');
    });

    actRow.appendChild(cancelBtn);
    actRow.appendChild(retryBtn);
    actRow.appendChild(checkApprovalBtn);
    actRow.appendChild(doneBtn);
    qrBox.appendChild(actRow);
    modalBody.appendChild(qrBox);

    // Poller
    let isPolling = false;
    window.channelOnboardingController.activePollInterval = setInterval(async () => {
      const modal = document.getElementById('modal-channel-onboarding');
      if (
        !window.channelOnboardingController.active ||
        window.channelOnboardingController.epoch !== stepEpoch ||
        !modal ||
        modal.classList.contains('hidden')
      ) {
        if (window.channelOnboardingController.activePollInterval) {
          clearInterval(window.channelOnboardingController.activePollInterval);
          window.channelOnboardingController.activePollInterval = null;
        }
        return;
      }

      if (isPolling) return;
      isPolling = true;
      try {
        const res = await apiRequest(`/api/manage/channels/onboarding/jobs/${encodeURIComponent(currentJob.id)}`);

        const modalAfter = document.getElementById('modal-channel-onboarding');
        if (
          !window.channelOnboardingController.active ||
          window.channelOnboardingController.epoch !== stepEpoch ||
          !modalAfter ||
          modalAfter.classList.contains('hidden') ||
          window.channelOnboardingController.currentJobId !== currentJob.id
        ) {
          return;
        }

        if (res && res.data) {
          currentJob = res.data;
          window.channelOnboardingController.currentStatus = currentJob.status;
          msgSpan.textContent = currentJob.statusMessage || currentJob.status;

          if (currentJob.lastPollAt) {
            diagSpan.textContent = `[${getLocale() === 'zh-CN' ? '最后核验' : 'Last poll'}: ${new Date(currentJob.lastPollAt).toLocaleTimeString()}]`;
          }

          if (currentJob.status === 'awaiting_approval') {
            clearQrDisplay();
            renderStatus('awaiting_approval', currentJob.statusMessage);
            alertBox.className = 'channel-approval-alert';
            alertBox.textContent = getLocale() === 'zh-CN'
              ? '应用权限及版本已提交，尚未确认生效。应用需企业管理员在飞书管理后台审批。'
              : 'Submitted for review, pending admin approval in Feishu Admin Console.';
            cancelBtn.classList.remove('hidden');
            checkApprovalBtn.classList.remove('hidden');
            doneBtn.classList.remove('hidden');
          } else if (currentJob.status === 'ready') {
            clearQrDisplay();
            renderStatus('ready', currentJob.statusMessage);
            alertBox.className = 'alert alert-success';
            alertBox.textContent = getLocale() === 'zh-CN'
              ? '飞书机器人配置完成！渠道已连接并正常运行。'
              : 'Feishu Bot onboarding successful! Channel connected and ready.';
            cancelBtn.classList.add('hidden');
            retryBtn.classList.add('hidden');
            checkApprovalBtn.classList.add('hidden');
            doneBtn.classList.remove('hidden');
            if (window.channelOnboardingController.activePollInterval) {
              clearInterval(window.channelOnboardingController.activePollInterval);
              window.channelOnboardingController.activePollInterval = null;
            }
          } else if (currentJob.status === 'failed' || currentJob.status === 'expired' || currentJob.status === 'cancelled') {
            clearQrDisplay();
            renderStatus(currentJob.status, currentJob.error || currentJob.statusMessage || 'Onboarding failed');
            alertBox.className = 'alert alert-danger';
            alertBox.textContent = currentJob.error || currentJob.statusMessage || 'Onboarding failed';
            cancelBtn.textContent = getLocale() === 'zh-CN' ? '关闭' : 'Close';
            retryBtn.classList.remove('hidden');
            checkApprovalBtn.classList.add('hidden');
            doneBtn.classList.add('hidden');
            if (window.channelOnboardingController.activePollInterval) {
              clearInterval(window.channelOnboardingController.activePollInterval);
              window.channelOnboardingController.activePollInterval = null;
            }
          } else if (currentJob.status === 'configuring' || currentJob.status === 'verifying') {
            clearQrDisplay();
            renderStatus(currentJob.status, currentJob.statusMessage);
          }
        }
      } catch (err) {
        const httpStatus = err && err.status;
        if (httpStatus === 404 || httpStatus === 401) {
          if (window.channelOnboardingController.activePollInterval) {
            clearInterval(window.channelOnboardingController.activePollInterval);
            window.channelOnboardingController.activePollInterval = null;
          }
          clearQrDisplay();
          renderStatus('error', httpStatus === 404
            ? (getLocale() === 'zh-CN' ? '任务不存在或已失效 (HTTP 404)' : 'Job not found or expired (HTTP 404)')
            : (getLocale() === 'zh-CN' ? '登录会话已过期，请重新登录 (HTTP 401)' : 'Session expired, please re-login (HTTP 401)'));
          retryBtn.classList.remove('hidden');
          cancelBtn.textContent = getLocale() === 'zh-CN' ? '关闭' : 'Close';
        } else {
          diagSpan.textContent = `[${new Date().toLocaleTimeString()} ${getLocale() === 'zh-CN' ? '核验异常' : 'Poll warning'}: ${err.message || 'Network error'}]`;
        }
      } finally {
        isPolling = false;
      }
    }, 1500);
  };

  renderStep1();
  openModal('modal-channel-onboarding');
}

// 2.9 Channels View (GET/POST/DELETE /api/manage/channels/accounts & bindings)
async function renderChannelsView(container) {
  let accounts = [];
  let bindings = [];
  let spaces = [];
  let isUnavailable = false;

  try {
    const [accRes, bindRes, spacesRes] = await Promise.all([
      apiRequest('/api/manage/channels/accounts'),
      apiRequest('/api/manage/channels/bindings'),
      apiRequest('/api/spaces').catch(() => ({ data: [] })),
    ]);

    accounts = (accRes && accRes.data && Array.isArray(accRes.data.accounts)) ? accRes.data.accounts : [];
    bindings = (bindRes && bindRes.data && Array.isArray(bindRes.data.bindings)) ? bindRes.data.bindings : [];
    spaces = (spacesRes && spacesRes.data && Array.isArray(spacesRes.data)) ? spacesRes.data : [];
  } catch (err) {
    isUnavailable = true;
  }

  container.replaceChildren();
  container.appendChild(createHeader('channels.title', 'channels.subtitle', () => renderManagementView('management/workspaces/channels')));

  if (isUnavailable) {
    container.appendChild(createStateCard('channels.unavailableTitle', 'channels.unavailableDesc', true));
    return;
  }

  // ──────── Toolbar Actions Row ────────
  const toolbarSection = document.createElement('div');
  toolbarSection.className = 'channel-toolbar-row mb-3';

  const btnConfigExisting = document.createElement('button');
  btnConfigExisting.type = 'button';
  btnConfigExisting.className = 'btn btn-primary';
  btnConfigExisting.textContent = getLocale() === 'zh-CN' ? '配置已有机器人' : 'Configure Existing Bot';
  btnConfigExisting.addEventListener('click', () => openChannelOnboardingModal('configure_existing', accounts, spaces));

  const btnCreateNew = document.createElement('button');
  btnCreateNew.type = 'button';
  btnCreateNew.className = 'btn btn-secondary';
  btnCreateNew.textContent = getLocale() === 'zh-CN' ? '新建机器人' : 'Create New Bot';
  btnCreateNew.addEventListener('click', () => openChannelOnboardingModal('create_new', accounts, spaces));

  toolbarSection.appendChild(btnConfigExisting);
  toolbarSection.appendChild(btnCreateNew);
  container.appendChild(toolbarSection);

  // ──────── Accounts Section (Cards) ────────
  const accSection = document.createElement("div");
  accSection.className = "management-section";

  const accSectionHeader = document.createElement("div");
  accSectionHeader.className = "section-header";
  const accTitle = document.createElement("h3");
  accTitle.textContent = getLocale() === "zh-CN" ? "机器人账号" : "Bot Accounts";
  accSectionHeader.appendChild(accTitle);
  accSection.appendChild(accSectionHeader);

  if (accounts.length === 0) {
    accSection.appendChild(createStateCard("channels.noAccountsTitle", "channels.noAccountsDesc"));
  } else {
    const accList = document.createElement("div");
    accList.className = "channel-accounts-list";

    accounts.forEach((acc) => {
      const card = document.createElement("div");
      card.className = "channel-account-card";

      // Header row
      const cardHeader = document.createElement("div");
      cardHeader.className = "channel-account-header";

      const titleWrap = document.createElement("div");
      titleWrap.className = "channel-account-title";

      const providerSpan = document.createElement("span");
      providerSpan.className = "channel-provider-name";
      if (acc.type === "lark") {
        providerSpan.textContent = getLocale() === "zh-CN" ? "飞书 / Lark" : "Feishu / Lark";
      } else if (acc.type === "wechat") {
        providerSpan.textContent = getLocale() === "zh-CN" ? "微信 / WeChat" : "WeChat";
      } else if (acc.type === "dingtalk") {
        providerSpan.textContent = getLocale() === "zh-CN" ? "钉钉 / DingTalk" : "DingTalk";
      } else {
        providerSpan.textContent = acc.type || "Unknown";
      }
      titleWrap.appendChild(providerSpan);

      const botNameSpan = document.createElement("span");
      botNameSpan.className = "channel-bot-name";
      const appMatch = acc.credentialRef ? acc.credentialRef.match(/cli_[a-zA-Z0-9]+/) : null;
      const fullAppId = appMatch ? appMatch[0] : (acc.appId || null);
      const shortSuffix = fullAppId
        ? ` (...${fullAppId.slice(-6)})`
        : ` (${acc.id.slice(-6)})`;

      let defaultAccName = "";
      if (acc.type === "wechat") {
        defaultAccName = getLocale() === "zh-CN" ? "微信账号" : "WeChat Account";
      } else if (acc.type === "lark") {
        defaultAccName = getLocale() === "zh-CN" ? "飞书账号" : "Feishu Account";
      } else if (acc.type === "dingtalk") {
        defaultAccName = getLocale() === "zh-CN" ? "钉钉账号" : "DingTalk Account";
      } else {
        defaultAccName = (acc.type || "Channel") + (getLocale() === "zh-CN" ? "账号" : " Account");
      }
      botNameSpan.textContent = acc.name ? acc.name : (defaultAccName + shortSuffix);
      titleWrap.appendChild(botNameSpan);
      cardHeader.appendChild(titleWrap);

      // Status Badge (strictly "已启用", "待配置", "待授权", "已停用", never "正常运行中" or "在线")
      let statusLabel = getLocale() === "zh-CN" ? "待配置" : "To Configure";
      let statusVariant = "warning";
      if (acc.status === "unverified") {
        statusLabel = getLocale() === "zh-CN" ? "待授权" : "Pending Auth";
        statusVariant = "warning";
      } else if (acc.status === "disabled") {
        statusLabel = getLocale() === "zh-CN" ? "已停用" : "Disabled";
        statusVariant = "neutral";
      } else if (acc.status === "active") {
        if (acc.credentialRef && acc.credentialRef.trim()) {
          statusLabel = getLocale() === "zh-CN" ? "已启用" : "Enabled";
          statusVariant = "success";
        } else {
          statusLabel = getLocale() === "zh-CN" ? "待配置" : "To Configure";
          statusVariant = "warning";
        }
      } else {
        statusLabel = getLocale() === "zh-CN" ? "待配置" : "To Configure";
        statusVariant = "warning";
      }
      const statusBadge = createBadgeElement(statusLabel, statusVariant);
      statusBadge.title = getLocale() === "zh-CN"
        ? "已启用仅表示配置开关，连接与权限需接入验证"
        : "Enabled indicates configuration switch only; connectivity and permissions require verification";
      cardHeader.appendChild(statusBadge);
      card.appendChild(cardHeader);

      // Body row (Workspace configuration with explicit Save button)
      const cardBody = document.createElement("div");
      cardBody.className = "channel-account-body";

      const wsControl = document.createElement("div");
      wsControl.className = "channel-workspace-control";

      const wsLabel = document.createElement("span");
      wsLabel.className = "channel-ws-label";
      wsLabel.textContent = getLocale() === "zh-CN" ? "默认工作区:" : "Default workspace:";
      wsControl.appendChild(wsLabel);

      const spaceSelect = document.createElement("select");
      spaceSelect.className = "form-select form-select-sm channel-acc-space-select";

      const emptyOpt = document.createElement("option");
      emptyOpt.value = "";
      emptyOpt.textContent = getLocale() === "zh-CN" ? "-- 无默认 --" : "-- None --";
      spaceSelect.appendChild(emptyOpt);

      spaces.forEach((s) => {
        const opt = document.createElement("option");
        opt.value = s.id;
        opt.textContent = s.name || s.folder || s.id;
        if (acc.defaultSpaceId === s.id) {
          opt.selected = true;
        }
        spaceSelect.appendChild(opt);
      });
      wsControl.appendChild(spaceSelect);

      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "btn btn-secondary btn-sm channel-save-space-btn";
      saveBtn.textContent = getLocale() === "zh-CN" ? "保存" : "Save";
      saveBtn.addEventListener("click", async () => {
        saveBtn.disabled = true;
        try {
          const selectedSpaceId = spaceSelect.value ? spaceSelect.value.trim() : null;
          await apiRequest("/api/manage/channels/accounts/" + encodeURIComponent(acc.id), {
            method: "PATCH",
            body: JSON.stringify({ defaultSpaceId: selectedSpaceId }),
          });
          showToast(getLocale() === "zh-CN" ? "默认工作区已保存" : "Default workspace saved", "success");
          await renderManagementView("management/workspaces/channels");
        } catch (err) {
          showToast(err.message || "Failed to update default workspace", "error");
        } finally {
          saveBtn.disabled = false;
        }
      });
      wsControl.appendChild(saveBtn);
      cardBody.appendChild(wsControl);

      // Group trigger configuration (Lark bot activation mode: 'mention' | 'always')
      if (!acc.type || acc.type === "lark" || acc.type === "feishu") {
        const triggerControl = document.createElement("div");
        triggerControl.className = "channel-trigger-control";

        const triggerRow = document.createElement("div");
        triggerRow.className = "channel-workspace-control channel-trigger-row";

        const triggerLabel = document.createElement("span");
        triggerLabel.className = "channel-ws-label channel-trigger-label";
        triggerLabel.textContent = (t("channels.groupTrigger") || (getLocale() === "zh-CN" ? "群聊触发方式" : "Group trigger")) + ":";
        triggerRow.appendChild(triggerLabel);

        const triggerSelect = document.createElement("select");
        triggerSelect.className = "form-select form-select-sm channel-acc-trigger-select";

        const currentMode = acc.groupActivationMode === "always" ? "always" : "mention";

        const optMention = document.createElement("option");
        optMention.value = "mention";
        optMention.textContent = t("channels.groupTriggerModeMention") || (getLocale() === "zh-CN" ? "仅 @ 机器人时回复" : "Reply only when @mentioned");
        if (currentMode === "mention") {
          optMention.selected = true;
        }
        triggerSelect.appendChild(optMention);

        const optAlways = document.createElement("option");
        optAlways.value = "always";
        optAlways.textContent = t("channels.groupTriggerModeAlways") || (getLocale() === "zh-CN" ? "监听群内所有消息" : "Reply to all group messages");
        if (currentMode === "always") {
          optAlways.selected = true;
        }
        triggerSelect.appendChild(optAlways);

        triggerRow.appendChild(triggerSelect);

        const triggerSaveBtn = document.createElement("button");
        triggerSaveBtn.type = "button";
        triggerSaveBtn.className = "btn btn-secondary btn-sm channel-save-trigger-btn";
        triggerSaveBtn.textContent = t("channels.save") || (getLocale() === "zh-CN" ? "保存" : "Save");
        triggerSaveBtn.addEventListener("click", async () => {
          triggerSaveBtn.disabled = true;
          try {
            const selectedMode = triggerSelect.value === "always" ? "always" : "mention";
            await apiRequest("/api/manage/channels/accounts/" + encodeURIComponent(acc.id), {
              method: "PATCH",
              body: JSON.stringify({ groupActivationMode: selectedMode }),
            });
            showToast(t("channels.groupTriggerSaved") || (getLocale() === "zh-CN" ? "群聊触发方式已保存" : "Group trigger saved"), "success");
            await renderManagementView("management/workspaces/channels");
          } catch (err) {
            showToast(err.message || (getLocale() === "zh-CN" ? "保存群聊触发方式失败" : "Failed to update group trigger"), "error");
          } finally {
            triggerSaveBtn.disabled = false;
          }
        });
        triggerRow.appendChild(triggerSaveBtn);
        triggerControl.appendChild(triggerRow);

        const triggerHint = document.createElement("div");
        triggerHint.className = "channel-trigger-hint";
        triggerHint.textContent = t("channels.groupTriggerHint") || (getLocale() === "zh-CN" ? "私聊不受影响；保存后同步应用到该机器人已加入的群。" : "Direct chats are unaffected; saving also applies to groups this bot has already joined.");
        triggerControl.appendChild(triggerHint);

        cardBody.appendChild(triggerControl);
      }

      const actionsWrap = document.createElement("div");
      actionsWrap.className = "channel-acc-actions";

      if (acc.type === "lark" || acc.type === "feishu") {
        const configBtn = document.createElement("button");
        configBtn.type = "button";
        configBtn.className = "btn btn-secondary btn-sm channel-config-acc-btn";
        configBtn.textContent = getLocale() === "zh-CN" ? "配置" : "Configure";
        configBtn.addEventListener("click", () => {
          openChannelOnboardingModal('configure_existing', accounts, spaces, acc.id);
        });
        actionsWrap.appendChild(configBtn);
      }

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn btn-secondary btn-sm channel-delete-acc-btn";
      delBtn.textContent = getLocale() === "zh-CN" ? "删除" : "Delete";
      delBtn.addEventListener("click", async () => {
        const ok = await showConfirmDialog(
          getLocale() === "zh-CN" ? "删除渠道账号" : "Delete Channel Account",
          getLocale() === "zh-CN" ? ("确定删除渠道账号 " + acc.id + " 吗？") : ("Are you sure you want to delete account " + acc.id + "?")
        );
        if (!ok) return;
        try {
          await apiRequest("/api/manage/channels/accounts/" + encodeURIComponent(acc.id), { method: "DELETE" });
          showToast(getLocale() === "zh-CN" ? "账号已删除" : "Account deleted", "success");
          await renderManagementView("management/workspaces/channels");
        } catch (err) {
          showToast(err.message || "Failed to delete account", "error");
        }
      });
      actionsWrap.appendChild(delBtn);
      cardBody.appendChild(actionsWrap);
      card.appendChild(cardBody);

      // Collapsible Technical details (default closed)
      const techDetails = document.createElement("details");
      techDetails.className = "channel-tech-details";

      const techSummary = document.createElement("summary");
      techSummary.textContent = getLocale() === "zh-CN" ? "技术详情" : "Technical Details";
      techDetails.appendChild(techSummary);

      const techContent = document.createElement("div");
      techContent.className = "channel-tech-content";

      const itemStatusNote = document.createElement("div");
      itemStatusNote.className = "channel-tech-item";
      const lblStatusNote = document.createElement("span");
      lblStatusNote.className = "channel-tech-label";
      lblStatusNote.textContent = getLocale() === "zh-CN" ? "状态说明" : "Status Note";
      const valStatusNote = document.createElement("span");
      valStatusNote.textContent = getLocale() === "zh-CN"
        ? "已启用仅表示配置开关，连接与权限需接入验证"
        : "Enabled indicates configuration switch only; connectivity and permissions require verification";
      itemStatusNote.appendChild(lblStatusNote);
      itemStatusNote.appendChild(valStatusNote);
      techContent.appendChild(itemStatusNote);

      if (fullAppId) {
        const itemAppId = document.createElement("div");
        itemAppId.className = "channel-tech-item";
        const lblApp = document.createElement("span");
        lblApp.className = "channel-tech-label";
        lblApp.textContent = getLocale() === "zh-CN" ? "应用 App ID" : "App ID";
        const valApp = document.createElement("code");
        valApp.textContent = fullAppId;
        itemAppId.appendChild(lblApp);
        itemAppId.appendChild(valApp);
        techContent.appendChild(itemAppId);
      }

      const itemAccId = document.createElement("div");
      itemAccId.className = "channel-tech-item";
      const lblAccId = document.createElement("span");
      lblAccId.className = "channel-tech-label";
      lblAccId.textContent = getLocale() === "zh-CN" ? "账号 ID" : "Account ID";
      const valAccId = document.createElement("code");
      valAccId.textContent = acc.id;
      itemAccId.appendChild(lblAccId);
      itemAccId.appendChild(valAccId);
      techContent.appendChild(itemAccId);

      const itemCred = document.createElement("div");
      itemCred.className = "channel-tech-item";
      const lblCred = document.createElement("span");
      lblCred.className = "channel-tech-label";
      lblCred.textContent = getLocale() === "zh-CN" ? "凭据引用" : "Credential Ref";
      const valCred = document.createElement("code");
      valCred.textContent = acc.credentialRef || "(none)";
      itemCred.appendChild(lblCred);
      itemCred.appendChild(valCred);
      techContent.appendChild(itemCred);

      const itemType = document.createElement("div");
      itemType.className = "channel-tech-item";
      const lblType = document.createElement("span");
      lblType.className = "channel-tech-label";
      lblType.textContent = getLocale() === "zh-CN" ? "渠道协议" : "Type";
      const valType = document.createElement("span");
      valType.textContent = acc.type;
      itemType.appendChild(lblType);
      itemType.appendChild(valType);
      techContent.appendChild(itemType);

      techDetails.appendChild(techContent);
      card.appendChild(techDetails);

      accList.appendChild(card);
    });

    accSection.appendChild(accList);
  }
  container.appendChild(accSection);

  // ──────── Bindings / Chat Routing Section ────────
  const routingSection = document.createElement("div");
  routingSection.className = "management-section channel-section-spacing";

  const routingDetails = document.createElement("details");
  routingDetails.className = "channel-routing-details";
  routingDetails.open = true;

  const routingSummary = document.createElement("summary");
  routingSummary.textContent = getLocale() === "zh-CN" ? "聊天路由" : "Chat Routing";
  routingDetails.appendChild(routingSummary);

  if (bindings.length === 0) {
    routingDetails.appendChild(createStateCard("channels.noBindingsTitle", "channels.noBindingsDesc"));
  } else {
    const bindTableWrap = document.createElement("div");
    bindTableWrap.className = "data-table-container channel-routing-table-wrap";
    const bTable = document.createElement("table");
    bTable.className = "data-table";

    const bThead = document.createElement("thead");
    const bTrHead = document.createElement("tr");
    const bCols = [
      getLocale() === "zh-CN" ? "聊天会话" : "Chat Session",
      getLocale() === "zh-CN" ? "工作区" : "Workspace",
      getLocale() === "zh-CN" ? "唤醒模式" : "Activation Mode",
      getLocale() === "zh-CN" ? "技术详情" : "Technical Details",
      getLocale() === "zh-CN" ? "操作" : "Actions",
    ];
    bCols.forEach((txt) => {
      const th = document.createElement("th");
      th.textContent = txt;
      bTrHead.appendChild(th);
    });
    bThead.appendChild(bTrHead);
    bTable.appendChild(bThead);

    const bTbody = document.createElement("tbody");
    bindings.forEach((b) => {
      const tr = document.createElement("tr");

      const tdSession = document.createElement("td");
      tdSession.textContent = getLocale() === "zh-CN" ? "聊天会话" : "Chat Session";

      const tdSpace = document.createElement("td");
      const targetSpace = spaces.find((s) => s.id === b.spaceId);
      tdSpace.textContent = targetSpace ? (targetSpace.name || targetSpace.folder || targetSpace.id) : b.spaceId;

      const tdAct = document.createElement("td");
      const actText = b.activationMode === "mention"
        ? (getLocale() === "zh-CN" ? "@机器人触发" : "Mention only")
        : (getLocale() === "zh-CN" ? "全部消息触发" : "All messages");
      tdAct.appendChild(createBadgeElement(actText, b.activationMode === "always" ? "primary" : "neutral"));

      const tdTech = document.createElement("td");
      const techSmall = document.createElement("small");
      techSmall.className = "channel-tech-inline form-text-muted";
      techSmall.textContent = "ctx: " + b.nativeContextId + " | acc: " + b.accountId;
      tdTech.appendChild(techSmall);

      const tdActBtn = document.createElement("td");
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn btn-secondary btn-sm delete-binding-btn";
      delBtn.textContent = getLocale() === "zh-CN" ? "解除绑定" : "Unbind";
      delBtn.addEventListener("click", async () => {
        const ok = await showConfirmDialog(
          getLocale() === "zh-CN" ? "解除聊天绑定" : "Unbind Chat Routing",
          getLocale() === "zh-CN" ? "确定解除此聊天会话与工作区的绑定吗？" : "Are you sure you want to unbind this chat routing?"
        );
        if (!ok) return;
        try {
          await apiRequest("/api/manage/channels/bindings/" + encodeURIComponent(b.id), { method: "DELETE" });
          showToast(getLocale() === "zh-CN" ? "绑定已解除" : "Binding removed", "success");
          await renderManagementView("management/workspaces/channels");
        } catch (err) {
          showToast(err.message || "Failed to delete binding", "error");
        }
      });
      tdActBtn.appendChild(delBtn);

      tr.appendChild(tdSession);
      tr.appendChild(tdSpace);
      tr.appendChild(tdAct);
      tr.appendChild(tdTech);
      tr.appendChild(tdActBtn);
      bTbody.appendChild(tr);
    });
    bTable.appendChild(bTbody);
    bindTableWrap.appendChild(bTable);
    routingDetails.appendChild(bindTableWrap);
  }
  routingSection.appendChild(routingDetails);
  container.appendChild(routingSection);

  // ──────── Advanced Section (Manual Form in Collapsible Details) ────────
  const advSection = document.createElement("div");
  advSection.className = "management-section channel-section-spacing";

  const advDetails = document.createElement("details");
  advDetails.className = "channel-advanced-details";

  const advSummary = document.createElement("summary");
  advSummary.textContent = getLocale() === "zh-CN" ? "高级：手动添加账号与绑定" : "Advanced: Manual Account & Binding";
  advDetails.appendChild(advSummary);

  const accForm = document.createElement("form");
  accForm.className = "inline-form-row channel-form-row mt-2";

  const typeInput = document.createElement("input");
  typeInput.type = "text";
  typeInput.id = "new-channel-acc-type";
  typeInput.className = "form-input channel-acc-type-input";
  typeInput.placeholder = getLocale() === "zh-CN" ? "渠道类型 (lark)" : "Channel Type (lark)";
  typeInput.value = "lark";
  typeInput.required = true;

  const credInput = document.createElement("input");
  credInput.type = "text";
  credInput.id = "new-channel-acc-cred";
  credInput.className = "form-input channel-acc-cred-input";
  credInput.placeholder = getLocale() === "zh-CN" ? "凭据引用 (如 cred_lark_1)" : "Credential Ref (e.g. cred_lark_1)";

  const statusSelect = document.createElement("select");
  statusSelect.id = "new-channel-acc-status";
  statusSelect.className = "form-select channel-acc-status-select";
  ["active", "unverified", "disabled"].forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    statusSelect.appendChild(opt);
  });

  const newDefaultSpaceSelect = document.createElement("select");
  newDefaultSpaceSelect.id = "new-channel-acc-default-space";
  newDefaultSpaceSelect.className = "form-select channel-acc-default-space-select";
  const noneSpaceOpt = document.createElement("option");
  noneSpaceOpt.value = "";
  noneSpaceOpt.textContent = getLocale() === "zh-CN" ? "-- 默认工作区 (可选) --" : "-- Default workspace (optional) --";
  newDefaultSpaceSelect.appendChild(noneSpaceOpt);
  spaces.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.name || s.folder || s.id;
    newDefaultSpaceSelect.appendChild(opt);
  });

  const addAccBtn = document.createElement("button");
  addAccBtn.type = "submit";
  addAccBtn.className = "btn btn-secondary btn-sm";
  addAccBtn.textContent = getLocale() === "zh-CN" ? "+ 添加账号" : "+ Add Account";

  accForm.appendChild(typeInput);
  accForm.appendChild(credInput);
  accForm.appendChild(statusSelect);
  accForm.appendChild(newDefaultSpaceSelect);
  accForm.appendChild(addAccBtn);

  accForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await apiRequest("/api/manage/channels/accounts", {
      method: "POST",
      body: JSON.stringify({
        type: typeInput.value.trim(),
        credentialRef: credInput.value.trim() || undefined,
        status: statusSelect.value,
        defaultSpaceId: newDefaultSpaceSelect.value ? newDefaultSpaceSelect.value.trim() : null,
      }),
    });
    showToast(getLocale() === "zh-CN" ? "账号添加成功" : "Account created successfully", "success");
    await renderManagementView("management/workspaces/channels");
  });
  advDetails.appendChild(accForm);

  if (accounts.length > 0 && spaces.length > 0) {
    const bindForm = document.createElement("form");
    bindForm.className = "inline-form-row channel-form-row mt-2";

    const accSelect = document.createElement("select");
    accSelect.id = "new-bind-acc";
    accSelect.className = "form-select form-select-sm";
    accounts.forEach((a) => {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = a.id + " (" + a.type + ")";
      accSelect.appendChild(opt);
    });

    const spaceSelect = document.createElement("select");
    spaceSelect.id = "new-bind-space";
    spaceSelect.className = "form-select form-select-sm";
    spaces.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.name || s.folder || s.id;
      spaceSelect.appendChild(opt);
    });

    const ctxInput = document.createElement("input");
    ctxInput.type = "text";
    ctxInput.id = "new-bind-context";
    ctxInput.className = "form-input form-input-sm channel-bind-context-input";
    ctxInput.placeholder = getLocale() === "zh-CN" ? "原生上下文 ID" : "Native Context ID";
    ctxInput.required = true;

    const actSelect = document.createElement("select");
    actSelect.id = "new-bind-activation";
    actSelect.className = "form-select form-select-sm channel-bind-activation-select";
    ["mention", "always"].forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      actSelect.appendChild(opt);
    });

    const addBindBtn = document.createElement("button");
    addBindBtn.type = "submit";
    addBindBtn.className = "btn btn-secondary btn-sm";
    addBindBtn.textContent = getLocale() === "zh-CN" ? "+ 添加绑定" : "+ Add Binding";

    bindForm.appendChild(accSelect);
    bindForm.appendChild(spaceSelect);
    bindForm.appendChild(ctxInput);
    bindForm.appendChild(actSelect);
    bindForm.appendChild(addBindBtn);

    bindForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      await apiRequest("/api/manage/channels/bindings", {
        method: "POST",
        body: JSON.stringify({
          accountId: accSelect.value,
          spaceId: spaceSelect.value,
          nativeContextId: ctxInput.value.trim(),
          activationMode: actSelect.value,
        }),
      });
      showToast(getLocale() === "zh-CN" ? "绑定添加成功" : "Binding created successfully", "success");
      await renderManagementView("management/workspaces/channels");
    });
    advDetails.appendChild(bindForm);
  }

  advSection.appendChild(advDetails);
  container.appendChild(advSection);
}

// 3. Delivery View (GET /api/manage/deliveries or /api/admin/deliveries)
async function renderDeliveryView(container) {
  const isAdmin = Boolean(state.currentUser && state.currentUser.role === 'admin');
  const endpoint = isAdmin ? '/api/admin/deliveries' : '/api/manage/deliveries';

  let deliveries = null;
  let isUnavailable = false;

  try {
    const res = await apiRequest(endpoint);
    if (res && res.data) {
      const raw = res.data;
      const rawList = Array.isArray(raw) ? raw : (Array.isArray(raw.items) ? raw.items : null);
      if (rawList) {
        deliveries = rawList;
      } else {
        isUnavailable = true;
      }
    } else {
      isUnavailable = true;
    }
  } catch (err) {
    isUnavailable = true;
  }

  container.replaceChildren();
  container.appendChild(createHeader('delivery.title', 'delivery.subtitle', () => renderManagementView('delivery')));

  if (isUnavailable) {
    container.appendChild(createStateCard('delivery.unavailableTitle', 'delivery.unavailableDesc', true));
    return;
  }

  if (!deliveries || deliveries.length === 0) {
    container.appendChild(createStateCard('delivery.emptyTitle', 'delivery.emptyDesc'));
    return;
  }

  const tableContainer = document.createElement('div');
  tableContainer.className = 'data-table-container';
  const table = document.createElement('table');
  table.className = 'data-table';

  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');
  const cols = ['Status', 'Received At', 'Updated At'];
  const colKeys = ['delivery.colStatus', 'delivery.colReceivedAt', 'delivery.colUpdatedAt'];
  cols.forEach((col, idx) => {
    const th = document.createElement('th');
    th.textContent = t(colKeys[idx], null, col);
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const VALID_DELIVERY_STATUSES = ['delivered', 'failed', 'held', 'processing', 'pending', 'accepted', 'duplicate', 'cancelled'];

  deliveries.forEach((d) => {
    const isValidDelivery = Boolean(d && typeof d === 'object' && VALID_DELIVERY_STATUSES.includes(d.status));
    if (!isValidDelivery) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 3;
      td.className = 'text-muted';
      td.textContent = t('common.invalidRecord', null, getLocale() === 'zh-CN' ? '无效记录' : 'Invalid record');
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    const tr = document.createElement('tr');

    const tdStatus = document.createElement('td');
    const deliveryStatus = d.status;
    const badgeType = deliveryStatus === 'delivered' ? 'success' : ((deliveryStatus === 'failed' || deliveryStatus === 'cancelled') ? 'danger' : ((deliveryStatus === 'duplicate' || deliveryStatus === 'held') ? 'warning' : 'muted'));
    tdStatus.appendChild(createBadgeElement(deliveryStatus, badgeType));
    tr.appendChild(tdStatus);

    const tdCreated = document.createElement('td');
    const tsCreated = d.createdAt || d.receivedAt || d.timestamp;
    tdCreated.textContent = tsCreated ? formatDate(tsCreated) : '-';
    tr.appendChild(tdCreated);

    const tdUpdated = document.createElement('td');
    const tsUpdated = d.updatedAt;
    tdUpdated.textContent = tsUpdated ? formatDate(tsUpdated) : '-';
    tr.appendChild(tdUpdated);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  tableContainer.appendChild(table);

  container.appendChild(tableContainer);
}

// Quotas View (GET /api/manage/quota/check?metrics=all or /api/admin/quotas, PATCH /api/admin/quotas/:userId/:metric)
async function renderQuotasView(container) {
  const isAdmin = Boolean(state.currentUser && state.currentUser.role === 'admin');

  container.replaceChildren();
  container.appendChild(createHeader('quotas.title', 'quotas.subtitle', () => renderManagementView('quotas')));

  if (isAdmin) {
    let quotaItems = [];
    let isUnavailable = false;

    try {
      const res = await apiRequest('/api/admin/quotas');
      const raw = res && res.data;
      if (raw && Array.isArray(raw.items)) {
        quotaItems = raw.items;
      } else {
        isUnavailable = true;
      }
    } catch {
      isUnavailable = true;
    }

    if (isUnavailable) {
      container.appendChild(createStateCard('quotas.unavailableTitle', 'quotas.unavailableDesc', true));
      return;
    }

    // Count genuine rules across returned items
    const totalLimits = quotaItems.reduce((acc, q) => acc + (Array.isArray(q.limits) ? q.limits.length : 0), 0);
    const totalReservations = quotaItems.reduce((acc, q) => acc + (Array.isArray(q.activeReservations) ? q.activeReservations.length : 0), 0);
    const totalUsages = quotaItems.reduce((acc, q) => acc + (Array.isArray(q.usage) ? q.usage.length : 0), 0);

    const kpiGrid = document.createElement('div');
    kpiGrid.className = 'kpi-grid';
    kpiGrid.appendChild(createKpiCard('quotas.kpiLimits', String(totalLimits), totalLimits > 0 ? (getLocale() === 'zh-CN' ? '生效规则策略' : 'Active rule policies') : (getLocale() === 'zh-CN' ? '无' : 'None')));
    kpiGrid.appendChild(createKpiCard('quotas.kpiReservations', String(totalReservations), totalReservations > 0 ? (getLocale() === 'zh-CN' ? '待结算预占' : 'Pending settlements') : (getLocale() === 'zh-CN' ? '无' : 'None')));
    kpiGrid.appendChild(createKpiCard('quotas.kpiUsages', String(totalUsages), totalUsages > 0 ? (getLocale() === 'zh-CN' ? '资源计数器' : 'Resource counters') : (getLocale() === 'zh-CN' ? '无' : 'None')));
    container.appendChild(kpiGrid);

    // Admin Quick Action: Set / Update Quota Limit for the 5 fixed metrics
    const adminActionSection = document.createElement('div');
    adminActionSection.className = 'profile-binding-bar';

    const actTitle = document.createElement('div');
    const aH4 = document.createElement('h4');
    aH4.textContent = t('quotas.adminControlsTitle', null, 'Admin Quota Controls');
    const aSub = document.createElement('p');
    aSub.className = 'text-muted';
    aSub.textContent = t('quotas.adminControlsSubtitle', null, 'Configure explicit resource limits for the 5 fixed metrics: tokens, messages, turns, storage_bytes, api_calls');
    actTitle.appendChild(aH4);
    actTitle.appendChild(aSub);
    adminActionSection.appendChild(actTitle);

    const btnEditQuota = document.createElement('button');
    btnEditQuota.type = 'button';
    btnEditQuota.id = 'btn-open-edit-quota';
    btnEditQuota.className = 'btn btn-primary btn-sm';
    btnEditQuota.textContent = t('quotas.btnOpenEdit', null, '+ Set / Update Metric Limit');
    btnEditQuota.addEventListener('click', () => {
      openEditQuotaModal();
    });
    adminActionSection.appendChild(btnEditQuota);

    container.appendChild(adminActionSection);

    if (quotaItems.length === 0 || totalLimits === 0) {
      container.appendChild(createStateCard('quotas.emptyTitle', 'quotas.emptyDesc'));
      return;
    }

    const section = document.createElement('div');
    section.className = 'management-section';
    const sHead = document.createElement('div');
    sHead.className = 'section-header';
    const h3 = document.createElement('h3');
    h3.textContent = t('quotas.sectionAllocations', null, 'Quota Allocations');
    sHead.appendChild(h3);
    section.appendChild(sHead);

    const tableContainer = document.createElement('div');
    tableContainer.className = 'data-table-container';
    const table = document.createElement('table');
    table.className = 'data-table';

    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');
    const cols = ['User / Scope', 'Metric / Resource', 'Limit', 'Updated At', 'Actions'];
    const colKeys = ['quotas.colUser', 'quotas.colMetric', 'quotas.colLimit', 'quotas.colUpdatedAt', 'quotas.colActions'];
    cols.forEach((col, idx) => {
      const th = document.createElement('th');
      th.textContent = t(colKeys[idx], null, col);
      trHead.appendChild(th);
    });
    thead.appendChild(trHead);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    quotaItems.forEach((q) => {
      if (!q || typeof q !== 'object') {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5;
        td.className = 'text-muted';
        td.textContent = t('common.invalidRecord', null, getLocale() === 'zh-CN' ? '无效记录' : 'Invalid record');
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }
      const uId = q.username || q.userId || '-';
      if (Array.isArray(q.limits)) {
        q.limits.forEach((lim) => {
          if (!lim || typeof lim !== 'object') {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = 5;
            td.className = 'text-muted';
            td.textContent = t('common.invalidRecord', null, getLocale() === 'zh-CN' ? '无效记录' : 'Invalid record');
            tr.appendChild(td);
            tbody.appendChild(tr);
            return;
          }
          const tr = document.createElement('tr');
          const tdUser = document.createElement('td');
          tdUser.textContent = uId;
          tr.appendChild(tdUser);

          const tdRes = document.createElement('td');
          const rawMetric = lim.resource || lim.metric || '-';
          tdRes.textContent = getLocalizedEnum('metric', rawMetric);
          tr.appendChild(tdRes);

          const tdLim = document.createElement('td');
          const val = lim.limit !== undefined ? lim.limit : (lim.limitAmount !== undefined ? lim.limitAmount : '-');
          tdLim.textContent = (typeof val === 'number' && val < 0)
            ? (getLocale() === 'zh-CN' ? '无限制' : 'Unlimited')
            : (val !== '-' ? formatNumber(val) : '-');
          tr.appendChild(tdLim);

          const tdTime = document.createElement('td');
          tdTime.textContent = lim.updatedAt ? formatDate(lim.updatedAt) : '-';
          tr.appendChild(tdTime);

          const tdActions = document.createElement('td');
          tdActions.className = 'file-actions-cell';
          const editBtn = document.createElement('button');
          editBtn.type = 'button';
          editBtn.className = 'btn btn-secondary btn-xs';
          editBtn.textContent = getLocale() === 'zh-CN' ? '修改上限' : 'Edit Limit';
          editBtn.addEventListener('click', () => {
            openEditQuotaModal(uId !== '-' ? uId : '', lim.resource || lim.metric || '', val !== '-' ? val : '');
          });
          tdActions.appendChild(editBtn);
          tr.appendChild(tdActions);

          tbody.appendChild(tr);
        });
      }
    });
    table.appendChild(tbody);
    tableContainer.appendChild(table);
    section.appendChild(tableContainer);
    container.appendChild(section);
  } else {
    // Non-admin tenant quota verification via exact GET /api/manage/quota/check?metrics=all
    let checkData = null;
    let isUnavailable = false;

    try {
      let res = await apiRequest('/api/manage/quota/check?metrics=all').catch(() => null);
      if (!res || !res.data) {
        res = await apiRequest('/api/manage/quotas');
      }
      if (res && res.data && typeof res.data === 'object') {
        checkData = res.data;
      } else {
        isUnavailable = true;
      }
    } catch {
      isUnavailable = true;
    }

    if (isUnavailable || !checkData) {
      container.appendChild(createStateCard('quotas.unavailableTitle', 'quotas.unavailableDesc', true));
      return;
    }

    const isAllowed = checkData.allowed === true;
    const usage = (checkData.usage && typeof checkData.usage === 'object') ? checkData.usage : {};
    const activeReservations = (checkData.activeReservations && typeof checkData.activeReservations === 'object') ? checkData.activeReservations : {};
    const limit = (checkData.limit && typeof checkData.limit === 'object') ? checkData.limit : {};
    const remaining = (checkData.remaining && typeof checkData.remaining === 'object') ? checkData.remaining : {};

    const FIXED_METRICS = ['tokens', 'messages', 'turns', 'storage_bytes', 'api_calls'];
    const metricKeys = FIXED_METRICS.filter(
      (m) => limit[m] !== undefined || usage[m] !== undefined || remaining[m] !== undefined || activeReservations[m] !== undefined
    );
    const allMetrics = metricKeys.length > 0 ? metricKeys : Array.from(new Set([
      ...Object.keys(limit),
      ...Object.keys(usage),
      ...Object.keys(activeReservations),
      ...Object.keys(remaining),
    ]));

    const kpiGrid = document.createElement('div');
    kpiGrid.className = 'kpi-grid';
    const statusSub = isAllowed
      ? (getLocale() === 'zh-CN' ? '所有资源均在配额范围内' : 'All resource rules in policy')
      : (getLocale() === 'zh-CN' ? '已超出资源配额上限' : 'Quota threshold exceeded');
    kpiGrid.appendChild(createKpiCard(getLocale() === 'zh-CN' ? '账户配额状态' : 'Account Quota Status', isAllowed ? (getLocale() === 'zh-CN' ? '正常配额内' : 'Allowed') : (getLocale() === 'zh-CN' ? '已超额' : 'Exceeded'), statusSub));
    kpiGrid.appendChild(createKpiCard(getLocale() === 'zh-CN' ? '监控指标项' : 'Monitored Resources', String(allMetrics.length), getLocale() === 'zh-CN' ? '追踪配额指标' : 'Tracked quota metrics'));
    kpiGrid.appendChild(createKpiCard(getLocale() === 'zh-CN' ? '策略重置时间' : 'Policy Reset', checkData.resetAt ? formatDate(checkData.resetAt) : (getLocale() === 'zh-CN' ? '固定 / 滚动窗口' : 'Fixed / Rolling'), getLocale() === 'zh-CN' ? '配额统计窗口' : 'Quota window'));
    container.appendChild(kpiGrid);

    if (allMetrics.length === 0) {
      container.appendChild(createStateCard('quotas.emptyTitle', 'quotas.emptyDesc'));
      return;
    }

    const section = document.createElement('div');
    section.className = 'management-section';
    const sHead = document.createElement('div');
    sHead.className = 'section-header';
    const h3 = document.createElement('h3');
    h3.textContent = getLocale() === 'zh-CN' ? '账户资源配额限制与使用情况' : 'Account Resource Quota Limits & Usage';
    sHead.appendChild(h3);
    section.appendChild(sHead);

    const tableContainer = document.createElement('div');
    tableContainer.className = 'data-table-container';
    const table = document.createElement('table');
    table.className = 'data-table';

    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');
    const cols = ['Metric / Resource', 'Limit', 'Usage', 'Active Reservations', 'Remaining', 'Status'];
    const colKeys = ['quotas.colMetric', 'quotas.colLimit', 'quotas.colUsage', 'quotas.colReservations', 'quotas.colRemaining', 'common.status'];
    cols.forEach((col, idx) => {
      const th = document.createElement('th');
      th.textContent = t(colKeys[idx], null, col);
      trHead.appendChild(th);
    });
    thead.appendChild(trHead);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    allMetrics.forEach((metric) => {
      if (!metric || typeof metric !== 'string') {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 6;
        td.className = 'text-muted';
        td.textContent = t('common.invalidRecord', null, getLocale() === 'zh-CN' ? '无效记录' : 'Invalid record');
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }

      const tr = document.createElement('tr');

      const tdMetric = document.createElement('td');
      tdMetric.textContent = getLocalizedEnum('metric', metric);
      tr.appendChild(tdMetric);

      const tdLimit = document.createElement('td');
      const limVal = limit[metric];
      tdLimit.textContent = limVal !== undefined && limVal !== null
        ? (limVal < 0 ? (getLocale() === 'zh-CN' ? '无限制' : 'Unlimited') : formatNumber(limVal))
        : (getLocale() === 'zh-CN' ? '无限制' : 'Unlimited');
      tr.appendChild(tdLimit);

      const tdUsage = document.createElement('td');
      const useVal = usage[metric];
      tdUsage.textContent = useVal !== undefined && useVal !== null ? formatNumber(useVal) : '0';
      tr.appendChild(tdUsage);

      const tdRes = document.createElement('td');
      const resVal = activeReservations[metric];
      tdRes.textContent = resVal !== undefined && resVal !== null ? formatNumber(resVal) : '0';
      tr.appendChild(tdRes);

      const tdRemaining = document.createElement('td');
      const remVal = remaining[metric];
      tdRemaining.textContent = remVal !== undefined && remVal !== null
        ? (remVal < 0 ? (getLocale() === 'zh-CN' ? '无限制' : 'Unlimited') : formatNumber(remVal))
        : '-';
      tr.appendChild(tdRemaining);

      const tdStatus = document.createElement('td');
      const isMetricAllowed = (remVal === undefined || remVal === null || remVal < 0 || remVal >= 0) && isAllowed;
      const statusText = isMetricAllowed ? (getLocale() === 'zh-CN' ? '正常' : 'Allowed') : (getLocale() === 'zh-CN' ? '超额' : 'Exceeded');
      tdStatus.appendChild(createBadgeElement(statusText, isMetricAllowed ? 'success' : 'danger'));
      tr.appendChild(tdStatus);

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    tableContainer.appendChild(table);
    section.appendChild(tableContainer);
    container.appendChild(section);
  }
}

function openEditQuotaModal(userId = '', metric = '', limit = '') {
  const userInput = document.getElementById('quota-target-user-id');
  const metricSelect = document.getElementById('quota-metric-select');
  const limitInput = document.getElementById('quota-limit-input');

  if (userInput) userInput.value = userId;
  if (metricSelect && metric) {
    const fixedMetrics = ['tokens', 'messages', 'turns', 'storage_bytes', 'api_calls'];
    if (fixedMetrics.includes(metric)) {
      metricSelect.value = metric;
    }
  }
  if (limitInput && limit !== '') limitInput.value = limit;

  openModal('modal-edit-quota');
}

// 5. Activity / Audit View (GET /api/manage/audit or /api/admin/audit)
async function renderActivityView(container) {
  const isAdmin = Boolean(state.currentUser && state.currentUser.role === 'admin');
  const endpoint = isAdmin ? '/api/admin/audit' : '/api/manage/audit';

  let auditEntries = null;
  let isUnavailable = false;

  try {
    const res = await apiRequest(endpoint);
    if (res && res.data) {
      const raw = res.data;
      const rawList = Array.isArray(raw) ? raw : (Array.isArray(raw.items) ? raw.items : null);

      if (rawList) {
        auditEntries = rawList;
      } else {
        isUnavailable = true;
      }
    } else {
      isUnavailable = true;
    }
  } catch (err) {
    isUnavailable = true;
  }

  container.replaceChildren();
  container.appendChild(createHeader('audit.title', 'audit.subtitle', () => renderManagementView('activity')));

  // Audit Export Toolbar (Native <a> streaming download with cookie auth)
  const exportBar = document.createElement('div');
  exportBar.className = 'filter-toolbar mb-2';
  const exportCsvLink = document.createElement('a');
  exportCsvLink.className = 'btn btn-secondary btn-sm';
  exportCsvLink.href = '/api/admin/audit/export?format=csv&limit=10000';
  exportCsvLink.setAttribute('download', 'audit_logs.csv');
  exportCsvLink.textContent = t('audit.btnExportCsv', null, 'Export CSV');

  const exportJsonlLink = document.createElement('a');
  exportJsonlLink.className = 'btn btn-secondary btn-sm';
  exportJsonlLink.href = '/api/admin/audit/export?format=jsonl&limit=10000';
  exportJsonlLink.setAttribute('download', 'audit_logs.jsonl');
  exportJsonlLink.textContent = t('audit.btnExportJsonl', null, 'Export JSONL');

  exportBar.appendChild(exportCsvLink);
  exportBar.appendChild(exportJsonlLink);
  container.appendChild(exportBar);

  if (isUnavailable) {
    container.appendChild(createStateCard('audit.unavailableTitle', 'audit.unavailableDesc', true));
    return;
  }

  if (!auditEntries || auditEntries.length === 0) {
    container.appendChild(createStateCard('audit.emptyTitle', 'audit.emptyDesc'));
    return;
  }

  const tableContainer = document.createElement('div');
  tableContainer.className = 'data-table-container';
  const table = document.createElement('table');
  table.className = 'data-table';

  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');
  const cols = ['Timestamp', 'Actor', 'Action', 'IP / Client'];
  const colKeys = ['audit.colTimestamp', 'audit.colActor', 'audit.colAction', 'audit.colClient'];
  cols.forEach((col, idx) => {
    const th = document.createElement('th');
    th.textContent = t(colKeys[idx], null, col);
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  auditEntries.forEach((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.username !== 'string' || entry.username.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.className = 'text-muted';
      td.textContent = t('common.invalidRecord', null, getLocale() === 'zh-CN' ? '无效记录' : 'Invalid record');
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    const tr = document.createElement('tr');

    const tdTime = document.createElement('td');
    const ts = entry.createdAt || entry.timestamp;
    tdTime.textContent = ts ? formatDate(ts) : '-';
    tr.appendChild(tdTime);

    const tdActor = document.createElement('td');
    tdActor.textContent = entry.username;
    tr.appendChild(tdActor);

    const tdAction = document.createElement('td');
    tdAction.textContent = getLocalizedEnum('action', entry.action);
    tr.appendChild(tdAction);

    const tdIP = document.createElement('td');
    tdIP.className = 'mono-cell';
    tdIP.textContent = entry.ipAddress || entry.client || '-';
    tr.appendChild(tdIP);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  tableContainer.appendChild(table);

  container.appendChild(tableContainer);
}

// 6. Imports View (GET /api/manage/imports or /api/admin/imports)
async function renderImportsView(container) {
  const isAdmin = Boolean(state.currentUser && state.currentUser.role === 'admin');
  const endpoint = isAdmin ? '/api/admin/imports' : '/api/manage/imports';

  let imports = null;
  let isUnavailable = false;

  const loadHistory = async () => {
    try {
      const res = await apiRequest(endpoint);
      if (res && res.data) {
        const raw = res.data;
        const rawList = Array.isArray(raw) ? raw : (Array.isArray(raw.items) ? raw.items : null);
        if (rawList) {
          imports = rawList;
        } else {
          isUnavailable = true;
        }
      } else {
        isUnavailable = true;
      }
    } catch {
      isUnavailable = true;
    }
  };

  await loadHistory();

  container.replaceChildren();
  container.appendChild(createHeader('imports.title', 'imports.subtitle', () => renderManagementView('imports')));

  if (isUnavailable) {
    container.appendChild(createStateCard('imports.unavailableTitle', 'imports.unavailableDesc', true));
    return;
  }

  // Admin: Staged Migration Wizard
  if (isAdmin) {
    const wizardContainer = document.createElement('div');
    wizardContainer.className = 'staged-wizard-container';
    renderStagedWizardComponent(wizardContainer, async () => {
      await loadHistory();
      renderHistorySection();
    });
    container.appendChild(wizardContainer);
  }

  const historyContainer = document.createElement('div');
  historyContainer.id = 'imports-history-container';
  container.appendChild(historyContainer);

  function renderHistorySection() {
    historyContainer.replaceChildren();

    if (isAdmin) {
      const historyHeader = document.createElement('h3');
      historyHeader.className = 'staged-wizard-title';
      historyHeader.textContent = t('imports.historyTitle', null, 'Import Receipts & History');
      historyContainer.appendChild(historyHeader);
    }

    if (!imports || imports.length === 0) {
      historyContainer.appendChild(createStateCard('imports.emptyTitle', 'imports.emptyDesc'));
      return;
    }

    const tableContainer = document.createElement('div');
    tableContainer.className = 'data-table-container';
    const table = document.createElement('table');
    table.className = 'data-table';

    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');
    const cols = ['User', 'Importer Version', 'Status', 'Messages (Imported / Source)', 'Attachments', 'Imported At'];
    const colKeys = ['imports.colUser', 'imports.colVersion', 'common.status', 'imports.colMessages', 'imports.colAttachments', 'imports.colImportedAt'];
    cols.forEach((col, idx) => {
      const th = document.createElement('th');
      th.textContent = t(colKeys[idx], null, col);
      trHead.appendChild(th);
    });
    thead.appendChild(trHead);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    imports.forEach((imp) => {
      if (!imp || typeof imp !== 'object') {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 6;
        td.className = 'text-muted';
        td.textContent = t('common.invalidRecord', null, getLocale() === 'zh-CN' ? '无效记录' : 'Invalid record');
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }

      const tr = document.createElement('tr');

      const tdUser = document.createElement('td');
      tdUser.className = 'mono-cell';
      tdUser.textContent = imp.username || imp.userId || '-';
      tr.appendChild(tdUser);

      const tdVersion = document.createElement('td');
      const verText = imp.importerVersion
        ? `${imp.importerVersion}${imp.sessionFormat !== undefined ? ` (fmt ${imp.sessionFormat})` : ''}`
        : '-';
      tdVersion.textContent = verText;
      tr.appendChild(tdVersion);

      const tdStatus = document.createElement('td');
      const statusText = imp.status || 'completed';
      tdStatus.appendChild(createBadgeElement(statusText, statusText === 'completed' ? 'success' : 'muted'));
      tr.appendChild(tdStatus);

      const tdItems = document.createElement('td');
      const importedCount = imp.importedMessagesCount !== undefined ? imp.importedMessagesCount : (imp.records !== undefined ? imp.records : (imp.itemCount !== undefined ? imp.itemCount : '-'));
      const totalCount = imp.sourceMessagesCount !== undefined ? imp.sourceMessagesCount : '-';
      const droppedCount = imp.droppedMessagesCount ? ` (${imp.droppedMessagesCount} ${getLocale() === 'zh-CN' ? '条丢弃' : 'dropped'})` : '';
      tdItems.textContent = (importedCount === '-' && totalCount === '-') ? '-' : `${importedCount !== '-' ? formatNumber(importedCount) : '-'} / ${totalCount !== '-' ? formatNumber(totalCount) : '-'}${droppedCount}`;
      tr.appendChild(tdItems);

      const tdAttach = document.createElement('td');
      tdAttach.textContent = imp.attachmentsCount !== undefined ? formatNumber(imp.attachmentsCount) : '0';
      tr.appendChild(tdAttach);

      const tdTime = document.createElement('td');
      tdTime.textContent = imp.createdAt ? formatDate(imp.createdAt) : '-';
      tr.appendChild(tdTime);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableContainer.appendChild(table);

    historyContainer.appendChild(tableContainer);
  }

  renderHistorySection();
}

/**
 * Interactive 5-Step Staged HappyClaw Migration Wizard Component
 */
function renderStagedWizardComponent(container, onCompleteRefresh) {
  const wizard = {
    step: 1,
    mode: 'pilot-v2', // 'pilot-v2' | 'v1'
    stagedFiles: [],
    selectedStagedId: null,
    selectedStagedItem: null,
    inspectData: null,
    v2InspectData: null,
    selectedKeys: new Set(),
    selectedWorkspaceIds: new Set(),
    v2Scopes: {
      coreData: true,
      extensions: true,
      tasks: true,
      channelsMetadata: true,
      credentials: false,
    },
    searchQuery: '',
    targetUserId: state.currentUser ? state.currentUser.id : 'alice',
    targetSpace: '',
    titleOverride: '',
    dryRunResult: null,
    v2DryRunResult: null,
    v2StageResult: null,
    credentialStatusList: [],
    credentialCapabilityToken: 'cap_' + ((typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID().slice(0, 8) : 'demo1234'),
    migrationResult: null,
    jobId: null,
    isLoading: false,
    page: 0,
    pageSize: 15,
  };

  const updateView = () => {
    container.replaceChildren();

    // 1. Wizard Header & Step Tracker
    const header = document.createElement('div');
    header.className = 'staged-wizard-header';

    const titleWrap = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'staged-wizard-title';
    title.textContent = wizard.mode === 'pilot-v2'
      ? t('imports.pilotV2Title', null, 'Migration Pilot V2')
      : t('imports.wizardTitle', null, 'Staged HappyClaw Migration');
    const sub = document.createElement('div');
    sub.className = 'staged-wizard-subtitle';
    sub.textContent = wizard.mode === 'pilot-v2'
      ? t('imports.pilotV2Subtitle', null, 'Scoped workspace-level pilot migration (P1-7 readiness, zero real cutover)')
      : t('imports.wizardSubtitle', null, 'Step-by-step migration from operator-staged HappyClaw SQLite databases');
    titleWrap.appendChild(title);
    titleWrap.appendChild(sub);
    header.appendChild(titleWrap);
    container.appendChild(header);

    const stepsNav = document.createElement('div');
    stepsNav.className = 'staged-wizard-steps';
    const stepDefs = [
      { num: 1, key: 'imports.stepSelect', label: '1. Select Database' },
      { num: 2, key: 'imports.stepInspect', label: wizard.mode === 'pilot-v2' ? '2. Workspaces & Scopes' : '2. Inspect & Filter' },
      { num: 3, key: 'imports.stepTarget', label: wizard.mode === 'pilot-v2' ? '3. Plan, Credentials & Stage' : '3. Target & Plan' },
      { num: 4, key: 'imports.stepMigrate', label: '4. Migrate' },
      { num: 5, key: 'imports.stepComplete', label: '5. Completed' },
    ];
    stepDefs.forEach((sd) => {
      // In pilot-v2 mode, step 4 is bypassed as execution is for P1-8
      if (wizard.mode === 'pilot-v2' && sd.num === 4) return;

      const stepEl = document.createElement('div');
      stepEl.className = 'staged-wizard-step';
      if (wizard.step === sd.num) stepEl.classList.add('active');
      if (wizard.step > sd.num) stepEl.classList.add('completed');

      const numBadge = document.createElement('span');
      numBadge.className = 'staged-wizard-step-num';
      numBadge.textContent = wizard.step > sd.num ? '✓' : String(sd.num);
      stepEl.appendChild(numBadge);

      const labelSpan = document.createElement('span');
      labelSpan.textContent = t(sd.key, null, sd.label);
      stepEl.appendChild(labelSpan);

      stepsNav.appendChild(stepEl);
    });
    container.appendChild(stepsNav);

    // 2. Render Active Step Content
    if (wizard.step === 1) {
      renderStep1(container);
    } else if (wizard.step === 2) {
      if (wizard.mode === 'pilot-v2') {
        renderStep2V2(container);
      } else {
        renderStep2(container);
      }
    } else if (wizard.step === 3) {
      if (wizard.mode === 'pilot-v2') {
        renderStep3V2(container);
      } else {
        renderStep3(container);
      }
    } else if (wizard.step === 4) {
      renderStep4(container);
    } else if (wizard.step === 5) {
      renderStep5(container);
    }
  };

  // Step 1: Select Staged DB / Upload / Mode Toggle
  const renderStep1 = (root) => {
    const listWrap = document.createElement('div');

    // Mode Selector Toolbar
    const modeToolbar = document.createElement('div');
    modeToolbar.className = 'btn-group staged-mode-toolbar';

    const btnPilotV2 = document.createElement('button');
    btnPilotV2.type = 'button';
    btnPilotV2.className = `btn btn-sm ${wizard.mode === 'pilot-v2' ? 'btn-primary' : 'btn-secondary'}`;
    btnPilotV2.textContent = t('imports.modePilotV2', null, 'Pilot V2 (Workspaces & Scopes)');
    btnPilotV2.addEventListener('click', () => {
      wizard.mode = 'pilot-v2';
      updateView();
    });

    const btnStandardV1 = document.createElement('button');
    btnStandardV1.type = 'button';
    btnStandardV1.className = `btn btn-sm ${wizard.mode === 'v1' ? 'btn-primary' : 'btn-secondary'}`;
    btnStandardV1.textContent = t('imports.modeStandard', null, 'Standard V1 (Chats)');
    btnStandardV1.addEventListener('click', () => {
      wizard.mode = 'v1';
      updateView();
    });

    modeToolbar.appendChild(btnPilotV2);
    modeToolbar.appendChild(btnStandardV1);
    listWrap.appendChild(modeToolbar);

    if (wizard.stagedFiles.length === 0) {
      const guidance = document.createElement('div');
      guidance.className = 'staged-info-banner';
      const gTitle = document.createElement('strong');
      gTitle.textContent = `${t('imports.guidanceTitle', null, 'Operator Staging Guidance')}: `;
      const gDesc = document.createElement('span');
      gDesc.textContent = t('imports.guidanceDesc', null, 'Place SQLite database files into the configured staging directory on the host, or upload a .db file below.');
      guidance.appendChild(gTitle);
      guidance.appendChild(gDesc);
      listWrap.appendChild(guidance);

      const emptyNotice = document.createElement('div');
      emptyNotice.className = 'text-muted';
      emptyNotice.textContent = t('imports.noStagedFound', null, 'No staged databases found in staging directories.');
      listWrap.appendChild(emptyNotice);
    } else {
      const dbList = document.createElement('div');
      dbList.className = 'staged-db-list';

      wizard.stagedFiles.forEach((file) => {
        const item = document.createElement('div');
        item.className = 'staged-db-item';
        if (wizard.selectedStagedId === file.stagedId) {
          item.classList.add('selected');
        }

        item.addEventListener('click', () => {
          wizard.selectedStagedId = file.stagedId;
          wizard.selectedStagedItem = file;
          updateView();
        });

        const info = document.createElement('div');
        info.className = 'staged-db-info';

        const nameEl = document.createElement('div');
        nameEl.className = 'staged-db-name';
        nameEl.textContent = `📦 ${file.name}`;
        info.appendChild(nameEl);

        const metaEl = document.createElement('div');
        metaEl.className = 'staged-db-meta';
        const sizeSpan = document.createElement('span');
        sizeSpan.textContent = formatBytes(file.size);
        const mtimeSpan = document.createElement('span');
        mtimeSpan.textContent = formatDate(file.mtime);
        metaEl.appendChild(sizeSpan);
        metaEl.appendChild(mtimeSpan);
        info.appendChild(metaEl);

        item.appendChild(info);

        const statusBadge = createBadgeElement(
          file.inspectionStatus,
          file.inspectionStatus === 'ready' ? 'success' : (file.inspectionStatus === 'invalid' ? 'danger' : 'muted')
        );
        item.appendChild(statusBadge);

        dbList.appendChild(item);
      });
      listWrap.appendChild(dbList);
    }

    // Upload Box
    const uploadBox = document.createElement('div');
    uploadBox.className = 'staged-upload-box';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.db,.sqlite';
    fileInput.className = 'staged-file-input';

    const uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.className = 'btn btn-secondary btn-sm';
    uploadBtn.textContent = t('imports.btnUpload', null, 'Upload');

    uploadBtn.addEventListener('click', async () => {
      if (!fileInput.files || fileInput.files.length === 0) return;
      const file = fileInput.files[0];
      uploadBtn.disabled = true;
      uploadBtn.textContent = `${t('imports.btnUpload', null, 'Upload')}...`;

      try {
        const csrf = state.csrfToken || '';
        const res = await fetch('/api/admin/imports/staged/upload', {
          method: 'POST',
          headers: {
            'X-Enkeep-CSRF': csrf,
            'X-Filename': file.name,
            'Content-Type': 'application/octet-stream',
          },
          body: file,
        });
        const json = await res.json();
        if (!res.ok || json.error) {
          throw new Error(json.error ? json.error.message : 'Upload failed');
        }
        await loadStagedFiles();
        if (json.data && json.data.stagedId) {
          wizard.selectedStagedId = json.data.stagedId;
          wizard.selectedStagedItem = json.data;
        }
        showToast(t('common.success', null, 'Uploaded successfully'), 'success');
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        uploadBtn.disabled = false;
        uploadBtn.textContent = t('imports.btnUpload', null, 'Upload');
        updateView();
      }
    });

    uploadBox.appendChild(fileInput);
    uploadBox.appendChild(uploadBtn);
    listWrap.appendChild(uploadBox);
    root.appendChild(listWrap);

    // Actions Bar
    const actions = document.createElement('div');
    actions.className = 'staged-actions-bar';

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'btn btn-secondary btn-sm';
    refreshBtn.textContent = t('imports.btnRefresh', null, 'Refresh Staged Files');
    refreshBtn.addEventListener('click', async () => {
      await loadStagedFiles();
      updateView();
    });
    actions.appendChild(refreshBtn);

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'btn btn-primary btn-sm';
    nextBtn.textContent = wizard.mode === 'pilot-v2'
      ? t('imports.btnNextInspectV2', null, 'Next: Inspect Workspaces (V2)')
      : t('imports.btnNextInspect', null, 'Next: Inspect Database');
    nextBtn.disabled = !wizard.selectedStagedId || (wizard.selectedStagedItem && wizard.selectedStagedItem.inspectionStatus === 'invalid');

    nextBtn.addEventListener('click', async () => {
      nextBtn.disabled = true;
      nextBtn.textContent = `${t('imports.btnNextInspect', null, 'Next')}...`;
      try {
        if (wizard.mode === 'pilot-v2') {
          const res = await apiRequest(`/api/manage/migrations/happyclaw/inspect`, {
            method: 'POST',
            body: { stagedId: wizard.selectedStagedId },
          });
          if (res && res.data) {
            wizard.v2InspectData = res.data;
            wizard.selectedWorkspaceIds.clear();
            if (Array.isArray(res.data.workspaces)) {
              res.data.workspaces.forEach((w) => wizard.selectedWorkspaceIds.add(w.workspaceId));
            }
            wizard.step = 2;
            updateView();
          }
        } else {
          const res = await apiRequest(`/api/admin/imports/staged/${wizard.selectedStagedId}/inspect`, {
            method: 'POST',
            body: { limit: 200, offset: 0 },
          });
          if (res && res.data) {
            wizard.inspectData = res.data;
            wizard.selectedKeys.clear();
            if (Array.isArray(res.data.conversations)) {
              res.data.conversations.forEach((c) => wizard.selectedKeys.add(c.sourceKey));
            }
            wizard.step = 2;
            updateView();
          }
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
        nextBtn.disabled = false;
        nextBtn.textContent = t('imports.btnNextInspect', null, 'Next: Inspect Database');
      }
    });

    actions.appendChild(nextBtn);
    root.appendChild(actions);
  };

  // Step 2 (Pilot V2): Workspace Checklist & Scope Summary
  const renderStep2V2 = (root) => {
    const insp = wizard.v2InspectData;
    if (!insp) return;

    // Summary Cards
    const summaryGrid = document.createElement('div');
    summaryGrid.className = 'staged-schema-summary';

    const cards = [
      { label: t('imports.colWorkspaces', null, 'Workspaces'), val: String(insp.totalWorkspaces) },
      { label: t('imports.totalMessages', null, 'Messages'), val: formatNumber(insp.totalMessages) },
      { label: t('imports.scopeExtensions', null, 'Extensions'), val: String(insp.totalExtensions) },
      { label: t('imports.scopeTasks', null, 'Tasks'), val: String(insp.totalTasks) },
      { label: t('imports.scopeChannelsMetadata', null, 'Channels'), val: String(insp.totalChannels) },
    ];

    cards.forEach((c) => {
      const card = document.createElement('div');
      card.className = 'staged-schema-card';
      const lbl = document.createElement('span');
      lbl.className = 'staged-schema-card-label';
      lbl.textContent = c.label;
      const v = document.createElement('span');
      v.className = 'staged-schema-card-val';
      v.textContent = c.val;
      card.appendChild(lbl);
      card.appendChild(v);
      summaryGrid.appendChild(card);
    });
    root.appendChild(summaryGrid);

    // Scopes Selector Card
    const scopeCard = document.createElement('div');
    scopeCard.className = 'card staged-scope-card';

    const scopeTitle = document.createElement('h4');
    scopeTitle.className = 'staged-scope-title';
    scopeTitle.textContent = t('imports.scopeSummaryTitle', null, 'Pilot Scope Selector');
    scopeCard.appendChild(scopeTitle);

    const scopesGrid = document.createElement('div');
    scopesGrid.className = 'staged-scope-grid';

    const scopeEntries = [
      { key: 'coreData', label: t('imports.scopeCoreData', null, 'Core Data (Users, Spaces, Profiles, Messages)') },
      { key: 'extensions', label: t('imports.scopeExtensions', null, 'Extensions (Skills, MCP, Plugins with Auto-Quarantine)') },
      { key: 'tasks', label: t('imports.scopeTasks', null, 'Scheduled Tasks') },
      { key: 'channelsMetadata', label: t('imports.scopeChannelsMetadata', null, 'Channel Metadata (Cutover Deferred)') },
      { key: 'credentials', label: t('imports.scopeCredentials', null, 'Credential Transfer (One-Time Capability)') },
    ];

    scopeEntries.forEach((se) => {
      const lbl = document.createElement('label');
      lbl.className = 'staged-scope-label';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = wizard.v2Scopes[se.key];
      chk.addEventListener('change', () => {
        wizard.v2Scopes[se.key] = chk.checked;
      });
      lbl.appendChild(chk);
      lbl.appendChild(document.createTextNode(se.label));
      scopesGrid.appendChild(lbl);
    });
    scopeCard.appendChild(scopesGrid);
    root.appendChild(scopeCard);

    // Workspace Checklist Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'staged-table-toolbar';

    const btnGroup = document.createElement('div');
    btnGroup.className = 'btn-group';

    const allWorkspaces = Array.isArray(insp.workspaces) ? insp.workspaces : [];

    const selectAllBtn = document.createElement('button');
    selectAllBtn.type = 'button';
    selectAllBtn.className = 'btn btn-secondary btn-xs';
    selectAllBtn.textContent = t('imports.selectAll', { count: allWorkspaces.length }, `Select All (${allWorkspaces.length})`);
    selectAllBtn.addEventListener('click', () => {
      allWorkspaces.forEach((w) => wizard.selectedWorkspaceIds.add(w.workspaceId));
      renderWsTableBody();
      updateWsActionBar();
    });

    const deselectAllBtn = document.createElement('button');
    deselectAllBtn.type = 'button';
    deselectAllBtn.className = 'btn btn-secondary btn-xs';
    deselectAllBtn.textContent = t('imports.deselectAll', null, 'Deselect All');
    deselectAllBtn.addEventListener('click', () => {
      wizard.selectedWorkspaceIds.clear();
      renderWsTableBody();
      updateWsActionBar();
    });

    const selCountSpan = document.createElement('span');
    selCountSpan.className = 'badge badge-info';
    selCountSpan.id = 'staged-v2-sel-count';
    selCountSpan.textContent = t('imports.workspacesSelected', { count: wizard.selectedWorkspaceIds.size }, `${wizard.selectedWorkspaceIds.size} Workspaces Selected`);

    btnGroup.appendChild(selectAllBtn);
    btnGroup.appendChild(deselectAllBtn);
    btnGroup.appendChild(selCountSpan);
    toolbar.appendChild(btnGroup);
    root.appendChild(toolbar);

    // Workspace Table
    const tableContainer = document.createElement('div');
    tableContainer.className = 'data-table-container';
    const table = document.createElement('table');
    table.className = 'data-table';

    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');

    const thCheck = document.createElement('th');
    thCheck.className = 'th-checkbox';
    trHead.appendChild(thCheck);

    const cols = ['Workspace', 'Folder', 'Messages', 'Extensions', 'Tasks', 'Channels'];
    cols.forEach((col) => {
      const th = document.createElement('th');
      th.textContent = col;
      trHead.appendChild(th);
    });
    thead.appendChild(trHead);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    tableContainer.appendChild(table);
    root.appendChild(tableContainer);

    function renderWsTableBody() {
      tbody.replaceChildren();
      allWorkspaces.forEach((ws) => {
        const tr = document.createElement('tr');

        const tdCheck = document.createElement('td');
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = wizard.selectedWorkspaceIds.has(ws.workspaceId);
        chk.addEventListener('change', () => {
          if (chk.checked) {
            wizard.selectedWorkspaceIds.add(ws.workspaceId);
          } else {
            wizard.selectedWorkspaceIds.delete(ws.workspaceId);
          }
          const cntEl = document.getElementById('staged-v2-sel-count');
          if (cntEl) {
            cntEl.textContent = t('imports.workspacesSelected', { count: wizard.selectedWorkspaceIds.size }, `${wizard.selectedWorkspaceIds.size} Workspaces Selected`);
          }
          updateWsActionBar();
        });
        tdCheck.appendChild(chk);
        tr.appendChild(tdCheck);

        const tdName = document.createElement('td');
        tdName.textContent = ws.name || ws.workspaceId;
        tr.appendChild(tdName);

        const tdFolder = document.createElement('td');
        tdFolder.textContent = ws.folder;
        tr.appendChild(tdFolder);

        const tdMsg = document.createElement('td');
        tdMsg.textContent = String(ws.messageCount);
        tr.appendChild(tdMsg);

        const tdExt = document.createElement('td');
        tdExt.textContent = `Skills: ${ws.skillsCount} | MCP: ${ws.mcpCount} | Plugins: ${ws.pluginsCount}`;
        tr.appendChild(tdExt);

        const tdTask = document.createElement('td');
        tdTask.textContent = String(ws.tasksCount);
        tr.appendChild(tdTask);

        const tdChan = document.createElement('td');
        tdChan.textContent = Array.isArray(ws.channels) ? ws.channels.join(', ') : 'none';
        tr.appendChild(tdChan);

        tbody.appendChild(tr);
      });
    }

    renderWsTableBody();

    // Actions Bar
    const actions = document.createElement('div');
    actions.className = 'staged-actions-bar';

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'btn btn-secondary btn-sm';
    backBtn.textContent = t('imports.btnBack', null, 'Back');
    backBtn.addEventListener('click', () => {
      wizard.step = 1;
      updateView();
    });
    actions.appendChild(backBtn);

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'btn btn-primary btn-sm';
    nextBtn.id = 'staged-v2-step2-next';
    nextBtn.textContent = t('imports.btnNextPlan', null, 'Next: Target & Dry-Run Plan');
    nextBtn.disabled = wizard.selectedWorkspaceIds.size === 0;

    nextBtn.addEventListener('click', () => {
      wizard.step = 3;
      updateView();
    });

    actions.appendChild(nextBtn);
    root.appendChild(actions);

    function updateWsActionBar() {
      const btn = document.getElementById('staged-v2-step2-next');
      if (btn) {
        btn.disabled = wizard.selectedWorkspaceIds.size === 0;
      }
    }
  };

  // Step 3 (Pilot V2): Dry-Run Preview, Credential Authorization & Package Staging
  const renderStep3V2 = (root) => {
    const formWrap = document.createElement('div');

    const grpUser = document.createElement('div');
    grpUser.className = 'form-group';
    const lblUser = document.createElement('label');
    lblUser.textContent = t('imports.targetUser', null, 'Target User ID');
    const inputUser = document.createElement('input');
    inputUser.type = 'text';
    inputUser.id = 'staged-target-user';
    inputUser.value = wizard.targetUserId;
    inputUser.addEventListener('input', (e) => {
      wizard.targetUserId = e.target.value;
    });
    grpUser.appendChild(lblUser);
    grpUser.appendChild(inputUser);
    formWrap.appendChild(grpUser);

    // Credential Authorization & Status Section (Strict Zero Secrets)
    const credCard = document.createElement('div');
    credCard.className = 'card staged-cred-card';

    const credTitle = document.createElement('h4');
    credTitle.className = 'staged-scope-title';
    credTitle.textContent = t('imports.credentialAuthStatus', null, 'Credential Transfer Status (Zero Secret Exposure)');
    credCard.appendChild(credTitle);

    const credDesc = document.createElement('p');
    credDesc.className = 'text-muted staged-cred-desc';
    credDesc.textContent = 'Admin capability token is used in-memory only. Credentials are transformed into encrypted vault references without browser or log exposure.';
    credCard.appendChild(credDesc);

    const credBtn = document.createElement('button');
    credBtn.type = 'button';
    credBtn.className = 'btn btn-secondary btn-sm';
    credBtn.textContent = t('imports.btnAuthorizeCredentials', null, 'Authorize & Encrypt Credentials');
    const credStatusBox = document.createElement('div');
    credStatusBox.className = 'staged-cred-status-box';

    credBtn.addEventListener('click', async () => {
      credBtn.disabled = true;
      credBtn.textContent = `${t('imports.btnAuthorizeCredentials', null, 'Authorizing')}...`;
      try {
        const res = await apiRequest('/api/manage/migrations/happyclaw/authorize-credentials', {
          method: 'POST',
          body: {
            stagedId: wizard.selectedStagedId,
            targetUserId: wizard.targetUserId || 'alice',
            capability: {
              capabilityToken: wizard.credentialCapabilityToken,
              sourceProviderRef: 'happyclaw-hpc-vault-ref',
              authorizedCredentialIds: ['cred_alice_lark', 'cred_bob_wechat', 'cred_charlie_lark'],
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
              singleUse: true,
              issuedBy: state.currentUser ? state.currentUser.username : 'admin',
            },
          },
        });
        if (res && res.data) {
          wizard.credentialStatusList = res.data.credentials || [];
          renderCredentialStatuses(credStatusBox, res.data);
          showToast(t('common.success', null, 'Credentials authorized and encrypted successfully'), 'success');
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        credBtn.disabled = false;
        credBtn.textContent = t('imports.btnAuthorizeCredentials', null, 'Authorize & Encrypt Credentials');
      }
    });

    credCard.appendChild(credBtn);
    credCard.appendChild(credStatusBox);
    formWrap.appendChild(credCard);

    // Dry Run Button & Preview Container
    const dryRunBtn = document.createElement('button');
    dryRunBtn.type = 'button';
    dryRunBtn.className = 'btn btn-secondary btn-sm';
    dryRunBtn.textContent = t('imports.btnRunPilotDryRun', null, 'Run Pilot V2 Dry-Run');

    const dryRunResultBox = document.createElement('div');
    dryRunResultBox.id = 'staged-v2-dryrun-result';
    if (wizard.v2DryRunResult) {
      renderV2DryRunDetails(dryRunResultBox, wizard.v2DryRunResult);
    }

    dryRunBtn.addEventListener('click', async () => {
      dryRunBtn.disabled = true;
      dryRunBtn.textContent = `${t('imports.btnRunPilotDryRun', null, 'Running Dry-Run')}...`;
      try {
        const res = await apiRequest('/api/manage/migrations/happyclaw/dry-run', {
          method: 'POST',
          body: {
            stagedId: wizard.selectedStagedId,
            targetUserId: wizard.targetUserId || 'alice',
            selectedWorkspaceIds: Array.from(wizard.selectedWorkspaceIds),
            scopes: wizard.v2Scopes,
          },
        });
        if (res && res.data && res.data.plan) {
          wizard.v2DryRunResult = res.data.plan;
          renderV2DryRunDetails(dryRunResultBox, res.data.plan);
          showToast(t('common.success', null, 'Pilot V2 dry run calculated successfully'), 'success');
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        dryRunBtn.disabled = false;
        dryRunBtn.textContent = t('imports.btnRunPilotDryRun', null, 'Run Pilot V2 Dry-Run');
      }
    });

    formWrap.appendChild(dryRunBtn);
    formWrap.appendChild(dryRunResultBox);

    // Stage Pilot Package Button
    const stageBtn = document.createElement('button');
    stageBtn.type = 'button';
    stageBtn.className = 'btn btn-primary btn-sm staged-margin-lg';
    stageBtn.textContent = t('imports.btnStagePilotPackage', null, 'Stage Pilot Package (P1-8 Ready)');

    const stageResultBox = document.createElement('div');
    stageResultBox.id = 'staged-v2-stage-result';

    stageBtn.addEventListener('click', async () => {
      stageBtn.disabled = true;
      stageBtn.textContent = `${t('imports.btnStagePilotPackage', null, 'Staging')}...`;
      try {
        const res = await apiRequest('/api/manage/migrations/happyclaw/stage', {
          method: 'POST',
          body: {
            stagedId: wizard.selectedStagedId,
            targetUserId: wizard.targetUserId || 'alice',
            selectedWorkspaceIds: Array.from(wizard.selectedWorkspaceIds),
            scopes: wizard.v2Scopes,
          },
        });
        if (res && res.data) {
          wizard.v2StageResult = res.data;
          renderV2StageDetails(stageResultBox, res.data);
          showToast(t('imports.stageSuccessTitle', null, 'Pilot package staged successfully'), 'success');
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        stageBtn.disabled = false;
        stageBtn.textContent = t('imports.btnStagePilotPackage', null, 'Stage Pilot Package (P1-8 Ready)');
      }
    });

    formWrap.appendChild(stageBtn);
    formWrap.appendChild(stageResultBox);
    root.appendChild(formWrap);

    // Actions Bar
    const actions = document.createElement('div');
    actions.className = 'staged-actions-bar';

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'btn btn-secondary btn-sm';
    backBtn.textContent = t('imports.btnBack', null, 'Back');
    backBtn.addEventListener('click', () => {
      wizard.step = 2;
      updateView();
    });
    actions.appendChild(backBtn);
    root.appendChild(actions);
  };

  function renderCredentialStatuses(box, data) {
    box.replaceChildren();
    const list = document.createElement('div');
    list.className = 'staged-cred-list';

    (data.credentials || []).forEach((c) => {
      const item = document.createElement('div');
      item.className = 'staged-cred-item';

      const nameSpan = document.createElement('span');
      nameSpan.textContent = `🔑 ${c.credentialId} (${c.channelType})`;
      item.appendChild(nameSpan);

      const statusBadge = createBadgeElement(
        c.status,
        c.status === 'transferred' ? 'success' : (c.status === 'reauthorization_required' ? 'warning' : 'danger')
      );
      item.appendChild(statusBadge);
      list.appendChild(item);
    });
    box.appendChild(list);
  }

  function renderV2DryRunDetails(box, plan) {
    box.replaceChildren();
    const card = document.createElement('div');
    card.className = 'staged-info-banner staged-margin-top';

    const pTitle = document.createElement('strong');
    pTitle.textContent = `Deterministic Plan ID: ${plan.planId}\n`;
    const pDetails = document.createElement('div');
    pDetails.textContent = `Workspaces: ${plan.summary.totalWorkspaces} | Messages: ${plan.summary.totalMessages} | Extensions: ${plan.summary.totalExtensions} | Quarantined Plugins: ${plan.summary.totalQuarantinedPlugins}`;

    card.appendChild(pTitle);
    card.appendChild(pDetails);

    if (plan.summary.totalQuarantinedPlugins > 0) {
      const qNotice = document.createElement('div');
      qNotice.className = 'staged-margin-top-sm';
      qNotice.appendChild(createBadgeElement(t('imports.quarantinedBadge', null, 'Quarantined (Security Policy)'), 'warning'));
      card.appendChild(qNotice);
    }

    box.appendChild(card);
  }

  function renderV2StageDetails(box, data) {
    box.replaceChildren();
    const card = document.createElement('div');
    card.className = 'staged-success-card staged-margin-top';

    const title = document.createElement('h4');
    title.textContent = t('imports.stageSuccessTitle', null, 'Pilot Package Staged Successfully');
    const desc = document.createElement('p');
    desc.textContent = t('imports.stageSuccessDesc', null, 'Immutable staged package created with verified checksum. Ready for P1-8 pilot execution. Live database was not mutated.');
    const chk = document.createElement('code');
    chk.textContent = `Checksum: ${data.packageChecksum}`;

    card.appendChild(title);
    card.appendChild(desc);
    card.appendChild(chk);

    // Button group for Pilot Actions
    const btnGroup = document.createElement('div');
    btnGroup.className = 'staged-margin-top staged-flex-row';

    const execBtn = document.createElement('button');
    execBtn.type = 'button';
    execBtn.className = 'btn btn-primary btn-sm';
    execBtn.textContent = t('imports.btnExecutePilot', null, 'Execute Pilot Migration');

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-danger btn-sm staged-margin-left';
    deleteBtn.textContent = t('imports.btnDeletePilotData', null, 'Delete Pilot Data');

    const pilotStatusBox = document.createElement('div');
    pilotStatusBox.className = 'staged-margin-top';

    execBtn.addEventListener('click', async () => {
      execBtn.disabled = true;
      execBtn.textContent = `${t('imports.btnExecutePilot', null, 'Executing Pilot')}...`;
      try {
        const res = await apiRequest('/api/manage/migrations/happyclaw/execute-pilot', {
          method: 'POST',
          body: { planId: data.planId },
        });
        if (res && res.data) {
          showToast(t('imports.pilotExecSuccess', null, 'Pilot migration executed successfully'), 'success');
          pilotStatusBox.replaceChildren();
          const info = document.createElement('div');
          info.className = 'staged-info-banner';
          info.textContent = `Pilot Executed! Workspaces: ${res.data.stats?.workspaces || 0}, Sessions: ${res.data.stats?.sessions || 0}, Messages: ${res.data.stats?.messages || 0}, Files: ${res.data.stats?.files || 0}`;
          pilotStatusBox.appendChild(info);
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        execBtn.disabled = false;
        execBtn.textContent = t('imports.btnExecutePilot', null, 'Execute Pilot Migration');
      }
    });

    deleteBtn.addEventListener('click', async () => {
      deleteBtn.disabled = true;
      deleteBtn.textContent = `${t('imports.btnDeletePilotData', null, 'Cleaning')}...`;
      try {
        const res = await apiRequest(`/api/manage/migrations/happyclaw/pilot/${data.planId}`, {
          method: 'DELETE',
        });
        if (res && res.data) {
          showToast(t('imports.pilotDeleteSuccess', null, 'Pilot migration data cleaned up successfully'), 'success');
          pilotStatusBox.replaceChildren();
          const info = document.createElement('div');
          info.className = 'staged-info-banner';
          info.textContent = `Pilot Data Removed! Cleaned ${res.data.deletedCounts?.spaces || 0} spaces, ${res.data.deletedCounts?.sessionRoutes || 0} sessions, ${res.data.deletedCounts?.extensions || 0} extensions.`;
          pilotStatusBox.appendChild(info);
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        deleteBtn.disabled = false;
        deleteBtn.textContent = t('imports.btnDeletePilotData', null, 'Delete Pilot Data');
      }
    });

    btnGroup.appendChild(execBtn);
    btnGroup.appendChild(deleteBtn);
    card.appendChild(btnGroup);
    card.appendChild(pilotStatusBox);

    box.appendChild(card);
  }

  // Step 2: Inspect Schema, Diagnostic & Select Conversations
  const renderStep2 = (root) => {
    const insp = wizard.inspectData;
    if (!insp) return;

    // Schema Summary Cards
    const summaryGrid = document.createElement('div');
    summaryGrid.className = 'staged-schema-summary';

    const cards = [
      { label: t('imports.schemaCompatibility', null, 'Compatibility'), val: insp.diagnostic.compatibilityLevel },
      { label: t('imports.schemaVersion', null, 'Schema Version'), val: insp.diagnostic.detectedSchemaVersion !== null ? `v${insp.diagnostic.detectedSchemaVersion}` : 'Legacy' },
      { label: t('imports.totalChats', null, 'Total Conversations'), val: formatNumber(insp.totalConversations) },
      { label: t('imports.totalMessages', null, 'Total Messages'), val: formatNumber(insp.totalMessages) },
      { label: t('imports.totalAttachments', null, 'Total Attachments'), val: formatNumber(insp.totalAttachments) },
    ];

    cards.forEach((c) => {
      const card = document.createElement('div');
      card.className = 'staged-schema-card';
      const lbl = document.createElement('span');
      lbl.className = 'staged-schema-card-label';
      lbl.textContent = c.label;
      const v = document.createElement('span');
      v.className = 'staged-schema-card-val';
      v.textContent = c.val;
      card.appendChild(lbl);
      card.appendChild(v);
      summaryGrid.appendChild(card);
    });
    root.appendChild(summaryGrid);

    // Schema diagnostic issues banner if any
    if (insp.diagnostic && Array.isArray(insp.diagnostic.issues) && insp.diagnostic.issues.length > 0) {
      const diagBanner = document.createElement('div');
      diagBanner.className = 'staged-notice-banner';
      const dTitle = document.createElement('strong');
      dTitle.textContent = `${t('imports.colWarnings', null, 'Warnings')}: `;
      const dList = document.createElement('span');
      dList.textContent = insp.diagnostic.issues.join(' | ');
      diagBanner.appendChild(dTitle);
      diagBanner.appendChild(dList);
      root.appendChild(diagBanner);
    }

    // Attachment Notice Banner (Requirement 4)
    const attachNotice = document.createElement('div');
    attachNotice.className = 'staged-info-banner';
    const aIcon = document.createElement('span');
    aIcon.textContent = '📎 ';
    const aText = document.createElement('span');
    aText.textContent = t('imports.attachmentNotice', null, 'Notice: Text transcripts and metadata will be migrated directly. Binary attachments referenced in chats will not be copied automatically unless files exist in space folders on host.');
    attachNotice.appendChild(aIcon);
    attachNotice.appendChild(aText);
    root.appendChild(attachNotice);

    // Toolbar (Search + Select All / Deselect All)
    const toolbar = document.createElement('div');
    toolbar.className = 'staged-table-toolbar';

    const searchBox = document.createElement('div');
    searchBox.className = 'staged-table-search';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = t('imports.searchPlaceholder', null, 'Search by title, key, or folder...');
    searchInput.value = wizard.searchQuery;
    searchInput.addEventListener('input', (e) => {
      wizard.searchQuery = e.target.value;
      wizard.page = 0;
      renderTableBody();
    });
    searchBox.appendChild(searchInput);
    toolbar.appendChild(searchBox);

    const btnGroup = document.createElement('div');
    btnGroup.className = 'btn-group';

    const allConversations = insp.conversations || [];
    const selectAllBtn = document.createElement('button');
    selectAllBtn.className = 'btn btn-secondary btn-xs';
    selectAllBtn.textContent = t('imports.selectAll', { count: allConversations.length }, `Select All (${allConversations.length})`);
    selectAllBtn.addEventListener('click', () => {
      allConversations.forEach((c) => wizard.selectedKeys.add(c.sourceKey));
      renderTableBody();
      updateActionBar();
    });

    const deselectAllBtn = document.createElement('button');
    deselectAllBtn.className = 'btn btn-secondary btn-xs';
    deselectAllBtn.textContent = t('imports.deselectAll', null, 'Deselect All');
    deselectAllBtn.addEventListener('click', () => {
      wizard.selectedKeys.clear();
      renderTableBody();
      updateActionBar();
    });

    const selCountSpan = document.createElement('span');
    selCountSpan.className = 'badge badge-info';
    selCountSpan.id = 'staged-sel-count';
    selCountSpan.textContent = t('imports.selectedCount', { count: wizard.selectedKeys.size }, `${wizard.selectedKeys.size} selected`);

    btnGroup.appendChild(selectAllBtn);
    btnGroup.appendChild(deselectAllBtn);
    btnGroup.appendChild(selCountSpan);
    toolbar.appendChild(btnGroup);
    root.appendChild(toolbar);

    // Conversations Table
    const tableContainer = document.createElement('div');
    tableContainer.className = 'data-table-container';
    const table = document.createElement('table');
    table.className = 'data-table';

    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');

    const thCheck = document.createElement('th');
    thCheck.className = 'th-checkbox';
    trHead.appendChild(thCheck);

    const cols = ['Conversation', 'Channel', 'Folder', 'Messages', 'Date Range', 'Warnings'];
    const colKeys = ['imports.colChat', 'imports.colChannel', 'imports.colFolder', 'imports.colMsgCount', 'imports.colDateRange', 'imports.colWarnings'];
    cols.forEach((col, idx) => {
      const th = document.createElement('th');
      th.textContent = t(colKeys[idx], null, col);
      trHead.appendChild(th);
    });
    thead.appendChild(trHead);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    tableContainer.appendChild(table);
    root.appendChild(tableContainer);

    function renderTableBody() {
      tbody.replaceChildren();
      let filtered = allConversations;
      if (wizard.searchQuery.trim()) {
        const q = wizard.searchQuery.trim().toLowerCase();
        filtered = filtered.filter(
          (c) =>
            (c.title && c.title.toLowerCase().includes(q)) ||
            (c.sourceKey && c.sourceKey.toLowerCase().includes(q)) ||
            (c.folder && c.folder.toLowerCase().includes(q))
        );
      }

      const paged = filtered.slice(wizard.page * wizard.pageSize, (wizard.page + 1) * wizard.pageSize);

      paged.forEach((conv) => {
        const tr = document.createElement('tr');

        const tdCheck = document.createElement('td');
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = wizard.selectedKeys.has(conv.sourceKey);
        chk.addEventListener('change', () => {
          if (chk.checked) {
            wizard.selectedKeys.add(conv.sourceKey);
          } else {
            wizard.selectedKeys.delete(conv.sourceKey);
          }
          const cntEl = document.getElementById('staged-sel-count');
          if (cntEl) {
            cntEl.textContent = t('imports.selectedCount', { count: wizard.selectedKeys.size }, `${wizard.selectedKeys.size} selected`);
          }
          updateActionBar();
        });
        tdCheck.appendChild(chk);
        tr.appendChild(tdCheck);

        const tdChat = document.createElement('td');
        tdChat.textContent = conv.title || conv.sourceKey;
        tr.appendChild(tdChat);

        const tdChan = document.createElement('td');
        tdChan.appendChild(createBadgeElement(conv.channel || 'web', 'muted'));
        tr.appendChild(tdChan);

        const tdFolder = document.createElement('td');
        tdFolder.className = 'mono-cell';
        tdFolder.textContent = conv.folder || '-';
        tr.appendChild(tdFolder);

        const tdMsgs = document.createElement('td');
        tdMsgs.textContent = formatNumber(conv.msgCount);
        tr.appendChild(tdMsgs);

        const tdDate = document.createElement('td');
        const first = conv.firstMessageAt ? formatDate(conv.firstMessageAt) : '';
        const last = conv.lastMessageAt ? formatDate(conv.lastMessageAt) : '';
        tdDate.textContent = first && last ? `${first} - ${last}` : (last || '-');
        tr.appendChild(tdDate);

        const tdWarn = document.createElement('td');
        if (conv.schemaWarnings && conv.schemaWarnings.length > 0) {
          tdWarn.appendChild(createBadgeElement(conv.schemaWarnings[0], 'warning'));
        } else {
          tdWarn.textContent = '-';
        }
        tr.appendChild(tdWarn);

        tbody.appendChild(tr);
      });

      const cntEl = document.getElementById('staged-sel-count');
      if (cntEl) {
        cntEl.textContent = t('imports.selectedCount', { count: wizard.selectedKeys.size }, `${wizard.selectedKeys.size} selected`);
      }
    }

    renderTableBody();

    // Actions Bar
    const actions = document.createElement('div');
    actions.className = 'staged-actions-bar';

    const backBtn = document.createElement('button');
    backBtn.className = 'btn btn-secondary btn-sm';
    backBtn.textContent = t('imports.btnBack', null, 'Back');
    backBtn.addEventListener('click', () => {
      wizard.step = 1;
      updateView();
    });
    actions.appendChild(backBtn);

    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn btn-primary btn-sm';
    nextBtn.id = 'staged-step2-next';
    nextBtn.textContent = t('imports.btnNextTarget', null, 'Next: Target & Dry-Run');
    nextBtn.disabled = wizard.selectedKeys.size === 0;

    nextBtn.addEventListener('click', () => {
      wizard.step = 3;
      updateView();
    });

    function updateActionBar() {
      const btn = document.getElementById('staged-step2-next');
      if (btn) {
        btn.disabled = wizard.selectedKeys.size === 0;
      }
    }

    actions.appendChild(nextBtn);
    root.appendChild(actions);
  };

  // Step 3: Target User & Dry Run
  const renderStep3 = (root) => {
    const formWrap = document.createElement('div');

    const grpUser = document.createElement('div');
    grpUser.className = 'form-group';
    const lblUser = document.createElement('label');
    lblUser.textContent = t('imports.targetUser', null, 'Target User ID');
    const inputUser = document.createElement('input');
    inputUser.type = 'text';
    inputUser.id = 'staged-target-user';
    inputUser.value = wizard.targetUserId;
    inputUser.addEventListener('input', (e) => {
      wizard.targetUserId = e.target.value;
    });
    grpUser.appendChild(lblUser);
    grpUser.appendChild(inputUser);
    formWrap.appendChild(grpUser);

    const grpSpace = document.createElement('div');
    grpSpace.className = 'form-group';
    const lblSpace = document.createElement('label');
    lblSpace.textContent = t('imports.targetSpace', null, 'Target Space Name (Optional)');
    const inputSpace = document.createElement('input');
    inputSpace.type = 'text';
    inputSpace.id = 'staged-target-space';
    inputSpace.value = wizard.targetSpace;
    inputSpace.placeholder = 'Auto-derived from group folder';
    inputSpace.addEventListener('input', (e) => {
      wizard.targetSpace = e.target.value;
    });
    grpSpace.appendChild(lblSpace);
    grpSpace.appendChild(inputSpace);
    formWrap.appendChild(grpSpace);

    const grpTitle = document.createElement('div');
    grpTitle.className = 'form-group';
    const lblTitle = document.createElement('label');
    lblTitle.textContent = t('imports.titleOverride', null, 'Session Title Override (Optional)');
    const inputTitle = document.createElement('input');
    inputTitle.type = 'text';
    inputTitle.id = 'staged-target-title';
    inputTitle.value = wizard.titleOverride;
    inputTitle.placeholder = 'Auto-derived from conversation name';
    inputTitle.addEventListener('input', (e) => {
      wizard.titleOverride = e.target.value;
    });
    grpTitle.appendChild(lblTitle);
    grpTitle.appendChild(inputTitle);
    formWrap.appendChild(grpTitle);

    // Selected summary
    const summaryCard = document.createElement('div');
    summaryCard.className = 'staged-schema-summary';
    const sc1 = document.createElement('div');
    sc1.className = 'staged-schema-card';
    const sc1L = document.createElement('span');
    sc1L.className = 'staged-schema-card-label';
    sc1L.textContent = t('imports.totalChats', null, 'Conversations to Migrate');
    const sc1V = document.createElement('span');
    sc1V.className = 'staged-schema-card-val';
    sc1V.textContent = String(wizard.selectedKeys.size);
    sc1.appendChild(sc1L);
    sc1.appendChild(sc1V);
    summaryCard.appendChild(sc1);
    formWrap.appendChild(summaryCard);

    // Dry Run Preview Button & Container
    const dryRunBtn = document.createElement('button');
    dryRunBtn.className = 'btn btn-secondary btn-sm';
    dryRunBtn.textContent = t('imports.btnRunDryRun', null, 'Run Dry-Run Preview');

    const dryRunResultBox = document.createElement('div');
    dryRunResultBox.id = 'staged-dryrun-result';
    if (wizard.dryRunResult) {
      renderDryRunDetails(dryRunResultBox, wizard.dryRunResult);
    }

    dryRunBtn.addEventListener('click', async () => {
      dryRunBtn.disabled = true;
      dryRunBtn.textContent = `${t('imports.btnRunDryRun', null, 'Run Dry-Run Preview')}...`;
      try {
        const res = await apiRequest(`/api/admin/imports/staged/${wizard.selectedStagedId}/migrate`, {
          method: 'POST',
          body: {
            targetUserId: wizard.targetUserId || 'alice',
            conversations: Array.from(wizard.selectedKeys),
            all: wizard.selectedKeys.size === (wizard.inspectData ? wizard.inspectData.totalConversations : 0),
            dryRun: true,
            targetSpace: wizard.targetSpace || undefined,
            titleOverride: wizard.titleOverride || undefined,
          },
        });
        if (res && res.data) {
          wizard.dryRunResult = res.data;
          renderDryRunDetails(dryRunResultBox, res.data);
          showToast(t('common.success', null, 'Dry run completed successfully'), 'success');
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        dryRunBtn.disabled = false;
        dryRunBtn.textContent = t('imports.btnRunDryRun', null, 'Run Dry-Run Preview');
      }
    });

    formWrap.appendChild(dryRunBtn);
    formWrap.appendChild(dryRunResultBox);
    root.appendChild(formWrap);

    // Actions Bar
    const actions = document.createElement('div');
    actions.className = 'staged-actions-bar';

    const backBtn = document.createElement('button');
    backBtn.className = 'btn btn-secondary btn-sm';
    backBtn.textContent = t('imports.btnBack', null, 'Back');
    backBtn.addEventListener('click', () => {
      wizard.step = 2;
      updateView();
    });
    actions.appendChild(backBtn);

    const startBtn = document.createElement('button');
    startBtn.className = 'btn btn-primary btn-sm';
    startBtn.textContent = t('imports.btnStartMigration', null, 'Start Migration');
    startBtn.addEventListener('click', async () => {
      wizard.step = 4;
      updateView();
      await executeRealMigration();
    });

    actions.appendChild(startBtn);
    root.appendChild(actions);
  };

  function renderDryRunDetails(box, data) {
    box.replaceChildren();
    const card = document.createElement('div');
    card.className = 'staged-info-banner';
    const plan = data.plan || {};
    const items = plan.items || [];
    let estEvents = 0;
    items.forEach((i) => { estEvents += (i.estimatedSeedEvents || 0); });

    const pTitle = document.createElement('strong');
    pTitle.textContent = `${t('imports.dryRunSummaryTitle', null, 'Dry-Run Migration Plan')}: `;
    const pDetails = document.createElement('span');
    pDetails.textContent = `${t('imports.planSpacesToCreate', { count: items.length }, `Spaces: ${items.length}`)} | ${t('imports.planSeedEvents', { count: estEvents }, `Events: ${estEvents}`)}`;
    card.appendChild(pTitle);
    card.appendChild(pDetails);
    box.appendChild(card);
  }

  // Step 4: Execute, Progress & Cancel
  const renderStep4 = (root) => {
    const progCard = document.createElement('div');
    progCard.className = 'staged-progress-container';

    const titleEl = document.createElement('h3');
    titleEl.textContent = t('imports.migratingInProgress', null, 'Migration in progress...');
    const descEl = document.createElement('p');
    descEl.textContent = t('imports.migratingDesc', null, 'Dual-writing records, creating spaces, session routes, and message history...');

    progCard.appendChild(titleEl);
    progCard.appendChild(descEl);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-danger btn-sm';
    cancelBtn.textContent = t('imports.btnCancelMigration', null, 'Cancel Migration');
    cancelBtn.addEventListener('click', async () => {
      if (wizard.jobId) {
        try {
          await apiRequest(`/api/admin/imports/staged/jobs/${wizard.jobId}/cancel`, { method: 'POST' });
          showToast(t('common.cancelled', null, 'Migration cancelled'), 'info');
        } catch {}
      }
      wizard.step = 3;
      updateView();
    });

    progCard.appendChild(cancelBtn);
    root.appendChild(progCard);
  };

  const executeRealMigration = async () => {
    try {
      const idempKey = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : 'idemp_mig_' + Date.now();
      const res = await apiRequest(`/api/admin/imports/staged/${wizard.selectedStagedId}/migrate`, {
        method: 'POST',
        headers: {
          'Idempotency-Key': idempKey,
        },
        body: {
          targetUserId: wizard.targetUserId || 'alice',
          conversations: Array.from(wizard.selectedKeys),
          all: wizard.selectedKeys.size === (wizard.inspectData ? wizard.inspectData.totalConversations : 0),
          dryRun: false,
          targetSpace: wizard.targetSpace || undefined,
          titleOverride: wizard.titleOverride || undefined,
        },
      });
      if (res && res.data) {
        wizard.migrationResult = res.data;
        wizard.jobId = res.data.jobId || null;
        wizard.step = 5;
        updateView();
        if (onCompleteRefresh) {
          await onCompleteRefresh();
        }
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
      wizard.step = 3;
      updateView();
    }
  };

  // Step 5: Success & Links to Imported Spaces / Sessions
  const renderStep5 = (root) => {
    const res = wizard.migrationResult;
    if (!res) return;

    const succCard = document.createElement('div');
    succCard.className = 'staged-success-card';

    const icon = document.createElement('div');
    icon.className = 'staged-success-icon';
    icon.textContent = '🎉';
    succCard.appendChild(icon);

    const titleEl = document.createElement('h3');
    titleEl.textContent = t('imports.successTitle', null, 'Migration Completed Successfully');
    succCard.appendChild(titleEl);

    const descEl = document.createElement('p');
    const numChats = res.compiledChats ? res.compiledChats.length : (res.stats ? res.stats.chats : 0);
    const numMsgs = res.stats ? res.stats.importedPeopleTalk : 0;
    descEl.textContent = t('imports.successDesc', { chats: numChats, messages: numMsgs }, `Imported ${numChats} conversations and ${numMsgs} messages.`);
    succCard.appendChild(descEl);

    // List of links to imported Space / Sessions
    if (res.compiledChats && res.compiledChats.length > 0) {
      const linkList = document.createElement('div');
      linkList.className = 'staged-session-link-list';

      res.compiledChats.forEach((chat) => {
        const item = document.createElement('a');
        item.className = 'staged-session-link-item';
        item.href = `#space=${encodeURIComponent(chat.folder)}&session=${encodeURIComponent(chat.sessionId)}`;

        const nameSpan = document.createElement('span');
        nameSpan.textContent = `💬 ${chat.folder} (${chat.sessionId.slice(0, 16)}...)`;
        const openSpan = document.createElement('span');
        openSpan.className = 'staged-session-link-arrow';
        openSpan.textContent = `${t('imports.openInChat', null, 'Open in Chat')} →`;

        item.appendChild(nameSpan);
        item.appendChild(openSpan);
        linkList.appendChild(item);
      });
      succCard.appendChild(linkList);
    }

    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn btn-secondary btn-sm';
    resetBtn.textContent = t('imports.btnImportAnother', null, 'Import Another Database');
    resetBtn.addEventListener('click', async () => {
      wizard.step = 1;
      wizard.selectedStagedId = null;
      wizard.selectedStagedItem = null;
      wizard.inspectData = null;
      wizard.selectedKeys.clear();
      wizard.dryRunResult = null;
      wizard.migrationResult = null;
      await loadStagedFiles();
      updateView();
    });

    succCard.appendChild(resetBtn);
    root.appendChild(succCard);
  };

  const loadStagedFiles = async () => {
    try {
      const res = await apiRequest('/api/admin/imports/staged');
      if (res && res.data && Array.isArray(res.data)) {
        wizard.stagedFiles = res.data;
        if (!wizard.selectedStagedId && res.data.length > 0) {
          const firstReady = res.data.find((f) => f.inspectionStatus === 'ready') || res.data[0];
          wizard.selectedStagedId = firstReady.stagedId;
          wizard.selectedStagedItem = firstReady;
        }
      }
    } catch {}
  };

  // Initial load
  loadStagedFiles().then(() => updateView());
}

// 7. Admin Dashboard View (GET /api/admin/dashboard)
async function renderAdminDashboardView(container) {
  let dashData = null;
  let isUnavailable = false;

  try {
    const res = await apiRequest('/api/admin/dashboard');
    if (!res || !res.data || typeof res.data !== 'object' || !res.data.counts || typeof res.data.counts !== 'object') {
      isUnavailable = true;
    } else {
      dashData = res.data;
    }
  } catch {
    isUnavailable = true;
  }

  container.replaceChildren();
  container.appendChild(createHeader('overview.adminTitle', 'overview.adminSubtitle', () => renderManagementView('admin-dashboard')));

  if (isUnavailable || !dashData) {
    container.appendChild(createStateCard('overview.adminUnavailableTitle', 'overview.adminUnavailableDesc', true));
    return;
  }

  const kpiGrid = document.createElement('div');
  kpiGrid.className = 'kpi-grid';

  const counts = dashData.counts;

  // 1. Users KPI with active/disabled breakdown
  const usersObj = counts.users;
  let usersTotal = getLocalizedEnum('status', 'unavailable');
  let usersSubtitle = getLocale() === 'zh-CN' ? '平台账户' : 'Platform accounts';
  if (usersObj && typeof usersObj === 'object') {
    const total = typeof usersObj.total === 'number' ? formatNumber(usersObj.total) : getLocalizedEnum('status', 'unavailable');
    const active = typeof usersObj.active === 'number' ? formatNumber(usersObj.active) : getLocalizedEnum('status', 'unavailable');
    const disabled = typeof usersObj.disabled === 'number' ? formatNumber(usersObj.disabled) : getLocalizedEnum('status', 'unavailable');
    usersTotal = total;
    if (active !== 'Unavailable' || disabled !== 'Unavailable') {
      usersSubtitle = getLocale() === 'zh-CN'
        ? `${active} 正常 / ${disabled} 已禁用`
        : `${active} active / ${disabled} disabled`;
    }
  }
  kpiGrid.appendChild(createKpiCard('overview.kpiTotalUsers', usersTotal, usersSubtitle));

  // 2. Spaces KPI
  const spacesTotal = counts.spaces && typeof counts.spaces.total === 'number'
    ? formatNumber(counts.spaces.total)
    : getLocalizedEnum('status', 'unavailable');
  kpiGrid.appendChild(createKpiCard('overview.kpiTotalSpaces', spacesTotal, getLocale() === 'zh-CN' ? '跨租户空间总数' : 'Cross-tenant spaces'));

  // 3. Sessions KPI
  const sessionsTotal = counts.sessions && typeof counts.sessions.total === 'number'
    ? formatNumber(counts.sessions.total)
    : getLocalizedEnum('status', 'unavailable');
  kpiGrid.appendChild(createKpiCard('overview.kpiTotalSessions', sessionsTotal, getLocale() === 'zh-CN' ? '会话实例总数' : 'Session instances'));

  // 4. Messages KPI
  const messagesTotal = counts.messages && typeof counts.messages.total === 'number'
    ? formatNumber(counts.messages.total)
    : getLocalizedEnum('status', 'unavailable');
  kpiGrid.appendChild(createKpiCard('overview.kpiTotalMessages', messagesTotal, getLocale() === 'zh-CN' ? '跨租户消息总数' : 'Cross-tenant messages'));

  // 5. Tasks KPI with pending/running breakdown
  const tasksObj = counts.tasks;
  let tasksTotal = getLocalizedEnum('status', 'unavailable');
  let tasksSubtitle = getLocale() === 'zh-CN' ? '平台执行任务' : 'Platform execution tasks';
  if (tasksObj && typeof tasksObj === 'object') {
    const total = typeof tasksObj.total === 'number' ? formatNumber(tasksObj.total) : getLocalizedEnum('status', 'unavailable');
    const pending = typeof tasksObj.pending === 'number' ? formatNumber(tasksObj.pending) : getLocalizedEnum('status', 'unavailable');
    const running = typeof tasksObj.running === 'number' ? formatNumber(tasksObj.running) : getLocalizedEnum('status', 'unavailable');
    tasksTotal = total;
    if (pending !== 'Unavailable' || running !== 'Unavailable') {
      tasksSubtitle = getLocale() === 'zh-CN'
        ? `${pending} 等待中 / ${running} 执行中`
        : `${pending} pending / ${running} running`;
    }
  }
  kpiGrid.appendChild(createKpiCard('overview.kpiPlatformTasks', tasksTotal, tasksSubtitle));

  // 6. Deliveries KPI with held/processing breakdown
  const delivObj = counts.deliveries;
  let delivTotal = getLocalizedEnum('status', 'unavailable');
  let delivSubtitle = getLocale() === 'zh-CN' ? '入站投递回执' : 'Inbound delivery receipts';
  if (delivObj && typeof delivObj === 'object') {
    const total = typeof delivObj.total === 'number' ? formatNumber(delivObj.total) : getLocalizedEnum('status', 'unavailable');
    const held = typeof delivObj.held === 'number' ? formatNumber(delivObj.held) : getLocalizedEnum('status', 'unavailable');
    const processing = typeof delivObj.processing === 'number' ? formatNumber(delivObj.processing) : getLocalizedEnum('status', 'unavailable');
    delivTotal = total;
    if (held !== 'Unavailable' || processing !== 'Unavailable') {
      delivSubtitle = getLocale() === 'zh-CN'
        ? `${held} 积压中 / ${processing} 处理中`
        : `${held} held / ${processing} processing`;
    }
  }
  kpiGrid.appendChild(createKpiCard('overview.kpiDeliveryPipeline', delivTotal, delivSubtitle));

  // 6.5 Storage / Imports summary
  const importsObj = counts.imports;
  if (importsObj && typeof importsObj === 'object' && typeof importsObj.totalReceipts === 'number') {
    const receipts = formatNumber(importsObj.totalReceipts);
    const importMsg = typeof importsObj.totalImportedMessages === 'number'
      ? (getLocale() === 'zh-CN' ? `${formatNumber(importsObj.totalImportedMessages)} 条导入消息` : `${importsObj.totalImportedMessages} imported messages`)
      : (getLocale() === 'zh-CN' ? '历史工作区种子数据' : 'Historical workspace seeds');
    kpiGrid.appendChild(createKpiCard('overview.kpiStorageImports', receipts, importMsg));
  }

  // 7. Runtime Engine Core Status
  const rtSummary = dashData.runtime && dashData.runtime.summary;
  const isHealthyCore = Boolean(rtSummary && rtSummary.allDshReady && rtSummary.healthyRuntimes > 0);
  const runtimeStatus = dashData.runtime && dashData.runtime.available
    ? (isHealthyCore ? 'Healthy' : 'Degraded')
    : 'Unavailable';
  const runtimeLocalized = getLocalizedEnum('status', runtimeStatus.toLowerCase());
  kpiGrid.appendChild(createKpiCard('overview.kpiRuntimeEngine', runtimeLocalized, getLocale() === 'zh-CN' ? 'Docker 隔离状态' : 'Docker isolation status'));

  // 7.5 Tool Execution Operational Status (Separate from core runtime readiness)
  if (rtSummary && typeof rtSummary.toolsOperationalCount === 'number') {
    const totalRts = typeof rtSummary.totalRuntimes === 'number' ? rtSummary.totalRuntimes : '-';
    const isToolsAllOp = totalRts !== '-' && rtSummary.toolsOperationalCount === totalRts && totalRts > 0;
    const toolsOpStatus = `${formatNumber(rtSummary.toolsOperationalCount)} / ${totalRts !== '-' ? formatNumber(totalRts) : '-'}`;
    const toolsSub = isToolsAllOp
      ? (getLocale() === 'zh-CN' ? '所有工具正常运行' : 'All tools operational')
      : (getLocale() === 'zh-CN' ? '工具执行降级' : 'Tool execution degraded');
    kpiGrid.appendChild(createKpiCard('overview.kpiToolExecution', toolsOpStatus, toolsSub));
  }

  // 8. Server Uptime
  const uptimeStr = typeof dashData.uptime === 'number' ? `${Math.floor(dashData.uptime)}s` : 'Unavailable';
  kpiGrid.appendChild(createKpiCard('overview.kpiUptime', uptimeStr, getLocale() === 'zh-CN' ? '进程运行时长' : 'Process runtime'));

  // 9. Compatible Future Extensions & Nested Telemetry: authFailures24h, schemaVersion, activeContainers
  const authFailures24h = (dashData.counts && dashData.counts.auth && typeof dashData.counts.auth.recentLoginFailures24h === 'number')
    ? dashData.counts.auth.recentLoginFailures24h
    : ((dashData.kpis && typeof dashData.kpis.recentLoginFailures24h === 'number')
      ? dashData.kpis.recentLoginFailures24h
      : (typeof dashData.authFailures24h === 'number' ? dashData.authFailures24h : null));
  if (typeof authFailures24h === 'number') {
    kpiGrid.appendChild(createKpiCard(getLocale() === 'zh-CN' ? '认证失败 (24h)' : 'Auth Failures (24h)', formatNumber(authFailures24h), getLocale() === 'zh-CN' ? '安全审计遥测' : 'Security telemetry'));
  }

  const schemaVersion = (dashData.schema && typeof dashData.schema.currentVersion === 'number')
    ? dashData.schema.currentVersion
    : ((dashData.counts && dashData.counts.schema && typeof dashData.counts.schema.currentVersion === 'number')
      ? dashData.counts.schema.currentVersion
      : ((dashData.kpis && typeof dashData.kpis.currentSchemaVersion === 'number')
        ? dashData.kpis.currentSchemaVersion
        : (typeof dashData.schemaVersion === 'number' ? dashData.schemaVersion : null)));
  if (typeof schemaVersion === 'number') {
    kpiGrid.appendChild(createKpiCard(getLocale() === 'zh-CN' ? '数据库 Schema 版本' : 'Schema Version', `v${schemaVersion}`, getLocale() === 'zh-CN' ? '数据库 Schema' : 'Database schema'));
  }

  const activeContainers = (dashData.runtime && typeof dashData.runtime.activeContainers === 'number')
    ? dashData.runtime.activeContainers
    : ((dashData.kpis && dashData.kpis.containers && typeof dashData.kpis.containers.active === 'number')
      ? dashData.kpis.containers.active
      : (typeof dashData.activeContainers === 'number' ? dashData.activeContainers : null));
  if (typeof activeContainers === 'number') {
    kpiGrid.appendChild(createKpiCard(getLocale() === 'zh-CN' ? '活跃容器数' : 'Active Containers', formatNumber(activeContainers), getLocale() === 'zh-CN' ? '容器运行器' : 'Container runner'));
  }

  container.appendChild(kpiGrid);
}

// 8. Admin Users & Access View (GET /api/admin/users, PATCH /api/admin/users/:id, POST /api/admin/users/:id/revoke-sessions)
async function renderAdminUsersView(container) {
  let users = null;
  let isUnavailable = false;

  try {
    const res = await apiRequest('/api/admin/users');
    if (res && res.data) {
      const raw = res.data;
      const rawList = Array.isArray(raw) ? raw : (Array.isArray(raw.items) ? raw.items : null);
      if (rawList) {
        users = rawList;
      } else {
        isUnavailable = true;
      }
    } else {
      isUnavailable = true;
    }
  } catch (err) {
    isUnavailable = true;
  }

  container.replaceChildren();
  const header = createHeader('users.title', 'users.subtitle', () => renderManagementView('admin-users'));
  
  // Add "Create User" action button to header
  const actionsContainer = header.querySelector('.management-actions');
  if (actionsContainer) {
    const btnCreateUser = document.createElement('button');
    btnCreateUser.type = 'button';
    btnCreateUser.id = 'btn-create-user-modal';
    btnCreateUser.className = 'btn btn-primary btn-sm';
    btnCreateUser.textContent = t('users.btnCreateUser', null, '➕ Create User');
    btnCreateUser.addEventListener('click', openCreateUserModal);
    actionsContainer.prepend(btnCreateUser);
  }

  container.appendChild(header);

  if (isUnavailable || !users) {
    container.appendChild(createStateCard('users.unavailableTitle', 'users.unavailableDesc', true));
    return;
  }

  const tableContainer = document.createElement('div');
  tableContainer.className = 'data-table-container';
  const table = document.createElement('table');
  table.className = 'data-table';

  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');
  const cols = ['Username', 'Display Name', 'Role', 'Status', 'Spaces / Sessions', 'Actions'];
  const colKeys = ['users.colUsername', 'users.colDisplayName', 'users.colRole', 'users.colStatus', 'users.colStats', 'users.colActions'];
  cols.forEach((col, idx) => {
    const th = document.createElement('th');
    th.textContent = t(colKeys[idx], null, col);
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const VALID_ROLES = ['admin', 'user'];
  const VALID_STATUSES = ['active', 'disabled'];

  users.forEach((u) => {
    const isValidUser = Boolean(
      u &&
      typeof u === 'object' &&
      typeof u.username === 'string' &&
      VALID_ROLES.includes(u.role) &&
      VALID_STATUSES.includes(u.status)
    );

    if (!isValidUser) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'text-muted';
      td.textContent = t('common.invalidRecord', null, getLocale() === 'zh-CN' ? '无效记录' : 'Invalid record');
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    const tr = document.createElement('tr');

    const tdUsername = document.createElement('td');
    tdUsername.className = 'mono-cell';
    tdUsername.textContent = u.username;
    tr.appendChild(tdUsername);

    const tdName = document.createElement('td');
    tdName.textContent = u.displayName || u.username;
    tr.appendChild(tdName);

    const tdRole = document.createElement('td');
    const userRole = u.role;
    tdRole.appendChild(createBadgeElement(userRole, userRole === 'admin' ? 'admin' : 'user', 'role'));
    tr.appendChild(tdRole);

    const tdStatus = document.createElement('td');
    const userStatus = u.status;
    const badgeType = userStatus === 'active' ? 'success' : 'danger';
    tdStatus.appendChild(createBadgeElement(userStatus, badgeType));
    tr.appendChild(tdStatus);

    const tdStats = document.createElement('td');
    tdStats.textContent = getLocale() === 'zh-CN'
      ? `${u.spaceCount != null ? formatNumber(u.spaceCount) : '-'} 空间 / ${u.sessionCount != null ? formatNumber(u.sessionCount) : '-'} 会话`
      : `${u.spaceCount ?? '-'} spaces / ${u.sessionCount ?? '-'} sessions`;
    tr.appendChild(tdStats);

    const tdActions = document.createElement('td');
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'flex-row-center';

    const btnEdit = document.createElement('button');
    btnEdit.type = 'button';
    btnEdit.className = 'btn btn-secondary btn-sm';
    btnEdit.textContent = t('users.btnEdit', null, 'Edit');
    btnEdit.addEventListener('click', () => openUserEditModal(u));
    actionsDiv.appendChild(btnEdit);

    const btnResetPwd = document.createElement('button');
    btnResetPwd.type = 'button';
    btnResetPwd.className = 'btn btn-secondary btn-sm';
    btnResetPwd.textContent = t('users.btnResetPwd', null, 'Reset Password');
    btnResetPwd.addEventListener('click', () => handleResetUserPassword(u));
    actionsDiv.appendChild(btnResetPwd);

    const btnRevoke = document.createElement('button');
    btnRevoke.type = 'button';
    btnRevoke.className = 'btn btn-danger btn-sm';
    btnRevoke.textContent = t('users.btnRevokeSessions', null, 'Revoke Sessions');
    btnRevoke.addEventListener('click', () => {
      const confirmTitle = t('users.confirmRevokeTitle', null, 'Revoke Active Sessions');
      const confirmMsg = t('users.confirmRevokeMsg', { username: u.username }, `Are you sure you want to revoke all active sessions for user "${u.username}"? They will be immediately signed out.`);
      showConfirmation(
        confirmTitle,
        confirmMsg,
        async () => {
          const isSelf = state.currentUser && (state.currentUser.id === u.id || state.currentUser.username === u.username);
          try {
            const res = await apiRequest(`/api/admin/users/${u.id || u.username}/revoke-sessions`, {
              method: 'POST',
            });

            showToast(getLocale() === 'zh-CN' ? `已吊销用户 ${u.username} 的所有活动会话` : `Sessions revoked for ${u.username}`, 'success');

            // If the target is the currently signed-in user, clear auth and show auth view immediately
            // without attempting subsequent admin fetches on revoked self
            if (isSelf || (res && res.data && res.data.forceLogout)) {
              showAuthView();
              return;
            }

            renderManagementView('admin-users');
          } catch (err) {
            showToast(getSafeErrorMessage(err, 'Failed to revoke user sessions.'), 'error');
          }
        }
      );
    });
    actionsDiv.appendChild(btnRevoke);

    tdActions.appendChild(actionsDiv);
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  tableContainer.appendChild(table);

  container.appendChild(tableContainer);
}

function openCreateUserModal() {
  const form = document.getElementById('create-user-form');
  if (form) form.reset();
  openModal('modal-create-user');
}

function openTempCredentialsModal(username, tempPassword) {
  const usernameInput = document.getElementById('display-target-username');
  const pwdInput = document.getElementById('display-temp-password');
  if (usernameInput) usernameInput.value = username;
  if (pwdInput) pwdInput.value = tempPassword;
  openModal('modal-temp-credentials');
}

async function handleCreateUser(e) {
  e.preventDefault();
  const usernameInput = document.getElementById('create-user-username');
  const nameInput = document.getElementById('create-user-displayname');
  const roleSelect = document.getElementById('create-user-role');
  const pwdInput = document.getElementById('create-user-temppassword');

  const username = usernameInput ? usernameInput.value.trim() : '';
  const displayName = nameInput && nameInput.value.trim() ? nameInput.value.trim() : undefined;
  const role = roleSelect ? roleSelect.value : 'user';
  const tempPassword = pwdInput && pwdInput.value ? pwdInput.value : undefined;

  if (!username) {
    showToast(getLocale() === 'zh-CN' ? '用户名不能为空' : 'Username is required', 'error');
    return;
  }

  closeModal('modal-create-user');

  try {
    const payload = { username, displayName, role };
    if (tempPassword) payload.tempPassword = tempPassword;

    const res = await apiRequest('/api/admin/users', {
      method: 'POST',
      body: payload,
    });

    if (res && res.data) {
      showToast(getLocale() === 'zh-CN' ? `用户 ${username} 创建成功` : `User ${username} created successfully`, 'success');
      const returnedPassword = res.data.tempPassword;
      renderManagementView('admin-users');
      openTempCredentialsModal(username, returnedPassword);
    }
  } catch (err) {
    showToast(getSafeErrorMessage(err, 'Failed to create user.'), 'error');
  }
}

async function handleResetUserPassword(user) {
  const modalTitle = getLocale() === 'zh-CN' ? '重置用户密码' : 'Reset User Password';
  const modalMsg = getLocale() === 'zh-CN'
    ? `确定为用户 "${user.username}" 生成新的一次性临时密码吗？该用户所有现存活跃会话将被立即强制吊销。`
    : `Generate a new one-time temporary password for user "${user.username}"? All existing active sessions for this user will be revoked immediately.`;

  showConfirmation(
    modalTitle,
    modalMsg,
    async () => {
      try {
        const res = await apiRequest(`/api/admin/users/${user.id || user.username}/reset-password`, {
          method: 'POST',
        });

        if (res && res.data) {
          showToast(getLocale() === 'zh-CN' ? `已重置用户 ${user.username} 的密码` : `Password reset for ${user.username}`, 'success');
          const isSelf = state.currentUser && (state.currentUser.id === user.id || state.currentUser.username === user.username);
          if (isSelf) {
            showAuthView();
            return;
          }
          renderManagementView('admin-users');
          openTempCredentialsModal(user.username, res.data.tempPassword);
        }
      } catch (err) {
        showToast(getSafeErrorMessage(err, 'Failed to reset user password.'), 'error');
      }
    }
  );
}

function openUserEditModal(user) {
  const modal = document.getElementById('modal-edit-user');
  const titleEl = document.getElementById('modal-edit-user-title');
  const idInput = document.getElementById('edit-user-id');
  const nameInput = document.getElementById('edit-user-displayname');
  const roleSelect = document.getElementById('edit-user-role');
  const statusSelect = document.getElementById('edit-user-status');

  if (titleEl) titleEl.textContent = getLocale() === 'zh-CN' ? `编辑用户: ${user.username}` : `Edit User: ${user.username}`;
  if (idInput) idInput.value = user.id || user.username;
  if (nameInput) nameInput.value = user.displayName || user.username;
  if (roleSelect) roleSelect.value = user.role || '';
  if (statusSelect) statusSelect.value = user.status || '';

  openModal('modal-edit-user');
}

async function handleSaveUserEdit(e) {
  e.preventDefault();
  const userId = document.getElementById('edit-user-id').value;
  const displayName = document.getElementById('edit-user-displayname').value.trim();
  const role = document.getElementById('edit-user-role').value;
  const status = document.getElementById('edit-user-status').value;

  closeModal('modal-edit-user');

  const modalTitle = t('users.confirmMutationTitle', null, 'Confirm User Mutation');
  const modalMsg = t('users.confirmMutationMsg', { userId, role, status, displayName }, `Apply changes to user ${userId}? (Role: ${role}, Status: ${status}, Display Name: ${displayName})`);

  showConfirmation(
    modalTitle,
    modalMsg,
    async () => {
      const isSelf = state.currentUser && (state.currentUser.id === userId || state.currentUser.username === userId);
      try {
        const payload = { role, status, displayName };
        const res = await apiRequest(`/api/admin/users/${userId}`, {
          method: 'PATCH',
          body: payload,
        });

        showToast(getLocale() === 'zh-CN' ? `用户 ${userId} 更新成功！` : `User ${userId} updated successfully!`, 'success');

        // Check if mutation affected the currently signed-in user
        if (isSelf) {
          if (status === 'disabled' || (res && res.data && res.data.forceLogout)) {
            // Disabled or forceLogout => clear auth and transition to login immediately
            showAuthView();
            return;
          }
          // Privilege or display name change => re-bootstrap /auth/me to update identity and roles
          await checkAuth();
          return;
        }

        if (state.currentRoute === 'admin-users') {
          renderManagementView('admin-users');
        }
      } catch (err) {
        showToast(getSafeErrorMessage(err, 'Failed to update user.'), 'error');
      }
    }
  );
}

// 9. Admin Spaces & Sessions View (GET /api/admin/spaces)
// NEVER calls tenant spaces sessions endpoint or exposes cross-tenant turns/messages.
// Renders one aggregate table using /api/admin/spaces fields only.
async function renderAdminSpacesView(container) {
  let spaces = null;
  let isUnavailable = false;

  try {
    const res = await apiRequest('/api/admin/spaces');
    if (res && res.data) {
      const raw = res.data;
      const rawList = Array.isArray(raw) ? raw : (Array.isArray(raw.items) ? raw.items : null);
      if (rawList) {
        spaces = rawList;
      } else {
        isUnavailable = true;
      }
    } else {
      isUnavailable = true;
    }
  } catch (err) {
    isUnavailable = true;
  }

  container.replaceChildren();
  container.appendChild(createHeader('spaces.title', 'spaces.subtitle', () => renderManagementView('admin-spaces')));

  if (isUnavailable || !spaces) {
    container.appendChild(createStateCard('spaces.unavailableTitle', 'spaces.unavailableDesc', true));
    return;
  }

  if (spaces.length === 0) {
    container.appendChild(createStateCard('spaces.emptyTitle', 'spaces.emptyDesc'));
    return;
  }

  const tableContainer = document.createElement('div');
  tableContainer.className = 'data-table-container';
  const table = document.createElement('table');
  table.className = 'data-table';

  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');
  const cols = ['Owner', 'Space Name', 'Sessions', 'Created At'];
  const colKeys = ['spaces.colOwner', 'spaces.colName', 'spaces.colSessions', 'spaces.colCreatedAt'];
  cols.forEach((col, idx) => {
    const th = document.createElement('th');
    th.textContent = t(colKeys[idx], null, col);
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  spaces.forEach((sp) => {
    if (!sp || typeof sp !== 'object' || !sp.id) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.className = 'text-muted';
      td.textContent = t('common.invalidRecord', null, getLocale() === 'zh-CN' ? '无效记录' : 'Invalid record');
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    const tr = document.createElement('tr');

    const tdOwner = document.createElement('td');
    tdOwner.className = 'mono-cell';
    tdOwner.textContent = sp.username || sp.userId || '-';
    tr.appendChild(tdOwner);

    const tdName = document.createElement('td');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = sp.name || '-';
    tdName.appendChild(nameSpan);
    const isHostSpace = sp.executionMode === 'host';
    const modeBadge = createBadgeElement(isHostSpace ? 'Host' : 'Docker', isHostSpace ? 'danger' : 'info');
    modeBadge.classList.add('space-mode-badge');
    tdName.appendChild(modeBadge);

    const btnMounts = document.createElement('button');
    btnMounts.type = 'button';
    btnMounts.className = 'btn btn-secondary btn-xs space-row-mounts-btn';
    btnMounts.textContent = t('chat.mounts', null, 'Mounts');
    btnMounts.title = t('chat.mountsTitle', null, 'Manage Controlled Mounts');
    btnMounts.addEventListener('click', () => openSpaceMountsModal(sp.id, sp.name));
    tdName.appendChild(btnMounts);
    tr.appendChild(tdName);

    const tdSessions = document.createElement('td');
    tdSessions.textContent = typeof sp.sessionCount === 'number' ? formatNumber(sp.sessionCount) : '-';
    tr.appendChild(tdSessions);

    const tdTime = document.createElement('td');
    tdTime.textContent = sp.createdAt ? formatDate(sp.createdAt) : '-';
    tr.appendChild(tdTime);

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  tableContainer.appendChild(table);
  container.appendChild(tableContainer);
}

// 10. Admin Runtime View (GET /api/admin/runtime)
async function renderAdminRuntimeView(container) {
  let runtimeData = null;
  let isUnavailable = false;

  try {
    const res = await apiRequest('/api/admin/runtime');
    if (res && res.data && res.data.available && Array.isArray(res.data.runtimes)) {
      runtimeData = res.data;
    } else {
      isUnavailable = true;
    }
  } catch (err) {
    isUnavailable = true;
  }

  container.replaceChildren();
  const header = createHeader('runtime.adminTitle', 'runtime.adminSubtitle', () => renderManagementView('admin-runtime'));
  const btnDiag = document.createElement('button');
  btnDiag.type = 'button';
  btnDiag.className = 'btn btn-secondary btn-sm ml-auto';
  btnDiag.textContent = t('diagnostics.btnOpen', null, 'Runtime Diagnostics');
  btnDiag.addEventListener('click', () => openDiagnosticsModal((state.currentUser && state.currentUser.id) || 'alice'));
  header.appendChild(btnDiag);
  container.appendChild(header);

  if (isUnavailable || !runtimeData) {
    container.appendChild(
      createStateCard(
        'runtime.adminServiceUnavailableTitle',
        'The runtime management endpoint (/api/admin/runtime) is unavailable or uninitialized.',
        true
      )
    );
    return;
  }

  const runtimes = runtimeData.runtimes;
  const allNone = runtimes.length > 0 && runtimes.every((r) => r.networkMode === 'none');
  const netKpi = allNone ? '--network none' : (runtimes.length === 0 ? 'Unavailable' : (getLocale() === 'zh-CN' ? '混合 / 未知' : 'Mixed / Unknown'));
  const netSubtitle = getLocale() === 'zh-CN' ? (allNone ? '所有已上报运行时均使用无网络模式' : '服务端上报模式') : (allNone ? 'All reported runtimes use no network' : 'Server-reported modes');

  const toolsOpCount = runtimes.filter((r) => r.toolsOperational === true).length;
  const toolsSubtitle = runtimes.length === 0
    ? (getLocale() === 'zh-CN' ? '暂无活动运行时' : 'No active runtimes')
    : (toolsOpCount === runtimes.length
        ? (getLocale() === 'zh-CN' ? '所有运行时工具正常' : 'All runtimes operational')
        : (toolsOpCount === 0
            ? (getLocale() === 'zh-CN' ? '工具执行已禁用' : 'Tools execution disabled')
            : (getLocale() === 'zh-CN' ? `${toolsOpCount} / ${runtimes.length} 工具正常` : `${toolsOpCount} of ${runtimes.length} operational`)));

  const kpiGrid = document.createElement('div');
  kpiGrid.className = 'kpi-grid';
  kpiGrid.appendChild(createKpiCard('Runtime Status', getLocalizedEnum('status', 'available'), getLocale() === 'zh-CN' ? '实时遥测已连接' : 'Live telemetry attached'));
  kpiGrid.appendChild(createKpiCard('Total Runtimes', String(runtimes.length), 'Reported records'));
  kpiGrid.appendChild(createKpiCard('Tools Operational', `${toolsOpCount} / ${runtimes.length}`, toolsSubtitle));
  kpiGrid.appendChild(createKpiCard('Network Isolation', netKpi, netSubtitle));
  container.appendChild(kpiGrid);

  if (runtimes.length > 0) {
    const section = document.createElement('div');
    section.className = 'management-section';
    const sHead = document.createElement('div');
    sHead.className = 'section-header';
    const h3 = document.createElement('h3');
    h3.textContent = t('runtime.sectionContainerSandboxes', null, 'Container Sandboxes');
    sHead.appendChild(h3);
    section.appendChild(sHead);

    const tableContainer = document.createElement('div');
    tableContainer.className = 'data-table-container';
    const table = document.createElement('table');
    table.className = 'data-table';

    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');
    const cols = ['User ID', 'Core Status', 'DSH Ready', 'Tool Schemas', 'Tool Execution', 'Network', 'Actions'];
    const colKeys = ['runtime.colUserId', 'runtime.colCoreStatus', 'runtime.colDshReady', 'runtime.colToolSchemas', 'runtime.colToolExecution', 'runtime.colNetwork', 'runtime.colActions'];
    cols.forEach((col, idx) => {
      const th = document.createElement('th');
      th.textContent = t(colKeys[idx], null, col);
      trHead.appendChild(th);
    });
    thead.appendChild(trHead);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    runtimes.forEach((r) => {
      if (!r || typeof r !== 'object' || typeof r.userId !== 'string') {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 7;
        td.className = 'text-muted';
        td.textContent = t('common.invalidRecord', null, getLocale() === 'zh-CN' ? '无效记录' : 'Invalid record');
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }

      const tr = document.createElement('tr');

      const tdUser = document.createElement('td');
      const userSpan = document.createElement('span');
      userSpan.textContent = r.userId;
      tdUser.appendChild(userSpan);
      const isHostInstance = r.mode === 'host' || r.executionMode === 'host';
      const modeBadge = createBadgeElement(isHostInstance ? 'Host' : 'Docker', isHostInstance ? 'danger' : 'info');
      modeBadge.classList.add('space-mode-badge');
      tdUser.appendChild(modeBadge);
      tr.appendChild(tdUser);

      const tdStatus = document.createElement('td');
      const isValidStatus = r.status === 'ok' || r.status === 'degraded' || r.status === 'error';
      const rowStatus = isValidStatus ? r.status : 'unavailable';
      const badgeType = rowStatus === 'ok' ? 'success' : (rowStatus === 'degraded' ? 'warning' : (rowStatus === 'error' ? 'danger' : 'muted'));
      tdStatus.appendChild(createBadgeElement(rowStatus, badgeType));
      tr.appendChild(tdStatus);

      const tdDsh = document.createElement('td');
      const dshState = r.dshReady === true ? 'Ready' : (r.dshReady === false ? 'Not Ready' : 'Unavailable');
      const dshBadgeType = r.dshReady === true ? 'success' : (r.dshReady === false ? 'warning' : 'muted');
      tdDsh.appendChild(createBadgeElement(dshState, dshBadgeType));
      tr.appendChild(tdDsh);

      // Tool Schemas Registered
      const tdSchemas = document.createElement('td');
      const countVal = typeof r.toolsCount === 'number' ? r.toolsCount : null;
      tdSchemas.textContent = countVal !== null ? (getLocale() === 'zh-CN' ? `${formatNumber(countVal)} 个 Schema` : `${countVal} Schemas`) : getLocalizedEnum('status', 'unavailable');
      tr.appendChild(tdSchemas);

      // Tool Execution Operational (Warning + Reason if false, NEVER green)
      const tdExec = document.createElement('td');
      if (r.toolsOperational === true) {
        tdExec.appendChild(createBadgeElement(getLocale() === 'zh-CN' ? '正常运行' : 'Operational', 'success'));
      } else if (r.toolsOperational === false) {
        tdExec.appendChild(createBadgeElement(getLocale() === 'zh-CN' ? '降级运行' : 'Degraded', 'warning'));
        const reasonText = getToolsUnavailableReason(r.toolsUnavailableReason);
        if (reasonText) {
          const reasonEl = document.createElement('div');
          reasonEl.className = 'text-warning text-xs';
          reasonEl.textContent = reasonText;
          tdExec.appendChild(reasonEl);
        }
      } else {
        tdExec.appendChild(createBadgeElement(getLocalizedEnum('status', 'unavailable'), 'muted'));
      }
      tr.appendChild(tdExec);

      const tdNet = document.createElement('td');
      tdNet.className = 'mono-cell';
      tdNet.textContent = r.networkMode === 'none' ? '--network none' : (r.networkMode ? r.networkMode : 'Unavailable');
      tr.appendChild(tdNet);

      // Actions Cell: Restart button with confirm, idempotency, and row-level loading
      const tdActions = document.createElement('td');
      tdActions.className = 'file-actions-cell';
      const btnRestart = document.createElement('button');
      btnRestart.type = 'button';
      btnRestart.className = 'btn btn-secondary btn-xs btn-runtime-restart';
      btnRestart.textContent = t('runtime.btnRestart', null, 'Restart');
      btnRestart.setAttribute('data-user-id', r.userId);

      btnRestart.addEventListener('click', () => {
        const isHostInstance = r.mode === 'host' || r.executionMode === 'host';
        const modeLabel = isHostInstance ? 'Host' : 'Docker';
        const confirmTitle = t('runtime.confirmRestartTitle', null, 'Confirm Container Restart');
        const confirmMsg = t('runtime.confirmRestartMessage', { userId: `${r.userId} (${modeLabel})` }, `Are you sure you want to restart runtime container for user ${r.userId}?`);

        showConfirmation(confirmTitle, confirmMsg, async () => {
          try {
            btnRestart.disabled = true;
            btnRestart.textContent = t('runtime.restarting', null, 'Restarting...');

            if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
              showToast(t('toast.cryptoUnavailable', null, 'Cryptographic context unavailable. Cannot generate Idempotency-Key.'), 'error');
              return;
            }
            const idempotencyKey = crypto.randomUUID();

            const restartUrl = isHostInstance
              ? `/api/admin/runtime/${encodeURIComponent(r.userId)}/restart?mode=host`
              : `/api/admin/runtime/${encodeURIComponent(r.userId)}/restart`;
            const restartRes = await apiRequest(restartUrl, {
              method: 'POST',
              headers: {
                'Idempotency-Key': idempotencyKey,
              },
              ...(isHostInstance ? { body: { mode: 'host' } } : {}),
            });

            const resData = restartRes && restartRes.data;
            if (resData && Array.isArray(resData.failedRuntimes) && resData.failedRuntimes.length > 0) {
              const details = resData.failedRuntimes.map((f) => `${f.userId}: ${f.error}`).join('; ');
              showToast(t('runtime.restartPartial', { details }, `Runtime container restart finished with warnings: ${details}`), 'warning');
            } else {
              showToast(t('runtime.restartSuccess', { userId: r.userId }, `Container for user ${r.userId} restarted successfully.`), 'success');
            }

            // Re-render admin runtime view to refresh live status
            await renderAdminRuntimeView(container);
          } catch (err) {
            showToast(getSafeErrorMessage(err, t('runtime.restartFailed', { error: err?.message || 'Unknown error' }, 'Failed to restart container.')), 'error');
          } finally {
            btnRestart.disabled = false;
            btnRestart.textContent = t('runtime.btnRestart', null, 'Restart');
          }
        });
      });

      tdActions.appendChild(btnRestart);
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableContainer.appendChild(table);
    section.appendChild(tableContainer);
    container.appendChild(section);
  }
}

// 11. Admin Plugins View (GET /api/admin/plugins)
async function renderAdminPluginsView(container) {
  let pluginData = null;
  let isUnavailable = false;

  try {
    const res = await apiRequest('/api/admin/plugins');
    pluginData = (res && res.data) || null;
  } catch (err) {
    isUnavailable = true;
  }

  container.replaceChildren();
  container.appendChild(createHeader('plugins.title', 'plugins.subtitle', () => renderManagementView('admin-plugins')));

  const runtimes = (pluginData && Array.isArray(pluginData.runtimes)) ? pluginData.runtimes : null;

  if (isUnavailable || !pluginData || !runtimes) {
    container.appendChild(
      createStateCard(
        'plugins.unavailableTitle',
        'plugins.unavailableDesc',
        true
      )
    );
    return;
  }

  if (runtimes.length === 0) {
    container.appendChild(createStateCard('plugins.noTelemetry', 'plugins.noTelemetryDesc'));
    return;
  }

  const section = document.createElement('div');
  section.className = 'management-section';
  const sHead = document.createElement('div');
  sHead.className = 'section-header';
  const h3 = document.createElement('h3');
  h3.textContent = t('plugins.sectionTitle', null, 'Enkeep Cordis Plugin Enclaves');
  sHead.appendChild(h3);
  section.appendChild(sHead);

  const tableContainer = document.createElement('div');
  tableContainer.className = 'data-table-container';
  const table = document.createElement('table');
  table.className = 'data-table';

  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');
  const cols = ['User ID', 'Bundle Loaded', 'DSH Ready', 'Tool Schemas', 'Tool Execution', 'Cordis Plugins (7)', 'Status'];
  const colKeys = ['runtime.colUserId', 'plugins.colBundle', 'plugins.colDshReady', 'plugins.colToolSchemas', 'plugins.colToolExecution', 'plugins.colPlugins', 'plugins.colStatus'];
  cols.forEach((col, idx) => {
    const th = document.createElement('th');
    th.textContent = t(colKeys[idx], null, col);
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  table.appendChild(thead);

  const CORDIS_PLUGIN_KEYS = [
    'receiptStore',
    'inbound',
    'eventRelay',
    'tools',
    'externalInteraction',
    'affinityPolicy',
    'llmAffinity',
  ];

  const tbody = document.createElement('tbody');
  runtimes.forEach((r) => {
    if (!r || typeof r !== 'object' || typeof r.userId !== 'string') {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.className = 'text-muted';
      td.textContent = t('common.invalidRecord', null, getLocale() === 'zh-CN' ? '无效记录' : 'Invalid record');
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    const tr = document.createElement('tr');

    const tdUser = document.createElement('td');
    tdUser.textContent = r.userId;
    tr.appendChild(tdUser);

    const tdBundle = document.createElement('td');
    const bundleText = r.enkeepBundleLoaded === true ? (getLocale() === 'zh-CN' ? '已加载' : 'Loaded') : (r.enkeepBundleLoaded === false ? (getLocale() === 'zh-CN' ? '未加载' : 'Not Loaded') : getLocalizedEnum('status', 'unavailable'));
    const bundleBadgeType = r.enkeepBundleLoaded === true ? 'success' : (r.enkeepBundleLoaded === false ? 'danger' : 'muted');
    tdBundle.appendChild(createBadgeElement(bundleText, bundleBadgeType));
    tr.appendChild(tdBundle);

    const tdDsh = document.createElement('td');
    const dshText = r.dshReady === true ? 'Ready' : (r.dshReady === false ? 'Not Ready' : 'Unavailable');
    const dshBadgeType = r.dshReady === true ? 'success' : (r.dshReady === false ? 'warning' : 'muted');
    tdDsh.appendChild(createBadgeElement(dshText, dshBadgeType));
    tr.appendChild(tdDsh);

    // Tool Schemas Registered
    const tdTools = document.createElement('td');
    const countVal = typeof r.toolsCount === 'number' ? r.toolsCount : null;
    tdTools.textContent = countVal !== null ? (getLocale() === 'zh-CN' ? `${formatNumber(countVal)} 个 Schema` : `${countVal} Schemas`) : getLocalizedEnum('status', 'unavailable');
    tr.appendChild(tdTools);

    // Tool Execution Operational (Warning + Reason if false, NEVER green)
    const tdExec = document.createElement('td');
    if (r.toolsOperational === true || r.executionOperational === true) {
      tdExec.appendChild(createBadgeElement(getLocale() === 'zh-CN' ? '正常运行' : 'Operational', 'success'));
    } else if (r.toolsOperational === false || r.executionOperational === false) {
      tdExec.appendChild(createBadgeElement(getLocale() === 'zh-CN' ? '降级 / 离线' : 'Degraded / Offline', 'warning'));
      const reasonText = getToolsUnavailableReason(r.toolsUnavailableReason);
      if (reasonText) {
        const reasonEl = document.createElement('div');
        reasonEl.className = 'text-warning text-xs';
        reasonEl.textContent = reasonText;
        tdExec.appendChild(reasonEl);
      }
    } else {
      tdExec.appendChild(createBadgeElement(getLocalizedEnum('status', 'unavailable'), 'muted'));
    }
    tr.appendChild(tdExec);

    const tdPlugins = document.createElement('td');
    const pluginList = document.createElement('div');
    pluginList.className = 'flex-row-wrap';

    CORDIS_PLUGIN_KEYS.forEach((key) => {
      let label = key;
      let badgeType = 'muted';
      if (r.plugins && r.plugins[key] === true) {
        label = `${key}: ${getLocale() === 'zh-CN' ? '已就绪' : 'Ready'}`;
        badgeType = 'success';
      } else if (r.plugins && r.plugins[key] === false) {
        label = `${key}: ${getLocale() === 'zh-CN' ? '未就绪' : 'Not Ready'}`;
        badgeType = 'warning';
      } else {
        label = `${key}: ${getLocale() === 'zh-CN' ? '不可用' : 'Unavailable'}`;
        badgeType = 'muted';
      }
      pluginList.appendChild(createBadgeElement(label, badgeType));
    });
    tdPlugins.appendChild(pluginList);
    tr.appendChild(tdPlugins);

    const tdStatus = document.createElement('td');
    const VALID_STATUSES = ['ok', 'degraded', 'error'];
    const status = VALID_STATUSES.includes(r.status) ? r.status : 'unavailable';
    const badgeType = status === 'ok' ? 'success' : (status === 'degraded' ? 'warning' : (status === 'error' ? 'danger' : 'muted'));
    tdStatus.appendChild(createBadgeElement(status, badgeType));
    tr.appendChild(tdStatus);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  tableContainer.appendChild(table);
  section.appendChild(tableContainer);
  container.appendChild(section);
}

// 12. Admin Security View (GET /api/admin/security)
async function renderAdminSecurityView(container) {
  let secData = null;
  let isUnavailable = false;

  try {
    const res = await apiRequest('/api/admin/security');
    secData = (res && res.data) || null;
  } catch (err) {
    isUnavailable = true;
  }

  container.replaceChildren();
  container.appendChild(createHeader('security.title', 'security.subtitle', () => renderManagementView('admin-security')));

  if (isUnavailable || !secData) {
    container.appendChild(
      createStateCard(
        'security.unavailableTitle',
        'security.unavailableDesc',
        true
      )
    );
    return;
  }

  const kpiGrid = document.createElement('div');
  kpiGrid.className = 'kpi-grid';

  const hostBinding = (secData.securityPolicy && secData.securityPolicy.hostBinding) || 'Unavailable';
  const csrfRequired = Boolean(secData.securityPolicy && secData.securityPolicy.csrfRequired === true);
  const csrfHeader = secData.securityPolicy && typeof secData.securityPolicy.csrfHeader === 'string' ? secData.securityPolicy.csrfHeader : null;
  const csrfStatus = (csrfRequired && csrfHeader) ? (getLocale() === 'zh-CN' ? '生效中' : 'Active') : getLocalizedEnum('status', 'unavailable');
  const csrfSub = (csrfRequired && csrfHeader) ? (getLocale() === 'zh-CN' ? `${csrfHeader} 已验证` : `${csrfHeader} verified`) : (getLocale() === 'zh-CN' ? '无服务端证据' : 'No server evidence');
  const migVer = (secData.migrations && secData.migrations.currentVersion !== undefined) ? `v${secData.migrations.currentVersion}` : getLocalizedEnum('status', 'unavailable');
  const migCheck = secData.migrations
    ? (secData.migrations.checksumsMatch === true
        ? (getLocale() === 'zh-CN' ? '已验证' : 'Verified')
        : (secData.migrations.checksumsMatch === false
            ? (getLocale() === 'zh-CN' ? '校验和不匹配' : 'Checksum Mismatch')
            : getLocalizedEnum('status', 'unavailable')))
    : getLocalizedEnum('status', 'unavailable');

  kpiGrid.appendChild(createKpiCard('security.kpiCsrf', csrfStatus, csrfSub));
  kpiGrid.appendChild(createKpiCard('security.kpiHost', hostBinding, getLocale() === 'zh-CN' ? '服务端上报绑定策略' : 'Server-reported binding policy'));
  kpiGrid.appendChild(createKpiCard('security.kpiMigrations', migVer, `${getLocale() === 'zh-CN' ? '校验和: ' : 'Checksums: '}${migCheck}`));
  container.appendChild(kpiGrid);
}

// 13. Account & Security Settings View (/api/auth/me, PUT /api/auth/password)
async function renderAccountView(container) {
  const user = state.currentUser;
  container.replaceChildren();
  container.appendChild(createHeader('account.title', 'account.subtitle', () => renderManagementView('account')));

  if (!user) {
    container.appendChild(createStateCard('account.unavailableTitle', 'account.unavailableDesc', true));
    return;
  }

  // Profile Card
  const profileSection = document.createElement('div');
  profileSection.className = 'management-section';
  const h3Profile = document.createElement('h3');
  h3Profile.textContent = t('account.profileTitle', null, 'Account Profile');
  profileSection.appendChild(h3Profile);

  const profileGrid = document.createElement('div');
  profileGrid.className = 'kpi-grid';
  profileGrid.appendChild(createKpiCard('account.username', user.username, getLocale() === 'zh-CN' ? '账户标识符' : 'Account identifier'));
  profileGrid.appendChild(createKpiCard('account.displayName', user.displayName || user.username, getLocale() === 'zh-CN' ? '公开显示名称' : 'Public name'));
  profileGrid.appendChild(createKpiCard('account.role', getLocalizedEnum('role', user.role || 'user'), user.role === 'admin' ? (getLocale() === 'zh-CN' ? '平台管理员' : 'Platform Administrator') : (getLocale() === 'zh-CN' ? '普通成员' : 'Standard Member')));
  profileGrid.appendChild(createKpiCard('common.status', getLocalizedEnum('status', user.status || 'active'), getLocale() === 'zh-CN' ? '账户访问状态' : 'Access status'));
  profileSection.appendChild(profileGrid);
  container.appendChild(profileSection);

  // Personal Instructions Section (Lightweight card / Open editor)
  const personalInstructionsSection = document.createElement('div');
  personalInstructionsSection.className = 'management-section';
  const h3Personal = document.createElement('h3');
  h3Personal.textContent = t('instructions.personalCardTitle', null, 'Personal Instructions');
  personalInstructionsSection.appendChild(h3Personal);

  const personalEditor = createInstructionsEditor({
    target: 'global',
    maxBytes: 20480,
    cardTitleKey: 'instructions.globalCardTitle',
    cardDescKey: 'instructions.globalCardDesc',
    explanationKey: 'instructions.globalExplanation',
    initialFile: 'AGENTS.md',
  });
  personalInstructionsSection.appendChild(personalEditor.element);
  container.appendChild(personalInstructionsSection);
  await personalEditor.load();

  // Change Password Section
  const pwdSection = document.createElement('div');
  pwdSection.className = 'management-section';
  const h3Pwd = document.createElement('h3');
  h3Pwd.textContent = t('account.securityTitle', null, 'Change Password');
  pwdSection.appendChild(h3Pwd);

  const formCard = document.createElement('div');
  formCard.className = 'card-panel';

  const form = document.createElement('form');
  form.id = 'account-password-form';

  const grpOld = document.createElement('div');
  grpOld.className = 'form-group';
  const lblOld = document.createElement('label');
  lblOld.htmlFor = 'account-old-password';
  lblOld.textContent = t('account.currentPwdLabel', null, 'Current Password *');
  const inpOld = document.createElement('input');
  inpOld.type = 'password';
  inpOld.id = 'account-old-password';
  inpOld.className = 'form-input';
  inpOld.required = true;
  grpOld.appendChild(lblOld);
  grpOld.appendChild(inpOld);
  form.appendChild(grpOld);

  const grpNew = document.createElement('div');
  grpNew.className = 'form-group';
  const lblNew = document.createElement('label');
  lblNew.htmlFor = 'account-new-password';
  lblNew.textContent = t('account.newPwdLabel', null, 'New Password *');
  const inpNew = document.createElement('input');
  inpNew.type = 'password';
  inpNew.id = 'account-new-password';
  inpNew.className = 'form-input';
  inpNew.required = true;
  inpNew.minLength = 8;
  grpNew.appendChild(lblNew);
  grpNew.appendChild(inpNew);
  form.appendChild(grpNew);

  const grpConfirm = document.createElement('div');
  grpConfirm.className = 'form-group';
  const lblConfirm = document.createElement('label');
  lblConfirm.htmlFor = 'account-confirm-password';
  lblConfirm.textContent = t('account.confirmPwdLabel', null, 'Confirm New Password *');
  const inpConfirm = document.createElement('input');
  inpConfirm.type = 'password';
  inpConfirm.id = 'account-confirm-password';
  inpConfirm.className = 'form-input';
  inpConfirm.required = true;
  grpConfirm.appendChild(lblConfirm);
  grpConfirm.appendChild(inpConfirm);
  form.appendChild(grpConfirm);

  const btnSubmit = document.createElement('button');
  btnSubmit.type = 'submit';
  btnSubmit.className = 'btn btn-primary';
  btnSubmit.textContent = t('account.btnChangePwd', null, 'Update Password');
  form.appendChild(btnSubmit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const oldPassword = inpOld.value;
    const newPassword = inpNew.value;
    const confirmPassword = inpConfirm.value;

    if (newPassword !== confirmPassword) {
      showToast(getLocale() === 'zh-CN' ? '两次输入的新密码不一致' : 'New passwords do not match', 'error');
      return;
    }
    if (newPassword.length < 8) {
      showToast(getLocale() === 'zh-CN' ? '新密码长度至少需要 8 个字符' : 'New password must be at least 8 characters', 'error');
      return;
    }

    try {
      btnSubmit.disabled = true;
      btnSubmit.textContent = getLocale() === 'zh-CN' ? '正在更新...' : 'Updating...';
      const res = await apiRequest('/api/auth/password', {
        method: 'PUT',
        body: { oldPassword, newPassword },
      });

      if (res && res.success) {
        showToast(getLocale() === 'zh-CN' ? '密码已成功更新' : 'Password updated successfully', 'success');
        inpOld.value = '';
        inpNew.value = '';
        inpConfirm.value = '';
      }
    } catch (err) {
      showToast(getSafeErrorMessage(err, 'Failed to update password.'), 'error');
    } finally {
      btnSubmit.disabled = false;
      btnSubmit.textContent = t('account.btnChangePwd', null, 'Update Password');
    }
  });

  formCard.appendChild(form);
  pwdSection.appendChild(formCard);
  container.appendChild(pwdSection);

  // Theme Preference Section
  const themeSection = document.createElement('div');
  themeSection.className = 'management-section';
  const h3Theme = document.createElement('h3');
  h3Theme.textContent = t('account.themeSection', null, 'Theme Preference');
  themeSection.appendChild(h3Theme);

  const themeCard = document.createElement('div');
  themeCard.className = 'card-panel';
  const grpTheme = document.createElement('div');
  grpTheme.className = 'form-group';
  const lblTheme = document.createElement('label');
  lblTheme.htmlFor = 'account-theme-select';
  lblTheme.textContent = t('account.themeSelectLabel', null, 'Color Theme');
  grpTheme.appendChild(lblTheme);

  const themeSelect = document.createElement('select');
  themeSelect.id = 'account-theme-select';
  themeSelect.className = 'form-select theme-select-control';
  themeSelect.setAttribute('aria-label', t('common.selectTheme', null, 'Select Theme'));

  const optDark = document.createElement('option');
  optDark.value = 'dark';
  optDark.textContent = t('theme.dark', null, 'Dark');
  themeSelect.appendChild(optDark);

  const optLight = document.createElement('option');
  optLight.value = 'light';
  optLight.textContent = t('theme.light', null, 'Light');
  themeSelect.appendChild(optLight);

  const optEyeCare = document.createElement('option');
  optEyeCare.value = 'eye-care';
  optEyeCare.textContent = t('theme.eyeCare', null, 'Eye-care');
  themeSelect.appendChild(optEyeCare);

  themeSelect.value = getTheme();
  themeSelect.addEventListener('change', async (e) => {
    await handleThemeSelectChange(e.target.value);
  });

  grpTheme.appendChild(themeSelect);
  themeCard.appendChild(grpTheme);
  themeSection.appendChild(themeCard);
  container.appendChild(themeSection);

}

// 14. Admin Model Configuration View (GET /api/admin/model-config, PATCH /api/admin/model-config)
async function renderAdminModelsView(container) {
  let modelData = null;
  let isUnavailable = false;

  try {
    const res = await apiRequest('/api/admin/model-config');
    modelData = (res && res.data) || null;
  } catch (err) {
    isUnavailable = true;
  }

  container.replaceChildren();
  container.appendChild(createHeader('models.adminTitle', 'models.adminSubtitle', () => renderManagementView('management/models/model-config')));

  if (isUnavailable || !modelData) {
    container.appendChild(createStateCard('models.unavailableTitle', 'models.unavailableDesc', true));
    return;
  }

  const kpiGrid = document.createElement('div');
  kpiGrid.className = 'kpi-grid';

  const defModel = modelData.defaultModel ? `${modelData.defaultModel.provider} / ${modelData.defaultModel.model}` : (getLocale() === 'zh-CN' ? '未配置' : 'Unconfigured');
  const dshDef = modelData.dshDefaultModel ? `${modelData.dshDefaultModel.provider} / ${modelData.dshDefaultModel.model}` : (getLocale() === 'zh-CN' ? '无' : 'None');
  const hasOverride = Boolean(modelData.override && modelData.override.provider);
  const overrideBadge = hasOverride
    ? (getLocale() === 'zh-CN' ? '平台覆盖生效中' : 'Active Platform Override')
    : (getLocale() === 'zh-CN' ? '继承 DSH 默认设置' : 'Inheriting DSH Default');

  kpiGrid.appendChild(createKpiCard('models.kpiActiveDefault', defModel, overrideBadge));
  kpiGrid.appendChild(createKpiCard('models.kpiDshDefault', dshDef, getLocale() === 'zh-CN' ? '底层基准配置' : 'Underlying configuration'));
  kpiGrid.appendChild(createKpiCard('models.kpiProvidersCount', String(Object.keys(modelData.providers || {}).length), getLocale() === 'zh-CN' ? '本地配置中发现' : 'Discovered in local config'));
  container.appendChild(kpiGrid);

  // Effective Model Resolution Preview
  await renderEffectiveModelPreview(container, state.currentSpaceId, state.currentSessionId);

  // Model Override Form
  const formSection = document.createElement('div');
  formSection.className = 'management-section';
  const sHeadForm = document.createElement('div');
  sHeadForm.className = 'section-header';
  const h3Form = document.createElement('h3');
  h3Form.textContent = t('models.overrideSectionTitle', null, 'Override Default Model');
  sHeadForm.appendChild(h3Form);

  if (modelData.revision) {
    const revBadge = document.createElement('span');
    revBadge.className = 'badge badge-xs text-muted mono-cell';
    revBadge.textContent = t('models.labelRevision', { revision: modelData.revision.slice(0, 12) }, `Revision: ${modelData.revision.slice(0, 12)}`);
    sHeadForm.appendChild(revBadge);
  }
  formSection.appendChild(sHeadForm);

  const cardPanel = document.createElement('div');
  cardPanel.className = 'card-panel';

  const form = document.createElement('form');
  form.id = 'form-model-override';

  const grpProvider = document.createElement('div');
  grpProvider.className = 'form-group';
  const lblProvider = document.createElement('label');
  lblProvider.htmlFor = 'select-override-provider';
  lblProvider.textContent = t('models.labelProvider', null, 'Provider *');
  const selProvider = document.createElement('select');
  selProvider.id = 'select-override-provider';
  selProvider.className = 'form-select';
  selProvider.required = true;

  const providersMap = modelData.providers || {};
  Object.keys(providersMap).forEach((pkey) => {
    const opt = document.createElement('option');
    opt.value = pkey;
    const configuredLabel = providersMap[pkey].configured
      ? (getLocale() === 'zh-CN' ? '已配置' : 'configured')
      : (getLocale() === 'zh-CN' ? '未配置 Token' : 'no token');
    opt.textContent = `${providersMap[pkey].displayName || pkey} (${configuredLabel})`;
    selProvider.appendChild(opt);
  });

  if (modelData.defaultModel && modelData.defaultModel.provider) {
    selProvider.value = modelData.defaultModel.provider;
  }
  grpProvider.appendChild(lblProvider);
  grpProvider.appendChild(selProvider);
  form.appendChild(grpProvider);

  const grpModel = document.createElement('div');
  grpModel.className = 'form-group';
  const lblModel = document.createElement('label');
  lblModel.htmlFor = 'select-override-model';
  lblModel.textContent = t('models.labelModel', null, 'Model *');
  const selModel = document.createElement('select');
  selModel.id = 'select-override-model';
  selModel.className = 'form-select';
  selModel.required = true;

  function populateModels(providerKey) {
    selModel.replaceChildren();
    const p = providersMap[providerKey];
    if (p && Array.isArray(p.models) && p.models.length > 0) {
      p.models.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name ? `${m.name} (${m.id})` : m.id;
        selModel.appendChild(opt);
      });
    } else {
      const opt = document.createElement('option');
      opt.value = 'default';
      opt.textContent = t('common.defaultOption', null, 'default');
      selModel.appendChild(opt);
    }
  }

  populateModels(selProvider.value);
  if (modelData.defaultModel && modelData.defaultModel.model) {
    selModel.value = modelData.defaultModel.model;
  }

  selProvider.addEventListener('change', () => {
    populateModels(selProvider.value);
  });

  grpModel.appendChild(lblModel);
  grpModel.appendChild(selModel);
  form.appendChild(grpModel);

  // Apply Mode selection (default: restart_all, advanced option: save_only)
  const grpApplyMode = document.createElement('div');
  grpApplyMode.className = 'form-group';
  const lblApplyMode = document.createElement('label');
  lblApplyMode.htmlFor = 'select-override-apply-mode';
  lblApplyMode.textContent = t('models.labelApplyMode', null, 'Apply Mode');
  const selApplyMode = document.createElement('select');
  selApplyMode.id = 'select-override-apply-mode';
  selApplyMode.className = 'form-select';

  const optRestartAll = document.createElement('option');
  optRestartAll.value = 'restart_all';
  optRestartAll.textContent = t('models.applyModeRestartAll', null, 'Save & Rolling Restart All Runtimes (Recommended)');
  selApplyMode.appendChild(optRestartAll);

  const optSaveOnly = document.createElement('option');
  optSaveOnly.value = 'save_only';
  optSaveOnly.textContent = t('models.applyModeSaveOnly', null, 'Save Configuration Only (Restart Later)');
  selApplyMode.appendChild(optSaveOnly);

  grpApplyMode.appendChild(lblApplyMode);
  grpApplyMode.appendChild(selApplyMode);
  form.appendChild(grpApplyMode);

  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'flex-row-center';

  const btnSave = document.createElement('button');
  btnSave.type = 'submit';
  btnSave.className = 'btn btn-primary';
  btnSave.textContent = t('models.btnSaveOverride', null, 'Save Platform Override');
  actionsDiv.appendChild(btnSave);

  if (hasOverride) {
    const btnReset = document.createElement('button');
    btnReset.type = 'button';
    btnReset.className = 'btn btn-secondary';
    btnReset.textContent = t('models.btnResetOverride', null, 'Reset to DSH Default');
    btnReset.addEventListener('click', async () => {
      const modalTitle = getLocale() === 'zh-CN' ? '重置模型覆盖' : 'Reset Model Override';
      const modalMsg = getLocale() === 'zh-CN' ? '确定清除平台模型覆盖并恢复为 DSH 配置默认值吗？' : 'Clear the platform model override and revert to the DSH configuration default?';
      showConfirmation(
        modalTitle,
        modalMsg,
        async () => {
          try {
            await apiRequest('/api/admin/model-config', {
              method: 'PATCH',
              headers: modelData.revision ? { 'If-Match': modelData.revision } : {},
              body: { clear: true, applyMode: selApplyMode.value },
            });
            showToast(getLocale() === 'zh-CN' ? '已清除模型覆盖' : 'Model override cleared', 'success');
            await renderManagementView('management/models/model-config');
          } catch (err) {
            showToast(getSafeErrorMessage(err, 'Failed to clear model override.'), 'error');
          }
        }
      );
    });
    actionsDiv.appendChild(btnReset);
  }

  form.appendChild(actionsDiv);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const provider = selProvider.value;
    const model = selModel.value;
    const applyMode = selApplyMode.value || 'restart_all';

    try {
      btnSave.disabled = true;
      btnSave.textContent = t('models.saving', null, 'Saving & Applying...');

      const patchHeaders = {};
      if (modelData.revision) {
        patchHeaders['If-Match'] = modelData.revision;
      }

      const patchRes = await apiRequest('/api/admin/model-config', {
        method: 'PATCH',
        headers: patchHeaders,
        body: {
          provider,
          model,
          applyMode,
          ifMatch: modelData.revision,
        },
      });

      const updated = patchRes && patchRes.data;
      const appliedCount = Array.isArray(updated?.appliedRuntimes) ? updated.appliedRuntimes.length : 0;
      const failedList = Array.isArray(updated?.failedRuntimes) ? updated.failedRuntimes : [];

      if (updated?.restartStatus === 'success') {
        showToast(
          t('models.saveSuccess', { count: appliedCount }, `Model configuration saved and applied (${appliedCount} runtimes restarted)`),
          'success'
        );
      } else if (updated?.restartStatus === 'partial') {
        const failedDetails = failedList.map((f) => `${f.userId}: ${f.error}`).join('; ');
        showToast(
          t('models.savePartial', { details: failedDetails }, `Configuration saved, but some runtimes failed to restart: ${failedDetails}`),
          'warning'
        );
      } else if (updated?.restartStatus === 'failed') {
        const failedDetails = failedList.map((f) => `${f.userId}: ${f.error}`).join('; ') || 'Unknown runtime error';
        showToast(
          t('models.saveFailed', { details: failedDetails }, `Configuration saved, but runtime restart failed: ${failedDetails}`),
          'error'
        );
      } else if (updated?.restartStatus === 'skipped') {
        showToast(t('models.saveSkipped', null, 'Model configuration saved (restart skipped)'), 'info');
      } else {
        showToast(getLocale() === 'zh-CN' ? '模型覆盖保存成功' : 'Model override saved successfully', 'success');
      }

      await renderManagementView('management/models/model-config');
    } catch (err) {
      showToast(getSafeErrorMessage(err, 'Failed to save model override.'), 'error');
    } finally {
      btnSave.disabled = false;
      btnSave.textContent = t('models.btnSaveOverride', null, 'Save Platform Override');
    }
  });

  cardPanel.appendChild(form);
  formSection.appendChild(cardPanel);
  container.appendChild(formSection);

  // Providers List Table
  const tableSection = document.createElement('div');
  tableSection.className = 'management-section';
  const h3Table = document.createElement('h3');
  h3Table.textContent = t('models.providersTableTitle', null, 'Discovered Providers & Credential Status');
  tableSection.appendChild(h3Table);

  const tableContainer = document.createElement('div');
  tableContainer.className = 'data-table-container';
  const table = document.createElement('table');
  table.className = 'data-table';

  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');
  const cols = ['Provider ID', 'Display Name', 'Protocol API', 'Configured Status', 'Available Models'];
  const colKeys = ['models.colProviderId', 'models.colDisplayName', 'models.colProtocol', 'models.colConfigured', 'models.colModels'];
  cols.forEach((col, idx) => {
    const th = document.createElement('th');
    th.textContent = t(colKeys[idx], null, col);
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  Object.keys(providersMap).forEach((pkey) => {
    const p = providersMap[pkey];
    const tr = document.createElement('tr');

    const tdId = document.createElement('td');
    tdId.className = 'mono-cell';
    tdId.textContent = p.id;
    tr.appendChild(tdId);

    const tdName = document.createElement('td');
    tdName.textContent = p.displayName || p.id;
    tr.appendChild(tdName);

    const tdApi = document.createElement('td');
    tdApi.className = 'mono-cell';
    tdApi.textContent = p.api || 'openai-completions';
    tr.appendChild(tdApi);

    const tdStatus = document.createElement('td');
    const statusLabel = p.configured ? (getLocale() === 'zh-CN' ? '已配置' : 'Configured') : (getLocale() === 'zh-CN' ? '未配置' : 'Unconfigured');
    tdStatus.appendChild(createBadgeElement(statusLabel, p.configured ? 'success' : 'danger'));
    tr.appendChild(tdStatus);

    const tdModels = document.createElement('td');
    const modelIds = (p.models || []).map((m) => m.id).join(', ') || '(none)';
    tdModels.textContent = modelIds;
    tr.appendChild(tdModels);

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  tableContainer.appendChild(table);
  tableSection.appendChild(tableContainer);
  container.appendChild(tableSection);

  // Health & Circuit Breakers Section
  const healthSection = document.createElement('div');
  healthSection.className = 'management-section';
  const sHeadHealth = document.createElement('div');
  sHeadHealth.className = 'section-header';
  const h3Health = document.createElement('h3');
  h3Health.textContent = t('models.healthSectionTitle', null, 'Model Health & Circuit Breakers');
  sHeadHealth.appendChild(h3Health);

  const btnResetBreakers = document.createElement('button');
  btnResetBreakers.type = 'button';
  btnResetBreakers.className = 'btn btn-sm btn-secondary';
  btnResetBreakers.textContent = t('models.btnResetBreaker', null, 'Reset Circuit Breakers');
  btnResetBreakers.addEventListener('click', async () => {
    try {
      btnResetBreakers.disabled = true;
      btnResetBreakers.textContent = t('models.btnResetBreakerRunning', null, 'Resetting...');
      const res = await apiRequest('/api/admin/models/circuit-breaker/reset', { method: 'POST', body: {} });
      const count = res && res.data && typeof res.data.resetCount === 'number' ? res.data.resetCount : 0;
      showToast(t('models.circuitResetSuccess', { count }, `Circuit breakers reset successfully (${count} reset)`), 'success');
      await renderManagementView('management/models/model-config');
    } catch (err) {
      showToast(getSafeErrorMessage(err, 'Failed to reset circuit breakers.'), 'error');
    } finally {
      btnResetBreakers.disabled = false;
      btnResetBreakers.textContent = t('models.btnResetBreaker', null, 'Reset Circuit Breakers');
    }
  });
  sHeadHealth.appendChild(btnResetBreakers);
  healthSection.appendChild(sHeadHealth);

  const healthTableContainer = document.createElement('div');
  healthTableContainer.className = 'data-table-container';
  const healthTable = document.createElement('table');
  healthTable.className = 'data-table';

  const theadHealth = document.createElement('thead');
  const trHeadHealth = document.createElement('tr');
  const healthColKeys = [
    'models.colProviderId',
    'models.labelModel',
    'models.colCircuitState',
    'models.colAvgLatency',
    'models.colErrorRate',
    'models.colFailures',
    'models.colActions',
  ];
  healthColKeys.forEach((k) => {
    const th = document.createElement('th');
    th.textContent = t(k, null, k);
    trHeadHealth.appendChild(th);
  });
  theadHealth.appendChild(trHeadHealth);
  healthTable.appendChild(theadHealth);

  const tbodyHealth = document.createElement('tbody');
  const summaries = Array.isArray(modelData.healthSummaries) ? modelData.healthSummaries : [];

  if (summaries.length > 0) {
    summaries.forEach((s) => {
      const tr = document.createElement('tr');

      const tdP = document.createElement('td');
      tdP.className = 'mono-cell';
      tdP.textContent = s.provider;
      tr.appendChild(tdP);

      const tdM = document.createElement('td');
      tdM.className = 'mono-cell';
      tdM.textContent = s.model;
      tr.appendChild(tdM);

      const tdState = document.createElement('td');
      const stateBadge = s.circuitState === 'closed'
        ? createBadgeElement(t('models.circuitClosed', null, 'Closed (Healthy)'), 'success')
        : (s.circuitState === 'half-open'
            ? createBadgeElement(t('models.circuitHalfOpen', null, 'Half-Open (Testing)'), 'warning')
            : createBadgeElement(t('models.circuitOpen', null, 'Open (Tripped)'), 'danger'));
      tdState.appendChild(stateBadge);
      tr.appendChild(tdState);

      const tdLat = document.createElement('td');
      tdLat.textContent = `${s.avgLatencyMs || 0} ms`;
      tr.appendChild(tdLat);

      const tdErr = document.createElement('td');
      tdErr.textContent = `${Math.round((s.errorRate || 0) * 100)}%`;
      tr.appendChild(tdErr);

      const tdFail = document.createElement('td');
      tdFail.textContent = String(s.consecutiveFailures || s.failureCount || 0);
      tr.appendChild(tdFail);

      const tdAct = document.createElement('td');
      const btnProbe = document.createElement('button');
      btnProbe.type = 'button';
      btnProbe.className = 'btn btn-xs btn-secondary';
      btnProbe.textContent = t('models.btnProbe', null, 'Probe Health');
      btnProbe.addEventListener('click', async () => {
        try {
          btnProbe.disabled = true;
          btnProbe.textContent = t('models.btnProbeRunning', null, 'Probing...');
          const probeRes = await apiRequest('/api/admin/models/probe', {
            method: 'POST',
            body: { provider: s.provider, model: s.model, mode: 'list_models' },
          });
          const pd = probeRes && probeRes.data;
          if (pd && pd.success) {
            showToast(t('models.probeSuccess', { latency: pd.latencyMs, tokens: pd.tokensUsed }, `Probe succeeded (${pd.latencyMs}ms, ${pd.tokensUsed} tokens)`), 'success');
          } else {
            showToast(t('models.probeFailed', { error: pd?.error || 'Probe failed' }, `Probe failed: ${pd?.error}`), 'error');
          }
          await renderManagementView('management/models/model-config');
        } catch (err) {
          showToast(getSafeErrorMessage(err, 'Probe execution failed.'), 'error');
        } finally {
          btnProbe.disabled = false;
          btnProbe.textContent = t('models.btnProbe', null, 'Probe Health');
        }
      });
      tdAct.appendChild(btnProbe);
      tr.appendChild(tdAct);

      tbodyHealth.appendChild(tr);
    });
  } else {
    // If no summaries, populate from providers
    Object.keys(providersMap).forEach((pkey) => {
      const p = providersMap[pkey];
      (p.models || []).forEach((m) => {
        const tr = document.createElement('tr');
        const tdP = document.createElement('td');
        tdP.className = 'mono-cell';
        tdP.textContent = pkey;
        tr.appendChild(tdP);

        const tdM = document.createElement('td');
        tdM.className = 'mono-cell';
        tdM.textContent = m.id;
        tr.appendChild(tdM);

        const tdState = document.createElement('td');
        tdState.appendChild(createBadgeElement(t('models.circuitClosed', null, 'Closed (Healthy)'), 'success'));
        tr.appendChild(tdState);

        const tdLat = document.createElement('td');
        tdLat.textContent = '0 ms';
        tr.appendChild(tdLat);

        const tdErr = document.createElement('td');
        tdErr.textContent = '0%';
        tr.appendChild(tdErr);

        const tdFail = document.createElement('td');
        tdFail.textContent = '0';
        tr.appendChild(tdFail);

        const tdAct = document.createElement('td');
        const btnProbe = document.createElement('button');
        btnProbe.type = 'button';
        btnProbe.className = 'btn btn-xs btn-secondary';
        btnProbe.textContent = t('models.btnProbe', null, 'Probe Health');
        btnProbe.addEventListener('click', async () => {
          try {
            btnProbe.disabled = true;
            btnProbe.textContent = t('models.btnProbeRunning', null, 'Probing...');
            const probeRes = await apiRequest('/api/admin/models/probe', {
              method: 'POST',
              body: { provider: pkey, model: m.id, mode: 'list_models' },
            });
            const pd = probeRes && probeRes.data;
            if (pd && pd.success) {
              showToast(t('models.probeSuccess', { latency: pd.latencyMs, tokens: pd.tokensUsed }, `Probe succeeded (${pd.latencyMs}ms, ${pd.tokensUsed} tokens)`), 'success');
            } else {
              showToast(t('models.probeFailed', { error: pd?.error || 'Probe failed' }, `Probe failed: ${pd?.error}`), 'error');
            }
            await renderManagementView('management/models/model-config');
          } catch (err) {
            showToast(getSafeErrorMessage(err, 'Probe execution failed.'), 'error');
          } finally {
            btnProbe.disabled = false;
            btnProbe.textContent = t('models.btnProbe', null, 'Probe Health');
          }
        });
        tdAct.appendChild(btnProbe);
        tr.appendChild(tdAct);

        tbodyHealth.appendChild(tr);
      });
    });
  }

  healthTable.appendChild(tbodyHealth);
  healthTableContainer.appendChild(healthTable);
  healthSection.appendChild(healthTableContainer);
  container.appendChild(healthSection);
}

// ----------------------------------------------------
// Chat & Workspace Internationalization Helpers
// ----------------------------------------------------

const CHAT_I18N_EN = {
  'chat.navLabel': 'Chat',
  'chat.spacesHeader': 'Spaces',
  'chat.newSpace': '+ Space',
  'chat.newSpaceTitle': 'Create a new space',
  'chat.selectSpaceAria': 'Select active workspace space',
  'chat.renameSpace': 'Rename',
  'chat.renameSpaceTitle': 'Rename current space',
  'chat.archiveSpace': 'Archive',
  'chat.archiveSpaceTitle': 'Archive current space',
  'chat.restoreSpace': 'Restore',
  'chat.restoreSpaceTitle': 'Restore current space',
  'chat.noSpacesAvailable': 'No spaces available',
  'chat.untitledSpace': 'Untitled Space',
  'chat.sessionsHeader': 'Sessions',
  'chat.showArchived': 'Archived',
  'chat.archivedBadge': 'Archived',
  'chat.refreshSessionsTitle': 'Refresh sessions',
  'chat.newSession': '+ Session',
  'chat.newSessionTitle': 'Create a new chat session',
  'chat.forkSession': '🍴 Fork',
  'chat.forkSessionTitle': 'Fork session from current history',
  'chat.forkFromHere': 'Fork from here',
  'chat.forkFromHereTitle': 'Fork new session starting from this message',
  'chat.regenerate': 'Regenerate',
  'chat.regenerateTitle': 'Regenerate assistant response (creates branch)',
  'chat.edit': 'Edit',
  'chat.editTitle': 'Edit user message (creates branch)',
  'chat.reply': 'Reply',
  'chat.replyTitle': 'Quote and reply to this message',
  'chat.replyingTo': 'Replying to {name}',
  'chat.cancelReply': 'Cancel reply',
  'chat.quotedMessage': 'Quoted message',
  'chat.regenerateConfirm': 'Regenerate creates a new session branch. Do you want to continue?',
  'chat.editConfirm': 'Editing creates a new session branch. Do you want to continue?',
  'chat.unsavedDraftWarning': 'You have unsaved text in your composer. Switching to a new branch will preserve your draft in the previous session. Continue?',
  'chat.turnActiveCannotAction': 'Cannot perform this action while a turn is active.',
  'chat.messageNotFound': 'Referenced message not found.',
  'chat.searchSessionsPlaceholder': 'Search sessions...',
  'chat.searchSessionsAria': 'Search sessions',
  'chat.emptySessionsInSpace': 'No sessions in this space',
  'chat.emptyContent': 'Message content cannot be empty',
  'chat.noMatchingSessions': 'No matching sessions found',
  'chat.untitledSession': 'Untitled',
  'chat.liveSync': 'Live Sync',
  'chat.toggleSidebarTitle': 'Toggle sidebar',
  'chat.toggleSidebarAria': 'Toggle workspace sidebar',
  'chat.noSessionSelected': 'Select or create a session',
  'chat.sessionTitleHeader': 'Session: {title}',
  'chat.sessionRouteMeta': 'Route: {title}',
  'chat.routeActiveSession': 'Route: Active Session',
  'chat.activeSessionPrefix': 'Active Session: {title}',
  'chat.activeSessionEmpty': 'Active Session: -',
  'chat.refreshMessagesTitle': 'Refresh session messages',
  'chat.refreshMessages': '↻ Refresh',
  'chat.inspectTurnsTitle': 'Inspect session turns history',
  'chat.inspectTurns': '🔍 Turns',
  'chat.inspectGenerationsTitle': 'Inspect session generation lifecycle history',
  'chat.inspectGenerations': '📜 Generations',
  'chat.resetGenTitle': 'Reset session context to start Generation N+1',
  'chat.resetGen': '🔄 Reset Gen',
  'chat.renameSessionTitle': 'Rename current session',
  'chat.renameSession': '✎ Rename',
  'chat.archiveSessionTitle': 'Archive current session (Read-Only)',
  'chat.archiveSession': '📦 Archive',
  'chat.restoreSessionTitle': 'Restore current archived session',
  'chat.restoreSession': '♻️ Restore',
  'chat.stopTurnTitle': 'Stop current active turn',
  'chat.stopTurn': '⏹ Stop Turn',
  'chat.stoppingTurn': 'Stopping...',
  'chat.cancellingTurnTitle': 'Cancelling turn in progress...',
  'chat.emptyTitle': 'No active session',
  'chat.emptySubtitle': 'Select an existing session from the sidebar or create a new one to start collaborating.',
  'chat.readyToChatTitle': 'Ready to Chat',
  'chat.readyToChatSubtitle': 'This session is active. Send your first message below.',
  'chat.inputPlaceholder': 'Type a message or instruction for Enkeep agent...',
  'chat.inputArchivedPlaceholder': 'This session is archived (read-only).',
  'chat.charCount': '{current} / {max}',
  'chat.composerHint': 'Press Enter to send, Shift+Enter for new line',
  'chat.send': 'Send',
  'chat.statusThinking': 'Thinking...',
  'chat.statusActive': 'active',
  'chat.statusArchived': 'archived',
  'chat.genBadge': 'Gen {number}',
  'chat.genUnavailable': 'Gen Unavailable',
  'chat.currentBadge': 'Current',
  'chat.roleUser': 'You',
  'chat.roleAssistant': 'AI Assistant',
  'chat.roleSystem': 'System',
  'chat.roleUnknown': 'Unknown',
  'chat.timestampUnavailable': 'Timestamp unavailable',
  'chat.streamingStatus': 'Streaming...',
  'chat.thinkingBadge': 'thinking',
  'chat.streamingBadge': 'streaming',
  'chat.thinkingText': 'Thinking...',
  'chat.toolStarted': 'tool: {toolName}',
  'chat.toolStatus': 'tool {status}: {toolName}',
  'chat.copyCodeTitle': 'Copy code to clipboard',
  'chat.mermaidTitle': 'Mermaid Diagram',
  'chat.turnStarted': 'Started',
  'chat.turnFinished': 'Finished',
  'status.delivered': 'delivered',
  'status.pending': 'pending',
  'status.unknown': 'Unknown',
  'modal.archiveSpaceConfirmTitle': 'Archive Space',
  'modal.archiveSpaceConfirmMessage': 'Are you sure you want to archive space "{name}"? Active execution turns cannot be running.',
  'modal.restoreSpaceConfirmTitle': 'Restore Space',
  'modal.restoreSpaceConfirmMessage': 'Are you sure you want to restore space "{name}"? It will become active.',
  'modal.archiveSessionConfirmTitle': 'Archive Session',
  'modal.archiveSessionConfirmMessage': 'Are you sure you want to archive this session? It will become read-only.',
  'modal.restoreSessionConfirmTitle': 'Restore Session',
  'modal.restoreSessionConfirmMessage': 'Are you sure you want to restore this session? It will become active.',
  'modal.forkSessionTitle': 'Fork Session',
  'modal.forkSessionNotice': 'Forking creates an independent session branching from the selected history point. The original session remains completely unchanged.',
  'modal.forkFromMessagePrefix': 'Forking from message #',
  'modal.forkSessionTitleLabel': 'Forked Session Title',
  'modal.forkSessionTitlePlaceholder': 'e.g. Experiment with alternative solution',
  'modal.forkTargetSpaceLabel': 'Target Space',
  'modal.forkSessionButton': 'Fork Session',
  'modal.generationsUnavailableTitle': 'Generations Unavailable',
  'modal.generationsUnavailableSubtitle': 'Could not load generations history.',
  'modal.initialGenerationOnlyTitle': 'Initial Generation Only',
  'modal.initialGenerationOnlySubtitle': 'This session is currently at its initial base generation (Gen 1).',
  'modal.generations.resetReason': 'Reset Reason: {reason}',
  'modal.generations.resetReasonOmitted': 'Reset Reason: Omitted',
  'modal.turnsUnavailableTitle': 'Turns Unavailable',
  'modal.turnsUnavailableSubtitle': 'The session turns history service is unavailable.',
  'modal.noTurnHistoryTitle': 'No Turn History',
  'modal.noTurnHistorySubtitle': 'No turn execution records found for this session.',
  'toast.failedLoadSpaces': 'Failed to load spaces.',
  'toast.selectSpaceToRename': 'Select a space to rename',
  'toast.spaceNameRequired': 'Space name is required',
  'toast.spaceRenamed': 'Space renamed to "{name}"',
  'toast.failedRenameSpace': 'Failed to rename space.',
  'toast.failedRestoreSpace': 'Failed to restore space.',
  'toast.failedRestoreSession': 'Failed to restore session.',
  'toast.failedForkSession': 'Failed to fork session.',
  'toast.selectSpaceToArchive': 'Select a space to archive',
  'toast.spaceArchived': 'Space "{name}" archived successfully',
  'toast.spaceRestored': 'Space "{name}" restored successfully',
  'toast.failedArchiveSpace': 'Failed to archive space.',
  'toast.spaceCreated': 'Space "{name}" created!',
  'toast.failedCreateSpace': 'Failed to create space.',
  'toast.failedLoadSessions': 'Failed to load sessions.',
  'toast.refreshedSessions': 'Refreshed sessions list',
  'toast.failedSelectSession': 'Failed to select session.',
  'toast.selectActiveSessionFirst': 'Select an active session first',
  'toast.sessionTitleRequired': 'Session title is required',
  'toast.sessionRenamed': 'Session renamed to "{title}"',
  'toast.failedRenameSession': 'Failed to rename session.',
  'toast.selectActiveSessionToArchive': 'Select an active session to archive',
  'toast.sessionArchived': 'Session archived successfully',
  'toast.sessionRestored': 'Session "{title}" restored successfully',
  'toast.sessionForked': 'Session forked successfully! Switched to new branch.',
  'toast.failedArchiveSession': 'Failed to archive session.',
  'toast.cryptoUnavailable': 'Cryptographic context unavailable. Cannot generate Idempotency-Key.',
  'toast.sessionResetSuccess': 'Session reset successfully to Generation {gen}. History preserved!',
  'toast.failedResetSession': 'Failed to reset session.',
  'toast.selectTargetSpaceFirst': 'Please select a target space first',
  'toast.sessionCreated': 'Session "{title}" created!',
  'toast.refreshedMessages': 'Refreshed session messages',
  'toast.turnNotCancellable': 'Turn is no longer in a cancellable state.',
  'toast.turnStoppedSuccess': 'Turn stopped successfully.',
  'toast.turnAlreadyCompleted': 'Turn had already completed or settled.',
  'chat.viewQuota': 'View Quota',
  'chat.viewQuotaTitle': 'View resource quota and limits',
  'toast.openQuota': 'Open Quota',
  'toast.quotaExceededTokens': 'Token quota exhausted. Open Account / Quota or contact admin.',
  'toast.quotaExceededGeneral': 'Resource quota exhausted. Open Account / Quota or contact admin.',
  'toast.recoveryRequiredTurn': 'Session corrupted or recovery required. Please reset generation or retry.',
  'toast.executionFailedTurn': 'Turn execution failed. Please retry or reset generation.',
  'toast.retryRequiredTurn': 'Turn encountered a temporary issue. Please retry.',
  'toast.turnTimeout': 'Turn execution timed out. Please retry.',
  'toast.leaseLost': 'Execution lease lost to another worker. Please retry.',
  'status.quota_exceeded': 'Quota Exceeded',
  'status.execution_failed': 'Execution Failed',
  'status.retry_required': 'Retry Required',
  'status.turn_timeout': 'Turn Timeout',
  'status.lease_lost': 'Lease Lost',
  'chat.queuedChip': '⏳ Turn Queued',
  'chat.recoveryRequired': '⚠️ Session corrupted or failed. Please reset generation or retry.',
  'chat.retryMessage': 'Retry',
  'chat.retryMessageTitle': 'Retry sending this user message',
  'chat.resetGeneration': '🔄 Reset Gen',
  'chat.resetGenerationTitle': 'Reset session generation to recover clean agent state',
  'chat.syncError': '⚠️ Sync issue',
  'toast.turnAlreadyRunning': 'Another turn is already in progress. Please wait for it to finish.',
  'toast.sessionArchivedCannotSend': 'This session or space is archived and cannot accept new messages.',
  'toast.serviceUnavailable': 'Agent service is temporarily unavailable. Please try again shortly.',
  'toast.idempotencyConflict': 'Message submission conflict. Please retry.',
  'toast.turnNotFound': 'Turn not found or session closed.',
  'toast.turnStateConflict': 'Turn state conflict (already finished).',
  'toast.cryptoSendUnavailable': 'Secure cryptographic context (crypto.randomUUID) is unavailable. Message sending disabled.',
  'toast.sessionExpired': 'Session expired or unauthorized. Please sign in again.',
  'toast.pollingForbidden': 'Access forbidden (403). Polling stopped.',
  'toast.pollingNotFound': 'Session not found. Polling stopped.',
  'toast.pollingServerError': 'Repeated server errors encountered. Polling stopped.',
  'toast.pollingNetworkIssue': 'Network issue encountered while polling events. Retrying...',
  'toast.pollingConnectionLost': 'Connection lost. Polling stopped after repeated failures.',
  'error.createSpace': 'Failed to create space.',
  'error.renameSpace': 'Failed to rename space.',
  'error.archiveSpace': 'Failed to archive space.',
  'error.createSession': 'Failed to create chat session.',
  'error.renameSession': 'Failed to rename session.',
  'error.archiveSession': 'Failed to archive session.',
  'error.resetSession': 'Failed to reset session.',
  'error.loadMessages': 'Failed to load session messages.',
  'error.sendMessage': 'Failed to send message.',
  'error.stopTurn': 'Failed to stop turn.',
  'error.pollEvents': 'Error synchronizing session events.',
};

const CHAT_I18N_ZH = {
  'chat.navLabel': '对话',
  'chat.spacesHeader': '空间',
  'chat.newSpace': '+ 空间',
  'chat.newSpaceTitle': '创建新空间',
  'chat.selectSpaceAria': '选择当前工作区空间',
  'chat.renameSpace': '重命名',
  'chat.renameSpaceTitle': '重命名当前空间',
  'chat.archiveSpace': '归档',
  'chat.archiveSpaceTitle': '归档当前空间',
  'chat.restoreSpace': '恢复',
  'chat.restoreSpaceTitle': '恢复当前空间',
  'chat.noSpacesAvailable': '无可用空间',
  'chat.untitledSpace': '未命名空间',
  'chat.sessionsHeader': '会话',
  'chat.showArchived': '已归档',
  'chat.archivedBadge': '已归档',
  'chat.refreshSessionsTitle': '刷新会话列表',
  'chat.newSession': '+ 会话',
  'chat.newSessionTitle': '创建新对话会话',
  'chat.forkSession': '🍴 分支派生',
  'chat.forkSessionTitle': '基于当前历史派生平行分支会话',
  'chat.forkFromHere': '从此派生分支',
  'chat.forkFromHereTitle': '从该条消息处派生新的平行会话',
  'chat.regenerate': '重新生成',
  'chat.regenerateTitle': '重新生成助手回复（派生新分支）',
  'chat.edit': '编辑',
  'chat.editTitle': '编辑用户消息（派生新分支）',
  'chat.reply': '引用回复',
  'chat.replyTitle': '引用此条消息进行回复',
  'chat.replyingTo': '正在回复 {name}',
  'chat.cancelReply': '取消引用',
  'chat.quotedMessage': '引用消息',
  'chat.regenerateConfirm': '重新生成将创建新的会话分支，是否继续？',
  'chat.editConfirm': '编辑历史消息将创建新的会话分支，是否继续？',
  'chat.unsavedDraftWarning': '当前输入框中有未发送的内容，切换到新分支将保留原草稿，是否继续？',
  'chat.turnActiveCannotAction': '当前轮次正在执行中，无法执行此操作。',
  'chat.messageNotFound': '引用的消息未找到。',
  'chat.searchSessionsPlaceholder': '搜索会话...',
  'chat.searchSessionsAria': '搜索会话',
  'chat.emptySessionsInSpace': '该空间下暂无会话',
  'chat.emptyContent': '消息内容不能为空',
  'chat.noMatchingSessions': '未找到匹配的会话',
  'chat.untitledSession': '未命名',
  'chat.liveSync': '实时同步',
  'chat.toggleSidebarTitle': '切换侧边栏',
  'chat.toggleSidebarAria': '切换工作区侧边栏',
  'chat.noSessionSelected': '选择或创建一个会话',
  'chat.sessionTitleHeader': '会话: {title}',
  'chat.sessionRouteMeta': '路由: {title}',
  'chat.routeActiveSession': '路由: 活跃会话',
  'chat.activeSessionPrefix': '当前会话: {title}',
  'chat.activeSessionEmpty': '当前会话: -',
  'chat.refreshMessagesTitle': '刷新会话消息',
  'chat.refreshMessages': '↻ 刷新',
  'chat.inspectTurnsTitle': '查看会话轮次历史',
  'chat.inspectTurns': '🔍 轮次历史',
  'chat.inspectGenerationsTitle': '查看会话世代生命周期历史',
  'chat.inspectGenerations': '📜 世代历史',
  'chat.resetGenTitle': '重置会话上下文以开启第 N+1 代',
  'chat.resetGen': '🔄 重置世代',
  'chat.renameSessionTitle': '重命名当前会话',
  'chat.renameSession': '✎ 重命名',
  'chat.archiveSessionTitle': '归档当前会话（只读）',
  'chat.archiveSession': '📦 归档',
  'chat.restoreSessionTitle': '恢复当前已归档会话',
  'chat.restoreSession': '♻️ 恢复',
  'chat.stopTurnTitle': '停止当前活跃轮次',
  'chat.stopTurn': '⏹ 停止轮次',
  'chat.stoppingTurn': '正在停止...',
  'chat.cancellingTurnTitle': '正在取消执行中的轮次...',
  'chat.emptyTitle': '无活跃会话',
  'chat.emptySubtitle': '从侧边栏选择已有会话或创建新会话以开始协作。',
  'chat.readyToChatTitle': '准备就绪',
  'chat.readyToChatSubtitle': '该会话处于活跃状态，在下方发送您的第一条消息。',
  'chat.inputPlaceholder': '输入消息或指令给 Enkeep 智能体...',
  'chat.inputArchivedPlaceholder': '该会话已被归档（只读）。',
  'chat.charCount': '{current} / {max}',
  'chat.composerHint': '按 Enter 发送，Shift+Enter 换行',
  'chat.send': '发送',
  'chat.statusThinking': '思考中...',
  'chat.statusActive': '活跃',
  'chat.statusArchived': '已归档',
  'chat.genBadge': '第 {number} 代',
  'chat.genUnavailable': '世代不可用',
  'chat.currentBadge': '当前',
  'chat.roleUser': '您',
  'chat.roleAssistant': 'AI 助手',
  'chat.roleSystem': '系统',
  'chat.roleUnknown': '未知',
  'chat.timestampUnavailable': '时间戳不可用',
  'chat.streamingStatus': '流式传输中...',
  'chat.thinkingBadge': '思考中',
  'chat.streamingBadge': '流式传输中',
  'chat.thinkingText': '思考中...',
  'chat.toolStarted': '工具: {toolName}',
  'chat.toolStatus': '工具 {status}: {toolName}',
  'chat.copyCodeTitle': '复制代码到剪贴板',
  'chat.mermaidTitle': 'Mermaid 架构图',
  'chat.turnStarted': '开始时间',
  'chat.turnFinished': '结束时间',
  'status.delivered': '已投递',
  'status.pending': '待处理',
  'status.unknown': '未知',
  'modal.archiveSpaceConfirmTitle': '归档空间',
  'modal.archiveSpaceConfirmMessage': '您确定要归档空间“{name}”吗？不能有正在运行中的执行轮次。',
  'modal.restoreSpaceConfirmTitle': '恢复空间',
  'modal.restoreSpaceConfirmMessage': '确定要恢复空间“{name}”吗？恢复后将重新激活。',
  'modal.archiveSessionConfirmTitle': '归档会话',
  'modal.archiveSessionConfirmMessage': '您确定要归档此会话吗？归档后将变为只读状态。',
  'modal.restoreSessionConfirmTitle': '恢复会话',
  'modal.restoreSessionConfirmMessage': '确定要恢复此会话吗？恢复后将重新激活。',
  'modal.forkSessionTitle': '会话分支派生 (Fork)',
  'modal.forkSessionNotice': '派生会话将基于所选历史节点创建完全独立的平行会话，原始会话历史保持不变。',
  'modal.forkFromMessagePrefix': '从消息节点派生：',
  'modal.forkSessionTitleLabel': '分支会话标题',
  'modal.forkSessionTitlePlaceholder': '例如：尝试另一种解决方案',
  'modal.forkTargetSpaceLabel': '目标空间',
  'modal.forkSessionButton': '立即派生分支',
  'modal.generationsUnavailableTitle': '世代历史不可用',
  'modal.generationsUnavailableSubtitle': '无法加载世代历史记录。',
  'modal.initialGenerationOnlyTitle': '仅初始世代',
  'modal.initialGenerationOnlySubtitle': '该会话当前处于初始基础世代（第 1 代）。',
  'modal.generations.resetReason': '重置原因: {reason}',
  'modal.generations.resetReasonOmitted': '重置原因: 未填写',
  'modal.turnsUnavailableTitle': '轮次历史不可用',
  'modal.turnsUnavailableSubtitle': '会话轮次历史服务当前不可用。',
  'modal.noTurnHistoryTitle': '无轮次记录',
  'modal.noTurnHistorySubtitle': '此会话暂无执行轮次记录。',
  'toast.failedLoadSpaces': '加载空间列表失败。',
  'toast.selectSpaceToRename': '请选择要重命名的空间',
  'toast.spaceNameRequired': '空间名称不能为空',
  'toast.spaceRenamed': '空间已重命名为“{name}”',
  'toast.failedRenameSpace': '重命名空间失败。',
  'toast.failedRestoreSpace': '恢复空间失败。',
  'toast.failedRestoreSession': '恢复会话失败。',
  'toast.failedForkSession': '派生会话失败。',
  'toast.selectSpaceToArchive': '请选择要归档的空间',
  'toast.spaceArchived': '空间“{name}”已成功归档',
  'toast.spaceRestored': '空间“{name}”已成功恢复',
  'toast.failedArchiveSpace': '归档空间失败。',
  'toast.spaceCreated': '空间“{name}”创建成功！',
  'toast.failedCreateSpace': '创建空间失败。',
  'toast.failedLoadSessions': '加载会话列表失败。',
  'toast.refreshedSessions': '已刷新会话列表',
  'toast.failedSelectSession': '选择会话失败。',
  'toast.selectActiveSessionFirst': '请先选择一个活跃会话',
  'toast.sessionTitleRequired': '会话标题不能为空',
  'toast.sessionRenamed': '会话已重命名为“{title}”',
  'toast.failedRenameSession': '重命名会话失败。',
  'toast.selectActiveSessionToArchive': '请选择要归档的活跃会话',
  'toast.sessionArchived': '会话已成功归档',
  'toast.sessionRestored': '会话“{title}”已成功恢复',
  'toast.sessionForked': '会话分支派生成功！已切换至新分支。',
  'toast.failedArchiveSession': '归档会话失败。',
  'toast.cryptoUnavailable': '密码学安全上下文不可用，无法生成幂等键。',
  'toast.sessionResetSuccess': '会话已成功重置至第 {gen} 代，历史记录完整保留！',
  'toast.failedResetSession': '重置会话失败。',
  'toast.selectTargetSpaceFirst': '请先选择目标空间',
  'toast.sessionCreated': '会话“{title}”创建成功！',
  'toast.refreshedMessages': '已刷新会话消息',
  'toast.turnNotCancellable': '轮次已不处于可取消状态。',
  'toast.turnStoppedSuccess': '轮次已成功停止。',
  'toast.turnAlreadyCompleted': '轮次已经完成或结算。',
  'chat.viewQuota': '查看配额',
  'chat.viewQuotaTitle': '查看资源配额与限制',
  'toast.openQuota': '打开配额',
  'toast.quotaExceededTokens': 'Token 配额已耗尽。请打开“账户 / 配额”或联系管理员。',
  'toast.quotaExceededGeneral': '资源配额已耗尽。请打开“账户 / 配额”或联系管理员。',
  'toast.recoveryRequiredTurn': '会话异常需要恢复，请重置世代或重试。',
  'toast.executionFailedTurn': '轮次执行失败，请重试或重置世代。',
  'toast.retryRequiredTurn': '轮次遇到临时异常，请重试。',
  'toast.turnTimeout': '轮次执行超时，请重试。',
  'toast.leaseLost': '执行租约已失效，请重试。',
  'status.quota_exceeded': '配额耗尽',
  'status.execution_failed': '执行失败',
  'status.retry_required': '需要重试',
  'status.turn_timeout': '轮次超时',
  'status.lease_lost': '租约丢失',
  'chat.queuedChip': '⏳ 轮次排队中',
  'chat.recoveryRequired': '⚠️ 会话日志异常或执行中断，请重置世代或派生新分支恢复。',
  'chat.retryMessage': '重试',
  'chat.retryMessageTitle': '重试发送此用户消息',
  'chat.resetGeneration': '🔄 重置世代',
  'chat.resetGenerationTitle': '重置会话世代以恢复干净的智能体运行状态',
  'chat.syncError': '⚠️ 同步异常',
  'toast.turnAlreadyRunning': '另一个轮次正在进行中，请等待其完成后再发送。',
  'toast.sessionArchivedCannotSend': '当前会话或空间已被归档，无法发送新消息。',
  'toast.serviceUnavailable': '智能体服务暂时不可用，请稍后重试。',
  'toast.idempotencyConflict': '消息提交冲突，请重试。',
  'toast.turnNotFound': '未找到轮次或会话已关闭。',
  'toast.turnStateConflict': '轮次状态冲突（已结束）。',
  'toast.cryptoSendUnavailable': '安全密码学上下文不可用，消息发送已禁用。',
  'toast.sessionExpired': '登录会话已过期或未授权，请重新登录。',
  'toast.pollingForbidden': '访问被禁止 (403)，轮询已停止。',
  'toast.pollingNotFound': '会话不存在，轮询已停止。',
  'toast.pollingServerError': '多次遇到服务器错误，轮询已停止。',
  'toast.pollingNetworkIssue': '轮询事件时遇到网络问题，正在重试...',
  'toast.pollingConnectionLost': '网络连接丢失，多次失败后已停止轮询。',
  'error.createSpace': '创建空间失败。',
  'error.renameSpace': '重命名空间失败。',
  'error.archiveSpace': '归档空间失败。',
  'error.createSession': '创建对话会话失败。',
  'error.renameSession': '重命名会话失败。',
  'error.archiveSession': '归档会话失败。',
  'error.resetSession': '重置会话失败。',
  'error.loadMessages': '加载会话消息失败。',
  'error.sendMessage': '发送消息失败。',
  'error.stopTurn': '停止轮次失败。',
  'error.pollEvents': '同步会话事件时发生错误。',
};

// Seamless integration into catalogs
if (typeof catalogs !== 'undefined' && catalogs) {
  if (catalogs.en) Object.assign(catalogs.en, CHAT_I18N_EN);
  if (catalogs['zh-CN']) Object.assign(catalogs['zh-CN'], CHAT_I18N_ZH);
}
if (typeof window !== 'undefined' && window.EnkeepI18n && window.EnkeepI18n.catalogs) {
  if (window.EnkeepI18n.catalogs.en) Object.assign(window.EnkeepI18n.catalogs.en, CHAT_I18N_EN);
  if (window.EnkeepI18n.catalogs['zh-CN']) Object.assign(window.EnkeepI18n.catalogs['zh-CN'], CHAT_I18N_ZH);
}

function tr(key, params, fallback) {
  if (typeof window !== 'undefined' && window.EnkeepI18n && typeof window.EnkeepI18n.t === 'function') {
    const res = window.EnkeepI18n.t(key, params);
    if (res && res !== key) return res;
  }
  if (typeof window !== 'undefined' && typeof window.t === 'function') {
    const res = window.t(key, params);
    if (res && res !== key) return res;
  }
  if (typeof t === 'function') {
    try {
      const res = t(key, params);
      if (res && res !== key) return res;
    } catch (tErr) {
      // Fall through to active catalog lookup
    }
  }
  const activeCatalog = (getLocale() === 'zh-CN' ? CHAT_I18N_ZH : CHAT_I18N_EN) || {};
  if (activeCatalog[key]) {
    const template = activeCatalog[key];
    if (!params || typeof params !== 'object') return template;
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, k) => (params[k] !== undefined && params[k] !== null ? String(params[k]) : m));
  }
  if (typeof fallback === 'string') {
    if (!params || typeof params !== 'object') return fallback;
    return fallback.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, k) => (params[k] !== undefined && params[k] !== null ? String(params[k]) : m));
  }
  return key;
}

function formatDateTime(dateVal) {
  if (!dateVal) return '-';
  const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
  if (isNaN(d.getTime())) return tr('common.unavailable', null, 'Unavailable');
  try {
    const loc = typeof getLocale === 'function' ? getLocale() : 'en';
    return new Intl.DateTimeFormat(loc, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

function formatTime(dateVal) {
  if (!dateVal) return tr('chat.timestampUnavailable', null, 'Timestamp unavailable');
  const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
  if (isNaN(d.getTime())) return tr('chat.timestampUnavailable', null, 'Timestamp unavailable');
  try {
    const loc = typeof getLocale === 'function' ? getLocale() : 'en';
    return new Intl.DateTimeFormat(loc, {
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    }).format(d);
  } catch {
    return d.toLocaleTimeString();
  }
}

const KNOWN_STATUS_KEYS = {
  active: 'status.active',
  archived: 'status.archived',
  disabled: 'status.disabled',
  waiting_approval: 'status.waiting_approval',
  recovery_required: 'status.recovery_required',
  quota_exceeded: 'status.quota_exceeded',
  execution_failed: 'status.execution_failed',
  retry_required: 'status.retry_required',
  turn_timeout: 'status.turn_timeout',
  lease_lost: 'status.lease_lost',
  running: 'status.running',
  queued: 'status.queued',
  completed: 'status.completed',
  failed: 'status.failed',
  cancelled: 'status.cancelled',
  settled: 'status.completed',
  interrupted: 'status.cancelled',
  started: 'status.running',
  delivered: 'status.delivered',
  pending: 'status.pending',
  ok: 'status.ok',
  degraded: 'status.degraded',
  error: 'status.error',
  unavailable: 'status.unavailable',
};

const ALLOWED_FAILURE_CODES = new Set([
  'QUOTA_EXCEEDED',
  'RECOVERY_REQUIRED',
  'EXECUTION_FAILED',
  'RETRY_REQUIRED',
  'TURN_TIMEOUT',
  'LEASE_LOST',
]);

function extractPublicFailureCode(ev) {
  if (!ev || typeof ev !== 'object') return 'EXECUTION_FAILED';
  let rawPayload = ev.payload;
  if (typeof rawPayload === 'string') {
    try {
      rawPayload = JSON.parse(rawPayload);
    } catch {
      rawPayload = null;
    }
  }
  const candidate = (
    (typeof ev.code === 'string' && ev.code) ||
    (rawPayload && typeof rawPayload === 'object' && typeof rawPayload.code === 'string' && rawPayload.code) ||
    ''
  ).trim().toUpperCase();

  if (ALLOWED_FAILURE_CODES.has(candidate)) {
    return candidate;
  }
  return 'EXECUTION_FAILED';
}

function updateTurnStatusBadge(optionalApprovals = null) {
  const turnBadge = document.getElementById('session-turn-status-badge');
  if (!turnBadge) return;

  const approvals = Array.isArray(optionalApprovals) ? optionalApprovals : (state.pendingApprovals || []);
  const pendingApprovalsCount = approvals.filter((a) => a.status === 'pending').length;
  if (pendingApprovalsCount > 0) {
    turnBadge.classList.remove('hidden');
    turnBadge.className = 'badge badge-warning';
    turnBadge.textContent = t('approvals.chatWaitingBadge', null, 'Waiting Approval');
    return;
  }

  const st = state.activeTurnStatus;
  if (!st || st === 'completed' || st === 'settled' || !state.currentSessionId) {
    turnBadge.classList.add('hidden');
    return;
  }

  const norm = String(st).toLowerCase();
  if (norm === 'running' || norm === 'started') {
    turnBadge.classList.remove('hidden');
    turnBadge.className = 'badge badge-running';
    turnBadge.textContent = tr('chat.statusThinking', null, 'Thinking...');
  } else if (norm === 'queued') {
    turnBadge.classList.remove('hidden');
    turnBadge.className = 'badge badge-queued';
    turnBadge.textContent = tr('status.queued', null, 'Queued');
  } else if (norm === 'waiting_approval') {
    turnBadge.classList.remove('hidden');
    turnBadge.className = 'badge badge-waiting_approval';
    turnBadge.textContent = t('approvals.chatWaitingBadge', null, 'Waiting Approval');
  } else if (norm === 'interrupted' || norm === 'cancelled') {
    turnBadge.classList.remove('hidden');
    turnBadge.className = 'badge badge-warning';
    turnBadge.textContent = tr('status.cancelled', null, 'Cancelled');
  } else if (norm === 'quota_exceeded') {
    turnBadge.classList.remove('hidden');
    turnBadge.className = 'badge badge-quota_exceeded';
    turnBadge.textContent = tr('status.quota_exceeded', null, 'Quota Exceeded');
  } else if (norm === 'recovery_required') {
    turnBadge.classList.remove('hidden');
    turnBadge.className = 'badge badge-recovery_required';
    turnBadge.textContent = tr('status.recovery_required', null, 'Recovery Required');
  } else if (norm === 'execution_failed') {
    turnBadge.classList.remove('hidden');
    turnBadge.className = 'badge badge-execution_failed';
    turnBadge.textContent = tr('status.execution_failed', null, 'Execution Failed');
  } else if (norm === 'retry_required') {
    turnBadge.classList.remove('hidden');
    turnBadge.className = 'badge badge-retry_required';
    turnBadge.textContent = tr('status.retry_required', null, 'Retry Required');
  } else if (norm === 'turn_timeout') {
    turnBadge.classList.remove('hidden');
    turnBadge.className = 'badge badge-turn_timeout';
    turnBadge.textContent = tr('status.turn_timeout', null, 'Turn Timeout');
  } else if (norm === 'lease_lost') {
    turnBadge.classList.remove('hidden');
    turnBadge.className = 'badge badge-lease_lost';
    turnBadge.textContent = tr('status.lease_lost', null, 'Lease Lost');
  } else if (norm === 'failed') {
    turnBadge.classList.remove('hidden');
    turnBadge.className = 'badge badge-failed';
    turnBadge.textContent = tr('status.failed', null, 'Failed');
  } else {
    turnBadge.classList.add('hidden');
  }
}

function formatStatus(status) {
  if (!status || typeof status !== 'string') {
    return tr('status.unavailable', null, 'Unavailable');
  }
  const normalized = status.toLowerCase().trim();
  const key = KNOWN_STATUS_KEYS[normalized];
  if (key) {
    return tr(key, null, status);
  }
  return tr('status.unknown', null, 'Unknown');
}

function formatRole(role) {
  if (role === 'user') return tr('chat.roleUser', null, 'You');
  if (role === 'assistant') return tr('chat.roleAssistant', null, 'AI Assistant');
  if (role === 'system') return tr('chat.roleSystem', null, 'System');
  return tr('chat.roleUnknown', null, 'Unknown');
}

function formatToolName(toolName) {
  if (!toolName || typeof toolName !== 'string') {
    return 'tool';
  }
  const cleanName = toolName.trim();
  const key = `chat.tool_${cleanName}`;
  const localized = tr(key, null, '');
  if (localized && localized !== key && !localized.startsWith('chat.tool_')) {
    return localized;
  }
  return cleanName;
}

// ----------------------------------------------------
// Session Turn History Inspector (GET /api/sessions/:id/turns)
// Contract fields only: status, startedAt, finishedAt
// NO prompt, input, response, output, or raw errors rendered.
// ----------------------------------------------------

async function openSessionTurnsModal(sessionId) {
  const titleEl = document.getElementById('turns-modal-title');
  const contentEl = document.getElementById('turns-history-content');

  if (titleEl) {
    titleEl.textContent = tr('modal.turnsHistoryTitle', null, 'Turns History');
  }

  if (contentEl) {
    contentEl.replaceChildren(createSkeletonLoader());
  }

  openModal('modal-turns-history');

  try {
    const res = await apiRequest(`/api/sessions/${sessionId}/turns`);
    const raw = res && res.data;
    const turns = (raw && Array.isArray(raw.items)) ? raw.items : null;

    if (!contentEl) return;
    contentEl.replaceChildren();

    if (!turns) {
      contentEl.appendChild(
        createStateCard(
          tr('modal.turnsUnavailableTitle', null, 'Turns Unavailable'),
          tr('modal.turnsUnavailableSubtitle', null, 'The session turns history service is unavailable.'),
          true
        )
      );
      return;
    }

    if (turns.length === 0) {
      contentEl.appendChild(
        createStateCard(
          tr('modal.noTurnHistoryTitle', null, 'No Turn History'),
          tr('modal.noTurnHistorySubtitle', null, 'No turn execution records found for this session.')
        )
      );
      return;
    }

    const tableContainer = document.createElement('div');
    tableContainer.className = 'data-table-container';
    const table = document.createElement('table');
    table.className = 'data-table';

    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');
    ['Status', 'Started', 'Finished'].forEach((col) => {
      const th = document.createElement('th');
      th.textContent = col === 'Status' ? tr('common.status', null, 'Status') : (col === 'Started' ? tr('chat.turnStarted', null, 'Started') : tr('chat.turnFinished', null, 'Finished'));
      trHead.appendChild(th);
    });
    thead.appendChild(trHead);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    turns.forEach((turn) => {
      const trEl = document.createElement('tr');

      const tdStatus = document.createElement('td');
      const VALID_TURN_STATUSES = ['completed', 'running', 'failed', 'queued', 'settled', 'cancelled'];
      const isKnown = VALID_TURN_STATUSES.includes(turn.status);
      const turnStatus = isKnown ? turn.status : 'unavailable';
      const badgeType = turnStatus === 'completed' || turnStatus === 'settled' ? 'success' : (turnStatus === 'running' || turnStatus === 'queued' ? 'warning' : (turnStatus === 'failed' || turnStatus === 'cancelled' ? 'danger' : 'muted'));
      const statusLabel = formatStatus(isKnown ? turnStatus : 'unavailable');
      tdStatus.appendChild(createBadgeElement(statusLabel, badgeType));
      trEl.appendChild(tdStatus);

      const tdStart = document.createElement('td');
      tdStart.textContent = turn.startedAt ? formatDateTime(turn.startedAt) : '-';
      trEl.appendChild(tdStart);

      const tdFinish = document.createElement('td');
      tdFinish.textContent = turn.finishedAt ? formatDateTime(turn.finishedAt) : '-';
      trEl.appendChild(tdFinish);

      tbody.appendChild(trEl);
    });

    table.appendChild(tbody);
    tableContainer.appendChild(table);
    contentEl.appendChild(tableContainer);
  } catch {
    contentEl.replaceChildren(
      createStateCard(
        tr('modal.turnsUnavailableTitle', null, 'Turns Unavailable'),
        tr('modal.turnsUnavailableSubtitle', null, 'The session turns history service is unavailable.'),
        true
      )
    );
  }
}

// ----------------------------------------------------
// Space Management & Lifecycle
// ----------------------------------------------------

async function loadSpaces() {
  try {
    const res = await apiRequest("/api/spaces?includeArchived=true");
    if (res && res.data && Array.isArray(res.data.spaces)) {
      state.spaces = res.data.spaces;
    } else if (res && Array.isArray(res.data)) {
      state.spaces = res.data;
    } else {
      state.spaces = [];
    }
    renderSpaceSelect();

    if (state.spaces.length > 0) {
      // Restore selected space from sessionStorage if present
      let savedSpaceId = null;
      try {
        savedSpaceId = sessionStorage.getItem("enkeep_active_space");
      } catch (storageErr) {
        // Ignore sessionStorage access error in restricted environment
      }

      const activeSpace = (savedSpaceId && state.spaces.find((s) => s.id === savedSpaceId)) ||
        (state.currentSpaceId && state.spaces.find((s) => s.id === state.currentSpaceId)) ||
        state.spaces[0];
      selectSpace(activeSpace.id);
    } else {
      state.currentSpaceId = null;
      try {
        sessionStorage.removeItem("enkeep_active_space");
      } catch (storageErr) {
        // Ignore sessionStorage access error in restricted environment
      }
      state.sessions = [];
      renderSessionList();
      updateSpaceLifecycleControls();
    }
  } catch (err) {
    showToast(getSafeErrorMessage(err, tr("toast.failedLoadSpaces", null, "Failed to load spaces.")), "error");
  }
}

function renderSpaceSelect() {
  const select = document.getElementById("space-select");
  const modalSelect = document.getElementById("session-space-select");
  const forkSpaceSelect = document.getElementById("fork-space-select");
  if (!select) return;

  select.replaceChildren();
  if (modalSelect) modalSelect.replaceChildren();
  if (forkSpaceSelect) forkSpaceSelect.replaceChildren();

  if (state.spaces.length === 0) {
    const emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = tr("chat.noSpacesAvailable", null, "No spaces available");
    select.appendChild(emptyOpt);
    return;
  }

  state.spaces.forEach((space) => {
    const opt = document.createElement("option");
    opt.value = space.id;
    const isArchived = space.status === "archived";
    const isHostSpace = space.executionMode === "host";
    const modeTag = isHostSpace ? "[Host]" : "[Docker]";
    const spaceLabel = space.name || tr("chat.untitledSpace", null, "Untitled Space");
    opt.textContent = isArchived ? `${spaceLabel} (${tr("chat.archivedBadge", null, "Archived")}) ${modeTag}` : `${spaceLabel} ${modeTag}`;
    select.appendChild(opt);

    if (!isArchived) {
      if (modalSelect) {
        const modalOpt = document.createElement("option");
        modalOpt.value = space.id;
        modalOpt.textContent = `${spaceLabel} ${modeTag}`;
        modalSelect.appendChild(modalOpt);
      }
      if (forkSpaceSelect) {
        const forkOpt = document.createElement("option");
        forkOpt.value = space.id;
        forkOpt.textContent = `${spaceLabel} ${modeTag}`;
        forkSpaceSelect.appendChild(forkOpt);
      }
    }
  });

  if (state.currentSpaceId) {
    select.value = state.currentSpaceId;
  }
}

function selectSpace(spaceId) {
  state.currentSpaceId = spaceId;
  try {
    if (spaceId) {
      sessionStorage.setItem("enkeep_active_space", spaceId);
    } else {
      sessionStorage.removeItem("enkeep_active_space");
    }
  } catch (storageErr) {
    // Ignore sessionStorage access error in restricted environment
  }

  const select = document.getElementById("space-select");
  if (select) select.value = spaceId;

  const modeBadge = document.getElementById("space-mode-badge");
  if (modeBadge) {
    const curSpace = state.spaces.find((s) => s.id === spaceId);
    if (curSpace) {
      modeBadge.classList.remove("hidden");
      const isHostSpace = curSpace.executionMode === "host";
      modeBadge.textContent = isHostSpace ? tr("spaces.modeHost", null, "Host") : tr("spaces.modeDocker", null, "Docker");
      modeBadge.className = isHostSpace ? "badge badge-risk-high space-mode-badge" : "badge badge-info space-mode-badge";
    } else {
      modeBadge.classList.add("hidden");
    }
  }

  updateSpaceLifecycleControls();
  loadSessions(spaceId);
}

function updateSpaceLifecycleControls() {
  const renameBtn = document.getElementById("btn-rename-space");
  const mountsBtn = document.getElementById("btn-manage-mounts");
  const archiveBtn = document.getElementById("btn-archive-space");
  const restoreBtn = document.getElementById("btn-restore-space");
  const hasSpace = Boolean(state.currentSpaceId);
  const currentSpace = state.spaces.find((s) => s.id === state.currentSpaceId);
  const isArchived = currentSpace && currentSpace.status === "archived";
  const isAdmin = Boolean(state.currentUser && state.currentUser.role === 'admin');

  if (renameBtn) {
    renameBtn.disabled = !hasSpace || isArchived;
    if (isArchived) renameBtn.classList.add("hidden");
    else renameBtn.classList.remove("hidden");
  }
  if (mountsBtn) {
    if (isAdmin && hasSpace && !isArchived) {
      mountsBtn.classList.remove("hidden");
      mountsBtn.disabled = false;
    } else {
      mountsBtn.classList.add("hidden");
      mountsBtn.disabled = true;
    }
  }
  if (archiveBtn) {
    archiveBtn.disabled = !hasSpace;
    if (isArchived) archiveBtn.classList.add("hidden");
    else archiveBtn.classList.remove("hidden");
  }
  if (restoreBtn) {
    if (isArchived) restoreBtn.classList.remove("hidden");
    else restoreBtn.classList.add("hidden");
  }
}

async function handleRestoreSpace() {
  if (!state.currentSpaceId) {
    showToast(tr("toast.selectSpaceToArchive", null, "Select a space"), "error");
    return;
  }
  const currentSpace = state.spaces.find((s) => s.id === state.currentSpaceId);
  const spaceName = currentSpace ? currentSpace.name : state.currentSpaceId;

  showConfirmation(
    tr("modal.restoreSpaceConfirmTitle", null, "Restore Space"),
    tr("modal.restoreSpaceConfirmMessage", { name: spaceName }, `Are you sure you want to restore space "${spaceName}"? It will become active.`),
    async () => {
      try {
        await apiRequest(`/api/spaces/${state.currentSpaceId}/restore`, {
          method: "POST",
        });
        showToast(tr("toast.spaceRestored", { name: spaceName }, `Space "${spaceName}" restored successfully`), "success");
        await loadSpaces();
        selectSpace(state.currentSpaceId);
      } catch (err) {
        showToast(getSafeErrorMessage(err, tr("toast.failedRestoreSpace", null, "Failed to restore space.")), "error");
      }
    }
  );
}

function openRenameSpaceModal() {
  if (!state.currentSpaceId) {
    showToast(tr("toast.selectSpaceToRename", null, "Select a space to rename"), "error");
    return;
  }
  const currentSpace = state.spaces.find((s) => s.id === state.currentSpaceId);
  const input = document.getElementById("rename-space-input");
  if (input && currentSpace) {
    input.value = currentSpace.name || "";
  }
  const modeBadge = document.getElementById("rename-space-mode-badge");
  if (modeBadge && currentSpace) {
    const isHostSpace = currentSpace.executionMode === "host";
    modeBadge.textContent = isHostSpace ? tr("spaces.modeHost", null, "Host") : tr("spaces.modeDocker", null, "Docker");
    modeBadge.className = isHostSpace ? "badge badge-risk-high" : "badge badge-info";
  }
  openModal("modal-rename-space");
}

async function handleRenameSpace(e) {
  e.preventDefault();
  if (!state.currentSpaceId) return;
  const input = document.getElementById("rename-space-input");
  const newName = input ? input.value.trim() : "";
  if (!newName) {
    showToast(tr("toast.spaceNameRequired", null, "Space name is required"), "error");
    return;
  }

  try {
    const res = await apiRequest(`/api/spaces/${state.currentSpaceId}`, {
      method: "PATCH",
      body: { name: newName },
    });
    showToast(tr("toast.spaceRenamed", { name: res.data.name }, `Space renamed to "${res.data.name}"`), "success");
    closeModal("modal-rename-space");
    await loadSpaces();
    selectSpace(state.currentSpaceId);
  } catch (err) {
    showToast(getSafeErrorMessage(err, tr("toast.failedRenameSpace", null, "Failed to rename space.")), "error");
  }
}

function handleArchiveSpace() {
  if (!state.currentSpaceId) {
    showToast(tr("toast.selectSpaceToArchive", null, "Select a space to archive"), "error");
    return;
  }
  const currentSpace = state.spaces.find((s) => s.id === state.currentSpaceId);
  const spaceName = currentSpace ? currentSpace.name : state.currentSpaceId;

  showConfirmation(
    tr("modal.archiveSpaceConfirmTitle", null, "Archive Space"),
    tr("modal.archiveSpaceConfirmMessage", { name: spaceName }, `Are you sure you want to archive space "${spaceName}"? Active execution turns cannot be running.`),
    async () => {
      try {
        await apiRequest(`/api/spaces/${state.currentSpaceId}/archive`, {
          method: "POST",
        });
        showToast(tr("toast.spaceArchived", { name: spaceName }, `Space "${spaceName}" archived successfully`), "success");
        state.currentSpaceId = null;
        try {
          sessionStorage.removeItem("enkeep_active_space");
        } catch (storageErr) {
          // Ignore sessionStorage access error in restricted environment
        }
        await loadSpaces();
      } catch (err) {
        showToast(getSafeErrorMessage(err, tr("toast.failedArchiveSpace", null, "Failed to archive space.")), "error");
      }
    }
  );
}

let activeMountsSpaceId = null;

async function loadSpaceMounts(spaceId) {
  const container = document.getElementById("space-mounts-list-container");
  if (!container) return;
  container.replaceChildren();

  const loadingDiv = document.createElement("div");
  loadingDiv.className = "text-muted text-sm";
  loadingDiv.textContent = t("common.loading", null, "Loading...");
  container.appendChild(loadingDiv);

  try {
    const res = await apiRequest(`/api/admin/spaces/${encodeURIComponent(spaceId)}/mounts`);
    let mounts = [];
    if (res && res.data) {
      if (Array.isArray(res.data.mounts)) {
        mounts = res.data.mounts;
      } else if (Array.isArray(res.data)) {
        mounts = res.data;
      }
    }

    container.replaceChildren();

    if (mounts.length === 0) {
      const emptyDiv = document.createElement("div");
      emptyDiv.className = "text-muted text-sm";
      emptyDiv.textContent = t("modal.noMountsFound", null, "No controlled mounts configured for this space.");
      container.appendChild(emptyDiv);
      return;
    }

    const currentSpace = state.spaces.find((s) => s.id === spaceId);
    const isArchived = currentSpace && currentSpace.status === "archived";

    for (const m of mounts) {
      const card = document.createElement("div");
      card.className = "mount-item-card p-2 mb-2 border rounded bg-secondary-subtle";

      const headerRow = document.createElement("div");
      headerRow.className = "d-flex justify-content-between align-items-center mb-1";

      const nameSlug = document.createElement("strong");
      nameSlug.textContent = m.name;

      const badge = document.createElement("span");
      badge.className = m.mode === "rw" ? "badge badge-success" : "badge badge-warning";
      badge.textContent = m.mode === "rw" ? "RW" : "RO";

      const left = document.createElement("div");
      left.className = "d-flex align-items-center gap-2";
      left.appendChild(nameSlug);
      left.appendChild(badge);

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn btn-danger btn-xs";
      delBtn.textContent = t("common.delete", null, "Delete");
      if (isArchived) {
        delBtn.disabled = true;
      }
      delBtn.addEventListener("click", () => handleDeleteControlledMount(m.id, m.name, spaceId));

      headerRow.appendChild(left);
      headerRow.appendChild(delBtn);
      card.appendChild(headerRow);

      const details = document.createElement("div");
      details.className = "text-xs text-muted font-monospace";

      const sourceDiv = document.createElement("div");
      sourceDiv.className = "mb-1";
      const sourceLabel = document.createElement("strong");
      sourceLabel.textContent = `${t("modal.mountSourcePath", null, "Host Source")}: `;
      const sourceSpan = document.createElement("span");
      sourceSpan.className = "user-select-all selectable-path";
      sourceSpan.textContent = m.sourcePath;
      sourceDiv.appendChild(sourceLabel);
      sourceDiv.appendChild(sourceSpan);
      details.appendChild(sourceDiv);

      if (m.createdAt) {
        const timeDiv = document.createElement("div");
        const timeLabel = document.createElement("strong");
        timeLabel.textContent = `${t("modal.mountCreatedAt", null, "Created At")}: `;
        const timeSpan = document.createElement("span");
        timeSpan.textContent = formatDate(m.createdAt);
        timeDiv.appendChild(timeLabel);
        timeDiv.appendChild(timeSpan);
        details.appendChild(timeDiv);
      }

      card.appendChild(details);
      container.appendChild(card);
    }
  } catch (err) {
    container.replaceChildren();
    const errDiv = document.createElement("div");
    errDiv.className = "text-danger text-sm";
    errDiv.textContent = getSafeErrorMessage(err, t("toast.failedLoadMounts", null, "Failed to load mounts list."));
    container.appendChild(errDiv);
  }
}

function openSpaceMountsModal(targetSpaceId, targetSpaceName) {
  const spaceId = (typeof targetSpaceId === 'string' && targetSpaceId.trim().length > 0)
    ? targetSpaceId.trim()
    : state.currentSpaceId;

  if (!spaceId) {
    showToast(t("toast.selectTargetSpaceFirst", null, "Please select a target space first"), "error");
    return;
  }
  activeMountsSpaceId = spaceId;

  const form = document.getElementById("add-controlled-mount-form");
  if (form) form.reset();
  const modeSelect = document.getElementById("mount-mode-select");
  if (modeSelect) modeSelect.value = "ro";

  const currentSpace = state.spaces.find((s) => s.id === spaceId);
  const isArchived = currentSpace && currentSpace.status === "archived";
  const archivedNotice = document.getElementById("mounts-archived-notice");
  const nameInput = document.getElementById("mount-name-input");
  const sourcePathInput = document.getElementById("mount-source-path-input");
  const submitBtn = document.getElementById("btn-submit-add-mount");

  if (archivedNotice) {
    if (isArchived) archivedNotice.classList.remove("hidden");
    else archivedNotice.classList.add("hidden");
  }
  if (nameInput) nameInput.disabled = Boolean(isArchived);
  if (sourcePathInput) sourcePathInput.disabled = Boolean(isArchived);
  if (modeSelect) modeSelect.disabled = Boolean(isArchived);
  if (submitBtn) submitBtn.disabled = Boolean(isArchived);

  openModal("modal-space-mounts");
  loadSpaceMounts(spaceId);
}

async function handleAddControlledMount(e) {
  e.preventDefault();
  const spaceId = activeMountsSpaceId || state.currentSpaceId;
  if (!spaceId) return;

  const nameInput = document.getElementById("mount-name-input");
  const sourcePathInput = document.getElementById("mount-source-path-input");
  const modeSelect = document.getElementById("mount-mode-select");

  const name = nameInput ? nameInput.value.trim() : "";
  const sourcePath = sourcePathInput ? sourcePathInput.value.trim() : "";
  const mode = (modeSelect && (modeSelect.value === "rw" || modeSelect.value === "ro")) ? modeSelect.value : "ro";

  if (!name || !sourcePath) {
    showToast(t("error.validation", null, "All fields are required"), "error");
    return;
  }

  try {
    const res = await apiRequest(`/api/admin/spaces/${encodeURIComponent(spaceId)}/mounts`, {
      method: "POST",
      body: { name, sourcePath, mode },
    });
    const createdName = (res.data && res.data.name) ? res.data.name : name;
    showToast(t("toast.mountAdded", { name: createdName }, `Mount "${createdName}" added successfully`), "success");
    if (nameInput) nameInput.value = "";
    if (sourcePathInput) sourcePathInput.value = "";
    if (modeSelect) modeSelect.value = "ro";
    loadSpaceMounts(spaceId);
  } catch (err) {
    showToast(getSafeErrorMessage(err, t("toast.failedAddMount", null, "Failed to add mount.")), "error");
  }
}

async function handleDeleteControlledMount(mountId, mountName, spaceIdParam) {
  const spaceId = (typeof spaceIdParam === 'string' && spaceIdParam.trim().length > 0)
    ? spaceIdParam.trim()
    : (activeMountsSpaceId || state.currentSpaceId);
  if (!spaceId) return;

  showConfirmation(
    t("modal.deleteMountConfirmTitle", null, "Delete Controlled Mount"),
    t("modal.deleteMountConfirmMessage", { name: mountName }, `Are you sure you want to delete mount "${mountName}"? Next turn will immediately lose access to this directory.`),
    async () => {
      try {
        await apiRequest(`/api/admin/spaces/${encodeURIComponent(spaceId)}/mounts/${encodeURIComponent(mountId)}`, {
          method: "DELETE",
        });
        showToast(t("toast.mountDeleted", { name: mountName }, `Mount "${mountName}" deleted successfully`), "success");
        loadSpaceMounts(spaceId);
      } catch (err) {
        showToast(getSafeErrorMessage(err, t("toast.failedDeleteMount", null, "Failed to delete mount.")), "error");
      }
    }
  );
}

function openCreateSpaceModal() {
  const isAdmin = Boolean(state.currentUser && state.currentUser.role === 'admin');
  const execModeSelect = document.getElementById("space-exec-mode-select");
  const hostDesc = document.getElementById("space-exec-mode-host-desc");

  if (execModeSelect) {
    execModeSelect.replaceChildren();
    const dockerOpt = document.createElement("option");
    dockerOpt.value = "container";
    dockerOpt.textContent = tr("modal.execModeDocker", null, "Docker (Default)");
    dockerOpt.setAttribute("data-i18n", "modal.execModeDocker");
    execModeSelect.appendChild(dockerOpt);

    if (isAdmin) {
      const hostOpt = document.createElement("option");
      hostOpt.value = "host";
      hostOpt.id = "space-exec-mode-host-option";
      hostOpt.textContent = tr("modal.execModeHost", null, "Host (High Risk)");
      hostOpt.setAttribute("data-i18n", "modal.execModeHost");
      execModeSelect.appendChild(hostOpt);
    }
    execModeSelect.value = "container";
  }

  if (hostDesc) {
    hostDesc.classList.add("hidden");
  }
  openModal("modal-space");
}

async function handleCreateSpace(e) {
  e.preventDefault();
  const name = document.getElementById("space-name-input").value.trim();
  const folderInput = document.getElementById("space-folder-input");
  const folder = (folderInput && folderInput.value.trim()) ? folderInput.value.trim() : (name ? name.toLowerCase().replace(/[^a-z0-9_-]/g, "-") : "space-folder");

  const execModeSelect = document.getElementById("space-exec-mode-select");
  const isAdmin = Boolean(state.currentUser && state.currentUser.role === 'admin');
  const executionMode = (execModeSelect && execModeSelect.value === "host" && isAdmin) ? "host" : "container";

  try {
    const res = await apiRequest("/api/spaces", {
      method: "POST",
      body: { name, folder, executionMode },
    });

    showToast(tr("toast.spaceCreated", { name: res.data.name }, `Space "${res.data.name}" created!`), "success");
    closeModal("modal-space");
    document.getElementById("create-space-form").reset();
    if (execModeSelect) execModeSelect.value = "container";
    const hostDesc = document.getElementById("space-exec-mode-host-desc");
    if (hostDesc) hostDesc.classList.add("hidden");
    await loadSpaces();
    selectSpace(res.data.id);
  } catch (err) {
    showToast(getSafeErrorMessage(err, tr("toast.failedCreateSpace", null, "Failed to create space.")), "error");
  }
}

// ----------------------------------------------------
// Session Management & Lifecycle
// ----------------------------------------------------

async function loadSessions(spaceId) {
  try {
    const incParam = state.showArchivedSessions ? '&includeArchived=true' : '';
    const url = spaceId
      ? `/api/sessions?spaceId=${encodeURIComponent(spaceId)}${incParam}`
      : `/api/sessions${state.showArchivedSessions ? '?includeArchived=true' : ''}`;
    const res = await apiRequest(url);
    if (res && res.data && Array.isArray(res.data.sessions)) {
      state.sessions = res.data.sessions;
    } else if (res && Array.isArray(res.data)) {
      state.sessions = res.data;
    } else {
      state.sessions = [];
    }
    renderSessionList();

    const toggleArchivedBtn = document.getElementById("btn-toggle-archived-sessions");
    if (toggleArchivedBtn) {
      if (state.showArchivedSessions) {
        toggleArchivedBtn.classList.add("active");
        toggleArchivedBtn.textContent = tr("chat.hideArchived", null, "Hide Archived");
      } else {
        toggleArchivedBtn.classList.remove("active");
        toggleArchivedBtn.textContent = tr("chat.showArchived", null, "Archived");
      }
    }

    if (state.sessions.length > 0) {
      let savedSessionId = null;
      try {
        savedSessionId = sessionStorage.getItem("enkeep_active_session");
      } catch (storageErr) {
        // Ignore sessionStorage access error in restricted environment
      }

      const currentActive = (savedSessionId && state.sessions.find((s) => s.id === savedSessionId)) ||
        (state.currentSessionId && state.sessions.find((s) => s.id === state.currentSessionId)) ||
        state.sessions[0];

      selectSession(currentActive.id);
    } else {
      deselectSession();
    }
  } catch (err) {
    showToast(getSafeErrorMessage(err, tr("toast.failedLoadSessions", null, "Failed to load sessions.")), "error");
  }
}

function toggleArchivedSessions() {
  state.showArchivedSessions = !state.showArchivedSessions;
  if (state.currentSpaceId) {
    loadSessions(state.currentSpaceId);
  }
}

function renderSessionList() {
  const container = document.getElementById("session-list");
  if (!container) return;

  container.replaceChildren();

  const query = (state.sessionSearchQuery || "").toLowerCase().trim();
  const filteredSessions = query
    ? state.sessions.filter((s) => (s.title || "").toLowerCase().includes(query))
    : state.sessions;

  if (state.sessions.length === 0) {
    const emptyDiv = document.createElement("div");
    emptyDiv.className = "empty-sessions";
    emptyDiv.textContent = tr("chat.emptySessionsInSpace", null, "No sessions in this space");
    container.appendChild(emptyDiv);
    return;
  }

  if (filteredSessions.length === 0) {
    const emptyDiv = document.createElement("div");
    emptyDiv.className = "empty-sessions";
    emptyDiv.textContent = tr("chat.noMatchingSessions", null, "No matching sessions found");
    container.appendChild(emptyDiv);
    return;
  }

  filteredSessions.forEach((session) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `session-item ${session.id === state.currentSessionId ? "active" : ""}`;
    item.addEventListener("click", () => selectSession(session.id));

    const titleDiv = document.createElement("div");
    titleDiv.className = "session-title";
    titleDiv.textContent = session.title || tr("chat.untitledSession", null, "Untitled");
    item.appendChild(titleDiv);

    if (session.status === "archived") {
      const archBadge = document.createElement("span");
      archBadge.className = "badge badge-disabled badge-xs";
      archBadge.textContent = tr("chat.archivedBadge", null, "Archived");
      item.appendChild(archBadge);
    } else if (typeof session.currentGeneration === "number" && session.currentGeneration >= 1) {
      const genBadge = document.createElement("span");
      genBadge.className = "badge badge-generation badge-xs";
      genBadge.textContent = tr("chat.genBadge", { number: formatNumber(session.currentGeneration) }, `Gen ${session.currentGeneration}`);
      item.appendChild(genBadge);
    }

    container.appendChild(item);
  });
}

function deselectSession() {
  state.currentSessionId = null;
  try {
    sessionStorage.removeItem("enkeep_active_session");
  } catch (storageErr) {
    // Ignore sessionStorage access error in restricted environment
  }
  state.currentSessionRoute = null;
  state.hasCancellableTurn = false;
  state.activeTurnStatus = null;
  state.isCancellingTurn = false;
  state.messages = [];
  state.streamingState = null;
  state.olderMessagesCursor = null;
  state.hasMoreMessages = false;
  state.isLoadingOlderMessages = false;
  state.loadOlderError = null;
  state.eventCursor = null;
  state.activeReply = null;
  renderComposerReplyBanner();
  stopPolling();

  const titleEl = document.getElementById("current-session-title");
  if (titleEl) titleEl.textContent = tr("chat.noSessionSelected", null, "Select or create a session");

  const metaEl = document.getElementById("current-session-meta");
  if (metaEl) metaEl.textContent = tr("chat.activeSessionEmpty", null, "Active Session: -");

  const statusBadge = document.getElementById("session-status-badge");
  if (statusBadge) statusBadge.classList.add("hidden");

  const genBadge = document.getElementById("session-generation-badge");
  if (genBadge) genBadge.classList.add("hidden");

  const turnBadge = document.getElementById("session-turn-status-badge");
  if (turnBadge) turnBadge.classList.add("hidden");

  const chatInput = document.getElementById("chat-input");
  if (chatInput) {
    chatInput.disabled = true;
    chatInput.value = "";
    chatInput.rows = 2;
  }
  updateCharCount();

  const sendBtn = document.getElementById("btn-send-message");
  if (sendBtn) sendBtn.disabled = true;

  const turnsBtn = document.getElementById("btn-inspect-turns");
  if (turnsBtn) turnsBtn.classList.add("hidden");

  const renameBtn = document.getElementById("btn-rename-session");
  if (renameBtn) renameBtn.classList.add("hidden");

  const archiveBtn = document.getElementById("btn-archive-session");
  if (archiveBtn) archiveBtn.classList.add("hidden");

  const restoreBtn = document.getElementById("btn-restore-session");
  if (restoreBtn) restoreBtn.classList.add("hidden");

  const forkBtn = document.getElementById("btn-fork-session");
  if (forkBtn) forkBtn.classList.add("hidden");

  const resetBtn = document.getElementById("btn-reset-session");
  if (resetBtn) resetBtn.classList.add("hidden");

  const genBtn = document.getElementById("btn-session-generations");
  if (genBtn) genBtn.classList.add("hidden");

  state.activeAttachments = [];
  state.processedEventIds = new Set();
  renderAttachmentTray();
  updateStopTurnControl();
  updateComposerControlsState();
  updateTurnStatusBadge();
  renderMessages();
}

async function selectSession(sessionId) {
  if (state.currentSessionId && state.currentSessionId !== sessionId) {
    const input = document.getElementById("chat-input");
    state.drafts[state.currentSessionId] = {
      content: input ? input.value : "",
      attachments: [...state.activeAttachments],
    };
  }

  state.currentSessionId = sessionId;
  try {
    if (sessionId) {
      sessionStorage.setItem("enkeep_active_session", sessionId);
    } else {
      sessionStorage.removeItem("enkeep_active_session");
    }
  } catch (storageErr) {
    // Ignore sessionStorage access error in restricted environment
  }

  state.eventCursor = null; // Fresh event polling cursor on session switch
  state.olderMessagesCursor = null;
  state.hasMoreMessages = false;
  state.isLoadingOlderMessages = false;
  state.loadOlderError = null;
  state.streamingState = null;
  state.hasCancellableTurn = false;
  state.activeTurnStatus = null;
  state.isCancellingTurn = false;
  state.consecutivePollingFailures = 0;
  state.processedEventIds = new Set();
  renderSessionList();
  updateStopTurnControl();
  updateTurnStatusBadge();

  const turnsBtn = document.getElementById("btn-inspect-turns");
  if (turnsBtn) {
    turnsBtn.classList.remove("hidden");
  }

  const forkBtn = document.getElementById("btn-fork-session");
  if (forkBtn) {
    forkBtn.classList.remove("hidden");
  }

  const renameBtn = document.getElementById("btn-rename-session");
  const archiveBtn = document.getElementById("btn-archive-session");
  const restoreBtn = document.getElementById("btn-restore-session");
  const resetBtn = document.getElementById("btn-reset-session");
  const genBtn = document.getElementById("btn-session-generations");
  if (genBtn) {
    genBtn.classList.remove("hidden");
  }

  try {
    const res = await apiRequest(`/api/sessions/${sessionId}`);
    state.currentSessionRoute = res.data;

    const titleEl = document.getElementById("current-session-title");
    if (titleEl) {
      titleEl.textContent = res.data && res.data.title
        ? tr("chat.sessionTitleHeader", { title: res.data.title }, `Session: ${res.data.title}`)
        : tr("chat.routeActiveSession", null, "Session Workspace");
    }

    const metaEl = document.getElementById("current-session-meta");
    if (metaEl) {
      metaEl.textContent = res.data && res.data.title
        ? tr("chat.sessionRouteMeta", { title: res.data.title }, `Route: ${res.data.title}`)
        : tr("chat.routeActiveSession", null, "Route: Active Session");
    }

    const statusBadge = document.getElementById("session-status-badge");
    if (statusBadge) {
      if (res.data && res.data.status) {
        statusBadge.textContent = formatStatus(res.data.status);
        statusBadge.className = `badge ${res.data.status === "active" ? "badge-active" : "badge-disabled"}`;
        statusBadge.classList.remove("hidden");
      } else {
        statusBadge.classList.add("hidden");
      }
    }

    const genBadge = document.getElementById("session-generation-badge");
    if (genBadge) {
      if (res.data && typeof res.data.currentGeneration === "number") {
        genBadge.textContent = tr("chat.genBadge", { number: formatNumber(res.data.currentGeneration) }, `Gen ${res.data.currentGeneration}`);
        genBadge.classList.remove("hidden");
      } else {
        genBadge.classList.add("hidden");
      }
    }

    const isArchived = Boolean(res.data && res.data.status === "archived");

    const chatInput = document.getElementById("chat-input");
    if (chatInput) {
      chatInput.disabled = isArchived;
      chatInput.placeholder = isArchived
        ? tr("chat.inputArchivedPlaceholder", null, "This session is archived (read-only).")
        : tr("chat.inputPlaceholder", null, "Type a message or instruction for Enkeep agent...");
    }

    const sendBtn = document.getElementById("btn-send-message");
    if (sendBtn) sendBtn.disabled = isArchived;

    if (resetBtn) {
      if (isArchived) resetBtn.classList.add("hidden");
      else resetBtn.classList.remove("hidden");
    }
    if (renameBtn) {
      if (isArchived) renameBtn.classList.add("hidden");
      else renameBtn.classList.remove("hidden");
    }
    if (archiveBtn) {
      if (isArchived) archiveBtn.classList.add("hidden");
      else archiveBtn.classList.remove("hidden");
    }
    if (restoreBtn) {
      if (isArchived) restoreBtn.classList.remove("hidden");
      else restoreBtn.classList.add("hidden");
    }

    // Restore drafts if any
    const draft = state.drafts[sessionId] || { content: "", attachments: [] };
    if (chatInput && !isArchived) {
      chatInput.value = draft.content || "";
      adjustTextareaHeight(chatInput);
    }
    state.activeAttachments = isArchived ? [] : (draft.attachments || []);
    state.activeReply = null;
    renderComposerReplyBanner();
    renderAttachmentTray();
    updateCharCount();
    updateComposerControlsState();

    // Load initial messages
    await loadMessages(sessionId);

    // Synchronize active cancellable turn status
    await syncActiveTurnStatus(sessionId);

    // Start live polling if in workspace view and not archived
    if (state.currentRoute === "workspace" && !isArchived) {
      startPolling(sessionId);
    }
  } catch (err) {
    showToast(getSafeErrorMessage(err, tr("toast.failedSelectSession", null, "Failed to select session.")), "error");
  }
}

function openRenameSessionModal() {
  if (!state.currentSessionId) {
    showToast(tr("toast.selectActiveSessionFirst", null, "Select an active session first"), "error");
    return;
  }
  const input = document.getElementById("rename-session-input");
  const currentSession = state.sessions.find((s) => s.id === state.currentSessionId);
  if (input) {
    input.value = (currentSession && currentSession.title) || "";
  }
  openModal("modal-rename-session");
}

async function handleRenameSession(e) {
  e.preventDefault();
  if (!state.currentSessionId) return;
  const input = document.getElementById("rename-session-input");
  const title = input ? input.value.trim() : "";
  if (!title) {
    showToast(tr("toast.sessionTitleRequired", null, "Session title is required"), "error");
    return;
  }

  try {
    const res = await apiRequest(`/api/sessions/${state.currentSessionId}`, {
      method: "PATCH",
      body: { title },
    });
    const updatedTitle = res.data.title || title;
    showToast(tr("toast.sessionRenamed", { title: updatedTitle }, `Session renamed to "${updatedTitle}"`), "success");
    closeModal("modal-rename-session");
    const titleEl = document.getElementById("current-session-title");
    if (titleEl) titleEl.textContent = tr("chat.sessionTitleHeader", { title: updatedTitle }, `Session: ${updatedTitle}`);
    if (state.currentSpaceId) {
      await loadSessions(state.currentSpaceId);
    }
  } catch (err) {
    showToast(getSafeErrorMessage(err, tr("toast.failedRenameSession", null, "Failed to rename session.")), "error");
  }
}

function handleArchiveSession() {
  if (!state.currentSessionId) {
    showToast(tr("toast.selectActiveSessionToArchive", null, "Select an active session to archive"), "error");
    return;
  }
  const sessionId = state.currentSessionId;
  showConfirmation(
    tr("modal.archiveSessionConfirmTitle", null, "Archive Session"),
    tr("modal.archiveSessionConfirmMessage", null, "Are you sure you want to archive this session? It will become read-only."),
    async () => {
      try {
        await apiRequest(`/api/sessions/${sessionId}/archive`, {
          method: "POST",
        });
        showToast(tr("toast.sessionArchived", null, "Session archived successfully"), "success");
        if (state.currentSpaceId) {
          await loadSessions(state.currentSpaceId);
        }
      } catch (err) {
        showToast(getSafeErrorMessage(err, tr("toast.failedArchiveSession", null, "Failed to archive session.")), "error");
      }
    }
  );
}

function handleRestoreSession() {
  if (!state.currentSessionId) {
    showToast(tr("toast.selectActiveSessionFirst", null, "Select an active session first"), "error");
    return;
  }
  const sessionId = state.currentSessionId;
  const currentSession = state.sessions.find((s) => s.id === sessionId);
  const sessionTitle = currentSession ? currentSession.title : sessionId;

  showConfirmation(
    tr("modal.restoreSessionConfirmTitle", null, "Restore Session"),
    tr("modal.restoreSessionConfirmMessage", null, "Are you sure you want to restore this session? It will become active."),
    async () => {
      try {
        const res = await apiRequest(`/api/sessions/${sessionId}/restore`, {
          method: "POST",
        });
        showToast(tr("toast.sessionRestored", { title: sessionTitle }, `Session "${sessionTitle}" restored successfully`), "success");
        if (state.currentSpaceId) {
          await loadSessions(state.currentSpaceId);
        }
        await selectSession(sessionId);
      } catch (err) {
        showToast(getSafeErrorMessage(err, tr("toast.failedRestoreSession", null, "Failed to restore session.")), "error");
      }
    }
  );
}

function openForkSessionModal(fromMessageId, fromTurnId) {
  if (!state.currentSessionId) {
    showToast(tr("toast.selectActiveSessionFirst", null, "Select an active session first"), "error");
    return;
  }
  const currentSession = state.sessions.find((s) => s.id === state.currentSessionId);
  const baseTitle = currentSession && currentSession.title ? currentSession.title : "Session";

  const titleInput = document.getElementById("fork-session-title-input");
  if (titleInput) {
    titleInput.value = `${baseTitle} (Fork)`;
  }

  const msgIdInput = document.getElementById("fork-source-message-id");
  if (msgIdInput) {
    msgIdInput.value = fromMessageId || "";
  }

  const turnIdInput = document.getElementById("fork-source-turn-id");
  if (turnIdInput) {
    turnIdInput.value = fromTurnId || "";
  }

  const indicator = document.getElementById("fork-point-indicator");
  const badge = document.getElementById("fork-point-badge");
  if (indicator && badge) {
    if (fromMessageId) {
      indicator.classList.remove("hidden");
      badge.textContent = `${tr("modal.forkFromMessagePrefix", null, "Forking from message #")}${fromMessageId.substring(0, 12)}...`;
    } else {
      indicator.classList.add("hidden");
    }
  }

  const spaceSelect = document.getElementById("fork-space-select");
  if (spaceSelect) {
    spaceSelect.replaceChildren();
    const activeSpaces = state.spaces.filter((s) => s.status !== "archived");
    activeSpaces.forEach((sp) => {
      const opt = document.createElement("option");
      opt.value = sp.id;
      opt.textContent = sp.name || sp.id;
      if (sp.id === state.currentSpaceId) {
        opt.selected = true;
      }
      spaceSelect.appendChild(opt);
    });
  }

  openModal("modal-fork-session");
}

async function handleForkSession(e) {
  e.preventDefault();
  if (!state.currentSessionId) return;

  const titleInput = document.getElementById("fork-session-title-input");
  const title = titleInput ? titleInput.value.trim() : undefined;

  const spaceSelect = document.getElementById("fork-space-select");
  const targetSpaceId = spaceSelect ? spaceSelect.value : undefined;

  const msgIdInput = document.getElementById("fork-source-message-id");
  const fromMessageId = (msgIdInput && msgIdInput.value) ? msgIdInput.value : undefined;

  const turnIdInput = document.getElementById("fork-source-turn-id");
  const fromTurnId = (turnIdInput && turnIdInput.value) ? turnIdInput.value : undefined;

  const sessionId = state.currentSessionId;

  try {
    const res = await apiRequest(`/api/sessions/${sessionId}/fork`, {
      method: "POST",
      body: {
        ...(title ? { title } : {}),
        ...(targetSpaceId ? { targetSpaceId } : {}),
        ...(fromMessageId ? { fromMessageId } : {}),
        ...(fromTurnId ? { fromTurnId } : {}),
      },
    });

    showToast(tr("toast.sessionForked", null, "Session forked successfully! Switched to new branch."), "success");
    closeModal("modal-fork-session");

    if (targetSpaceId && targetSpaceId !== state.currentSpaceId) {
      selectSpace(targetSpaceId);
    } else if (state.currentSpaceId) {
      await loadSessions(state.currentSpaceId);
    }

    if (res && res.data && res.data.id) {
      await selectSession(res.data.id);
    }
  } catch (err) {
    showToast(getSafeErrorMessage(err, tr("toast.failedForkSession", null, "Failed to fork session.")), "error");
  }
}

// ----------------------------------------------------
// Message Actions: Reply, Edit, and Regenerate
// ----------------------------------------------------

function renderComposerReplyBanner() {
  const banner = document.getElementById("composer-reply-banner");
  if (!banner) return;

  if (!state.activeReply) {
    banner.replaceChildren();
    banner.classList.add("hidden");
    return;
  }

  banner.replaceChildren();
  banner.classList.remove("hidden");

  const infoDiv = document.createElement("div");
  infoDiv.className = "composer-reply-info";

  const iconSpan = document.createElement("span");
  iconSpan.className = "composer-reply-icon";
  iconSpan.textContent = "↩️";

  const titleSpan = document.createElement("span");
  titleSpan.className = "composer-reply-title";
  const roleName = formatRole(state.activeReply.role);
  titleSpan.textContent = tr("chat.replyingTo", { name: roleName }, `Replying to ${roleName}:`);

  const snippetSpan = document.createElement("span");
  snippetSpan.className = "composer-reply-text";
  snippetSpan.textContent = `"${state.activeReply.snippet}"`;

  infoDiv.appendChild(iconSpan);
  infoDiv.appendChild(titleSpan);
  infoDiv.appendChild(snippetSpan);

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "composer-reply-cancel";
  cancelBtn.title = tr("chat.cancelReply", null, "Cancel reply");
  cancelBtn.setAttribute("aria-label", tr("chat.cancelReply", null, "Cancel reply"));
  cancelBtn.textContent = "✕";
  cancelBtn.addEventListener("click", cancelReplyMessage);

  banner.appendChild(infoDiv);
  banner.appendChild(cancelBtn);
}

function setReplyMessage(messageId, role, snippet) {
  state.activeReply = {
    messageId,
    role: role || 'user',
    snippet: snippet ? snippet.slice(0, 150) : '',
  };
  renderComposerReplyBanner();
  const input = document.getElementById("chat-input");
  if (input) {
    input.focus();
  }
}

function cancelReplyMessage() {
  state.activeReply = null;
  renderComposerReplyBanner();
}

function openEditMessageModal(messageId) {
  if (!state.currentSessionId) return;

  if (state.hasCancellableTurn) {
    showToast(tr("chat.turnActiveCannotAction", null, "Cannot perform this action while a turn is active."), "warning");
    return;
  }

  const msg = state.messages.find((m) => m.id === messageId);
  if (!msg) {
    showToast(tr("chat.messageNotFound", null, "Referenced message not found."), "error");
    return;
  }

  const idInput = document.getElementById("edit-message-source-id");
  if (idInput) idInput.value = messageId;

  const contentInput = document.getElementById("edit-message-content-input");
  if (contentInput) {
    contentInput.value = msg.content || "";
  }

  openModal("modal-edit-message");
}

async function handleEditMessage(e) {
  e.preventDefault();
  if (!state.currentSessionId) return;

  const idInput = document.getElementById("edit-message-source-id");
  const messageId = idInput ? idInput.value : "";
  const contentInput = document.getElementById("edit-message-content-input");
  const content = contentInput ? contentInput.value.trim() : "";

  if (!content) {
    showToast(tr("chat.emptyContent", null, "Message content cannot be empty"), "warning");
    return;
  }

  const currentInput = document.getElementById("chat-input");
  const hasUnsavedDraft = currentInput && currentInput.value.trim().length > 0;

  const proceedEdit = async () => {
    try {
      const res = await apiRequest(`/api/messages/${encodeURIComponent(messageId)}/edit`, {
        method: "POST",
        body: { content },
      });

      closeModal("modal-edit-message");
      showToast(tr("toast.sessionForked", null, "Branched session created!"), "success");

      if (state.currentSpaceId) {
        await loadSessions(state.currentSpaceId);
      }

      if (res && res.data && (res.data.newSessionId || res.data.sessionId)) {
        const newId = res.data.newSessionId || res.data.sessionId;
        await selectSession(newId);
      }
    } catch (err) {
      showToast(getSafeErrorMessage(err, tr("toast.failedForkSession", null, "Failed to edit and branch message.")), "error");
    }
  };

  if (hasUnsavedDraft) {
    showConfirmation(
      tr("chat.editConfirm", null, "Editing creates a new session branch. Do you want to continue?"),
      tr("chat.unsavedDraftWarning", null, "You have unsaved text in your composer. Switching to a new branch will preserve your draft in the previous session. Continue?"),
      proceedEdit
    );
  } else {
    await proceedEdit();
  }
}

async function handleRegenerateMessage(sourceMessageId) {
  if (!state.currentSessionId) return;

  if (state.hasCancellableTurn) {
    showToast(tr("chat.turnActiveCannotAction", null, "Cannot perform this action while a turn is active."), "warning");
    return;
  }

  const currentInput = document.getElementById("chat-input");
  const hasUnsavedDraft = currentInput && currentInput.value.trim().length > 0;

  const proceedRegen = async () => {
    try {
      const res = await apiRequest(`/api/sessions/${state.currentSessionId}/regenerate`, {
        method: "POST",
        body: { sourceMessageId },
      });

      showToast(tr("toast.sessionForked", null, "Regenerated in new session branch!"), "success");

      if (state.currentSpaceId) {
        await loadSessions(state.currentSpaceId);
      }

      if (res && res.data && (res.data.newSessionId || res.data.sessionId)) {
        const newId = res.data.newSessionId || res.data.sessionId;
        await selectSession(newId);
      }
    } catch (err) {
      showToast(getSafeErrorMessage(err, tr("toast.failedForkSession", null, "Failed to regenerate message.")), "error");
    }
  };

  showConfirmation(
    tr("chat.regenerateConfirm", null, "Regenerate creates a new session branch. Do you want to continue?"),
    hasUnsavedDraft
      ? tr("chat.unsavedDraftWarning", null, "You have unsaved text in your composer. Switching to a new branch will preserve your draft in the previous session. Continue?")
      : tr("modal.forkSessionNotice", null, "Forking creates an independent session branching from the selected history point. The original session remains completely unchanged."),
    proceedRegen
  );
}

function openResetSessionModal() {
  if (!state.currentSessionId) {
    showToast(tr("toast.selectActiveSessionFirst", null, "Select an active session first"), "error");
    return;
  }
  const reasonInput = document.getElementById("reset-session-reason-input");
  if (reasonInput) reasonInput.value = "";
  openModal("modal-reset-session");
}

async function handleResetSession(e) {
  e.preventDefault();
  if (!state.currentSessionId) return;
  const sessionId = state.currentSessionId;
  const reasonInput = document.getElementById("reset-session-reason-input");
  const reason = reasonInput ? reasonInput.value.trim() : undefined;

  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
    showToast(tr("toast.cryptoUnavailable", null, "Cryptographic context unavailable. Cannot generate Idempotency-Key."), "error");
    return;
  }

  const idempotencyKey = crypto.randomUUID();
  try {
    const res = await apiRequest(`/api/sessions/${sessionId}/reset`, {
      method: "POST",
      headers: {
        "Idempotency-Key": idempotencyKey,
      },
      body: reason ? { reason } : {},
    });
    const genRaw = res && res.data && res.data.generation !== undefined ? res.data.generation : "new";
    const gen = typeof genRaw === 'number' ? formatNumber(genRaw) : genRaw;
    showToast(tr("toast.sessionResetSuccess", { gen }, `Session reset successfully to Generation ${gen}. History preserved!`), "success");
    closeModal("modal-reset-session");
    await selectSession(sessionId);
  } catch (err) {
    showToast(getSafeErrorMessage(err, tr("toast.failedResetSession", null, "Failed to reset session.")), "error");
  }
}

async function openSessionGenerationsModal(sessionId = state.currentSessionId) {
  if (!sessionId) {
    showToast(tr("toast.selectActiveSessionFirst", null, "Select an active session first"), "error");
    return;
  }
  const titleEl = document.getElementById("generations-modal-title");
  const contentEl = document.getElementById("generations-history-content");
  if (titleEl) {
    titleEl.textContent = tr("modal.generationsTitle", null, "Generation History");
  }
  if (contentEl) {
    contentEl.replaceChildren(createSkeletonLoader());
  }
  openModal("modal-generations");

  try {
    const res = await apiRequest(`/api/sessions/${sessionId}/generations`);
    const generations = (res && res.data && Array.isArray(res.data.generations))
      ? res.data.generations
      : null;

    if (!contentEl) return;
    contentEl.replaceChildren();

    if (!generations) {
      contentEl.appendChild(createStateCard(
        tr("modal.generationsUnavailableTitle", null, "Generations Unavailable"),
        tr("modal.generationsUnavailableSubtitle", null, "Could not load generations history."),
        true
      ));
      return;
    }

    if (generations.length === 0) {
      contentEl.appendChild(createStateCard(
        tr("modal.initialGenerationOnlyTitle", null, "Initial Generation Only"),
        tr("modal.initialGenerationOnlySubtitle", null, "This session is currently at its initial base generation (Gen 1).")
      ));
      return;
    }

    generations.forEach((g) => {
      const card = document.createElement("div");
      card.className = "generation-card";

      const header = document.createElement("div");
      header.className = "generation-card-header";

      const badge = document.createElement("span");
      badge.className = "badge badge-generation";
      const genNum = (typeof g.generationNumber === "number" && Number.isInteger(g.generationNumber)) ? g.generationNumber : ((typeof g.generation === "number" && Number.isInteger(g.generation) && g.generation >= 1) ? g.generation : null);
      const isGenValid = typeof genNum === "number" && Number.isInteger(genNum) && genNum >= 1;
      badge.textContent = isGenValid
        ? tr("chat.genBadge", { number: formatNumber(genNum) }, `Gen ${genNum}`)
        : tr("chat.genUnavailable", null, "Gen Unavailable");
      header.appendChild(badge);

      if (g.isCurrent === true) {
        const curBadge = document.createElement("span");
        curBadge.className = "badge badge-active";
        curBadge.textContent = tr("chat.currentBadge", null, "Current");
        header.appendChild(curBadge);
      }

      let dateText = tr("common.unavailable", null, "Unavailable");
      if (typeof g.createdAt === "string" || typeof g.createdAt === "number") {
        const d = new Date(g.createdAt);
        if (!isNaN(d.getTime())) {
          dateText = formatDateTime(d);
        }
      }
      const timeSpan = document.createElement("span");
      timeSpan.className = "text-muted";
      timeSpan.textContent = dateText;
      header.appendChild(timeSpan);

      card.appendChild(header);

      const reasonP = document.createElement("p");
      reasonP.className = "text-muted";
      if (typeof g.resetReason === "string" && g.resetReason.trim()) {
        reasonP.textContent = tr("modal.generations.resetReason", { reason: g.resetReason.trim() }, `Reset Reason: ${g.resetReason.trim()}`);
      } else {
        reasonP.textContent = tr("modal.generations.resetReasonOmitted", null, 'Reset Reason: Omitted');
      }
      card.appendChild(reasonP);

      contentEl.appendChild(card);
    });
  } catch (err) {
    if (contentEl) {
      contentEl.replaceChildren(
        createStateCard(
          tr("modal.generationsUnavailableTitle", null, "Generations Unavailable"),
          tr("modal.generationsUnavailableSubtitle", null, "Could not load generations history."),
          true
        )
      );
    }
  }
}

// ----------------------------------------------------
// Agent Profile Form Handlers
// ----------------------------------------------------

async function handleCreateProfile(e) {
  e.preventDefault();
  const nameInput = document.getElementById("profile-name-input");
  const descInput = document.getElementById("profile-desc-input");
  const changesInput = document.getElementById("profile-changes-input");
  const identityInput = document.getElementById("profile-identity-input");
  const soulInput = document.getElementById("profile-soul-input");
  const agentsInput = document.getElementById("profile-agents-input");
  const toolsInput = document.getElementById("profile-tools-input");

  const name = nameInput ? nameInput.value.trim() : "";
  if (!name) {
    showToast(t("modal.profileNameRequired", null, getLocale() === "zh-CN" ? "画像名称不能为空" : "Profile name is required"), "error");
    return;
  }

  const payload = {
    name,
    description: descInput ? descInput.value.trim() || undefined : undefined,
    changeSummary: changesInput ? changesInput.value.trim() || undefined : undefined,
    identity: identityInput ? identityInput.value : "",
    soul: soulInput ? soulInput.value : "",
    agents: agentsInput ? agentsInput.value : "",
    tools: toolsInput ? toolsInput.value : "",
  };

  try {
    const res = await apiRequest("/api/manage/agent-profiles", {
      method: "POST",
      body: payload,
    });
    showToast(t("modal.profileCreated", { name: res.data.name }, getLocale() === "zh-CN" ? `智能体画像 "${res.data.name}" 创建成功！` : `Agent profile "${res.data.name}" created!`), "success");
    closeModal("modal-create-profile");
    document.getElementById("create-profile-form").reset();
    renderManagementView("agent-profiles");
  } catch {
    showSafeError("create_profile");
  }
}

async function handleCreateProfileVersion(e) {
  e.preventDefault();
  const profileIdInput = document.getElementById("version-target-profile-id");
  const changesInput = document.getElementById("profile-ver-changes-input");
  const identityInput = document.getElementById("profile-ver-identity-input");
  const soulInput = document.getElementById("profile-ver-soul-input");
  const agentsInput = document.getElementById("profile-ver-agents-input");
  const toolsInput = document.getElementById("profile-ver-tools-input");

  const profileId = profileIdInput ? profileIdInput.value.trim() : "";
  const changeSummary = changesInput ? changesInput.value.trim() : "";

  if (!profileId || !changeSummary) {
    showToast(t("modal.versionChangesRequired", null, getLocale() === "zh-CN" ? "变更摘要不能为空" : "Change summary is required"), "error");
    return;
  }

  const payload = {
    changeSummary,
    identity: identityInput ? identityInput.value : "",
    soul: soulInput ? soulInput.value : "",
    agents: agentsInput ? agentsInput.value : "",
    tools: toolsInput ? toolsInput.value : "",
  };

  try {
    const res = await apiRequest(`/api/manage/agent-profiles/${profileId}/versions`, {
      method: "POST",
      body: payload,
    });
    showToast(t("modal.versionPublished", { version: res.data.version }, getLocale() === "zh-CN" ? `版本 ${res.data.version} 发布成功！` : `Version ${res.data.version} published!`), "success");
    closeModal("modal-create-profile-version");
    document.getElementById("create-profile-version-form").reset();
    renderManagementView("agent-profiles");
  } catch {
    showSafeError("create_profile_version");
  }
}

// ----------------------------------------------------
// Admin Quota Form Handler
// ----------------------------------------------------

async function handleSaveQuotaEdit(e) {
  e.preventDefault();
  const userIdInput = document.getElementById("quota-target-user-id");
  const metricSelect = document.getElementById("quota-metric-select");
  const limitInput = document.getElementById("quota-limit-input");
  const windowInput = document.getElementById("quota-window-input");

  const userId = userIdInput ? userIdInput.value.trim() : "";
  const metric = metricSelect ? metricSelect.value.trim() : "";
  const rawLimit = limitInput ? limitInput.value.trim() : "";
  const rawWindow = windowInput ? windowInput.value.trim() : "";

  if (!userId || !metric || rawLimit === "") {
    showToast(t("modal.quotaRequired", null, getLocale() === "zh-CN" ? "用户 ID、指标和限制配额为必填项" : "User ID, metric, and limit are required"), "error");
    return;
  }

  const limit = parseInt(rawLimit, 10);
  if (isNaN(limit) || (limit < 0 && limit !== -1)) {
    showToast(t("modal.quotaLimitInvalid", null, getLocale() === "zh-CN" ? "限制配额必须为大于等于 0 的整数或 -1（无限制）" : "Limit must be an integer >= 0 or -1 (unlimited)"), "error");
    return;
  }

  const body = { limit };
  if (rawWindow !== "") {
    const win = parseInt(rawWindow, 10);
    if (!isNaN(win) && win > 0) {
      body.windowSeconds = win;
    }
  }

  try {
    await apiRequest(`/api/admin/quotas/${encodeURIComponent(userId)}/${encodeURIComponent(metric)}`, {
      method: "PATCH",
      body,
    });
    showToast(t("modal.quotaUpdated", { metric, userId }, getLocale() === "zh-CN" ? `用户 ${userId} 的 ${metric} 配额已更新！` : `Quota for ${metric} updated for user ${userId}!`), "success");
    closeModal("modal-edit-quota");
    renderManagementView("quotas");
  } catch {
    showSafeError("update_quota");
  }
}

async function handleCreateSession(e) {
  e.preventDefault();
  const spaceSelect = document.getElementById("session-space-select");
  const titleInput = document.getElementById("session-title-input");

  const spaceId = (spaceSelect && spaceSelect.value) ? spaceSelect.value : state.currentSpaceId;
  const title = titleInput && titleInput.value.trim() ? titleInput.value.trim() : undefined;

  if (!spaceId) {
    showToast(tr("toast.selectTargetSpaceFirst", null, "Please select a target space first"), "error");
    return;
  }

  try {
    const body = { spaceId, executionMode: "container", ...(title ? { title } : {}) };

    const res = await apiRequest("/api/sessions", {
      method: "POST",
      body,
    });

    const newTitle = res.data.title || tr("chat.untitledSession", null, "New Session");
    showToast(tr("toast.sessionCreated", { title: newTitle }, `Session "${newTitle}" created!`), "success");
    closeModal("modal-session");
    document.getElementById("create-session-form").reset();

    state.currentSpaceId = spaceId;
    renderSpaceSelect();
    await loadSessions(spaceId);
    await selectSession(res.data.id);
  } catch {
    showSafeError("create_session");
  }
}

// ----------------------------------------------------
// Safe DOM Markdown Subset Parser (DOM Nodes only)
// ----------------------------------------------------

// ----------------------------------------------------
// Safe DOM Markdown & Syntax Highlighting Engine
// (Zero raw markup injection, zero eval, zero inline styles, CSP-compliant)
// ----------------------------------------------------

function isSafeUrl(url) {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (/^(javascript|data|vbscript):/i.test(trimmed)) return false;
  if (/^(https?:\/\/|mailto:|tel:|\/)/i.test(trimmed)) return true;
  return false;
}

function renderInlineMarkdown(parent, text) {
  if (typeof text !== 'string' || !text) return;

  const tokenRegex = /(!?\[[^\]]*\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g;
  let lastIndex = 0;
  let match;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parent.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
    }

    const token = match[0];
    if (token.startsWith('![') && token.includes('](') && token.endsWith(')')) {
      const imgMatch = token.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (imgMatch) {
        const altText = imgMatch[1] || 'image';
        const imgUrl = imgMatch[2].trim();
        if (isSafeUrl(imgUrl)) {
          const img = document.createElement('img');
          img.className = 'chat-rendered-image';
          img.src = imgUrl;
          img.alt = altText;
          img.loading = 'lazy';
          img.title = altText;
          parent.appendChild(img);
        } else {
          parent.appendChild(document.createTextNode(token));
        }
      } else {
        parent.appendChild(document.createTextNode(token));
      }
    } else if (token.startsWith('`') && token.endsWith('`')) {
      const code = document.createElement('code');
      code.className = 'inline-code';
      code.textContent = token.slice(1, -1);
      parent.appendChild(code);
    } else if (token.startsWith('[') && token.includes('](') && token.endsWith(')')) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        const linkText = linkMatch[1];
        const linkUrl = linkMatch[2].trim();
        if (isSafeUrl(linkUrl)) {
          const a = document.createElement('a');
          a.href = linkUrl;
          if (/^https?:\/\//i.test(linkUrl)) {
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
          }
          a.textContent = linkText;
          parent.appendChild(a);
        } else {
          parent.appendChild(document.createTextNode(token));
        }
      } else {
        parent.appendChild(document.createTextNode(token));
      }
    } else if ((token.startsWith('**') && token.endsWith('**')) || (token.startsWith('__') && token.endsWith('__'))) {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      parent.appendChild(strong);
    } else if ((token.startsWith('*') && token.endsWith('*')) || (token.startsWith('_') && token.endsWith('_'))) {
      const em = document.createElement('em');
      em.textContent = token.slice(1, -1);
      parent.appendChild(em);
    } else {
      parent.appendChild(document.createTextNode(token));
    }

    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    parent.appendChild(document.createTextNode(text.substring(lastIndex)));
  }
}

// Lowlight-compatible AST Tokenizer
const HIGHLIGHT_ALLOWLIST = new Set([
  'javascript', 'js',
  'typescript', 'ts',
  'json',
  'python', 'py',
  'bash', 'sh', 'shell', 'zsh',
  'html', 'xml',
  'css',
  'sql',
  'yaml', 'yml',
  'markdown', 'md',
  'rust', 'rs',
  'go',
  'c', 'cpp', 'c++', 'h', 'hpp',
  'java',
]);

const JS_KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally',
  'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'instanceof',
  'interface', 'let', 'new', 'null', 'of', 'package', 'private', 'protected',
  'public', 'return', 'set', 'static', 'super', 'switch', 'this', 'throw',
  'try', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield',
  'type', 'declare', 'enum', 'namespace',
]);

const PY_KEYWORDS = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if',
  'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield', 'None', 'True', 'False', 'self',
]);

const BASH_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'while', 'until',
  'do', 'done', 'in', 'function', 'select', 'time', 'return', 'exit', 'export',
  'local', 'source', 'alias', 'set', 'unset',
]);

const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set',
  'delete', 'create', 'table', 'drop', 'alter', 'index', 'primary', 'key',
  'foreign', 'references', 'join', 'left', 'right', 'inner', 'outer', 'on',
  'group', 'by', 'order', 'having', 'limit', 'offset', 'distinct', 'union',
  'and', 'or', 'not', 'in', 'like', 'is', 'null', 'as', 'case', 'when',
  'then', 'else', 'end', 'exists', 'between', 'cast', 'count', 'sum', 'avg',
]);

function tokenizeCodeToLowlightAst(code, lang) {
  const normLang = (lang || '').trim().toLowerCase();
  if (!normLang || !HIGHLIGHT_ALLOWLIST.has(normLang)) {
    return [{ type: 'text', value: code }];
  }

  const nodes = [];
  const lines = code.split('\n');

  for (let lIdx = 0; lIdx < lines.length; lIdx++) {
    const line = lines[lIdx];
    if (lIdx > 0) {
      nodes.push({ type: 'text', value: '\n' });
    }

    if (!line) continue;

    // Line comments
    let commentIdx = -1;
    if (normLang === 'python' || normLang === 'py' || normLang === 'yaml' || normLang === 'yml' || normLang === 'bash' || normLang === 'sh' || normLang === 'shell' || normLang === 'zsh') {
      commentIdx = line.indexOf('#');
    } else if (normLang === 'sql') {
      commentIdx = line.indexOf('--');
    } else if (normLang !== 'html' && normLang !== 'xml' && normLang !== 'css' && normLang !== 'json') {
      commentIdx = line.indexOf('//');
    }

    let codePart = line;
    let commentPart = '';
    if (commentIdx !== -1) {
      codePart = line.substring(0, commentIdx);
      commentPart = line.substring(commentIdx);
    }

    // Tokenize codePart using regex for strings, numbers, identifiers, punctuation
    const tokenRe = /("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|`[^`\\]*(?:\\.[^`\\]*)*`|\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?\b|[a-zA-Z_$][a-zA-Z0-9_$]*|[^\s\w])/g;
    let lastIdx = 0;
    let match;

    while ((match = tokenRe.exec(codePart)) !== null) {
      if (match.index > lastIdx) {
        nodes.push({ type: 'text', value: codePart.substring(lastIdx, match.index) });
      }

      const tok = match[0];
      if (tok.startsWith('"') || tok.startsWith("'") || tok.startsWith('`')) {
        nodes.push({
          type: 'element',
          tagName: 'span',
          properties: { className: ['hljs-string'] },
          children: [{ type: 'text', value: tok }],
        });
      } else if (/^\d/.test(tok) || tok.startsWith('0x')) {
        nodes.push({
          type: 'element',
          tagName: 'span',
          properties: { className: ['hljs-number'] },
          children: [{ type: 'text', value: tok }],
        });
      } else if (/^[a-zA-Z_$]/.test(tok)) {
        const lowerTok = tok.toLowerCase();
        let isKeyword = false;
        if (normLang === 'python' || normLang === 'py') {
          isKeyword = PY_KEYWORDS.has(tok);
        } else if (normLang === 'sql') {
          isKeyword = SQL_KEYWORDS.has(lowerTok);
        } else if (normLang === 'bash' || normLang === 'sh' || normLang === 'shell' || normLang === 'zsh') {
          isKeyword = BASH_KEYWORDS.has(tok);
        } else if (normLang === 'json') {
          isKeyword = tok === 'true' || tok === 'false' || tok === 'null';
        } else {
          isKeyword = JS_KEYWORDS.has(tok);
        }

        if (isKeyword) {
          nodes.push({
            type: 'element',
            tagName: 'span',
            properties: { className: ['hljs-keyword'] },
            children: [{ type: 'text', value: tok }],
          });
        } else if (tok === 'true' || tok === 'false' || tok === 'null' || tok === 'undefined' || tok === 'None' || tok === 'True' || tok === 'False') {
          nodes.push({
            type: 'element',
            tagName: 'span',
            properties: { className: ['hljs-literal'] },
            children: [{ type: 'text', value: tok }],
          });
        } else {
          nodes.push({ type: 'text', value: tok });
        }
      } else {
        nodes.push({ type: 'text', value: tok });
      }

      lastIdx = tokenRe.lastIndex;
    }

    if (lastIdx < codePart.length) {
      nodes.push({ type: 'text', value: codePart.substring(lastIdx) });
    }

    if (commentPart) {
      nodes.push({
        type: 'element',
        tagName: 'span',
        properties: { className: ['hljs-comment'] },
        children: [{ type: 'text', value: commentPart }],
      });
    }
  }

  return nodes;
}

function renderLowlightAstToDom(container, astNodes) {
  if (!Array.isArray(astNodes)) return;
  for (const node of astNodes) {
    if (!node) continue;
    if (node.type === 'text') {
      container.appendChild(document.createTextNode(node.value || ''));
    } else if (node.type === 'element' && node.tagName === 'span') {
      const span = document.createElement('span');
      if (node.properties && Array.isArray(node.properties.className)) {
        span.className = node.properties.className.join(' ');
      }
      if (node.children) {
        renderLowlightAstToDom(span, node.children);
      }
      container.appendChild(span);
    }
  }
}

// Safe GFM Table Parser (Bounds: max 100 rows, max 20 cols, max 1000 total cells, max 1000 bytes/cell)
const MAX_TABLE_ROWS = 100;
const MAX_TABLE_COLS = 20;
const MAX_TOTAL_CELLS = 1000;
const MAX_CELL_BYTES = 1000;

function parseMarkdownTable(lines, startIndex) {
  if (startIndex + 1 >= lines.length) return null;

  const headerLine = lines[startIndex].trim();
  const delimiterLine = lines[startIndex + 1].trim();

  // Delimiter validation
  if (!delimiterLine.includes('-') || !delimiterLine.includes('|')) return null;

  const splitTableRow = (rowStr) => {
    let raw = rowStr.trim();
    if (raw.startsWith('|')) raw = raw.slice(1);
    if (raw.endsWith('|')) raw = raw.slice(0, -1);
    return raw.split('|').map((c) => c.trim());
  };

  const delimCells = splitTableRow(delimiterLine);
  if (delimCells.length === 0 || delimCells.length > MAX_TABLE_COLS) return null;

  const alignments = [];
  for (const dc of delimCells) {
    const trimmed = dc.replace(/\s+/g, '');
    if (!/^:?-+:?$/.test(trimmed) || trimmed.replace(/:/g, '').length < 1) {
      return null; // Invalid delimiter row
    }
    if (trimmed.startsWith(':') && trimmed.endsWith(':')) {
      alignments.push('align-center');
    } else if (trimmed.endsWith(':')) {
      alignments.push('align-right');
    } else {
      alignments.push('align-left');
    }
  }

  const numCols = Math.min(delimCells.length, MAX_TABLE_COLS);
  const headerCells = splitTableRow(headerLine).slice(0, numCols);

  const wrapper = document.createElement('div');
  wrapper.className = 'markdown-table-wrapper';

  const table = document.createElement('table');
  table.className = 'markdown-table';

  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');

  let totalCellsCount = 0;

  for (let c = 0; c < numCols; c++) {
    const th = document.createElement('th');
    const alignClass = alignments[c] || 'align-left';
    th.className = alignClass;
    const rawText = headerCells[c] || '';
    const safeText = rawText.length > MAX_CELL_BYTES ? rawText.substring(0, MAX_CELL_BYTES) : rawText;
    renderInlineMarkdown(th, safeText);
    trHead.appendChild(th);
    totalCellsCount++;
  }
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  let rowIdx = startIndex + 2;
  let rowCount = 0;

  while (rowIdx < lines.length && rowCount < MAX_TABLE_ROWS && totalCellsCount < MAX_TOTAL_CELLS) {
    const currentLine = lines[rowIdx].trim();
    if (!currentLine || !currentLine.includes('|')) break;

    const rowCells = splitTableRow(currentLine);
    const tr = document.createElement('tr');

    for (let c = 0; c < numCols; c++) {
      const td = document.createElement('td');
      const alignClass = alignments[c] || 'align-left';
      td.className = alignClass;
      const rawText = rowCells[c] || '';
      const safeText = rawText.length > MAX_CELL_BYTES ? rawText.substring(0, MAX_CELL_BYTES) : rawText;
      renderInlineMarkdown(td, safeText);
      tr.appendChild(td);
      totalCellsCount++;
      if (totalCellsCount >= MAX_TOTAL_CELLS) break;
    }

    tbody.appendChild(tr);
    rowCount++;
    rowIdx++;
  }

  table.appendChild(tbody);
  wrapper.appendChild(table);

  return {
    element: wrapper,
    nextIndex: rowIdx,
  };
}

function renderMarkdownToElement(container, markdownText) {
  if (typeof markdownText !== 'string' || !markdownText) {
    return;
  }

  const lines = markdownText.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 1. Fenced Code Block
    const codeBlockMatch = line.match(/^```(\w+)?/);
    if (codeBlockMatch) {
      const lang = (codeBlockMatch[1] || '').trim().toLowerCase();
      i++;
      const codeLines = [];
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length && lines[i].startsWith('```')) {
        i++;
      }
      const codeContent = codeLines.join('\n');

      if (lang === 'mermaid') {
        const placeholder = document.createElement('div');
        placeholder.className = 'mermaid-placeholder';

        const header = document.createElement('div');
        header.className = 'mermaid-header';
        const iconSpan = document.createElement('span');
        iconSpan.className = 'mermaid-icon';
        iconSpan.textContent = '📊';
        const titleSpan = document.createElement('span');
        titleSpan.className = 'mermaid-title';
        titleSpan.textContent = tr('chat.mermaidTitle', null, 'Mermaid Diagram');
        header.appendChild(iconSpan);
        header.appendChild(titleSpan);

        const pre = document.createElement('pre');
        pre.className = 'mermaid-code';
        const codeEl = document.createElement('code');
        codeEl.textContent = codeContent;
        pre.appendChild(codeEl);

        placeholder.appendChild(header);
        placeholder.appendChild(pre);
        container.appendChild(placeholder);
      } else {
        const blockWrapper = document.createElement('div');
        blockWrapper.className = 'code-block-wrapper';

        const blockHeader = document.createElement('div');
        blockHeader.className = 'code-block-header';

        const langSpan = document.createElement('span');
        langSpan.className = 'code-lang';
        langSpan.textContent = lang || 'code';

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'btn-copy-code btn btn-secondary btn-xs';
        copyBtn.textContent = tr('common.copy', null, 'Copy');
        copyBtn.title = tr('chat.copyCodeTitle', null, 'Copy code to clipboard');
        copyBtn.addEventListener('click', () => {
          const copiedText = tr('common.copied', null, 'Copied!');
          const copyText = tr('common.copy', null, 'Copy');
          if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(codeContent).then(() => {
              copyBtn.textContent = copiedText;
              setTimeout(() => {
                copyBtn.textContent = copyText;
              }, 2000);
            }).catch(() => {
              copyBtn.textContent = copiedText;
              setTimeout(() => {
                copyBtn.textContent = copyText;
              }, 2000);
            });
          } else {
            copyBtn.textContent = copiedText;
            setTimeout(() => {
              copyBtn.textContent = copyText;
            }, 2000);
          }
        });

        blockHeader.appendChild(langSpan);
        blockHeader.appendChild(copyBtn);

        const pre = document.createElement('pre');
        const codeEl = document.createElement('code');
        if (lang) {
          codeEl.className = `language-${lang}`;
        }

        // Render syntax highlighting using Lowlight AST nodes
        const astNodes = tokenizeCodeToLowlightAst(codeContent, lang);
        renderLowlightAstToDom(codeEl, astNodes);

        pre.appendChild(codeEl);

        blockWrapper.appendChild(blockHeader);
        blockWrapper.appendChild(pre);
        container.appendChild(blockWrapper);
      }
      continue;
    }

    // 2. GFM Table
    if (line.trim().startsWith('|') || (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && lines[i + 1].includes('|'))) {
      const parsedTable = parseMarkdownTable(lines, i);
      if (parsedTable) {
        container.appendChild(parsedTable.element);
        i = parsedTable.nextIndex;
        continue;
      }
    }

    // 3. Headings (# H1 to ###### H6)
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2];
      const hEl = document.createElement(`h${level}`);
      renderInlineMarkdown(hEl, headingText);
      container.appendChild(hEl);
      i++;
      continue;
    }

    // 4. Blockquotes (> ...)
    if (line.startsWith('>')) {
      const quoteLines = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      const bq = document.createElement('blockquote');
      const p = document.createElement('p');
      renderInlineMarkdown(p, quoteLines.join(' '));
      bq.appendChild(p);
      container.appendChild(bq);
      continue;
    }

    // 5. Unordered Lists (- item or * item)
    if (line.match(/^[\*\-]\s+(.*)$/)) {
      const ul = document.createElement('ul');
      while (i < lines.length && lines[i].match(/^[\*\-]\s+(.*)$/)) {
        const itemMatch = lines[i].match(/^[\*\-]\s+(.*)$/);
        const li = document.createElement('li');
        renderInlineMarkdown(li, itemMatch[1]);
        ul.appendChild(li);
        i++;
      }
      container.appendChild(ul);
      continue;
    }

    // 6. Ordered Lists (1. item)
    if (line.match(/^\d+\.\s+(.*)$/)) {
      const ol = document.createElement('ol');
      while (i < lines.length && lines[i].match(/^\d+\.\s+(.*)$/)) {
        const itemMatch = lines[i].match(/^\d+\.\s+(.*)$/);
        const li = document.createElement('li');
        renderInlineMarkdown(li, itemMatch[1]);
        ol.appendChild(li);
        i++;
      }
      container.appendChild(ol);
      continue;
    }

    // 7. Blank lines
    if (!line.trim()) {
      i++;
      continue;
    }

    // 8. Paragraphs
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith('```') &&
      !lines[i].match(/^#{1,6}\s+/) &&
      !lines[i].startsWith('>') &&
      !lines[i].match(/^[\*\-]\s+/) &&
      !lines[i].match(/^\d+\.\s+/) &&
      !(lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && lines[i + 1].includes('|'))
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    const p = document.createElement('p');
    renderInlineMarkdown(p, paraLines.join('\n'));
    container.appendChild(p);
  }
}

// ----------------------------------------------------
// Attachment Icon & Rendering Helpers
// ----------------------------------------------------

function getFileIcon(nameOrMediaType) {
  const str = String(nameOrMediaType || '').toLowerCase();
  if (
    str.includes('image/') ||
    str.endsWith('.png') ||
    str.endsWith('.jpg') ||
    str.endsWith('.jpeg') ||
    str.endsWith('.gif') ||
    str.endsWith('.webp') ||
    str.endsWith('.svg') ||
    str.endsWith('.bmp')
  ) {
    return '🖼️';
  }
  if (str.includes('pdf') || str.endsWith('.pdf')) {
    return '📄';
  }
  if (
    str.includes('text/') ||
    str.includes('json') ||
    str.includes('javascript') ||
    str.includes('typescript') ||
    str.endsWith('.txt') ||
    str.endsWith('.md') ||
    str.endsWith('.json') ||
    str.endsWith('.js') ||
    str.endsWith('.ts') ||
    str.endsWith('.csv') ||
    str.endsWith('.html') ||
    str.endsWith('.css') ||
    str.endsWith('.yml') ||
    str.endsWith('.yaml')
  ) {
    return '📝';
  }
  if (
    str.includes('zip') ||
    str.includes('tar') ||
    str.includes('gzip') ||
    str.endsWith('.zip') ||
    str.endsWith('.tar') ||
    str.endsWith('.gz') ||
    str.endsWith('.tgz') ||
    str.endsWith('.7z')
  ) {
    return '📦';
  }
  return '📎';
}

function sanitizeClientFilename(name) {
  if (!name || typeof name !== 'string') return 'attachment.bin';
  return name.normalize('NFC').replace(/[\/\\\0]/g, '_').trim() || 'attachment.bin';
}

function renderMessageAttachments(parentCard, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return;

  const container = document.createElement('div');
  container.className = 'message-attachments-container';

  attachments.forEach((att) => {
    if (!att || typeof att !== 'object') return;

    const card = document.createElement('div');
    card.className = 'message-attachment-card';

    const iconSpan = document.createElement('span');
    iconSpan.className = 'message-attachment-icon';
    iconSpan.textContent = getFileIcon(att.mediaType || att.displayName || att.relativePath);

    const details = document.createElement('div');
    details.className = 'message-attachment-details';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'message-attachment-name';
    const displayName = att.displayName || (att.relativePath ? att.relativePath.split('/').pop() : 'attachment');
    nameSpan.textContent = displayName;

    const sizeSpan = document.createElement('span');
    sizeSpan.className = 'message-attachment-size';
    sizeSpan.textContent = formatBytes(att.size);

    details.appendChild(nameSpan);
    details.appendChild(sizeSpan);

    card.appendChild(iconSpan);
    card.appendChild(details);

    // Safe download link verification: must be relative starting with /api/spaces/
    if (typeof att.downloadUrl === 'string' && att.downloadUrl.startsWith('/api/spaces/')) {
      const downloadLink = document.createElement('a');
      downloadLink.className = 'btn btn-secondary btn-xs attachment-download-btn';
      downloadLink.href = att.downloadUrl;
      downloadLink.download = displayName;
      downloadLink.target = '_blank';
      downloadLink.rel = 'noopener noreferrer';
      downloadLink.textContent = t('chat.attachmentDownload', null, 'Download');
      downloadLink.setAttribute('aria-label', t('chat.attachmentDownloadAria', { name: displayName }, `Download ${displayName}`));
      downloadLink.setAttribute('title', t('chat.attachmentDownloadAria', { name: displayName }, `Download ${displayName}`));
      card.appendChild(downloadLink);
    }

    container.appendChild(card);
  });

  parentCard.appendChild(container);
}

// ----------------------------------------------------
// UI Helpers for Composer & Sidebar
// ----------------------------------------------------

function updateComposerControlsState() {
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('btn-send-message');
  const attachBtn = document.getElementById('btn-attach');

  const hasSession = Boolean(state.currentSessionId);
  const isArchived = Boolean(state.currentSessionRoute && state.currentSessionRoute.status === 'archived');
  const isSending = Boolean(state.isSendingMessage);
  const isQueued = Boolean(state.activeTurnStatus === 'queued');

  if (attachBtn) {
    attachBtn.disabled = !hasSession || isArchived || isSending;
  }

  if (input) {
    input.disabled = !hasSession || isArchived || isSending;
  }

  if (sendBtn) {
    const hasText = Boolean(input && input.value.trim().length > 0);
    const hasUploading = state.activeAttachments.some((a) => a.status === 'uploading' || a.status === 'pending');
    sendBtn.disabled = !hasSession || isArchived || !hasText || hasUploading || isSending;

    if (isQueued && !isSending) {
      sendBtn.textContent = tr('chat.queuedChip', null, '⏳ Turn Queued');
    } else {
      sendBtn.textContent = tr('chat.send', null, 'Send');
    }
  }
}

function renderAttachmentTray() {
  const tray = document.getElementById('composer-attachment-tray');
  if (!tray) return;

  tray.replaceChildren();

  if (state.activeAttachments.length === 0) {
    tray.classList.add('hidden');
    updateComposerControlsState();
    return;
  }

  tray.classList.remove('hidden');

  state.activeAttachments.forEach((item) => {
    const trayItem = document.createElement('div');
    trayItem.className = `attachment-tray-item status-${item.status}`;

    const iconSpan = document.createElement('span');
    iconSpan.className = 'attachment-tray-icon';
    iconSpan.textContent = getFileIcon(item.displayName);

    const details = document.createElement('div');
    details.className = 'attachment-tray-details';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'attachment-tray-name';
    nameSpan.textContent = item.displayName;

    const metaSpan = document.createElement('span');
    metaSpan.className = 'attachment-tray-meta';
    if (item.status === 'uploading') {
      metaSpan.textContent = t('chat.uploadProgress', { percent: item.progress || 0 }, `Uploading ${item.progress || 0}%`);
    } else if (item.status === 'error') {
      metaSpan.textContent = t('chat.uploadFailed', null, 'Upload failed');
    } else {
      metaSpan.textContent = formatBytes(item.size);
    }

    details.appendChild(nameSpan);
    details.appendChild(metaSpan);

    const actions = document.createElement('div');
    actions.className = 'attachment-tray-actions';

    if (item.status === 'uploading') {
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn-tray-cancel';
      cancelBtn.title = t('chat.cancelUpload', null, 'Cancel upload');
      cancelBtn.setAttribute('aria-label', t('chat.cancelUpload', null, 'Cancel upload'));
      cancelBtn.textContent = '✕';
      cancelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cancelComposerUpload(item.id);
      });
      actions.appendChild(cancelBtn);
    } else if (item.status === 'error') {
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn-tray-retry';
      retryBtn.title = t('chat.retryUpload', null, 'Retry upload');
      retryBtn.setAttribute('aria-label', t('chat.retryUpload', null, 'Retry upload'));
      retryBtn.textContent = '↻';
      retryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        retryComposerUpload(item.id);
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn-tray-remove';
      removeBtn.title = t('chat.removeAttachment', null, 'Remove attachment');
      removeBtn.setAttribute('aria-label', t('chat.removeAttachmentAria', { name: item.displayName }, `Remove ${item.displayName}`));
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeAttachment(item.id);
      });

      actions.appendChild(retryBtn);
      actions.appendChild(removeBtn);
    } else {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn-tray-remove';
      removeBtn.title = t('chat.removeAttachment', null, 'Remove attachment');
      removeBtn.setAttribute('aria-label', t('chat.removeAttachmentAria', { name: item.displayName }, `Remove ${item.displayName}`));
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeAttachment(item.id);
      });
      actions.appendChild(removeBtn);
    }

    trayItem.appendChild(iconSpan);
    trayItem.appendChild(details);
    trayItem.appendChild(actions);

    tray.appendChild(trayItem);
  });

  updateComposerControlsState();
}

function removeAttachment(attachmentId) {
  const item = state.activeAttachments.find((a) => a.id === attachmentId);
  if (item && item.abortController) {
    try { item.abortController.abort(); } catch {}
  }
  state.activeAttachments = state.activeAttachments.filter((a) => a.id !== attachmentId);
  state.composerUploadQueue = state.composerUploadQueue.filter((a) => a.id !== attachmentId);
  if (state.currentSessionId) {
    const input = document.getElementById('chat-input');
    state.drafts[state.currentSessionId] = {
      content: input ? input.value : '',
      attachments: [...state.activeAttachments],
    };
  }
  renderAttachmentTray();
}

function cancelComposerUpload(attachmentId) {
  removeAttachment(attachmentId);
}

function retryComposerUpload(attachmentId) {
  const item = state.activeAttachments.find((a) => a.id === attachmentId);
  if (!item || item.status !== 'error') return;

  item.status = 'uploading';
  item.progress = 0;
  item.error = null;
  item.abortController = new AbortController();

  if (!state.composerUploadQueue.includes(item)) {
    state.composerUploadQueue.push(item);
  }

  renderAttachmentTray();
  processComposerUploadQueue();
}

function handleFilesSelected(files) {
  if (!files || files.length === 0) return;
  if (!state.currentSessionId || !state.currentSpaceId) {
    showToast(t('toast.selectActiveSessionFirst', null, 'Select an active session first'), 'error');
    return;
  }

  const fileList = Array.from(files);
  const MAX_ATTACHMENTS = 10;
  const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
  const MAX_TOTAL_SIZE = 50 * 1024 * 1024; // 50 MB

  let currentTotalSize = state.activeAttachments.reduce((sum, a) => sum + (a.size || 0), 0);

  for (const file of fileList) {
    if (state.activeAttachments.length >= MAX_ATTACHMENTS) {
      showToast(t('chat.maxAttachmentsExceeded', null, 'Maximum 10 attachments allowed per message'), 'error');
      break;
    }

    if (file.size > MAX_FILE_SIZE) {
      showToast(t('chat.maxFileSizeExceeded', { name: file.name }, `File "${file.name}" exceeds the maximum limit of 50 MB`), 'error');
      continue;
    }

    if (currentTotalSize + file.size > MAX_TOTAL_SIZE) {
      showToast(t('chat.maxTotalSizeExceeded', null, 'Total attachment size cannot exceed 50 MB'), 'error');
      break;
    }

    // Check duplicate in active tray
    const isDuplicate = state.activeAttachments.some(
      (a) => a.displayName === file.name && a.size === file.size
    );
    if (isDuplicate) {
      showToast(t('chat.fileAlreadyAttached', { name: file.name }, `File "${file.name}" is already attached`), 'warning');
      continue;
    }

    const item = {
      id: crypto.randomUUID(),
      type: 'upload',
      displayName: file.name,
      size: file.size,
      status: 'uploading',
      progress: 0,
      path: null,
      etag: null,
      error: null,
      file,
      abortController: new AbortController(),
    };

    state.activeAttachments.push(item);
    state.composerUploadQueue.push(item);
    currentTotalSize += file.size;
  }

  if (state.currentSessionId) {
    const input = document.getElementById('chat-input');
    state.drafts[state.currentSessionId] = {
      content: input ? input.value : '',
      attachments: [...state.activeAttachments],
    };
  }

  renderAttachmentTray();
  processComposerUploadQueue();
}

async function ensureUploadsDir(spaceId) {
  try {
    await apiRequest(`/api/spaces/${encodeURIComponent(spaceId)}/files/mkdir`, {
      method: 'POST',
      body: { path: 'uploads' },
    });
  } catch {
    // Conflict (409) or directory already existing is completely safe and expected
  }
}

async function processComposerUploadQueue() {
  const MAX_CONCURRENT_UPLOADS = 2;

  while (state.activeComposerUploadCount < MAX_CONCURRENT_UPLOADS && state.composerUploadQueue.length > 0) {
    const item = state.composerUploadQueue.shift();
    if (!item || item.status !== 'uploading') continue;

    state.activeComposerUploadCount++;
    const spaceId = state.currentSpaceId;

    (async () => {
      try {
        await ensureUploadsDir(spaceId);

        const formData = new FormData();
        const uuidPrefix = crypto.randomUUID().slice(0, 8);
        const safeName = sanitizeClientFilename(item.file.name);
        const destFilename = `${uuidPrefix}-${safeName}`;

        formData.append('file', item.file, destFilename);

        const uploadUrl = `/api/spaces/${encodeURIComponent(spaceId)}/files/upload?path=uploads`;
        const csrf = state.csrfToken || (await fetchCsrfToken());
        const idempotencyKey = crypto.randomUUID();

        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', uploadUrl, true);
          xhr.setRequestHeader('X-Enkeep-CSRF', csrf);
          xhr.setRequestHeader('Idempotency-Key', idempotencyKey);
          xhr.withCredentials = true;

          if (item.abortController) {
            item.abortController.signal.addEventListener('abort', () => {
              xhr.abort();
              reject(new Error('Upload aborted'));
            });
          }

          xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable && e.total > 0) {
              item.progress = Math.min(Math.round((e.loaded / e.total) * 100), 99);
              renderAttachmentTray();
            }
          });

          xhr.addEventListener('load', () => {
            if (xhr.status === 200 || xhr.status === 201) {
              try {
                const res = JSON.parse(xhr.responseText);
                if (res && res.data && Array.isArray(res.data.files) && res.data.files[0]) {
                  const uploadedFile = res.data.files[0];
                  item.status = 'ready';
                  item.path = uploadedFile.path;
                  item.etag = uploadedFile.etag;
                  item.progress = 100;
                  resolve(uploadedFile);
                } else {
                  reject(new Error('Malformed upload response'));
                }
              } catch (parseErr) {
                reject(parseErr);
              }
            } else {
              try {
                const res = JSON.parse(xhr.responseText);
                const msg = (res && res.error && res.error.message) || `Upload failed (${xhr.status})`;
                reject(new Error(msg));
              } catch {
                reject(new Error(`Upload failed (${xhr.status})`));
              }
            }
          });

          xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
          xhr.send(formData);
        });
      } catch (err) {
        if (item.abortController && item.abortController.signal.aborted) {
          // If aborted by user, it's already removed
          return;
        }
        item.status = 'error';
        item.error = err && err.message ? err.message : 'Upload failed';
        showToast(item.error, 'error');
      } finally {
        state.activeComposerUploadCount--;
        if (state.currentSessionId) {
          const input = document.getElementById('chat-input');
          state.drafts[state.currentSessionId] = {
            content: input ? input.value : '',
            attachments: [...state.activeAttachments],
          };
        }
        renderAttachmentTray();
        processComposerUploadQueue();
      }
    })();
  }
}

// ----------------------------------------------------
// Workspace File Picker Modal Logic
// ----------------------------------------------------

function openWorkspaceFilePicker() {
  if (!state.currentSpaceId) {
    showToast(t('toast.selectActiveSessionFirst', null, 'Select an active session first'), 'error');
    return;
  }

  state.filePickerCurrentPath = '.';
  state.filePickerSelectedEntries = new Map();
  state.filePickerSearchQuery = '';

  const searchInput = document.getElementById('file-picker-search-input');
  if (searchInput) searchInput.value = '';

  openModal('modal-file-picker');
  loadWorkspaceFilePicker('.');
}

async function loadWorkspaceFilePicker(dirPath = '.') {
  const listContainer = document.getElementById('file-picker-list');
  const breadcrumbsContainer = document.getElementById('file-picker-breadcrumbs');
  const selectBtn = document.getElementById('btn-file-picker-select');
  const countSpan = document.getElementById('file-picker-selected-count');

  if (!listContainer || !state.currentSpaceId) return;

  state.filePickerCurrentPath = dirPath;

  // Render Breadcrumbs
  if (breadcrumbsContainer) {
    breadcrumbsContainer.replaceChildren();
    const parts = dirPath === '.' || dirPath === '' ? [] : dirPath.split('/').filter(Boolean);

    const rootCrumb = document.createElement('span');
    rootCrumb.className = `file-picker-crumb ${parts.length === 0 ? 'active' : ''}`;
    rootCrumb.textContent = t('modal.filePickerRootFolder', null, 'Root Directory');
    if (parts.length > 0) {
      rootCrumb.addEventListener('click', () => loadWorkspaceFilePicker('.'));
    }
    breadcrumbsContainer.appendChild(rootCrumb);

    let accPath = '';
    parts.forEach((part, idx) => {
      accPath = accPath ? `${accPath}/${part}` : part;
      const targetPath = accPath;

      const sep = document.createElement('span');
      sep.className = 'file-picker-crumb-separator';
      sep.textContent = '/';
      breadcrumbsContainer.appendChild(sep);

      const crumb = document.createElement('span');
      const isLast = idx === parts.length - 1;
      crumb.className = `file-picker-crumb ${isLast ? 'active' : ''}`;
      crumb.textContent = part;
      if (!isLast) {
        crumb.addEventListener('click', () => loadWorkspaceFilePicker(targetPath));
      }
      breadcrumbsContainer.appendChild(crumb);
    });
  }

  listContainer.replaceChildren();

  const loadingDiv = document.createElement('div');
  loadingDiv.className = 'file-picker-empty';
  loadingDiv.textContent = t('modal.filePickerLoading', null, 'Loading workspace files...');
  listContainer.appendChild(loadingDiv);

  try {
    const res = await apiRequest(`/api/spaces/${encodeURIComponent(state.currentSpaceId)}/files?path=${encodeURIComponent(dirPath)}`);
    listContainer.replaceChildren();

    if (!res || !res.data || !Array.isArray(res.data.entries)) {
      throw new Error('Malformed file list response');
    }

    const entries = res.data.entries;
    const query = (state.filePickerSearchQuery || '').toLowerCase().trim();
    const filteredEntries = query
      ? entries.filter((e) => e.name.toLowerCase().includes(query))
      : entries;

    if (filteredEntries.length === 0) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'file-picker-empty';
      emptyDiv.textContent = query
        ? t('modal.filePickerNoMatch', null, 'No matching files found')
        : t('modal.filePickerEmpty', null, 'No files found in this workspace');
      listContainer.appendChild(emptyDiv);
      updateFilePickerSelectionUI();
      return;
    }

    // Up one level row if not root
    if (dirPath !== '.' && dirPath !== '' && !query) {
      const upItem = document.createElement('div');
      upItem.className = 'file-picker-item is-dir';

      const upIcon = document.createElement('span');
      upIcon.className = 'file-picker-item-icon';
      upIcon.textContent = '📁';

      const upName = document.createElement('span');
      upName.className = 'file-picker-item-name';
      upName.textContent = `.. (${t('modal.filePickerNavigateUp', null, 'Up one level')})`;

      upItem.appendChild(upIcon);
      upItem.appendChild(upName);

      upItem.addEventListener('click', () => {
        const parts = dirPath.split('/');
        parts.pop();
        const parentPath = parts.join('/') || '.';
        loadWorkspaceFilePicker(parentPath);
      });

      listContainer.appendChild(upItem);
    }

    // Sort: directories first, then files
    const sorted = [...filteredEntries].sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name);
    });

    sorted.forEach((entry) => {
      const entryRelPath = dirPath === '.' || dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;

      const itemEl = document.createElement('div');
      itemEl.className = `file-picker-item ${entry.type === 'directory' ? 'is-dir' : 'is-file'}`;

      if (entry.type === 'directory') {
        const iconSpan = document.createElement('span');
        iconSpan.className = 'file-picker-item-icon';
        iconSpan.textContent = '📁';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'file-picker-item-name';
        nameSpan.textContent = entry.name;

        itemEl.appendChild(iconSpan);
        itemEl.appendChild(nameSpan);

        itemEl.addEventListener('click', () => {
          loadWorkspaceFilePicker(entryRelPath);
        });
      } else {
        const isSelected = state.filePickerSelectedEntries.has(entryRelPath);
        if (isSelected) itemEl.classList.add('selected');

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'file-picker-item-checkbox';
        checkbox.checked = isSelected;
        checkbox.setAttribute('aria-label', t('modal.filePickerItemAria', { name: entry.name }, `Select ${entry.name}`));

        const iconSpan = document.createElement('span');
        iconSpan.className = 'file-picker-item-icon';
        iconSpan.textContent = getFileIcon(entry.name);

        const nameSpan = document.createElement('span');
        nameSpan.className = 'file-picker-item-name';
        nameSpan.textContent = entry.name;

        const sizeSpan = document.createElement('span');
        sizeSpan.className = 'file-picker-item-size';
        sizeSpan.textContent = formatBytes(entry.size);

        itemEl.appendChild(checkbox);
        itemEl.appendChild(iconSpan);
        itemEl.appendChild(nameSpan);
        itemEl.appendChild(sizeSpan);

        const toggleSelection = (e) => {
          if (e.target !== checkbox) {
            checkbox.checked = !checkbox.checked;
          }
          if (checkbox.checked) {
            const currentTotal = state.activeAttachments.length + state.filePickerSelectedEntries.size;
            if (currentTotal >= 10) {
              checkbox.checked = false;
              showToast(t('modal.filePickerMaxSelected', null, 'Maximum 10 files can be selected'), 'warning');
              return;
            }
            state.filePickerSelectedEntries.set(entryRelPath, {
              path: entryRelPath,
              etag: entry.etag,
              name: entry.name,
              size: entry.size,
              type: entry.type,
            });
            itemEl.classList.add('selected');
          } else {
            state.filePickerSelectedEntries.delete(entryRelPath);
            itemEl.classList.remove('selected');
          }
          updateFilePickerSelectionUI();
        };

        itemEl.addEventListener('click', toggleSelection);
      }

      listContainer.appendChild(itemEl);
    });

    updateFilePickerSelectionUI();
  } catch {
    listContainer.replaceChildren();
    const errDiv = document.createElement('div');
    errDiv.className = 'file-picker-empty text-danger';
    errDiv.textContent = t('toast.failedLoadFiles', null, 'Failed to load workspace files');
    listContainer.appendChild(errDiv);
  }
}

function updateFilePickerSelectionUI() {
  const selectBtn = document.getElementById('btn-file-picker-select');
  const countSpan = document.getElementById('file-picker-selected-count');
  const count = state.filePickerSelectedEntries.size;

  if (countSpan) {
    countSpan.textContent = count > 0
      ? t('modal.filePickerSelectedCount', { count: formatNumber(count) }, `${count} file(s) selected`)
      : '';
  }

  if (selectBtn) {
    selectBtn.disabled = count === 0;
  }
}

function handleApplyWorkspacePickerSelection() {
  const entries = Array.from(state.filePickerSelectedEntries.values());
  if (entries.length === 0) return;

  const MAX_ATTACHMENTS = 10;
  const MAX_TOTAL_SIZE = 50 * 1024 * 1024;

  let currentTotalSize = state.activeAttachments.reduce((sum, a) => sum + (a.size || 0), 0);

  for (const entry of entries) {
    if (state.activeAttachments.length >= MAX_ATTACHMENTS) {
      showToast(t('chat.maxAttachmentsExceeded', null, 'Maximum 10 attachments allowed per message'), 'error');
      break;
    }

    if (currentTotalSize + entry.size > MAX_TOTAL_SIZE) {
      showToast(t('chat.maxTotalSizeExceeded', null, 'Total attachment size cannot exceed 50 MB'), 'error');
      break;
    }

    // Check duplicate in active attachments
    const isDuplicate = state.activeAttachments.some(
      (a) => (a.path && a.path === entry.path) || (a.displayName === entry.name && a.size === entry.size)
    );
    if (isDuplicate) {
      showToast(t('chat.fileAlreadyAttached', { name: entry.name }, `File "${entry.name}" is already attached`), 'warning');
      continue;
    }

    state.activeAttachments.push({
      id: crypto.randomUUID(),
      type: 'workspace',
      displayName: entry.name,
      size: entry.size,
      status: 'ready',
      progress: 100,
      path: entry.path,
      etag: entry.etag,
    });
    currentTotalSize += entry.size;
  }

  if (state.currentSessionId) {
    const input = document.getElementById('chat-input');
    state.drafts[state.currentSessionId] = {
      content: input ? input.value : '',
      attachments: [...state.activeAttachments],
    };
  }

  closeModal('modal-file-picker');
  renderAttachmentTray();
}

function setupComposerDragAndDrop() {
  const composerBox = document.getElementById('composer-box');
  if (!composerBox) return;

  // Prevent default window drop to prevent browser navigation
  window.addEventListener('dragover', (e) => e.preventDefault(), false);
  window.addEventListener('drop', (e) => e.preventDefault(), false);

  composerBox.addEventListener('dragenter', (e) => {
    e.preventDefault();
    e.stopPropagation();
    composerBox.classList.add('drag-over');
  });

  composerBox.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    composerBox.classList.add('drag-over');
  });

  composerBox.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    composerBox.classList.remove('drag-over');
  });

  composerBox.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    composerBox.classList.remove('drag-over');

    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFilesSelected(e.dataTransfer.files);
    }
  });
}

function setupComposerPasteHandler() {
  const chatInput = document.getElementById('chat-input');
  if (!chatInput) return;

  chatInput.addEventListener('paste', (e) => {
    if (!e.clipboardData) return;

    const items = e.clipboardData.items;
    if (items && items.length > 0) {
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) {
            e.preventDefault();
            const timestamp = Date.now();
            const filename = `pasted-image-${timestamp}.png`;
            const imageFile = new File([blob], filename, { type: blob.type || 'image/png' });
            handleFilesSelected([imageFile]);
            return;
          }
        }
      }
    }

    if (e.clipboardData.files && e.clipboardData.files.length > 0) {
      e.preventDefault();
      handleFilesSelected(e.clipboardData.files);
    }
  });
}

function adjustTextareaHeight(textarea) {
  if (!textarea) return;
  const lineCount = (textarea.value.match(/\n/g) || []).length + 1;
  textarea.rows = Math.min(Math.max(lineCount, 2), 8);
}

function updateCharCount() {
  const input = document.getElementById('chat-input');
  const countEl = document.getElementById('chat-char-count');
  if (input && countEl) {
    const len = input.value.length;
    countEl.textContent = tr('chat.charCount', { current: formatNumber(len, { useGrouping: false }), max: formatNumber(4000, { useGrouping: false }) }, `${len} / 4000`);
    if (len > 4000) {
      countEl.classList.add('text-danger');
    } else {
      countEl.classList.remove('text-danger');
    }
  }
}

function toggleWorkspaceSidebar() {
  const sidebar = document.getElementById('workspace-sidebar');
  if (sidebar) {
    sidebar.classList.toggle('sidebar-collapsed');
    state.isSidebarCollapsed = sidebar.classList.contains('sidebar-collapsed');
  }
}

// ----------------------------------------------------
// Chat Messages & Incremental Polling
// ----------------------------------------------------

async function loadMessages(sessionId) {
  if (!sessionId) return;
  state.messages = [];
  state.olderMessagesCursor = null;
  state.hasMoreMessages = false;
  state.isLoadingOlderMessages = false;
  state.loadOlderError = null;
  state.forceScrollBottom = true;

  try {
    const res = await apiRequest(`/api/sessions/${sessionId}/messages?limit=50`);
    if (
      !res ||
      !res.data ||
      !Array.isArray(res.data.messages) ||
      (res.data.olderCursor !== null && typeof res.data.olderCursor !== 'string')
    ) {
      throw new Error('Malformed messages response');
    }
    // Verify session hasn't changed while request was in flight
    if (state.currentSessionId !== sessionId) return;

    state.messages = res.data.messages;
    state.olderMessagesCursor = res.data.olderCursor || null;
    state.hasMoreMessages = Boolean(res.data.hasMore && state.olderMessagesCursor);
    renderMessages();
  } catch (err) {
    if (state.currentSessionId === sessionId) {
      showSafeError('load_messages');
      renderMessages();
    }
  }
}

async function loadOlderMessages(sessionId) {
  if (!sessionId || state.currentSessionId !== sessionId) return;
  const cursor = state.olderMessagesCursor;
  if (state.isLoadingOlderMessages || !state.hasMoreMessages || !cursor) return;

  state.isLoadingOlderMessages = true;
  state.loadOlderError = null;

  const container = document.getElementById('messages-container');
  const prevScrollHeight = container ? container.scrollHeight : 0;
  const prevScrollTop = container ? container.scrollTop : 0;

  renderMessages(true);

  const requestCursor = cursor;
  try {
    const res = await apiRequest(`/api/sessions/${sessionId}/messages?limit=50&before=${encodeURIComponent(requestCursor)}`);
    if (
      !res ||
      !res.data ||
      !Array.isArray(res.data.messages) ||
      (res.data.olderCursor !== null && typeof res.data.olderCursor !== 'string')
    ) {
      throw new Error('Malformed pagination response');
    }

    // Ignore stale response if user switched session
    if (state.currentSessionId !== sessionId) return;

    const olderMessages = res.data.messages;
    state.olderMessagesCursor = res.data.olderCursor || null;
    state.hasMoreMessages = Boolean(res.data.hasMore && state.olderMessagesCursor);
    state.isLoadingOlderMessages = false;
    state.loadOlderError = null;

    if (olderMessages.length > 0) {
      // Prepend older messages avoiding any duplicate public msg ids
      const existingIds = new Set(state.messages.map((m) => m.id));
      const filtered = olderMessages.filter((m) => !existingIds.has(m.id));
      state.messages = [...filtered, ...state.messages];
    }

    renderMessages(true);

    // Scroll anchor: maintain exact visual position by delta
    if (container) {
      const newScrollHeight = container.scrollHeight;
      container.scrollTop = (newScrollHeight - prevScrollHeight) + prevScrollTop;
    }
  } catch (err) {
    if (state.currentSessionId === sessionId) {
      state.isLoadingOlderMessages = false;
      state.loadOlderError = true;
      renderMessages(true);
    }
  }
}

function renderMessages(preserveScroll = false) {
  const container = document.getElementById('messages-container');
  if (!container) return;

  const wasNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 80;
  const prevScrollTop = container.scrollTop;

  container.replaceChildren();

  if (!state.currentSessionId) {
    const emptyChat = document.createElement('div');
    emptyChat.className = 'empty-chat';

    const h3 = document.createElement('h3');
    h3.textContent = tr('chat.emptyTitle', null, 'No active session');

    const p = document.createElement('p');
    p.textContent = tr('chat.emptySubtitle', null, 'Select an existing session from the sidebar or create a new one to start collaborating.');

    emptyChat.appendChild(h3);
    emptyChat.appendChild(p);
    container.appendChild(emptyChat);
    return;
  }

  const hasStreaming = Boolean(
    state.streamingState &&
    state.streamingState.sessionId === state.currentSessionId
  );

  if (state.messages.length === 0 && !hasStreaming && !state.hasMoreMessages && !state.isLoadingOlderMessages) {
    const emptyChat = document.createElement('div');
    emptyChat.className = 'empty-chat';

    const h3 = document.createElement('h3');
    h3.textContent = tr('chat.readyToChatTitle', null, 'Ready to Chat');

    const p = document.createElement('p');
    p.textContent = tr('chat.readyToChatSubtitle', null, 'This session is active. Send your first message below.');

    emptyChat.appendChild(h3);
    emptyChat.appendChild(p);
    container.appendChild(emptyChat);
    return;
  }

  // 1. Pagination Top Control Bar (Load older messages / Loading indicator / Retry button)
  if (state.hasMoreMessages || state.isLoadingOlderMessages || state.loadOlderError) {
    const paginationBar = document.createElement('div');
    paginationBar.className = 'chat-pagination-bar';
    paginationBar.id = 'chat-pagination-bar';

    if (state.isLoadingOlderMessages) {
      const loadingDiv = document.createElement('div');
      loadingDiv.className = 'chat-pagination-loading';
      const spinner = document.createElement('span');
      spinner.className = 'chat-pagination-spinner';
      const loadingText = document.createElement('span');
      loadingText.textContent = tr('chat.loadingOlder', null, 'Loading older messages...');
      loadingDiv.appendChild(spinner);
      loadingDiv.appendChild(loadingText);
      paginationBar.appendChild(loadingDiv);
    } else if (state.loadOlderError) {
      const errDiv = document.createElement('div');
      errDiv.className = 'chat-pagination-error';
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.id = 'btn-retry-load-older';
      retryBtn.className = 'chat-pagination-retry-btn';
      retryBtn.textContent = tr('chat.loadOlderFailed', null, 'Failed to load older messages. Click to retry.');
      retryBtn.addEventListener('click', () => {
        loadOlderMessages(state.currentSessionId);
      });
      errDiv.appendChild(retryBtn);
      paginationBar.appendChild(errDiv);
    } else if (state.hasMoreMessages) {
      const loadBtn = document.createElement('button');
      loadBtn.type = 'button';
      loadBtn.id = 'btn-load-older-messages';
      loadBtn.className = 'btn-load-older';
      loadBtn.setAttribute('aria-label', tr('chat.loadOlderAria', null, 'Load older messages in this session'));
      loadBtn.textContent = `↑ ${tr('chat.loadOlder', null, 'Load older messages')}`;
      loadBtn.addEventListener('click', () => {
        loadOlderMessages(state.currentSessionId);
      });
      paginationBar.appendChild(loadBtn);
    }

    container.appendChild(paginationBar);
  }

  // 2. Render Chat Messages
  state.messages.forEach((msg) => {
    const card = document.createElement('div');
    if (msg.id) {
      card.id = `msg-card-${msg.id}`;
    }
    const roleClass = msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'assistant' : 'system';
    card.className = `message-card ${roleClass} ${msg.status === 'failed' ? 'error' : ''}`;

    const meta = document.createElement('div');
    meta.className = 'message-meta';

    const senderSpan = document.createElement('span');
    senderSpan.className = 'sender';
    senderSpan.textContent = formatRole(msg.role);

    const bulletSpan = document.createElement('span');
    bulletSpan.textContent = '•';

    const timeSpan = document.createElement('span');
    let timeText = tr('chat.timestampUnavailable', null, 'Timestamp unavailable');
    if (typeof msg.createdAt === 'string' || typeof msg.createdAt === 'number') {
      const d = new Date(msg.createdAt);
      if (!isNaN(d.getTime())) {
        timeText = formatTime(d);
      }
    }
    timeSpan.textContent = timeText;

    meta.appendChild(senderSpan);
    meta.appendChild(bulletSpan);
    meta.appendChild(timeSpan);

    if (msg.role === 'user' && msg.status) {
      const statusBadge = document.createElement('span');
      const st = msg.status;
      const variant = st === 'delivered' ? 'badge-success' : (st === 'pending' ? 'badge-warning' : 'badge-danger');
      statusBadge.className = `badge ${variant} badge-xs message-status`;
      const label = (st === 'failed' && msg.failureCode) ? formatStatus(msg.failureCode) : formatStatus(st);
      statusBadge.textContent = label;
      meta.appendChild(statusBadge);
    }

    card.appendChild(meta);

    // Render reply quote card if msg has replyReference
    if (msg.replyReference && msg.replyReference.messageId) {
      const quoteCard = document.createElement('div');
      quoteCard.className = 'message-reply-quote';
      quoteCard.setAttribute('role', 'button');
      quoteCard.setAttribute('tabindex', '0');
      quoteCard.setAttribute('aria-label', `${tr('chat.quotedMessage', null, 'Quoted message')}: ${msg.replyReference.snippet}`);

      const qHeader = document.createElement('div');
      qHeader.className = 'message-reply-quote-header';
      const refRoleName = formatRole(msg.replyReference.role || 'user');
      qHeader.textContent = `↩ ${refRoleName}`;

      const qSnippet = document.createElement('div');
      qSnippet.className = 'message-reply-quote-snippet';
      qSnippet.textContent = msg.replyReference.snippet || '';

      quoteCard.appendChild(qHeader);
      quoteCard.appendChild(qSnippet);

      const jumpToRef = (ev) => {
        ev.stopPropagation();
        const targetEl = document.getElementById(`msg-card-${msg.replyReference.messageId}`);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          targetEl.classList.remove('highlight-flash');
          void targetEl.offsetWidth; // force reflow
          targetEl.classList.add('highlight-flash');
        } else {
          showToast(tr('chat.messageNotFound', null, 'Referenced message not found in current view.'), 'info');
        }
      };

      quoteCard.addEventListener('click', jumpToRef);
      quoteCard.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          jumpToRef(ev);
        }
      });

      card.appendChild(quoteCard);
    }

    const content = document.createElement('div');
    content.className = 'message-content';

    // Safe message content injection using textContent directly
    if (typeof msg.content === 'string') {
      renderMarkdownToElement(content, msg.content);
    } else {
      content.textContent = msg.content;
    }

    card.appendChild(content);

    // Render safe message attachments cards if present
    if (msg.attachments && Array.isArray(msg.attachments) && msg.attachments.length > 0) {
      renderMessageAttachments(card, msg.attachments);
    }

    if (msg.id && (msg.role === 'user' || msg.role === 'assistant')) {
      const actionsBar = document.createElement('div');
      actionsBar.className = 'message-actions-bar';

      // 1. Assistant: Regenerate | User: Edit & Retry
      if (msg.role === 'assistant') {
        const regenBtn = document.createElement('button');
        regenBtn.type = 'button';
        regenBtn.className = 'message-action-btn btn-action-regenerate';
        regenBtn.title = tr('chat.regenerateTitle', null, 'Regenerate assistant response (creates branch)');
        regenBtn.setAttribute('data-i18n-title', 'chat.regenerateTitle');
        regenBtn.setAttribute('aria-label', tr('chat.regenerateTitle', null, 'Regenerate assistant response'));
        regenBtn.textContent = `🔄 ${tr('chat.regenerate', null, 'Regenerate')}`;
        regenBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          handleRegenerateMessage(msg.id);
        });
        actionsBar.appendChild(regenBtn);
      } else if (msg.role === 'user') {
        if (msg.status === 'failed') {
          if (msg.failureCode === 'QUOTA_EXCEEDED') {
            const quotaBtn = document.createElement('button');
            quotaBtn.type = 'button';
            quotaBtn.className = 'message-action-btn btn-action-view-quota';
            quotaBtn.title = tr('chat.viewQuotaTitle', null, 'View resource quota and limits');
            quotaBtn.setAttribute('data-i18n-title', 'chat.viewQuotaTitle');
            quotaBtn.setAttribute('aria-label', tr('chat.viewQuotaTitle', null, 'View resource quota and limits'));
            quotaBtn.textContent = `⏱️ ${tr('chat.viewQuota', null, 'View Quota')}`;
            quotaBtn.addEventListener('click', (ev) => {
              ev.stopPropagation();
              window.location.hash = '#quotas';
            });
            actionsBar.appendChild(quotaBtn);
          } else {
            const retryBtn = document.createElement('button');
            retryBtn.type = 'button';
            retryBtn.className = 'message-action-btn btn-action-retry';
            retryBtn.title = tr('chat.retryMessageTitle', null, 'Retry sending this user message');
            retryBtn.setAttribute('data-i18n-title', 'chat.retryMessageTitle');
            retryBtn.setAttribute('aria-label', tr('chat.retryMessageTitle', null, 'Retry sending this user message'));
            retryBtn.textContent = `↻ ${tr('chat.retryMessage', null, 'Retry')}`;
            retryBtn.addEventListener('click', (ev) => {
              ev.stopPropagation();
              const input = document.getElementById('chat-input');
              if (input) {
                input.value = msg.content || '';
                updateComposerControlsState();
                input.focus();
              }
            });
            actionsBar.appendChild(retryBtn);
          }

          const resetGenBtn = document.createElement('button');
          resetGenBtn.type = 'button';
          resetGenBtn.className = 'message-action-btn btn-action-reset-gen';
          resetGenBtn.title = tr('chat.resetGenerationTitle', null, 'Reset session generation to recover clean agent state');
          resetGenBtn.setAttribute('data-i18n-title', 'chat.resetGenerationTitle');
          resetGenBtn.setAttribute('aria-label', tr('chat.resetGenerationTitle', null, 'Reset session generation'));
          resetGenBtn.textContent = tr('chat.resetGeneration', null, '🔄 Reset Gen');
          resetGenBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            openResetSessionModal();
          });
          actionsBar.appendChild(resetGenBtn);
        }

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'message-action-btn btn-action-edit';
        editBtn.title = tr('chat.editTitle', null, 'Edit user message (creates branch)');
        editBtn.setAttribute('data-i18n-title', 'chat.editTitle');
        editBtn.setAttribute('aria-label', tr('chat.editTitle', null, 'Edit user message'));
        editBtn.textContent = `✏️ ${tr('chat.edit', null, 'Edit')}`;
        editBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          openEditMessageModal(msg.id);
        });
        actionsBar.appendChild(editBtn);
      }

      // 2. Reply (for both user and assistant)
      const replyBtn = document.createElement('button');
      replyBtn.type = 'button';
      replyBtn.className = 'message-action-btn btn-action-reply';
      replyBtn.title = tr('chat.replyTitle', null, 'Quote and reply to this message');
      replyBtn.setAttribute('data-i18n-title', 'chat.replyTitle');
      replyBtn.setAttribute('aria-label', tr('chat.replyTitle', null, 'Quote and reply'));
      replyBtn.textContent = `↩️ ${tr('chat.reply', null, 'Reply')}`;
      replyBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        setReplyMessage(msg.id, msg.role, msg.content);
      });
      actionsBar.appendChild(replyBtn);

      // 3. Fork from here (for both user and assistant)
      const forkBtn = document.createElement('button');
      forkBtn.type = 'button';
      forkBtn.className = 'message-action-btn btn-action-fork';
      forkBtn.title = tr('chat.forkFromHereTitle', null, 'Fork new session starting from this message');
      forkBtn.setAttribute('data-i18n-title', 'chat.forkFromHereTitle');
      forkBtn.setAttribute('aria-label', tr('chat.forkFromHereTitle', null, 'Fork from here'));
      forkBtn.textContent = `🍴 ${tr('chat.forkFromHere', null, 'Fork from here')}`;
      forkBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openForkSessionModal(msg.id, msg.turnId || undefined);
      });
      actionsBar.appendChild(forkBtn);

      card.appendChild(actionsBar);
    }

    container.appendChild(card);
  });

  // Render active streaming bubble if present
  if (hasStreaming) {
    const stream = state.streamingState;
    const card = document.createElement('div');
    card.className = `message-card assistant ${stream.cancelled ? 'error' : 'streaming'}`;

    const meta = document.createElement('div');
    meta.className = 'message-meta';

    const senderSpan = document.createElement('span');
    senderSpan.className = 'sender';
    senderSpan.textContent = formatRole('assistant');

    const bulletSpan = document.createElement('span');
    bulletSpan.textContent = '•';

    const timeSpan = document.createElement('span');
    let timeText = tr('chat.streamingStatus', null, 'Streaming...');
    if (stream.createdAt) {
      const d = new Date(stream.createdAt);
      if (!isNaN(d.getTime())) {
        timeText = formatTime(d);
      }
    }
    timeSpan.textContent = timeText;

    meta.appendChild(senderSpan);
    meta.appendChild(bulletSpan);
    meta.appendChild(timeSpan);

    if (stream.cancelled) {
      const cancelledBadge = document.createElement('span');
      cancelledBadge.className = 'badge badge-danger badge-xs message-status';
      cancelledBadge.textContent = tr('status.cancelled', null, 'Cancelled');
      meta.appendChild(cancelledBadge);
    } else if (stream.toolStatus) {
      const toolBadge = document.createElement('span');
      const variant = stream.toolStatus.status === 'completed' ? 'badge-success' : (stream.toolStatus.status === 'failed' ? 'badge-danger' : 'badge-warning');
      toolBadge.className = `badge ${variant} badge-xs message-status`;
      const displayName = formatToolName(stream.toolStatus.toolName);
      toolBadge.textContent = stream.toolStatus.status === 'started'
        ? tr('chat.toolStarted', { toolName: displayName }, `tool: ${displayName}`)
        : tr('chat.toolStatus', { status: formatStatus(stream.toolStatus.status), toolName: displayName }, `tool ${stream.toolStatus.status}: ${displayName}`);
      meta.appendChild(toolBadge);
    } else if (stream.isThinking && (!stream.text || stream.text.length === 0)) {
      const thinkingBadge = document.createElement('span');
      thinkingBadge.className = 'badge badge-info badge-xs message-status';
      thinkingBadge.textContent = tr('chat.thinkingBadge', null, 'thinking');
      meta.appendChild(thinkingBadge);
    } else {
      const streamingBadge = document.createElement('span');
      streamingBadge.className = 'badge badge-warning badge-xs message-status';
      streamingBadge.textContent = tr('chat.streamingBadge', null, 'streaming');
      meta.appendChild(streamingBadge);
    }

    const content = document.createElement('div');
    content.className = 'message-content';

    if (stream.text && stream.text.length > 0) {
      renderMarkdownToElement(content, stream.text);
    } else if (stream.isThinking && !stream.toolStatus && !stream.cancelled) {
      const thinkingText = document.createElement('p');
      thinkingText.textContent = tr('chat.thinkingText', null, 'Thinking...');
      content.appendChild(thinkingText);
    }

    if (!stream.streamEnded && !stream.cancelled) {
      const typingIndicator = document.createElement('div');
      typingIndicator.className = 'typing-indicator';
      typingIndicator.appendChild(document.createElement('span'));
      typingIndicator.appendChild(document.createElement('span'));
      typingIndicator.appendChild(document.createElement('span'));
      content.appendChild(typingIndicator);
    }

    card.appendChild(meta);
    card.appendChild(content);
    container.appendChild(card);
  }

  // Sticky auto-scroll vs preserved scroll
  if (!preserveScroll) {
    if (wasNearBottom || state.forceScrollBottom) {
      container.scrollTop = container.scrollHeight;
      state.forceScrollBottom = false;
    }
  }
}

// ----------------------------------------------------
// Active Turn Control & Cancellation
// ----------------------------------------------------

function updateStopTurnControl() {
  const btn = document.getElementById('btn-stop-turn');
  if (!btn) return;

  const isCancellable = Boolean(
    state.currentSessionId &&
    state.hasCancellableTurn &&
    (state.activeTurnStatus === 'queued' || state.activeTurnStatus === 'running')
  );

  if (isCancellable) {
    btn.classList.remove('hidden');
    if (state.isCancellingTurn) {
      btn.disabled = true;
      btn.textContent = 'Stopping...';
      if (getLocale() === 'zh-CN') btn.textContent = tr('chat.stoppingTurn', null, '正在停止...');
      btn.title = tr('chat.cancellingTurnTitle', null, 'Cancelling turn in progress...');
    } else {
      btn.disabled = false;
      btn.textContent = '⏹ Stop Turn';
      if (getLocale() === 'zh-CN') btn.textContent = tr('chat.stopTurn', null, '⏹ 停止轮次');
      btn.title = tr('chat.stopTurnTitle', null, 'Stop current active turn');
    }
  } else {
    btn.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = '⏹ Stop Turn';
    if (getLocale() === 'zh-CN') btn.textContent = tr('chat.stopTurn', null, '⏹ 停止轮次');
    btn.title = tr('chat.stopTurnTitle', null, 'Stop current active turn');
  }
}

async function syncActiveTurnStatus(sessionId) {
  if (!sessionId || state.currentSessionId !== sessionId) return;
  if (state.isTurnSyncInFlight) return;
  state.isTurnSyncInFlight = true;

  try {
    const res = await apiRequest(`/api/sessions/${sessionId}/turn/current`);
    if (state.currentSessionId !== sessionId) return;

    if (res && res.data && typeof res.data.status === 'string') {
      const status = res.data.status;
      if (status === 'queued' || status === 'running') {
        state.hasCancellableTurn = true;
        state.activeTurnStatus = status;
      } else if (status === 'waiting_approval') {
        state.hasCancellableTurn = true;
        state.activeTurnStatus = 'waiting_approval';
        updateApprovalBadges([{ id: 'turn_approval', status: 'pending' }]);
      } else if (status === 'recovery_required') {
        state.hasCancellableTurn = false;
        state.activeTurnStatus = 'recovery_required';
        showToast(tr('chat.recoveryRequired', null, '⚠️ Session corrupted or failed. Please reset generation or retry.'), 'error');
      } else {
        state.hasCancellableTurn = false;
        state.activeTurnStatus = status;
      }
    } else {
      state.hasCancellableTurn = false;
      state.activeTurnStatus = null;
    }
    updateStopTurnControl();
    updateTurnStatusBadge();
  } catch {
    if (state.currentSessionId === sessionId) {
      state.hasCancellableTurn = false;
      state.activeTurnStatus = null;
      updateStopTurnControl();
      updateTurnStatusBadge();
    }
  } finally {
    state.isTurnSyncInFlight = false;
  }
}

async function handleStopCurrentTurn() {
  const sessionId = state.currentSessionId;

  if (!sessionId || !state.hasCancellableTurn || state.isCancellingTurn) {
    return;
  }

  if (state.activeTurnStatus !== 'queued' && state.activeTurnStatus !== 'running') {
    state.hasCancellableTurn = false;
    state.activeTurnStatus = null;
    updateStopTurnControl();
    showToast(tr('toast.turnNotCancellable', null, 'Turn is no longer in a cancellable state.'), 'info');
    return;
  }

  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    showToast(tr('toast.cryptoUnavailable', null, 'Cryptographic context unavailable. Cannot generate Idempotency-Key.'), 'error');
    return;
  }

  state.isCancellingTurn = true;
  updateStopTurnControl();

  try {
    const idempotencyKey = crypto.randomUUID();
    const res = await apiRequest(`/api/sessions/${sessionId}/turn/cancel-current`, {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey,
      },
    });

    const isCancelled = Boolean(res && res.data && res.data.cancelled === true);

    if (isCancelled) {
      showToast(tr('toast.turnStoppedSuccess', null, 'Turn stopped successfully.'), 'success');
      state.hasCancellableTurn = false;
      state.activeTurnStatus = null;
      updateTurnStatusBadge();
      if (state.streamingState) {
        state.streamingState.cancelled = true;
        state.streamingState.streamEnded = true;
        renderMessages();
      }
    } else {
      showToast(tr('toast.turnAlreadyCompleted', null, 'Turn had already completed or settled.'), 'info');
      state.hasCancellableTurn = false;
      state.activeTurnStatus = null;
      updateTurnStatusBadge();
    }
  } catch (err) {
    if (err && err.status === 404) {
      showToast(tr('toast.turnNotFound', null, 'Turn not found or session closed.'), 'error');
      state.hasCancellableTurn = false;
      state.activeTurnStatus = null;
      updateTurnStatusBadge();
    } else if (err && err.status === 409) {
      showToast(tr('toast.turnStateConflict', null, 'Turn state conflict (already finished).'), 'warning');
      state.hasCancellableTurn = false;
      state.activeTurnStatus = null;
      updateTurnStatusBadge();
    } else {
      showSafeError('stop_turn');
    }
  } finally {
    state.isCancellingTurn = false;
    updateStopTurnControl();

    if (state.currentSessionId === sessionId) {
      loadMessages(sessionId);
      syncActiveTurnStatus(sessionId);
    }
  }
}

async function handleSendMessage() {
  const input = document.getElementById('chat-input');
  const text = input ? input.value.trim() : '';
  if (!state.currentSessionId || state.isSendingMessage) return;

  if (!text) {
    if (state.activeAttachments.length > 0) {
      showToast(t('chat.emptyContentWithAttachments', null, 'Please enter a message or instruction alongside attachments.'), 'warning');
    }
    return;
  }

  // Check if any attachment is currently uploading or pending
  if (state.activeAttachments.some((a) => a.status === 'uploading' || a.status === 'pending')) {
    showToast(t('chat.uploading', null, 'Uploading...'), 'warning');
    return;
  }

  const btn = document.getElementById('btn-send-message');

  // Enforce secure cryptographic context: crypto.randomUUID() without non-secure fallback
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    showToast(tr('toast.cryptoSendUnavailable', null, 'Secure cryptographic context (crypto.randomUUID) is unavailable. Message sending disabled.'), 'error');
    return;
  }

  state.isSendingMessage = true;
  updateComposerControlsState();

  const idempotencyKey = crypto.randomUUID();

  // Filter ready attachments with path and etag
  const readyAttachments = state.activeAttachments
    .filter((a) => a.status === 'ready' && a.path && a.etag)
    .map((a) => ({
      path: a.path,
      etag: a.etag,
      displayName: a.displayName || a.path.split('/').pop(),
    }));

  const savedAttachments = [...state.activeAttachments];
  const savedReply = state.activeReply ? { ...state.activeReply } : null;
  const replyToMessageId = state.activeReply ? state.activeReply.messageId : undefined;

  // Clear input, tray & reply banner for immediate user feedback; restore on failure
  input.value = '';
  input.rows = 2;
  state.activeAttachments = [];
  state.activeReply = null;
  renderComposerReplyBanner();
  renderAttachmentTray();
  updateCharCount();
  state.forceScrollBottom = true;

  try {
    const payload = {
      content: text,
      ...(readyAttachments.length > 0 ? { attachments: readyAttachments } : {}),
      ...(replyToMessageId ? { replyToMessageId } : {}),
    };

    const res = await apiRequest(`/api/sessions/${state.currentSessionId}/messages`, {
      method: 'POST',
      retryNetwork: true, // Only this idempotent message submission allows single network retry
      headers: {
        'Idempotency-Key': idempotencyKey,
      },
      body: payload,
    });

    const inboundMsg = res && res.data ? res.data.message : null;
    if (
      !res ||
      !res.data ||
      res.data.accepted !== true ||
      !inboundMsg ||
      typeof inboundMsg !== 'object'
    ) {
      throw new Error('Invalid message response');
    }

    state.messages.push(inboundMsg);
    state.streamingState = null;
    if (state.drafts[state.currentSessionId]) {
      delete state.drafts[state.currentSessionId];
    }
    renderMessages();

    state.hasCancellableTurn = true;
    state.activeTurnStatus = 'queued';
    updateStopTurnControl();

    // Reset polling failure counter and ensure polling is running
    state.consecutivePollingFailures = 0;
    if (!state.isPollingActive && state.currentRoute === 'workspace') {
      startPolling(state.currentSessionId);
    }

    if (state.currentSessionId) {
      syncActiveTurnStatus(state.currentSessionId);
    }

    // Refresh immediately to pick up any synchronous or fast asynchronous runtime responses
    setTimeout(() => {
      if (state.currentSessionId) {
        pollEvents(state.currentSessionId);
        syncActiveTurnStatus(state.currentSessionId);
      }
    }, 300);
  } catch (err) {
    // Restore chat draft, attachments and reply context on send failure
    input.value = text;
    state.activeAttachments = savedAttachments;
    state.activeReply = savedReply;
    renderComposerReplyBanner();
    renderAttachmentTray();
    updateCharCount();

    if (err && err.status === 409) {
      if (err.code === 'TURN_ACTIVE') {
        showToast(tr('toast.turnAlreadyRunning', null, 'Another turn is already in progress. Please wait for it to finish.'), 'warning');
      } else if (err.code === 'SESSION_ARCHIVED' || err.code === 'SPACE_ARCHIVED') {
        showToast(tr('toast.sessionArchivedCannotSend', null, 'This session or space is archived and cannot accept new messages.'), 'error');
      } else if (err.code === 'IDEMPOTENCY_CONFLICT') {
        showToast(tr('toast.idempotencyConflict', null, 'Message submission conflict. Please retry.'), 'warning');
      } else {
        showToast(tr('toast.turnStateConflict', null, 'Turn state conflict (already finished).'), 'warning');
      }
    } else if (err && err.status === 429) {
      showToast(tr('error.rateLimited', null, 'Too many requests. Please slow down and try again.'), 'warning');
    } else if (err && (err.status === 503 || err.status === 502)) {
      showToast(tr('toast.serviceUnavailable', null, 'Agent service is temporarily unavailable. Please try again shortly.'), 'error');
    } else {
      showSafeError('send_message');
    }
  } finally {
    state.isSendingMessage = false;
    updateComposerControlsState();
    input.focus();
  }
}

// Incremental Polling Lifecycle
function startPolling(sessionId) {
  stopPolling();
  state.consecutivePollingFailures = 0;
  state.isPollingActive = true;

  const pollLoop = async () => {
    if (state.currentSessionId !== sessionId || state.currentRoute !== 'workspace' || !state.isPollingActive) {
      return;
    }
    await pollEvents(sessionId);
    if (state.currentSessionId === sessionId && state.currentRoute === 'workspace' && state.isPollingActive) {
      // Fast polling (500ms) during active stream / turn; standard (2000ms) when idle
      const interval = (state.hasCancellableTurn || (state.streamingState && !state.streamingState.streamEnded)) ? 500 : 2000;
      state.pollingTimer = setTimeout(pollLoop, interval);
    }
  };

  state.pollingTimer = setTimeout(pollLoop, 300);
}

function stopPolling() {
  if (state.pollingTimer) {
    clearTimeout(state.pollingTimer);
    clearInterval(state.pollingTimer);
    state.pollingTimer = null;
  }
  state.isPollingActive = false;
  state.consecutivePollingFailures = 0;
}

function handleTurnFailureEvent(ev, explicitFailureCode, isDuplicate, sessionId) {
  let rawPayload = ev && ev.payload;
  if (typeof rawPayload === 'string') {
    try { rawPayload = JSON.parse(rawPayload); } catch { rawPayload = null; }
  }
  const failureCode = explicitFailureCode || extractPublicFailureCode(ev);
  const resource = (rawPayload && typeof rawPayload === 'object' && (rawPayload.resource || rawPayload.metric)) || (ev && ev.resource) || '';
  const isTokenResource = String(resource).toLowerCase() === 'tokens';

  if (failureCode === 'QUOTA_EXCEEDED') {
    // 1. Clear streaming immediately
    state.streamingState = null;

    // 2. Mark last user message failed with failureCode metadata & preserve draft
    let lastUserMsg = null;
    for (let i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === 'user') {
        state.messages[i].status = 'failed';
        state.messages[i].failureCode = 'QUOTA_EXCEEDED';
        lastUserMsg = state.messages[i];
        break;
      }
    }

    // Preserve content in draft
    if (lastUserMsg && lastUserMsg.content) {
      const chatInput = document.getElementById('chat-input');
      if (chatInput && !chatInput.value) {
        chatInput.value = lastUserMsg.content;
      }
      state.drafts[sessionId] = {
        content: lastUserMsg.content,
        attachments: [...state.activeAttachments],
      };
    }

    state.hasCancellableTurn = false;
    state.activeTurnStatus = 'quota_exceeded';
    updateStopTurnControl();
    updateComposerControlsState();
    updateTurnStatusBadge();

    // 3. Localized visible status/toast with action button (avoid duplicate toast on polling)
    if (!isDuplicate) {
      const toastMsgKey = isTokenResource ? 'toast.quotaExceededTokens' : 'toast.quotaExceededGeneral';
      const toastFallback = isTokenResource
        ? 'Token quota exhausted. Open Account / Quota or contact admin.'
        : 'Resource quota exhausted. Open Account / Quota or contact admin.';
      showToast(
        tr(toastMsgKey, null, toastFallback),
        'error',
        null,
        {
          label: tr('toast.openQuota', null, 'Open Quota'),
          handler: () => {
            window.location.hash = '#quotas';
          },
        }
      );
    }
  } else {
    // Other failure codes (RECOVERY_REQUIRED, EXECUTION_FAILED, RETRY_REQUIRED, TURN_TIMEOUT, LEASE_LOST)
    if (state.streamingState) {
      state.streamingState.streamEnded = true;
    }
    let lastUserMsg = null;
    for (let i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === 'user') {
        state.messages[i].status = 'failed';
        state.messages[i].failureCode = failureCode;
        lastUserMsg = state.messages[i];
        break;
      }
    }

    if (lastUserMsg && lastUserMsg.content) {
      state.drafts[sessionId] = {
        content: lastUserMsg.content,
        attachments: [...state.activeAttachments],
      };
    }

    state.hasCancellableTurn = false;
    state.activeTurnStatus = failureCode.toLowerCase();
    updateStopTurnControl();
    updateComposerControlsState();
    updateTurnStatusBadge();

    if (!isDuplicate) {
      if (failureCode === 'RECOVERY_REQUIRED') {
        showToast(
          tr('toast.recoveryRequiredTurn', null, 'Session corrupted or recovery required. Please reset generation or retry.'),
          'error'
        );
      } else if (failureCode === 'RETRY_REQUIRED') {
        showToast(
          tr('toast.retryRequiredTurn', null, 'Turn encountered a temporary issue. Please retry.'),
          'warning'
        );
      } else if (failureCode === 'TURN_TIMEOUT') {
        showToast(
          tr('toast.turnTimeout', null, 'Turn execution timed out. Please retry.'),
          'warning'
        );
      } else if (failureCode === 'LEASE_LOST') {
        showToast(
          tr('toast.leaseLost', null, 'Execution lease lost to another worker. Please retry.'),
          'warning'
        );
      } else {
        showToast(
          tr('toast.executionFailedTurn', null, 'Turn execution failed. Please retry or reset generation.'),
          'error'
        );
      }
    }
  }
}

async function pollEvents(sessionId) {
  if (!sessionId || state.currentSessionId !== sessionId || state.isPollingInFlight) return;
  state.isPollingInFlight = true;

  try {
    const cursorQuery = state.eventCursor ? `?cursor=${encodeURIComponent(state.eventCursor)}` : '';
    const res = await apiRequest(`/api/sessions/${sessionId}/events${cursorQuery}`);

    if (state.currentSessionId !== sessionId) return;

    // Reset failure counter on successful request
    state.consecutivePollingFailures = 0;

    // Always update eventCursor from res.data.nextCursor when provided (even if no events were returned)
    if (res && res.data && res.data.nextCursor) {
      state.eventCursor = res.data.nextCursor;
    }

    if (res && res.data && Array.isArray(res.data.events) && res.data.events.length > 0) {
      let hasChanges = false;
      for (const ev of res.data.events) {
        if (!ev || typeof ev !== 'object') continue;

        let rawPayload = ev.payload;
        if (typeof rawPayload === 'string') {
          try {
            rawPayload = JSON.parse(rawPayload);
          } catch {
            rawPayload = null;
          }
        }
        const eventId = ev.id || (rawPayload && typeof rawPayload === 'object' && rawPayload.id) || null;
        const isDuplicate = Boolean(eventId && state.processedEventIds && state.processedEventIds.has(eventId));
        if (eventId && state.processedEventIds) {
          state.processedEventIds.add(eventId);
        }

        switch (ev.type) {
          case 'message': {
            const msg = (ev.payload && ev.payload.message)
              ? ev.payload.message
              : ev.message
                ? ev.message
                : null;

            if (msg && msg.id) {
              const existingIdx = state.messages.findIndex((m) => m.id === msg.id);
              if (existingIdx === -1) {
                state.messages.push(msg);
              } else {
                state.messages[existingIdx] = msg;
              }
              if (msg.role === 'assistant') {
                state.streamingState = null;
              }
              hasChanges = true;
            }
            break;
          }

          case 'assistant_delta': {
            const streamId = ev.streamId || (ev.payload && ev.payload.streamId);
            const delta = ev.delta || (ev.payload && ev.payload.delta) || '';
            const rawLength = typeof ev.accumulatedLength === 'number'
              ? ev.accumulatedLength
              : (ev.payload && typeof ev.payload.accumulatedLength === 'number')
                ? ev.payload.accumulatedLength
                : undefined;

            if (streamId) {
              if (state.streamingState && state.streamingState.streamId === streamId) {
                const currentLen = state.streamingState.accumulatedLength || state.streamingState.text.length;
                const newLen = rawLength !== undefined ? rawLength : (currentLen + delta.length);
                if (newLen > currentLen) {
                  state.streamingState.text += delta;
                  state.streamingState.accumulatedLength = newLen;
                  state.streamingState.isThinking = false;
                  hasChanges = true;
                }
              } else {
                state.streamingState = {
                  sessionId,
                  streamId,
                  text: delta,
                  accumulatedLength: rawLength !== undefined ? rawLength : delta.length,
                  createdAt: ev.timestamp || new Date().toISOString(),
                  isThinking: false,
                  streamEnded: false,
                  cancelled: false,
                };
                hasChanges = true;
              }
            }
            break;
          }

          case 'assistant_stream_end': {
            const streamId = ev.streamId || (ev.payload && ev.payload.streamId);
            if (state.streamingState && (!streamId || state.streamingState.streamId === streamId)) {
              state.streamingState.streamEnded = true;
              hasChanges = true;
            }
            break;
          }

          case 'thinking': {
            if (!state.streamingState) {
              state.streamingState = {
                sessionId,
                streamId: ev.streamId || `msgstream_${Date.now()}`,
                text: '',
                accumulatedLength: 0,
                createdAt: ev.timestamp || new Date().toISOString(),
                isThinking: true,
                streamEnded: false,
                cancelled: false,
              };
            } else {
              state.streamingState.isThinking = true;
            }
            hasChanges = true;
            break;
          }

          case 'tool_status': {
            const toolName = ev.toolName || (ev.payload && ev.payload.toolName) || 'tool';
            const status = ev.status || (ev.payload && ev.payload.status) || 'started';
            if (!state.streamingState) {
              state.streamingState = {
                sessionId,
                streamId: `msgstream_${Date.now()}`,
                text: '',
                accumulatedLength: 0,
                createdAt: ev.timestamp || new Date().toISOString(),
                isThinking: false,
                toolStatus: { toolName, status },
                streamEnded: false,
                cancelled: false,
              };
            } else {
              state.streamingState.toolStatus = { toolName, status };
            }
            hasChanges = true;
            break;
          }

          case 'turn_status': {
            const status = ev.status || (rawPayload && typeof rawPayload === 'object' && rawPayload.status);
            const code = ev.code || (rawPayload && typeof rawPayload === 'object' && rawPayload.code);
            if (status === 'interrupted' || code === 'TURN_CANCELLED') {
              if (state.streamingState) {
                state.streamingState.cancelled = true;
                state.streamingState.streamEnded = true;
                hasChanges = true;
              }
              state.hasCancellableTurn = false;
              state.activeTurnStatus = 'interrupted';
              updateStopTurnControl();
              updateTurnStatusBadge();
            } else if (status === 'completed') {
              state.streamingState = null;
              state.hasCancellableTurn = false;
              state.activeTurnStatus = 'completed';
              updateStopTurnControl();
              updateTurnStatusBadge();
              hasChanges = true;
            } else if (status === 'failed' || status === 'recovery_required') {
              const explicitCode = status === 'recovery_required' ? 'RECOVERY_REQUIRED' : null;
              handleTurnFailureEvent(ev, explicitCode, isDuplicate, sessionId);
              hasChanges = true;
            } else if (status === 'running' || status === 'queued' || status === 'waiting_approval') {
              state.hasCancellableTurn = true;
              state.activeTurnStatus = status;
              updateStopTurnControl();
              updateComposerControlsState();
              updateTurnStatusBadge();
            }
            break;
          }

          case 'turn_failed': {
            handleTurnFailureEvent(ev, null, isDuplicate, sessionId);
            hasChanges = true;
            break;
          }

          case 'turn_cancelled': {
            if (state.streamingState) {
              state.streamingState.cancelled = true;
              state.streamingState.streamEnded = true;
              hasChanges = true;
            }
            state.hasCancellableTurn = false;
            state.activeTurnStatus = 'interrupted';
            updateStopTurnControl();
            updateTurnStatusBadge();
            break;
          }

          case 'status_update': {
            const status = ev.status || (rawPayload && typeof rawPayload === 'object' && rawPayload.status);
            if (status === 'completed' || status === 'failed' || status === 'interrupted') {
              if (state.streamingState) {
                state.streamingState.streamEnded = true;
                if (status === 'interrupted') state.streamingState.cancelled = true;
                hasChanges = true;
              }
              state.hasCancellableTurn = false;
              state.activeTurnStatus = status;
              updateStopTurnControl();
              updateTurnStatusBadge();
            } else if (status === 'running' || status === 'queued') {
              state.hasCancellableTurn = true;
              state.activeTurnStatus = status;
              updateStopTurnControl();
              updateTurnStatusBadge();
            }
            break;
          }

          case 'error': {
            if (state.streamingState) {
              state.streamingState.streamEnded = true;
              hasChanges = true;
            }
            state.hasCancellableTurn = false;
            state.activeTurnStatus = 'execution_failed';
            updateStopTurnControl();
            updateTurnStatusBadge();
            break;
          }
        }
      }

      if (hasChanges) {
        renderMessages();
      }
      syncActiveTurnStatus(sessionId);
    } else if (state.hasCancellableTurn) {
      syncActiveTurnStatus(sessionId);
    }

    // Synchronize pending approvals for session/turn
    await fetchPendingApprovals(sessionId);
  } catch (err) {
    state.consecutivePollingFailures += 1;

    if (err && err.status === 400) {
      // 400 Bad Request: Stale / invalid cursor -> clear cursor and retry fresh
      state.eventCursor = null;
      return;
    }

    if (err && err.status === 401) {
      stopPolling();
      showToast(tr('toast.sessionExpired', null, 'Session expired or unauthorized. Please sign in again.'), 'error');
      showAuthView();
      return;
    }

    if (err && err.status === 403) {
      fetchCsrfToken();
      if (state.consecutivePollingFailures >= 3) {
        stopPolling();
        showToast(tr('toast.pollingForbidden', null, 'Access forbidden (403). Polling stopped.'), 'error');
      }
      return;
    }

    if (err && err.status === 404) {
      stopPolling();
      showToast(tr('toast.pollingNotFound', null, 'Session not found. Polling stopped.'), 'error');
      deselectSession();
      return;
    }

    if (err && err.status >= 500) {
      if (state.consecutivePollingFailures === 1 || state.consecutivePollingFailures % 5 === 0) {
        showSafeError('poll_events');
      }
      if (state.consecutivePollingFailures >= 3) {
        stopPolling();
        showToast(tr('toast.pollingServerError', null, 'Repeated server errors encountered. Polling stopped.'), 'error');
      }
      return;
    }

    // Network glitches / offline handling: visible offline notification on first occurrence; stop after bounded threshold (3)
    if (state.consecutivePollingFailures === 1) {
      showToast(tr('toast.pollingNetworkIssue', null, 'Network issue encountered while polling events. Retrying...'), 'info');
    } else if (state.consecutivePollingFailures >= 3) {
      stopPolling();
      showToast(tr('toast.pollingConnectionLost', null, 'Connection lost. Polling stopped after repeated failures.'), 'error');
    }
  } finally {
    state.isPollingInFlight = false;
  }
}

function handleWorkspaceLocaleChange() {
  if (state.currentRoute === 'workspace' || !state.currentRoute || state.currentRoute.startsWith('workspace')) {
    renderSpaceSelect();
    renderSessionList();
    if (state.currentSessionId) {
      const activeSession = state.sessions.find((s) => s.id === state.currentSessionId);
      const titleEl = document.getElementById('current-session-title');
      if (titleEl) {
        titleEl.textContent = activeSession && activeSession.title
          ? tr('chat.sessionTitleHeader', { title: activeSession.title }, `Session: ${activeSession.title}`)
          : tr('chat.noSessionSelected', null, 'Select or create a session');
      }
      const metaEl = document.getElementById('current-session-meta');
      if (metaEl) {
        metaEl.textContent = activeSession && activeSession.title
          ? tr('chat.sessionRouteMeta', { title: activeSession.title }, `Route: ${activeSession.title}`)
          : tr('chat.activeSessionEmpty', null, 'Active Session: -');
      }
      const statusBadge = document.getElementById('session-status-badge');
      if (statusBadge && state.currentSessionRoute && state.currentSessionRoute.status) {
        statusBadge.textContent = formatStatus(state.currentSessionRoute.status);
      }
      const genBadge = document.getElementById('session-generation-badge');
      if (genBadge && state.currentSessionRoute && typeof state.currentSessionRoute.currentGeneration === 'number') {
        genBadge.textContent = tr('chat.genBadge', { number: formatNumber(state.currentSessionRoute.currentGeneration) }, `Gen ${state.currentSessionRoute.currentGeneration}`);
      }
      const chatInput = document.getElementById('chat-input');
      if (chatInput) {
        const isArchived = Boolean(state.currentSessionRoute && state.currentSessionRoute.status === 'archived');
        chatInput.placeholder = isArchived
          ? tr('chat.inputArchivedPlaceholder', null, 'This session is archived (read-only).')
          : tr('chat.inputPlaceholder', null, 'Type a message or instruction for Enkeep agent...');
      }
    } else {
      const titleEl = document.getElementById('current-session-title');
      if (titleEl) {
        titleEl.textContent = tr('chat.noSessionSelected', null, 'Select or create a session');
      }
      const metaEl = document.getElementById('current-session-meta');
      if (metaEl) {
        metaEl.textContent = tr('chat.activeSessionEmpty', null, 'Active Session: -');
      }
    }
    updateStopTurnControl();
    updateCharCount();
    renderMessages();
  }
}

// ----------------------------------------------------
// Theme Management & Multi-Theme Switching Architecture
// ----------------------------------------------------

let currentActiveTheme = 'dark';

export function detectTheme(user = null) {
  // 1. Authenticated user canonical theme preference
  if (user && typeof user.theme === 'string' && SUPPORTED_THEMES.includes(user.theme)) {
    return user.theme;
  }

  // 2. Pre-login explicit local preference (with backward-compatible legacy key migration)
  try {
    if (typeof localStorage !== 'undefined') {
      const legacy = localStorage.getItem('enkeep.theme');
      if (legacy) {
        if (SUPPORTED_THEMES.includes(legacy) && !localStorage.getItem('enkeep.theme.prelogin')) {
          localStorage.setItem('enkeep.theme.prelogin', legacy);
        }
        localStorage.removeItem('enkeep.theme');
      }

      const saved = localStorage.getItem('enkeep.theme.prelogin');
      if (saved && SUPPORTED_THEMES.includes(saved)) {
        return saved;
      }
    }
  } catch {
    // Storage access blocked or unavailable
  }

  // 3. System prefers-color-scheme default (light -> light, else dark; eye-care never automatic)
  if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light';
  }

  // 4. Default theme fallback
  return DEFAULT_THEME;
}

export function getTheme() {
  if (typeof document !== 'undefined' && document.documentElement && document.documentElement.dataset.theme) {
    const dt = document.documentElement.dataset.theme;
    if (SUPPORTED_THEMES.includes(dt)) {
      return dt;
    }
  }
  return currentActiveTheme || DEFAULT_THEME;
}

export function setTheme(newTheme, options = {}) {
  let targetTheme = newTheme;
  if (!SUPPORTED_THEMES.includes(targetTheme)) {
    targetTheme = DEFAULT_THEME;
  }

  const previousTheme = currentActiveTheme;
  currentActiveTheme = targetTheme;

  // 1. Apply to document.documentElement immediately before body repaint
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.dataset.theme = targetTheme;
  }

  // 2. Persist to localStorage for unauthenticated prelogin preference unless persist: false
  // Authenticated user themes are stored in database only and never leak to prelogin storage
  if (options.persist !== false && !state.currentUser) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('enkeep.theme.prelogin', targetTheme);
      }
    } catch {
      // Storage unavailable
    }
  }

  // 3. Synchronize all theme selectors in DOM
  if (typeof document !== 'undefined') {
    syncThemeControls(targetTheme);
  }

  // 4. Dispatch custom event enkeep:themechange
  if (options.silent !== true) {
    const detail = { theme: targetTheme, previousTheme, source: options.source || 'user' };
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try {
        window.dispatchEvent(new CustomEvent('enkeep:themechange', { detail }));
      } catch {}
    }
    if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function') {
      try {
        document.dispatchEvent(new CustomEvent('enkeep:themechange', { detail }));
      } catch {}
    }
  }

  return currentActiveTheme;
}

export async function handleThemeSelectChange(newTheme) {
  const previousTheme = getTheme();
  if (newTheme === previousTheme) return;

  // 1. Switch theme immediately without page reload, modal closing, or draft loss
  // For unauthenticated users, persist: true sets enkeep.theme.prelogin; for authenticated users, persist: false
  setTheme(newTheme, { persist: !state.currentUser });

  // 2. If user is logged in, sync with canonical backend preference API (PUT /api/account/preferences/theme)
  if (state.currentUser) {
    try {
      const idempotencyKey = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : 'idem-' + Date.now();

      await apiRequest('/api/account/preferences/theme', {
        method: 'PUT',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: { theme: newTheme },
      });

      if (state.currentUser) {
        state.currentUser.theme = newTheme;
      }
    } catch (err) {
      // Preference save failed -> rollback theme and show error toast
      setTheme(previousTheme, { persist: false });
      showToast(t('account.themeSaveFailed', null, 'Failed to save theme preference to server. Reverted.'), 'error');
    }
  }
}

// Cross-tab storage synchronization listener
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'enkeep.theme.prelogin' && !state.currentUser) {
      if (e.newValue && SUPPORTED_THEMES.includes(e.newValue)) {
        setTheme(e.newValue, { persist: false, source: 'cross-tab-storage' });
      } else {
        setTheme(detectTheme(null), { persist: false, source: 'cross-tab-storage' });
      }
    }
    if (e.key === 'enkeep.locale' && e.newValue && SUPPORTED_LOCALES.includes(e.newValue)) {
      setLocale(e.newValue, { persist: false, source: 'cross-tab-storage' });
      rerenderCurrentViewForLocale();
    }
  });

  // System prefers-color-scheme listener (only active when unauthenticated and no explicit prelogin theme set)
  if (window.matchMedia) {
    const colorSchemeMediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    const handleSystemThemeChange = (e) => {
      if (!state.currentUser) {
        let hasExplicit = false;
        try {
          hasExplicit = Boolean(localStorage.getItem('enkeep.theme.prelogin'));
        } catch {}
        if (!hasExplicit) {
          const sysTheme = e.matches ? 'light' : 'dark';
          setTheme(sysTheme, { persist: false, source: 'system-matchmedia' });
        }
      }
    };
    if (typeof colorSchemeMediaQuery.addEventListener === 'function') {
      colorSchemeMediaQuery.addEventListener('change', handleSystemThemeChange);
    } else if (typeof colorSchemeMediaQuery.addListener === 'function') {
      colorSchemeMediaQuery.addListener(handleSystemThemeChange);
    }
  }
}

function onLocaleChangeEvent() {
  handleWorkspaceLocaleChange();
  rerenderCurrentViewForLocale();

  const currentLoc = getLocale();
  if (state.currentUser && state.currentUser.locale !== currentLoc) {
    state.currentUser.locale = currentLoc;
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      try {
        const idempotencyKey = crypto.randomUUID();
        apiRequest('/api/account/preferences', {
          method: 'PATCH',
          headers: { 'Idempotency-Key': idempotencyKey },
          body: { locale: currentLoc },
        }).catch(() => {});
      } catch (prefErr) {
        // Non-critical background preference sync error
      }
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('enkeep:localechange', onLocaleChangeEvent);
  window.addEventListener('localechange', onLocaleChangeEvent);
}
if (typeof document !== 'undefined') {
  document.addEventListener('enkeep:localechange', onLocaleChangeEvent);
  document.addEventListener('localechange', onLocaleChangeEvent);
}

// ----------------------------------------------------
// Internationalization (i18n) View Rerender & Handlers
// ----------------------------------------------------

async function handleLocaleSelectChange(newLocale) {
  const previousLocale = getLocale();
  if (newLocale === previousLocale) return;

  // 1. Switch locale immediately in UI & DOM
  setLocale(newLocale);

  // 2. Call view rerender hook
  rerenderCurrentViewForLocale();

  // 3. If user is logged in, sync with canonical backend preference API
  if (state.currentUser) {
    try {
      const idempotencyKey = crypto.randomUUID();
      await apiRequest('/api/account/preferences', {
        method: 'PATCH',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: { locale: newLocale },
      });
      if (state.currentUser) {
        state.currentUser.locale = newLocale;
      }
    } catch {
      // Preference save failed -> rollback locale and show error toast
      setLocale(previousLocale);
      rerenderCurrentViewForLocale();
      showToast(t('error.preferenceSaveFailed'), 'error');
    }
  }
}

function rerenderCurrentViewForLocale() {
  if (typeof document === 'undefined') return;

  const channelModal = document.getElementById('modal-channel-onboarding');
  if (channelModal && !channelModal.classList.contains('hidden')) {
    if (typeof window !== 'undefined' && window.channelOnboardingController && typeof window.channelOnboardingController.cleanup === 'function') {
      window.channelOnboardingController.cleanup();
    }
    closeModal('modal-channel-onboarding');
  }

  // Capture unsaved inputs from active modals and entire body before translation
  const savedModalState = captureFormState(document.body);

  // 1. Re-translate static DOM elements
  translateDom(document);

  // Restore form inputs immediately for static DOM modals
  restoreFormState(document.body, savedModalState);

  // 2. If user is not logged in or in auth view, auth view is updated via translateDom
  if (!state.currentUser) {
    return;
  }

  // 3. Update topbar breadcrumb
  const isAdmin = Boolean(state.currentUser && state.currentUser.role === 'admin');
  const parsed = parseManagementRoute(state.currentRoute, isAdmin);
  const breadcrumbEl = document.getElementById('active-view-label');
  if (breadcrumbEl) {
    breadcrumbEl.textContent = getRouteBreadcrumb(parsed, isAdmin);
  }

  // 4. Update topbar role badge
  const roleBadgeEl = document.getElementById('user-role-badge');
  if (roleBadgeEl && state.currentUser) {
    roleBadgeEl.textContent = state.currentUser.role === 'admin' ? t('auth.roleAdmin', null, 'Admin') : t('auth.roleUser', null, 'Member');
    roleBadgeEl.className = `badge badge-role ${state.currentUser.role === 'admin' ? 'badge-admin' : 'badge-user'}`;
  }

  // 5. Update tenant indicator
  updateTenantIndicator(state.currentUser);

  // 6. If in workspace view, preserve session, draft, and message list without reloading
  if (parsed.type === 'workspace') {
    // Preserve selected session title & status
    if (state.currentSessionId) {
      const activeSession = state.sessions.find((s) => s.id === state.currentSessionId);
      const titleEl = document.getElementById('current-session-title');
      if (titleEl && activeSession) {
        titleEl.textContent = activeSession.title || 'Untitled Session';
      }
    } else {
      const titleEl = document.getElementById('current-session-title');
      if (titleEl) {
        titleEl.textContent = t('chat.noSessionSelected');
      }
    }
    updateStopTurnControl();
  } else {
    // 7. If in management view, capture canvas form inputs, rerender and restore
    const canvas = document.getElementById('management-canvas');
    const savedCanvasState = captureFormState(canvas);
    renderManagementView(state.currentRoute).then(() => {
      restoreFormState(canvas, savedCanvasState);
      restoreFormState(document.body, savedModalState);
    });
  }
}

if (typeof window !== 'undefined') {
  window.openModal = openModal;
  window.closeModal = closeModal;
  window.rerenderCurrentViewForLocale = rerenderCurrentViewForLocale;
  window.handleLocaleSelectChange = handleLocaleSelectChange;
  window.renderMessages = renderMessages;
  window.loadMessages = loadMessages;
  window.loadOlderMessages = loadOlderMessages;
  window.updateApprovalBadges = updateApprovalBadges;
  window.updateComposerControlsState = updateComposerControlsState;
  window.renderSessionList = renderSessionList;
  window.renderSpaceSelect = renderSpaceSelect;
  window.renderAttachmentTray = renderAttachmentTray;
  window.handleFilesSelected = handleFilesSelected;
  window.openWorkspaceFilePicker = openWorkspaceFilePicker;
  window.loadWorkspaceFilePicker = loadWorkspaceFilePicker;
  window.handleApplyWorkspacePickerSelection = handleApplyWorkspacePickerSelection;
  window.handleSendMessage = handleSendMessage;
  window.setReplyMessage = setReplyMessage;
  window.cancelReplyMessage = cancelReplyMessage;
  window.renderComposerReplyBanner = renderComposerReplyBanner;
  window.openEditMessageModal = openEditMessageModal;
  window.handleEditMessage = handleEditMessage;
  window.handleRegenerateMessage = handleRegenerateMessage;
  window.tokenizeCodeToLowlightAst = tokenizeCodeToLowlightAst;
  window.parseMarkdownTable = parseMarkdownTable;
  window.renderMarkdownToElement = renderMarkdownToElement;
  window.t = t;
  window.setLocale = (newLocale, options = {}) => {
    setLocale(newLocale, options);
    if (state.currentUser && options.syncBackend !== false) {
      handleLocaleSelectChange(newLocale).catch(() => {});
    }
  };
  window.getLocale = getLocale;
  window.detectTheme = detectTheme;
  window.getTheme = getTheme;
  window.setTheme = (newTheme, options = {}) => {
    setTheme(newTheme, options);
    if (state.currentUser && options.syncBackend !== false) {
      handleThemeSelectChange(newTheme).catch(() => {});
    }
  };
  window.handleThemeSelectChange = handleThemeSelectChange;
  window.formatDate = formatDate;
  window.formatNumber = formatNumber;
  window.formatBytes = formatBytes;
  window.getLocalizedEnum = getLocalizedEnum;
  window.captureFormState = captureFormState;
  window.restoreFormState = restoreFormState;
}

// ----------------------------------------------------
// Event Listeners Setup
// ----------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  // Theme Selectors
  const themeSelect = document.getElementById('theme-select');
  if (themeSelect) {
    themeSelect.addEventListener('change', (e) => handleThemeSelectChange(e.target.value));
  }
  const authThemeSelect = document.getElementById('auth-theme-select');
  if (authThemeSelect) {
    authThemeSelect.addEventListener('change', (e) => handleThemeSelectChange(e.target.value));
  }
  const forcedThemeSelect = document.getElementById('forced-password-theme-select');
  if (forcedThemeSelect) {
    forcedThemeSelect.addEventListener('change', (e) => handleThemeSelectChange(e.target.value));
  }

  // Initialize theme
  setTheme(detectTheme(null), { silent: false });

  // Language Selectors
  const localeSelect = document.getElementById('locale-select');
  if (localeSelect) {
    localeSelect.addEventListener('change', (e) => handleLocaleSelectChange(e.target.value));
  }
  const authLocaleSelect = document.getElementById('auth-locale-select');
  if (authLocaleSelect) {
    authLocaleSelect.addEventListener('change', (e) => handleLocaleSelectChange(e.target.value));
  }
  const forcedLocaleSelect = document.getElementById('forced-password-locale-select');
  if (forcedLocaleSelect) {
    forcedLocaleSelect.addEventListener('change', (e) => handleLocaleSelectChange(e.target.value));
  }

  // Initialize i18n
  initI18n();

  // Auth Form
  const loginForm = document.getElementById('login-form');
  if (loginForm) loginForm.addEventListener('submit', handleLogin);

  const forcedPasswordForm = document.getElementById('forced-password-form');
  if (forcedPasswordForm) forcedPasswordForm.addEventListener('submit', handleForcedPasswordSubmit);

  const forcedLogoutBtn = document.getElementById('btn-forced-password-logout');
  if (forcedLogoutBtn) forcedLogoutBtn.addEventListener('click', handleLogout);

  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);

  const navLogoutBtn = document.getElementById('btn-nav-logout');
  if (navLogoutBtn) navLogoutBtn.addEventListener('click', handleLogout);

  // Management Tab Buttons
  MANAGEMENT_TABS.forEach((t) => {
    const btn = document.getElementById(`tab-btn-${t}`);
    if (btn) {
      btn.addEventListener('click', () => {
        window.location.hash = `#management/${t}`;
      });
    }
  });

  // Hash Navigation Routing
  window.addEventListener('hashchange', handleRouteHash);

  // Space Form & Lifecycle Actions
  const createSpaceForm = document.getElementById('create-space-form');
  if (createSpaceForm) createSpaceForm.addEventListener('submit', handleCreateSpace);

  const newSpaceBtn = document.getElementById('btn-new-space');
  if (newSpaceBtn) newSpaceBtn.addEventListener('click', openCreateSpaceModal);

  const execModeSelect = document.getElementById('space-exec-mode-select');
  if (execModeSelect) {
    execModeSelect.addEventListener('change', (e) => {
      const val = e.target.value;
      const hostDesc = document.getElementById('space-exec-mode-host-desc');
      if (val === 'host') {
        const confirmTitle = t('modal.hostConfirmTitle', null, 'High Risk Confirmation');
        const confirmMsg = t('modal.hostConfirmMessage', null, 'Host execution mode runs directly on platform host with controlled Enkeep workspace (not arbitrary mount yet; admin only). Are you sure you want to proceed?');
        showConfirmation(
          confirmTitle,
          confirmMsg,
          () => {
            execModeSelect.value = 'host';
            if (hostDesc) hostDesc.classList.remove('hidden');
          },
          () => {
            execModeSelect.value = 'container';
            if (hostDesc) hostDesc.classList.add('hidden');
          }
        );
      } else {
        if (hostDesc) hostDesc.classList.add('hidden');
      }
    });
  }

  const spaceSelect = document.getElementById('space-select');
  if (spaceSelect) {
    spaceSelect.addEventListener('change', (e) => {
      const newSpaceId = e.target.value;
      if (newSpaceId === state.currentSpaceId) return;
      if (state.activeAttachments && state.activeAttachments.length > 0) {
        showConfirmation(
          t('chat.confirmSwitchSpaceTitle', null, 'Unsaved Attachments'),
          t('chat.confirmSwitchSpaceMessage', null, 'Switching space will clear current attachments. Do you want to proceed?'),
          () => {
            state.activeAttachments = [];
            state.drafts = {};
            renderAttachmentTray();
            selectSpace(newSpaceId);
          },
          () => {
            if (state.currentSpaceId) {
              spaceSelect.value = state.currentSpaceId;
            }
          }
        );
      } else {
        selectSpace(newSpaceId);
      }
    });
  }

  const renameSpaceBtn = document.getElementById('btn-rename-space');
  if (renameSpaceBtn) renameSpaceBtn.addEventListener('click', openRenameSpaceModal);

  const manageMountsBtn = document.getElementById('btn-manage-mounts');
  if (manageMountsBtn) manageMountsBtn.addEventListener('click', openSpaceMountsModal);

  const addControlledMountForm = document.getElementById('add-controlled-mount-form');
  if (addControlledMountForm) addControlledMountForm.addEventListener('submit', handleAddControlledMount);

  const renameSpaceForm = document.getElementById('rename-space-form');
  if (renameSpaceForm) renameSpaceForm.addEventListener('submit', handleRenameSpace);

  const archiveSpaceBtn = document.getElementById('btn-archive-space');
  if (archiveSpaceBtn) archiveSpaceBtn.addEventListener('click', handleArchiveSpace);

  const restoreSpaceBtn = document.getElementById('btn-restore-space');
  if (restoreSpaceBtn) restoreSpaceBtn.addEventListener('click', handleRestoreSpace);

  // Session Form & Lifecycle Actions
  const createSessionForm = document.getElementById('create-session-form');
  if (createSessionForm) createSessionForm.addEventListener('submit', handleCreateSession);

  const forkSessionForm = document.getElementById('fork-session-form');
  if (forkSessionForm) forkSessionForm.addEventListener('submit', handleForkSession);

  const editMessageForm = document.getElementById('edit-message-form');
  if (editMessageForm) editMessageForm.addEventListener('submit', handleEditMessage);

  const newSessionBtn = document.getElementById('btn-new-session');
  if (newSessionBtn) newSessionBtn.addEventListener('click', () => openModal('modal-session'));

  const forkSessionBtn = document.getElementById('btn-fork-session');
  if (forkSessionBtn) forkSessionBtn.addEventListener('click', () => openForkSessionModal());

  const toggleArchivedBtn = document.getElementById('btn-toggle-archived-sessions');
  if (toggleArchivedBtn) toggleArchivedBtn.addEventListener('click', toggleArchivedSessions);

  const refreshSessionsBtn = document.getElementById('btn-refresh-sessions');
  if (refreshSessionsBtn) {
    refreshSessionsBtn.addEventListener('click', () => {
      if (state.currentSpaceId) {
        loadSessions(state.currentSpaceId);
        showToast(tr('toast.refreshedSessions', null, 'Refreshed sessions list'), 'info');
      }
    });
  }

  const sessionSearchInputEl = document.getElementById('session-search-input');
  if (sessionSearchInputEl) {
    sessionSearchInputEl.addEventListener('input', (e) => {
      state.sessionSearchQuery = e.target.value;
      renderSessionList();
    });
  }

  const toggleSidebarBtn = document.getElementById('btn-toggle-sidebar');
  if (toggleSidebarBtn) {
    toggleSidebarBtn.addEventListener('click', toggleWorkspaceSidebar);
  }

  const renameSessionBtn = document.getElementById('btn-rename-session');
  if (renameSessionBtn) renameSessionBtn.addEventListener('click', openRenameSessionModal);

  const renameSessionForm = document.getElementById('rename-session-form');
  if (renameSessionForm) renameSessionForm.addEventListener('submit', handleRenameSession);

  const archiveSessionBtn = document.getElementById('btn-archive-session');
  if (archiveSessionBtn) archiveSessionBtn.addEventListener('click', handleArchiveSession);

  const restoreSessionBtn = document.getElementById('btn-restore-session');
  if (restoreSessionBtn) restoreSessionBtn.addEventListener('click', handleRestoreSession);

  const resetSessionBtn = document.getElementById('btn-reset-session');
  if (resetSessionBtn) resetSessionBtn.addEventListener('click', openResetSessionModal);

  const resetSessionForm = document.getElementById('reset-session-form');
  if (resetSessionForm) resetSessionForm.addEventListener('submit', handleResetSession);

  const genHistoryBtn = document.getElementById('btn-session-generations');
  if (genHistoryBtn) genHistoryBtn.addEventListener('click', () => openSessionGenerationsModal());

  const refreshSessionBtn = document.getElementById('btn-refresh-session');
  if (refreshSessionBtn) {
    refreshSessionBtn.addEventListener('click', () => {
      if (state.currentSessionId) {
        loadMessages(state.currentSessionId);
        syncActiveTurnStatus(state.currentSessionId);
        showToast(tr('toast.refreshedMessages', null, 'Refreshed session messages'), 'info');
      }
    });
  }

  const inspectTurnsBtn = document.getElementById('btn-inspect-turns');
  if (inspectTurnsBtn) {
    inspectTurnsBtn.addEventListener('click', () => {
      if (state.currentSessionId) {
        openSessionTurnsModal(state.currentSessionId);
      }
    });
  }

  const stopTurnBtn = document.getElementById('btn-stop-turn');
  if (stopTurnBtn) stopTurnBtn.addEventListener('click', handleStopCurrentTurn);

  // Agent Profiles Forms
  const createProfileForm = document.getElementById('create-profile-form');
  if (createProfileForm) createProfileForm.addEventListener('submit', handleCreateProfile);

  const createProfileVerForm = document.getElementById('create-profile-version-form');
  if (createProfileVerForm) createProfileVerForm.addEventListener('submit', handleCreateProfileVersion);

  // Admin Quota Edit Form
  const editQuotaForm = document.getElementById('edit-quota-form');
  if (editQuotaForm) editQuotaForm.addEventListener('submit', handleSaveQuotaEdit);

  // User Edit Form (Admin)
  const editUserForm = document.getElementById('edit-user-form');
  if (editUserForm) editUserForm.addEventListener('submit', handleSaveUserEdit);

  // Admin Create User Form
  const createUserForm = document.getElementById('create-user-form');
  if (createUserForm) createUserForm.addEventListener('submit', handleCreateUser);

  // Copy Temporary Password Button
  const copyTempPwdBtn = document.getElementById('btn-copy-temp-password');
  if (copyTempPwdBtn) {
    copyTempPwdBtn.addEventListener('click', () => {
      const pwdInput = document.getElementById('display-temp-password');
      if (pwdInput && pwdInput.value) {
        navigator.clipboard.writeText(pwdInput.value).then(() => {
          showToast(t('modal.tempPasswordCopied', null, getLocale() === 'zh-CN' ? '临时密码已复制到剪贴板' : 'Temporary password copied to clipboard'), 'success');
        }).catch(() => {
          pwdInput.select();
          document.execCommand('copy');
          showToast(t('modal.tempPasswordCopied', null, getLocale() === 'zh-CN' ? '临时密码已复制到剪贴板' : 'Temporary password copied to clipboard'), 'success');
        });
      }
    });
  }

  // Chat Input
  const sendBtn = document.getElementById('btn-send-message');
  if (sendBtn) sendBtn.addEventListener('click', handleSendMessage);

  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    chatInput.addEventListener('input', () => {
      adjustTextareaHeight(chatInput);
      updateCharCount();
      updateComposerControlsState();
      if (state.currentSessionId) {
        state.drafts[state.currentSessionId] = {
          content: chatInput.value,
          attachments: [...state.activeAttachments],
        };
      }
    });

    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendMessage();
      }
    });
  }

  // Attachments Dropdown Menu & Triggers
  const attachBtn = document.getElementById('btn-attach');
  const attachMenu = document.getElementById('attach-menu');
  const attachLocalBtn = document.getElementById('btn-attach-local');
  const attachWorkspaceBtn = document.getElementById('btn-attach-workspace');
  const chatFileInput = document.getElementById('chat-file-input');

  if (attachBtn && attachMenu) {
    attachBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = attachMenu.classList.contains('hidden');
      if (isHidden) {
        attachMenu.classList.remove('hidden');
        attachBtn.setAttribute('aria-expanded', 'true');
      } else {
        attachMenu.classList.add('hidden');
        attachBtn.setAttribute('aria-expanded', 'false');
      }
    });

    document.addEventListener('click', (e) => {
      if (!attachMenu.contains(e.target) && e.target !== attachBtn) {
        attachMenu.classList.add('hidden');
        attachBtn.setAttribute('aria-expanded', 'false');
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !attachMenu.classList.contains('hidden')) {
        attachMenu.classList.add('hidden');
        attachBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  if (attachLocalBtn && chatFileInput) {
    attachLocalBtn.addEventListener('click', () => {
      if (attachMenu) attachMenu.classList.add('hidden');
      if (attachBtn) attachBtn.setAttribute('aria-expanded', 'false');
      chatFileInput.value = '';
      chatFileInput.click();
    });
  }

  if (chatFileInput) {
    chatFileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleFilesSelected(e.target.files);
      }
    });
  }

  if (attachWorkspaceBtn) {
    attachWorkspaceBtn.addEventListener('click', () => {
      if (attachMenu) attachMenu.classList.add('hidden');
      if (attachBtn) attachBtn.setAttribute('aria-expanded', 'false');
      openWorkspaceFilePicker();
    });
  }

  // Workspace File Picker Modal Actions
  const filePickerSearchInput = document.getElementById('file-picker-search-input');
  if (filePickerSearchInput) {
    filePickerSearchInput.addEventListener('input', (e) => {
      state.filePickerSearchQuery = e.target.value;
      loadWorkspaceFilePicker(state.filePickerCurrentPath);
    });
  }

  const filePickerSelectBtn = document.getElementById('btn-file-picker-select');
  if (filePickerSelectBtn) {
    filePickerSelectBtn.addEventListener('click', handleApplyWorkspacePickerSelection);
  }

  // Drag and Drop & Paste Setup
  setupComposerDragAndDrop();
  setupComposerPasteHandler();

  // Chat Messages Scroll Pagination Listener
  const messagesContainer = document.getElementById('messages-container');
  if (messagesContainer) {
    let scrollThrottleTimeout = null;
    messagesContainer.addEventListener('scroll', () => {
      if (messagesContainer.scrollTop < 80) {
        if (state.currentSessionId && state.hasMoreMessages && !state.isLoadingOlderMessages) {
          if (!scrollThrottleTimeout) {
            scrollThrottleTimeout = setTimeout(() => {
              scrollThrottleTimeout = null;
              if (messagesContainer.scrollTop < 80 && state.currentSessionId && state.hasMoreMessages && !state.isLoadingOlderMessages) {
                loadOlderMessages(state.currentSessionId);
              }
            }, 100);
          }
        }
      }
    });
  }

  // Approvals Button in Chat Header
  const chatApprovalsBtn = document.getElementById('btn-chat-approvals');
  if (chatApprovalsBtn) {
    chatApprovalsBtn.addEventListener('click', () => {
      openApprovalsModal(state.currentSessionId);
    });
  }

  // Model Badge in Chat Header
  const sessionModelBadge = document.getElementById('session-model-badge');
  if (sessionModelBadge) {
    sessionModelBadge.addEventListener('click', () => {
      window.location.hash = '#management/models/model-config';
    });
  }

  // Extension Installation Form Listeners
  const skillSourceTypeSelect = document.getElementById('skill-source-type-select');
  const skillGitGroup = document.getElementById('skill-git-fields-group');
  const skillUploadGroup = document.getElementById('skill-upload-fields-group');
  const skillArchiveInput = document.getElementById('skill-archive-file-input');
  let loadedArchiveBase64 = null;
  let loadedArchiveFilename = null;

  if (skillSourceTypeSelect && skillGitGroup && skillUploadGroup) {
    skillSourceTypeSelect.addEventListener('change', () => {
      if (skillSourceTypeSelect.value === 'upload') {
        skillGitGroup.classList.add('hidden');
        skillUploadGroup.classList.remove('hidden');
      } else {
        skillGitGroup.classList.remove('hidden');
        skillUploadGroup.classList.add('hidden');
      }
    });
  }

  if (skillArchiveInput) {
    skillArchiveInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) {
        loadedArchiveFilename = file.name;
        const reader = new FileReader();
        reader.addEventListener('load', () => {
          const res = reader.result;
          if (typeof res === 'string') {
            const base64Index = res.indexOf('base64,');
            loadedArchiveBase64 = base64Index !== -1 ? res.slice(base64Index + 7) : res;
          }
        });
        reader.readAsDataURL(file);
      } else {
        loadedArchiveBase64 = null;
        loadedArchiveFilename = null;
      }
    });
  }

  const installSkillForm = document.getElementById('install-skill-form');
  if (installSkillForm) {
    installSkillForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = document.getElementById('btn-submit-install-skill');
      const sourceType = skillSourceTypeSelect ? skillSourceTypeSelect.value : 'git';
      const scopeSelect = document.getElementById('skill-scope-select');
      const targetSpaceSelect = document.getElementById('skill-target-space-select');

      const scope = scopeSelect ? scopeSelect.value : 'space';
      const spaceId = scope === 'space' ? (targetSpaceSelect ? targetSpaceSelect.value : null) : null;

      if (scope === 'space' && !spaceId) {
        showToast('Please select a target space.', 'warning');
        return;
      }

      try {
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = 'Installing...';
        }

        const idempotencyKey = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : undefined;
        let payload;

        if (sourceType === 'git') {
          const repoUrlInput = document.getElementById('skill-repo-url-input');
          const gitRefInput = document.getElementById('skill-git-ref-input');
          const subdirInput = document.getElementById('skill-subdirectory-input');
          const expCommitInput = document.getElementById('skill-expected-commit-input');
          const credRefInput = document.getElementById('skill-credential-ref-input');
          const checksumInput = document.getElementById('skill-checksum-input');

          payload = {
            sourceKind: 'git',
            spaceId: spaceId || undefined,
            gitSource: {
              repositoryUrl: repoUrlInput ? repoUrlInput.value.trim() : '',
              ref: (gitRefInput && gitRefInput.value.trim()) || undefined,
              subdirectory: (subdirInput && subdirInput.value.trim()) || undefined,
              credentialRef: (credRefInput && credRefInput.value.trim()) || undefined,
              expectedCommit: (expCommitInput && expCommitInput.value.trim()) || undefined,
              expectedChecksum: (checksumInput && checksumInput.value.trim()) || undefined,
            },
          };
        } else if (sourceType === 'upload') {
          if (!loadedArchiveBase64) {
            showToast('Please select an archive file to upload.', 'warning');
            return;
          }
          const checksumInput = document.getElementById('skill-checksum-input');
          payload = {
            sourceKind: 'archive',
            spaceId: spaceId || undefined,
            archiveBase64: loadedArchiveBase64,
            archiveFilename: loadedArchiveFilename || 'skill-archive.tar.gz',
            expectedChecksum: (checksumInput && checksumInput.value.trim()) || undefined,
          };
        }

        const installRes = await apiRequest('/api/manage/extensions/install', {
          method: 'POST',
          headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
          body: payload,
        });

        const installed = installRes && installRes.data;
        if (spaceId) {
          state.activeSkillFilterSpace = spaceId;
          state.currentSpaceId = spaceId;
        }
        showToast(t('extensions.installSuccess', { name: installed?.name || installed?.slug || 'extension', version: installed?.installedVersion || installed?.activeVersion || 1 }, 'Extension installed successfully.'), 'success');
        closeModal('modal-install-skill');
        renderManagementView(state.currentRoute);
      } catch (err) {
        showToast(getSafeErrorMessage(err, 'Failed to install extension.'), 'error');
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = t('extensions.btnInstall', null, 'Install Extension');
        }
      }
    });
  }

  // Update Extension Form & Diff Preview
  const btnPreviewDiff = document.getElementById('btn-preview-skill-diff');
  if (btnPreviewDiff) {
    btnPreviewDiff.addEventListener('click', async () => {
      const nameInput = document.getElementById('update-skill-name');
      const spaceInput = document.getElementById('update-skill-space-id');
      const refInput = document.getElementById('update-skill-ref-input');
      const expCommitInput = document.getElementById('update-skill-expected-commit-input');
      const credRefInput = document.getElementById('update-skill-credential-ref-input');

      const diffContainer = document.getElementById('skill-diff-preview-container');
      const diffSummaryText = document.getElementById('skill-diff-summary-text');
      const diffFilesList = document.getElementById('skill-diff-files-list');

      if (!nameInput || !nameInput.value) return;

      try {
        btnPreviewDiff.disabled = true;
        btnPreviewDiff.textContent = 'Previewing...';

        const res = await apiRequest(`/api/manage/extensions/${encodeURIComponent(nameInput.value)}/update`, {
          method: 'POST',
          body: {
            spaceId: (spaceInput && spaceInput.value) || undefined,
            ref: (refInput && refInput.value.trim()) || undefined,
            expectedCommit: (expCommitInput && expCommitInput.value.trim()) || undefined,
            credentialRef: (credRefInput && credRefInput.value.trim()) || undefined,
            confirmDiff: false,
          },
        });

        const preview = res && res.data;
        if (preview && diffContainer && diffSummaryText && diffFilesList) {
          diffSummaryText.textContent = preview.diffSummary || 'Diff preview analyzed.';
          diffFilesList.replaceChildren();

          if (Array.isArray(preview.changedFiles)) {
            preview.changedFiles.forEach((cf) => {
              const fileDiv = document.createElement('div');
              fileDiv.className = `diff-file-item ${cf.status || 'modified'}`;
              fileDiv.textContent = `[${(cf.status || 'M').charAt(0).toUpperCase()}] ${cf.path}`;
              diffFilesList.appendChild(fileDiv);
            });
          }
          diffContainer.classList.remove('hidden');
        }
      } catch (err) {
        showToast(getSafeErrorMessage(err, 'Failed to preview diff.'), 'error');
      } finally {
        btnPreviewDiff.disabled = false;
        btnPreviewDiff.textContent = t('extensions.btnPreviewDiff', null, 'Preview Update Diff');
      }
    });
  }

  const updateSkillForm = document.getElementById('update-skill-form');
  if (updateSkillForm) {
    updateSkillForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = document.getElementById('btn-commit-update-skill');
      const nameInput = document.getElementById('update-skill-name');
      const spaceInput = document.getElementById('update-skill-space-id');
      const refInput = document.getElementById('update-skill-ref-input');
      const expCommitInput = document.getElementById('update-skill-expected-commit-input');
      const credRefInput = document.getElementById('update-skill-credential-ref-input');

      if (!nameInput || !nameInput.value) return;

      try {
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = 'Updating...';
        }

        const res = await apiRequest(`/api/manage/extensions/${encodeURIComponent(nameInput.value)}/update`, {
          method: 'POST',
          body: {
            spaceId: (spaceInput && spaceInput.value) || undefined,
            ref: (refInput && refInput.value.trim()) || undefined,
            expectedCommit: (expCommitInput && expCommitInput.value.trim()) || undefined,
            credentialRef: (credRefInput && credRefInput.value.trim()) || undefined,
            confirmDiff: true,
          },
        });

        const updated = res && res.data;
        showToast(t('extensions.updateSuccess', { name: nameInput.value, version: updated?.installedVersion || updated?.activeVersion || 2 }, 'Extension updated successfully.'), 'success');
        closeModal('modal-update-skill');
        renderManagementView(state.currentRoute);
      } catch (err) {
        showToast(getSafeErrorMessage(err, 'Failed to update extension.'), 'error');
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = t('extensions.btnCommitUpdate', null, 'Confirm & Apply Update');
        }
      }
    });
  }

  const rollbackSkillForm = document.getElementById('rollback-skill-form');
  if (rollbackSkillForm) {
    rollbackSkillForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = document.getElementById('btn-submit-rollback-skill');
      const nameInput = document.getElementById('rollback-skill-name');
      const spaceInput = document.getElementById('rollback-skill-space-id');
      const verInput = document.getElementById('rollback-skill-target-version-input');

      const targetVer = verInput ? parseInt(verInput.value, 10) : 1;
      if (isNaN(targetVer) || targetVer < 1) {
        showToast('Target version must be a positive integer.', 'warning');
        return;
      }

      try {
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = 'Rolling back...';
        }

        await apiRequest(`/api/manage/extensions/${encodeURIComponent(nameInput.value)}/rollback`, {
          method: 'POST',
          body: {
            targetVersion: targetVer,
            spaceId: (spaceInput && spaceInput.value) || undefined,
          },
        });

        showToast(t('extensions.rollbackSuccess', { name: nameInput.value, version: targetVer }, 'Extension rolled back successfully.'), 'success');
        closeModal('modal-rollback-skill');
        renderManagementView(state.currentRoute);
      } catch (err) {
        showToast(getSafeErrorMessage(err, 'Failed to rollback extension.'), 'error');
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = t('extensions.btnRollback', null, 'Rollback');
        }
      }
    });
  }

  // Initial Auth Check and CSRF token bootstrap
  fetchCsrfToken().then(() => checkAuth());
});
