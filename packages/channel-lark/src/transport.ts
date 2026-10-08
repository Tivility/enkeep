/**
 * Lark Transport implementations.
 * Provides FakeLarkTransport for testing / offline closed-loop execution,
 * and CredentialedLarkTransport for production integration with @larksuiteoapi/node-sdk.
 *
 * @module @enkeep/channel-lark/transport
 */

import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { resolveMaxInboundFileBytes } from '@enkeep/platform-core';
import {
  REAL_LARK_CREDENTIAL_ACCEPTANCE,
  REAL_LARK_CREDENTIAL_SKIP_REASON,
  type CardFinalMetadata,
  type CardToolStatusEntry,
  type LarkAccountConfig,
  type LarkCredentialResolver,
  type LarkEventHandler,
  type LarkRawEvent,
  type LarkSdkClientFactory,
  type LarkStreamingCardSession,
  type LarkTransport,
  type OutboundReplyResult,
  type ILarkApiClient,
  type ILarkWSClient,
} from './types.js';
import {
  optimizeMarkdownStyle,
  chunkMarkdown,
  markdownToCardElements,
  type LarkCardBodyElement,
} from './markdown-card.js';

export const SAFE_RESOURCE_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
export const LARK_PLATFORM_MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MiB Feishu IM resource limit
export const LARK_NON_RANGE_MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MiB Feishu IM non-range download limit
export const LARK_DOWNLOAD_CHUNK_SIZE_BYTES = 32 * 1024 * 1024; // 32 MiB Feishu IM ranged chunk size
export const MAX_IMAGE_DOWNLOAD_BYTES = 30 * 1024 * 1024; // 30 MiB per-image cap (Feishu IM limit)
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 60000; // 60 seconds
export const MAX_FILE_DOWNLOAD_BYTES = 500 * 1024 * 1024; // 500 MiB Enkeep inbound cap
export const FILE_DOWNLOAD_TIMEOUT_MS = 600000; // 10 minutes total lifecycle budget
export const FILE_ACTIVITY_TIMEOUT_MS = 30000; // 30 seconds idle heartbeat timeout
export const LARK_CHUNK_RETRY_COUNT = 3;
export const LARK_CHUNK_INITIAL_BACKOFF_MS = 200;

export async function isFeishuSizeLimitError(err: any): Promise<boolean> {
  if (!err) return false;
  const msg = String(err?.message || err?.msg || '').toLowerCase();
  const code = String(err?.code || err?.response?.data?.code || err?.status || '');
  if (
    code === '234037' ||
    msg.includes('234037') ||
    msg.includes('downloaded file size exceeds limit') ||
    msg.includes('size exceeds limit')
  ) {
    return true;
  }
  if (err?.response?.data) {
    try {
      let bodyText = '';
      if (Buffer.isBuffer(err.response.data)) {
        bodyText = err.response.data.toString('utf8');
      } else if (
        typeof err.response.data.read === 'function' ||
        typeof err.response.data[Symbol.asyncIterator] === 'function'
      ) {
        const stream = err.response.data;
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        bodyText = Buffer.concat(chunks).toString('utf8');
      } else if (typeof err.response.data === 'string') {
        bodyText = err.response.data;
      }
      if (
        bodyText.includes('234037') ||
        bodyText.toLowerCase().includes('downloaded file size exceeds limit') ||
        bodyText.toLowerCase().includes('size exceeds limit')
      ) {
        return true;
      }
    } catch {}
  }
  return false;
}

/**
 * Validates strict PDF byte signature (%PDF-).
 * Rejects masquerades, truncated buffers, and non-PDF files.
 */
export function isPdfBuffer(buffer: Buffer): boolean {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 5 &&
    buffer[0] === 0x25 && // %
    buffer[1] === 0x50 && // P
    buffer[2] === 0x44 && // D
    buffer[3] === 0x46 && // F
    buffer[4] === 0x2d    // -
  );
}

/**
 * Sniffs authoritative image MIME type from binary buffer header magic bytes.
 * Rejects unsupported file masquerades (e.g. executables, archives).
 */
export function sniffSupportedImageMime(buffer: Buffer): string | null {
  if (!buffer || buffer.length < 4) return null;
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF: GIF87a or GIF89a (47 49 46 38)
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return 'image/gif';
  }
  // WebP: RIFF....WEBP
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Sanitized safe logger for Lark SDK.
 * Strips sensitive Authorization headers, appSecrets, and suppresses raw Axios config/request objects.
 */
export class SanitizedLarkLogger implements lark.Logger {
  error(...args: any[]): void {
    const sanitized = args.map((arg) => {
      if (arg instanceof Error) {
        return `${arg.name}: ${arg.message}`;
      }
      if (typeof arg === 'string') {
        return arg
          .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [REDACTED]')
          .replace(/"app_?secret"\s*:\s*"[^"]+"/gi, '"app_secret":"[REDACTED]"');
      }
      if (typeof arg === 'object' && arg !== null) {
        const safe: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(arg)) {
          if (/secret|token|auth|key|password/i.test(k)) {
            safe[k] = '[REDACTED]';
          } else {
            safe[k] = v;
          }
        }
        return safe;
      }
      return '[Sanitized Object]';
    });
    console.error(...sanitized);
  }

  warn(...args: any[]): void {
    const sanitized = args.map((arg) => {
      if (arg instanceof Error) {
        return `${arg.name}: ${arg.message}`;
      }
      if (typeof arg === 'string') {
        return arg
          .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [REDACTED]')
          .replace(/"app_?secret"\s*:\s*"[^"]+"/gi, '"app_secret":"[REDACTED]"');
      }
      if (typeof arg === 'object' && arg !== null) {
        const safe: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(arg)) {
          if (/secret|token|auth|key|password/i.test(k)) {
            safe[k] = '[REDACTED]';
          } else {
            safe[k] = v;
          }
        }
        return safe;
      }
      return '[Sanitized Object]';
    });
    console.warn(...sanitized);
  }

  info(): void {}
  debug(): void {}
  trace(): void {}
}

/**
 * Creates a bounded HttpInstance with 15s socket/HTTP timeout and standard SDK response unwrapping.
 */
export function createBoundedHttpInstance(timeoutMs = 15000): lark.HttpInstance {
  const instance = lark.defaultHttpInstance.create({
    timeout: timeoutMs,
  });
  instance.interceptors.response.use((resp: any) => {
    if (resp && resp.config && resp.config['$return_headers']) {
      return {
        data: resp.data,
        headers: resp.headers,
      };
    }
    return resp ? resp.data : resp;
  });
  return instance as unknown as lark.HttpInstance;
}

export const LARK_THREAD_REPLY_UNSUPPORTED_CODES = new Set([230071, 230072]);

export interface ReplyTargetResolution {
  messageId?: string;
  replyInThread: boolean;
}

export function resolveReplyTarget(params: {
  rootId?: string;
  threadId?: string;
  replyToMessageId?: string;
}): ReplyTargetResolution {
  const replyInThread = Boolean(params.rootId || params.threadId);
  let messageId: string | undefined;

  if (params.rootId && /^om_/.test(params.rootId)) {
    messageId = params.rootId;
  } else if (params.replyToMessageId && !params.replyToMessageId.startsWith('omt_')) {
    messageId = params.replyToMessageId;
  }

  return { messageId, replyInThread };
}

export function getLarkApiErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    const match = String(error).match(/code[=:]\s*(\d+)/i);
    return match ? Number(match[1]) : undefined;
  }
  const value = error as {
    code?: number;
    message?: string;
    response?: { code?: number; data?: { code?: number } };
  };
  if (typeof value.code === 'number') return value.code;
  if (typeof value.response?.data?.code === 'number') {
    return value.response.data.code;
  }
  if (typeof value.response?.code === 'number') return value.response.code;
  const match = value.message?.match(/code[=:]\s*(\d+)/i);
  return match ? Number(match[1]) : undefined;
}

export interface SentReplyRecord {
  readonly chatId: string;
  readonly rootId?: string;
  readonly threadId?: string;
  readonly replyToMessageId?: string;
  readonly content: string;
  readonly format?: 'plain' | 'markdown';
  readonly uuid?: string;
  readonly timestamp: string;
  readonly messageId: string;
}

export interface FakeReactionRecord {
  readonly messageId: string;
  readonly emojiType: string;
  readonly reactionId: string;
  readonly timestamp: string;
}

export interface FakeRemovedReactionRecord {
  readonly messageId: string;
  readonly reactionId: string;
  readonly timestamp: string;
}

export interface FakeStreamingCallRecord {
  readonly type: 'card_create' | 'push' | 'push_status' | 'push_thinking' | 'push_status_line' | 'finalize';
  readonly cardId?: string;
  readonly messageId?: string;
  readonly content?: string;
  readonly toolStatus?: string | readonly CardToolStatusEntry[];
  readonly thinkingText?: string;
  readonly statusLine?: string;
  readonly status?: 'completed' | 'failed' | 'stopped';
  readonly metadata?: CardFinalMetadata;
  readonly card?: any;
  readonly params?: any;
  readonly timestamp: string;
}

/**
 * Check if a tool entry represents a subagent task.
 */
export function isSubagentTool(entry: CardToolStatusEntry): boolean {
  if (entry.isSubagent) return true;
  const name = entry.toolName?.toLowerCase() || '';
  return name === 'subagent' || name === 'subagent_fork' || name === 'create_task';
}

/**
 * Format duration in milliseconds into a concise readable string.
 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '-';
  if (ms === 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${Number.isInteger(sec) ? sec : sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const restSec = Math.floor(sec % 60);
  return restSec === 0 ? `${min}m` : `${min}m ${restSec}s`;
}

/**
 * Build Schema 2.0 streaming status line with 5s-bucketed elapsed time and liveness indicators.
 */
export function buildStreamingStatusLine(params: {
  elapsedMs: number;
  nowMs?: number;
  lastActivityAt?: number;
  staleThresholdMs?: number;
}): string {
  const elapsedBucket = Math.max(0, Math.floor(params.elapsedMs / 5000) * 5000);
  const now = params.nowMs ?? Date.now();
  const nowBucket = Math.floor(now / 5000) * 5000;
  const timeSec = `<local_datetime millisecond='${nowBucket}' format_type='time_sec'></local_datetime>`;

  let idleNotice = '';
  const staleThreshold = params.staleThresholdMs ?? 120_000;
  if (params.lastActivityAt && now - params.lastActivityAt >= staleThreshold) {
    const silenceMs = now - params.lastActivityAt;
    idleNotice = ` · ${formatDuration(silenceMs)} 无新事件，仍在运行`;
  }

  return `<font color='grey'>⏳ 已用 ${formatDuration(elapsedBucket)} · 更新 ${timeSec}${idleNotice}</font>`;
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1) + '…';
}

export interface ToolCallView {
  name: string;
  status: 'running' | 'complete' | 'completed' | 'error' | 'failed' | 'started';
  durationMs: number;
  summary?: string;
  /** When the tool invocation is wrapping a Skill, display this instead of name. */
  skillName?: string;
  /** Sub-agent tool calls get visual indentation. */
  isNested?: boolean;
}

/** Map a tool name + summary to a labeled parameter (mirrors HappyClaw parseToolParam). */
export function parseToolParam(
  toolName: string,
  summary: string | undefined
): { label: string; value: string } | null {
  if (!summary) return null;
  let text = summary.trim();
  if (!text) return null;

  // Try parsing JSON if it looks like a JSON object
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === 'object') {
        const val =
          obj.path ??
          obj.file_path ??
          obj.cmd ??
          obj.command ??
          obj.pattern ??
          obj.query ??
          obj.url ??
          obj.task ??
          obj.prompt ??
          obj.input ??
          obj.name;
        if (val !== undefined && typeof val === 'string') {
          text = val;
        } else if (val !== undefined) {
          text = String(val);
        }
      }
    } catch {}
  }

  const lower = toolName.toLowerCase();
  if (['read', 'write', 'edit', 'glob', 'read_file', 'write_file', 'edit_file'].includes(lower)) {
    return { label: 'path', value: text };
  }
  if (['bash', 'sh', 'shell', 'exec', 'command'].includes(lower)) {
    return { label: 'cmd', value: text };
  }
  if (['grep', 'search', 'ripgrep'].includes(lower)) {
    return { label: 'pattern', value: text };
  }
  if (['agent', 'task', 'subagent', 'subagent_fork', 'create_task'].includes(lower)) {
    return { label: 'task', value: text };
  }
  if (['web_fetch', 'fetch'].includes(lower)) {
    return { label: 'url', value: text };
  }
  return { label: 'input', value: text };
}

