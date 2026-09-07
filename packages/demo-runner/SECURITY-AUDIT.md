# Enkeep Demo Runner Security Audit & Safety Architecture Specification

**Audit Target:** Enkeep Demo Lifecycle Orchestration (`@enkeep/demo-runner`)  
**Scope:** Security Audit across repository, Safety Hardening of `demo:reset`, `demo:down`, `demo:status`, `demo:test`, and Integration Recommendations for `demo:up`.  
**Date:** August 2026  
**Status:** Completed & Fully Hardened with Hermetic Negative Verification

---

## 1. Executive Summary

A comprehensive security audit of the Enkeep demo orchestration lifecycle (`demo:reset`, `demo:up`, `demo:down`, `demo:test`, `demo:status`) was conducted across the `enkeep` repository. The audit focused on eliminating destructive lifecycle side effects, preventing PID reuse attacks, preventing symlink traversal / TOCTOU breakouts, ensuring cryptographic integrity of state metadata, protecting sensitive tokens from leaking in CLI outputs, and safeguarding critical system ports (specifically Port 3000 for HappyClaw and Port 3080 for DeepSeek Harness Web GUI).

To maintain team velocity and prevent conflicting edits with parallel runtime integration work, all safety implementations were encapsulated inside `packages/demo-runner`'s metadata, verification, cleanup, and teardown subsystems without modifying the core `up` runtime integration. All architectural requirements and integration instructions for `up` are documented in Section 4.

---

## 2. Threat Modeling & Vulnerability Analysis

The audit identified nine primary threat vectors across the demo lifecycle:

### Threat 1: PID Reuse & Blind Process Termination
- **Vulnerability:** If `demo:down` or cleanup tools blindly call `process.kill(pid, 'SIGTERM')` based solely on a recorded integer PID, an OS PID rollover may result in terminating unrelated system services, user applications, or production databases.
- **Remediation:** Enforced three-tier process verification (`ProcessInspector`):
  1. Verification of process existence.
  2. Verification of process creation start time (`startTime`) against the signed metadata timestamp.
  3. Command-line and ownership token matching before issuing any OS termination signal.

### Threat 2: Ephemeral Launcher PID vs Long-Running Daemon PID
- **Vulnerability:** When a CLI launcher process writes `process.pid` to metadata and immediately exits (or forks a child), `demo:down` attempts to kill the already-dead launcher PID or a reused process, leaving the actual background service orphaned.
- **Remediation:** Process metadata records the actual long-running daemon PID, verified start time, ownership nonce, and executable command line.

### Threat 3: Metadata Tampering & HMAC Forgery
- **Vulnerability:** Plaintext JSON files in `.demo-data/pids/*.json` or `.demo-data/containers/*.json` can be tampered with by unprivileged processes or symlink attacks to redirect termination signals to arbitrary PIDs or ports.
- **Remediation:** All metadata files are cryptographically signed using HMAC-SHA256 with a repository-local `.meta-secret` (mode `0600`). Verification utilizes constant-time comparison (`crypto.timingSafeEqual`) and fails closed on signature mismatch, missing secrets, or unknown ownership tags.

### Threat 4: Docker Container / Volume Prefix Spoofing & Blind Teardown
- **Vulnerability:** Relying on simple string matching (e.g., `name.startsWith('enkeep-demo-')`) can result in deleting foreign containers or volumes created with similar prefixes.
- **Remediation:** Container teardown enforces live Docker inspection, verifying:
  1. Exact Docker labels (`app=enkeep-demo`, `enkeep.user=<user>`, `enkeep.run-id=<runId>`).
  2. Exact match of real `containerId` against signed metadata.
  3. Ownership verification before any `stopContainer`, `removeContainer`, or `removeVolume` invocation.

### Threat 5: TOCTOU & Symlink Traversal Breakout
- **Vulnerability:** An attacker replacing `.demo-data`, `.demo-data/pids`, or `.meta-secret` with a symlink pointing to `/etc`, `~/.ssh`, or `/tmp` could cause `demo:reset` or `demo:down` to overwrite or delete arbitrary host filesystem paths.
- **Remediation:** Enforced strict symlink containment (`assertPathInDemoData`):
  - Pre-flight `lstatSync` checks to reject any symbolic link directory or file.
  - Realpath resolution ensuring all targets resolve strictly within `<repoRoot>/.demo-data/`.
  - Blocklist rejection of production databases and root system paths.

