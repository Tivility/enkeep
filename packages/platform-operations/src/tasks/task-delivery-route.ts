import type { TaskDeliveryTarget } from '../types/task.js';

/**
 * Resolves the IM route of a task from its anchor session when the task has no explicit delivery.
 * Priority:
 * 1. Channel binding of the origin session (session_routes) if bound to lark/wechat.
 * 2. Channel binding of the origin space (channel_bindings) if the space has a unique chat binding.
 * If neither exists, or if space has multiple conflicting chat bindings, returns undefined (web only).
 *
 * Shared by the task worker (success output of non-silent tasks) and the platform failure notifier.
 */
export function resolveTaskOriginDelivery(
  db: any,
  tenantId: string,
  payload: { sessionId?: string; spaceId?: string }
): TaskDeliveryTarget | undefined {
  if (!db || !payload.sessionId) {
    return undefined;
  }

  try {
    // 1. Query origin session route
    let routeRow: {
      space_id?: string;
      channel?: string;
      account_id?: string;
      native_context_id?: string;
    } | undefined;

    try {
      routeRow = db.prepare(`
        SELECT space_id, channel, account_id, native_context_id
        FROM session_routes
        WHERE id = ? AND user_id = ?
        LIMIT 1
      `).get(payload.sessionId, tenantId) as typeof routeRow;
    } catch {}

    // If task payload specified spaceId and routeRow exists with a different spaceId: fail closed
    if (payload.spaceId && routeRow?.space_id && payload.spaceId !== routeRow.space_id) {
      return undefined;
    }

    const resolvedSpaceId = payload.spaceId || routeRow?.space_id;

    // 1a. If origin session itself has a direct channel binding (lark or wechat)
    if (
      routeRow &&
      (routeRow.channel === 'lark' || routeRow.channel === 'wechat') &&
      routeRow.account_id &&
      routeRow.native_context_id
    ) {
      // If channel_accounts table is present, verify account is active
      try {
        const accountRow = db.prepare(`
          SELECT id, status, type FROM channel_accounts
          WHERE id = ? AND user_id = ?
          LIMIT 1
        `).get(routeRow.account_id, tenantId) as { id?: string; status?: string; type?: string } | undefined;
        if (accountRow && accountRow.status !== 'active') {
          return undefined;
        }
      } catch {}

      // If channel_bindings table is present, verify binding exists and matches space
      try {
        const baseContext = routeRow.native_context_id.includes(':')
          ? routeRow.native_context_id.split(':')[0]
          : routeRow.native_context_id;
        const bindingRow = db.prepare(`
          SELECT id, space_id FROM channel_bindings
          WHERE user_id = ? AND account_id = ? AND (native_context_id = ? OR native_context_id = ?)
          LIMIT 1
        `).get(tenantId, routeRow.account_id, routeRow.native_context_id, baseContext) as { id?: string; space_id?: string } | undefined;

        if (bindingRow && resolvedSpaceId && bindingRow.space_id !== resolvedSpaceId) {
          return undefined;
        }
      } catch {}

      return {
        channel: routeRow.channel,
        accountId: routeRow.account_id,
        nativeContextId: routeRow.native_context_id,
      };
    }

    // 2. Fall back to origin space channel binding (when session is web or has no channel route)
    if (!resolvedSpaceId) {
      return undefined;
    }

    let candidateBindings: Array<{
      account_id: string;
      native_context_id: string;
    }> = [];

    try {
      candidateBindings = db.prepare(`
        SELECT account_id, native_context_id
        FROM channel_bindings
        WHERE user_id = ? AND space_id = ?
      `).all(tenantId, resolvedSpaceId) as typeof candidateBindings;
    } catch {}

    if (!candidateBindings || candidateBindings.length === 0) {
      return undefined;
    }

    const validTargets: Array<{
      channel: 'lark' | 'wechat';
      accountId: string;
      nativeContextId: string;
    }> = [];

    for (const b of candidateBindings) {
      if (!b.account_id || !b.native_context_id) continue;

      let channelType: 'lark' | 'wechat' | undefined;
      try {
        const accRow = db.prepare(`
          SELECT type, status FROM channel_accounts
          WHERE id = ? AND user_id = ?
          LIMIT 1
        `).get(b.account_id, tenantId) as { type?: string; status?: string } | undefined;
        if (accRow) {
          if (accRow.status !== 'active') continue;
          if (accRow.type === 'lark' || accRow.type === 'wechat') {
            channelType = accRow.type;
          } else {
            continue;
          }
        }
      } catch {}

      if (!channelType) {
        if (b.account_id.includes('lark') || b.account_id.startsWith('acc_hpc_') || b.account_id.startsWith('acc_lark_')) {
          channelType = 'lark';
        } else if (b.account_id.includes('wechat')) {
          channelType = 'wechat';
        }
      }

      if (channelType) {
        validTargets.push({
          channel: channelType,
          accountId: b.account_id,
          nativeContextId: b.native_context_id,
        });
      }
    }

    if (validTargets.length === 0) {
      return undefined;
    }

    // Check if candidate bindings point to multiple different chats: never guess a different chat!
    const uniqueChatKeys = new Set(
      validTargets.map((t) => {
        const base = t.nativeContextId.includes(':') ? t.nativeContextId.split(':')[0] : t.nativeContextId;
        return `${t.channel}:${t.accountId}:${base}`;
      })
    );

    if (uniqueChatKeys.size > 1) {
      console.warn(`[agent-prompt-task] Multiple candidate channel bindings found for space "${resolvedSpaceId}"; falling back to web only without guessing:`, {
        tenantId,
        spaceId: resolvedSpaceId,
        candidateCount: uniqueChatKeys.size,
      });
      return undefined;
    }

    return validTargets[0];
  } catch (err) {
    console.warn('[agent-prompt-task] Error during fallback delivery resolution:', err);
    return undefined;
  }
}
