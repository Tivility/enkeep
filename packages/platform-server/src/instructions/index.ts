/**
 * Authoritative Platform Instructions Subsystem
 *
 * @module @enkeep/platform-server/instructions
 */

export {
  RuntimeInstructionsPort,
  validateInstructionsFilename,
  computeContentEtag,
  computeContentSha256,
  MAX_GLOBAL_INSTRUCTIONS_BYTES,
  MAX_SPACE_INSTRUCTIONS_BYTES,
  ETAG_REGEX,
  type InstructionsTarget,
  type InstructionsFilename,
  type ReadInstructionsRequest,
  type ReadInstructionsResult,
  type WriteInstructionsRequest,
  type WriteInstructionsResult,
  type RuntimeInstructionsPortOptions,
} from './runtime-instructions-port.js';

export {
  InstructionsService,
  type InstructionsServiceOptions,
  type InstructionsPayload,
  type InstructionsWritePayload,
} from './instructions-service.js';

export {
  InstructionsRoutes,
  ALLOWED_PUT_GLOBAL_INSTRUCTIONS_KEYS,
  ALLOWED_PUT_SPACE_INSTRUCTIONS_KEYS,
} from './instructions-routes.js';
