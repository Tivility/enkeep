/**
 * browser_interact Tool Implementation
 *
 * Performs interactive actions (click, fill, press, select) on semantic elements
 * with strict action-specific parameter validation and human approval integration.
 *
 * @module @enkeep/dsh-tool-browser/tools/browser-interact
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type {
  BrowserInteractArgs,
  BrowserInteractResult,
  BrowserInteractAction,
  BrowserPlatformClientService,
  BrowserPluginConfig,
} from '../types.js';
import {
  createBrowserToolUnavailableError,
  createInvalidBrowserResponseError,
  createInvalidArgumentError,
} from '../errors.js';
import {
  MAX_PAGE_ID_LENGTH,
  MAX_REF_LENGTH,
  MAX_VALUE_LENGTH,
} from '../security.js';
import { resolveCallerScope } from '../scope.js';
import { enforceBrowserApproval } from '../approvals.js';

export const VALID_INTERACT_ACTIONS = Object.freeze<BrowserInteractAction[]>([
  'click',
  'fill',
  'press',
  'select',
]);

export function createBrowserInteractTool(
  getClient: () => BrowserPlatformClientService | undefined,
  config: BrowserPluginConfig = {},
  ctx?: Context
): ToolDefinition {
  return {
    name: 'browser_interact',
    description:
      'Perform an interactive action (click, fill, press, select) on a target element reference identified in a snapshot.',
    parameters: {
      type: 'object',
      properties: {
        pageId: {
          type: 'string',
          description: 'The target pageId.',
        },
        action: {
          type: 'string',
          enum: ['click', 'fill', 'press', 'select'],
          description: 'The interaction action to perform.',
        },
        ref: {
          type: 'string',
          description: 'The element reference from the snapshot (e.g. "@e1" or "e1").',
        },
        value: {
          type: 'string',
          description: 'Input value required for "fill" and "select" actions.',
        },
      },
      required: ['pageId', 'action', 'ref'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          pageId: { type: 'string' },
          action: {
            type: 'string',
            enum: ['click', 'fill', 'press', 'select'],
          },
          ref: { type: 'string' },
          url: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['success', 'pageId', 'action', 'ref'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: any) => [
        {
          type: 'text',
          text: `Performed ${value.action} on ${value.ref} (pageId: ${value.pageId})${value.message ? `: ${value.message}` : ''}`,
        },
      ],
    },
    async execute(
      args: any,
      execContext?: ToolRunContext
    ): Promise<BrowserInteractResult> {
      if (!args || typeof args !== 'object') {
        throw createInvalidArgumentError('browser_interact requires an arguments object');
      }

      const { pageId, action, ref, value } = args;

      if (typeof pageId !== 'string' || pageId.trim() === '') {
        throw createInvalidArgumentError('browser_interact requires a non-empty "pageId" string');
      }
      if (pageId.length > MAX_PAGE_ID_LENGTH) {
        throw createInvalidArgumentError(`pageId exceeds maximum allowed length of ${MAX_PAGE_ID_LENGTH}`);
      }

      if (!VALID_INTERACT_ACTIONS.includes(action)) {
        throw createInvalidArgumentError(
          `Invalid interaction action "${String(action)}". Valid actions are: ${VALID_INTERACT_ACTIONS.join(', ')}`
        );
      }

      if (typeof ref !== 'string' || ref.trim() === '') {
        throw createInvalidArgumentError('browser_interact requires a non-empty "ref" identifier (e.g. "@e1")');
      }
      if (ref.length > MAX_REF_LENGTH) {
        throw createInvalidArgumentError(`ref identifier exceeds maximum allowed length of ${MAX_REF_LENGTH}`);
      }

      // Action-specific validation
      if (action === 'fill' || action === 'select') {
        if (value === undefined || value === null || typeof value !== 'string') {
          throw createInvalidArgumentError(
            `Action "${action}" requires a "value" string property`
          );
        }
        if (value.length > MAX_VALUE_LENGTH) {
          throw createInvalidArgumentError(
            `Value exceeds maximum allowed length of ${MAX_VALUE_LENGTH} characters`
          );
        }
      }

      const scope = resolveCallerScope(execContext, ctx);

      // Enforce human approval for interaction mutations (side-effects)
      const actionDesc =
        action === 'fill' || action === 'select'
          ? `${action} "${value}" on ${ref}`
          : `${action} on ${ref}`;

      await enforceBrowserApproval({
        ctx,
        execContext,
        toolName: 'browser_interact',
        actionDescription: actionDesc,
        agent: scope.agent,
        forceApproval: true,
      });

      const client = getClient();
      if (!client || typeof client.request !== 'function') {
        throw createBrowserToolUnavailableError();
      }

      const timeoutMs = config.defaultTimeoutMs ?? 30_000;
      const res = await client.request<{
        success?: boolean;
        pageId?: string;
        action?: BrowserInteractAction;
        ref?: string;
        url?: string;
        message?: string;
      }>('/api/browser/interact', {
        method: 'POST',
        timeoutMs,
        signal: execContext?.signal,
        body: {
          pageId: pageId.trim(),
          action,
          ref: ref.trim(),
          ...(value !== undefined ? { value } : {}),
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
        throw createInvalidBrowserResponseError('Platform browser interact response is empty or invalid');
      }

      return {
        success: data.success !== false,
        pageId: String(data.pageId || pageId),
        action,
        ref: String(data.ref || ref),
        ...(typeof data.url === 'string' ? { url: data.url } : {}),
        ...(typeof data.message === 'string' ? { message: data.message } : {}),
      };
    },
  };
}
