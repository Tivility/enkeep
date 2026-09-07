import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { getWebUiAsset, getWebUiIndexHtml } from '@enkeep/web-ui';
import { createSuccessEnvelope, createErrorEnvelope, ProtocolErrorCode } from '@enkeep/protocol';
import { PlatformError } from '@enkeep/platform-core';
import type {
  PlatformWebApi,
  RuntimeGateway,
  InboundEnvelope,
  PublicMessage,
  PublicSession,
} from './types.js';
import {
  DEFAULT_SECURITY_HEADERS,
  API_CACHE_CONTROL_HEADERS,
  DEFAULT_MAX_BODY_BYTES,
  validateOrigin,
  validatePathId,
  validateMessageContent,
  validateAttachments,
} from './security.js';

export interface WebChannelHandlerOptions {
  platformApi: PlatformWebApi;
  runtimeGateway: RuntimeGateway;
  csrfToken: string;
  maxBodyBytes?: number;
}

const STATIC_MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function getAuthoritativeMimeType(pathname: string, assetFallback?: string): string {
  const dotIndex = pathname.lastIndexOf('.');
  if (dotIndex !== -1) {
    const ext = pathname.slice(dotIndex).toLowerCase();
    if (STATIC_MIME_MAP[ext]) {
      return STATIC_MIME_MAP[ext]!;
    }
  }
  return assetFallback || 'application/octet-stream';
}

export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

class PayloadTooLargeError extends PlatformError {
  constructor() {
    super('Request payload exceeds maximum allowed size', ProtocolErrorCode.PAYLOAD_TOO_LARGE, 413);
  }
}

class JsonSyntaxError extends PlatformError {
  constructor() {
    super('Malformed JSON body', ProtocolErrorCode.BAD_REQUEST, 400);
  }
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

/**
 * Parses JSON body from Node.js IncomingMessage with strict byte size limit enforcement.
 * Does not mutate framing via trim() and uses fixed error messages.
 */
async function parseJsonBody<T = unknown>(req: IncomingMessage, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<T> {
  return new Promise((resolve, reject) => {
    let byteCount = 0;
    const chunks: Buffer[] = [];

    const onData = (chunk: Buffer) => {
      byteCount += chunk.length;
      if (byteCount > maxBytes) {
        req.removeListener('data', onData);
        req.resume();
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('error', onError);
    };

    req.on('data', onData);
    req.once('error', onError);
    req.on('end', () => {
      cleanup();
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (raw.length === 0) {
        return resolve({} as T);
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        resolve(parsed as T);
      } catch {
        reject(new JsonSyntaxError());
      }
    });
  });
}

/**
 * Sends a JSON response with status code, security headers, and cache control headers.
 */
function sendJson(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) {
  const jsonStr = JSON.stringify(data);
  res.writeHead(status, {
    ...DEFAULT_SECURITY_HEADERS,
    ...API_CACHE_CONTROL_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(jsonStr, 'utf-8'),
    ...headers,
  });
  res.end(jsonStr);
}

const STRICT_LOWERCASE_UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Creates the HTTP Request Handler for the Enkeep Web Channel Adapter.
 * Canonical routing under /api/... only (no duplicate v1 aliases).
 */
export function createWebChannelHandler(options: WebChannelHandlerOptions): HttpHandler {
  const { platformApi, runtimeGateway, csrfToken, maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = options;

  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const secValidation = validateOrigin(req, { csrfToken });
      if (!secValidation.allowed) {
        sendJson(res, 403, createErrorEnvelope({
          code: ProtocolErrorCode.FORBIDDEN,
          message: secValidation.reason || 'Forbidden: Security policy violation',
          status: 403,
        }));
        return;
      }

      const method = req.method ? req.method.toUpperCase() : 'GET';
      const rawUrl = req.url || '/';
      // Build base fixed http://127.0.0.1 (never interpolate raw Host header into base authority)
      const parsedUrl = new URL(rawUrl, 'http://127.0.0.1');
      const pathname = parsedUrl.pathname;

      // 1. Static Assets & Web UI
      if (pathname === '/' || pathname === '/index.html') {
        const html = getWebUiIndexHtml();
        res.writeHead(200, {
          ...DEFAULT_SECURITY_HEADERS,
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html, 'utf-8'),
        });
        res.end(html);
        return;
      }

      if (pathname.startsWith('/assets/') || pathname.startsWith('/static/')) {
        const assetPath = pathname.startsWith('/assets/')
          ? pathname.slice('/assets/'.length)
          : pathname.slice('/static/'.length);
        const asset = getWebUiAsset(assetPath);
        if (!asset || !asset.exists) {
          sendJson(res, 404, createErrorEnvelope({
            code: ProtocolErrorCode.NOT_FOUND,
            message: 'Static asset not found',
            status: 404,
          }));
          return;
        }

        const contentType = getAuthoritativeMimeType(
          assetPath,
          asset.contentType || asset.mimeType
        );

        res.writeHead(200, {
          ...DEFAULT_SECURITY_HEADERS,
          ...API_CACHE_CONTROL_HEADERS,
          'Content-Type': contentType,
          'Content-Length': asset.content.length,
        });
        res.end(asset.content);
        return;
      }

      // 2. CSRF Token Bootstrap Endpoint (Exact GET /api/auth/csrf)
      if (pathname === '/api/auth/csrf' && method === 'GET') {
        sendJson(res, 200, createSuccessEnvelope({
          csrfToken,
        }));
        return;
      }

      // 3. Authentication: Login (POST /api/auth/login)
      if (pathname === '/api/auth/login' && method === 'POST') {
        const body = await parseJsonBody<unknown>(req, maxBodyBytes);
        if (!isRecord(body)) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: 'Request body must be a JSON object',
            status: 400,
          }));
          return;
        }

        const allowedLoginKeys = new Set(['username', 'password']);
        for (const key of Object.keys(body)) {
          if (!allowedLoginKeys.has(key)) {
            sendJson(res, 400, createErrorEnvelope({
              code: ProtocolErrorCode.BAD_REQUEST,
              message: 'Unexpected field in request body',
              status: 400,
            }));
            return;
          }
        }

        const rawUsername = body.username;
        const rawPassword = body.password;

