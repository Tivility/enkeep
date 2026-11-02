/**
 * The contract between the Jarvis channel engine (this package) and the platform that backs it
 * (platform-server's Jarvis runtime manager). The engine speaks the Jarvis runtime protocol to a
 * jarvisd node over one WebSocket; everything enkeep-specific — tenants, spaces, session routes,
 * the delivery gateway, the per-user runtime container — sits behind a {@link JarvisChannelSource}
 * scoped to ONE enkeep user (the owner of the Jarvis channel account).
 *
 * Ids: the session id the engine and Jarvis see is the platform's session route id
 * (`ses_<hex>`). The source translates to the DSH session id inside the container itself.
 * Seqs: DSH persisted session events count from 0; the engine maps them to Jarvis seqs
 * (DSH seq + 1) and items. The source never deals in Jarvis items.
 */

/** A DSH persisted session event as the runtime returns it (`SessionEvent`; seq counts from 0). */
export interface DshSessionEvent {
  seq: number;
  type: string;
  [key: string]: unknown;
}

/** One session as Jarvis lists it (`runtime.sessions` rows). */
export interface JarvisSessionRow {
  /** The platform session route id. */
  session_id: string;
  title?: string;
  /** Where the session works (the space's folder inside the runtime). */
  cwd?: string;
  status: 'working' | 'blocked' | 'done' | 'idle' | 'offline';
  /** ISO time of the last activity. */
  updated_at: string;
  /** Changes whenever the session's content does (the latest DSH seq + 1 seen, or another watermark). */
  rev?: number;
  /** The last assistant text (a preview). */
  last_text?: string;
  space_id?: string;
  space_name?: string;
  model?: string;
}

export interface ReadEventsQuery {
  /** Only events with seq > afterSeq (DSH seqs). */
  afterSeq?: number;
  /** Only events with seq < beforeSeq (DSH seqs); the newest such events come back (still in ascending order). */
  beforeSeq?: number;
  /** At most this many events. */
  limit?: number;
}

export interface ReadEventsResult {
  /** Ascending by seq. */
  events: DshSessionEvent[];
  /**
   * The identity of the event log: it changes when the log is replaced (a session reset to a new
   * generation, a new DSH session id). E.g. `dsh:<dsh session id>`.
   */
  history: string;
  /** The last seq in the log (-1 when empty). */
  lastSeq: number;
  /** More events exist beyond this page in the direction read (before: older; after: newer). */
  hasMore: boolean;
}

/** A tool approval waiting in the runtime (the DSH approval chain). */
export interface PendingApprovalCard {
  /** The platform's approval id (answered with it). */
  id: string;
  sessionId: string;
  /** The DSH tool name (`bash`, `edit`…). */
  toolName: string;
  /** The tool call id, when known. */
  callId?: string;
  /** The tool call's arguments, when known. */
  toolInput?: Record<string, unknown>;
  /** One line the user sees (the command, the file…). */
  summary?: string;
  /** Why the runtime asks. */
  reason?: string;
  /** When the runtime stops waiting (ISO); the card expires then. */
  expiresAt?: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

/** An `ask_user_question` (or a plan review) waiting in the runtime. */
export interface PendingQuestionCard {
  id: string;
  sessionId: string;
  callId?: string;
  /** A plan review: approve or send back with feedback. */
  plan?: string;
  questions: Array<{ id: string; question: string; header?: string; options?: QuestionOption[]; multiSelect?: boolean }>;
  expiresAt?: string;
}

/** What the phone answered to a question card: per question id, the chosen labels or the user's own text. */
export type QuestionAnswers = Array<{ id: string; selected: string[]; custom?: string }>;

export interface JarvisSourceListener {
  /** The session list changed (a session appeared or went away, a turn started or ended, a rename). */
  sessionsChanged(): void;
  /** A DSH session event was persisted (live). `history` as in {@link ReadEventsResult}. */
  sessionEvent(sessionId: string, event: DshSessionEvent, history: string): void;
  /** The text being generated right now (the whole text so far); `null` when that text ended. */
  delta(sessionId: string, text: string | null): void;
  approvalAsked(card: PendingApprovalCard): void;
  /** Answered elsewhere, expired or withdrawn: the card comes off the phone. */
  approvalSettled(id: string): void;
  questionAsked(card: PendingQuestionCard): void;
  questionSettled(id: string): void;
}

/** Everything the engine needs from the platform, for one user. Errors with `code` are passed to Jarvis as rpc error codes. */
export interface JarvisChannelSource {
  /** The user's sessions worth listing (the engine adds the phone's recent ones it asks about). */
  listSessions(): Promise<JarvisSessionRow[]>;
  /** One session's row, also for sessions not in the list; null when it is not this user's. */
  getSession(sessionId: string): Promise<JarvisSessionRow | null>;
  readEvents(sessionId: string, query: ReadEventsQuery): Promise<ReadEventsResult>;
  /** An image attachment's bytes (base64), by the reference the mapper put on the item. */
  readImage(sessionId: string, ref: string): Promise<{ mime: string; data: string }>;
  /** Deliver a message. Idempotent per clientMsgId (a retry must not run twice). */
  send(params: { sessionId: string; text: string; images: Array<{ mime: string; data: string; name?: string }>; clientMsgId: string }): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  /** A new session working in cwd (an existing space's folder, else the account's default space). */
  start(params: { cwd: string; prompt?: string }): Promise<JarvisSessionRow>;
  rename(sessionId: string, title: string): Promise<void>;
  /** Archive (it leaves the list). */
  close(sessionId: string): Promise<void>;
  answerApproval(id: string, decision: { allow: boolean; message?: string }): Promise<void>;
  answerQuestion(id: string, answers: QuestionAnswers): Promise<void>;
  /** Live notifications; returns an unsubscribe function. */
  subscribe(listener: JarvisSourceListener): () => void;
}
