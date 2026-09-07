# Enkeep Demo Runner Subsystem (`@enkeep/demo-runner`)

This document defines the architecture, security model, lifecycle operations, test automation matrix, orchestration ports, and CLI specification for the **Enkeep Demo Runner** (`@enkeep/demo-runner`).

---

## 1. Overview & Architectural Principles

The Enkeep Demo Runner orchestrates the complete local demonstration environment for Enkeep and DeepSeek Harness (DSH). It automates environment initialization, database provisioning, offline fixture importing, server and user runtime container orchestration, automated test verification, and safe teardown.

```
+---------------------------------------------------------------------------------------------------+
|                                      Enkeep Demo Architecture                                     |
|                                                                                                   |
|   +--------------------------+                      +-----------------------------------------+   |
|   |   Platform Server HTTP   |                      |       User Runtime Docker Containers    |   |
|   |  (127.0.0.1:<dynPort>)   |                      |                                         |   |
|   |  • REST JSON Web API     |  Docker Exec (JSON)  |   Alice Runtime (Admin)                 |   |
|   |  • Session Cookie Auth   | -------------------> |   • Container: enkeep-demo-alice[-<sfx>]|   |
|   |    (Strict SameSite)     |   (--network none)   |   • Volume:    enkeep-demo-dsh-alice    |   |
|   |  • Host: 127.0.0.1:<port>|                      |                [-<sfx>]                 |   |
|   |  • Origin: http://...    |                      |   • User:      1000:1000 (non-root)     |   |
|   |  • Remote: 127.0.0.1     |                      |   • Volume-ID: enkeep.volume-id         |   |
|   |  • SQLite Storage (v1-v8)|                      |   • Transport: docker-exec://           |   |
|   |  • Event Polling & Relay |                      +-----------------------------------------+   |
|   +--------------------------+                      |   Bob Runtime (Regular User)            |   |
|                 |                                   |   • Container: enkeep-demo-bob[-<sfx>]  |   |
|                 |                                   |   • Volume:    enkeep-demo-dsh-bob      |   |
|   +--------------------------+                      |                [-<sfx>]                 |   |
|   |   Local Boundary & State |                      |   • User:      1000:1000 (non-root)     |   |
|   |   <repoRoot>/.demo-data/ |                      |   • Volume-ID: enkeep.volume-id         |   |
|   |   ├── secrets.json       |                      +-----------------------------------------+   |
|   |   ├── platform.db        |                                                                    |
|   |   ├── pids/*.json        |  [Signed Metadata]   • HMAC-SHA256 (metaSecret)                    |
|   |   ├── containers/*.json  |                      • Exact enkeep.run-id & enkeep.volume-id      |
|   |   ├── volumes/*.json     |                      • Real Full 64-char Docker CIDs               |
|   |   └── import/            |                      • Zero Network Egress/Ingress                 |
|   |  (Docker state in vols)  |                      • DSH: $DSH_HOME/sessions/<pKey>/<seg>/...    |
|   +--------------------------+                                                                    |
+---------------------------------------------------------------------------------------------------+
       |                                                                            |
  [Zero Disruption]                                                        [Strict Safety Guard]
  Protected: 127.0.0.1:3000 (HappyClaw)                                    • No 0.0.0.0 / External IM
  Protected: 127.0.0.1:3080 (DSH GUI)                                      • No docker system/volume prune
  Listener PID & TCP Probed Unchanged                                      • Never touch ~/happyclaw/data
                                                                           • Fail-closed if Docker unavailable
```

### Core Invariants & Safety Guarantees

1. **State Partitioning (`.demo-data` vs. Docker Volumes)**:
   The local host directory `<repoRoot>/.demo-data` strictly stores platform metadata, secrets (`secrets.json`), SQLite database (`platform.db`), and import artifacts. Container runtime state and session history are stored inside dedicated per-user Docker volumes (`enkeep-demo-dsh-*`), not on host paths. Production paths (`$HOME/happyclaw/data`, real `$DSH_HOME`, `~/.dsh`, `/etc`, `/var`) are never accessed or modified.