/** Tool timeline with status tags, elapsed time, labeled params, skill + nested hints (HappyClaw parity). */
export function buildToolsTimelineText(
  tools: ToolCallView[],
  opts: { maxVisible?: number } = {}
): string {
  // Filter out AskUserQuestion
  const filtered = tools.filter((t) => {
    const lower = t.name?.toLowerCase() || '';
    return lower !== 'askuserquestion' && lower !== 'ask_user_question';
  });
  if (filtered.length === 0) return "<font color='grey'>尚未调用任何工具</font>";

  const maxVisible = opts.maxVisible ?? 8;
  const running = filtered.filter((t) => t.status === 'running' || t.status === 'started');
  const recent = filtered.filter((t) => t.status !== 'running' && t.status !== 'started').slice(-maxVisible);
  const picked = [...running, ...recent].slice(0, maxVisible);

  const lines = picked.map((t) => {
    const tagColor =
      t.status === 'running' || t.status === 'started'
        ? 'blue'
        : t.status === 'error' || t.status === 'failed'
          ? 'red'
          : 'green';
    const tagText =
      t.status === 'running' || t.status === 'started'
        ? '运行'
        : t.status === 'error' || t.status === 'failed'
          ? '失败'
          : '完成';
    const elapsed =
      t.durationMs > 0
        ? ` <font color='grey'>(${formatDuration(t.durationMs)})</font>`
        : '';
    const isSkill = t.name === 'Skill' || t.name === 'skill' || t.name?.toLowerCase() === 'skill';
    const displayName = isSkill && t.skillName ? t.skillName : t.name;
    const param = parseToolParam(t.name, t.summary);
    const paramLine =
      param && !(isSkill && param.value === displayName)
        ? `\n  <font color='grey'>${param.label}: ${truncate(param.value, 90)}</font>`
        : '';
    const indent = t.isNested ? '    ' : '';
    return `${indent}<text_tag color='${tagColor}'>${tagText}</text_tag> \`${displayName}\`${elapsed}${paramLine}`;
  });

  const hidden = filtered.length - picked.length;
  const more =
    hidden > 0
      ? `\n<font color='grey'>… 另有 ${hidden} 条工具记录已收起</font>`
      : '';
  return `${lines.join('\n')}${more}`;
}

/**
 * Format tool status entries into Lark Schema 2.0 markdown content.
 * Displays tool name, Schema 2.0 status badges, elapsed duration, and param summary.
 */
export function formatToolStatusMarkdown(
  toolStatus?: string | readonly CardToolStatusEntry[],
  nowMs?: number,
  opts?: { maxVisible?: number; useSchemaTags?: boolean }
): string | null {
  if (!toolStatus) return null;
  if (typeof toolStatus === 'string') {
    const trimmed = toolStatus.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!Array.isArray(toolStatus) || toolStatus.length === 0) {
    return null;
  }

  // D10: Filter out AskUserQuestion from tools timeline
  const filtered = toolStatus.filter((e) => {
    const lower = e.toolName?.toLowerCase() || '';
    return lower !== 'askuserquestion' && lower !== 'ask_user_question';
  });
  if (filtered.length === 0) {
    return null;
  }

  const subagentEntries = filtered.filter(isSubagentTool);
  const normalToolEntries = filtered.filter((e) => !isSubagentTool(e));

  const sections: string[] = [];

  if (subagentEntries.length > 0) {
    const maxSub = opts?.maxVisible ?? 8;
    const runningSub = subagentEntries.filter(
      (e) => e.status === 'started' || e.status === 'running'
    );
    const recentSub = subagentEntries
      .filter((e) => e.status !== 'started' && e.status !== 'running')
      .slice(-maxSub);
    const pickedSub = [...runningSub, ...recentSub].slice(0, maxSub);
    const hiddenSub = subagentEntries.length - pickedSub.length;

    const subagentLines = pickedSub.map((entry) => {
      const tagColor =
        entry.status === 'started' || entry.status === 'running'
          ? 'blue'
          : entry.status === 'completed'
            ? 'green'
            : 'red';
      const tagText =
        entry.status === 'started' || entry.status === 'running'
          ? '运行'
          : entry.status === 'completed'
            ? '完成'
            : '失败';

      let elapsedPart = '';
      if (typeof entry.startTime === 'number' && entry.startTime > 0) {
        const end =
          typeof entry.endTime === 'number' && entry.endTime > 0
            ? entry.endTime
            : (nowMs ?? Date.now());
        const durationMs = Math.max(0, end - entry.startTime);
        elapsedPart = ` <font color='grey'>· ${formatDuration(durationMs)}</font>`;
      }

      const desc = entry.description
        ? `\n  <font color='grey'>${truncate(entry.description, 180)}</font>`
        : '';

      const statusDesc =
        entry.status === 'started' || entry.status === 'running'
          ? '正在执行…'
          : entry.status === 'completed'
            ? '已完成'
            : '执行失败';

      const indent = entry.isNested ? '    ' : '';
      return `${indent}<text_tag color='${tagColor}'>${tagText}</text_tag> 🤖 **${entry.toolName}**: ${statusDesc}${elapsedPart}${desc}`;
    });

    if (hiddenSub > 0) {
      subagentLines.push(`<font color='grey'>… 另有 ${hiddenSub} 项子任务已收起</font>`);
    }

    sections.push(`🤖 **子任务 / Subagents**\n${subagentLines.join('\n')}`);
  }

  if (normalToolEntries.length > 0) {
    const hasRichInfo = normalToolEntries.some(
      (e) =>
        Boolean(e.description) ||
        Boolean(e.skillName) ||
        Boolean(e.isNested)
    );
    const useTags = opts?.useSchemaTags === true || hasRichInfo;

    if (useTags) {
      const maxNormal = opts?.maxVisible ?? 8;
      const runningNormal = normalToolEntries.filter(
        (e) => e.status === 'started' || e.status === 'running'
      );
      const recentNormal = normalToolEntries
        .filter((e) => e.status !== 'started' && e.status !== 'running')
        .slice(-maxNormal);
      const pickedNormal = [...runningNormal, ...recentNormal].slice(0, maxNormal);
      const hiddenNormal = normalToolEntries.length - pickedNormal.length;

      const normalToolLines = pickedNormal.map((entry) => {
        const tagColor =
          entry.status === 'started' || entry.status === 'running'
            ? 'blue'
            : entry.status === 'completed'
              ? 'green'
              : 'red';
        const tagText =
          entry.status === 'started' || entry.status === 'running'
            ? '运行'
            : entry.status === 'completed'
              ? '完成'
              : '失败';

        let elapsedPart = '';
        if (typeof entry.startTime === 'number' && entry.startTime > 0) {
          const end =
            typeof entry.endTime === 'number' && entry.endTime > 0
              ? entry.endTime
              : (nowMs ?? Date.now());
          const durationMs = Math.max(0, end - entry.startTime);
          if (durationMs > 0) {
            elapsedPart = ` <font color='grey'>(${formatDuration(durationMs)})</font>`;
          }
        }

        const isSkill =
          entry.toolName === 'Skill' ||
          entry.toolName === 'skill' ||
          entry.toolName?.toLowerCase() === 'skill';
        const displayName = isSkill && entry.skillName ? entry.skillName : entry.toolName;

        const summary = entry.description || entry.detail;
        const param = parseToolParam(entry.toolName, summary);
        let paramLine = '';
        if (param && !(isSkill && param.value === displayName)) {
          paramLine = `\n  <font color='grey'>${param.label}: ${truncate(param.value, 90)}</font>`;
        }
        const indent = entry.isNested ? '    ' : '';
        return `${indent}<text_tag color='${tagColor}'>${tagText}</text_tag> \`${displayName}\`${elapsedPart}${paramLine}`;
      });

      if (hiddenNormal > 0) {
        normalToolLines.push(
          `<font color='grey'>… 另有 ${hiddenNormal} 条工具记录已收起</font>`
        );
      }

      if (subagentEntries.length > 0) {
        sections.push(`🔨 **工具调用**\n${normalToolLines.join('\n')}`);
      } else {
        sections.push(normalToolLines.join('\n'));
      }
    } else {
      // Legacy fallback for bare test entries without start/end times or descriptions
      const normalToolLines = normalToolEntries.map((entry) => {
        if (entry.status === 'started' || entry.status === 'running') {
          return `🔨 **${entry.toolName}**: 正在执行…`;
        } else if (entry.status === 'completed') {
          return `✅ **${entry.toolName}**: 已完成`;
        } else if (entry.status === 'failed') {
          return `❌ **${entry.toolName}**: 执行失败`;
        }
        return `• **${entry.toolName}**: ${entry.status}`;
      });

      if (subagentEntries.length > 0) {
        sections.push(`🔨 **工具调用**\n${normalToolLines.join('\n')}`);
      } else {
        sections.push(normalToolLines.join('\n'));
      }
    }
  }

  return sections.join('\n\n');
}

/**
 * Build Schema 2.0 collapsible_panel element.
 * Header uses valid enum colors: "wathet-50", "blue-50", "grey", etc.
 */
export function buildCollapsibleStatusPanel(opts: {
  content: string;
  expanded?: boolean;
  elementId?: string;
  contentElementId?: string;
  title?: string;
  backgroundColor?: string;
}): Record<string, unknown> {
  const panel: Record<string, unknown> = {
    tag: 'collapsible_panel',
    expanded: opts.expanded ?? false,
    header: {
      title: {
        tag: 'markdown',
        content: opts.title ?? '**🔧 执行过程**',
      },
      background_color: opts.backgroundColor ?? 'wathet-50',
    },
    elements: [
      {
        tag: 'markdown',
        content: opts.content,
        ...(opts.contentElementId ? { element_id: opts.contentElementId } : {}),
      },
    ],
  };

  if (opts.elementId) {
    panel.element_id = opts.elementId;
  }

  return panel;
}

/**
 * Build Schema 2.0 collapsible_panel element for model thinking / reasoning.
 * Header uses "blue-50" (matching HappyClaw PANEL_TINT.thinking) or custom background_color.
 * Title defaults to "**💭 思考过程**".
 */
export function buildCollapsibleThinkingPanel(opts: {
  content: string;
  expanded?: boolean;
  elementId?: string;
  contentElementId?: string;
  title?: string;
  backgroundColor?: string;
}): Record<string, unknown> {
  const panel: Record<string, unknown> = {
    tag: 'collapsible_panel',
    expanded: opts.expanded ?? false,
    header: {
      title: {
        tag: 'markdown',
        content: opts.title ?? '**💭 思考过程**',
      },
      background_color: opts.backgroundColor ?? 'blue-50',
    },
    elements: [
      {
        tag: 'markdown',
        content: opts.content,
        ...(opts.contentElementId ? { element_id: opts.contentElementId } : {}),
      },
    ],
  };

  if (opts.elementId) {
    panel.element_id = opts.elementId;
  }

  return panel;
}

export const THINKING_MAX_CONTENT_LENGTH = 3800;
export const THINKING_TRUNCATION_NOTICE = '... (思考过程超长，已截断展示)\n\n';

/**
 * Guard thinking text to safe maximum length (default 3800 characters) for Feishu CardKit.
 * When text exceeds maxLength, truncates and prepends a notice.
 */
