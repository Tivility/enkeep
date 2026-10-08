import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ValidationError, PlatformError } from '@enkeep/platform-core';
import type { ModelSelectionService } from '../models/model-selection-service.js';

export type ChatCommandType = 'model' | 'effort' | 'help' | 'status' | 'new' | 'stop' | 'compact' | 'sw' | 'spawn' | 'where' | 'bind' | 'unbind' | 'newws' | 'list' | 'ws' | 'session' | 'ses' | 'mention' | 'require_mention' | 'unknown';

export interface ParsedChatCommand {
  command: ChatCommandType;
  type: ChatCommandType;
  subcommand: string;
  action: string;
  arg?: string;
  target?: string;
  effort?: string;
  raw: string;
  isConfirm?: boolean;
  all?: boolean;
  legacy?: 'where' | 'list' | 'bind' | 'unbind' | 'newws' | 'new' | 'clear' | 'reset';
  word?: string;
  closest?: string;
}

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const HELP_USAGE = `Available commands:

工作区指令 (/ws):
  /ws - 查看当前工作区 (名称、目录、执行模式、绑定来源)
  /ws list - 列出活跃工作区 (别名: /ws ls)
  /ws use <名称/目录/ID/main> - 切换到工作区主会话并清除固定会话
  /ws new <名称> - 新建工作区并切换
  /ws home - 回到账号默认工作区

会话指令 (/session, 别名 /ses):
  /session - 查看当前会话 (短ID、标题、主会话、代际、最后活跃)
  /session list - 列出当前工作区有效会话 (别名: /session ls)
  /session use <短ID/标题/main> - 固定到会话 (main 跟随主会话)
  /session new [标题] - 新建会话并固定
  /session clear - 清空当前会话 (主会话被共享时需 /session clear confirm)

运行与控制指令:
  /status - 查看当前工作区、会话、模型与排队状态
  /stop - 取消正在运行或排队的轮次
  /compact - Force session compaction regardless of threshold
  /model - Show, list, set, or reset session model override
  /effort - List, set, or reset reasoning effort override
  /sw - Start parallel background task in current space (alias: /spawn)
  /mention [on|off] - 查看或设置群聊回复模式 (别名: /require_mention true|false)
  /help - Show this help message

过渡期兼容提示:
  /where - Show current workspace binding and context
  /bind - Bind channel context to workspace (alias: /bind <space>)
  /unbind - Revert channel context to default workspace
  /newws - Create a new workspace (alias: /new-workspace <name>)
  /list - List active spaces ordered by recent activity (alias: /ls)
  /new - 区分会话与工作区，请使用 /session new 或 /ws new
  /clear, /reset - 等同于 /session clear`;

export const WS_USAGE = `用法:
  /ws - 查看当前工作区 (名称、目录、执行模式、绑定来源)
  /ws list - 列出活跃工作区 (别名: /ws ls)
  /ws use <名称/目录/ID/main> - 切换到工作区主会话并清除固定会话
  /ws new <名称> - 新建工作区并切换
  /ws home - 回到账号默认工作区`;

export const SESSION_USAGE = `用法:
  /session - 查看当前会话 (别名: /ses)
  /session list - 列出当前工作区会话 (别名: /session ls)
  /session use <短ID/标题/main> - 固定到会话 (main 跟随主会话)
  /session new [标题] - 新建会话并固定
  /session clear - 清空当前会话
  /session clear confirm - 确认清空共享主会话`;

/**
 * Computes deterministic short session ID:
 * Removes prefix (e.g. "ses_"), defaults to first 4 chars, and automatically
 * extends length if there is collision with any other active session in the same workspace.
 */
export function computeSessionShortId(sessionId: string, allSpaceSessionIds: string[]): string {
  const stripPrefix = (id: string) => {
    if (id.startsWith('ses_')) return id.slice(4);
    if (id.startsWith('ses-')) return id.slice(4);
    const idx = id.indexOf('_');
    return idx >= 0 ? id.slice(idx + 1) : id;
  };

  const stripped = stripPrefix(sessionId);
  if (stripped.length <= 4) {
    return stripped;
  }

  const otherStripped = allSpaceSessionIds
    .filter((id) => id !== sessionId)
    .map(stripPrefix);

  for (let len = 4; len < stripped.length; len++) {
    const candidate = stripped.slice(0, len);
    const hasConflict = otherStripped.some((other) => other.slice(0, len) === candidate);
    if (!hasConflict) {
      return candidate;
    }
  }

  return stripped;
}

/**
 * Resolves session candidate within workspace by short ID (collision-aware), prefix, full ID, or title.
 */
export function matchSessionInSpace<T extends { id: string; title: string | null }>(
  target: string,
  sessions: T[],
  canonicalSessionId?: string | null
): { matched?: T; ambiguous?: boolean } {
  const cleanTarget = target.trim();
  const lower = cleanTarget.toLowerCase();

  if (lower === 'main') {
    if (canonicalSessionId) {
      const canon = sessions.find((s) => s.id === canonicalSessionId);
      if (canon) return { matched: canon };
    }
    return {};
  }

  // 1. Exact full ID match
  const byFullId = sessions.find((s) => s.id === cleanTarget || s.id.toLowerCase() === lower);
  if (byFullId) return { matched: byFullId };

  const allIds = sessions.map((s) => s.id);
  // 2. Exact short ID match (with collision resolution)
  const shortIdMatches = sessions.filter((s) => {
    const shortId = computeSessionShortId(s.id, allIds);
    return shortId.toLowerCase() === lower;
  });
  if (shortIdMatches.length === 1) return { matched: shortIdMatches[0] };
  if (shortIdMatches.length > 1) return { ambiguous: true };

  // 3. Prefix match of stripped ID
  const stripPrefix = (id: string) => (id.startsWith('ses_') ? id.slice(4) : id.replace(/^[^_]+_/, ''));
  const prefixMatches = sessions.filter((s) => stripPrefix(s.id).toLowerCase().startsWith(lower));
  if (prefixMatches.length === 1) return { matched: prefixMatches[0] };
  if (prefixMatches.length > 1) return { ambiguous: true };

  // 4. Exact title match (case-insensitive)
  const byTitle = sessions.filter((s) => s.title && s.title.toLowerCase() === lower);
  if (byTitle.length === 1) return { matched: byTitle[0] };
  if (byTitle.length > 1) return { ambiguous: true };

  return {};
}

const SPAWN_USAGE = `用法: /sw <任务描述>
在当前工作区创建并行任务`;

const MODEL_USAGE = `Usage:
  /model - Show current effective model
  /model list - List available models
  /model <provider/model> or <modelId> - Set session model override (alias: /model use <id>)
  /model reset - Reset session model override`;

const EFFORT_USAGE = `Usage:
  /effort list - List supported reasoning efforts for current model
  /effort <name> - Set reasoning effort for current session
  /effort reset - Reset reasoning effort override`;

export const KNOWN_CHAT_COMMANDS = [
  'model',
  'effort',
  'help',
  'status',
  'new',
  'reset',
  'clear',
  'stop',
  'compact',
  'sw',
  'spawn',
  'where',
  'bind',
  'unbind',
  'newws',
  'new-workspace',
  'list',
  'ls',
  'ws',
  'session',
  'ses',
  'mention',
  'require_mention',
] as const;

export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

export function findClosestCommand(
  word: string,
  knownCommands: readonly string[] = KNOWN_CHAT_COMMANDS
): string | null {
  const lower = word.toLowerCase();
  let minDistance = Infinity;
  let closest: string | null = null;
  for (const cmd of knownCommands) {
    const dist = levenshteinDistance(lower, cmd);
    if (dist < minDistance) {
      minDistance = dist;
      closest = cmd;
    }
  }
  return minDistance <= 2 ? closest : null;
}

export function parseUnknownChatCommand(content: unknown): {
  word: string;
  closest: string | null;
  raw: string;
} | null {
  if (typeof content !== 'string') {
    return null;
  }
  const trimmed = content.trim();
  const match = trimmed.match(/^\/([A-Za-z][A-Za-z0-9_-]*)(\s|$)/);
  if (!match) {
    return null;
  }
  const word = match[1];
  const lower = word.toLowerCase();
  const isKnown = KNOWN_CHAT_COMMANDS.some((cmd) => cmd === lower);
  if (isKnown) {
    return null;
  }
  const closest = findClosestCommand(lower, KNOWN_CHAT_COMMANDS);
  return {
    word,
    closest,
    raw: trimmed,
  };
}

export function formatUnknownCommandReply(word: string, closest: string | null): string {
  if (closest) {
    return `未知指令 /${word}。你是不是想用 /${closest}？发送 /help 查看全部指令。`;
  }
  return `未知指令 /${word}。发送 /help 查看全部指令。`;
}

/**
 * Parses in-chat slash commands (/model, /effort, /help, /status, /new, /reset, /clear, /stop) at a word boundary.
 * Returns null if the content does not match.
 */
