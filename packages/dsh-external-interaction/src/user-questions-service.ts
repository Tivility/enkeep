/**
 * A minimal enkeep-local `userQuestions` service (DSH 0.2.1-rc.5 ships none): the
 * `ask_user_question` tool asks through it, and a provider (the external interaction service)
 * holds each question until the user answers, it expires, or the call is aborted.
 *
 * @module @enkeep/dsh-external-interaction/user-questions-service
 */

import { Context, Service } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { QuestionResolution, UserQuestion } from './user-questions.js';

export const USER_QUESTIONS_SERVICE_NAME = 'userQuestions';

export interface UserQuestionsAskRequest {
  /** Normalized questions (see `normalizeAskUserQuestionInput`). */
  questions: readonly UserQuestion[];
  /** The agent asking (its session routes the question). */
  agent?: Agent;
  /** The tool call id, reused as the question id when possible. */
  callId?: string;
  /** Aborting withdraws the question (outcome `cancelled`). */
  signal?: AbortSignal;
}

export interface UserQuestionsProvider {
  ask(request: UserQuestionsAskRequest): Promise<QuestionResolution>;
}

export class UserQuestionsService extends Service {
  private readonly providers: UserQuestionsProvider[] = [];

  constructor(ctx: Context) {
    super(ctx, USER_QUESTIONS_SERVICE_NAME);
  }

  /** Registers a provider; the most recently registered one answers. Returns the disposer. */
  registerProvider(provider: UserQuestionsProvider): () => void {
    this.providers.push(provider);
    return () => {
      const index = this.providers.lastIndexOf(provider);
      if (index >= 0) this.providers.splice(index, 1);
    };
  }

  hasProvider(): boolean {
    return this.providers.length > 0;
  }

  async ask(request: UserQuestionsAskRequest): Promise<QuestionResolution> {
    const provider = this.providers[this.providers.length - 1];
    if (!provider) {
      throw new Error('No user question provider is registered in this runtime');
    }
    return provider.ask(request);
  }
}