export function applyThinkingLengthGuard(
  text: string,
  maxLength: number = THINKING_MAX_CONTENT_LENGTH,
  notice: string = THINKING_TRUNCATION_NOTICE
): string {
  if (!text || text.length <= maxLength) {
    return text;
  }
  if (notice.length >= maxLength) {
    return text.slice(text.length - maxLength);
  }
  const allowed = maxLength - notice.length;
  return notice + text.slice(text.length - allowed);
}

/**
 * Format reasoning content during streaming (HappyClaw style).
 * Wraps text into blockquote or summarized form with safe length cap.
 */
export function formatThinkingContent(text: string, maxLength: number = 2000): string {
  const trimmed = text.trim();
  if (!trimmed) return "<font color='grey'>正在思考…</font>";
  const sliced = trimmed.length > maxLength ? '…' + trimmed.slice(-(maxLength - 1)) : trimmed;
  return sliced
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n');
}

/**
 * Strip <think>...</think> tags from text so that card body contains only the final answer.
 */
export function stripThinkingTags(text: string): string {
  if (!text || !text.includes('<think>')) return text;
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .trim();
}

/**
 * Extract reasoning from inline <think> tags if present in text.
 */
export function extractThinkingFromText(text: string): { text: string; thinking?: string } {
  if (!text || !text.includes('<think>')) return { text };
  const thinkMatches: string[] = [];
  let cleaned = text.replace(/<think>([\s\S]*?)<\/think>/gi, (_, p1) => {
    if (p1.trim()) thinkMatches.push(p1.trim());
    return '';
  });
  cleaned = cleaned.replace(/<think>([\s\S]*)$/gi, (_, p1) => {
    if (p1.trim()) thinkMatches.push(p1.trim());
    return '';
  });
  const thinking = thinkMatches.length > 0 ? thinkMatches.join('\n\n') : undefined;
  return {
    text: cleaned.trim(),
    thinking,
  };
}

/**
 * Detects if a model or model configuration supports reasoning / thinking.
 */
export function isReasoningModelOrEffort(params: {
  model?: string | null;
  reasoningEffort?: string | null;
}): boolean {
  if (params.reasoningEffort && params.reasoningEffort.trim().length > 0) {
    return true;
  }
  if (!params.model) return false;
  const m = params.model.toLowerCase().trim();
  return (
    m.includes('reasoner') ||
    m.includes('r1') ||
    m.startsWith('o1') ||
    m.startsWith('o3') ||
    m.includes('qwq')
  );
}

/**
 * Build Schema 2.0 stop reply danger button element.
 * Statically strips in final cards to prevent post-completion clicks.
 */
export function buildStopReplyButton(turnId?: string, sessionId?: string): Record<string, unknown> {
  return {
    tag: 'button',
    element_id: 'stop_reply_button',
    text: {
      tag: 'plain_text',
      content: '⏹ 停止回复',
    },
    type: 'danger',
    value: {
      action: 'stop_reply',
      ...(turnId ? { turnId } : {}),
      ...(sessionId ? { sessionId } : {}),
    },
  };
}

/**
 * Format compact usage footer metadata for final Lark cards.
 * Template: <font color='grey'>🤖 ${model} · ⏱ ${duration}s · 💡 ${promptTokens}+${completionTokens} tokens · 💰 $${cost}</font>
 * Gracefully degrades when fields are missing; returns null if no valid fields exist.
 */
export function formatCardUsageFooter(metadata?: CardFinalMetadata): string | null {
  if (!metadata) return null;

  const parts: string[] = [];

  // 1. Model
  if (typeof metadata.model === 'string' && metadata.model.trim().length > 0) {
    parts.push(`🤖 ${metadata.model.trim()}`);
  }

  // 2. Elapsed time / duration
  let durationSec: number | undefined;
  if (typeof metadata.durationSeconds === 'number' && Number.isFinite(metadata.durationSeconds) && metadata.durationSeconds >= 0) {
    durationSec = metadata.durationSeconds;
  } else if (typeof metadata.durationMs === 'number' && Number.isFinite(metadata.durationMs) && metadata.durationMs >= 0) {
    durationSec = metadata.durationMs / 1000;
  }
  if (durationSec !== undefined) {
    const rounded = Math.round(durationSec * 10) / 10;
    parts.push(`⏱ ${rounded}s`);
  }

  // 3. Tokens (prompt + completion or total)
  const hasPrompt = typeof metadata.promptTokens === 'number' && Number.isFinite(metadata.promptTokens) && metadata.promptTokens > 0;
  const hasCompletion = typeof metadata.completionTokens === 'number' && Number.isFinite(metadata.completionTokens) && metadata.completionTokens > 0;
  const hasTotal = typeof metadata.totalTokens === 'number' && Number.isFinite(metadata.totalTokens) && metadata.totalTokens > 0;

  if (hasPrompt && hasCompletion) {
    parts.push(`💡 ${metadata.promptTokens}+${metadata.completionTokens} tokens`);
  } else if (hasTotal) {
    parts.push(`💡 ${metadata.totalTokens} tokens`);
  } else if (hasPrompt) {
    parts.push(`💡 ${metadata.promptTokens} tokens`);
  } else if (hasCompletion) {
    parts.push(`💡 ${metadata.completionTokens} tokens`);
  }

  // 4. Cost (only if available from existing turn metadata; no fabricated numbers)
  if (typeof metadata.cost === 'number' && Number.isFinite(metadata.cost) && metadata.cost > 0) {
    const formattedCost = Number.isInteger(metadata.cost)
      ? String(metadata.cost)
      : String(Number(metadata.cost.toFixed(4)));
    parts.push(`💰 $${formattedCost}`);
  }

  if (parts.length === 0) {
    return null;
  }

  return `<font color='grey'>${parts.join(' · ')}</font>`;
}

export class FakeLarkTransport implements LarkTransport {
  private _connected = false;
  private readonly handlers = new Set<LarkEventHandler>();
  private readonly _sentReplies: SentReplyRecord[] = [];
  private readonly _addedReactions: FakeReactionRecord[] = [];
  private readonly _removedReactions: FakeRemovedReactionRecord[] = [];
  private readonly _streamingCalls: FakeStreamingCallRecord[] = [];
  private readonly _mockImages = new Map<string, { buffer: Buffer; mimeType: string }>();
  private readonly _mockFiles = new Map<string, { buffer: Buffer; mimeType: string }>();
  public failNextSend = false;
  public failNextSendReason = 'Simulated network timeout';
  public failDownloadImage = false;
  public failDownloadImageReason = 'Simulated image download failure';
  public failDownloadFile = false;
  public failDownloadFileReason = 'Simulated file download failure';
  public botOpenId?: string;
  public streamingCardsEnabled = true;
  public failStreamingCard = false;
  public finalizeDelayMs = 0;

  get connected(): boolean {
    return this._connected;
  }

  get sentReplies(): readonly SentReplyRecord[] {
    return this._sentReplies;
  }

  get addedReactions(): readonly FakeReactionRecord[] {
    return this._addedReactions;
  }

  get removedReactions(): readonly FakeRemovedReactionRecord[] {
    return this._removedReactions;
  }

  get streamingCalls(): readonly FakeStreamingCallRecord[] {
    return this._streamingCalls;
  }

  async start(): Promise<void> {
    this._connected = true;
  }

  async stop(): Promise<void> {
    this._connected = false;
  }

  onEvent(handler: LarkEventHandler): void {
    this.handlers.add(handler);
  }

  removeEventHandler(handler: LarkEventHandler): void {
    this.handlers.delete(handler);
  }

  async simulateInboundEvent(event: LarkRawEvent): Promise<any> {
    if (!this._connected) {
      throw new Error('FakeLarkTransport is disconnected; cannot receive inbound events');
    }
    const promises = Array.from(this.handlers).map((h) => h(event));
    const results = await Promise.all(promises);
    return results.find((r) => r && typeof r === 'object') ?? results[0];
  }

  async addReaction(messageId: string, emojiType: string): Promise<{ reactionId?: string }> {
    const reactionId = `rx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this._addedReactions.push({
      messageId,
      emojiType,
      reactionId,
      timestamp: new Date().toISOString(),
    });
    return { reactionId };
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    this._removedReactions.push({
      messageId,
      reactionId,
      timestamp: new Date().toISOString(),
    });
  }

  clearReactions(): void {
    this._addedReactions.length = 0;
    this._removedReactions.length = 0;
  }

  registerMockImage(fileKey: string, buffer: Buffer, mimeType?: string, messageId?: string): void {
    const effectiveMime = mimeType || sniffSupportedImageMime(buffer) || 'image/png';
    this._mockImages.set(fileKey, { buffer, mimeType: effectiveMime });
    if (messageId) {
      this._mockImages.set(`${messageId}:${fileKey}`, { buffer, mimeType: effectiveMime });
    }
  }

  clearMockImages(): void {
    this._mockImages.clear();
  }

  registerMockFile(fileKey: string, buffer: Buffer, mimeType?: string, messageId?: string): void {
    const effectiveMime = mimeType || (isPdfBuffer(buffer) ? 'application/pdf' : 'application/octet-stream');
    this._mockFiles.set(fileKey, { buffer, mimeType: effectiveMime });
    if (messageId) {
      this._mockFiles.set(`${messageId}:${fileKey}`, { buffer, mimeType: effectiveMime });
    }
  }

  clearMockFiles(): void {
    this._mockFiles.clear();
  }

  public maxFileDownloadBytes: number = MAX_FILE_DOWNLOAD_BYTES;

  async downloadFileResource(
    messageId: string,
    fileKey: string,
    options?: {
      declaredSize?: number;
      chunkSizeBytes?: number;
      nonRangeLimitBytes?: number;
      maxBytes?: number;
      timeoutMs?: number;
      activityTimeoutMs?: number;
    }
  ): Promise<{ buffer: Buffer; mimeType: string } | null> {
    if (!this._connected) {
      throw new Error('FakeLarkTransport is not connected');
    }
    if (this.failDownloadFile) {
      throw new Error(this.failDownloadFileReason);
    }
    if (!SAFE_RESOURCE_ID_REGEX.test(messageId) || !SAFE_RESOURCE_ID_REGEX.test(fileKey)) {
      throw new Error('Invalid resource identifier format or path traversal detected');
    }
    const effectiveMaxBytes = options?.maxBytes ?? this.maxFileDownloadBytes ?? MAX_FILE_DOWNLOAD_BYTES;
    if (typeof options?.declaredSize === 'number' && options.declaredSize > effectiveMaxBytes) {
      throw new Error(`File exceeds maximum allowed size of ${effectiveMaxBytes} bytes`);
    }
    const found = this._mockFiles.get(`${messageId}:${fileKey}`) || this._mockFiles.get(fileKey);
    if (!found) {
      return null;
    }
    if (found.buffer.length > effectiveMaxBytes) {
      throw new Error(`File exceeds maximum allowed size of ${effectiveMaxBytes} bytes`);
    }
    return { buffer: found.buffer, mimeType: found.mimeType || 'application/octet-stream' };
  }

  async downloadImageResource(
    messageId: string,
    fileKey: string
  ): Promise<{ buffer: Buffer; mimeType: string } | null> {
    if (!this._connected) {
      throw new Error('FakeLarkTransport is not connected');
    }
    if (this.failDownloadImage) {
      throw new Error(this.failDownloadImageReason);
    }
    if (!SAFE_RESOURCE_ID_REGEX.test(messageId) || !SAFE_RESOURCE_ID_REGEX.test(fileKey)) {
      throw new Error('Invalid resource identifier format or path traversal detected');
    }
    const found = this._mockImages.get(`${messageId}:${fileKey}`) || this._mockImages.get(fileKey);
    if (!found) {
      return null;
    }
    const sniffed = sniffSupportedImageMime(found.buffer);
    if (!sniffed) {
      throw new Error('Unsupported image format or invalid image magic bytes');
    }
    return { buffer: found.buffer, mimeType: sniffed };
  }

  async sendReply(params: {
    chatId: string;
    rootId?: string;
    threadId?: string;
    replyToMessageId?: string;
    content: string;
    format?: 'plain' | 'markdown';
    uuid?: string;
  }): Promise<OutboundReplyResult> {
    if (!this._connected) {
      return {
        success: false,
        error: 'FakeLarkTransport is not connected',
      };
    }

    if (this.failNextSend) {
      this.failNextSend = false;
      return {
        success: false,
        error: this.failNextSendReason,
      };
    }

    const replyMsgId = `om_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record: SentReplyRecord = {
      chatId: params.chatId,
      rootId: params.rootId,
      threadId: params.threadId,
      replyToMessageId: params.replyToMessageId,
      content: params.content,
      format: params.format ?? 'plain',
      uuid: params.uuid,
      timestamp: new Date().toISOString(),
      messageId: replyMsgId,
    };
    this._sentReplies.push(record);

    return {
      success: true,
      messageId: replyMsgId,
    };
  }

