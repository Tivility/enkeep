import type {
  FileMetadata,
  PathPolicyConfig,
} from '../types/file.js';

export interface CreateFileMetadataInput {
  id?: string;
  filename: string;
  relativePath: string;
  size: number;
  mimeType?: string;
  extension: string;
  checksum?: string;
  recipient: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface TenantScopedFileMetadataRepository {
  readonly userId: string;

  findById(id: string): Promise<FileMetadata | null>;
  create(input: CreateFileMetadataInput): Promise<FileMetadata>;
  listByRecipient(recipient: string, options?: { limit?: number; offset?: number }): Promise<FileMetadata[]>;
  list(options?: { limit?: number; offset?: number }): Promise<FileMetadata[]>;
}

export interface PathValidationResult {
  valid: boolean;
  normalizedRelativePath: string;
  filename: string;
  extension: string;
  mimeType?: string;
  error?: string;
}

export interface PathPolicyPort {
  /**
   * Validate a path against tenant security policy (traversal, workspace containment,
   * allowed extensions, blocked executables) WITHOUT reading external paths.
   */
  validatePath(
    userId: string,
    targetPath: string,
    config?: PathPolicyConfig
  ): Promise<PathValidationResult>;
}
