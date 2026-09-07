import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';

export interface AffinityPolicyConfig {
  /**
   * Whether strict verification is enforced (default: true).
   * When true, requests without a valid sessionId are rejected fail-loud.
   */
  strict?: boolean;

  /**
   * Whether auxiliary requests (e.g. compaction, session-title) with purpose stamped are exempt or validated.
   * Default: false (all model requests must carry valid session affinity).
   */
  exemptAuxiliary?: boolean;

  /**
   * Specific purpose names that are exempt from sessionId requirements.
   */
  exemptPurposes?: string[];
}

export class AffinityPolicyError extends Error {
  public readonly code: string;
  public readonly details?: unknown;

  constructor(message: string, code = 'MISSING_SESSION_AFFINITY', details?: unknown) {
    super(message);
    this.name = 'AffinityPolicyError';
    this.code = code;
    this.details = details;
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'llm/stream'(
      options: GenerateOptions,
      next: () => AsyncIterable<StreamChunk>
    ): AsyncIterable<StreamChunk>;
  }
}