  async createStreamingCard(params: {
    chatId: string;
    replyToMessageId?: string;
    rootId?: string;
    threadId?: string;
    title?: string;
    statusPanelTitle?: string;
    withStatusPanel?: boolean;
    collapsibleToolStatus?: boolean;
    withThinkingPanel?: boolean;
    collapsibleThinking?: boolean;
    expandStatusPanel?: boolean;
    expandThinkingPanel?: boolean;
    withStatusBar?: boolean;
    withStopButton?: boolean;
    turnId?: string;
    sessionId?: string;
  }): Promise<LarkStreamingCardSession | null> {
    if (!this._connected || !this.streamingCardsEnabled || this.failStreamingCard) {
      console.warn('[lark-stream] createStreamingCard returned null', {
        connected: this._connected,
        streamingCardsEnabled: this.streamingCardsEnabled,
        failStreamingCard: this.failStreamingCard,
      });
      return null;
    }

    const cardId = `crd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const messageId = `om_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const withThinking = Boolean(params.withThinkingPanel ?? params.collapsibleThinking);
    const withStatus = Boolean(params.withStatusPanel ?? params.collapsibleToolStatus);
    const withStatusBar = Boolean(params.withStatusBar);
    const expandThinking = params.expandThinkingPanel ?? true;
    const expandStatus = params.expandStatusPanel ?? true;
    const withStop = params.withStopButton ?? Boolean(params.turnId || params.sessionId);

    const initialElements: Array<Record<string, unknown>> = [];
    if (withThinking) {
      initialElements.push(
        buildCollapsibleThinkingPanel({
          content: "<font color='grey'>尚未开始思考…</font>",
          expanded: expandThinking,
          elementId: 'thinking_panel',
          contentElementId: 'thinking_content',
          title: '**💭 思考过程**',
          backgroundColor: 'blue-50',
        })
      );
    }
    if (withStatus) {
      initialElements.push(
        buildCollapsibleStatusPanel({
          content: "<font color='grey'>尚未调用工具…</font>",
          expanded: expandStatus,
          elementId: 'tool_status_panel',
          contentElementId: 'tool_status_content',
          title: params.statusPanelTitle ?? '**🔧 执行过程**',
          backgroundColor: 'wathet-50',
        })
      );
    }
    initialElements.push({
      tag: 'markdown',
      element_id: 'main_content',
      content: '正在思考…',
    });
    if (withStatusBar) {
      initialElements.push({
        tag: 'markdown',
        element_id: 'streaming_status_bar',
        text_size: 'notation',
        content: buildStreamingStatusLine({ elapsedMs: 0, nowMs: Date.now() }),
      });
    }
    if (withStop) {
      initialElements.push(buildStopReplyButton(params.turnId, params.sessionId));
    }

    const initialCard = {
      schema: '2.0',
      config: {
        update_multi: true,
        streaming_mode: true,
      },
      header: {
        title: {
          tag: 'plain_text',
          content: params.title ?? 'Enkeep',
        },
        template: 'blue',
      },
      body: {
        direction: 'vertical',
        elements: initialElements,
      },
    };

    this._streamingCalls.push({
      type: 'card_create',
      cardId,
      messageId,
      params,
      card: initialCard,
      timestamp: new Date().toISOString(),
    });

    const session: LarkStreamingCardSession = {
      cardId,
      messageId,
      pushText: async (accumulatedText: string, toolStatus?: string, thinkingText?: string, statusLine?: string): Promise<void> => {
        this._streamingCalls.push({
          type: 'push',
          cardId,
          messageId,
          content: accumulatedText,
          toolStatus,
          thinkingText,
          statusLine,
          timestamp: new Date().toISOString(),
        });
      },
      pushToolStatus: async (statusText: string): Promise<void> => {
        this._streamingCalls.push({
          type: 'push_status',
          cardId,
          messageId,
          content: statusText,
          timestamp: new Date().toISOString(),
        });
      },
      pushThinking: async (thinkingText: string): Promise<void> => {
        this._streamingCalls.push({
          type: 'push_thinking',
          cardId,
          messageId,
          content: thinkingText,
          timestamp: new Date().toISOString(),
        });
      },
      pushStatusLine: async (statusText: string): Promise<void> => {
        this._streamingCalls.push({
          type: 'push_status_line',
          cardId,
          messageId,
          content: statusText,
          timestamp: new Date().toISOString(),
        });
      },
      finalize: async (
        finalText: string,
        status: 'completed' | 'failed' | 'stopped',
        metadata?: CardFinalMetadata,
        toolStatus?: string | readonly CardToolStatusEntry[],
        thinkingText?: string
      ): Promise<void> => {
        if (this.finalizeDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.finalizeDelayMs));
        }

        let cleanFinalText = finalText;
        let cleanThinking = thinkingText?.trim();
        if (cleanFinalText && cleanFinalText.includes('<think>')) {
          const extracted = extractThinkingFromText(cleanFinalText);
          cleanFinalText = extracted.text;
          if (!cleanThinking && extracted.thinking) {
            cleanThinking = extracted.thinking;
          }
        }

        const bodyElements: Array<Record<string, unknown> | LarkCardBodyElement> = [];
        let hasProcessArea = false;

        // 1. Thinking panel: placed ABOVE process panel/body; collapsed in final card (expanded: false)
        if (cleanThinking) {
          const guardedThinking = applyThinkingLengthGuard(cleanThinking);
          bodyElements.push(
            buildCollapsibleThinkingPanel({
              content: guardedThinking,
              expanded: false, // collapsed on completion
              title: '**💭 思考过程**',
              backgroundColor: 'blue-50',
            })
          );
          hasProcessArea = true;
        }

        // 2. Process panel (tool status panel)
        const formattedToolStatus = formatToolStatusMarkdown(toolStatus);
        if (formattedToolStatus) {
          bodyElements.push(
            buildCollapsibleStatusPanel({
              content: formattedToolStatus,
              expanded: false, // collapsed on completion
              title: params.statusPanelTitle ?? '**🔧 执行过程**',
              backgroundColor: 'wathet-50',
            })
          );
          hasProcessArea = true;
        }

        if (hasProcessArea) {
          bodyElements.push({ tag: 'hr' });
        }

        const emptyFallback = status === 'stopped' ? '(已停止回复)' : '(空回复)';
        const contentElements = markdownToCardElements(cleanFinalText, {
          maxChunkLen: 4000,
          emptyFallback,
        });
        if (contentElements.length === 0) {
          bodyElements.push({
            tag: 'markdown',
            content: emptyFallback,
          });
        } else {
          for (const el of contentElements) {
            bodyElements.push(el);
          }
        }

        if (status === 'stopped') {
          bodyElements.push({
            tag: 'markdown',
            element_id: 'streaming_status_bar',
            text_size: 'notation',
            content: "<font color='grey'>⏹ 已停止</font>",
          });
        }

        const footer = formatCardUsageFooter(metadata);
        if (footer) {
          bodyElements.push({
            tag: 'markdown',
            text_size: 'notation',
            content: footer,
          });
        }

        const card = {
          schema: '2.0',
          header:
            status === 'completed'
              ? {
                  title: { tag: 'plain_text', content: params.title ?? '已完成' },
                  template: 'violet',
                }
              : status === 'stopped'
                ? {
                    title: {
                      tag: 'plain_text',
                      content: params.title ? `${params.title} (已中止)` : '已中止',
                    },
                    template: 'orange',
                  }
                : {
                    title: {
                      tag: 'plain_text',
                      content: params.title ? `${params.title} (处理失败)` : '处理失败',
                    },
                    template: 'red',
                  },
          body: {
            direction: 'vertical',
            elements: bodyElements,
          },
        };

        this._streamingCalls.push({
          type: 'finalize',
          cardId,
          messageId,
          content: finalText,
          status,
          metadata,
          toolStatus,
          card,
          timestamp: new Date().toISOString(),
        });
      },
    };

    return session;
  }

  simulateDisconnect(): void {
    this._connected = false;
  }

  simulateReconnect(): void {
    this._connected = true;
  }

  clearSentReplies(): void {
    this._sentReplies.length = 0;
    this._streamingCalls.length = 0;
  }

  clearStreamingCalls(): void {
    this._streamingCalls.length = 0;
  }
}

export interface CredentialedLarkTransportOptions {
  account: LarkAccountConfig;
  credentialResolver?: LarkCredentialResolver;
  clientFactory?: LarkSdkClientFactory;
  autoConnect?: boolean;
  apiClient?: any;
}

/**
 * Production Lark Transport using official @larksuiteoapi/node-sdk.
 * Credentials resolved via injected resolver. Supports domain selection (Feishu vs Lark),
 * WSClient long-connection with 15000ms handshake timeout, SanitizedLarkLogger to prevent credential leakage,
 * real onReady lifecycle, openapi Client for replies with stable uuid idempotency, bounded HTTP timeout, and bot identity resolution.
 */
export class CredentialedLarkTransport implements LarkTransport {
  private readonly account: LarkAccountConfig;
  private readonly credentialResolver?: LarkCredentialResolver;
  private readonly clientFactory?: LarkSdkClientFactory;
  private _connected = false;
  private _connecting = false;
  private readonly handlers = new Set<LarkEventHandler>();
  private wsClient: ILarkWSClient | null = null;
  private apiClient: any = null;
  private _resolvedBotOpenId?: string;
  private readonly logger = new SanitizedLarkLogger();

  constructor(options: LarkAccountConfig | CredentialedLarkTransportOptions) {
    if ('account' in options) {
      this.account = options.account;
      this.credentialResolver = options.credentialResolver;
      this.clientFactory = options.clientFactory;
      if (options.apiClient) {
        this.apiClient = options.apiClient;
        this._connected = true;
      }
    } else {
      this.account = options;
    }
    this._resolvedBotOpenId = this.account.botOpenId;
  }

  get connected(): boolean {
    if (this.wsClient && typeof this.wsClient.getConnectionStatus === 'function') {
      const status = this.wsClient.getConnectionStatus();
      if (typeof status === 'object' && status !== null && 'state' in status) {
        return status.state === 'connected';
      }
      return status === 'connected';
    }
    return this._connected;
  }

  get connecting(): boolean {
    return this._connecting;
  }

  get botOpenId(): string | undefined {
    return this._resolvedBotOpenId || this.account.botOpenId;
  }

  get skipReason(): string {
    return REAL_LARK_CREDENTIAL_SKIP_REASON;
  }

  get acceptanceStatus(): typeof REAL_LARK_CREDENTIAL_ACCEPTANCE {
    return REAL_LARK_CREDENTIAL_ACCEPTANCE;
  }

