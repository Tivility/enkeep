export interface MigrationRecord {
  version: number;
  name: string;
  checksum: string;
  appliedAt: string;
}

export interface MigrationDefinition {
  version: number;
  name: string;
  upSql: string;
  downSql?: string;
  checksum?: string; // If omitted, calculated at runtime from upSql
}
