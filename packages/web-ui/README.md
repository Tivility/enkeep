# @enkeep/web-ui

Unified Web User Interface and Management Console package for Enkeep.

## Features

- **Zero-complexity Distribution**: Ready-to-serve vanilla ES modules and static HTML/CSS/JS without external CDN or framework dependencies (strictly CSP-compliant, zero inline scripts/styles, zero `innerHTML`).
- **Role-Aware Information Architecture & Hash Routing**:
  - **All Users**: Workspace (`#workspace`), Overview (`#overview`), Tasks (`#tasks`), Delivery (`#delivery`), Quotas (`#quotas`), Activity (`#activity`), Imports (`#imports`).
  - **Admin Only**: Dashboard (`#admin-dashboard`), Users & Access (`#admin-users`), Spaces & Sessions (`#admin-spaces`), Runtime (`#admin-runtime`), Plugins (`#admin-plugins`), Security (`#admin-security`).
  - **Role Guards**: Non-admin users (e.g. Bob) receive a Member badge and hidden admin navigation; direct hash attempts to administration routes automatically redirect to `#overview`.
- **Primary Workspace & Chat Preservation**:
  - Space switcher with container and host execution modes.
  - Session list with creation modals.
  - Real-time chat with incremental event polling, suspended when in management views and resumed on return to workspace.
- **Unified Management Console**:
  - Responsive management canvas with KPI summary cards, structured data tables, and status badges.
  - State rendering: graceful handling of loaded, empty, error, skeleton, and unavailable service states (never falsely claiming readiness when endpoints are offline).
  - Administration mutations: user role/status/display name editing (`PATCH /api/admin/users/:id`) and session revocation (`POST /api/admin/users/:id/revoke-sessions`) with required confirmation dialogs.
  - Session Turn History Inspector: inspect execution turns via `GET /api/sessions/:id/turns`.
- **Security & Integrity**:
  - Exact `X-Enkeep-CSRF` protection across all requests.
  - Single network retry for idempotent message submissions using canonical `Idempotency-Key` (UUIDv4) generated via `crypto.randomUUID()`.
  - Fail-safe static asset serving with strict path containment and symlink rejection.

## Usage

```typescript
import { getWebUiAsset, getWebUiIndexHtml, getWebUiStaticDir } from '@enkeep/web-ui';

// Retrieve SPA HTML entry
const html = getWebUiIndexHtml();

// Retrieve a static file asset (CSS / JS)
const css = getWebUiAsset('style.css');
const mimeType = css.mimeType; // text/css; charset=utf-8
```

## Testing

```bash
# Unit & pure render contract tests
pnpm test
```
