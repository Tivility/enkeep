/**
 * browser_open Tool Implementation
 *
 * Opens a web page at a validated URL in an isolated platform browser session.
 *
 * @module @enkeep/dsh-tool-browser/tools/browser-open
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type {
  BrowserOpenArgs,
  BrowserOpenResult,
  BrowserPlatformClientService,
  BrowserPluginConfig,
} from '../types.js';
import {
  createBrowserToolUnavailableError,
  createInvalidBrowserResponseError,
  createInvalidArgumentError,
} from '../errors.js';
import { validateSafeUrl } from '../security.js';
import { resolveCallerScope } from '../scope.js';
import { enforceBrowserApproval } from '../approvals.js';

export function createBrowserOpenTool(
  getClient: () => BrowserPlatformClientService | undefined,
  config: BrowserPluginConfig = {},
  ctx?: Context
): ToolDefinition {
  return {
    name: 'browser_open',
    description:
      'Open a web page at the specified URL in an isolated browser session. Returns pageId for subsequent snapshot and interaction.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The absolute HTTP or HTTPS URL of the web page to open.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          pageId: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['success', 'pageId', 'url'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: any) => [
        {
          type: 'text',
          text: `Opened ${value.url} (pageId: ${value.pageId})${value.title ? ` — ${value.title}` : ''}`,
        },
      ],
    },
    async execute(args: any, execContext?: ToolRunContext): Promise<BrowserOpenResult> {
      if (!args || typeof args !== 'object') {
        throw createInvalidArgumentError('browser_open requires an object with a "url" property');
      }

      const safeUrl = validateSafeUrl(args.url, config.allowedProtocols);
      const scope = resolveCallerScope(execContext, ctx);

      if (config.requireApprovalOnOpen) {
        await enforceBrowserApproval({
          ctx,
          execContext,
          toolName: 'browser_open',
          actionDescription: `Navigate to "${safeUrl}"`,
          agent: scope.agent,
          forceApproval: true,
        });
      }

      const client = getClient();
      if (!client || typeof client.request !== 'function') {
        throw createBrowserToolUnavailableError();
      }

      const timeoutMs = config.defaultTimeoutMs ?? 30_000;
      const res = await client.request<{
        success?: boolean;
        pageId?: string;
        url?: string;
        title?: string;
        message?: string;
      }>('/api/browser/open', {
        method: 'POST',
        timeoutMs,
        signal: execContext?.signal,
        body: {
          url: safeUrl,
          userId: scope.userId,
          spaceId: scope.spaceId,
          sessionId: scope.sessionId,
        },
      });

      if (!res || typeof res !== 'object' || typeof res.status !== 'number') {
        throw createInvalidBrowserResponseError('Invalid HTTP transport response from platform browser service');
      }

      const data = res.data;
      if (!data || typeof data !== 'object' || !data.pageId || typeof data.pageId !== 'string') {
        throw createInvalidBrowserResponseError('Platform browser open response missing required "pageId"');
      }

      return {
        success: data.success !== false,
        pageId: String(data.pageId),
        url: typeof data.url === 'string' ? data.url : safeUrl,
        ...(typeof data.title === 'string' ? { title: data.title } : {}),
        ...(typeof data.message === 'string' ? { message: data.message } : {}),
      };
    },
  };
}
