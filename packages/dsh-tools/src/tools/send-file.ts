import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type {
  ToolDefinition,
  PlatformClientService,
  SendFileResult,
  ToolExecutionContext,
  ToolResult,
} from '../types.js';
import {
  readValidatedFile,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  MAX_PATH_LENGTH,
  FileSecurityError,
  type FileSecurityHooks,
} from '../file-security.js';
import {
  createPlatformToolUnavailableError,
  createInvalidPlatformResponseError,
  createToolContextUnavailableError,
} from '../errors.js';

export interface SendFileArgs {
  recipient: string;
  path: string;
  description?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSendFileResult(value: unknown): value is SendFileResult {
  return (
    isRecord(value) &&
    typeof value.success === 'boolean' &&
    typeof value.fileId === 'string' &&
    typeof value.path === 'string' &&
    typeof value.size === 'number' &&
    typeof value.recipient === 'string'
  );
}

export interface SendFileToolOptions {
  workspaceBoundaryRoot?: string | (() => string);
  /** @deprecated Legacy alias for workspaceBoundaryRoot. Will NOT be used as operational fallback cwd. */
  workspaceRoot?: string | (() => string);
  maxSizeBytes?: number;
  hooks?: FileSecurityHooks;
  context?: Context;
}

/**
 * Validate that an operational session cwd is an existing, non-symlink directory
 * strictly inside (and not equal to) the configured workspaceBoundaryRoot.
 *
 * @internal
 */
export function validateSessionWorkspaceCwd(
  sessionCwd: string,
  workspaceBoundaryRoot: string
): { canonicalCwd: string; canonicalBoundary: string } {
  if (!workspaceBoundaryRoot || typeof workspaceBoundaryRoot !== 'string' || workspaceBoundaryRoot.trim() === '') {
    throw new TypeError('send_file requires a valid absolute workspaceBoundaryRoot configuration');
  }

  if (!path.isAbsolute(workspaceBoundaryRoot)) {
    throw new TypeError('send_file workspaceBoundaryRoot must be an absolute path');
  }

  if (workspaceBoundaryRoot.includes('\0')) {
    throw new FileSecurityError('Null byte injection detected in workspaceBoundaryRoot', 'NULL_BYTE_INJECTION', 500);
  }

  let boundaryStat: fs.Stats;
  try {
    boundaryStat = fs.lstatSync(workspaceBoundaryRoot);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT') {
      throw new FileSecurityError('workspaceBoundaryRoot directory not found', 'WORKSPACE_BOUNDARY_NOT_FOUND', 500);
    }
    throw new FileSecurityError('Failed to inspect workspaceBoundaryRoot', 'WORKSPACE_BOUNDARY_STAT_FAILED', 500);
  }

  if (boundaryStat.isSymbolicLink()) {
    throw new FileSecurityError(
      'workspaceBoundaryRoot cannot be a symbolic link',
      'WORKSPACE_BOUNDARY_IS_SYMLINK',
      403
    );
  }

  if (!boundaryStat.isDirectory()) {
    throw new FileSecurityError(
      'workspaceBoundaryRoot is not a directory',
      'WORKSPACE_BOUNDARY_NOT_DIRECTORY',
      500
    );
  }

  let canonicalBoundary: string;
  try {
    canonicalBoundary = fs.realpathSync(workspaceBoundaryRoot);
  } catch {
    throw new FileSecurityError('Failed to resolve canonical workspaceBoundaryRoot', 'WORKSPACE_BOUNDARY_NOT_FOUND', 500);
  }

  if (!sessionCwd || typeof sessionCwd !== 'string' || sessionCwd.trim() === '') {
    throw createToolContextUnavailableError('Agent session cwd is required for send_file');
  }

  if (!path.isAbsolute(sessionCwd)) {
    throw createToolContextUnavailableError('Agent session cwd must be an absolute path');
  }

  if (sessionCwd.includes('\0')) {
    throw new FileSecurityError('Null byte injection detected in session cwd', 'NULL_BYTE_INJECTION', 400);
  }

