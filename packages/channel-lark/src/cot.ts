/**
 * Native CoT (thinking process) message — Feishu `im.v1 message_cot` bridge.
 *
 * Feishu renders `message_cot` messages as the native thinking bubble
 * (collapsible, fixed-height, scrolling AI thinking UI), driven by AG-UI protocol events.
 *
 * Lifecycle per turn:
 *   1. First thinking update with actual thinking content ->
 *      POST /open-apis/im/v1/message_cot (chat-addressed with thread-aware placement) ->
 *      { cot_id, message_id } -> push RUN_STARTED + REASONING_START prologue.
 *   2. Subsequent updates -> PUT /open-apis/im/v1/message_cot (AG-UI events).
 *      Thinking entries pushed as reasoning nodes (START/CONTENT/END).
 *      Tool calls pushed as TOOL_CALL_START/ARGS/END and TOOL_CALL_RESULT.
 *   3. Turn end (completed / failed / stopped) ->
 *      Terminal PUT: REASONING_END / RUN_FINISHED (done or interrupted).
 *      Fallback error-path: POST /open-apis/im/v1/message_cot/complete/:cot_id.
 *
 * Strictly cosmetic & best-effort: network failures are logged and disable CoT
 * for the turn without interrupting turn execution or final card delivery.
 *
 * @module @enkeep/channel-lark/cot
 */

export const COT_REQUEST_TIMEOUT_MS = 15_000;

export interface LarkCotApiClient {
  request(options: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    url: string;
    params?: Record<string, any>;
    data?: Record<string, any>;
    timeout?: number;
  }): Promise<any>;
}

export type CotEntry =
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; id: string; name: string; args?: string }
  | { kind: 'tool_result'; id: string; result: string };

export interface CotEvent {
  event_type: string;
  content: string;
  timestamp: number;
}

export interface CotPlacementParams {
  chatId: string;
  rootId?: string;
  threadId?: string;
  replyToMessageId?: string;
  turnId?: string;
}

export interface CotPlacement {
  origin_message_id?: string;
  reply_in_thread?: boolean;
}

/**
 * Determine message_cot placement in Lark conversation.
 * Mirrors session reply targeting:
 * - Thread/topic targets set origin_message_id to anchor + reply_in_thread: true
 * - Quote/message targets set origin_message_id without reply_in_thread
 */
export function cotPlacement(params: CotPlacementParams): CotPlacement {
  const anchor = params.rootId || params.threadId;
  if (anchor && anchor.startsWith('om_')) {
    return { origin_message_id: anchor, reply_in_thread: true };
  }
  if (params.replyToMessageId && params.replyToMessageId.startsWith('om_')) {
    return { origin_message_id: params.replyToMessageId };
  }
  if (params.turnId && params.turnId.startsWith('om_')) {
    return { origin_message_id: params.turnId };
  }
  return {};
}

/**
 * Categorize tool by name into built-in Feishu icon and readable title.
 */
export function toolMeta(name: string): { icon: string; title: string } {
  const n = name.toLowerCase();
  if (n.includes('bash') || n.includes('shell') || n.includes('command')) {
    return { icon: 'bash', title: '执行命令' };
  }
  if (n.includes('write') || n.includes('edit') || n.includes('patch')) {
    return { icon: 'write', title: '编辑文件' };
  }
  if (n.includes('read') || n.includes('notebook')) {
    return { icon: 'read', title: '读取文件' };
  }
  if (n.includes('grep') || n.includes('glob') || n.includes('search') || n.includes('fetch')) {
    return { icon: 'search', title: '搜索' };
  }
  if (n.includes('task') || n.includes('todo') || n.includes('plan')) {
    return { icon: 'task', title: '任务规划' };
  }
  return { icon: 'default', title: name };
}

export interface CotState {
  turnId: string;
  chatId: string;
  sessionId?: string;
  rootId?: string;
  threadId?: string;
  replyToMessageId?: string;
  cotId?: string;
  messageId?: string;
  sentCount: number;
  pendingEntries?: CotEntry[];
  lastReasoningId?: string;
  pumping: boolean;
  disabled: boolean;
  settled: boolean;
  finishStatus?: 'done' | 'interrupted';
}

function ev(eventType: string, content: unknown): CotEvent {
  return {
    event_type: eventType,
    content: JSON.stringify(content),
    timestamp: Date.now(),
  };
}