  async start(): Promise<void> {
    if (this.apiClient) {
      this._connected = true;
      return;
    }
    // 1. Resolve credentials
    let appId = this.account.appId;
    let appSecret = this.account.appSecret;
    let brand = this.account.brand ?? 'feishu';

    if (this.credentialResolver && this.account.credentialRef) {
      const resolved = await this.credentialResolver.resolve(
        this.account.userId,
        this.account.credentialRef
      );
      if (resolved) {
        appId = resolved.appId;
        appSecret = resolved.appSecret;
        if (resolved.domain) {
          brand = resolved.domain;
        }
        if (resolved.botOpenId) {
          this._resolvedBotOpenId = resolved.botOpenId;
        }
      }
    }

    if (!appId || !appSecret) {
      // In absence of valid appId/appSecret, do not fake online.
      this._connected = false;
      this._connecting = false;
      return;
    }

    const domain = brand === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;
    const boundedHttpInstance = createBoundedHttpInstance(15000);
    const sanitizedLogger = this.logger;

    // 2. Initialize API Client with sanitized logger
    if (this.clientFactory) {
      this.apiClient = this.clientFactory.createClient({ appId, appSecret, domain });
    } else {
      this.apiClient = new lark.Client({
        appId,
        appSecret,
        domain,
        httpInstance: boundedHttpInstance,
        logger: sanitizedLogger,
        loggerLevel: lark.LoggerLevel.error,
      });
    }

    // 2b. If botOpenId not provided, query /open-apis/bot/v3/info
    if (!this._resolvedBotOpenId && this.apiClient) {
      try {
        if (typeof this.apiClient.request === 'function') {
          const infoRes = await this.apiClient.request({
            url: '/open-apis/bot/v3/info',
            method: 'GET',
          });
          if (infoRes?.bot?.open_id) {
            this._resolvedBotOpenId = infoRes.bot.open_id;
          }
        }
      } catch {
        // Fall back to mentions by appId if bot/v3/info query fails or in mock
      }
    }

    // 3. Initialize Event Dispatcher & WSClient with sanitized logger and 15000ms handshakeTimeoutMs
    const eventDispatcher = new lark.EventDispatcher({
      logger: sanitizedLogger,
    } as any).register({
      'im.message.receive_v1': async (data: any) => {
        // SDK EventDispatcher provides flattened data (data.sender, data.message, data.event_id, etc.)
        const rawEvent: LarkRawEvent = {
          header: data.header ?? {
            event_id: data.event_id,
            event_type: data.event_type ?? 'im.message.receive_v1',
            create_time: data.create_time,
            token: data.token,
            app_id: data.app_id,
            tenant_key: data.tenant_key,
          },
          event: data.event ?? {
            sender: data.sender,
            message: data.message,
          },
          sender: data.sender ?? data.event?.sender,
          message: data.message ?? data.event?.message,
          uuid: data.uuid,
        };
        const promises = Array.from(this.handlers).map((h) => h(rawEvent));
        await Promise.all(promises);
      },
      'card.action.trigger': async (data: any) => {
        const rawEvent: LarkRawEvent = {
          header: data.header ?? {
            event_id: data.event_id ?? (data.context?.open_message_id ? `act_${data.context.open_message_id}_${Date.now()}` : undefined),
            event_type: 'card.action.trigger',
            create_time: data.create_time,
            token: data.token,
            app_id: data.app_id,
            tenant_key: data.tenant_key,
          },
          action: data.action,
          operator: data.operator,
          context: data.context,
          open_message_id: data.open_message_id ?? data.context?.open_message_id,
          open_chat_id: data.open_chat_id ?? data.context?.open_chat_id,
          open_id: data.operator?.open_id ?? data.open_id,
        };
        const results = await Promise.all(Array.from(this.handlers).map((h) => h(rawEvent)));
        const resWithToast = results.find((r) => r && typeof r === 'object' && ('toast' in r || 'card' in r));
        return resWithToast ?? {};
      },
    });

    const onReadyCallback = () => {
      this._connected = true;
      this._connecting = false;
    };
    const onErrorCallback = (_err: Error) => {
      this._connected = false;
    };
    const onReconnectingCallback = () => {
      this._connected = false;
      this._connecting = true;
    };
    const onReconnectedCallback = () => {
      this._connected = true;
      this._connecting = false;
    };

    this._connecting = true;
    try {
      if (this.clientFactory && this.clientFactory.createWSClient) {
        this.wsClient = this.clientFactory.createWSClient({
          appId,
          appSecret,
          domain,
          logger: sanitizedLogger,
          loggerLevel: lark.LoggerLevel.error,
          handshakeTimeoutMs: 15000,
          onReady: onReadyCallback,
          onError: onErrorCallback,
          onReconnecting: onReconnectingCallback,
          onReconnected: onReconnectedCallback,
        });
      } else {
        this.wsClient = new lark.WSClient({
          appId,
          appSecret,
          domain,
          httpInstance: boundedHttpInstance,
          logger: sanitizedLogger,
          loggerLevel: lark.LoggerLevel.error,
          handshakeTimeoutMs: 15000,
          onReady: onReadyCallback,
          onError: onErrorCallback,
          onReconnecting: onReconnectingCallback,
          onReconnected: onReconnectedCallback,
        });
      }

      // Start WSClient with eventDispatcher
      if (this.wsClient && typeof this.wsClient.start === 'function') {
        await this.wsClient.start({ eventDispatcher });
      }

      // If WSClient provides getConnectionStatus, check if state is connected
      if (this.wsClient && typeof this.wsClient.getConnectionStatus === 'function') {
        const status = this.wsClient.getConnectionStatus();
        if (typeof status === 'object' && status !== null && 'state' in status) {
          this._connected = status.state === 'connected';
        }
      }
      this._connecting = false;
    } catch (err) {
      this._connected = false;
      this._connecting = false;
      throw err;
    }
  }

  async stop(): Promise<void> {
    this._connected = false;
    this._connecting = false;
    if (this.wsClient) {
      try {
        if (typeof this.wsClient.close === 'function') {
          await this.wsClient.close();
        }
      } catch {
        // Ignore close error on shutdown
      }
      this.wsClient = null;
    }
    this.apiClient = null;
  }

  onEvent(handler: LarkEventHandler): void {
    this.handlers.add(handler);
  }

  removeEventHandler(handler: LarkEventHandler): void {
    this.handlers.delete(handler);
  }

  async addReaction(messageId: string, emojiType: string): Promise<{ reactionId?: string }> {
    if (!this.apiClient) {
      return {};
    }
    try {
      const reactionApi = this.apiClient.im?.v1?.messageReaction || this.apiClient.im?.messageReaction;
      if (!reactionApi || typeof reactionApi.create !== 'function') {
        return {};
      }
      const res = await reactionApi.create({
        path: {
          message_id: messageId,
        },
        data: {
          reaction_type: {
            emoji_type: emojiType,
          },
        },
      });
      const reactionId = res?.data?.reaction_id;
      return { reactionId };
    } catch {
      return {};
    }
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    if (!this.apiClient || !reactionId) {
      return;
    }
    try {
      const reactionApi = this.apiClient.im?.v1?.messageReaction || this.apiClient.im?.messageReaction;
      if (!reactionApi || typeof reactionApi.delete !== 'function') {
        return;
      }
      await reactionApi.delete({
        path: {
          message_id: messageId,
          reaction_id: reactionId,
        },
      });
    } catch {
      // Best-effort; ignore errors
    }
  }

