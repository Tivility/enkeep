/**
 * Web E2E Testing Package for Enkeep
 *
 * Provides:
 * - Layer A: In-process Contract E2E with TestOnly fake RuntimeGateway, real PlatformServer, real Web UI, SQLite, and 3000/3080 port guard
 * - Layer B: Real Docker E2E gated by RUN_DOCKER_TESTS=1
 *
 * @module @enkeep/web-e2e
 */

export * from './contract/test-only-runtime-gateway.js';
export * from './contract/test-platform-server.js';
export * from './contract/browser-helper.js';
export * from './probes/ports-guard.js';
export * from './docker/docker-e2e-runner.js';
