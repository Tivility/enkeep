import type {
  PlatformOperationsStorage,
  TenantScopedOperationsStorage,
} from '../ports/storage-port.js';
import type { OutboundChannelAdapter } from '../types/message.js';
import type { OutboundFileChannelAdapter, PathPolicyConfig } from '../types/file.js';
import { MessageOperationService } from './message-operation-service.js';
import { FileOperationService } from './file-operation-service.js';
import { TaskOperationService } from './task-operation-service.js';
import { QuotaOperationService } from './quota-operation-service.js';

export interface PlatformOperationsConfig {
  storage: PlatformOperationsStorage;
  messageChannelAdapter?: OutboundChannelAdapter;
  fileChannelAdapter?: OutboundFileChannelAdapter;
  filePathConfig?: PathPolicyConfig;
  defaultTaskLeaseDurationMs?: number;
  defaultTaskMaxRetries?: number;
}

export interface TenantScopedOperations {
  readonly userId: string;
  readonly messages: MessageOperationService;
  readonly files: FileOperationService;
  readonly tasks: TaskOperationService;
  readonly quota: QuotaOperationService;
}

/**
 * Top-level entry point for Platform Operations.
 * Fully decoupled from concrete storage via PlatformOperationsStorage port.
 */
export class PlatformOperationsService {
  private readonly storage: PlatformOperationsStorage;
  private readonly config: PlatformOperationsConfig;
  private readonly tenantCache = new Map<string, TenantScopedOperations>();

  constructor(config: PlatformOperationsConfig) {
    this.storage = config.storage;
    this.config = config;
  }

  get auditLogs() {
    return this.storage.auditLogs;
  }

  /**
   * Obtain operations context scoped strictly to a tenant (userId).
   */
  forTenant(userId: string): TenantScopedOperations {
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      throw new Error('Valid tenant userId is required for operations');
    }

    const cached = this.tenantCache.get(userId);
    if (cached) {
      return cached;
    }

    const tenantStorage: TenantScopedOperationsStorage = this.storage.forTenant(userId);

    const messages = new MessageOperationService({
      deliveryReceipts: tenantStorage.deliveryReceipts,
      auditLogs: this.storage.auditLogs,
      channelAdapter: this.config.messageChannelAdapter,
    });

    const files = new FileOperationService({
      files: tenantStorage.files,
      pathPolicy: this.storage.pathPolicy,
      auditLogs: this.storage.auditLogs,
      channelAdapter: this.config.fileChannelAdapter,
      policyConfig: this.config.filePathConfig,
    });

    const tasks = new TaskOperationService({
      tasks: tenantStorage.tasks,
      auditLogs: this.storage.auditLogs,
      defaultLeaseDurationMs: this.config.defaultTaskLeaseDurationMs,
      defaultMaxRetries: this.config.defaultTaskMaxRetries,
    });

    const quota = new QuotaOperationService({
      quota: tenantStorage.quota,
      auditLogs: this.storage.auditLogs,
    });

    const tenantOps: TenantScopedOperations = {
      userId,
      messages,
      files,
      tasks,
      quota,
    };

    this.tenantCache.set(userId, tenantOps);
    return tenantOps;
  }

  /**
   * System restart recovery sweep across all tenants.
   */
  async recoverAfterRestart(options?: { nowIso?: string }): Promise<{
    recoveredTasks: number;
    expiredReservations: number;
  }> {
    return this.storage.recoverAfterRestart(options);
  }
}

/**
 * Factory function for creating PlatformOperationsService with explicit ports.
 */
export function createPlatformOperations(config: PlatformOperationsConfig): PlatformOperationsService {
  return new PlatformOperationsService(config);
}
