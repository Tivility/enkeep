# @enkeep/web-e2e

Comprehensive Web End-to-End (E2E) Testing Package for the Enkeep Web Platform.

## Architecture

This package implements a dual-layer Playwright-based testing framework:

### Layer A: In-Process Contract E2E
- **Runtime Gateway**: Explicit in-process `TestOnlyContractRuntimeGateway` / `TestOnlyFakeRuntimeGateway` (never defaulting fake gateways in production).
- **Backend Components**: Real `PlatformServer`, `SqlitePlatformStorage`, `DefaultAuthService`, and `SqliteWebMessageStore`.
- **Frontend UI**: Real Single-Page Application served by `@enkeep/web-ui`.
- **Port Binding**: Strictly `127.0.0.1:0` dynamic ephemeral loopback ports.
- **Service Protection Guard**: Automatically probes ports 3000 (HappyClaw) and 3080 (DSH Web GUI) before and after test suites, asserting 100% untouched listener PIDs and URLs.
- **Coverage**:
  - CSRF Bootstrap (`/api/auth/csrf`) and token validation
  - Admin (Alice) and Regular (Bob) authentication and UI workspace loading
  - Disabled user (`charlie_disabled`) login rejection and error notification
  - Historical space and session display from SQLite persistence
  - New space and session creation via UI modals
  - Sending prompt messages via chat input and receiving live polled fake assistant replies
  - User logout and session invalidation
  - Multi-tenant space/session/message isolation (Alice cannot see Bob's data and vice versa)
  - Browser page refresh persistence
  - PlatformServer restart persistence (re-binding to existing SQLite database file)
  - Malicious tenant ID spoofing rejection (header/body tamper protection)
  - CSRF and host security negative tests (Host header validation, Origin rejection, payload limits)

### Layer B: Real Docker E2E
- **Gating**: Gated by `RUN_DOCKER_TESTS=1`.
- **Default Behaviour**: When `RUN_DOCKER_TESTS` is unset or `!= 1`, tests safely skip with explicit console logging and are strictly excluded from acceptance counting.
- **Live Verification**: When enabled, executes `launchDemoSystem({ repoRoot })` from `@enkeep/demo-runner`, boots real Alice and Bob DSH runtime containers, verifies imported history resume, new session creation, and container isolation in real Chromium browser.
- **Cleanup**: Calls `demo:down` to cleanly remove demo resources and assert port 3000/3080 listener integrity.

---

## Package Scripts

```bash
# Typecheck TypeScript files
pnpm run typecheck

# Build TypeScript to dist
pnpm run build

# Run Layer A Contract E2E tests (default test command)
pnpm run test

# Run Layer A Contract E2E tests explicitly
pnpm run test:contract

# Run Layer B Real Docker E2E tests (requires active Docker daemon)
pnpm run test:docker
```

---

## Playwright Browser Requirements

This test suite utilizes Playwright Chromium in headless mode. If the browser binary is missing from your system, install it via:

```bash
npx playwright install chromium
# or
pnpm exec playwright install chromium
```
