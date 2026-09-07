/**
 * AES-256-GCM + scrypt Authenticated Encryption & Envelope Codec
 *
 * @module @enkeep/backup-restore/crypto/cipher
 */

import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import {
  BACKUP_MAGIC_BYTES,
  BACKUP_CONTAINER_VERSION,
  CRYPTO_PARAMS,
} from '../constants.js';
import { BackupEncryptionError } from '../errors.js';

export const CIPHER_TYPE_AES_256_GCM = 1;

/**
 * Derives a 256-bit symmetric encryption key from a passphrase and salt using scrypt.
 */
export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  try {
    return scryptSync(
      passphrase,
      salt,
      CRYPTO_PARAMS.keyBytes,
      {
        N: CRYPTO_PARAMS.scryptN,
        r: CRYPTO_PARAMS.scryptR,
        p: CRYPTO_PARAMS.scryptP,
        maxmem: CRYPTO_PARAMS.scryptMaxmem,
      }
    );
  } catch (err) {
    throw new BackupEncryptionError(
      `Failed to derive encryption key via scrypt: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export interface EnvelopeMetadata {
  readonly magic: string;
  readonly version: number;
  readonly cipherType: number;
  readonly salt: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
}

/**
 * Checks if a buffer begins with the encrypted backup magic bytes.
 */
export function isEncryptedBackupBuffer(buf: Buffer): boolean {
  if (buf.length < BACKUP_MAGIC_BYTES.length) return false;
  return buf.subarray(0, BACKUP_MAGIC_BYTES.length).toString('ascii') === BACKUP_MAGIC_BYTES;
}

/**
 * Encrypts arbitrary payload (e.g. tar stream) using AES-256-GCM and wraps with binary container header.
 *
 * Header layout (72 bytes total):
 * - Magic bytes (8 bytes): "ENKPBKP1"
 * - Version (2 bytes big-endian): 0x0001
 * - CipherType (2 bytes big-endian): 0x0001 (AES-256-GCM)
 * - Salt (32 bytes)
 * - IV (12 bytes)
 * - Auth Tag (16 bytes)
 * - Ciphertext (remaining bytes)
 */
export function encryptBackupPayload(payload: Buffer, passphrase: string): Buffer {
  if (!passphrase) {
    throw new BackupEncryptionError('Cannot encrypt payload: passphrase is empty');
  }

  const salt = randomBytes(CRYPTO_PARAMS.saltBytes);
  const iv = randomBytes(CRYPTO_PARAMS.ivBytes);
  const key = deriveKey(passphrase, salt);

  const headerPrefix = Buffer.alloc(12);
  headerPrefix.write(BACKUP_MAGIC_BYTES, 0, 8, 'ascii');
  headerPrefix.writeUInt16BE(BACKUP_CONTAINER_VERSION, 8);
  headerPrefix.writeUInt16BE(CIPHER_TYPE_AES_256_GCM, 10);

  // Authenticate the header prefix as AAD (Additional Authenticated Data)
  const aad = headerPrefix;

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);

  const encryptedChunks = [cipher.update(payload), cipher.final()];
  const tag = cipher.getAuthTag();

  return Buffer.concat([
    headerPrefix, // 12 bytes
    salt, // 32 bytes
    iv, // 12 bytes
    tag, // 16 bytes
    ...encryptedChunks,
  ]);
}

/**
 * Decrypts an encrypted backup container buffer.
 * Authenticates header prefix (AAD) and validates the GCM authentication tag.
 */
export function decryptBackupPayload(encryptedBuffer: Buffer, passphrase: string): Buffer {
  if (!passphrase) {
    throw new BackupEncryptionError('Cannot decrypt payload: passphrase is empty');
  }

  const minHeaderLen = 12 + CRYPTO_PARAMS.saltBytes + CRYPTO_PARAMS.ivBytes + CRYPTO_PARAMS.tagBytes; // 72 bytes
  if (encryptedBuffer.length < minHeaderLen) {
    throw new BackupEncryptionError(
      `Invalid backup archive: Payload too small (${encryptedBuffer.length} bytes, minimum is ${minHeaderLen} bytes)`
    );
  }

  const magic = encryptedBuffer.subarray(0, 8).toString('ascii');
  if (magic !== BACKUP_MAGIC_BYTES) {
    throw new BackupEncryptionError(
      `Invalid backup archive magic header: Expected "${BACKUP_MAGIC_BYTES}", received "${magic}"`
    );
  }

  const version = encryptedBuffer.readUInt16BE(8);
  if (version !== BACKUP_CONTAINER_VERSION) {
    throw new BackupEncryptionError(
      `Unsupported backup container version: ${version} (expected ${BACKUP_CONTAINER_VERSION})`
    );
  }

  const cipherType = encryptedBuffer.readUInt16BE(10);
  if (cipherType !== CIPHER_TYPE_AES_256_GCM) {
    throw new BackupEncryptionError(
      `Unsupported cipher type: ${cipherType} (expected ${CIPHER_TYPE_AES_256_GCM})`
    );
  }

  const aad = encryptedBuffer.subarray(0, 12);
  const salt = encryptedBuffer.subarray(12, 12 + CRYPTO_PARAMS.saltBytes);
  const iv = encryptedBuffer.subarray(12 + CRYPTO_PARAMS.saltBytes, 12 + CRYPTO_PARAMS.saltBytes + CRYPTO_PARAMS.ivBytes);
  const tag = encryptedBuffer.subarray(
    12 + CRYPTO_PARAMS.saltBytes + CRYPTO_PARAMS.ivBytes,
    12 + CRYPTO_PARAMS.saltBytes + CRYPTO_PARAMS.ivBytes + CRYPTO_PARAMS.tagBytes
  );
  const ciphertext = encryptedBuffer.subarray(minHeaderLen);

  const key = deriveKey(passphrase, salt);

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted;
  } catch (err) {
    throw new BackupEncryptionError(
      'Decryption failed: Invalid passphrase or corrupted/tampered backup archive (authentication tag verification failed).'
    );
  }
}
