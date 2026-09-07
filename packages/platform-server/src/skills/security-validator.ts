import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ValidationError } from '@enkeep/platform-core';
import type { ParsedSkillFrontmatter, ValidatedSkillPayload } from './skill-types.js';
import { validateExtensionJson, type CanonicalExtensionContribution } from '../extensions/extension-manifest-validator.js';

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SKILL_FILES_COUNT = 500;
export const MAX_SKILL_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_SKILL_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Validates that a skill name is strictly kebab-case without traversal or special chars.
 */
export function validateSkillName(name: string): string {
  if (typeof name !== 'string' || !name || name.trim() !== name) {
    throw new ValidationError('Skill name must be a non-empty string without leading or trailing whitespace');
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new ValidationError(
      `Invalid skill name "${name}". Skill name must match kebab-case pattern: ^[a-z0-9]+(?:-[a-z0-9]+)*$`
    );
  }
  if (name.length > 64) {
    throw new ValidationError(`Skill name "${name}" exceeds maximum allowed length of 64 characters`);
  }
  return name;
}

/**
 * Sanitizes repository URL by removing username, password, or token credentials.
 */
export function sanitizeRepositoryUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    // If it's a valid URL with credentials
    if (rawUrl.includes('://')) {
      const url = new URL(rawUrl);
      if (url.username || url.password) {
        url.username = '';
        url.password = '';
      }
      return url.toString();
    }
    // If it's SSH format like git@github.com:org/repo.git
    if (rawUrl.startsWith('git@') || rawUrl.includes('@')) {
      return rawUrl.replace(/^[^@]+@/, 'git@');
    }
    return rawUrl;
  } catch (_err) {
    return rawUrl.replace(/\/\/[^@]+@/, '//');
  }
}

/**
 * Validates repository URL against scheme allowlist, embedded credentials, and argument injection attacks.
 */
export function validateRepositoryUrl(rawUrl: string): void {
  if (typeof rawUrl !== 'string' || !rawUrl || rawUrl.trim() !== rawUrl) {
    throw new ValidationError('Repository URL must be a non-empty string without leading or trailing whitespace');
  }
  const trimmed = rawUrl.trim();

  // Reject argument injection (e.g. --upload-pack, -c, etc.)
  if (trimmed.startsWith('-') || trimmed.startsWith('--')) {
    throw new ValidationError('Repository URL must not start with dash flags (argument injection defense)');
  }

  // Reject embedded credentials in URL
  if (trimmed.includes('://')) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.username || parsed.password) {
        throw new ValidationError(
          'Embedded credentials (username/password/token) in Git repository URL are strictly prohibited. Pass authentication tokens via secure authorization configuration.'
        );
      }
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(`Malformed Git repository URL: "${rawUrl}"`);
    }
  } else if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:/.test(trimmed)) {
    const scpUser = trimmed.split('@')[0];
    if (scpUser !== 'git') {
      throw new ValidationError(
        'Embedded custom user in SSH Git repository URL is prohibited. Pass authentication via secure SSH key configuration.'
      );
    }
  }
}

/**
 * Parses frontmatter from SKILL.md.
 */
export function parseSkillMarkdown(raw: string): ParsedSkillFrontmatter {
  const firstLineEnd = raw.indexOf('\n');
  if (firstLineEnd < 0) {
    throw new ValidationError('Invalid skill content: missing YAML frontmatter delimiters');
  }
  const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/, '');
  if (firstLine !== '---') {
    throw new ValidationError('Invalid skill content: must start with "---" YAML frontmatter delimiter');
  }

  const start = firstLineEnd + 1;
  let lineStart = start;
  let closing: { start: number; bodyStart: number } | undefined;

  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart);
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '');
    if (line === '---') {
      closing = { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 };
      break;
    }
    if (nextNewline < 0) break;
    lineStart = nextNewline + 1;
  }

  if (!closing) {
    throw new ValidationError('Invalid skill content: unclosed YAML frontmatter ("---" closing delimiter not found)');
  }

  const yamlText = raw.slice(start, closing.start);
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (err) {
    throw new ValidationError(`Invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError('Invalid YAML frontmatter: top-level must be an object');
  }

  const data = parsed as Record<string, unknown>;
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  const description = typeof data.description === 'string' ? data.description.trim() : '';

  if (!name) {
    throw new ValidationError('YAML frontmatter requires non-empty "name" field');
  }
  validateSkillName(name);

  if (!description) {
    throw new ValidationError('YAML frontmatter requires non-empty "description" field');
  }

  const whenToUse = typeof data['whenToUse'] === 'string' ? (data['whenToUse'] as string).trim() : undefined;
  const disableModelInvocation =
    data['disable-model-invocation'] === true || data['disableModelInvocation'] === true;
  const userInvocable = data['user-invocable'] !== false && data['userInvocable'] !== false;

  const content = raw.slice(closing.bodyStart).trim();

  return {
    name,
    description,
    whenToUse,
    disableModelInvocation,
    userInvocable,
    metadata: data,
    content,
  };
}

/**
 * Updates or sets disable-model-invocation in YAML frontmatter while preserving other fields and body.
 */
export function updateSkillFrontmatterInvocation(raw: string, disableModelInvocation: boolean): string {
  const firstLineEnd = raw.indexOf('\n');
  if (firstLineEnd < 0) return raw;
  const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/, '');
  if (firstLine !== '---') return raw;

  const start = firstLineEnd + 1;
  let lineStart = start;
  let closing: { start: number; bodyStart: number } | undefined;

  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart);
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '');
    if (line === '---') {
      closing = { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 };
      break;
    }
    if (nextNewline < 0) break;
    lineStart = nextNewline + 1;
  }

  if (!closing) return raw;

  const yamlText = raw.slice(start, closing.start);
  let parsed: any;
  try {
    parsed = parseYaml(yamlText) || {};
  } catch (_err) {
    return raw;
  }

  if (disableModelInvocation) {
    parsed['disable-model-invocation'] = true;
  } else {
    delete parsed['disable-model-invocation'];
    delete parsed['disableModelInvocation'];
  }

  // Serialize back to YAML
  const yamlLines = Object.entries(parsed)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`)
    .join('\n');

  const body = raw.slice(closing.bodyStart);
  return `---\n${yamlLines}\n---\n${body}`;
}

