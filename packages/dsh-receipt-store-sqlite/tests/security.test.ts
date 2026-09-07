import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  SqliteReceiptStore,
  ReceiptStoreError,
  resolveAndValidateDbPath,
} from '../src/index.js';

describe('ReceiptStore Path & Security Validation Tests', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `receipt-store-sec-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  describe('Path validation & DSH_HOME resolution', () => {
    it('rejects empty or whitespace database path', () => {
      expect(() => resolveAndValidateDbPath('')).toThrow(ReceiptStoreError);
      expect(() => resolveAndValidateDbPath('   ')).toThrow(ReceiptStoreError);
    });

    it('allows :memory: database path', () => {
      const p = resolveAndValidateDbPath(':memory:');
      expect(p).toBe(':memory:');
    });

    it('rejects database file when it is a symbolic link', () => {
      const realDbPath = join(testDir, 'real.db');
      const symlinkDbPath = join(testDir, 'symlink.db');

      writeFileSync(realDbPath, '');
      try {
        symlinkSync(realDbPath, symlinkDbPath);
      } catch {
        // Symlinks may require privileges on Windows, skip if OS denies
        return;
      }

      expect(() => resolveAndValidateDbPath(symlinkDbPath)).toThrow(ReceiptStoreError);
    });

    it('resolves relative path using DSH_HOME when provided in environment', () => {
      const dshHome = join(testDir, 'custom-dsh-home');
      mkdirSync(dshHome, { recursive: true });

      const resolved = resolveAndValidateDbPath('data/receipts.db', { DSH_HOME: dshHome });
      expect(resolved).toBe(join(dshHome, 'data', 'receipts.db'));
    });
  });

  describe('Mandatory userId configuration and validation', () => {
    it('rejects empty or whitespace userId', () => {
      expect(
        () =>
          new SqliteReceiptStore({
            path: ':memory:',
            userId: '',
          })
      ).toThrow(ReceiptStoreError);

      expect(
        () =>
          new SqliteReceiptStore({
            path: ':memory:',
            userId: '   ',
          })
      ).toThrow(ReceiptStoreError);
    });

    it('rejects missing or non-string userId', () => {
      expect(
        () =>
          new SqliteReceiptStore({
            path: ':memory:',
            userId: undefined as any,
          })
      ).toThrow(ReceiptStoreError);

      expect(
        () =>
          new SqliteReceiptStore({
            path: ':memory:',
          } as any)
      ).toThrow(ReceiptStoreError);
    });
  });
});
