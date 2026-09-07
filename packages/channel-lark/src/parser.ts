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
  LarkParsedMessage,
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
                unsupported: true,
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
          unsupported: true,
        });
      }
      return { text: '[图片 (附件下载未实现)]', resources };
    }

    if (msgType === 'file') {
      const parsed = JSON.parse(rawContent);
      if (parsed.file_key) {
        resources.push({
          type: 'file',
          key: parsed.file_key,
          name: parsed.file_name ?? parsed.file_key,
          unsupported: true,
        });
      }
      return { text: parsed.file_name ? `[文件: ${parsed.file_name} (附件下载未实现)]` : '[文件 (附件下载未实现)]', resources };
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
