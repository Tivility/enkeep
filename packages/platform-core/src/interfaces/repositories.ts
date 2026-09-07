import type {
  User,
  CreateUserInput,
  UpdateUserInput,
  UserSession,
  CreateUserSessionInput,
  UpdateUserSessionInput,
  AuthAuditLog,
  CreateAuthAuditLogInput,
  Space,
  CreateSpaceInput,
  UpdateSpaceInput,
  SessionRoute,
  CreateSessionRouteInput,
  UpdateSessionRouteInput,
  ResetSessionRouteInput,
  SessionSource,
  CreateSessionSourceInput,
  DeliveryReceipt,
  CreateDeliveryReceiptInput,
  UpdateDeliveryReceiptStatusInput,
  DeliveryInboxEntry,
  IngestDeliveryInboxInput,
  IngestDeliveryResult,
  UpdateDeliveryInboxStatusInput,
  EventCursor,
  TurnRun,
  CreateTurnRunInput,
  UpdateTurnRunStatusInput,
  AgentProfile,
  AgentProfileSnapshot,
  AgentProfileWithSnapshot,
  CreateAgentProfileInput,
  UpdateAgentProfileInput,
  CreateAgentProfileVersionInput,
  RollbackAgentProfileVersionInput,
  EffectiveAgentProfile,
  LifecycleStatus,
  SessionGeneration,
  CreateSessionGenerationInput,
  ExtensionKind,
  ExtensionSourceKind,
  ExtensionPackageStatus,
  ExtensionContributionStatus,
  ExtensionPackageRecord,
  ExtensionVersionRecord,
  ExtensionContributionRecord,
  ExtensionBindingRecord,
  SkillPackage,
  SkillPackageVersion,
  SkillBinding,
  SkillOperation,
  SkillScope,
  SpaceMount,
  CreateSpaceMountInput,
  SkillStatus,
  SkillOperationStatus,
  TenantScopedChannelRepository,
} from '../types/index.js';

export type { TenantScopedChannelRepository };

export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByUsername(username: string): Promise<User | null>;
  create(input: CreateUserInput): Promise<User>;
  update(id: string, input: UpdateUserInput): Promise<User>;
  list(options?: { role?: string; status?: string; limit?: number; offset?: number }): Promise<User[]>;
  count(): Promise<number>;
}

export interface UserSessionRepository {
  findById(id: string): Promise<UserSession | null>;
  findByTokenHash(tokenHash: string): Promise<UserSession | null>;
  create(input: CreateUserSessionInput): Promise<UserSession>;
  update(id: string, input: UpdateUserSessionInput): Promise<UserSession>;
  revoke(id: string, revokedAt?: string): Promise<void>;
  revokeAllForUser(userId: string, revokedAt?: string): Promise<number>;
  deleteExpired(now?: string): Promise<number>;
  listByUserId(userId: string, activeOnly?: boolean): Promise<UserSession[]>;
}

export interface AuthAuditLogRepository {
  create(input: CreateAuthAuditLogInput): Promise<AuthAuditLog>;
  listByUserId(userId: string, options?: { limit?: number; offset?: number }): Promise<AuthAuditLog[]>;
  listRecent(options?: { limit?: number; offset?: number; action?: string }): Promise<AuthAuditLog[]>;
  countRecentFailures?(options: { username?: string; ipAddress?: string; windowSeconds?: number }): Promise<number>;
}

export interface TenantScopedSpaceRepository {
  readonly userId: string;
  findById(id: string): Promise<Space | null>;
  findByFolder(folder: string): Promise<Space | null>;
  create(input: Omit<CreateSpaceInput, 'userId'>): Promise<Space>;
  update(id: string, input: UpdateSpaceInput): Promise<Space>;
  archive(id: string): Promise<Space>;
  restore(id: string): Promise<Space>;
  delete(id: string): Promise<boolean>;
  list(options?: { status?: LifecycleStatus; limit?: number; offset?: number }): Promise<Space[]>;
  resolveAgentProfile(spaceId: string): Promise<EffectiveAgentProfile>;
}

