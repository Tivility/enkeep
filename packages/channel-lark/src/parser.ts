/**
 * Lark message parser & mention extractor.
 * Distilled minimal parser from Botmux (commit d9a977) and HappyClaw.
 *
 * @module @enkeep/channel-lark/parser
 */

import type {
  LarkEventMessage,
  LarkEventSender,
  LarkMention,
  LarkMessageResource,
  LarkParsedCardAction,
  LarkParsedMessage,
  LarkRestMessageItem,
  LarkRawEvent,
  LarkRawMention,
  MentionIdentity,
} from './types.js';

export function mentionOpenId(
  m: { id?: { open_id?: string; app_id?: string } | string | null; id_type?: string } | null | undefined
): string | undefined {
  const id = m?.id;
  if (id == null) return undefined;
  if (typeof id === 'object') return id.open_id || undefined;
  if (typeof id === 'string') {
    if (m?.id_type && m.id_type !== 'open_id') return undefined;
    return id || undefined;
  }
  return undefined;
}

export function mentionUnionId(
  m: { id?: { union_id?: string } | string | null; id_type?: string } | null | undefined
): string | undefined {
  const id = m?.id;
  if (id == null) return undefined;
  if (typeof id === 'object') return id.union_id || undefined;
  if (typeof id === 'string') {
    if (m?.id_type !== 'union_id') return undefined;
    return id || undefined;
  }
  return undefined;
}

export function mentionAppId(m: any): string | undefined {
  if (!m || typeof m !== 'object') return undefined;
  if (typeof m.appId === 'string') return m.appId;
  if (typeof m.app_id === 'string') return m.app_id;
  const idType = m.id_type ?? m.idType;
  if (idType === 'app_id' && typeof m.id === 'string') return m.id;
  if (m.id && typeof m.id === 'object' && typeof m.id.app_id === 'string') return m.id.app_id;
  return undefined;
}

export function mentionIdentity(m: LarkRawMention | null | undefined): MentionIdentity {
  const id = m?.id;
  const out: MentionIdentity = {
    key: m?.key,
    name: m?.name,
    idType: m?.id_type,
  };
  if (id && typeof id === 'object') {
    out.openId = id.open_id || undefined;
    out.userId = id.user_id || undefined;
    out.unionId = id.union_id || undefined;
    out.appId = id.app_id || undefined;
    return out;
  }
  if (typeof id === 'string' && id) {
    if (!m?.id_type || m.id_type === 'open_id') out.openId = id;
    else if (m.id_type === 'user_id') out.userId = id;
    else if (m.id_type === 'union_id') out.unionId = id;
    else if (m.id_type === 'app_id') out.appId = id;
  }
  return out;
}

export function extractPostAtParticipants(contentStr?: string | null): LarkMention[] {
  const out: LarkMention[] = [];
  if (!contentStr) return out;
  let parsed: any;
  try {
    parsed = JSON.parse(contentStr);
  } catch {
    return out;
  }
  const inner = parsed?.zh_cn ?? parsed?.en_us ?? parsed;
  if (!Array.isArray(inner?.content)) return out;
  let seq = 0;
  for (const para of inner.content) {
    if (!Array.isArray(para)) continue;
    for (const node of para) {
      if (node?.tag === 'at') {
        const uid: string | undefined = typeof node.user_id === 'string' ? node.user_id : undefined;
        const name: string | undefined = typeof node.user_name === 'string' ? node.user_name : undefined;
        const isOpenId = !!uid && uid.startsWith('ou_');
        const isAppId = !!uid && uid.startsWith('cli_');
        out.push({
          key: `@_post_at_${seq}`,
          name: name ?? uid ?? '',
          ...(isOpenId ? { openId: uid } : {}),
          ...(isAppId ? { appId: uid } : {}),
          idType: isAppId ? 'app_id' : 'open_id',
        });
      }
      seq++;
    }
  }
  return out;
}