        if (
          typeof rawUsername !== 'string' ||
          rawUsername.trim() !== rawUsername ||
          rawUsername.length === 0 ||
          rawUsername.length > 128 ||
          /\s/.test(rawUsername)
        ) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: 'Invalid username in login request',
            status: 400,
          }));
          return;
        }

        if (
          typeof rawPassword !== 'string' ||
          rawPassword.length === 0 ||
          rawPassword.length > 1024
        ) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: 'Invalid password in login request',
            status: 400,
          }));
          return;
        }

        const clientIp = typeof req.socket.remoteAddress === 'string' ? req.socket.remoteAddress : undefined;
        const rawUserAgent = req.headers['user-agent'];
        const userAgent = typeof rawUserAgent === 'string' ? rawUserAgent : undefined;

        const loginResult = await platformApi.login(rawUsername, rawPassword, {
          ipAddress: clientIp,
          userAgent,
        });

        sendJson(res, 200, createSuccessEnvelope({
          user: {
            id: loginResult.user.id,
            username: loginResult.user.username,
            role: loginResult.user.role,
          },
        }), {
          'Set-Cookie': loginResult.cookieHeader,
        });
        return;
      }

      // 4. Authentication: Logout (POST /api/auth/logout - requires valid auth)
      if (pathname === '/api/auth/logout' && method === 'POST') {
        const cookieHeader = req.headers.cookie;
        const auth = await platformApi.authenticateCookie(cookieHeader);
        if (!auth || !auth.session) {
          sendJson(res, 401, createErrorEnvelope({
            code: ProtocolErrorCode.UNAUTHORIZED,
            message: 'Authentication required: missing or invalid session cookie',
            status: 401,
          }));
          return;
        }
        await platformApi.logout(auth.session.id);
        sendJson(res, 200, createSuccessEnvelope({ loggedOut: true }), {
          'Set-Cookie': 'enkeep_session=; Path=/; HttpOnly; Max-Age=0; SameSite=Strict',
        });
        return;
      }

      // 5. Authentication: Current User (GET /api/auth/me)
      if (pathname === '/api/auth/me' && method === 'GET') {
        const cookieHeader = req.headers.cookie;
        const auth = await platformApi.authenticateCookie(cookieHeader);
        if (!auth) {
          sendJson(res, 401, createErrorEnvelope({
            code: ProtocolErrorCode.UNAUTHORIZED,
            message: 'Not authenticated',
            status: 401,
          }));
          return;
        }
        sendJson(res, 200, createSuccessEnvelope({
          user: {
            id: auth.user.id,
            username: auth.user.username,
            role: auth.user.role,
          },
        }));
        return;
      }

      // All remaining endpoints require authenticated user session
      const cookieHeader = req.headers.cookie;
      const auth = await platformApi.authenticateCookie(cookieHeader);
      if (!auth) {
        sendJson(res, 401, createErrorEnvelope({
          code: ProtocolErrorCode.UNAUTHORIZED,
          message: 'Authentication required: missing or invalid session cookie',
          status: 401,
        }));
        return;
      }

      const currentUserId = auth.user.id;

      // 6. Spaces API: GET /api/spaces or POST /api/spaces
      if (pathname === '/api/spaces') {
        if (method === 'GET') {
          const rawIncludeArchived = parsedUrl.searchParams.get('includeArchived');
          let includeArchived: boolean | undefined = undefined;
          if (rawIncludeArchived !== null) {
            if (rawIncludeArchived === 'true') {
              includeArchived = true;
            } else if (rawIncludeArchived === 'false') {
              includeArchived = false;
            } else {
              sendJson(res, 400, createErrorEnvelope({
                code: ProtocolErrorCode.BAD_REQUEST,
                message: 'includeArchived query parameter must be a boolean string ("true" or "false")',
                status: 400,
              }));
              return;
            }
          }

          const spaces = await platformApi.listSpaces(currentUserId, { includeArchived });
          sendJson(res, 200, createSuccessEnvelope(spaces));
          return;
        }

        if (method === 'POST') {
          const body = await parseJsonBody<unknown>(req, maxBodyBytes);
          if (!isRecord(body)) {
            sendJson(res, 400, createErrorEnvelope({
              code: ProtocolErrorCode.BAD_REQUEST,
              message: 'Request body must be a JSON object',
              status: 400,
            }));
            return;
          }

          const allowedKeys = new Set(['name']);
          for (const key of Object.keys(body)) {
            if (!allowedKeys.has(key)) {
              sendJson(res, 400, createErrorEnvelope({
                code: ProtocolErrorCode.BAD_REQUEST,
                message: 'Unexpected field in request body',
                status: 400,
              }));
              return;
            }
          }

          if (
            typeof body.name !== 'string' ||
            body.name.trim() !== body.name ||
            body.name.length === 0 ||
            body.name.length > 256
          ) {
            sendJson(res, 400, createErrorEnvelope({
              code: ProtocolErrorCode.BAD_REQUEST,
              message: 'Space name must be a non-empty string with maximum 256 characters',
              status: 400,
            }));
            return;
          }

          const space = await platformApi.createSpace(currentUserId, {
            name: body.name,
          });

          sendJson(res, 201, createSuccessEnvelope(space));
          return;
        }
      }

      // 6b. Single Space: GET /api/spaces/:spaceId or PATCH /api/spaces/:spaceId
      const singleSpaceMatch = pathname.match(/^\/api\/spaces\/([^\/]+)$/);
      if (singleSpaceMatch) {
        const rawSpaceId = singleSpaceMatch[1];
        const validated = validatePathId(rawSpaceId, 'spaceId');
        if (!validated.valid || !validated.value) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: validated.error || 'Invalid spaceId',
            status: 400,
          }));
          return;
        }
        const spaceId = validated.value;

        if (method === 'GET') {
          const space = await platformApi.getSpace(currentUserId, spaceId);
          if (!space) {
            sendJson(res, 404, createErrorEnvelope({
              code: ProtocolErrorCode.NOT_FOUND,
              message: 'Space not found or access denied',
              status: 404,
            }));
            return;
          }
          sendJson(res, 200, createSuccessEnvelope(space));
          return;
        }

        if (method === 'PATCH') {
          const body = await parseJsonBody<unknown>(req, maxBodyBytes);
          if (!isRecord(body)) {
            sendJson(res, 400, createErrorEnvelope({
              code: ProtocolErrorCode.BAD_REQUEST,
              message: 'Request body must be a JSON object',
              status: 400,
            }));
            return;
          }

          const allowedKeys = new Set(['name']);
          for (const key of Object.keys(body)) {
            if (!allowedKeys.has(key)) {
              sendJson(res, 400, createErrorEnvelope({
                code: ProtocolErrorCode.BAD_REQUEST,
                message: 'Unexpected field in request body',
                status: 400,
              }));
              return;
            }
          }

          if (
            typeof body.name !== 'string' ||
            body.name.trim() !== body.name ||
            body.name.length === 0 ||
            body.name.length > 256
          ) {
            sendJson(res, 400, createErrorEnvelope({
              code: ProtocolErrorCode.BAD_REQUEST,
              message: 'Space name must be a non-empty string with maximum 256 characters',
              status: 400,
            }));
            return;
          }

          const updated = await platformApi.updateSpace(currentUserId, spaceId, {
            name: body.name,
          });

          sendJson(res, 200, createSuccessEnvelope(updated));
          return;
        }
      }

      // 6c. Space Archival: POST /api/spaces/:spaceId/archive
      const spaceArchiveMatch = pathname.match(/^\/api\/spaces\/([^\/]+)\/archive$/);
      if (spaceArchiveMatch && method === 'POST') {
        const rawSpaceId = spaceArchiveMatch[1];
        const validated = validatePathId(rawSpaceId, 'spaceId');
        if (!validated.valid || !validated.value) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: validated.error || 'Invalid spaceId',
            status: 400,
          }));
          return;
        }
        const spaceId = validated.value;
        const body = await parseJsonBody<unknown>(req, maxBodyBytes);
        if (isRecord(body) && Object.keys(body).length > 0) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: 'Archive space endpoint expects an empty body',
            status: 400,
          }));
          return;
        }

        const archived = await platformApi.archiveSpace(currentUserId, spaceId);
        sendJson(res, 200, createSuccessEnvelope(archived));
        return;
      }

      // 6c-2. Space Restore: POST /api/spaces/:spaceId/restore
      const spaceRestoreMatch = pathname.match(/^\/api\/spaces\/([^\/]+)\/restore$/);
      if (spaceRestoreMatch && method === 'POST') {
        const rawSpaceId = spaceRestoreMatch[1];
        const validated = validatePathId(rawSpaceId, 'spaceId');
        if (!validated.valid || !validated.value) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: validated.error || 'Invalid spaceId',
            status: 400,
          }));
          return;
        }
        const spaceId = validated.value;
        const body = await parseJsonBody<unknown>(req, maxBodyBytes);
        if (isRecord(body) && Object.keys(body).length > 0) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: 'Restore space endpoint expects an empty body',
            status: 400,
          }));
          return;
        }

        const restored = await platformApi.restoreSpace(currentUserId, spaceId);
        sendJson(res, 200, createSuccessEnvelope(restored));
        return;
      }

      // 6d. Nested Space Sessions: GET /api/spaces/:spaceId/sessions
      const spaceSessionsMatch = pathname.match(/^\/api\/spaces\/([^\/]+)\/sessions$/);
      if (spaceSessionsMatch && method === 'GET') {
        const rawSpaceId = spaceSessionsMatch[1];
        const validated = validatePathId(rawSpaceId, 'spaceId');
        if (!validated.valid || !validated.value) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: validated.error || 'Invalid spaceId',
            status: 400,
          }));
          return;
        }
        const spaceId = validated.value;
        const space = await platformApi.getSpace(currentUserId, spaceId);
        if (!space) {
          sendJson(res, 404, createErrorEnvelope({
            code: ProtocolErrorCode.NOT_FOUND,
            message: 'Space not found or access denied',
            status: 404,
          }));
          return;
        }

        const rawIncludeArchived = parsedUrl.searchParams.get('includeArchived');
        let includeArchived: boolean | undefined = undefined;
        if (rawIncludeArchived !== null) {
          if (rawIncludeArchived === 'true') {
            includeArchived = true;
          } else if (rawIncludeArchived === 'false') {
            includeArchived = false;
          } else {
            sendJson(res, 400, createErrorEnvelope({
              code: ProtocolErrorCode.BAD_REQUEST,
              message: 'includeArchived query parameter must be a boolean string ("true" or "false")',
              status: 400,
            }));
            return;
          }
        }

        const sessions = await platformApi.listSessions(currentUserId, { spaceId, includeArchived });
        sendJson(res, 200, createSuccessEnvelope(sessions));
        return;
      }

      // 7. General Sessions List & Create: GET /api/sessions or POST /api/sessions
      if (pathname === '/api/sessions') {
        if (method === 'GET') {
          const rawSpaceId = parsedUrl.searchParams.get('spaceId');
          let spaceId: string | undefined = undefined;
          if (rawSpaceId) {
            const validated = validatePathId(rawSpaceId, 'spaceId');
            if (!validated.valid || !validated.value) {
              sendJson(res, 400, createErrorEnvelope({
                code: ProtocolErrorCode.BAD_REQUEST,
                message: validated.error || 'Invalid spaceId query parameter',
                status: 400,
              }));
              return;
            }
            spaceId = validated.value;
          }

          const rawIncludeArchived = parsedUrl.searchParams.get('includeArchived');
          let includeArchived: boolean | undefined = undefined;
          if (rawIncludeArchived !== null) {
            if (rawIncludeArchived === 'true') {
              includeArchived = true;
            } else if (rawIncludeArchived === 'false') {
              includeArchived = false;
            } else {
              sendJson(res, 400, createErrorEnvelope({
                code: ProtocolErrorCode.BAD_REQUEST,
                message: 'includeArchived query parameter must be a boolean string ("true" or "false")',
                status: 400,
              }));
              return;
            }
          }

          const sessions = await platformApi.listSessions(currentUserId, { spaceId, includeArchived });
          sendJson(res, 200, createSuccessEnvelope(sessions));
          return;
        }

        if (method === 'POST') {
          const body = await parseJsonBody<unknown>(req, maxBodyBytes);
          if (!isRecord(body)) {
            sendJson(res, 400, createErrorEnvelope({
              code: ProtocolErrorCode.BAD_REQUEST,
              message: 'Request body must be a JSON object',
              status: 400,
            }));
            return;
          }

          const allowedSessionKeys = new Set(['spaceId', 'title']);
          for (const key of Object.keys(body)) {
            if (!allowedSessionKeys.has(key)) {
              sendJson(res, 400, createErrorEnvelope({
                code: ProtocolErrorCode.BAD_REQUEST,
                message: 'Unexpected field in request body',
                status: 400,
              }));
              return;
            }
          }

          if (
            typeof body.spaceId !== 'string' ||
            body.spaceId.trim() !== body.spaceId ||
            body.spaceId.length === 0
          ) {
            sendJson(res, 400, createErrorEnvelope({
              code: ProtocolErrorCode.BAD_REQUEST,
              message: 'Missing or invalid spaceId',
              status: 400,
            }));
            return;
          }

          let title: string | null = null;
          if (body.title !== undefined && body.title !== null) {
            if (typeof body.title !== 'string') {
              sendJson(res, 400, createErrorEnvelope({
                code: ProtocolErrorCode.BAD_REQUEST,
                message: 'Session title must be a string',
                status: 400,
              }));
              return;
            }
            if (body.title.length > 256) {
              sendJson(res, 400, createErrorEnvelope({
                code: ProtocolErrorCode.BAD_REQUEST,
                message: 'Session title must not exceed 256 characters',
                status: 400,
              }));
              return;
            }
            title = body.title;
          }

          const session = await platformApi.createSession(currentUserId, {
            spaceId: body.spaceId,
            title,
          });

          sendJson(res, 201, createSuccessEnvelope(session));
          return;
        }
      }

      // 7b. Single Session: GET /api/sessions/:sessionId or PATCH /api/sessions/:sessionId
      const singleSessionMatch = pathname.match(/^\/api\/sessions\/([^\/]+)$/);
      if (singleSessionMatch) {
        const rawSessionId = singleSessionMatch[1];
        const validated = validatePathId(rawSessionId, 'sessionId');
        if (!validated.valid || !validated.value) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: validated.error || 'Invalid sessionId',
            status: 400,
          }));
          return;
        }
        const sessionId = validated.value;

        if (method === 'GET') {
          const session = await platformApi.getSession(currentUserId, sessionId);
          if (!session) {
            sendJson(res, 404, createErrorEnvelope({
              code: ProtocolErrorCode.NOT_FOUND,
              message: 'Session not found or access denied',
              status: 404,
            }));
            return;
          }
          sendJson(res, 200, createSuccessEnvelope(session));
          return;
        }

        if (method === 'PATCH') {
          const body = await parseJsonBody<unknown>(req, maxBodyBytes);
          if (!isRecord(body)) {
            sendJson(res, 400, createErrorEnvelope({
              code: ProtocolErrorCode.BAD_REQUEST,
              message: 'Request body must be a JSON object',
              status: 400,
            }));
            return;
          }

          const allowedPatchKeys = new Set(['title']);
          for (const key of Object.keys(body)) {
            if (!allowedPatchKeys.has(key)) {
              sendJson(res, 400, createErrorEnvelope({
                code: ProtocolErrorCode.BAD_REQUEST,
                message: 'Unexpected field in request body',
                status: 400,
              }));
              return;
            }
          }

          let title: string | null = null;
          if (body.title !== undefined && body.title !== null) {
            if (typeof body.title !== 'string') {
              sendJson(res, 400, createErrorEnvelope({
                code: ProtocolErrorCode.BAD_REQUEST,
                message: 'Session title must be a string',
                status: 400,
              }));
              return;
            }
            if (body.title.length > 256) {
              sendJson(res, 400, createErrorEnvelope({
                code: ProtocolErrorCode.BAD_REQUEST,
                message: 'Session title must not exceed 256 characters',
                status: 400,
              }));
              return;
            }
            title = body.title;
          }

          const updated = await platformApi.updateSession(currentUserId, sessionId, { title });
          sendJson(res, 200, createSuccessEnvelope(updated));
          return;
        }
      }

      // 7c. Session Archival: POST /api/sessions/:sessionId/archive
      const sessionArchiveMatch = pathname.match(/^\/api\/sessions\/([^\/]+)\/archive$/);
      if (sessionArchiveMatch && method === 'POST') {
        const rawSessionId = sessionArchiveMatch[1];
        const validated = validatePathId(rawSessionId, 'sessionId');
        if (!validated.valid || !validated.value) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: validated.error || 'Invalid sessionId',
            status: 400,
          }));
          return;
        }
        const sessionId = validated.value;
        const body = await parseJsonBody<unknown>(req, maxBodyBytes);
        if (isRecord(body) && Object.keys(body).length > 0) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: 'Archive session endpoint expects an empty body',
            status: 400,
          }));
          return;
        }

        const archived = await platformApi.archiveSession(currentUserId, sessionId);
        sendJson(res, 200, createSuccessEnvelope(archived));
        return;
      }

      // 7c-2. Session Restore: POST /api/sessions/:sessionId/restore
      const sessionRestoreMatch = pathname.match(/^\/api\/sessions\/([^\/]+)\/restore$/);
      if (sessionRestoreMatch && method === 'POST') {
        const rawSessionId = sessionRestoreMatch[1];
        const validated = validatePathId(rawSessionId, 'sessionId');
        if (!validated.valid || !validated.value) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: validated.error || 'Invalid sessionId',
            status: 400,
          }));
          return;
        }
        const sessionId = validated.value;
        const body = await parseJsonBody<unknown>(req, maxBodyBytes);
        if (isRecord(body) && Object.keys(body).length > 0) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: 'Restore session endpoint expects an empty body',
            status: 400,
          }));
          return;
        }

        const restored = await platformApi.restoreSession(currentUserId, sessionId);
        sendJson(res, 200, createSuccessEnvelope(restored));
        return;
      }

      // 7c-3. Session Fork: POST /api/sessions/:sessionId/fork
      const sessionForkMatch = pathname.match(/^\/api\/sessions\/([^\/]+)\/fork$/);
      if (sessionForkMatch && method === 'POST') {
        const rawSessionId = sessionForkMatch[1];
        const validated = validatePathId(rawSessionId, 'sessionId');
        if (!validated.valid || !validated.value) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: validated.error || 'Invalid sessionId',
            status: 400,
          }));
          return;
        }
        const sessionId = validated.value;

        const body = await parseJsonBody<unknown>(req, maxBodyBytes);
        if (!isRecord(body)) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: 'Request body must be a JSON object',
            status: 400,
          }));
          return;
        }

        const allowedForkKeys = new Set(['fromMessageId', 'fromTurnId', 'title', 'targetSpaceId']);
        for (const key of Object.keys(body)) {
          if (!allowedForkKeys.has(key)) {
            sendJson(res, 400, createErrorEnvelope({
              code: ProtocolErrorCode.BAD_REQUEST,
              message: `Unexpected field "${key}" in fork request body`,
              status: 400,
            }));
            return;
          }
        }

        const forked = await platformApi.forkSession(currentUserId, sessionId, {
          fromMessageId: typeof body.fromMessageId === 'string' ? body.fromMessageId : undefined,
          fromTurnId: typeof body.fromTurnId === 'string' ? body.fromTurnId : undefined,
          title: typeof body.title === 'string' ? body.title : undefined,
          targetSpaceId: typeof body.targetSpaceId === 'string' ? body.targetSpaceId : undefined,
        });

        sendJson(res, 201, createSuccessEnvelope(forked));
        return;
      }

      // 7c-4. Session Regenerate: POST /api/sessions/:sessionId/regenerate
      const sessionRegenMatch = pathname.match(/^\/api\/sessions\/([^\/]+)\/regenerate$/);
      if (sessionRegenMatch && method === 'POST') {
        const rawSessionId = sessionRegenMatch[1];
        const validated = validatePathId(rawSessionId, 'sessionId');
        if (!validated.valid || !validated.value) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: validated.error || 'Invalid sessionId',
            status: 400,
          }));
          return;
        }
        const sessionId = validated.value;

        const body = await parseJsonBody<unknown>(req, maxBodyBytes);
        if (!isRecord(body)) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: 'Request body must be a JSON object',
            status: 400,
          }));
          return;
        }

        const allowedRegenKeys = new Set(['sourceMessageId', 'title', 'targetSpaceId']);
        for (const key of Object.keys(body)) {
          if (!allowedRegenKeys.has(key)) {
            sendJson(res, 400, createErrorEnvelope({
              code: ProtocolErrorCode.BAD_REQUEST,
              message: `Unexpected field "${key}" in regenerate request body`,
              status: 400,
            }));
            return;
          }
        }

        if (typeof body.sourceMessageId !== 'string' || !body.sourceMessageId.trim()) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: 'Field "sourceMessageId" must be a non-empty string',
            status: 400,
          }));
          return;
        }

        // Fetch messages for session
        const msgsRes = await platformApi.listMessages(currentUserId, sessionId, { limit: 100 });
        const allMsgs = msgsRes.messages;
        const targetMsgIdx = allMsgs.findIndex((m) => m.id === body.sourceMessageId);
        if (targetMsgIdx === -1) {
          sendJson(res, 404, createErrorEnvelope({
            code: ProtocolErrorCode.NOT_FOUND,
            message: `Message "${body.sourceMessageId}" not found in session`,
            status: 404,
          }));
          return;
        }

        const targetMsg = allMsgs[targetMsgIdx];
        let userPromptMsg: PublicMessage | undefined;
        let userPromptIdx = -1;

        if (targetMsg.role === 'assistant') {
          for (let i = targetMsgIdx - 1; i >= 0; i--) {
            if (allMsgs[i].role === 'user') {
              userPromptMsg = allMsgs[i];
              userPromptIdx = i;
              break;
            }
          }
          if (!userPromptMsg) {
            sendJson(res, 400, createErrorEnvelope({
              code: ProtocolErrorCode.BAD_REQUEST,
              message: 'Cannot regenerate assistant message without preceding user prompt',
              status: 400,
            }));
            return;
          }
        } else {
          userPromptMsg = targetMsg;
          userPromptIdx = targetMsgIdx;
        }

        const branchTitle = typeof body.title === 'string' ? body.title : undefined;
        const targetSpaceId = typeof body.targetSpaceId === 'string' ? body.targetSpaceId : undefined;

        let forkedSession: PublicSession;
        if (userPromptIdx > 0) {
          forkedSession = await platformApi.forkSession(currentUserId, sessionId, {
            fromMessageId: allMsgs[userPromptIdx - 1].id,
            title: branchTitle,
            targetSpaceId,
          });
        } else {
          const srcSess = await platformApi.getSession(currentUserId, sessionId);
          forkedSession = await platformApi.createSession(currentUserId, {
            spaceId: targetSpaceId || (srcSess ? srcSess.spaceId : 'default'),
            title: branchTitle || (srcSess?.title ? `${srcSess.title} (Branch)` : 'Session (Branch)'),
          });
        }

        const deliveryId = `deliv_${randomUUID().replace(/-/g, '').toLowerCase()}`;
        const inboundEnvelope: InboundEnvelope = {
          id: deliveryId,
          userId: currentUserId,
          sessionId: forkedSession.id,
          content: userPromptMsg.content,
          timestamp: new Date().toISOString(),
          ...(userPromptMsg.attachments && userPromptMsg.attachments.length > 0
            ? { attachments: userPromptMsg.attachments as any }
            : {}),
          ...(userPromptMsg.replyReference ? { replyToMessageId: userPromptMsg.replyReference.messageId } : {}),
        };

        const dispatchResult = await runtimeGateway.dispatchInbound(inboundEnvelope);

        sendJson(res, 201, createSuccessEnvelope({
          newSessionId: forkedSession.id,
          sessionId: forkedSession.id,
          session: forkedSession,
          sourceSessionId: sessionId,
          sourceMessageId: body.sourceMessageId,
          message: dispatchResult.message,
          accepted: true,
        }));
        return;
      }

      // 7d. Session Reset: POST /api/sessions/:sessionId/reset
      const sessionResetMatch = pathname.match(/^\/api\/sessions\/([^\/]+)\/reset$/);
      if (sessionResetMatch && method === 'POST') {
        const rawSessionId = sessionResetMatch[1];
        const validated = validatePathId(rawSessionId, 'sessionId');
        if (!validated.valid || !validated.value) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: validated.error || 'Invalid sessionId',
            status: 400,
          }));
          return;
        }
        const sessionId = validated.value;

        const altHeader = req.headers['x-idempotency-key'];
        if (altHeader) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: 'Alternate header "x-idempotency-key" is not permitted; use canonical "Idempotency-Key" header',
            status: 400,
          }));
          return;
        }

        const rawHeaderKey = req.headers['idempotency-key'];
        let idempotencyKey: string | undefined = undefined;
        if (typeof rawHeaderKey === 'string' && rawHeaderKey.length > 0) {
          if (rawHeaderKey !== rawHeaderKey.trim() || !STRICT_LOWERCASE_UUID_V4_REGEX.test(rawHeaderKey)) {
            sendJson(res, 400, createErrorEnvelope({
              code: ProtocolErrorCode.BAD_REQUEST,
              message: 'Idempotency-Key header must be a valid lowercase UUIDv4',
              status: 400,
            }));
            return;
          }
          idempotencyKey = rawHeaderKey;
        }

        const body = await parseJsonBody<unknown>(req, maxBodyBytes);
        let reason: string | undefined = undefined;
        if (isRecord(body)) {
          const allowedResetKeys = new Set(['reason', 'idempotencyKey']);
          for (const key of Object.keys(body)) {
            if (!allowedResetKeys.has(key)) {
              sendJson(res, 400, createErrorEnvelope({
                code: ProtocolErrorCode.BAD_REQUEST,
                message: 'Unexpected field in request body',
                status: 400,
              }));
              return;
            }
          }

          if (body.reason !== undefined && body.reason !== null) {
            if (
              typeof body.reason !== 'string' ||
              body.reason !== body.reason.trim() ||
              body.reason.normalize('NFC') !== body.reason ||
              body.reason.length === 0 ||
              body.reason.length > 128
            ) {
              sendJson(res, 400, createErrorEnvelope({
                code: ProtocolErrorCode.BAD_REQUEST,
                message: 'Reset reason must be a non-empty NFC-normalized string with maximum 128 characters',
                status: 400,
              }));
              return;
            }
            reason = body.reason;
          }

          if (body.idempotencyKey !== undefined && body.idempotencyKey !== null) {
            if (
              typeof body.idempotencyKey !== 'string' ||
              body.idempotencyKey !== body.idempotencyKey.trim() ||
              !STRICT_LOWERCASE_UUID_V4_REGEX.test(body.idempotencyKey)
            ) {
              sendJson(res, 400, createErrorEnvelope({
                code: ProtocolErrorCode.BAD_REQUEST,
                message: 'Body idempotencyKey must be a valid lowercase UUIDv4',
                status: 400,
              }));
              return;
            }
            if (idempotencyKey && idempotencyKey !== body.idempotencyKey) {
              sendJson(res, 400, createErrorEnvelope({
                code: ProtocolErrorCode.BAD_REQUEST,
                message: 'Conflicting Idempotency-Key values between Header and Body',
                status: 400,
              }));
              return;
            }
            idempotencyKey = body.idempotencyKey;
          }
        }

        if (!idempotencyKey) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: 'Missing required Idempotency-Key for session reset',
            status: 400,
          }));
          return;
        }

        const resetResult = await platformApi.resetSession(currentUserId, sessionId, {
          idempotencyKey,
          reason,
        });

        sendJson(res, 200, createSuccessEnvelope(resetResult));
        return;
      }

      // 7e. Session Generations List: GET /api/sessions/:sessionId/generations
      const sessionGenerationsMatch = pathname.match(/^\/api\/sessions\/([^\/]+)\/generations$/);
      if (sessionGenerationsMatch && method === 'GET') {
        const rawSessionId = sessionGenerationsMatch[1];
        const validated = validatePathId(rawSessionId, 'sessionId');
        if (!validated.valid || !validated.value) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: validated.error || 'Invalid sessionId',
            status: 400,
          }));
          return;
        }
        const sessionId = validated.value;

        const generations = await platformApi.listSessionGenerations(currentUserId, sessionId);
        sendJson(res, 200, createSuccessEnvelope(generations));
        return;
      }

      // 8. Session Messages: GET /api/sessions/:sessionId/messages or POST /api/sessions/:sessionId/messages
      const sessionMessagesMatch = pathname.match(/^\/api\/sessions\/([^\/]+)\/messages$/);
      if (sessionMessagesMatch) {
        const rawSessionId = sessionMessagesMatch[1];
        const validated = validatePathId(rawSessionId, 'sessionId');
        if (!validated.valid || !validated.value) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: validated.error || 'Invalid sessionId',
            status: 400,
          }));
          return;
        }
        const sessionId = validated.value;

        if (method === 'GET') {
          const cursor = parsedUrl.searchParams.get('cursor') || undefined;
          const rawLimit = parsedUrl.searchParams.get('limit');
          let limit: number | undefined = undefined;
          if (rawLimit) {
            const parsed = parseInt(rawLimit, 10);
            if (Number.isNaN(parsed) || parsed <= 0 || parsed > 500) {
              sendJson(res, 400, createErrorEnvelope({
                code: ProtocolErrorCode.BAD_REQUEST,
                message: 'limit parameter must be a positive integer between 1 and 500',
                status: 400,
              }));
              return;
            }
            limit = parsed;
          }

          const listResult = await platformApi.listMessages(currentUserId, sessionId, {
            cursor,
            limit,
          });

          sendJson(res, 200, createSuccessEnvelope(listResult));
          return;
        }

        if (method === 'POST') {
          const session = await platformApi.getSession(currentUserId, sessionId);
          if (!session) {
            sendJson(res, 404, createErrorEnvelope({
              code: ProtocolErrorCode.NOT_FOUND,
              message: 'Session not found or access denied',
              status: 404,
            }));
            return;
          }

          if (session.status === 'archived' || session.status === 'deleted') {
            sendJson(res, 400, createErrorEnvelope({
              code: ProtocolErrorCode.BAD_REQUEST,
              message: 'Cannot send messages in archived session',
              status: 400,
            }));
            return;
          }

          const altIdempHeader = req.headers['x-idempotency-key'];
          if (altIdempHeader) {
            sendJson(res, 400, createErrorEnvelope({
              code: ProtocolErrorCode.BAD_REQUEST,
              message: 'Alternate header "x-idempotency-key" is not permitted; use canonical "Idempotency-Key" header',
              status: 400,
            }));
            return;
          }

          const rawIdempotencyHeader = req.headers['idempotency-key'];
          if (!rawIdempotencyHeader || typeof rawIdempotencyHeader !== 'string') {
            sendJson(res, 400, createErrorEnvelope({
              code: ProtocolErrorCode.BAD_REQUEST,
              message: 'Missing required Idempotency-Key header for message delivery',
              status: 400,
            }));
            return;
          }

          if (Array.isArray(rawIdempotencyHeader) || rawIdempotencyHeader.includes(',')) {
            sendJson(res, 400, createErrorEnvelope({
              code: ProtocolErrorCode.BAD_REQUEST,
              message: 'Duplicate or comma-separated Idempotency-Key header is rejected',
              status: 400,
            }));
            return;
          }

          if (rawIdempotencyHeader !== rawIdempotencyHeader.trim() || !STRICT_LOWERCASE_UUID_V4_REGEX.test(rawIdempotencyHeader)) {
            sendJson(res, 400, createErrorEnvelope({
              code: ProtocolErrorCode.BAD_REQUEST,
              message: 'Invalid Idempotency-Key format. Expected exact UUID v4.',
              status: 400,
            }));
            return;
          }
          const deliveryId = `deliv_${rawIdempotencyHeader.replace(/-/g, '').toLowerCase()}`;

          const body = await parseJsonBody<unknown>(req, maxBodyBytes);
          if (!isRecord(body)) {
            sendJson(res, 400, createErrorEnvelope({
              code: ProtocolErrorCode.BAD_REQUEST,
              message: 'Request body must be a JSON object',
              status: 400,
            }));
            return;
          }

          const allowedKeys = new Set(['content', 'attachments', 'replyToMessageId']);
          for (const key of Object.keys(body)) {
            if (!allowedKeys.has(key)) {
              sendJson(res, 400, createErrorEnvelope({
                code: ProtocolErrorCode.BAD_REQUEST,
                message: 'Unexpected field in request body',
                status: 400,
              }));
              return;
            }
          }

          const validContent = validateMessageContent(body.content);
          if (!validContent.valid || !validContent.value) {
            sendJson(res, 400, createErrorEnvelope({
              code: ProtocolErrorCode.BAD_REQUEST,
              message: validContent.error || 'Invalid message content',
              status: 400,
            }));
            return;
          }

          let rawAttachments: any[] | undefined;
          if (body.attachments !== undefined) {
            const validAtt = validateAttachments(body.attachments);
            if (!validAtt.valid) {
              sendJson(res, 400, createErrorEnvelope({
                code: ProtocolErrorCode.BAD_REQUEST,
                message: validAtt.error || 'Invalid attachments',
                status: 400,
              }));
              return;
            }
            rawAttachments = validAtt.value;
          }

          let replyToMessageId: string | undefined;
          if (body.replyToMessageId !== undefined && body.replyToMessageId !== null) {
            if (typeof body.replyToMessageId !== 'string' || !body.replyToMessageId.trim()) {
              sendJson(res, 400, createErrorEnvelope({
                code: ProtocolErrorCode.BAD_REQUEST,
                message: 'Field "replyToMessageId" must be a non-empty string',
                status: 400,
              }));
              return;
            }
            replyToMessageId = body.replyToMessageId.trim();
          }

          const inboundEnvelope: InboundEnvelope = {
            id: deliveryId,
            userId: currentUserId,
            sessionId,
            content: validContent.value,
            timestamp: new Date().toISOString(),
            ...(rawAttachments && rawAttachments.length > 0 ? { attachments: rawAttachments } : {}),
            ...(replyToMessageId ? { replyToMessageId } : {}),
          };

          const dispatchResult = await runtimeGateway.dispatchInbound(inboundEnvelope);

          sendJson(res, 200, createSuccessEnvelope({
            accepted: true,
            message: {
              id: dispatchResult.message.id,
              role: dispatchResult.message.role,
              content: dispatchResult.message.content,
              status: dispatchResult.message.status,
              createdAt: dispatchResult.message.createdAt,
              ...(dispatchResult.message.attachments && dispatchResult.message.attachments.length > 0
                ? { attachments: dispatchResult.message.attachments }
                : {}),
              ...(dispatchResult.message.replyReference ? { replyReference: dispatchResult.message.replyReference } : {}),
            },
            isDuplicate: Boolean(dispatchResult.isDuplicate),
          }));
          return;
        }
      }

      // 8b. Edit Message: POST /api/messages/:messageId/edit or POST /api/sessions/:sessionId/messages/:messageId/edit
      const standaloneEditMatch = pathname.match(/^\/api\/messages\/([^\/]+)\/edit$/);
      const sessionMsgEditMatch = pathname.match(/^\/api\/sessions\/([^\/]+)\/messages\/([^\/]+)\/edit$/);
      if ((standaloneEditMatch || sessionMsgEditMatch) && method === 'POST') {
        const messageId = standaloneEditMatch ? standaloneEditMatch[1] : sessionMsgEditMatch![2];
        const body = await parseJsonBody<unknown>(req, maxBodyBytes);
        if (!isRecord(body)) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: 'Request body must be a JSON object',
            status: 400,
          }));
          return;
        }

        const validContent = validateMessageContent(body.content);
        if (!validContent.valid || !validContent.value) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: validContent.error || 'Invalid message content',
            status: 400,
          }));
          return;
        }

        let rawAttachments: any[] | undefined;
        if (body.attachments !== undefined) {
          const validAtt = validateAttachments(body.attachments);
          if (!validAtt.valid) {
            sendJson(res, 400, createErrorEnvelope({
              code: ProtocolErrorCode.BAD_REQUEST,
              message: validAtt.error || 'Invalid attachments',
              status: 400,
            }));
            return;
          }
          rawAttachments = validAtt.value;
        }

        // Find message to locate session
        let targetSessionId = sessionMsgEditMatch ? sessionMsgEditMatch[1] : undefined;
        if (!targetSessionId) {
          const sessions = await platformApi.listSessions(currentUserId);
          for (const s of sessions) {
            const m = await platformApi.getMessage(currentUserId, s.id, messageId);
            if (m) {
              targetSessionId = s.id;
              break;
            }
          }
        }

        if (!targetSessionId) {
          sendJson(res, 404, createErrorEnvelope({
            code: ProtocolErrorCode.NOT_FOUND,
            message: `Message "${messageId}" not found`,
            status: 404,
          }));
          return;
        }

        const msgsRes = await platformApi.listMessages(currentUserId, targetSessionId, { limit: 100 });
        const allMsgs = msgsRes.messages;
        const targetIdx = allMsgs.findIndex((m) => m.id === messageId);
        if (targetIdx === -1) {
          sendJson(res, 404, createErrorEnvelope({
            code: ProtocolErrorCode.NOT_FOUND,
            message: `Message "${messageId}" not found in session`,
            status: 404,
          }));
          return;
        }

        const branchTitle = typeof body.title === 'string' ? body.title : undefined;
        const targetSpaceId = typeof body.targetSpaceId === 'string' ? body.targetSpaceId : undefined;

        let forkedSession: PublicSession;
        if (targetIdx > 0) {
          forkedSession = await platformApi.forkSession(currentUserId, targetSessionId, {
            fromMessageId: allMsgs[targetIdx - 1].id,
            title: branchTitle,
            targetSpaceId,
          });
        } else {
          const srcSess = await platformApi.getSession(currentUserId, targetSessionId);
          forkedSession = await platformApi.createSession(currentUserId, {
            spaceId: targetSpaceId || (srcSess ? srcSess.spaceId : 'default'),
            title: branchTitle || (srcSess?.title ? `${srcSess.title} (Edit)` : 'Session (Edit)'),
          });
        }

        const deliveryId = `deliv_${randomUUID().replace(/-/g, '').toLowerCase()}`;
        const inboundEnvelope: InboundEnvelope = {
          id: deliveryId,
          userId: currentUserId,
          sessionId: forkedSession.id,
          content: validContent.value,
          timestamp: new Date().toISOString(),
          ...(rawAttachments && rawAttachments.length > 0 ? { attachments: rawAttachments } : {}),
          ...(typeof body.replyToMessageId === 'string' ? { replyToMessageId: body.replyToMessageId } : {}),
        };

        const dispatchResult = await runtimeGateway.dispatchInbound(inboundEnvelope);

        sendJson(res, 201, createSuccessEnvelope({
          newSessionId: forkedSession.id,
          sessionId: forkedSession.id,
          session: forkedSession,
          sourceSessionId: targetSessionId,
          sourceMessageId: messageId,
          message: dispatchResult.message,
          accepted: true,
        }));
        return;
      }

      // 9. Incremental Polling Events: GET /api/sessions/:sessionId/events
      const sessionEventsMatch = pathname.match(/^\/api\/sessions\/([^\/]+)\/events$/);
      if (sessionEventsMatch && method === 'GET') {
        const rawSessionId = sessionEventsMatch[1];
        const validated = validatePathId(rawSessionId, 'sessionId');
        if (!validated.valid || !validated.value) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: validated.error || 'Invalid sessionId',
            status: 400,
          }));
          return;
        }
        const sessionId = validated.value;
        const cursor = parsedUrl.searchParams.get('cursor') || undefined;

        const eventsResult = await platformApi.pollEvents(currentUserId, sessionId, cursor);
        sendJson(res, 200, createSuccessEnvelope(eventsResult));
        return;
      }

      // 10. Current Turn Status: GET /api/sessions/:sessionId/turn/current
      const turnStatusMatch = pathname.match(/^\/api\/sessions\/([^\/]+)\/turn\/current$/);
      if (turnStatusMatch && method === 'GET') {
        const rawSessionId = turnStatusMatch[1];
        const validated = validatePathId(rawSessionId, 'sessionId');
        if (!validated.valid || !validated.value) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: validated.error || 'Invalid sessionId',
            status: 400,
          }));
          return;
        }
        const sessionId = validated.value;
        const turnStatus = await runtimeGateway.getCurrentTurnStatus(currentUserId, sessionId);
        sendJson(res, 200, createSuccessEnvelope(turnStatus));
        return;
      }

      // 11. Cancel Current Turn: POST /api/sessions/:sessionId/turn/cancel-current
      const turnCancelMatch = pathname.match(/^\/api\/sessions\/([^\/]+)\/turn\/cancel-current$/);
      if (turnCancelMatch && method === 'POST') {
        const rawSessionId = turnCancelMatch[1];
        const validated = validatePathId(rawSessionId, 'sessionId');
        if (!validated.valid || !validated.value) {
          sendJson(res, 400, createErrorEnvelope({
            code: ProtocolErrorCode.BAD_REQUEST,
            message: validated.error || 'Invalid sessionId',
            status: 400,
          }));
          return;
        }
        const sessionId = validated.value;
        const cancelled = await runtimeGateway.cancelCurrentTurn(currentUserId, sessionId);
        sendJson(res, 200, createSuccessEnvelope({ cancelled }));
        return;
      }

      // 404 Route Not Found
      sendJson(res, 404, createErrorEnvelope({
        code: ProtocolErrorCode.NOT_FOUND,
        message: 'Endpoint not found',
        status: 404,
      }));
    } catch (err: unknown) {
      if (err instanceof PlatformError) {
        sendJson(res, err.status, createErrorEnvelope({
          code: err.code,
          message: err.message,
          status: err.status,
        }));
        return;
      }

      const errObj = isRecord(err) ? err : undefined;
      const status = typeof errObj?.status === 'number' ? errObj.status : 500;
      const code = typeof errObj?.code === 'string'
        ? errObj.code
        : (status === 400 ? ProtocolErrorCode.BAD_REQUEST : (status === 413 ? ProtocolErrorCode.PAYLOAD_TOO_LARGE : ProtocolErrorCode.INTERNAL_ERROR));
      const message = err instanceof Error ? err.message : (typeof errObj?.message === 'string' ? errObj.message : 'Internal server error');

      sendJson(res, status, createErrorEnvelope({
        code,
        message,
        status,
      }));
    }
  };
}
