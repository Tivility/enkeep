# HappyClaw Database Migration & Fork Layer (`@enkeep/import-happyclaw`)

This document defines the universal migration and fork architecture, schema introspection engine, CLI commands, backend admin endpoints, and dual-write guarantees for migrating conversations from arbitrary HappyClaw SQLite databases into Enkeep and DeepSeek Harness (DSH).

---

## 1. Overview & Architecture

The migration layer provides a generic source adapter that:
1. **Reads source databases in immutable, read-only mode** (`file:<path>?immutable=1&mode=ro`) without ever writing to source SQLite databases or modifying live HappyClaw data.
2. **Performs automated schema introspection** across modern, legacy, and minimal single-table HappyClaw schemas with structured diagnostics.
3. **Supports selective conversation migration and fork semantics**:
   - Selective migration by `--conversation <sourceKey>` (single or multiple) or `--all`.
   - Custom space mapping (`--space <folder>`) and session title override (`--title <text>`).
   - Generation 1 session initialization allowing immediate DSH session resume and continuation.
4. **Executes deterministic dual-write**:
   - Platform SQLite persistence (`spaces`, `session_routes`, `session_generations`, `session_sources`, `web_messages`, `web_events`, `fixed_import_receipts`, `fixed_import_provenance`).
   - Official DSH JSONL session seeds (`user/message`, `turn/start`, `assistant/message`, `session/end-seed`).
   - Attachment metadata mapping and safe file copies via typed runtime file providers.
5. **Enforces multi-tenant isolation and repeatability**:
   - Re-running identical migrations is an idempotent no-op with zero duplicate rows.
   - Cross-tenant migrations are strictly isolated (Alice vs. Bob).

---

## 2. CLI Specification (`enkeep-import-happyclaw`)

The CLI binary `enkeep-import-happyclaw` (alias `hpc-migrate`) provides three core subcommands: `inspect`, `migrate`, and `fork`.

```bash
# General Syntax
enkeep-import-happyclaw <command> [options]
```

### 2.1 `inspect` Command

Inspects a source HappyClaw SQLite database without mutating it, displaying schema diagnostics, conversation metadata, message counts, and time spans. Does not leak message body content by default.

```bash
# Human-readable table inspection
enkeep-import-happyclaw inspect --source /path/to/messages.db

# Structured JSON inspection
enkeep-import-happyclaw inspect --source /path/to/messages.db --json
```

**Output Example (CLI Table)**:
```text
================================================================================
                    HappyClaw Source Inspection Report                          
================================================================================
Source Database:   /path/to/messages.db
Fingerprint:       sha256:7b1d9c28...
Schema Version:    64
Compatibility:     current
Total Chats:       2
Total Messages:    52
--------------------------------------------------------------------------------
#    | Source Key (JID)               | Name                 | Channel    |   Msgs | First Message          | Last Message          
----------------------------------------------------------------------------------------------------------------------------
1    | web:alice-workspace-jid-001    | Alice Project Space  | web        |     50 | 2026-08-01T10:00:00Z   | 2026-08-01T10:25:00Z  
2    | feishu:bob-channel-002         | Bob Migration Space  | feishu     |      2 | 2026-08-01T11:00:00Z   | 2026-08-01T11:01:00Z  
================================================================================
```

### 2.2 `migrate` Command

Migrates one or more conversations into Enkeep platform format with dry-run planning.

```bash
# Dry-run migration plan for all conversations
enkeep-import-happyclaw migrate --source ./messages.db --all --user alice --dry-run

# Migrate specific conversations to a target user and space
enkeep-import-happyclaw migrate \
  --source ./messages.db \
  --conversation "web:alice-workspace-jid-001" \
  --conversation "feishu:bob-channel-002" \
  --user alice \
  --groups-dir ./groups \
  --target-dir ./output \
  --demo-root .
```

### 2.3 `fork` Command

Forks a single conversation into an Enkeep space with custom space folder and session title.

```bash
# Fork one conversation with custom title and space mapping
enkeep-import-happyclaw fork \
  --source ./messages.db \
  --conversation "web:alice-workspace-jid-001" \
  --user alice \
  --space "forked-alice-space" \
  --title "Forked Architecture Discussion"
```