2. **Zero-Network Docker Execution (`--network none`)**:
   User containers run under strict `--network none` with zero published network ports. Inter-process turn dispatch and health checks execute via `DockerExecTransport` streaming structured JSON across `docker exec` (`docker-exec://enkeep-demo-<userId>`).
3. **Dynamic Loopback-Only Server Binding (`127.0.0.1:0`)**:
   The Platform HTTP Server binds exclusively to exact `127.0.0.1` on dynamically allocated ephemeral ports, validating `Host === 127.0.0.1:<socket.localPort>`, `Origin === http://127.0.0.1:<socket.localPort>`, and remote socket address exact `127.0.0.1`. Exposure on `0.0.0.0`, `::`, `localhost`, or external networks throws immediate safety violations.
4. **Protected Service Immunity (Ports 3000 & 3080)**:
   Existing services on port 3000 (HappyClaw) and port 3080 (DeepSeek Harness GUI) are permanently protected. The test runner probes listener PIDs (`lsof`/`ps`) and TCP socket connectivity (`net.connect`) before and after execution to assert zero interference.
5. **Independent Real User Runtimes (Alice & Bob)**:
   Alice (Admin) and Bob (Regular User) run in separate, dedicated Docker containers (`enkeep-demo-alice[-<suffix>]`, `enkeep-demo-bob[-<suffix>]`) with isolated volumes matching `^enkeep-demo-dsh-[a-zA-Z0-9][a-zA-Z0-9_-]{0,60}$` (e.g. `enkeep-demo-dsh-alice[-<suffix>]`, `enkeep-demo-dsh-bob[-<suffix>]`), immutable `enkeep.volume-id` labels independent of `enkeep.run-id`, and non-root execution (`1000:1000`).
6. **Signed Process, Container & Volume Ownership with Full CIDs**:
   All demo processes, containers, and volumes record cryptographically signed metadata (`HMAC-SHA256`) in `.demo-data/pids/`, `.demo-data/containers/`, and `.demo-data/volumes/` using `metaSecret` from `secrets.json` (`schemaVersion: 1`, mode `0o600`). Real 64-character full Docker container IDs returned by Docker are registered with exact `enkeep.run-id` and `enkeep.volume-id`. Teardown only touches verified resources. Volume ownership verification requires exact `volumeName`, `userId`, and `volumeId` (no `runId`).
7. **Strict Fail-Closed Architecture**:
   No synthetic runtime or fake mock daemon is used in production. If Docker daemon is unavailable, container spec is invalid, or runtime fails to start, the runner immediately terminates resources and throws explicit fail-closed errors.

---

## 2. Lifecycle Commands (`CLI & Library`)

The package provides both a programmatic API and a command-line interface:

| Command | Programmatic Function | Description |
|---|---|---|
| `pnpm demo:reset` | `resetDemo(options)` | Recreates `.demo-data`, executes SQLite migrations (v1–v8), provisions test accounts/spaces, and executes offline HappyClaw import from fixtures (exact invariants: 2 chats, 52 source, 50 talk, 2 dropped, 5 attachments). |
| `pnpm demo:up` | `upDemo(options)` | Performs preflight checks, starts Platform Server on `127.0.0.1:0` in the foreground, initializes Alice/Bob isolated Docker runtimes (`enkeep-demo-alice[-<suffix>]`), registers signed metadata, and outputs dynamic URLs. |
| `pnpm demo:down` | `downDemo(options)` | Verifies HMAC signatures (`metaSecret`) and ownership metadata, then safely terminates and cleans registered demo processes and containers (preserves user volumes). |
| `pnpm demo:down -- --remove-vols` | `downDemo({ removeVolumes: true })` | Safely terminates demo processes and containers AND removes verified user Docker volumes (`enkeep-demo-dsh-*`) matching `VolumeOwnershipExpectation` (`volumeName,userId,volumeId`). |
| `pnpm demo:test` | `runDemoTestSuite(options)` | Builds runtime image (`enkeep-demo-runtime:acceptance`) and executes full automated test suite with port 3000/3080 listener PID and TCP socket stability probes and teardown. |
| `pnpm demo:status` | `getStatus(repoRoot)` | Inspects registered metadata and returns active process, container, volume, and port status. |

