/**
 * Extract plain text from common file types for inline prompt injection.
 *
 * Models often fail to call read reliably or hallucinate when encountering
 * binary attachments. Feeding extracted plain text directly into the prompt
 * under a secure nonce fence bypasses unreliable tool-use round-trips.
 *
 * Supported formats:
 * - PDF           → `pdftotext -layout <file> -` (poppler-utils)
 * - Office (doc/docx/rtf) → `textutil -convert txt -stdout` (macOS)
 *                           or `pandoc --to=plain` (Linux container)
 *                           fallback: user guidance placeholder
 * - Text (txt/md/csv/json/yaml/html/etc.) → fs.readFile
 * - Others        → returns null (caller retains original file path reference)
 *
 * @module @enkeep/runtime-runner/runtime/file-text-extractor
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileP = promisify(execFile);

export const DEFAULT_EXTRACT_MAX_BYTES = 20 * 1024; // 20 KB
export const EXTRACT_MAX_BYTES = DEFAULT_EXTRACT_MAX_BYTES;
export const EXEC_TIMEOUT_MS = 15_000;
export const EXEC_MAX_BUFFER = 512 * 1024; // 512 KB
export const TRUNCATION_NOTE = '\n\n[...内容过长已截断，完整文件见原路径]';

export const TEXT_EXTS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.log',
  '.yml',
  '.yaml',
  '.xml',
  '.html',
  '.htm',
]);

export const OFFICE_EXTS = new Set(['.doc', '.docx', '.rtf']);

export interface ExtractResult {
  /** Extracted plain text (possibly truncated with a marker). */
  text: string;
  /** True when extracted text exceeded the cap and was truncated. */
  truncated: boolean;
  /** Extractor that produced the text. */
  method: 'pdftotext' | 'textutil' | 'pandoc' | 'fs';
}

export function getExtractMaxBytes(): number {
  if (process.env.DSH_EXTRACT_MAX_BYTES) {
    const parsed = parseInt(process.env.DSH_EXTRACT_MAX_BYTES, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_EXTRACT_MAX_BYTES;
}

export function truncate(
  text: string,
  maxBytes: number = getExtractMaxBytes(),
): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) {
    return { text, truncated: false };
  }
  // Walk the byte before the cut point backward to a valid UTF-8 char
  // boundary so we don't leave a mid-codepoint byte that decodes to U+FFFD.
  // A UTF-8 continuation byte is 0x80–0xBF; a multi-byte start is >= 0xC0.
  let end = maxBytes;
  while (end > 0) {
    const b = buf[end - 1]!;
    if (b < 0x80) break; // ASCII — safe boundary
    if (b >= 0xc0) {
      // Start byte of an incomplete multi-byte char at the boundary — drop it.
      end -= 1;
      break;
    }
    end -= 1; // continuation — keep walking back
  }
  const safe = buf.subarray(0, end).toString('utf8');
  return { text: safe + TRUNCATION_NOTE, truncated: true };
}

/**
 * Try to extract plain text from `filePath`. Returns null when the file type
 * is not supported, empty, or extraction fails.
 * Pure in-memory extraction with zero disk sidecar caching.
 */
export async function extractFileText(
  filePath: string,
  options?: { maxBytes?: number },
): Promise<ExtractResult | null> {
  const maxBytes = options?.maxBytes ?? getExtractMaxBytes();
  const ext = path.extname(filePath).toLowerCase();

  try {
    if (ext === '.pdf') {
      const { stdout } = await execFileP(
        'pdftotext',
        ['-layout', filePath, '-'],
        { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER },
      );
      if (stdout.trim().length === 0) {
        return null;
      }
      const { text, truncated } = truncate(stdout, maxBytes);
      return { text, truncated, method: 'pdftotext' };
    }

    if (OFFICE_EXTS.has(ext)) {
      // Try textutil first (macOS), then pandoc (Linux container).
      for (const [bin, args, label] of [
        ['textutil', ['-convert', 'txt', '-stdout', filePath], 'textutil'] as const,
        ['pandoc', ['--to=plain', filePath], 'pandoc'] as const,
      ]) {
        try {
          const { stdout } = await execFileP(bin, args, {
            timeout: EXEC_TIMEOUT_MS,
            maxBuffer: EXEC_MAX_BUFFER,
          });
          if (stdout.trim().length > 0) {
            const { text, truncated } = truncate(stdout, maxBytes);
            return { text, truncated, method: label };
          }
        } catch {
          // This binary not available or failed — try next.
        }
      }
      // Both textutil and pandoc missing or failed — return placeholder so
      // the Agent can inform the user to convert to PDF / Markdown.
      const cleanExt = ext.replace(/^\./, '');
      return {
        text: `[无法提取 .${cleanExt} 文件内容：当前环境不支持此格式。请将文件转为 PDF 或 Markdown 格式后重新发送。]`,
        truncated: false,
        method: 'textutil',
      };
    }

    if (TEXT_EXTS.has(ext)) {
      const raw = await fs.readFile(filePath, 'utf8');
      if (raw.trim().length === 0) {
        return null;
      }
      const { text, truncated } = truncate(raw, maxBytes);
      return { text, truncated, method: 'fs' };
    }

    return null;
  } catch (_err) {
    // Missing binary, timeout, maxBuffer exceeded, unreadable file, etc.
    // Graceful degradation: caller falls back to path-only reference.
    return null;
  }
}
