import { randomBytes } from 'node:crypto';

export interface InboundRouteResolverParams<TRoute = any, TBinding = any> {
  userId: string;
  binding: TBinding & {
    id: string;
    spaceId: string;
    sessionRouteId?: string | null;
  };
  sessionRouteRepo: {
    findById(id: string): Promise<TRoute | null>;
    getOrCreateCanonicalSession?(spaceId: string, options: any): Promise<TRoute>;
    findByRouteIdentity?(channel: string, accountId: string, nativeContextId: string): Promise<TRoute | null>;
    create?(input: any): Promise<TRoute>;
  };
  channelRepo?: {
    updateBinding?(id: string, input: { sessionRouteId?: string | null }): Promise<any>;
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
}

export interface InboundRouteResolverResult<TRoute = any> {
  route: TRoute;
  fallbackNotice?: string;
  pinned: boolean;
}

export const DEFAULT_INVALID_PIN_FALLBACK_NOTICE = '提示：此前固定的会话已失效，已自动切回主会话。';

/**
 * Shared inbound session route resolver for IM channels (Lark, WeChat).
 * Enforces session pinning contract:
 * - If channel_bindings.session_route_id points to an active session in the same workspace & user, enters it.
 * - Otherwise enters canonical main session.
 * - If the pinned session was invalid/archived/deleted, clears session_route_id and generates a fallback notice.
 */
export async function resolveInboundRoute<TRoute = any, TBinding = any>(
  params: InboundRouteResolverParams<TRoute, TBinding>
): Promise<InboundRouteResolverResult<TRoute>> {
  const {
    userId,
    binding,
    sessionRouteRepo,
    channelRepo,
    canonicalOptions,
    fallbackNoticeMessage = DEFAULT_INVALID_PIN_FALLBACK_NOTICE,
  } = params;

  // 1. Session pinning check
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
      };
    }

    // Pinned route is invalid / archived / deleted / wrong space
    // Clear session_route_id from channel_bindings
    if (channelRepo && typeof channelRepo.updateBinding === 'function') {
      try {
        await channelRepo.updateBinding(binding.id, { sessionRouteId: null });
      } catch {}
    }
    binding.sessionRouteId = null;

    // Fall back to canonical session with notice
    const canonicalRoute = await resolveCanonicalSession<TRoute>(
      sessionRouteRepo,
      binding.spaceId,
      canonicalOptions
    );

    return {
      route: canonicalRoute,
      fallbackNotice: fallbackNoticeMessage,
      pinned: false,
    };
  }

  // 2. Default to canonical main session
  const canonicalRoute = await resolveCanonicalSession<TRoute>(
    sessionRouteRepo,
    binding.spaceId,
    canonicalOptions
  );

  return {
    route: canonicalRoute,
    pinned: false,
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