---

## 3. Detailed Command Specifications

### 3.1 `demo:reset`
- **Actions**:
  1. Validates that target directory resolves inside `<repoRoot>/.demo-data`.
  2. Cleans and initializes `.demo-data/pids/`, `.demo-data/containers/`, `.demo-data/volumes/`, `.demo-data/spaces/`, `.demo-data/sessions/`, `.demo-data/import/`.
  3. Initializes SQLite database at `.demo-data/platform.db` and runs all schema migrations (v1–v8).
  4. Provisions default accounts:
     - `alice` (Admin, space `alice-container`)
     - `bob` (Regular User, space `bob-space`)
     - `charlie_disabled` (Disabled User, for security rejection testing)
  5. Executes fixed HappyClaw importer using safe fixtures (`packages/import-happyclaw/fixtures/source/db/messages.db`) into `.demo-data/import/` (asserts exact fixture counts: 2 chats, 52 source messages, 50 imported people-talk, 2 dropped empty messages, 5 attachments).
  6. Generates `.demo-data/secrets.json` (mode `0o600`, containing `metaSecret`, `cookieSecret`, and `csrfToken`).

### 3.2 `demo:up`
- **Actions**:
  1. Invokes `assertPreflight()` to guarantee safe binding and data boundaries.
  2. Launches `PlatformServer` on `127.0.0.1:<dynamicPort>` with `cookieSameSite: 'Strict'`.
  3. Starts isolated user runtimes using real Docker containers (`enkeep-demo-alice[-<suffix>]` / `enkeep-demo-bob[-<suffix>]`) with `DockerRuntimeContainerAdapter` under `--network none` and `docker-exec://` transport.
  4. Enforces fail-closed: If Docker is unavailable or image fails to boot, tears down partial resources and throws an explicit error.
  5. Writes signed process metadata to `.demo-data/pids/<service>.json`, container metadata with full 64-char CIDs and exact `enkeep.run-id` to `.demo-data/containers/<name>.json`, and volume metadata with `enkeep.volume-id` to `.demo-data/volumes/<name>.json`.
  6. Outputs dynamic URLs and service health status.

### 3.3 `demo:down`
- **Actions**:
  1. Scans `.demo-data/pids/*.json`, `.demo-data/containers/*.json`, and `.demo-data/volumes/*.json`.
  2. Verifies cryptographic HMAC signatures using `metaSecret` against `secrets.json`.
  3. Verifies container name prefix (`enkeep-demo-`), mandatory label `app=enkeep-demo`, `enkeep.user=<userId>`, and exact `enkeep.run-id`.
  4. Terminates verified demo processes via `SIGTERM` followed by graceful escalation (with PID reuse & command verification).
  5. Stops and removes verified Docker containers via safe Docker API with explicit `OwnershipExpectation`.
  6. If `--remove-vols` (`removeVolumes: true`) is specified, verifies volume ownership (`VolumeOwnershipExpectation` with matching `volumeName`, `userId`, `volumeId`) and removes user Docker volumes (`enkeep-demo-dsh-*`).
  7. Removes metadata files only upon verified successful removal or explicit not-found status.
  8. **Strictly avoids** any destructive system-wide commands (`docker prune`, `killall node`, etc.).