export function parseChatCommand(
  content: unknown,
  options?: { allowUnknown?: boolean }
): ParsedChatCommand | null {
  if (typeof content !== 'string') {
    return null;
  }

  const trimmed = content.trim();
  const match = trimmed.match(/^\/(model|effort|help|status|new|reset|clear|stop|compact|sw|spawn|where|bind|unbind|newws|new-workspace|list|ls|ws|session|ses|mention|require_mention)(?:[\s\t\r\n]+([\s\S]*))?$/i);
  if (!match) {
    if (options?.allowUnknown) {
      const unknown = parseUnknownChatCommand(trimmed);
      if (unknown) {
        return {
          command: 'unknown',
          type: 'unknown',
          subcommand: '',
          action: '',
          raw: trimmed,
          word: unknown.word,
          closest: unknown.closest ?? undefined,
        };
      }
    }
    return null;
  }

  const cmd = match[1].toLowerCase() as ChatCommandType | 'new-workspace' | 'ls' | 'reset' | 'clear' | 'spawn';
  const rest = match[2] !== undefined ? match[2].trim() : '';

  if (cmd === 'ws') {
    if (!rest) {
      return {
        command: 'ws',
        type: 'ws',
        subcommand: 'show',
        action: 'show',
        raw: trimmed,
      };
    }
    const [first, ...restTokens] = rest.split(/\s+/);
    const sub = first.toLowerCase();
    const subRest = restTokens.join(' ').trim();

    if (sub === 'list' || sub === 'ls') {
      return {
        command: 'ws',
        type: 'ws',
        subcommand: 'list',
        action: 'list',
        raw: trimmed,
      };
    }
    if (sub === 'use') {
      return {
        command: 'ws',
        type: 'ws',
        subcommand: 'use',
        action: 'use',
        target: subRest || undefined,
        arg: subRest || undefined,
        raw: trimmed,
      };
    }
    if (sub === 'new') {
      return {
        command: 'ws',
        type: 'ws',
        subcommand: 'new',
        action: 'new',
        target: subRest || undefined,
        arg: subRest || undefined,
        raw: trimmed,
      };
    }
    if (sub === 'home') {
      return {
        command: 'ws',
        type: 'ws',
        subcommand: 'home',
        action: 'home',
        raw: trimmed,
      };
    }
    return {
      command: 'ws',
      type: 'ws',
      subcommand: 'unknown',
      action: 'unknown',
      arg: rest,
      raw: trimmed,
    };
  }

  if (cmd === 'session' || cmd === 'ses') {
    if (!rest) {
      return {
        command: 'session',
        type: 'session',
        subcommand: 'show',
        action: 'show',
        raw: trimmed,
      };
    }
    const [first, ...restTokens] = rest.split(/\s+/);
    const sub = first.toLowerCase();
    const subRest = restTokens.join(' ').trim();

    if (sub === 'list' || sub === 'ls') {
      return {
        command: 'session',
        type: 'session',
        subcommand: 'list',
        action: 'list',
        raw: trimmed,
      };
    }
    if (sub === 'use') {
      const allMatch = subRest.match(/^(.*?)\s+all$/i);
      const applyAll = Boolean(allMatch);
      const target = allMatch ? allMatch[1].trim() : subRest;
      return {
        command: 'session',
        type: 'session',
        subcommand: 'use',
        action: 'use',
        target: target || undefined,
        arg: target || undefined,
        all: applyAll,
        raw: trimmed,
      };
    }
    if (sub === 'new') {
      return {
        command: 'session',
        type: 'session',
        subcommand: 'new',
        action: 'new',
        target: subRest || undefined,
        arg: subRest || undefined,
        raw: trimmed,
      };
    }
    if (sub === 'clear') {
      const isConfirm = subRest.toLowerCase() === 'confirm';
      return {
        command: 'session',
        type: 'session',
        subcommand: 'clear',
        action: 'clear',
        isConfirm,
        raw: trimmed,
      };
    }
    return {
      command: 'session',
      type: 'session',
      subcommand: 'unknown',
      action: 'unknown',
      arg: rest,
      raw: trimmed,
    };
  }

  if (cmd === 'mention' || cmd === 'require_mention') {
    if (!rest) {
      return {
        command: cmd,
        type: cmd,
        subcommand: 'show',
        action: 'show',
        raw: trimmed,
      };
    }
    const low = rest.toLowerCase();
    if (low === 'on' || low === 'true') {
      return {
        command: cmd,
        type: cmd,
        subcommand: 'set',
        action: 'set',
        target: 'on',
        arg: 'on',
        raw: trimmed,
      };
    }
    if (low === 'off' || low === 'false') {
      return {
        command: cmd,
        type: cmd,
        subcommand: 'set',
        action: 'set',
        target: 'off',
        arg: 'off',
        raw: trimmed,
      };
    }
    return {
      command: cmd,
      type: cmd,
      subcommand: 'unknown',
      action: 'unknown',
      arg: rest,
      raw: trimmed,
    };
  }

  if (cmd === 'clear' || cmd === 'reset') {
    const isConfirm = rest.toLowerCase() === 'confirm';
    return {
      command: 'session',
      type: 'session',
      subcommand: 'clear',
      action: 'clear',
      isConfirm,
      legacy: cmd,
      raw: trimmed,
    };
  }

  if (cmd === 'new') {
    return {
      command: 'new',
      type: 'new',
      subcommand: 'new',
      action: 'new',
      arg: rest || undefined,
      legacy: 'new',
      raw: trimmed,
    };
  }

  if (cmd === 'where') {
    return {
      command: 'where',
      type: 'where',
      subcommand: 'show',
      action: 'show',
      legacy: 'where',
      raw: trimmed,
    };
  }

  if (cmd === 'bind') {
    return {
      command: 'bind',
      type: 'bind',
      subcommand: rest ? 'bind' : 'show',
      action: rest ? 'bind' : 'show',
      target: rest || undefined,
      arg: rest || undefined,
      legacy: 'bind',
      raw: trimmed,
    };
  }

  if (cmd === 'unbind') {
    return {
      command: 'unbind',
      type: 'unbind',
      subcommand: 'unbind',
      action: 'unbind',
      legacy: 'unbind',
      raw: trimmed,
    };
  }

  if (cmd === 'newws' || cmd === 'new-workspace') {
    return {
      command: 'newws',
      type: 'newws',
      subcommand: 'create',
      action: 'create',
      arg: rest || undefined,
      target: rest || undefined,
      legacy: 'newws',
      raw: trimmed,
    };
  }

  if (cmd === 'list' || cmd === 'ls') {
    return {
      command: 'list',
      type: 'list',
      subcommand: 'list',
      action: 'list',
      arg: rest || undefined,
      legacy: 'list',
      raw: trimmed,
    };
  }

  if (cmd === 'sw' || cmd === 'spawn') {
    if (!rest) {
      return {
        command: 'spawn',
        type: 'spawn',
        subcommand: 'show',
        action: 'show',
        raw: trimmed,
      };
    }
    return {
      command: 'spawn',
      type: 'spawn',
      subcommand: 'spawn',
      action: 'spawn',
      arg: rest,
      raw: trimmed,
    };
  }

  if (cmd === 'help') {
    return {
      command: 'help',
      type: 'help',
      subcommand: 'show',
      action: 'show',
      arg: rest || undefined,
      raw: trimmed,
    };
  }

  if (cmd === 'status') {
    return {
      command: 'status',
      type: 'status',
      subcommand: 'show',
      action: 'show',
      arg: rest || undefined,
      raw: trimmed,
    };
  }

  if (cmd === 'stop') {
    return {
      command: 'stop',
      type: 'stop',
      subcommand: 'stop',
      action: 'stop',
      arg: rest || undefined,
      raw: trimmed,
    };
  }

  if (cmd === 'compact') {
    return {
      command: 'compact',
      type: 'compact',
      subcommand: 'compact',
      action: 'compact',
      arg: rest || undefined,
      raw: trimmed,
    };
  }

  if (cmd === 'model') {
    if (!rest) {
      return {
        command: 'model',
        type: 'model',
        subcommand: 'show',
        action: 'show',
        raw: trimmed,
      };
    }
    if (rest === 'list') {
      return {
        command: 'model',
        type: 'model',
        subcommand: 'list',
        action: 'list',
        raw: trimmed,
      };
    }
    if (rest === 'reset') {
      return {
        command: 'model',
        type: 'model',
        subcommand: 'reset',
        action: 'reset',
        raw: trimmed,
      };
    }
    const useMatch = rest.match(/^use(?:\s+([\s\S]*))?$/i);
    if (useMatch) {
      const useTarget = useMatch[1]?.trim();
      if (!useTarget || /\s/.test(useTarget)) {
        return {
          command: 'model',
          type: 'model',
          subcommand: 'unknown',
          action: 'unknown',
          arg: rest,
          raw: trimmed,
        };
      }
      return {
        command: 'model',
        type: 'model',
        subcommand: 'set',
        action: 'set',
        arg: useTarget,
        target: useTarget,
        raw: trimmed,
      };
    }
    if (rest === 'help' || rest === '--help' || rest === '-h' || /\s/.test(rest)) {
      return {
        command: 'model',
        type: 'model',
        subcommand: 'unknown',
        action: 'unknown',
        arg: rest,
        raw: trimmed,
      };
    }
    return {
      command: 'model',
      type: 'model',
      subcommand: 'set',
      action: 'set',
      arg: rest,
      target: rest,
      raw: trimmed,
    };
  }

  // cmd === 'effort'
  if (!rest) {
    return {
      command: 'effort',
      type: 'effort',
      subcommand: 'unknown',
      action: 'unknown',
      raw: trimmed,
    };
  }
  if (rest === 'list') {
    return {
      command: 'effort',
      type: 'effort',
      subcommand: 'list',
      action: 'list',
      raw: trimmed,
    };
  }
  if (rest === 'reset') {
    return {
      command: 'effort',
      type: 'effort',
      subcommand: 'reset',
      action: 'reset',
      raw: trimmed,
    };
  }
  if (rest === 'help' || rest === '--help' || rest === '-h' || /\s/.test(rest)) {
    return {
      command: 'effort',
      type: 'effort',
      subcommand: 'unknown',
      action: 'unknown',
      arg: rest,
      raw: trimmed,
    };
  }
  return {
    command: 'effort',
    type: 'effort',
    subcommand: 'set',
    action: 'set',
    arg: rest,
    effort: rest,
    raw: trimmed,
  };
}

