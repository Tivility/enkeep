/**
 * DSH persisted session events → Jarvis items (§8.5). Pure functions, no I/O.
 *
 * Seqs: a Jarvis seq is the DSH seq + 1; one event may yield several items, with ids `<seq>#<n>`
 * (n from 0, in the order below). An event that yields no item still advances the seq.
 *
 * | DSH event | items |
 * | --- | --- |
 * | `user/message` from the person | text → `{role:'user', kind:'text'}`, image → `{role:'user', kind:'image'}` |
 * | `assistant/message` | reasoning → `thinking`; text → `text`; tool-call → `tool_use`; image → `image` (role `assistant`) |
 * | `tool/result` | `{role:'user', kind:'tool_result', tool_use_id, is_error, text}`, then its images (role `user`, `tool_use_id` set) |
 *
 * Roles are `user` | `assistant` | `system` (notices). Tool results sit on the user side, as in
 * Claude's convention. Image items carry `image: {mime, data: '', lazy: true, size?, width?,
 * height?, name?}`; the bytes come from `session.image`.
 * | `turn/end` aborted / interrupted | notice `已中断` |
 * | `turn/end` error / max-tokens | notice `出错：…` / `已达到输出上限` |
 * | `compaction/end` without error | notice `上下文已压缩` |
 * | anything else (`tool/call`, steps, headers, attempts…) | nothing |
 *
 * Which `user/message` events are the person's: DSH tags every user-role message with
 * `source.kind` (dsh-llm `MessageSourceMap`). Direct prompts carry `{kind:'user'}` — enkeep's
 * runtime submits every delivered turn (web, Lark, WeChat, Jarvis, tasks) through
 * `agent.followup(createUserMessage({source:{kind:'user'}}))`. Every other kind is injected
 * context and hidden: `runtime-context`, `agent-instructions`, `skill-catalog`, `skill-invocation`,
 * `agent-message`, `subagent-settled`, `tool-jobs`, `user-approval`, `repeat-tool-reminder`,
 * `working-directory`, `model-selection`, `compact-checkpoint`, `ptc-mode`, `tool-registry`,
 * enkeep `plugin` sources, and any kind added later. Caveats:
 * - enkeep's runtime also injects context with `{kind:'user'}` via `agent.inject`, claimed just
 *   before the person's message of the same turn: the quoted-reply hint (`[Quoting previous message
 *   from …`, hidden) and the workspace attachment guidance (`Workspace attachments:\n- <path> …`).
 *   The guidance text is hidden, but each listed attachment becomes a person's item: an image →
 *   lazy `image` with ref `path:<snapshot path>`, another file → one short text line. A listing
 *   appended to the person's own text is split off the same way. Text that does not match the
 *   listing format is shown as is;
 * - a surface replacement (`surfaceOp.op === 'replace'`, i.e. a compaction summary) is never shown.
 * Legacy events without a `source` count as the person's, as in the platform's web projection.
 *
 * Image refs (engine-internal, resolved by `source.readImage(sessionId, ref)`) are opaque strings
 * `<kind>:<value>`, split on the first `:`: `att:<DSH attachment id>` for image blocks in DSH events
 * (e.g. `att:sha256:<hex>`), `path:<workspace-relative snapshot path>` for enkeep attachments.
 *
 * Tool names are aligned with Claude's (`bash`→`Bash`…); arguments keep their names.
 *
 * @module @enkeep/channel-jarvis/mapper
 */

import type { DshSessionEvent } from './source.js';

export type JarvisItemRole = 'user' | 'assistant' | 'system';
export type JarvisItemKind = 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image' | 'notice';

/** One Jarvis item. Fields beyond `id`…`kind` depend on the kind. */
export interface JarvisItem {
  /** `<seq>#<n>`. */
  id: string;
  /** DSH seq + 1. */
  seq: number;
  /** ISO time of the event. */
  ts: string;
  role: JarvisItemRole;
  kind: JarvisItemKind;
  text?: string;
  /** Set when `text` (or a `tool_input` string) was truncated: the full size in bytes. */
  full_size?: number;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  /** Image items: a lazy placeholder; `data` is always empty (the bytes come from `session.image`). */
  image?: JarvisImage;
  /**
   * Engine-internal (removed by {@link toWireItem}): the image reference `source.readImage` resolves,
   * `att:<DSH attachment id>` or `path:<snapshot path>` (see the module comment).
   */
  ref?: string;
  /** Engine-internal (removed by {@link toWireItem}): the item belongs to the person's message. */
  person?: true;
}

