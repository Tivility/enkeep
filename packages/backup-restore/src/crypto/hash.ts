/**
 * SHA-256 Hash Utilities
 *
 * @module @enkeep/backup-restore/crypto/hash
 */

import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';

/**
 * Computes SHA-256 hex digest for a string or buffer.
 */
export function computeSha256(data: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Computes SHA-256 hex digest and size for a file on disk via streaming.
 */
export async function computeFileHashAndSize(
  filePath: string
): Promise<{ sha256: string; size: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let size = 0;

    const stream = createReadStream(filePath);

    stream.on('data', (chunk: string | Buffer) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      hash.update(buffer);
    });

    stream.on('end', () => {
      resolve({
        sha256: hash.digest('hex'),
        size,
      });
    });

    stream.on('error', (err) => {
      reject(err);
    });
  });
}
