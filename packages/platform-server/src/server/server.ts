import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformError,
  type PlatformStorage,
  type AuthService,
} from '@enkeep/platform-core';
import {
  SqlitePlatformStorage,
  SqlitePlatformOperationsStorage,
} from '@enkeep/platform-storage-sqlite';
import {
  PlatformOperationsService,
  createPlatformOperations,
} from '@enkeep/platform-operations';
import { DefaultAuthService } from '@enkeep/platform-auth';
import type { PlatformWebApi, RuntimeGateway } from '@enkeep/web-channel';
import {
  validateServerBinding,
} from '../safety/host-binding.js';
import {
  type ServerLimitsOptions,
  DEFAULT_SERVER_LIMITS,
  DEFAULT_SECURITY_HEADERS,
  API_CACHE_CONTROL_HEADERS,
  MIN_COOKIE_SECRET_LENGTH,
  MIN_CSRF_TOKEN_LENGTH,
} from '../safety/limits.js';
import { SqliteWebMessageStore } from '../storage/web-messages.js';
import { PlatformServerMigrationRunner, ALL_PLATFORM_MIGRATIONS } from '../storage/migrations.js';
import { FileTransferRecoveryService } from '../storage/file-transfer-recovery.js';
import { AttachmentSnapshotRecoveryService } from '../storage/attachment-snapshot-recovery.js';
import { SqlitePlatformWebApiAdapter } from '../storage/sqlite-platform-api.js';
import {
  createPlatformServerHandler,
  type HttpRequestHandler,
} from './handler.js';
import {
  DeliveryRuntimeGateway,
  type DrainableRuntimeGateway,
  type TenantQuotaProvider,
  type DeliveryTurnExecutor,
} from '../runtime/delivery-gateway.js';

export function isDrainableRuntimeGateway(gateway: unknown): gateway is DrainableRuntimeGateway {
  return (
    typeof gateway === 'object' &&
    gateway !== null &&
    typeof (gateway as DrainableRuntimeGateway).drain === 'function' &&
    typeof (gateway as DrainableRuntimeGateway).redriveHeld === 'function'
  );
}
import {
  ConsoleDataSource,
} from '../management/console-data-source.js';
import type {
  TenantQuotaDefaultsConfig,
} from '../management/tenant-provisioning-service.js';
import type {
  ManagementRuntimeProvider,
  ManagementOperationsProvider,
} from '../management/types.js';
import {
  createManagementOperationsAdapter,
} from '../operations/management-adapter.js';
import {
  type TenantRuntimeFileProvider,
  RuntimeFileApiService,
} from '../files/runtime-file-api.js';
import {
  createOperationsTenantQuotaProvider,
  createAgentPromptDeliveryDispatcher,
} from '../operations/index.js';
import {
  AgentPromptTaskWorker,
  createPlatformServerTaskWorker,
} from '../tasks/agent-prompt-worker.js';
import {
  type AgentProfileApi,
  createProfileService,
} from '../profiles/profile-service.js';
import type { IExternalInteractionService } from '@enkeep/dsh-external-interaction';
import {
  HappyClawMigrationService,
} from '../imports/happyclaw-migration-service.js';
import {
  HappyClawMigrationRoutes,
} from '../imports/happyclaw-migration-routes.js';
import {
  ExtensionService,
  type ExtensionServiceConfig,
} from '../extensions/extension-service.js';
import {
  ExtensionRoutes,
} from '../extensions/extension-routes.js';
import {
  SkillCatalogService,
} from '../skills/skill-catalog-service.js';
import {
  type GitSourcePolicy,
} from '../skills/git-source-policy.js';
import type {
  GitCredentialResolverPort,
} from '../skills/skill-types.js';
import {
  InstructionsService,
  InstructionsRoutes,
} from '../instructions/index.js';
import {
  ChannelManagementService,
  ChannelRoutes,
} from '../channels/channel-routes.js';
import {
  ChannelRuntimeManager,
  type LarkTransportFactory,
  type LarkDefaultSpaceResolver,
} from '../channels/channel-runtime-manager.js';
import { SqliteStreamEventSource } from '../channels/sqlite-stream-event-source.js';
import { LarkEncryptedCredentialStore } from '../channels/lark-encrypted-credentials.js';
import { LarkOnboardingService } from '../channels/lark-onboarding-service.js';
import type { LarkCredentialResolver, StreamEventSource } from '@enkeep/channel-lark';
import type { ChannelAccount } from '@enkeep/platform-core';
import {
  cleanupStaleGitTempDirs,
} from '../skills/git-installer.js';
import {
  ForkService,
} from '../sessions/fork-service.js';
import {
  SessionLifecycleService,
} from '../sessions/session-lifecycle-service.js';
import {
  FileProviderAttachmentCopyPort,
  type RuntimeArtifactPort,
  type AttachmentCopyPort,
} from '../sessions/runtime-artifact-port.js';
import {
  RuntimeDiagnosticsService,
} from '../diagnostics/runtime-diagnostics-service.js';
import {
  AuditExportService,
} from '../exports/audit-export-service.js';
import {
  UsageExportService,
} from '../exports/usage-export-service.js';
import {
  TaskNotificationService,
} from '../notifications/task-notification-service.js';
import {
  type WebhookSecurityOptions,
} from '../notifications/webhook-security-policy.js';
import {
  ModelSelectionService,
} from '../models/model-selection-service.js';
import {
  RuntimeProviderRegistry,
  CompositeDeliveryTurnExecutor,
  CompositeTenantRuntimeFileProvider,
  CompositeRuntimeArtifactPort,
  CompositeManagementRuntimeProvider,
  type RuntimeProvider,
} from '../runtime/provider-registry.js';
import type { RuntimeMountReconciler, BrowserService, PlatformProxyMcpService } from '@enkeep/platform-core';
import { SpaceMountService } from '../mounts/space-mount-service.js';

export class PlatformConfigurationError extends PlatformError {
  constructor(message: string, code = 'CONFIGURATION_ERROR') {
    super(message, code, 500);
  }
}

