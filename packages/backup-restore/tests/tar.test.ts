import { describe, it, expect } from 'vitest';
import {
  TarWriter,
  TarReader,
  normalizeAndValidateArchivePath,
  BLOCK_SIZE,
} from '../src/index.js';
import {
  BackupArchiveError,
  BackupPathSafetyError,
} from '../src/errors.js';

describe('Tar Writer, Reader & Safety Guards', () => {
  it('normalizes valid relative paths and rejects path traversal', () => {
    expect(normalizeAndValidateArchivePath('platform.db')).toBe('platform.db');
    expect(normalizeAndValidateArchivePath('sessions/sp_alice/session.jsonl')).toBe(
      'sessions/sp_alice/session.jsonl'
    );
    expect(normalizeAndValidateArchivePath('/sessions/sp_alice/session.jsonl')).toBe(
      'sessions/sp_alice/session.jsonl'
    );
    expect(normalizeAndValidateArchivePath('./sessions/sp_alice/session.jsonl')).toBe(
      'sessions/sp_alice/session.jsonl'
    );

    expect(() => normalizeAndValidateArchivePath('../escape.db')).toThrow(BackupPathSafetyError);
    expect(() => normalizeAndValidateArchivePath('sessions/../../escape.db')).toThrow(
      BackupPathSafetyError
    );
    expect(() => normalizeAndValidateArchivePath('')).toThrow(BackupPathSafetyError);
    expect(() => normalizeAndValidateArchivePath('null\x00byte')).toThrow(BackupPathSafetyError);
  });

  it('packs and unpacks standard files round-trip', () => {
    const writer = new TarWriter();
    writer.addFile({
      path: 'secrets.json',
      data: Buffer.from('{"secret":"token123"}', 'utf8'),
      mode: 0o600,
    });
    writer.addFile({
      path: 'sessions/session_1.jsonl',
      data: Buffer.from('{"role":"user","content":"hello"}\n', 'utf8'),
      mode: 0o600,
    });

    const tarBuffer = writer.finalize();
    expect(tarBuffer.length % BLOCK_SIZE).toBe(0);

    const reader = new TarReader();
    const entries = reader.readAllEntries(tarBuffer);

    expect(entries.length).toBe(2);
    expect(entries[0]!.path).toBe('secrets.json');
    expect(entries[0]!.data.toString('utf8')).toBe('{"secret":"token123"}');
    expect(entries[0]!.mode).toBe(0o600);

    expect(entries[1]!.path).toBe('sessions/session_1.jsonl');
    expect(entries[1]!.data.toString('utf8')).toBe('{"role":"user","content":"hello"}\n');
  });

  it('supports GNU LongLink for long file paths (> 100 characters)', () => {
    const longPath = 'sessions/very_long_project_directory_name_that_exceeds_one_hundred_characters_in_total_length/subfolder/session_data.jsonl';
    expect(Buffer.from(longPath, 'utf8').length).toBeGreaterThan(100);

    const writer = new TarWriter();
    writer.addFile({
      path: longPath,
      data: Buffer.from('long path content', 'utf8'),
    });

    const tarBuffer = writer.finalize();
    const reader = new TarReader();
    const entries = reader.readAllEntries(tarBuffer);

    expect(entries.length).toBe(1);
    expect(entries[0]!.path).toBe(longPath);
    expect(entries[0]!.data.toString('utf8')).toBe('long path content');
  });

  it('rejects duplicate paths and case collisions during write', () => {
    const writer = new TarWriter();
    writer.addFile({
      path: 'platform.db',
      data: Buffer.from('db1'),
    });

    expect(() =>
      writer.addFile({
        path: 'platform.db',
        data: Buffer.from('db2'),
      })
    ).toThrow(BackupArchiveError);

    expect(() =>
      writer.addFile({
        path: 'PLATFORM.DB',
        data: Buffer.from('db3'),
      })
    ).toThrow(BackupArchiveError);
  });

  it('enforces max file size limit', () => {
    const writer = new TarWriter({ maxFileSize: 50 });
    expect(() =>
      writer.addFile({
        path: 'large.bin',
        data: Buffer.alloc(100),
      })
    ).toThrow(BackupArchiveError);
  });

  it('enforces max total size limit', () => {
    const writer = new TarWriter({ maxTotalSize: 100 });
    writer.addFile({ path: 'f1.bin', data: Buffer.alloc(60) });
    expect(() =>
      writer.addFile({ path: 'f2.bin', data: Buffer.alloc(60) })
    ).toThrow(BackupArchiveError);
  });

  it('enforces max file count limit', () => {
    const writer = new TarWriter({ maxFileCount: 2 });
    writer.addFile({ path: 'f1.bin', data: Buffer.alloc(10) });
    writer.addFile({ path: 'f2.bin', data: Buffer.alloc(10) });
    expect(() =>
      writer.addFile({ path: 'f3.bin', data: Buffer.alloc(10) })
    ).toThrow(BackupArchiveError);
  });

  it('reader rejects empty archive or corrupted block sizes', () => {
    const reader = new TarReader();
    expect(() => reader.readAllEntries(Buffer.alloc(0))).toThrow(BackupArchiveError);
    expect(() => reader.readAllEntries(Buffer.alloc(300))).toThrow(BackupArchiveError);
  });

  it('reader rejects symlink entries if present in tar stream', () => {
    // Construct a handcrafted 512-byte tar header with typeflag '2' (symlink)
    const header = Buffer.alloc(512, 0);
    header.write('symlink_entry', 0, 13, 'ascii');
    header.write('0000777\0', 100, 8, 'ascii');
    header.write('00000000000\0', 124, 12, 'ascii');
    header[156] = 50; // '2' for symlink
    header.write('target_file', 157, 11, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');

    // Compute checksum
    let sum = 0;
    for (let i = 0; i < 512; i++) {
      if (i >= 148 && i < 156) sum += 32;
      else sum += header[i]!;
    }
    const chkStr = sum.toString(8).padStart(6, '0') + '\0 ';
    header.write(chkStr, 148, 8, 'ascii');

    const tarData = Buffer.concat([header, Buffer.alloc(1024, 0)]);

    const reader = new TarReader();
    expect(() => reader.readAllEntries(tarData)).toThrow(BackupArchiveError);
  });
});