### 3.4 `demo:test`
- **Actions**:
  1. **Before Probe**: Probes listener PIDs (`lsof`/`ps`) and TCP socket responsiveness (`net.connect`) for protected ports `3000` (HappyClaw) and `3080` (DSH GUI).
  2. **Automated Verification Steps**:
     - `step_reset_provision`: Database & fixture provisioning across migrations v1–v8.
     - `step_auth_verification`: Alice admin login, Bob user login, Charlie disabled account rejection, invalid password rejection with CSRF and Strict cookies.
     - `step_import_history`: Imported chat manifest, message count (52 source, 50 talk, 2 dropped, 5 attachments), and space folder mapping verification.
     - `step_tenant_isolation`: Alice & Bob space, session route, and data isolation verification.
     - `step_session_lifecycle`: Session creation, routing, and multi-turn resume execution.
     - `step_sqlite_restart`: PlatformStorage crash simulation, verifying `recoverAfterRestart` resets in-flight `processing` deliveries to `held` and transitions open `running` / `queued` turn runs to `interrupted`. Separate web-messages gateway recovery (`recoverDanglingDeliveriesOnStartup`) resets stranded `processing` delivery rows and idempotency records to `held` and `running` turns to `queued` for startup redrive.
     - `step_migration_idempotency`: Repeated migration execution without errors or data duplication across v1–v8.
     - `step_dsh_docker_runtime`: Booting genuine DSH agent loop in real Docker container (`DockerRuntimeAdapter` over `DockerExecTransport`), asserting deterministic format `[DemoModel:<user>] ...`, multi-turn event incrementation, session persistence inside `$DSH_HOME/sessions/<project-key>/<encoded-session-id>/session.jsonl`, cross-exec `SIGUSR1` cancellation with `agent.cancel({ kind: 'user' })`, and authoritative `turn/end` event (`reason.kind === 'aborted'`).
     - `step_teardown`: Invoking `demo:down` to clean up all demo resources.
  3. **After Probe**: Probes ports `3000` and `3080` and asserts listener PIDs and TCP socket reachability are unchanged (`probesUnchanged: true`).

---

## 4. Security & Isolation Architecture

### 4.1 Cryptographic Ownership Metadata

To prevent accidental termination of external processes or foreign containers, every managed process, container, and volume writes a signed metadata file:

```json
{
  "service": "platform-server",
  "pid": 56128,
  "port": 56128,
  "url": "http://127.0.0.1:56128",
  "startedAt": "2026-08-25T09:40:30.000Z",
  "owner": "enkeep-demo",
  "runId": "run_a8f9c1d2e3...",
  "commandToken": "cmd_platform-server_a8f9c1d2e3...",
  "signature": "3f9a7b8c1d2e...",
  "command": "node dist/demo-runner.js up"
}
```

The `signature` is an `HMAC-SHA256` of metadata fields keyed by `metaSecret` in `.demo-data/secrets.json`. If a metadata file has been modified or lacks a valid signature, `demo:down` rejects termination.

### 4.2 Docker Container & Volume Isolation

Docker containers spawned for user runtimes adhere to strict spec validation (`@enkeep/runtime-runner/spec`):
- **Name Prefix**: Must match `enkeep-demo-<userId>[-<suffix>]` (e.g. `enkeep-demo-alice`, `enkeep-demo-bob`, or with random suffix).
- **Volume Isolation & Stable ID**: Dedicated per-user volume matching `^enkeep-demo-dsh-[a-zA-Z0-9][a-zA-Z0-9_-]{0,60}$` (e.g. `enkeep-demo-dsh-alice[-<suffix>]`) carrying an immutable `enkeep.volume-id` label independent of `enkeep.run-id`. Cross-user volume sharing is rejected.
- **Volume Ownership Expectation**: Verifies exact `volumeName`, `userId`, and `volumeId` (independent of `runId`).
- **Non-Root Execution**: Runs as user `1000:1000` (`dsh`), forbidding root execution.
- **Zero Open Ports**: Operates under `--network none` with `docker-exec://` transport.
- **Mandatory Labels**: `app=enkeep-demo`, `enkeep.user=<userId>`, `enkeep.run-id=<runId>`, and `enkeep.volume-id=<volumeId>`.
- **Forbidden Mounts**: `docker.sock`, `/var/run/docker.sock`, host home directory (`$HOME`), and external HappyClaw production directories are explicitly blocked.

---

## 5. Orchestration Ports & Adapters (`@enkeep/demo-runner/ports`)