const ALLOWED_PLATFORM_SERVER_OPTIONS = new Set([
  'dbPath',
  'database',
  'storage',
  'authService',
  'cookieSecret',
  'csrfToken',
  'runtimeGateway',
  'platformApi',
  'host',
  'port',
  'limits',
  'autoRecover',
  'managementProvider',
  'consoleDataSource',
  'tenantQuotaDefaults',
  'quotaDefaults',
  'operationsStorage',
  'operationsService',
  'taskWorker',
  'quotaProvider',
  'enableWorker',
  'workerId',
  'runId',
  'fileProvider',
  'fileService',
  'agentProfileApi',
  'happyClawMigrationService',
  'allowlistedImportRoots',
  'stagedImportsDir',
  'runtimeArtifactPort',
  'attachmentCopyPort',
  'forkService',
  'sessionLifecycleService',
  'skillCatalogService',
  'extensionService',
  'extensionRoutes',
  'instructionsService',
  'instructionsRoutes',
  'dshHome',
  'spacesDir',
  'bundledSkillDir',
  'gitSourcePolicy',
  'gitCredentialResolver',
  'runtimeDiagnosticsService',
  'auditExportService',
  'usageExportService',
  'taskNotificationService',
  'webhookSecurityOptions',
  'modelSelectionService',
  'externalInteractionService',
  'runtimeProviderRegistry',
  'hostProvider',
  'containerProvider',
  'mountReconciler',
  'spaceMountService',
  'browserService',
  'mcpService',
  'channelService',
  'channelRoutes',
  'channelRuntimeManager',
  'larkCredentialResolver',
  'larkTransportFactory',
  'larkDefaultSpaceResolver',
  'larkOnboardingService',
  'larkEncryptedCredentialStore',
  'larkCredentialKeyFilePath',
  'streamEventSource',
]);

const ALLOWED_LIMITS_OPTIONS = new Set([
  'maxBodySizeBytes',
  'requestTimeoutMs',
  'maxCookieSizeBytes',
  'maxFailedLogins',
  'failedLoginWindowSeconds',
]);

export interface PlatformServerOptions {
  /** Database file path. Defaults to ':memory:' if neither dbPath nor database is provided. Mutually exclusive with database. */
  dbPath?: string;
  /** Existing DatabaseSync instance. Mutually exclusive with dbPath. */
  database?: DatabaseSync;
  /** Optional existing PlatformStorage instance */
  storage?: PlatformStorage;
  /** Optional existing AuthService instance */
  authService?: AuthService;
  /**
   * Secret for signing session cookies (REQUIRED, minimum 32 characters).
   * Hardcoded default credentials are strictly forbidden.
   */
  cookieSecret: string;
  /**
   * CSRF Token for header constant-time matching (REQUIRED, minimum 32 characters).
   * Frontends and CLI callers bootstrap token via GET /api/v1/auth/csrf or provide header X-Enkeep-CSRF.
   */
  csrfToken: string;
  /**
   * Runtime Gateway instance for executing turns and routing agent actions (REQUIRED).
   * A fake self-replying runtime gateway MUST NOT be quietly defaulted in production.
   * Tests or callers must explicitly pass their intended runtime gateway (e.g. real DSH Gateway or DeliveryRuntimeGateway).
   */
  runtimeGateway: RuntimeGateway;
  /** Optional existing PlatformWebApi instance */
  platformApi?: PlatformWebApi;
  /** Host binding: MUST strictly be '127.0.0.1' */
  host?: string;
  /** Port: 0 for dynamic ephemeral port, or safe validated port */
  port?: number;
  /** Server limits & safety options */
  limits?: ServerLimitsOptions;
  /** Enable automatic recovery of interrupted turn runs on startup */
  autoRecover?: boolean;
  /** Optional runtime provider for live container/plugin status queries */
  managementProvider?: ManagementRuntimeProvider;
  /** Optional custom ConsoleDataSource instance */
  consoleDataSource?: ConsoleDataSource;
  /** Required tenant quota defaults configuration (or provided via consoleDataSource) */
  tenantQuotaDefaults?: TenantQuotaDefaultsConfig;
  /** Explicit deployment quota defaults configuration (alias for tenantQuotaDefaults) */
  quotaDefaults?: TenantQuotaDefaultsConfig;
  /** Optional dedicated operations storage */
  operationsStorage?: SqlitePlatformOperationsStorage;
  /** Optional dedicated operations service */
  operationsService?: PlatformOperationsService;
  /** Optional dedicated task worker */
  taskWorker?: AgentPromptTaskWorker;
  /** Optional dedicated quota provider */
  quotaProvider?: TenantQuotaProvider;
  /** Optional flag to enable background AgentPromptTaskWorker */
  enableWorker?: boolean;
  /** Optional explicit worker ID */
  workerId?: string;
  /** Optional run ID used to derive worker ID */
  runId?: string;
  /** Optional tenant runtime file provider */
  fileProvider?: TenantRuntimeFileProvider;
  /** Optional runtime file API service */
  fileService?: RuntimeFileApiService;
  /** Optional agent profile API service */
  agentProfileApi?: AgentProfileApi;
  /** Optional custom HappyClaw migration service */
  happyClawMigrationService?: HappyClawMigrationService;
  /** Optional allowlisted filesystem roots for host SQLite imports */
  allowlistedImportRoots?: readonly string[];
  /** Optional staged imports directory */
  stagedImportsDir?: string;
  /** Optional runtime artifact port for inspecting/exporting/importing DSH transcripts */
  runtimeArtifactPort?: RuntimeArtifactPort;
  /** Optional attachment copy port for copying snapshots cross-space */
  attachmentCopyPort?: AttachmentCopyPort;
  /** Optional dedicated fork service */
  forkService?: ForkService;
  /** Optional dedicated session lifecycle service */
  sessionLifecycleService?: SessionLifecycleService;
  /** Optional dedicated skill catalog service */
  skillCatalogService?: SkillCatalogService;
  /** Optional dedicated extension service */
  extensionService?: ExtensionService;
  /** Optional dedicated extension routes */
  extensionRoutes?: ExtensionRoutes;
  /** Optional dedicated instructions service */
  instructionsService?: InstructionsService;
  /** Optional dedicated instructions routes */
  instructionsRoutes?: InstructionsRoutes;
  /** Optional DSH home directory for skill resolution */
  dshHome?: string;
  /** Optional spaces directory for skill resolution */
  spacesDir?: string;
  /** Optional bundled skills directory */
  bundledSkillDir?: string;
  /** Optional Git source policy for skills installation */
  gitSourcePolicy?: GitSourcePolicy;
  /** Optional Git credential resolver for skills installation */
  gitCredentialResolver?: GitCredentialResolverPort;
  /** Optional runtime diagnostics service */
  runtimeDiagnosticsService?: RuntimeDiagnosticsService;
  /** Optional audit export service */
  auditExportService?: AuditExportService;
  /** Optional usage export service */
  usageExportService?: UsageExportService;
  /** Optional task notification service */
  taskNotificationService?: TaskNotificationService;
  /** Optional webhook security options */
  webhookSecurityOptions?: WebhookSecurityOptions;
  /** Optional dedicated model selection service */
  modelSelectionService?: ModelSelectionService;
  /** Optional external interaction service for approvals and interactive questions */
  externalInteractionService?: IExternalInteractionService;
  /** Optional runtime provider registry managing multi-mode execution */
  runtimeProviderRegistry?: RuntimeProviderRegistry;
  /** Optional host runtime provider for host mode execution */
  hostProvider?: RuntimeProvider;
  /** Optional container runtime provider for container mode execution */
  containerProvider?: RuntimeProvider;
  /** Optional runtime mount reconciler for space directory mounts */
  mountReconciler?: RuntimeMountReconciler;
  /** Optional dedicated space mount service */
  spaceMountService?: SpaceMountService;
  /** Optional browser execution service */
  browserService?: BrowserService;
  /** Optional MCP execution and process pool service */
  mcpService?: PlatformProxyMcpService;
  /** Optional channel management service */
  channelService?: ChannelManagementService;
  /** Optional channel management routes */
  channelRoutes?: ChannelRoutes;
  /** Optional channel runtime manager */
  channelRuntimeManager?: ChannelRuntimeManager;
  /** Optional Lark credential resolver */
  larkCredentialResolver?: LarkCredentialResolver;
  /** Optional Lark transport factory */
  larkTransportFactory?: LarkTransportFactory;
  /** Optional Lark default space resolver */
  larkDefaultSpaceResolver?: LarkDefaultSpaceResolver;
  /** Optional Lark onboarding service */
  larkOnboardingService?: LarkOnboardingService;
  /** Optional Lark encrypted credential store */
  larkEncryptedCredentialStore?: LarkEncryptedCredentialStore;
  /** Optional explicit 0600 key file path outside workspace for Lark encrypted credentials */
  larkCredentialKeyFilePath?: string;
  /** Optional stream event source for Lark interactive reply cards */
  streamEventSource?: StreamEventSource;
}

