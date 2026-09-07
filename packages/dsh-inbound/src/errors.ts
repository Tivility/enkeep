/**
 * Error classes for DSH Inbound Plugin.
 *
 * @module @enkeep/dsh-inbound
 */

export class InboundError extends Error {
  readonly code: string;

  constructor(message: string, code = 'INBOUND_ERROR', cause?: unknown) {
    super(message, { cause });
    this.name = 'InboundError';
    this.code = code;
  }
}

export class AgentNotFoundError extends InboundError {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Agent for session '${sessionId}' not found in registry`, 'AGENT_NOT_FOUND');
    this.name = 'AgentNotFoundError';
    this.sessionId = sessionId;
  }
}

export class InboundValidationError extends InboundError {
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message, 'INBOUND_VALIDATION_ERROR');
    this.name = 'InboundValidationError';
    this.field = field;
  }
}

export class WireParserError extends InboundError {
  constructor(message: string, cause?: unknown) {
    super(`Failed parsing wire message: ${message}`, 'WIRE_PARSER_ERROR', cause);
    this.name = 'WireParserError';
  }
}

export class PreviousDeliveryFailedError extends InboundError {
  readonly deliveryId: string;

  constructor(deliveryId: string, originalError?: string | null) {
    super(
      `Delivery '${deliveryId}' previously failed: ${originalError ?? 'unknown error'}`,
      'PREVIOUS_DELIVERY_FAILED'
    );
    this.name = 'PreviousDeliveryFailedError';
    this.deliveryId = deliveryId;
  }
}
