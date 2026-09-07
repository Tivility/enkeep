/**
 * Invariant manifest for @enkeep/dsh-memory
 *
 * @module @enkeep/dsh-memory/invariant
 */

export const name = '@enkeep/dsh-memory';
export const version = '0.1.0';

export const INVARIANTS = {
  STABLE_PROMPT_SECTION: 'Memory section is mounted at order 50 on systemPrompt with stable hash',
  BOUNDED_INJECTION: 'Global memory injection is bounded to maxGlobalBytes (default 20KB)',
  XML_ENCODING_SHIELD: 'Memory content is strictly sanitized and XML-escaped before prompt assembly',
  CONFUSED_DEPUTY_DEFENSE: 'Template variables {{...}} in memory content are escaped to prevent DSH interpolation errors',
  SCOPED_TOOL_CONFINEMENT: 'memory_read/write/search tools are strictly confined to per-user dshHome/memory and spacePath/memory',
  OPTIMISTIC_CONCURRENCY: 'memory_write enforces optimistic concurrency via etag / expectedHash',
  APPROVAL_GOVERNANCE: 'memory_write enforces approval policy for mutation operations',
  SUBAGENT_INHERITANCE: 'Subagents inherit parent memory context and plan',
} as const;
