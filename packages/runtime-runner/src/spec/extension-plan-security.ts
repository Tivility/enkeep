/**
 * Extension Activation Plan Security & Hash Verification for Enkeep DSH Runtime
 *
 * Implements deterministic SHA-256 hash calculation, fail-closed validation of contribution kinds,
 * and security containment preventing path leaks.
 *
 * @module @enkeep/runtime-runner/spec/extension-plan-security
 */

import crypto from 'node:crypto';
import {
  type ExtensionActivationPlan,
  validateExtensionActivationPlan,
} from '@enkeep/protocol';

/**
 * Computes a deterministic SHA-256 hash of an active extension plan without leaking host paths.
 */
export function computeExtensionPlanHash(plan?: ExtensionActivationPlan | null): string {
  if (!plan) {
    return crypto.createHash('sha256').update(JSON.stringify({ generation: 0, contributions: [] })).digest('hex');
  }

  const validated = validateExtensionActivationPlan(plan);
  const safeDescriptors = validated.contributions
    .map((c) => ({
      kind: c.kind,
      contributionId: c.contributionId,
      contributionKey: c.contributionKey,
      name: c.name,
      enabled: c.enabled,
      modelInvocable: (c as any).modelInvocable,
      userInvocable: (c as any).userInvocable,
      version: c.version,
      contentHash: (c as any).contentHash ?? (c as any).integrity,
      artifactRelPath: (c as any).artifactRelPath,
      trustedPluginId: (c as any).trustedPluginId,
      integrity: (c as any).integrity,
    }))
    .sort((a, b) => {
      const keyA = `${a.kind}:${a.contributionKey || a.name}`;
      const keyB = `${b.kind}:${b.contributionKey || b.name}`;
      return keyA.localeCompare(keyB);
    });

  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ generation: validated.generation, contributions: safeDescriptors }))
    .digest('hex');
}
