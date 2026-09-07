/**
 * browser_screenshot Tool Implementation
 *
 * Captures a screenshot of an open web page.
 * The Platform Browser Gateway persists the screenshot directly into the space workspace
 * at `artifacts/browser/<timestamp>-<id>.png` via TenantRuntimeFileProvider.
 * Returns virtual relative workspace path and downloadUrl reference (no raw base64 bytes to model).
 *
 * @module @enkeep/dsh-tool-browser/tools/browser-screenshot
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type {
  BrowserScreenshotArgs,
  BrowserScreenshotResult,
  BrowserPlatformClientService,
  BrowserPluginConfig,
} from '../types.js';
import {
  createBrowserToolUnavailableError,
  createInvalidBrowserResponseError,
  createInvalidArgumentError,
} from '../errors.js';
import { MAX_PAGE_ID_LENGTH } from '../security.js';
import { resolveCallerScope } from '../scope.js';

export function createBrowserScreenshotTool(
  getClient: () => BrowserPlatformClientService | undefined,
  config: BrowserPluginConfig = {},
  ctx?: Context
): ToolDefinition {
  return {
    name: 'browser_screenshot',
    description:
      'Capture a screenshot of an open web page. The image is persisted directly to workspace artifacts and returned as a file path and download reference.',
    parameters: {
      type: 'object',
      properties: {
        pageId: {
          type: 'string',
          description: 'The target pageId.',
        },
        fullPage: {
          type: 'boolean',
          description: 'Whether to capture full scrollable page height instead of current viewport only. Defaults to false.',
        },
      },
      required: ['pageId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          pageId: { type: 'string' },
          path: { type: 'string' },
          downloadUrl: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
          sizeBytes: { type: 'number' },
        },
        required: ['success', 'pageId', 'path', 'downloadUrl'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: any) => [
        {
          type: 'text',
          text: `Captured screenshot of page ${value.pageId} saved to ${value.path} (Download: ${value.downloadUrl})`,
        },
      ],
    },
    async execute(
      args: any,
      execContext?: ToolRunContext
    ): Promise<BrowserScreenshotResult> {
      if (!args || typeof args !== 'object' || typeof args.pageId !== 'string' || args.pageId.trim() === '') {
        throw createInvalidArgumentError('browser_screenshot requires a non-empty "pageId" string');
      }

      if (args.pageId.length > MAX_PAGE_ID_LENGTH) {
        throw createInvalidArgumentError(`pageId exceeds maximum allowed length of ${MAX_PAGE_ID_LENGTH}`);
      }

      const fullPage = args.fullPage === true;
      const scope = resolveCallerScope(execContext, ctx);

      const client = getClient();
      if (!client || typeof client.request !== 'function') {
        throw createBrowserToolUnavailableError();
      }

      const timeoutMs = config.defaultTimeoutMs ?? 30_000;
      const res = await client.request<{
        success?: boolean;
        pageId?: string;
        path?: string;
        downloadUrl?: string;
        width?: number;
        height?: number;
        sizeBytes?: number;
      }>('/api/browser/screenshot', {
        method: 'POST',
        timeoutMs,
        signal: execContext?.signal,
        body: {
          pageId: args.pageId.trim(),
          fullPage,
          userId: scope.userId,
          spaceId: scope.spaceId,
          sessionId: scope.sessionId,
        },
      });

      if (!res || typeof res !== 'object' || typeof res.status !== 'number') {
        throw createInvalidBrowserResponseError('Invalid HTTP transport response from platform browser service');
      }

      const data = res.data;
      if (!data || typeof data !== 'object') {
        throw createInvalidBrowserResponseError('Platform browser screenshot response is empty or invalid');
      }

      if (!data.path || typeof data.path !== 'string') {
        throw createInvalidBrowserResponseError('Platform browser screenshot response missing artifact "path"');
      }

      const rawDownloadUrl =
        typeof data.downloadUrl === 'string'
          ? data.downloadUrl
          : `/api/spaces/${encodeURIComponent(scope.spaceId)}/files/download?path=${encodeURIComponent(data.path)}`;

      return {
        success: data.success !== false,
        pageId: String(data.pageId || args.pageId),
        path: data.path,
        downloadUrl: rawDownloadUrl,
        ...(typeof data.width === 'number' ? { width: data.width } : {}),
        ...(typeof data.height === 'number' ? { height: data.height } : {}),
        ...(typeof data.sizeBytes === 'number' ? { sizeBytes: data.sizeBytes } : {}),
      };
    },
  };
}