export interface JarvisImage {
  mime: string;
  /** Always `''` in items. */
  data: '';
  lazy: true;
  size?: number;
  width?: number;
  height?: number;
  name?: string;
}

/** An item as sent to Jarvis. */
export type JarvisWireItem = Omit<JarvisItem, 'ref' | 'person'>;

export const IMAGE_REF_ATTACHMENT = 'att';
export const IMAGE_REF_PATH = 'path';

/** Text of pages and pushes is cut at 24 KB (UTF-8 bytes). */
export const TEXT_LIMIT_BYTES = 24 * 1024;
/** Tool output in pages and pushes is cut at 4 KB. */
export const TOOL_OUTPUT_LIMIT_BYTES = 4 * 1024;

export const INTERRUPTED_NOTICE = '已中断';
export const MAX_TOKENS_NOTICE = '已达到输出上限';
export const COMPACTED_NOTICE = '上下文已压缩';
export const ERROR_NOTICE_PREFIX = '出错';

/** Opening of the attachment guidance enkeep's runtime injects with a `{kind:'user'}` source (dsh-boot). */
export const ENKEEP_ATTACHMENTS_HEADER = 'Workspace attachments:\n';
/** Opening of the quoted-reply hint enkeep's runtime injects with a `{kind:'user'}` source (dsh-boot). */
export const ENKEEP_QUOTE_PREFIX = '[Quoting previous message from ';
/** Label of the short text line shown for a non-image attachment. */
export const ATTACHMENT_LINE_LABEL = '附件';

/** Roles per item origin; one place to adjust if the Jarvis renderer expects other values. */
export const ITEM_ROLES = {
  person: 'user',
  assistant: 'assistant',
  toolResult: 'user',
  notice: 'system',
} as const satisfies Record<string, JarvisItemRole>;

export const TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  grep: 'Grep',
  glob: 'Glob',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  todo_write: 'TodoWrite',
  ask_user_question: 'AskUserQuestion',
  read_image: 'Read',
};

/** The Claude-aligned name of a DSH tool; unknown tools keep their name. */
export function mapToolName(name: string): string {
  return Object.prototype.hasOwnProperty.call(TOOL_NAME_MAP, name) ? TOOL_NAME_MAP[name]! : name;
}

/** The Jarvis seq of an item id (`<seq>#<n>`), or null when malformed. */
export function itemSeqOf(itemId: string): number | null {
  const match = /^(\d+)#(\d+)$/.exec(itemId);
  if (!match) return null;
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

/**
 * Where a turn starts: the first of a run of the person's items (the attachments enkeep injects
 * just before the person's text belong to the same turn). `previous` is the item before, if any.
 * Tool results are role `user` too, but not the person's.
 */
export function isTurnStart(item: JarvisItem, previous: JarvisItem | undefined): boolean {
  return item.person === true && previous?.person !== true;
}

/** The item as sent to Jarvis (engine-internal fields removed). */
export function toWireItem(item: JarvisItem): JarvisWireItem {
  if (item.ref === undefined && item.person === undefined) return item;
  const { ref: _ref, person: _person, ...wire } = item;
  return wire;
}

export interface MapOptions {
  /** Do not truncate (for `session.item`). */
  full?: boolean;
}

interface Block {
  type?: unknown;
  [key: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function contentBlocks(content: unknown): Block[] {
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Block => asRecord(b) !== null);
}

function blockText(block: Block): string {
  return typeof block.text === 'string' ? block.text : '';
}

// ---------------------------------------------------------------------------
// Truncation

export function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function cutUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  let end = Math.min(maxBytes, bytes.length);
  // Back off to a character boundary (continuation bytes are 10xxxxxx).
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function truncationNote(fullSize: number, toolOutput: boolean): string {
  return toolOutput ? `…（已截断，点开看全文，共 ${fullSize} 字节）` : `…（已截断，共 ${fullSize} 字节）`;
}

/** Cut `text` to `limit` bytes; returns the shown text and, when cut, the full size. */
export function truncateText(text: string, limit: number, toolOutput: boolean): { text: string; fullSize?: number } {
  // Each UTF-16 unit is at most 3 UTF-8 bytes: short strings need no measuring.
  if (text.length * 3 <= limit) return { text };
  const size = utf8Length(text);
  if (size <= limit) return { text };
  return { text: `${cutUtf8(text, limit)}\n${truncationNote(size, toolOutput)}`, fullSize: size };
}

function lightValue(value: unknown, state: { cut: boolean }): unknown {
  if (typeof value === 'string') {
    const t = truncateText(value, TEXT_LIMIT_BYTES, false);
    if (t.fullSize !== undefined) state.cut = true;
    return t.text;
  }
  if (Array.isArray(value)) return value.map((v) => lightValue(v, state));
  const record = asRecord(value);
  if (record) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) out[k] = lightValue(v, state);
    return out;
  }
  return value;
}

