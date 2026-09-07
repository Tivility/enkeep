# Enkeep Safety Guardrails & Preflight Subsystem

This document defines the architecture, isolation rules, cryptographic ownership model, and APIs for the **Enkeep Safety Guardrails**.

---

## 1. Safety Objectives & Principles

Enkeep operates in development environments alongside critical existing services:
- **HappyClaw**: Local service running on dynamic PIDs and commonly bound to `127.0.0.1:3000`. **Must never be killed, restarted, or interrupted.**
- **DeepSeek Harness (DSH) Web GUI**: Active development environment on `127.0.0.1:3080`. **Must never be killed, restarted, or interrupted.**
- **Production Data / Credentials**: Production databases (e.g. external `$HOME/happyclaw/data`), user home environments (`$DSH_HOME`, `~/.dsh`), and sensitive system paths. **Must never be read, modified, or accessed by demo scripts.**

To guarantee zero interference, strict security boundaries are enforced:

```
+-------------------------------------------------------------------------+
|                              Enkeep Repo                                |
|                                                                         |
|   scripts/safety/              tests/safety/         .demo-data/        |
|   ├── constants.ts             ├── port.test.ts      ├── pids/          |
|   ├── errors.ts                ├── preflight.test.ts │   └── <svc>.json |
|   ├── port.ts                  └── ownership.test.ts ├── containers/    |
|   ├── preflight.ts                                   │   └── <c>.json   |
|   ├── ownership.ts             packages/import/      ├── volumes/       |
|   └── index.ts                 └── fixtures/messages.db  └── <v>.json   |
|                                                      └── secrets.json   |
+-------------------------------------------------------------------------+
       |                           |                          |
   [Exact 127.0.0.1 Only]  [Port Exclusions]          [Signed Multi-Attribute]
   Strict 127.0.0.1        Excludes 3000, 3080        Requires HMAC (metaSecret),
   Host: 127.0.0.1:<port>  & caller exclusions        'enkeep-demo' owner tag,
   Origin: http://...                                 exact enkeep.run-id & labels
   Remote: 127.0.0.1
```

---

## 2. Core Guardrail Components

### 2.1 Demo Data Isolation & Fixture Handling
- **State Partitioning**: The host `.demo-data/` directory is strictly confined to platform metadata, cryptographic secrets (`secrets.json`), the SQLite database (`platform.db`), and import artifacts. Container runtime state and session history persist inside dedicated Docker volumes, not on host paths.
- **Gitignore Protection**: `.demo-data` is permanently registered in `.gitignore` and must never be committed.
- **Resolved Production Path Defense**: Preflight path checks reject access resolving to external production locations (e.g. `$HOME/happyclaw/data`, `$DSH_HOME`, `/etc`).
- **Safe Repository Fixtures**: Offline data imports use only safe fixed repository fixtures (`packages/import-happyclaw/fixtures/source/db/messages.db`), asserting exact invariants: 2 chats, 52 source messages, 50 imported people-talk, 2 dropped empty messages, and 5 attachments. Dynamic/arbitrary live import API endpoints and external IM tokens are disallowed.

### 2.2 Host Binding & Port Allocation Guardrails (`scripts/safety/port.ts`)
- **Strict Exact 127.0.0.1 Binding**: Services are restricted strictly to exact `127.0.0.1`. Any attempt to bind to `0.0.0.0`, `::`, `localhost`, `::1`, or public interfaces throws `SafetyViolationError` with code `UNSAFE_HOST_BINDING`.
- **HTTP Header & Socket Safety**: Web requests enforce exact `Host === 127.0.0.1:<socket.localPort>`, exact `Origin === http://127.0.0.1:<socket.localPort>`, and remote socket address exact `127.0.0.1`.
- **Protected Ports**: Ports `3000` (HappyClaw common port) and `3080` (DSH GUI) are permanently protected against allocation or disruption. Probing verifies listener PIDs (`lsof`/`ps`) and TCP socket connectivity (`net.connect`) with zero process interference.
- **Dynamic Port Allocation**: `findAvailablePort()` and `allocatePorts()` dynamically test TCP loopback availability and assign safe, unused ephemeral ports.

