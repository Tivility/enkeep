/**
 * Background Task Panel Manager and Formatter for Lark/Feishu Cards.
 * Manages background task visibility across interactive cards within a chat session.
 *
 * Rules:
 * 1. Background panel follows the LATEST card of the session in that chat.
 * 2. On card handoff: previous card collapses to '本轮启动了 N 个后台任务，进度见最新消息'
 *    if it launched tasks, else the panel is removed.
 * 3. Polls the platform API (chatContextId filter) every ~30s while any task is running.
 * 4. Per-task line: kind, name, status, progress (agents d/t or step N), elapsed.
 * 5. Stalled tasks marked with '⚠️ 可能卡住'.
 * 6. Tasks completed during an active turn marked with '✅ 已完成，结果已并入当前回复'.
 * 7. When all tasks complete, collapses to '✅ 后台任务已全部完成' and stops polling.
 *
 * @module @enkeep/channel-lark/background-panel
 */

import { createHash } from 'node:crypto';
import type { BackgroundTask, LarkStreamingCardSession } from './types.js';
import { formatDuration } from './transport.js';

function hashRouteId(sessionRouteId: string): string {
  return createHash('sha256').update(sessionRouteId).digest('hex').slice(0, 8);
}

export interface FormatBackgroundTaskLineOptions {
  completedDuringActiveTurn?: boolean;
  now?: number;
}

/**
 * Format a single background task line according to the spec:
 * kind, name, status, progress (agents d/t or step N), elapsed;
 * '⚠️ 可能卡住' when stalled;
 * '✅ 已完成，结果已并入当前回复' for tasks completed during an active turn.
 */
export function formatBackgroundTaskLine(
  task: BackgroundTask,
  options?: FormatBackgroundTaskLineOptions
): string {
  const now = options?.now ?? Date.now();
  let statusText: string = task.status;

  if (task.status === 'running') {
    if (task.stalled) {
      statusText = 'running ⚠️ 可能卡住';
    } else {
      statusText = 'running';
    }
  } else if (task.status === 'completed') {
    statusText = 'completed';
  } else if (task.status === 'failed') {
    statusText = 'failed';
  } else if (task.status === 'cancelled') {
    statusText = 'cancelled';
  }

  // Progress: (agents d/t or step N)
  let progressText = '';
  if (task.progress) {
    if (typeof task.progress.agentsTotal === 'number' && task.progress.agentsTotal > 0) {
      const done = task.progress.agentsDone ?? 0;
      progressText = `${done}/${task.progress.agentsTotal} agents`;
    } else if (typeof task.progress.step === 'number') {
      progressText = `step ${task.progress.step}`;
    }
  }

  // Elapsed time calculation
  let elapsedText = '';
  if (task.startedAt) {
    const startMs = new Date(task.startedAt).getTime();
    if (!isNaN(startMs)) {
      const endMs = task.finishedAt ? new Date(task.finishedAt).getTime() : now;
      const elapsedMs = Math.max(0, endMs - startMs);
      elapsedText = formatDuration(elapsedMs);
    }
  }

  const parts = [
    `[${task.kind}] ${task.name}`,
    statusText,
  ];
  if (progressText) {
    parts.push(progressText);
  }
  if (elapsedText) {
    parts.push(elapsedText);
  }

  return parts.join(' · ');
}

export interface FormatBackgroundPanelOptions {
  activeTurnCompletedTaskIds?: Set<string>;
  seenRunningTaskIds?: Set<string>;
  now?: number;
}

/**
 * Format the entire background tasks panel markdown.
 * When all tasks are finished, collapses to '✅ 后台任务已全部完成'.
 */
