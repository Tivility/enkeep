/**
 * Safety Guardrail Constants for Enkeep
 *
 * Phase 0 Safety Boundary Specifications:
 * - HappyClaw: PID & port are dynamic (commonly 127.0.0.1:3000) - NEVER kill/restart/touch
 * - DSH GUI: 127.0.0.1:3080 - NEVER kill/restart/touch
 * - Host binding MUST always be strictly exact 127.0.0.1 (rejects localhost, ::1, 0.0.0.0)
 * - Demo data MUST be strictly contained inside <repoRoot>/.demo-data
 * - Process and container ownership dynamically tracked by metadata (enkeep-demo owner)
 * - Safe repository fixtures (e.g. packages/import/fixtures/messages.db, docs/safety.md) are allowed
 * - Real production data (e.g. $HOME/happyclaw/data, $DSH_HOME) is strictly forbidden
 */

/** Default reserved / excluded ports that must never be allocated or bound */
export const DEFAULT_EXCLUDED_PORTS: readonly number[] = Object.freeze([
  3000, // HappyClaw common service port
  3080, // DSH Web GUI port
]);

/** Permitted host bindings (strictly exact 127.0.0.1 loopback only) */
export const ALLOWED_HOSTS: readonly string[] = Object.freeze([
  '127.0.0.1',
]);

/** Forbidden host bindings that expose services externally or across non-exact interfaces */
export const FORBIDDEN_HOSTS: readonly string[] = Object.freeze([
  '0.0.0.0',
  '::',
  '::0',
  '0:0:0:0:0:0:0:0',
  '::ffff:0.0.0.0',
  'localhost',
  '::1',
  '*',
]);

/** Repository-relative demo data folder name (must be gitignored) */
export const DEMO_DATA_DIR_NAME = '.demo-data';

/** Subdirectory within demo data for storing PID metadata */
export const DEMO_PID_META_SUBDIR = 'pids';

/** Required ownership tag for enkeep demo processes */
export const DEMO_OWNERSHIP_TAG = 'enkeep-demo';

/** Required container prefix for Docker resources */
export const DEMO_DOCKER_CONTAINER_PREFIX = 'enkeep-demo-';

/** Required Docker label key and value */
export const DEMO_DOCKER_LABEL_KEY = 'app';
export const DEMO_DOCKER_LABEL_VALUE = 'enkeep-demo';

/** Sensitive system path prefixes outside repository that must never be accessed */
export const SYSTEM_DANGER_ROOTS: readonly string[] = Object.freeze([
  '/etc',
  '/var',
  '/usr',
  '/System',
  '/private/etc',
  '/private/var',
  '/root',
]);

/** Default starting port range for demo services */
export const DEFAULT_PORT_RANGE = Object.freeze({
  start: 3100,
  end: 65535,
});
