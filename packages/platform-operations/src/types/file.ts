export interface PathPolicyConfig {
  /**
   * Root directories allowed for this tenant workspace.
   * If paths are relative, they are resolved against the active workspace root.
   */
  workspaceRoot?: string;
  /**
   * Maximum allowed file size in bytes (default: 10MB).
   */
  maxSizeBytes?: number;
  /**
   * Allowed file extensions (e.g. ['.txt', '.json', '.pdf', '.png']).
   * If empty or undefined, all non-executable extensions are allowed.
   */
  allowedExtensions?: string[];
  /**
   * Blocked extensions (e.g. ['.exe', '.sh', '.bin', '.dll', '.so']).
   */
  blockedExtensions?: string[];
  /**
   * Whether to allow absolute paths (if true, must still be within workspaceRoot).
   */
  allowAbsolute?: boolean;
}

export interface FileMetadata {
  id: string;
  userId: string;
  filename: string;
  relativePath: string;
  size: number;
  mimeType?: string;
  extension: string;
  checksum?: string;
  recipient: string;
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface SendFileInput {
  recipient: string;
  path: string;
  filename?: string;
  size?: number;
  mimeType?: string;
  checksum?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface SendFileResult {
  success: boolean;
  fileId: string;
  recipient: string;
  metadata: FileMetadata;
  timestamp: string;
  isIdempotentHit?: boolean;
}

export interface OutboundFileChannelAdapter {
  deliverFile(params: {
    userId: string;
    recipient: string;
    fileMetadata: FileMetadata;
    customPayload?: Record<string, unknown>;
  }): Promise<{ channelFileId?: string; metadata?: Record<string, unknown> }>;
}
