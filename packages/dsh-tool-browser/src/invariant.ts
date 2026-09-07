/**
 * Invariant manifest for @enkeep/dsh-tool-browser
 *
 * @module @enkeep/dsh-tool-browser/invariant
 */

export const name = '@enkeep/dsh-tool-browser';
export const version = '0.1.0';

export const INVARIANTS = {
  STRICT_SCHEMAS: 'All 5 browser tool schemas enforce additionalProperties: false',
  INITIATOR_SCOPE_DERIVATION: 'User/space/session scopes derive strictly from initiator agent context, never model arguments',
  SAFE_URL_VALIDATION: 'browser_open strictly validates protocols and rejects dangerous javascript/file/data schemes and null bytes',
  BOUNDED_SNAPSHOT: 'browser_snapshot bounds snapshot length to prevent context explosion',
  INTERACTION_APPROVAL_GOVERNANCE: 'browser_interact enforces human approval via DSH approval service before execution',
  SCREENSHOT_ARTIFACT_PERSISTENCE: 'browser_screenshot returns virtual workspace relative path and download reference, no raw base64 to model',
  EXACT_PAGE_CLOSE: 'browser_close requires an exact pageId and fails on empty/missing pageId',
  HONEST_CAPABILITIES: 'Capabilities report operational only when Platform browser service is available',
  NO_ARBITRARY_EVALUATE: 'No arbitrary script evaluation or raw javascript execution tool is exposed',
} as const;
