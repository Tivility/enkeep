import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ValidationError, PlatformError } from '@enkeep/platform-core';
import type { ModelSelectionService } from '../models/model-selection-service.js';

export type ChatCommandType = 'model' | 'effort' | 'help' | 'status' | 'new' | 'stop' | 'compact' | 'sw' | 'spawn' | 'where' | 'bind' | 'unbind';

export interface ParsedChatCommand {
  command: ChatCommandType;
  type: ChatCommandType;
  subcommand: string;
  action: string;
  arg?: string;
  target?: string;
  effort?: string;
  raw: string;
}

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const HELP_USAGE = `Available commands:
  /help - Show this help message
  /status - Show current space, session, model, and turn status
  /new - Start a new session generation (aliases: /reset, /clear)
  /stop - Cancel running or queued turn
  /compact - Force session compaction regardless of threshold
  /model - Show, list, set, or reset session model override
  /effort - List, set, or reset reasoning effort override
  /sw - Start parallel background task in current space (alias: /spawn)
  /where - Show current workspace binding and context
  /bind - Bind channel context to workspace (alias: /bind <space>)
  /unbind - Revert channel context to default workspace`;

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

/**
 * Parses in-chat slash commands (/model, /effort, /help, /status, /new, /reset, /clear, /stop) at a word boundary.
 * Returns null if the content does not match.
 */
