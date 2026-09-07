# @enkeep/platform-server

Core Node.js HTTP platform server for **Enkeep**, providing multi-tenant isolation, signed-cookie session authentication, SQLite-backed state persistence, abstract runtime gateway integration, event polling, and strict loopback security guardrails.

---

## 1. Overview & Architecture

`@enkeep/platform-server` coordinates the Enkeep backend platform by integrating:
- **`@enkeep/platform-core`**: Core domain types, entities, error definitions, and repository interfaces.
- **`@enkeep/platform-storage-sqlite`**: Real SQLite persistence for users, user sessions, spaces, session routes, delivery receipts, event cursors, and turn runs.
- **`@enkeep/platform-auth`**: Scrypt password hashing, HMAC-SHA256 signed cookie issuance, session validation, and host execution authorization.
- **`@enkeep/protocol`**: Standard wire protocols, branded IDs, and structured API envelopes (`createSuccessEnvelope`, `createErrorEnvelope`).
- **`@enkeep/web-channel`**: Web routing keys (`${userId}:web:web-demo:${sessionId}`), envelopes, and abstract `RuntimeGateway` interface.
- **`@enkeep/web-ui`**: Embedded static assets and Single Page Application (SPA) HTML fallback.

```
                  +-----------------------------------------+
                  |         Client / Web Browser UI         |
                  +-----------------------------------------+
                                      |
                     HTTP + Signed Cookies (127.0.0.1:port)
                                      v
       +---------------------------------------------------------------+
       |                      PlatformServer                           |
       |  - Loopback Host Guard (127.0.0.1 only, rejects 0.0.0.0 / ::) |
       |  - Reserved Port Protection (excludes 3000, 3080)             |
       |  - Request Limits (1MB body, 4KB cookies, 30s timeout)        |
       |  - CSRF Protection (SameSite=Lax + Origin/Referer check)      |
       +---------------------------------------------------------------+
           |                     |                     |
           v                     v                     v
   [Auth & Identity]     [Multi-Tenant REST]    [Runtime Gateway]
   - /api/auth/login     - /api/spaces          - /api/sessions/:id/messages
   - /api/auth/logout    - /api/sessions        - /api/sessions/:id/events
   - /api/auth/me        - /api/turns
           |                     |                     |
           +---------------------+---------------------+
                                 |
                                 v
        +-----------------------------------------------+
        |             Platform Storage (SQLite)         |
        |  - users / user_sessions / auth_audit_log     |
        |  - spaces / session_routes / session_sources  |
        |  - web_messages / web_events                  |
        |  - turn_runs / delivery_receipts              |
        +-----------------------------------------------+
```

---

## 2. Security & Guardrails

### Strict Loopback Host Binding
- The HTTP server rejects any attempt to bind to `0.0.0.0`, `::`, `*`, or public network interfaces (`UnsafeHostBindingError`).
- Port allocations strictly exclude `3000` (HappyClaw) and `3080` (DSH Web GUI) to prevent port conflicts (`UnsafePortAllocationError`).
- All test suites use ephemeral dynamic ports (`127.0.0.1:0`).

### Session Authentication & Signed Cookies
- Client session tokens are signed via HMAC-SHA256 (`base64url(payload).signature`).
- Signatures are verified using timing-safe comparison (`timingSafeEqual`) to prevent timing attacks.
- Tampered or revoked cookies immediately fail authentication.
- Set-Cookie attributes include `HttpOnly`, `SameSite=Lax`, and `Path=/`.

### Server-Derived Tenant Isolation
- **Tenant ID is strictly derived from the verified server-side session.**
- Client-provided query parameters (e.g. `?userId=...`) or body fields cannot escalate privileges.
- Cross-tenant access to spaces, sessions, or message history returns `404 Not Found` (never leaking resource existence).

### Deny-by-Default Privileged APIs
- Administrative and DSH execution endpoints (`/api/dsh/*`, `/api/admin/*`) are protected by explicit role checks.
- Non-admin users attempting privileged access receive `403 Forbidden`.
- Unauthenticated requests receive `401 Unauthorized`.

### Request Safety Limits & CSRF Protection
- **Body Size Limit**: Defaults to 1 MB (`413 Payload Too Large`).
- **Request Timeout**: Configurable (default 30s) (`408 Request Timeout`).
- **Cookie Length**: Max 4 KB (`400 Validation Error`).
- **CSRF Validation**: State-modifying HTTP methods (`POST`, `PUT`, `DELETE`, `PATCH`) enforce matching `Origin`/`Referer` headers.

---

## 3. HTTP API Reference

All responses follow the standard `@enkeep/protocol` wire envelope format:
```json
{
  "success": true,
  "data": { ... }
}
```
or on error:
```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Session not found",
    "status": 404
  }
}
```

| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| `GET` | `/api/health` | Service health check | No |
| `POST` | `/api/auth/login` | Authenticate with username & password; sets signed cookie | No |
| `POST` | `/api/auth/logout` | Revoke current session & clear cookie | Yes |
| `GET` | `/api/auth/me` | Get current authenticated user profile | Yes |
| `GET` | `/api/spaces` | List spaces belonging to authenticated tenant | Yes |
| `POST` | `/api/spaces` | Create new space (`name`, `folder`, `executionMode`) | Yes |
| `GET` | `/api/spaces/:spaceId` | Get space detail (tenant-scoped) | Yes |
| `GET` | `/api/spaces/:spaceId/sessions` | List sessions in specified space | Yes |
| `GET` | `/api/sessions` | List all sessions for authenticated tenant | Yes |
| `POST` | `/api/sessions` | Create new session route (`spaceId`, `peerId`) | Yes |
| `GET` | `/api/sessions/:sessionId` | Get session detail and computed `routeKey` | Yes |
| `GET` | `/api/sessions/:sessionId/messages` | List message history with cursor pagination | Yes |
| `POST` | `/api/sessions/:sessionId/messages` | Send inbound message & dispatch execution turn (idempotency support) | Yes |
| `GET` | `/api/sessions/:sessionId/events` | Poll incremental events using cursor | Yes |
| `GET` | `/api/turns/:turnId` | Query turn status (`queued`, `running`, `completed`, `failed`, `interrupted`) | Yes |
| `POST` | `/api/turns/:turnId/cancel` | Cancel an in-progress or queued turn | Yes |
| `GET` | `/api/dsh/status` | Privileged DSH runner status (Admin only) | Admin |
| `GET` | `/static/*` | Static Web UI assets | No |
| `GET` | `/` or `/index.html` | SPA HTML fallback | No |

---

## 4. Usage Example

```ts
import { PlatformServer } from '@enkeep/platform-server';

const server = new PlatformServer({
  host: '127.0.0.1',
  port: 0, // dynamic safe port
  cookieSecret: process.env.COOKIE_SECRET || 'a-very-secure-32-char-cookie-secret!',
});

const { url, port } = await server.start();
console.log(`Enkeep Platform Server listening at ${url}`);

// Clean shutdown
process.on('SIGTERM', async () => {
  await server.stop();
  process.exit(0);
});
```

---

## 5. Development & Testing

```bash
# Compile TypeScript
pnpm --filter @enkeep/platform-server build

# Typecheck without emit
pnpm --filter @enkeep/platform-server typecheck

# Run test suite
pnpm --filter @enkeep/platform-server test
```