export interface TenantScopedSessionRouteRepository {
  readonly userId: string;
  findById(id: string): Promise<SessionRoute | null>;
  findByRouteIdentity(channel: string, accountId: string, nativeContextId: string): Promise<SessionRoute | null>;
  findByPeer(channel: string, peerId: string): Promise<SessionRoute | null>;
  findByDshSessionId(dshSessionId: string): Promise<SessionRoute | null>;
  create(input: Omit<CreateSessionRouteInput, 'userId'>): Promise<SessionRoute>;
  update(id: string, input: UpdateSessionRouteInput): Promise<SessionRoute>;
  reset(id: string, input: ResetSessionRouteInput): Promise<{ route: SessionRoute; generation: SessionGeneration }>;
  archive(id: string): Promise<SessionRoute>;
  restore(id: string): Promise<SessionRoute>;
  delete(id: string): Promise<boolean>;
  listBySpaceId(spaceId: string, options?: { status?: LifecycleStatus }): Promise<SessionRoute[]>;
  countBySpaceId(spaceId: string, options?: { status?: LifecycleStatus }): Promise<number>;
  list(options?: { status?: LifecycleStatus; limit?: number; offset?: number }): Promise<SessionRoute[]>;
  resolveAgentProfile(routeId: string): Promise<EffectiveAgentProfile>;
}

export interface TenantScopedSessionSourceRepository {
  readonly userId: string;
  findById(id: string): Promise<SessionSource | null>;
  findBySource(sourceType: string, sourceId: string): Promise<SessionSource | null>;
  create(input: Omit<CreateSessionSourceInput, 'userId'>): Promise<SessionSource>;
  listByRouteId(routeId: string): Promise<SessionSource[]>;
}

export interface TenantScopedDeliveryReceiptRepository {
  readonly userId: string;
  findById(id: string): Promise<DeliveryReceipt | null>;
  findByDeliveryId(deliveryId: string): Promise<DeliveryReceipt | null>;
  create(input: Omit<CreateDeliveryReceiptInput, 'userId'>): Promise<DeliveryReceipt>;
  updateStatus(id: string, input: UpdateDeliveryReceiptStatusInput): Promise<DeliveryReceipt>;
  listPending(options?: { limit?: number }): Promise<DeliveryReceipt[]>;
  listByRouteId(routeId: string): Promise<DeliveryReceipt[]>;
}

export interface TenantScopedDeliveryInboxRepository {
  readonly userId: string;
  findById(id: string): Promise<DeliveryInboxEntry | null>;
  findByDeliveryId(deliveryId: string): Promise<DeliveryInboxEntry | null>;
  ingest(input: Omit<IngestDeliveryInboxInput, 'userId'>): Promise<IngestDeliveryResult>;
  claimHeld(id: string): Promise<DeliveryInboxEntry | null>;
  releaseToHeld(id: string, error?: string): Promise<DeliveryInboxEntry>;
  markDelivered(id: string, processedAt?: string): Promise<DeliveryInboxEntry>;
  markDuplicate(id: string, error?: string): Promise<DeliveryInboxEntry>;
  markCancelled(id: string, error?: string): Promise<DeliveryInboxEntry>;
  updateStatus(id: string, input: UpdateDeliveryInboxStatusInput): Promise<DeliveryInboxEntry>;
  listHeld(options?: { limit?: number }): Promise<DeliveryInboxEntry[]>;
  listProcessing(options?: { limit?: number }): Promise<DeliveryInboxEntry[]>;
  listByRouteId(routeId: string, options?: { limit?: number; offset?: number }): Promise<DeliveryInboxEntry[]>;
}

export interface TenantScopedEventCursorRepository {
  readonly userId: string;
  getCursor(routeId: string, consumer?: string): Promise<EventCursor | null>;
  setCursor(routeId: string, cursorValue: string, consumer?: string): Promise<EventCursor>;
  listByRouteId(routeId: string): Promise<EventCursor[]>;
}

export interface TenantScopedTurnRunRepository {
  readonly userId: string;
  findById(id: string): Promise<TurnRun | null>;
  create(input: Omit<CreateTurnRunInput, 'userId'>): Promise<TurnRun>;
  updateStatus(id: string, input: UpdateTurnRunStatusInput): Promise<TurnRun>;
  listByRouteId(routeId: string): Promise<TurnRun[]>;
  listOpenRuns(): Promise<TurnRun[]>;
  interruptOpenRuns(reason?: string): Promise<number>;
}

