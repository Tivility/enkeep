/**
 * Container Specification Validator for Enkeep DSH Runtime
 *
 * Enforces strict non-root, per-user volume isolation, mandatory random run-id,
 * immutable volume-id tracking, exact lowercase 64-hex container ID validation,
 * writable home volume, and strict zero-network (--network none) rules.
 *
 * @module @enkeep/runtime-runner/spec/validator
 */

import type {
  RuntimeContainerSpec,
  RuntimeVolumeSpec,
  RuntimeMountSpec,
  SpecValidationResult,
} from './types.js';
import { validateMountSpec } from './mount-security.js';

export const DEMO_CONTAINER_PREFIX = 'enkeep-demo-';
export const DEMO_VOLUME_PREFIX = 'enkeep-demo-dsh-';
export const DEMO_LABEL_KEY = 'app';
export const DEMO_LABEL_VALUE = 'enkeep-demo';
export const USER_LABEL_KEY = 'enkeep.user';
export const RUN_ID_LABEL_KEY = 'enkeep.run-id';
export const RUN_LABEL_KEY = 'enkeep.run-id'; // Unified to enkeep.run-id
export const VOLUME_ID_LABEL_KEY = 'enkeep.volume-id';
/** Which deployment a runtime container or volume belongs to: `production` or `test`. */
export const ENV_LABEL_KEY = 'enkeep.env';

/**
 * Naming of runtime containers and home volumes. A production deployment and test/demo runs use
 * disjoint prefixes and `app` labels, so test cleanup can never match a production resource and a
 * production resource never reads as a demo. The namespace of a resource follows from its name.
 */
export interface RuntimeResourceNamespace {
  readonly env: 'production' | 'test';
  readonly containerPrefix: string;
  readonly volumePrefix: string;
  /** Value of the `app` label. */
  readonly appLabel: string;
}

/** Test, demo and e2e runs (the original `enkeep-demo-*` names). */
export const TEST_RESOURCE_NAMESPACE: RuntimeResourceNamespace = Object.freeze({
  env: 'test',
  containerPrefix: DEMO_CONTAINER_PREFIX,
  volumePrefix: DEMO_VOLUME_PREFIX,
  appLabel: DEMO_LABEL_VALUE,
});

/** A production deployment started with `enkeep-server serve`. */
export const PRODUCTION_RESOURCE_NAMESPACE: RuntimeResourceNamespace = Object.freeze({
  env: 'production',
  containerPrefix: 'enkeep-runtime-',
  volumePrefix: 'enkeep-home-',
  appLabel: 'enkeep',
});

export const RUNTIME_RESOURCE_NAMESPACES: readonly RuntimeResourceNamespace[] = Object.freeze([
  TEST_RESOURCE_NAMESPACE,
  PRODUCTION_RESOURCE_NAMESPACE,
]);

const RESOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,60}$/;

/** Namespace of a container name, or undefined when the name is in none. */
export function namespaceOfContainerName(name: unknown): RuntimeResourceNamespace | undefined {
  if (typeof name !== 'string') return undefined;
  return RUNTIME_RESOURCE_NAMESPACES.find(
    (ns) => name.startsWith(ns.containerPrefix) && RESOURCE_ID_PATTERN.test(name.slice(ns.containerPrefix.length))
  );
}

/** Namespace of a volume name, or undefined when the name is in none. */
export function namespaceOfVolumeName(name: unknown): RuntimeResourceNamespace | undefined {
  if (typeof name !== 'string') return undefined;
  return RUNTIME_RESOURCE_NAMESPACES.find(
    (ns) => name.startsWith(ns.volumePrefix) && RESOURCE_ID_PATTERN.test(name.slice(ns.volumePrefix.length))
  );
}

/** Whether `name` is `<prefix><userId>` or `<prefix><userId>-<suffix>` for the given prefix. */
export function isNameScopedToUser(name: string, prefix: string, userId: string): boolean {
  return name === `${prefix}${userId}` || name.startsWith(`${prefix}${userId}-`);
}

