/**
 * Pure user-question helpers (no Cordis/DSH runtime imports), shared by the in-container
 * `ask_user_question` tool and interaction service, the runtime daemon protocol, and the
 * host-side platform (which renders the cards, validates answers and words late answers).
 *
 * Wire shapes:
 * - a question as the user sees it: {@link UserQuestion} (camelCase `multiSelect`);
 * - an answer: {@link QuestionAnswer} `{ id, selected: [labels], custom? }`, where an item
 *   with empty `selected` and no `custom` (or a question with no item) means "skipped";
 * - a waiting question: {@link PendingQuestion}; its settlement: {@link QuestionSettlement}.
 *
 * @module @enkeep/dsh-external-interaction/user-questions
 */

import { parseApprovalTimeoutMs } from './approval-policy.js';

/** Name of the model-facing tool. */
export const ASK_USER_QUESTION_TOOL_NAME = 'ask_user_question';

/** Runtime env gate: the tool and the question service exist only when this is `1`. */
export const USER_QUESTIONS_ENV = 'ENKEEP_USER_QUESTIONS';

/** Runtime env: how long a question waits for an answer, in milliseconds. */
export const QUESTION_TIMEOUT_ENV = 'ENKEEP_QUESTION_TIMEOUT_MS';

/** Default wait for an answer (10 min: a phone or watch needs time). */
export const DEFAULT_QUESTION_TIMEOUT_MS = 10 * 60 * 1000;

/** Bounds accepted for {@link QUESTION_TIMEOUT_ENV}: 1 s .. 24 h. */
export const MIN_QUESTION_TIMEOUT_MS = 1_000;
export const MAX_QUESTION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** Input limits of one `ask_user_question` call. */
export const MAX_QUESTIONS_PER_CALL = 4;
export const MAX_OPTIONS_PER_QUESTION = 6;
export const MAX_QUESTION_ID_LENGTH = 64;
export const MAX_QUESTION_TEXT_LENGTH = 2_000;
export const MAX_QUESTION_HEADER_LENGTH = 100;
export const MAX_OPTION_LABEL_LENGTH = 200;
export const MAX_OPTION_DESCRIPTION_LENGTH = 1_000;
/** Longest free-text (`custom`) answer accepted, in characters. */
export const MAX_CUSTOM_ANSWER_LENGTH = 8_000;

export interface QuestionOption {
  label: string;
  description?: string;
}

/** One question as asked (normalized from the tool input). */
export interface UserQuestion {
  /** Chosen by the model; unique within the call; answers refer to it. */
  id: string;
  question: string;
  header?: string;
  /** Empty when the question expects a free-text answer only. */
  options: QuestionOption[];
  /** Whether more than one option may be selected (always false without options). */
  multiSelect: boolean;
}

/** The user's answer to one question. */
export interface QuestionAnswer {
  /** A {@link UserQuestion.id} of the same call. */
  id: string;
  /** Selected option labels, exactly as offered (at most one unless `multiSelect`). */
  selected: string[];
  /** The user's own words, alongside or instead of options. */
  custom?: string;
}

export type QuestionOutcome = 'answered' | 'expired' | 'cancelled';

export type QuestionStatus = 'pending' | QuestionOutcome;

/** A question waiting in the runtime for the user's answer. */
export interface PendingQuestion {
  /**
   * Stable id: the `ask_user_question` tool call id when it is usable (unique in the runtime,
   * ≤ 128 chars of `[A-Za-z0-9_.:-]`), otherwise `q_<uuid>`.
   */
  id: string;
  /** The DSH session id of the agent that asked. */
  sessionId: string;
  /** The tool call id (correlates with the session's `tool/call` event). */
  callId?: string;
  userId?: string;
  spaceId?: string;
  sessionSource: 'external' | 'im' | 'web' | string;
  questions: UserQuestion[];
  /**
   * The plan under review, for a plan-review question. Never set by this runtime (DSH
   * 0.2.1-rc.5 has no plan mode); reserved so cards can show it later.
   */
  plan?: string;
  /** ISO time the question was asked. */
  createdAt: string;
  /** How long the question waits for an answer. */
  timeoutMs: number;
  /** ISO time the question expires (`createdAt + timeoutMs`). */
  expiresAt: string;
  status: QuestionStatus;
  /** ISO time it settled (settled records only). */
  settledAt?: string;
  /** The answers (outcome `answered` only). */
  answers?: QuestionAnswer[];
}

/** How a question ended. */
export interface QuestionSettlement {
  id: string;
  sessionId: string;
  callId?: string;
  outcome: QuestionOutcome;
  /** Present when `outcome` is `answered`. */
  answers?: QuestionAnswer[];
  settledAt: string;
  /** Why it was cancelled (turn interrupted, runtime shutting down, …). */
  reason?: string;
}

/** What the asking side (the tool) gets back. */
export type QuestionResolution =
  | { outcome: 'answered'; questionId: string; answers: QuestionAnswer[] }
  | { outcome: 'expired'; questionId: string; timeoutMs: number }
  | { outcome: 'cancelled'; questionId: string; reason?: string };

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** `1` → true, `0` → false (surrounding whitespace ignored); anything else → undefined. */
export function parseUserQuestionsEnabled(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (value === '1') return true;
  if (value === '0') return false;
  return undefined;
}

