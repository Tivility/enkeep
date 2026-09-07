import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import {
  PlatformError,
  NotFoundError,
  ValidationError,
  ForbiddenError,
  type User,
  type ExtensionKind,
  type ExtensionSourceKind,
  type ExtensionPackageStatus,
} from '@enkeep/platform-core';
import { createSuccessEnvelope } from '@enkeep/protocol';
import {
  API_CACHE_CONTROL_HEADERS,
  validateCsrf,
} from '../safety/limits.js';
import { validateSkillName, MAX_SKILL_TOTAL_BYTES } from '../skills/security-validator.js';
import type { ExtensionCatalogService } from './extension-catalog-service.js';
import { isRecord, readJsonBody, sendJsonResponse } from '../imports/happyclaw-migration-routes.js';

export const IDEMPOTENCY_KEY_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const SENSITIVE_FORBIDDEN_BODY_KEYS = Object.freeze([
  'authtoken',
  'sshprivatekey',
  'privatekey',
  'password',
  'token',
  'secret',
  'appsecret',
  'app_secret',
  'apikey',
  'api_key',
  'knownhosts',
  'knownhostsfile',
  'bearer',
]);

/**
 * Validates that an object contains only allowed keys and no sensitive/unknown properties.
 */
export function assertStrictBodyShape(
  obj: Record<string, unknown>,
  allowedKeys: readonly string[],
  contextName = 'Request body'
): void {
  const allowedSet = new Set(allowedKeys);
  for (const key of Object.keys(obj)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_FORBIDDEN_BODY_KEYS.includes(lower)) {
      throw new ValidationError(
        `Plaintext secret field "${key}" is strictly forbidden in API request payload. Pass credentials via secure credential reference (credentialRef).`
      );
    }
    if (!allowedSet.has(key)) {
      throw new ValidationError(`Unknown field "${key}" is prohibited in ${contextName}`);
    }
  }
}

/**
 * Validates that a string is strictly trimmed and in Unicode NFC normalized form.
 */
export function validateExactString(
  val: unknown,
  fieldName: string,
  required = false
): string | undefined {
  if (val === undefined || val === null) {
    if (required) {
      throw new ValidationError(`Field "${fieldName}" is required`);
    }
    return undefined;
  }
  if (typeof val !== 'string') {
    throw new ValidationError(`Field "${fieldName}" must be a string`);
  }
  if (val.trim() !== val) {
    throw new ValidationError(`Field "${fieldName}" must not contain leading or trailing whitespace`);
  }
  if (val.normalize('NFC') !== val) {
    throw new ValidationError(`Field "${fieldName}" must be in Unicode NFC normalized form`);
  }
  if (required && val.length === 0) {
    throw new ValidationError(`Field "${fieldName}" must not be empty`);
  }
  return val;
}

export function validateIdempotencyKey(rawHeader: unknown): string | undefined {
  if (rawHeader === undefined || rawHeader === null) return undefined;
  if (Array.isArray(rawHeader)) {
    throw new ValidationError('Duplicate Idempotency-Key header is prohibited');
  }
  if (typeof rawHeader !== 'string' || rawHeader.trim() === '') {
    throw new ValidationError('Idempotency-Key header must be a non-empty string');
  }
  const key = rawHeader.trim();
  if (!IDEMPOTENCY_KEY_REGEX.test(key)) {
    throw new ValidationError('Idempotency-Key must be a valid canonical UUID v4');
  }
  return key.toLowerCase();
}

export const STRICT_BASE64_REGEX = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Validates that a string is strictly formatted and canonically encoded Base64.
 * Rejects non-base64 characters, unaligned padding, illegal padding, non-zero padding bits, and empty buffers.
 * Enforces maximum decoded size limit (MAX_SKILL_TOTAL_BYTES = 20MB).
 */
export function validateCanonicalBase64(val: unknown, fieldName = 'archiveBase64'): Buffer {
  if (val === undefined || val === null) {
    throw new ValidationError(`Field "${fieldName}" is required`);
  }
  if (typeof val !== 'string') {
    throw new ValidationError(`Field "${fieldName}" must be a string`);
  }
  if (val.trim() !== val) {
    throw new ValidationError(`Field "${fieldName}" must not contain leading or trailing whitespace`);
  }
  if (val.length === 0) {
    throw new ValidationError(`Field "${fieldName}" must not be empty`);
  }
  if (val.length % 4 !== 0) {
    throw new ValidationError(`Field "${fieldName}" length must be a multiple of 4`);
  }
  if (!STRICT_BASE64_REGEX.test(val)) {
    throw new ValidationError(`Field "${fieldName}" is not a valid strict base64 encoded string`);
  }

  const buf = Buffer.from(val, 'base64');
  if (buf.length === 0) {
    throw new ValidationError(`Field "${fieldName}" must decode to non-empty bytes`);
  }

  if (buf.length > MAX_SKILL_TOTAL_BYTES) {
    throw new ValidationError(
      `Decoded ${fieldName} size (${buf.length} bytes) exceeds maximum allowed limit of ${MAX_SKILL_TOTAL_BYTES} bytes`
    );
  }

  // Canonical base64 check: re-encoded string must match input exactly (rejects non-zero padding bits / non-canonical encodings)
  if (buf.toString('base64') !== val) {
    throw new ValidationError(`Field "${fieldName}" must be canonically encoded base64 without non-zero padding bits`);
  }

  return buf;
}

