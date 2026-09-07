import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type {
  ToolDefinition,
  PlatformClientService,
  SendMessageResult,
  ToolExecutionContext,
  ToolResult,
} from '../types.js';
import {
  createPlatformToolUnavailableError,
  createInvalidPlatformResponseError,
} from '../errors.js';

export interface SendPlatformMessageArgs {
  recipient: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export type SendMessageArgs = SendPlatformMessageArgs;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSendMessageResult(value: unknown): value is SendMessageResult {
  return (
    isRecord(value) &&
    typeof value.success === 'boolean' &&
    typeof value.messageId === 'string' &&
    typeof value.recipient === 'string' &&
    typeof value.timestamp === 'string'
  );
}

export function createSendPlatformMessageTool(
  getClient: () => PlatformClientService | undefined
): ToolDefinition {
  return {
    name: 'send_platform_message',
    description:
      'Send a text message or notification to an external recipient or channel via the Enkeep platform.',
    parameters: {
      type: 'object',
      properties: {
        recipient: {
          type: 'string',
          description: 'Recipient user ID, channel ID, or destination target.',
        },
        content: {
          type: 'string',
          description: 'Text content of the message to send.',
        },
        metadata: {
          type: 'object',
          description: 'Optional structured metadata associated with the message.',
        },
      },
      required: ['recipient', 'content'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          messageId: { type: 'string' },
          recipient: { type: 'string' },
          timestamp: { type: 'string' },
        },
        required: ['success', 'messageId', 'recipient', 'timestamp'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: JsonValue): ContentBlock[] => {
        if (isSendMessageResult(value)) {
          return [
            {
              type: 'text',
              text: `Message sent to ${value.recipient} (ID: ${value.messageId}) at ${value.timestamp}`,
            },
          ];
        }
        return [{ type: 'text', text: 'Message sent' }];
      },
    },
    async execute(
      rawArgs: unknown,
      _context?: ToolExecutionContext
    ): Promise<SendMessageResult> {
      if (!isRecord(rawArgs) || typeof rawArgs.recipient !== 'string' || rawArgs.recipient.length === 0) {
        throw new TypeError('send_platform_message requires a non-empty recipient string');
      }
      if (typeof rawArgs.content !== 'string' || rawArgs.content.length === 0) {
        throw new TypeError('send_platform_message requires a non-empty content string');
      }

      const args: SendPlatformMessageArgs = {
        recipient: rawArgs.recipient,
        content: rawArgs.content,
        ...(isRecord(rawArgs.metadata) ? { metadata: rawArgs.metadata } : {}),
      };

      const client = getClient();
      if (!client || !client.request) {
        throw createPlatformToolUnavailableError(
          'Enkeep Platform Client service is not available'
        );
      }

      const res = await client.request<{
        success?: boolean;
        messageId?: string;
        id?: string;
        timestamp?: string;
        createdAt?: string;
        recipient?: string;
      }>('/api/messages', {
        method: 'POST',
        body: {
          recipient: args.recipient,
          content: args.content,
          ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
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

      const messageId = data.messageId ?? data.id;
      if (!messageId || typeof messageId !== 'string' || messageId.length === 0) {
        throw createInvalidPlatformResponseError(
          'Platform request response is missing authoritative messageId'
        );
      }

      const timestamp = data.timestamp ?? data.createdAt;
      if (!timestamp || typeof timestamp !== 'string' || timestamp.length === 0) {
        throw createInvalidPlatformResponseError(
          'Platform request response is missing authoritative timestamp'
        );
      }

      return {
        success: true,
        messageId,
        recipient: data.recipient || args.recipient,
        timestamp,
      };
    },
    presentCall: (rawArgs: unknown) => ({
      card: 'generic',
      title: isRecord(rawArgs) && typeof rawArgs.recipient === 'string'
        ? `Send platform message to ${rawArgs.recipient}`
        : 'Send platform message',
    }),
    presentResult: (_args: unknown, result: ToolResult) => ({
      card: 'generic',
      title: !result.isError
        ? 'Sent platform message'
        : 'Failed to send platform message',
    }),
  };
}

export const createSendMessageTool = createSendPlatformMessageTool;
