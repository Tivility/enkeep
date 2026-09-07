import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readPassphraseFromFile,
  deriveKey,
  encryptBackupPayload,
  decryptBackupPayload,
  isEncryptedBackupBuffer,
  computeSha256,
} from '../src/index.js';
import {
  BackupEncryptionError,
  BackupPathSafetyError,
} from '../src/errors.js';

describe('Crypto Module & Authenticated Envelope', () => {
  const testDir = mkdtempSync(join(tmpdir(), 'enkeep-crypto-test-'));

  it('computes SHA-256 deterministic hash', () => {
    const hash = computeSha256('hello enkeep backup');
    expect(hash).toBe('ff9296fd6ae06dba6dfd417c14f1bbfcab49a454b08f45eb3de3ffc758d1dfaf');
  });

  it('reads and trims passphrase from file', () => {
    const passFile = join(testDir, 'pass.txt');
    writeFileSync(passFile, 'super-secret-passphrase-12345\n');
    const read = readPassphraseFromFile(passFile);
    expect(read).toBe('super-secret-passphrase-12345');
  });

  it('rejects missing or empty passphrase file', () => {
    expect(() => readPassphraseFromFile('')).toThrow(BackupEncryptionError);
    expect(() => readPassphraseFromFile(join(testDir, 'nonexistent.txt'))).toThrow(
      BackupPathSafetyError
    );
  });

  it('rejects short passphrase (< 8 characters)', () => {
    const passFile = join(testDir, 'short.txt');
    writeFileSync(passFile, 'short\n');
    expect(() => readPassphraseFromFile(passFile)).toThrow(BackupEncryptionError);
  });

  it('rejects symlinked passphrase file', () => {
    const realFile = join(testDir, 'real-pass.txt');
    const linkFile = join(testDir, 'link-pass.txt');
    writeFileSync(realFile, 'valid-passphrase-12345\n');
    symlinkSync(realFile, linkFile);

    expect(() => readPassphraseFromFile(linkFile)).toThrow(BackupPathSafetyError);
  });

  it('derives stable 32-byte key via scrypt', () => {
    const salt = Buffer.alloc(32, 1);
    const key1 = deriveKey('my-secure-password', salt);
    const key2 = deriveKey('my-secure-password', salt);
    expect(key1.length).toBe(32);
    expect(key1.equals(key2)).toBe(true);
  });

  it('encrypts and decrypts payload round-trip with AES-256-GCM', () => {
    const payload = Buffer.from('Database payload and secrets content to protect', 'utf8');
    const passphrase = 'high-entropy-test-password-12345';

    const encrypted = encryptBackupPayload(payload, passphrase);
    expect(isEncryptedBackupBuffer(encrypted)).toBe(true);
    expect(encrypted.length).toBeGreaterThan(payload.length + 70);

    const decrypted = decryptBackupPayload(encrypted, passphrase);
    expect(decrypted.equals(payload)).toBe(true);
    expect(decrypted.toString('utf8')).toBe('Database payload and secrets content to protect');
  });

  it('fails decryption with wrong passphrase (authentication tag failure)', () => {
    const payload = Buffer.from('Sensitive payload', 'utf8');
    const encrypted = encryptBackupPayload(payload, 'correct-passphrase-123');

    expect(() => decryptBackupPayload(encrypted, 'wrong-passphrase-456')).toThrow(
      BackupEncryptionError
    );
  });

  it('fails decryption when ciphertext is tampered', () => {
    const payload = Buffer.from('Sensitive payload', 'utf8');
    const encrypted = encryptBackupPayload(payload, 'passphrase-12345');

    // Tamper with last byte
    encrypted[encrypted.length - 1] = (encrypted[encrypted.length - 1]! ^ 0xff);

    expect(() => decryptBackupPayload(encrypted, 'passphrase-12345')).toThrow(
      BackupEncryptionError
    );
  });

  it('fails decryption when header or auth tag is corrupted', () => {
    const payload = Buffer.from('Sensitive payload', 'utf8');
    const encrypted = encryptBackupPayload(payload, 'passphrase-12345');

    // Tamper with auth tag byte (offset 56-72)
    encrypted[60] = (encrypted[60]! ^ 0xff);

    expect(() => decryptBackupPayload(encrypted, 'passphrase-12345')).toThrow(
      BackupEncryptionError
    );
  });
});
