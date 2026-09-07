import { randomUUID } from 'node:crypto';
import type {
  SendFileInput,
  SendFileResult,
  FileMetadata,
  PathPolicyConfig,
  OutboundFileChannelAdapter,
} from '../types/file.js';
import type { TenantScopedFileMetadataRepository, PathPolicyPort } from '../ports/file-port.js';
import type { OperationsAuditPort } from '../ports/audit-port.js';
import { StandardPathPolicyValidator, DEFAULT_MAX_FILE_SIZE_BYTES } from '../policies/path-policy.js';
import { ValidationError, PathPolicyViolationError } from '../errors/index.js';

export interface FileOperationServiceOptions {
  files: TenantScopedFileMetadataRepository;
  pathPolicy?: PathPolicyPort;
  auditLogs?: OperationsAuditPort;
  channelAdapter?: OutboundFileChannelAdapter;
  policyConfig?: PathPolicyConfig;
}

export class FileOperationService {
  private readonly files: TenantScopedFileMetadataRepository;
  private readonly pathPolicy: PathPolicyPort;
  private readonly auditLogs?: OperationsAuditPort;
  private readonly channelAdapter?: OutboundFileChannelAdapter;
  private readonly policyConfig?: PathPolicyConfig;

  constructor(options: FileOperationServiceOptions) {
    this.files = options.files;
    this.pathPolicy = options.pathPolicy ?? new StandardPathPolicyValidator();
    this.auditLogs = options.auditLogs;
    this.channelAdapter = options.channelAdapter;
    this.policyConfig = options.policyConfig;
  }

  get userId(): string {
    return this.files.userId;
  }

  /**
   * Process outbound file transfer metadata & path policy.
   * Note: This operations layer does NOT read arbitrary external filesystem paths;
   * it validates the path policy, constructs metadata, persists tenant-scoped file record,
   * and optionally delegates byte streaming to the channel adapter.
   */
  async sendFile(input: SendFileInput, overrideConfig?: PathPolicyConfig): Promise<SendFileResult> {
    if (!input.recipient || typeof input.recipient !== 'string' || !input.recipient.trim()) {
      throw new ValidationError('Recipient must be a non-empty string');
    }
    if (!input.path || typeof input.path !== 'string' || !input.path.trim()) {
      throw new ValidationError('File path must be a non-empty string');
    }

    const config = { ...this.policyConfig, ...overrideConfig };
    const maxSizeBytes = config?.maxSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;

    // Validate size if specified in input
    if (input.size !== undefined && input.size > maxSizeBytes) {
      if (this.auditLogs) {
        await this.auditLogs.record({
          userId: this.userId,
          action: 'file_policy_violation',
          resourceType: 'file',
          details: {
            path: input.path,
            reason: `File size (${input.size} bytes) exceeds maximum limit (${maxSizeBytes} bytes)`,
            recipient: input.recipient,
          },
        });
      }
      throw new PathPolicyViolationError(
        input.path,
        `File size (${input.size} bytes) exceeds maximum allowed limit (${maxSizeBytes} bytes)`
      );
    }

    // Validate path policy (traversal, null bytes, extensions, relative path containment)
    let validationResult;
    try {
      validationResult = await this.pathPolicy.validatePath(this.userId, input.path, config);
    } catch (err: any) {
      if (this.auditLogs) {
        await this.auditLogs.record({
          userId: this.userId,
          action: 'file_policy_violation',
          resourceType: 'file',
          details: {
            path: input.path,
            error: err.message,
            recipient: input.recipient,
          },
        });
      }
      throw err;
    }

    const fileId = `file_${randomUUID().replace(/-/g, '')}`;
    const effectiveSize = input.size ?? 0;
    const filename = input.filename || validationResult.filename;
    const mimeType = input.mimeType || validationResult.mimeType;

    // Create file metadata in tenant storage
    const fileMetadata: FileMetadata = await this.files.create({
      id: fileId,
      filename,
      relativePath: validationResult.normalizedRelativePath,
      size: effectiveSize,
      mimeType,
      extension: validationResult.extension,
      checksum: input.checksum,
      recipient: input.recipient,
      description: input.description,
      metadata: input.metadata,
    });

    // Record audit log
    if (this.auditLogs) {
      await this.auditLogs.record({
        userId: this.userId,
        action: 'file_dispatched',
        resourceType: 'file',
        resourceId: fileMetadata.id,
        details: {
          recipient: input.recipient,
          filename: fileMetadata.filename,
          relativePath: fileMetadata.relativePath,
          size: fileMetadata.size,
          mimeType: fileMetadata.mimeType,
        },
      });
    }

    // Deliver via channel adapter if provided
    if (this.channelAdapter) {
      await this.channelAdapter.deliverFile({
        userId: this.userId,
        recipient: input.recipient,
        fileMetadata,
        customPayload: input.metadata,
      });
    }

    return {
      success: true,
      fileId: fileMetadata.id,
      recipient: input.recipient,
      metadata: fileMetadata,
      timestamp: fileMetadata.createdAt,
    };
  }

  /**
   * Look up file metadata by ID.
   */
  async getFile(fileId: string): Promise<FileMetadata | null> {
    return this.files.findById(fileId);
  }

  /**
   * List files for this tenant.
   */
  async listFiles(options?: { limit?: number; offset?: number }): Promise<FileMetadata[]> {
    return this.files.list(options);
  }
}