/**
 * Whether labels carry the ownership marks of `ns`: its `app` value, and, when present, a matching
 * `enkeep.env`.
 */
export function labelsMatchNamespace(labels: Readonly<Record<string, string>> | undefined, ns: RuntimeResourceNamespace): boolean {
  if (!labels || labels[DEMO_LABEL_KEY] !== ns.appLabel) return false;
  const env = labels[ENV_LABEL_KEY];
  return env === undefined || env === ns.env;
}

export const FORBIDDEN_HOST_PATTERNS = Object.freeze([
  '0.0.0.0',
  '::',
  '::0',
  '0:0:0:0:0:0:0:0',
  '*',
]);

export const CONTAINER_NAME_REGEX = /^(?:enkeep-demo-|enkeep-runtime-)[a-z0-9][a-z0-9_-]{0,60}$/;
export const VOLUME_NAME_REGEX = /^(?:enkeep-demo-dsh-|enkeep-home-)[a-z0-9][a-z0-9_-]{0,60}$/;
export const USER_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const RUN_ID_REGEX = /^run_[a-zA-Z0-9_-]{1,64}$/;
export const VOLUME_ID_REGEX = /^vol_[0-9a-f]{32}$/;
export const IMAGE_REF_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,127}$/;

const HEX_64_REGEX = /^[0-9a-f]{64}$/;

/**
 * Type guard for generic objects without unsafe type assertions.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates whether a container ID is a full 64-character lowercase hexadecimal SHA256 string.
 */
export function is64HexContainerId(id: unknown): id is string {
  return typeof id === 'string' && HEX_64_REGEX.test(id);
}

// --- Typed Error Hierarchy ---

export class DockerOwnershipError extends Error {
  readonly code: string = 'DOCKER_OWNERSHIP_VIOLATION';
  constructor(message = 'Docker ownership or hardening invariant violation') {
    super(`Safety Violation: ${message}`);
    this.name = 'DockerOwnershipError';
  }
}

export class NetworkModeMismatchError extends DockerOwnershipError {
  override readonly code: string = 'NETWORK_MODE_MISMATCH';
  readonly existingMode: string;
  readonly desiredMode: string;

  constructor(existingMode: string, desiredMode: string, message?: string) {
    super(
      message ??
        `Container networkMode mismatch: existing container has "${existingMode}", but requested "${desiredMode}". ` +
        `Controlled rollout requires draining active turns and controlled teardown/rebuild.`
    );
    this.name = 'NetworkModeMismatchError';
    this.existingMode = existingMode;
    this.desiredMode = desiredMode;
  }
}

export class DockerCollisionError extends Error {
  readonly code = 'DOCKER_RESOURCE_COLLISION';
  constructor(message = 'Docker resource collision detected') {
    super(`Safety Violation: Collision detected: ${message}`);
    this.name = 'DockerCollisionError';
  }
}

export class DockerDaemonError extends Error {
  readonly code = 'DOCKER_DAEMON_ERROR';
  constructor(message = 'Docker daemon error', public readonly cause?: unknown) {
    super(`Docker daemon error: ${message}`);
    this.name = 'DockerDaemonError';
  }
}

export class DockerNotFoundError extends Error {
  readonly code = 'DOCKER_NOT_FOUND';
  constructor(message = 'Docker resource not found') {
    super(`Docker resource not found: ${message}`);
    this.name = 'DockerNotFoundError';
  }
}

export class DockerProtocolError extends Error {
  readonly code = 'DOCKER_PROTOCOL_ERROR';
  constructor(message = 'Docker protocol error', public readonly cause?: unknown) {
    super(`Docker protocol error: ${message}`);
    this.name = 'DockerProtocolError';
  }
}

export const ALLOWED_SPEC_KEYS = new Set([
  'userId',
  'runId',
  'containerName',
  'image',
  'user',
  'workingDir',
  'volume',
  'mounts',
  'bindMounts',
  'networkMode',
  'labels',
  'environment',
]);

export const ALLOWED_VOLUME_KEYS = new Set([
  'volumeName',
  'volumeId',
  'containerPath',
  'readOnly',
]);