### 2.3 Preflight Safety Verification (`scripts/safety/preflight.ts`)
Before starting demo components (such as in `demo:up`), preflight checks verify:
1. **Repository Identity**: Root `package.json` has `name === "enkeep-root"`.
2. **Gitignore Protection**: `.gitignore` contains `.demo-data`.
3. **Host Safety**: Target binding host is strictly exact `127.0.0.1`.
4. **Protected Ports Guard**: Ports 3000 and 3080 are not allocated.
5. **Data Boundary**: Target demo data paths resolve strictly inside `.demo-data`.
6. **Forbidden Path Isolation**: Paths do not resolve to external HappyClaw production directories, `$DSH_HOME`, or system credentials.

### 2.4 Cryptographic Ownership Model (`scripts/safety/ownership.ts` & `@enkeep/demo-runner`)

#### Process Ownership (Signed PID Metadata)
- **No Hardcoded PIDs**: Ownership is tracked dynamically via cryptographically signed metadata.
- When an Enkeep demo process starts, a signed metadata file is written to `.demo-data/pids/<service>.json`:
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
- Before terminating any process during teardown (`demo:down`):
  - Validates `HMAC-SHA256` signature using `metaSecret` against `secrets.json`.
  - Confirms `owner === "enkeep-demo"`.
  - Performs live command line and start time verification to prevent killing recycled PIDs.
  - Rejects any operation targeting unverified or foreign PIDs.

#### Docker Container & Volume Ownership
- **Multi-Attribute Verification (Not Prefix-Only)**:
  - Container name must match `enkeep-demo-<userId>[-<suffix>]` (e.g. `enkeep-demo-alice[-<suffix>]`, `enkeep-demo-bob[-<suffix>]`).
  - Mandatory label `app=enkeep-demo`.
  - User ownership label `enkeep.user=<userId>`.
  - Exact run identifier label `enkeep.run-id=<runId>`.
  - Full 64-character container ID verification.
  - Live Docker inspection verifies metadata matches actual container state before issuing stop or remove commands.
- **Volume Ownership & Teardown**:
  - Volumes follow pattern `^enkeep-demo-dsh-[a-zA-Z0-9][a-zA-Z0-9_-]{0,60}$` (e.g. `enkeep-demo-dsh-alice[-<suffix>]`).
  - Mandatory immutable volume identifier label `enkeep.volume-id=<volumeId>` independent of `enkeep.run-id`.
  - Teardown requires explicit `VolumeOwnershipExpectation` with exact fields `volumeName`, `userId`, and `volumeId` (no `runId`).
  - `pnpm demo:down` retains volumes for persistent session resume.
  - `pnpm demo:down -- --remove-vols` safely deletes verified volumes.

---

## 3. Module API Reference

### `scripts/safety/constants.ts`
- `DEFAULT_EXCLUDED_PORTS`: `[3000, 3080]`
- `ALLOWED_HOSTS`: `['127.0.0.1']`
- `FORBIDDEN_HOSTS`: `['0.0.0.0', '::', 'localhost', '::1', ...]`
- `DEMO_DATA_DIR_NAME`: `'.demo-data'`
- `DEMO_OWNERSHIP_TAG`: `'enkeep-demo'`
- `DEMO_DOCKER_CONTAINER_PREFIX`: `'enkeep-demo-'`
- `DEMO_DOCKER_LABEL_KEY`: `'app'`
- `DEMO_DOCKER_LABEL_VALUE`: `'enkeep-demo'`

### `scripts/safety/errors.ts`
- `SafetyViolationError`: Custom error class containing structured `code` (`UNSAFE_HOST_BINDING`, `UNSAFE_PORT_ALLOCATION`, `FORBIDDEN_DATA_ACCESS`, `UNVERIFIED_PROCESS_OWNERSHIP`, etc.) and `details`.

