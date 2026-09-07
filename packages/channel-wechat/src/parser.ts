/**
 * Pure WeChat iLink message parser, validator, and cursor progression logic.
 *
 * @module @enkeep/channel-wechat/parser
 */

import {
  WECHAT_ITEM_TYPE_FILE,
  WECHAT_ITEM_TYPE_IMAGE,
  WECHAT_ITEM_TYPE_TEXT,
  WECHAT_ITEM_TYPE_VIDEO,
  WECHAT_ITEM_TYPE_VOICE,
  WECHAT_MESSAGE_TYPE_BOT,
  type MessageItem,
  type WeChatApiEnvelope,
  type WeChatParsedMessage,
  type WeixinMessage,
} from './types.js';

/**
 * Extract text content from message item_list.
 * Includes voice-to-text transcription and fallback labels for non-text items.
 */
export function extractTextContent(items: MessageItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.type === WECHAT_ITEM_TYPE_TEXT && item.text_item?.text) {
      parts.push(item.text_item.text);
    } else if (item.type === WECHAT_ITEM_TYPE_IMAGE) {
      if (!item.image_item?.media?.encrypt_query_param) {
        parts.push('(image)');
      }
    } else if (item.type === WECHAT_ITEM_TYPE_VOICE) {
      if (item.voice_item?.text) {
        parts.push(item.voice_item.text);
      } else {
        parts.push('(voice)');
      }
    } else if (item.type === WECHAT_ITEM_TYPE_FILE) {
      if (!item.file_item?.media?.encrypt_query_param) {
        parts.push(`(file: ${item.file_item?.file_name ?? 'unknown'})`);
      }
    } else if (item.type === WECHAT_ITEM_TYPE_VIDEO) {
      parts.push('(video)');
    }
  }
  return parts.join('\n').trim();
}

/**
 * Generate a unique deduplication key from a raw WeixinMessage.
 */
export function dedupKey(msg: WeixinMessage): string {
  if (msg.message_id !== undefined) return `mid:${msg.message_id}`;
  if (msg.seq !== undefined) return `seq:${msg.seq}`;
  return `fallback:${msg.from_user_id ?? 'unknown'}:${msg.create_time_ms ?? 0}:${msg.client_id ?? ''}`;
}

/**
 * Normalize an incoming raw WeixinMessage into a standard WeChatParsedMessage.
 * Returns null if the message lacks essential identifiers or is a bot self-echo.
 */
export function parseWeixinMessage(msg: WeixinMessage): WeChatParsedMessage | null {
  const fromUserId = msg.from_user_id;
  if (!fromUserId) return null;

  const isFromBot = msg.message_type === WECHAT_MESSAGE_TYPE_BOT;
  const items = msg.item_list ?? [];
  const text = extractTextContent(items);
  const senderName = fromUserId.split('@')[0] || 'WeChat用户';
  const chatId = `wechat:${fromUserId}`;
  const messageId = msg.message_id !== undefined ? String(msg.message_id) : String(msg.seq ?? Date.now());
  const nowIso = msg.create_time_ms ? new Date(msg.create_time_ms).toISOString() : new Date().toISOString();

  const mediaItems: WeChatParsedMessage['mediaItems'] = [];
  for (const item of items) {
    if (item.type === WECHAT_ITEM_TYPE_IMAGE && item.image_item) {
      mediaItems.push({
        type: 'image',
        encryptQueryParam: item.image_item.media?.encrypt_query_param,
        aesKey: item.image_item.aeskey,
      });
    } else if (item.type === WECHAT_ITEM_TYPE_VOICE && item.voice_item) {
      mediaItems.push({
        type: 'voice',
        encryptQueryParam: item.voice_item.media?.encrypt_query_param,
        aesKey: item.voice_item.media?.aes_key,
        transcribedText: item.voice_item.text,
      });
    } else if (item.type === WECHAT_ITEM_TYPE_FILE && item.file_item) {
      mediaItems.push({
        type: 'file',
        name: item.file_item.file_name,
        encryptQueryParam: item.file_item.media?.encrypt_query_param,
        aesKey: item.file_item.media?.aes_key,
      });
    } else if (item.type === WECHAT_ITEM_TYPE_VIDEO && item.video_item) {
      mediaItems.push({
        type: 'video',
        encryptQueryParam: item.video_item.media?.encrypt_query_param,
        aesKey: item.video_item.media?.aes_key,
      });
    }
  }

  return {
    messageId,
    senderId: fromUserId,
    senderName,
    chatId,
    contextToken: msg.context_token,
    text,
    createTimeMs: msg.create_time_ms,
    timestamp: nowIso,
    dedupKey: dedupKey(msg),
    isFromBot,
    mediaItems: mediaItems.length > 0 ? mediaItems : undefined,
  };
}

function nonZeroApiCode(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric !== 0 : true;
}

/**
 * Reject transport-success responses that encode a WeChat API failure.
 */
export function assertWeChatApiSuccess(
  response: WeChatApiEnvelope,
  operation: string
): void {
  const codes: Array<[string, unknown]> = [
    ['ret', response.ret],
    ['errcode', response.errcode],
    ['error_code', response.error_code],
    ['errno', response.errno],
    ['code', response.code],
    ['base_resp.ret', response.base_resp?.ret],
    ['base_resp.errcode', response.base_resp?.errcode],
  ];
  const failure = codes.find(([, value]) => nonZeroApiCode(value));
  if (!failure) return;
  const message =
    response.errmsg ??
    response.error_msg ??
    response.message ??
    response.base_resp?.errmsg ??
    '';
  throw new Error(
    `${operation} failed: ${failure[0]}=${String(failure[1])}${message ? ` message=${String(message)}` : ''}`
  );
}

/**
 * Process one long-poll batch before acknowledging its cursor. If processing
 * or persistence fails, the caller keeps the previous cursor so the batch is
 * replayed after retry/restart instead of being acknowledged early.
 */
export async function processWeChatUpdateBatch<T>(input: {
  messages?: T[];
  nextCursor?: string;
  currentCursor: string;
  processMessage: (message: T) => Promise<void>;
  persistCursor?: (cursor: string) => void | Promise<void>;
}): Promise<string> {
  for (const message of input.messages ?? []) {
    await input.processMessage(message);
  }
  if (!input.nextCursor || input.nextCursor === input.currentCursor) {
    return input.currentCursor;
  }
  await input.persistCursor?.(input.nextCursor);
  return input.nextCursor;
}