export interface TenantScopedAgentProfileRepository {
  readonly userId: string;
  findById(id: string): Promise<AgentProfile | null>;
  findByName(name: string): Promise<AgentProfile | null>;
  getWithActiveSnapshot(id: string): Promise<AgentProfileWithSnapshot | null>;
  getSnapshot(profileId: string, version: number): Promise<AgentProfileSnapshot | null>;
  getSnapshotById(snapshotId: string): Promise<AgentProfileSnapshot | null>;
  listSnapshots(profileId: string): Promise<AgentProfileSnapshot[]>;
  create(input: Omit<CreateAgentProfileInput, 'userId'>): Promise<AgentProfileWithSnapshot>;
  update(id: string, input: UpdateAgentProfileInput): Promise<AgentProfile>;
  createVersion(profileId: string, input: CreateAgentProfileVersionInput): Promise<AgentProfileSnapshot>;
  rollbackVersion(profileId: string, input: RollbackAgentProfileVersionInput): Promise<AgentProfileSnapshot>;
  archive(id: string): Promise<AgentProfile>;
  delete(id: string): Promise<boolean>;
  list(options?: { status?: LifecycleStatus; limit?: number; offset?: number }): Promise<AgentProfile[]>;
}

export interface TenantScopedSessionGenerationRepository {
  readonly userId: string;
  findById(id: string): Promise<SessionGeneration | null>;
  findByRouteAndNumber(routeId: string, generationNumber: number): Promise<SessionGeneration | null>;
  getLatestByRouteId(routeId: string): Promise<SessionGeneration | null>;
  create(input: Omit<CreateSessionGenerationInput, 'userId'>): Promise<SessionGeneration>;
  listByRouteId(routeId: string, options?: { limit?: number; offset?: number }): Promise<SessionGeneration[]>;
}

// ---- Unified Extension Repositories (Migration 30) ----

export interface TenantScopedExtensionPackageRepository {
  readonly userId: string;
  findById(id: string): Promise<ExtensionPackageRecord | null>;
  findBySlug(slug: string): Promise<ExtensionPackageRecord | null>;
  create(input: Omit<ExtensionPackageRecord, 'userId' | 'createdAt' | 'updatedAt' | 'id'> & { id?: string }): Promise<ExtensionPackageRecord>;
  update(id: string, input: Partial<Omit<ExtensionPackageRecord, 'id' | 'userId' | 'createdAt' | 'updatedAt'>>): Promise<ExtensionPackageRecord>;
  delete(id: string): Promise<boolean>;
  list(options?: {
    kind?: ExtensionKind;
    sourceKind?: ExtensionSourceKind;
    status?: ExtensionPackageStatus;
    limit?: number;
    offset?: number;
  }): Promise<ExtensionPackageRecord[]>;

  // Versions
  createVersion(input: Omit<ExtensionVersionRecord, 'createdAt' | 'id'> & { id?: string }): Promise<ExtensionVersionRecord>;
  listVersions(packageId: string): Promise<ExtensionVersionRecord[]>;
  getVersion(packageId: string, version: number): Promise<ExtensionVersionRecord | null>;

  // Contributions
  createContribution(input: Omit<ExtensionContributionRecord, 'createdAt' | 'updatedAt' | 'id'> & { id?: string }): Promise<ExtensionContributionRecord>;
  updateContribution(id: string, input: Partial<Pick<ExtensionContributionRecord, 'manifestJson' | 'status'>>): Promise<ExtensionContributionRecord>;
  listContributions(packageId: string): Promise<ExtensionContributionRecord[]>;
  listAllContributions(options?: {
    kind?: ExtensionKind;
    status?: ExtensionContributionStatus;
    limit?: number;
    offset?: number;
  }): Promise<ExtensionContributionRecord[]>;
  findContributionById(contributionId: string): Promise<ExtensionContributionRecord | null>;
  findContributionByKey(packageId: string, kind: ExtensionKind, key: string): Promise<ExtensionContributionRecord | null>;
  deleteContribution(id: string): Promise<boolean>;
}

