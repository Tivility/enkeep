import { randomBytes } from 'node:crypto';

export interface InboundRouteResolverParams<TRoute = any, TBinding = any> {
  userId: string;
  binding: TBinding & {
    id: string;
    spaceId: string;
    sessionRouteId?: string | null;
  };
  topicBinding?: (TBinding & {
    id: string;
    spaceId: string;
    sessionRouteId?: string | null;
  }) | null;
  sessionRouteRepo: {
    findById(id: string): Promise<TRoute | null>;
    getOrCreateCanonicalSession?(spaceId: string, options: any): Promise<TRoute>;
    findByRouteIdentity?(channel: string, accountId: string, nativeContextId: string): Promise<TRoute | null>;
    create?(input: any): Promise<TRoute>;
  };
  channelRepo?: {
    updateBinding?(id: string, input: { sessionRouteId?: string | null }): Promise<any>;
    deleteBinding?(id: string): Promise<any>;
  };
  canonicalOptions: {
    channel: string;
    accountId: string;
    nativeContextId: string;
    fallbackNativeContextId?: string;
    peerId?: string;
    title?: string;
  };
  fallbackNoticeMessage?: string;
  spaceMismatchNoticeMessage?: string;
}

export interface InboundRouteResolverResult<TRoute = any> {
  route: TRoute;
  fallbackNotice?: string;
  pinned: boolean;
}

export const DEFAULT_INVALID_PIN_FALLBACK_NOTICE = '提示：此前固定的会话已失效，已自动切回主会话。';
export const DEFAULT_TOPIC_SPACE_MISMATCH_NOTICE = '提示：该话题此前固定的工作区已失效，已自动切回主会话。';

/**
 * Strips the thread part from a Lark nativeContextId ('chatId:threadId') to get the chat-level ID ('chatId').
 * Topic semantics apply ONLY to channel 'lark'.
 * For every other channel (wechat, qq, ...): chat-level id = nativeContextId unchanged.
 */
export function getChatLevelNativeContextId(nativeContextId: string, channel: string = 'lark'): string {
  if (channel !== 'lark') {
    return nativeContextId;
  }
  const colonIdx = nativeContextId.indexOf(':');
  return colonIdx >= 0 ? nativeContextId.slice(0, colonIdx) : nativeContextId;
}

/**
 * Checks whether a nativeContextId represents a topic.
 * Topic semantics apply ONLY to channel 'lark'.
 * For every other channel (wechat, qq, ...): returns false.
 */
export function isTopicNativeContextId(nativeContextId: string, channel: string = 'lark'): boolean {
  if (channel !== 'lark') {
    return false;
  }
  return nativeContextId.includes(':');
}

/**
 * Shared inbound session route resolver for IM channels (Lark, WeChat).
 * Enforces two-layer session pinning contract (Section 4A):
 * - Resolver order: topic -> chat -> main session
 * - Workspace always from chat level (binding.spaceId)
 * - Invalidate topic bindings whose space differs: delete + one-time notice
 * - If topic pin is invalid/archived: clear pin, set fallback notice, fall back to chat pin or main session
 * - If chat pin is invalid/archived: clear pin, set fallback notice, fall back to main session
 * - Otherwise canonical main session
 */