### Threat 6: Secret & Signature Information Disclosure in `demo:status`
- **Vulnerability:** Printing raw metadata in `demo:status` exposes HMAC signatures, command tokens, and internal process nonces to terminal logs or JSON consumers.
- **Remediation:** Implemented `SanitizedProcessMetadata` and `SanitizedContainerMetadata` in `getStatus()`, stripping cryptographic signatures, private tokens, and internal nonces before returning status output.

### Threat 7: Destructive Reset on Active Services
- **Vulnerability:** Running `demo:reset` while demo services or containers are actively executing causes database corruption, unhandled socket errors, and orphaned processes.
- **Remediation:** `resetDemo` performs an active resource preflight check. If live processes (verified via `ProcessInspector`) or active containers are found, `demo:reset` refuses to proceed and instructs the user to run `demo:down` first.

### Threat 8: Protected System Ports Collision (Ports 3000 and 3080)
- **Vulnerability:** Hardcoded or accidental binding to Port 3000 (HappyClaw) or Port 3080 (DeepSeek Harness GUI) interrupts existing developer workflows.
- **Remediation:** Strict host binding to `127.0.0.1` and dynamic port allocation (`port: 0`). `validateSafePort` throws on ports 3000, 3080, and privileged ports (<1024). Integrity probes snapshot listener PID + HTTP response status + SHA256 payload digest before and after demo runs.

### Threat 9: Insecure Permissions on Session Secret
- **Vulnerability:** A session secret readable by other local users permits unauthorized HMAC forgery.
- **Remediation:** `.meta-secret` is created with strict POSIX mode `0600` (`chmodSync(path, 0o600)`). The secret is rotated securely upon reset.

---

## 3. Implemented Security Architecture

### A. Cryptographic Metadata Integrity & Subsystem Key Derivation (`src/utils/crypto-meta.ts`)
- **HMAC Signing:** Computes `HMAC-SHA256(canonicalPayload, sessionSecret)`.
- **Constant-Time Verification:** Uses `crypto.timingSafeEqual` over raw buffer digests to prevent timing side-channel attacks.
- **Fail-Closed Semantics:** Any missing, unreadable, corrupted, or symlinked `.meta-secret` causes immediate fail-closed error.
- **Dynamic Secret Derivation:** Subsystem secrets (e.g. auth cookie secret, CSRF token) are dynamically derived via `deriveSecret(purpose, repoRoot)` (`HMAC-SHA256(rootSecret, "enkeep-derived:<purpose>")`), completely eliminating hardcoded secret strings across the demo lifecycle.
- **Run ID Isolation:** Every demo session generates a cryptographically random run ID (`run_<12 hex bytes>`).

### B. Process Guard & Safe Teardown (`src/utils/process-guard.ts` & `src/down/index.ts`)
- **Protected PID Filter:** Refuses to terminate:
  - Caller process PID (`process.pid`)
  - Parent process PID (`process.ppid`)
  - Kernel / Init PIDs (`PID <= 1`)
  - Protected port listeners (Ports 3000 and 3080)
- **Pluggable Abstraction:** `ProcessInspector` and `ProcessKiller` interfaces allow 100% hermetic negative testing without issuing live OS kill signals.
- **Graceful Escalation:** `safeKillProcess` sends `SIGTERM` followed by a configurable grace period before sending `SIGKILL`.

### C. Container Guard (`src/down/index.ts`)
- **Ownership Verification:** Uses `OwnershipExpectation` with `containerName`, `userId`, `runId`, and `containerId`.
- **Live Label Validation:** Live Docker inspection confirms labels before deletion.
- **Safe Volume Teardown:** Volume removal is opt-in (`removeVolumes: true`) and restricted to `enkeep-demo-dsh-<user>`.