export interface ServerAddressInfo {
  host: string;
  port: number;
  url: string;
  csrfToken: string;
}

export class PlatformServer {
  private server: Server | null = null;
  private isRunning = false;

  public readonly host: string;
  public readonly requestedPort: number;
  public readonly db: DatabaseSync;
  public readonly storage: PlatformStorage;
  public readonly operationsStorage: SqlitePlatformOperationsStorage;
  public readonly operationsService: PlatformOperationsService;
  public readonly operationsProvider: ManagementOperationsProvider;
  public readonly quotaProvider: TenantQuotaProvider;
  public readonly runtimeProviderRegistry: RuntimeProviderRegistry;
  public readonly agentProfileApi?: AgentProfileApi;
  public readonly fileProvider?: TenantRuntimeFileProvider;
  public readonly fileService?: RuntimeFileApiService;
  public readonly runtimeArtifactPort?: RuntimeArtifactPort;
  public readonly attachmentCopyPort?: AttachmentCopyPort;
  public readonly forkService?: ForkService;
  public readonly sessionLifecycleService?: SessionLifecycleService;
  public readonly taskWorker?: AgentPromptTaskWorker;
  public readonly authService: AuthService;
  public readonly messageStore: SqliteWebMessageStore;
  public readonly migrationRunner: PlatformServerMigrationRunner;
  public readonly platformApi: PlatformWebApi;
  public readonly runtimeGateway: RuntimeGateway;
  public readonly handler: HttpRequestHandler;
  public readonly limits: ServerLimitsOptions;
  public readonly csrfToken: string;
  public readonly autoRecover: boolean;
  public readonly managementProvider?: ManagementRuntimeProvider;
  public readonly consoleDataSource?: ConsoleDataSource;
  public readonly runtimeDiagnosticsService: RuntimeDiagnosticsService;
  public readonly auditExportService: AuditExportService;
  public readonly usageExportService: UsageExportService;
  public readonly taskNotificationService: TaskNotificationService;
  public readonly modelSelectionService: ModelSelectionService;
  public readonly extensionService: ExtensionService;
  public readonly extensionRoutes: ExtensionRoutes;
  public readonly skillCatalogService: SkillCatalogService;
  public readonly instructionsService: InstructionsService;
  public readonly instructionsRoutes: InstructionsRoutes;
  public readonly channelService: ChannelManagementService;
  public readonly channelRoutes: ChannelRoutes;
  public readonly channelRuntimeManager?: ChannelRuntimeManager;
  public readonly larkEncryptedCredentialStore?: LarkEncryptedCredentialStore;
  public readonly larkOnboardingService?: LarkOnboardingService;
  public readonly externalInteractionService?: IExternalInteractionService;
  public readonly mountReconciler?: RuntimeMountReconciler;
  public readonly spaceMountService?: SpaceMountService;
  public readonly browserService?: BrowserService;
  public readonly mcpService?: PlatformProxyMcpService;

  private activeSockets = new Set<import('node:net').Socket>();

