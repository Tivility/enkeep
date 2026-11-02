/**
 * @enkeep/channel-jarvis — Jarvis as an enkeep channel: the runtime side of the Jarvis runtime
 * protocol over one WebSocket a jarvisd node dials in to. See docs/jarvis-channel.md §8.
 *
 * Wiring (platform-server): `createJarvisEndpoint({authenticate, onConnection})`, call its
 * `handleUpgrade` from the http server's `upgrade` event for {@link JARVIS_RUNTIME_PATH} after Host
 * validation; in `onConnection` build the user's {@link JarvisChannelSource} and
 * `new JarvisRuntime(socket, source, options).start()`.
 *
 * @module @enkeep/channel-jarvis
 */

export type {
  DshSessionEvent,
  JarvisChannelSource,
  JarvisSessionRow,
  JarvisSourceListener,
  PendingApprovalCard,
  PendingQuestionCard,
  QuestionAnswers,
  QuestionOption,
  ReadEventsQuery,
  ReadEventsResult,
} from './source.js';

export {
  Peer,
  RpcError,
  errorCode,
  type CallOptions,
  type EventHandler,
  type JarvisLogger,
  type MessageSocket,
  type PeerOptions,
  type RequestHandler,
} from './rpc.js';

export {
  JARVIS_CLOSE_REPLACED,
  JARVIS_MAX_PAYLOAD,
  JARVIS_RUNTIME_PATH,
  JARVIS_SUBPROTOCOL,
  bearerToken,
  createJarvisEndpoint,
  offeredSubprotocols,
  wrapWebSocket,
  type JarvisConnection,
  type JarvisEndpoint,
  type JarvisEndpointOptions,
  type JarvisPrincipal,
} from './endpoint.js';

export {
  ATTACHMENT_LINE_LABEL,
  COMPACTED_NOTICE,
  ENKEEP_ATTACHMENTS_HEADER,
  ENKEEP_QUOTE_PREFIX,
  ERROR_NOTICE_PREFIX,
  IMAGE_REF_ATTACHMENT,
  IMAGE_REF_PATH,
  INTERRUPTED_NOTICE,
  ITEM_ROLES,
  MAX_TOKENS_NOTICE,
  TEXT_LIMIT_BYTES,
  TOOL_NAME_MAP,
  TOOL_OUTPUT_LIMIT_BYTES,
  classifyUserMessage,
  fullItem,
  imageSource,
  isPersonMessage,
  isTurnStart,
  itemSeqOf,
  lightToolInput,
  mapEvent,
  mapEvents,
  mapToolName,
  parseAttachmentLine,
  splitAttachmentListing,
  toWireItem,
  truncateText,
  type JarvisImage,
  type JarvisItem,
  type JarvisItemKind,
  type JarvisWireItem,
  type JarvisItemRole,
  type ListedAttachment,
  type MapOptions,
  type UserMessageClass,
} from './mapper.js';

export {
  DEFAULT_PAGING_LIMITS,
  parseItemsQuery,
  readItems,
  type ItemsPage,
  type ItemsQuery,
  type PagingLimits,
  type RangePage,
} from './paging.js';

export {
  DEFAULT_RUNTIME_TIMING,
  JARVIS_RUNTIME_INSTANCE,
  JarvisRuntime,
  planAnswersOf,
  questionAnswersOf,
  type JarvisRuntimeOptions,
  type JarvisRuntimeTiming,
  type NodeHello,
} from './runtime.js';
