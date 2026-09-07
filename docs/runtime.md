# Enkeep DSH Runtime & Docker Isolation Architecture

This document describes the design, implementation, safety invariants, and operational model of the **Enkeep DSH Runtime and Docker Isolation Subsystem**.

---

## 1. Architectural Overview (Zero-Network Isolation)

Enkeep provisions isolated, non-root Docker runtime containers for individual tenants (e.g., **Alice** and **Bob**). Each user's agent runtime runs inside a dedicated sandbox with isolated state persistence, dedicated volumes, and **zero open network ports** (`--network none`).

```
+-----------------------------------------------------------------------------------+
| Host System (macOS / Linux)                                                      |
|                                                                                   |
|  Enkeep Platform (Web / CLI)                                                      |
|  - Zero TCP port forwarding across container boundaries                           |
|  - Guarded: HappyClaw (3000) & DSH GUI (3080) listener PID / TCP verified          |
|  - Strict SafeDockerClient with OwnershipExpectation & Run-ID verification        |
|                                                                                   |
|        │                                                │                         |
|        │ docker exec (stdin/stdout JSON)                │ docker exec (JSON)      |
|        ▼ (--network none)                               ▼ (--network none)        |
|  +───────────────────────────────+            +───────────────────────────────+   |
|  | Container:                    |            | Container:                    |   |
|  |   enkeep-demo-alice[-<sfx>]   |            |   enkeep-demo-bob[-<sfx>]     |   |
|  | - User: non-root (1000:1000)  |            | - User: non-root (1000:1000)  |   |
|  | - Network: NONE (0 ports)     |            | - Network: NONE (0 ports)     |   |
|  | - Full CID: 64-char hex       |            | - Full CID: 64-char hex       |   |
|  | - NO docker.sock              |            | - NO docker.sock              |   |
|  | - NO host home                |            | - NO host home                |   |
|  | - NO sibling volume           |            | - NO sibling volume           |   |
|  | - DSH Agent Loop & Cordis     |            | - DSH Agent Loop & Cordis     |   |
|  | - In-Container Exec CLI       |            | - In-Container Exec CLI       |   |
|  | - Deterministic Demo LLM      |            | - Deterministic Demo LLM      |   |
|  +───────────────────────────────+            +───────────────────────────────+   |
|        │                                                │                         |
|        ▼ (Volume Mount: /home/dsh)                      ▼ (Volume Mount: /home/dsh)|
|  +───────────────────────────────+            +───────────────────────────────+   |
|  | Volume:                       |            | Volume:                       |   |
|  |   enkeep-demo-dsh-alice[-<sfx>]|           |   enkeep-demo-dsh-bob[-<sfx>] |   |
|  | - Label: enkeep.volume-id     |            | - Label: enkeep.volume-id     |   |
|  | - $DSH_HOME/sessions/<pKey>/  |            | - $DSH_HOME/sessions/<pKey>/  |   |
|  |   <encoded-session-id>/       |            |   <encoded-session-id>/       |   |
|  |   session.jsonl               |            |   session.jsonl               |   |
|  | - spaces/ (workspace files)   |            | - spaces/ (workspace files)   |   |
|  +───────────────────────────────+            +───────────────────────────────+   |
+-----------------------------------------------------------------------------------+
```

---

## 2. Core Security & Isolation Principles

1. **Zero Open Ports (`--network none`)**:
   - Runtime containers run with `--network none`, completely disconnecting the network stack.
   - Eliminates port scanning, container ingress/egress risks, and port collision vulnerabilities.
   - Container Dockerfiles contain **zero `EXPOSE` directives**.

2. **Non-Root Container Execution**:
   - Containers run under non-root UID/GID `1000:1000` (`dsh:dsh`).
   - Root user IDs (`0`, `root`, `0:0`) are rejected by the `ContainerSpecValidator`.

3. **Ownership Verification & Fail-Closed Guardrails**:
   - `SafeDockerClient` enforces strict `OwnershipExpectation` verification before every execution, inspection, stop, or removal.
   - Containers require matching prefix (`enkeep-demo-`), `app=enkeep-demo`, `enkeep.user=<userId>`, exact `enkeep.run-id=<runId>`, and full 64-character container ID.
   - Volumes enforce matching volume prefix (`enkeep-demo-dsh-`), `app=enkeep-demo`, `enkeep.user=<userId>`, and mandatory immutable `enkeep.volume-id=<volumeId>` independent of `enkeep.run-id`.
   - `VolumeOwnershipExpectation` requires exact fields `volumeName`, `userId`, and `volumeId` (no `runId`).
   - If ownership mismatches, operations **fail closed** immediately without touching foreign containers or volumes.

4. **DSH Official Sole Session & Runtime Truth**:
   - The genuine DeepSeek Harness runtime stack inside the container is the sole source of truth for agent loop execution, session event streaming, and session history persistence.
   - Session events are persisted to project-nested paths: `$DSH_HOME/sessions/<project-key>/<encoded-session-id>/session.jsonl` using `@deepseek-ai/dsh-session-persistence-jsonl`.

