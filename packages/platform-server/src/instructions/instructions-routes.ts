/**
 * Authoritative Canonical Platform Instructions HTTP Routes
 *
 * REST Endpoints:
 * - GET /api/account/instructions/global
 * - PUT /api/account/instructions/global
 * - GET /api/spaces/:spaceId/instructions
 * - PUT /api/spaces/:spaceId/instructions
 *
 * Concurrency & Security:
 * - ALLOWED PUT keys: strictly ['content']
 * - Space query parameter: strictly 'file' (AGENTS.md | CLAUDE.md)
 * - If-Match concurrency control via HTTP header only
 * - 428 PRECONDITION_REQUIRED when modifying existing instructions without If-Match
 * - 409 CONFLICT on ETag mismatch
 * - Standard SuccessEnvelope / ErrorEnvelope from @enkeep/protocol
 * - Zero raw internal error message leakage (whitelisted public messages)
 *
 * @module @enkeep/platform-server/instructions/instructions-routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PlatformError,
  NotFoundError,
  ValidationError,
  ForbiddenError,
  ConflictError,
  type User,
} from '@enkeep/platform-core';
import {
  createSuccessEnvelope,
  createErrorEnvelope,
  type ErrorEnvelope,
} from '@enkeep/protocol';
import { validateCsrf } from '../safety/limits.js';
import type { InstructionsService } from './instructions-service.js';
import { isRecord, readJsonBody, sendJsonResponse } from '../imports/happyclaw-migration-routes.js';
import { assertStrictBodyShape } from '../extensions/extension-routes.js';

export const ALLOWED_PUT_GLOBAL_INSTRUCTIONS_KEYS = Object.freeze(['content'] as const);
export const ALLOWED_PUT_SPACE_INSTRUCTIONS_KEYS = Object.freeze(['content'] as const);

export interface InstructionsRoutesOptions {
  expectedCsrfToken?: string;
}

const PUBLIC_ERROR_MESSAGES: Readonly<Record<string, { status: number; code: string; message: string }>> = Object.freeze({
  VALIDATION_ERROR: { status: 400, code: 'VALIDATION_ERROR', message: 'Invalid request' },
  BAD_REQUEST: { status: 400, code: 'VALIDATION_ERROR', message: 'Invalid request' },
  SPACE_INACTIVE: { status: 400, code: 'VALIDATION_ERROR', message: 'Invalid request' },
  UNAUTHORIZED: { status: 401, code: 'UNAUTHORIZED', message: 'Authentication required' },
  FORBIDDEN: { status: 403, code: 'FORBIDDEN', message: 'Forbidden' },
  CSRF_INVALID: { status: 403, code: 'FORBIDDEN', message: 'Forbidden' },
  NOT_FOUND: { status: 404, code: 'NOT_FOUND', message: 'Resource not found' },
  METHOD_NOT_ALLOWED: { status: 405, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' },
  CONFLICT: { status: 409, code: 'CONFLICT', message: 'Instructions changed' },
  PRECONDITION_FAILED: { status: 409, code: 'CONFLICT', message: 'Instructions changed' },
  PRECONDITION_REQUIRED: { status: 428, code: 'PRECONDITION_REQUIRED', message: 'Precondition required' },
  RUNTIME_UNAVAILABLE: { status: 503, code: 'RUNTIME_UNAVAILABLE', message: 'Runtime unavailable' },
  INTERNAL_ERROR: { status: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' },
});

function toSafeErrorResponse(err: unknown): { status: number; envelope: ErrorEnvelope } {
  let status = 500;
  let code = 'INTERNAL_ERROR';

  if (err instanceof PlatformError) {
    status = err.status;
    code = err.code || 'INTERNAL_ERROR';
  } else if (err instanceof ValidationError) {
    status = 400;
    code = 'VALIDATION_ERROR';
  } else if (err instanceof NotFoundError) {
    status = 404;
    code = 'NOT_FOUND';
  } else if (err instanceof ForbiddenError) {
    status = 403;
    code = 'FORBIDDEN';
  } else if (err instanceof ConflictError) {
    status = 409;
    code = 'CONFLICT';
  } else if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    if (typeof obj['status'] === 'number' && obj['status'] >= 400 && obj['status'] <= 599) {
      status = obj['status'];
    }
    if (typeof obj['code'] === 'string') {
      code = obj['code'];
    }
  }

  // Normalize fallback code based on status if needed
  if (status === 401) {
    code = 'UNAUTHORIZED';
  } else if (status === 403) {
    code = 'FORBIDDEN';
  } else if (status === 404) {
    code = 'NOT_FOUND';
  } else if (status === 405) {
    code = 'METHOD_NOT_ALLOWED';
  } else if (status === 409) {
    code = 'CONFLICT';
  } else if (status === 428) {
    code = 'PRECONDITION_REQUIRED';
  } else if (status === 400 && !PUBLIC_ERROR_MESSAGES[code]) {
    code = 'VALIDATION_ERROR';
  }

  const mapping = PUBLIC_ERROR_MESSAGES[code];
  const finalStatus = mapping?.status ?? status;
  const finalCode = mapping?.code ?? (status >= 500 ? 'INTERNAL_ERROR' : code);
  const finalMessage = mapping?.message ?? (status >= 500 ? 'Internal server error' : 'Invalid request');

  return {
    status: finalStatus,
    envelope: createErrorEnvelope({
      code: finalCode,
      message: finalMessage,
      status: finalStatus,
    }),
  };
}

function extractIfMatchHeader(req: IncomingMessage): string | undefined {
  const header = req.headers['if-match'];
  if (Array.isArray(header)) {
    const first = header[0]?.trim();
    return first && first.length > 0 ? first : undefined;
  }
  if (typeof header === 'string') {
    const trimmed = header.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

export class InstructionsRoutes {
  private readonly instructionsService: InstructionsService;
  private readonly expectedCsrfToken?: string;

  constructor(instructionsService: InstructionsService, options?: InstructionsRoutesOptions) {
    if (!instructionsService) {
      throw new ValidationError('InstructionsRoutes requires instructionsService');
    }
    this.instructionsService = instructionsService;
    this.expectedCsrfToken = options?.expectedCsrfToken;
  }

  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    user: User | null,
    url?: URL
  ): Promise<boolean> {
    const rawHost = req.headers.host;
    const safeHost = typeof rawHost === 'string' && rawHost.trim().length > 0 ? rawHost.trim() : 'localhost';
    const requestUrl = url || new URL(req.url || '/', `http://${safeHost}`);
    return this.handleRequest(req, res, pathname, requestUrl, user);
  }

  async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    url: URL,
    user: User | null
  ): Promise<boolean> {
    const isAccountGlobal = pathname === '/api/account/instructions/global';
    const spaceMatch = pathname.match(/^\/api\/spaces\/([^/]+)\/instructions$/);

    if (!isAccountGlobal && !spaceMatch) {
      return false;
    }

    if (!user) {
      const { status, envelope } = toSafeErrorResponse(
        new PlatformError('Authentication required', 'UNAUTHORIZED', 401)
      );
      sendJsonResponse(res, status, envelope);
      return true;
    }

    const method = req.method?.toUpperCase();

    try {
      // 1. Account Global Instructions: /api/account/instructions/global
      if (isAccountGlobal) {
        for (const [key] of url.searchParams.entries()) {
          throw new ValidationError(`Query parameter "${key}" is not supported on global instructions`);
        }

        if (method === 'GET') {
          const payload = await this.instructionsService.getGlobalInstructions(user);
          const headers: Record<string, string> = {
            'Cache-Control': 'private, no-cache',
          };
          if (payload.etag) {
            headers['ETag'] = payload.etag;
          }
          sendJsonResponse(res, 200, createSuccessEnvelope(payload), headers);
          return true;
        }

        if (method === 'PUT') {
          validateCsrf(req, { csrfToken: this.expectedCsrfToken ?? '' });
          const rawBody = await readJsonBody(req);
          if (!isRecord(rawBody)) {
            throw new ValidationError('Invalid JSON body');
          }
          assertStrictBodyShape(rawBody, ALLOWED_PUT_GLOBAL_INSTRUCTIONS_KEYS, 'Global instructions request body');

          if (typeof rawBody['content'] !== 'string') {
            throw new ValidationError('Field "content" must be a string');
          }

          const ifMatch = extractIfMatchHeader(req);

          // If resource already exists and has ETag, If-Match header is mandatory
          const existing = await this.instructionsService.getGlobalInstructions(user);
          if (existing.exists && existing.etag && !ifMatch) {
            throw new PlatformError(
              'Header "If-Match" is required when modifying existing instructions',
              'PRECONDITION_REQUIRED',
              428
            );
          }

          const payload = await this.instructionsService.putGlobalInstructions(
            user,
            rawBody['content'],
            { ifMatch }
          );

          const headers: Record<string, string> = {
            'Cache-Control': 'private, no-cache',
            'ETag': payload.etag,
          };
          sendJsonResponse(res, 200, createSuccessEnvelope(payload), headers);
          return true;
        }

        const { status, envelope } = toSafeErrorResponse(
          new PlatformError(`Method ${method} not allowed on ${pathname}`, 'METHOD_NOT_ALLOWED', 405)
        );
        sendJsonResponse(res, status, envelope);
        return true;
      }

      // 2. Space Instructions: /api/spaces/:spaceId/instructions
      if (spaceMatch) {
        const rawSpaceId = spaceMatch[1];
        if (!rawSpaceId) {
          throw new ValidationError('Space ID is required');
        }
        const spaceId = decodeURIComponent(rawSpaceId);

        let queryFilename: 'AGENTS.md' | 'CLAUDE.md' | undefined = undefined;
        for (const [key, value] of url.searchParams.entries()) {
          if (key !== 'file') {
            throw new ValidationError(`Invalid query parameter "${key}". Only "file" is allowed`);
          }
          if (value !== 'AGENTS.md' && value !== 'CLAUDE.md') {
            throw new ValidationError(`Invalid file parameter "${value}". Allowed: AGENTS.md, CLAUDE.md`);
          }
          queryFilename = value;
        }

        if (method === 'GET') {
          const payload = await this.instructionsService.getSpaceInstructions(user, spaceId, queryFilename);
          const headers: Record<string, string> = {
            'Cache-Control': 'private, no-cache',
          };
          if (payload.etag) {
            headers['ETag'] = payload.etag;
          }
          sendJsonResponse(res, 200, createSuccessEnvelope(payload), headers);
          return true;
        }

        if (method === 'PUT') {
          validateCsrf(req, { csrfToken: this.expectedCsrfToken ?? '' });
          const rawBody = await readJsonBody(req);
          if (!isRecord(rawBody)) {
            throw new ValidationError('Invalid JSON body');
          }
          assertStrictBodyShape(rawBody, ALLOWED_PUT_SPACE_INSTRUCTIONS_KEYS, 'Space instructions request body');

          if (typeof rawBody['content'] !== 'string') {
            throw new ValidationError('Field "content" must be a string');
          }

          const ifMatch = extractIfMatchHeader(req);

          // If resource already exists and has ETag, If-Match header is mandatory
          const existing = await this.instructionsService.getSpaceInstructions(user, spaceId, queryFilename);
          if (existing.exists && existing.etag && !ifMatch) {
            throw new PlatformError(
              'Header "If-Match" is required when modifying existing instructions',
              'PRECONDITION_REQUIRED',
              428
            );
          }

          const payload = await this.instructionsService.putSpaceInstructions(
            user,
            spaceId,
            rawBody['content'],
            {
              filename: queryFilename,
              ifMatch,
            }
          );

          const headers: Record<string, string> = {
            'Cache-Control': 'private, no-cache',
            'ETag': payload.etag,
          };
          sendJsonResponse(res, 200, createSuccessEnvelope(payload), headers);
          return true;
        }

        const { status, envelope } = toSafeErrorResponse(
          new PlatformError(`Method ${method} not allowed on ${pathname}`, 'METHOD_NOT_ALLOWED', 405)
        );
        sendJsonResponse(res, status, envelope);
        return true;
      }

      return false;
    } catch (err: unknown) {
      const { status, envelope } = toSafeErrorResponse(err);
      sendJsonResponse(res, status, envelope);
      return true;
    }
  }
}