export function formatBackgroundPanel(
  tasks: BackgroundTask[],
  options?: FormatBackgroundPanelOptions
): string {
  if (!tasks || tasks.length === 0) {
    return '';
  }

  const now = options?.now ?? Date.now();
  // Judge terminal status across all current tasks
  const allTerminated = tasks.length > 0 && tasks.every(
    (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled'
  );

  if (allTerminated) {
    const hasFailedOrCancelled = tasks.some(
      (t) => t.status === 'failed' || t.status === 'cancelled'
    );
    if (!hasFailedOrCancelled) {
      return '✅ 后台任务已全部完成';
    }
    const completedCount = tasks.filter((t) => t.status === 'completed').length;
    const failedCount = tasks.filter((t) => t.status === 'failed').length;
    const cancelledCount = tasks.filter((t) => t.status === 'cancelled').length;
    return `后台任务已结束 (完成 ${completedCount}，失败 ${failedCount}，已停止 ${cancelledCount})`;
  }

  const lines = tasks.map((task) => {
    const isTurnCompleted = options?.activeTurnCompletedTaskIds?.has(task.id) || false;
    return `• ${formatBackgroundTaskLine(task, { completedDuringActiveTurn: isTurnCompleted, now })}`;
  });

  return `**🔄 后台任务**\n${lines.join('\n')}`;
}

export interface LarkBackgroundPanelManagerOptions {
  getBackgroundTasks: (
    sessionId: string,
    options?: { chatContextId?: string }
  ) => Promise<{ items: BackgroundTask[]; updatedAt: string; available?: boolean }>;
  pollIntervalMs?: number;
}

interface ChatCardRecord {
  cardSession: LarkStreamingCardSession;
  turnId?: string;
  launchedTaskIds: Set<string>;
}

interface ChatSessionState {
  latestCard: ChatCardRecord | null;
  previousCards: ChatCardRecord[];
  activeTurnCompletedTaskIds: Set<string>;
  seenRunningTaskIds: Set<string>;
  activeTurnId?: string;
  pollTimer: NodeJS.Timeout | null;
  isPolling: boolean;
  hadRunningTasks: boolean;
  lastPanelText?: string;
  turnFinalizedAt?: number;
  lastLoggedRegisterState?: string;
  lastLoggedFinalizedState?: string;
  lastLoggedPollState?: string;
  lastLoggedStopState?: string;
}

export class LarkBackgroundPanelManager {
  private readonly getBackgroundTasksFn: (
    sessionId: string,
    options?: { chatContextId?: string }
  ) => Promise<{ items: BackgroundTask[]; updatedAt: string; available?: boolean }>;
  private readonly pollIntervalMs: number;
  private readonly chatStates = new Map<string, ChatSessionState>();
  private isDisposed = false;

  constructor(options: LarkBackgroundPanelManagerOptions) {
    this.getBackgroundTasksFn = options.getBackgroundTasks;
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
  }

  private getChatKey(sessionRouteId: string, chatContextId?: string): string {
    return `${sessionRouteId}:${chatContextId || ''}`;
  }

  private getOrCreateState(sessionRouteId: string, chatContextId?: string): ChatSessionState {
    const key = this.getChatKey(sessionRouteId, chatContextId);
    let state = this.chatStates.get(key);
    if (!state) {
      state = {
        latestCard: null,
        previousCards: [],
        activeTurnCompletedTaskIds: new Set<string>(),
        seenRunningTaskIds: new Set<string>(),
        activeTurnId: undefined,
        pollTimer: null,
        isPolling: false,
        hadRunningTasks: false,
      };
      this.chatStates.set(key, state);
    }
    return state;
  }

  /**
   * Register a newly created card session for a given chat and session route.
   * Performs handoff from previous card to the new card:
   * - Previous card collapses to '本轮启动了 N 个后台任务，进度见最新消息' if it launched tasks, else panel is removed.
   * - New card becomes the latest card and receives the active background panel.
   */
  async registerCard(
    sessionRouteId: string,
    chatContextId: string | undefined,
    cardSession: LarkStreamingCardSession,
    turnId?: string
  ): Promise<void> {
    if (this.isDisposed) return;
    const state = this.getOrCreateState(sessionRouteId, chatContextId);

    // 1. Handoff from previous card
    if (state.latestCard && state.latestCard.cardSession !== cardSession) {
      const prevCard = state.latestCard;
      state.previousCards.push(prevCard);

      const launchedCount = prevCard.launchedTaskIds.size;
      if (launchedCount > 0) {
        const collapsedLine = `本轮启动了 ${launchedCount} 个后台任务，进度见最新消息`;
        try {
          if (typeof prevCard.cardSession.updateBackgroundPanel === 'function') {
            await prevCard.cardSession.updateBackgroundPanel(collapsedLine);
          }
        } catch (err) {
          console.warn('[lark-bg] failed to collapse previous card panel', err);
        }
      } else {
        try {
          if (typeof prevCard.cardSession.updateBackgroundPanel === 'function') {
            await prevCard.cardSession.updateBackgroundPanel(null);
          }
        } catch (err) {
          console.warn('[lark-bg] failed to remove previous card panel', err);
        }
      }
    }

    // 2. Set new card as latest
    state.latestCard = {
      cardSession,
      turnId,
      launchedTaskIds: new Set<string>(),
    };
    state.activeTurnId = turnId;
    state.turnFinalizedAt = undefined;
    state.activeTurnCompletedTaskIds = new Set<string>();

    const regLog = `registerCard session=${hashRouteId(sessionRouteId)} turn=${turnId ?? 'none'}`;
    if (state.lastLoggedRegisterState !== regLog) {
      state.lastLoggedRegisterState = regLog;
      console.info(`[lark-bg] ${regLog}`);
    }

    // 3. Immediately poll and render background tasks for new card
    await this.pollTick(sessionRouteId, chatContextId);
  }

  /**
   * Called when an active turn finalizes.
   */
  async onTurnFinalized(
    sessionRouteId: string,
    chatContextId: string | undefined,
    turnId?: string
  ): Promise<void> {
    if (this.isDisposed) return;
    const state = this.getOrCreateState(sessionRouteId, chatContextId);
    if (state.activeTurnId === turnId) {
      state.activeTurnId = undefined;
    }
    state.turnFinalizedAt = Date.now();

    const finLog = `onTurnFinalized session=${hashRouteId(sessionRouteId)} turn=${turnId ?? 'none'}`;
    if (state.lastLoggedFinalizedState !== finLog) {
      state.lastLoggedFinalizedState = finLog;
      console.info(`[lark-bg] ${finLog}`);
    }

    await this.pollTick(sessionRouteId, chatContextId);
  }

  /**
   * Track that a task completed while an active turn was running.
   */
  recordTaskCompletedInActiveTurn(
    sessionRouteId: string,
    chatContextId: string | undefined,
    taskId: string
  ): void {
    const state = this.getOrCreateState(sessionRouteId, chatContextId);
    state.activeTurnCompletedTaskIds.add(taskId);
  }

  /**
   * Single polling tick for a session/chat.
   */
  async pollTick(sessionRouteId: string, chatContextId?: string): Promise<void> {
    if (this.isDisposed) return;
    const state = this.getOrCreateState(sessionRouteId, chatContextId);

    try {
      const res = await this.getBackgroundTasksFn(sessionRouteId, {
        chatContextId: chatContextId || undefined,
      });

      if (!state.latestCard) {
        return;
      }

      // A-01: Runtime query failed / unavailable
      if (res?.available === false) {
        let unavailableText = '⚠️ 状态暂不可用';
        if (state.lastPanelText) {
          unavailableText = `${state.lastPanelText}\n\n⚠️ 状态暂不可用`;
        }
        if (typeof state.latestCard.cardSession.updateBackgroundPanel === 'function') {
          await state.latestCard.cardSession.updateBackgroundPanel(unavailableText);
        }
        // Retain polling during failure
        this.ensurePolling(sessionRouteId, chatContextId);
        return;
      }

      const tasks = res?.items ?? [];

      // Track tasks launched during this latest turn
      if (state.latestCard.turnId) {
        for (const task of tasks) {
          if (task.originTurnId === state.latestCard.turnId) {
            state.latestCard.launchedTaskIds.add(task.id);
          }
        }
      }

      // Maintain seenRunningTaskIds: "only records tasks that were running when last seen"
      // Each poll:
      // 1. If present in list and status is terminal -> remove from seenRunningTaskIds
      // 2. If present and running -> add to seenRunningTaskIds
      const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
      const currentTaskMap = new Map(tasks.map((t) => [t.id, t]));

      for (const t of tasks) {
        if (terminalStatuses.has(t.status)) {
          state.seenRunningTaskIds.delete(t.id);
        } else if (t.status === 'running') {
          state.seenRunningTaskIds.add(t.id);
        }
      }

      const hasRunning = tasks.some((t) => t.status === 'running');
      if (hasRunning) {
        state.hadRunningTasks = true;
      }

      // Check whether any task currently in seenRunningTaskIds is missing from current tasks
      // (a task in seenRunningTaskIds was running when last seen; if it disappears from the list, it's missing unconfirmed)
      let hasMissingSeenTask = false;
      for (const seenId of state.seenRunningTaskIds) {
        if (!currentTaskMap.has(seenId)) {
          hasMissingSeenTask = true;
          break;
        }
      }

      const turnActive = Boolean(state.activeTurnId);
      let action: 'update' | 'unconfirmed' | 'clear' | 'none' = 'none';

      // Format and update panel on latest card
      if (hasMissingSeenTask) {
        action = 'unconfirmed';
        // A seen running task disappeared without terminal state: retain previous text and append note, continue polling
        const baseText = state.lastPanelText || (tasks.length > 0 ? formatBackgroundPanel(tasks, {
          activeTurnCompletedTaskIds: state.activeTurnCompletedTaskIds,
          seenRunningTaskIds: state.seenRunningTaskIds,
        }) : '**🔄 后台任务**');
        const unconfirmedSuffix = '（部分任务状态未确认）';
        const panelText = baseText.endsWith(unconfirmedSuffix) ? baseText : `${baseText}\n${unconfirmedSuffix}`;
        state.lastPanelText = panelText;

        if (typeof state.latestCard.cardSession.updateBackgroundPanel === 'function') {
          await state.latestCard.cardSession.updateBackgroundPanel(panelText);
        }
      } else if (tasks.length > 0) {
        action = 'update';
        const panelText = formatBackgroundPanel(tasks, {
          activeTurnCompletedTaskIds: state.activeTurnCompletedTaskIds,
          seenRunningTaskIds: state.seenRunningTaskIds,
        });
        state.lastPanelText = panelText;

        if (typeof state.latestCard.cardSession.updateBackgroundPanel === 'function') {
          await state.latestCard.cardSession.updateBackgroundPanel(panelText);
        }
      } else if (state.hadRunningTasks && !turnActive) {
        action = 'clear';
        // If turn has finalized and task list is empty with no seen running tasks unconfirmed, clear panel
        state.lastPanelText = undefined;
        if (typeof state.latestCard.cardSession.updateBackgroundPanel === 'function') {
          await state.latestCard.cardSession.updateBackgroundPanel(null);
        }
        state.hadRunningTasks = false;
      }

      // 10-minute grace period after turn finalized when list is empty and never saw running tasks
      const GRACE_PERIOD_MS = 10 * 60 * 1000;
      const inGracePeriod =
        !turnActive &&
        tasks.length === 0 &&
        !state.hadRunningTasks &&
        state.turnFinalizedAt !== undefined &&
        Date.now() - state.turnFinalizedAt < GRACE_PERIOD_MS;

      const runningCount = tasks.filter((t) => t.status === 'running').length;
      const shouldPoll = hasRunning || turnActive || hasMissingSeenTask || inGracePeriod;

      const tickLog = `pollTick session=${hashRouteId(sessionRouteId)} available=${res?.available ?? true} items=${tasks.length} running=${runningCount} action=${action} continuePolling=${shouldPoll}`;
      if (state.lastLoggedPollState !== tickLog) {
        state.lastLoggedPollState = tickLog;
        console.info(`[lark-bg] ${tickLog}`);
      }

      if (shouldPoll) {
        this.ensurePolling(sessionRouteId, chatContextId);
      } else {
        this.stopPolling(sessionRouteId, chatContextId);
      }
    } catch (err) {
      console.warn('[lark-bg] pollTick error', err);
    }
  }

  ensurePolling(sessionRouteId: string, chatContextId?: string): void {
    const state = this.getOrCreateState(sessionRouteId, chatContextId);
    if (state.pollTimer || state.isPolling || this.isDisposed) {
      return;
    }

    state.isPolling = true;
    const timer = setInterval(() => {
      void this.pollTick(sessionRouteId, chatContextId);
    }, this.pollIntervalMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    state.pollTimer = timer;
  }

  stopPolling(sessionRouteId: string, chatContextId?: string): void {
    const state = this.getOrCreateState(sessionRouteId, chatContextId);
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    state.isPolling = false;

    const stopLog = `stopPolling session=${hashRouteId(sessionRouteId)}`;
    if (state.lastLoggedStopState !== stopLog) {
      state.lastLoggedStopState = stopLog;
      console.info(`[lark-bg] ${stopLog}`);
    }
  }

  hasLatestCard(sessionRouteId: string): boolean {
    for (const [key, state] of this.chatStates.entries()) {
      if (key === sessionRouteId || key.startsWith(`${sessionRouteId}:`)) {
        if (state.latestCard) return true;
      }
    }
    return false;
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    for (const state of this.chatStates.values()) {
      if (state.pollTimer) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
      }
      state.isPolling = false;
    }
    this.chatStates.clear();
  }
}
