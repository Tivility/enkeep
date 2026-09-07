# @enkeep/dsh-tool-browser

Platform BrowserPort client plugin and tool suite for DeepSeek Harness (Enkeep Runtime).

## Overview

`@enkeep/dsh-tool-browser` provides headless browser automation capabilities to DSH agents via an RPC gateway to the host-side Platform Browser Service (`@enkeep/platform-service-browser`). The container runtime acts purely as a client over the existing UDS / loopback tunnel (`platformClient`), preventing memory leaks and container bloat by never executing local browser daemons.

## Tools

| Tool Name | Parameters | Description | Risk / Approval |
| :--- | :--- | :--- | :--- |
| `browser_open` | `url: string` | Opens a web page at the specified URL in an isolated browser session. Returns `pageId`. | Low-risk navigation (configurable approval). |
| `browser_snapshot` | `pageId: string` | Captures an accessibility tree snapshot with `@e1` semantic references. | Read-only (allowed without approval). |
| `browser_interact` | `pageId: string`, `action: 'click' \| 'fill' \| 'press' \| 'select'`, `ref: string`, `value?: string` | Performs interactions on elements identified by snapshot references. | Mutation / side-effect (requires human approval). |
| `browser_screenshot` | `pageId: string`, `fullPage?: boolean` | Captures a screenshot persisted directly to `artifacts/browser/<ts>-<id>.png`. Returns path & download URL. | Read-only (allowed without approval). |
| `browser_close` | `pageId: string` | Closes the specified page and releases allocated browser resources. | Safe cleanup. |

## Key Invariants & Security Guarantees

1. **Initiator Scope Derivation**: User ID, space ID, and session ID are strictly derived from the caller initiator context (`agent.session`), never accepted from model arguments.
2. **Strict Schema Validation**: All tools enforce `additionalProperties: false` and strict parameter types.
3. **No Arbitrary Evaluate**: Arbitrary script evaluation (`evaluate`) is explicitly omitted to prevent unsandboxed code execution.
4. **Artifact Persistence & No Raw Base64**: Screenshots are written directly by the platform file gateway to `artifacts/browser/` using `TenantRuntimeFileProvider`. The model receives virtual relative paths and download references, preventing circular buffer bloat.
5. **DSH Approval Registry Integration**: Interactive mutations (`browser_interact`) enforce approvals through `ctx.approval.request(...)` with fail-closed semantics.
6. **Honest Capability Advertisement**: Probes `/capabilities` or `/api/browser` to verify browser service readiness before declaring operational status.
