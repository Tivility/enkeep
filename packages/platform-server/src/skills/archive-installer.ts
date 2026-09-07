import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { PlatformError, ValidationError } from '@enkeep/platform-core';
import { TarReader, type ExtractedTarEntry } from '@enkeep/backup-restore';
import {
  validateSkillDirectory,
  MAX_SKILL_TOTAL_BYTES,
  MAX_SKILL_FILE_SIZE_BYTES,
  MAX_SKILL_FILES_COUNT,
} from './security-validator.js';
import type { ValidatedSkillPayload } from './skill-types.js';

import { createSecureTempDir } from './git-installer.js';

export interface StagedArchiveSkillResult {
  stageDir: string;
  targetDir: string;
  payload: ValidatedSkillPayload;
  cleanup: () => void;
}

/**
 * Parses zip archive headers and extracts files into memory safely.
 */
function extractZipBuffer(zipBuffer: Buffer): Array<{ path: string; data: Buffer }> {
  const entries: Array<{ path: string; data: Buffer }> = [];
  let offset = 0;
  let totalBytes = 0;

  while (offset < zipBuffer.length - 4) {
    const signature = zipBuffer.readUInt32LE(offset);

    // End of central directory or Central directory file header
    if (signature === 0x02014b50 || signature === 0x06054b50) {
      break;
    }

    // Local file header signature: 0x04034b50 ('PK\x03\x04')
    if (signature !== 0x04034b50) {
      // Advance to search
      offset++;
      continue;
    }

    if (offset + 30 > zipBuffer.length) {
      throw new ValidationError('Malformed zip archive header: unexpected end of buffer');
    }

    const compressionMethod = zipBuffer.readUInt16LE(offset + 8);
    const compressedSize = zipBuffer.readUInt32LE(offset + 18);
    const uncompressedSize = zipBuffer.readUInt32LE(offset + 22);
    const fileNameLength = zipBuffer.readUInt16LE(offset + 26);
    const extraFieldLength = zipBuffer.readUInt16LE(offset + 28);

    if (uncompressedSize > MAX_SKILL_FILE_SIZE_BYTES) {
      throw new ValidationError(
        `Zip entry uncompressed size (${uncompressedSize} bytes) exceeds limit of ${MAX_SKILL_FILE_SIZE_BYTES} bytes`
      );
    }

    const fileNameStart = offset + 30;
    const fileNameEnd = fileNameStart + fileNameLength;
    if (fileNameEnd > zipBuffer.length) {
      throw new ValidationError('Malformed zip archive: entry filename exceeds buffer');
    }

    const fileName = zipBuffer.subarray(fileNameStart, fileNameEnd).toString('utf8');
    const dataStart = fileNameEnd + extraFieldLength;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd > zipBuffer.length) {
      throw new ValidationError('Malformed zip archive: entry payload exceeds buffer');
    }

    const compressedData = zipBuffer.subarray(dataStart, dataEnd);
    let entryData: Buffer;

    if (compressionMethod === 0) {
      // Stored (no compression)
      entryData = compressedData;
    } else if (compressionMethod === 8) {
      // Deflated
      try {
        entryData = zlib.inflateRawSync(compressedData);
      } catch (err) {
        throw new ValidationError(`Failed to inflate zip entry "${fileName}": ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      throw new ValidationError(`Unsupported zip compression method: ${compressionMethod} in entry "${fileName}"`);
    }

    if (entryData.length !== uncompressedSize) {
      throw new ValidationError(
        `Zip entry size mismatch for "${fileName}": header says ${uncompressedSize}, extracted ${entryData.length}`
      );
    }

    totalBytes += entryData.length;
    if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
      throw new ValidationError(`Total zip uncompressed size exceeds limit of ${MAX_SKILL_TOTAL_BYTES} bytes`);
    }

    // Skip directories (ending in /)
    if (!fileName.endsWith('/')) {
      entries.push({ path: fileName, data: entryData });
      if (entries.length > MAX_SKILL_FILES_COUNT) {
        throw new ValidationError(`Zip contains more than ${MAX_SKILL_FILES_COUNT} files`);
      }
    }

    offset = dataEnd;
  }

  return entries;
}

/**
 * Extracts and stages an uploaded archive buffer (tar, tar.gz, tgz, zip).
 */
export async function stageArchiveSkill(
  archiveBuffer: Buffer,
  filename = 'skill.tar.gz'
): Promise<StagedArchiveSkillResult> {
  if (!archiveBuffer || archiveBuffer.length === 0) {
    throw new ValidationError('Archive buffer is empty');
  }

  const stageDir = createSecureTempDir('enkeep-archive-skill-');

  const cleanup = () => {
    const errors: Error[] = [];
    if (fs.existsSync(stageDir)) {
      try {
        fs.rmSync(stageDir, { recursive: true, force: true });
      } catch (rmErr) {
        if (rmErr && (rmErr as NodeJS.ErrnoException).code !== 'ENOENT') {
          errors.push(new PlatformError('Failed to remove archive staging directory', 'STAGE_CLEANUP_FAILED'));
        }
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to clean up archive staging directory');
    }
  };

  try {
    let extractedFiles: Array<{ path: string; data: Buffer }> = [];

    const isGzip = archiveBuffer.length >= 2 && archiveBuffer[0] === 0x1f && archiveBuffer[1] === 0x8b;
    const isZip = archiveBuffer.length >= 4 && archiveBuffer[0] === 0x50 && archiveBuffer[1] === 0x4b;

    if (isZip || filename.endsWith('.zip')) {
      extractedFiles = extractZipBuffer(archiveBuffer);
    } else if (isGzip || filename.endsWith('.gz') || filename.endsWith('.tgz')) {
      let tarBuffer: Buffer;
      try {
        tarBuffer = zlib.gunzipSync(archiveBuffer);
      } catch (err) {
        throw new ValidationError(`Failed to decompress gzip archive: ${err instanceof Error ? err.message : String(err)}`);
      }
      const reader = new TarReader({
        maxFileSize: MAX_SKILL_FILE_SIZE_BYTES,
        maxTotalSize: MAX_SKILL_TOTAL_BYTES,
        maxFileCount: MAX_SKILL_FILES_COUNT,
      });
      const tarEntries = reader.readAllEntries(tarBuffer);
      extractedFiles = tarEntries.map((e: ExtractedTarEntry) => ({ path: e.path, data: e.data }));
    } else {
      // Plain tar
      const reader = new TarReader({
        maxFileSize: MAX_SKILL_FILE_SIZE_BYTES,
        maxTotalSize: MAX_SKILL_TOTAL_BYTES,
        maxFileCount: MAX_SKILL_FILES_COUNT,
      });
      const tarEntries = reader.readAllEntries(archiveBuffer);
      extractedFiles = tarEntries.map((e: ExtractedTarEntry) => ({ path: e.path, data: e.data }));
    }

    if (extractedFiles.length === 0) {
      throw new ValidationError('Archive contains no files');
    }

    // Write files into stageDir
    for (const file of extractedFiles) {
      const normalizedRel = path.normalize(file.path).replace(/^(\.\.(\/|\\|$))+/, '');
      if (normalizedRel.startsWith('..') || path.isAbsolute(normalizedRel)) {
        throw new ValidationError(`Path traversal detected in archive entry "${file.path}"`);
      }

      const destPath = path.join(stageDir, normalizedRel);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, file.data, { mode: 0o600 });
    }

    // Check if the archive wrapped everything in a single root folder
    const topEntries = fs.readdirSync(stageDir);
    let targetDir = stageDir;
    if (topEntries.length === 1) {
      const singleTop = path.join(stageDir, topEntries[0]);
      if (fs.statSync(singleTop).isDirectory()) {
        targetDir = singleTop;
      }
    }

    const payload = validateSkillDirectory(stageDir, targetDir !== stageDir ? topEntries[0] : undefined);

    return {
      stageDir,
      targetDir,
      payload,
      cleanup,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}
