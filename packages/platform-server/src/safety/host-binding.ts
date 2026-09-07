import { PlatformError } from '@enkeep/platform-core';

/**
 * Standard forbidden host strings that must NEVER be bound to.
 */
export const FORBIDDEN_HOSTS: readonly string[] = Object.freeze([
  '0.0.0.0',
  '::',
  '::0',
  '0:0:0:0:0:0:0:0',
  '::ffff:0.0.0.0',
  '*',
]);

/**
 * Reserved protected ports that must NEVER be bound or allocated (HappyClaw & DSH Web GUI).
 */
export const RESERVED_PROTECTED_PORTS: readonly number[] = Object.freeze([
  3000, // HappyClaw common service port
  3080, // DSH Web GUI port
]);

/**
 * Permitted host bindings (strictly loopback).
 */
export const ALLOWED_HOSTS: readonly string[] = Object.freeze([
  '127.0.0.1',
]);

export class UnsafeHostBindingError extends PlatformError {
  constructor(host: string) {
    super(
      `Unsafe host binding "${host}". Only strictly verified loopback host (127.0.0.1) is permitted.`,
      'UNSAFE_HOST_BINDING',
      500
    );
  }
}

export class UnsafePortAllocationError extends PlatformError {
  constructor(port: number, reason?: string) {
    super(
      reason ?? `Port ${port} is reserved for external critical services (3000=HappyClaw, 3080=DSH Web GUI) and cannot be bound.`,
      'UNSAFE_PORT_ALLOCATION',
      500
    );
  }
}

/**
 * Validates that the target binding host is strictly 127.0.0.1.
 * Throws UnsafeHostBindingError if invalid.
 */
export function validateHostBinding(host: string): void {
  if (!host || typeof host !== 'string') {
    throw new UnsafeHostBindingError(String(host));
  }

  const normalized = host.trim().toLowerCase();

  // Explicit check for forbidden wildcard patterns
  if (FORBIDDEN_HOSTS.includes(normalized) || normalized.includes('0.0.0.0')) {
    throw new UnsafeHostBindingError(host);
  }

  // Must strictly be 127.0.0.1
  if (normalized !== '127.0.0.1') {
    throw new UnsafeHostBindingError(host);
  }
}

/**
 * Validates that the port is safe (0 for ephemeral dynamic port, or valid non-reserved port).
 * Throws UnsafePortAllocationError if invalid.
 */
export function validatePortBinding(port: number): void {
  if (typeof port !== 'number' || !Number.isInteger(port)) {
    throw new UnsafePortAllocationError(port, `Invalid port number "${port}". Must be an integer.`);
  }

  if (port < 0 || port > 65535) {
    throw new UnsafePortAllocationError(port, `Port ${port} is out of valid range (0-65535).`);
  }

  if (RESERVED_PROTECTED_PORTS.includes(port)) {
    throw new UnsafePortAllocationError(port);
  }
}

/**
 * Combined validation for host and port.
 */
export function validateServerBinding(host: string, port: number): void {
  validateHostBinding(host);
  validatePortBinding(port);
}