export function entryEvents(state: CotState, entry: CotEntry, index: number): CotEvent[] {
  if (entry.kind === 'thinking') {
    const mid = `reasoning-${state.turnId}-${index + 1}`;
    state.lastReasoningId = mid;
    return [
      ev('REASONING_MESSAGE_START', { messageId: mid, role: 'reasoning' }),
      ev('REASONING_MESSAGE_CONTENT', { messageId: mid, delta: entry.text }),
      ev('REASONING_MESSAGE_END', { messageId: mid }),
    ];
  }
  if (entry.kind === 'tool_call') {
    const meta = toolMeta(entry.name);
    return [
      ev('TOOL_CALL_START', {
        toolCallId: entry.id,
        icon: meta.icon,
        title: meta.title,
        toolCallName: entry.name,
        ...(state.lastReasoningId ? { parentMessageId: state.lastReasoningId } : {}),
      }),
      ...(entry.args && entry.args.length > 0
        ? [ev('TOOL_CALL_ARGS', { toolCallId: entry.id, delta: entry.args })]
        : []),
      ev('TOOL_CALL_END', { toolCallId: entry.id }),
    ];
  }
  if (entry.kind === 'tool_result') {
    if (!entry.result || entry.result.length === 0) return [];
    return [
      ev('TOOL_CALL_RESULT', {
        messageId: `tr-${entry.id}`,
        toolCallId: entry.id,
        role: 'tool',
        content: JSON.stringify({ type: 'code', code: entry.result }),
      }),
    ];
  }
  return [];
}

export interface LarkCotManagerOptions {
  enabled?: boolean;
  apiClient?: LarkCotApiClient;
  noCotChats?: string[] | Set<string>;
  logger?: {
    info(msg: string, ...args: any[]): void;
    warn(msg: string, ...args: any[]): void;
    error(msg: string, ...args: any[]): void;
    debug?(msg: string, ...args: any[]): void;
  };
}

export class LarkCotManager {
  private enabled: boolean;
  private apiClient?: LarkCotApiClient;
  private readonly noCotChats: Set<string>;
  private readonly logger: Required<Pick<NonNullable<LarkCotManagerOptions['logger']>, 'info' | 'warn' | 'error'>>;
  private readonly states = new Map<string, CotState>();

  constructor(options: LarkCotManagerOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.apiClient = options.apiClient;
    this.noCotChats = new Set(options.noCotChats ?? []);
    this.logger = {
      info: options.logger?.info?.bind(options.logger) ?? ((msg, ...args) => console.info(`[lark-cot] ${msg}`, ...args)),
      warn: options.logger?.warn?.bind(options.logger) ?? ((msg, ...args) => console.warn(`[lark-cot] ${msg}`, ...args)),
      error: options.logger?.error?.bind(options.logger) ?? ((msg, ...args) => console.error(`[lark-cot] ${msg}`, ...args)),
    };
  }

  setApiClient(apiClient?: LarkCotApiClient): void {
    this.apiClient = apiClient;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isMasterEnabled(): boolean {
    return this.enabled;
  }

  setChatCotMode(chatId: string, enabled: boolean): void {
    if (!chatId) return;
    if (enabled) {
      this.noCotChats.delete(chatId);
    } else {
      this.noCotChats.add(chatId);
    }
  }

  isCotEnabledForChat(chatId?: string): boolean {
    if (!this.enabled) return false;
    if (chatId && this.noCotChats.has(chatId)) return false;
    return true;
  }

  hasActiveCot(turnId: string): boolean {
    const s = this.states.get(turnId);
    return Boolean(s && s.cotId && !s.settled && !s.disabled);
  }

  getCotState(turnId: string): CotState | undefined {
    return this.states.get(turnId);
  }

  private async apiCreate(state: CotState): Promise<void> {
    if (!this.apiClient) {
      throw new Error('LarkCotApiClient not configured');
    }
    const placement = cotPlacement({
      chatId: state.chatId,
      rootId: state.rootId,
      threadId: state.threadId,
      replyToMessageId: state.replyToMessageId,
      turnId: state.turnId,
    });
    const res = await this.apiClient.request({
      method: 'POST',
      url: '/open-apis/im/v1/message_cot',
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: state.chatId,
        ...placement,
      },
      timeout: COT_REQUEST_TIMEOUT_MS,
    });
    const cotId = res?.data?.cot_id;
    const messageId = res?.data?.message_id;
    if (!cotId || !messageId || typeof cotId !== 'string' || typeof messageId !== 'string') {
      throw new Error(`CreateCOT missing ids: ${JSON.stringify(res?.data ?? res).slice(0, 200)}`);
    }
    state.cotId = cotId;
    state.messageId = messageId;
  }

  private async apiAppend(state: CotState, events: CotEvent[]): Promise<void> {
    if (!this.apiClient || events.length === 0) return;
    for (let i = 0; i < events.length; i += 50) {
      const slice = events.slice(i, i + 50);
      await this.apiClient.request({
        method: 'PUT',
        url: '/open-apis/im/v1/message_cot',
        data: {
          cot_id: state.cotId,
          message_id: state.messageId,
          events: slice,
        },
        timeout: COT_REQUEST_TIMEOUT_MS,
      });
    }
  }

  private async apiComplete(state: CotState, reason: 'done' | 'error' | 'interrupted'): Promise<void> {
    if (!this.apiClient || !state.cotId || !state.messageId) return;
    const apiReason = reason === 'done' ? 'done' : 'error';
    await this.apiClient.request({
      method: 'POST',
      url: `/open-apis/im/v1/message_cot/complete/${encodeURIComponent(state.cotId)}`,
      params: { message_id: state.messageId, reason: apiReason },
      timeout: COT_REQUEST_TIMEOUT_MS,
    });
  }