export const ALLOWED_LABEL_KEYS = new Set([
  DEMO_LABEL_KEY,
  USER_LABEL_KEY,
  RUN_ID_LABEL_KEY,
  VOLUME_ID_LABEL_KEY,
  ENV_LABEL_KEY,
]);

/** Runtime env key read by `@enkeep/dsh-external-interaction` for the approval wait (ms). */
export const APPROVAL_TIMEOUT_ENV_KEY = 'ENKEEP_APPROVAL_TIMEOUT_MS';
const POSITIVE_INTEGER_STRING = /^[1-9]\d{0,15}$/;

/**
 * The approval wait timeout to pass to a runtime process, from a raw env value: a positive
 * integer string (ms) as given, otherwise `undefined` (the runtime keeps its default; it bounds
 * the value itself).
 */
export function normalizeApprovalTimeoutEnv(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!POSITIVE_INTEGER_STRING.test(value) || !Number.isSafeInteger(Number(value))) return undefined;
  return value;
}

/** Runtime env gate read by `@enkeep/dsh-external-interaction`: `1` composes `ask_user_question`. */
export const USER_QUESTIONS_ENV_KEY = 'ENKEEP_USER_QUESTIONS';

/** Runtime env key read by `@enkeep/dsh-external-interaction` for the question wait (ms). */
export const QUESTION_TIMEOUT_ENV_KEY = 'ENKEEP_QUESTION_TIMEOUT_MS';

/** The user-questions gate to pass to a runtime process: `'1'` or `'0'` (trimmed), else `undefined`. */
export function normalizeUserQuestionsEnv(raw: unknown): '1' | '0' | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return value === '1' || value === '0' ? value : undefined;
}

/**
 * The question wait timeout to pass to a runtime process: a positive integer string (ms) as given,
 * otherwise `undefined` (the runtime bounds it to 1 s .. 24 h and defaults to 10 min).
 */
export function normalizeQuestionTimeoutEnv(raw: unknown): string | undefined {
  return normalizeApprovalTimeoutEnv(raw);
}

export const ALLOWED_ENV_KEYS = new Set([
  'DSH_USER',
  'DSH_HOME',
  'DSH_SPACES',
  'DSH_IDLE_AGENT_TIMEOUT_MS',
  'DSH_MAX_AGENTS',
  'DSH_MAX_CONCURRENT_SESSIONS',
  'ENKEEP_CONTEXT_WINDOW_DEFAULT',
  'ENKEEP_APPROVAL_TIMEOUT_MS',
  'ENKEEP_USER_QUESTIONS',
  'ENKEEP_QUESTION_TIMEOUT_MS',
  'ENKEEP_LLM_ENABLED',
  'ENKEEP_LLM_PROVIDER',
  'ENKEEP_LLM_MODEL',
  'ENKEEP_LLM_BASE_URL',
  'ENKEEP_LLM_PROVIDERS',
  'IN_CONTAINER_PLACEHOLDER',
]);

/**
 * Validates a single RuntimeContainerSpec against safety and zero-network invariants.
 * Accepts raw unknown input without type assertions and strictly rejects unknown/forbidden properties.
 *
 * @param rawSpec - The container configuration to validate.
 * @returns Validation outcome and list of violations (if any).
 */
