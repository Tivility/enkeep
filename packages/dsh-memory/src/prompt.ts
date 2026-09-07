/**
 * Memory Prompt Section Construction and Sanitization
 *
 * Implements:
 * 1. XML sanitization / escaping to prevent prompt injection and tag breakout.
 * 2. Template variable shielding (`{{` / `}}`) to prevent DSH systemPrompt assemble errors.
 * 3. Strict byte bounding (default 20 KiB for global memory).
 * 4. Deterministic SHA-256 content hashing.
 * 5. Structured `<enkeep_memory>` prompt section formatting.
 *
 * @module @enkeep/dsh-memory/prompt
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AssembleMemoryOptions, MemorySnapshot } from './types.js';

export const DEFAULT_MAX_GLOBAL_MEMORY_BYTES = 20 * 1024; // 20 KiB
export const MEMORY_SECTION_NAME = 'memory:enkeep';
export const MEMORY_SECTION_ORDER = 50; // After agent profile (10..40), before workspace tools (100+)

/**
 * Escapes XML special characters so untrusted memory content cannot break XML structure.
 */
export function escapeXmlContent(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Escapes DSH template variable delimiters (`{{` and `}}`) using XML numeric character entities.
 * This prevents DSH's systemPrompt variable interpolation from throwing errors on arbitrary user memory.
 */
export function escapeTemplateVariables(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/\{\{/g, '&#123;&#123;')
    .replace(/\}\}/g, '&#125;&#125;');
}

/**
 * Sanitizes memory text for safe inclusion inside XML prompt sections.
 */
export function sanitizeMemoryForPrompt(raw: string): string {
  const xmlEscaped = escapeXmlContent(raw);
  return escapeTemplateVariables(xmlEscaped);
}

/**
 * Computes a deterministic SHA-256 hash for a given string or buffer.
 */
export function computeContentHash(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Truncates UTF-8 text safely within a specified byte limit without slicing in the middle of multi-byte characters.
 */
export function truncateUtf8Bytes(text: string, maxBytes: number): { text: string; truncated: boolean; originalBytes: number } {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) {
    return { text, truncated: false, originalBytes: buf.length };
  }

  // Safe truncation avoiding half-character UTF-8 splits
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--;
  }
  const slicedBuf = buf.subarray(0, end);
  const truncatedText = slicedBuf.toString('utf-8');
  return {
    text: truncatedText,
    truncated: true,
    originalBytes: buf.length,
  };
}

/**
 * Ensures the global memory skeleton file exists under dshHome.
 */
export function ensureGlobalMemorySkeleton(dshHome: string): string {
  const memoryDir = path.join(dshHome, 'memory');
  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
  }
  const globalPath = path.join(memoryDir, 'global.md');
  if (!fs.existsSync(globalPath)) {
    const defaultSkeleton = '# Global Memory\n\nThis is your long-term memory across all spaces and sessions.\n';
    fs.writeFileSync(globalPath, defaultSkeleton, { encoding: 'utf-8', mode: 0o600 });
  }
  return globalPath;
}

/**
 * Loads global memory snapshot from disk within bounded limits.
 */
export function loadGlobalMemorySnapshot(
  dshHome: string,
  maxBytes = DEFAULT_MAX_GLOBAL_MEMORY_BYTES,
  customGlobalPath?: string
): { content: string; hash: string; etag: string; size: number; truncated: boolean; rawPath: string } {
  const globalPath = customGlobalPath && path.isAbsolute(customGlobalPath)
    ? customGlobalPath
    : path.join(dshHome, 'memory', 'global.md');

  if (!fs.existsSync(globalPath)) {
    ensureGlobalMemorySkeleton(dshHome);
  }

  let rawContent = '';
  try {
    rawContent = fs.readFileSync(globalPath, 'utf-8');
  } catch {
    rawContent = '';
  }

  const { text: boundedContent, truncated, originalBytes } = truncateUtf8Bytes(rawContent, maxBytes);
  const hash = computeContentHash(rawContent);
  const etag = `"${hash.slice(0, 16)}"`;

  return {
    content: boundedContent,
    hash,
    etag,
    size: originalBytes,
    truncated,
    rawPath: globalPath,
  };
}

/**
 * Assembles the full model-visible <enkeep_memory> prompt section text and computes its hash.
 */