5. **Fail-Loud Session Resume (`PersistedSessionResumeError`)**:
   - When a session log exists on disk (`$DSH_HOME/sessions/<project-key>/<encoded-session-id>/session.jsonl`), the runtime resumes it via `agents.resume()`.
   - If corruption or format errors prevent successful resumption, the runtime **throws `PersistedSessionResumeError` immediately** rather than silently creating an empty session with the same ID.

6. **Dedicated Per-User Storage Volumes with Stable Volume IDs**:
   - Alice mounts volume `enkeep-demo-dsh-alice[-<suffix>]` (with label `enkeep.volume-id`) at `/home/dsh`.
   - Bob mounts volume `enkeep-demo-dsh-bob[-<suffix>]` (with label `enkeep.volume-id`) at `/home/dsh`.
   - Pattern: `^enkeep-demo-dsh-[a-zA-Z0-9][a-zA-Z0-9_-]{0,60}$`.
   - Cross-user volume sharing is strictly forbidden and rejected at specification validation time (`validateCrossUserIsolation`).

7. **Strict Path Isolation**:
   - **Zero `docker.sock` Mounts**: `/var/run/docker.sock` is never mounted into user containers.
   - **Zero Host Home Exposure**: Host `$HOME` / `/root` directories are rejected by bind mount validators.
   - **Forbidden Path Safeguard**: Bind mounts containing `happyclaw/data`, `messages.db`, or system states are blocked.

---

## 3. Platform <-> Runtime Transport Analysis

### 3.1 Transport Decision

- **Docker Exec (`DockerExecTransport`)**: Pure zero-network transport (`--network none`).
- All communication passes through `SafeDockerClient.execOwned()` executing `dist/runtime/exec-cli.js`.
- Strict execution controls:
  - 30-second timeout with `SIGKILL` cleanup.
  - 10MB maximum stdout/stderr buffer protection with process termination on overflow.
  - 1MB maximum stdin payload size with JSON depth validation.

### 3.2 Technical Evidence

1. **macOS Hypervisor Limitation**:
   On macOS, Docker runs inside a lightweight virtual machine. Hypervisor file sharing (VirtioFS / 9p) does not forward AF_UNIX socket descriptors across the Darwin kernel <-> Guest Linux kernel boundary, causing `ECONNREFUSED` on socket connects.
2. **Container-side 0.0.0.0 Listening Flaw**:
   Published TCP ports require the container process to listen on `0.0.0.0` within the container namespace to accept forwarded traffic from the Docker proxy.
3. **The Zero-Network Solution**:
   Using `DockerExecTransport` with `--network none` executes the in-container CLI tool (`packages/runtime-runner/dist/runtime/exec-cli.js`), streaming structured JSON requests/responses across `stdin`/`stdout`.

---

## 4. DeepSeek Harness (DSH) Boot & Agent Loop Integration

The runtime container executes a genuine DeepSeek Harness (DSH) stack without custom fake loops:

- **Framework**: `@deepseek-ai/cordis` microkernel.
- **Composable Plugins**: DeepSeek Harness and Cordis plugins are independently composable, disposable, and upgradable fibers.
- **Core Registries**:
  - `@deepseek-ai/dsh-llm` (`LlmRuntime`): Manages LLM adapters and streaming execution.
  - `@deepseek-ai/dsh-session` (`SessionStore`): Manages event-sourced session histories.
  - `@deepseek-ai/dsh-tools` (`ToolsRegistry`): Integrates workspace tool executions.
  - `@deepseek-ai/dsh-system-prompt` (`SystemPromptRegistry`): Builds system prompt templates.
  - `@deepseek-ai/dsh-agent` (`AgentRegistry`): Orchestrates agent lifecycle and sessions.
  - `@deepseek-ai/dsh-agent-loop` (`AgentLoop`): Drives the core model thought/tool loop.
  - `@deepseek-ai/dsh-agent-default-model` (`AgentDefaultModel`): Configures model routing.
  - `@deepseek-ai/dsh-session-persistence-jsonl` (`SessionPersistenceJsonl`): Persists session logs directly to `$DSH_HOME/sessions/<project-key>/<encoded-session-id>/session.jsonl`.

### 4.1 Cordis Atomic Bundle Composition (`createEnkeepRuntimeBundle` + `applyEnkeepBundle`)

- **Typed Composition Truth**: Runtime boot (`packages/runtime-runner/src/runtime/dsh-boot.ts`) consumes the typed functions `createEnkeepRuntimeBundle` and `applyEnkeepBundle` exported from `@enkeep/dsh-enkeep-bundle`. It mounts the 7 typed Cordis plugin entries in mandatory composition order:
  1. `receipt-store` (`@enkeep/dsh-receipt-store-sqlite`): SQLite receipt store for delivery idempotency.
  2. `inbound` (`@enkeep/dsh-inbound`): Inbound gateway dispatching `followup` and `cancel` requests to the agent.
  3. `event-relay` (`@enkeep/dsh-event-relay`): Event bus delivering real-time agent lifecycle and message events.
  4. `enkeep-tools` (`@enkeep/dsh-tools`): Outbound tools (`send_message`, file operations) with strict workspace confinement.
  5. `enkeep-external-interaction` (`@enkeep/dsh-external-interaction`): Handles external approval and question suspension.
  6. `enkeep-affinity-policy` (`@enkeep/dsh-affinity-policy`): Manages session affinity and routing boundaries.
  7. `llm-affinity` (`@tivility/dsh-llm-affinity`): Attaches routing metadata for model affinity.
