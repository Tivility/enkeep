/**
 * Port Allocation and Safety Verification Module
 *
 * Ensures all allocated ports bind exclusively to 127.0.0.1 and strictly
 * exclude protected services (HappyClaw on 3000, DSH GUI on 3080) and caller exclusions.
 */

import * as net from 'node:net';
import {
  DEFAULT_EXCLUDED_PORTS,
  DEFAULT_PORT_RANGE,
  ALLOWED_HOSTS,
  FORBIDDEN_HOSTS,
} from './constants.js';
import { SafetyViolationError } from './errors.js';

export interface FindPortOptions {
  /** Starting port to search from (default: 3100) */
  startPort?: number;
  /** Ending port to search until (default: 65535) */
  endPort?: number;
  /** Additional custom ports to exclude */
  excludePorts?: Iterable<number>;
  /** Host interface to test (default: '127.0.0.1', strictly loopback) */
  host?: string;
  /** Maximum number of sequential attempts (default: 500) */
  maxAttempts?: number;
}

/**
 * Validates that the specified host is strictly the exact loopback address 127.0.0.1.
 * Rejects 0.0.0.0, localhost, ::1, wildcard, or external network interfaces.
 */
export function validateHost(host: string): void {
  const normalizedHost = host.trim().toLowerCase();

  for (const forbidden of FORBIDDEN_HOSTS) {
    if (normalizedHost === forbidden.toLowerCase()) {
      throw new SafetyViolationError(
        'UNSAFE_HOST_BINDING',
        `Forbidden host binding: "${host}". Only exact loopback address (127.0.0.1) is permitted.`,
        { host }
      );
    }
  }

  if (!ALLOWED_HOSTS.some(allowed => allowed.toLowerCase() === normalizedHost)) {
    throw new SafetyViolationError(
      'UNSAFE_HOST_BINDING',
      `Unsafe host binding: "${host}". Must be strictly exact 127.0.0.1.`,
      { host }
    );
  }
}

/**
 * Checks if a port is in the excluded list (default protected ports or custom).
 */
export function isPortExcluded(port: number, customExcludedPorts?: Iterable<number>): boolean {
  if (DEFAULT_EXCLUDED_PORTS.includes(port)) {
    return true;
  }
  if (customExcludedPorts) {
    for (const excluded of customExcludedPorts) {
      if (excluded === port) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Validates that a given port is valid, safe, and not in the excluded list.
 */
export function validatePort(port: number, customExcludedPorts?: Iterable<number>): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SafetyViolationError(
      'UNSAFE_PORT_ALLOCATION',
      `Invalid port number: ${port}. Must be an integer between 1 and 65535.`,
      { port }
    );
  }

  if (isPortExcluded(port, customExcludedPorts)) {
    throw new SafetyViolationError(
      'UNSAFE_PORT_ALLOCATION',
      `Port ${port} is reserved/protected (e.g. 3000 HappyClaw / 3080 DSH GUI or caller-excluded) and cannot be allocated.`,
      { port }
    );
  }
}

/**
 * Tests if a specific port is currently available on the given loopback host.
 */
export async function isPortAvailable(port: number, host: string = '127.0.0.1'): Promise<boolean> {
  validateHost(host);

  return new Promise((resolve) => {
    const server = net.createServer();

    // Disable unhandled exception on listen error
    server.once('error', () => {
      resolve(false);
    });

    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

/**
 * Finds a free, non-reserved port on 127.0.0.1.
 */
export async function findAvailablePort(options: FindPortOptions = {}): Promise<number> {
  const host = options.host ?? '127.0.0.1';
  validateHost(host);

  const startPort = options.startPort ?? DEFAULT_PORT_RANGE.start;
  const endPort = options.endPort ?? DEFAULT_PORT_RANGE.end;
  const maxAttempts = options.maxAttempts ?? 500;

  if (startPort < 1 || endPort > 65535 || startPort > endPort) {
    throw new SafetyViolationError(
      'UNSAFE_PORT_ALLOCATION',
      `Invalid port range: ${startPort} - ${endPort}`,
      { startPort, endPort }
    );
  }

  let attempts = 0;
  for (let port = startPort; port <= endPort && attempts < maxAttempts; port++, attempts++) {
    if (isPortExcluded(port, options.excludePorts)) {
      continue;
    }

    const available = await isPortAvailable(port, host);
    if (available) {
      return port;
    }
  }

  throw new SafetyViolationError(
    'PORT_RANGE_EXHAUSTED',
    `Could not find an available free port in range [${startPort}, ${endPort}] on ${host} after ${attempts} attempts.`,
    { startPort, endPort, host, attempts }
  );
}

/**
 * Allocates multiple distinct free ports for named services.
 * Ensures each allocated port is unique and safe.
 */
export async function allocatePorts<T extends string>(
  names: readonly T[],
  options: FindPortOptions = {}
): Promise<Record<T, number>> {
  const allocated = {} as Record<T, number>;
  const collectedPorts = new Set<number>(
    options.excludePorts ? Array.from(options.excludePorts) : []
  );

  let currentStart = options.startPort ?? DEFAULT_PORT_RANGE.start;

  for (const name of names) {
    const port = await findAvailablePort({
      ...options,
      startPort: currentStart,
      excludePorts: collectedPorts,
    });
    allocated[name] = port;
    collectedPorts.add(port);
    currentStart = port + 1;
  }

  return allocated;
}
