/**
 * Wire parser minimal interface and fallback implementation for Inbound plugin.
 *
 * Integration Note:
 * This minimal parser accepts standard plain JS objects / JSON envelopes.
 * When specialized binary or schema protocols from `@enkeep/protocol` are used,
 * pass a custom `InboundWireParser` to `Config.wireParser`.
 *
 * @module @enkeep/dsh-inbound
 */

import type { InboundCancelRequest, InboundFollowupRequest, InboundWireParser } from './types.js';
import { InboundValidationError, WireParserError } from './errors.js';

export class DefaultInboundWireParser implements InboundWireParser {
  parseFollowup(raw: unknown): InboundFollowupRequest {
    if (!raw || typeof raw !== 'object') {
      throw new WireParserError('Wire payload must be a non-null object');
    }

    const obj = raw as Record<string, unknown>;

    // Support envelope unwrap if wrapped in { success: true, data: { ... } } or { data: { ... } }
    const targetObj = (obj['data'] && typeof obj['data'] === 'object') ? (obj['data'] as Record<string, unknown>) : obj;

    const deliveryId = targetObj['deliveryId'];
    if (typeof deliveryId !== 'string' || deliveryId.trim().length === 0) {
      throw new InboundValidationError('deliveryId is required and must be a non-empty string', 'deliveryId');
    }

    const sessionId = targetObj['sessionId'];
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new InboundValidationError('sessionId is required and must be a non-empty string', 'sessionId');
    }

    const message = targetObj['message'] ?? targetObj['content'];
    if (message === undefined || message === null) {
      throw new InboundValidationError('message/content is required', 'message');
    }

    const target = targetObj['target'] as InboundFollowupRequest['target'] | undefined;
    if (target !== undefined && target !== 'followup' && target !== 'steer' && target !== 'inject') {
      throw new InboundValidationError(`Invalid target '${String(target)}'. Must be 'followup', 'steer', or 'inject'.`, 'target');
    }

    const source = targetObj['source'] as InboundFollowupRequest['source'] | undefined;

    return {
      deliveryId: deliveryId.trim(),
      sessionId: sessionId.trim(),
      message: message as InboundFollowupRequest['message'],
      source,
      target,
    };
  }

  parseCancel(raw: unknown): InboundCancelRequest {
    if (!raw || typeof raw !== 'object') {
      throw new WireParserError('Wire payload must be a non-null object');
    }

    const obj = raw as Record<string, unknown>;
    const targetObj = (obj['data'] && typeof obj['data'] === 'object') ? (obj['data'] as Record<string, unknown>) : obj;

    const sessionId = targetObj['sessionId'];
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new InboundValidationError('sessionId is required and must be a non-empty string', 'sessionId');
    }

    const deliveryId = typeof targetObj['deliveryId'] === 'string' ? targetObj['deliveryId'].trim() : undefined;
    const cause = targetObj['cause'] as InboundCancelRequest['cause'] | undefined;
    const options = targetObj['options'] as InboundCancelRequest['options'] | undefined;

    return {
      sessionId: sessionId.trim(),
      deliveryId,
      cause,
      options,
    };
  }
}
