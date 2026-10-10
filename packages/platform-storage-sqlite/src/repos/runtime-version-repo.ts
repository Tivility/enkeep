import type { DatabaseSync } from 'node:sqlite';
import type { RuntimeTargetVersionRecord, RuntimeVersionConfig } from '@enkeep/platform-core';

export function parseRuntimeTargetVersionRow(row: any): RuntimeTargetVersionRecord {
  return {
    id: String(row.id),
    image: row.image !== null && row.image !== undefined ? String(row.image) : null,
    daemonCliPath: row.daemon_cli_path !== null && row.daemon_cli_path !== undefined ? String(row.daemon_cli_path) : null,
    updatedBy: row.updated_by !== null && row.updated_by !== undefined ? String(row.updated_by) : null,
    updatedAt: String(row.updated_at),
  };
}

export class RuntimeTargetVersionRepo {
  constructor(private readonly db: DatabaseSync) {}

  public getTargetVersion(): RuntimeTargetVersionRecord | null {
    try {
      const stmt = this.db.prepare(
        'SELECT id, image, daemon_cli_path, updated_by, updated_at FROM runtime_target_version WHERE id = ?'
      );
      const row = stmt.get('default');
      if (!row) return null;
      return parseRuntimeTargetVersionRow(row);
    } catch {
      return null;
    }
  }

  public setTargetVersion(input: {
    image?: string | null;
    daemonCliPath?: string | null;
    updatedBy?: string | null;
  }): RuntimeTargetVersionRecord {
    const existing = this.getTargetVersion();
    const image = input.image !== undefined ? input.image : (existing?.image ?? null);
    const daemonCliPath = input.daemonCliPath !== undefined ? input.daemonCliPath : (existing?.daemonCliPath ?? null);
    const updatedBy = input.updatedBy ?? null;

    const stmt = this.db.prepare(`
      INSERT INTO runtime_target_version (id, image, daemon_cli_path, updated_by, updated_at)
      VALUES ('default', ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        image = excluded.image,
        daemon_cli_path = excluded.daemon_cli_path,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `);

    stmt.run(image, daemonCliPath, updatedBy);
    return this.getTargetVersion()!;
  }
}