---

## 3. Backend Admin HTTP Endpoints

For management backends and automation, `packages/platform-server` exposes secure admin migration endpoints:

| Endpoint | Method | Role | Description |
| :--- | :--- | :--- | :--- |
| `/api/admin/imports/happyclaw/inspect` | `POST` | Admin | Inspect source database schema and list conversations (enforces allowlisted import roots and CSRF). |
| `/api/admin/imports/happyclaw/execute` | `POST` | Admin | Execute migration or dry run plan with dual-write into platform SQLite and DSH seeds. |
| `/api/admin/imports/happyclaw/status/:jobId` | `GET` | Admin | Query status of an asynchronous or executed migration job. |
| `/api/admin/imports/happyclaw/cancel/:jobId` | `POST` | Admin | Cancel an in-flight migration job. |

### Request & Response Example: `POST /api/admin/imports/happyclaw/inspect`

**Request**:
```json
{
  "sourcePath": "/var/allowlisted-imports/source.db"
}
```

**Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "sourcePath": "/var/allowlisted-imports/source.db",
    "sourceFingerprint": "sha256:d8c238b...",
    "diagnostic": {
      "ok": true,
      "compatibilityLevel": "current",
      "detectedSchemaVersion": 64,
      "tablesFound": ["chats", "messages", "registered_groups", "router_state"],
      "missingRequiredTables": [],
      "missingOptionalTables": [],
      "issues": [],
      "recommendations": []
    },
    "totalConversations": 2,
    "totalMessages": 52,
    "conversations": [
      {
        "sourceKey": "web:alice-workspace-jid-001",
        "name": "Alice Project Space",
        "channel": "web",
        "folder": "alice-space",
        "executionMode": "container",
        "messageCount": 50,
        "firstMessageAt": "2026-08-01T10:00:00.000Z",
        "lastMessageAt": "2026-08-01T10:25:00.000Z",
        "senderCount": 2,
        "hasAttachments": true
      }
    ]
  }
}
```

---

## 4. Verification & Test Evidence

The migration subsystem is fully covered by automated unit, integration, and Docker acceptance tests:

- `packages/import-happyclaw/tests/generic-source-adapter.test.ts`:
  - Multi-scale dynamic temporary databases (0, 1, 100 conversations).
  - Modern schema (v64), legacy schema (no registered_groups/router_state), minimal single-table schema (messages only).
  - Corrupt database handling (missing messages table) with structured diagnostics.
  - WAL / SHM temporary companion file rejection.
  - Idempotent repeated migration verification.
  - Fork semantics and DSH `Session.create` session continuation.
- `packages/import-happyclaw/tests/cli.test.ts`:
  - Argument parser and CLI subcommands (`inspect`, `migrate`, `fork`, `--dry-run`, `--json`, `--help`).
- `packages/platform-server/tests/happyclaw-migration-service-and-routes.test.ts`:
  - Admin authorization and CSRF protection.
  - Allowlisted import root containment and host path security.
  - Dual-write transaction integrity (`spaces`, `session_routes`, `session_generations`, `session_sources`, `web_messages`, `web_events`, receipts, provenance).
  - Cross-tenant isolation (Alice vs. Bob).
- `packages/runtime-runner/tests/docker-optin.e2e.test.ts`:
  - **Fork one conversation then continue**: Creates a dynamic source SQLite database, forks a conversation, imports DSH seed into real non-root zero-network Docker container, resumes DSH session loop, and executes follow-up turn successfully.

---

## 5. Rollback Semantics & Volume Snapshot Requirements

When migrating or operating sessions under DeepSeek Harness (DSH) rc1:
- **Pre-cutover / Dry-run**: Safe to discard staging outputs without mutating persistent states.
- **Post-cutover with new writes**: Once new conversation turns and events are committed to DSH JSONL session persistence artifacts, rollback cannot be accomplished by partial database deletes or reverse-syncing alone. **Rolling back post-cutover new writes strictly requires a storage volume snapshot** (or full filesystem / container volume snapshot) taken at the exact cutover freeze point.