/**
 * Validates a staged skill directory for:
 * - Special files rejection (symlinks, hardlinks, FIFOs, sockets, devices)
 * - Unicode NFC normalization
 * - Case collision detection
 * - Traversal and limits check
 * - SKILL.md validity
 * - Deterministic SHA-256 calculation
 */
export function validateSkillDirectory(stageDir: string, subdirectory?: string): ValidatedSkillPayload {
  const targetDir = subdirectory ? path.join(stageDir, subdirectory) : stageDir;
  if (!fs.existsSync(targetDir)) {
    throw new ValidationError(`Skill target directory does not exist: "${subdirectory || '.'}"`);
  }

  // Ensure targetDir stays strictly inside stageDir
  const rel = path.relative(stageDir, targetDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ValidationError('Path traversal detected in skill subdirectory');
  }

  const lowerCasePaths = new Set<string>();
  const allFiles: Array<{ relPath: string; fullPath: string; stat: fs.Stats }> = [];
  let totalBytes = 0;

  function walk(currentDir: string, currentRel: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const name = entry.name;

      // Ignore VCS metadata directory
      if (name === '.git') {
        continue;
      }

      // Check Unicode NFC
      if (name.normalize('NFC') !== name) {
        throw new ValidationError(`Unicode normalization error: file "${name}" is not in NFC form`);
      }

      // Reject submodules / .gitmodules files
      if (name === '.gitmodules') {
        throw new ValidationError('Submodule definition file (.gitmodules) is strictly prohibited in skills');
      }

      // Check case collision
      const entryRel = currentRel ? `${currentRel}/${name}` : name;
      const lower = entryRel.toLowerCase();
      if (lowerCasePaths.has(lower)) {
        throw new ValidationError(`Case collision detected for path "${entryRel}"`);
      }
      lowerCasePaths.add(lower);

      const fullPath = path.join(currentDir, name);
      const lstat = fs.lstatSync(fullPath);

      if (lstat.isSymbolicLink()) {
        throw new ValidationError(`Symlink detected at "${entryRel}". Symlinks are strictly prohibited in skills.`);
      }
      if (lstat.isFIFO() || lstat.isSocket() || lstat.isCharacterDevice() || lstat.isBlockDevice()) {
        throw new ValidationError(`Special file detected at "${entryRel}". Special files are prohibited.`);
      }

      if (lstat.isDirectory()) {
        walk(fullPath, entryRel);
      } else if (lstat.isFile()) {
        if (lstat.nlink > 1) {
          throw new ValidationError(`Hard-linked file detected (nlink=${lstat.nlink}) at "${entryRel}". Refusing skill.`);
        }
        if (lstat.size > MAX_SKILL_FILE_SIZE_BYTES) {
          throw new ValidationError(
            `File "${entryRel}" size (${lstat.size} bytes) exceeds maximum file limit of ${MAX_SKILL_FILE_SIZE_BYTES} bytes`
          );
        }
        totalBytes += lstat.size;
        if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
          throw new ValidationError(`Skill total payload size exceeds maximum limit of ${MAX_SKILL_TOTAL_BYTES} bytes`);
        }
        allFiles.push({ relPath: entryRel, fullPath, stat: lstat });
        if (allFiles.length > MAX_SKILL_FILES_COUNT) {
          throw new ValidationError(`Skill contains more than ${MAX_SKILL_FILES_COUNT} files`);
        }
      }
    }
  }

  walk(targetDir, '');

  // 1. Check for extension.json at target directory root
  const extJsonFile = allFiles.find((f) => f.relPath === 'extension.json' || f.relPath === 'extension.JSON');
  if (extJsonFile) {
    const rawJson = fs.readFileSync(extJsonFile.fullPath, 'utf8');
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawJson);
    } catch (jsonErr) {
      throw new ValidationError(`Malformed extension.json: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`);
    }

    const validatedExt = validateExtensionJson(parsedJson);

    // Compute deterministic SHA-256 across all files sorted by relative path
    allFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));
    const hasher = crypto.createHash('sha256');
    for (const file of allFiles) {
      hasher.update(`FILE:${file.relPath}\n`);
      const content = fs.readFileSync(file.fullPath);
      hasher.update(content);
    }
    const contentHash = hasher.digest('hex');

    const isMcp = validatedExt.contributions.some((c) => c.kind === 'mcp');
    const isCli = validatedExt.contributions.some((c) => c.kind === 'cli');

    for (const c of validatedExt.contributions) {
      if (c.kind === 'cli') {
        const cliManifest = c.manifest as Record<string, unknown>;
        const scriptPath = typeof cliManifest.script === 'string' ? cliManifest.script.trim() : '';
        if (scriptPath) {
          const scriptFound = allFiles.some(
            (f) => f.relPath === scriptPath || f.relPath === scriptPath.replace(/\\/g, '/')
          );
          if (!scriptFound) {
            throw new ValidationError(`CLI contribution script "${scriptPath}" not found in extension package`);
          }
        }
      }
    }

    let skillContent = '';

    if (!isMcp && !isCli) {
      // For skill extensions, check if SKILL.md or entrypoint exists
      const directSkillMd = allFiles.find((f) => f.relPath === 'SKILL.md' || f.relPath === 'skill.md');
      if (directSkillMd) {
        skillContent = fs.readFileSync(directSkillMd.fullPath, 'utf8');
      }
    }

    const firstContrib = validatedExt.contributions[0];
    const contribManifest = (firstContrib?.manifest || {}) as Record<string, unknown>;

    return {
      slug: validatedExt.slug,
      name: validatedExt.name,
      description: validatedExt.description ?? (contribManifest.description as string) ?? '',
      whenToUse: (contribManifest.whenToUse as string) ?? undefined,
      invocation: {
        modelInvocable: (contribManifest.invocation as any)?.modelInvocable ?? true,
        userInvocable: (contribManifest.invocation as any)?.userInvocable ?? true,
      },
      content: skillContent,
      metadata: contribManifest,
      contentHash,
      fileCount: allFiles.length,
      totalBytes,
      isMcp,
      isCli,
      contributions: validatedExt.contributions,
    };
  }

  // 2. Legacy / Pure Skill format: Look for SKILL.md or <name>.md
  let skillMdFile: { relPath: string; fullPath: string } | undefined;
  const directSkillMd = allFiles.find((f) => f.relPath === 'SKILL.md' || f.relPath === 'skill.md');
  if (directSkillMd) {
    skillMdFile = directSkillMd;
  } else {
    // Check if there's a single flat markdown file or file in root
    const rootMds = allFiles.filter((f) => !f.relPath.includes('/') && f.relPath.endsWith('.md'));
    if (rootMds.length === 1) {
      skillMdFile = rootMds[0];
    }
  }

  if (!skillMdFile) {
    throw new ValidationError('Extension package is missing mandatory "extension.json" or "SKILL.md" file at root');
  }

  const rawSkillMd = fs.readFileSync(skillMdFile.fullPath, 'utf8');
  const parsed = parseSkillMarkdown(rawSkillMd);

  // Compute deterministic SHA-256 across all files sorted by relative path
  allFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const hasher = crypto.createHash('sha256');
  for (const file of allFiles) {
    hasher.update(`FILE:${file.relPath}\n`);
    const content = fs.readFileSync(file.fullPath);
    hasher.update(content);
  }
  const contentHash = hasher.digest('hex');

  const synthesizedContribution: CanonicalExtensionContribution = {
    kind: 'skill',
    key: parsed.name,
    manifest: {
      name: parsed.name,
      description: parsed.description,
      whenToUse: parsed.whenToUse,
      entrypoint: 'SKILL.md',
      invocation: {
        modelInvocable: !parsed.disableModelInvocation,
        userInvocable: parsed.userInvocable ?? true,
      },
    },
  };

  return {
    slug: parsed.name,
    name: parsed.name,
    description: parsed.description,
    whenToUse: parsed.whenToUse,
    invocation: {
      modelInvocable: !parsed.disableModelInvocation,
      userInvocable: parsed.userInvocable ?? true,
    },
    content: parsed.content,
    metadata: parsed.metadata,
    contentHash,
    fileCount: allFiles.length,
    totalBytes,
    isMcp: false,
    contributions: [synthesizedContribution],
  };
}