### `scripts/safety/port.ts`
```ts
function validateHost(host: string): void;
function validatePort(port: number, customExcludedPorts?: Iterable<number>): void;
function isPortExcluded(port: number, customExcludedPorts?: Iterable<number>): boolean;
function isPortAvailable(port: number, host?: string): Promise<boolean>;
function findAvailablePort(options?: FindPortOptions): Promise<number>;
function allocatePorts<T extends string>(names: readonly T[], options?: FindPortOptions): Promise<Record<T, number>>;
```

### `scripts/safety/preflight.ts`
```ts
function findRepoRoot(startDir?: string): string;
function getCanonicalDemoDataDir(repoRoot?: string): string;
function isForbiddenPath(targetPath: string, repoRoot?: string): { forbidden: boolean; reason?: string };
function validateDemoDataPath(targetPath: string, repoRoot?: string): string;
function validateSafePath(targetPath: string, repoRoot?: string): string;
function runPreflightChecks(options?: PreflightOptions): PreflightReport;
function assertPreflight(options?: PreflightOptions): PreflightReport;
```

### `scripts/safety/ownership.ts`
```ts
function getPidMetadataDir(repoRoot?: string): string;
function writeProcessMetadata(meta: Partial<ProcessMetadata>, repoRoot?: string): ProcessMetadata;
function readProcessMetadata(service: string, repoRoot?: string): ProcessMetadata | null;
function listDemoProcesses(repoRoot?: string): ProcessMetadata[];
function removeProcessMetadata(service: string, repoRoot?: string): boolean;
function isProcessAlive(pid: number): boolean;
function planProcessTeardown(service: string, repoRoot?: string): ProcessTeardownPlan;
function validateDockerContainerName(name: string): void;
function validateDockerLabels(labels: Record<string, string>): void;
function validateContainerMetadata(container: ContainerMetadata): void;
```

---

## 4. Intentional Architectural Exclusions & Security Boundaries

Enkeep enforces strict fail-closed security boundaries:
- **No Real External IM**: No live integrations with external messaging platforms (Feishu, WeChat, Telegram, Discord, etc.).
- **No Real External Credentials**: No production API keys, LLM provider tokens, or external credentials stored or transmitted.
- **No Arbitrary / Dynamic Imports**: Offline data migration is strictly restricted to verified repository fixtures (`packages/import-happyclaw/fixtures/source/db/messages.db`). Dynamic live imports and external production DB access are disallowed.
- **No Host Execution**: User code, tool commands, and agent turns run exclusively inside zero-network Docker containers, never on the host.
- **No Arbitrary Host Mounts**: User containers never mount `/var/run/docker.sock`, host `$HOME`, `~/.dsh`, `/etc`, or arbitrary host directories (`additional_mounts`).
- **No External MCP / Arbitrary Plugins**: No Stdio/SSE Model Context Protocol servers or unvetted external Cordis plugins.
- **No Host Git / Shell Skills**: No host-level git automation or host-executing shell skill plugins.

---

## 5. Commands & Development Scripts

| Command | Action |
|---|---|
| `pnpm run preflight` | Runs the preflight safety check suite and reports diagnostic status. |
| `pnpm run safety:test` | Runs the Vitest test suite specifically for `tests/safety/**`. |
| `pnpm run test` | Runs root safety tests and all workspace package test suites. |
| `pnpm run clean` | Cleans `dist/` build artifacts across root and all workspace packages. |
| `pnpm run test:docker` | Builds workspace packages (`pnpm run build`), builds fresh `enkeep-demo-runtime:acceptance` image, and executes all 3 mandatory Docker suites: runtime-runner, demo-runner, and web-e2e (auto-detects LLM config or deterministic demo fallback, self-contained from clean tree). |
| `pnpm run test:docker:demo` | Explicit offline demo mode (`ENKEEP_LLM_ENABLED=0`) executing all 3 Docker suites with deterministic mocked adapter. |
| `pnpm run build` | Compiles root scripts/tests (`tsc -b`) and workspace packages. |
| `pnpm run verify` | Sequentially runs preflight, typecheck, build, and test. |
