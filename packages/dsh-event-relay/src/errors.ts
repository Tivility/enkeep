/**
 * Error classes for DSH Event Relay.
 *
 * @module @enkeep/dsh-event-relay
 */

export class EventRelayError extends Error {
  readonly code: string;

  constructor(message: string, code = 'EVENT_RELAY_ERROR', cause?: unknown) {
    super(message, { cause });
    this.name = 'EventRelayError';
    this.code = code;
  }
}

export class RelayBackpressureError extends EventRelayError {
  readonly sessionId: string;
  readonly capacity: number;
  readonly unacknowledgedCount: number;

  constructor(sessionId: string, capacity: number, unacknowledgedCount: number) {
    super(
      `Event relay buffer backpressure for session '${sessionId}': capacity (${capacity}) reached with ${unacknowledgedCount} unacknowledged events. Consumer must ack to proceed.`,
      'RELAY_BACKPRESSURE'
    );
    this.name = 'RelayBackpressureError';
    this.sessionId = sessionId;
    this.capacity = capacity;
    this.unacknowledgedCount = unacknowledgedCount;
  }
}

/** Alias for backward compatibility */
export const BufferOverflowError = RelayBackpressureError;

export class EventRelayValidationError extends EventRelayError {
  constructor(message: string) {
    super(message, 'EVENT_RELAY_VALIDATION_ERROR');
    this.name = 'EventRelayValidationError';
  }
}
