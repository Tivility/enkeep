import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  inspectDirectory,
  executeFileOperation,
  clearFileETagCache,
  getFileETagCacheSize,
  computeFileETag,
  type FileOpExecutionOptions,
} from '../src/runtime/file-ops.js';

describe('D2: Large File ETag and Stat Cache Optimization', () => {
  let tmpDir: string;
  let spacesDir: string;
  let spaceRoot: string;
  const defaultSpace = 'test-space';
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const ETAG_REGEX = /^"[0-9a-f]{64}"$/;

  let defaultOptions: FileOpExecutionOptions;

  beforeEach(() => {
    clearFileETagCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-d2-test-'));
    spacesDir = path.join(tmpDir, 'spaces');
    spaceRoot = path.join(spacesDir, defaultSpace);
    fs.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spaceRoot, { recursive: true, mode: 0o700 });

    defaultOptions = {
      spacesDir,
      expectedUid: currentUid,
      procStatReader: (_pid: number) => ({ starttime: '12345' }),
    };
  });

  afterEach(() => {
    clearFileETagCache();
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('inspectDirectory computes valid SHA-256 ETags for files > 1MiB (2MB and 5MB)', () => {
    const size2MB = 2 * 1024 * 1024;
    const size5MB = 5 * 1024 * 1024;

    const buf2MB = crypto.randomBytes(size2MB);
    const buf5MB = crypto.randomBytes(size5MB);

    const path2MB = path.join(spaceRoot, 'large-2mb.bin');
    const path5MB = path.join(spaceRoot, 'large-5mb.bin');

    fs.writeFileSync(path2MB, buf2MB);
    fs.writeFileSync(path5MB, buf5MB);

    const expectedEtag2MB = computeFileETag(buf2MB);
    const expectedEtag5MB = computeFileETag(buf5MB);

    const result = inspectDirectory(fs, spaceRoot, currentUid);

    expect(result.entries).toHaveLength(2);

    const entry2MB = result.entries.find((e) => e.name === 'large-2mb.bin');
    const entry5MB = result.entries.find((e) => e.name === 'large-5mb.bin');

    expect(entry2MB).toBeDefined();
    expect(entry2MB?.size).toBe(size2MB);
    expect(entry2MB?.etag).toBeDefined();
    expect(ETAG_REGEX.test(entry2MB?.etag ?? '')).toBe(true);
    expect(entry2MB?.etag).toBe(expectedEtag2MB);

    expect(entry5MB).toBeDefined();
    expect(entry5MB?.size).toBe(size5MB);
    expect(entry5MB?.etag).toBeDefined();
    expect(ETAG_REGEX.test(entry5MB?.etag ?? '')).toBe(true);
    expect(entry5MB?.etag).toBe(expectedEtag5MB);
  });

  it('second inspectDirectory hits in-memory ETag cache and avoids re-reading disk (zero readSync)', () => {
    const size2MB = 2 * 1024 * 1024;
    const size5MB = 5 * 1024 * 1024;

    const buf2MB = crypto.randomBytes(size2MB);
    const buf5MB = crypto.randomBytes(size5MB);

    fs.writeFileSync(path.join(spaceRoot, 'file-2mb.bin'), buf2MB);
    fs.writeFileSync(path.join(spaceRoot, 'file-5mb.bin'), buf5MB);

    const mockReadSync = vi.fn((...args: Parameters<typeof fs.readSync>) => fs.readSync(...args));
    const trackedFs = {
      ...fs,
      readSync: mockReadSync,
    } as unknown as typeof fs;

    // Initial listing - populates cache and performs streaming reads
    const initialResult = inspectDirectory(trackedFs, spaceRoot, currentUid);
    expect(initialResult.entries).toHaveLength(2);
    expect(getFileETagCacheSize()).toBeGreaterThanOrEqual(2);
    const initialReadCalls = mockReadSync.mock.calls.length;
    expect(initialReadCalls).toBeGreaterThan(0);

    // Reset call tracker
    mockReadSync.mockClear();

    // Second listing - should hit cache
    const secondResult = inspectDirectory(trackedFs, spaceRoot, currentUid);

    // readSync should NOT have been called during the second listing
    expect(mockReadSync).not.toHaveBeenCalled();

    // Verify results are identical
    expect(secondResult.entries).toHaveLength(2);
    expect(secondResult.entries[0].etag).toBe(initialResult.entries[0].etag);
    expect(secondResult.entries[1].etag).toBe(initialResult.entries[1].etag);
    expect(secondResult.etag).toBe(initialResult.etag);
  });

  it('re-hashes when file is modified (size or mtime changed)', () => {
    const filePath = path.join(spaceRoot, 'mutable-large.bin');
    const initialBuf = crypto.randomBytes(2 * 1024 * 1024);
    fs.writeFileSync(filePath, initialBuf);

    const firstResult = inspectDirectory(fs, spaceRoot, currentUid);
    const initialEtag = firstResult.entries[0].etag;
    expect(initialEtag).toBe(computeFileETag(initialBuf));

    // Modify file content (new size and content)
    const modifiedBuf = crypto.randomBytes(3 * 1024 * 1024);
    fs.writeFileSync(filePath, modifiedBuf);

    const secondResult = inspectDirectory(fs, spaceRoot, currentUid);
    const modifiedEtag = secondResult.entries[0].etag;

    expect(modifiedEtag).toBe(computeFileETag(modifiedBuf));
    expect(modifiedEtag).not.toBe(initialEtag);
  });

  it('executeFileOperation op:list and op:stat integrate with ETag cache for >1MiB files', () => {
    const size3MB = 3 * 1024 * 1024;
    const buf3MB = crypto.randomBytes(size3MB);
    const expectedEtag = computeFileETag(buf3MB);

    fs.writeFileSync(path.join(spaceRoot, 'movie-script.pdf'), buf3MB);

    const mockReadSync = vi.fn((...args: Parameters<typeof fs.readSync>) => fs.readSync(...args));
    const trackedFs = {
      ...fs,
      readSync: mockReadSync,
    } as unknown as typeof fs;

    const customOptions: FileOpExecutionOptions = {
      ...defaultOptions,
      fsImpl: trackedFs,
    };

    // 1. op: list (computes and caches ETag)
    const listResult = executeFileOperation(
      { op: 'list', space: defaultSpace, path: '.' },
      customOptions
    );
    expect(listResult.op).toBe('list');
    if (listResult.op === 'list') {
      const entry = listResult.entries.find((e) => e.name === 'movie-script.pdf');
      expect(entry).toBeDefined();
      expect(entry?.size).toBe(size3MB);
      expect(entry?.etag).toBe(expectedEtag);
      expect(ETAG_REGEX.test(entry?.etag ?? '')).toBe(true);
    }
    expect(mockReadSync.mock.calls.length).toBeGreaterThan(0);

    // Reset call tracker
    mockReadSync.mockClear();

    // 2. op: stat (should hit cache - zero readSync)
    const statResult = executeFileOperation(
      { op: 'stat', space: defaultSpace, path: 'movie-script.pdf' },
      customOptions
    );
    expect(statResult.op).toBe('stat');
    if (statResult.op === 'stat') {
      expect(statResult.etag).toBe(expectedEtag);
      expect(statResult.size).toBe(size3MB);
    }
    expect(mockReadSync).not.toHaveBeenCalled();
  });

  it('handles empty (0 byte) file and mixed small/large files correctly', () => {
    fs.writeFileSync(path.join(spaceRoot, 'empty.txt'), Buffer.alloc(0));
    fs.writeFileSync(path.join(spaceRoot, 'small.txt'), Buffer.from('hello world'));
    const largeBuf = crypto.randomBytes(1.5 * 1024 * 1024);
    fs.writeFileSync(path.join(spaceRoot, 'large.bin'), largeBuf);

    const result = inspectDirectory(fs, spaceRoot, currentUid);
    expect(result.entries).toHaveLength(3);

    for (const entry of result.entries) {
      expect(entry.etag).toBeDefined();
      expect(ETAG_REGEX.test(entry.etag ?? '')).toBe(true);
    }

    const emptyEntry = result.entries.find((e) => e.name === 'empty.txt');
    expect(emptyEntry?.etag).toBe(computeFileETag(Buffer.alloc(0)));

    const smallEntry = result.entries.find((e) => e.name === 'small.txt');
    expect(smallEntry?.etag).toBe(computeFileETag(Buffer.from('hello world')));

    const largeEntry = result.entries.find((e) => e.name === 'large.bin');
    expect(largeEntry?.etag).toBe(computeFileETag(largeBuf));
  });
});
