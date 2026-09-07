/**
 * Transport Feasibility Evidence & Platform Diagnostics
 *
 * Explains and documents:
 * 1. Why Docker Exec transport with `--network none` provides zero-port, zero-network isolation.
 * 2. Why container TCP port publishing requires 0.0.0.0 listening inside the container, violating zero-network invariants.
 * 3. Why VirtioFS/9p hypervisor file sharing cannot forward Unix Domain Sockets across macOS VM boundaries.
 *
 * @module @enkeep/runtime-runner/transport/evidence
 */

export interface TransportProbeResult {
  isMacOs: boolean;
  platform: NodeJS.Platform;
  zeroNetworkExecSupported: boolean;
  recommendedTransport: 'exec';
  rationale: string;
  technicalEvidence: readonly string[];
}

/**
 * Diagnostic analysis of network and IPC limitations across container boundaries.
 */
export const ZERO_NETWORK_EXEC_EVIDENCE = Object.freeze({
  zeroNetworkIsolation:
    'Running containers with --network none and communicating via safe docker exec transport eliminates all open ports, all UDS VM boundary failures, and all container-side network listening, achieving true zero-network isolation.',
  portPublishingRisk:
    'Published TCP ports (-p 127.0.0.1:<port>) require the in-container process to bind to 0.0.0.0 inside the container namespace to be reachable from host, violating the never-0.0.0.0 invariant.',
  macOsUdsLimitation:
    'VirtioFS and 9p file-sharing drivers do not serialize or forward BSD / Linux AF_UNIX IPC socket descriptors across the guest Linux kernel <-> host Darwin Mach/XNU kernel boundary.',
});

/**
 * Evaluates host environment and returns the recommended transport mechanism with evidence.
 */
export function probeTransportFeasibility(): TransportProbeResult {
  const isMac = process.platform === 'darwin';

  if (isMac) {
    return {
      isMacOs: true,
      platform: process.platform,
      zeroNetworkExecSupported: true,
      recommendedTransport: 'exec',
      rationale:
        'macOS hypervisor filesystem drivers (virtiofs/gRPC-FUSE) do not forward AF_UNIX sockets, and container TCP publishing requires 0.0.0.0 inside containers. Pure zero-network (--network none) with Docker Exec transport is enforced.',
      technicalEvidence: [
        ZERO_NETWORK_EXEC_EVIDENCE.zeroNetworkIsolation,
        ZERO_NETWORK_EXEC_EVIDENCE.macOsUdsLimitation,
        ZERO_NETWORK_EXEC_EVIDENCE.portPublishingRisk,
      ],
    };
  }

  return {
    isMacOs: false,
    platform: process.platform,
    zeroNetworkExecSupported: true,
    recommendedTransport: 'exec',
    rationale:
      'Zero-network (--network none) with Docker Exec transport is enforced for safe multi-tenant container isolation.',
    technicalEvidence: [
      ZERO_NETWORK_EXEC_EVIDENCE.zeroNetworkIsolation,
      ZERO_NETWORK_EXEC_EVIDENCE.portPublishingRisk,
    ],
  };
}