/** Whether to compose user questions: explicit config first, then `ENKEEP_USER_QUESTIONS`, else off. */
export function resolveUserQuestionsEnabled(options: {
  configured?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
} = {}): boolean {
  if (typeof options.configured === 'boolean') return options.configured;
  return parseUserQuestionsEnabled(options.env?.[USER_QUESTIONS_ENV]) ?? false;
}

/** A question timeout (decimal ms) within 1 s .. 24 h, else undefined. */
export function parseQuestionTimeoutMs(raw: unknown): number | undefined {
  return parseApprovalTimeoutMs(raw);
}

/**
 * Effective question timeout. Precedence: explicit `configured` (positive integer, clamped to
 * the bounds), then `ENKEEP_QUESTION_TIMEOUT_MS` (must lie within the bounds), then 10 min.
 */
export function resolveQuestionTimeoutMs(options: {
  configured?: number;
  env?: Readonly<Record<string, string | undefined>>;
} = {}): number {
  const configured = options.configured;
  if (typeof configured === 'number' && Number.isSafeInteger(configured) && configured > 0) {
    return Math.min(MAX_QUESTION_TIMEOUT_MS, Math.max(MIN_QUESTION_TIMEOUT_MS, configured));
  }
  return parseQuestionTimeoutMs(options.env?.[QUESTION_TIMEOUT_ENV]) ?? DEFAULT_QUESTION_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// C0 controls other than tab/newline/carriage return, DEL, and C1 controls.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

function text(
  value: unknown,
  path: string,
  maxLength: number,
  { optional = false, singleLine = false }: { optional?: boolean; singleLine?: boolean } = {}
): ValidationResult<string | undefined> {
  if (value === undefined || value === null) {
    return optional ? { ok: true, value: undefined } : { ok: false, error: `${path} is required` };
  }
  if (typeof value !== 'string') return { ok: false, error: `${path} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) {
    return optional ? { ok: true, value: undefined } : { ok: false, error: `${path} must not be empty` };
  }
  if (trimmed.length > maxLength) return { ok: false, error: `${path} is longer than ${maxLength} characters` };
  if (CONTROL_CHARS.test(trimmed) || (singleLine && /[\r\n]/.test(trimmed))) {
    return { ok: false, error: `${path} contains control characters` };
  }
  return { ok: true, value: trimmed };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Validates and normalizes `ask_user_question` arguments:
 * `{ questions: [{ id, question, header?, options?: [{ label, description? }], multi_select? }] }`
 * with 1–4 questions and at most 6 options each (`multiSelect` is accepted as an alias).
 * The result is deeply frozen.
 */
export function normalizeAskUserQuestionInput(raw: unknown): ValidationResult<UserQuestion[]> {
  if (!isRecord(raw)) return { ok: false, error: 'arguments must be an object with a "questions" array' };
  const list = raw.questions;
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, error: '"questions" must be a non-empty array' };
  }
  if (list.length > MAX_QUESTIONS_PER_CALL) {
    return { ok: false, error: `ask at most ${MAX_QUESTIONS_PER_CALL} questions per call` };
  }
  const ids = new Set<string>();
  const questions: UserQuestion[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const at = `questions[${i}]`;
    if (!isRecord(item)) return { ok: false, error: `${at} must be an object` };
    const id = text(item.id, `${at}.id`, MAX_QUESTION_ID_LENGTH, { singleLine: true });
    if (!id.ok) return id;
    if (ids.has(id.value!)) return { ok: false, error: `${at}.id "${id.value}" is used twice` };
    ids.add(id.value!);
    const question = text(item.question, `${at}.question`, MAX_QUESTION_TEXT_LENGTH);
    if (!question.ok) return question;
    const header = text(item.header, `${at}.header`, MAX_QUESTION_HEADER_LENGTH, { optional: true, singleLine: true });
    if (!header.ok) return header;

    const rawOptions = item.options;
    const options: QuestionOption[] = [];
    if (rawOptions !== undefined && rawOptions !== null) {
      if (!Array.isArray(rawOptions)) return { ok: false, error: `${at}.options must be an array` };
      if (rawOptions.length > MAX_OPTIONS_PER_QUESTION) {
        return { ok: false, error: `${at}.options has more than ${MAX_OPTIONS_PER_QUESTION} entries` };
      }
      const labels = new Set<string>();
      for (let j = 0; j < rawOptions.length; j++) {
        const option = rawOptions[j];
        const oat = `${at}.options[${j}]`;
        if (!isRecord(option)) return { ok: false, error: `${oat} must be an object` };
        const label = text(option.label, `${oat}.label`, MAX_OPTION_LABEL_LENGTH, { singleLine: true });
        if (!label.ok) return label;
        if (labels.has(label.value!)) return { ok: false, error: `${oat}.label "${label.value}" is used twice` };
        labels.add(label.value!);
        const description = text(option.description, `${oat}.description`, MAX_OPTION_DESCRIPTION_LENGTH, { optional: true });
        if (!description.ok) return description;
        options.push({ label: label.value!, ...(description.value ? { description: description.value } : {}) });
      }
    }

    const rawMulti = item.multi_select ?? item.multiSelect;
    if (rawMulti !== undefined && rawMulti !== null && typeof rawMulti !== 'boolean') {
      return { ok: false, error: `${at}.multi_select must be a boolean` };
    }
    questions.push({
      id: id.value!,
      question: question.value!,
      ...(header.value ? { header: header.value } : {}),
      options,
      multiSelect: options.length > 0 && rawMulti === true,
    });
  }
  return { ok: true, value: deepFreeze(questions) };
}

/**
 * Validates the user's answers against the questions asked:
 * an array of `{ id, selected?: string[], custom?: string }`, at most one item per question id,
 * `selected` labels exactly as offered (at most one unless `multiSelect`; none without options),
 * `custom` up to {@link MAX_CUSTOM_ANSWER_LENGTH} characters (blank means absent).
 * Questions without an item, and items with nothing selected and no `custom`, count as skipped.
 * Returns the normalized answers in question order.
 */
export function validateQuestionAnswers(
  questions: readonly UserQuestion[],
  raw: unknown
): ValidationResult<QuestionAnswer[]> {
  if (!Array.isArray(raw)) return { ok: false, error: 'answers must be an array' };
  const byId = new Map(questions.map((q) => [q.id, q] as const));
  const answered = new Map<string, QuestionAnswer>();
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const at = `answers[${i}]`;
    if (!isRecord(item)) return { ok: false, error: `${at} must be an object` };
    if (typeof item.id !== 'string' || !byId.has(item.id)) {
      return { ok: false, error: `${at}.id does not name a question of this request` };
    }
    if (answered.has(item.id)) return { ok: false, error: `${at}.id "${item.id}" is answered twice` };
    const question = byId.get(item.id)!;

    const rawSelected = item.selected ?? [];
    if (!Array.isArray(rawSelected)) return { ok: false, error: `${at}.selected must be an array of option labels` };
    const labels = new Set(question.options.map((o) => o.label));
    const selected: string[] = [];
    for (const label of rawSelected) {
      if (typeof label !== 'string' || !labels.has(label)) {
        return { ok: false, error: `${at}.selected contains a label that question "${question.id}" does not offer` };
      }
      if (selected.includes(label)) return { ok: false, error: `${at}.selected repeats "${label}"` };
      selected.push(label);
    }
    if (!question.multiSelect && selected.length > 1) {
      return { ok: false, error: `${at}.selected has ${selected.length} labels but question "${question.id}" allows one` };
    }

    const custom = text(item.custom, `${at}.custom`, MAX_CUSTOM_ANSWER_LENGTH, { optional: true });
    if (!custom.ok) return custom;
    answered.set(item.id, { id: item.id, selected, ...(custom.value ? { custom: custom.value } : {}) });
  }
  const ordered = questions.map((q) => answered.get(q.id)).filter((a): a is QuestionAnswer => a !== undefined);
  return { ok: true, value: ordered };
}

// ---------------------------------------------------------------------------
// Model-facing text
// ---------------------------------------------------------------------------

/** `45 s`, `10 min`, `1 h 30 min`. */
export function formatWaitDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} s`;
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/** One line per question: its id and text, then the chosen labels, the user's own words, or "skipped". */
export function formatQuestionAnswerLines(
  questions: readonly UserQuestion[],
  answers: readonly QuestionAnswer[]
): string[] {
  const byId = new Map(answers.map((a) => [a.id, a] as const));
  return questions.map((q) => {
    const answer = byId.get(q.id);
    const parts: string[] = [];
    if (answer && answer.selected.length > 0) parts.push(answer.selected.join(', '));
    if (answer?.custom) parts.push(`in their own words: ${quote(answer.custom)}`);
    const reply = parts.length > 0 ? parts.join('; ') : 'skipped';
    return `- ${q.id} (${quote(q.question)}): ${reply}`;
  });
}

/** What the model reads when the user answered. */
export function formatQuestionAnswers(
  questions: readonly UserQuestion[],
  answers: readonly QuestionAnswer[]
): string {
  return ['The user answered:', ...formatQuestionAnswerLines(questions, answers)].join('\n');
}

/** What the model reads when nobody answered in time. */
export function formatQuestionExpired(timeoutMs: number): string {
  return (
    `The user did not answer within ${formatWaitDuration(timeoutMs)}. ` +
    'Continue with your best judgement and say what you assumed, or ask again later only if the decision is essential.'
  );
}

/**
 * A message that delivers an answer given after the question expired, for the platform to send
 * as the user's next message (the tool call has already returned "no answer" to the model).
 */
export function formatLateQuestionAnswers(
  question: Pick<PendingQuestion, 'questions' | 'createdAt'>,
  answers: readonly QuestionAnswer[]
): string {
  return [
    `Answer to the question you asked at ${question.createdAt}, which timed out before I answered:`,
    ...formatQuestionAnswerLines(question.questions, answers),
  ].join('\n');
}
