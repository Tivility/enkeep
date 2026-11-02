/**
 * The enkeep-local `ask_user_question` tool, compatible with DSH's own tool of that name:
 * input `{ questions: [{ id, question, header?, options?: [{ label, description? }],
 * multi_select? }] }`, 1–4 questions, at most 6 options each. It waits (abortably) for the
 * user's answers through the `userQuestions` service and tells the model what was chosen, or
 * that nobody answered in time.
 *
 * Registered only when user questions are enabled (`ENKEEP_USER_QUESTIONS=1`).
 *
 * @module @enkeep/dsh-external-interaction/ask-user-question-tool
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import {
  ASK_USER_QUESTION_TOOL_NAME,
  formatQuestionAnswers,
  formatQuestionExpired,
  normalizeAskUserQuestionInput,
  type QuestionAnswer,
  type QuestionResolution,
} from './user-questions.js';
import type { UserQuestionsAskRequest } from './user-questions-service.js';

/** JSON schema subset accepted by the DSH tools registry. */
interface ToolJsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  description?: string;
  properties?: Record<string, ToolJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ToolJsonSchema;
  enum?: Array<string | number | boolean | null>;
}

/** The parts of a DSH tool execution context this tool uses. */
export interface AskUserQuestionExecution {
  readonly callId?: string;
  readonly agent?: UserQuestionsAskRequest['agent'];
  readonly signal: AbortSignal;
}

/** Canonical result value of one call (what `output.render` turns into model text). */
export type AskUserQuestionResult =
  | { questionId: string; outcome: 'answered'; answers: QuestionAnswer[] }
  | { questionId: string; outcome: 'expired'; waitedMs: number };

/** Structurally a DSH `ToolDefinition`. */
export interface AskUserQuestionToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolJsonSchema & { type: 'object' };
  readonly output: {
    readonly schema: ToolJsonSchema;
    render(args: unknown, value: unknown): ContentBlock[];
  };
  execute(args: unknown, exec: AskUserQuestionExecution): Promise<AskUserQuestionResult>;
}

/** What the tool needs from the `userQuestions` service. */
export interface UserQuestionsAsker {
  ask(request: UserQuestionsAskRequest): Promise<QuestionResolution>;
}

export const ASK_USER_QUESTION_DESCRIPTION =
  'Ask the user one to four questions and wait for the answers; the user may pick offered options or ' +
  'reply in their own words, and may take minutes to answer. Use it sparingly: only when you cannot ' +
  'proceed well without the user\'s decision, such as a real choice between approaches, information ' +
  'you cannot find yourself, or confirmation before an irreversible step. Do not ask what you can look ' +
  'up or reasonably decide. If nobody answers in time, the result says so.';

const PARAMETERS: AskUserQuestionToolDefinition['parameters'] = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      description: 'One to four questions, shown to the user together.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Short id, unique in this call; the answer refers to it.' },
          question: { type: 'string', description: 'The specific question to ask.' },
          header: { type: 'string', description: 'Optional short heading, such as "Confirm" or "Choose mode".' },
          options: {
            type: 'array',
            description:
              'Optional choices, at most six. Put a recommended choice first and append "(Recommended)" to its label. ' +
              'Omit for a free-text question; the user can always reply in their own words.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Short user-facing label.' },
                description: { type: 'string', description: 'One sentence on the tradeoff or impact.' },
              },
              required: ['label'],
              additionalProperties: false,
            },
          },
          multi_select: {
            type: 'boolean',
            description: 'Whether the user may pick more than one option. Defaults to false.',
          },
        },
        required: ['id', 'question'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
};

const OUTPUT_SCHEMA: ToolJsonSchema = {
  type: 'object',
  properties: {
    questionId: { type: 'string' },
    outcome: { type: 'string', enum: ['answered', 'expired'] },
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          selected: { type: 'array', items: { type: 'string' } },
          custom: { type: 'string' },
        },
        required: ['id', 'selected'],
        additionalProperties: false,
      },
    },
    waitedMs: { type: 'integer' },
  },
  required: ['questionId', 'outcome'],
  additionalProperties: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for subagent / workflow child sessions, whose questions the platform cannot route. */
function isChildSessionAgent(agent: unknown): boolean {
  if (!isRecord(agent)) return false;
  const session = isRecord(agent.session) ? agent.session : undefined;
  const header = isRecord(session?.header) ? session!.header : undefined;
  const meta = isRecord(session?.meta) ? session!.meta : undefined;
  const parent = header?.parentSession ?? meta?.parentSession ?? header?.parentSessionId ?? meta?.parentSessionId;
  if (parent !== undefined && parent !== null && String(parent).trim() !== '') return true;
  return (header?.origin ?? meta?.origin) === 'subagent';
}

function abortError(signal: AbortSignal, reason?: string): Error {
  const err = new Error(reason ? `ask_user_question was cancelled: ${reason}` : 'ask_user_question was cancelled');
  err.name = 'AbortError';
  (err as Error & { cause?: unknown }).cause = signal.reason;
  return err;
}

function render(args: unknown, value: unknown): ContentBlock[] {
  if (!isRecord(value)) return [{ type: 'text', text: 'The user did not answer.' }];
  if (value.outcome === 'expired') {
    const waited = typeof value.waitedMs === 'number' ? value.waitedMs : 0;
    return [{ type: 'text', text: formatQuestionExpired(waited) }];
  }
  const parsed = normalizeAskUserQuestionInput(args);
  const answers = Array.isArray(value.answers) ? (value.answers as QuestionAnswer[]) : [];
  if (!parsed.ok) {
    return [{ type: 'text', text: `The user answered: ${JSON.stringify(answers)}` }];
  }
  return [{ type: 'text', text: formatQuestionAnswers(parsed.value, answers) }];
}

/**
 * Creates the tool. `getAsker` is read at call time (the `userQuestions` service of the runtime).
 */
export function createAskUserQuestionTool(
  getAsker: () => UserQuestionsAsker | undefined
): AskUserQuestionToolDefinition {
  return {
    name: ASK_USER_QUESTION_TOOL_NAME,
    description: ASK_USER_QUESTION_DESCRIPTION,
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(rawArgs: unknown, exec: AskUserQuestionExecution): Promise<AskUserQuestionResult> {
      const parsed = normalizeAskUserQuestionInput(rawArgs);
      if (!parsed.ok) {
        throw new TypeError(`Invalid ask_user_question arguments: ${parsed.error}`);
      }
      if (isChildSessionAgent(exec.agent)) {
        throw new Error(
          'ask_user_question is available to the main agent only; report the open question to your parent agent instead'
        );
      }
      const asker = getAsker();
      if (!asker || typeof asker.ask !== 'function') {
        throw new Error('Asking the user is not available in this runtime');
      }
      if (exec.signal.aborted) throw abortError(exec.signal);

      const resolution = await asker.ask({
        questions: parsed.value,
        agent: exec.agent,
        callId: typeof exec.callId === 'string' ? exec.callId : undefined,
        signal: exec.signal,
      });
      switch (resolution.outcome) {
        case 'answered':
          return { questionId: resolution.questionId, outcome: 'answered', answers: resolution.answers };
        case 'expired':
          return { questionId: resolution.questionId, outcome: 'expired', waitedMs: resolution.timeoutMs };
        default:
          throw abortError(exec.signal, resolution.reason);
      }
    },
  };
}