/**
 * Validates an archive filename for safety, length, characters, and extension.
 */
export function validateArchiveFilename(raw: unknown, fieldName = 'archiveFilename'): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw new ValidationError(`Field "${fieldName}" must be a string`);
  }
  if (raw.trim() !== raw) {
    throw new ValidationError(`Field "${fieldName}" must not contain leading or trailing whitespace`);
  }
  if (raw.normalize('NFC') !== raw) {
    throw new ValidationError(`Field "${fieldName}" must be in Unicode NFC normalized form`);
  }
  if (raw.length === 0 || raw.length > 255) {
    throw new ValidationError(`Field "${fieldName}" length must be between 1 and 255 characters`);
  }
  if (raw === '.' || raw === '..') {
    throw new ValidationError(`Field "${fieldName}" cannot be "." or ".."`);
  }
  if (raw.includes('/') || raw.includes('\\')) {
    throw new ValidationError(`Field "${fieldName}" cannot contain path separators`);
  }
  if (raw.includes('\0')) {
    throw new ValidationError(`Field "${fieldName}" cannot contain null bytes`);
  }
  if (raw.includes('..')) {
    throw new ValidationError(`Field "${fieldName}" cannot contain path traversal sequences`);
  }
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code <= 31 || code === 127) {
      throw new ValidationError(`Field "${fieldName}" cannot contain control characters`);
    }
  }
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(raw)) {
    throw new ValidationError(`Field "${fieldName}" contains reserved system device name`);
  }
  if (!/\.(?:tar\.gz|tgz|tar|zip)$/i.test(raw)) {
    throw new ValidationError(`Field "${fieldName}" must have a valid archive extension (.tar.gz, .tgz, .tar, .zip)`);
  }
  return raw;
}

/**
 * Validates a SHA-256 checksum string (must be exact 64-char lowercase hex).
 */
export function validateChecksum(val: unknown, fieldName = 'expectedChecksum'): string | undefined {
  if (val === undefined || val === null) return undefined;
  const str = validateExactString(val, fieldName, false);
  if (!str) return undefined;
  if (!/^[0-9a-fA-F]{64}$/.test(str)) {
    throw new ValidationError(`Field "${fieldName}" must be a valid 64-character hex SHA-256 string`);
  }
  return str.toLowerCase();
}

export class ExtensionsRoutes {
  private readonly extensionService: ExtensionCatalogService;
  private readonly expectedCsrfToken: string;

