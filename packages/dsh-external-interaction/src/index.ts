import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { ApprovalRequest, ApprovalOutcome } from './types.js';
import {
  ExternalInteractionService,
  resolveSessionSource,
  DEFAULT_INTERACTION_TIMEOUT_MS,
} from './service.js';
import { resolveApprovalTimeoutMs } from './approval-policy.js';
import { resolveQuestionTimeoutMs, resolveUserQuestionsEnabled } from './user-questions.js';
import {
  USER_QUESTIONS_SERVICE_NAME,
  UserQuestionsService,
  type UserQuestionsAskRequest,
} from './user-questions-service.js';
import { createAskUserQuestionTool, type UserQuestionsAsker } from './ask-user-question-tool.js';

export * from './types.js';
export * from './service.js';
export * from './user-questions.js';
export * from './user-questions-service.js';
export * from './ask-user-question-tool.js';
export {
  APPROVAL_TIMEOUT_ENV,
  MIN_APPROVAL_TIMEOUT_MS,
  MAX_APPROVAL_TIMEOUT_MS,
  parseApprovalTimeoutMs,
  resolveApprovalTimeoutMs,
} from './approval-policy.js';

export const name = 'enkeep-external-interaction';

export const inject = [];

export interface Config {
  defaultTimeoutMs?: number;
  /**
   * Approval wait in milliseconds. When omitted, `ENKEEP_APPROVAL_TIMEOUT_MS` from the runtime
   * environment applies, then `defaultTimeoutMs`, then 60 s.
   */
  approvalTimeoutMs?: number;
  /**
   * Compose the `ask_user_question` tool and the `userQuestions` service. When omitted,
   * `ENKEEP_USER_QUESTIONS=1` in the runtime environment enables them; otherwise they are absent.
   */
  userQuestions?: boolean;
  /**
   * Question wait in milliseconds. When omitted, `ENKEEP_QUESTION_TIMEOUT_MS` from the runtime
   * environment applies (1 s .. 24 h), then 10 min.
   */
  questionTimeoutMs?: number;
}

export const Config: Schema<Config> = Schema.object({
  defaultTimeoutMs: Schema.natural().description('Default interaction timeout in milliseconds (default: 60000)'),
  approvalTimeoutMs: Schema.natural().description(
    'Approval timeout in milliseconds (default: ENKEEP_APPROVAL_TIMEOUT_MS, else defaultTimeoutMs)'
  ),
  userQuestions: Schema.boolean().description(
    'Offer the ask_user_question tool (default: ENKEEP_USER_QUESTIONS=1, else off)'
  ),
  questionTimeoutMs: Schema.natural().description(
    'Question timeout in milliseconds (default: ENKEEP_QUESTION_TIMEOUT_MS, else 600000)'
  ),
});

interface ToolsRegistryLike {
  register(definition: unknown): (() => void) | unknown;
}

/**
 * Functional Cordis plugin for platform session interaction & approvals.
 *
 * Intercepts approval and question requests across platform sessions.
 * Holds approval state safely in ExternalInteractionService without leaking command args.
 * Supports /api/interactions/approvals queries, decisions, cancellations, and timeouts.
 * When user questions are enabled, also provides a `userQuestions` service and the
 * `ask_user_question` tool, whose questions wait in the same service.
 * Does NOT start any HTTP server.
 * All registrations and pending suspensions are revocable effects bound to the plugin lifecycle.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;
  const service = new ExternalInteractionService(ctx, {
    defaultTimeoutMs,
    approvalTimeoutMs: resolveApprovalTimeoutMs({
      configured: config.approvalTimeoutMs,
      env: process.env,
      fallback: defaultTimeoutMs,
    }),
    questionTimeoutMs: resolveQuestionTimeoutMs({
      configured: config.questionTimeoutMs,
      env: process.env,
    }),
  });

  // Intercept approval requests as an effect returning its disposer
  ctx.effect(() => {
    return ctx.on('approval/request', async function (this: any, req: ApprovalRequest, _next: () => Promise<ApprovalOutcome>) {
      const source = resolveSessionSource(req.agent);
      return await service.suspendApproval(req, source);
    });
  });

  // User questions (gated): our own `userQuestions` service plus the `ask_user_question` tool.
  // A `userQuestions` service composed by someone else is left alone (and gets our provider below).
  const userQuestionsEnabled = resolveUserQuestionsEnabled({ configured: config.userQuestions, env: process.env });
  if (userQuestionsEnabled && !ctx.get(USER_QUESTIONS_SERVICE_NAME)) {
    new UserQuestionsService(ctx);
    const tool = createAskUserQuestionTool(
      () => ctx.get(USER_QUESTIONS_SERVICE_NAME) as UserQuestionsAsker | undefined
    );
    ctx.inject(['tools'], (toolsCtx) => {
      toolsCtx.effect(() => {
        const tools = toolsCtx.get('tools') as ToolsRegistryLike | undefined;
        if (!tools || typeof tools.register !== 'function') {
          throw new Error('enkeep-external-interaction: the "tools" registry is unavailable for ask_user_question');
        }
        const dispose = tools.register(tool);
        return () => {
          if (typeof dispose === 'function') (dispose as () => void)();
        };
      }, 'enkeep-external-interaction.askUserQuestionTool()');
    });
  }

  // Answer questions from the userQuestions service (ours, or one composed elsewhere)
  ctx.inject([USER_QUESTIONS_SERVICE_NAME], (userQuestionsCtx) => {
    userQuestionsCtx.effect(() => {
      const userQuestionsService = userQuestionsCtx.get(USER_QUESTIONS_SERVICE_NAME);
      if (userQuestionsService && typeof userQuestionsService.registerProvider === 'function') {
        const disposeProvider = userQuestionsService.registerProvider({
          async ask(request: UserQuestionsAskRequest) {
            const source = resolveSessionSource(request.agent);
            return await service.suspendQuestion(request, source);
          },
        });

        return typeof disposeProvider === 'function' ? disposeProvider : undefined;
      }
    });
  });

  // Lifecycle cleanup effect: clear and settle all pending suspensions on teardown
  ctx.effect(() => () => {
    service.disposeAll();
  });
}