export function messageMentionsBot(
  message: { mentions?: LarkRawMention[]; content?: string } | null | undefined,
  botAppId?: string,
  botOpenId?: string
): boolean {
  if (!botAppId && !botOpenId) return false;
  const mentions = message?.mentions ?? [];
  for (const m of mentions) {
    if (botOpenId && mentionOpenId(m) === botOpenId) return true;
    if (botAppId && mentionAppId(m) === botAppId) return true;
  }

  // Check inline at-tags in post content
  if (botOpenId || botAppId) {
    try {
      const parsed = JSON.parse(message?.content ?? '{}');
      const inner = parsed.zh_cn ?? parsed.en_us ?? parsed;
      if (Array.isArray(inner?.content)) {
        for (const paragraph of inner.content) {
          if (!Array.isArray(paragraph)) continue;
          for (const node of paragraph) {
            if (node?.tag === 'at') {
              if (botOpenId && node.user_id === botOpenId) return true;
              if (botAppId && node.user_id === botAppId) return true;
            }
          }
        }
      }
    } catch {
      // Ignore non-JSON content
    }
  }
  return false;
}

export function stripBotMentions(
  text: string,
  mentions?: Array<{
    key?: string;
    name?: string;
    openId?: string;
    id?: any;
    id_type?: string;
  }>,
  botOpenId?: string
): string {
  if (!text) return '';

  let result = text;

  // Identify which mentions in the array belong to the bot
  const botMentions: Array<{ key?: string; name?: string }> = [];
  if (mentions && mentions.length > 0) {
    for (const m of mentions) {
      const openId = m.openId ?? mentionOpenId(m as any);
      const isBot = botOpenId ? openId === botOpenId : true;
      if (isBot) {
        botMentions.push({ key: m.key, name: m.name });
      }
    }
  }

  // 1. Strip raw Feishu placeholder form (@_user_1 keys) for bot mentions
  for (const bm of botMentions) {
    if (bm.key) {
      result = result.replaceAll(bm.key, ' ');
    }
  }

  // 2. Strip resolved form (@<name>) for bot mentions
  const names = botMentions
    .map((bm) => bm.name?.trim())
    .filter((n): n is string => Boolean(n))
    .sort((a, b) => b.length - a.length);

  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?<![A-Za-z0-9_])@${escaped}(?![\\p{L}\\p{N}_])`, 'gu');
    result = result.replace(pattern, ' ');
    if (result.includes(`@${name}`)) {
      result = result.replaceAll(`@${name}`, ' ');
    }
  }

  // 3. Fallback when mentions array was not provided or empty and botOpenId is unknown
  if ((!mentions || mentions.length === 0) && !botOpenId) {
    result = result.replace(/(?<![A-Za-z0-9_])@\S+/g, ' ');
  }

  // 4. Collapse duplicate whitespace and trim
  return result.replace(/\s+/g, ' ').trim();
}

export function stripLeadingMentions(content: string, mentions?: Array<{ name: string }>): string {
  let s = content.trimStart();
  if (mentions && mentions.length > 0) {
    const sortedMentions = [...mentions].sort((a, b) => b.name.length - a.name.length);
    let changed = true;
    while (changed) {
      changed = false;
      for (const m of sortedMentions) {
        if (!m.name) continue;
        const tag = `@${m.name}`;
        if (s.startsWith(tag)) {
          s = s.slice(tag.length).trimStart();
          changed = true;
          break;
        }
      }
    }
    return s;
  }

  let changed = true;
  while (changed) {
    changed = false;
    const m = s.match(/^@\S+/);
    if (m) {
      s = s.slice(m[0].length).trimStart();
      changed = true;
    }
  }
  return s;
}

function resolvePostText(parsed: any): string {
  const inner = parsed?.zh_cn ?? parsed?.en_us ?? parsed;
  const title = typeof inner?.title === 'string' ? inner.title : '';
  const contentBlocks = Array.isArray(inner?.content) ? inner.content : [];
  const lines: string[] = [];

  for (const block of contentBlocks) {
    if (!Array.isArray(block)) continue;
    const blockText = block
      .map((node: any) => {
        if (node?.tag === 'text') return node.text ?? '';
        if (node?.tag === 'a') return node.text ?? node.href ?? '';
        if (node?.tag === 'at') return `@${node.user_name ?? node.user_id ?? 'user'}`;
        if (node?.tag === 'code_block') return `\n\`\`\`\n${node.text ?? node.content ?? ''}\n\`\`\`\n`;
        if (node?.tag === 'img' || node?.tag === 'media') return '[图片]';
        if (node?.tag === 'file') return `[文件: ${node.file_name ?? 'file'}]`;
        return '';
      })
      .join('');
    if (blockText.trim()) {
      lines.push(blockText);
    }
  }

  const body = lines.join('\n');
  return title ? `${title}\n${body}` : body;
}