```ts
export interface PlatformServerPort {
  start(options: { host: string; port: number; dbPath: string; repoRoot?: string }): Promise<{
    url: string;
    host: string;
    port: number;
    pid: number;
    meta: SignedProcessMetadata;
    close(): Promise<void>;
  }>;
  stop(serviceName: string, repoRoot?: string): Promise<void>;
}

export interface UserRuntimeHandle {
  userId: string;
  containerName: string;
  endpoint: string;
  containerId: string;
  volumeId: string;
  runId: string;
  volumeCreated: boolean;
  meta?: SignedContainerMetadata;
  rawHandle?: ActiveRuntimeHandle;
  checkHealth(): Promise<UserRuntimeHealthInfo>;
  importSeed?(sessionId: string, seed: readonly unknown[]): Promise<{ status: string; sessionId: string; persisted: boolean; eventsCount: number; receipt?: SessionSeedReceipt; duplicate?: boolean }>;
  sendTurn(prompt: string, sessionId?: string, turnId?: string, profile?: RuntimeAgentProfileSnapshot | null): Promise<{ replyText: string; persisted: boolean; eventsCount: number }>;
  cancelTurn?(turnId?: string): Promise<{ status: string; turnId?: string }>;
  stop(): Promise<void>;
  teardown(removeVolume?: boolean): Promise<void>;
}

export interface RuntimeContainerPort {
  startUserRuntime(options: {
    userId: 'alice' | 'bob' | string;
    image?: string;
    repoRoot?: string;
    dataRoot?: string;
    mode?: DemoRunnerMode;
    resourceSuffix?: string;
    timeoutMs?: number;
  }): Promise<UserRuntimeHandle>;
  connectUserRuntime?(options: {
    userId: 'alice' | 'bob' | string;
    image?: string;
    repoRoot?: string;
    dataRoot?: string;
    mode?: DemoRunnerMode;
    resourceSuffix?: string;
    timeoutMs?: number;
  }): Promise<UserRuntimeHandle>;
  listActiveRuntimes(options?: DemoPathOptions | string): Promise<SignedContainerMetadata[]>;
  stopUserRuntime(containerName: string, removeVolume?: boolean, options?: DemoPathOptions | string): Promise<void>;
}
```

---

## 6. Required Root Scripts for Integration

```json
{
  "scripts": {
    "demo:reset": "pnpm --filter @enkeep/demo-runner run demo:reset",
    "demo:up": "pnpm --filter @enkeep/demo-runner run demo:up",
    "demo:down": "pnpm --filter @enkeep/demo-runner run demo:down",
    "demo:test": "pnpm run docker:build-runtime && ENKEEP_RUNTIME_IMAGE=enkeep-demo-runtime:acceptance pnpm --filter @enkeep/demo-runner run demo:test",
    "demo:status": "pnpm --filter @enkeep/demo-runner run demo:status"
  }
}
```

---

## 7. Intentional Exclusions & Boundaries

- **Zero External Network**: User containers run with `--network none`, no external API keys, tokens, or network egress.
- **Fixture Only**: All test data originates strictly from fixed repository fixtures (`packages/import-happyclaw/fixtures/source/db/messages.db`), asserting 2 chats, 52 source messages, 50 imported messages, 2 dropped empty messages, 5 attachments.
- **No Real IM / MCP / Git Skills**: No live IM integrations (Feishu, WeChat), no external MCP servers, no host-level git automation, and no host execution.
- **Strict Host Isolation**: No mounting of `/var/run/docker.sock`, `$HOME`, or arbitrary host directories.

---

## 8. Related Documentation

- **Management Console Specifications**: [`docs/management-console.md`](management-console.md) — Product and technical design for the Enkeep management console, admin oversight, and REST API contract (P0 implemented with test suites; P1/P2 planned for advanced orchestration).
- **Safety Guardrails & Preflight**: [`docs/safety.md`](safety.md) — Host loopback binding, port protections (3000/3080), and cryptographic ownership model.
- **Runtime Architecture & Transport**: [`docs/runtime.md`](runtime.md) — DSH agent loop, typed Cordis bundle composition, and zero-network Docker execution.
