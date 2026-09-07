/**
 * Data contracts and configuration types for DSH Receipt Store SQLite.
 *
 * @module @enkeep/dsh-receipt-store-sqlite
 */

export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface DeliveryReceipt {
  readonly id: number;
  readonly userId: string;
  readonly deliveryId: string;
  readonly messageId: string;
  readonly routeId: string;
  readonly status: DeliveryStatus;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecordReceiptInput {
  readonly deliveryId: string;
  readonly messageId: string;
  readonly routeId?: string;
  readonly status?: DeliveryStatus;
  readonly error?: string | null;
}

export interface SessionSource {
  readonly id: number;
  readonly userId: string;
  readonly routeId: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly metadata: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecordSessionSourceInput {
  readonly routeId: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly metadata?: Record<string, unknown> | null;
}

export interface EventCursor {
  readonly userId: string;
  readonly sessionId: string;
  readonly consumer: string;
  readonly cursorValue: string;
  readonly updatedAt: string;
}

export interface SetEventCursorInput {
  readonly sessionId: string;
  readonly cursorValue: string;
  readonly consumer?: string;
}

export type SeedImportAlgorithm = 'sha256-session-events-v1';

export interface SeedImportReceipt {
  readonly userId: string;
  readonly sessionId: string;
  readonly algorithm: 'sha256-session-events-v1';
  readonly checksum: string;
  readonly canonicalBytes: number;
  readonly eventCount: number;
  readonly importedAt: string;
}

export interface RecordSeedImportReceiptInput {
  readonly sessionId: string;
  readonly algorithm?: 'sha256-session-events-v1';
  readonly checksum: string;
  readonly canonicalBytes: number;
  readonly eventCount: number;
  readonly importedAt?: string;
}

export interface ReceiptStoreConfig {
  /**
   * Path to SQLite database file or ':memory:'
   */
  readonly path: string;

  /**
   * Tenant identifier for single-tenant isolation. Mandatory in runtime.
   */
  readonly userId: string;

  /**
   * SQLite journal mode. Defaults to 'wal'.
   */
  readonly journalMode?: 'wal' | 'delete' | 'truncate' | 'persist' | 'memory' | 'off';

  /**
   * SQLite busy timeout in milliseconds. Defaults to 5000.
   */
  readonly busyTimeoutMs?: number;
}

export interface RestartRecoverySummary {
  readonly pendingReceiptsRecovered: number;
  readonly inFlightReceiptsCount: number;
}

export interface IReceiptStore {
  readonly userId: string;
  readonly isClosed: boolean;

  init(): void;
  close(): Promise<void>;

  recordReceipt(input: RecordReceiptInput): Promise<DeliveryReceipt>;
  getReceiptByDeliveryId(deliveryId: string): Promise<DeliveryReceipt | null>;
  getReceiptByMessageId(messageId: string): Promise<DeliveryReceipt | null>;
  updateReceiptStatus(deliveryId: string, status: DeliveryStatus, error?: string | null): Promise<DeliveryReceipt>;

  recordSessionSource(input: RecordSessionSourceInput): Promise<SessionSource>;
  getSessionSource(sourceType: string, sourceId: string): Promise<SessionSource | null>;
  getSessionSourcesByRouteId(routeId: string): Promise<readonly SessionSource[]>;

  getEventCursor(sessionId: string, consumer?: string): Promise<EventCursor | null>;
  setEventCursor(inputOrSessionId: SetEventCursorInput | string, cursorValue?: string, consumer?: string): Promise<EventCursor>;

  getSeedImportReceipt(sessionId: string): Promise<SeedImportReceipt | null>;
  recordSeedImportReceipt(input: RecordSeedImportReceiptInput): Promise<SeedImportReceipt>;

  recoverAfterRestart(): Promise<RestartRecoverySummary>;
}