/**
 * A tool input for pages and pushes: every string longer than 24 KB is cut. `fullSize` (the size of
 * the whole input as JSON) is set when something was cut.
 */
export function lightToolInput(input: Record<string, unknown>, rawSize?: number): { input: Record<string, unknown>; fullSize?: number } {
  const state = { cut: false };
  const light = lightValue(input, state) as Record<string, unknown>;
  if (!state.cut) return { input };
  return { input: light, fullSize: rawSize ?? utf8Length(JSON.stringify(input)) };
}

function parseToolInput(args: unknown): Record<string, unknown> {
  if (typeof args === 'string') {
    if (args.trim().length === 0) return {};
    try {
      const parsed: unknown = JSON.parse(args);
      const record = asRecord(parsed);
      return record ?? { value: parsed };
    } catch {
      return { raw: args };
    }
  }
  return asRecord(args) ?? {};
}

// ---------------------------------------------------------------------------
// Mapping

function isoTime(time: unknown): string {
  const ms = typeof time === 'number' && Number.isFinite(time) ? time : 0;
  return new Date(ms).toISOString();
}

/** How a `user/message` is shown (see the module comment). */
export type UserMessageClass = 'person' | 'attachments' | 'hidden';

/** Classify a `user/message` payload: the person's message, enkeep's attachment guidance, or hidden context. */
export function classifyUserMessage(data: unknown, surfaceOp?: unknown): UserMessageClass {
  const message = asRecord(data);
  if (!message) return 'hidden';
  if (message.role !== undefined && message.role !== 'user') return 'hidden';
  const replace = asRecord(surfaceOp);
  if (replace && replace.op === 'replace') return 'hidden';
  const source = asRecord(message.source);
  if (source && source.kind !== 'user') return 'hidden';
  const firstText = contentBlocks(message.content).find((b) => b.type === 'text');
  if (firstText) {
    const text = blockText(firstText);
    if (text.startsWith(ENKEEP_QUOTE_PREFIX)) return 'hidden';
    if (text.startsWith(ENKEEP_ATTACHMENTS_HEADER)) return 'attachments';
  }
  return 'person';
}

/** Whether a `user/message` payload is the person's own message (not enkeep- or DSH-injected context). */
export function isPersonMessage(data: unknown, surfaceOp?: unknown): boolean {
  return classifyUserMessage(data, surfaceOp) === 'person';
}

/** One attachment of enkeep's listing (`- <snapshotPath>[ (<name>)] (media: <type>, size: <n> bytes, etag: <etag>)`). */
export interface ListedAttachment {
  path: string;
  name?: string;
  mime: string;
  size: number;
}

const LISTING_TAIL = /\s\(media: ([^,()]+), size: (\d+) bytes, etag: [^()]*\)\s*$/;