export interface TenantScopedExtensionBindingRepository {
  readonly userId: string;
  findById(id: string): Promise<ExtensionBindingRecord | null>;
  findBySpaceAndContribution(spaceId: string, contributionId: string): Promise<ExtensionBindingRecord | null>;
  findBySpaceAndContributionKey(spaceId: string, kind: ExtensionKind, key: string): Promise<ExtensionBindingRecord | null>;
  setBinding(
    spaceId: string,
    contributionId: string,
    enabled: boolean
  ): Promise<ExtensionBindingRecord>;
  deleteBinding(spaceId: string, contributionId: string): Promise<boolean>;
  deleteByContribution(contributionId: string): Promise<number>;
  deleteBySpace(spaceId: string): Promise<number>;
  listBySpace(spaceId: string): Promise<ExtensionBindingRecord[]>;
  listByContribution(contributionId: string): Promise<ExtensionBindingRecord[]>;
  list(options?: { spaceId?: string; limit?: number; offset?: number }): Promise<ExtensionBindingRecord[]>;
}

// ---- Skill Repositories (Legacy M21 kept for backward compatibility/read) ----

export interface TenantScopedSkillPackageRepository {
  readonly userId: string;
  findById(id: string): Promise<SkillPackage | null>;
  findByName(name: string, scope?: SkillScope, spaceId?: string | null): Promise<SkillPackage | null>;
  create(input: Omit<SkillPackage, 'userId' | 'createdAt' | 'updatedAt'> | SkillPackage): Promise<SkillPackage>;
  update(id: string, input: Partial<Omit<SkillPackage, 'id' | 'userId' | 'createdAt' | 'updatedAt'>>): Promise<SkillPackage>;
  delete(id: string): Promise<boolean>;
  createVersion(input: Omit<SkillPackageVersion, 'createdAt'> | SkillPackageVersion): Promise<SkillPackageVersion>;
  listVersions(packageId: string): Promise<SkillPackageVersion[]>;
  getVersion(packageId: string, version: number): Promise<SkillPackageVersion | null>;
  list(options?: { scope?: SkillScope; spaceId?: string | null; status?: SkillStatus; limit?: number; offset?: number }): Promise<SkillPackage[]>;
}

export interface TenantScopedSkillBindingRepository {
  readonly userId: string;
  findById(id: string): Promise<SkillBinding | null>;
  findBySpaceAndSkill(spaceId: string, skillName: string): Promise<SkillBinding | null>;
  listBySpace(spaceId: string): Promise<SkillBinding[]>;
  listBySkill(skillName: string): Promise<SkillBinding[]>;
  setBinding(spaceId: string, skillName: string, enabled: boolean, packageId?: string | null): Promise<SkillBinding>;
  deleteBySkill(skillName: string): Promise<number>;
  deleteBySpace(spaceId: string): Promise<number>;
  list(options?: { spaceId?: string; limit?: number; offset?: number }): Promise<SkillBinding[]>;
}

export interface TenantScopedSkillOperationRepository {
  readonly userId: string;
  findById(id: string): Promise<SkillOperation | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<SkillOperation | null>;
  create(input: Omit<SkillOperation, 'userId' | 'createdAt' | 'updatedAt'> | SkillOperation): Promise<SkillOperation>;
  list(options?: { status?: SkillOperationStatus; limit?: number; offset?: number }): Promise<SkillOperation[]>;
}

export interface TenantScopedSpaceMountRepository {
  readonly userId: string;
  findById(id: string): Promise<SpaceMount | null>;
  findByName(spaceId: string, name: string): Promise<SpaceMount | null>;
  listBySpace(spaceId: string): Promise<SpaceMount[]>;
  listAllForUser(): Promise<SpaceMount[]>;
  create(input: CreateSpaceMountInput): Promise<SpaceMount>;
  restore(mount: SpaceMount): Promise<SpaceMount>;
  delete(id: string): Promise<boolean>;
  deleteBySpace(spaceId: string): Promise<number>;
}