  let cwdStat: fs.Stats;
  try {
    cwdStat = fs.lstatSync(sessionCwd);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT') {
      throw new FileSecurityError('Agent session workspace directory not found', 'WORKSPACE_NOT_FOUND', 404);
    }
    throw new FileSecurityError('Failed to inspect agent session cwd', 'WORKSPACE_STAT_FAILED', 400);
  }

  if (cwdStat.isSymbolicLink()) {
    throw new FileSecurityError(
      'Agent session cwd cannot be a symbolic link',
      'WORKSPACE_IS_SYMLINK',
      403
    );
  }

  if (!cwdStat.isDirectory()) {
    throw new FileSecurityError(
      'Agent session cwd is not a directory',
      'WORKSPACE_NOT_DIRECTORY',
      400
    );
  }

  let canonicalCwd: string;
  try {
    canonicalCwd = fs.realpathSync(sessionCwd);
  } catch {
    throw new FileSecurityError('Failed to resolve canonical agent session cwd', 'WORKSPACE_NOT_FOUND', 404);
  }

  // CWD must NOT equal the boundary root (must be a specific space child directory)
  if (canonicalCwd === canonicalBoundary) {
    throw new FileSecurityError(
      'Agent session cwd cannot be the spaces boundary root; must operate within a specific space',
      'WORKSPACE_CANNOT_BE_BOUNDARY_ROOT',
      403
    );
  }

  // CWD must be strictly contained inside the boundary root
  const relCwd = path.relative(canonicalBoundary, canonicalCwd);
  if (!relCwd || relCwd.startsWith('..') || path.isAbsolute(relCwd)) {
    throw new FileSecurityError(
      'Agent session cwd escapes the configured workspaceBoundaryRoot boundary',
      'WORKSPACE_OUTSIDE_BOUNDARY',
      403
    );
  }

  // Validate no intermediate path segments in relative cwd are symlinks
  const cwdSegments = relCwd.split(/[\\\/]+/).filter(Boolean);
  let currentWalk = canonicalBoundary;
  for (const seg of cwdSegments) {
    currentWalk = path.join(currentWalk, seg);
    let segStat: fs.Stats;
    try {
      segStat = fs.lstatSync(currentWalk);
    } catch {
      throw new FileSecurityError('Failed to inspect workspace path segment', 'WORKSPACE_SEGMENT_STAT_FAILED', 400);
    }
    if (segStat.isSymbolicLink()) {
      throw new FileSecurityError(
        'Symbolic link detected in workspace path segments',
        'WORKSPACE_PATH_IS_SYMLINK',
        403
      );
    }
  }

  return { canonicalCwd, canonicalBoundary };
}

