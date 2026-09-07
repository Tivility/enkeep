/**
 * Types for DSH Inbound Plugin.
 *
 * @module @enkeep/dsh-inbound
 */

import type { UserMessage, ContentBlock } from '@deepseek-ai/dsh-llm';
import type { AgentCancelCause, CancelOptions } from '@deepseek-ai/dsh-agent';

export type InboundTarget = 'followup' | 'steer' | 'inject';

export interface InboundSourceMetadata {
  readonly routeId?: string;
  readonly sourceType?: string;
  readonly sourceId?: string;
  readonly metadata?: Record<string, unknown> | null;
}

export interface InboundFollowupRequest {
  /**
   * Monotonic or UUID delivery identifier for deduplication and idempotency.
   */
  readonly deliveryId: string;

  /**
   * Target DSH Session ID.
   */
  readonly sessionId: string;

  /**
   * Message content: string, content blocks array, or pre-constructed UserMessage.
   */
  readonly message: string | ContentBlock[] | UserMessage;

  /**
   * Optional platform route / channel / peer source attribution.
   */
  readonly source?: InboundSourceMetadata;

  /**
   * Dispatch target boundary on Agent. Defaults to 'followup'.
   */
  readonly target?: InboundTarget;
}

export interface InboundFollowupResult {
  readonly success: true;
  readonly deliveryId: string;
  readonly messageId: string;
  readonly status: 'delivered';
  readonly duplicate: boolean;
}

export interface InboundCancelRequest {
  /**
   * Target DSH Session ID.
   */
  readonly sessionId: string;

  /**
   * Optional delivery identifier for deduplication.
   */
  readonly deliveryId?: string;

  /**
   * Optional cancellation cause (defaults to { kind: 'user' }).
   */
  readonly cause?: AgentCancelCause;

  /**
   * Optional cancellation options (e.g. keepInbox).
   */
  readonly options?: CancelOptions;
}

export interface InboundCancelResult {
  readonly success: true;
  readonly sessionId: string;
  readonly status: 'cancelled';
  readonly duplicate?: boolean;
}

export interface InboundConfig {
  /**
   * Optional default target dispatch mode ('followup' | 'steer' | 'inject'). Defaults to 'followup'.
   */
  readonly defaultTarget?: InboundTarget;

  /**
   * Optional custom wire message parser.
   */
  readonly wireParser?: InboundWireParser;
}

/**
 * Minimal interface for wire payload parsers.
 *
 * Integration Note:
 * When `@enkeep/protocol` wire formats (e.g. JSON-RPC or REST wire envelopes) are available,
 * implement this interface and inject or pass it in Config. Do not duplicate protocol implementations here.
 */
export interface InboundWireParser {
  parseFollowup(raw: unknown): InboundFollowupRequest;
  parseCancel(raw: unknown): InboundCancelRequest;
}

export interface IInboundService {
  handleFollowup(request: InboundFollowupRequest): Promise<InboundFollowupResult>;
  handleCancel(request: InboundCancelRequest): Promise<InboundCancelResult>;
  parseAndFollowup(rawWirePayload: unknown): Promise<InboundFollowupResult>;
  parseAndCancel(rawWirePayload: unknown): Promise<InboundCancelResult>;
}
