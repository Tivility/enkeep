/**
 * Docker Exec Transport for Zero-Network Container Runtime
 *
 * Dispatches health and followup calls into running Docker containers
 * via safe `docker exec` process execution, operating under `--network none`
 * without exposing or opening any host/container TCP ports.
 *
 * @module @enkeep/runtime-runner/transport/exec-transport
 */

import {
  type RuntimeTransport,
  type RuntimeHealthStatus,
  type AgentFollowupRequest,
  type AgentFollowupResponse,
  type ToolsUnavailableReasonCode,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  isAllowedToolsUnavailableReason,
  RUNTIME_SESSION_ID_PATTERN,
  RUNTIME_TURN_ID_PATTERN,
  DEFAULT_FOLLOWUP_TIMEOUT_MS,
} from './types.js';
import { validateAgentProfileSnapshot } from '../runtime/agent-profile.js';
import {
  type SafeDockerClient,
  type OwnershipExpectation,
  HEALTH_EXEC_MAX_INPUT_BYTES,
  HEALTH_EXEC_MAX_OUTPUT_BYTES,
  DEFAULT_EXEC_MAX_INPUT_BYTES,
} from '../docker/client.js';

export class DockerExecTransport implements RuntimeTransport {
  readonly mode = 'exec';
  readonly endpoint = 'docker-exec://local-runtime';

  constructor(
    private readonly dockerClient: SafeDockerClient,
    private readonly expectation: OwnershipExpectation,
    private readonly cliScriptPath: string = '/app/runtime-runner/dist/runtime/exec-cli.js'
  ) {}

  /**
   * Checks runtime health via in-container Exec CLI execution.
   * STRICT FAIL-CLOSED: Rejects missing or invalid readiness fields without fabricating defaults.
   * All thrown errors use strictly fixed codes without leaking container IDs or raw execution details.
   */
  async checkHealth(): Promise<RuntimeHealthStatus> {
    const envelope = await this.dockerClient.execOwned(
      this.expectation,
      { action: 'health' },
      {
        cliPath: this.cliScriptPath,
        maxInputBytes: HEALTH_EXEC_MAX_INPUT_BYTES,
        maxBodyBytes: HEALTH_EXEC_MAX_OUTPUT_BYTES,
      }
    );

    if (envelope.status === 'error') {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.HEALTH_CHECK_FAILED);
    }

    if (envelope.status !== 'ok') {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }

