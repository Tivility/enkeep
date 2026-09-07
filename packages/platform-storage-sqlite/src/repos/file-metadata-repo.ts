import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  TenantScopedFileMetadataRepository,
  CreateFileMetadataInput,
  FileMetadata,
} from '@enkeep/platform-operations';
import { parseFileMetadataRow, queryOne, queryAll, type DbParam } from '../utils/db.js';

export class SqliteTenantScopedFileMetadataRepository implements TenantScopedFileMetadataRepository {
  readonly userId: string;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  async create(input: CreateFileMetadataInput): Promise<FileMetadata> {
    const id = input.id || `file_${randomUUID().replace(/-/g, '')}`;
    const metaStr = input.metadata ? JSON.stringify(input.metadata) : null;

    this.db.prepare(`
      INSERT INTO file_metadata (
        id, user_id, filename, relative_path, size, mime_type, extension,
        checksum, recipient, description, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      id,
      this.userId,
      input.filename,
      input.relativePath,
      input.size,
      input.mimeType ?? null,
      input.extension,
      input.checksum ?? null,
      input.recipient,
      input.description ?? null,
      metaStr
    );

    const created = await this.findById(id);
    if (!created) {
      throw new Error('Failed to retrieve newly created file metadata');
    }
    return created;
  }

  async findById(id: string): Promise<FileMetadata | null> {
    const stmt = this.db.prepare('SELECT * FROM file_metadata WHERE id = ? AND user_id = ?');
    return queryOne(stmt, parseFileMetadataRow, id, this.userId);
  }

  async listByRecipient(recipient: string, options?: { limit?: number; offset?: number }): Promise<FileMetadata[]> {
    let sql = 'SELECT * FROM file_metadata WHERE user_id = ? AND recipient = ? ORDER BY created_at DESC';
    const params: DbParam[] = [this.userId, recipient];

    if (options?.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
      if (options?.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(options.offset);
      }
    }

    const stmt = this.db.prepare(sql);
    return queryAll(stmt, parseFileMetadataRow, ...params);
  }

  async list(options?: { limit?: number; offset?: number }): Promise<FileMetadata[]> {
    let sql = 'SELECT * FROM file_metadata WHERE user_id = ? ORDER BY created_at DESC';
    const params: DbParam[] = [this.userId];

    if (options?.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
      if (options?.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(options.offset);
      }
    }

    const stmt = this.db.prepare(sql);
    return queryAll(stmt, parseFileMetadataRow, ...params);
  }
}