export function sanitizeClaimedFileName(raw: string): string | undefined {
  // Strip ANSI escape codes, control chars, null bytes, normalize NFC
  let cleaned = raw
    .normalize('NFC')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .trim();
  // Strip path traversal or separators (/ and \)
  cleaned = cleaned.replace(/.*[/\\]/, '');
  if (cleaned === '.' || cleaned === '..' || cleaned.length === 0) {
    return undefined;
  }
  if (cleaned.length > 255) {
    cleaned = cleaned.slice(0, 255);
  }
  return cleaned;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function sliceFeishuText(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  let end = Math.max(0, maxUnits);
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end--;
  return text.slice(0, end);
}

function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function truncationMarker(droppedChars: number): string {
  return `\n[…卡片内容已截断 ${droppedChars} 字符]`;
}

function plainText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!value || typeof value !== 'object') return undefined;
  const object = value as Record<string, unknown>;
  for (const key of ['content', 'text', 'title', 'plain_text']) {
    const nested = object[key];
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  return undefined;
}

export interface InteractiveCardLimits {
  maxCardNodes?: number;
  maxTextChars?: number;
  maxImageKeys?: number;
}

export const DEFAULT_INTERACTIVE_CARD_LIMITS: Required<InteractiveCardLimits> = {
  maxCardNodes: 500,
  maxTextChars: 20_000,
  maxImageKeys: 10,
};

export function extractInteractiveCardContent(
  rawContent: string,
  limits: InteractiveCardLimits = DEFAULT_INTERACTIVE_CARD_LIMITS
): { text: string; imageKeys: string[] } {
  const maxCardNodes = limits.maxCardNodes ?? DEFAULT_INTERACTIVE_CARD_LIMITS.maxCardNodes;
  const maxTextChars = limits.maxTextChars ?? DEFAULT_INTERACTIVE_CARD_LIMITS.maxTextChars;
  const maxImageKeys = limits.maxImageKeys ?? DEFAULT_INTERACTIVE_CARD_LIMITS.maxImageKeys;

  let root: any;
  try {
    root = JSON.parse(rawContent);
  } catch {
    return { text: typeof rawContent === 'string' && rawContent.trim() ? rawContent.trim() : '[飞书卡片消息]', imageKeys: [] };
  }

  if (typeof root === 'string') {
    return { text: root.trim() || '[飞书卡片消息]', imageKeys: [] };
  }
  if (!root || typeof root !== 'object') {
    return { text: '[飞书卡片消息]', imageKeys: [] };
  }

  const lines: string[] = [];
  const imageKeys: string[] = [];
  const seenObjects = new Set<object>();
  let visited = 0;
  let textChars = 0;
  let droppedChars = 0;

  const addLine = (value?: string) => {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    if (!normalized || lines[lines.length - 1] === normalized) return;
    if (textChars >= maxTextChars) {
      droppedChars += codePointLength(normalized);
      return;
    }
    const remaining = maxTextChars - textChars;
    const clipped = sliceFeishuText(normalized, remaining);
    if (clipped.length < normalized.length) {
      droppedChars += codePointLength(normalized.slice(clipped.length));
    }
    if (lines[lines.length - 1] !== clipped) {
      lines.push(clipped);
      textChars += clipped.length + 1;
    }
  };

  const visit = (node: unknown, depth: number) => {
    if (node === null || node === undefined) return;
    if (depth > 12 || visited >= maxCardNodes || textChars >= maxTextChars) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    if (seenObjects.has(node)) return;
    seenObjects.add(node);
    visited++;

    const object = node as Record<string, unknown>;
    const imgKey =
      typeof object.image_key === 'string'
        ? object.image_key
        : typeof object.img_key === 'string'
          ? object.img_key
          : undefined;
    if (imgKey && !imageKeys.includes(imgKey)) {
      if (imageKeys.length < maxImageKeys) {
        imageKeys.push(imgKey);
        addLine('[图片]');
      }
    }

    const tag = typeof object.tag === 'string' ? object.tag : undefined;
    const label = plainText(object.text) ?? plainText(object.title);
    const href =
      typeof object.href === 'string'
        ? object.href
        : typeof object.url === 'string'
          ? object.url
          : typeof (object.multi_url as any)?.url === 'string'
            ? (object.multi_url as any).url
            : undefined;

    if (tag === 'button' && label) {
      addLine(`[按钮: ${label}]`);
    } else if (tag === 'a' && label) {
      addLine(href ? `[${label}](${href})` : label);
    } else {
      for (const key of ['title', 'text', 'content', 'plain_text']) {
        const val = object[key];
        if (typeof val === 'string' && tag !== 'img') addLine(val);
      }
    }

    for (const val of Object.values(object)) {
      if (val && typeof val === 'object') visit(val, depth + 1);
    }
  };

  visit(root, 0);

  let text = lines.join('\n').trim();
  if (droppedChars > 0) {
    const marker = truncationMarker(droppedChars);
    text = `${sliceFeishuText(text, Math.max(0, maxTextChars - marker.length))}${marker}`;
  }

  return {
    text: text || '[飞书卡片消息]',
    imageKeys,
  };
}

