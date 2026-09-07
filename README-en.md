# enkeep

[中文](./README.md) | English

Multi-user, multi-entrypoint enterprise platform built on [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

---

## 1. Product Scope & Architectural Overview

Enkeep provides an isolated, multi-tenant execution platform for DeepSeek Harness (DSH). It allows individual tenants (**Alice Admin** and **Bob User**) to execute agent workflows inside dedicated, non-root, zero-network Docker sandboxes while a central Platform Server coordinates session routing, authentication, and state management.

```
+---------------------------------------------------------------------------------------------------+
|                                     Enkeep Platform Architecture                                  |
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
|   |  • Cursor Event Polling  |                      |   • Transport: docker-exec://           |   |
|   |  • SQLite Storage (v1-v8)|                      +-----------------------------------------+   |
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

---

## 2. Documentation Directory

- **Safety Guardrails & Preflight**: [`docs/safety.md`](docs/safety.md) — Host loopback binding (`127.0.0.1:<socket.localPort>`), port protections (3000/3080), local data containment, and cryptographic ownership model (`volumeName,userId,volumeId`).
- **Demo Runner Subsystem & CLI**: [`docs/demo.md`](docs/demo.md) — Lifecycle orchestration (`demo:reset`, `demo:up`, `demo:down`, `demo:test`, `demo:status`), Docker container management (`enkeep-demo-alice[-<suffix>]`), `--remove-vols` teardown, and automated test execution.
- **Runtime Architecture & Transport**: [`docs/runtime.md`](docs/runtime.md) — DSH agent loop, typed Cordis bundle composition (`createEnkeepRuntimeBundle` + `applyEnkeepBundle`), zero-network Docker execution (`DockerExecTransport`), complete cancellation, and nested persistence paths (`$DSH_HOME/sessions/<project-key>/<encoded-session-id>/session.jsonl`).
- **Management Console Architecture & Specifications**: [`docs/management-console.md`](docs/management-console.md) — Product and technical design for the multi-tenant management console (P0 implemented: admin dashboard, users/spaces/runtime/plugins/tasks/deliveries/quotas/audit/imports/security endpoints, and tenant self-service hub; P1/P2 planned: agent prompt profiles studio, file manager, tool approval cards, and scheduler).

---

## 3. Quick Start

### 3.1 Prerequisites

- **Node.js**: `^22.19.0 || >=24.0.0`
- **pnpm**: `^10.0.0 || ^11.7.0`
- **Docker Engine / Docker Desktop**: Running locally (required for containerized user runtimes and Docker acceptance tests)

### 3.2 Step-by-Step Commands

1. **Install Monorepo Dependencies**:
   ```bash
   pnpm install
   ```

2. **Verify Codebase & Safety Guardrails**:
   ```bash
   pnpm run verify
   ```
   *Runs preflight safety assertions, monorepo typechecking, build, root safety tests, and package test suites.*

3. **Initialize Demo Environment & Safe Fixtures**:
   ```bash
   pnpm run demo:reset
   ```
   *Creates `<repoRoot>/.demo-data/`, applies SQLite migrations (v1–v8), provisions default test accounts (`alice`, `bob`, `charlie_disabled`), generates secure random cryptographic keys in `.demo-data/secrets.json` (`0o600`), and executes transactional fixture import from `packages/import-happyclaw/fixtures/source/db/messages.db` (exact invariants: 2 chats, 52 source messages, 50 imported people-talk, 2 dropped empty messages, 5 attachments).*

4. **Start Demo Platform & Container Runtimes (Foreground)**:
   ```bash
   pnpm run demo:up
   ```
   *Launches the Platform HTTP Server on dynamic `127.0.0.1:0` and initializes isolated Docker containers for Alice (`enkeep-demo-alice[-<suffix>]`) and Bob (`enkeep-demo-bob[-<suffix>]`). Runs in the foreground, outputting active endpoints and dynamic URLs.*

5. **Inspect Demo Runtime Status**:
   ```bash
   pnpm run demo:status
   # Or machine-readable JSON:
   pnpm run demo:status -- --json
   ```

6. **Run Automated Demo Test Suite**:
   ```bash
   pnpm run demo:test
   ```
   *Builds the runtime image (`docker:build-runtime`) and executes the complete verification suite with before/after listener PID and TCP reachability probes on protected ports 3000 and 3080.*

7. **Safely Stop Demo Services**:
   ```bash
   # Preserves user persistent Docker volumes for subsequent session resume
   pnpm run demo:down

   # Or cleanly tear down processes, containers, AND persistent Docker volumes:
   pnpm run demo:down -- --remove-vols
   ```

### 3.3 Credential & Secret Management

- **Secrets Storage**: When `demo:reset` runs, cryptographic keys (`metaSecret`, `cookieSecret`, `csrfToken`) are generated using cryptographically secure random bytes and saved to `<repoRoot>/.demo-data/secrets.json` with restricted file permissions (`0o600`).
- **Zero Log Leakage**: Cryptographic secrets and authentication tokens are **never logged to stdout/stderr** or returned in unauthenticated API responses.
- **Test Accounts**: Test user accounts (`alice` as admin, `bob` as regular user) are initialized with Scrypt-hashed passwords for offline development. The disabled test account (`charlie_disabled`) is provisioned to verify authorization rejection. Production credentials, external IM tokens, and live/arbitrary import endpoints are strictly forbidden.

---

## 4. Core Technical & Safety Invariants

### 4.1 DSH Official Sole Session & Runtime Truth
- The genuine DeepSeek Harness runtime stack (`SessionStore`, `SessionPersistenceJsonl`, `AgentLoop`, `AgentRegistry`) running inside the user container is the **sole source of truth** for agent execution and session persistence.
- Session events are persisted to project-nested paths: `$DSH_HOME/sessions/<project-key>/<encoded-session-id>/session.jsonl`. If a session exists on disk, it is resumed via `agents.resume`. If resumption fails, it throws `PersistedSessionResumeError` rather than silently creating an empty session with the same ID.

### 4.2 Fixed Offline HappyClaw Importer (Never Production Data)
- Historical data import operates strictly offline from deterministic repository fixtures located at `packages/import-happyclaw/fixtures/source/db/messages.db`.
- **Exact Fixture Invariants**: The fixture contains exactly 2 chats, 52 source messages, 50 imported people-talk messages, 2 dropped empty messages, and 5 attachments.
- **Strict Isolation**: Production paths (`$HOME/happyclaw/data`, real `$DSH_HOME`, `~/.dsh`, `/etc`) are blocked by path validation preflight guards. Dynamic/arbitrary live import API endpoints and external IM tokens are disallowed.

### 4.3 Atomic Cordis Plugins: Typed Composition vs. Declarative YAML
- **Composable & Disposable Plugins**: DeepSeek Harness and Cordis plugins are independently composable, disposable, and upgradable fibers.
- **Runtime Composition Truth**: Runtime containers compose and apply plugin fibers in TypeScript via `createEnkeepRuntimeBundle({ dshHome, userId, spacesDir })` and `applyEnkeepBundle(ctx, bundleEntries)` exported from `@enkeep/dsh-enkeep-bundle`. If any entry fails during mount, previous fibers are disposed in reverse order.
- **Declarative YAML Role**: The runtime never reads or parses YAML at runtime. `cordis.patch.yml` is used solely as a package manifest declaration (`dsh.bundle.patch`) for packaging and static audit.
- **Plugin Conventions**: All `@enkeep/dsh-*` plugins declare `cordis` and `dsh` as `peerDependencies` (never runtime dependencies), accessing optional services dynamically via `ctx.get(name)`.
- Plugins include:
  - `@enkeep/dsh-receipt-store-sqlite`: SQLite receipt store for delivery idempotency.
  - `@enkeep/dsh-inbound`: Inbound gateway dispatching turn actions (`followup`, `cancel`).
  - `@enkeep/dsh-event-relay`: Event bus delivering real-time agent lifecycle and message events.
  - `@enkeep/dsh-tools`: Outbound platform tools (`send_message`, file operations) with strict workspace confinement.
  - `@enkeep/dsh-external-interaction`: Handles external approval and question suspension.
  - `@enkeep/dsh-affinity-policy`: Manages session affinity and routing boundaries.
  - `@tivility/dsh-llm-affinity`: Attaches routing metadata for model affinity.

### 4.4 Offline Deterministic Adapter Boundaries
- Containers mount `DeterministicDemoLlmAdapter` registered for provider `demo-provider` and model `demo-model`.
- Produces deterministic formatted responses prefixed with `[DemoModel:<user>] ...`, operating completely offline without external network access or remote API keys.

### 4.5 SQLite Migrations (v1–v8), Transactions & Crash Recovery
- Platform storage and server migrations (**v1–v8**) are tracked in `_schema_migrations` with SHA-256 checksum validation and downgrade rejection:
  - v1–v4: Core platform schema (users, credentials, spaces, session routes, quotas, audit logs, initial delivery inbox).
  - v5: `web_messages` and `web_events` tables with session indexes.
  - v6: `delivery_inbox` turn linkage and `idempotency_records` table (`held`, `processing`, `completed`, `failed`).
  - v7: `delivery_inbox` status extension (`held`, `processing`, `delivered`, `duplicate`, `cancelled`, `failed`).
  - v8: `fixed_import_receipts` and `fixed_import_provenance` tables.
- Fixture import executes within atomic SQLite transactions, populating spaces, session routes, web messages, and event cursors.
- **Startup Crash Recovery**:
  - **Platform Server / Delivery Gateway Startup**: When `PlatformServer.start()` boots with a drainable `DeliveryRuntimeGateway`, it executes `runtimeGateway.redriveHeld()`, which invokes `recoverDanglingDeliveriesOnStartup()`. This atomically resets stranded `processing` delivery inbox records to `held`, `processing` idempotency records to `held`, and `running` turn runs to `queued`, then redrives all `held` deliveries across tenants.
  - **Platform Storage Recovery (`recoverAfterRestart`)**: In standalone/fallback storage mode without a drainable gateway, `storage.recoverAfterRestart()` resets in-flight `processing` deliveries to `held` and transitions all open `running` and `queued` `turn_runs` to `interrupted`.
  - `PlatformServer.start()` coordinates this cleanly: if `runtimeGateway` provides `redriveHeld()`, it calls `runtimeGateway.redriveHeld()` exclusively; otherwise it delegates to `storage.recoverAfterRestart()`.
- **Explicit Cancellation & Turn Control**:
  - Turn cancellation: `POST /api/turns/:turnId/cancel`
  - Session-scoped cancellation: `POST /api/sessions/:sessionId/turn/cancel-current` (with `GET /api/sessions/:sessionId/turn/current` for turn state inspection)
  - Cancellation dispatches `agent.cancel({ kind: 'user' })` with cross-exec `SIGUSR1` signaling. Only an authoritative session `turn/end` event with `reason.kind === 'aborted'` results in cancellation, atomically transitioning the turn run to `interrupted`, the delivery inbox record to `cancelled`, and the idempotency record to `failed`.

### 4.6 Zero-Network Tool Schemas & Plugin Contract
- **Isolated Sandbox**: User containers run under strict `--network none` with no open network ports and no Unix Domain Socket (UDS) connections to the host.
- **Tool Schemas (4 Schemas)**: The `@enkeep/dsh-tools` plugin registers 4 tool schemas (`send_message`, `send_file`, `create_task`, `check_quota`) into the DSH `ToolsRegistry` (`schemasRegistered === true`, `toolsCount === 4`, `plugins.tools === true`).
- **Platform Client Unavailable**: Because the platform client is not attached inside zero-network sandboxes, platform tool execution is disabled (`toolsOperational: false`, `toolsUnavailableReason: 'PLATFORM_CLIENT_UNAVAILABLE'`).
- **Core Bundle Readiness**: The 6 core operational plugins (`receiptStore`, `inbound`, `eventRelay`, `externalInteraction`, `affinityPolicy`, `llmAffinity`) and persistence are fully operational (`corePluginsReady: true`, `enkeepBundleLoaded: true`). No UDS or platform tool execution occurs in the container.

### 4.7 Platform Tasks, Quotas, Files & Profiles Governance
- **Tasks (`agent_prompt`)**: Background task execution strictly enforces the `AgentPromptTaskPayload` contract: `{ type: 'agent_prompt', prompt: string, sessionId: string, sessionPolicy: 'existing_session', spaceId?: string }`.
- **Resource Quotas (5 Fixed Metrics)**: Enforces 5 explicit core metrics (`tokens`, `messages`, `turns`, `storage_bytes`, `api_calls`). Unconfigured quota policy is strictly `fail_closed`. Quota reservations use atomic CAS transitions (`reserved` -> `committed` / `released` / `expired`) and are released on turn cancellation.
- **Files Workbench**: Container-volume files workbench APIs (`/api/spaces/:spaceId/files*`), strictly scoped to user container space volume.
  - Non-recursive operations: `list`, `read`, `write`, `mkdir`, `rename`, `delete`.
  - Strict preconditions: `mkdir` requires `{ requireAbsent: true }`; `write` requires `expectedEtag` or `requireAbsent: true`; `rename` requires `expectedEtag` and (`expectedTargetEtag` or `requireTargetAbsent: true`); `delete` requires `expectedEtag`.
  - ETags: exact raw quoted lowercase SHA-256 (`"[0-9a-f]{64}"`).
- **Agent Profiles Governance**:
  - 4 sections: `IDENTITY`, `SOUL`, `AGENTS`, `TOOLS`.
  - Versioning: Positive integers (`1, 2, 3...`), canonical JSON SHA-256 prompt hash.
  - Space Binding & Generation Pinning: Space binding pins active version; session generation resets pin profile snapshot at generation boundary.
  - Archive Behavior: Soft archiving transitions profile status to `archived`; existing sessions retain pinned snapshots; archived profiles cannot be bound to new spaces.
- **Public ID & Credential Privacy**: Sensitive internal fields (`password_hash`, `token_hash`, `promptHash`, raw HMAC secrets, internal DB IDs, cross-tenant data) are stripped from public REST API responses. `PublicAgentProfileSnapshot` exposes version, sections, changeSummary, and createdAt.

### 4.8 Intentional Architectural Exclusions
- **No Real External IM**: No live integrations with external messaging platforms (Feishu, WeChat, Telegram, Discord, etc.).
- **No Real External Credentials**: No production API keys, LLM provider tokens, or external credentials stored or transmitted.
- **No Arbitrary / Dynamic Imports**: Offline data migration is strictly restricted to verified repository fixtures (`packages/import-happyclaw/fixtures/source/db/messages.db`). Dynamic live imports and external production DB access are disallowed.
- **No Host Execution**: User code, tool commands, and agent turns run exclusively inside zero-network Docker containers, never on the host.
- **No Arbitrary Host Mounts**: User containers never mount `/var/run/docker.sock`, host `$HOME`, `~/.dsh`, `/etc`, or arbitrary host directories (`additional_mounts`).
- **No External MCP / Arbitrary Plugins**: No Stdio/SSE Model Context Protocol servers or unvetted external Cordis plugins.
- **No Host Git / Shell Skills**: No host-level git automation or host-executing shell skill plugins.

### 4.9 Alice & Bob Real Docker Isolation & Hardening
- **Containers**: Alice (`enkeep-demo-alice[-<suffix>]`) and Bob (`enkeep-demo-bob[-<suffix>]`) tracked with exact 64-character full container IDs.
- **Volumes**: Dedicated per-user volumes matching `^enkeep-demo-dsh-[a-zA-Z0-9][a-zA-Z0-9_-]{0,60}$` (e.g. `enkeep-demo-dsh-alice[-<suffix>]`, `enkeep-demo-dsh-bob[-<suffix>]`) mounted at `/home/dsh` with mandatory immutable `enkeep.volume-id` labels independent of `enkeep.run-id`. Cross-user volume sharing is rejected.
- **Non-Root Execution**: Runs under UID/GID `1000:1000` (`dsh`), forbidding root execution.
- **Zero-Network Mode**: Strict `--network none` with zero published network ports (no `EXPOSE` directives).
- **Transport**: `DockerExecTransport` streaming JSON requests/responses across `docker exec` (`docker-exec://enkeep-demo-<userId>`).
- **Hardening & Ownership**: `SafeDockerClient` rejects `docker system prune` and enforces multi-attribute ownership. Volume ownership expectation requires exact `volumeName`, `userId`, and `volumeId` (no `runId`).
- **Data Location**: Container runtime state and session history persist inside dedicated Docker volumes. The host directory `<repoRoot>/.demo-data/` stores only platform metadata, SQLite database, and import artifacts.

### 4.10 Web Channel, Authentication & CSRF Protection
- **Host Header Validation**: All requests undergo pre-routing Host header verification strictly enforcing exact `Host === 127.0.0.1:<socket.localPort>` matching the server socket's local port.
- **CSRF Defense**: State-modifying requests (POST, PUT, PATCH, DELETE) require BOTH constant-time matching of `X-Enkeep-CSRF` headers AND exact `Origin === http://127.0.0.1:<socket.localPort>`. Remote socket address must be strictly exact `127.0.0.1`.
- **Session Security**: Scrypt password hashing with signed cookies (`cookieSameSite: 'Strict'`).
- **Content Security Policy (CSP)**: `default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`.
- **Static Assets**: Single-page application assets served via `@enkeep/web-ui` with strict path containment, preventing arbitrary dynamic imports.

### 4.11 Signed Teardown Metadata & Fail-Closed Lifecycle
- Spawned processes and containers write signed metadata files (`.demo-data/pids/`, `.demo-data/containers/`, `.demo-data/volumes/`) keyed by `metaSecret` from `secrets.json`.
- Teardown (`demo:down`) verifies HMAC-SHA256 signatures, start times, command lines, container labels, and volume ownership expectations (`volumeName,userId,volumeId`) before issuing termination commands.
- If verification fails or Docker daemon is unreachable, the system **fails closed**, preserving metadata and refusing to terminate unverified resources.

### 4.12 Protected Service Immunity (Ports 3000 & 3080)
- Existing development services on `127.0.0.1:3000` (HappyClaw) and `127.0.0.1:3080` (DeepSeek Harness Web GUI) are permanently protected.
- Listener PIDs (`lsof`/`ps`) and TCP socket connectivity (`net.connect`) are probed before and after test execution to assert zero interference.

---

## 5. Strict Test Matrix & Acceptance Rules

The repository enforces a comprehensive test hierarchy:

| Test Suite | Command | Scope |
|---|---|---|
| **Safety Preflight Tests** | `pnpm run safety:test` | Host binding, port exclusion (3000/3080), `.demo-data` containment, PID ownership, root scripts build-gate safety. |
| **Package Unit & Integration** | `pnpm run test:packages` | Storage migrations (v1-v8), Cordis plugin composition, crypto metadata, UDS client, protocol codecs. |
| **Live Docker Acceptance** | `pnpm run test:docker` | Builds workspace (`pnpm run build`), builds fresh `enkeep-demo-runtime:acceptance` image, and executes all 3 mandatory Docker suites: runtime-runner, demo-runner, and web-e2e (auto-detects LLM config or deterministic demo fallback, self-contained from clean tree). |
| **Live Docker Acceptance (Offline Demo)** | `pnpm run test:docker:demo` | Explicit offline demo mode (`ENKEEP_LLM_ENABLED=0`) executing all 3 Docker suites with deterministic mocked adapter. |
| **Full Verification Pipeline** | `pnpm run verify` | Sequential chain of `preflight`, `typecheck`, `build`, and all unit/integration test suites. |
| **Demo E2E Test Suite** | `pnpm run demo:test` | Self-contained full lifecycle test from clean tree (builds packages, builds image, executes reset, auth, import, isolation, session, restart recovery, Docker execution, protected port listener/TCP probes). |

*Acceptance & Gate Invariants*:
- **Authoritative Root Commands**: Root commands (`pnpm run test:docker`, `pnpm run demo:test`, `pnpm run verify`, `pnpm test`) are the authoritative entry points and guarantee self-contained clean-tree execution via topological build gating (`pnpm run build`). When invoking individual package filters (such as `pnpm --filter @enkeep/demo-runner run test:docker`), callers should ensure workspace packages are built.
- **Acceptance Rule**: Acceptance suites require all declared test suites to execute without implicit skipping.

---

## 6. Workspace Structure

The monorepo contains 20 workspace packages managed with `pnpm`:

```
packages/
├── demo-runner/                Demo lifecycle orchestrator & CLI (reset, up, down, test, status)
├── dsh-affinity-policy/        DSH agent affinity & session routing policy (Cordis plugin)
├── dsh-enkeep-bundle/          DSH Cordis bundle runtime composition (createEnkeepRuntimeBundle)
├── dsh-event-relay/            DSH event bus & relay (Cordis plugin)
├── dsh-external-interaction/   DSH external interaction tools & approval suspension
├── dsh-inbound/                DSH inbound message gateway (followup/cancel dispatcher)
├── dsh-platform-client/        UDS & HTTP client to platform server with retry logic
├── dsh-receipt-store-sqlite/   Receipt store with SQLite persistence (Cordis plugin)
├── dsh-tools/                  Outbound platform tools (send_message, workspace fs guards)
├── import-happyclaw/           HappyClaw offline database migration & fixture importer
├── platform-auth/              Auth service with Scrypt password hashing & signed cookies
├── platform-core/              Core domain types, errors, and branded IDs
├── platform-operations/        Platform operation services, quotas, and audit logging
├── platform-server/            HTTP API server (REST API, cursor-based event polling, routes)
├── platform-storage-sqlite/    SQLite storage repositories, CAS transitions & migrations (v1-v8)
├── protocol/                   Wire protocol schemas, branded encoders & JSON codecs
├── runtime-runner/             Container & process runtime runner, SafeDockerClient & CLI
├── web-channel/                Web channel, route keys & CSRF/session gateway
├── web-e2e/                    End-to-end contract, Playwright UI, and Docker test suites
└── web-ui/                     SPA frontend static assets & secure asset loader
```

---

## 7. Troubleshooting Guide

| Symptom | Cause | Solution |
|---|---|---|
| `SafetyViolationError: UNSAFE_HOST_BINDING` | Server or script attempted to bind to `0.0.0.0`, `localhost`, or public IP. | Ensure host binding is strictly set to exact `127.0.0.1`. |
| `SafetyViolationError: UNSAFE_PORT_ALLOCATION` | Target port is reserved (`3000` or `3080`). | Use ephemeral dynamic port `0` or assign an unreserved port. |
| `DockerDaemonUnavailableError` | Docker daemon is not running on host. | Start Docker Desktop or Docker Engine daemon. |
| `PersistedSessionResumeError` | Corrupted session JSONL file in container persistence volume. | Run `pnpm run demo:reset` or `pnpm run demo:down -- --remove-vols` to reinitialize clean volume state. |
| `CsrfViolationError` (403) | Missing or invalid `X-Enkeep-CSRF` header, mismatched Host/Origin socket port. | Fetch CSRF token via `GET /api/auth/csrf` and include header `X-Enkeep-CSRF` and matching `Origin` on state-changing requests. |
| `ActiveProcessesRunningError` on `demo:reset` | Previous demo processes are still running. | Run `pnpm run demo:down` before resetting demo environment. |

---

## 8. Conventions & Dependency Policy

- **Cordis / DSH Plugins (`packages/dsh-*`)**: Generic DSH and Cordis plugin packages follow the plugin convention where `dsh` / `cordis` packages are `peerDependencies` (plus dev), never runtime dependencies; plugins are independently composable, disposable, and upgradable fibers; do not mix plugin export forms; read optional services with `ctx.get(name)`.
- **Runtime Composition**: Runtime containers compose plugins via `createEnkeepRuntimeBundle` and `applyEnkeepBundle` from `@enkeep/dsh-enkeep-bundle`. Runtime never reads or parses YAML files; package `dsh.bundle.patch` declaration in `package.json` points to `cordis.patch.yml` solely as packaging metadata.
- **Standalone Runtime & Runner Packages (`runtime-runner`, `demo-runner`)**: Standalone host/container runtime runners legitimately declare explicit DSH runtime dependencies (such as `@deepseek-ai/dsh-*` engines and persistence layers) necessary for standalone server, CLI, and containerized runtime execution.
