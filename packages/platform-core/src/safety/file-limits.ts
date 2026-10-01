/**
 * Single configurable constant for maximum inbound file size.
 * Defaults to 500MB (524,288,000 bytes) per Issue FF / F-diagnosis.zh.md.
 * Configurable via process.env.MAX_FILE_SIZE_MB or process.env.ENKEEP_MAX_FILE_SIZE_BYTES.
 */

export const DEFAULT_MAX_FILE_SIZE_MB = 500;

/**
 * Resolves maximum inbound file size in bytes from environment or default (500MB).
 */
export function resolveMaxInboundFileBytes(): number {
  if (typeof process !== 'undefined' && process.env) {
    if (process.env.ENKEEP_MAX_FILE_SIZE_BYTES) {
      const parsedBytes = parseInt(process.env.ENKEEP_MAX_FILE_SIZE_BYTES, 10);
      if (Number.isSafeInteger(parsedBytes) && parsedBytes > 0) {
        return parsedBytes;
      }
    }
    if (process.env.MAX_FILE_SIZE_MB) {
      const parsedMb = parseInt(process.env.MAX_FILE_SIZE_MB, 10);
      if (Number.isSafeInteger(parsedMb) && parsedMb > 0) {
        return parsedMb * 1024 * 1024;
      }
    }
  }
  return DEFAULT_MAX_FILE_SIZE_MB * 1024 * 1024;
}

export const MAX_INBOUND_FILE_BYTES = 500 * 1024 * 1024; // 500 MiB (524,288,000 bytes)
export const MAX_FILE_SIZE_MB = DEFAULT_MAX_FILE_SIZE_MB;
