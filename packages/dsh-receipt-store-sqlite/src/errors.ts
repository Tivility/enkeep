/**
 * Error classes for DSH Receipt Store SQLite.
 *
 * @module @enkeep/dsh-receipt-store-sqlite
 */

/**
 * Type guard for Error instances.
 */
export function isError(err: unknown): err is Error {
  return err instanceof Error;
}

/**
 * Type guard for generic plain object record.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Safely extracts a message from unknown error value.
 */
export function toErrorMessage(err: unknown): string {
  if (isError(err)) {
    return err.message;
  }
  if (err !== null && err !== undefined && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err ?? 'Unknown error');
}

/**
 * Converts unknown caught value into an Error instance.
 */
export function toError(err: unknown): Error {
  if (isError(err)) return err;
  return new Error(toErrorMessage(err), { cause: err });
}

export class ReceiptStoreError extends Error {
  readonly code: string;

  constructor(message: string, codeOrCause: string | unknown = 'RECEIPT_STORE_ERROR', cause?: unknown) {
    let code = 'RECEIPT_STORE_ERROR';
    let actualCause = cause;
    if (typeof codeOrCause === 'string') {
      code = codeOrCause;
    } else if (codeOrCause !== undefined) {
      actualCause = codeOrCause;
    }
    super(message, { cause: actualCause });
    this.name = 'ReceiptStoreError';
    this.code = code;
  }
}

export class ReceiptStoreClosedError extends ReceiptStoreError {
  constructor(message = 'Receipt store is closed') {
    super(message, 'RECEIPT_STORE_CLOSED');
    this.name = 'ReceiptStoreClosedError';
  }
}

export class ReceiptNotFoundError extends ReceiptStoreError {
  constructor(identifier: string) {
    super(`Delivery receipt '${identifier}' not found`, 'RECEIPT_NOT_FOUND');
    this.name = 'ReceiptNotFoundError';
  }
}

export class DuplicateDeliveryIdError extends ReceiptStoreError {
  constructor(deliveryId: string) {
    super(`Delivery receipt with deliveryId '${deliveryId}' already exists`, 'DUPLICATE_DELIVERY_ID');
    this.name = 'DuplicateDeliveryIdError';
  }
}

export class SeedImportMismatchError extends ReceiptStoreError {
  readonly sessionId: string;
  readonly expected: {
    readonly algorithm: string;
    readonly checksum: string;
    readonly canonicalBytes: number;
    readonly eventCount: number;
  };
  readonly actual: {
    readonly algorithm: string;
    readonly checksum: string;
    readonly canonicalBytes: number;
    readonly eventCount: number;
  };

  constructor(
    sessionId: string,
    expected: { algorithm: string; checksum: string; canonicalBytes: number; eventCount: number },
    actual: { algorithm: string; checksum: string; canonicalBytes: number; eventCount: number }
  ) {
    super(
      `Seed import receipt mismatch for session '${sessionId}': expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      'SEED_IMPORT_MISMATCH'
    );
    this.name = 'SeedImportMismatchError';
    this.sessionId = sessionId;
    this.expected = expected;
    this.actual = actual;
  }
}

export class MigrationError extends ReceiptStoreError {
  constructor(message: string, cause?: unknown) {
    super(message, 'MIGRATION_ERROR', cause);
    this.name = 'MigrationError';
  }
}

export class MigrationDowngradeError extends MigrationError {
  readonly currentVersion: number;
  readonly targetVersion: number;

  constructor(currentVersion: number, targetVersion: number) {
    super(
      `Database schema version ${currentVersion} is newer than target version ${targetVersion}`
    );
    this.name = 'MigrationDowngradeError';
    this.currentVersion = currentVersion;
    this.targetVersion = targetVersion;
  }
}

export class MigrationChecksumMismatchError extends MigrationError {
  readonly version: number;
  readonly expectedChecksum: string;
  readonly actualChecksum: string;

  constructor(version: number, expectedChecksum: string, actualChecksum: string) {
    super(
      `Checksum mismatch for migration version ${version}: expected ${expectedChecksum}, got ${actualChecksum}`
    );
    this.name = 'MigrationChecksumMismatchError';
    this.version = version;
    this.expectedChecksum = expectedChecksum;
    this.actualChecksum = actualChecksum;
  }
}
