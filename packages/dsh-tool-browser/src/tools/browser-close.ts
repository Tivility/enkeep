/**
 * browser_close Tool Implementation
 *
 * Closes an open browser page session and releases associated resources.
 * Requires exact target pageId.
 *
 * @module @enkeep/dsh-tool-browser/tools/browser-close
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type {
  BrowserCloseArgs,
  BrowserCloseResult,
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

export function createBrowserCloseTool(
  getClient: () => BrowserPlatformClientService | undefined,
  config: BrowserPluginConfig = {},
  ctx?: Context
): ToolDefinition {
  return {
    name: 'browser_close',
    description:
      'Close a specific open browser page and release its memory and context resources.',
    parameters: {
      type: 'object',
      properties: {
        pageId: {
          type: 'string',
          description: 'The exact target pageId to close.',
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
          closed: { type: 'boolean' },
          closedPages: { type: 'number' },
        },
        required: ['success', 'pageId', 'closed'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: any) => [
        {
          type: 'text',
          text: `Closed browser page ${value.pageId}`,
        },
      ],
    },
    async execute(
      args: any,
      execContext?: ToolRunContext
    ): Promise<BrowserCloseResult> {
      if (!args || typeof args !== 'object' || typeof args.pageId !== 'string' || args.pageId.trim() === '') {
        throw createInvalidArgumentError('browser_close requires an exact non-empty "pageId" string');
      }

      if (args.pageId.length > MAX_PAGE_ID_LENGTH) {
        throw createInvalidArgumentError(`pageId exceeds maximum allowed length of ${MAX_PAGE_ID_LENGTH}`);
      }

      const scope = resolveCallerScope(execContext, ctx);

      const client = getClient();
      if (!client || typeof client.request !== 'function') {
        throw createBrowserToolUnavailableError();
      }

      const timeoutMs = config.defaultTimeoutMs ?? 30_000;
      const res = await client.request<{
        success?: boolean;
        pageId?: string;
        closed?: boolean;
        closedPages?: number;
      }>('/api/browser/close', {
        method: 'POST',
        timeoutMs,
        signal: execContext?.signal,
        body: {
          pageId: args.pageId.trim(),
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
        throw createInvalidBrowserResponseError('Platform browser close response is empty or invalid');
      }

      return {
        success: data.success !== false,
        pageId: String(data.pageId || args.pageId),
        closed: data.closed !== false,
        ...(typeof data.closedPages === 'number' ? { closedPages: data.closedPages } : {}),
      };
    },
  };
}
