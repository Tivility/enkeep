import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { AffinityPolicyConfig, AffinityPolicyError } from './types.js';

export * from './types.js';

export const name = 'enkeep-affinity-policy';

export const inject = [];

export interface Config extends AffinityPolicyConfig {}

export const Config: Schema<Config> = Schema.object({
  strict: Schema.boolean().default(true).description('Fail-loud when sessionId is missing'),
  exemptAuxiliary: Schema.boolean().default(false).description('Whether auxiliary requests (with purpose) are exempt'),
  exemptPurposes: Schema.array(Schema.string()).default([]).description('List of exempt purpose classifications'),
});

/**
 * Functional Cordis plugin that performs strict, fail-loud verification of sessionId on llm/stream requests.
 *
 * It validates that incoming model requests carry a valid sessionId for affinity and state routing.
 * Does NOT inject headers or mutate wire payload (delegating actual transport routing to affinity transport layer).
 * All listeners are revocable effects bound to the plugin lifecycle.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const strict = config.strict ?? true;
  const exemptAuxiliary = config.exemptAuxiliary ?? false;
  const exemptPurposes = new Set(config.exemptPurposes ?? []);

  // Wrap llm/stream listener in ctx.effect returning the disposer
  ctx.effect(() => {
    return ctx.on('llm/stream', function (this: any, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
      const sessionId = options.sessionId;

      const hasValidSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0;

      if (!hasValidSessionId) {
        const isExempt =
          (exemptAuxiliary && Boolean(options.purpose)) ||
          (Boolean(options.purpose) && exemptPurposes.has(options.purpose!));

        if (!isExempt && strict) {
          throw new AffinityPolicyError(
            `[AffinityPolicy] llm/stream request rejected: missing or invalid sessionId (received: ${JSON.stringify(
              sessionId
            )}) for provider "${options.provider}", model "${options.model}". Session affinity verification failed loudly.`,
            'MISSING_SESSION_AFFINITY',
            { provider: options.provider, model: options.model, purpose: options.purpose }
          );
        }
      }

      // Pass through without any wire payload mutation or transport header injection
      return next();
    });
  });
}