- **Rollback on Error**: If any entry fails during mount, `applyEnkeepBundle` automatically disposes previously mounted fibers in reverse order before propagating an `AggregateError`.
- **Declarative YAML Role**: The runtime never reads or parses YAML at runtime. `cordis.patch.yml` is used solely as a package manifest declaration (`dsh.bundle.patch`) in `package.json` for packaging and static audit tooling.
- **Cordis Convention**: All `@enkeep/dsh-*` plugins treat `cordis` and `dsh` packages as `peerDependencies` (plus dev), read optional services via `ctx.get(name)`, and avoid mixing export styles.

### 4.2 Offline Deterministic Demo LLM Adapter & Agent Profile Injection

- **Adapter**: `DeterministicDemoLlmAdapter` registered for provider `demo-provider` and model `demo-model`.
- **Formatting**: Outputs deterministic responses prefixed with `[DemoModel:<user>] ...`.
- **Isolation**: Requires no external network access, API tokens, or remote services.
- **Agent Profile Governance**: System prompt assembly in `packages/runtime-runner/src/runtime/agent-profile.ts` injects the 4 prompt sections (`IDENTITY`, `SOUL`, `AGENTS`, `TOOLS`) from the validated `AgentProfileSnapshot` passed to `sendTurn`. Snapshot integrity is verified via canonical JSON SHA-256 (`promptHash`). The pinned profile snapshot remains immutable across execution turns within a generation boundary.

### 4.3 Zero-Network Tool Schemas & Plugin Readiness Contract

- **Zero-Network / No-UDS Principle**: In isolated user containers running under `--network none`, no TCP forwarding and no Unix Domain Socket (UDS) connections exist between the container and the Platform Server.
- **Tool Schema Registration (4 Schemas)**: The `@enkeep/dsh-tools` plugin registers 4 tool schemas (`send_message`, `send_file`, `create_task`, `check_quota`) into the DSH `ToolsRegistry` (`schemasRegistered === true`, `toolsCount === 4`, `plugins.tools === true`).
- **Tools Operational Status**: Because the platform client is not connected inside the zero-network sandbox (`!platformClient`), platform tool execution is disabled. Health checks report:
  - `toolsOperational: false`
  - `toolsUnavailableReason: 'PLATFORM_CLIENT_UNAVAILABLE'`
- **Core Bundle Readiness**: The 6 core operational plugins (`receiptStore`, `inbound`, `eventRelay`, `externalInteraction`, `affinityPolicy`, `llmAffinity`) and session persistence are fully operational (`corePluginsReady: true`, `enkeepBundleLoaded: true`). No UDS or platform tool execution takes place inside the container.

### 4.4 Complete Cancellation Implementation

- **Canonical API Endpoints**:
  - Turn-scoped cancellation: `POST /api/turns/:turnId/cancel`
  - Session-scoped cancellation: `POST /api/sessions/:sessionId/turn/cancel-current` (and `GET /api/sessions/:sessionId/turn/current` for turn status inspection)
- The platform API delegates cancellation to `DeliveryRuntimeGateway`.
- For running turns, the gateway triggers container cancellation via `DockerRuntimeAdapter.cancelTurn()`.
- Within the runtime container, `exec-cli` performs cross-exec process signaling using `SIGUSR1` to notify the active turn process.
- The active turn handler invokes `agent.cancel({ kind: 'user' })` on the live DSH Agent instance.
- **Authoritative Resolution**: Only when the DSH Session emits an authoritative `turn/end` event with `reason.kind === 'aborted'` does the runtime confirm cancellation. The platform database atomically updates `turn_runs` to `interrupted`, `delivery_inbox` to `cancelled`, and `idempotency_records` to `failed`.

---

## 5. Intentional Architectural Exclusions

The Enkeep runtime sandbox enforces clear, fail-closed boundaries:
- **No Real External IM**: No live integrations with external IM protocols (Feishu, WeChat, Telegram, Discord, etc.).
- **No Real Credentials**: No external model provider credentials, tokens, or API keys are accepted, stored, or transmitted.
- **No Arbitrary / Dynamic Imports**: Offline data migration is strictly restricted to verified repository fixtures (`packages/import-happyclaw/fixtures/source/db/messages.db`). Dynamic live imports and external production DB access are disallowed.
- **No Host Execution**: User code, tool commands, and agent turns run exclusively inside zero-network Docker containers, never on the host.
- **No Arbitrary Host Mounts**: User containers never mount `/var/run/docker.sock`, host `$HOME`, `~/.dsh`, `/etc`, or arbitrary host directories (`additional_mounts`).
- **No External MCP / Arbitrary Plugins**: No Stdio/SSE Model Context Protocol servers or unvetted external Cordis plugins.
- **No Host Git / Shell Skills**: No host-level git automation or host-executing shell skill plugins.