  constructor(options: PlatformServerOptions) {
    if (!options || typeof options !== 'object') {
      throw new PlatformConfigurationError('PlatformServer requires an options object.');
    }

    // Validate unknown configuration options
    for (const key of Object.keys(options)) {
      if (!ALLOWED_PLATFORM_SERVER_OPTIONS.has(key)) {
        throw new PlatformConfigurationError(`Unknown configuration option "${key}" passed to PlatformServer.`);
      }
    }

    if (options.limits && typeof options.limits === 'object') {
      for (const key of Object.keys(options.limits)) {
        if (!ALLOWED_LIMITS_OPTIONS.has(key)) {
          throw new PlatformConfigurationError(`Unknown configuration option "${key}" passed to PlatformServer limits.`);
        }
      }
    }

    // Mutually exclusive dbPath and database check (xor validation)
    if (options.dbPath !== undefined && options.database !== undefined) {
      throw new PlatformConfigurationError('Cannot provide both "dbPath" and "database" options.');
    }

    // 1. Validate required runtimeGateway (no implicit fake runtime gateway default)
    if (!options.runtimeGateway) {
      throw new PlatformConfigurationError(
        'PlatformServer requires an explicit "runtimeGateway" instance. Implicit fake auto-reply default is forbidden in production.'
      );
    }
    this.runtimeGateway = options.runtimeGateway;

    // 2. Validate required cookieSecret (no hardcoded fallback credentials, min 32 chars)
    if (!options.cookieSecret || typeof options.cookieSecret !== 'string' || options.cookieSecret.trim().length < MIN_COOKIE_SECRET_LENGTH) {
      throw new PlatformConfigurationError(
        `PlatformServer requires an explicit "cookieSecret" of at least ${MIN_COOKIE_SECRET_LENGTH} characters. Hardcoded default credentials are strictly forbidden.`
      );
    }

    // 3. Validate required csrfToken (min 32 chars)
    if (!options.csrfToken || typeof options.csrfToken !== 'string' || options.csrfToken.trim().length < MIN_CSRF_TOKEN_LENGTH) {
      throw new PlatformConfigurationError(
        `PlatformServer requires an explicit "csrfToken" of at least ${MIN_CSRF_TOKEN_LENGTH} characters.`
      );
    }
    this.csrfToken = options.csrfToken;

    this.host = options.host ?? '127.0.0.1';
    this.requestedPort = options.port ?? 0;
    this.limits = {
      ...DEFAULT_SERVER_LIMITS,
      ...options.limits,
    };
    this.autoRecover = options.autoRecover ?? true;
    this.managementProvider = options.managementProvider;

    // 4. Strict safety check on host and port binding
    validateServerBinding(this.host, this.requestedPort);

    // 5. Initialize Database & Storage without executing raw DDL in constructors
    const db = options.database ?? new DatabaseSync(options.dbPath ?? ':memory:');
    this.db = db;
    this.storage = options.storage ?? new SqlitePlatformStorage(db);
    this.messageStore = new SqliteWebMessageStore(db);
    this.migrationRunner = new PlatformServerMigrationRunner(db);

    // 6. Initialize Platform Operations Storage, Service, Concrete Operations Provider & Tenant Quota Provider
    this.operationsStorage = options.operationsStorage ?? new SqlitePlatformOperationsStorage(db, {
      quotaOptions: { unconfiguredPolicy: 'fail_closed' },
    });
    this.operationsService = options.operationsService ?? createPlatformOperations({
      storage: this.operationsStorage,
    });
    this.operationsProvider = createManagementOperationsAdapter(this.operationsService);
    this.quotaProvider = options.quotaProvider ?? createOperationsTenantQuotaProvider(this.operationsService);

    // 7. Initialize Task Worker if requested or injected
    if (options.taskWorker) {
      this.taskWorker = options.taskWorker;
    } else if (options.enableWorker) {
      if (this.runtimeGateway instanceof DeliveryRuntimeGateway) {
        const dispatcher = createAgentPromptDeliveryDispatcher({
          gateway: this.runtimeGateway,
          storage: this.storage,
          database: db,
        });
        this.taskWorker = createPlatformServerTaskWorker({
          db,
          dispatcher,
          operationsStorage: this.operationsStorage,
          runId: options.runId,
          workerId: options.workerId,
        });
      }
    }

    if (options.consoleDataSource) {
      this.consoleDataSource = options.consoleDataSource;
    } else {
      const quotaDefaults = options.tenantQuotaDefaults ?? options.quotaDefaults;
      if (quotaDefaults) {
        this.consoleDataSource = new ConsoleDataSource({
          database: db,
          storage: this.storage,
          quotaDefaults,
        });
      }
    }

    if (options.authService) {
      this.authService = options.authService;
    } else {
      this.authService = new DefaultAuthService(this.storage, {
        cookieSecret: options.cookieSecret,
        cookieSecure: false, // Local dev/test on HTTP
        cookieSameSite: 'Strict',
        cookieName: 'enkeep_session',
      });
    }

    this.runtimeProviderRegistry = options.runtimeProviderRegistry ?? new RuntimeProviderRegistry();
    if (options.containerProvider) {
      this.runtimeProviderRegistry.registerProvider(options.containerProvider);
    }
    if (options.hostProvider) {
      this.runtimeProviderRegistry.registerProvider(options.hostProvider);
    }

    if (!this.runtimeProviderRegistry.hasProvider('container')) {
      const defaultTurnExecutor: DeliveryTurnExecutor = (this.runtimeGateway as any)?.executor ?? {
        execute: async () => ({ replyText: 'ok' }),
        cancel: async () => false,
      };
      this.runtimeProviderRegistry.registerProvider({
        mode: 'container',
        turnExecutor: defaultTurnExecutor,
        fileProvider: options.fileProvider,
        runtimeArtifactPort: options.runtimeArtifactPort,
        managementProvider: options.managementProvider,
      });
    }

    this.agentProfileApi = options.agentProfileApi ?? createProfileService(this.storage, db);

    const hasMultiMode = this.runtimeProviderRegistry.listModes().length > 1;
    this.fileProvider = hasMultiMode
      ? new CompositeTenantRuntimeFileProvider(this.runtimeProviderRegistry, db)
      : (options.fileProvider ?? this.runtimeProviderRegistry.getProvider('container')?.fileProvider);

    this.runtimeArtifactPort = hasMultiMode
      ? new CompositeRuntimeArtifactPort(this.runtimeProviderRegistry, db)
      : (options.runtimeArtifactPort ?? this.runtimeProviderRegistry.getProvider('container')?.runtimeArtifactPort);

    if (hasMultiMode) {
      this.managementProvider = new CompositeManagementRuntimeProvider(this.runtimeProviderRegistry);
    }

    this.attachmentCopyPort =
      options.attachmentCopyPort ??
      (this.fileProvider ? new FileProviderAttachmentCopyPort({ fileProvider: this.fileProvider, db }) : undefined);

    if (options.forkService) {
      this.forkService = options.forkService;
    } else if (this.runtimeArtifactPort && this.attachmentCopyPort) {
      this.forkService = new ForkService({
        db,
        storage: this.storage,
        runtimeArtifactPort: this.runtimeArtifactPort,
        attachmentCopyPort: this.attachmentCopyPort,
      });
    }

    this.browserService = options.browserService;
    this.mcpService = options.mcpService;

    if (options.sessionLifecycleService) {
      this.sessionLifecycleService = options.sessionLifecycleService;
      if (this.browserService) {
        this.sessionLifecycleService.setBrowserService(this.browserService);
      }
    } else if (this.runtimeArtifactPort) {
      this.sessionLifecycleService = new SessionLifecycleService({
        db,
        storage: this.storage,
        runtimeArtifactPort: this.runtimeArtifactPort,
        browserService: this.browserService,
      });
    }

    this.platformApi = options.platformApi ?? new SqlitePlatformWebApiAdapter({
      db,
      storage: this.storage,
      authService: this.authService,
      messageStore: this.messageStore,
      forkService: this.forkService,
      sessionLifecycleService: this.sessionLifecycleService,
      runtimeProviderRegistry: this.runtimeProviderRegistry,
    });

    this.fileService = options.fileService ?? (this.fileProvider ? new RuntimeFileApiService({ fileProvider: this.fileProvider, platformApi: this.platformApi, operations: this.operationsService }) : undefined);

    const migrationService =
      options.happyClawMigrationService ??
      new HappyClawMigrationService({
        db,
        storage: this.storage,
        fileProvider: this.fileProvider,
        runtimeGateway: this.runtimeGateway,
        allowlistedImportRoots: options.allowlistedImportRoots,
        stagedImportsDir: options.stagedImportsDir,
      });

    const happyClawMigrationRoutes = new HappyClawMigrationRoutes(
      migrationService,
      this.csrfToken
    );

    const extensionService =
      options.extensionService ??
      new ExtensionService(this.storage, db, {
        dshHome: options.dshHome ?? (process.env.DSH_HOME || path.join(os.homedir(), '.dsh')),
        spacesDir: options.spacesDir ?? (process.env.ENKEEP_SPACES_DIR || path.join(os.homedir(), '.enkeep', 'spaces')),
        bundledSkillDir: options.bundledSkillDir ?? (process.env.DSH_BUNDLED_SKILL_DIR || undefined),
        gitSourcePolicy: options.gitSourcePolicy,
        credentialResolver: options.gitCredentialResolver,
        browserService: this.browserService,
        mcpService: this.mcpService,
      });

    if (this.browserService) {
      extensionService.setBrowserService(this.browserService);
    }
    if (this.mcpService) {
      extensionService.setMcpService(this.mcpService);
    }
    if (this.fileProvider) {
      extensionService.setFileProvider(this.fileProvider);
    }

    const extensionRoutes =
      options.extensionRoutes ??
      new ExtensionRoutes(extensionService, this.csrfToken);

    this.extensionService = extensionService;
    this.extensionRoutes = extensionRoutes;

    const skillCatalogService =
      options.skillCatalogService ??
      new SkillCatalogService(extensionService);

    const instructionsService =
      options.instructionsService ??
      new InstructionsService({
        storage: this.storage,
        db,
        fileProvider: this.fileProvider,
        operations: this.operationsService,
      });

    const instructionsRoutes =
      options.instructionsRoutes ??
      new InstructionsRoutes(instructionsService, {
        expectedCsrfToken: this.csrfToken,
      });

    this.runtimeDiagnosticsService =
      options.runtimeDiagnosticsService ??
      new RuntimeDiagnosticsService({
        db,
      });

    this.auditExportService =
      options.auditExportService ??
      new AuditExportService(db);

    this.usageExportService =
      options.usageExportService ??
      new UsageExportService(db);

    this.taskNotificationService =
      options.taskNotificationService ??
      new TaskNotificationService({
        db,
        securityOptions: options.webhookSecurityOptions,
        cipherKey: options.cookieSecret,
      });

    this.modelSelectionService =
      options.modelSelectionService ??
      new ModelSelectionService({
        db,
        operations: this.operationsService,
      });

    this.skillCatalogService = skillCatalogService;
    this.instructionsService = instructionsService;
    this.instructionsRoutes = instructionsRoutes;
    this.externalInteractionService = options.externalInteractionService;

    this.mountReconciler = options.mountReconciler;
    this.spaceMountService =
      options.spaceMountService ??
      new SpaceMountService({
        db,
        storage: this.storage,
        cipherSecret: options.cookieSecret,
        platformSecret: options.cookieSecret,
        reconciler: options.mountReconciler,
      });

    if (this.runtimeGateway instanceof DeliveryRuntimeGateway && !this.runtimeGateway.getMountResolver()) {
      this.runtimeGateway.setMountResolver(this.spaceMountService);
    }
    if (this.runtimeGateway instanceof DeliveryRuntimeGateway && !this.runtimeGateway.getExtensionResolver()) {
      this.runtimeGateway.setExtensionResolver(this.extensionService);
    }

    this.larkEncryptedCredentialStore =
      options.larkEncryptedCredentialStore ??
      new LarkEncryptedCredentialStore({
        cipherSecret: options.cookieSecret,
        keyFilePath: options.larkCredentialKeyFilePath,
        db,
      });

    const effectiveLarkCredentialResolver: LarkCredentialResolver = {
      resolve: async (userId: string, credentialRef: string) => {
        if (options.larkCredentialResolver) {
          const res = await options.larkCredentialResolver.resolve(userId, credentialRef);
          if (res) return res;
        }
        return this.larkEncryptedCredentialStore ? this.larkEncryptedCredentialStore.resolve(userId, credentialRef) : null;
      },
    };

    this.channelService =
      options.channelService ??
      new ChannelManagementService(this.storage, undefined);

    let defaultSpaceResolver = options.larkDefaultSpaceResolver;

    this.larkOnboardingService =
      options.larkOnboardingService ??
      new LarkOnboardingService(
        this.storage,
        this.larkEncryptedCredentialStore!,
        this.channelService,
        undefined,
        effectiveLarkCredentialResolver
      );

    if (!defaultSpaceResolver) {
      defaultSpaceResolver = async (userId: string, account: ChannelAccount) => {
        if (account.defaultSpaceId !== undefined) {
          return account.defaultSpaceId ?? undefined;
        }
        return this.larkOnboardingService ? this.larkOnboardingService.resolveDefaultSpace(userId, account) : undefined;
      };
    }

    this.channelRuntimeManager =
      options.channelRuntimeManager ??
      (this.runtimeGateway instanceof DeliveryRuntimeGateway
        ? new ChannelRuntimeManager({
            storage: this.storage,
            db,
            deliveryGateway: this.runtimeGateway,
            credentialResolver: effectiveLarkCredentialResolver,
            transportFactory: options.larkTransportFactory,
            defaultSpaceResolver,
            streamEventSource:
              options.streamEventSource ??
              (options.larkTransportFactory ? undefined : new SqliteStreamEventSource(db)),
          })
        : undefined);

    // Re-bind runtimeManager to channelService and larkOnboardingService
    (this.channelService as any).runtimeManager = this.channelRuntimeManager;
    (this.larkOnboardingService as any).runtimeManager = this.channelRuntimeManager;

    this.channelRoutes =
      options.channelRoutes ??
      new ChannelRoutes(this.channelService, this.csrfToken, this.larkOnboardingService);

    // 8. Construct HTTP Request Handler with all injected and adapted operational services
    this.handler = createPlatformServerHandler({
      database: db,
      storage: this.storage as SqlitePlatformStorage,
      authService: this.authService,
      platformApi: this.platformApi,
      runtimeGateway: this.runtimeGateway,
      csrfToken: this.csrfToken,
      limits: this.limits,
      managementProvider: this.managementProvider,
      consoleDataSource: this.consoleDataSource,
      operations: this.operationsService,
      operationsProvider: this.operationsProvider,
      taskWorker: this.taskWorker,
      fileProvider: this.fileProvider,
      fileService: this.fileService,
      agentProfileApi: this.agentProfileApi,
      happyClawMigrationRoutes,
      extensionRoutes,
      instructionsRoutes,
      channelRoutes: this.channelRoutes,
      runtimeDiagnosticsService: this.runtimeDiagnosticsService,
      auditExportService: this.auditExportService,
      usageExportService: this.usageExportService,
      taskNotificationService: this.taskNotificationService,
      sessionLifecycleService: this.sessionLifecycleService,
      runtimeArtifactPort: this.runtimeArtifactPort,
      externalInteractionService: options.externalInteractionService,
      spaceMountService: this.spaceMountService,
      browserService: this.browserService,
      mcpService: this.mcpService,
    });
  }

