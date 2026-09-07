/**
 * browser_snapshot Tool Implementation
 *
 * Captures accessibility tree snapshots of a web page with semantic references.
 *
 * @module @enkeep/dsh-tool-browser/tools/browser-snapshot
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type {
  BrowserSnapshotArgs,
  BrowserSnapshotResult,
  BrowserPlatformClientService,
  BrowserPluginConfig,
} from '../types.js';
import {
  createBrowserToolUnavailableError,
  createInvalidBrowserResponseError,
  createInvalidArgumentError,
} from '../errors.js';
import { boundSnapshot, MAX_PAGE_ID_LENGTH } from '../security.js';
import { resolveCallerScope } from '../scope.js';

export function createBrowserSnapshotTool(
  getClient: () => BrowserPlatformClientService | undefined,
  config: BrowserPluginConfig = {},
  ctx?: Context
): ToolDefinition {
  return {
    name: 'browser_snapshot',
    description:
      'Capture the accessibility snapshot and interactive element tree of an open web page.',
    parameters: {
      type: 'object',
      properties: {
        pageId: {
          type: 'string',
          description: 'The target pageId returned from browser_open.',
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
          url: { type: 'string' },
          title: { type: 'string' },
          snapshot: { type: 'string' },
          textSummary: { type: 'string' },
          interactiveElementsCount: { type: 'number' },
        },
        required: ['success', 'pageId', 'url', 'snapshot'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: any) => [
        {
          type: 'text',
          text: `Snapshot of ${value.url} (pageId: ${value.pageId})${value.title ? ` — ${value.title}` : ''}:\n\n${value.snapshot}`,
        },
      ],
    },
    async execute(
      args: any,
      execContext?: ToolRunContext
    ): Promise<BrowserSnapshotResult> {
      if (!args || typeof args !== 'object' || typeof args.pageId !== 'string' || args.pageId.trim() === '') {
        throw createInvalidArgumentError('browser_snapshot requires a non-empty "pageId" string');
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
        url?: string;
        title?: string;
        snapshot?: string;
        textSummary?: string;
        interactiveElementsCount?: number;
      }>('/api/browser/snapshot', {
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
        throw createInvalidBrowserResponseError('Platform browser snapshot response is empty or invalid');
      }

      const rawSnapshot =
        typeof data.snapshot === 'string'
          ? data.snapshot
          : typeof data.textSummary === 'string'
          ? data.textSummary
          : '';
      const bounded = boundSnapshot(rawSnapshot, config.maxSnapshotLength);

      return {
        success: data.success !== false,
        pageId: String(data.pageId || args.pageId),
        url: typeof data.url === 'string' ? data.url : '',
        ...(typeof data.title === 'string' ? { title: data.title } : {}),
        snapshot: bounded,
        textSummary: bounded,
        ...(typeof data.interactiveElementsCount === 'number'
          ? { interactiveElementsCount: data.interactiveElementsCount }
          : {}),
      };
    },
  };
}
