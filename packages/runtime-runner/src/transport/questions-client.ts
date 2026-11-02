/**
 * Host-side helpers for `ask_user_question` questions held in a user's runtime: the
 * `listQuestions` / `answerQuestion` ops and typed subscriptions to the `question/asked` /
 * `question/settled` pushes. Shared by the Docker daemon transport and the host-mode UDS transport.
 *
 * The daemon broadcasts pushes to the connected bridge only, without replay: after a
 * (re)connect (`'connected'` on the transport), resynchronize with `listQuestions()`.
 *
 * @module @enkeep/runtime-runner/transport/questions-client
 */

import crypto from 'node:crypto';
import type { EventEmitter } from 'node:events';
import {
  DAEMON_OPS,
  DAEMON_STREAM_EVENTS,
  type AnswerQuestionRequest,
  type AnswerQuestionResponse,
  type AnswerQuestionResult,
  type DaemonStreamEvent,
  type DaemonStreamQuestionAskedEvent,
  type DaemonStreamQuestionSettledEvent,
  type ListQuestionsRequest,
  type ListQuestionsResponse,
  type ListQuestionsResult,
  type QuestionAnswer,
} from '../runtime/daemon-protocol.js';
import type { DaemonRequestFn } from './session-history-client.js';

/** A `question/asked` or `question/settled` push, stamped with the runtime owner when known. */
export type HostQuestionEvent =
  | (DaemonStreamQuestionAskedEvent & { readonly userId?: string })
  | (DaemonStreamQuestionSettledEvent & { readonly userId?: string });

export type HostQuestionEventListener = (event: HostQuestionEvent) => void;

/** Run `listQuestions` and strip the envelope. */
export async function listQuestionsVia(
  request: DaemonRequestFn,
  sessionId?: string,
  timeoutMs?: number
): Promise<ListQuestionsResult> {
  const req: ListQuestionsRequest = {
    id: `list_questions_${crypto.randomUUID()}`,
    op: DAEMON_OPS.LIST_QUESTIONS,
    ...(sessionId ? { sessionId } : {}),
  };
  const res = (await request(req, timeoutMs)) as ListQuestionsResponse;
  return {
    enabled: Boolean(res.enabled),
    questions: Array.isArray(res.questions) ? res.questions : [],
  };
}

/**
 * Run `answerQuestion` and strip the envelope. Rejects with a `DaemonProtocolError` whose `code`
 * is `question/not-found`, `question/expired`, `question/already-settled`,
 * `question/invalid-answers`, `question/unavailable` or `INVALID_PARAMETERS`.
 */
export async function answerQuestionVia(
  request: DaemonRequestFn,
  questionId: string,
  answers: readonly QuestionAnswer[],
  timeoutMs?: number
): Promise<AnswerQuestionResult> {
  const req: AnswerQuestionRequest = {
    id: `answer_question_${crypto.randomUUID()}`,
    op: DAEMON_OPS.ANSWER_QUESTION,
    questionId,
    answers,
  };
  const res = (await request(req, timeoutMs)) as AnswerQuestionResponse;
  return {
    questionId: res.questionId,
    answered: true,
    answers: Array.isArray(res.answers) ? res.answers : [],
  };
}

/** Subscribe to `question/asked` / `question/settled` pushes on a transport's `'stream'`; returns unsubscribe. */
export function subscribeQuestionEvents(
  emitter: EventEmitter,
  userId: string | undefined,
  listener: HostQuestionEventListener
): () => void {
  const onStream = (event: DaemonStreamEvent) => {
    if (!event) return;
    if (event.event !== DAEMON_STREAM_EVENTS.QUESTION_ASKED && event.event !== DAEMON_STREAM_EVENTS.QUESTION_SETTLED) {
      return;
    }
    try {
      listener(userId ? { ...event, userId } : event);
    } catch {
      // A failing subscriber must not break the transport's stream dispatch.
    }
  };
  emitter.on('stream', onStream);
  return () => {
    emitter.removeListener('stream', onStream);
  };
}