  constructor(extensionService: ExtensionCatalogService, expectedCsrfToken = '') {
    this.extensionService = extensionService;
    this.expectedCsrfToken = expectedCsrfToken;
  }

  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    currentUser: User
  ): Promise<boolean> {
    if (!pathname.startsWith('/api/manage/extensions')) {
      return false;
    }

    const method = req.method?.toUpperCase();

    // 1. GET /api/manage/extensions/contributions
    if (pathname === '/api/manage/extensions/contributions' && method === 'GET') {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const spaceId = url.searchParams.get('spaceId') || undefined;
      const kind = (url.searchParams.get('kind') as ExtensionKind) || undefined;
      const search = url.searchParams.get('search') || undefined;

      const contribs = await this.extensionService.listContributions(currentUser, {
        spaceId,
        kind,
        search,
      });

      sendJsonResponse(res, 200, createSuccessEnvelope(contribs));
      return true;
    }

    // 2. GET /api/manage/extensions/bindings
    if (pathname === '/api/manage/extensions/bindings' && method === 'GET') {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const spaceId = url.searchParams.get('spaceId') || undefined;

      const bindings = await this.extensionService.listBindings(currentUser, {
        spaceId,
      });

      sendJsonResponse(res, 200, createSuccessEnvelope(bindings));
      return true;
    }

    // 3. GET /api/manage/extensions
    if (pathname === '/api/manage/extensions' && method === 'GET') {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const spaceId = url.searchParams.get('spaceId') || undefined;
      const kind = (url.searchParams.get('kind') as ExtensionKind) || undefined;
      const status = (url.searchParams.get('status') as ExtensionPackageStatus) || undefined;
      const search = url.searchParams.get('search') || undefined;
      const enabledParam = url.searchParams.get('enabled');
      const enabled = enabledParam !== null ? enabledParam === 'true' : undefined;

      const packages = await this.extensionService.listPackages(currentUser, {
        spaceId,
        kind,
        status,
        search,
      });

      sendJsonResponse(res, 200, createSuccessEnvelope(packages));
      return true;
    }

    // 4. POST /api/manage/extensions/install
    if (pathname === '/api/manage/extensions/install' && method === 'POST') {
      validateCsrf(req, { csrfToken: this.expectedCsrfToken });
      const idempotencyKey = validateIdempotencyKey(req.headers['idempotency-key']);
      const body = await readJsonBody(req);

      if (!isRecord(body)) {
        throw new ValidationError('Request body must be a JSON object');
      }

      const sourceKind = body.sourceKind;
      if (typeof sourceKind !== 'string') {
        throw new ValidationError('Field "sourceKind" is required and must be "git" or "archive"');
      }

      if (sourceKind === 'git') {
        assertStrictBodyShape(body, ['sourceKind', 'spaceId', 'gitSource'], 'Git install request body');

        const gitSource = body.gitSource;
        if (!isRecord(gitSource)) {
          throw new ValidationError('Field "gitSource" is required and must be an object when sourceKind is "git"');
        }

        assertStrictBodyShape(gitSource, [
          'repositoryUrl',
          'ref',
          'subdirectory',
          'credentialRef',
          'expectedCommit',
          'expectedChecksum',
        ], 'gitSource');

        const repositoryUrl = validateExactString(gitSource.repositoryUrl, 'gitSource.repositoryUrl', true)!;
        const ref = validateExactString(gitSource.ref, 'gitSource.ref');
        const subdirectory = validateExactString(gitSource.subdirectory, 'gitSource.subdirectory');
        const credentialRef = validateExactString(gitSource.credentialRef, 'gitSource.credentialRef');
        const expectedCommit = validateExactString(gitSource.expectedCommit, 'gitSource.expectedCommit');
        const expectedChecksum = validateChecksum(gitSource.expectedChecksum, 'gitSource.expectedChecksum');
        const targetSpaceId = validateExactString(body.spaceId, 'spaceId');

        const installed = await this.extensionService.installGit({
          userId: currentUser.id,
          repositoryUrl,
          ref,
          subdirectory,
          credentialRef,
          expectedCommit,
          expectedChecksum,
          targetSpaceId,
          idempotencyKey,
        });

        sendJsonResponse(res, 201, createSuccessEnvelope(installed));
        return true;
      } else if (sourceKind === 'archive') {
        assertStrictBodyShape(
          body,
          ['sourceKind', 'spaceId', 'archiveBase64', 'archiveFilename', 'expectedChecksum'],
          'Archive install request body'
        );

        const archiveBuffer = validateCanonicalBase64(body.archiveBase64, 'archiveBase64');
        const archiveFilename = validateArchiveFilename(body.archiveFilename, 'archiveFilename');
        const targetSpaceId = validateExactString(body.spaceId, 'spaceId');
        const expectedChecksum = validateChecksum(body.expectedChecksum, 'expectedChecksum');

        if (expectedChecksum) {
          const bufferChecksum = createHash('sha256').update(archiveBuffer).digest('hex');
          if (expectedChecksum !== bufferChecksum) {
            throw new ValidationError(
              `Archive checksum mismatch: expected "${expectedChecksum}", got "${bufferChecksum}"`
            );
          }
        }

        const installed = await this.extensionService.installArchive({
          userId: currentUser.id,
          archiveBuffer,
          archiveFilename,
          targetSpaceId,
          expectedChecksum,
          idempotencyKey,
        });

        sendJsonResponse(res, 201, createSuccessEnvelope(installed));
        return true;
      }

      throw new ValidationError(`Unsupported sourceKind: "${String(sourceKind)}". sourceKind must be "git" or "archive".`);
    }

    // Match /api/manage/extensions/:slug and sub-routes
    const prefix = '/api/manage/extensions/';
    if (pathname.startsWith(prefix)) {
      const rest = pathname.slice(prefix.length);
      const parts = rest.split('/');
      const slug = parts[0];
      validateSkillName(slug);

      // 5. GET /api/manage/extensions/:slug
      if (parts.length === 1 && method === 'GET') {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const spaceIdParam = url.searchParams.get('spaceId');

        const detail = await this.extensionService.getPackage(currentUser, slug, spaceIdParam || undefined);
        sendJsonResponse(res, 200, createSuccessEnvelope(detail));
        return true;
      }

      // 6. POST /api/manage/extensions/:slug/update
      if (parts.length === 2 && parts[1] === 'update' && method === 'POST') {
        validateCsrf(req, { csrfToken: this.expectedCsrfToken });
        const idempotencyKey = validateIdempotencyKey(req.headers['idempotency-key']);
        const body = await readJsonBody(req);

        if (!isRecord(body)) {
          throw new ValidationError('Request body must be a JSON object');
        }

        assertStrictBodyShape(body, [
          'ref',
          'expectedCommit',
          'confirmDiff',
          'spaceId',
          'credentialRef',
        ]);

        const ref = validateExactString(body.ref, 'ref');
        const expectedCommit = validateExactString(body.expectedCommit, 'expectedCommit');
        const confirmDiff = body.confirmDiff === true;
        const targetSpaceId = validateExactString(body.spaceId, 'spaceId');
        const credentialRef = validateExactString(body.credentialRef, 'credentialRef');

        const result = await this.extensionService.update({
          userId: currentUser.id,
          slug,
          ref,
          expectedCommit,
          confirmDiff,
          targetSpaceId,
          credentialRef,
          idempotencyKey,
        });

        sendJsonResponse(res, 200, createSuccessEnvelope(result));
        return true;
      }

      // 7. POST /api/manage/extensions/:slug/rollback
      if (parts.length === 2 && parts[1] === 'rollback' && method === 'POST') {
        validateCsrf(req, { csrfToken: this.expectedCsrfToken });
        const idempotencyKey = validateIdempotencyKey(req.headers['idempotency-key']);
        const body = await readJsonBody(req);

        if (!isRecord(body)) {
          throw new ValidationError('Request body must be a JSON object');
        }

        assertStrictBodyShape(body, ['targetVersion', 'spaceId']);

        const targetVersion = typeof body.targetVersion === 'number'
          ? body.targetVersion
          : typeof body.targetVersion === 'string' && /^\d+$/.test(body.targetVersion)
          ? parseInt(body.targetVersion, 10)
          : NaN;

        if (isNaN(targetVersion) || targetVersion < 1) {
          throw new ValidationError('targetVersion must be a positive integer');
        }

        const targetSpaceId = validateExactString(body.spaceId, 'spaceId');

        const result = await this.extensionService.rollback({
          userId: currentUser.id,
          slug,
          targetVersion,
          targetSpaceId,
          idempotencyKey,
        });

        sendJsonResponse(res, 200, createSuccessEnvelope(result));
        return true;
      }

      // 8. POST /api/manage/extensions/:slug/enable
      if (parts.length === 2 && parts[1] === 'enable' && method === 'POST') {
        validateCsrf(req, { csrfToken: this.expectedCsrfToken });
        const body = await readJsonBody(req);
        if (!isRecord(body)) {
          throw new ValidationError('Request body must be a JSON object');
        }
        assertStrictBodyShape(body, ['spaceId']);
        const spaceId = validateExactString(body.spaceId, 'spaceId', true)!;

        const binding = await this.extensionService.enable(currentUser, spaceId, slug);

        sendJsonResponse(res, 200, createSuccessEnvelope(binding));
        return true;
      }

      // 9. POST /api/manage/extensions/:slug/disable
      if (parts.length === 2 && parts[1] === 'disable' && method === 'POST') {
        validateCsrf(req, { csrfToken: this.expectedCsrfToken });
        const body = await readJsonBody(req);
        if (!isRecord(body)) {
          throw new ValidationError('Request body must be a JSON object');
        }
        assertStrictBodyShape(body, ['spaceId']);
        const spaceId = validateExactString(body.spaceId, 'spaceId', true)!;

        const binding = await this.extensionService.disable(currentUser, spaceId, slug);

        sendJsonResponse(res, 200, createSuccessEnvelope(binding));
        return true;
      }

      // 10. POST /api/manage/extensions/:slug/uninstall or DELETE /api/manage/extensions/:slug
      if (
        (parts.length === 2 && parts[1] === 'uninstall' && method === 'POST') ||
        (parts.length === 1 && method === 'DELETE')
      ) {
        validateCsrf(req, { csrfToken: this.expectedCsrfToken });
        let spaceId: string | undefined;

        if (method === 'POST') {
          const body = await readJsonBody(req);
          if (isRecord(body)) {
            assertStrictBodyShape(body, ['spaceId']);
            spaceId = validateExactString(body.spaceId, 'spaceId');
          }
        } else {
          const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
          spaceId = url.searchParams.get('spaceId') || undefined;
        }

        const success = await this.extensionService.uninstall(currentUser, slug, spaceId);
        sendJsonResponse(res, 200, createSuccessEnvelope({ success, slug }));
        return true;
      }
    }

    return false;
  }
}

export { ExtensionsRoutes as ExtensionRoutes };