export function parseChatCommand(content: unknown): ParsedChatCommand | null {
  if (typeof content !== 'string') {
    return null;
  }

  const trimmed = content.trim();
  const match = trimmed.match(/^\/(model|effort|help|status|new|reset|clear|stop|compact|sw|spawn|where|bind|unbind)(?:[\s\t\r\n]+([\s\S]*))?$/i);
  if (!match) {
    return null;
  }

  const cmd = match[1].toLowerCase() as 'model' | 'effort' | 'help' | 'status' | 'new' | 'reset' | 'clear' | 'stop' | 'compact' | 'sw' | 'spawn' | 'where' | 'bind' | 'unbind';
  const rest = match[2] !== undefined ? match[2].trim() : '';

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

  if (cmd === 'new' || cmd === 'reset' || cmd === 'clear') {
    return {
      command: 'new',
      type: 'new',
      subcommand: 'new',
      action: 'new',
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

  if (cmd === 'where') {
    return {
      command: 'where',
      type: 'where',
      subcommand: 'show',
      action: 'show',
      arg: rest || undefined,
      raw: trimmed,
    };
  }

  if (cmd === 'bind') {
    return {
      command: 'bind',
      type: 'bind',
      subcommand: rest ? 'bind' : 'show',
      action: rest ? 'bind' : 'show',
      arg: rest || undefined,
      target: rest || undefined,
      raw: trimmed,
    };
  }

  if (cmd === 'unbind') {
    return {
      command: 'unbind',
      type: 'unbind',
      subcommand: 'unbind',
      action: 'unbind',
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

export interface ChatCommandServiceOptions {
  modelSelectionService: ModelSelectionService;
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
}

export class ChatCommandService {
  private readonly modelSelectionService: ModelSelectionService;
  private platformApi?: ChatCommandServiceOptions['platformApi'];
  private taskOperations?: ChatCommandServiceOptions['taskOperations'];
  private gateway?: ChatCommandServiceOptions['gateway'];
  private db?: DatabaseSync;

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
    }
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

  async execute(params: {
    userId: string;
    sessionId: string;
    spaceId: string;
    content: string;
    idempotencyKey?: string;
  }): Promise<{ replyText: string }> {
    try {
      const parsed = parseChatCommand(params.content);
      if (!parsed) {
        return { replyText: 'Unrecognized command.' };
      }

      switch (parsed.command) {
        case 'help':
          return { replyText: HELP_USAGE };
        case 'status':
          return await this.executeStatusCommand(params, parsed);
        case 'stop':
          return await this.executeStopCommand(params, parsed);
        case 'new':
          return await this.executeNewCommand(params, parsed);
        case 'compact':
          return await this.executeCompactCommand(params, parsed);
        case 'model':
          return await this.executeModelCommand(params, parsed);
        case 'effort':
          return await this.executeEffortCommand(params, parsed);
        case 'sw':
        case 'spawn':
          return await this.executeSpawnCommand(params, parsed);
        case 'where':
          return await this.executeWhereCommand(params, parsed);
        case 'bind':
          return await this.executeBindCommand(params, parsed);
        case 'unbind':
          return await this.executeUnbindCommand(params, parsed);
        default:
          return { replyText: 'Unrecognized command.' };
      }
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
    params: { userId: string; sessionId: string; spaceId: string },
    _parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    const { userId, sessionId, spaceId } = params;

    let targetSpaceId = spaceId;
    let channel = 'web';
    let accountId: string | null = null;
    let nativeContextId: string | null = null;
    let agentProfileId: string | null = null;

    if (this.db) {
      try {
        const routeRow = this.db
          .prepare('SELECT space_id, channel, account_id, native_context_id, agent_profile_id FROM session_routes WHERE id = ?')
          .get(sessionId) as {
            space_id?: string;
            channel?: string;
            account_id?: string | null;
            native_context_id?: string | null;
            agent_profile_id?: string | null;
          } | undefined;
        if (routeRow) {
          if (routeRow.space_id) targetSpaceId = routeRow.space_id;
          if (routeRow.channel) channel = routeRow.channel;
          accountId = routeRow.account_id ?? null;
          nativeContextId = routeRow.native_context_id ?? null;
          agentProfileId = routeRow.agent_profile_id ?? null;
        }
      } catch {}
    }

    let spaceName = targetSpaceId;
    let folder = targetSpaceId;
    let spaceMode = 'default';

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

    let profileName = 'default';
    if (agentProfileId && this.db) {
      try {
        const profRow = this.db
          .prepare('SELECT name FROM agent_profiles WHERE id = ?')
          .get(agentProfileId) as { name?: string | null } | undefined;
        if (profRow?.name) {
          profileName = profRow.name;
        } else {
          profileName = agentProfileId;
        }
      } catch {}
    }

    if (channel === 'web') {
      const lines = [
        `space: ${spaceName} (${targetSpaceId})`,
        `folder: ${folder}`,
        `mode: ${spaceMode}`,
        `profile: ${profileName}`,
        'channel: web (workspace binding is immutable)',
      ];
      return { replyText: lines.join('\n') };
    }

    // Non-web channel (e.g. lark)
    let activationMode = 'mention';
    if (this.db && accountId && nativeContextId) {
      try {
        const bindingRow = this.db
          .prepare('SELECT activation_mode FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?')
          .get(userId, accountId, nativeContextId) as { activation_mode?: string } | undefined;
        if (bindingRow?.activation_mode) {
          activationMode = bindingRow.activation_mode;
        }
      } catch {}
    }

    const lines = [
      `space: ${spaceName} (${targetSpaceId})`,
      `folder: ${folder}`,
      `mode: ${spaceMode}`,
      `profile: ${profileName}`,
      `channel: ${channel} (context: ${nativeContextId || 'default'}, mode: ${activationMode})`,
    ];
    return { replyText: lines.join('\n') };
  }

  private async executeBindCommand(
    params: { userId: string; sessionId: string; spaceId: string },
    parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    const { userId, sessionId } = params;

    let channel = 'web';
    let accountId: string | null = null;
    let nativeContextId: string | null = null;

    if (this.db) {
      try {
        const routeRow = this.db
          .prepare('SELECT channel, account_id, native_context_id FROM session_routes WHERE id = ?')
          .get(sessionId) as {
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

    if (channel === 'web') {
      return { replyText: 'Web 会话工作区绑定固定，请在目标工作区新建会话。' };
    }

    const rawTarget = parsed.target?.trim() || parsed.arg?.trim();
    if (!rawTarget) {
      return { replyText: '用法: /bind <workspace>' };
    }

    if (!this.db) {
      return { replyText: '数据库未连接，无法执行绑定。' };
    }

    if (!accountId || !nativeContextId) {
      return { replyText: '当前会话缺少渠道上下文，无法绑定。' };
    }

    const cleanTarget = rawTarget.replace(/^["']|["']$/g, '').trim();

    // Resolve target space: priority id -> folder -> name
    let targetSpace: { id: string; name: string; folder: string; execution_mode: string } | undefined;
    try {
      const byId = this.db
        .prepare('SELECT id, name, folder, execution_mode FROM spaces WHERE user_id = ? AND id = ?')
        .get(userId, cleanTarget) as { id: string; name: string; folder: string; execution_mode: string } | undefined;
      if (byId) {
        targetSpace = byId;
      } else {
        const byFolder = this.db
          .prepare('SELECT id, name, folder, execution_mode FROM spaces WHERE user_id = ? AND folder = ?')
          .get(userId, cleanTarget) as { id: string; name: string; folder: string; execution_mode: string } | undefined;
        if (byFolder) {
          targetSpace = byFolder;
        } else {
          const byName = this.db
            .prepare('SELECT id, name, folder, execution_mode FROM spaces WHERE user_id = ? AND name = ?')
            .all(userId, cleanTarget) as Array<{ id: string; name: string; folder: string; execution_mode: string }>;
          if (byName.length === 1) {
            targetSpace = byName[0];
          } else if (byName.length > 1) {
            return { replyText: `工作区名称 "${cleanTarget}" 存在歧义，请使用准确的工作区 ID。` };
          }
        }
      }
    } catch {}

    if (!targetSpace) {
      return { replyText: `未找到工作区 "${cleanTarget}"。` };
    }

    // Update channel_bindings and session_routes
    try {
      const existing = this.db
        .prepare('SELECT id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?')
        .get(userId, accountId, nativeContextId) as { id: string } | undefined;

      if (existing) {
        this.db
          .prepare('UPDATE channel_bindings SET space_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(targetSpace.id, existing.id);
      } else {
        const newId = `cb_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        this.db
          .prepare(`
            INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id, activation_mode, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'mention', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `)
          .run(newId, userId, accountId, targetSpace.id, nativeContextId);
      }

      this.db
        .prepare('UPDATE session_routes SET space_id = ?, execution_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
        .run(targetSpace.id, targetSpace.execution_mode || 'container', sessionId, userId);

      return { replyText: `已成功绑定到工作区: ${targetSpace.name} (${targetSpace.folder || targetSpace.id})` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { replyText: `绑定失败: ${msg}` };
    }
  }

  private async executeUnbindCommand(
    params: { userId: string; sessionId: string; spaceId: string },
    _parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    const { userId, sessionId } = params;

    let channel = 'web';
    let accountId: string | null = null;
    let nativeContextId: string | null = null;

    if (this.db) {
      try {
        const routeRow = this.db
          .prepare('SELECT channel, account_id, native_context_id FROM session_routes WHERE id = ?')
          .get(sessionId) as {
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

    if (channel === 'web') {
      return { replyText: 'Web 会话工作区绑定固定，无需解除绑定。' };
    }

    if (!this.db) {
      return { replyText: '数据库未连接，无法解除绑定。' };
    }

    if (!accountId || !nativeContextId) {
      return { replyText: '当前会话缺少渠道上下文，无法解除绑定。' };
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
        .get(accRow.default_space_id, userId) as {
          id: string;
          name: string;
          folder: string;
          execution_mode: string;
        } | undefined;

      if (!defaultSpace) {
        return { replyText: '默认工作区不存在，已保留当前绑定。' };
      }

      this.db
        .prepare('DELETE FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?')
        .run(userId, accountId, nativeContextId);

      this.db
        .prepare('UPDATE session_routes SET space_id = ?, execution_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
        .run(defaultSpace.id, defaultSpace.execution_mode || 'container', sessionId, userId);

      return { replyText: `已恢复渠道默认工作区: ${defaultSpace.name} (${defaultSpace.folder || defaultSpace.id})` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { replyText: `解除绑定失败: ${msg}` };
    }
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
    params: { userId: string; sessionId: string; idempotencyKey?: string },
    _parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    const { userId, sessionId, idempotencyKey } = params;

    let hasActiveTurn = false;
    if (this.gateway?.getCurrentTurnStatus) {
      const turnStatus = await this.gateway.getCurrentTurnStatus(userId, sessionId);
      if (turnStatus && (turnStatus.status === 'running' || turnStatus.status === 'queued')) {
        hasActiveTurn = true;
      }
    } else if (this.db) {
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

    if (!this.platformApi?.resetSession) {
      return { replyText: 'Platform API resetSession unavailable.' };
    }

    const effectiveIdempotencyKey =
      idempotencyKey && UUID_V4_REGEX.test(idempotencyKey)
        ? idempotencyKey.toLowerCase()
        : randomUUID();

    const resetResult = await this.platformApi.resetSession(userId, sessionId, {
      idempotencyKey: effectiveIdempotencyKey,
      reason: 'chat_command',
    });

    const newGen = resetResult.generation.generation;
    const oldGen = newGen - 1;
    return { replyText: `Started generation ${newGen} (was ${oldGen})` };
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