    // Mandatory userId validation against ownership expectation
    if (typeof envelope.userId !== 'string' || !envelope.userId.trim()) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }
    if (envelope.userId !== this.expectation.userId) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }

    // Mandatory uptimeSeconds validation
    if (
      typeof envelope.uptimeSeconds !== 'number' ||
      !Number.isFinite(envelope.uptimeSeconds) ||
      envelope.uptimeSeconds < 0
    ) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }

    // Mandatory version validation
    if (typeof envelope.version !== 'string' || !envelope.version.trim()) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }

    // Mandatory dshReady validation (fail closed, no fabricated readiness)
    if (typeof envelope.dshReady !== 'boolean') {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }

    // Mandatory plugins validation (must come from authentic envelope)
    if (!envelope.plugins || typeof envelope.plugins !== 'object') {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }

    const plugins = envelope.plugins;
    if (
      typeof plugins.receiptStore !== 'boolean' ||
      typeof plugins.inbound !== 'boolean' ||
      typeof plugins.eventRelay !== 'boolean' ||
      typeof plugins.externalInteraction !== 'boolean' ||
      typeof plugins.affinityPolicy !== 'boolean' ||
      typeof plugins.llmAffinity !== 'boolean' ||
      typeof plugins.tools !== 'boolean'
    ) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }

    // Mandatory toolsCount validation
    if (
      typeof envelope.toolsCount !== 'number' ||
      !Number.isSafeInteger(envelope.toolsCount) ||
      envelope.toolsCount < 0
    ) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }

    // Mandatory enkeepBundleLoaded validation
    if (typeof envelope.enkeepBundleLoaded !== 'boolean') {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }

    // Mandatory toolsOperational validation (must be explicit boolean; no fallback)
    if (typeof envelope.toolsOperational !== 'boolean') {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }

    // Strict toolsOperational invariant validation
    let reasonCode: ToolsUnavailableReasonCode | null = null;
    if (envelope.toolsOperational === false) {
      if (!isAllowedToolsUnavailableReason(envelope.toolsUnavailableReason)) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
      }
      reasonCode = envelope.toolsUnavailableReason;
    } else {
      if (envelope.toolsUnavailableReason !== null && envelope.toolsUnavailableReason !== undefined) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
      }
      if (plugins.tools !== true || envelope.toolsCount < 4) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
      }
      reasonCode = null;
    }

    // Core bundle readiness requires the 6 core operational plugins
    const corePluginsReady =
      plugins.receiptStore === true &&
      plugins.inbound === true &&
      plugins.eventRelay === true &&
      plugins.externalInteraction === true &&
      plugins.affinityPolicy === true &&
      plugins.llmAffinity === true;

    let computedStatus: RuntimeHealthStatus['status'];
    if (!envelope.dshReady) {
      computedStatus = 'error';
    } else if (!envelope.enkeepBundleLoaded || !corePluginsReady) {
      computedStatus = 'degraded';
    } else {
      computedStatus = 'ok';
    }

    if (
      typeof envelope.modelProvider !== 'string' ||
      envelope.modelProvider.length === 0 ||
      envelope.modelProvider !== envelope.modelProvider.trim()
    ) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }

    return {
      status: computedStatus,
      uptimeSeconds: envelope.uptimeSeconds,
      userId: envelope.userId,
      dshReady: envelope.dshReady,
      enkeepBundleLoaded: envelope.enkeepBundleLoaded,
      modelProvider: envelope.modelProvider,
      plugins,
      toolsCount: envelope.toolsCount,
      toolsOperational: envelope.toolsOperational,
      toolsUnavailableReason: reasonCode,
      version: envelope.version,
    };
  }

  /**
   * Dispatches a user followup request via in-container Exec CLI execution.
   * STRICT FAIL-CLOSED: Validates all envelope fields with exact expectations and zero fabricated values.
   * All thrown errors use strictly fixed codes without leaking container IDs or raw execution details.
   */
  async sendFollowup(request: AgentFollowupRequest): Promise<AgentFollowupResponse> {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }

    // Validate exact allowed keys on request: no unknown keys allowed
    const requestKeys = Object.keys(request);
    const allowedKeys = new Set(['prompt', 'sessionId', 'turnId', 'profile', 'timeoutMs', 'workspaceFolder', 'spaceId', 'attachments', 'modelSelection']);
    for (const key of requestKeys) {
      if (!allowedKeys.has(key)) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
      }
    }
    if (
      !('prompt' in request) ||
      !('sessionId' in request) ||
      !('turnId' in request) ||
      !('profile' in request)
    ) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }

    if (
      'modelSelection' in request &&
      request.modelSelection !== undefined &&
      request.modelSelection !== null
    ) {
      const ms = request.modelSelection;
      if (typeof ms !== 'object' || Array.isArray(ms)) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
      }
      if (typeof ms.provider !== 'string' || ms.provider.trim().length === 0) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
      }
      if (typeof ms.model !== 'string' || ms.model.trim().length === 0) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
      }
      if (ms.fallbackChain !== undefined && ms.fallbackChain !== null) {
        if (!Array.isArray(ms.fallbackChain)) {
          throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
        }
        for (const item of ms.fallbackChain) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
          }
          if (typeof item.provider !== 'string' || item.provider.trim().length === 0) {
            throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
          }
          if (typeof item.model !== 'string' || item.model.trim().length === 0) {
            throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
          }
        }
      }
    }

    if (
      'workspaceFolder' in request &&
      request.workspaceFolder !== undefined &&
      (typeof request.workspaceFolder !== 'string' || request.workspaceFolder.trim().length === 0)
    ) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }

    if (
      'spaceId' in request &&
      request.spaceId !== undefined &&
      (typeof request.spaceId !== 'string' || request.spaceId.trim().length === 0)
    ) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }

    if (
      'timeoutMs' in request &&
      request.timeoutMs !== undefined &&
      (typeof request.timeoutMs !== 'number' || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0)
    ) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }

    // Validate prompt: non-empty string, exact preserved representation, max 64KiB (65,536 UTF-8 bytes)
    if (
      typeof request.prompt !== 'string' ||
      request.prompt.length === 0 ||
      request.prompt.trim().length === 0 ||
      Buffer.byteLength(request.prompt, 'utf8') > 65536
    ) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }

    // Validate sessionId: exact /^(ses_[0-9a-f]{32}|import-[0-9a-f]{32})$/
    if (
      typeof request.sessionId !== 'string' ||
      !RUNTIME_SESSION_ID_PATTERN.test(request.sessionId)
    ) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }

    // Validate turnId: exact /^turn_[0-9a-f]{32}$/
    if (
      typeof request.turnId !== 'string' ||
      !RUNTIME_TURN_ID_PATTERN.test(request.turnId)
    ) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }

    // Validate profile using strict existing validator or explicit null for unbound generation
    if (request.profile !== null) {
      if (!request.profile || typeof request.profile !== 'object' || Array.isArray(request.profile)) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
      }
      try {
        validateAgentProfileSnapshot(request.profile);
      } catch {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
      }
    }

    const effectiveTimeoutMs = request.timeoutMs ?? DEFAULT_FOLLOWUP_TIMEOUT_MS;
    const effectiveWorkspaceFolder = request.workspaceFolder ?? request.spaceId;

    const envelope = await this.dockerClient.execOwned(
      this.expectation,
      {
        action: 'followup',
        prompt: request.prompt,
        sessionId: request.sessionId,
        turnId: request.turnId,
        profile: request.profile,
        ...(effectiveWorkspaceFolder ? { workspaceFolder: effectiveWorkspaceFolder } : {}),
        ...(request.attachments ? { attachments: request.attachments } : {}),
        ...(request.modelSelection ? { modelSelection: request.modelSelection } : {}),
      },
      {
        cliPath: this.cliScriptPath,
        timeoutMs: effectiveTimeoutMs,
        maxInputBytes: DEFAULT_EXEC_MAX_INPUT_BYTES,
      }
    );

    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_RESPONSE_ENVELOPE);
    }

    if (envelope.status === 'error') {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.FOLLOWUP_FAILED);
    }

    if (envelope.status !== 'completed' && envelope.status !== 'cancelled') {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_RESPONSE_ENVELOPE);
    }

    // Strict sessionId validation (exact string matching requested sessionId)
    if (
      typeof envelope.sessionId !== 'string' ||
      !RUNTIME_SESSION_ID_PATTERN.test(envelope.sessionId)
    ) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }
    if (envelope.sessionId !== request.sessionId) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.SESSION_ID_MISMATCH);
    }

    // Strict turnId validation (exact string matching requested turnId)
    if (
      typeof envelope.turnId !== 'string' ||
      !RUNTIME_TURN_ID_PATTERN.test(envelope.turnId)
    ) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }
    if (envelope.turnId !== request.turnId) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.TURN_ID_MISMATCH);
    }

    // Strict eventsCount validation (authoritative non-negative safe integer)
    if (
      typeof envelope.eventsCount !== 'number' ||
      !Number.isSafeInteger(envelope.eventsCount) ||
      envelope.eventsCount < 0
    ) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }

    if (envelope.status === 'completed') {
      // Completed status requires non-empty replyText string (preserves exact byte representation)
      if (typeof envelope.replyText !== 'string' || !envelope.replyText.trim()) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.EMPTY_REPLY_TEXT);
      }
      // Completed status requires persisted === true (exact literal true)
      if (envelope.persisted !== true) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PERSISTENCE_REQUIRED);
      }

      return {
        sessionId: envelope.sessionId,
        turnId: envelope.turnId,
        status: 'completed',
        replyText: envelope.replyText,
        eventsCount: envelope.eventsCount,
        persisted: true,
      };
    }

    // Cancelled status validation
    if (envelope.replyText !== undefined) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }
    if (typeof envelope.persisted !== 'boolean') {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
    }

    return {
      sessionId: envelope.sessionId,
      turnId: envelope.turnId,
      status: 'cancelled',
      replyText: undefined,
      eventsCount: envelope.eventsCount,
      persisted: envelope.persisted,
    };
  }

  /**
   * Closes transport.
   */
  async close(): Promise<void> {
    // Zero persistent connections to close
  }
}
