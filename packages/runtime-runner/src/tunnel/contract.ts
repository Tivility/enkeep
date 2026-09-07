/**
 * Tunnel and StreamHandler Interface Contracts
 *
 * Defines the contract boundaries between the in-container stdio tunnel multiplexer
 * and platform host stream handlers (such as LlmProxyHandler).
 *
 * @module @enkeep/runtime-runner/tunnel/contract
 */

import type { Duplex } from 'node:stream';

/**
 * Metadata provided when opening or dispatching a multiplexed tunnel stream.
 */
export interface StreamMetadata {
  /** The kind of stream handler required, e.g. 'llm' */
  readonly kind: string;
  /** Optional stream identifier */
  readonly id?: string;
  /** Optional session identifier */
  readonly sessionId?: string;
  /** Optional user identifier */
  readonly userId?: string;
  /** Arbitrary extra metadata attributes */
  readonly [key: string]: unknown;
}

/**
 * Generic StreamHandler interface for multiplexed tunnel streams.
 */
export interface StreamHandler {
  /** The stream kind handled by this handler (e.g. 'llm') */
  readonly kind: string;

  /**
   * Handles an incoming duplex stream with its associated metadata.
   *
   * @param stream - The duplex stream carrying payload bytes.
   * @param metadata - The stream OPEN metadata.
   */
  handle(stream: Duplex, metadata: StreamMetadata): Promise<void> | void;
}

/**
 * Tunnel Host interface managing registration and dispatch of stream handlers.
 */
export interface TunnelHost {
  /**
   * Registers a stream handler for its declared kind.
   *
   * @param handler - The stream handler instance.
   * @returns Unsubscribe / disposer function.
   */
  registerHandler(handler: StreamHandler): () => void;

  /**
   * Dispatches an incoming stream to the registered handler for its kind.
   *
   * @param stream - The duplex stream.
   * @param metadata - The stream metadata with kind.
   */
  handleStream(stream: Duplex, metadata: StreamMetadata): Promise<void>;
}
