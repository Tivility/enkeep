import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type {
  ApprovalRequest,
  ApprovalOutcome,
  AskUserQuestionRequest,
  AskUserQuestionAnswer,
} from './types.js';
import {
  ExternalInteractionService,
  resolveSessionSource,
  DEFAULT_INTERACTION_TIMEOUT_MS,
} from './service.js';

export * from './types.js';
export * from './service.js';

export const name = 'enkeep-external-interaction';

export const inject = [];

export interface Config {
  defaultTimeoutMs?: number;
}

export const Config: Schema<Config> = Schema.object({
  defaultTimeoutMs: Schema.natural().description('Default interaction timeout in milliseconds (default: 60000)'),
});

/**
 * Functional Cordis plugin for platform session interaction & approvals.
 *
 * Intercepts approval and question requests across platform sessions.
 * Holds approval state safely in ExternalInteractionService without leaking command args.
 * Supports /api/interactions/approvals queries, decisions, cancellations, and timeouts.
 * Does NOT start any HTTP server.
 * All registrations and pending suspensions are revocable effects bound to the plugin lifecycle.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const service = new ExternalInteractionService(ctx, {
    defaultTimeoutMs: config.defaultTimeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS,
  });

  // Intercept approval requests as an effect returning its disposer
  ctx.effect(() => {
    return ctx.on('approval/request', async function (this: any, req: ApprovalRequest, _next: () => Promise<ApprovalOutcome>) {
      const source = resolveSessionSource(req.agent);
      return await service.suspendApproval(req, source);
    });
  });

  // Intercept user questions if userQuestions service is present, with scoped effect
  ctx.inject(['userQuestions'], (userQuestionsCtx) => {
    userQuestionsCtx.effect(() => {
      const userQuestionsService = userQuestionsCtx.get('userQuestions');
      if (userQuestionsService && typeof userQuestionsService.registerProvider === 'function') {
        const disposeProvider = userQuestionsService.registerProvider({
          async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
            const source = resolveSessionSource(request.agent);
            return await service.suspendQuestion(request, source);
          },
        });

        return typeof disposeProvider === 'function' ? disposeProvider : undefined;
      }
    });
  });

  // Lifecycle cleanup effect: clear and reject all pending suspensions on teardown
  ctx.effect(() => () => {
    service.disposeAll();
  });
}