export function formatForwardMessageTime(createTime?: string | number): string {
  if (!createTime) return '';
  const num = typeof createTime === 'string' ? Number(createTime) : createTime;
  if (!Number.isFinite(num) || num <= 0) return '';
  // Lark create_time is epoch in milliseconds (13 digits) or seconds (10 digits)
  const ms = num < 100_000_000_000 ? num * 1000 : num;
  const date = new Date(ms);
  if (isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const mins = pad(date.getMinutes());
  return `${month}-${day} ${hours}:${mins}`;
}

export function expandMergeForwardContent(
  items: any[],
  parentMessageId?: string,
  limits: { maxForwardItems?: number } = {}
): { text: string; resources: LarkMessageResource[] } {
  const maxItems = limits.maxForwardItems ?? 20;
  const resources: LarkMessageResource[] = [];

  if (!Array.isArray(items) || items.length === 0) {
    return { text: '[合并转发消息]', resources };
  }

  // Filter items:
  // 1. Skip items whose msg_type === 'merge_forward' (e.g. parent message itself in im.v1.message.get)
  // 2. If any item has upper_message_id, only keep items whose upper_message_id === parentMessageId
  let candidates = items.filter((item) => (item.msg_type || item.message_type) !== 'merge_forward');
  if (candidates.some((item) => Boolean(item.upper_message_id))) {
    candidates = candidates.filter((item) => item.upper_message_id === parentMessageId);
  }

  if (candidates.length === 0) {
    return { text: '[合并转发消息]', resources };
  }

  const bounded = candidates.slice(0, maxItems);
  const lines: string[] = ['[合并转发]'];

  for (const item of bounded) {
    const rawSender =
      typeof item.sender?.name === 'string'
        ? item.sender.name.trim()
        : typeof item.sender_name === 'string'
          ? item.sender_name.trim()
          : '';
    const sender = rawSender;
    const senderPart = sender ? `${sender} ` : '';

    const timeRaw = item.create_time ?? item.createTime ?? item.timestamp;
    const timeFormatted = formatForwardMessageTime(timeRaw);
    const timePart = timeFormatted ? `${timeFormatted}: ` : (senderPart ? ': ' : '');

    const header = senderPart || timePart ? `${senderPart}${timePart}`.trim() : '';

    let subType = item.msg_type || item.message_type || 'text';
    let subContent = item.body?.content ?? item.content ?? '';

    // If item is deleted
    if (item.deleted) {
      lines.push(header ? `${header} [已撤回]` : '[已撤回]');
      continue;
    }

    const subParsed = extractTextAndResources(subType, subContent);
    // Sub-message images: use parent messageId if provided, else keep sub-message id
    const imageOwnerMessageId = parentMessageId || item.message_id || item.messageId;
    for (const res of subParsed.resources) {
      if (res.type === 'image') {
        resources.push({
          ...res,
          ...(imageOwnerMessageId ? { messageId: imageOwnerMessageId } : {}),
        });
      }
    }

    const contentText = subParsed.text.trim() || '[空消息]';
    lines.push(header ? `${header} ${contentText}` : contentText);
  }

  if (candidates.length > maxItems) {
    lines.push(`> ...（共 ${candidates.length} 条，仅展示前 ${maxItems} 条）`);
  }

  return { text: lines.join('\n'), resources };
}

export function extractTextAndResources(
  msgType: string,
  rawContent: string,
  mentions?: LarkRawMention[]
): { text: string; resources: LarkMessageResource[] } {
  const resources: LarkMessageResource[] = [];

  try {
    if (msgType === 'text') {
      const parsed = JSON.parse(rawContent);
      let text = typeof parsed.text === 'string' ? parsed.text : rawContent;
      if (mentions && mentions.length > 0) {
        for (const m of mentions) {
          if (m.key && m.name) {
            // Fix: replace all occurrences of mention key, not just the first one
            text = text.replaceAll(m.key, `@${m.name}`);
          }
        }
      }
      return { text: text.trim(), resources };
    }

    if (msgType === 'post') {
      const parsed = JSON.parse(rawContent);
      const text = resolvePostText(parsed);
      // Extract post resources (retaining metadata but explicit that raw content download is unsupported)
      const inner = parsed?.zh_cn ?? parsed?.en_us ?? parsed;
      if (Array.isArray(inner?.content)) {
        for (const block of inner.content) {
          if (!Array.isArray(block)) continue;
          for (const node of block) {
            if (node?.tag === 'img' && node.image_key) {
              resources.push({
                type: 'image',
                key: node.image_key,
                name: `${node.image_key}.jpg`,
              });
            } else if (node?.tag === 'file' && node.file_key) {
              resources.push({
                type: 'file',
                key: node.file_key,
                name: node.file_name ?? node.file_key,
                unsupported: true,
              });
            }
          }
        }
      }
      return { text, resources };
    }

    if (msgType === 'image') {
      const parsed = JSON.parse(rawContent);
      if (parsed.image_key) {
        resources.push({
          type: 'image',
          key: parsed.image_key,
          name: `${parsed.image_key}.jpg`,
        });
      }
      return { text: '[图片]', resources };
    }

    if (msgType === 'file') {
      const parsed = JSON.parse(rawContent);
      if (parsed.file_key) {
        const rawName = typeof parsed.file_name === 'string' ? parsed.file_name : undefined;
        const sanitizedName = rawName ? sanitizeClaimedFileName(rawName) : undefined;
        const displayName = sanitizedName || parsed.file_key;
        const rawSize =
          typeof parsed.file_size === 'number' && parsed.file_size > 0
            ? parsed.file_size
            : (typeof parsed.size === 'number' && parsed.size > 0 ? parsed.size : undefined);
        resources.push({
          type: 'file',
          key: parsed.file_key,
          name: displayName,
          ...(rawSize !== undefined ? { size: rawSize } : {}),
        });
        return { text: `[文件: ${displayName}]`, resources };
      }
      return { text: '[文件]', resources };
    }

    if (msgType === 'interactive') {
      const cardResult = extractInteractiveCardContent(rawContent);
      for (const imgKey of cardResult.imageKeys) {
        resources.push({
          type: 'image',
          key: imgKey,
          name: `${imgKey}.jpg`,
        });
      }
      return { text: cardResult.text, resources };
    }

    if (msgType === 'merge_forward') {
      try {
        const parsed = JSON.parse(rawContent);
        const items = parsed.items || parsed.message_list || [];
        if (Array.isArray(items) && items.length > 0) {
          return expandMergeForwardContent(items);
        }
      } catch {}
      return { text: '[合并转发消息]', resources };
    }

    if (msgType === 'audio') {
      let durationStr = '';
      try {
        const parsed = JSON.parse(rawContent);
        if (typeof parsed.duration === 'number' && parsed.duration > 0) {
          durationStr = `: ${Math.round(parsed.duration / 1000)}s`;
        }
      } catch {}
      return { text: `[语音消息${durationStr}]`, resources };
    }

    if (msgType === 'media') {
      let fileName = '';
      let fileKey = '';
      try {
        const parsed = JSON.parse(rawContent);
        if (typeof parsed.file_key === 'string' && parsed.file_key) {
          fileKey = parsed.file_key;
        }
        if (typeof parsed.file_name === 'string' && parsed.file_name) {
          fileName = sanitizeClaimedFileName(parsed.file_name) || '';
        }
        const displayName = fileName || (fileKey ? `${fileKey}.mp4` : 'video.mp4');
        if (fileKey) {
          resources.push({
            type: 'file',
            key: fileKey,
            name: displayName,
          });
        }
      } catch {}
      return { text: fileName ? `[视频: ${fileName}]` : '[视频消息]', resources };
    }

    if (msgType === 'sticker') {
      let desc = '';
      try {
        const parsed = JSON.parse(rawContent);
        desc = parsed.description || parsed.sticker_id || '';
      } catch {}
      return { text: desc ? `[表情包: ${desc}]` : '[表情包]', resources };
    }

    if (msgType === 'share_chat') {
      let name = '';
      try {
        const parsed = JSON.parse(rawContent);
        name = parsed.chat_name || parsed.chat_id || '';
      } catch {}
      return { text: name ? `[分享群聊: ${name}]` : '[分享群聊]', resources };
    }

    if (msgType === 'share_user') {
      let name = '';
      try {
        const parsed = JSON.parse(rawContent);
        name = parsed.user_name || parsed.user_id || '';
      } catch {}
      return { text: name ? `[分享名片: ${name}]` : '[分享名片]', resources };
    }

    if (msgType === 'location') {
      let locText = '';
      try {
        const parsed = JSON.parse(rawContent);
        const name = parsed.name || '';
        const addr = parsed.address || '';
        if (name && addr && name !== addr) {
          locText = `${name} - ${addr}`;
        } else {
          locText = name || addr || '';
        }
      } catch {}
      return { text: locText ? `[位置: ${locText}]` : '[位置]', resources };
    }

    if (msgType === 'system') {
      let sysText = '';
      try {
        const parsed = JSON.parse(rawContent);
        const body = parsed.body || parsed.content || parsed.template || '';
        sysText = typeof body === 'string' ? body : JSON.stringify(body);
        if (sysText.length > 200) {
          sysText = sysText.slice(0, 200);
        }
      } catch {
        sysText = typeof rawContent === 'string' ? rawContent.slice(0, 200) : '';
      }
      return { text: sysText ? `[系统消息: ${sysText}]` : '[系统消息]', resources };
    }

    return { text: rawContent, resources };
  } catch {
    return { text: rawContent, resources };
  }
}

/**
 * Builds the canonical nativeContextId from chatId and optional threadId / rootId.
 * Standard format:
 * - If threadId / rootId present: `${chatId}:${threadId || rootId}`
 * - Otherwise: `${chatId}`
 */
export function buildNativeContextId(chatId: string, threadId?: string, rootId?: string): string {
  const thread = threadId || rootId;
  if (thread && thread.trim()) {
    return `${chatId.trim()}:${thread.trim()}`;
  }
  return chatId.trim();
}

/**
 * Extract nativeEventId and sender from raw Lark event.
 * Filters out non-message events (only im.message.receive_v1 allowed).
 */
export function parseLarkEvent(rawEvent: LarkRawEvent): LarkParsedMessage | null {
  // If event header or flattened event has event_type, strictly filter for im.message.receive_v1
  const eventType = rawEvent.header?.event_type ?? (rawEvent as any).event_type;
  if (eventType && eventType !== 'im.message.receive_v1') {
    return null;
  }

  const sender = rawEvent.event?.sender ?? rawEvent.sender;
  const message = rawEvent.event?.message ?? rawEvent.message;

  if (!message || !message.message_id || !message.chat_id) {
    return null;
  }

  const { text, resources } = extractTextAndResources(
    message.message_type ?? 'text',
    message.content ?? '',
    message.mentions
  );

  const mentions: LarkMention[] = [];
  if (message.mentions && message.mentions.length > 0) {
    for (const m of message.mentions) {
      mentions.push({
        key: m.key,
        name: m.name,
        openId: mentionOpenId(m),
        userId: mentionIdentity(m).userId,
        unionId: mentionUnionId(m),
        appId: mentionAppId(m),
        idType: m.id_type,
      });
    }
  }

  // Also include inline at participants from post content if any
  const postAts = extractPostAtParticipants(message.content);
  for (const pa of postAts) {
    if (!mentions.some((m) => (m.openId && m.openId === pa.openId) || (m.appId && m.appId === pa.appId))) {
      mentions.push(pa);
    }
  }

  const parsed: LarkParsedMessage = {
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType: message.chat_type ?? 'group',
    rootId: message.root_id || undefined,
    threadId: message.thread_id || undefined,
    parentId: message.parent_id || undefined,
    senderId: sender?.sender_id?.open_id ?? '',
    senderUnionId: sender?.sender_id?.union_id,
    senderType: sender?.sender_type ?? 'user',
    msgType: message.message_type ?? 'text',
    text,
    createTime: message.create_time ?? new Date().toISOString(),
    mentions: mentions.length > 0 ? mentions : undefined,
    resources: resources.length > 0 ? resources : undefined,
  };

  return parsed;
}

/**
 * Checks whether the raw Lark event represents a card action callback.
 */
export function isCardActionEvent(rawEvent: LarkRawEvent | null | undefined): boolean {
  if (!rawEvent) return false;
  const eventType = rawEvent.header?.event_type ?? (rawEvent as any).event_type;
  if (eventType === 'card.action.trigger') return true;
  if (rawEvent.action || (rawEvent.event as any)?.action) return true;
  return false;
}

/**
 * Parses a Lark `card.action.trigger` callback event into a normalized LarkParsedCardAction object.
 * Extracts operator identification, action metadata (action name, turnId, sessionId), and context messageId.
 */
export function parseLarkCardAction(rawEvent: LarkRawEvent | null | undefined): LarkParsedCardAction | null {
  if (!rawEvent) return null;

  const isAction = isCardActionEvent(rawEvent);
  if (!isAction) {
    return null;
  }

  const rawAction = rawEvent.action ?? (rawEvent.event as any)?.action ?? {};
  const rawContext = rawEvent.context ?? (rawEvent.event as any)?.context ?? {};
  const rawOperator = rawEvent.operator ?? (rawEvent.event as any)?.operator ?? {};

  const actionValue =
    typeof rawAction.value === 'object' && rawAction.value !== null
      ? rawAction.value
      : typeof rawAction.value === 'string'
        ? (() => {
            try {
              return JSON.parse(rawAction.value);
            } catch {
              return {};
            }
          })()
        : {};

  const actionType =
    actionValue.action ??
    actionValue.action_type ??
    rawAction.tag ??
    rawAction.option ??
    'unknown';

  const turnId =
    typeof actionValue.turnId === 'string'
      ? actionValue.turnId
      : typeof actionValue.turn_id === 'string'
        ? actionValue.turn_id
        : undefined;

  const sessionId =
    typeof actionValue.sessionId === 'string'
      ? actionValue.sessionId
      : typeof actionValue.session_id === 'string'
        ? actionValue.session_id
        : undefined;

  const messageId =
    rawContext.open_message_id ??
    rawEvent.open_message_id ??
    (rawEvent as any).message_id ??
    actionValue.messageId ??
    actionValue.message_id ??
    '';

  const chatId =
    rawContext.open_chat_id ??
    rawEvent.open_chat_id ??
    (rawEvent as any).chat_id ??
    actionValue.chatId ??
    actionValue.chat_id ??
    undefined;

  const operatorId =
    rawOperator.open_id ??
    rawOperator.operator_id?.open_id ??
    rawEvent.open_id ??
    (rawEvent.sender as any)?.sender_id?.open_id ??
    '';

  const operatorUserId =
    rawOperator.user_id ??
    rawOperator.operator_id?.user_id ??
    (rawEvent.sender as any)?.sender_id?.user_id ??
    undefined;

  const operatorUnionId =
    rawOperator.union_id ??
    rawOperator.operator_id?.union_id ??
    (rawEvent.sender as any)?.sender_id?.union_id ??
    undefined;

  return {
    eventType: 'card.action.trigger',
    actionType,
    actionValue,
    turnId,
    sessionId,
    messageId,
    chatId,
    operatorId,
    operatorUserId,
    operatorUnionId,
  };
}

/**
 * Normalizes a REST message from OpenAPI im.v1.message.list into LarkParsedMessage.
 * Align mentions, sender and resources with the EventDispatcher im.message.receive_v1 format.
 */
export function normalizeRestMessageToParsed(
  item: LarkRestMessageItem,
  context: { chatType: 'p2p' | 'group'; botOpenId?: string; botAppId?: string }
): LarkParsedMessage | null {
  if (!item || !item.message_id || item.deleted) {
    return null;
  }
  // Bot's own messages must not be ingested as inbound user messages
  if (item.sender?.sender_type === 'app') {
    return null;
  }
  if (context.botOpenId && item.sender?.id === context.botOpenId) {
    return null;
  }
  if (context.botAppId && item.sender?.id === context.botAppId) {
    return null;
  }

  const rawMentions: LarkRawMention[] = (item.mentions || []).map((m) => ({
    key: m.key,
    name: m.name,
    id_type: m.id_type,
    id: m.id_type === 'open_id' ? { open_id: m.id } : m.id_type === 'user_id' ? { user_id: m.id } : { open_id: m.id },
  }));

  const { text, resources } = extractTextAndResources(
    item.msg_type,
    item.body?.content || '{}',
    rawMentions
  );

  const mentions: LarkMention[] = [];
  if (rawMentions.length > 0) {
    for (const m of rawMentions) {
      mentions.push({
        key: m.key,
        name: m.name,
        openId: mentionOpenId(m),
        userId: mentionIdentity(m).userId,
        unionId: mentionUnionId(m),
        appId: mentionAppId(m),
        idType: m.id_type,
      });
    }
  }

  const postAts = extractPostAtParticipants(item.body?.content);
  for (const pa of postAts) {
    if (!mentions.some((m) => (m.openId && m.openId === pa.openId) || (m.appId && m.appId === pa.appId))) {
      mentions.push(pa);
    }
  }

  let senderId = '';
  if (item.sender?.id_type === 'open_id') {
    senderId = item.sender.id;
  } else if (item.sender?.id) {
    senderId = item.sender.id;
  }

  return {
    messageId: item.message_id,
    chatId: item.chat_id,
    chatType: context.chatType,
    rootId: item.root_id || undefined,
    threadId: item.thread_id || undefined,
    parentId: item.parent_id || undefined,
    senderId,
    senderType: item.sender?.sender_type ?? 'user',
    msgType: item.msg_type,
    text,
    createTime: item.create_time ? new Date(Number(item.create_time)).toISOString() : new Date().toISOString(),
    mentions: mentions.length > 0 ? mentions : undefined,
    resources: resources.length > 0 ? resources : undefined,
  };
}