  /**
   * Starts the HTTP server on strictly verified 127.0.0.1 loopback host.
   * Executes combined schema migrations and startup recovery before accepting requests.
   *
   * Startup sequence:
   * 1. Validate binding host and port
   * 2. Run versioned database migrations
   * 3. Perform startup recovery and redrive (schedules held turns; worker unrelated)
   * 4. Create HTTP server instance (no bind)
   * 5. Start background task worker (if worker start fails, listener is zero)
   * 6. Bind HTTP listener
   * 7. Validate address binding after listen
   */
  async start(): Promise<ServerAddressInfo> {
    if (this.isRunning && this.server) {
      const addr = this.server.address();
      if (!addr || typeof addr === 'string' || typeof addr.port !== 'number' || !Number.isInteger(addr.port)) {
        throw new PlatformConfigurationError('Server is running but has no valid TCP port address.');
      }
      return {
        host: addr.address,
        port: addr.port,
        url: `http://${addr.address}:${addr.port}`,
        csrfToken: this.csrfToken,
      };
    }

    // 1. Double validate binding host & port
    validateServerBinding(this.host, this.requestedPort);

    // 2. Execute full versioned migrations (including platform storage builtin migrations + platform-server migrations)
    await this.migrationRunner.migrate(ALL_PLATFORM_MIGRATIONS);

    // 2b. Failclosed check for host execution mode records if HostProvider is unavailable
    const hostSpacesCount = (this.db.prepare("SELECT COUNT(*) as c FROM spaces WHERE execution_mode = 'host'").get() as { c: number } | undefined)?.c ?? 0;
    const hostRoutesCount = (this.db.prepare("SELECT COUNT(*) as c FROM session_routes WHERE execution_mode = 'host'").get() as { c: number } | undefined)?.c ?? 0;

    if (hostSpacesCount > 0 || hostRoutesCount > 0) {
      if (!this.runtimeProviderRegistry.hasProvider('host')) {
        throw new PlatformConfigurationError(
          `FAIL-CLOSED: Database contains host execution mode records (${hostSpacesCount} space(s), ${hostRoutesCount} session route(s) with execution_mode='host'), ` +
          `but no HostProvider is configured on platform server. Please configure a valid HostProvider or migrate spaces to container mode.`
        );
      }
    }

    // 2c. Startup mount reconciliation & Fail-closed check if space_mounts exist without reconciler
    if (this.spaceMountService) {
      await this.spaceMountService.reconcileAllActiveMountsOnStartup();
    }

    // 2d. Synchronize compiled trusted DSH plugin registry into SQLite for all tenants
    if (this.extensionService) {
      await this.extensionService.syncAllTenantsTrustedPlugins();
    }

    // 3. Perform startup recovery & redrive BEFORE creating server or binding listen socket.
    // Recovery redrive schedules held turns; worker is unrelated.
    // If runtimeGateway satisfies Drainable with redriveHeld, call ONLY redriveHeld()
    // (which owns recoverDanglingDeliveriesOnStartup). Else call storage.recoverAfterRestart only.
    if (this.autoRecover) {
      if (isDrainableRuntimeGateway(this.runtimeGateway)) {
        await this.runtimeGateway.redriveHeld();
      } else {
        await this.storage.recoverAfterRestart({
          interruptedReason: 'Recovered after platform-server restart',
        });
      }

      // Recover operations leases & stale reservations
      await this.operationsStorage.recoverAfterRestart();
    }

    // Clean up stale ephemeral git / skill staging directories on startup
    const staleCleanup = cleanupStaleGitTempDirs();
    if (staleCleanup.errors.length > 0) {
      throw new PlatformConfigurationError(
        `Failed to clean up stale ephemeral temp directories on startup (${staleCleanup.errors.length} error(s), primary code: ${staleCleanup.errors[0].code}).`
      );
    }

    // 4. Create HTTP server instance without binding
    const server = createServer((req, res) => {
      // Set security headers immediately on every response before handler or timeout
      for (const [key, value] of Object.entries(DEFAULT_SECURITY_HEADERS)) {
        res.setHeader(key, value);
      }
      for (const [key, value] of Object.entries(API_CACHE_CONTROL_HEADERS)) {
        res.setHeader(key, value);
      }

      // Set request timeout
      const timeoutMs = this.limits.requestTimeoutMs ?? DEFAULT_SERVER_LIMITS.requestTimeoutMs;
      req.setTimeout(timeoutMs, () => {
        if (!res.headersSent) {
          const body = JSON.stringify({
            success: false,
            error: { code: 'REQUEST_TIMEOUT', message: 'Request timeout exceeded', status: 408 },
          });
          res.writeHead(408, {
            ...DEFAULT_SECURITY_HEADERS,
            ...API_CACHE_CONTROL_HEADERS,
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body, 'utf-8'),
            'Connection': 'close',
          });
          res.end(body, () => {
            req.socket?.destroy();
          });
        } else {
          req.socket?.destroy();
        }
      });

      this.handler(req, res).catch((err: unknown) => {
        if (process.env.DEBUG_SERVER_ERRORS) {
          console.error("SERVER HANDLER ERROR:", err);
        }
        if (!res.headersSent) {
          const body = JSON.stringify({
            success: false,
            error: { code: 'INTERNAL_ERROR', message: 'Internal server error', status: 500 },
          });
          res.writeHead(500, {
            ...DEFAULT_SECURITY_HEADERS,
            ...API_CACHE_CONTROL_HEADERS,
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body, 'utf-8'),
          });
          res.end(body);
        }
      });
    });

    this.server = server;

    // Track active sockets for clean shutdown
    server.on('connection', (socket) => {
      this.activeSockets.add(socket);
      socket.on('close', () => {
        this.activeSockets.delete(socket);
      });
    });

    let workerStarted = false;
    let listenerBound = false;

    try {
      // 4.5 Recover pending file transfer journals and attachment snapshot journals before listener binds
      if (this.fileService || this.fileProvider) {
        if (this.fileService) {
          const recoveryService = new FileTransferRecoveryService(this.db, this.fileService);
          const report = await recoveryService.recoverAll();
          if (report.errors.length > 0) {
            const codes = Array.from(new Set(report.errors.map((e) => e.code))).join(', ');
            throw new PlatformConfigurationError(
              `PlatformServer startup failed during file transfer journal recovery: ${report.errors.length} unrecoverable error(s) encountered (codes: ${codes}).`
            );
          }
        }

        const attRecovery = new AttachmentSnapshotRecoveryService(this.db, {
          fileService: this.fileService,
          fileProvider: this.fileProvider,
        });
        const attReport = await attRecovery.recover();
        if (attReport.errors.length > 0) {
          const codes = Array.from(new Set(attReport.errors.map((e) => e.code))).join(', ');
          throw new PlatformConfigurationError(
            `PlatformServer startup failed during attachment snapshot journal recovery: ${attReport.errors.length} unrecoverable error(s) encountered (codes: ${codes}).`
          );
        }
      } else {
        // Preflight check: If no fileService/fileProvider is configured, fail startup if any pending journal entries exist
        const pendingCountRow = this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM file_transfer_journal
          WHERE status IN ('staged', 'committed', 'cleanup_pending')
        `).get() as { count: number } | undefined;

        if (pendingCountRow && pendingCountRow.count > 0) {
          throw new PlatformConfigurationError(
            `Cannot start PlatformServer with ${pendingCountRow.count} unrecovered pending file transfer records when fileProvider/fileService is not configured.`
          );
        }

        const pendingAttCountRow = this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM attachment_snapshot_journal
          WHERE status IN ('staging', 'copied', 'cleanup_pending')
        `).get() as { count: number } | undefined;

        if (pendingAttCountRow && pendingAttCountRow.count > 0) {
          throw new PlatformConfigurationError(
            `Cannot start PlatformServer with ${pendingAttCountRow.count} unrecovered pending attachment snapshot records when fileProvider/fileService is not configured.`
          );
        }
      }

      // 4c. Reconcile any unfinalized seeded fork operations
      if (this.forkService) {
        await this.forkService.reconcilePendingOperations();
      }

      // 4d. Initialize and health-check browserService before binding listener
      if (this.browserService) {
        try {
          await this.browserService.initialize();
          const health = await this.browserService.checkHealth();
          if (health.status !== 'healthy') {
            throw new PlatformConfigurationError(
              'Browser service health check failed after initialization.',
              'BROWSER_UNAVAILABLE'
            );
          }
        } catch (browserErr: unknown) {
          if (browserErr instanceof PlatformConfigurationError && browserErr.code === 'BROWSER_UNAVAILABLE') {
            throw browserErr;
          }
          throw new PlatformConfigurationError(
            'Browser service failed to initialize or is unavailable.',
            'BROWSER_UNAVAILABLE'
          );
        }
      }

      // 5. Start background task worker BEFORE listener binds (if worker start fails, listener remains zero)
      if (this.taskWorker) {
        await this.taskWorker.start();
        workerStarted = true;
      }

      this.runtimeDiagnosticsService.startCleanupWorker();
      this.taskNotificationService.startRetryWorker();

      // 5.5 Start channel runtime manager
      if (this.channelRuntimeManager) {
        await this.channelRuntimeManager.start();
      }

      // 6. Bind listener
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.requestedPort, this.host, () => {
          server.removeListener('error', reject);
          listenerBound = true;
          resolve();
        });
      });

      // 7. Validate address binding after listen (if validation fails, rollback listener and worker)
      const addr = server.address();
      if (!addr || typeof addr === 'string' || typeof addr.port !== 'number' || !Number.isInteger(addr.port)) {
        throw new PlatformConfigurationError('Server started but failed to obtain a valid TCP port address.');
      }
      validateServerBinding(addr.address, addr.port);

      this.isRunning = true;

      return {
        host: addr.address,
        port: addr.port,
        url: `http://${addr.address}:${addr.port}`,
        csrfToken: this.csrfToken,
      };
    } catch (startupErr: unknown) {
      const rollbackErrors: Error[] = [];
      const primaryErr = startupErr instanceof Error ? startupErr : new Error('PlatformServer startup failed', { cause: startupErr });

      // Roll back worker if started
      if (workerStarted && this.taskWorker) {
        try {
          await this.taskWorker.stop({ abortInFlight: true });
        } catch (workerStopErr: unknown) {
          rollbackErrors.push(
            workerStopErr instanceof Error
              ? workerStopErr
              : new Error('Task worker stop failed during rollback', { cause: workerStopErr })
          );
        }
      }

      // Destroy active sockets
      for (const socket of this.activeSockets) {
        try {
          socket.destroy();
        } catch (sockErr: unknown) {
          rollbackErrors.push(
            sockErr instanceof Error
              ? sockErr
              : new Error('Socket destruction failed during rollback', { cause: sockErr })
          );
        }
      }
      this.activeSockets.clear();

      // Close server if listener was bound
      if (listenerBound) {
        try {
          await new Promise<void>((resolve, reject) => {
            server.close((closeErr) => {
              if (closeErr) return reject(closeErr);
              resolve();
            });
          });
        } catch (closeErr: unknown) {
          rollbackErrors.push(
            closeErr instanceof Error
              ? closeErr
              : new Error('Server close failed during rollback', { cause: closeErr })
          );
        }
      }

      // Dispose browserService if configured
      if (this.browserService) {
        try {
          await this.browserService.dispose();
        } catch (bErr: unknown) {
          rollbackErrors.push(
            bErr instanceof Error
              ? bErr
              : new Error('Browser service disposal failed during rollback', { cause: bErr })
          );
        }
      }

      // Dispose mcpService if configured
      if (this.mcpService) {
        try {
          if (typeof this.mcpService.dispose === 'function') {
            await this.mcpService.dispose();
          } else if (typeof this.mcpService.close === 'function') {
            await this.mcpService.close();
          }
        } catch (mErr: unknown) {
          rollbackErrors.push(
            mErr instanceof Error
              ? mErr
              : new Error('MCP service disposal failed during rollback', { cause: mErr })
          );
        }
      }

      this.isRunning = false;
      this.server = null;

      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [primaryErr, ...rollbackErrors],
          'PlatformServer startup failed with rollback errors.'
        );
      }
      throw primaryErr;
    }
  }

  /**
   * Stops the HTTP server and cleans up active connections and background workers.
   *
   * Shutdown sequence:
   * 1. Initiate closing the HTTP server listener so no new connections are accepted (capture pending promise)
   * 2. Stop background task worker with abortInFlight: true
   * 3. Drain in-flight gateway turns before destroying sockets
   * 4. Destroy remaining client sockets only after drain completes (or fails/times out)
   * 5. Await server close promise
   * 6. Collect all errors with fixed messages and throw AggregateError if multiple
   */
  async stop(options?: { abrupt?: boolean }): Promise<void> {
    if (!this.server && !this.isRunning) {
      return;
    }

    const errors: Error[] = [];
    const isAbrupt = options?.abrupt === true;

    try {
      // 1. Initiate closing the HTTP server listener and capture promise without await
      let closePromise: Promise<void> | null = null;
      if (this.server) {
        const s = this.server;
        closePromise = new Promise<void>((resolve, reject) => {
          s.close((err) => {
            if (err) return reject(err);
            resolve();
          });
        });
      }

      // 2. Stop background task worker with abortInFlight: true
      if (this.taskWorker) {
        try {
          await this.taskWorker.stop({ abortInFlight: true });
        } catch (workerErr: unknown) {
          errors.push(
            workerErr instanceof Error
              ? workerErr
              : new Error('Task worker stop failed during shutdown', { cause: workerErr })
          );
        }
      }

      this.runtimeDiagnosticsService.stopCleanupWorker();
      this.taskNotificationService.stopRetryWorker();

      // 2.5 Stop channel runtime manager
      if (this.channelRuntimeManager) {
        try {
          await this.channelRuntimeManager.stop();
        } catch (crmErr: unknown) {
          errors.push(
            crmErr instanceof Error
              ? crmErr
              : new Error('Channel runtime manager stop failed during shutdown', { cause: crmErr })
          );
        }
      }

      // 3. Drain in-flight turns if gateway implements DrainableRuntimeGateway BEFORE destroying sockets (skip if abrupt)
      if (!isAbrupt && isDrainableRuntimeGateway(this.runtimeGateway)) {
        try {
          if (typeof (this.runtimeGateway as any).close === 'function') {
            await (this.runtimeGateway as any).close();
          } else {
            await this.runtimeGateway.drain(3000);
          }
        } catch (drainErr: unknown) {
          errors.push(
            drainErr instanceof Error
              ? drainErr
              : new Error('Runtime gateway drain failed during shutdown', { cause: drainErr })
          );
        }
      }

      // 4. Destroy remaining active client sockets only after drain settles
      for (const socket of this.activeSockets) {
        try {
          socket.destroy();
        } catch (sockErr: unknown) {
          errors.push(
            sockErr instanceof Error
              ? sockErr
              : new Error('Socket destruction failed during shutdown', { cause: sockErr })
          );
        }
      }
      this.activeSockets.clear();

      // 5. Await server close promise
      if (closePromise) {
        try {
          await closePromise;
        } catch (closeErr: unknown) {
          errors.push(
            closeErr instanceof Error
              ? closeErr
              : new Error('Server close failed during shutdown', { cause: closeErr })
          );
        }
      }

      // 6. Dispose browser service if configured
      if (this.browserService) {
        try {
          await this.browserService.dispose();
        } catch (bErr: unknown) {
          errors.push(
            bErr instanceof Error
              ? bErr
              : new Error('Browser service disposal failed during shutdown', { cause: bErr })
          );
        }
      }

      // 7. Dispose MCP service if configured
      if (this.mcpService) {
        try {
          if (typeof this.mcpService.dispose === 'function') {
            await this.mcpService.dispose();
          } else if (typeof this.mcpService.close === 'function') {
            await this.mcpService.close();
          }
        } catch (mErr: unknown) {
          errors.push(
            mErr instanceof Error
              ? mErr
              : new Error('MCP service disposal failed during shutdown', { cause: mErr })
          );
        }
      }
    } finally {
      this.isRunning = false;
      this.server = null;
    }

    if (errors.length === 1) {
      throw errors[0];
    } else if (errors.length > 1) {
      throw new AggregateError(
        errors,
        'Multiple errors occurred during PlatformServer shutdown.'
      );
    }
  }

  getPort(): number {
    if (!this.server || !this.isRunning) {
      return this.requestedPort;
    }
    const addr = this.server.address();
    if (!addr || typeof addr === 'string' || typeof addr.port !== 'number' || !Number.isInteger(addr.port)) {
      throw new PlatformConfigurationError('Server is running but has no valid TCP port address.');
    }
    return addr.port;
  }

  getUrl(): string {
    const port = this.getPort();
    return `http://${this.host}:${port}`;
  }
}

/**
 * Helper to create and start a PlatformServer in one step.
 */
export async function createPlatformServer(options: PlatformServerOptions): Promise<{
  server: PlatformServer;
  address: ServerAddressInfo;
}> {
  const server = new PlatformServer(options);
  const address = await server.start();
  return {
    server,
    address,
  };
}