/** Parse one listing line; null when it does not match the format. */
export function parseAttachmentLine(line: string): ListedAttachment | null {
  if (!line.startsWith('- ')) return null;
  const tail = LISTING_TAIL.exec(line);
  if (!tail) return null;
  let head = line.slice(2, tail.index).trim();
  let name: string | undefined;
  if (head.endsWith(')')) {
    // The display name is the last balanced `(…)` group, preceded by a space.
    let depth = 0;
    for (let i = head.length - 1; i > 0; i--) {
      const ch = head[i];
      if (ch === ')') depth++;
      else if (ch === '(' && --depth === 0) {
        if (head[i - 1] === ' ') {
          name = head.slice(i + 1, -1);
          head = head.slice(0, i - 1).trimEnd();
        }
        break;
      }
    }
  }
  if (head.length === 0) return null;
  const attachment: ListedAttachment = { path: head, mime: tail[1]!.trim(), size: Number(tail[2]) };
  if (name !== undefined && name.length > 0) attachment.name = name;
  return attachment;
}

/**
 * Split enkeep's attachment listing off a text: the text before `Workspace attachments:\n` and the
 * listed attachments. Without a parsable listing the whole text is returned unchanged.
 */
export function splitAttachmentListing(text: string): { text: string; attachments: ListedAttachment[] } {
  const at = text.startsWith(ENKEEP_ATTACHMENTS_HEADER) ? 0 : text.lastIndexOf(`\n${ENKEEP_ATTACHMENTS_HEADER}`);
  if (at < 0) return { text, attachments: [] };
  const start = at === 0 ? ENKEEP_ATTACHMENTS_HEADER.length : at + 1 + ENKEEP_ATTACHMENTS_HEADER.length;
  const attachments: ListedAttachment[] = [];
  for (const line of text.slice(start).split('\n')) {
    if (!line.startsWith('- ')) break;
    const parsed = parseAttachmentLine(line);
    if (!parsed) return { text, attachments: [] };
    attachments.push(parsed);
  }
  if (attachments.length === 0) return { text, attachments: [] };
  return { text: text.slice(0, at).trimEnd(), attachments };
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** An image block's placeholder fields, its attachment reference and inline bytes (legacy logs). */
interface ImageInfo {
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
  name?: string;
  ref?: string;
  inline?: { mime: string; data: string };
}

function imageInfo(block: Block): ImageInfo | null {
  const attachment = asRecord(block.attachment);
  if (attachment && typeof attachment.attachmentId === 'string') {
    const info: ImageInfo = { ref: `${IMAGE_REF_ATTACHMENT}:${attachment.attachmentId}` };
    if (typeof attachment.mediaType === 'string') info.mime = attachment.mediaType;
    if (typeof attachment.bytes === 'number') info.size = attachment.bytes;
    if (typeof attachment.width === 'number') info.width = attachment.width;
    if (typeof attachment.height === 'number') info.height = attachment.height;
    if (typeof attachment.name === 'string' && attachment.name.length > 0) info.name = attachment.name;
    return info;
  }
  // Older logs carried the bytes inline (`{data, mimeType}` or `{source:{media_type, data}}`).
  const nested = asRecord(block.source);
  const data = typeof block.data === 'string' ? block.data : typeof nested?.data === 'string' ? nested.data : undefined;
  const mime =
    typeof block.mimeType === 'string'
      ? block.mimeType
      : typeof block.mediaType === 'string'
        ? block.mediaType
        : typeof nested?.media_type === 'string'
          ? nested.media_type
          : undefined;
  if (data === undefined) return null;
  const effectiveMime = mime ?? 'application/octet-stream';
  return { mime: effectiveMime, size: Math.floor((data.length * 3) / 4), inline: { mime: effectiveMime, data } };
}

class ItemBuilder {
  readonly items: JarvisItem[] = [];
  readonly images = new Map<string, ImageInfo>();
  /** Items added now belong to the person's message. */
  person = false;

  constructor(
    private readonly seq: number,
    private readonly ts: string,
    private readonly full: boolean,
  ) {}

  private base(role: JarvisItemRole, kind: JarvisItemKind): JarvisItem {
    const item: JarvisItem = { id: `${this.seq}#${this.items.length}`, seq: this.seq, ts: this.ts, role, kind };
    if (this.person) item.person = true;
    return item;
  }

  text(role: JarvisItemRole, kind: 'text' | 'thinking' | 'notice', text: string): void {
    const item = this.base(role, kind);
    this.setText(item, text, false);
    this.items.push(item);
  }

  toolUse(name: string, args: unknown, callId: unknown): void {
    const item = this.base(ITEM_ROLES.assistant, 'tool_use');
    item.tool_name = mapToolName(name);
    const input = parseToolInput(args);
    if (this.full) {
      item.tool_input = input;
    } else {
      const light = lightToolInput(input, typeof args === 'string' ? utf8Length(args) : undefined);
      item.tool_input = light.input;
      if (light.fullSize !== undefined) item.full_size = light.fullSize;
    }
    if (typeof callId === 'string') item.tool_use_id = callId;
    this.items.push(item);
  }

  toolResult(callId: string | undefined, isError: boolean, text: string): void {
    const item = this.base(ITEM_ROLES.toolResult, 'tool_result');
    if (callId !== undefined) item.tool_use_id = callId;
    item.is_error = isError;
    this.setText(item, text, true);
    this.items.push(item);
  }

  image(role: JarvisItemRole, block: Block, callId?: string): void {
    const info = imageInfo(block);
    if (info) this.pushImage(role, info, callId);
  }

  /** enkeep's listed attachments: images as lazy image items, other files as one short text line. */
  listed(attachments: readonly ListedAttachment[]): void {
    const files: string[] = [];
    for (const att of attachments) {
      if (att.mime.startsWith('image/')) {
        const info: ImageInfo = { mime: att.mime, size: att.size, name: att.name ?? baseName(att.path), ref: `${IMAGE_REF_PATH}:${att.path}` };
        this.pushImage(ITEM_ROLES.person, info);
      } else {
        files.push(`${ATTACHMENT_LINE_LABEL}：${att.name ?? baseName(att.path)}`);
      }
    }
    if (files.length > 0) this.text(ITEM_ROLES.person, 'text', files.join('\n'));
  }

  private pushImage(role: JarvisItemRole, info: ImageInfo, callId?: string): void {
    const item = this.base(role, 'image');
    const image: JarvisImage = { mime: info.mime ?? 'application/octet-stream', data: '', lazy: true };
    if (info.size !== undefined) image.size = info.size;
    if (info.width !== undefined) image.width = info.width;
    if (info.height !== undefined) image.height = info.height;
    if (info.name !== undefined) image.name = info.name;
    item.image = image;
    if (callId !== undefined) item.tool_use_id = callId;
    if (info.ref !== undefined) item.ref = info.ref;
    this.images.set(item.id, info);
    this.items.push(item);
  }

  private setText(item: JarvisItem, text: string, toolOutput: boolean): void {
    if (this.full) {
      item.text = text;
      return;
    }
    const t = truncateText(text, toolOutput ? TOOL_OUTPUT_LIMIT_BYTES : TEXT_LIMIT_BYTES, toolOutput);
    item.text = t.text;
    if (t.fullSize !== undefined) item.full_size = t.fullSize;
  }
}

function build(event: DshSessionEvent, full: boolean): ItemBuilder {
  const seq = event.seq + 1;
  const b = new ItemBuilder(seq, isoTime(event.time), full);
  const data = asRecord(event.data);
  if (!data) return b;

  switch (event.type) {
    case 'user/message': {
      const shown = classifyUserMessage(data, event.surfaceOp);
      if (shown === 'hidden') break;
      b.person = true;
      const listed: ListedAttachment[] = [];
      let first = true;
      for (const block of contentBlocks(data.content)) {
        if (block.type === 'text') {
          // Only the first text block can carry (or be) enkeep's listing.
          const split = first ? splitAttachmentListing(blockText(block)) : { text: blockText(block), attachments: [] };
          first = false;
          listed.push(...split.attachments);
          if (shown === 'person' && split.text.trim().length > 0) b.text(ITEM_ROLES.person, 'text', split.text);
          if (shown === 'attachments') break;
        } else if (block.type === 'image' && shown === 'person') {
          b.image(ITEM_ROLES.person, block);
        }
      }
      b.listed(listed);
      break;
    }
    case 'assistant/message': {
      const message = asRecord(data.message);
      if (!message) break;
      for (const block of contentBlocks(message.content)) {
        if (block.type === 'reasoning') {
          const text = blockText(block);
          if (text.trim().length > 0) b.text(ITEM_ROLES.assistant, 'thinking', text);
        } else if (block.type === 'text') {
          const text = blockText(block);
          if (text.trim().length > 0) b.text(ITEM_ROLES.assistant, 'text', text);
        } else if (block.type === 'tool-call') {
          b.toolUse(typeof block.name === 'string' ? block.name : 'unknown', block.arguments, block.id);
        } else if (block.type === 'image') {
          b.image(ITEM_ROLES.assistant, block);
        }
      }
      break;
    }
    case 'tool/result': {
      const message = asRecord(data.message);
      if (!message) break;
      const source = asRecord(message.source);
      const callId =
        typeof message.toolCallId === 'string'
          ? message.toolCallId
          : typeof source?.callId === 'string'
            ? source.callId
            : undefined;
      const blocks = contentBlocks(message.content);
      let text = blocks
        .filter((blk) => blk.type === 'text')
        .map(blockText)
        .join('\n');
      const isError = message.isError === true;
      const failure = asRecord(data.error);
      if (isError && text.trim().length === 0 && typeof failure?.reason === 'string') text = failure.reason;
      b.toolResult(callId, isError, text);
      for (const block of blocks) {
        if (block.type === 'image') b.image(ITEM_ROLES.toolResult, block, callId);
      }
      break;
    }
    case 'turn/end': {
      const reason = asRecord(data.reason);
      const kind = reason?.kind;
      if (kind === 'aborted' || kind === 'interrupted') {
        b.text(ITEM_ROLES.notice, 'notice', INTERRUPTED_NOTICE);
      } else if (kind === 'max-tokens') {
        b.text(ITEM_ROLES.notice, 'notice', MAX_TOKENS_NOTICE);
      } else if (kind === 'error') {
        const failure = asRecord(reason?.error);
        const message = typeof failure?.message === 'string' && failure.message.length > 0 ? failure.message : 'unknown error';
        const code = typeof failure?.code === 'string' && failure.code !== 'UNKNOWN' ? failure.code : undefined;
        b.text(ITEM_ROLES.notice, 'notice', code ? `${ERROR_NOTICE_PREFIX}（${code}）：${message}` : `${ERROR_NOTICE_PREFIX}：${message}`);
      }
      break;
    }
    case 'compaction/end': {
      if (data.error === undefined || data.error === null) b.text(ITEM_ROLES.notice, 'notice', COMPACTED_NOTICE);
      break;
    }
    default:
      break;
  }
  return b;
}

/** The items of one event, truncated for pages and pushes unless `full`. */
export function mapEvent(event: DshSessionEvent, options: MapOptions = {}): JarvisItem[] {
  return build(event, options.full === true).items;
}

/** The items of several events, in order. */
export function mapEvents(events: readonly DshSessionEvent[], options: MapOptions = {}): JarvisItem[] {
  const out: JarvisItem[] = [];
  for (const event of events) out.push(...mapEvent(event, options));
  return out;
}

/** One item of an event in full (no truncation), for `session.item`; null when the event has no such item. */
export function fullItem(event: DshSessionEvent, itemId: string): JarvisItem | null {
  if (itemSeqOf(itemId) !== event.seq + 1) return null;
  return mapEvent(event, { full: true }).find((item) => item.id === itemId) ?? null;
}

/**
 * Where an image item's bytes come from: `{ref}` for `source.readImage`, or the bytes themselves
 * for images older logs stored inline. Null when the item is not an image of this event.
 */
export function imageSource(event: DshSessionEvent, itemId: string): { ref: string } | { mime: string; data: string } | null {
  if (itemSeqOf(itemId) !== event.seq + 1) return null;
  const info = build(event, true).images.get(itemId);
  if (!info) return null;
  if (info.ref !== undefined) return { ref: info.ref };
  return info.inline ?? null;
}
