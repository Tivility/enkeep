import { randomUUID } from 'node:crypto';
import type {
  FileMetadata,
} from '../../src/types/file.js';
import type {
  TenantScopedFileMetadataRepository,
  CreateFileMetadataInput,
} from '../../src/ports/file-port.js';

export class FakeTenantScopedFileMetadataRepository implements TenantScopedFileMetadataRepository {
  readonly userId: string;
  private readonly files = new Map<string, FileMetadata>();

  constructor(userId: string) {
    this.userId = userId;
  }

  async create(input: CreateFileMetadataInput): Promise<FileMetadata> {
    const id = input.id || `file_${randomUUID().replace(/-/g, '')}`;
    const now = new Date().toISOString();

    const metadata: FileMetadata = {
      id,
      userId: this.userId,
      filename: input.filename,
      relativePath: input.relativePath,
      size: input.size,
      mimeType: input.mimeType,
      extension: input.extension,
      checksum: input.checksum,
      recipient: input.recipient,
      description: input.description,
      metadata: input.metadata ? JSON.parse(JSON.stringify(input.metadata)) : undefined,
      createdAt: now,
    };

    this.files.set(id, metadata);
    return { ...metadata };
  }

  async findById(id: string): Promise<FileMetadata | null> {
    const f = this.files.get(id);
    if (!f || f.userId !== this.userId) return null;
    return { ...f };
  }

  async listByRecipient(recipient: string, options?: { limit?: number; offset?: number }): Promise<FileMetadata[]> {
    const list = Array.from(this.files.values())
      .filter((f) => f.userId === this.userId && f.recipient === recipient)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? list.length;
    return list.slice(offset, offset + limit).map((f) => ({ ...f }));
  }

  async list(options?: { limit?: number; offset?: number }): Promise<FileMetadata[]> {
    const list = Array.from(this.files.values())
      .filter((f) => f.userId === this.userId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? list.length;
    return list.slice(offset, offset + limit).map((f) => ({ ...f }));
  }
}
