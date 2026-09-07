import type {
  User,
  UserRole,
  UserStatus,
  UserSession,
  AuthAuditLog,
  ExecutionMode,
  DeliveryInboxEntry,
  MigrationRecord,
  MigrationDefinition,
  ExtensionActivationPlan,
  BrowserOpenOptions,
  BrowserOpenResult,
  BrowserSnapshotOptions,
  BrowserSnapshotResult,
  BrowserInteractOptions,
  BrowserInteractResult,
  BrowserScreenshotOptions,
  BrowserScreenshotResult,
  BrowserCloseOptions,
  BrowserCloseResult,
  BrowserServiceHealth,
  PlatformProxyMcpService,
  McpContributionReconciler,
  McpProxyContext,
  McpToolDefinition,
  McpToolCallResult,
  McpServerHealth,
} from '../types/index.js';
import type {
  UserRepository,
  UserSessionRepository,
  AuthAuditLogRepository,
  TenantScopedSpaceRepository,
  TenantScopedSessionRouteRepository,
  TenantScopedSessionSourceRepository,
  TenantScopedDeliveryReceiptRepository,
  TenantScopedDeliveryInboxRepository,
  TenantScopedEventCursorRepository,
  TenantScopedTurnRunRepository,
  TenantScopedAgentProfileRepository,
  TenantScopedSessionGenerationRepository,
  TenantScopedExtensionPackageRepository,
  TenantScopedExtensionBindingRepository,
  TenantScopedSkillPackageRepository,
  TenantScopedSkillBindingRepository,
  TenantScopedSkillOperationRepository,
  TenantScopedSpaceMountRepository,
  TenantScopedChannelRepository,
} from './repositories.js';

export interface RuntimeMountSpec {
  readonly id: string;
  readonly name: string;
  readonly sourcePath: string;
  readonly mode: 'ro' | 'rw';
}

export interface RuntimeMountResolver {
  resolveForSpace(userId: string, platformSpaceId: string): Promise<readonly RuntimeMountSpec[]>;
}

export interface ExtensionPlanResolver {
  resolveForSpace(userId: string, platformSpaceId: string): Promise<ExtensionActivationPlan>;
}

export interface MountSourcePreflightContext {
  readonly dataRoot?: string;
  readonly dshHome?: string;
  readonly spacesDir?: string;
  readonly runDir?: string;
  readonly protectedRoots?: readonly string[];
}

export interface MountSourcePreflightResult {
  readonly realPath: string;
  readonly dev?: number;
  readonly ino?: number;
}

export interface RuntimeMountReconciler {
  preflightSource(
    sourcePath: string,
    context?: MountSourcePreflightContext
  ): Promise<MountSourcePreflightResult>;

  reconcileUserMounts(
    userId: string,
    mode: 'host' | 'container',
    mountsBySpace: Map<string, RuntimeMountSpec[]> | Record<string, RuntimeMountSpec[]>
  ): Promise<void>;
}

export interface MigrationRunner {
  migrate(migrations?: MigrationDefinition[]): Promise<MigrationRecord[]>;
  getAppliedMigrations(): Promise<MigrationRecord[]>;
  getCurrentVersion(): Promise<number>;
  verifyChecksums(migrations: MigrationDefinition[]): Promise<void>;
}

export interface PlatformStorage {
  readonly users: UserRepository;
  readonly sessions: UserSessionRepository;
  readonly auditLogs: AuthAuditLogRepository;

  // Tenant-scoped factory
  forTenant(userId: string): {
    readonly spaces: TenantScopedSpaceRepository;
    readonly sessionRoutes: TenantScopedSessionRouteRepository;
    readonly sessionSources: TenantScopedSessionSourceRepository;
    readonly deliveryReceipts: TenantScopedDeliveryReceiptRepository;
    readonly deliveryInbox: TenantScopedDeliveryInboxRepository;
    readonly eventCursors: TenantScopedEventCursorRepository;
    readonly turnRuns: TenantScopedTurnRunRepository;
    readonly agentProfiles: TenantScopedAgentProfileRepository;
    readonly sessionGenerations: TenantScopedSessionGenerationRepository;
    readonly skillPackages: TenantScopedSkillPackageRepository;
    readonly skillBindings: TenantScopedSkillBindingRepository;
    readonly skillOperations: TenantScopedSkillOperationRepository;
    readonly extensionPackages: TenantScopedExtensionPackageRepository;
    readonly extensionBindings: TenantScopedExtensionBindingRepository;
    readonly spaceMounts: TenantScopedSpaceMountRepository;
    readonly channels: TenantScopedChannelRepository;
    readonly permissionPresets?: unknown;
  };

  readonly migrations: MigrationRunner;

  // Global recovery & held drainage actions
  listAllHeldDeliveries(options?: { limit?: number }): Promise<DeliveryInboxEntry[]>;
  recoverAfterRestart(options?: { interruptedReason?: string }): Promise<{
    interruptedTurnRuns: number;
    heldDeliveries: DeliveryInboxEntry[];
  }>;
  close(): Promise<void>;
}

export interface AuthContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface SessionAuthResult {
  authenticated: boolean;
  user?: User;
  session?: UserSession;
  error?: string;
}

export interface LoginResult {
  user: User;
  session: UserSession;
  sessionToken: string;
  cookieHeader: string;
}

export interface RotateSessionResult {
  session: UserSession;
  sessionToken: string;
  cookieHeader: string;
}

export interface AuthServiceConfig {
  cookieSecret: string;
  sessionTtlSeconds?: number;
  cookieName?: string;
  cookieSecure?: boolean;
  cookieSameSite?: 'Strict' | 'Lax' | 'None';
  cookiePath?: string;
}

export interface AuthService {
  hashPassword(plaintext: string): Promise<string>;
  verifyPassword(plaintext: string, hash: string): Promise<boolean>;
  login(username: string, password: string, context?: AuthContext): Promise<LoginResult>;
  authenticateCookie(cookieHeader: string, context?: AuthContext): Promise<SessionAuthResult>;
  authenticateToken(sessionId: string, token: string, context?: AuthContext): Promise<SessionAuthResult>;
  revokeSession(sessionId: string, revokedAt?: string): Promise<void>;
  revokeAllUserSessions(userId: string, revokedAt?: string): Promise<number>;
  logout(sessionId: string, context?: AuthContext): Promise<void>;
  createSession(userId: string, context?: AuthContext): Promise<RotateSessionResult>;
  rotateSession(userId: string, context?: AuthContext): Promise<RotateSessionResult>;
}

export interface BrowserService {
  initialize(): Promise<void>;
  open(options: BrowserOpenOptions): Promise<BrowserOpenResult>;
  snapshot(options: BrowserSnapshotOptions): Promise<BrowserSnapshotResult>;
  interact(options: BrowserInteractOptions): Promise<BrowserInteractResult>;
  screenshot(options: BrowserScreenshotOptions): Promise<BrowserScreenshotResult>;
  close(options?: BrowserCloseOptions): Promise<BrowserCloseResult>;
  checkHealth(): Promise<BrowserServiceHealth>;
  dispose(): Promise<void>;
}

export type {
  PlatformProxyMcpService,
  McpContributionReconciler,
  McpProxyContext,
  McpToolDefinition,
  McpToolCallResult,
  McpServerHealth,
};


