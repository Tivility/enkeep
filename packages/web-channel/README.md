# @enkeep/web-channel

Official Web Channel Adapter for Enkeep.

## Overview

`@enkeep/web-channel` implements the Web Channel Adapter for the Enkeep platform:
- Implements standard envelope abstractions: `InboundEnvelope` and `NativeContext`.
- Uses fixed `accountId: 'web-demo'` with deterministic route keys: `${userId}:${channel}:${accountId}:${nativeContextId}`.
- Interacts exclusively with execution engines via the abstract `RuntimeGateway` interface (no direct coupling to concrete DSH runtime implementations).
- Enforces strict multi-tenancy: user/tenant identity is derived solely from server-side session cookies and never trusted from client request parameters.
- Provides `PlatformWebApi` interface and `InMemoryPlatformWebApi` contract test harness.
- Serves static Web UI from `@enkeep/web-ui`.

## Route Key Architecture

The route key uniquely routes messages across channels and tenants:
```
<userId>:<channel>:<accountId>:<nativeContextId>
```
Example: `usr_alice123:web:web-demo:ses_001`

## API Endpoints (Canonical)

- `GET /api/auth/csrf` — Bootstrap CSRF token
- `POST /api/auth/login` — Sign in and issue `enkeep_session` cookie
- `POST /api/auth/logout` — Sign out and revoke session
- `GET /api/auth/me` — Authenticated user info
- `GET /api/spaces` — List spaces for tenant
- `POST /api/spaces` — Create space
- `GET /api/spaces/:spaceId/sessions` — List sessions in space
- `POST /api/sessions` — Create session
- `GET /api/sessions/:sessionId` — Get session details (tenant-scoped)
- `POST /api/sessions/:sessionId/archive` — Soft archive session
- `POST /api/sessions/:sessionId/reset` — Generational reset preserving history
- `GET /api/sessions/:sessionId/generations` — List session generation snapshots
- `GET /api/sessions/:sessionId/messages` — Get message history
- `POST /api/sessions/:sessionId/messages` — Send inbound message to Runtime Gateway
- `GET /api/sessions/:sessionId/events` — Incremental polling for turn and message updates
- `GET /api/sessions/:sessionId/turns` — List execution turn history for session
- `GET /api/sessions/:sessionId/turn/current` — Get active turn status for session
- `POST /api/sessions/:sessionId/turn/cancel-current` — Stop current active turn for session
- `GET /api/turns/:turnId` — Check turn execution status
- `POST /api/turns/:turnId/cancel` — Cancel turn by ID

## Testing & Safeguards

- Tests bind to temporary ephemeral loopback addresses (`127.0.0.1:0`).
- Unsafe bindings (`0.0.0.0`, `::`) and protected ports (`3000`, `3080`) are strictly rejected.