let _cachedDockerAvailable: boolean | null = null;
export async function isDockerAvailable(): Promise<boolean> {
  if (_cachedDockerAvailable !== null) return _cachedDockerAvailable;
  try {
    const { execFile } = await import('node:child_process');
    await new Promise<void>((resolve, reject) => {
      execFile('docker', ['info'], { timeout: 2000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    _cachedDockerAvailable = true;
  } catch {
    _cachedDockerAvailable = false;
  }
  return _cachedDockerAvailable;
}

export interface ChatCommandServiceOptions {
  modelSelectionService: ModelSelectionService;
  isDockerAvailable?: () => Promise<boolean> | boolean;
  platformApi?: {
    resetSession: (
      userId: string,
      sessionId: string,
      options: { idempotencyKey: string; reason?: string }
    ) => Promise<{
      session?: unknown;
      generation: { generation: number; resetReason?: string };
      isIdempotentHit?: boolean;
    }>;
    compactSession?: (
      userId: string,
      sessionId: string
    ) => Promise<{
      beforeTokens?: number;
      afterTokens?: number;
      eventsBefore: number;
      eventsAfter: number;
      summaryChars: number;
      status?: string;
      error?: string;
    }>;
    createTask?: (
      userId: string,
      input: {
        title: string;
        payload: Record<string, unknown>;
        scheduleType?: string;
        priority?: string;
      }
    ) => Promise<{
      task: { id: string; title?: string; status?: string; [key: string]: unknown };
      isIdempotentHit?: boolean;
    }>;
    createSpace?: (
      userId: string,
      input: {
        name: string;
        folder?: string;
        executionMode?: 'container' | 'host';
      }
    ) => Promise<{
      id: string;
      name: string;
      folder?: string;
      executionMode?: 'container' | 'host';
      [key: string]: unknown;
    }>;
    listSpaces?: (
      userId: string,
      options?: any
    ) => Promise<Array<{
      id: string;
      name: string;
      folder?: string;
      executionMode?: 'container' | 'host';
      lastActivityAt?: string;
      [key: string]: unknown;
    }>>;
    createSession?: (
      userId: string,
      input: {
        spaceId: string;
        title?: string | null;
        executionMode?: 'container' | 'host';
        forceNew?: boolean;
      }
    ) => Promise<{
      id: string;
      title?: string | null;
      [key: string]: unknown;
    }>;
  };
  taskOperations?: (userId: string) => {
    createTask: (input: {
      title: string;
      payload: Record<string, unknown>;
      scheduleType?: string;
      priority?: string;
      [key: string]: unknown;
    }) => Promise<{
      task: { id: string; title?: string; status?: string; [key: string]: unknown };
      isIdempotentHit?: boolean;
    }>;
  };
  gateway?: {
    cancelCurrentTurn: (userId: string, sessionId: string) => Promise<boolean>;
    getCurrentTurnStatus: (
      userId: string,
      sessionId: string
    ) => Promise<{ status: string; code?: string; queuePosition?: number } | null>;
  };
  db?: DatabaseSync;
  checkChatAdmin?: (params: {
    channel: string;
    accountId?: string | null;
    chatId?: string | null;
    senderId?: string | null;
    userId?: string;
  }) => Promise<boolean> | boolean;
}

export interface ChatCommandChannelContext {
  channel?: string;
  accountId?: string;
  nativeContextId?: string;
  chatId?: string;
  senderId?: string | null;
  chatType?: string | null;
  fallbackNotice?: string | null;
}

export class ChatCommandService {
  private readonly modelSelectionService: ModelSelectionService;
  private platformApi?: ChatCommandServiceOptions['platformApi'];
  private taskOperations?: ChatCommandServiceOptions['taskOperations'];
  private gateway?: ChatCommandServiceOptions['gateway'];
  private db?: DatabaseSync;
  private isDockerAvailableFn?: () => Promise<boolean> | boolean;
  private checkChatAdmin?: ChatCommandServiceOptions['checkChatAdmin'];

  constructor(optionsOrModelSelection: ModelSelectionService | ChatCommandServiceOptions) {
    if ('resolveEffectiveModel' in optionsOrModelSelection || 'getDshCatalog' in optionsOrModelSelection) {
      this.modelSelectionService = optionsOrModelSelection as ModelSelectionService;
    } else {
      const opts = optionsOrModelSelection as ChatCommandServiceOptions;
      this.modelSelectionService = opts.modelSelectionService;
      this.platformApi = opts.platformApi;
      this.taskOperations = opts.taskOperations;
      this.gateway = opts.gateway;
      this.db = opts.db;
      this.isDockerAvailableFn = opts.isDockerAvailable;
      this.checkChatAdmin = opts.checkChatAdmin;
    }
  }

  setCheckChatAdmin(fn?: ChatCommandServiceOptions['checkChatAdmin']): void {
    this.checkChatAdmin = fn;
  }

  setDockerAvailableCheck(fn: () => Promise<boolean> | boolean): void {
    this.isDockerAvailableFn = fn;
  }

  private async checkDockerAvailability(): Promise<boolean> {
    if (this.isDockerAvailableFn) {
      return Boolean(await this.isDockerAvailableFn());
    }
    return await isDockerAvailable();
  }

  setPlatformApi(platformApi: ChatCommandServiceOptions['platformApi']): void {
    this.platformApi = platformApi;
  }

  setTaskOperations(taskOperations: ChatCommandServiceOptions['taskOperations']): void {
    this.taskOperations = taskOperations;
  }

  setGateway(gateway: ChatCommandServiceOptions['gateway']): void {
    this.gateway = gateway;
  }

  setDb(db: DatabaseSync): void {
    this.db = db;
  }

  private resolveChannelContext(params: {
    sessionId: string;
    channelContext?: ChatCommandChannelContext;
  }): {
    channel: string;
    accountId: string | null;
    nativeContextId: string | null;
    chatId: string | null;
    senderId: string | null;
    chatType: string;
  } {
    if (params.channelContext) {
      return {
        channel: params.channelContext.channel || 'web',
        accountId: params.channelContext.accountId ?? null,
        nativeContextId: params.channelContext.nativeContextId || params.channelContext.chatId || null,
        chatId: params.channelContext.chatId || params.channelContext.nativeContextId || null,
        senderId: params.channelContext.senderId ?? null,
        chatType: params.channelContext.chatType || (params.channelContext.channel === 'web' ? 'p2p' : 'p2p'),
      };
    }
    let channel = 'web';
    let accountId: string | null = null;
    let nativeContextId: string | null = null;
    if (this.db) {
      try {
        const routeRow = this.db
          .prepare('SELECT channel, account_id, native_context_id FROM session_routes WHERE id = ?')
          .get(params.sessionId) as {
            channel?: string;
            account_id?: string | null;
            native_context_id?: string | null;
          } | undefined;
        if (routeRow) {
          if (routeRow.channel) channel = routeRow.channel;
          accountId = routeRow.account_id ?? null;
          nativeContextId = routeRow.native_context_id ?? null;
        }
      } catch {}
    }
    return {
      channel,
      accountId,
      nativeContextId,
      chatId: nativeContextId,
      senderId: null,
      chatType: channel === 'web' ? 'p2p' : 'p2p',
    };
  }

  private getChatAndTopicIds(params: {
    sessionId: string;
    channelContext?: ChatCommandChannelContext;
  }): {
    channel: string;
    accountId: string | null;
    chatNativeContextId: string | null;
    nativeContextId: string | null;
    isTopic: boolean;
    chatType: string;
    senderId: string | null;
  } {
    const ctx = this.resolveChannelContext(params);
    const rawNative = ctx.nativeContextId;

    let chatNativeContextId: string | null = null;
    let isTopic = false;

    if (ctx.channel === 'lark') {
      if (params.channelContext?.chatId) {
        chatNativeContextId = params.channelContext.chatId;
      } else if (rawNative) {
        const colonIdx = rawNative.indexOf(':');
        chatNativeContextId = colonIdx >= 0 ? rawNative.slice(0, colonIdx) : rawNative;
      }
      isTopic = Boolean(rawNative && chatNativeContextId && rawNative !== chatNativeContextId);
    } else {
      chatNativeContextId = rawNative;
      isTopic = false;
    }

    return {
      channel: ctx.channel,
      accountId: ctx.accountId,
      chatNativeContextId,
      nativeContextId: rawNative,
      isTopic,
      chatType: ctx.chatType,
      senderId: ctx.senderId,
    };
  }

  private resetTopicBindings(userId: string, accountId: string, chatNativeContextId: string): number {
    if (!this.db || !accountId || !chatNativeContextId) return 0;
    const pattern = `${chatNativeContextId}:%`;
    try {
      const countRow = this.db.prepare(
        'SELECT COUNT(*) as count FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id LIKE ?'
      ).get(userId, accountId, pattern) as { count?: number } | undefined;
      const count = countRow?.count ?? 0;
      if (count > 0) {
        this.db.prepare(
          'DELETE FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id LIKE ?'
        ).run(userId, accountId, pattern);
      }
      return count;
    } catch {
      return 0;
    }
  }

  async execute(params: {
    userId: string;
    sessionId: string;
    spaceId: string;
    content: string;
    idempotencyKey?: string;
    channelContext?: ChatCommandChannelContext;
  }): Promise<{ replyText: string }> {
    try {
      const parsed = parseChatCommand(params.content, { allowUnknown: true });
      if (!parsed) {
        return { replyText: 'Unrecognized command.' };
      }

      if (parsed.command === 'unknown') {
        return {
          replyText: formatUnknownCommandReply(parsed.word!, parsed.closest ?? null),
        };
      }

      // Group chat permission gating for mutating commands
      const { channel, accountId, nativeContextId, chatId, senderId, chatType } = this.resolveChannelContext(params);
      const isGroup = chatType === 'group';

      if (isGroup && this.isMutatingCommand(parsed)) {
        const isAllowed = this.checkChatAdmin
          ? await this.checkChatAdmin({
              channel,
              accountId,
              chatId,
              senderId,
              userId: params.userId,
            })
          : false;
        if (!isAllowed) {
          return { replyText: '群聊中仅群主或管理员可执行此指令。' };
        }
      }

      let result: { replyText: string };
      switch (parsed.command) {
        case 'help':
          result = { replyText: HELP_USAGE };
          break;
        case 'status':
          result = await this.executeStatusCommand(params, parsed);
          break;
        case 'stop':
          result = await this.executeStopCommand(params, parsed);
          break;
        case 'new':
          result = await this.executeNewCommand(params, parsed);
          break;
        case 'ws':
          result = await this.executeWsCommand(params, parsed);
          break;
        case 'session':
        case 'ses':
          result = await this.executeSessionCommand(params, parsed);
          break;
        case 'newws':
          result = await this.executeWsNewCommand(params, parsed);
          break;
        case 'list':
          result = await this.executeWsListCommand(params, parsed);
          break;
        case 'compact':
          result = await this.executeCompactCommand(params, parsed);
          break;
        case 'model':
          result = await this.executeModelCommand(params, parsed);
          break;
        case 'effort':
          result = await this.executeEffortCommand(params, parsed);
          break;
        case 'sw':
        case 'spawn':
          result = await this.executeSpawnCommand(params, parsed);
          break;
        case 'where':
          result = await this.executeWhereCommand(params, parsed);
          break;
        case 'bind':
          result = await this.executeBindCommand(params, parsed);
          break;
        case 'unbind':
          result = await this.executeUnbindCommand(params, parsed);
          break;
        case 'mention':
        case 'require_mention':
          result = await this.executeMentionCommand(params, parsed);
          break;
        default:
          result = { replyText: 'Unrecognized command.' };
          break;
      }

      if (parsed.legacy) {
        const hint = this.getLegacyHint(parsed.legacy);
        if (hint) {
          result.replyText = `${result.replyText}\n\n${hint}`;
        }
      }

      return result;
    } catch (err: unknown) {
      if (err instanceof ValidationError || err instanceof PlatformError) {
        return { replyText: err.message };
      }
      if (err instanceof Error) {
        return { replyText: err.message };
      }
      return { replyText: String(err) };
    }
  }

  private isMutatingCommand(parsed: ParsedChatCommand): boolean {
    if (parsed.command === 'ws') {
      return parsed.subcommand === 'use' || parsed.subcommand === 'new' || parsed.subcommand === 'home';
    }
    if (parsed.command === 'session' || parsed.command === 'ses') {
      return parsed.subcommand === 'use' || parsed.subcommand === 'new' || parsed.subcommand === 'clear';
    }
    if (parsed.command === 'sw' || parsed.command === 'spawn') {
      return true;
    }
    if (parsed.command === 'bind' || parsed.command === 'unbind' || parsed.command === 'newws') {
      return true;
    }
    if (parsed.command === 'mention' || parsed.command === 'require_mention') {
      return parsed.subcommand === 'set';
    }
    return false;
  }

  private getLegacyHint(legacy: ParsedChatCommand['legacy']): string | null {
    switch (legacy) {
      case 'where':
        return '提示: 建议使用新指令 /ws';
      case 'list':
        return '提示: 建议使用新指令 /ws list';
      case 'bind':
        return '提示: 建议使用新指令 /ws use <目标>';
      case 'unbind':
        return '提示: 建议使用新指令 /ws home';
      case 'newws':
        return '提示: 建议使用新指令 /ws new <名称>';
      default:
        return null;
    }
  }

  private async executeStatusCommand(
    params: { userId: string; sessionId: string; spaceId: string },
    _parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    const { userId, sessionId, spaceId } = params;

    let spaceName = spaceId;
    let spaceMode = 'default';
    let sessionTitle = '(untitled)';
    let currentGen = 1;
    let lastActivity = 'none';

    if (this.db) {
      try {
        const spaceRow = this.db
          .prepare('SELECT name, execution_mode FROM spaces WHERE id = ?')
          .get(spaceId) as { name?: string | null; execution_mode?: string | null } | undefined;
        if (spaceRow) {
          if (spaceRow.name) spaceName = spaceRow.name;
          if (spaceRow.execution_mode) spaceMode = spaceRow.execution_mode;
        }
      } catch {}

      try {
        const routeRow = this.db
          .prepare('SELECT title, current_generation FROM session_routes WHERE id = ?')
          .get(sessionId) as { title?: string | null; current_generation?: number } | undefined;
        if (routeRow) {
          if (routeRow.title) sessionTitle = routeRow.title;
          if (typeof routeRow.current_generation === 'number') currentGen = routeRow.current_generation;
        }
      } catch {}

      try {
        const actRow = this.db
          .prepare('SELECT MAX(created_at) as last_activity FROM web_messages WHERE session_id = ?')
          .get(sessionId) as { last_activity?: string | null } | undefined;
        if (actRow?.last_activity) {
          lastActivity = actRow.last_activity;
        }
      } catch {}
    }

    const shortId = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;

    const effective = await this.modelSelectionService.resolveEffectiveModel({
      sessionId,
      spaceId,
      userId,
    });
    const effortStr = effective.reasoningEffort ?? 'default';
    const modelStr = `${effective.provider}/${effective.model} · ${effortStr} · ${effective.source}`;

    let turnStatus = 'idle';
    let activeCount = 0;
    let queuedCount = 0;
    let queuePosition: number | null = null;

    if (this.db) {
      try {
        const qRow = this.db.prepare(`
          SELECT
            COUNT(CASE WHEN status = 'running' THEN 1 END) as active_count,
            COUNT(CASE WHEN status = 'queued' THEN 1 END) as queued_count
          FROM turn_runs
          WHERE user_id = ?
        `).get(userId) as { active_count?: number; queued_count?: number } | undefined;
        if (qRow) {
          activeCount = Number(qRow.active_count || 0);
          queuedCount = Number(qRow.queued_count || 0);
        }

        const posRow = this.db.prepare(`
          SELECT COUNT(*) as pos
          FROM turn_runs
          WHERE user_id = ? AND status = 'queued' AND created_at <= (
            SELECT MIN(created_at) FROM turn_runs
            WHERE user_id = ? AND route_id = ? AND status = 'queued'
          )
        `).get(userId, userId, sessionId) as { pos?: number } | undefined;
        if (posRow?.pos && posRow.pos > 0) {
          queuePosition = Number(posRow.pos);
        }
      } catch {}
    }

    if (this.gateway?.getCurrentTurnStatus) {
      const turnRes = await this.gateway.getCurrentTurnStatus(userId, sessionId);
      if (turnRes?.status) {
        turnStatus = turnRes.status;
      }
      if (typeof turnRes?.queuePosition === 'number') {
        queuePosition = turnRes.queuePosition;
      }
    } else if (this.db) {
      try {
        const runRow = this.db
          .prepare(`
            SELECT status FROM turn_runs
            WHERE user_id = ? AND route_id = ? AND status IN ('queued', 'running')
            ORDER BY CASE status WHEN 'running' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END, created_at ASC
            LIMIT 1
          `)
          .get(userId, sessionId) as { status: string } | undefined;
        if (runRow?.status) {
          turnStatus = runRow.status;
        }
      } catch {}
    }

    let resourcesStr = 'n/a (idle)';
    if (this.db) {
      try {
        const diagRow = this.db.prepare(`
          SELECT cpu_percent, memory_usage_bytes, memory_limit_bytes, pids_count
          FROM runtime_diagnostics
          WHERE user_id = ? AND (cpu_percent IS NOT NULL OR memory_usage_bytes IS NOT NULL OR pids_count IS NOT NULL)
          ORDER BY created_at DESC
          LIMIT 1
        `).get(userId) as {
          cpu_percent?: number | null;
          memory_usage_bytes?: number | null;
          memory_limit_bytes?: number | null;
          pids_count?: number | null;
        } | undefined;

        if (diagRow) {
          let memStr = 'n/a';
          if (typeof diagRow.memory_usage_bytes === 'number') {
            const usedMb = (diagRow.memory_usage_bytes / (1024 * 1024)).toFixed(1);
            if (typeof diagRow.memory_limit_bytes === 'number' && diagRow.memory_limit_bytes > 0) {
              const limitMb = (diagRow.memory_limit_bytes / (1024 * 1024)).toFixed(0);
              memStr = `${usedMb}MB / ${limitMb}MB`;
            } else {
              memStr = `${usedMb}MB`;
            }
          }
          const cpuStr = typeof diagRow.cpu_percent === 'number'
            ? `${diagRow.cpu_percent.toFixed(1)}%`
            : 'n/a';
          const pidsStr = typeof diagRow.pids_count === 'number'
            ? `${diagRow.pids_count}`
            : 'n/a';

          resourcesStr = `mem ${memStr}, cpu ${cpuStr}, pids ${pidsStr}`;
        }
      } catch {}
    }

    const queuePosText = queuePosition !== null && turnStatus === 'queued' ? ` (#${queuePosition})` : '';
    const lines = [
      `space: ${spaceName} (${spaceMode})`,
      `session: ${shortId} (${sessionTitle})`,
      `generation: ${currentGen}`,
      `model: ${modelStr}`,
      `turn: ${turnStatus}${queuePosText}`,
      `queue: ${turnStatus}${queuePosText} (user queue: ${activeCount} running, ${queuedCount} queued)`,
      `resources: ${resourcesStr}`,
      `last activity: ${lastActivity}`,
    ];
    return { replyText: lines.join('\n') };
  }

  private async executeWhereCommand(
    params: { userId: string; sessionId: string; spaceId: string; channelContext?: ChatCommandChannelContext },
    parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    return await this.executeWsShowCommand(params, { ...parsed, legacy: 'where' });
  }

  private async executeBindCommand(
    params: { userId: string; sessionId: string; spaceId: string; channelContext?: ChatCommandChannelContext },
    parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    return await this.executeWsUseCommand(params, { ...parsed, legacy: 'bind' });
  }

  private async executeUnbindCommand(
    params: { userId: string; sessionId: string; spaceId: string; channelContext?: ChatCommandChannelContext },
    parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    return await this.executeWsHomeCommand(params, { ...parsed, legacy: 'unbind' });
  }

  private async executeNewwsCommand(
    params: { userId: string; sessionId: string; spaceId: string; channelContext?: ChatCommandChannelContext },
    parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    return await this.executeWsNewCommand(params, { ...parsed, legacy: 'newws' });
  }

  private async executeListCommand(
    params: { userId: string; sessionId: string; spaceId: string; channelContext?: ChatCommandChannelContext },
    parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    return await this.executeWsListCommand(params, { ...parsed, legacy: 'list' });
  }

  private async executeWsCommand(
    params: { userId: string; sessionId: string; spaceId: string; channelContext?: ChatCommandChannelContext },
    parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    switch (parsed.subcommand) {
      case 'show':
        return await this.executeWsShowCommand(params, parsed);
      case 'list':
        return await this.executeWsListCommand(params, parsed);
      case 'use':
        return await this.executeWsUseCommand(params, parsed);
      case 'new':
        return await this.executeWsNewCommand(params, parsed);
      case 'home':
        return await this.executeWsHomeCommand(params, parsed);
      default:
        return { replyText: WS_USAGE };
    }
  }

  private async executeWsShowCommand(
    params: { userId: string; sessionId: string; spaceId: string; channelContext?: ChatCommandChannelContext },
    parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    const { userId, sessionId, spaceId } = params;
    const { channel, accountId, chatNativeContextId, nativeContextId } = this.getChatAndTopicIds(params);
    const lookupCtxId = chatNativeContextId || nativeContextId;

    let targetSpaceId = spaceId;
    let agentProfileId: string | null = null;
    if (this.db) {
      try {
        const routeRow = this.db
          .prepare('SELECT space_id, agent_profile_id FROM session_routes WHERE id = ?')
          .get(sessionId) as { space_id?: string; agent_profile_id?: string | null } | undefined;
        if (routeRow?.space_id) targetSpaceId = routeRow.space_id;
        if (routeRow?.agent_profile_id) agentProfileId = routeRow.agent_profile_id;
      } catch {}
    }

    let spaceName = targetSpaceId;
    let folder = targetSpaceId;
    let spaceMode = 'container';

    if (this.db) {
      try {
        const spaceRow = this.db
          .prepare('SELECT name, folder, execution_mode FROM spaces WHERE id = ?')
          .get(targetSpaceId) as { name?: string | null; folder?: string | null; execution_mode?: string | null } | undefined;
        if (spaceRow) {
          if (spaceRow.name) spaceName = spaceRow.name;
          if (spaceRow.folder) folder = spaceRow.folder;
          if (spaceRow.execution_mode) spaceMode = spaceRow.execution_mode;
        }
      } catch {}
    }

    let bindingOrigin = '默认';
    if (channel === 'web') {
      bindingOrigin = '默认';
    } else if (this.db && accountId && lookupCtxId) {
      try {
        const accRow = this.db
          .prepare('SELECT default_space_id FROM channel_accounts WHERE id = ? AND user_id = ?')
          .get(accountId, userId) as { default_space_id?: string | null } | undefined;
        const bindingRow = this.db
          .prepare('SELECT space_id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?')
          .get(userId, accountId, lookupCtxId) as { space_id?: string } | undefined;

        if (bindingRow) {
          if (accRow?.default_space_id && bindingRow.space_id === accRow.default_space_id) {
            bindingOrigin = '默认';
          } else {
            bindingOrigin = '显式';
          }
        }
      } catch {}
    }

    const modeDisplay = spaceMode === 'host' ? '宿主机执行 (host)' : '容器隔离 (container)';

    if (parsed.legacy === 'where') {
      let profileName = 'default';
      if (agentProfileId && this.db) {
        try {
          const profRow = this.db
            .prepare('SELECT name FROM agent_profiles WHERE id = ?')
            .get(agentProfileId) as { name?: string | null } | undefined;
          if (profRow?.name) profileName = profRow.name;
          else profileName = agentProfileId;
        } catch {}
      }

      if (channel === 'web') {
        const lines = [
          `space: ${spaceName} (${targetSpaceId})`,
          `folder: ${folder}`,
          `mode: ${spaceMode}`,
          `profile: ${profileName}`,
          `绑定来源: ${bindingOrigin}`,
          'channel: web (workspace binding is immutable)',
        ];
        return { replyText: lines.join('\n') };
      }

      let activationMode = 'mention';
      if (this.db && accountId && nativeContextId) {
        try {
          const bindingRow = this.db
            .prepare('SELECT activation_mode FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?')
            .get(userId, accountId, nativeContextId) as { activation_mode?: string } | undefined;
          if (bindingRow?.activation_mode) activationMode = bindingRow.activation_mode;
        } catch {}
      }

      const lines = [
        `space: ${spaceName} (${targetSpaceId})`,
        `folder: ${folder}`,
        `mode: ${spaceMode}`,
        `profile: ${profileName}`,
        `绑定来源: ${bindingOrigin}`,
        `channel: ${channel} (context: ${nativeContextId || 'default'}, mode: ${activationMode})`,
      ];
      return { replyText: lines.join('\n') };
    }

    const lines = [
      `工作区: ${spaceName}`,
      `目录: ${folder}`,
      `执行模式: ${modeDisplay}`,
      `绑定来源: ${bindingOrigin}`,
    ];
    return { replyText: lines.join('\n') };
  }

  private async executeWsListCommand(
    params: { userId: string; sessionId: string; spaceId: string; channelContext?: ChatCommandChannelContext },
    _parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    const { userId, sessionId, spaceId } = params;
    const isGroup = params.channelContext?.chatType === 'group';

    let currentSpaceId = spaceId;
    if (this.db) {
      try {
        const routeRow = this.db.prepare('SELECT space_id FROM session_routes WHERE id = ?').get(sessionId) as { space_id?: string } | undefined;
        if (routeRow?.space_id) currentSpaceId = routeRow.space_id;
      } catch {}
    }

    const spaceList = await this.loadActiveSpaces(userId);

    // Group chat permission gating: /ws list in group chat shows current workspace only!
    if (isGroup) {
      let currentSpace = spaceList.find((s) => s.id === currentSpaceId);
      if (!currentSpace) {
        let curName = currentSpaceId;
        let curMode = 'container';
        if (this.db) {
          try {
            const sp = this.db.prepare('SELECT name, execution_mode FROM spaces WHERE id = ? AND user_id = ?').get(currentSpaceId, userId) as { name?: string; execution_mode?: string } | undefined;
            if (sp?.name) curName = sp.name;
            if (sp?.execution_mode) curMode = sp.execution_mode;
          } catch {}
        }
        currentSpace = { id: currentSpaceId, name: curName, executionMode: curMode };
      }
      const lines = [
        `工作区列表 (群聊仅展示当前工作区，共 1 个):`,
        `* ${currentSpace.name} (${currentSpace.executionMode || 'container'})`,
      ];
      return { replyText: lines.join('\n') };
    }

    if (spaceList.length === 0) {
      return { replyText: '没有可用的工作区' };
    }

    if (_parsed?.legacy === 'list') {
      const lines: string[] = [];
      for (const space of spaceList) {
        const isCurrent = space.id === currentSpaceId;
        const mode = space.executionMode || 'container';
        const prefix = isCurrent ? '* ' : '  ';
        lines.push(`${prefix}${space.name} (${mode})`);
      }
      return { replyText: lines.join('\n') };
    }

    const totalCount = spaceList.length;
    const displayed = spaceList.slice(0, 20);
    const header = totalCount > 20
      ? `工作区列表 (共 ${totalCount} 个，显示前 20 个):`
      : `工作区列表 (共 ${totalCount} 个):`;
    const lines = [header];
    for (const space of displayed) {
      const isCurrent = space.id === currentSpaceId;
      const mode = space.executionMode || 'container';
      const prefix = isCurrent ? '* ' : '  ';
      lines.push(`${prefix}${space.name} (${mode})`);
    }

    return { replyText: lines.join('\n') };
  }

  private async executeWsUseCommand(
    params: { userId: string; sessionId: string; spaceId: string; channelContext?: ChatCommandChannelContext },
    parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    const { userId } = params;
    const { channel, accountId, chatNativeContextId, nativeContextId } = this.getChatAndTopicIds(params);
    const targetCtxId = chatNativeContextId || nativeContextId;
    const isLegacyBind = parsed.legacy === 'bind';

    if (channel === 'web') {
      if (isLegacyBind) {
        return { replyText: 'Web 会话工作区绑定固定，请在目标工作区新建会话。' };
      }
      return { replyText: '请在侧栏切换工作区。' };
    }

    const rawTarget = parsed.target?.trim() || parsed.arg?.trim();
    if (!rawTarget) {
      if (isLegacyBind) {
        return { replyText: '用法: /bind <workspace>' };
      }
      return { replyText: '用法: /ws use <名称/目录/ID/main>' };
    }

    if (!this.db) {
      return { replyText: '数据库未连接，无法执行切换。' };
    }

    if (!accountId || !targetCtxId) {
      return { replyText: '当前会话缺少渠道上下文，无法切换。' };
    }

    const cleanTarget = rawTarget.replace(/^["']|["']$/g, '').trim();
    const targetLower = cleanTarget.toLowerCase();
    let targetSpace: { id: string; name: string } | undefined;

    try {
      if (targetLower === 'main' || targetLower === 'home') {
        const accRow = this.db
          .prepare('SELECT default_space_id FROM channel_accounts WHERE id = ? AND user_id = ?')
          .get(accountId, userId) as { default_space_id?: string | null } | undefined;
        if (accRow?.default_space_id) {
          targetSpace = this.db
            .prepare('SELECT id, name FROM spaces WHERE user_id = ? AND id = ?')
            .get(userId, accRow.default_space_id) as typeof targetSpace;
        }
      }

      if (!targetSpace) {
        targetSpace = this.db
          .prepare('SELECT id, name FROM spaces WHERE user_id = ? AND id = ?')
          .get(userId, cleanTarget) as typeof targetSpace;
      }

      if (!targetSpace) {
        targetSpace = this.db
          .prepare('SELECT id, name FROM spaces WHERE user_id = ? AND LOWER(folder) = LOWER(?)')
          .get(userId, cleanTarget) as typeof targetSpace;
      }

      if (!targetSpace) {
        const byName = this.db
          .prepare('SELECT id, name FROM spaces WHERE user_id = ? AND LOWER(name) = LOWER(?)')
          .all(userId, cleanTarget) as Array<{ id: string; name: string }>;
        if (byName.length === 1) {
          targetSpace = byName[0];
        } else if (byName.length > 1) {
          return { replyText: `工作区名称 "${cleanTarget}" 存在歧义，请使用准确的工作区 ID。` };
        }
      }
    } catch {}

    if (!targetSpace) {
      return { replyText: `未找到工作区 "${cleanTarget}"。请使用 /ws list 查看可用工作区。` };
    }

    try {
      const resetCount = this.resetTopicBindings(userId, accountId, targetCtxId);

      const existing = this.db
        .prepare('SELECT id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?')
        .get(userId, accountId, targetCtxId) as { id: string } | undefined;

      if (existing) {
        this.db
          .prepare('UPDATE channel_bindings SET space_id = ?, session_route_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(targetSpace.id, existing.id);
      } else {
        const newId = `cb_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        this.db
          .prepare(`
            INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id, activation_mode, session_route_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'mention', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `)
          .run(newId, userId, accountId, targetSpace.id, targetCtxId);
      }

      const resetNotice = resetCount > 0 ? `\n已重置 ${resetCount} 个话题。` : '';
      if (isLegacyBind) {
        return { replyText: `已绑定到工作区: ${targetSpace.name}。之后本聊天的消息会进入该工作区的会话。${resetNotice}` };
      }
      return { replyText: `已切换到工作区: ${targetSpace.name} (主会话)${resetNotice}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { replyText: `切换失败: ${msg}` };
    }
  }

  private async executeWsNewCommand(
    params: { userId: string; sessionId: string; spaceId: string; channelContext?: ChatCommandChannelContext },
    parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    const { userId } = params;
    const rawName = parsed.target !== undefined ? parsed.target : (parsed.arg !== undefined ? parsed.arg : '');
    const trimmedName = typeof rawName === 'string' ? rawName.trim() : '';

    if (!trimmedName || trimmedName.length < 1 || trimmedName.length > 50) {
      return { replyText: '工作区名称长度必须在 1 到 50 个字符之间。' };
    }

    const dockerAvailable = await this.checkDockerAvailability();
    const executionMode: 'container' | 'host' = dockerAvailable ? 'container' : 'host';

    let createdSpace: { id: string; name: string } | undefined;
    if (this.platformApi?.createSpace) {
      const res = await this.platformApi.createSpace(userId, { name: trimmedName, executionMode });
      createdSpace = { id: res.id, name: res.name };
    } else if (this.db) {
      const newId = `spc_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const folderHex = randomUUID().replace(/-/g, '').slice(0, 16);
      const internalFolder = `space-${folderHex}`;
      this.db.prepare(`
        INSERT INTO spaces (id, user_id, name, folder, execution_mode, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(newId, userId, trimmedName, internalFolder, executionMode);
      createdSpace = { id: newId, name: trimmedName };
    } else {
      return { replyText: '平台服务未连接，无法创建工作区。' };
    }

    const { channel } = this.resolveChannelContext(params);
    const isLegacyNewws = parsed.legacy === 'newws';
    if (channel === 'web') {
      if (isLegacyNewws) {
        return {
          replyText: `工作区 "${createdSpace.name}" 已创建。Web 会话工作区绑定固定，请从工作区列表切换打开。`,
        };
      }
      return { replyText: `工作区 "${createdSpace.name}" 已创建。请在侧栏切换打开。` };
    }

    const bindResult = await this.executeWsUseCommand(params, {
      command: isLegacyNewws ? 'bind' : 'ws',
      type: isLegacyNewws ? 'bind' : 'ws',
      subcommand: isLegacyNewws ? 'bind' : 'use',
      action: isLegacyNewws ? 'bind' : 'use',
      target: createdSpace.id,
      arg: createdSpace.id,
      legacy: isLegacyNewws ? 'bind' : undefined,
      raw: isLegacyNewws ? `/bind ${createdSpace.id}` : `/ws use ${createdSpace.id}`,
    });

    if (isLegacyNewws) {
      if (bindResult.replyText.startsWith('已绑定到工作区')) {
        return {
          replyText: `工作区 "${createdSpace.name}" 已创建。\n${bindResult.replyText}`,
        };
      }
      return {
        replyText: `工作区 "${createdSpace.name}" 已创建，但绑定失败: ${bindResult.replyText}`,
      };
    }

    if (bindResult.replyText.startsWith('已切换到工作区')) {
      return { replyText: `工作区 "${createdSpace.name}" 已创建并切换。` };
    }

    return { replyText: `工作区 "${createdSpace.name}" 已创建，但切换失败: ${bindResult.replyText}` };
  }

  private async executeWsHomeCommand(
    params: { userId: string; sessionId: string; spaceId: string; channelContext?: ChatCommandChannelContext },
    parsed?: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    const { userId } = params;
    const { channel, accountId, chatNativeContextId, nativeContextId } = this.getChatAndTopicIds(params);
    const targetCtxId = chatNativeContextId || nativeContextId;
    const isLegacyUnbind = parsed?.legacy === 'unbind' || parsed?.command === 'unbind';

    if (channel === 'web') {
      if (isLegacyUnbind) {
        return { replyText: 'Web 会话工作区绑定固定，无需解除绑定。' };
      }
      return { replyText: '请在侧栏切换工作区。' };
    }

    if (!this.db) {
      return { replyText: '数据库未连接，无法执行回到默认工作区。' };
    }

    if (!accountId || !targetCtxId) {
      return { replyText: '当前会话缺少渠道上下文，无法回到默认工作区。' };
    }

    try {
      const accRow = this.db
        .prepare('SELECT default_space_id FROM channel_accounts WHERE id = ? AND user_id = ?')
        .get(accountId, userId) as { default_space_id?: string | null } | undefined;

      if (!accRow?.default_space_id) {
        return { replyText: '渠道账号未设置默认工作区，已保留当前绑定。' };
      }

      const defaultSpace = this.db
        .prepare('SELECT id, name, folder, execution_mode FROM spaces WHERE id = ? AND user_id = ?')
        .get(accRow.default_space_id, userId) as { id: string; name: string; folder?: string } | undefined;

      if (!defaultSpace) {
        return { replyText: '默认工作区不存在，已保留当前绑定。' };
      }

      const resetCount = this.resetTopicBindings(userId, accountId, targetCtxId);

      this.db
        .prepare('DELETE FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?')
        .run(userId, accountId, targetCtxId);

      const resetNotice = resetCount > 0 ? `\n已重置 ${resetCount} 个话题。` : '';
      if (isLegacyUnbind) {
        return { replyText: `已恢复渠道默认工作区: ${defaultSpace.name} (${defaultSpace.folder || defaultSpace.id})${resetNotice}` };
      }
      return { replyText: `已回到账号默认工作区: ${defaultSpace.name}${resetNotice}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { replyText: `操作失败: ${msg}` };
    }
  }

  private async executeSessionCommand(
    params: { userId: string; sessionId: string; spaceId: string; idempotencyKey?: string; channelContext?: ChatCommandChannelContext },
    parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    switch (parsed.subcommand) {
      case 'show':
        return await this.executeSessionShowCommand(params);
      case 'list':
        return await this.executeSessionListCommand(params);
      case 'use':
        return await this.executeSessionUseCommand(params, parsed);
      case 'new':
        return await this.executeSessionNewCommand(params, parsed);
      case 'clear':
        return await this.executeSessionClearCommand(params, parsed);
      default:
        return { replyText: SESSION_USAGE };
    }
  }

  private async executeSessionShowCommand(
    params: { userId: string; sessionId: string; spaceId: string; channelContext?: ChatCommandChannelContext }
  ): Promise<{ replyText: string }> {
    const { userId, sessionId, spaceId } = params;

    let targetSpaceId = spaceId;
    let title: string | null = null;
    let currentGen = 1;
    let lastActivity = 'none';

    let allSessionIdsInSpace: string[] = [sessionId];
    let canonicalSessionId: string | null = null;

    if (this.db) {
      try {
        const routeRow = this.db
          .prepare('SELECT space_id, title, current_generation, created_at, updated_at FROM session_routes WHERE id = ? AND user_id = ?')
          .get(sessionId, userId) as {
            space_id?: string;
            title?: string | null;
            current_generation?: number;
            created_at?: string;
            updated_at?: string;
          } | undefined;
        if (routeRow) {
          if (routeRow.space_id) targetSpaceId = routeRow.space_id;
          title = routeRow.title ?? null;
          if (typeof routeRow.current_generation === 'number') currentGen = routeRow.current_generation;
          lastActivity = routeRow.updated_at || routeRow.created_at || 'none';
        }

        const spaceRow = this.db
          .prepare('SELECT canonical_session_id FROM spaces WHERE id = ?')
          .get(targetSpaceId) as { canonical_session_id?: string | null } | undefined;
        if (spaceRow) {
          canonicalSessionId = spaceRow.canonical_session_id ?? null;
        }

        const siblingRows = this.db
          .prepare("SELECT id FROM session_routes WHERE space_id = ? AND user_id = ? AND status = 'active'")
          .all(targetSpaceId, userId) as Array<{ id: string }>;
        if (siblingRows.length > 0) {
          allSessionIdsInSpace = siblingRows.map((r) => r.id);
        }

        const msgRow = this.db
          .prepare('SELECT MAX(created_at) as last_msg FROM web_messages WHERE session_id = ?')
          .get(sessionId) as { last_msg?: string | null } | undefined;
        if (msgRow?.last_msg) {
          lastActivity = msgRow.last_msg;
        }
      } catch {}
    }

    const shortId = computeSessionShortId(sessionId, allSessionIdsInSpace);
    const isCanonical = canonicalSessionId === sessionId;

    const lines = [
      `会话: ${shortId}`,
      `标题: ${title || '未命名'}`,
      `主会话: ${isCanonical ? '是' : '否'}`,
      `代际: 第 ${currentGen} 代`,
      `最后活跃: ${lastActivity}`,
    ];
    return { replyText: lines.join('\n') };
  }

  private async executeSessionListCommand(
    params: { userId: string; sessionId: string; spaceId: string; channelContext?: ChatCommandChannelContext }
  ): Promise<{ replyText: string }> {
    const { userId, sessionId, spaceId } = params;

    let targetSpaceId = spaceId;
    let canonicalSessionId: string | null = null;

    if (this.db) {
      try {
        const routeRow = this.db
          .prepare('SELECT space_id FROM session_routes WHERE id = ?')
          .get(sessionId) as { space_id?: string } | undefined;
        if (routeRow?.space_id) targetSpaceId = routeRow.space_id;

        const spaceRow = this.db
          .prepare('SELECT canonical_session_id FROM spaces WHERE id = ?')
          .get(targetSpaceId) as { canonical_session_id?: string | null } | undefined;
        if (spaceRow) canonicalSessionId = spaceRow.canonical_session_id ?? null;

        const sessionRows = this.db
          .prepare("SELECT id, title, current_generation, created_at, updated_at FROM session_routes WHERE space_id = ? AND user_id = ? AND status = 'active'")
          .all(targetSpaceId, userId) as Array<{ id: string; title: string | null; current_generation: number; created_at: string; updated_at: string }>;

        const msgRows = this.db
          .prepare('SELECT session_id, MAX(created_at) as last_msg FROM web_messages WHERE user_id = ? GROUP BY session_id')
          .all(userId) as Array<{ session_id: string; last_msg?: string | null }>;
        const msgMap = new Map<string, string>();
        for (const m of msgRows) {
          if (m.last_msg) msgMap.set(m.session_id, m.last_msg);
        }

        const allIds = sessionRows.map((r) => r.id);
        const sorted = sessionRows.map((s) => ({
          ...s,
          shortId: computeSessionShortId(s.id, allIds),
          lastAct: msgMap.get(s.id) || s.updated_at || s.created_at,
          isCurrent: s.id === sessionId,
          isCanonical: s.id === canonicalSessionId,
        }));

        sorted.sort((a, b) => {
          const diff = new Date(b.lastAct).getTime() - new Date(a.lastAct).getTime();
          return diff !== 0 ? diff : b.id.localeCompare(a.id);
        });

        if (sorted.length === 0) {
          return { replyText: '当前工作区暂无有效会话' };
        }

        const lines = [`当前工作区会话 (共 ${sorted.length} 个):`];
        for (const s of sorted) {
          const prefix = s.isCurrent ? '* ' : '  ';
          const canonTag = s.isCanonical ? ' [主会话]' : '';
          lines.push(`${prefix}${s.shortId} - ${s.title || '未命名'}${canonTag} (第 ${s.current_generation || 1} 代)`);
        }
        return { replyText: lines.join('\n') };
      } catch (err) {
        return { replyText: `查询会话失败: ${String(err)}` };
      }
    }

    return { replyText: '当前工作区暂无有效会话' };
  }

  private async executeSessionUseCommand(
    params: { userId: string; sessionId: string; spaceId: string; channelContext?: ChatCommandChannelContext },
    parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    const { userId, sessionId, spaceId } = params;
    const { channel, accountId, chatNativeContextId, nativeContextId, isTopic } = this.getChatAndTopicIds(params);

    if (channel === 'web') {
      return { replyText: '请在侧栏切换会话。' };
    }

    const rawTarget = parsed.target?.trim() || parsed.arg?.trim();
    if (!rawTarget) {
      return { replyText: '用法: /session use <短ID/标题/main>' };
    }

    if (!this.db) {
      return { replyText: '数据库未连接，无法切换会话。' };
    }
    const targetCtxId = chatNativeContextId || nativeContextId;
    if (!accountId || !targetCtxId) {
      return { replyText: '当前会话缺少渠道上下文，无法切换。' };
    }

    let targetSpaceId = spaceId;
    try {
      const bindingRow = this.db.prepare(
        'SELECT space_id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?'
      ).get(userId, accountId, targetCtxId) as { space_id?: string } | undefined;
      if (bindingRow?.space_id) {
        targetSpaceId = bindingRow.space_id;
      } else {
        const routeRow = this.db.prepare('SELECT space_id FROM session_routes WHERE id = ? AND user_id = ?').get(sessionId, userId) as { space_id?: string } | undefined;
        if (routeRow?.space_id) targetSpaceId = routeRow.space_id;
      }
    } catch {}

    const writeToChatLevel = parsed.all || !isTopic;
    const bindingTargetCtx = writeToChatLevel ? targetCtxId : nativeContextId!;

    const targetLower = rawTarget.toLowerCase();
    if (targetLower === 'main') {
      try {
        const existing = this.db.prepare(
          'SELECT id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?'
        ).get(userId, accountId, bindingTargetCtx) as { id: string } | undefined;
        if (existing) {
          this.db.prepare('UPDATE channel_bindings SET session_route_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(existing.id);
        }
        return { replyText: '已切换为跟随主会话。' };
      } catch (err: unknown) {
        return { replyText: `切换失败: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    // Match session in current space
    const activeSessions = this.db.prepare(
      "SELECT id, title FROM session_routes WHERE space_id = ? AND user_id = ? AND status = 'active'"
    ).all(targetSpaceId, userId) as Array<{ id: string; title: string | null }>;

    const spaceRow = this.db.prepare('SELECT canonical_session_id FROM spaces WHERE id = ? AND user_id = ?').get(targetSpaceId, userId) as { canonical_session_id?: string | null } | undefined;
    const matchRes = matchSessionInSpace(rawTarget, activeSessions, spaceRow?.canonical_session_id);

    if (matchRes.ambiguous) {
      return { replyText: `会话标识 "${rawTarget}" 存在歧义，请使用更长的短 ID 或完整会话 ID。` };
    }
    if (!matchRes.matched) {
      return { replyText: `未找到会话 "${rawTarget}"。请使用 /session list 查看可用会话。` };
    }

    const matchedSession = matchRes.matched;
    try {
      let chatActivationMode = 'mention';
      const chatBinding = this.db.prepare(
        'SELECT activation_mode FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?'
      ).get(userId, accountId, targetCtxId) as { activation_mode?: string } | undefined;
      if (chatBinding?.activation_mode) {
        chatActivationMode = chatBinding.activation_mode;
      }

      const existing = this.db.prepare(
        'SELECT id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?'
      ).get(userId, accountId, bindingTargetCtx) as { id: string } | undefined;

      if (existing) {
        this.db.prepare(
          'UPDATE channel_bindings SET space_id = ?, session_route_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run(targetSpaceId, matchedSession.id, existing.id);
      } else {
        const newId = `cb_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        this.db.prepare(`
          INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id, activation_mode, session_route_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run(newId, userId, accountId, targetSpaceId, bindingTargetCtx, chatActivationMode, matchedSession.id);
      }

      const allIds = activeSessions.map((s) => s.id);
      const shortId = computeSessionShortId(matchedSession.id, allIds);
      return { replyText: `已固定到会话: ${shortId} (${matchedSession.title || '未命名'})` };
    } catch (err: unknown) {
      return { replyText: `固定会话失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async executeSessionNewCommand(
    params: { userId: string; sessionId: string; spaceId: string; channelContext?: ChatCommandChannelContext },
    parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    const { userId, sessionId, spaceId } = params;
    const { channel, accountId, chatNativeContextId, nativeContextId, isTopic } = this.getChatAndTopicIds(params);

    const targetCtxId = chatNativeContextId || nativeContextId;
    let targetSpaceId = spaceId;
    if (this.db) {
      try {
        if (targetCtxId && accountId) {
          const bindingRow = this.db.prepare(
            'SELECT space_id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?'
          ).get(userId, accountId, targetCtxId) as { space_id?: string } | undefined;
          if (bindingRow?.space_id) {
            targetSpaceId = bindingRow.space_id;
          }
        }
        if (!targetSpaceId) {
          const routeRow = this.db.prepare('SELECT space_id FROM session_routes WHERE id = ? AND user_id = ?').get(sessionId, userId) as { space_id?: string } | undefined;
          if (routeRow?.space_id) targetSpaceId = routeRow.space_id;
        }
      } catch {}
    }

    const rawTitle = parsed.target !== undefined ? parsed.target : (parsed.arg !== undefined ? parsed.arg : '');
    const title = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : null;

    let createdSession: { id: string; title: string | null } | undefined;

    if (this.platformApi?.createSession) {
      const res = await this.platformApi.createSession(userId, {
        spaceId: targetSpaceId,
        title,
        forceNew: true,
      });
      createdSession = { id: res.id, title: (res as any).title ?? title };
    } else if (this.db) {
      const spaceRow = this.db.prepare(
        'SELECT execution_mode, canonical_session_id, agent_profile_id, agent_profile_snapshot_id FROM spaces WHERE id = ? AND user_id = ?'
      ).get(targetSpaceId, userId) as { execution_mode?: string; canonical_session_id?: string | null; agent_profile_id?: string | null; agent_profile_snapshot_id?: string | null } | undefined;

      const newSessionId = `ses_${randomUUID().replace(/-/g, '')}`;
      const dshSessionId = `ses_${randomUUID().replace(/-/g, '')}`;
      const execMode = spaceRow?.execution_mode || 'container';

      this.db.prepare(`
        INSERT INTO session_routes (
          id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id,
          execution_mode, status, title, reset_count, current_generation, agent_profile_id, agent_profile_snapshot_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 0, 1, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(
        newSessionId,
        targetSpaceId,
        userId,
        channel,
        accountId || 'default',
        newSessionId,
        `${channel}:${newSessionId}`,
        dshSessionId,
        execMode,
        title,
        spaceRow?.agent_profile_id ?? null,
        spaceRow?.agent_profile_snapshot_id ?? null
      );

      const genId = `gen_${randomUUID().replace(/-/g, '')}`;
      this.db.prepare(`
        INSERT INTO session_generations (
          id, user_id, route_id, generation_number, dsh_session_id, agent_profile_snapshot_id, reset_reason, created_at
        )
        VALUES (?, ?, ?, 1, ?, ?, 'initial', CURRENT_TIMESTAMP)
      `).run(genId, userId, newSessionId, dshSessionId, spaceRow?.agent_profile_snapshot_id ?? null);

      if (!spaceRow?.canonical_session_id) {
        this.db.prepare('UPDATE spaces SET canonical_session_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?').run(newSessionId, targetSpaceId, userId);
      }

      createdSession = { id: newSessionId, title };
    } else {
      return { replyText: '平台服务未连接，无法创建会话。' };
    }

    let allIds = [createdSession.id];
    if (this.db) {
      try {
        const rows = this.db.prepare("SELECT id FROM session_routes WHERE space_id = ? AND user_id = ? AND status = 'active'").all(targetSpaceId, userId) as Array<{ id: string }>;
        allIds = rows.map((r) => r.id);
      } catch {}
    }
    const shortId = computeSessionShortId(createdSession.id, allIds);

    if (channel === 'web') {
      return { replyText: `会话 "${createdSession.title || shortId}" 已创建。请在侧栏切换打开。` };
    }

    const bindingTargetCtx = isTopic ? nativeContextId : targetCtxId;
    if (this.db && accountId && bindingTargetCtx) {
      try {
        let chatActivationMode = 'mention';
        if (targetCtxId) {
          const chatBinding = this.db.prepare(
            'SELECT activation_mode FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?'
          ).get(userId, accountId, targetCtxId) as { activation_mode?: string } | undefined;
          if (chatBinding?.activation_mode) {
            chatActivationMode = chatBinding.activation_mode;
          }
        }

        const existing = this.db.prepare(
          'SELECT id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?'
        ).get(userId, accountId, bindingTargetCtx) as { id: string } | undefined;

        if (existing) {
          this.db.prepare('UPDATE channel_bindings SET space_id = ?, session_route_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(targetSpaceId, createdSession.id, existing.id);
        } else {
          const newId = `cb_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
          this.db.prepare(`
            INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id, activation_mode, session_route_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `).run(newId, userId, accountId, targetSpaceId, bindingTargetCtx, chatActivationMode, createdSession.id);
        }
      } catch (err: unknown) {
        return { replyText: `新建会话成功但固定失败: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    return { replyText: `已新建会话并固定: ${shortId}${createdSession.title ? ` (${createdSession.title})` : ''}` };
  }

  private async executeMentionCommand(
    params: { userId: string; sessionId: string; spaceId: string; channelContext?: ChatCommandChannelContext },
    parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    const { userId } = params;
    const { channel, accountId, chatNativeContextId, nativeContextId, chatType } = this.getChatAndTopicIds(params);

    if (channel === 'web' || chatType === 'p2p') {
      return { replyText: '私聊不适用（总是回复）。' };
    }

    if (parsed.subcommand === 'unknown') {
      return { replyText: '用法: /mention [on|off] 或 /require_mention [true|false]' };
    }

    const targetCtxId = chatNativeContextId || nativeContextId;
    if (!this.db || !accountId || !targetCtxId) {
      return { replyText: '当前会话缺少渠道上下文，无法配置 @ 模式。' };
    }

    if (parsed.subcommand === 'show') {
      let mode = 'mention';
      try {
        const binding = this.db.prepare(
          'SELECT activation_mode FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?'
        ).get(userId, accountId, targetCtxId) as { activation_mode?: string } | undefined;
        if (binding?.activation_mode) {
          mode = binding.activation_mode;
        } else {
          const acc = this.db.prepare(
            'SELECT group_activation_mode FROM channel_accounts WHERE id = ? AND user_id = ?'
          ).get(accountId, userId) as { group_activation_mode?: string | null } | undefined;
          if (acc?.group_activation_mode) {
            mode = acc.group_activation_mode;
          }
        }
      } catch {}

      if (mode === 'always') {
        return { replyText: '当前设置: 回复所有消息 (off)' };
      }
      return { replyText: '当前设置: 仅在被 @ 时回复 (on)' };
    }

    // parsed.subcommand === 'set'
    const targetMode = parsed.target === 'off' ? 'always' : 'mention';
    try {
      const existing = this.db.prepare(
        'SELECT id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?'
      ).get(userId, accountId, targetCtxId) as { id: string } | undefined;

      if (existing) {
        this.db.prepare(
          'UPDATE channel_bindings SET activation_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run(targetMode, existing.id);
      } else {
        let defaultSpaceId = params.spaceId;
        try {
          const acc = this.db.prepare(
            'SELECT default_space_id FROM channel_accounts WHERE id = ? AND user_id = ?'
          ).get(accountId, userId) as { default_space_id?: string | null } | undefined;
          if (acc?.default_space_id) {
            defaultSpaceId = acc.default_space_id;
          }
        } catch {}

        const newId = `cb_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        this.db.prepare(`
          INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id, activation_mode, session_route_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run(newId, userId, accountId, defaultSpaceId, targetCtxId, targetMode);
      }

      if (parsed.target === 'off') {
        return { replyText: '已关闭 @ 模式：机器人将回复群内所有消息。\n提示：需要在飞书开放平台开通“获取群组中所有消息”权限。' };
      }
      return { replyText: '已开启 @ 模式：仅在被 @ 机器人时回复。' };
    } catch (err: unknown) {
      return { replyText: `配置失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async executeSessionClearCommand(
    params: {
      userId: string;
      sessionId: string;
      spaceId: string;
      idempotencyKey?: string;
      channelContext?: ChatCommandChannelContext;
    },
    parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    const { userId, sessionId, spaceId, idempotencyKey } = params;
    const { accountId, nativeContextId } = this.resolveChannelContext(params);

    // Active turn check
    let hasActiveTurn = false;
    if (this.gateway?.getCurrentTurnStatus) {
      const turnStatus = await this.gateway.getCurrentTurnStatus(userId, sessionId);
      if (turnStatus && (turnStatus.status === 'running' || turnStatus.status === 'queued')) {
        hasActiveTurn = true;
      }
    } else if (this.db) {
      try {
        const row = this.db.prepare(
          "SELECT status FROM turn_runs WHERE user_id = ? AND route_id = ? AND status IN ('queued', 'running') LIMIT 1"
        ).get(userId, sessionId) as { status: string } | undefined;
        if (row) hasActiveTurn = true;
      } catch {}
    }

    if (hasActiveTurn) {
      return { replyText: 'a turn is active, use /stop first' };
    }

    let targetSpaceId = spaceId;
    if (this.db) {
      try {
        const routeRow = this.db.prepare('SELECT space_id FROM session_routes WHERE id = ? AND user_id = ?').get(sessionId, userId) as { space_id?: string } | undefined;
        if (routeRow?.space_id) targetSpaceId = routeRow.space_id;
      } catch {}
    }

    let isCanonical = false;
    if (this.db) {
      try {
        const spaceRow = this.db.prepare('SELECT canonical_session_id FROM spaces WHERE id = ? AND user_id = ?').get(targetSpaceId, userId) as { canonical_session_id?: string | null } | undefined;
        isCanonical = (spaceRow?.canonical_session_id === sessionId);
      } catch {}
    }

    const isConfirmed = Boolean(parsed.isConfirm);

    // Dependency check for canonical main session
    if (isCanonical && !isConfirmed && this.db) {
      let otherBindingsCount = 0;
      let currentBindingId: string | null = null;
      if (accountId && nativeContextId) {
        const curB = this.db.prepare(
          'SELECT id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?'
        ).get(userId, accountId, nativeContextId) as { id: string } | undefined;
        if (curB) currentBindingId = curB.id;
      }

      try {
        const bRows = this.db.prepare(
          'SELECT id, session_route_id FROM channel_bindings WHERE user_id = ? AND space_id = ?'
        ).all(userId, targetSpaceId) as Array<{ id: string; session_route_id: string | null }>;
        for (const b of bRows) {
          if (currentBindingId && b.id === currentBindingId) continue;
          if (!b.session_route_id) {
            otherBindingsCount++;
          }
        }
      } catch {}

      let scheduledTaskCount = 0;
      try {
        const taskRows = this.db.prepare(`
          SELECT t.id, t.payload FROM platform_tasks t
          LEFT JOIN task_schedules s ON s.task_id = t.id
          WHERE t.user_id = ?
            AND (
              (s.id IS NOT NULL AND s.enabled = 1)
              OR t.status IN ('pending', 'claimed', 'running')
            )
        `).all(userId) as Array<{ id: string; payload: string | null }>;
        for (const t of taskRows) {
          if (!t.payload) continue;
          try {
            const p = JSON.parse(t.payload);
            if (p.sessionPolicy === 'existing_session' && p.sessionId === sessionId) {
              scheduledTaskCount++;
            }
          } catch {}
        }
      } catch {}

      const dependencyCount = otherBindingsCount + scheduledTaskCount;
      if (dependencyCount > 0) {
        return {
          replyText: `当前主会话正被 ${otherBindingsCount} 个其他绑定及 ${scheduledTaskCount} 个定时任务（共 ${dependencyCount} 处依赖）共享使用。清空将影响所有依赖项。\n如确认清空，请发送: /session clear confirm`,
        };
      }
    }

    // Execute resetSession
    if (this.platformApi?.resetSession) {
      const effectiveIdempotencyKey = idempotencyKey && UUID_V4_REGEX.test(idempotencyKey) ? idempotencyKey.toLowerCase() : randomUUID();
      const resetResult = await this.platformApi.resetSession(userId, sessionId, {
        idempotencyKey: effectiveIdempotencyKey,
        reason: 'chat_command',
      });
      const newGen = resetResult.generation.generation;
      const oldGen = newGen - 1;
      return { replyText: `Started generation ${newGen} (was ${oldGen})` };
    }

    if (this.db) {
      const routeRow = this.db.prepare(
        'SELECT current_generation, reset_count, agent_profile_snapshot_id FROM session_routes WHERE id = ? AND user_id = ?'
      ).get(sessionId, userId) as { current_generation?: number; reset_count?: number; agent_profile_snapshot_id?: string | null } | undefined;
      const oldGen = routeRow?.current_generation || 1;
      const newGen = oldGen + 1;
      const newResetCount = (routeRow?.reset_count || 0) + 1;
      const newDshSessionId = `ses_${randomUUID().replace(/-/g, '')}`;

      this.db.prepare(`
        INSERT INTO session_generations (id, user_id, route_id, generation_number, dsh_session_id, agent_profile_snapshot_id, reset_reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'chat_command', CURRENT_TIMESTAMP)
      `).run(`gen_${randomUUID().replace(/-/g, '')}`, userId, sessionId, newGen, newDshSessionId, routeRow?.agent_profile_snapshot_id ?? null);

      this.db.prepare(`
        UPDATE session_routes
        SET dsh_session_id = ?, current_generation = ?, reset_count = ?, last_reset_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `).run(newDshSessionId, newGen, newResetCount, sessionId, userId);

      return { replyText: `Started generation ${newGen} (was ${oldGen})` };
    }

    return { replyText: '平台服务未连接，无法清空会话。' };
  }

  private async executeStopCommand(
    params: { userId: string; sessionId: string },
    _parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    const { userId, sessionId } = params;
    if (!this.gateway?.cancelCurrentTurn) {
      return { replyText: 'nothing running' };
    }
    const cancelled = await this.gateway.cancelCurrentTurn(userId, sessionId);
    if (cancelled) {
      return { replyText: 'cancelled' };
    }
    return { replyText: 'nothing running' };
  }

  private async executeNewCommand(
    _params: { userId: string; sessionId: string; idempotencyKey?: string },
    _parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    return {
      replyText: '新会话请使用 /session new，新建工作区请使用 /ws new',
    };
  }

  private async loadActiveSpaces(userId: string): Promise<Array<{ id: string; name: string; executionMode?: string; lastActivityAt?: string }>> {
    let spaceList: Array<{ id: string; name: string; executionMode?: string; lastActivityAt?: string }> = [];
    if (this.db) {
      try {
        const msgRows = this.db.prepare(
          'SELECT session_id, MAX(created_at) as last_msg FROM web_messages WHERE user_id = ? GROUP BY session_id'
        ).all(userId) as Array<{ session_id: string; last_msg?: string | null }>;
        const msgMap = new Map<string, string>();
        for (const row of msgRows) {
          if (row.last_msg) msgMap.set(row.session_id, row.last_msg);
        }

        const sessionRows = this.db.prepare(
          "SELECT id, space_id, created_at, updated_at FROM session_routes WHERE user_id = ? AND status != 'deleted'"
        ).all(userId) as Array<{ id: string; space_id: string; created_at: string; updated_at: string }>;

        const spaceMaxMap = new Map<string, string>();
        for (const s of sessionRows) {
          const sAct = msgMap.get(s.id) || s.updated_at || s.created_at;
          const curMax = spaceMaxMap.get(s.space_id);
          if (!curMax || new Date(sAct).getTime() > new Date(curMax).getTime()) {
            spaceMaxMap.set(s.space_id, sAct);
          }
        }

        const spaceRows = this.db.prepare(
          "SELECT id, name, execution_mode, created_at, updated_at FROM spaces WHERE user_id = ? AND (status = 'active' OR status IS NULL)"
        ).all(userId) as Array<{ id: string; name: string; execution_mode?: string; created_at: string; updated_at: string }>;

        spaceList = spaceRows.map((s) => {
          const sessionMax = spaceMaxMap.get(s.id);
          const lastActivityAt = sessionMax || s.updated_at || s.created_at;
          return {
            id: s.id,
            name: s.name,
            executionMode: s.execution_mode || 'container',
            lastActivityAt,
          };
        });

        spaceList.sort((a, b) => {
          const diff = new Date(b.lastActivityAt || 0).getTime() - new Date(a.lastActivityAt || 0).getTime();
          return diff !== 0 ? diff : b.id.localeCompare(a.id);
        });
      } catch {}
    } else if (this.platformApi?.listSpaces) {
      try {
        const apiSpaces = await this.platformApi.listSpaces(userId, { includeArchived: false });
        spaceList = apiSpaces.map((s) => ({
          id: s.id,
          name: s.name,
          executionMode: s.executionMode || (s as any).execution_mode || 'container',
          lastActivityAt: s.lastActivityAt,
        }));
        spaceList.sort((a, b) => {
          const diff = new Date(b.lastActivityAt || 0).getTime() - new Date(a.lastActivityAt || 0).getTime();
          return diff !== 0 ? diff : b.id.localeCompare(a.id);
        });
      } catch {}
    }
    return spaceList;
  }

  private async executeCompactCommand(
    params: { userId: string; sessionId: string; spaceId: string },
    _parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    const { userId, sessionId } = params;

    let hasActiveTurn = false;
    if (this.gateway) {
      const currentTurn = await this.gateway.getCurrentTurnStatus(userId, sessionId);
      hasActiveTurn = Boolean(currentTurn && (currentTurn.status === 'running' || currentTurn.status === 'queued'));
    }
    if (!hasActiveTurn && this.db) {
      try {
        const row = this.db
          .prepare(`
            SELECT status FROM turn_runs
            WHERE user_id = ? AND route_id = ? AND status IN ('queued', 'running')
            LIMIT 1
          `)
          .get(userId, sessionId) as { status: string } | undefined;
        if (row) {
          hasActiveTurn = true;
        }
      } catch {}
    }

    if (hasActiveTurn) {
      return { replyText: 'a turn is active, use /stop first' };
    }

    if (!this.platformApi?.compactSession) {
      return { replyText: 'Platform API compactSession unavailable.' };
    }

    try {
      const res = await this.platformApi.compactSession(userId, sessionId);
      const beforeTok = res.beforeTokens !== undefined ? `${res.beforeTokens}` : 'unknown';
      const afterTok = res.afterTokens !== undefined ? `${res.afterTokens}` : 'unknown';
      return {
        replyText: `Session compacted: ${beforeTok} -> ${afterTok} tokens, ${res.eventsBefore} -> ${res.eventsAfter} events, summary ${res.summaryChars} chars.`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { replyText: `Compaction failed: ${message}` };
    }
  }

  private async executeModelCommand(
    params: { userId: string; sessionId: string; spaceId: string },
    parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    const { userId, sessionId, spaceId } = params;

    if (parsed.subcommand === 'unknown') {
      return { replyText: MODEL_USAGE };
    }

    if (parsed.subcommand === 'show') {
      const effective = await this.modelSelectionService.resolveEffectiveModel({
        sessionId,
        spaceId,
        userId,
      });
      const effortStr = effective.reasoningEffort ?? 'default';
      return {
        replyText: `Current model: ${effective.provider}/${effective.model} (${effective.source}, effort: ${effortStr})`,
      };
    }

    if (parsed.subcommand === 'list') {
      const catalog = this.modelSelectionService.getDshCatalog();
      const effective = await this.modelSelectionService.resolveEffectiveModel({
        sessionId,
        spaceId,
        userId,
      });

      const lines: string[] = [];
      for (const [pId, prov] of Object.entries(catalog.providers || {})) {
        for (const m of prov.models || []) {
          const modelKey = `${pId}/${m.id}`;
          if (pId === effective.provider && m.id === effective.model) {
            const effortStr = effective.reasoningEffort ? `effort: ${effective.reasoningEffort}` : 'effort: default';
            lines.push(`* ${modelKey} (${effective.source}, ${effortStr})`);
          } else {
            lines.push(modelKey);
          }
        }
      }

      if (lines.length === 0) {
        return { replyText: 'No models available in catalog.' };
      }
      return { replyText: lines.join('\n') };
    }

    if (parsed.subcommand === 'reset') {
      await this.modelSelectionService.deleteOverride('session', sessionId, userId);
      return { replyText: 'Session model override reset.' };
    }

    // parsed.subcommand === 'set'
    const target = parsed.target || '';
    const catalog = this.modelSelectionService.getDshCatalog();

    let targetProvider = '';
    let targetModel = '';

    if (target.includes('/')) {
      const slashIdx = target.indexOf('/');
      targetProvider = target.slice(0, slashIdx).trim();
      targetModel = target.slice(slashIdx + 1).trim();
    } else {
      const candidates: Array<{ provider: string; model: string }> = [];
      for (const [pId, prov] of Object.entries(catalog.providers || {})) {
        for (const m of prov.models || []) {
          if (m.id === target) {
            candidates.push({ provider: pId, model: m.id });
          }
        }
      }

      if (candidates.length === 0) {
        return {
          replyText: `Model "${target}" not found in catalog. Use "/model list" to see available models.\n\n${MODEL_USAGE}`,
        };
      }
      if (candidates.length > 1) {
        const candidateList = candidates.map((c) => `${c.provider}/${c.model}`).join(', ');
        return {
          replyText: `Model "${target}" is ambiguous across providers. Please specify one of: ${candidateList}`,
        };
      }

      targetProvider = candidates[0]!.provider;
      targetModel = candidates[0]!.model;
    }

    // Validate provider and model against catalog
    this.modelSelectionService.validateProviderAndModel(targetProvider, targetModel);

    // Resolve current effective effort to decide whether to keep or nullify
    const currentEffective = await this.modelSelectionService.resolveEffectiveModel({
      sessionId,
      spaceId,
      userId,
    });
    const currentEffort = currentEffective.reasoningEffort;

    const prov = catalog.providers?.[targetProvider];
    const modelDef = prov?.models?.find((m) => m.id === targetModel);

    let newEffort: string | null = null;
    let effortNotice: string | null = null;

    if (currentEffort) {
      if (
        modelDef?.reasoningEfforts &&
        Object.prototype.hasOwnProperty.call(modelDef.reasoningEfforts, currentEffort)
      ) {
        newEffort = currentEffort;
      } else {
        newEffort = null;
        effortNotice = `Reasoning effort "${currentEffort}" is not supported by ${targetProvider}/${targetModel} and was reset to null.`;
      }
    } else {
      newEffort = null;
    }

    await this.modelSelectionService.setOverride(userId, 'session', sessionId, {
      provider: targetProvider,
      model: targetModel,
      reasoningEffort: newEffort,
      fallbackChain: null,
    });

    let reply = `Session model set to ${targetProvider}/${targetModel}.`;
    if (newEffort) {
      reply += ` (effort: ${newEffort})`;
    }
    if (effortNotice) {
      reply += ` ${effortNotice}`;
    }
    return { replyText: reply };
  }

  private async executeEffortCommand(
    params: { userId: string; sessionId: string; spaceId: string },
    parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    const { userId, sessionId, spaceId } = params;

    if (parsed.subcommand === 'unknown') {
      return { replyText: EFFORT_USAGE };
    }

    const effective = await this.modelSelectionService.resolveEffectiveModel({
      sessionId,
      spaceId,
      userId,
    });

    if (parsed.subcommand === 'list') {
      const catalog = this.modelSelectionService.getDshCatalog();
      const prov = catalog.providers?.[effective.provider];
      const modelDef = prov?.models?.find((m) => m.id === effective.model);

      const supported = modelDef?.reasoningEfforts ? Object.keys(modelDef.reasoningEfforts) : [];
      const currentEffortStr = effective.reasoningEffort ?? 'default';

      if (supported.length === 0) {
        return {
          replyText: `Model ${effective.provider}/${effective.model} has no effort options. (Current effort: ${currentEffortStr})`,
        };
      }

      return {
        replyText: `Supported efforts for ${effective.provider}/${effective.model}: ${supported.join(', ')}\nCurrent effort: ${currentEffortStr}`,
      };
    }

    if (parsed.subcommand === 'reset') {
      const existing = await this.modelSelectionService.getOverride('session', sessionId);
      if (existing && existing.provider && existing.model) {
        await this.modelSelectionService.setOverride(userId, 'session', sessionId, {
          provider: existing.provider,
          model: existing.model,
          reasoningEffort: null,
          fallbackChain: null,
        });
        return {
          replyText: `Reasoning effort reset for session (${existing.provider}/${existing.model}).`,
        };
      }

      return {
        replyText: 'No session override active; reasoning effort is already at default.',
      };
    }

    // parsed.subcommand === 'set'
    const effortName = parsed.effort || '';
    this.modelSelectionService.validateProviderAndModel(
      effective.provider,
      effective.model,
      effortName
    );

    await this.modelSelectionService.setOverride(userId, 'session', sessionId, {
      provider: effective.provider,
      model: effective.model,
      reasoningEffort: effortName,
      fallbackChain: null,
    });

    return {
      replyText: `Reasoning effort set to "${effortName}" for session (${effective.provider}/${effective.model}).`,
    };
  }

  private async executeSpawnCommand(
    params: { userId: string; sessionId: string; spaceId: string },
    parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    const message = parsed.arg?.trim();
    if (!message) {
      return { replyText: SPAWN_USAGE };
    }

    const truncatedName = message.length > 30 ? message.slice(0, 30) + '…' : message;
    const title = `⚡ ${truncatedName}`;

    let task: { id: string } | undefined;

    if (this.taskOperations) {
      const ops = this.taskOperations(params.userId);
      const result = await ops.createTask({
        title,
        payload: {
          type: 'agent_prompt',
          prompt: message,
          sessionId: params.sessionId,
          spaceId: params.spaceId,
          sessionPolicy: 'isolated',
          contextMode: 'isolated',
        },
        scheduleType: 'once',
      });
      task = result.task;
    } else if (this.platformApi?.createTask) {
      const result = await this.platformApi.createTask(params.userId, {
        title,
        payload: {
          type: 'agent_prompt',
          prompt: message,
          sessionId: params.sessionId,
          spaceId: params.spaceId,
          sessionPolicy: 'isolated',
          contextMode: 'isolated',
        },
        scheduleType: 'once',
      });
      task = result.task;
    } else {
      return { replyText: 'Background task scheduling is not available in current configuration.' };
    }

    const shortId = task.id.startsWith('task_') ? task.id.slice(5, 9) : task.id.slice(0, 4);
    return { replyText: `⚡ 并行任务已启动 [${shortId}]: ${truncatedName}` };
  }
}
