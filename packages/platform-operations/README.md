# @enkeep/platform-operations

Optional, atomic platform operations package for the Enkeep ecosystem.

This package provides tenant-scoped operational capabilities—including idempotent outbound messaging, safe file metadata and path policy enforcement, persistent one-time tasks with claim/lease semantics, and an atomic two-phase quota ledger for token and call budgets.

---

## Key Characteristics & Modularity

- **Atomic & Optional Platform Plugin**: Designed as an independent, modular plugin package that can be installed, enabled, or removed without affecting other layers of the platform core.
- **Port-Based Decoupling**: Pure business and domain operations depend strictly on repository and audit ports (`platform-core` repositories and custom operations ports). There is **no direct dependency on SQLite** or any specific database engine.
- **Future SQLite Adapter Support**: All persistence interactions go through tenant-scoped repository interfaces (`TenantScopedDeliveryReceiptRepository`, `TenantScopedTaskRepository`, `TenantScopedQuotaLedgerRepository`, `TenantScopedFileMetadataRepository`). A concrete persistence adapter (e.g. SQLite tables in `@enkeep/platform-storage-sqlite` or a standalone SQLite operations adapter) can be plugged in without modifying the domain logic.
- **Strict Multi-Tenant Isolation**: All operations, entities, and ledgers are strictly partitioned by `userId` (tenant context). Cross-tenant access is rejected at the domain boundary.
- **Auditable**: Every operational action emits structured, tenant-scoped audit events via `OperationsAuditPort` (with built-in adapter support for `@enkeep/platform-core`'s `AuthAuditLogRepository`).
- **Strict TypeScript ESM**: Target ES2022, NodeNext resolution, zero runtime dependencies outside of platform ports.

---

## Architecture & Features

```
                                  +---------------------------------------+
                                  |      PlatformOperationsService        |
                                  +-------------------+-------------------+
                                                      |
                                         .forTenant(userId)
                                                      |
                   +----------------------------------+----------------------------------+
                   |                                  |                                  |
    +--------------v---------------+   +--------------v---------------+   +--------------v---------------+   +--------------v---------------+
    |   MessageOperationService    |   |     FileOperationService     |   |     TaskOperationService     |   |    QuotaOperationService     |
    +--------------+---------------+   +--------------+---------------+   +--------------+---------------+   +--------------+---------------+
                   |                                  |                                  |                                  |
                   v                                  v                                  v                                  v
         [DeliveryReceiptPort]                 [FileMetadataPort]                  [TaskRepoPort]                [QuotaLedgerRepoPort]
         (Outbound Idempotency)              (Path Policy & Metadata)           (Claim/Lease & Recovery)          (2-Phase Reserve/Commit)
                   |                                  |                                  |                                  |
                   +----------------------------------+----------------------------------+----------------------------------+
                                                      |
                                                      v
                                      +---------------+---------------+
                                      |     OperationsAuditPort       |
                                      |   (Per-tenant audit logs)     |
                                      +-------------------------------+
```

### 1. `send_message` (Outbound Receipts & Idempotency)
- **Delivery Idempotency**: Outbound messages are tracked via `deliveryId`. Duplicate send requests with the same `deliveryId` return the existing receipt immediately (`isIdempotentHit: true`) and bypass redundant channel dispatches.
- **Receipt Lifecycle**: Tracks `pending` -> `delivered` | `failed` state transitions.
- **Outbound Adapter Hook**: Optional `OutboundChannelAdapter` integration for dispatching to external channels.

### 2. `send_file` (Metadata & Path Policy)
- **Path Policy Enforcement**: Validates file paths against tenant security policies without reading arbitrary host or external paths (`"不读外部路径"`).
- **Security Protections**:
  - Traversal prevention (`../`, `/../` directory escapes).
  - Null-byte injection blocking (`\0`).
  - Disallows absolute paths outside the workspace boundary.
  - Executable blacklist (`.exe`, `.sh`, `.bat`, `.dll`, `.ps1`, etc.).
  - Configurable extension allowlists and file size ceilings.
- **Metadata Persistence**: Generates and persists tenant-scoped `FileMetadata` (size, MIME type, relative path, checksum).

### 3. `create_task` (Persistent Tasks with Claim/Lease)
- **At-Most-Once Idempotency**: Tasks created with an `idempotencyKey` return existing task records on retries to prevent duplicate task execution.
- **Claim/Lease Semantics**: Workers claim tasks with an exclusive lease (`leaseDurationMs` / `leaseExpiresAt`). While a lease is active, other workers cannot claim the task.
- **Heartbeat Renewal**: Active workers can extend their lease via `renewLease`.
- **Restart Recovery**: Unfinished tasks whose worker crashed or whose lease expired are automatically swept and recovered back to `pending` (for retry) or `failed` (when `maxRetries` is exhausted) via `recoverExpiredLeases` or `recoverAfterRestart`.

### 4. `check_quota` & Token/Call Budget Ledger (Atomic Reserve/Commit/Release)
- **Multi-Resource Budgeting**: Tracks tokens (input/output/total), calls/requests, storage bytes, or custom metrics.
- **Atomic Two-Phase Reservations**:
  1. `reserveQuota`: Atomically verifies `available = limit - (used + reserved) >= amount` and holds a temporary reservation with a TTL.
  2. `commitQuota`: Settles the reservation with actual usage (adjusting ledger balances atomically).
  3. `releaseQuota`: Cancels an uncommitted reservation and refunds held quota to the available pool.
- **Concurrency Safe**: Parallel reservations race safely without exceeding limits or creating negative balances.
- **Stale Reservation Expiry**: Expired reservations are automatically released during system recovery sweeps.

---

## Directory Layout

```
packages/platform-operations/
├── src/
│   ├── errors/                 # Domain error classes (QuotaExceededError, TaskConflictError, etc.)
│   ├── types/                  # TypeScript domain models and interfaces
│   │   ├── common.ts           # Tenant context & pagination
│   │   ├── audit.ts            # Audit actions & records
│   │   ├── message.ts          # Message payloads & delivery results
│   │   ├── file.ts             # File metadata & path policies
│   │   ├── task.ts             # Task states, claim/lease params
│   │   └── quota.ts            # Ledger summaries & reservations
│   ├── ports/                  # Storage & adapter port definitions
│   │   ├── audit-port.ts       # OperationsAuditPort & CoreAuthAuditLogAdapter
│   │   ├── delivery-receipt-port.ts # DeliveryReceiptPort
│   │   ├── file-port.ts        # TenantScopedFileMetadataRepository & PathPolicyPort
│   │   ├── task-port.ts        # TenantScopedTaskRepository
│   │   ├── quota-ledger-port.ts # TenantScopedQuotaLedgerRepository
│   │   └── storage-port.ts     # PlatformOperationsStorage
│   ├── policies/               # Standard security & validation policies
│   │   └── path-policy.ts      # Pure path containment validator (no external FS reads)
│   ├── services/               # Core domain business logic
│   │   ├── message-operation-service.ts
│   │   ├── file-operation-service.ts
│   │   ├── task-operation-service.ts
│   │   ├── quota-operation-service.ts
│   │   └── platform-operations-service.ts
│   ├── fakes/                  # In-memory fake ports for testing & standalone use
│   │   ├── fake-audit-repo.ts
│   │   ├── fake-delivery-receipt-repo.ts
│   │   ├── fake-file-metadata-repo.ts
│   │   ├── fake-task-repo.ts
│   │   ├── fake-quota-ledger-repo.ts
│   │   └── fake-storage.ts
│   └── index.ts                # Package public exports
├── tests/                      # Vitest test suites (zero live server dependencies)
│   ├── tenant-isolation.test.ts
│   ├── quota-concurrency.test.ts
│   ├── task-lifecycle-and-restart.test.ts
│   ├── message-receipts-idempotency.test.ts
│   ├── file-path-policy.test.ts
│   ├── audit-port.test.ts
│   └── operations-edge-cases.test.ts
├── package.json
├── tsconfig.json
└── README.md
```

---

## Usage Example

```typescript
import {
  PlatformOperationsService,
  FakePlatformOperationsStorage,
} from '@enkeep/platform-operations';

// 1. Initialize with in-memory storage (or a future SQLite storage adapter)
const storage = new FakePlatformOperationsStorage();
const operations = new PlatformOperationsService({ storage });

// 2. Access tenant-scoped operations
const aliceOps = operations.forTenant('user_alice');

// --- Quota 2-Phase Reservation ---
await aliceOps.quota.setLimit({ resource: 'tokens', limit: 10000 });
const reservation = await aliceOps.quota.reserveQuota({
  resource: 'tokens',
  amount: 500,
});

// Run task or LLM turn, then commit actual tokens used:
await aliceOps.quota.commitQuota({
  reservationId: reservation.id,
  actualAmount: 420,
});

// --- Persistent Task with Claim/Lease ---
const { task } = await aliceOps.tasks.createTask({
  title: 'Process Analytics',
  idempotencyKey: 'analytics-2025-01',
  priority: 'high',
});

// Worker claims task
const claimed = await aliceOps.tasks.claimTask({
  claimantId: 'worker_1',
  preferredTaskId: task.id,
  leaseDurationMs: 30000,
});

// Worker completes task
await aliceOps.tasks.completeTask(claimed!.id, {
  claimantId: 'worker_1',
  result: { processedRecords: 1500 },
});

// --- Outbound Message with Idempotency ---
const receipt = await aliceOps.messages.sendMessage({
  recipient: 'peer_bob',
  content: 'Processing completed',
  deliveryId: 'deliv_batch_42',
});

// --- System Restart Recovery ---
await operations.recoverAfterRestart();
```

---

## Future SQLite Adapter Integration

To bind this operations layer to a persistent SQLite database:
1. Implement the repository port interfaces (`TenantScopedTaskRepository`, `TenantScopedQuotaLedgerRepository`, `TenantScopedFileMetadataRepository`) using SQLite prepared statements.
2. Implement `PlatformOperationsStorage.forTenant(userId)` to return SQLite-backed tenant repositories.
3. Pass the SQLite storage instance into `new PlatformOperationsService({ storage: sqliteOperationsStorage })`.

No business logic inside `@enkeep/platform-operations` needs to change when migrating between in-memory and SQLite storage.

---

## Building and Testing

```bash
# Type check and build
pnpm --filter @enkeep/platform-operations run build

# Run comprehensive test suite
pnpm --filter @enkeep/platform-operations test
```