export function assembleMemoryPromptSection(options: AssembleMemoryOptions): {
  text: string;
  hash: string;
  revision: string;
  snapshot: MemorySnapshot;
} {
  const {
    dshHome,
    spacePath,
    spaceId,
    maxGlobalBytes = DEFAULT_MAX_GLOBAL_MEMORY_BYTES,
    injectGlobalMemory = 'always',
    memoryPlan,
  } = options;

  const effectiveInjectMode = memoryPlan?.injectGlobalMemory ?? injectGlobalMemory;
  const effectiveMaxBytes = memoryPlan?.maxGlobalBytes ?? maxGlobalBytes;

  let globalMemorySnapshot: MemorySnapshot['globalMemory'];
  let globalSanitizedText = '';

  if (effectiveInjectMode !== 'never') {
    const loaded = loadGlobalMemorySnapshot(dshHome, effectiveMaxBytes, memoryPlan?.globalMemoryPath);
    globalMemorySnapshot = {
      path: 'global.md',
      content: loaded.content,
      etag: loaded.etag,
      size: loaded.size,
      truncated: loaded.truncated,
    };

    let sanitized = sanitizeMemoryForPrompt(loaded.content);
    if (loaded.truncated) {
      sanitized += `\n\n[... Note: Global memory truncated to ${effectiveMaxBytes} bytes budget. Use memory_read tool to view full content ...]`;
    }
    globalSanitizedText = sanitized;
  }

  const spaceMemoryDirAvailable = Boolean(spacePath && fs.existsSync(path.join(spacePath, 'memory')));
  let spaceFilesCount = 0;
  if (spacePath && spaceMemoryDirAvailable) {
    try {
      const files = fs.readdirSync(path.join(spacePath, 'memory'));
      spaceFilesCount = files.filter(f => !f.startsWith('.')).length;
    } catch {
      spaceFilesCount = 0;
    }
  }

  const spaceMemorySnapshot: MemorySnapshot['spaceMemory'] = {
    spaceId: spaceId ?? (spacePath ? path.basename(spacePath) : undefined),
    spacePath: spacePath ? 'memory/' : undefined,
    available: spaceMemoryDirAvailable,
    filesCount: spaceFilesCount,
  };

  // Build the complete deterministic XML section
  const lines: string[] = [];
  const rawHashInput = `${globalMemorySnapshot?.etag ?? 'none'}:${spaceMemorySnapshot.spaceId ?? 'none'}:${spaceMemorySnapshot.filesCount ?? 0}`;
  const computedHash = computeContentHash(rawHashInput);
  const revision = memoryPlan?.revision ?? `mem_rev_${computedHash.slice(0, 16)}`;

  lines.push(`<enkeep_memory revision="${revision}" hash="${computedHash}">`);
  lines.push('The following is user-managed long-term memory. It represents persistent user context, preferences, and knowledge. Treat this as reliable user context and follow it unless it contradicts explicit safety policies or current system instructions.');

  if (globalMemorySnapshot) {
    lines.push(
      `<global_memory source="global" path="${globalMemorySnapshot.path}" size="${globalMemorySnapshot.size}" hash="${globalMemorySnapshot.etag.replace(/"/g, '')}" truncated="${globalMemorySnapshot.truncated}">`
    );
    lines.push(globalSanitizedText);
    lines.push('</global_memory>');
  }

  lines.push(
    `<space_memory spaceId="${spaceMemorySnapshot.spaceId ?? 'default'}" path="memory/" available="${spaceMemorySnapshot.available}" filesCount="${spaceMemorySnapshot.filesCount}">`
  );
  lines.push(
    'Space-specific memories and date-based memory notes are located in the `memory/` directory. Use the `memory_search` and `memory_read` tools to retrieve relevant memory entries on demand, and `memory_write` to store new facts or updates for this space.'
  );
  lines.push('</space_memory>');
  lines.push('</enkeep_memory>');

  const promptText = lines.join('\n');
  const sectionHash = computeContentHash(promptText);

  const snapshot: MemorySnapshot = {
    globalMemory: globalMemorySnapshot,
    spaceMemory: spaceMemorySnapshot,
    revision,
    hash: sectionHash,
  };

  return {
    text: promptText,
    hash: sectionHash,
    revision,
    snapshot,
  };
}