  private async pump(state: CotState): Promise<void> {
    if (state.pumping) return;
    state.pumping = true;
    try {
      while (!state.disabled) {
        if (!state.cotId) {
          await this.apiCreate(state);
          await this.apiAppend(state, [
            ev('RUN_STARTED', { threadId: state.sessionId ?? state.turnId, runId: state.turnId }),
            ev('REASONING_START', { messageId: `reasoning-${state.turnId}-0` }),
          ]);
          this.logger.info(`created cot=${state.cotId} msg=${state.messageId} turn=${state.turnId.slice(0, 12)}`);
        }

        const pending = state.pendingEntries;
        state.pendingEntries = undefined;
        if (pending && pending.length > state.sentCount) {
          const batch: CotEvent[] = [];
          for (let i = state.sentCount; i < pending.length; i++) {
            batch.push(...entryEvents(state, pending[i], i));
          }
          if (batch.length > 0) {
            await this.apiAppend(state, batch);
          }
          state.sentCount = pending.length;
          continue;
        }

        if (state.finishStatus && !state.settled) {
          await this.apiAppend(state, [
            ev('REASONING_END', { messageId: state.lastReasoningId ?? `reasoning-${state.turnId}-0` }),
            ev('RUN_FINISHED', {
              threadId: state.sessionId ?? state.turnId,
              runId: state.turnId,
              status: state.finishStatus,
            }),
          ]);
          state.settled = true;
          this.logger.info(`finished cot=${state.cotId} status=${state.finishStatus}`);
        }
        break;
      }
    } catch (err) {
      state.disabled = true;
      this.logger.warn(`disabled for turn ${state.turnId.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
      if (state.cotId && state.finishStatus && !state.settled) {
        state.settled = true;
        this.apiComplete(state, 'error').catch(() => {});
      }
    } finally {
      state.pumping = false;
      if (!state.disabled && (state.pendingEntries !== undefined || (state.finishStatus && !state.settled))) {
        void this.pump(state);
      }
    }
  }

  /**
   * Handle thinking content update for a turn.
   * Only creates CoT bubble if thinking entries actually exist and CoT is enabled for the chat.
   * Returns true if CoT handled/accepted the update, false otherwise.
   */
  async handleThinkingUpdate(params: {
    turnId: string;
    chatId: string;
    sessionId?: string;
    rootId?: string;
    threadId?: string;
    replyToMessageId?: string;
    entries: CotEntry[];
  }): Promise<boolean> {
    if (!this.isCotEnabledForChat(params.chatId)) {
      return false;
    }
    if (!params.entries || params.entries.length === 0) {
      return false;
    }

    // Filter to ensure there is substantive thinking or tool content
    const hasSubstance = params.entries.some((e) => {
      if (e.kind === 'thinking') return Boolean(e.text && e.text.trim().length > 0);
      if (e.kind === 'tool_call') return Boolean(e.name);
      if (e.kind === 'tool_result') return Boolean(e.result);
      return false;
    });
    if (!hasSubstance) {
      return false;
    }

    let state = this.states.get(params.turnId);
    if (state?.disabled) return false;
    if (state?.settled) return true;

    if (!state) {
      state = {
        turnId: params.turnId,
        chatId: params.chatId,
        sessionId: params.sessionId,
        rootId: params.rootId,
        threadId: params.threadId,
        replyToMessageId: params.replyToMessageId,
        sentCount: 0,
        pumping: false,
        disabled: false,
        settled: false,
      };
      this.states.set(params.turnId, state);
    }

    state.pendingEntries = params.entries;
    await this.pump(state);
    return !state.disabled;
  }

  /**
   * Finalize a turn's CoT bubble.
   * If no bubble was created (e.g. model stream didn't expose thinking content), this is a safe no-op.
   */
  async finalizeTurn(
    turnId: string,
    status: 'completed' | 'failed' | 'stopped' | 'cancelled'
  ): Promise<boolean> {
    const state = this.states.get(turnId);
    if (!state || !state.cotId) return false;

    if (state.disabled) {
      if (state.cotId && !state.settled) {
        state.settled = true;
        this.apiComplete(state, 'error').catch(() => {});
      }
      return false;
    }

    if (!state.finishStatus) {
      state.finishStatus = status === 'completed' ? 'done' : 'interrupted';
      await this.pump(state);
    }
    return true;
  }

  /**
   * Abort a turn's CoT bubble immediately (e.g. cancellation or stop reply).
   */
  async abortTurn(turnId: string): Promise<boolean> {
    const state = this.states.get(turnId);
    if (!state || !state.cotId || state.settled) return false;

    if (state.disabled) {
      state.settled = true;
      this.apiComplete(state, 'error').catch(() => {});
      return true;
    }

    if (!state.finishStatus) {
      state.finishStatus = 'interrupted';
      await this.pump(state);
    }
    return true;
  }

  dispose(): void {
    for (const state of this.states.values()) {
      if (state.cotId && !state.settled) {
        state.settled = true;
        this.apiComplete(state, 'interrupted').catch(() => {});
      }
    }
    this.states.clear();
  }
}
