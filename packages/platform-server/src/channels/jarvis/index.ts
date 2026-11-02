/**
 * Jarvis channel on the platform: accounts and tokens (also usable offline, by the admin CLI), the
 * `/api/jarvis/runtime` endpoint and the per-connection source behind the `@enkeep/channel-jarvis`
 * engine.
 *
 * @module @enkeep/platform-server/channels/jarvis
 */

export {
  JarvisRuntimeManager,
  JARVIS_CLOSE_REVOKED,
  JARVIS_DEFAULT_VERSION,
  type JarvisAccountStatus,
  type JarvisManagerDeliveryPort,
  type JarvisRuntimeManagerOptions,
} from './manager.js';
export {
  JarvisAccountLifecycle,
  JARVIS_CHANNEL_TYPE,
  type JarvisAccountLifecycleOptions,
} from './accounts.js';
export {
  PlatformJarvisSource,
  DEFAULT_RUNTIME_SPACES_DIR,
  JARVIS_LIST_MAX_SESSIONS,
  JARVIS_LIST_RECENT_MS,
  JARVIS_MAX_IMAGE_BYTES,
  JARVIS_REJECT_REASON_PREFIX,
  JARVIS_SLASH_REFUSAL,
  JARVIS_LATE_ANSWER_MSG_PREFIX,
  jarvisIdempotencyKey,
  toJarvisRpcError,
  toolCallsOf,
  type JarvisDeliveryPort,
  type JarvisImageIngestor,
  type JarvisSessionApi,
  type PlatformJarvisSourceOptions,
} from './source.js';
export {
  JarvisTokenStore,
  JarvisTokenOwnerConflictError,
  JARVIS_TOKEN_PREFIX,
  generateJarvisToken,
  hashJarvisToken,
  isJarvisTokenShape,
  type JarvisTokenPrincipal,
} from './token-store.js';
