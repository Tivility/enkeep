/**
 * WeChat iLink protocol types and parser models.
 *
 * @module @enkeep/channel-wechat/types
 */

export const WECHAT_MESSAGE_TYPE_USER = 1;
export const WECHAT_MESSAGE_TYPE_BOT = 2;

export const WECHAT_ITEM_TYPE_TEXT = 1;
export const WECHAT_ITEM_TYPE_IMAGE = 2;
export const WECHAT_ITEM_TYPE_VOICE = 3;
export const WECHAT_ITEM_TYPE_FILE = 4;
export const WECHAT_ITEM_TYPE_VIDEO = 5;

export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
}

export interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: { media?: CDNMedia; aeskey?: string; url?: string };
  voice_item?: { media?: CDNMedia; text?: string };
  file_item?: { media?: CDNMedia; file_name?: string; len?: string };
  video_item?: { media?: CDNMedia };
  ref_msg?: { message_item?: MessageItem; title?: string };
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

export interface WeChatGetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface WeChatParsedMessage {
  messageId: string;
  senderId: string;
  senderName: string;
  chatId: string;
  contextToken?: string;
  text: string;
  createTimeMs?: number;
  timestamp: string;
  dedupKey: string;
  isFromBot: boolean;
  mediaItems?: Array<{
    type: 'image' | 'voice' | 'file' | 'video';
    name?: string;
    encryptQueryParam?: string;
    aesKey?: string;
    transcribedText?: string;
  }>;
}

export type WeChatApiEnvelope = {
  ret?: unknown;
  errcode?: unknown;
  error_code?: unknown;
  errno?: unknown;
  code?: unknown;
  errmsg?: unknown;
  error_msg?: unknown;
  message?: unknown;
  base_resp?: { ret?: unknown; errcode?: unknown; errmsg?: unknown };
};

export interface WeChatOutboundReply {
  toUserId: string;
  contextToken: string;
  text: string;
  messageId: string;
  timestamp: string;
}

export interface WeChatTransport {
  readonly connected: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendReply(toUserId: string, contextToken: string, text: string): Promise<{ success: boolean; error?: string; messageId?: string }>;
}
