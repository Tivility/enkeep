/**
 * AES-256-GCM Credential Cipher Port Implementation
 *
 * Provides authenticated encryption for stored credentials (e.g. webhook HMAC secrets)
 * with random 96-bit nonces (IV) and 128-bit authentication tags.
 *
 * Format: `v1:<hex_iv>:<hex_tag>:<hex_ciphertext>`
 *
 * @module @enkeep/platform-server/notifications
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
} from 'node:crypto';
import type { CredentialCipherPort } from '@enkeep/platform-core';

export class CredentialDecryptionError extends Error {
  constructor(message = 'Failed to decrypt credential: authentication tag mismatch or invalid key') {
    super(message);
    this.name = 'CredentialDecryptionError';
  }
}

export class AesGcmCredentialCipher implements CredentialCipherPort {
  private readonly key: Buffer;

  constructor(keyOrSecret: string | Buffer) {
    if (!keyOrSecret || (typeof keyOrSecret === 'string' && keyOrSecret.trim().length === 0)) {
      throw new Error('AesGcmCredentialCipher requires a non-empty key or secret');
    }

    if (Buffer.isBuffer(keyOrSecret)) {
      if (keyOrSecret.length !== 32) {
        this.key = createHash('sha256').update(keyOrSecret).digest();
      } else {
        this.key = keyOrSecret;
      }
    } else {
      // Derive 256-bit key from passphrase / secret
      this.key = createHash('sha256').update(keyOrSecret, 'utf8').digest();
    }
  }

  encrypt(plaintext: string): string {
    if (typeof plaintext !== 'string') {
      throw new Error('Credential plaintext must be a string');
    }

    const iv = randomBytes(12); // 96-bit standard GCM nonce
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);

    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(plaintext, 'utf8')),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag(); // 128-bit authentication tag

    return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
  }

  decrypt(payload: string): string {
    if (typeof payload !== 'string' || !payload.startsWith('v1:')) {
      throw new CredentialDecryptionError('Invalid credential ciphertext format: expected v1 prefix');
    }

    const parts = payload.split(':');
    if (parts.length !== 4) {
      throw new CredentialDecryptionError('Invalid credential ciphertext structure');
    }

    const [, ivHex, tagHex, dataHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const ciphertext = Buffer.from(dataHex, 'hex');

    if (iv.length !== 12 || tag.length !== 16) {
      throw new CredentialDecryptionError('Corrupted credential nonce or tag length');
    }

    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return decrypted.toString('utf8');
    } catch {
      throw new CredentialDecryptionError();
    }
  }
}

/**
 * Computes a public, non-reversible SHA-256 fingerprint for secret verification.
 * Returns e.g. "sha256:a1b2c3d4"
 */
export function computeSecretFingerprint(secret: string): string {
  const hash = createHash('sha256').update(secret, 'utf8').digest('hex');
  return `sha256:${hash.slice(0, 8)}`;
}

/**
 * Computes the full one-way SHA-256 hash for database indexing/verification.
 */
export function computeSecretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}