export function validateContainerSpec(rawSpec: unknown): SpecValidationResult {
  const errors: string[] = [];

  if (!isRecord(rawSpec)) {
    return {
      valid: false,
      errors: ['Container specification must be a valid JSON object.'],
    };
  }

  // 0. Unknown property rejection on spec object
  for (const key of Object.keys(rawSpec)) {
    if (!ALLOWED_SPEC_KEYS.has(key)) {
      errors.push('Unknown or forbidden property in RuntimeContainerSpec.');
    }
  }

  // 1. User ID validation (strict lowercase alphanumeric, rejects trim differences and whitespace/uppercase)
  const userId = rawSpec.userId;
  if (typeof userId !== 'string' || !USER_ID_REGEX.test(userId)) {
    errors.push(
      'userId must match pattern ^[a-z0-9][a-z0-9_-]{0,63}$ (lowercase alphanumeric)'
    );
  }

  // 2. Mandatory Run ID validation
  const runId = rawSpec.runId;
  if (!runId || typeof runId !== 'string' || !RUN_ID_REGEX.test(runId)) {
    errors.push('runId must match pattern ^run_[a-zA-Z0-9_-]{1,64}$');
  }

  // 3. Container name validation (exact scope relationship to userId)
  const containerName = rawSpec.containerName;
  if (!containerName || typeof containerName !== 'string') {
    errors.push('containerName must be a non-empty string');
  } else if (!CONTAINER_NAME_REGEX.test(containerName) || !namespaceOfContainerName(containerName)) {
    errors.push('containerName must match pattern ^(enkeep-demo-|enkeep-runtime-)[a-z0-9][a-z0-9_-]{0,60}$');
  } else if (typeof userId === 'string' && USER_ID_REGEX.test(userId)) {
    const ns = namespaceOfContainerName(containerName)!;
    if (!isNameScopedToUser(containerName, ns.containerPrefix, userId)) {
      errors.push('containerName must be scoped to userId');
    }
  }
  const containerNamespace = namespaceOfContainerName(containerName);

  // 4. Image validation (strict bounded, no whitespace/control characters, no leading dash)
  const image = rawSpec.image;
  if (
    !image ||
    typeof image !== 'string' ||
    image.startsWith('-') ||
    /\s|[\x00-\x1F\x7F]/.test(image) ||
    !IMAGE_REF_REGEX.test(image)
  ) {
    errors.push(
      'image is invalid. Must be a valid Docker image reference without whitespace, control characters, or leading dash.'
    );
  }

  // 5. Non-root user execution: must be exactly '1000:1000'
  const user = rawSpec.user;
  if (user !== '1000:1000') {
    errors.push(
      'user is forbidden. Container user MUST run as non-root (must be exactly "1000:1000").'
    );
  }

  // 6. Working directory: must be exactly '/home/dsh'
  const workingDir = rawSpec.workingDir;
  if (workingDir !== '/home/dsh') {
    errors.push(
      'workingDir is forbidden. Container workingDir MUST be exactly "/home/dsh".'
    );
  }

  // 7. Network mode enforcement: whitelisted 'none' or 'bridge'
  const networkMode = rawSpec.networkMode;
  if (networkMode !== 'none' && networkMode !== 'bridge') {
    errors.push('networkMode MUST be "none" or "bridge"');
  }

  // 8. No published ports permitted under container isolation architecture
  if ('publishedPorts' in rawSpec) {
    errors.push('publishedPorts is strictly forbidden under container isolation architecture');
  }

  // 9. Controlled host mounts validation & legacy bindMounts check
  const mounts = rawSpec.mounts;
  if (mounts !== undefined) {
    if (!Array.isArray(mounts)) {
      errors.push('mounts must be an array of RuntimeMountSpec');
    } else {
      const seenIds = new Set<string>();
      for (const m of mounts) {
        const mountRes = validateMountSpec(m);
        if (!mountRes.valid) {
          errors.push(...mountRes.errors);
        } else if (mountRes.spec) {
          if (seenIds.has(mountRes.spec.id)) {
            errors.push(`Duplicate mount ID "${mountRes.spec.id}" in container specification`);
          }
          seenIds.add(mountRes.spec.id);
        }
      }
    }
  }

  const bindMounts = rawSpec.bindMounts;
  if (bindMounts !== undefined) {
    if (!Array.isArray(bindMounts) || bindMounts.length > 0) {
      errors.push('Host bind mounts are strictly forbidden. bindMounts must be absent or an empty array.');
    }
  }

  // 10. Dedicated volume specification
  const expectedUserId = typeof userId === 'string' ? userId : undefined;
  const volumeValidation = validateVolumeSpec(rawSpec.volume, expectedUserId);
  if (!volumeValidation.valid) {
    errors.push(...volumeValidation.errors);
  } else if (containerNamespace && isRecord(rawSpec.volume)) {
    const volumeNamespace = namespaceOfVolumeName(rawSpec.volume['volumeName']);
    if (volumeNamespace && volumeNamespace !== containerNamespace) {
      errors.push(`volume.volumeName must be a ${containerNamespace.env} volume (${containerNamespace.volumePrefix}*) for this container`);
    }
  }

  // 11. Required metadata labels: only allowed keys and exact values
  const labels = rawSpec.labels;
  if (!isRecord(labels)) {
    errors.push('labels must be an object');
  } else {
    for (const key of Object.keys(labels)) {
      if (!ALLOWED_LABEL_KEYS.has(key)) {
        errors.push('Forbidden extra label. Only app, enkeep.user, enkeep.run-id, enkeep.volume-id, enkeep.env are allowed.');
      }
    }
    if (containerNamespace && !labelsMatchNamespace(labels as Record<string, string>, containerNamespace)) {
      errors.push(`labels must contain app: ${containerNamespace.appLabel} (and enkeep.env: ${containerNamespace.env} when set)`);
    } else if (!containerNamespace && labels[DEMO_LABEL_KEY] !== DEMO_LABEL_VALUE) {
      errors.push('labels must contain app: enkeep-demo');
    }
    if (typeof userId === 'string' && labels[USER_LABEL_KEY] !== userId) {
      errors.push('labels must contain enkeep.user matching the container userId');
    }
    if (typeof runId === 'string' && labels[RUN_ID_LABEL_KEY] !== runId) {
      errors.push('labels must contain enkeep.run-id matching the container runId');
    }
    const expectedVolumeId = isRecord(rawSpec.volume) && typeof rawSpec.volume.volumeId === 'string' ? rawSpec.volume.volumeId : undefined;
    if (expectedVolumeId && labels[VOLUME_ID_LABEL_KEY] !== expectedVolumeId) {
      errors.push('labels must contain enkeep.volume-id matching the volumeId');
    }
  }

  // 12. Environment variables: only allowed keys and exact matching values
  const environment = rawSpec.environment;
  if (!isRecord(environment)) {
    errors.push('environment must be an object');
  } else {
    for (const [key, v] of Object.entries(environment)) {
      if (!ALLOWED_ENV_KEYS.has(key)) {
        if (typeof v === 'string') {
          const trimmed = v.trim().toLowerCase();
          if (FORBIDDEN_HOST_PATTERNS.some((pattern) => trimmed === pattern || trimmed.startsWith(pattern + ':'))) {
            errors.push('Forbidden listening host pattern in environment variable. 0.0.0.0 listening is strictly prohibited.');
          }
        }
        errors.push('Forbidden extra environment variable. Only DSH_USER, DSH_HOME, DSH_SPACES are permitted.');
      }
    }
    if (typeof userId === 'string' && environment.DSH_USER !== userId) {
      errors.push('environment.DSH_USER must match userId');
    }
    if (environment.DSH_HOME !== '/home/dsh/.dsh' && environment.DSH_HOME !== '/home/dsh') {
      errors.push('environment.DSH_HOME must be "/home/dsh/.dsh" or "/home/dsh"');
    }
    if (environment.DSH_SPACES !== '/home/dsh/spaces') {
      errors.push('environment.DSH_SPACES must be "/home/dsh/spaces"');
    }
    if ('DSH_IDLE_AGENT_TIMEOUT_MS' in environment && environment.DSH_IDLE_AGENT_TIMEOUT_MS !== undefined) {
      if (typeof environment.DSH_IDLE_AGENT_TIMEOUT_MS !== 'string' || !/^\d+$/.test(environment.DSH_IDLE_AGENT_TIMEOUT_MS)) {
        errors.push('environment.DSH_IDLE_AGENT_TIMEOUT_MS must be a positive integer string');
      }
    }
    if ('ENKEEP_APPROVAL_TIMEOUT_MS' in environment && environment.ENKEEP_APPROVAL_TIMEOUT_MS !== undefined) {
      if (normalizeApprovalTimeoutEnv(environment.ENKEEP_APPROVAL_TIMEOUT_MS) !== environment.ENKEEP_APPROVAL_TIMEOUT_MS) {
        errors.push('environment.ENKEEP_APPROVAL_TIMEOUT_MS must be a positive integer string');
      }
    }
    if ('ENKEEP_USER_QUESTIONS' in environment && environment.ENKEEP_USER_QUESTIONS !== undefined) {
      if (environment.ENKEEP_USER_QUESTIONS !== '1' && environment.ENKEEP_USER_QUESTIONS !== '0') {
        errors.push('environment.ENKEEP_USER_QUESTIONS must be "1" or "0"');
      }
    }
    if ('ENKEEP_QUESTION_TIMEOUT_MS' in environment && environment.ENKEEP_QUESTION_TIMEOUT_MS !== undefined) {
      if (normalizeQuestionTimeoutEnv(environment.ENKEEP_QUESTION_TIMEOUT_MS) !== environment.ENKEEP_QUESTION_TIMEOUT_MS) {
        errors.push('environment.ENKEEP_QUESTION_TIMEOUT_MS must be a positive integer string');
      }
    }
    if ('DSH_MAX_AGENTS' in environment && environment.DSH_MAX_AGENTS !== undefined) {
      if (typeof environment.DSH_MAX_AGENTS !== 'string' || !/^\d+$/.test(environment.DSH_MAX_AGENTS)) {
        errors.push('environment.DSH_MAX_AGENTS must be a positive integer string');
      }
    }
    if ('DSH_MAX_CONCURRENT_SESSIONS' in environment && environment.DSH_MAX_CONCURRENT_SESSIONS !== undefined) {
      if (typeof environment.DSH_MAX_CONCURRENT_SESSIONS !== 'string' || !/^\d+$/.test(environment.DSH_MAX_CONCURRENT_SESSIONS)) {
        errors.push('environment.DSH_MAX_CONCURRENT_SESSIONS must be a positive integer string');
      }
    }
    if ('ENKEEP_LLM_ENABLED' in environment && environment.ENKEEP_LLM_ENABLED !== undefined) {
      if (environment.ENKEEP_LLM_ENABLED !== '1' && environment.ENKEEP_LLM_ENABLED !== '0') {
        errors.push('environment.ENKEEP_LLM_ENABLED must be "1" or "0"');
      }
    }
    if ('ENKEEP_LLM_PROVIDER' in environment && environment.ENKEEP_LLM_PROVIDER !== undefined) {
      if (typeof environment.ENKEEP_LLM_PROVIDER !== 'string' || !/^[a-zA-Z0-9_\-:.]{1,128}$/.test(environment.ENKEEP_LLM_PROVIDER)) {
        errors.push('environment.ENKEEP_LLM_PROVIDER must match canonical provider identifier pattern');
      }
    }
    if ('ENKEEP_LLM_MODEL' in environment && environment.ENKEEP_LLM_MODEL !== undefined) {
      if (typeof environment.ENKEEP_LLM_MODEL !== 'string' || !/^[a-zA-Z0-9_\-:.]{1,128}$/.test(environment.ENKEEP_LLM_MODEL)) {
        errors.push('environment.ENKEEP_LLM_MODEL must match canonical model identifier pattern');
      }
    }
    if ('ENKEEP_LLM_PROVIDERS' in environment && environment.ENKEEP_LLM_PROVIDERS !== undefined) {
      if (typeof environment.ENKEEP_LLM_PROVIDERS !== 'string') {
        errors.push('environment.ENKEEP_LLM_PROVIDERS must be a valid JSON string');
      }
    }
    if ('ENKEEP_LLM_BASE_URL' in environment && environment.ENKEEP_LLM_BASE_URL !== undefined) {
      if (
        typeof environment.ENKEEP_LLM_BASE_URL !== 'string' ||
        (!environment.ENKEEP_LLM_BASE_URL.startsWith('http://127.0.0.1:') &&
          !environment.ENKEEP_LLM_BASE_URL.startsWith('http://localhost:'))
      ) {
        errors.push('environment.ENKEEP_LLM_BASE_URL must be a safe local loopback URL');
      }
    }
    if ('IN_CONTAINER_PLACEHOLDER' in environment && environment.IN_CONTAINER_PLACEHOLDER !== undefined) {
      if (
        typeof environment.IN_CONTAINER_PLACEHOLDER !== 'string' ||
        environment.IN_CONTAINER_PLACEHOLDER !== 'in-container-placeholder'
      ) {
        errors.push('environment.IN_CONTAINER_PLACEHOLDER must be "in-container-placeholder"');
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates a RuntimeVolumeSpec for security compliance and user isolation.
 * Accepts raw unknown input and strictly rejects unknown/forbidden properties.
 */
export function validateVolumeSpec(volume: unknown, expectedUserId?: string): SpecValidationResult {
  const errors: string[] = [];

  if (!isRecord(volume)) {
    return { valid: false, errors: ['volume specification is required and must be an object'] };
  }

  // Unknown property rejection on volume object
  for (const key of Object.keys(volume)) {
    if (!ALLOWED_VOLUME_KEYS.has(key)) {
      errors.push('Unknown or forbidden property in RuntimeVolumeSpec.');
    }
  }

  const volumeName = volume.volumeName;
  if (!volumeName || typeof volumeName !== 'string') {
    errors.push('volume.volumeName must be a non-empty string');
  } else if (!VOLUME_NAME_REGEX.test(volumeName) || !namespaceOfVolumeName(volumeName)) {
    errors.push('volume.volumeName must match pattern ^(enkeep-demo-dsh-|enkeep-home-)[a-z0-9][a-z0-9_-]{0,60}$');
  } else if (expectedUserId && USER_ID_REGEX.test(expectedUserId)) {
    const ns = namespaceOfVolumeName(volumeName)!;
    if (!isNameScopedToUser(volumeName, ns.volumePrefix, expectedUserId)) {
      errors.push('volume.volumeName must be scoped to user');
    }
  }

  const volumeId = volume.volumeId;
  if (!volumeId || typeof volumeId !== 'string' || !VOLUME_ID_REGEX.test(volumeId)) {
    errors.push('volume.volumeId must match pattern ^vol_[0-9a-f]{32}$');
  }

  const containerPath = volume.containerPath;
  if (containerPath !== '/home/dsh') {
    errors.push('volume.containerPath must be exactly "/home/dsh"');
  }

  // Runtime requires writable user home volume (/home/dsh). readOnly=true is forbidden.
  if (volume.readOnly === true) {
    errors.push('volume.readOnly=true is forbidden. DSH runtime requires a writable home volume.');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates cross-user isolation invariants between two runtime specifications.
 * Ensures Alice and Bob have distinct container names, dedicated non-overlapping volumes, and unique volumeIds.
 */
export function validateCrossUserIsolation(
  userASpec: RuntimeContainerSpec,
  userBSpec: RuntimeContainerSpec
): SpecValidationResult {
  const errors: string[] = [];

  if (userASpec.userId === userBSpec.userId) {
    errors.push('Cannot cross-validate identical user');
    return { valid: false, errors };
  }

  // Container name collision check
  if (userASpec.containerName === userBSpec.containerName) {
    errors.push(
      'CRITICAL ISOLATION VIOLATION: Container name collision: Both users share containerName'
    );
  }

  // Volume isolation invariant: Alice and Bob MUST have distinct volume names and volumeIds
  if (userASpec.volume?.volumeName && userBSpec.volume?.volumeName && userASpec.volume.volumeName === userBSpec.volume.volumeName) {
    errors.push(
      'CRITICAL VOLUME LEAK: Both users share volume'
    );
  }

  if (userASpec.volume?.volumeId && userBSpec.volume?.volumeId && userASpec.volume.volumeId === userBSpec.volume.volumeId) {
    errors.push(
      'CRITICAL VOLUME LEAK: Both users share volumeId'
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