### D. Protected Port Probes (`src/utils/probes.ts`)
- **Multi-Dimensional Fingerprinting:**
  1. TCP listener PID via `lsof -iTCP:<port> -sTCP:LISTEN`.
  2. HTTP status code.
  3. SHA256 digest of HTTP response payload.
- **Assertion:** `assertProbesUnchanged` verifies that protected ports remain completely untouched throughout demo execution.

---

## 4. Recommendations & Integration Guidance for `demo:up`

For the team or agent responsible for the `up` runtime integration, follow these critical safety patterns:

### 1. Avoid Recording Launcher CLI PID
- When `demo:up` is executed via CLI, **do not** write `process.pid` of the CLI launcher as the service PID if the CLI is ephemeral.
- If the service is spawned as a child process or background daemon:
  1. Capture the child process PID (`child.pid`).
  2. Obtain the child's start timestamp.
  3. Write the signed metadata using `writeSignedProcessMeta()` with the child's PID.

### 2. Exclusive Dynamic Binding on 127.0.0.1
- Always bind the Platform HTTP Server to `127.0.0.1` with dynamic port `0` (or dynamic OS port allocation).
- Never bind to `0.0.0.0` or static ports `3000` / `3080`.
- Call `validateLoopbackHost(host)` and `validateSafePort(port)` before binding.

### 3. Container Registration with Real Docker Container ID
- When starting user runtime containers (`alice` and `bob`), retrieve the true Docker container ID from `client.runContainer()` / `adapter.startRuntime()`.
- Pass the real container ID and labels (`app: 'enkeep-demo'`, `enkeep.user: userId`, `enkeep.run-id: runId`) to `writeSignedContainerMeta()`.

### 4. Fail-Closed on Docker or Database Unavailability
- If Docker is required but unavailable, throw an explicit `FAIL-CLOSED` exception rather than attempting unisolated fallback process execution.
- Maintain zero-network isolation (`--network none`) for user runtime containers.

---

## 5. Negative Test Suite & Verification Matrix

The test suite in `packages/demo-runner/tests/` includes 53 automated tests across 10 test files:

| Test File | Focus Area | Scenarios Verified |
|---|---|---|
| `negative-metadata.test.ts` | Cryptographic Integrity | Tampered PID, tampered port, tampered token, forged signature, negative/invalid PID, foreign owner tag, tampered container ID, removed labels, corrupted `.meta-secret`, timing-safe equality, dynamic subsystem secret derivation (`deriveSecret`). |
| `negative-down.test.ts` | Process & Container Teardown | Refusal to kill `process.pid`, `process.ppid`, PID 1, PID start-time mismatch (PID reuse), command-line mismatch, foreign container prefix spoofing, foreign volume deletion. |
| `negative-reset.test.ts` | Reset Safety & Permissions | Rejection of reset while processes are active, rejection of reset while containers are active, symlink containment check on `.demo-data`, mode `0600` on `.meta-secret`. |
| `negative-status.test.ts` | Information Disclosure | Verifies that `demo:status` never leaks signatures, command tokens, or private nonces. |
| `negative-containment.test.ts` | Path Security | Symlink breakouts, path traversal (`../../`), system path rejection (`/etc`, `/usr`), production database protection. |
| `probes.test.ts` | Port Fingerprinting | Loopback verification, port 3000/3080 rejection, probe snapshot capturing, discrepancy detection. |
| `fail-closed.test.ts` | Failure Modes | Fail-closed behavior on missing Docker, invalid configurations, and corrupted states. |
| `lifecycle.test.ts` | Integration Workflows | Full `reset -> up -> down -> test` lifecycle with probe verification and real Docker opt-in. |
| `crypto-meta.test.ts` | Metadata Operations | Round-trip process and container metadata signing and verification. |
| `config.test.ts` | Path Resolution | Demo data path configuration and boundary assertions. |

---

## 6. Conclusion

The `@enkeep/demo-runner` package now enforces robust, cryptographically verified, and non-destructive demo lifecycle management. All destructive actions require multi-factor verification, protected services on ports 3000 and 3080 are shielded by integrity probes, and sensitive metadata is securely isolated.