  private async downloadBoundedResourceStream(
    resourceApi: any,
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    timeoutMs: number,
    maxBytes: number
  ): Promise<Buffer | null> {
    const overallDeadline = Date.now() + timeoutMs;

    let preHeadersTimer: NodeJS.Timeout | undefined;
    const preHeadersPromise = resourceApi.get({
      path: {
        message_id: messageId,
        file_key: fileKey,
      },
      params: {
        type,
      },
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      preHeadersTimer = setTimeout(() => {
        reject(new Error(`${type === 'image' ? 'Image' : 'File'} resource download timed out waiting for headers`));
      }, timeoutMs);
    });

    let res: any;
    try {
      res = await Promise.race([preHeadersPromise, timeoutPromise]);
    } finally {
      if (preHeadersTimer) clearTimeout(preHeadersTimer);
    }

    if (!res) {
      return null;
    }

    let buffer: Buffer;
    let activeStream: any = null;
    let streamTimer: NodeJS.Timeout | undefined;

    try {
      if (typeof res.getReadableStream === 'function') {
        const stream = res.getReadableStream();
        activeStream = stream;
        const chunks: Buffer[] = [];
        let totalBytes = 0;

        const activityTimeoutMs = FILE_ACTIVITY_TIMEOUT_MS;

        await new Promise<void>((resolve, reject) => {
          const resetActivityTimer = () => {
            if (streamTimer) clearTimeout(streamTimer);
            const timeLeft = overallDeadline - Date.now();
            if (timeLeft <= 0) {
              const timeoutErr = new Error(`${type === 'image' ? 'Image' : 'File'} resource download body stream timed out`);
              if (typeof stream.destroy === 'function') {
                stream.destroy(timeoutErr);
              }
              reject(timeoutErr);
              return;
            }
            const delay = Math.min(activityTimeoutMs, timeLeft);
            streamTimer = setTimeout(() => {
              const timeoutErr = new Error(`${type === 'image' ? 'Image' : 'File'} resource download body stream timed out`);
              if (typeof stream.destroy === 'function') {
                stream.destroy(timeoutErr);
              }
              reject(timeoutErr);
            }, delay);
          };

          resetActivityTimer();

          const onData = (chunk: any) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += buf.length;
            if (totalBytes > maxBytes) {
              cleanup();
              const sizeErr = new Error(`${type === 'image' ? 'Image' : 'File'} exceeds maximum allowed size of ${maxBytes} bytes`);
              if (typeof stream.destroy === 'function') {
                stream.destroy(sizeErr);
              }
              reject(sizeErr);
              return;
            }
            chunks.push(buf);
            resetActivityTimer();
          };

          const onError = (err: any) => {
            cleanup();
            reject(err);
          };

          const onEnd = () => {
            cleanup();
            resolve();
          };

          const cleanup = () => {
            if (streamTimer) clearTimeout(streamTimer);
            stream.removeListener('data', onData);
            stream.removeListener('end', onEnd);
            stream.on('error', () => {});
            stream.removeListener('error', onError);
          };

          stream.on('data', onData);
          stream.on('error', onError);
          stream.on('end', onEnd);
        });

        buffer = Buffer.concat(chunks);
      } else if (Buffer.isBuffer(res)) {
        buffer = res;
      } else if (Buffer.isBuffer((res as any).data)) {
        buffer = (res as any).data;
      } else {
        throw new Error('Unsupported response format from messageResource.get');
      }

      if (buffer.length > maxBytes) {
        throw new Error(`${type === 'image' ? 'Image' : 'File'} exceeds maximum allowed size of ${maxBytes} bytes`);
      }

      return buffer;
    } catch (streamErr) {
      if (activeStream && typeof activeStream.destroy === 'function' && !activeStream.destroyed) {
        activeStream.destroy(streamErr);
      }
      throw streamErr;
    } finally {
      if (streamTimer) clearTimeout(streamTimer);
    }
  }

  async downloadImageResource(
    messageId: string,
    fileKey: string
  ): Promise<{ buffer: Buffer; mimeType: string } | null> {
    if (!this.apiClient) {
      return null;
    }
    if (!SAFE_RESOURCE_ID_REGEX.test(messageId) || !SAFE_RESOURCE_ID_REGEX.test(fileKey)) {
      throw new Error('Invalid resource identifier format or path traversal detected');
    }

    const resourceApi =
      this.apiClient.im?.v1?.messageResource || (this.apiClient.im as any)?.messageResource;
    if (!resourceApi || typeof resourceApi.get !== 'function') {
      throw new Error('Feishu/Lark SDK im.messageResource API not available');
    }

    const buffer = await this.downloadBoundedResourceStream(
      resourceApi,
      messageId,
      fileKey,
      'image',
      IMAGE_DOWNLOAD_TIMEOUT_MS,
      MAX_IMAGE_DOWNLOAD_BYTES
    );
    if (!buffer) {
      return null;
    }

    const mimeType = sniffSupportedImageMime(buffer);
    if (!mimeType) {
      throw new Error('Unsupported image format or invalid image magic bytes');
    }

    return { buffer, mimeType };
  }

  async downloadFileResource(
    messageId: string,
    fileKey: string,
    options?: {
      declaredSize?: number;
      chunkSizeBytes?: number;
      nonRangeLimitBytes?: number;
      maxBytes?: number;
      timeoutMs?: number;
      activityTimeoutMs?: number;
    }
  ): Promise<{ buffer: Buffer; mimeType: string } | null> {
    if (!this.apiClient) {
      return null;
    }
    if (!SAFE_RESOURCE_ID_REGEX.test(messageId) || !SAFE_RESOURCE_ID_REGEX.test(fileKey)) {
      throw new Error('Invalid resource identifier format or path traversal detected');
    }

    const resourceApi =
      this.apiClient.im?.v1?.messageResource || (this.apiClient.im as any)?.messageResource;
    if (!resourceApi || typeof resourceApi.get !== 'function') {
      throw new Error('Feishu/Lark SDK im.messageResource API not available');
    }

    const effectiveMaxBytes = options?.maxBytes ?? resolveMaxInboundFileBytes();
    const effectiveTimeoutMs = options?.timeoutMs ?? FILE_DOWNLOAD_TIMEOUT_MS;
    const effectiveActivityTimeoutMs = options?.activityTimeoutMs ?? FILE_ACTIVITY_TIMEOUT_MS;
    const effectiveNonRangeLimit = options?.nonRangeLimitBytes ??
      (process.env.ENKEEP_LARK_NON_RANGE_MAX_BYTES
        ? parseInt(process.env.ENKEEP_LARK_NON_RANGE_MAX_BYTES, 10)
        : LARK_NON_RANGE_MAX_FILE_BYTES);
    const effectiveChunkSize = options?.chunkSizeBytes ??
      (process.env.ENKEEP_LARK_DOWNLOAD_CHUNK_BYTES
        ? parseInt(process.env.ENKEEP_LARK_DOWNLOAD_CHUNK_BYTES, 10)
        : LARK_DOWNLOAD_CHUNK_SIZE_BYTES);

    const overallDeadline = Date.now() + effectiveTimeoutMs;

    if (typeof options?.declaredSize === 'number' && options.declaredSize > effectiveMaxBytes) {
      throw new Error(`File exceeds maximum allowed size of ${effectiveMaxBytes} bytes`);
    }

    const tempFilePath = path.join(
      os.tmpdir(),
      `enkeep_lark_${messageId}_${fileKey}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.tmp`
    );

    const knownLarge = typeof options?.declaredSize === 'number' && options.declaredSize >= effectiveNonRangeLimit;

    try {
      if (knownLarge) {
        await this.downloadFileRangedChunksToTempFile({
          resourceApi,
          messageId,
          fileKey,
          tempFilePath,
          chunkSize: effectiveChunkSize,
          maxBytes: effectiveMaxBytes,
          activityTimeoutMs: effectiveActivityTimeoutMs,
          overallDeadline,
        });
      } else {
        let mustFallbackToRanged = false;
        try {
          await this.downloadFileNonRangeToTempFile({
            resourceApi,
            messageId,
            fileKey,
            tempFilePath,
            maxBytes: effectiveMaxBytes,
            activityTimeoutMs: effectiveActivityTimeoutMs,
            overallDeadline,
          });
        } catch (err: any) {
          if (await isFeishuSizeLimitError(err)) {
            mustFallbackToRanged = true;
            try { await fs.promises.unlink(tempFilePath); } catch {}
          } else {
            throw err;
          }
        }

        if (mustFallbackToRanged) {
          await this.downloadFileRangedChunksToTempFile({
            resourceApi,
            messageId,
            fileKey,
            tempFilePath,
            chunkSize: effectiveChunkSize,
            maxBytes: effectiveMaxBytes,
            activityTimeoutMs: effectiveActivityTimeoutMs,
            overallDeadline,
          });
        }
      }

      const stat = await fs.promises.stat(tempFilePath);
      if (stat.size > effectiveMaxBytes) {
        throw new Error(`File exceeds maximum allowed size of ${effectiveMaxBytes} bytes`);
      }

      const buffer = await fs.promises.readFile(tempFilePath);
      const mimeType = isPdfBuffer(buffer) ? 'application/pdf' : 'application/octet-stream';
      return { buffer, mimeType };
    } finally {
      try {
        await fs.promises.unlink(tempFilePath);
      } catch {}
    }
  }

  private async downloadFileNonRangeToTempFile(params: {
    resourceApi: any;
    messageId: string;
    fileKey: string;
    tempFilePath: string;
    maxBytes: number;
    activityTimeoutMs: number;
    overallDeadline: number;
  }): Promise<void> {
    const { resourceApi, messageId, fileKey, tempFilePath, maxBytes, activityTimeoutMs, overallDeadline } = params;
    const timeLeft = overallDeadline - Date.now();
    if (timeLeft <= 0) {
      throw new Error('File resource download timed out before request');
    }

    let preHeadersTimer: NodeJS.Timeout | undefined;
    const preHeadersPromise = resourceApi.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: 'file' },
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      preHeadersTimer = setTimeout(() => {
        reject(new Error('File resource download timed out waiting for headers'));
      }, Math.min(60000, timeLeft));
    });

    let res: any;
    try {
      res = await Promise.race([preHeadersPromise, timeoutPromise]);
    } finally {
      if (preHeadersTimer) clearTimeout(preHeadersTimer);
    }

    if (!res) {
      throw new Error(`Resource not found for key ${fileKey}`);
    }

    const contentType = res.headers?.['content-type'] || res.headers?.['Content-Type'] || '';
    if (contentType.includes('application/json')) {
      if (typeof res.getReadableStream === 'function') {
        const stream = res.getReadableStream();
        const jsonChunks: Buffer[] = [];
        for await (const chunk of stream) {
          jsonChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const text = Buffer.concat(jsonChunks).toString('utf8');
        try {
          const parsedJson = JSON.parse(text);
          if (parsedJson.code === 234037 || String(parsedJson.msg).toLowerCase().includes('size exceeds limit')) {
            const sizeErr: any = new Error(parsedJson.msg || 'Downloaded file size exceeds limit');
            sizeErr.code = 234037;
            throw sizeErr;
          }
          if (parsedJson.code !== 0) {
            throw new Error(`Feishu API error ${parsedJson.code}: ${parsedJson.msg}`);
          }
        } catch (e: any) {
          if (e.code === 234037) throw e;
        }
      }
    }

    if (typeof res.getReadableStream === 'function') {
      const stream = res.getReadableStream();
      await this.pipeStreamToTempFile({
        stream,
        tempFilePath,
        maxBytes,
        activityTimeoutMs,
        overallDeadline,
        flags: 'w',
      });
    } else if (Buffer.isBuffer(res)) {
      if (res.length > maxBytes) {
        throw new Error(`File exceeds maximum allowed size of ${maxBytes} bytes`);
      }
      await fs.promises.writeFile(tempFilePath, res);
    } else if (Buffer.isBuffer((res as any).data)) {
      if ((res as any).data.length > maxBytes) {
        throw new Error(`File exceeds maximum allowed size of ${maxBytes} bytes`);
      }
      await fs.promises.writeFile(tempFilePath, (res as any).data);
    } else {
      throw new Error('Unsupported response format from messageResource.get');
    }
  }

  private async downloadFileRangedChunksToTempFile(params: {
    resourceApi: any;
    messageId: string;
    fileKey: string;
    tempFilePath: string;
    chunkSize: number;
    maxBytes: number;
    activityTimeoutMs: number;
    overallDeadline: number;
  }): Promise<void> {
    const { resourceApi, messageId, fileKey, tempFilePath, chunkSize, maxBytes, activityTimeoutMs, overallDeadline } = params;

    let offset = 0;
    let totalFileSize: number | null = null;
    let accumulatedTotalBytes = 0;

    while (true) {
      if (Date.now() >= overallDeadline) {
        throw new Error('File resource download body stream timed out');
      }

      let end = offset + chunkSize - 1;
      if (totalFileSize !== null && end >= totalFileSize) {
        end = totalFileSize - 1;
      }
      if (totalFileSize !== null && offset >= totalFileSize) {
        break;
      }

      const rangeHeader = `bytes=${offset}-${end}`;

      let chunkRes: any = null;
      let lastErr: any = null;

      for (let attempt = 1; attempt <= LARK_CHUNK_RETRY_COUNT; attempt++) {
        const timeLeft = overallDeadline - Date.now();
        if (timeLeft <= 0) {
          throw new Error('File resource download body stream timed out');
        }

        try {
          let preHeadersTimer: NodeJS.Timeout | undefined;
          const preHeadersPromise = resourceApi.get(
            {
              path: { message_id: messageId, file_key: fileKey },
              params: { type: 'file' },
            },
            {
              headers: {
                Range: rangeHeader,
              },
            }
          );

          const timeoutPromise = new Promise<never>((_, reject) => {
            preHeadersTimer = setTimeout(() => {
              reject(new Error('File resource chunk download timed out waiting for headers'));
            }, Math.min(30000, timeLeft));
          });

          try {
            chunkRes = await Promise.race([preHeadersPromise, timeoutPromise]);
          } finally {
            if (preHeadersTimer) clearTimeout(preHeadersTimer);
          }

          if (!chunkRes) {
            throw new Error(`Resource chunk not found for key ${fileKey} at ${rangeHeader}`);
          }
          break;
        } catch (err: any) {
          lastErr = err;
          if (attempt >= LARK_CHUNK_RETRY_COUNT || Date.now() >= overallDeadline) {
            throw lastErr;
          }
          const backoffMs = LARK_CHUNK_INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }

      const contentRangeHeader =
        chunkRes.headers?.['content-range'] || chunkRes.headers?.['Content-Range'] || '';
      if (contentRangeHeader) {
        const match = String(contentRangeHeader).match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
        if (match) {
          const totalStr = match[3];
          if (totalStr !== '*') {
            totalFileSize = parseInt(totalStr, 10);
            if (totalFileSize > maxBytes) {
              throw new Error(`File exceeds maximum allowed size of ${maxBytes} bytes`);
            }
          }
        }
      }

      let bytesInChunk = 0;
      if (typeof chunkRes.getReadableStream === 'function') {
        const stream = chunkRes.getReadableStream();
        bytesInChunk = await this.pipeStreamToTempFile({
          stream,
          tempFilePath,
          maxBytes: maxBytes - accumulatedTotalBytes,
          activityTimeoutMs,
          overallDeadline,
          flags: 'a',
        });
      } else if (Buffer.isBuffer(chunkRes)) {
        bytesInChunk = chunkRes.length;
        if (accumulatedTotalBytes + bytesInChunk > maxBytes) {
          throw new Error(`File exceeds maximum allowed size of ${maxBytes} bytes`);
        }
        await fs.promises.appendFile(tempFilePath, chunkRes);
      } else if (Buffer.isBuffer((chunkRes as any).data)) {
        const buf = (chunkRes as any).data;
        bytesInChunk = buf.length;
        if (accumulatedTotalBytes + bytesInChunk > maxBytes) {
          throw new Error(`File exceeds maximum allowed size of ${maxBytes} bytes`);
        }
        await fs.promises.appendFile(tempFilePath, buf);
      } else {
        throw new Error('Unsupported chunk response format from messageResource.get');
      }

      accumulatedTotalBytes += bytesInChunk;
      offset += bytesInChunk;

      if (accumulatedTotalBytes > maxBytes) {
        throw new Error(`File exceeds maximum allowed size of ${maxBytes} bytes`);
      }

      if (bytesInChunk === 0) {
        break;
      }

      if (totalFileSize !== null && offset >= totalFileSize) {
        break;
      }

      const requestedRangeLength = end - (offset - bytesInChunk) + 1;
      if (bytesInChunk < requestedRangeLength) {
        break;
      }
    }
  }

  private async pipeStreamToTempFile(params: {
    stream: any;
    tempFilePath: string;
    maxBytes: number;
    activityTimeoutMs: number;
    overallDeadline: number;
    flags: 'w' | 'a';
  }): Promise<number> {
    const { stream, tempFilePath, maxBytes, activityTimeoutMs, overallDeadline, flags } = params;
    let streamTimer: NodeJS.Timeout | undefined;
    let bytesWritten = 0;
    const writeStream = fs.createWriteStream(tempFilePath, { flags });

    return await new Promise<number>((resolve, reject) => {
      const resetActivityTimer = () => {
        if (streamTimer) clearTimeout(streamTimer);
        const timeLeft = overallDeadline - Date.now();
        if (timeLeft <= 0) {
          const timeoutErr = new Error('File resource download body stream timed out');
          cleanup();
          try { stream.destroy(timeoutErr); } catch {}
          try { writeStream.destroy(timeoutErr); } catch {}
          reject(timeoutErr);
          return;
        }
        const delay = Math.min(activityTimeoutMs, timeLeft);
        streamTimer = setTimeout(() => {
          const timeoutErr = new Error('File resource download body stream timed out');
          cleanup();
          try { stream.destroy(timeoutErr); } catch {}
          try { writeStream.destroy(timeoutErr); } catch {}
          reject(timeoutErr);
        }, delay);
      };

      resetActivityTimer();

      const onData = (chunk: any) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesWritten += buf.length;
        if (bytesWritten > maxBytes) {
          cleanup();
          const sizeErr = new Error(`File exceeds maximum allowed size of ${maxBytes} bytes`);
          try { stream.destroy(sizeErr); } catch {}
          try { writeStream.destroy(sizeErr); } catch {}
          reject(sizeErr);
          return;
        }
        writeStream.write(buf);
        resetActivityTimer();
      };

      const onError = (err: any) => {
        cleanup();
        try { writeStream.destroy(err); } catch {}
        reject(err);
      };

      const onEnd = () => {
        cleanup();
        writeStream.end(() => {
          resolve(bytesWritten);
        });
      };

      const cleanup = () => {
        if (streamTimer) clearTimeout(streamTimer);
        stream.removeListener('data', onData);
        stream.removeListener('error', onError);
        stream.removeListener('end', onEnd);
      };

      stream.on('data', onData);
      stream.on('error', onError);
      stream.on('end', onEnd);
    });
  }

  /**
   * Send reply using official SDK API.
   * Uses plain text format. Chooses reply or create message based on replyToMessageId/rootId.
   * Passes stable uuid for idempotency in API params/payload.
   */
  async sendReply(params: {
    chatId: string;
    rootId?: string;
    threadId?: string;
    replyToMessageId?: string;
    content: string;
    format?: 'plain' | 'markdown';
    uuid?: string;
  }): Promise<OutboundReplyResult> {
    if (!this.apiClient) {
      return {
        success: false,
        error: `Live Lark reply skipped (${REAL_LARK_CREDENTIAL_ACCEPTANCE}): ${REAL_LARK_CREDENTIAL_SKIP_REASON}`,
      };
    }

    try {
      const textContent = JSON.stringify({ text: params.content });
      const target = resolveReplyTarget({
        rootId: params.rootId,
        threadId: params.threadId,
        replyToMessageId: params.replyToMessageId,
      });

      if (target.messageId) {
        const doReply = async (replyInThread: boolean, msgId: string) => {
          const replyFn =
            this.apiClient.im?.message?.reply || this.apiClient.im?.v1?.message?.reply;
          return await replyFn({
            path: {
              message_id: msgId,
            },
            params: params.uuid ? { uuid: params.uuid } : undefined,
            data: {
              content: textContent,
              msg_type: 'text',
              reply_in_thread: replyInThread,
              uuid: params.uuid,
            },
          });
        };

        const fallbackTarget =
          params.replyToMessageId && !params.replyToMessageId.startsWith('omt_')
            ? params.replyToMessageId
            : target.messageId;

        let res: any;
        try {
          res = await doReply(target.replyInThread, target.messageId);
        } catch (firstErr) {
          const errCode = getLarkApiErrorCode(firstErr);
          if (target.replyInThread && errCode && LARK_THREAD_REPLY_UNSUPPORTED_CODES.has(errCode) && fallbackTarget) {
            res = await doReply(false, fallbackTarget);
          } else {
            throw firstErr;
          }
        }

        // If returned response contains unsupported code (some SDK responses return non-zero code instead of throwing)
        if (target.replyInThread && res?.code && LARK_THREAD_REPLY_UNSUPPORTED_CODES.has(res.code) && fallbackTarget) {
          res = await doReply(false, fallbackTarget);
        }

        if (res?.code === 0 || res?.data?.message_id) {
          return {
            success: true,
            messageId: res.data?.message_id,
          };
        } else {
          return {
            success: false,
            error: res?.msg || `Lark API reply failed with code ${res?.code}`,
          };
        }
      } else {
        const res = await this.apiClient.im.message.create({
          params: {
            receive_id_type: 'chat_id',
            ...(params.uuid ? { uuid: params.uuid } : {}),
          },
          data: {
            receive_id: params.chatId,
            content: textContent,
            msg_type: 'text',
            uuid: params.uuid,
          },
        });

        if (res?.code === 0 || res?.data?.message_id) {
          return {
            success: true,
            messageId: res.data?.message_id,
          };
        } else {
          return {
            success: false,
            error: res?.msg || `Lark API create message failed with code ${res?.code}`,
          };
        }
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown Lark API error',
      };
    }
  }

  /**
   * Create a CardKit Schema 2.0 streaming card session.
   * Creates the card entity via CardKit, sends it using IM message reply/create,
   * and returns a session to push streaming text and finalize upon turn completion.
   */
  async createStreamingCard(params: {
    chatId: string;
    replyToMessageId?: string;
    rootId?: string;
    threadId?: string;
    title?: string;
    statusPanelTitle?: string;
    withStatusPanel?: boolean;
    collapsibleToolStatus?: boolean;
    withThinkingPanel?: boolean;
    collapsibleThinking?: boolean;
    expandStatusPanel?: boolean;
    expandThinkingPanel?: boolean;
    withStatusBar?: boolean;
    withStopButton?: boolean;
    turnId?: string;
    sessionId?: string;
  }): Promise<LarkStreamingCardSession | null> {
    if (!this.apiClient) {
      this.logger.warn('[lark-stream] createStreamingCard failed: no apiClient');
      return null;
    }

    try {
      const cardCreateFn = this.apiClient.cardkit?.v1?.card?.create;
      if (typeof cardCreateFn !== 'function') {
        this.logger.warn('[lark-stream] createStreamingCard failed: cardkit.v1.card.create is not a function');
        return null;
      }

      const withThinking = Boolean(params.withThinkingPanel ?? params.collapsibleThinking);
      const withStatus = Boolean(params.withStatusPanel ?? params.collapsibleToolStatus);
      const withStatusBar = Boolean(params.withStatusBar);
      const expandThinking = params.expandThinkingPanel ?? true;
      const expandStatus = params.expandStatusPanel ?? true;
      const withStop = params.withStopButton ?? Boolean(params.turnId || params.sessionId);
      const initialElements: Array<Record<string, unknown>> = [];
      if (withThinking) {
        initialElements.push(
          buildCollapsibleThinkingPanel({
            content: "<font color='grey'>尚未开始思考…</font>",
            expanded: expandThinking,
            elementId: 'thinking_panel',
            contentElementId: 'thinking_content',
            title: '**💭 思考过程**',
            backgroundColor: 'blue-50',
          })
        );
      }
      if (withStatus) {
        initialElements.push(
          buildCollapsibleStatusPanel({
            content: "<font color='grey'>尚未调用工具…</font>",
            expanded: expandStatus,
            elementId: 'tool_status_panel',
            contentElementId: 'tool_status_content',
            title: '**🔧 执行过程**',
            backgroundColor: 'wathet-50',
          })
        );
      }
      initialElements.push({
        tag: 'markdown',
        element_id: 'main_content',
        content: '正在思考…',
      });
      if (withStatusBar) {
        initialElements.push({
          tag: 'markdown',
          element_id: 'streaming_status_bar',
          text_size: 'notation',
          content: buildStreamingStatusLine({ elapsedMs: 0, nowMs: Date.now() }),
        });
      }
      if (withStop) {
        initialElements.push(buildStopReplyButton(params.turnId, params.sessionId));
      }

      // 1. Build schema 2.0 card JSON
      const initialCard = {
        schema: '2.0',
        config: {
          update_multi: true,
          streaming_mode: true,
        },
        header: {
          title: {
            tag: 'plain_text',
            content: params.title ?? 'Enkeep',
          },
          template: 'blue',
        },
        body: {
          direction: 'vertical',
          elements: initialElements,
        },
      };

      // 2. cardkit.v1.card.create({ data: { type: 'card_json', data: JSON.stringify(card) } })
      const cardCreateRes = await this.apiClient.cardkit.v1.card.create({
        data: {
          type: 'card_json',
          data: JSON.stringify(initialCard),
        },
      });

      const cardId = cardCreateRes?.data?.card_id;
      if (!cardId) {
        this.logger.warn('[lark-stream] createStreamingCard failed: no card_id', {
          code: cardCreateRes?.code,
          message: cardCreateRes?.msg,
        });
        return null;
      }

      let seq = 1;

      // 3. Send: reuse the SAME thread targeting rule as sendReply
      const target = resolveReplyTarget({
        rootId: params.rootId,
        threadId: params.threadId,
        replyToMessageId: params.replyToMessageId,
      });

      const cardContent = JSON.stringify({
        type: 'card',
        data: { card_id: cardId },
      });

      let messageId: string | undefined;

      const replyFn =
        this.apiClient.im?.message?.reply || this.apiClient.im?.v1?.message?.reply;
      const messageCreateFn =
        this.apiClient.im?.message?.create || this.apiClient.im?.v1?.message?.create;

      if (target.messageId) {
        if (typeof replyFn !== 'function') {
          this.logger.warn('[lark-stream] createStreamingCard failed: im.message.reply is not a function');
          return null;
        }

        const doReply = async (replyInThread: boolean, msgId: string) => {
          return await replyFn({
            path: {
              message_id: msgId,
            },
            data: {
              content: cardContent,
              msg_type: 'interactive',
              reply_in_thread: replyInThread,
            },
          });
        };

        const fallbackTarget =
          params.replyToMessageId && !params.replyToMessageId.startsWith('omt_')
            ? params.replyToMessageId
            : target.messageId;

        let res: any;
        try {
          res = await doReply(target.replyInThread, target.messageId);
        } catch (firstErr) {
          const errCode = getLarkApiErrorCode(firstErr);
          if (target.replyInThread && errCode && LARK_THREAD_REPLY_UNSUPPORTED_CODES.has(errCode) && fallbackTarget) {
            res = await doReply(false, fallbackTarget);
          } else {
            this.logger.warn('[lark-stream] createStreamingCard reply error', {
              code: errCode,
              message: firstErr instanceof Error ? firstErr.message : String(firstErr),
            });
            throw firstErr;
          }
        }

        if (target.replyInThread && res?.code && LARK_THREAD_REPLY_UNSUPPORTED_CODES.has(res.code) && fallbackTarget) {
          res = await doReply(false, fallbackTarget);
        }

        if (res?.code === 0 || res?.data?.message_id) {
          messageId = res.data?.message_id;
        } else {
          this.logger.warn('[lark-stream] createStreamingCard reply failed', {
            code: res?.code,
            message: res?.msg,
          });
          return null;
        }
      } else {
        if (typeof messageCreateFn !== 'function') {
          this.logger.warn('[lark-stream] createStreamingCard failed: im.message.create is not a function');
          return null;
        }

        const res = await messageCreateFn({
          params: {
            receive_id_type: 'chat_id',
          },
          data: {
            receive_id: params.chatId,
            content: cardContent,
            msg_type: 'interactive',
          },
        });

        if (res?.code === 0 || res?.data?.message_id) {
          messageId = res.data?.message_id;
        } else {
          this.logger.warn('[lark-stream] createStreamingCard message create failed', {
            code: res?.code,
            message: res?.msg,
          });
          return null;
        }
      }

      if (!messageId) {
        this.logger.warn('[lark-stream] createStreamingCard failed: no message_id obtained');
        return null;
      }

      const boundMessageId = messageId;
      const logger = this.logger;
      const client = this.apiClient;

      // 4. Return streaming card session
      const session: LarkStreamingCardSession = {
        cardId,
        messageId: boundMessageId,
        pushText: async (accumulatedText: string, toolStatus?: string, thinkingText?: string, statusLine?: string): Promise<void> => {
          try {
            const contentFn = client.cardkit?.v1?.cardElement?.content;
            if (typeof contentFn !== 'function') return;

            seq += 1;
            let res: any;
            try {
              res = await contentFn({
                path: {
                  card_id: cardId,
                  element_id: 'main_content',
                },
                data: {
                  content: accumulatedText,
                  sequence: seq,
                },
              });
            } catch (contentErr) {
              const errCode = getLarkApiErrorCode(contentErr);
              if (errCode === 200850 || errCode === 300309) {
                // Re-enable streaming mode and retry once
                seq += 1;
                const settingsFn = client.cardkit?.v1?.card?.settings;
                if (typeof settingsFn === 'function') {
                  try {
                    await settingsFn({
                      path: { card_id: cardId },
                      data: {
                        settings: JSON.stringify({ config: { streaming_mode: true } }),
                        sequence: seq,
                      },
                    });
                  } catch (settingsErr) {
                    logger.warn('[lark-stream] settings streaming_mode retry failed', {
                      code: (settingsErr as any)?.code,
                      message: settingsErr instanceof Error ? settingsErr.message : String(settingsErr),
                    });
                  }
                }
                seq += 1;
                await contentFn({
                  path: {
                    card_id: cardId,
                    element_id: 'main_content',
                  },
                  data: {
                    content: accumulatedText,
                    sequence: seq,
                  },
                });
                return;
              }
              logger.warn('[lark-stream] pushText failed', {
                code: errCode,
                message: contentErr instanceof Error ? contentErr.message : String(contentErr),
              });
              return;
            }

            // Check non-throwing error code in response
            if (res?.code === 200850 || res?.code === 300309) {
              seq += 1;
              const settingsFn = client.cardkit?.v1?.card?.settings;
              if (typeof settingsFn === 'function') {
                try {
                  await settingsFn({
                    path: { card_id: cardId },
                    data: {
                      settings: JSON.stringify({ config: { streaming_mode: true } }),
                      sequence: seq,
                    },
                  });
                } catch (settingsErr) {
                  logger.warn('[lark-stream] settings streaming_mode retry failed', {
                    code: (settingsErr as any)?.code,
                    message: settingsErr instanceof Error ? settingsErr.message : String(settingsErr),
                  });
                }
              }
              seq += 1;
              await contentFn({
                path: {
                  card_id: cardId,
                  element_id: 'main_content',
                },
                data: {
                  content: accumulatedText,
                  sequence: seq,
                },
              });
            }

            if (toolStatus) {
              seq += 1;
              await contentFn({
                path: {
                  card_id: cardId,
                  element_id: 'tool_status_content',
                },
                data: {
                  content: toolStatus,
                  sequence: seq,
                },
              });
            }

            if (thinkingText) {
              seq += 1;
              await contentFn({
                path: {
                  card_id: cardId,
                  element_id: 'thinking_content',
                },
                data: {
                  content: thinkingText,
                  sequence: seq,
                },
              });
            }

            if (withStatusBar && statusLine) {
              seq += 1;
              await contentFn({
                path: {
                  card_id: cardId,
                  element_id: 'streaming_status_bar',
                },
                data: {
                  content: statusLine,
                  sequence: seq,
                },
              });
            }
          } catch (err) {
            logger.warn('[lark-stream] pushText error', {
              code: (err as any)?.code,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        },
        pushToolStatus: async (statusText: string): Promise<void> => {
          try {
            const contentFn = client.cardkit?.v1?.cardElement?.content;
            if (typeof contentFn !== 'function') return;

            seq += 1;
            await contentFn({
              path: {
                card_id: cardId,
                element_id: 'tool_status_content',
              },
              data: {
                content: statusText,
                sequence: seq,
              },
            });
          } catch (err) {
            logger.warn('[lark-stream] pushToolStatus error', {
              code: (err as any)?.code,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        },
        pushThinking: async (thinkingText: string): Promise<void> => {
          try {
            const contentFn = client.cardkit?.v1?.cardElement?.content;
            if (typeof contentFn !== 'function') return;

            seq += 1;
            await contentFn({
              path: {
                card_id: cardId,
                element_id: 'thinking_content',
              },
              data: {
                content: thinkingText,
                sequence: seq,
              },
            });
          } catch (err) {
            logger.warn('[lark-stream] pushThinking error', {
              code: (err as any)?.code,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        },
        pushStatusLine: async (statusText: string): Promise<void> => {
          if (!withStatusBar) return;
          try {
            const contentFn = client.cardkit?.v1?.cardElement?.content;
            if (typeof contentFn !== 'function') return;

            seq += 1;
            await contentFn({
              path: {
                card_id: cardId,
                element_id: 'streaming_status_bar',
              },
              data: {
                content: statusText,
                sequence: seq,
              },
            });
          } catch (err) {
            logger.warn('[lark-stream] pushStatusLine error', {
              code: (err as any)?.code,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        },
        finalize: async (
          finalText: string,
          status: 'completed' | 'failed' | 'stopped',
          metadata?: CardFinalMetadata,
          toolStatus?: string | readonly CardToolStatusEntry[],
          thinkingText?: string
        ): Promise<void> => {
          // Close streaming mode via card.settings (swallow errors)
          try {
            const settingsFn = client.cardkit?.v1?.card?.settings;
            if (typeof settingsFn === 'function') {
              seq += 1;
              await settingsFn({
                path: { card_id: cardId },
                data: {
                  settings: JSON.stringify({ config: { streaming_mode: false } }),
                  sequence: seq,
                },
              });
            }
          } catch (settingsErr) {
            logger.warn('[lark-stream] settings streaming_mode false failed', {
              code: (settingsErr as any)?.code,
              message: settingsErr instanceof Error ? settingsErr.message : String(settingsErr),
            });
          }

          let cleanFinalText = finalText;
          let cleanThinking = thinkingText?.trim();
          if (cleanFinalText && cleanFinalText.includes('<think>')) {
            const extracted = extractThinkingFromText(cleanFinalText);
            cleanFinalText = extracted.text;
            if (!cleanThinking && extracted.thinking) {
              cleanThinking = extracted.thinking;
            }
          }

          // Build final card JSON
          const bodyElements: Array<Record<string, unknown> | LarkCardBodyElement> = [];
          let hasProcessArea = false;

          // 1. Thinking panel: placed ABOVE process panel/body; collapsed in final card (expanded: false)
          if (cleanThinking) {
            const guardedThinking = applyThinkingLengthGuard(cleanThinking);
            bodyElements.push(
              buildCollapsibleThinkingPanel({
                content: guardedThinking,
                expanded: false, // collapsed on completion
                title: '**💭 思考过程**',
                backgroundColor: 'blue-50',
              })
            );
            hasProcessArea = true;
          }

          // 2. Process panel (tool status panel)
          const formattedToolStatus = formatToolStatusMarkdown(toolStatus);
          if (formattedToolStatus) {
            bodyElements.push(
              buildCollapsibleStatusPanel({
                content: formattedToolStatus,
                expanded: false, // collapsed on completion
                title: params.statusPanelTitle ?? '**🔧 执行过程**',
                backgroundColor: 'wathet-50',
              })
            );
            hasProcessArea = true;
          }

          if (hasProcessArea) {
            bodyElements.push({ tag: 'hr' });
          }

          const emptyFallback = status === 'stopped' ? '(已停止回复)' : '(空回复)';
          const contentElements = markdownToCardElements(cleanFinalText, {
            maxChunkLen: 4000,
            emptyFallback,
          });
          if (contentElements.length === 0) {
            bodyElements.push({
              tag: 'markdown',
              content: emptyFallback,
            });
          } else {
            for (const el of contentElements) {
              bodyElements.push(el);
            }
          }

          if (status === 'stopped') {
            bodyElements.push({
              tag: 'markdown',
              element_id: 'streaming_status_bar',
              text_size: 'notation',
              content: "<font color='grey'>⏹ 已停止</font>",
            });
          }

          const footer = formatCardUsageFooter(metadata);
          if (footer) {
            bodyElements.push({
              tag: 'markdown',
              text_size: 'notation',
              content: footer,
            });
          }

          const finalCard = {
            schema: '2.0',
            header:
              status === 'completed'
                ? {
                    title: { tag: 'plain_text', content: params.title ?? '已完成' },
                    template: 'violet',
                  }
                : status === 'stopped'
                  ? {
                      title: {
                        tag: 'plain_text',
                        content: params.title ? `${params.title} (已中止)` : '已中止',
                      },
                      template: 'orange',
                    }
                  : {
                      title: {
                        tag: 'plain_text',
                        content: params.title ? `${params.title} (处理失败)` : '处理失败',
                      },
                      template: 'red',
                    },
            body: {
              direction: 'vertical',
              elements: bodyElements,
            },
          };

          const finalCardJson = JSON.stringify(finalCard);

          // Full card update via cardkit.v1.card.update
          let updateSuccess = false;
          let updateError: any;

          try {
            const cardUpdateFn = client.cardkit?.v1?.card?.update;
            if (typeof cardUpdateFn === 'function') {
              seq += 1;
              const updateRes = await cardUpdateFn({
                path: { card_id: cardId },
                data: {
                  card: {
                    type: 'card_json',
                    data: finalCardJson,
                  },
                  sequence: seq,
                },
              });
              if (updateRes?.code === 0 || (!updateRes?.code && !updateRes?.msg)) {
                updateSuccess = true;
              } else {
                updateError = new Error(
                  updateRes?.msg || `card.update returned code ${updateRes?.code}`
                );
                (updateError as any).code = updateRes?.code;
              }
            } else {
              updateError = new Error('cardkit.v1.card.update is not available');
            }
          } catch (err) {
            updateError = err;
          }

          if (updateSuccess) {
            return;
          }

          logger.warn('[lark-stream] session.finalize card.update failed, falling back to message.patch', {
            code: updateError?.code ?? (updateError as any)?.status,
            message: updateError instanceof Error ? updateError.message : String(updateError),
          });

          // Fallback to im.v1.message.patch
          try {
            const patchFn =
              client.im?.v1?.message?.patch || client.im?.message?.patch;
            if (typeof patchFn === 'function') {
              const patchRes = await patchFn({
                path: { message_id: boundMessageId },
                data: {
                  content: finalCardJson,
                },
              });
              if (patchRes?.code === 0 || (!patchRes?.code && !patchRes?.msg)) {
                return;
              }
              const err = new Error(
                patchRes?.msg || `message.patch returned code ${patchRes?.code}`
              );
              (err as any).code = patchRes?.code;
              throw err;
            } else {
              throw new Error('im.message.patch is not available');
            }
          } catch (patchErr) {
            logger.warn('[lark-stream] session.finalize message.patch failed', {
              code: (patchErr as any)?.code,
              message: patchErr instanceof Error ? patchErr.message : String(patchErr),
            });
            logger.error(
              `Failed to finalize streaming card via card.update and message.patch: ${
                patchErr instanceof Error ? patchErr.message : String(patchErr)
              }`
            );
            throw patchErr;
          }
        },
      };

      return session;
    } catch (err) {
      this.logger.warn('[lark-stream] createStreamingCard error', {
        code: (err as any)?.code ?? (err as any)?.status,
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
