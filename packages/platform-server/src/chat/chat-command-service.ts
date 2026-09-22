import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ValidationError, PlatformError } from '@enkeep/platform-core';
import type { ModelSelectionService } from '../models/model-selection-service.js';

export type ChatCommandType = 'model' | 'effort' | 'help' | 'status' | 'new' | 'stop' | 'compact' | 'sw' | 'spawn';

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
  /sw - Start parallel background task in current space (alias: /spawn)`;

const SPAWN_USAGE = `用法: /sw <任务描述>
在当前工作区创建并行任务`;

const MODEL_USAGE = `Usage:
  /model - Show current effective model
  /model list - List available models
  /model <provider/model> or <modelId> - Set session model override
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
  const match = trimmed.match(/^\/(model|effort|help|status|new|reset|clear|stop|compact|sw|spawn)(?:[\s\t\r\n]+([\s\S]*))?$/i);
  if (!match) {
    return null;
  }

  const cmd = match[1].toLowerCase() as 'model' | 'effort' | 'help' | 'status' | 'new' | 'reset' | 'clear' | 'stop' | 'compact' | 'sw' | 'spawn';
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
    if (this.gateway?.getCurrentTurnStatus) {
      const turnRes = await this.gateway.getCurrentTurnStatus(userId, sessionId);
      if (turnRes?.status) {
        turnStatus = turnRes.status;
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

    const lines = [
      `space: ${spaceName} (${spaceMode})`,
      `session: ${shortId} (${sessionTitle})`,
      `generation: ${currentGen}`,
      `model: ${modelStr}`,
      `turn: ${turnStatus}`,
      `last activity: ${lastActivity}`,
    ];
    return { replyText: lines.join('\n') };
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
        priority: 'normal',
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
        priority: 'normal',
      });
      task = result.task;
    } else {
      return { replyText: 'Background task scheduling is not available in current configuration.' };
    }

    const shortId = task.id.startsWith('task_') ? task.id.slice(5, 9) : task.id.slice(0, 4);
    return { replyText: `⚡ 并行任务已启动 [${shortId}]: ${truncatedName}` };
  }
}