export async function resolveInboundRoute<TRoute = any, TBinding = any>(
  params: InboundRouteResolverParams<TRoute, TBinding>
): Promise<InboundRouteResolverResult<TRoute>> {
  const {
    userId,
    binding,
    topicBinding,
    sessionRouteRepo,
    channelRepo,
    canonicalOptions,
    fallbackNoticeMessage = DEFAULT_INVALID_PIN_FALLBACK_NOTICE,
    spaceMismatchNoticeMessage = DEFAULT_TOPIC_SPACE_MISMATCH_NOTICE,
  } = params;

  let fallbackNotice: string | undefined;

  // 1. Topic-level binding check (if in a topic)
  if (topicBinding) {
    if (topicBinding.spaceId !== binding.spaceId) {
      // Space mismatch: invalidate topic binding (delete it) and give one-time notice
      if (channelRepo && typeof channelRepo.deleteBinding === 'function') {
        try {
          await channelRepo.deleteBinding(topicBinding.id);
        } catch {}
      }
      fallbackNotice = spaceMismatchNoticeMessage;
      // Do not use topicBinding further
    } else if (topicBinding.sessionRouteId) {
      let pinnedRoute: TRoute | null = null;
      try {
        pinnedRoute = await sessionRouteRepo.findById(topicBinding.sessionRouteId);
      } catch {
        pinnedRoute = null;
      }

      const routeSpaceId = (pinnedRoute as any)?.spaceId ?? (pinnedRoute as any)?.space_id;
      const routeUserId = (pinnedRoute as any)?.userId ?? (pinnedRoute as any)?.user_id;
      const routeStatus = (pinnedRoute as any)?.status;

      const isValid = Boolean(
        pinnedRoute &&
        routeStatus === 'active' &&
        routeSpaceId === binding.spaceId &&
        (!routeUserId || routeUserId === userId)
      );

      if (isValid) {
        return {
          route: pinnedRoute as TRoute,
          pinned: true,
        };
      }

      // Topic pin is invalid (archived / deleted) -> clear topic pin
      if (channelRepo && typeof channelRepo.updateBinding === 'function') {
        try {
          await channelRepo.updateBinding(topicBinding.id, { sessionRouteId: null });
        } catch {}
      }
      topicBinding.sessionRouteId = null;
      fallbackNotice = fallbackNoticeMessage;
    }
  }

  // 2. Chat-level session pinning check
  if (binding.sessionRouteId) {
    let pinnedRoute: TRoute | null = null;
    try {
      pinnedRoute = await sessionRouteRepo.findById(binding.sessionRouteId);
    } catch {
      pinnedRoute = null;
    }

    const routeSpaceId = (pinnedRoute as any)?.spaceId ?? (pinnedRoute as any)?.space_id;
    const routeUserId = (pinnedRoute as any)?.userId ?? (pinnedRoute as any)?.user_id;
    const routeStatus = (pinnedRoute as any)?.status;

    const isValid = Boolean(
      pinnedRoute &&
      routeStatus === 'active' &&
      routeSpaceId === binding.spaceId &&
      (!routeUserId || routeUserId === userId)
    );

    if (isValid) {
      return {
        route: pinnedRoute as TRoute,
        pinned: true,
        fallbackNotice,
      };
    }

    // Chat pin is invalid -> clear chat pin
    if (channelRepo && typeof channelRepo.updateBinding === 'function') {
      try {
        await channelRepo.updateBinding(binding.id, { sessionRouteId: null });
      } catch {}
    }
    binding.sessionRouteId = null;
    if (!fallbackNotice) {
      fallbackNotice = fallbackNoticeMessage;
    }
  }

  // 3. Fall back to canonical main session in chat's workspace
  const canonicalRoute = await resolveCanonicalSession<TRoute>(
    sessionRouteRepo,
    binding.spaceId,
    canonicalOptions
  );

  return {
    route: canonicalRoute,
    pinned: false,
    fallbackNotice,
  };
}

async function resolveCanonicalSession<TRoute = any>(
  sessionRouteRepo: InboundRouteResolverParams['sessionRouteRepo'],
  spaceId: string,
  options: InboundRouteResolverParams['canonicalOptions']
): Promise<TRoute> {
  if (typeof sessionRouteRepo.getOrCreateCanonicalSession === 'function') {
    return await sessionRouteRepo.getOrCreateCanonicalSession(spaceId, options);
  }

  if (typeof sessionRouteRepo.findByRouteIdentity === 'function') {
    let existing = await sessionRouteRepo.findByRouteIdentity(
      options.channel,
      options.accountId,
      options.nativeContextId
    );
    if (!existing && options.fallbackNativeContextId && options.fallbackNativeContextId !== options.nativeContextId) {
      existing = await sessionRouteRepo.findByRouteIdentity(
        options.channel,
        options.accountId,
        options.fallbackNativeContextId
      );
    }
    if (existing) {
      return existing as TRoute;
    }
  }

  if (typeof sessionRouteRepo.create === 'function') {
    const newSessionId = `ses_${randomBytes(16).toString('hex')}`;
    const dshSessionId = `ses_${randomBytes(16).toString('hex')}`;
    return await sessionRouteRepo.create({
      id: newSessionId,
      spaceId,
      channel: options.channel,
      accountId: options.accountId,
      nativeContextId: options.nativeContextId,
      peerId: options.peerId || options.nativeContextId,
      dshSessionId,
      title: options.title,
    });
  }

  throw new Error('sessionRouteRepo cannot resolve or create session route');
}