export function createSendFileTool(
  getClient: () => PlatformClientService | undefined,
  toolOptions?: SendFileToolOptions,
  cordisContext?: Context
): ToolDefinition {
  return {
    name: 'send_file',
    description:
      'Send a workspace file to an external recipient. The file path must reside inside the calling agent session space directory.',
    parameters: {
      type: 'object',
      properties: {
        recipient: {
          type: 'string',
          description: 'Recipient user ID, channel ID, or destination target.',
        },
        path: {
          type: 'string',
          description: 'Relative path to the file inside the agent session space (or absolute path strictly within the active space).',
        },
        description: {
          type: 'string',
          description: 'Optional human-readable description or caption for the file.',
        },
      },
      required: ['recipient', 'path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          fileId: { type: 'string' },
          path: { type: 'string' },
          size: { type: 'integer' },
          recipient: { type: 'string' },
        },
        required: ['success', 'fileId', 'path', 'size', 'recipient'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: JsonValue): ContentBlock[] => {
        if (isSendFileResult(value)) {
          return [
            {
              type: 'text',
              text: `File "${value.path}" (${value.size} bytes) sent to ${value.recipient} (File ID: ${value.fileId})`,
            },
          ];
        }
        return [{ type: 'text', text: 'File sent' }];
      },
    },
    async execute(rawArgs: unknown, context?: ToolExecutionContext): Promise<SendFileResult> {
      if (!isRecord(rawArgs) || typeof rawArgs.recipient !== 'string' || rawArgs.recipient.length === 0) {
        throw new TypeError('send_file requires a non-empty recipient string');
      }
      if (typeof rawArgs.path !== 'string' || rawArgs.path.length === 0) {
        throw new TypeError('send_file requires a non-empty path string');
      }

      const args: SendFileArgs = {
        recipient: rawArgs.recipient,
        path: rawArgs.path,
        ...(typeof rawArgs.description === 'string' ? { description: rawArgs.description } : {}),
      };

      // 1. Check platformClient operational BEFORE any filesystem read
      const client = getClient();
      if (!client || !client.request) {
        throw createPlatformToolUnavailableError(
          'Enkeep Platform Client service is not available'
        );
      }

      // 2. Discover active Agent & session cwd via official initiator / request context
      const effectiveCtx = cordisContext ?? (toolOptions?.context as Context | undefined);
      let activeAgent = (context as any)?.agent;

      if (!activeAgent && effectiveCtx) {
        const agentsService = effectiveCtx.get('agents');
        if (agentsService) {
          if (typeof agentsService.currentInitiator === 'function') {
            activeAgent = agentsService.currentInitiator();
          }
          if (!activeAgent && (context as any)?.sessionId && typeof agentsService.get === 'function') {
            activeAgent = agentsService.get((context as any).sessionId);
          }
        }
      }

      const sessionCwd: string | undefined =
        activeAgent?.session?.header?.cwd ??
        (context as any)?.session?.header?.cwd ??
        (context as any)?.cwd;

      if (!sessionCwd || typeof sessionCwd !== 'string' || sessionCwd.trim() === '' || !path.isAbsolute(sessionCwd)) {
        throw createToolContextUnavailableError(
          'No active agent session context available for send_file (session cwd unavailable)'
        );
      }

      // 3. Resolve boundary root (mandatory configuration, ONLY used to validate cwd is allowed, never as fallback cwd)
      let boundaryRoot: string | undefined;
      const rawBoundaryOpt = toolOptions?.workspaceBoundaryRoot ?? toolOptions?.workspaceRoot;
      if (typeof rawBoundaryOpt === 'function') {
        boundaryRoot = rawBoundaryOpt();
      } else if (typeof rawBoundaryOpt === 'string') {
        boundaryRoot = rawBoundaryOpt;
      }

      if (!boundaryRoot || typeof boundaryRoot !== 'string' || boundaryRoot.trim() === '' || !path.isAbsolute(boundaryRoot)) {
        throw new TypeError('send_file requires an absolute workspaceBoundaryRoot configured');
      }

      // 4. Strictly validate session cwd within workspace boundary (fails closed on root equality, escapes, symlinks)
      const { canonicalCwd } = validateSessionWorkspaceCwd(sessionCwd, boundaryRoot);

      // 5. Validate and resolve target filePath relative to canonical session cwd
      if (args.path.length > MAX_PATH_LENGTH) {
        throw new FileSecurityError('File path exceeds maximum allowed length', 'PATH_TOO_LONG', 400);
      }
      if (args.path.includes('\0')) {
        throw new FileSecurityError('Null byte injection detected in path', 'NULL_BYTE_INJECTION', 400);
      }

      let relativeFilePath: string;
      if (path.isAbsolute(args.path) || args.path.startsWith('/') || args.path.startsWith('\\') || /^[a-zA-Z]:[\\\/]/.test(args.path)) {
        const resolvedAbsolute = path.resolve(args.path);
        const relToCwd = path.relative(canonicalCwd, resolvedAbsolute);
        if (!relToCwd || relToCwd === '' || relToCwd === '.' || relToCwd.startsWith('..') || path.isAbsolute(relToCwd)) {
          throw new FileSecurityError(
            'Absolute path is outside the active agent session workspace boundary',
            'ABSOLUTE_PATH_DISALLOWED',
            400
          );
        }
        relativeFilePath = relToCwd;
      } else {
        relativeFilePath = args.path;
      }

      // 6. Perform strict containment validation & atomic read inside the verified session cwd
      const validated = readValidatedFile({
        workspaceRoot: canonicalCwd,
        filePath: relativeFilePath,
        maxSizeBytes: toolOptions?.maxSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES,
        hooks: toolOptions?.hooks,
      });

      const sha256Hex = crypto.createHash('sha256').update(validated.content).digest('hex');
      const base64Content = validated.content.toString('base64');

      // Extract calling sessionId if known
      const callerSessionId: string | undefined =
        activeAgent?.session?.header?.id ??
        (context as any)?.sessionId ??
        (context as any)?.session?.header?.id;

      // 7. Execute platform request
      // Platform proxy will resolve route & spaceId from recipient or sessionId mapping in SQLite
      const res = await client.request<{
        success?: boolean;
        fileId?: string;
        id?: string;
        path?: string;
        size?: number;
        recipient?: string;
      }>('/api/files', {
        method: 'POST',
        body: {
          recipient: args.recipient,
          path: validated.relativePath,
          filename: validated.filename,
          size: validated.size,
          content: base64Content,
          encoding: 'base64',
          checksum: `sha256:${sha256Hex}`,
          sha256: sha256Hex,
          ...(callerSessionId ? { sessionId: callerSessionId } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
        },
      });

      if (!res || typeof res !== 'object' || typeof res.status !== 'number') {
        throw createInvalidPlatformResponseError(
          'Platform request returned an invalid HTTP response structure'
        );
      }

      if (res.status < 200 || res.status >= 300) {
        throw createInvalidPlatformResponseError(
          'Platform request failed'
        );
      }

      const data = res.data;
      if (!data || typeof data !== 'object') {
        throw createInvalidPlatformResponseError(
          'Platform request response body is missing or invalid'
        );
      }

      if (data.success === false) {
        throw createInvalidPlatformResponseError(
          'Platform request returned non-success response'
        );
      }

      const fileId = data.fileId ?? data.id;
      if (!fileId || typeof fileId !== 'string' || fileId.length === 0) {
        throw createInvalidPlatformResponseError(
          'Platform request response is missing authoritative fileId'
        );
      }

      return {
        success: true,
        fileId,
        path: data.path || validated.relativePath,
        size: typeof data.size === 'number' ? data.size : validated.size,
        recipient: data.recipient || args.recipient,
      };
    },
    presentCall: (rawArgs: unknown) => ({
      card: 'generic',
      title: isRecord(rawArgs) && typeof rawArgs.path === 'string' && typeof rawArgs.recipient === 'string'
        ? `Send file ${rawArgs.path} to ${rawArgs.recipient}`
        : 'Send file',
    }),
    presentResult: (_args: unknown, result: ToolResult) => ({
      card: 'generic',
      title: !result.isError ? 'Sent file' : 'Failed to send file',
    }),
  };
}
